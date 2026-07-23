from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest


MODULE_PATH = Path(__file__).parents[1] / "hooks" / "context_orchestrator.py"
SPEC = importlib.util.spec_from_file_location("context_orchestrator", MODULE_PATH)
assert SPEC and SPEC.loader
HOOK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOOK)


class RootCreationCandidatesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.runtime = SimpleNamespace(repo=Path(__file__).parents[2])

    def test_typescript_comparison_in_patch_is_not_shell_redirection(self) -> None:
        payload = {
            "tool_name": "apply_patch",
            "tool_input": (
                "*** Begin Patch\n"
                "*** Update File: frontend/src/example.tsx\n"
                "@@\n"
                "-const tone = item.value > 0 ? 'up' : 'down'\n"
                "+const tone = item.value >= 0 ? 'up' : 'down'\n"
                "*** End Patch\n"
            ),
        }

        self.assertEqual(HOOK.root_creation_candidates(self.runtime, payload), set())

    def test_apply_patch_only_reports_explicit_add_file_headers(self) -> None:
        payload = {
            "tool_name": "apply_patch",
            "tool_input": (
                "*** Begin Patch\n"
                "*** Add File: ROOT_NOTE.md\n"
                "+reason\n"
                "*** End Patch\n"
            ),
        }

        self.assertEqual(HOOK.root_creation_candidates(self.runtime, payload), {"ROOT_NOTE.md"})

    def test_shell_redirection_is_still_detected(self) -> None:
        payload = {
            "tool_name": "exec_command",
            "tool_input": {"cmd": "printf '%s\\n' note > ROOT_NOTE.md"},
        }

        self.assertEqual(HOOK.root_creation_candidates(self.runtime, payload), {"ROOT_NOTE.md"})


if __name__ == "__main__":
    unittest.main()
