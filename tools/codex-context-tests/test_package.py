from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / ".codex" / "hooks" / "context_orchestrator.py"


class PackageTests(unittest.TestCase):
    def test_hook_json_is_valid_and_has_required_events(self) -> None:
        data = json.loads((ROOT / ".codex" / "hooks.json").read_text(encoding="utf-8"))
        events = set(data["hooks"])
        required = {"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "Stop"}
        self.assertTrue(required.issubset(events))

    def test_policy_and_script_load(self) -> None:
        self.assertTrue((ROOT / ".codex" / "context-policy.toml").is_file())
        spec = importlib.util.spec_from_file_location("context_orchestrator", SCRIPT)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)
        self.assertEqual(module.VERSION, "2.0.0")

    def test_redaction(self) -> None:
        spec = importlib.util.spec_from_file_location("context_orchestrator_redact", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)
        self.assertNotIn("sk-secretvalue123456", module.redact("key=sk-secretvalue123456"))


if __name__ == "__main__":
    unittest.main()
