"""Unified ``poly-lab`` command line for replay, observation, paper, and storage audit."""

from __future__ import annotations

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
from typing import Any, Sequence

from .backtest import (
    DatasetAcceptancePolicy,
    ExecutionConfig,
    ExecutionModel,
    ExecutionScenario,
    FeeModel,
    FeeSchedule,
    NoTradeStrategy,
    ReplayEngine,
)
from .normalized import NormalizedDatasetBuilder
from .runtime import (
    GIB,
    MIN_FREE_BYTES,
    ReplayPacer,
    ReplaySpeed,
    _default_decision_points,
    _settlement_times,
    inventory_directory,
    load_strategy_plugin,
)


def _json_default(value: object) -> object:
    if hasattr(value, "value"):
        return getattr(value, "value")
    return str(value)


def _write_json(value: object, output: Path | None) -> None:
    body = json.dumps(value, default=_json_default, indent=2, sort_keys=True) + "\n"
    if output is None:
        sys.stdout.write(body)
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as handle:
        handle.write(body)


def _parse_bytes(value: str) -> int:
    normalized = value.strip().lower()
    factors = {"b": 1, "kib": 1024, "mib": 1024**2, "gib": 1024**3}
    for suffix in sorted(factors, key=len, reverse=True):
        if normalized.endswith(suffix):
            number = normalized[: -len(suffix)]
            try:
                result = int(number) * factors[suffix]
            except ValueError as exc:
                raise argparse.ArgumentTypeError("byte limit must be an integer with B/KiB/MiB/GiB") from exc
            if result <= 0:
                raise argparse.ArgumentTypeError("byte limit must be positive")
            return result
    raise argparse.ArgumentTypeError("byte limit requires B/KiB/MiB/GiB suffix")


def _run_replay(args: argparse.Namespace) -> int:
    dataset_path = Path(args.dataset).resolve(strict=True)
    dataset = NormalizedDatasetBuilder.load(dataset_path)
    strategy = (
        NoTradeStrategy(_default_decision_points(dataset))
        if args.strategy == "no-trade"
        else load_strategy_plugin(args.strategy, dataset)
    )
    pacer = ReplayPacer(ReplaySpeed(args.speed))
    if hasattr(signal, "SIGUSR1"):
        signal.signal(signal.SIGUSR1, lambda *_: pacer.pause())
        signal.signal(signal.SIGUSR2, lambda *_: pacer.resume())
    pacer.pace(strategy.decision_points())
    policy = DatasetAcceptancePolicy()
    engine = ReplayEngine.open(
        dataset_path,
        expected_dataset_hash=args.dataset_hash,
        execution_model=ExecutionModel(
            ExecutionConfig(ExecutionScenario.TAKER_TOUCH_WITH_FEES),
            fee_model=FeeModel(
                FeeSchedule(version="poly-lab-empty-fee-schedule", historical_verified=False, rates=())
            ),
            acceptance_policy=policy,
        ),
        acceptance_policy=policy,
        require_clean_normalizer=not args.allow_dirty_fixture,
    )
    result = engine.run(strategy, settlement_times=_settlement_times(dataset))
    _write_json(result.to_mapping(), Path(args.output) if args.output else None)
    return 0


def _repository_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _run_live(args: argparse.Namespace) -> int:
    if args.record == "raw":
        if args.duration is None or args.max_bytes is None or args.output is None:
            raise SystemExit("raw mode requires --duration, --max-bytes, and --output")
        duration = args.duration
    else:
        duration = args.duration or 60
    root = _repository_root()
    built = root / "dist/scripts/live-runtime.js"
    if not built.is_file():
        raise SystemExit("TypeScript runtime is not built; run npm run build")
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    command = [
        "node",
        "--use-env-proxy",
        str(built),
        args.command,
        "--duration-seconds",
        str(duration),
        "--record",
        args.record,
        "--git-commit",
        commit,
    ]
    if args.output is not None:
        command.extend(["--output", str(Path(args.output).resolve())])
    if args.max_bytes is not None:
        command.extend(["--max-bytes", str(args.max_bytes)])
    if args.summary is not None:
        command.extend(["--summary", str(Path(args.summary).resolve())])
    command.append("--json")
    if args.json or not sys.stdout.isatty():
        return subprocess.run(command, cwd=root, check=False).returncode

    from rich.console import Console
    from rich.live import Live
    from rich.table import Table

    def table(view: dict[str, Any]) -> Table:
        result = Table(title=f"poly-lab {view.get('mode', args.command)}")
        result.add_column("Field", style="cyan", no_wrap=True)
        result.add_column("Value")
        rows = (
            ("At", view.get("at")),
            ("Current / next", f"{view.get('currentMarket') or '-'} / {view.get('nextMarket') or '-'}"),
            ("Book", f"{view.get('bookState')} · continuity {view.get('continuity')}"),
            ("UP bid / ask", _quote(view.get("up"))),
            ("DOWN bid / ask", _quote(view.get("down"))),
            ("Chainlink BTC/USD", view.get("chainlink")),
            ("Binance spot", view.get("binanceSpot")),
            ("Binance perpetual", view.get("binancePerpetual")),
            ("Opportunities", len(view.get("opportunities", []))),
            ("Disk free bytes", view.get("diskFreeBytes")),
            ("Raw bytes/hour", view.get("rawWriteBytesPerHour")),
        )
        for label, value in rows:
            result.add_row(label, "-" if value is None else str(value))
        return result

    def _quote(value: object) -> str:
        if not isinstance(value, dict):
            return "-"
        return f"{value.get('bid', '-')} / {value.get('ask', '-')}"

    process = subprocess.Popen(
        command,
        cwd=root,
        stdout=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    summary: dict[str, Any] | None = None
    placeholder = Table(title=f"poly-lab {args.command}")
    placeholder.add_column("Status")
    placeholder.add_row("Waiting for public market data")
    assert process.stdout is not None
    with Live(placeholder, refresh_per_second=4) as live:
        for line in process.stdout:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if value.get("type") == "runtime_snapshot":
                live.update(table(value))
            elif value.get("type") == "runtime_summary":
                summary = value
    return_code = process.wait()
    if summary is not None:
        Console().print_json(data=summary)
    return return_code


def _run_inventory(args: argparse.Namespace) -> int:
    root = Path(args.path).resolve(strict=True)
    before = root.stat()
    report = inventory_directory(root).to_mapping()
    selected_hashes: dict[str, str] = {}
    for raw in args.sha256:
        selected = Path(raw).resolve(strict=True)
        if root not in selected.parents:
            raise SystemExit("--sha256 file must be inside inventory root")
        digest = sha256()
        with selected.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        selected_hashes[str(selected.relative_to(root))] = digest.hexdigest()
    report["selected_full_sha256"] = selected_hashes
    after = root.stat()
    if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
        raise RuntimeError("inventory root changed during read-only scan")
    _write_json(report, Path(args.output) if args.output else None)
    return 0


def _command_output(command: Sequence[str]) -> str:
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else f"UNAVAILABLE: {result.stderr.strip()}"


def _run_storage_report(args: argparse.Namespace) -> int:
    data_root = Path(args.data_root).resolve(strict=True)
    root_stats = os.statvfs(data_root)
    d_stats = os.statvfs("/mnt/d")
    linux_free = root_stats.f_bavail * root_stats.f_frsize
    d_free = d_stats.f_bavail * d_stats.f_frsize
    powershell = "/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe"
    query = (
        "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\*' "
        "| Select-Object DistributionName,BasePath | ConvertTo-Json -Compress"
    )
    base_path_raw = _command_output([powershell, "-NoProfile", "-Command", query])
    try:
        distributions: Any = json.loads(base_path_raw)
    except json.JSONDecodeError:
        distributions = base_path_raw
    report = {
        "df_hT": _command_output(["df", "-hT"]),
        "findmnt": _command_output(["findmnt", "-o", "TARGET,SOURCE,FSTYPE,OPTIONS"]),
        "poly_data_root": str(data_root),
        "poly_data_root_filesystem": _command_output(["findmnt", "-T", str(data_root), "-n", "-o", "SOURCE,FSTYPE,TARGET"]),
        "windows_d_filesystem": _command_output(["findmnt", "-T", "/mnt/d", "-n", "-o", "SOURCE,FSTYPE,TARGET"]),
        "wsl_distributions": distributions,
        "ext4_vhdx": "/mnt/d/WSL/Ubuntu/ext4.vhdx",
        "wsl_linux_free_bytes_virtual": linux_free,
        "windows_d_free_bytes_physical": d_free,
        "raw_physical_consumption": "D:\\WSL\\Ubuntu\\ext4.vhdx",
        "local_safe_capacity_bytes": max(0, min(linux_free, d_free - MIN_FREE_BYTES)),
        "local_safe_capacity_gib": max(0, min(linux_free, d_free - MIN_FREE_BYTES)) / GIB,
        "warning": "ext4 free space is virtual; physical D: free space is the binding limit",
    }
    _write_json(report, Path(args.output) if args.output else None)
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="poly-lab")
    commands = root.add_subparsers(dest="command", required=True)

    replay = commands.add_parser("replay")
    replay.add_argument("--dataset", required=True)
    replay.add_argument("--dataset-hash", required=True)
    replay.add_argument("--strategy", default="no-trade", help="no-trade or module:function")
    replay.add_argument("--speed", choices=[item.value for item in ReplaySpeed], default="max")
    replay.add_argument("--output")
    replay.add_argument("--allow-dirty-fixture", action="store_true", help=argparse.SUPPRESS)
    replay.set_defaults(handler=_run_replay)

    for name in ("monitor", "paper"):
        live = commands.add_parser(name)
        live.add_argument("--duration", type=int)
        live.add_argument("--record", choices=("none", "metrics", "raw"), default="metrics")
        live.add_argument("--max-bytes", type=_parse_bytes)
        live.add_argument("--output")
        live.add_argument("--summary")
        live.add_argument("--json", action="store_true")
        live.set_defaults(handler=_run_live)

    inventory = commands.add_parser("inventory")
    inventory.add_argument("--path", default="/mnt/d/polymarket-data")
    inventory.add_argument("--sha256", action="append", default=[])
    inventory.add_argument("--output")
    inventory.set_defaults(handler=_run_inventory)

    storage = commands.add_parser("storage-report")
    storage.add_argument("--data-root", default="/root/polymarket-money-data")
    storage.add_argument("--output")
    storage.set_defaults(handler=_run_storage_report)
    return root


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    return int(args.handler(args))


if __name__ == "__main__":
    raise SystemExit(main())
