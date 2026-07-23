import { loadAppStatus, type AppStatusTransport } from "../../services/app-status.js";
import type { AppStatusV1 } from "../../types/app-status.js";
import type { WorkbenchViewData } from "../domain/read-model.js";
import type { WorkbenchManifestV1 } from "../domain/workbench.js";
import type { WorkbenchDataSource } from "../ports/workbench-data-source.js";
import { parseWorkbenchManifestV1 } from "./workbench-manifest.js";

export type WorkbenchCommand =
  | "get_app_status_v1"
  | "get_workbench_manifest_v1"
  | "get_workbench_view_v1"
  | "list_strategy_definitions_v1"
  | "list_strategy_versions_v1"
  | "get_strategy_version_v1"
  | "validate_strategy_parameters_v1"
  | "save_strategy_version_v1"
  | "delete_strategy_version_v1"
  | "delete_dataset_v1"
  | "delete_backtest_v1"
  | "register_dataset_source_v1"
  | "normalize_raw_dataset_v1"
  | "start_backtest_v1"
  | "get_backtest_job_v1"
  | "list_backtest_jobs_v1"
  | "stop_backtest_v1"
  | "get_backtest_result_v1"
  | "get_backtest_decisions_v1"
  | "get_backtest_orders_v1"
  | "get_backtest_fills_v1"
  | "get_backtest_settlements_v1"
  | "get_backtest_equity_v1"
  | "get_backtest_replay_v1"
  | "compare_backtests_v1"
  | "get_system_health_v1"
  | "list_system_incidents_v1"
  | "scan_datasets_v1"
  | "list_datasets_v1"
  | "get_dataset_v1"
  | "validate_dataset_selection_v1"
  | "list_paper_sessions_v1"
  | "get_paper_replay_v1"
  | "get_paper_market_host_status_v1"
  | "get_paper_market_runtime_v1"
  | "get_paper_strategy_runtime_v1"
  | "start_public_paper_market_host_v1"
  | "stop_public_paper_market_host_v1"
  | "start_paper_session_v1"
  | "get_paper_session_status_v1"
  | "stop_paper_session_v1"
  | "resume_paper_session_v1"
  | "get_paper_session_detail_v1"
  | "submit_paper_order_v1"
  | "cancel_paper_order_v1"
  | "reprice_paper_order_v1"
  | "expire_paper_orders_v1"
  | "settle_paper_market_v1"
  | "get_paper_system_control_v1"
  | "set_paper_kill_switch_v1";

export interface WorkbenchCommandTransport extends AppStatusTransport {
  invoke(command: WorkbenchCommand, args?: Readonly<Record<string, unknown>>): Promise<unknown>;
}

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: Readonly<{ invoke(command: string, args?: Readonly<Record<string, unknown>>): Promise<unknown> }>;
};

function notAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new DOMException("request aborted", "AbortError");
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string`);
  return value;
}

function strings(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${path} must be a string array`);
  }
  return value as string[];
}

/** Strict parser for the UI read model. It intentionally accepts no file paths or database handles. */
export function parseWorkbenchViewV1(value: unknown): WorkbenchViewData {
  const root = record(value, "workbench view");
  const expected = ["schemaVersion", "sourceKind", "decisions", "chartSeries", "runs"].sort();
  if (Object.keys(root).sort().join("\0") !== expected.join("\0") || root.schemaVersion !== "workbench-view-v1") {
    throw new Error("workbench view has an unsupported shape");
  }
  if (root.sourceKind !== "verified-local") throw new Error("desktop command may only return verified-local data");
  if (!Array.isArray(root.decisions) || !Array.isArray(root.runs)) throw new Error("workbench collections must be arrays");
  const chart = record(root.chartSeries, "chartSeries");
  const chartKeys = ["raw", "calibrated", "bid", "ask", "pnl", "brier"].sort();
  if (Object.keys(chart).sort().join("\0") !== chartKeys.join("\0")) throw new Error("chartSeries has an unsupported shape");
  const chartSeries = Object.fromEntries(chartKeys.map((key) => {
    const values = chart[key];
    if (!Array.isArray(values) || values.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
      throw new Error(`chartSeries.${key} must contain finite numbers`);
    }
    return [key, values];
  })) as unknown as WorkbenchViewData["chartSeries"];
  const decisions = root.decisions.map((item, index) => {
    const row = record(item, `decisions[${index}]`);
    const keys = ["id", "time", "event", "market", "direction", "probability", "price", "edge", "eligibility", "pnl"];
    if (Object.keys(row).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error(`decisions[${index}] has an unsupported shape`);
    const parsed = Object.fromEntries(keys.map((key) => [key, string(row[key], `decisions[${index}].${key}`)]));
    return parsed as unknown as WorkbenchViewData["decisions"][number];
  });
  const runs = root.runs.map((item, index) => {
    const run = record(item, `runs[${index}]`);
    const keys = ["id", "name", "pnl", "drawdown", "brier", "color"];
    if (Object.keys(run).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error(`runs[${index}] has an unsupported shape`);
    strings(keys.map((key) => run[key]), `runs[${index}]`);
    return Object.fromEntries(keys.map((key) => [key, run[key]])) as unknown as WorkbenchViewData["runs"][number];
  });
  return { sourceKind: "verified-local", decisions, chartSeries, runs };
}

export function browserTauriTransport(): WorkbenchCommandTransport {
  return {
    async invoke(command, args) {
      const invoke = (window as TauriWindow).__TAURI_INTERNALS__?.invoke;
      if (invoke === undefined) throw new Error("Tauri command bridge is unavailable");
      return invoke(command, args);
    },
  };
}

/** Same-origin Web adapter. It can reach only the fixed local backend command endpoint. */
export function browserWebTransport(): WorkbenchCommandTransport {
  return {
    async invoke(command, args) {
      const response = await fetch(`/api/commands/${encodeURIComponent(command)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-workbench-client": "web-v1" },
        body: JSON.stringify(args ?? {}),
        credentials: "omit",
        redirect: "error",
      });
      const value: unknown = await response.json();
      const envelope = record(value, "Web backend response");
      const expected = envelope.ok === true ? ["schemaVersion", "ok", "result"] : ["schemaVersion", "ok", "error"];
      if (Object.keys(envelope).sort().join("\0") !== expected.sort().join("\0") || envelope.schemaVersion !== "workbench-web-response-v1") throw new Error("Web backend response is invalid");
      if (envelope.ok !== true) {
        const error = record(envelope.error, "Web backend error");
        if (Object.keys(error).sort().join("\0") !== ["code", "message"].sort().join("\0")) throw new Error("Web backend error is invalid");
        throw new Error(string(error.message, "Web backend error.message"));
      }
      return envelope.result;
    },
  };
}

export function createTauriWorkbenchDataSource(transport: WorkbenchCommandTransport): WorkbenchDataSource {
  return {
    async loadAppStatus(signal): Promise<AppStatusV1> {
      notAborted(signal);
      const result = await loadAppStatus(transport);
      notAborted(signal);
      return result;
    },
    async loadManifest(signal): Promise<WorkbenchManifestV1> {
      notAborted(signal);
      const result = parseWorkbenchManifestV1(await transport.invoke("get_workbench_manifest_v1"));
      notAborted(signal);
      return result;
    },
    async loadViewData(signal): Promise<WorkbenchViewData> {
      notAborted(signal);
      const result = parseWorkbenchViewV1(await transport.invoke("get_workbench_view_v1"));
      notAborted(signal);
      return result;
    },
  };
}

export const createWorkbenchDataSource = createTauriWorkbenchDataSource;
