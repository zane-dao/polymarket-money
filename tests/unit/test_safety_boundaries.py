from datetime import datetime, timezone
from decimal import Decimal
import unittest

from research.polymarket_money.domain import OrderIntent, Side
from research.polymarket_money.safety import (
    CredentialMode,
    ExecutionMode,
    IdempotencyConflict,
    LiveClientCreationDenied,
    OrderSubmissionOutcome,
    OrderSubmissionResult,
    RuntimeEnvironment,
    SafetyConfig,
    SafetyConfigurationError,
    SubmissionCoordinator,
    create_execution_client,
)


UTC = timezone.utc


def make_intent(*, idempotency_key: str = "decision-1:up:buy") -> OrderIntent:
    return OrderIntent(
        intent_id="intent-1",
        idempotency_key=idempotency_key,
        decision_id="decision-1",
        market_id="market-1",
        token_id="up-token",
        side=Side.BUY,
        limit_price=Decimal("0.52"),
        quantity=Decimal("5"),
        decision_time=datetime(2026, 7, 15, 12, 1, tzinfo=UTC),
        order_send_time=None,
    )


class RecordingClient:
    def __init__(self, result: OrderSubmissionResult) -> None:
        self.result = result
        self.calls = 0

    def submit(self, intent: OrderIntent) -> OrderSubmissionResult:
        self.calls += 1
        return self.result


class SafetyBoundariesTest(unittest.TestCase):
    def test_defaults_are_live_off_dry_run_and_credentialless(self) -> None:
        config = SafetyConfig()

        self.assertFalse(config.live_trading_enabled)
        self.assertEqual(config.mode, ExecutionMode.DRY_RUN)
        self.assertEqual(config.credential_mode, CredentialMode.NONE)
        self.assertFalse(config.explicit_live_authorization)

    def test_conflicting_prod_flags_are_rejected(self) -> None:
        with self.assertRaises(SafetyConfigurationError):
            SafetyConfig.from_mapping({"PROD": "true", "FORCE_PROD": "true"})

    def test_default_client_is_offline_dry_run(self) -> None:
        client = create_execution_client(SafetyConfig())

        result = client.submit(make_intent())

        self.assertEqual(result.outcome, OrderSubmissionOutcome.DRY_RUN)
        self.assertIsNone(result.exchange_order_id)

    def test_test_environment_cannot_create_live_client(self) -> None:
        factory_calls = 0

        def live_factory() -> RecordingClient:
            nonlocal factory_calls
            factory_calls += 1
            return RecordingClient(
                OrderSubmissionResult(outcome=OrderSubmissionOutcome.ACCEPTED)
            )

        config = SafetyConfig(
            environment=RuntimeEnvironment.TEST,
            mode=ExecutionMode.LIVE,
            live_trading_enabled=True,
            credential_mode=CredentialMode.PROVIDED,
            explicit_live_authorization=True,
        )

        with self.assertRaises(LiveClientCreationDenied):
            create_execution_client(config, live_factory=live_factory)
        self.assertEqual(factory_calls, 0)

    def test_missing_explicit_authorization_fails_closed(self) -> None:
        config = SafetyConfig(
            environment=RuntimeEnvironment.DEVELOPMENT,
            mode=ExecutionMode.LIVE,
            live_trading_enabled=True,
            credential_mode=CredentialMode.PROVIDED,
            explicit_live_authorization=False,
        )

        with self.assertRaises(LiveClientCreationDenied):
            create_execution_client(
                config,
                live_factory=lambda: RecordingClient(
                    OrderSubmissionResult(outcome=OrderSubmissionOutcome.ACCEPTED)
                ),
            )

    def test_even_fully_authorized_production_cannot_create_batch_one_live_client(self) -> None:
        factory_calls = 0

        def live_factory() -> RecordingClient:
            nonlocal factory_calls
            factory_calls += 1
            return RecordingClient(
                OrderSubmissionResult(outcome=OrderSubmissionOutcome.ACCEPTED)
            )

        config = SafetyConfig(
            environment=RuntimeEnvironment.PRODUCTION,
            mode=ExecutionMode.LIVE,
            live_trading_enabled=True,
            credential_mode=CredentialMode.PROVIDED,
            explicit_live_authorization=True,
        )

        with self.assertRaises(LiveClientCreationDenied):
            create_execution_client(config, live_factory=live_factory)
        self.assertEqual(factory_calls, 0)

    def test_unknown_order_outcome_is_not_automatically_retried(self) -> None:
        client = RecordingClient(
            OrderSubmissionResult(outcome=OrderSubmissionOutcome.UNKNOWN)
        )
        coordinator = SubmissionCoordinator(client)
        intent = make_intent()

        first = coordinator.submit(intent)
        second = coordinator.submit(intent)

        self.assertEqual(first.outcome, OrderSubmissionOutcome.UNKNOWN)
        self.assertEqual(second, first)
        self.assertEqual(client.calls, 1)

    def test_idempotency_key_cannot_be_reused_for_different_intent(self) -> None:
        client = RecordingClient(
            OrderSubmissionResult(outcome=OrderSubmissionOutcome.UNKNOWN)
        )
        coordinator = SubmissionCoordinator(client)
        first = make_intent()
        second = OrderIntent(
            intent_id="intent-2",
            idempotency_key=first.idempotency_key,
            decision_id="decision-2",
            market_id=first.market_id,
            token_id=first.token_id,
            side=first.side,
            limit_price=first.limit_price,
            quantity=first.quantity,
            decision_time=first.decision_time,
            order_send_time=None,
        )

        coordinator.submit(first)
        with self.assertRaises(IdempotencyConflict):
            coordinator.submit(second)
        self.assertEqual(client.calls, 1)

    def test_order_intent_requires_an_idempotency_key(self) -> None:
        with self.assertRaises(ValueError):
            make_intent(idempotency_key="")


if __name__ == "__main__":
    unittest.main()
