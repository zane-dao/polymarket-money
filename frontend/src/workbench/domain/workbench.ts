export const WORKBENCH_ROUTE_IDS = [
  "overview",
  "live",
  "decisions",
  "strategy",
  "datasets",
  "backtest",
  "replay",
  "compare",
  "health",
] as const;

export type WorkbenchRouteId = (typeof WORKBENCH_ROUTE_IDS)[number];

export type DataAvailability =
  | Readonly<{ status: "ready"; asOfUtc: string }>
  | Readonly<{ status: "unavailable"; reason: string }>
  | Readonly<{ status: "loading" }>;

export type WorkbenchCapability = Readonly<{
  routeId: WorkbenchRouteId;
  label: string;
  shortLabel: string;
  availability: DataAvailability;
}>;

export type WorkbenchManifestV1 = Readonly<{
  schemaVersion: "workbench-manifest-v1";
  generatedAtUtc: string;
  capabilities: readonly WorkbenchCapability[];
}>;

export type WorkbenchState = Readonly<{
  activeRoute: WorkbenchRouteId;
  selectedDecisionId: string | null;
  selectedRunIds: readonly string[];
  selectedStrategyId: string | null;
  selectedStrategyVersion: string | null;
  replayPositionPermille: number;
  replayPlaying: boolean;
  paperTicketOpen: boolean;
  helpOpen: boolean;
  dataView: "auto" | "verified" | "demo";
}>;

export type WorkbenchAction =
  | Readonly<{ type: "navigate"; routeId: WorkbenchRouteId }>
  | Readonly<{ type: "select-decision"; decisionId: string | null }>
  | Readonly<{ type: "toggle-run"; runId: string }>
  | Readonly<{ type: "select-strategy-version"; strategyId: string; version: string }>
  | Readonly<{ type: "seek-replay"; positionPermille: number }>
  | Readonly<{ type: "set-replay-playing"; playing: boolean }>
  | Readonly<{ type: "set-paper-ticket-open"; open: boolean }>
  | Readonly<{ type: "set-help-open"; open: boolean }>
  | Readonly<{ type: "set-data-view"; dataView: "auto" | "verified" | "demo" }>;

export const INITIAL_WORKBENCH_STATE: WorkbenchState = Object.freeze({
  activeRoute: "overview",
  selectedDecisionId: null,
  selectedRunIds: Object.freeze([]),
  selectedStrategyId: null,
  selectedStrategyVersion: null,
  replayPositionPermille: 0,
  replayPlaying: false,
  paperTicketOpen: false,
  helpOpen: false,
  dataView: "auto",
});

function clampPermille(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1000, Math.round(value)));
}

export function reduceWorkbenchState(
  state: WorkbenchState,
  action: WorkbenchAction,
): WorkbenchState {
  switch (action.type) {
    case "navigate":
      return { ...state, activeRoute: action.routeId };
    case "select-decision":
      return { ...state, selectedDecisionId: action.decisionId };
    case "toggle-run": {
      const selected = new Set(state.selectedRunIds);
      if (selected.has(action.runId)) {
        selected.delete(action.runId);
      } else {
        selected.add(action.runId);
      }
      return { ...state, selectedRunIds: [...selected] };
    }
    case "select-strategy-version":
      return { ...state, selectedStrategyId: action.strategyId, selectedStrategyVersion: action.version };
    case "seek-replay":
      return { ...state, replayPositionPermille: clampPermille(action.positionPermille) };
    case "set-replay-playing":
      return { ...state, replayPlaying: action.playing };
    case "set-paper-ticket-open":
      return { ...state, paperTicketOpen: action.open };
    case "set-help-open":
      return { ...state, helpOpen: action.open };
    case "set-data-view":
      return { ...state, dataView: action.dataView };
  }
}
