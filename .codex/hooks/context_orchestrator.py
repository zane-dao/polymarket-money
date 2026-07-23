#!/usr/bin/env python3
"""Cache-aware context routing, recovery checkpoints, and safety hooks for Codex.

The hook is deterministic and model-free. It keeps the normal prompt prefix stable,
adds route guidance only when the route or its source documents change, checkpoints
outside the tracked worktree, and asks for semantic write-back only on rare durable
changes. Canonical repository documents always outrank generated state.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import tomllib
from typing import Any, Iterable, Iterator

VERSION = "2.0.0"
UTC = dt.timezone.utc
REQUIRED_HOOK_EVENTS = (
    "SessionStart",
    "UserPromptSubmit",
    "SubagentStart",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "Stop",
)
PATH_KEY_NAMES = {
    "path",
    "file",
    "file_path",
    "filepath",
    "filename",
    "target",
    "destination",
    "dest",
    "output",
    "output_path",
}
SECRET_PATTERNS = (
    re.compile(r"\bsk-[A-Za-z0-9_-]{12,}\b"),
    re.compile(r"(?i)\b(api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s,;]+"),
    re.compile(r"\b0x[a-fA-F0-9]{64}\b"),
    re.compile(r"(?i)\b(?:seed phrase|mnemonic)\b\s*[:=]?\s*(?:[a-z]+\s+){5,}[a-z]+"),
)
TEST_WORDS = (
    "npm test",
    "npm run test",
    "pnpm test",
    "yarn test",
    "python3 -m unittest",
    "python -m unittest",
    "pytest",
    "node --test",
    "cargo test",
    "cargo check",
    "tsc",
    "ruff",
    "mypy",
    "pyright",
)
DURABLE_WORDS = (
    "architecture",
    "contract",
    "invariant",
    "decision",
    "accepted",
    "roadmap",
    "milestone",
    "batch",
    "migration",
    "breaking",
    "safety",
    "risk",
    "release",
    "handoff",
    "current state",
    "remember",
    "persist",
    "document this",
    "架构",
    "契约",
    "不变量",
    "决策",
    "接受",
    "路线",
    "里程碑",
    "批次",
    "迁移",
    "破坏性",
    "安全",
    "风控",
    "发布",
    "交接",
    "当前状态",
    "记住",
    "持久化",
    "更新文档",
    "记录下来",
)
EXPLICIT_PERSIST_WORDS = (
    "remember this",
    "persist this",
    "update current",
    "update the current",
    "record the decision",
    "document this",
    "finish the batch",
    "archive this",
    "记住",
    "持久化",
    "更新当前状态",
    "更新 current",
    "更新文档",
    "记录决策",
    "写入交接",
    "完成批次",
    "归档",
    "以后都",
)


def utc_now() -> dt.datetime:
    return dt.datetime.now(tz=UTC)


def iso_now() -> str:
    return utc_now().replace(microsecond=0).isoformat()


def parse_iso(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    except (TypeError, ValueError):
        return None


def cap(text: str, limit: int, suffix: str = "\n…[truncated]") -> str:
    if limit <= 0:
        return ""
    if len(text) <= limit:
        return text
    room = max(0, limit - len(suffix))
    return text[:room].rstrip() + suffix


def redact(text: str) -> str:
    result = text
    for pattern in SECRET_PATTERNS:
        result = pattern.sub("[REDACTED]", result)
    return result


def hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def sanitize_id(value: str | None, fallback: str = "unknown") -> str:
    clean = re.sub(r"[^A-Za-z0-9._-]+", "-", value or "").strip("-.")
    return (clean or fallback)[:96]


def atomic_write(path: Path, content: str, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            os.chmod(temp_path, mode)
        os.replace(temp_path, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temp_path.unlink()


def atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    atomic_write(path, json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def read_json(path: Path, default: dict[str, Any] | None = None) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else (default or {})
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default or {}


@contextlib.contextmanager
def file_lock(path: Path) -> Iterator[None]:
    """Use an advisory lock so overlapping first-turn hooks remain idempotent."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        if os.name == "nt":
            import msvcrt  # type: ignore

            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            deadline = time.monotonic() + 4.0
            while True:
                try:
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(f"Could not lock {path}")
                    time.sleep(0.05)
            try:
                yield
            finally:
                handle.seek(0)
                with contextlib.suppress(OSError):
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl  # type: ignore

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def run_process(args: list[str], cwd: Path, timeout: float = 5.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=str(cwd),
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )


def find_repo(cwd: str | Path | None = None) -> Path:
    start = Path(cwd or os.getcwd()).expanduser().resolve()
    try:
        result = run_process(["git", "rev-parse", "--show-toplevel"], start, timeout=3)
        if result.returncode == 0 and result.stdout.strip():
            return Path(result.stdout.strip()).resolve()
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass
    for candidate in (start, *start.parents):
        if (candidate / ".git").exists():
            return candidate
    return start


def load_policy(repo: Path) -> dict[str, Any]:
    path = repo / ".codex" / "context-policy.toml"
    with path.open("rb") as handle:
        policy = tomllib.load(handle)
    if not isinstance(policy.get("routes"), list):
        raise ValueError("context-policy.toml: routes must be an array of tables")
    return policy


def ensure_writable_dir(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / f".write-test-{os.getpid()}"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return True
    except OSError:
        return False


def git_private_root(repo: Path) -> Path | None:
    try:
        result = run_process(["git", "rev-parse", "--git-path", "codex-context"], repo, timeout=3)
        if result.returncode != 0 or not result.stdout.strip():
            return None
        raw = Path(result.stdout.strip())
        return (raw if raw.is_absolute() else repo / raw).resolve()
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None


class Runtime:
    def __init__(self, repo: Path, policy: dict[str, Any]):
        self.repo = repo.resolve()
        self.policy = policy
        self.budget = policy.get("budget", {})
        self.lifecycle = policy.get("lifecycle", {})
        self.documents = policy.get("documents", {})
        self.safety = policy.get("safety", {})
        self.maintenance = policy.get("maintenance", {})
        self.commands = policy.get("commands", {})
        self.routes: list[dict[str, Any]] = policy.get("routes", [])

        candidates: list[Path] = []
        env_name = str(policy.get("state_root_env", "POLYMARKET_CONTEXT_ROOT"))
        raw_env = os.environ.get(env_name)
        if raw_env:
            candidates.append(Path(os.path.expandvars(os.path.expanduser(raw_env))))
        private = git_private_root(self.repo)
        if private is not None:
            candidates.append(private)
        repo_key = f"{sanitize_id(str(policy.get('project_name', self.repo.name)))}-{hash_text(str(self.repo))[:10]}"
        candidates.append(Path.home() / ".codex" / "project-memory" / repo_key)

        chosen: Path | None = None
        for candidate in candidates:
            if ensure_writable_dir(candidate):
                chosen = candidate.resolve()
                break
        if chosen is None:
            raise OSError("No writable context state directory")

        self.state_root = chosen
        self.generated = self.state_root / str(policy.get("generated_dir", "codex-context"))
        self.state_dir = self.generated / "sessions"
        self.checkpoints_dir = self.generated / "checkpoints"
        self.archive_dir = self.generated / "archive"
        self.logs_dir = self.generated / "logs"
        for path in (self.generated, self.state_dir, self.checkpoints_dir, self.archive_dir, self.logs_dir):
            path.mkdir(parents=True, exist_ok=True)

    def state_path(self, session_id: str) -> Path:
        return self.state_dir / f"{sanitize_id(session_id)}.json"

    def lock_path(self, session_id: str) -> Path:
        return self.state_dir / f"{sanitize_id(session_id)}.lock"

    @property
    def meta_path(self) -> Path:
        return self.generated / "meta.json"

    @property
    def recovery_path(self) -> Path:
        return self.generated / "RECOVERY.md"

    @property
    def maintenance_path(self) -> Path:
        return self.generated / "MAINTENANCE.md"

    @property
    def index_path(self) -> Path:
        return self.generated / "INDEX.md"


def default_state(payload: dict[str, Any], runtime: Runtime) -> dict[str, Any]:
    return {
        "version": 2,
        "session_id": sanitize_id(str(payload.get("session_id") or "unknown")),
        "repo": str(runtime.repo),
        "created_at": iso_now(),
        "updated_at": iso_now(),
        "source": payload.get("source"),
        "baseline_git": {},
        "active_turn_id": "",
        "turn_started_at": "",
        "turn_baseline_git": {},
        "turn_touched_paths": [],
        "turn_tool_commands": [],
        "turn_test_runs": [],
        "turn_prompt": "",
        "prompts": [],
        "active_routes": [],
        "route_history": [],
        "last_route_signature": "",
        "last_route_source_signature": "",
        "last_injected_turn": "",
        "announced_routes": [],
        "canonical_guarded_turn_routes": [],
        "touched_paths": [],
        "tool_commands": [],
        "test_runs": [],
        "last_assistant_message": "",
        "last_checkpoint_fingerprint": "",
        "last_checkpoint_path": "",
        "last_compact_recovery_fingerprint": "",
        "semantic_request_fingerprint": "",
        "semantic_request_at": "",
        "semantic_review_result": "",
        "semantic_review_at": "",
    }


def load_state(runtime: Runtime, payload: dict[str, Any]) -> dict[str, Any]:
    session_id = sanitize_id(str(payload.get("session_id") or "unknown"))
    base = default_state(payload, runtime)
    state = read_json(runtime.state_path(session_id), base)
    for key, value in base.items():
        state.setdefault(key, value)
    state["session_id"] = session_id
    state["repo"] = str(runtime.repo)
    return state


def save_state(runtime: Runtime, state: dict[str, Any]) -> None:
    state["updated_at"] = iso_now()
    atomic_write_json(runtime.state_path(str(state.get("session_id") or "unknown")), state)


def log_event(runtime: Runtime, event: str, details: dict[str, Any]) -> None:
    try:
        path = runtime.logs_dir / f"events-{utc_now().date().isoformat()}.jsonl"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"ts": iso_now(), "event": event, **details}, ensure_ascii=False) + "\n")
    except OSError:
        pass


def read_stdin_payload() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("Hook stdin must be one JSON object")
    return value


def json_stdout(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def git_branch(repo: Path) -> str:
    try:
        result = run_process(["git", "branch", "--show-current"], repo, timeout=3)
        return result.stdout.strip() if result.returncode == 0 else ""
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return ""


def git_status(repo: Path) -> dict[str, str]:
    try:
        result = run_process(["git", "status", "--porcelain=v1", "--untracked-files=all"], repo, timeout=5)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return {}
    if result.returncode != 0:
        return {}
    status: dict[str, str] = {}
    for line in result.stdout.splitlines():
        if len(line) < 4:
            continue
        code = line[:2]
        raw_path = line[3:].strip()
        if " -> " in raw_path:
            raw_path = raw_path.split(" -> ", 1)[1]
        if len(raw_path) >= 2 and raw_path[0] == raw_path[-1] == '"':
            raw_path = raw_path[1:-1]
        status[raw_path] = code
    return status


def file_fingerprint(path: Path, max_bytes: int = 8 * 1024 * 1024) -> str:
    try:
        if not path.exists():
            return "missing"
        if path.is_dir():
            return "dir"
        stat = path.stat()
        if stat.st_size > max_bytes:
            return f"large:{stat.st_size}:{stat.st_mtime_ns}"
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return "unreadable"


def snapshot_dirty(repo: Path) -> dict[str, dict[str, str]]:
    return {
        rel: {"status": code, "fingerprint": file_fingerprint(repo / rel)}
        for rel, code in git_status(repo).items()
    }


def normalize_repo_path(raw: str, repo: Path) -> str | None:
    value = raw.strip().strip("'\"`:,;()[]{}")
    value = value.replace("\\", "/")
    if not value or value.startswith("-"):
        return None
    path = Path(value).expanduser()
    if path.is_absolute():
        try:
            return path.resolve().relative_to(repo.resolve()).as_posix()
        except (ValueError, OSError):
            return None
    normalized = Path(value)
    if ".." in normalized.parts:
        return None
    result = normalized.as_posix()
    while result.startswith("./"):
        result = result[2:]
    return result or None


def walk_path_values(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).lower() in PATH_KEY_NAMES and isinstance(child, str):
                yield child
            yield from walk_path_values(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_path_values(child)


def extract_paths(tool_name: str, tool_input: Any, repo: Path) -> list[str]:
    paths: set[str] = set()
    command = ""
    if isinstance(tool_input, dict):
        raw = tool_input.get("command")
        if isinstance(raw, str):
            command = raw
        for candidate in walk_path_values(tool_input):
            normalized = normalize_repo_path(candidate, repo)
            if normalized:
                paths.add(normalized)
    elif isinstance(tool_input, str):
        command = tool_input

    if tool_name == "apply_patch" or "*** Begin Patch" in command:
        for match in re.finditer(r"^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$", command, re.MULTILINE):
            normalized = normalize_repo_path(match.group(1), repo)
            if normalized:
                paths.add(normalized)
        for match in re.finditer(r"^\*\*\* Move to:\s*(.+?)\s*$", command, re.MULTILINE):
            normalized = normalize_repo_path(match.group(1), repo)
            if normalized:
                paths.add(normalized)

    top_names = "backend|frontend|src-tauri|strategies|contracts|research|experiments|data|scripts|tests|docs|reports|\\.codex|\\.agents"
    general = re.compile(rf"(?<![A-Za-z0-9_.-])((?:{top_names})/[A-Za-z0-9_@%+.,=:/\\-]+)")
    for match in general.finditer(command):
        normalized = normalize_repo_path(match.group(1), repo)
        if normalized:
            paths.add(normalized)

    redirection = re.compile(
        r"(?:^|[;&|\s])(?:>|>>|tee(?:\s+-a)?|touch|mkdir(?:\s+-p)?|rm(?:\s+-[^\s]+)*|cp|mv)\s+(['\"]?)([^'\"\s;&|]+)\1"
    )
    for match in redirection.finditer(command):
        normalized = normalize_repo_path(match.group(2), repo)
        if normalized:
            paths.add(normalized)
    return sorted(paths)


def command_from_payload(payload: dict[str, Any]) -> str:
    tool_input = payload.get("tool_input")
    if isinstance(tool_input, dict) and isinstance(tool_input.get("command"), str):
        return tool_input["command"]
    if isinstance(tool_input, str):
        return tool_input
    try:
        return json.dumps(tool_input, ensure_ascii=False, sort_keys=True)
    except TypeError:
        return str(tool_input or "")


def contains_any(text: str, values: Iterable[str]) -> bool:
    low = text.lower()
    return any(str(value).lower() in low for value in values)


def path_matches(path: str, patterns: Iterable[str]) -> bool:
    for raw in patterns:
        value = str(raw)
        if value.endswith("/") and path.startswith(value):
            return True
        if path == value:
            return True
    return False


def is_canonical(path: str, runtime: Runtime) -> bool:
    return path_matches(path, runtime.documents.get("canonical_paths", []))


def is_guarded_canonical(path: str, runtime: Runtime) -> bool:
    return path_matches(path, runtime.documents.get("canonical_guard_paths", []))


def is_source(path: str, runtime: Runtime) -> bool:
    return path_matches(path, runtime.documents.get("source_paths", []))


def is_critical(path: str, runtime: Runtime) -> bool:
    return path_matches(path, runtime.documents.get("critical_paths", []))


def is_policy_path(path: str, runtime: Runtime) -> bool:
    return path_matches(path, runtime.documents.get("policy_paths", []))


def route_for_path(path: str, runtime: Runtime) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for route in runtime.routes:
        if any(path.startswith(str(prefix)) for prefix in route.get("path_prefixes", [])):
            found.append(route)
    if not found and is_guarded_canonical(path, runtime):
        fallback = next((route for route in runtime.routes if route.get("name") == "context-memory"), None)
        if fallback is not None:
            found.append(fallback)
    return sorted(found, key=lambda item: int(item.get("priority", 0)), reverse=True)


def select_routes(prompt: str, runtime: Runtime, cwd: Path | None = None) -> list[dict[str, Any]]:
    low = prompt.lower()
    scored: list[tuple[int, int, dict[str, Any]]] = []
    rel_cwd = ""
    if cwd is not None:
        try:
            rel_cwd = cwd.resolve().relative_to(runtime.repo).as_posix()
        except (ValueError, OSError):
            rel_cwd = ""
    for route in runtime.routes:
        hits = 0
        for keyword in route.get("keywords", []):
            key = str(keyword).lower()
            if key and key in low:
                hits += 1
        for prefix in route.get("path_prefixes", []):
            pfx = str(prefix).lower()
            if pfx and pfx in low:
                hits += 3
            if rel_cwd and rel_cwd.startswith(pfx.rstrip("/")):
                hits += 1
        if hits:
            scored.append((hits, int(route.get("priority", 0)), route))
    scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
    limit = int(runtime.lifecycle.get("max_routes_per_prompt", 2))
    return [item[2] for item in scored[:limit]]


def route_signature(routes: list[dict[str, Any]]) -> str:
    return "+".join(str(route.get("name")) for route in routes) or "narrow"


def route_source_signature(routes: list[dict[str, Any]], runtime: Runtime) -> str:
    sources: list[tuple[str, str]] = []
    for route in routes:
        for rel in route.get("docs", []):
            path = runtime.repo / str(rel)
            if path.exists():
                sources.append((str(rel), file_fingerprint(path)))
        for skill in route.get("skills", []):
            path = runtime.repo / ".agents" / "skills" / str(skill) / "SKILL.md"
            if path.exists():
                sources.append((path.relative_to(runtime.repo).as_posix(), file_fingerprint(path)))
    return hash_text(json.dumps(sources, ensure_ascii=False, sort_keys=True))


def existing_route_docs(routes: list[dict[str, Any]], runtime: Runtime, limit: int = 3) -> list[str]:
    result: list[str] = []
    for route in routes:
        for rel in route.get("docs", []):
            value = str(rel)
            if value not in result and (runtime.repo / value).exists():
                result.append(value)
            if len(result) >= limit:
                return result
    return result


def route_context(routes: list[dict[str, Any]], runtime: Runtime) -> str:
    limit = int(runtime.budget.get("route_context_chars", 1050))
    if not routes:
        if not bool(runtime.lifecycle.get("inject_narrow_route", False)):
            return ""
        return cap(
            "[Context route: narrow] Start from the named files and nearby tests. Do not preload docs/INDEX.md or CURRENT.md unless scope, current state, or an active batch is material.",
            limit,
        )

    names = ", ".join(str(route.get("name")) for route in routes)
    lines = [
        f"[Context route: {names}] Deterministic hook result. Reuse it until scope changes.",
        "Start from target files and nearby tests. Do not scan sibling docs or all skills.",
    ]
    for route in routes:
        instruction = str(route.get("instruction") or "").strip()
        if instruction:
            lines.append(f"- {route.get('name')}: {instruction}")
    docs = existing_route_docs(routes, runtime, limit=3)
    if docs:
        lines.append("Read only when needed, in this order: " + " -> ".join(f"`{item}`" for item in docs) + ".")

    skills: list[str] = []
    for route in routes:
        for name in route.get("skills", []):
            value = str(name)
            if value not in skills and (runtime.repo / ".agents" / "skills" / value / "SKILL.md").exists():
                skills.append(value)
    if "web3-polymarket" in skills:
        lines.append(
            "For public protocol facts, invoke `$web3-polymarket` explicitly. It is read-only here; ignore credential, signing, order, cancellation, deposit, withdrawal, or live-wallet flows."
        )
        skills.remove("web3-polymarket")
    if "polymarket-paper-safety" in skills:
        lines.append(
            "Apply `$polymarket-paper-safety` for runtime or protocol work. The same boundary is also enforced by AGENTS.md and PreToolUse."
        )
        skills.remove("polymarket-paper-safety")
    if "polymarket-context-router" in skills:
        lines.append(
            "Use `$polymarket-context-router` only for multi-document, planning, handoff, or durable-state work. If implicit activation is missed, open `.agents/skills/polymarket-context-router/SKILL.md` directly."
        )
    return cap("\n".join(lines), limit)


def compile_safety_patterns(runtime: Runtime) -> list[re.Pattern[str]]:
    return [re.compile(str(raw)) for raw in runtime.safety.get("block_patterns", [])]


def safety_violation(runtime: Runtime, payload: dict[str, Any]) -> str | None:
    command = command_from_payload(payload)
    for pattern in compile_safety_patterns(runtime):
        if pattern.search(command):
            return str(runtime.safety.get("block_message", "Blocked by repository policy."))
    normalized = command.replace("\\", "/")
    if str(runtime.generated).replace("\\", "/") in normalized:
        return "Generated context state is hook-owned. Change canonical repository documents or `.codex/context-policy.toml` instead."
    return None


def root_creation_candidates(runtime: Runtime, payload: dict[str, Any]) -> set[str]:
    """Return paths that a tool invocation explicitly asks to create.

    Patch bodies and shell commands use different grammars. In particular,
    scanning a TypeScript patch for shell redirection turns ``value >= 0`` into
    a bogus request to create a file named ``0``.
    """
    command = command_from_payload(payload)
    tool_name = str(payload.get("tool_name") or "")
    added: set[str] = set()

    if tool_name == "apply_patch" or "*** Begin Patch" in command:
        for match in re.finditer(r"^\*\*\* Add File:\s*(.+?)\s*$", command, re.MULTILINE):
            normalized = normalize_repo_path(match.group(1), runtime.repo)
            if normalized:
                added.add(normalized)
        return added

    for pattern in (
        r"(?:^|[;&|\s])touch\s+(['\"]?)([^'\"\s;&|]+)\1",
        r"(?:^|[;&|\s])mkdir(?:\s+-p)?\s+(['\"]?)([^'\"\s;&|]+)\1",
        r"(?:^|[;&|\s])(?:>>|>)\s*(['\"]?)([^'\"\s;&|]+)\1",
    ):
        for match in re.finditer(pattern, command):
            normalized = normalize_repo_path(match.group(2), runtime.repo)
            if normalized:
                added.add(normalized)
    return added


def root_creation_violation(runtime: Runtime, state: dict[str, Any], payload: dict[str, Any]) -> str | None:
    prompt = str(state.get("turn_prompt") or "")
    if contains_any(prompt, runtime.commands.get("root_approval_tags", [])):
        return None
    added = root_creation_candidates(runtime, payload)
    root_new = [path for path in added if "/" not in path and not (runtime.repo / path).exists()]
    # AGENTS.md allows root-level creation after the agent explains the reason,
    # purpose, and impact. Keep detection for future observability, but do not
    # block the write or misclassify comparison operators inside patches.
    if root_new:
        return None
    return None


def test_record(payload: dict[str, Any]) -> dict[str, Any] | None:
    command = command_from_payload(payload)
    if not contains_any(command, TEST_WORDS):
        return None
    response = payload.get("tool_response")
    try:
        response_text = json.dumps(response, ensure_ascii=False, sort_keys=True)
    except TypeError:
        response_text = str(response or "")
    failure = bool(
        re.search(
            r"(?i)(?:\bfailed\b|traceback|\berror:|exit code [1-9]|returncode[\"']?\s*[:=]\s*[1-9])",
            response_text,
        )
    )
    if isinstance(response, dict):
        for key in ("exit_code", "returncode", "status_code"):
            value = response.get(key)
            if isinstance(value, int) and value != 0:
                failure = True
    return {
        "ts": iso_now(),
        "command": cap(redact(command), 280),
        "result": "failed" if failure else "observed",
        "response_excerpt": cap(redact(response_text), 220),
    }


def state_changed_paths(runtime: Runtime, state: dict[str, Any]) -> list[str]:
    turn_scoped = bool(state.get("active_turn_id"))
    touched_key = "turn_touched_paths" if turn_scoped else "touched_paths"
    baseline_key = "turn_baseline_git" if turn_scoped else "baseline_git"
    paths = set(str(item) for item in state.get(touched_key, []))
    baseline: dict[str, dict[str, str]] = state.get(baseline_key, {}) or {}
    current = git_status(runtime.repo)
    for path, code in current.items():
        current_fp = file_fingerprint(runtime.repo / path)
        before = baseline.get(path)
        if before is None or before.get("status") != code or before.get("fingerprint") != current_fp:
            paths.add(path)
    for path, before in baseline.items():
        if path not in current and file_fingerprint(runtime.repo / path) != before.get("fingerprint"):
            paths.add(path)
    return sorted(path for path in paths if path)


def semantic_score(runtime: Runtime, state: dict[str, Any], changed: list[str]) -> tuple[int, list[str], bool]:
    if not changed:
        return 0, [], False
    prompt = str(state.get("turn_prompt") or "")
    low = prompt.lower()
    explicit = contains_any(low, EXPLICIT_PERSIST_WORDS) or contains_any(low, runtime.commands.get("persist_tags", []))
    reasons: list[str] = []
    score = 0
    source = [path for path in changed if is_source(path, runtime)]
    critical = [path for path in changed if is_critical(path, runtime)]
    policy = [path for path in changed if is_policy_path(path, runtime)]
    canonical = [path for path in changed if is_canonical(path, runtime)]
    tests = state.get("turn_test_runs") if state.get("active_turn_id") else state.get("test_runs")

    if source:
        score += 1
        reasons.append("source changed")
    if len(changed) >= 6:
        score += 1
        reasons.append("multi-file change")
    if len(changed) >= 14:
        score += 1
        reasons.append("broad change")
    if critical:
        score += 2
        reasons.append("critical domain, adapter, contract, risk, or desktop boundary changed")
    if policy:
        score += 4
        reasons.append("repository policy or orchestration boundary changed")
    if any(path.startswith(("docs/batches/", "reports/batches/")) for path in changed):
        score += 2
        reasons.append("batch scope or evidence changed")
    if contains_any(low, DURABLE_WORDS):
        score += 2
        reasons.append("durable-state language in task")
    if explicit:
        score += 4
        reasons.append("explicit persistence request")
    if tests:
        score += 1
        reasons.append("validation observed")
    if canonical:
        score += 1
        reasons.append("canonical document already changed")
    return score, reasons, explicit


def checkpoint_fingerprint(runtime: Runtime, state: dict[str, Any], changed: list[str], event: str) -> str:
    tests = state.get("turn_test_runs") if state.get("active_turn_id") else state.get("test_runs")
    data = {
        "event": event,
        "turn": state.get("active_turn_id"),
        "routes": state.get("active_routes", []),
        "prompt": state.get("turn_prompt", ""),
        "changed": changed,
        "content": {path: file_fingerprint(runtime.repo / path) for path in changed[:80]},
        "tests": (tests or [])[-4:],
        "assistant": state.get("last_assistant_message", ""),
    }
    return hash_text(json.dumps(data, ensure_ascii=False, sort_keys=True))


def write_recovery(runtime: Runtime, state: dict[str, Any], changed: list[str]) -> None:
    tests = state.get("turn_test_runs") if state.get("active_turn_id") else state.get("test_runs")
    lines = [
        "# Codex recovery capsule",
        "",
        "> Machine-generated and private to this checkout. Canonical repository documents win.",
        "",
        f"- Updated: `{iso_now()}`",
        f"- Branch: `{git_branch(runtime.repo) or '(detached)'}`",
        "- Active routes: " + (", ".join(f"`{item}`" for item in state.get("active_routes", [])) or "none"),
        "",
        "## Latest task excerpt",
        "",
        cap(redact(str(state.get("turn_prompt") or "")), int(runtime.budget.get("checkpoint_prompt_chars", 900))) or "(none)",
        "",
        "## Changed or touched paths",
        "",
    ]
    file_limit = int(runtime.budget.get("checkpoint_file_limit", 50))
    if changed:
        lines.extend(f"- `{path}`" for path in changed[:file_limit])
    else:
        lines.append("- none detected")
    lines.extend(["", "## Validation observed", ""])
    if tests:
        for item in tests[-4:]:
            lines.append(f"- `{item.get('result', 'observed')}`: `{item.get('command', '')}`")
    else:
        lines.append("- none")
    lines.extend([
        "",
        "## Resume rule",
        "",
        "Continue from target files and canonical docs. Use this capsule only to recover uncommitted intent after resume or compaction.",
        "",
    ])
    atomic_write(runtime.recovery_path, "\n".join(lines))


def write_checkpoint(runtime: Runtime, state: dict[str, Any], payload: dict[str, Any], event: str) -> Path | None:
    changed = state_changed_paths(runtime, state)
    fingerprint = checkpoint_fingerprint(runtime, state, changed, event)
    if fingerprint == state.get("last_checkpoint_fingerprint"):
        existing = str(state.get("last_checkpoint_path") or "")
        write_recovery(runtime, state, changed)
        return Path(existing) if existing else None

    now = utc_now()
    session = sanitize_id(str(state.get("session_id")))[:16]
    turn = sanitize_id(str(payload.get("turn_id") or state.get("active_turn_id") or "turn"))[:16]
    folder = runtime.checkpoints_dir / now.date().isoformat()
    path = folder / f"{now.strftime('%H%M%S')}_{session}_{turn}.md"
    tests = state.get("turn_test_runs") if state.get("active_turn_id") else state.get("test_runs")
    score, reasons, explicit = semantic_score(runtime, state, changed)
    lines = [
        "# Codex machine checkpoint",
        "",
        "> Private recovery aid. It is not canonical project truth.",
        "",
        f"- Time: `{iso_now()}`",
        f"- Event: `{event}`",
        f"- Session: `{state.get('session_id')}`",
        f"- Turn: `{payload.get('turn_id') or state.get('active_turn_id') or ''}`",
        f"- Branch: `{git_branch(runtime.repo) or '(detached)'}`",
        f"- Semantic score: `{score}`" + (f" ({'; '.join(reasons)})" if reasons else ""),
        f"- Explicit persistence signal: `{str(explicit).lower()}`",
        "",
        "## Latest task",
        "",
        cap(redact(str(state.get("turn_prompt") or "")), int(runtime.budget.get("checkpoint_prompt_chars", 900))) or "(none)",
        "",
        "## Active routes",
        "",
    ]
    routes = state.get("active_routes", [])
    lines.extend((f"- `{item}`" for item in routes) if routes else ["- none"])
    lines.extend(["", "## Changed or touched paths", ""])
    file_limit = int(runtime.budget.get("checkpoint_file_limit", 50))
    if changed:
        lines.extend(f"- `{item}`" for item in changed[:file_limit])
        if len(changed) > file_limit:
            lines.append(f"- … plus {len(changed) - file_limit} paths")
    else:
        lines.append("- none detected")
    lines.extend(["", "## Validation observed", ""])
    if tests:
        for item in tests[-4:]:
            lines.append(f"- `{item.get('result', 'observed')}`: `{item.get('command', '')}`")
    else:
        lines.append("- none")
    assistant = cap(
        redact(str(state.get("last_assistant_message") or "")),
        int(runtime.budget.get("checkpoint_assistant_chars", 550)),
    )
    if assistant:
        lines.extend(["", "## Last assistant outcome excerpt", "", assistant])
    lines.extend([
        "",
        "## Recovery rule",
        "",
        "Canonical docs and current code beat this checkpoint. Use it only for uncommitted turn intent, routes, touched paths, and observed validation.",
        "",
    ])
    atomic_write(path, "\n".join(lines))
    state["last_checkpoint_fingerprint"] = fingerprint
    state["last_checkpoint_path"] = str(path)
    write_recovery(runtime, state, changed)
    rebuild_index(runtime)
    return path


def latest_files(folder: Path, pattern: str, limit: int) -> list[Path]:
    if not folder.exists():
        return []
    files = [path for path in folder.rglob(pattern) if path.is_file()]
    files.sort(key=lambda item: item.stat().st_mtime, reverse=True)
    return files[:limit]


def rebuild_index(runtime: Runtime) -> None:
    checkpoints = latest_files(runtime.checkpoints_dir, "*.md", 15)
    archives = latest_files(runtime.archive_dir, "*.gz", 8)
    lines = [
        "# Codex private context index",
        "",
        "> Generated outside the tracked worktree. Canonical project truth remains in repository docs.",
        "",
        f"- Recovery capsule: `{runtime.recovery_path}`",
        f"- Maintenance report: `{runtime.maintenance_path}`",
        "",
        "## Recent checkpoints",
        "",
    ]
    if checkpoints:
        lines.extend(f"- `{path.relative_to(runtime.generated).as_posix()}`" for path in checkpoints)
    else:
        lines.append("- none")
    lines.extend(["", "## Compressed checkpoints", ""])
    if archives:
        lines.extend(f"- `{path.relative_to(runtime.generated).as_posix()}`" for path in archives)
    else:
        lines.append("- none")
    lines.append("")
    atomic_write(runtime.index_path, "\n".join(lines))


def maintenance_candidates(runtime: Runtime) -> list[str]:
    targets: list[tuple[Path, int]] = [
        (runtime.repo / str(runtime.documents.get("current", "docs/plan/CURRENT.md")), int(runtime.maintenance.get("current_soft_chars", 14000))),
        (runtime.repo / str(runtime.documents.get("repo_index", "docs/INDEX.md")), int(runtime.maintenance.get("index_soft_chars", 12000))),
    ]
    canonical_soft = int(runtime.maintenance.get("canonical_doc_soft_chars", 26000))
    for base in (runtime.repo / "docs" / "plan", runtime.repo / "docs" / "batches", runtime.repo / "docs" / "spec"):
        if base.exists():
            targets.extend((path, canonical_soft) for path in base.rglob("*.md"))
    candidates: list[str] = []
    seen: set[Path] = set()
    for path, threshold in targets:
        if path in seen or not path.is_file():
            continue
        seen.add(path)
        try:
            size = len(path.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        if size > threshold:
            candidates.append(
                f"`{path.relative_to(runtime.repo).as_posix()}` is {size:,} chars; review for section overwrite or reversible archival."
            )
    return candidates


def compress_old_checkpoints(runtime: Runtime) -> tuple[int, int]:
    compress_days = int(runtime.lifecycle.get("checkpoint_compress_after_days", 7))
    retention_days = int(runtime.lifecycle.get("checkpoint_retention_days", 45))
    now = utc_now().timestamp()
    compressed = 0
    removed = 0
    for path in list(runtime.checkpoints_dir.rglob("*.md")):
        try:
            age = (now - path.stat().st_mtime) / 86400
        except OSError:
            continue
        if age < compress_days:
            continue
        relative = path.relative_to(runtime.checkpoints_dir)
        destination = runtime.archive_dir / "checkpoints" / relative.with_suffix(".md.gz")
        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            with path.open("rb") as source, gzip.open(destination, "wb", compresslevel=6) as target:
                shutil.copyfileobj(source, target)
            path.unlink()
            compressed += 1
        except OSError:
            continue
    archive_root = runtime.archive_dir / "checkpoints"
    if archive_root.exists():
        for path in archive_root.rglob("*.gz"):
            try:
                if (now - path.stat().st_mtime) / 86400 > retention_days:
                    path.unlink()
                    removed += 1
            except OSError:
                pass
    return compressed, removed


def prune_state_and_logs(runtime: Runtime) -> tuple[int, int]:
    state_days = int(runtime.lifecycle.get("state_retention_days", 30))
    log_days = int(runtime.lifecycle.get("log_retention_days", 14))
    now = utc_now().timestamp()
    states = 0
    logs = 0
    for path in runtime.state_dir.glob("*.json"):
        try:
            if (now - path.stat().st_mtime) / 86400 > state_days:
                path.unlink()
                states += 1
        except OSError:
            pass
    for path in runtime.logs_dir.glob("*.jsonl"):
        try:
            if (now - path.stat().st_mtime) / 86400 > log_days:
                path.unlink()
                logs += 1
        except OSError:
            pass
    return states, logs


def maybe_maintain(runtime: Runtime, force: bool = False) -> dict[str, Any]:
    meta = read_json(runtime.meta_path, {})
    last = parse_iso(str(meta.get("last_maintenance_at") or ""))
    interval = int(runtime.lifecycle.get("maintenance_interval_hours", 24))
    due = force or last is None or (utc_now() - last).total_seconds() >= interval * 3600
    if not due:
        return {"ran": False}
    compressed, removed = compress_old_checkpoints(runtime)
    states, logs = prune_state_and_logs(runtime)
    candidates = maintenance_candidates(runtime)
    lines = [
        "# Codex context maintenance",
        "",
        "> Deterministic candidate report. It never rewrites semantic repository documents.",
        "",
        f"- Checked: `{iso_now()}`",
        f"- Checkpoints compressed: `{compressed}`",
        f"- Expired compressed checkpoints removed: `{removed}`",
        f"- Expired session states removed: `{states}`",
        f"- Expired logs removed: `{logs}`",
        "",
        "## Semantic compression candidates",
        "",
    ]
    lines.extend((f"- {item}" for item in candidates) if candidates else ["- none"])
    lines.extend([
        "",
        "## Rule",
        "",
        "Archive the complete original before shortening an active semantic document. Do not compress accepted decisions or evidence reports merely to save context.",
        "",
    ])
    atomic_write(runtime.maintenance_path, "\n".join(lines))
    meta["last_maintenance_at"] = iso_now()
    meta["maintenance_candidates"] = candidates
    atomic_write_json(runtime.meta_path, meta)
    rebuild_index(runtime)
    return {
        "ran": True,
        "compressed": compressed,
        "removed": removed,
        "states": states,
        "logs": logs,
        "candidates": candidates,
    }


def startup_capsule(runtime: Runtime) -> str:
    text = (
        "[Polymarket context orchestrator v2] Keep the normal prefix stable. Do not preload docs/INDEX.md, CURRENT.md, or all skills. "
        "Start from target files and tests; the prompt hook injects at most two routes only when scope or route sources change. "
        "Paper-only boundary: keep LIVE_TRADING_ENABLED=false; never access credentials, signing, live orders, deposits, withdrawals, or real-wallet flows. "
        "Private checkpoints recover interrupted work but never override code or canonical docs. Tags: #ctx:refresh, #ctx:none, #ctx:persist, #ctx:root-ok."
    )
    return cap(text, int(runtime.budget.get("session_context_chars", 850)))


def recovery_context(runtime: Runtime, state: dict[str, Any], reason: str) -> str:
    changed = state_changed_paths(runtime, state)
    if not changed and not runtime.recovery_path.exists():
        return ""
    lines = [
        f"[Recovery after {reason}] Canonical docs and current code still win.",
        "Active routes: " + (", ".join(f"`{item}`" for item in state.get("active_routes", [])) or "none") + ".",
    ]
    if changed:
        lines.append("Uncommitted/touched paths: " + ", ".join(f"`{item}`" for item in changed[:14]) + ".")
    tests = state.get("turn_test_runs") or state.get("test_runs") or []
    if tests:
        lines.append("Last validation: " + "; ".join(f"{item.get('result')}: {item.get('command')}" for item in tests[-2:]) + ".")
    lines.append(
        "Continue from these paths without rediscovering the whole repository. For complex routing, open `.agents/skills/polymarket-context-router/SKILL.md` directly."
    )
    return cap("\n".join(lines), int(runtime.budget.get("recovery_context_chars", 950)))


def session_start(payload: dict[str, Any], runtime: Runtime, state: dict[str, Any]) -> dict[str, Any]:
    source = str(payload.get("source") or "startup")
    state["source"] = source
    if not state.get("baseline_git") or source in ("startup", "clear"):
        state["baseline_git"] = snapshot_dirty(runtime.repo)
    maybe_maintain(runtime)
    context = startup_capsule(runtime)
    if source in ("resume", "compact") and git_status(runtime.repo):
        extra = recovery_context(runtime, state, source)
        if extra:
            context = cap(context + "\n" + extra, int(runtime.budget.get("session_context_chars", 850)) + int(runtime.budget.get("recovery_context_chars", 950)))
    return {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": context,
        }
    }


def user_prompt_submit(payload: dict[str, Any], runtime: Runtime, state: dict[str, Any]) -> dict[str, Any]:
    prompt = redact(str(payload.get("prompt") or ""))
    turn_id = sanitize_id(str(payload.get("turn_id") or f"turn-{int(time.time())}"))
    state["active_turn_id"] = turn_id
    state["turn_started_at"] = iso_now()
    state["turn_baseline_git"] = snapshot_dirty(runtime.repo)
    state["turn_touched_paths"] = []
    state["turn_tool_commands"] = []
    state["turn_test_runs"] = []
    state["turn_prompt"] = cap(prompt, 1800)
    state["canonical_guarded_turn_routes"] = []
    prompts = [item for item in state.get("prompts", []) if isinstance(item, dict)]
    prompts.append({"ts": iso_now(), "turn_id": payload.get("turn_id"), "text": cap(prompt, 1800)})
    state["prompts"] = prompts[-8:]

    cwd = Path(str(payload.get("cwd") or runtime.repo))
    routes = select_routes(prompt, runtime, cwd)
    signature = route_signature(routes)
    source_signature = route_source_signature(routes, runtime)
    state["active_routes"] = [str(route.get("name")) for route in routes]
    history = [str(item) for item in state.get("route_history", [])]
    for name in state["active_routes"]:
        if not history or history[-1] != name:
            history.append(name)
    state["route_history"] = history[-16:]

    if contains_any(prompt, runtime.commands.get("disable_route_tags", [])):
        state["last_route_signature"] = signature
        state["last_route_source_signature"] = source_signature
        return {}

    force = contains_any(prompt, runtime.commands.get("force_refresh_tags", []))
    same_route = signature == state.get("last_route_signature")
    same_sources = source_signature == state.get("last_route_source_signature")
    reinject_sources = bool(runtime.lifecycle.get("reinject_when_sources_change", True))
    state["last_route_signature"] = signature
    state["last_route_source_signature"] = source_signature

    if not force and same_route and (same_sources or not reinject_sources):
        return {}
    context = route_context(routes, runtime)
    if not context:
        return {}
    state["last_injected_turn"] = turn_id
    announced = set(str(item) for item in state.get("announced_routes", []))
    announced.update(state["active_routes"])
    state["announced_routes"] = sorted(announced)
    return {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": context,
        }
    }


def subagent_start(payload: dict[str, Any], runtime: Runtime, state: dict[str, Any]) -> dict[str, Any]:
    routes = state.get("active_routes", [])[-2:]
    context = (
        "Subagent boundary: paper-only, no credentials, signing, live orders, deposits, withdrawals, or real-wallet flows. "
        "Start from assigned files and tests; canonical docs beat private checkpoints."
    )
    if routes:
        context += " Parent routes: " + ", ".join(f"`{item}`" for item in routes) + "."
    return {
        "hookSpecificOutput": {
            "hookEventName": "SubagentStart",
            "additionalContext": cap(context, int(runtime.budget.get("subagent_context_chars", 520))),
        }
    }


def pre_tool_use(payload: dict[str, Any], runtime: Runtime, state: dict[str, Any]) -> dict[str, Any]:
    violation = safety_violation(runtime, payload) or root_creation_violation(runtime, state, payload)
    if violation:
        log_event(runtime, "blocked", {"tool": payload.get("tool_name"), "reason": violation})
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": violation,
            }
        }

    if not bool(runtime.lifecycle.get("canonical_first_write_guard", True)):
        return {}
    tool_name = str(payload.get("tool_name") or "")
    paths = extract_paths(tool_name, payload.get("tool_input"), runtime.repo)
    guarded_paths = [path for path in paths if is_guarded_canonical(path, runtime)]
    if not guarded_paths:
        return {}

    needed: list[dict[str, Any]] = []
    active = set(str(item) for item in state.get("active_routes", []))
    guarded = set(str(item) for item in state.get("canonical_guarded_turn_routes", []))
    for path in guarded_paths:
        for route in route_for_path(path, runtime):
            name = str(route.get("name"))
            if name not in active and name not in guarded and route not in needed:
                needed.append(route)
    if not needed:
        return {}
    for route in needed:
        guarded.add(str(route.get("name")))
    state["canonical_guarded_turn_routes"] = sorted(guarded)
    reason = (
        "Canonical first-write gate. Before retrying, load the exact existing canonical target and its route. "
        "Do not append a session summary or create a duplicate source of truth.\n" + route_context(needed[:2], runtime)
    )
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": cap(reason, int(runtime.budget.get("route_context_chars", 1050)) + 260),
        }
    }


def permission_request(payload: dict[str, Any], runtime: Runtime, state: dict[str, Any]) -> dict[str, Any]:
    violation = safety_violation(runtime, payload) or root_creation_violation(runtime, state, payload)
    if not violation:
        return {}
    return {
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {"behavior": "deny", "message": violation},
        }
    }


def post_tool_use(payload: dict[str, Any], runtime: Runtime, state: dict[str, Any]) -> dict[str, Any]:
    tool_name = str(payload.get("tool_name") or "")
    paths = extract_paths(tool_name, payload.get("tool_input"), runtime.repo)
    all_touched = set(str(item) for item in state.get("touched_paths", []))
    all_touched.update(paths)
    turn_touched = set(str(item) for item in state.get("turn_touched_paths", []))
    turn_touched.update(paths)

    current = git_status(runtime.repo)
    baseline = state.get("baseline_git", {}) or {}
    turn_baseline = state.get("turn_baseline_git", {}) or {}
    for path in current:
        fp = file_fingerprint(runtime.repo / path)
        before = baseline.get(path)
        if before is None or before.get("fingerprint") != fp:
            all_touched.add(path)
        turn_before = turn_baseline.get(path)
        if turn_before is None or turn_before.get("fingerprint") != fp:
            turn_touched.add(path)
    state["touched_paths"] = sorted(all_touched)[:500]
    state["turn_touched_paths"] = sorted(turn_touched)[:500]

    command = cap(redact(command_from_payload(payload)), 360)
    if command:
        commands = [str(item) for item in state.get("tool_commands", [])]
        if not commands or commands[-1] != command:
            commands.append(command)
        state["tool_commands"] = commands[-20:]
        turn_commands = [str(item) for item in state.get("turn_tool_commands", [])]
        if not turn_commands or turn_commands[-1] != command:
            turn_commands.append(command)
        state["turn_tool_commands"] = turn_commands[-12:]
    record = test_record(payload)
    if record:
        tests = [item for item in state.get("test_runs", []) if isinstance(item, dict)]
        tests.append(record)
        state["test_runs"] = tests[-12:]
        turn_tests = [item for item in state.get("turn_test_runs", []) if isinstance(item, dict)]
        turn_tests.append(record)
        state["turn_test_runs"] = turn_tests[-8:]
    return {}


def pre_compact(payload: dict[str, Any], runtime: Runtime, state: dict[str, Any]) -> dict[str, Any]:
    write_checkpoint(runtime, state, payload, "PreCompact")
    return {}


def post_compact(payload: dict[str, Any], runtime: Runtime, state: dict[str, Any]) -> dict[str, Any]:
    # PostCompact does not have a model-context output channel in current Codex releases.
    # SessionStart(source=compact) performs the recovery injection instead. Keep this hook
    # as a deterministic state marker so future compaction paths remain observable.
    del payload
    state["last_compact_recovery_fingerprint"] = file_fingerprint(runtime.recovery_path)
    return {}


def semantic_continuation(runtime: Runtime, changed: list[str], score: int, reasons: list[str]) -> str:
    limit = int(runtime.budget.get("continuation_chars", 1050))
    paths = ", ".join(f"`{path}`" for path in changed[:14]) or "(none)"
    text = textwrap.dedent(
        f"""
        Durable-memory review gate, score {score}: {', '.join(reasons) or 'material change'}.
        Changed paths: {paths}.

        Open `.agents/skills/polymarket-memory-maintainer/SKILL.md` directly. Do not rely on implicit skill activation. Perform exactly one focused review:
        1. Read only the existing canonical target for this change.
        2. If durable truth changed, make the smallest overwrite, decision/spec update, handoff update, or evidence append.
        3. If no durable truth changed, edit no semantic document.
        4. Never append a full turn summary to AGENTS.md or CURRENT.md. Archive the complete original before shortening a living document.
        Finish after this single review.
        """
    ).strip()
    return cap(text, limit)


def stop_event(payload: dict[str, Any], runtime: Runtime, state: dict[str, Any]) -> dict[str, Any]:
    state["last_assistant_message"] = cap(redact(str(payload.get("last_assistant_message") or "")), 1200)
    write_checkpoint(runtime, state, payload, "Stop")
    changed = state_changed_paths(runtime, state)
    score, reasons, explicit = semantic_score(runtime, state, changed)
    canonical_changed = any(is_canonical(path, runtime) for path in changed)
    fingerprint = hash_text(
        json.dumps(
            {
                "turn": state.get("active_turn_id") or payload.get("turn_id"),
                "changed": changed,
                "content": {path: file_fingerprint(runtime.repo / path) for path in changed[:80]},
                "prompt": hash_text(str(state.get("turn_prompt") or "")),
                "score": score,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    meta = read_json(runtime.meta_path, {})

    if bool(payload.get("stop_hook_active")):
        state["semantic_review_at"] = iso_now()
        state["semantic_review_result"] = "canonical-updated" if canonical_changed else "reviewed-no-update"
        meta["last_semantic_review_at"] = iso_now()
        meta["last_semantic_fingerprint"] = fingerprint
        atomic_write_json(runtime.meta_path, meta)
        return {}

    mode = str(runtime.lifecycle.get("semantic_writeback_mode", "explicit_or_high_confidence"))
    if mode in ("off", "checkpoint_only") or canonical_changed or not changed:
        return {}

    threshold = int(runtime.lifecycle.get("semantic_score_threshold", 8))
    explicit_min = int(runtime.lifecycle.get("semantic_explicit_min_score", 5))
    urgent = int(runtime.lifecycle.get("urgent_score_threshold", 11))
    should_score = score >= threshold
    should_explicit = explicit and score >= explicit_min
    if mode == "explicit_only":
        candidate = should_explicit
    elif mode == "high_confidence_only":
        candidate = should_score
    else:
        candidate = should_score or should_explicit

    last_request = parse_iso(str(meta.get("last_semantic_request_at") or ""))
    cooldown_minutes = int(runtime.lifecycle.get("semantic_cooldown_minutes", 360))
    cooling = last_request is not None and (utc_now() - last_request).total_seconds() < cooldown_minutes * 60
    same = fingerprint in {
        str(state.get("semantic_request_fingerprint") or ""),
        str(meta.get("last_semantic_fingerprint") or ""),
    }
    if not candidate or same or (cooling and score < urgent):
        return {}

    state["semantic_request_fingerprint"] = fingerprint
    state["semantic_request_at"] = iso_now()
    meta["last_semantic_request_at"] = iso_now()
    meta["last_semantic_fingerprint"] = fingerprint
    meta["last_semantic_session"] = state.get("session_id")
    meta["last_semantic_turn"] = state.get("active_turn_id") or payload.get("turn_id")
    atomic_write_json(runtime.meta_path, meta)
    return {
        "decision": "block",
        "reason": semantic_continuation(runtime, changed, score, reasons),
    }


def handle_hook(payload: dict[str, Any], runtime: Runtime) -> dict[str, Any]:
    event = str(payload.get("hook_event_name") or "")
    session_id = sanitize_id(str(payload.get("session_id") or "unknown"))
    with file_lock(runtime.lock_path(session_id)):
        state = load_state(runtime, payload)
        if event == "SessionStart":
            output = session_start(payload, runtime, state)
        elif event == "UserPromptSubmit":
            output = user_prompt_submit(payload, runtime, state)
        elif event == "SubagentStart":
            output = subagent_start(payload, runtime, state)
        elif event == "PreToolUse":
            output = pre_tool_use(payload, runtime, state)
        elif event == "PermissionRequest":
            output = permission_request(payload, runtime, state)
        elif event == "PostToolUse":
            output = post_tool_use(payload, runtime, state)
        elif event == "PreCompact":
            output = pre_compact(payload, runtime, state)
        elif event == "PostCompact":
            output = post_compact(payload, runtime, state)
        elif event == "Stop":
            output = stop_event(payload, runtime, state)
        else:
            output = {}
        save_state(runtime, state)
    log_event(runtime, event or "unknown", {"session": session_id, "output": bool(output)})
    return output


def handler_is_ours(group: dict[str, Any]) -> bool:
    hooks = group.get("hooks", [])
    if not isinstance(hooks, list):
        return False
    for hook in hooks:
        if not isinstance(hook, dict):
            continue
        command = str(hook.get("command", "")) + str(hook.get("commandWindows", ""))
        if "context_orchestrator.py" in command:
            return True
    return False


def doctor(repo: Path) -> int:
    errors: list[str] = []
    warnings: list[str] = []
    if sys.version_info < (3, 11):
        errors.append("Python 3.11+ is required.")
    required = (
        "AGENTS.md",
        "docs/INDEX.md",
        "docs/plan/CURRENT.md",
        ".codex/config.toml",
        ".codex/hooks.json",
        ".codex/context-policy.toml",
        ".codex/hooks/context_orchestrator.py",
        ".agents/skills/polymarket-context-router/SKILL.md",
        ".agents/skills/polymarket-memory-maintainer/SKILL.md",
        ".agents/skills/polymarket-paper-safety/SKILL.md",
    )
    for rel in required:
        if not (repo / rel).exists():
            errors.append(f"Missing expected path: {rel}")

    runtime: Runtime | None = None
    try:
        policy = load_policy(repo)
        runtime = Runtime(repo, policy)
        compile_safety_patterns(runtime)
        if len(startup_capsule(runtime)) > int(runtime.budget.get("session_context_chars", 850)):
            errors.append("Startup capsule exceeds configured budget")
    except Exception as exc:
        errors.append(f"Policy/runtime error: {exc}")

    try:
        with (repo / ".codex" / "config.toml").open("rb") as handle:
            config = tomllib.load(handle)
        if config.get("features", {}).get("hooks") is not True:
            errors.append(".codex/config.toml must set [features].hooks = true")
    except Exception as exc:
        errors.append(f"Codex config error: {exc}")

    try:
        hooks = json.loads((repo / ".codex" / "hooks.json").read_text(encoding="utf-8"))
        table = hooks.get("hooks")
        if not isinstance(table, dict):
            errors.append(".codex/hooks.json has no hooks object")
        else:
            for event in REQUIRED_HOOK_EVENTS:
                groups = table.get(event)
                if not isinstance(groups, list) or not any(isinstance(group, dict) and handler_is_ours(group) for group in groups):
                    errors.append(f"Missing context orchestrator handler for event: {event}")
    except Exception as exc:
        errors.append(f"Hook config error: {exc}")

    agents = (repo / "AGENTS.md").read_text(encoding="utf-8", errors="replace") if (repo / "AGENTS.md").exists() else ""
    if "codex-context-orchestrator:start" not in agents:
        warnings.append("AGENTS.md has no orchestrator marker block")
    if "每个实质性项目任务开始前，完整读取" in agents:
        errors.append("AGENTS.md still contains the old unconditional full-read rule")
    index = (repo / "docs" / "INDEX.md").read_text(encoding="utf-8", errors="replace") if (repo / "docs" / "INDEX.md").exists() else ""
    if "codex-context-orchestrator:index-start" not in index:
        warnings.append("docs/INDEX.md has no cache-aware minimum-read marker")

    web3_yaml = repo / ".agents" / "skills" / "web3-polymarket" / "agents" / "openai.yaml"
    if web3_yaml.exists() and "allow_implicit_invocation: false" not in web3_yaml.read_text(encoding="utf-8", errors="replace"):
        errors.append("web3-polymarket must be explicit-only in this paper-only repository")

    if runtime is not None:
        try:
            maybe_maintain(runtime, force=True)
        except Exception as exc:
            errors.append(f"Context state write error: {exc}")

    print(f"Codex context orchestrator doctor v{VERSION}")
    print(f"Repository: {repo}")
    if runtime is not None:
        print(f"Private state root: {runtime.state_root}")
        print(f"Recovery capsule: {runtime.recovery_path}")
    for warning in warnings:
        print(f"WARN: {warning}")
    for error in errors:
        print(f"ERROR: {error}")
    print("RESULT: OK" if not errors else "RESULT: FAILED")
    return 0 if not errors else 1


def print_status(runtime: Runtime) -> None:
    print(
        json.dumps(
            {
                "version": VERSION,
                "repository": str(runtime.repo),
                "state_root": str(runtime.state_root),
                "recovery": str(runtime.recovery_path),
                "recovery_exists": runtime.recovery_path.exists(),
                "session_states": len(list(runtime.state_dir.glob("*.json"))),
                "recent_checkpoints": [str(path) for path in latest_files(runtime.checkpoints_dir, "*.md", 5)],
                "meta": read_json(runtime.meta_path, {}),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def route_cli(runtime: Runtime, prompt: str) -> None:
    routes = select_routes(prompt, runtime, runtime.repo)
    print(
        json.dumps(
            {
                "routes": [str(route.get("name")) for route in routes],
                "source_signature": route_source_signature(routes, runtime),
                "context": route_context(routes, runtime),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def print_recovery(runtime: Runtime) -> None:
    if runtime.recovery_path.exists():
        print(runtime.recovery_path.read_text(encoding="utf-8", errors="replace"))
    else:
        print("No recovery capsule exists yet.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", help="Repository root; defaults to git root from cwd")
    parser.add_argument("--doctor", action="store_true", help="Validate installation and budgets")
    parser.add_argument("--status", action="store_true", help="Print private context state")
    parser.add_argument("--maintain", action="store_true", help="Rotate checkpoints and scan semantic size candidates")
    parser.add_argument("--route", metavar="PROMPT", help="Show deterministic route for a prompt")
    parser.add_argument("--recovery", action="store_true", help="Print the current private recovery capsule")
    parser.add_argument("--checkpoint", action="store_true", help="Write a manual checkpoint using a synthetic session")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    repo = find_repo(args.repo)
    if args.doctor:
        return doctor(repo)
    try:
        policy = load_policy(repo)
        runtime = Runtime(repo, policy)
        if args.status:
            print_status(runtime)
            return 0
        if args.maintain:
            print(json.dumps(maybe_maintain(runtime, force=True), ensure_ascii=False, indent=2))
            return 0
        if args.route is not None:
            route_cli(runtime, args.route)
            return 0
        if args.recovery:
            print_recovery(runtime)
            return 0
        if args.checkpoint:
            payload = {"session_id": "manual", "turn_id": "manual", "hook_event_name": "Stop"}
            with file_lock(runtime.lock_path("manual")):
                state = load_state(runtime, payload)
                state["baseline_git"] = {}
                state["turn_baseline_git"] = {}
                state["active_turn_id"] = "manual"
                path = write_checkpoint(runtime, state, payload, "Manual")
                save_state(runtime, state)
            print(path or "checkpoint unchanged")
            return 0

        payload = read_stdin_payload()
        output = handle_hook(payload, runtime)
        event = str(payload.get("hook_event_name") or "")
        if output or event == "Stop":
            json_stdout(output)
        return 0
    except Exception as exc:
        try:
            fallback_repo = find_repo(args.repo)
            policy = load_policy(fallback_repo)
            runtime = Runtime(fallback_repo, policy)
            log_event(runtime, "hook-error", {"error": repr(exc)})
        except Exception:
            pass
        if os.environ.get("CODEX_CONTEXT_HOOK_DEBUG") == "1":
            print(f"context hook error: {exc}", file=sys.stderr)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
