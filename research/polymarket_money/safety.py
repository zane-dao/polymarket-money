"""Fail-closed Batch 1 execution boundary.

The module contains no SDK imports, credential readers, signing code, network
calls, or live execution implementation.  Configuration is injected as a
mapping so tests never read the process environment implicitly.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import Enum
from typing import Protocol

from .domain import OrderIntent


class RuntimeEnvironment(str, Enum):
    TEST = "test"
    DEVELOPMENT = "development"
    PRODUCTION = "production"


class ExecutionMode(str, Enum):
    DRY_RUN = "dry-run"
    LIVE = "live"


class CredentialMode(str, Enum):
    NONE = "none"
    PROVIDED = "provided"


class OrderSubmissionOutcome(str, Enum):
    DRY_RUN = "dry-run"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    UNKNOWN = "unknown"


class SafetyConfigurationError(ValueError):
    """Safety configuration contains ambiguous or invalid semantics."""


class LiveClientCreationDenied(PermissionError):
    """The fail-closed gate rejected creation of a live client."""


class IdempotencyConflict(ValueError):
    """An idempotency key was reused for different order content."""


@dataclass(frozen=True, slots=True)
class OrderSubmissionResult:
    outcome: OrderSubmissionOutcome
    exchange_order_id: str | None = None
    detail: str | None = None


class ExecutionClient(Protocol):
    def submit(self, intent: OrderIntent) -> OrderSubmissionResult: ...


@dataclass(frozen=True, slots=True)
class SafetyConfig:
    environment: RuntimeEnvironment = RuntimeEnvironment.DEVELOPMENT
    mode: ExecutionMode = ExecutionMode.DRY_RUN
    live_trading_enabled: bool = False
    credential_mode: CredentialMode = CredentialMode.NONE
    explicit_live_authorization: bool = False

    @classmethod
    def from_mapping(cls, values: Mapping[str, str]) -> SafetyConfig:
        forbidden_legacy_flags = {"PROD", "FORCE_PROD"}.intersection(values)
        if forbidden_legacy_flags:
            flags = ", ".join(sorted(forbidden_legacy_flags))
            raise SafetyConfigurationError(
                f"legacy production flags are forbidden because they create a second truth: {flags}"
            )

        live_enabled = _parse_bool(
            values.get("LIVE_TRADING_ENABLED", "false"),
            "LIVE_TRADING_ENABLED",
        )
        dry_run = _parse_bool(values.get("DRY_RUN", "true"), "DRY_RUN")
        if live_enabled and dry_run:
            raise SafetyConfigurationError(
                "LIVE_TRADING_ENABLED=true conflicts with DRY_RUN=true"
            )
        try:
            environment = RuntimeEnvironment(values.get("APP_ENV", "development").lower())
            credential_mode = CredentialMode(
                values.get("CREDENTIAL_MODE", "none").lower()
            )
        except ValueError as error:
            raise SafetyConfigurationError(str(error)) from error

        authorization = _parse_bool(
            values.get("EXPLICIT_LIVE_AUTHORIZATION", "false"),
            "EXPLICIT_LIVE_AUTHORIZATION",
        )
        return cls(
            environment=environment,
            mode=ExecutionMode.LIVE if live_enabled else ExecutionMode.DRY_RUN,
            live_trading_enabled=live_enabled,
            credential_mode=credential_mode,
            explicit_live_authorization=authorization,
        )


def _parse_bool(raw: str, field_name: str) -> bool:
    value = raw.strip().lower()
    if value == "true":
        return True
    if value == "false":
        return False
    raise SafetyConfigurationError(f"{field_name} must be exactly true or false")


class DryRunExecutionClient:
    """Offline client that records no credentials and performs no I/O."""

    def submit(self, intent: OrderIntent) -> OrderSubmissionResult:
        return OrderSubmissionResult(
            outcome=OrderSubmissionOutcome.DRY_RUN,
            detail=f"offline dry-run for {intent.intent_id}",
        )


def create_execution_client(
    config: SafetyConfig,
    *,
    live_factory: Callable[[], ExecutionClient] | None = None,
) -> ExecutionClient:
    """Return only an offline client in Batch 1; every live path fails closed."""

    if config.mode is not ExecutionMode.LIVE:
        return DryRunExecutionClient()
    if config.environment is RuntimeEnvironment.TEST:
        raise LiveClientCreationDenied("test environment cannot create a live client")
    if not config.live_trading_enabled:
        raise LiveClientCreationDenied("LIVE_TRADING_ENABLED is false")
    if not config.explicit_live_authorization:
        raise LiveClientCreationDenied("explicit live authorization is missing")
    if config.credential_mode is not CredentialMode.PROVIDED:
        raise LiveClientCreationDenied("live mode requires an approved credential provider")

    # A real adapter is deliberately absent in Batch 1.  Keep the injected
    # factory unreachable so a misconfigured test or application still cannot
    # create a network-capable client.
    del live_factory
    raise LiveClientCreationDenied("Batch 1 contains no live execution adapter")


class SubmissionCoordinator:
    """Deduplicate order intents and never retry an unknown submission result."""

    def __init__(self, client: ExecutionClient) -> None:
        self._client = client
        self._submitted: dict[str, tuple[OrderIntent, OrderSubmissionResult]] = {}

    def submit(self, intent: OrderIntent) -> OrderSubmissionResult:
        existing = self._submitted.get(intent.idempotency_key)
        if existing is not None:
            existing_intent, existing_result = existing
            if existing_intent != intent:
                raise IdempotencyConflict(
                    "idempotency key is already bound to a different order intent"
                )
            return existing_result

        result = self._client.submit(intent)
        self._submitted[intent.idempotency_key] = (intent, result)
        return result
