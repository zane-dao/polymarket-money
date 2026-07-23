import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/app/App.js";
import { PREVIEW_WORKBENCH_DATA } from "../src/workbench/data/preview-data.js";
import {
  parsePaperStrategyRuntimeV1,
  type WorkbenchCommands,
} from "../src/workbench/services/workbench-commands.js";
import type { WorkbenchViewData } from "../src/workbench/domain/read-model.js";

const EMPTY_VERIFIED_DATA: WorkbenchViewData = {
  sourceKind: "verified-local",
  decisions: [],
  runs: [],
  chartSeries: {
    raw: [],
    calibrated: [],
    bid: [],
    ask: [],
    pnl: [],
    brier: [],
  },
};

beforeEach(() => window.history.replaceState(null, "", "/"));
const READY_PAPER_MARKET = {
  schemaVersion: "paper-market-runtime-v1" as const,
  status: "READY" as const,
  checkedAtUtc: "2026-07-21T00:00:01.000Z",
  market: {
    marketId: "market-1",
    conditionId: "condition-1",
    slug: "btc-updown-5m-1775181000",
    intervalStart: "2026-07-21T00:00:00.000Z",
    intervalEnd: "2026-07-21T00:05:00.000Z",
    decisionTime: "2026-07-21T00:00:00.900Z",
    continuity: "UNVERIFIED" as const,
    bookAgeMs: 8,
    signalAgeMs: 5,
    up: { tokenId: "1", bid: "0.49", ask: "0.5", bidSize: "10", askSize: "11" },
    down: {
      tokenId: "2",
      bid: "0.5",
      ask: "0.51",
      bidSize: "12",
      askSize: "13",
    },
    signal: {
      provider: "BINANCE_SPOT" as const,
      price: "67842.31",
      sourceTime: "2026-07-21T00:00:00.800Z",
      serverTime: "2026-07-21T00:00:00.850Z",
      receiveTime: "2026-07-21T00:00:00.895Z",
    },
    feeEvidence: {
      schemaVersion: "paper-fee-evidence-v1" as const,
      model: "POLYMARKET_TAKER_CURVE_V1" as const,
      conditionId: "condition-1",
      rate: "0.01",
      effectiveFromUtc: "2026-07-21T00:00:00.000Z",
      effectiveToUtc: "2026-07-21T00:05:00.000Z",
      evidenceStatus: "UNVERIFIED" as const,
      evidenceReference: "test-fixture",
    },
  },
};

function commands(): WorkbenchCommands {
  const hostStatus = {
    schemaVersion: "paper-market-host-status-v1" as const,
    hostId: "desktop-paper-host",
    feedId: "unconfigured",
    source: "PUBLIC_MARKET_DATA" as const,
    executionMode: "PAPER_ONLY" as const,
    lifecycle: "STOPPED" as const,
    connection: "DISCONNECTED" as const,
    ready: false,
    cachedMarketCount: 0,
    snapshotCount: 0,
    gapCount: 0,
    errorCount: 0,
    lastSnapshotAtUtc: null,
    lastConnectionAtUtc: null,
    events: [],
  };
  return {
    getAppStatus: vi.fn(async () => ({
      schemaVersion: "app-status-v1" as const,
      generatedAtUtc: "2026-07-21T00:00:00Z",
      appVersion: "0.1.0",
      mode: "paper-only" as const,
      liveTradingEnabled: false as const,
      dataRootConfigured: true,
      modules: [],
    })),
    getPaperMarketHostStatus: vi.fn(async () => hostStatus),
    getPaperMarketRuntime: vi.fn(async () => ({
      schemaVersion: "paper-market-runtime-v1" as const,
      status: "STOPPED" as const,
      checkedAtUtc: "1970-01-01T00:00:00.000Z",
      market: null,
    })),
    startPaperRunner: vi.fn(async () => ({
      ...hostStatus,
      lifecycle: "RUNNING" as const,
      connection: "CONNECTED" as const,
    })),
    startPublicPaperMarketHost: vi.fn(async () => ({
      ...hostStatus,
      lifecycle: "RUNNING" as const,
      connection: "CONNECTED" as const,
    })),
    stopPublicPaperMarketHost: vi.fn(async () => hostStatus),
    getPaperStrategyRuntime: vi.fn(async () => ({
      schemaVersion: "paper-strategy-runtime-v2" as const,
      status: "STOPPED" as const,
      executionAuthority: "PAPER_SESSION" as const,
      planner: {
        engineVersion: "kj-paper-engine-v2" as const,
        journalRecordCount: 0,
        recoveredInputCount: 0,
        lastRecordHash: null,
        error: null,
      },
      canonicalAccounts: [],
      executionLinks: [],
      shadow: { nonAuthoritative: true as const, snapshot: null, events: [] },
    })),
    listPaperSessions: vi.fn(async () => []),
    getPaperReplay: vi.fn(async () => ({
      schemaVersion: "paper-replay-page-v1" as const,
      page: 1,
      pageSize: 100,
      totalItems: 0,
      totalPages: 0,
      items: [],
    })),
    startPaperSession: vi.fn(async (request) => ({
      schemaVersion: "paper-session-view-v1" as const,
      sessionId: request.sessionId,
      status: "RUNNING" as const,
      adapterId: "public-feed",
      startedAtUtc: request.startedAtUtc,
      updatedAtUtc: request.startedAtUtc,
      cash: request.initialCash,
      openOrderCount: 0,
      fillCount: 0,
      systemKillSwitchEnabled: false,
    })),
    getPaperSessionStatus: vi.fn(),
    stopPaperSession: vi.fn(),
    resumePaperSession: vi.fn(),
    getPaperSessionDetail: vi.fn(),
    submitPaperOrder: vi.fn(),
    cancelPaperOrder: vi.fn(),
    repricePaperOrder: vi.fn(),
    expirePaperOrders: vi.fn(),
    settlePaperMarket: vi.fn(),
    getPaperSystemControl: vi.fn(async () => ({
      schemaVersion: "paper-system-control-v1" as const,
      killSwitchEnabled: false,
      updatedAtUtc: "1970-01-01T00:00:00.000Z",
      reason: "INITIAL_STATE",
    })),
    setPaperKillSwitch: vi.fn(async (enabled, reason) => ({
      schemaVersion: "paper-system-control-v1" as const,
      killSwitchEnabled: enabled,
      updatedAtUtc: "2026-07-21T00:00:00Z",
      reason,
    })),
    listStrategyDefinitions: vi.fn(async () => [
      {
        strategyId: "J_FEE_AWARE",
        displayName: "费用感知概率策略（J）",
        runtime: "python" as const,
        allowedModes: ["backtest", "paper"] as const,
        parameters: {
          threshold: {
            type: "number" as const,
            required: true,
            defaultValue: 0.25,
            minimum: 0,
            maximum: 1,
          },
        },
      },
    ]),
    listStrategyVersions: vi.fn(async () => ["1.0.0"]),
    getStrategyVersion: vi.fn(async (strategyId, version) => ({
      schemaVersion: "strategy-version-v1" as const,
      strategyId,
      version,
      description: "后端保存版本",
      parameters: { threshold: 0.4 },
      createdAtUtc: "2026-07-21T00:00:00Z",
    })),
    validateStrategyParameters: vi.fn(async () => ({
      schemaVersion: "strategy-validation-v1" as const,
      valid: true,
      errors: [],
    })),
    saveStrategyVersion: vi.fn(async (value) => value),
    registerDatasetSource: vi.fn(async () => ({
      schemaVersion: "registered-dataset-source-v1" as const,
      sourceId: "b".repeat(64),
      registeredAtUtc: "2026-07-21T00:00:00Z",
      datasetCount: 1,
      rawDataPolicy: "read-only-not-copied" as const,
    })),
    normalizeRawDataset: vi.fn(async (request) => ({
      schemaVersion: "normalized-dataset-publication-v1" as const,
      datasetId: request.datasetId,
      versionHash: "c".repeat(64),
      format: "normalized-events-v1" as const,
      rowCount: 4,
      sourceFileCount: 1,
      startTimeUtc: "2026-01-01T00:00:00Z",
      endTimeUtc: "2026-01-01T00:05:01Z",
      rawDataPolicy: "read-only-not-copied" as const,
    })),
    scanDatasets: vi.fn(async () => ({
      schemaVersion: "dataset-scan-v1" as const,
      scannedAtUtc: "2026-07-21T00:00:00Z",
      datasetCount: 1,
      datasets: [
        {
          schemaVersion: "dataset-list-item-v1" as const,
          datasetId: "btc",
          versionHash: "a".repeat(64),
          format: "external-historical-v1" as const,
          continuity: "UNVERIFIED" as const,
          startTimeUtc: null,
          endTimeUtc: null,
          rowCount: 1,
          quarantineCount: 0,
          status: "available" as const,
        },
      ],
    })),
    listDatasets: vi.fn(async () => ({
      schemaVersion: "dataset-list-v1" as const,
      scannedAtUtc: "2026-07-21T00:00:00Z",
      datasets: [
        {
          schemaVersion: "dataset-list-item-v1" as const,
          datasetId: "btc",
          versionHash: "a".repeat(64),
          format: "external-historical-v1" as const,
          continuity: "UNVERIFIED" as const,
          startTimeUtc: null,
          endTimeUtc: null,
          rowCount: 1,
          quarantineCount: 0,
          status: "available" as const,
        },
      ],
    })),
    getDataset: vi.fn(async (datasetId, versionHash) => ({
      schemaVersion: "dataset-detail-v1" as const,
      datasetId,
      versionHash,
      format: "external-historical-v1" as const,
      continuity: "UNVERIFIED" as const,
      startTimeUtc: null,
      endTimeUtc: null,
      rowCount: 1,
      quarantineCount: 0,
      status: "available" as const,
      selectionReady: true as const,
      rawDataPolicy: "read-only-not-copied" as const,
    })),
    validateDatasetSelection: vi.fn(async (selection) => ({
      schemaVersion: "validated-dataset-selection-v1" as const,
      datasetId: selection.datasetId,
      versionHash: selection.versionHash,
      validatedAtUtc: "2026-07-21T00:00:00Z",
    })),
    startBacktest: vi.fn(async (request) => ({
      schemaVersion: "backtest-job-v1" as const,
      runId: "bt-1",
      requestId: request.requestId,
      status: "queued" as const,
      progressPermille: 0,
      error: null,
    })),
    getBacktestJob: vi.fn(async () => ({
      schemaVersion: "backtest-job-v1" as const,
      runId: "bt-1",
      requestId: "request-ui-1",
      status: "running" as const,
      progressPermille: 500,
      error: null,
    })),
    listBacktestJobs: vi.fn(async () => []),
    stopBacktest: vi.fn(async () => ({
      schemaVersion: "backtest-job-v1" as const,
      runId: "bt-1",
      requestId: "request-ui-1",
      status: "stopping" as const,
      progressPermille: 500,
      error: null,
    })),
    getBacktestResult: vi.fn(),
    getBacktestDecisions: vi.fn(),
    getBacktestOrders: vi.fn(),
    getBacktestFills: vi.fn(),
    getBacktestSettlements: vi.fn(),
    getBacktestEquity: vi.fn(),
    getBacktestReplay: vi.fn(),
    compareBacktests: vi.fn(async () => []),
    getSystemHealth: vi.fn(async () => ({
      schemaVersion: "system-health-v1" as const,
      status: "degraded" as const,
      checkedAtUtc: "2026-07-21T00:00:00Z",
      database: "unavailable" as const,
      datasets: "healthy" as const,
      jobs: "healthy" as const,
      activeJobs: 0,
      failedJobs: 0,
      liveTradingEnabled: false as const,
      executionMode: "paper-only" as const,
    })),
    listSystemIncidents: vi.fn(async () => ({
      schemaVersion: "query-page-v1" as const,
      page: 1,
      pageSize: 100,
      totalItems: 0,
      totalPages: 0,
      items: [],
    })),
  };
}

describe("workbench command interactions", () => {
  it("strictly rejects unexpected K/J strategy runtime fields", () => {
    expect(() =>
      parsePaperStrategyRuntimeV1({
        schemaVersion: "paper-strategy-runtime-v2",
        status: "STOPPED",
        executionAuthority: "PAPER_SESSION",
        planner: {
          engineVersion: "kj-paper-engine-v2",
          journalRecordCount: 0,
          recoveredInputCount: 0,
          lastRecordHash: null,
          error: null,
        },
        canonicalAccounts: [],
        executionLinks: [],
        shadow: { nonAuthoritative: true, snapshot: null, events: [] },
        unexpected: "mock",
      }),
    ).toThrow(/unexpected or missing fields/);
  });
  it("validates and saves a strategy through the backend command client", async () => {
    const client = commands();
    const user = userEvent.setup();
    render(<App commands={client} initialData={PREVIEW_WORKBENCH_DATA} />);
    await user.click(
      screen
        .getByRole("navigation", { name: "主导航" })
        .querySelectorAll("a")[3]!,
    );
    await screen.findByDisplayValue("费用感知概率策略（J）");
    expect(screen.getByLabelText("版本")).toHaveValue("1.0.1");
    expect(screen.getByLabelText("参数 threshold")).toHaveValue(0.25);
    await user.click(screen.getByRole("button", { name: "验证参数" }));
    expect(client.validateStrategyParameters).toHaveBeenCalledWith("J_FEE_AWARE", {
      threshold: 0.25,
    });
    await user.click(screen.getByRole("button", { name: "保存版本" }));
    expect(client.saveStrategyVersion).toHaveBeenCalled();
    expect(
      await screen.findByText(/已由后端保存不可变版本/),
    ).toBeInTheDocument();
  });

  it("shows backend-owned research warnings without blocking a strategy version", async () => {
    const client = commands();
    vi.mocked(client.validateStrategyParameters).mockResolvedValue({
      schemaVersion: "strategy-validation-v1",
      valid: true,
      errors: [],
      warnings: [{ code: "NARROW_EDGE_WINDOW", severity: "warning", message: "可交易优势区间很窄" }],
    });
    const user = userEvent.setup();
    render(<App commands={client} initialData={PREVIEW_WORKBENCH_DATA} />);
    await user.click(screen.getByRole("navigation", { name: "主导航" }).querySelectorAll("a")[3]!);
    await screen.findByDisplayValue("费用感知概率策略（J）");
    await user.click(screen.getByRole("button", { name: "验证参数" }));
    expect(await screen.findByLabelText("研究告警")).toHaveTextContent("可交易优势区间很窄");
    await user.click(screen.getByRole("button", { name: "保存版本" }));
    expect(client.saveStrategyVersion).toHaveBeenCalled();
  });

  it("reloads an immutable strategy version through the backend command client", async () => {
    const client = commands();
    const user = userEvent.setup();
    render(<App commands={client} initialData={PREVIEW_WORKBENCH_DATA} />);
    await user.click(
      screen
        .getByRole("navigation", { name: "主导航" })
        .querySelectorAll("a")[3]!,
    );
    await screen.findByRole("option", { name: "1.0.0" });
    await user.click(screen.getByRole("button", { name: "加载版本" }));
    expect(client.getStrategyVersion).toHaveBeenCalledWith("J_FEE_AWARE", "1.0.0");
    expect(await screen.findByDisplayValue("后端保存版本")).toBeInTheDocument();
    expect(screen.getByLabelText("参数 threshold")).toHaveValue(0.4);
    expect(screen.getByLabelText("版本")).toHaveValue("1.0.1");
    expect(screen.getByLabelText("当前策略摘要")).toHaveTextContent("2026");
  });

  it("renders backend allowed modes and never invents Paper eligibility for L V2", async () => {
    const client = commands();
    vi.mocked(client.listStrategyDefinitions).mockResolvedValue([
      {
        strategyId: "L_ADAPTIVE_EXECUTION_V2",
        displayName: "L V2",
        runtime: "python",
        allowedModes: ["backtest"],
        parameters: {},
      },
    ]);
    vi.mocked(client.listStrategyVersions).mockResolvedValue([]);
    const user = userEvent.setup();
    render(<App commands={client} initialData={PREVIEW_WORKBENCH_DATA} />);
    await user.click(
      screen
        .getByRole("navigation", { name: "主导航" })
        .querySelectorAll("a")[3]!,
    );
    const modes = await screen.findByLabelText("允许模式");
    expect(modes).toHaveValue("backtest");
    expect((modes as HTMLInputElement).value).not.toContain("paper");
  });

  it("keeps frozen baselines and failed L V1 out of the editable strategy selector", async () => {
    const client = commands();
    vi.mocked(client.listStrategyDefinitions).mockResolvedValue([
      { strategyId: "B0_NO_TRADE", displayName: "永不交易基线（B0）", summary: "冻结对照", researchStatus: "RESEARCH_ONLY", runtime: "python", allowedModes: [], parameters: {} },
      { strategyId: "J_FEE_AWARE", displayName: "费用感知概率策略（J）", researchStatus: "PAPER_READY", runtime: "python", allowedModes: ["backtest", "paper"], parameters: { threshold: { type: "number", required: true, defaultValue: 0.25 } } },
      { strategyId: "L_ADAPTIVE_EXECUTION_V1", displayName: "自适应执行（L V1 · 历史门失败）", summary: "保留用于审计，不能运行。", researchStatus: "RESEARCH_GATE_FAILED", runtime: "python", allowedModes: [], parameters: {} },
    ]);
    const user = userEvent.setup();
    render(<App commands={client} initialData={PREVIEW_WORKBENCH_DATA} />);
    await user.click(screen.getByRole("navigation", { name: "主导航" }).querySelectorAll("a")[3]!);
    const selector = await screen.findByLabelText("策略 ID");
    expect(selector).toHaveValue("J_FEE_AWARE");
    expect(selector.querySelector('option[value="B0_NO_TRADE"]')).toBeNull();
    expect(selector.querySelector('option[value="L_ADAPTIVE_EXECUTION_V1"]')).toBeNull();
    expect(screen.queryByText("研究对照基线（B0–B3）")).not.toBeInTheDocument();
    expect(screen.getByText("历史门失败策略（只读审计）")).toBeInTheDocument();
    expect(screen.getByText("保留用于审计，不能运行。")).toBeInTheDocument();
  });

  it("scans, inspects and validates a dataset only through backend commands", async () => {
    const client = commands();
    const user = userEvent.setup();
    render(<App commands={client} initialData={PREVIEW_WORKBENCH_DATA} />);
    await user.click(screen.getByRole("link", { name: /数据集管理/ }));
    await screen.findByRole("heading", { name: "Btc" });
    expect(screen.getByText("生成时间").parentElement).toHaveTextContent("未记录");
    await user.click(screen.getByRole("button", { name: "重新扫描" }));
    expect(client.scanDatasets).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "详情与校验" }));
    expect(client.getDataset).toHaveBeenCalledWith("btc", "a".repeat(64));
    expect(client.validateDatasetSelection).toHaveBeenCalledWith({
      schemaVersion: "dataset-selection-request-v1",
      datasetId: "btc",
      versionHash: "a".repeat(64),
    });
    expect(await screen.findByText("read-only-not-copied")).toBeInTheDocument();
    expect(screen.getByLabelText("当前研究会话")).toHaveTextContent("btc");
    await user.click(screen.getByRole("button", { name: /下一步：选择策略/ }));
    await screen.findByRole("heading", { name: /策略工作室/ });
    await user.click(await screen.findByRole("button", { name: "使用此版本回测" }));
    expect(await screen.findByRole("heading", { name: /回测实验室/ })).toBeInTheDocument();
    expect(screen.getByLabelText("回测数据集")).toHaveValue(`btc:${"a".repeat(64)}`);
  });

  it("registers an explicit absolute normalized root only through the backend", async () => {
    const client = commands();
    const user = userEvent.setup();
    render(<App commands={client} initialData={PREVIEW_WORKBENCH_DATA} />);
    await user.click(screen.getByRole("link", { name: /数据集管理/ }));
    await user.type(
      await screen.findByLabelText("外部 normalized 发布根"),
      "/mnt/history/normalized",
    );
    await user.click(screen.getByRole("button", { name: "登记标准化数据源" }));
    expect(client.registerDatasetSource).toHaveBeenCalledWith({
      schemaVersion: "dataset-source-registration-request-v1",
      sourceDirectory: "/mnt/history/normalized",
    });
    expect(client.scanDatasets).toHaveBeenCalled();
    expect(await screen.findByText(/后端已登记只读数据源/)).toBeInTheDocument();
  });

  it("normalizes a raw path only through the fixed backend command", async () => {
    const client = commands(),
      user = userEvent.setup();
    render(<App commands={client} initialData={PREVIEW_WORKBENCH_DATA} />);
    await user.click(screen.getByRole("link", { name: /数据集管理/ }));
    await user.type(await screen.findByLabelText("原始数据集 ID"), "btc-raw");
    await user.type(
      screen.getByLabelText("原始历史数据路径"),
      "/mnt/history/events.ndjson",
    );
    await user.click(screen.getByRole("button", { name: "归一化并发布历史数据" }));
    expect(client.normalizeRawDataset).toHaveBeenCalledWith({
      schemaVersion: "raw-dataset-normalization-request-v1",
      inputPath: "/mnt/history/events.ndjson",
      datasetId: "btc-raw",
    });
    expect(
      await screen.findByText(/后端已归一化 4 条事件/),
    ).toBeInTheDocument();
  });

  it("starts and refreshes a backtest only through the backend command client", async () => {
    const client = commands();
    const user = userEvent.setup();
    render(<App commands={client} initialData={PREVIEW_WORKBENCH_DATA} />);
    await user.click(screen.getByRole("link", { name: /回测实验室/ }));
    expect(screen.getByLabelText("回测数据分组")).toHaveValue("VALIDATION");
    await user.click(screen.getByRole("button", { name: "运行回测" }));
    expect(client.startBacktest).toHaveBeenCalledWith(
      expect.objectContaining({ evaluationSplit: "VALIDATION", displayName: expect.stringContaining("验证"), description: expect.any(String) }),
    );
    expect(await screen.findByText(/后端已接受任务 bt-1/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "刷新状态" }));
    expect(client.getBacktestJob).toHaveBeenCalledWith("bt-1");
    expect(await screen.findByText(/running · 50%/)).toBeInTheDocument();
  });

  it("enters a completed run, exposes all evidence layers, and carries its frozen context into Paper review", async () => {
    const client = commands();
    vi.mocked(client.listBacktestJobs).mockResolvedValue([{
      schemaVersion: "backtest-job-v1",
      runId: "run-evidence",
      requestId: "request-evidence",
      strategyId: "J_FEE_AWARE",
      strategyVersion: "1.0.0",
      displayName: "J · BTC 验证",
      status: "succeeded",
      progressPermille: 1000,
      error: null,
    }]);
    vi.mocked(client.getBacktestResult).mockResolvedValue({
      schemaVersion: "backtest-result-v1",
      runId: "run-evidence",
      request: {
        schemaVersion: "backtest-request-v1",
        requestId: "request-evidence",
        strategyId: "J_FEE_AWARE",
        strategyVersion: "1.0.0",
        datasetId: "btc",
        datasetVersionHash: "a".repeat(64),
        feeModel: "fee-v2",
        latencyMs: 1000,
        initialCash: "1000",
        maxPosition: "100",
        evaluationSplit: "VALIDATION",
      },
      startedAtUtc: "2026-07-21T00:00:00Z",
      completedAtUtc: "2026-07-21T01:00:00Z",
      evaluationScope: {
        schemaVersion: "backtest-evaluation-scope-v1",
        split: "VALIDATION",
        horizonSeconds: 300,
        scenario: "BASE_1S",
        cohortHash: "c".repeat(64),
        cohortSize: 120,
      },
      metrics: { netPnl: "12.5", fees: "1.2", maxDrawdown: "-3.1", fillRate: "0.6", winRate: "0.55", brier: "0.19" },
      equityCurve: [{ timeUtc: "2026-07-21T00:00:00Z", equity: "1000" }, { timeUtc: "2026-07-21T01:00:00Z", equity: "1012.5" }],
      events: [
        { eventId: "decision-cal-1", eventTimeUtc: "2026-07-21T00:10:00Z", kind: "decision", payload: { marketId: "m-1", probability: 0.22, outcome: "Down", reason: "EDGE" } },
        { eventId: "decision-cal-2", eventTimeUtc: "2026-07-21T00:20:00Z", kind: "decision", payload: { marketId: "m-2", probability: 0.74, outcome: "Up", reason: "EDGE" } },
        { eventId: "settlement-cal-1", eventTimeUtc: "2026-07-21T00:40:00Z", kind: "settlement", payload: { marketId: "m-1", pnl: -1.5, status: "SETTLED" } },
        { eventId: "settlement-cal-2", eventTimeUtc: "2026-07-21T00:50:00Z", kind: "settlement", payload: { marketId: "m-2", pnl: 3.2, status: "SETTLED" } },
      ],
    });
    const user = userEvent.setup();
    render(<App commands={client} initialData={EMPTY_VERIFIED_DATA} />);
    await user.click(screen.getByRole("link", { name: /回测实验室/ }));
    expect(await screen.findByLabelText("回测决策总览")).toHaveTextContent(
      "Paper 准入未通过",
    );
    expect(client.getBacktestResult).toHaveBeenCalledWith("run-evidence");
    expect(screen.getByRole("navigation", { name: "结果分析目录" })).toHaveTextContent("核心收益风险概率质量交易与执行参数稳健性");
    expect(screen.queryByText("参数敏感性")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "训练、验证与最终测试时间带" })).not.toBeInTheDocument();
    expect(screen.getByText("概率校准图")).toBeInTheDocument();
    expect(screen.getByText("Brier 分解")).toBeInTheDocument();
    expect(screen.getByText("概率分桶明细")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "分桶 Brier" })).toBeInTheDocument();
    expect(screen.getByText("单市场 PnL 分布")).toBeInTheDocument();
    expect(screen.getAllByText("未计算").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "进入 Paper 评审" }));
    expect(await screen.findByRole("heading", { name: "自动 Paper Runner" })).toBeInTheDocument();
    expect(screen.getByLabelText("Paper 策略")).toHaveValue("J_FEE_AWARE");
    expect(screen.getByLabelText("Paper 策略版本")).toHaveValue("1.0.0");
    expect(window.location.search).toContain("run=run-evidence");
    expect(window.location.search).toContain("view=live");
  });

  it("regenerates automatic backtest names after the selected strategy changes", async () => {
    const client = commands();
    vi.mocked(client.listStrategyDefinitions).mockResolvedValue([
      { strategyId: "J_FEE_AWARE", displayName: "费用感知概率策略（J）", runtime: "python", allowedModes: ["backtest", "paper"], parameters: {} },
      { strategyId: "K_DUAL_VOL", displayName: "双波动率概率策略（K）", runtime: "python", allowedModes: ["backtest", "paper"], parameters: {} },
    ]);
    const user = userEvent.setup();
    render(<App commands={client} initialData={PREVIEW_WORKBENCH_DATA} />);
    await user.click(screen.getByRole("link", { name: /回测实验室/ }));
    await screen.findByDisplayValue("费用感知概率策略（J）");
    await user.click(screen.getByRole("button", { name: "运行回测" }));
    await user.selectOptions(screen.getByLabelText("回测策略"), "K_DUAL_VOL");
    await user.click(screen.getByRole("button", { name: "运行回测" }));
    const calls = vi.mocked(client.startBacktest).mock.calls;
    expect(calls[0]?.[0].displayName).toContain("费用感知概率策略（J）");
    expect(calls[1]?.[0].displayName).toContain("双波动率概率策略（K）");
  });

  it("shows and submits only the verified one-second execution latency", async () => {
    const client = commands();
    const user = userEvent.setup();
    render(<App commands={client} initialData={PREVIEW_WORKBENCH_DATA} />);
    await user.click(screen.getByRole("link", { name: /回测实验室/ }));
    const latency = screen.getByLabelText("延迟毫秒");
    expect(latency).toHaveValue(1000);
    expect(latency).toHaveAttribute("readonly");
    await user.click(screen.getByRole("button", { name: "运行回测" }));
    expect(client.startBacktest).toHaveBeenCalledWith(
      expect.objectContaining({ latencyMs: 1000 }),
    );
  });

  it("renders health, host and incidents only from backend commands", async () => {
    const client = commands();
    const user = userEvent.setup();
    render(<App commands={client} initialData={EMPTY_VERIFIED_DATA} />);
    await user.click(screen.getByRole("link", { name: /系统健康/ }));
    expect((await screen.findAllByText("不可用")).length).toBeGreaterThan(0);
    expect(screen.getByText("已停止")).toBeInTheDocument();
    expect(screen.getByText("没有已记录的系统异常")).toBeInTheDocument();
    expect(client.getSystemHealth).toHaveBeenCalled();
    expect(client.listSystemIncidents).toHaveBeenCalledWith({
      page: 1,
      pageSize: 100,
    });
  });

  it("fails closed when no command bridge is supplied", async () => {
    const user = userEvent.setup();
    render(<App initialData={PREVIEW_WORKBENCH_DATA} />);
    await user.click(screen.getByRole("link", { name: /回测实验室/ }));
    expect(screen.getByRole("button", { name: "运行回测" })).toBeDisabled();
    expect(screen.getByText(/命令桥接不可用/)).toBeInTheDocument();
  });

  it("starts one automatic Paper Runner without exposing internal orchestration", async () => {
    const client = commands();
    const user = userEvent.setup();
    render(<App commands={client} initialData={EMPTY_VERIFIED_DATA} />);
    await user.click(screen.getByRole("link", { name: /实时驾驶舱/ }));
    await screen.findByRole("button", { name: "启动自动 Paper" });
    await user.clear(screen.getByLabelText("初始资金 USDC"));
    await user.type(screen.getByLabelText("初始资金 USDC"), "2500");
    await user.clear(screen.getByLabelText("最大仓位 USDC"));
    await user.type(screen.getByLabelText("最大仓位 USDC"), "125");
    await user.clear(screen.getByLabelText("最低净优势"));
    await user.type(screen.getByLabelText("最低净优势"), "0.04");
    await user.click(screen.getByRole("button", { name: "启动自动 Paper" }));
    expect(client.startPaperRunner).toHaveBeenCalledWith({ strategyId: "J_FEE_AWARE", strategyVersion: "1.0.0", initialCash: "2500", maximumPosition: "125", minimumNetEdge: "0.04" });
    expect(await screen.findByText(/市场发现、行情、决策、风控、模拟成交、结算和轮转/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Paper 会话 ID")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("精确 BTC 5 分钟 slug")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "创建 Paper 订单" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "手动模拟结算" })).not.toBeInTheDocument();
  });

  it("loads the selected completed run's paged decision ledger only through backend commands", async () => {
    const client = commands();
    vi.mocked(client.listBacktestJobs).mockResolvedValue([
      {
        schemaVersion: "backtest-job-v1",
        runId: "run-complete",
        requestId: "request-complete",
        displayName: "费用感知概率策略 · BTC 验证",
        status: "succeeded",
        progressPermille: 1000,
        error: null,
      },
      {
        schemaVersion: "backtest-job-v1",
        runId: "run-running",
        requestId: "request-running",
        status: "running",
        progressPermille: 500,
        error: null,
      },
    ]);
    const decision = {
      schemaVersion: "public-backtest-event-v1" as const,
      eventId: "decision-real-1",
      eventTimeUtc: "2026-07-21T00:00:01Z",
      kind: "decision" as const,
      data: { action: "BUY", reason: "EDGE_OK" },
    };
    const order = {
      ...decision,
      eventId: "order-real-1",
      eventTimeUtc: "2026-07-21T00:00:02Z",
      kind: "order" as const,
      data: { status: "OPEN" },
    };
    const page = <T,>(items: readonly T[], pageSize = 10) => ({
      schemaVersion: "query-page-v1" as const,
      page: 1,
      pageSize,
      totalItems: items.length,
      totalPages: items.length === 0 ? 0 : 1,
      items,
    });
    vi.mocked(client.getBacktestReplay).mockResolvedValue({ ...page([decision, order], 20), totalItems: 42, totalPages: 3 });
    vi.mocked(client.getBacktestDecisions).mockResolvedValue(page([decision]));
    vi.mocked(client.getBacktestOrders).mockResolvedValue(page([order]));
    vi.mocked(client.getBacktestFills).mockResolvedValue(page([]));
    vi.mocked(client.getBacktestSettlements).mockResolvedValue(page([]));
    const user = userEvent.setup();
    render(<App commands={client} initialData={EMPTY_VERIFIED_DATA} />);
    await user.click(screen.getByRole("link", { name: /决策记录/ }));
    expect((await screen.findAllByText("费用感知概率策略 · BTC 验证")).length).toBeGreaterThan(0);
    expect(
      (await screen.findAllByText("decision-real-1")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("order-real-1")).toBeInTheDocument();
    expect(client.getBacktestReplay).toHaveBeenCalledWith("run-complete", {
      page: 1,
      pageSize: 20,
    });
    expect(client.getBacktestDecisions).toHaveBeenCalledWith("run-complete", {
      page: 1,
      pageSize: 10,
    });
    await user.selectOptions(screen.getByLabelText("决策账本每页条数"), "50");
    await waitFor(() => expect(client.getBacktestReplay).toHaveBeenCalledWith("run-complete", { page: 1, pageSize: 50 }));
    await user.selectOptions(screen.getByLabelText("决策账本页码"), "2");
    await waitFor(() => expect(client.getBacktestReplay).toHaveBeenCalledWith("run-complete", { page: 2, pageSize: 50 }));
    expect(document.body).not.toHaveTextContent("K-Edge v0.4");
    expect(document.body).not.toHaveTextContent("0.584 / 0.625");
  });

  it("loads and navigates a completed run's paged replay without preview events", async () => {
    const client = commands();
    vi.mocked(client.listBacktestJobs).mockResolvedValue([
      {
        schemaVersion: "backtest-job-v1",
        runId: "replay-complete",
        requestId: "request-replay",
        displayName: "双波动率概率策略 · BTC 验证",
        status: "succeeded",
        progressPermille: 1000,
        error: null,
      },
    ]);
    vi.mocked(client.getBacktestReplay).mockResolvedValue({
      schemaVersion: "query-page-v1",
      page: 1,
      pageSize: 20,
      totalItems: 42,
      totalPages: 3,
      items: [
        {
          schemaVersion: "public-backtest-event-v1",
          eventId: "replay-real-2",
          eventTimeUtc: "2026-07-21T00:00:02Z",
          kind: "fill",
          data: { price: "0.51" },
        },
        {
          schemaVersion: "public-backtest-event-v1",
          eventId: "replay-real-1",
          eventTimeUtc: "2026-07-21T00:00:01Z",
          kind: "decision",
          data: { action: "HOLD" },
        },
      ],
    });
    const user = userEvent.setup();
    render(<App commands={client} initialData={EMPTY_VERIFIED_DATA} />);
    await user.click(screen.getByRole("link", { name: /市场回放/ }));
    expect((await screen.findAllByText("双波动率概率策略 · BTC 验证")).length).toBeGreaterThan(0);
    expect(
      await screen.findByRole("heading", { name: "HOLD" }),
    ).toBeInTheDocument();
    expect(client.getBacktestReplay).toHaveBeenCalledWith("replay-complete", {
      page: 1,
      pageSize: 20,
    });
    await user.click(screen.getByRole("button", { name: "下一事件 ▶" }));
    expect(
      await screen.findByRole("heading", { name: "冻结事件" }),
    ).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("运行回放每页条数"), "10");
    await waitFor(() => expect(client.getBacktestReplay).toHaveBeenCalledWith("replay-complete", { page: 1, pageSize: 10 }));
    await user.selectOptions(screen.getByLabelText("运行回放页码"), "2");
    await waitFor(() => expect(client.getBacktestReplay).toHaveBeenCalledWith("replay-complete", { page: 2, pageSize: 10 }));
    expect(document.body).not.toHaveTextContent("BTCUSDT 67,837.20");
    expect(document.body).not.toHaveTextContent("23:17:00.250");
  });

  it("shows immediate progress and a visible backend error when comparing selected runs", async () => {
    const client = commands();
    vi.mocked(client.listBacktestJobs).mockResolvedValue([
      { schemaVersion: "backtest-job-v1", runId: "arena-run-1", requestId: "request-1", status: "succeeded", progressPermille: 1000, error: null },
      { schemaVersion: "backtest-job-v1", runId: "arena-run-2", requestId: "request-2", status: "succeeded", progressPermille: 1000, error: null },
    ]);
    vi.mocked(client.compareBacktests).mockRejectedValue(new Error("运行的费用模型不一致"));
    const user = userEvent.setup();
    render(<App commands={client} initialData={EMPTY_VERIFIED_DATA} />);
    await user.click(screen.getByRole("link", { name: /策略竞技场/ }));
    const compareButton = await screen.findByRole("button", { name: "比较所选运行（2）" });
    await user.click(compareButton);
    expect(client.compareBacktests).toHaveBeenCalledWith(["arena-run-1", "arena-run-2"]);
    expect(await screen.findByRole("alert")).toHaveTextContent("比较失败：运行的费用模型不一致");
    expect(compareButton).toBeEnabled();
  });

  it("automatically combines the latest real strategy candidates with the current baseline group", async () => {
    const client = commands();
    window.history.replaceState(null, "", "/?view=compare&run=k-run");
    vi.mocked(client.listBacktestJobs).mockResolvedValue([
      { schemaVersion: "backtest-job-v1", runId: "b3-run", requestId: "b3-request", strategyId: "B3_MARKET_PRIOR", strategyVersion: "1.0.0", comparisonGroupId: "group-k", status: "succeeded", progressPermille: 1000, error: null },
      { schemaVersion: "backtest-job-v1", runId: "k-run", requestId: "k-request", strategyId: "K_DUAL_VOL", strategyVersion: "2.0.0", comparisonGroupId: "group-k", status: "succeeded", progressPermille: 1000, error: null },
      { schemaVersion: "backtest-job-v1", runId: "l-run", requestId: "l-request", strategyId: "L_ADAPTIVE_EXECUTION", strategyVersion: "1.0.3", comparisonGroupId: "group-l", status: "succeeded", progressPermille: 1000, error: null },
      { schemaVersion: "backtest-job-v1", runId: "j-run", requestId: "j-request", strategyId: "J_FEE_AWARE", strategyVersion: "2.0.1", comparisonGroupId: "group-j", status: "succeeded", progressPermille: 1000, error: null },
      { schemaVersion: "backtest-job-v1", runId: "j-old-run", requestId: "j-old-request", strategyId: "J_FEE_AWARE", strategyVersion: "2.0.0", comparisonGroupId: "group-j-old", status: "succeeded", progressPermille: 1000, error: null },
    ]);
    render(<App commands={client} initialData={EMPTY_VERIFIED_DATA} />);
    await waitFor(() =>
      expect(client.compareBacktests).toHaveBeenCalledWith([
        "k-run",
        "b3-run",
        "l-run",
        "j-run",
      ]),
    );
    expect(screen.getByText("选择比较运行 · 已选 4 个")).toBeInTheDocument();
  });

});
