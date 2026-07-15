from pathlib import Path
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
        self.assertNotIn("FORCE_PROD", env_example)
        self.assertNotIn("\nPROD=", env_example)


if __name__ == "__main__":
    unittest.main()
