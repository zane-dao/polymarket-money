from pathlib import Path
import json
import tomllib
import unittest


class ConfigurationTest(unittest.TestCase):
    def test_pyproject_is_valid_and_safe_by_default(self) -> None:
        root = Path(__file__).resolve().parents[2]
        config = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
        env_example = (root / ".env.example").read_text(encoding="utf-8")

        self.assertEqual(config["project"]["name"], "polymarket-money")
        self.assertEqual(
            config["tool"]["setuptools"]["packages"],
            ["research", "research.polymarket_money"],
        )
        self.assertIn("LIVE_TRADING_ENABLED=false", env_example)
        self.assertIn("DRY_RUN=true", env_example)
        self.assertIn("CREDENTIAL_MODE=none", env_example)
        self.assertIn("POLY_DATA_ROOT=/tmp/polymarket-money-data", env_example)
        self.assertNotIn("FORCE_PROD", env_example)
        self.assertNotIn("\nPROD=", env_example)

    def test_raw_event_json_schema_and_ignore_boundaries(self) -> None:
        root = Path(__file__).resolve().parents[2]
        schema = json.loads(
            (root / "contracts" / "raw-event-v1.schema.json").read_text(encoding="utf-8")
        )
        required = set(schema["required"])
        self.assertTrue(
            {
                "source_time",
                "server_time",
                "receive_time",
                "process_time",
                "persist_time",
                "raw_payload",
                "raw_sha256",
            }.issubset(required)
        )
        self.assertFalse(schema["additionalProperties"])
        ignore = (root / ".gitignore").read_text(encoding="utf-8")
        for rule in (".env", "data/raw/*", "node_modules/", ".venv/", "*.log", "*.db", "review-packs/"):
            self.assertIn(rule, ignore)


if __name__ == "__main__":
    unittest.main()
