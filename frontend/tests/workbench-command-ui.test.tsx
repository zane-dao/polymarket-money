import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

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
        strategyId: "k-edge",
        displayName: "K Edge",
        runtime: "python" as const,
        allowedModes: ["backtest", "paper"] as const,
        parameters: {
          threshold: {
            type: "number" as const,
            required: true,
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
        .querySelectorAll("button")[3]!,
    );
    await screen.findByDisplayValue("K Edge · k-edge");
    await user.click(screen.getByRole("button", { name: "验证参数" }));
    expect(client.validateStrategyParameters).toHaveBeenCalledWith("k-edge", {
      threshold: 0,
    });
    await user.click(screen.getByRole("button", { name: "保存版本" }));
    expect(client.saveStrategyVersion).toHaveBeenCalled();
    expect(
      await screen.findByText(/已由后端保存不可变版本/),
    ).toBeInTheDocument();
  });

  it("reloads an immutable strategy version through the backend command client", async () => {
    const client = commands();
    const user = userEvent.setup();
    render(<App commands={client} initialData={PREVIEW_WORKBENCH_DATA} />);
    await user.click(
      screen
        .getByRole("navigation", { name: "主导航" })
        .querySelectorAll("button")[3]!,
    );
    await screen.findByRole("option", { name: "1.0.0" });
    await user.click(screen.getByRole("button", { name: "版本操作" }));
    expect(client.getStrategyVersion).toHaveBeenCalledWith("k-edge", "1.0.0");
    expect(await screen.findByDisplayValue("后端保存版本")).toBeInTheDocument();
    expect(screen.getByLabelText("参数 threshold")).toHaveValue(0.4);
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
        .querySelectorAll("button")[3]!,
    );
    const modes = await screen.findByLabelText("允许模式");
    expect(modes).toHaveValue("backtest");
    expect((modes as HTMLInputElement).value).not.toContain("paper");
  });

  it("scans, inspects and validates a dataset only through backend commands", async () => {
    const client = commands();
    const user = userEvent.setup();
    render(<App commands={client} initialData={PREVIEW_WORKBENCH_DATA} />);
    await user.click(screen.getByRole("button", { name: /数据集管理/ }));
    await screen.findByText("btc");
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
  });

  it("registers an explicit absolute normalized root only through the backend", async () => {
    const client = commands();
    const user = userEvent.setup();
    render(<App commands={client} initialData={PREVIEW_WORKBENCH_DATA} />);
    await user.click(screen.getByRole("button", { name: /数据集管理/ }));
    await user.type(
      await screen.findByLabelText("外部 normalized 发布根"),
      "/mnt/history/normalized",
    );
    await user.click(screen.getByRole("button", { name: "后端操作" }));
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
    await user.click(screen.getByRole("button", { name: /数据集管理/ }));
    await user.type(await screen.findByLabelText("原始数据集 ID"), "btc-raw");
    await user.type(
      screen.getByLabelText("原始历史数据路径"),
      "/mnt/history/events.ndjson",
    );
    await user.click(screen.getByRole("button", { name: "Web 后端操作" }));
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
    await user.click(screen.getByRole("button", { name: /回测实验室/ }));
    await user.click(screen.getByRole("button", { name: "运行回测" }));
    expect(client.startBacktest).toHaveBeenCalled();
    expect(await screen.findByText(/后端已接受任务 bt-1/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "刷新状态" }));
    expect(client.getBacktestJob).toHaveBeenCalledWith("bt-1");
    expect(await screen.findByText(/running · 50%/)).toBeInTheDocument();
  });

  it("shows and submits only the verified one-second execution latency", async () => {
    const client = commands();
    const user = userEvent.setup();
    render(<App commands={client} initialData={PREVIEW_WORKBENCH_DATA} />);
    await user.click(screen.getByRole("button", { name: /回测实验室/ }));
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
    await user.click(screen.getByRole("button", { name: /系统健康/ }));
    expect(await screen.findByText("unavailable")).toBeInTheDocument();
    expect(screen.getByText("STOPPED")).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: /回测实验室/ }));
    expect(screen.getByRole("button", { name: "运行回测" })).toBeDisabled();
    expect(screen.getByText(/命令桥接不可用/)).toBeInTheDocument();
  });

  it("requests a Paper session through the backend and shows fail-closed rejection", async () => {
    const client = commands();
    vi.mocked(client.startPaperSession).mockRejectedValueOnce(
      new Error("public market host is unavailable; collection does not start"),
    );
    const user = userEvent.setup();
    render(<App commands={client} initialData={EMPTY_VERIFIED_DATA} />);
    await user.click(screen.getByRole("button", { name: /实时驾驶舱/ }));
    await user.type(
      await screen.findByLabelText("Paper 会话 ID"),
      "btc-paper-1",
    );
    await user.click(screen.getByRole("button", { name: "启动 Paper 会话" }));
    expect(client.startPaperSession).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: "paper-session-start-v1",
        sessionId: "btc-paper-1",
        initialCash: "10000",
      }),
    );
    expect(
      await screen.findByText(/public market host is unavailable/),
    ).toBeInTheDocument();
    expect(screen.getByText("实时快照不可用")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("67,842.31");
  });

  it("stops and resumes persisted Paper sessions only through backend commands", async () => {
    const client = commands();
    const running = {
      schemaVersion: "paper-session-view-v1" as const,
      sessionId: "paper-1",
      status: "RUNNING" as const,
      adapterId: "public-feed",
      startedAtUtc: "2026-07-21T00:00:00Z",
      updatedAtUtc: "2026-07-21T00:00:00Z",
      cash: "100",
      openOrderCount: 0,
      fillCount: 0,
      systemKillSwitchEnabled: false,
    };
    const stopped = { ...running, status: "STOPPED" as const };
    vi.mocked(client.listPaperSessions)
      .mockResolvedValueOnce([running])
      .mockResolvedValueOnce([stopped])
      .mockResolvedValueOnce([running]);
    vi.mocked(client.stopPaperSession).mockResolvedValue(stopped);
    vi.mocked(client.resumePaperSession).mockResolvedValue(running);
    const user = userEvent.setup();
    render(<App commands={client} initialData={EMPTY_VERIFIED_DATA} />);
    await user.click(screen.getByRole("button", { name: /实时驾驶舱/ }));
    await screen.findByText("paper-1");
    await user.click(screen.getByRole("button", { name: "停止" }));
    expect(client.stopPaperSession).toHaveBeenCalledWith("paper-1");
    await user.click(await screen.findByRole("button", { name: "恢复" }));
    expect(client.resumePaperSession).toHaveBeenCalledWith("paper-1");
  });

  it("runs the Paper order lifecycle only through backend commands", async () => {
    const client = commands();
    const session = {
      schemaVersion: "paper-session-view-v1" as const,
      sessionId: "paper-ledger",
      status: "RUNNING" as const,
      adapterId: "public-feed",
      startedAtUtc: "2026-07-21T00:00:00Z",
      updatedAtUtc: "2026-07-21T00:00:00Z",
      cash: "100",
      openOrderCount: 1,
      fillCount: 0,
      systemKillSwitchEnabled: false,
    };
    vi.mocked(client.getPaperMarketRuntime).mockResolvedValue(
      READY_PAPER_MARKET,
    );
    const order = {
      schemaVersion: "paper-order-v1" as const,
      orderId: "paper-order-1",
      clientOrderId: "client-1",
      idempotencyKey: "idem-1",
      marketId: "market-1",
      token: "YES" as const,
      limitPrice: "0.5",
      quantity: "1",
      filledQuantity: "0",
      remainingQuantity: "1",
      timeInForce: "GTC" as const,
      expiresAtUtc: null,
      status: "OPEN" as const,
      rejectionReason: null,
      createdAtUtc: "2026-07-21T00:00:00Z",
      updatedAtUtc: "2026-07-21T00:00:00Z",
    };
    const detail = {
      schemaVersion: "paper-session-detail-v1" as const,
      session,
      orders: [order],
      fills: [],
      positions: [],
      settlements: [],
      events: [],
    };
    vi.mocked(client.listPaperSessions).mockResolvedValue([session]);
    vi.mocked(client.getPaperSessionDetail).mockResolvedValue(detail);
    vi.mocked(client.submitPaperOrder).mockResolvedValue({
      ...order,
      status: "FILLED",
      filledQuantity: "1",
      remainingQuantity: "0",
    });
    vi.mocked(client.repricePaperOrder).mockResolvedValue({
      ...order,
      orderId: "paper-order-2",
      limitPrice: "0.55",
    });
    vi.mocked(client.cancelPaperOrder).mockResolvedValue({
      ...order,
      status: "CANCELLED",
    });
    vi.mocked(client.expirePaperOrders).mockResolvedValue([
      { ...order, status: "EXPIRED" },
    ]);
    vi.mocked(client.settlePaperMarket).mockResolvedValue({
      marketId: "market-1",
      winningToken: "YES",
      payout: "1",
      settledAtUtc: "2026-07-21T00:01:00Z",
    });
    const user = userEvent.setup();
    render(<App commands={client} initialData={EMPTY_VERIFIED_DATA} />);
    await user.click(screen.getByRole("button", { name: /实时驾驶舱/ }));
    await screen.findByText("paper-ledger");
    await user.click(screen.getByRole("button", { name: "账本" }));
    await screen.findByText("paper-order-1");
    await user.clear(screen.getByLabelText("Paper 限价"));
    await user.type(screen.getByLabelText("Paper 限价"), "0.55");
    await user.click(screen.getByRole("button", { name: "创建 Paper 订单" }));
    expect(client.submitPaperOrder).toHaveBeenCalledWith(
      "paper-ledger",
      expect.objectContaining({ marketId: "market-1", token: "YES" }),
    );
    await user.click(screen.getByRole("button", { name: "改价" }));
    expect(client.repricePaperOrder).toHaveBeenCalledWith(
      "paper-ledger",
      "paper-order-1",
      expect.objectContaining({
        marketId: "market-1",
        limitPrice: "0.55",
        quantity: "1",
      }),
    );
    await user.click(screen.getByRole("button", { name: "撤单" }));
    expect(client.cancelPaperOrder).toHaveBeenCalledWith(
      "paper-ledger",
      "paper-order-1",
      "OPERATOR_CANCEL_FROM_WORKBENCH",
    );
    await user.click(screen.getByRole("button", { name: "检查过期订单" }));
    expect(client.expirePaperOrders).toHaveBeenCalledWith("paper-ledger");
    expect(await screen.findByText(/1 个订单已过期/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "手动模拟结算" }));
    expect(client.settlePaperMarket).toHaveBeenCalledWith(
      "paper-ledger",
      "market-1",
      "YES",
      "MANUAL_PAPER_TEST",
    );
  });

  it("keeps a backend risk rejection visible instead of replacing it with success text", async () => {
    const client = commands();
    const session = {
      schemaVersion: "paper-session-view-v1" as const,
      sessionId: "paper-reject",
      status: "RUNNING" as const,
      adapterId: "public-feed",
      startedAtUtc: "2026-07-21T00:00:00Z",
      updatedAtUtc: "2026-07-21T00:00:00Z",
      cash: "100",
      openOrderCount: 0,
      fillCount: 0,
      systemKillSwitchEnabled: false,
    };
    vi.mocked(client.getPaperMarketRuntime).mockResolvedValue(
      READY_PAPER_MARKET,
    );
    const rejected = {
      schemaVersion: "paper-order-v1" as const,
      orderId: "rejected-1",
      clientOrderId: "client-1",
      idempotencyKey: "idem-1",
      marketId: "market-1",
      token: "YES" as const,
      limitPrice: "0.5",
      quantity: "1",
      filledQuantity: "0",
      remainingQuantity: "1",
      timeInForce: "GTC" as const,
      expiresAtUtc: null,
      status: "REJECTED" as const,
      rejectionReason: "NET_EDGE_BELOW_MINIMUM",
      createdAtUtc: "2026-07-21T00:00:00Z",
      updatedAtUtc: "2026-07-21T00:00:00Z",
    };
    vi.mocked(client.listPaperSessions).mockResolvedValue([session]);
    vi.mocked(client.getPaperSessionDetail).mockResolvedValue({
      schemaVersion: "paper-session-detail-v1",
      session,
      orders: [],
      fills: [],
      positions: [],
      settlements: [],
      events: [],
    });
    vi.mocked(client.submitPaperOrder).mockResolvedValue(rejected);
    const user = userEvent.setup();
    render(<App commands={client} initialData={EMPTY_VERIFIED_DATA} />);
    await user.click(screen.getByRole("button", { name: /实时驾驶舱/ }));
    await screen.findByText("paper-reject");
    await user.click(screen.getByRole("button", { name: "账本" }));
    await user.click(screen.getByRole("button", { name: "创建 Paper 订单" }));
    expect(
      await screen.findByText("订单被风控拒绝：NET_EDGE_BELOW_MINIMUM"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Paper 订单已提交后端模拟执行。"),
    ).not.toBeInTheDocument();
  });

  it("renders only the K/J strategy runtime returned by the backend", async () => {
    const client = commands();
    vi.mocked(client.getPaperStrategyRuntime).mockResolvedValue({
      schemaVersion: "paper-strategy-runtime-v2",
      status: "RUNNING",
      executionAuthority: "PAPER_SESSION",
      planner: {
        engineVersion: "kj-paper-engine-v2",
        journalRecordCount: 3,
        recoveredInputCount: 1,
        lastRecordHash: "a".repeat(64),
        error: null,
      },
      canonicalAccounts: [],
      executionLinks: [],
      shadow: {
        nonAuthoritative: true,
        snapshot: {
          schemaVersion: "kj-paper-engine-snapshot-v1",
          engineVersion: "kj-paper-engine-v2",
          wallets: {
            J_FEE_AWARE: {
              cash: "9999",
              available: "9998",
              reserved: "1",
              positions: {},
            },
            K_DUAL_VOL: {
              cash: "9997",
              available: "9997",
              reserved: "0",
              positions: { "token-k": "2" },
            },
          },
          markets: [],
          pendingIntents: [],
          eventCount: "1",
        },
        events: [
          {
            schemaVersion: "kj-paper-engine-v2",
            eventId: "kj-event-1",
            eventType: "DECISION",
            strategy: "J_FEE_AWARE",
            marketId: "btc-market-real",
            eventTime: "2026-07-21T00:00:01Z",
            details: { reason: "EDGE_OK" },
          },
        ],
      },
    });
    const user = userEvent.setup();
    render(<App commands={client} initialData={EMPTY_VERIFIED_DATA} />);
    await user.click(screen.getByRole("button", { name: /实时驾驶舱/ }));
    expect(await screen.findByText("btc-market-real")).toBeInTheDocument();
    expect(screen.getByText("9999")).toBeInTheDocument();
    expect(screen.getByText("NON-AUTHORITATIVE")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("67,842.31");
  });

  it("renders the real public book, Binance signal and ages returned by the backend", async () => {
    const client = commands();
    vi.mocked(client.getPaperMarketRuntime).mockResolvedValue({
      schemaVersion: "paper-market-runtime-v1",
      status: "READY",
      checkedAtUtc: "2026-07-21T00:00:01.000Z",
      market: {
        marketId: "market-real",
        conditionId: "condition-real",
        slug: "btc-updown-5m-1775181000",
        intervalStart: "2026-07-21T00:00:00.000Z",
        intervalEnd: "2026-07-21T00:05:00.000Z",
        decisionTime: "2026-07-21T00:00:00.900Z",
        continuity: "UNVERIFIED",
        bookAgeMs: 8,
        signalAgeMs: 5,
        up: {
          tokenId: "1",
          bid: "0.49",
          ask: "0.5",
          bidSize: "10",
          askSize: "11",
        },
        down: {
          tokenId: "2",
          bid: "0.5",
          ask: "0.51",
          bidSize: "12",
          askSize: "13",
        },
        signal: {
          provider: "BINANCE_SPOT",
          price: "67842.31",
          sourceTime: "2026-07-21T00:00:00.800Z",
          serverTime: "2026-07-21T00:00:00.850Z",
          receiveTime: "2026-07-21T00:00:00.895Z",
        },
        feeEvidence: {
          schemaVersion: "paper-fee-evidence-v1",
          model: "POLYMARKET_TAKER_CURVE_V1",
          conditionId: "condition-real",
          rate: "0.01",
          effectiveFromUtc: "2026-07-21T00:00:00.000Z",
          effectiveToUtc: "2026-07-21T00:05:00.000Z",
          evidenceStatus: "UNVERIFIED",
          evidenceReference: "test-fixture",
        },
      },
    });
    const user = userEvent.setup();
    render(<App commands={client} initialData={EMPTY_VERIFIED_DATA} />);
    await user.click(screen.getByRole("button", { name: /实时驾驶舱/ }));
    expect(await screen.findByText("67842.31")).toBeInTheDocument();
    expect(screen.getByText("0.49 / 10")).toBeInTheDocument();
    expect(screen.getByText(/8 \/ 5 ms/)).toBeInTheDocument();
  });

  it("loads the selected completed run's paged decision ledger only through backend commands", async () => {
    const client = commands();
    vi.mocked(client.listBacktestJobs).mockResolvedValue([
      {
        schemaVersion: "backtest-job-v1",
        runId: "run-complete",
        requestId: "request-complete",
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
    const page = <T,>(items: readonly T[]) => ({
      schemaVersion: "query-page-v1" as const,
      page: 1,
      pageSize: 100,
      totalItems: items.length,
      totalPages: items.length === 0 ? 0 : 1,
      items,
    });
    vi.mocked(client.getBacktestDecisions).mockResolvedValue(page([decision]));
    vi.mocked(client.getBacktestOrders).mockResolvedValue(page([order]));
    vi.mocked(client.getBacktestFills).mockResolvedValue(page([]));
    vi.mocked(client.getBacktestSettlements).mockResolvedValue(page([]));
    const user = userEvent.setup();
    render(<App commands={client} initialData={EMPTY_VERIFIED_DATA} />);
    await user.click(screen.getByRole("button", { name: /决策记录/ }));
    expect(
      (await screen.findAllByText("decision-real-1")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("order-real-1")).toBeInTheDocument();
    expect(client.getBacktestDecisions).toHaveBeenCalledWith("run-complete", {
      page: 1,
      pageSize: 100,
    });
    expect(client.getBacktestOrders).toHaveBeenCalledWith("run-complete", {
      page: 1,
      pageSize: 100,
    });
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
        status: "succeeded",
        progressPermille: 1000,
        error: null,
      },
    ]);
    vi.mocked(client.getBacktestReplay).mockResolvedValue({
      schemaVersion: "query-page-v1",
      page: 1,
      pageSize: 100,
      totalItems: 2,
      totalPages: 1,
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
    await user.click(screen.getByRole("button", { name: /市场回放/ }));
    expect(
      await screen.findByRole("heading", { name: "replay-real-1" }),
    ).toBeInTheDocument();
    expect(client.getBacktestReplay).toHaveBeenCalledWith("replay-complete", {
      page: 1,
      pageSize: 100,
    });
    await user.click(screen.getByRole("button", { name: "下一事件 ▶" }));
    expect(
      await screen.findByRole("heading", { name: "replay-real-2" }),
    ).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("BTCUSDT 67,837.20");
    expect(document.body).not.toHaveTextContent("23:17:00.250");
  });

  it("shows a locked, explicit demo for an empty verified-local DTO and can return to verified data", async () => {
    const user = userEvent.setup();
    render(<App initialData={EMPTY_VERIFIED_DATA} />);
    expect(screen.getByText("DEMO DATA · 非真实数据")).toBeInTheDocument();
    expect(screen.getByText(/\+214\.80/)).toBeInTheDocument();
    expect(screen.getByText(/所有输入与操作均已锁定/)).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "页面数据视图" }), "verified");
    expect(screen.queryByText(/\+214\.80/)).not.toBeInTheDocument();
    const navigation = screen.getByRole("navigation", { name: "主导航" });
    for (const index of [1, 2, 5, 6, 7, 8]) {
      await user.click(navigation.querySelectorAll("button")[index]!);
      expect(document.body).not.toHaveTextContent("+214.80");
      expect(document.body).not.toHaveTextContent("HEALTHY");
      expect(document.body).not.toHaveTextContent("8.4M");
    }
    expect(screen.getByText("详细健康数据不可用")).toBeInTheDocument();
  });
});
