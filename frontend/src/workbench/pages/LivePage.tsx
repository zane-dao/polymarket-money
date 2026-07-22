import { useEffect, useState } from "react";
import { useWorkbench } from "../app/WorkbenchContext.js";
import { useWorkbenchCommands } from "../app/WorkbenchCommandContext.js";
import { useWorkbenchData } from "../app/WorkbenchDataContext.js";
import { DecisionTable } from "../components/DecisionTable.js";
import { LineChart } from "../components/LineChart.js";
import {
  Badge,
  EmptyState,
  MetricCard,
  PageHeader,
  Panel,
} from "../components/ui.js";
import type {
  PaperMarketHostStatusV1,
  PaperMarketRuntimeV1,
  PaperRiskConfigV1,
  PaperSessionDetailV1,
  PaperSessionViewV1,
  PaperStrategyRuntimeV1,
  PaperSystemControlV1,
  WorkbenchCommands,
} from "../services/workbench-commands.js";

const DEFAULT_RISK: PaperRiskConfigV1 = {
  schemaVersion: "paper-risk-config-v1",
  maximumQuoteAgeMs: 2_000,
  minimumNetEdge: "0.0025",
  maximumOrderNotional: "100",
  maximumMarketExposure: "500",
  maximumTotalExposure: "1000",
};

export function LivePage() {
  const { state, dispatch } = useWorkbench();
  const commands = useWorkbenchCommands();
  const { sourceKind, chartSeries, decisions } = useWorkbenchData();
  if (sourceKind === "verified-local")
    return <VerifiedLivePage commands={commands} />;
  const selected =
    decisions.find((row) => row.id === state.selectedDecisionId) ??
    decisions[1]!;
  return (
    <>
      <PageHeader
        title="实时驾驶舱（Live Cockpit）"
        subtitle="只读行情、模型概率、可交易价格、市场状态和模拟执行。"
        action={
          <div className="toolbar">
            <button className="button">1 秒</button>
            <button className="button">5 秒</button>
            <button className="button">10 秒</button>
            <button
              className="button"
              onClick={() =>
                dispatch({ type: "set-paper-ticket-open", open: true })
              }
            >
              模拟票据
            </button>
          </div>
        }
      />
      <div className="metrics-grid live-metrics">
        <MetricCard
          label="已结算净盈亏"
          english="Settled Net PnL"
          value="+18.42 USDC"
          tone="positive"
          footer={
            <>
              <span>毛盈亏（Gross PnL）</span>
              <strong className="positive">+22.37</strong>
              <span>手续费（Fees）</span>
              <strong className="negative">−3.95</strong>
            </>
          }
        />
        <MetricCard
          label="市价估值盈亏"
          english="Mark-to-Market PnL"
          value="−1.24 USDC"
          tone="negative"
          footer={
            <>
              <span>未结算市场</span>
              <strong>2</strong>
              <span>性质</span>
              <strong>未实现估值</strong>
            </>
          }
        />
        <MetricCard
          label="当前风险敞口"
          english="Current Exposure"
          value="+874 YES"
          tone="blue"
          footer={
            <>
              <span>YES / NO 份额</span>
              <strong>
                <em className="positive">1,286</em> /{" "}
                <em className="negative">412</em>
              </strong>
              <span>风险占用</span>
              <strong className="amber">21.8%</strong>
            </>
          }
        />
        <MetricCard
          label="买入 YES 可执行优势"
          english="Buy YES Executable Edge"
          value="−1.84%"
          tone="negative"
          footer={
            <>
              <span>校准概率 / 卖一价</span>
              <strong>0.612 / 0.625</strong>
              <span>可见数量</span>
              <strong>4,892</strong>
            </>
          }
        />
        <MetricCard
          label="买入 NO 可执行优势"
          english="Buy NO Executable Edge"
          value="+0.36%"
          tone="positive"
          footer={
            <>
              <span>NO 概率 / 卖一价</span>
              <strong>0.388 / 0.381</strong>
              <span>可见数量</span>
              <strong>6,231</strong>
            </>
          }
        />
        <MetricCard
          label="模型质量"
          english="Model Quality · Brier Score"
          value="0.0941"
          footer={
            <>
              <span>布里尔分数 @ T−60s</span>
              <strong>最近 50 个已结算市场</strong>
              <span>基准分数</span>
              <strong>0.1372</strong>
            </>
          }
        />
      </div>
      <div className="live-fidelity-grid">
        <Panel
          title="概率与可交易价格时间线"
          english="Probability & Tradable Price Timeline"
        >
          <LineChart
            height={430}
            series={[
              {
                label: "原始概率 p_raw",
                values: chartSeries.raw,
                color: "#7890a8",
              },
              {
                label: "校准概率 p_cal",
                values: chartSeries.calibrated,
                color: "#4f91ff",
              },
              { label: "YES 买一", values: chartSeries.bid, color: "#4fd17d" },
              { label: "YES 卖一", values: chartSeries.ask, color: "#ff676f" },
            ]}
          />
        </Panel>
        <div className="stack">
          <Panel
            title="市场状态"
            english="Market State"
            action={<Badge tone="good">ACTIVE 活跃</Badge>}
          >
            <MarketState />
          </Panel>
          <Panel title="Polymarket 五档盘口" english="Order Book">
            <OrderBook />
          </Panel>
        </div>
        <Panel
          title="当前决策"
          english="Current Decision"
          action={<Badge tone="good">ELIGIBLE 可执行</Badge>}
        >
          <div className="decision-card decision-card--dense">
            <span>当前动作（Current Action）</span>
            <strong>买入 NO（BUY NO）</strong>
            <p>净优势 +0.36% · 目标数量 1,000</p>
            <dl>
              <dt>原始概率 p_raw</dt>
              <dd>0.605</dd>
              <dt>校准概率 p_cal</dt>
              <dd>0.606</dd>
              <dt>NO 卖一价</dt>
              <dd className="negative">0.381</dd>
              <dt>可见数量</dt>
              <dd>6,231</dd>
              <dt>策略阈值</dt>
              <dd>0.25%</dd>
              <dt>特征时间戳</dt>
              <dd>23:18:16.120</dd>
            </dl>
            <ul className="check-list">
              <li>✓ 扣除手续费后的优势高于阈值</li>
              <li>✓ 可见盘口深度满足最低要求</li>
              <li>✓ 数据新鲜度满足要求</li>
              <li className="warning">⚠ 盘口连续性仍未被外部证明</li>
            </ul>
          </div>
        </Panel>
      </div>
      <div className="split-grid">
        <Panel
          title="最近决策与执行事件"
          english="Recent Decisions & Execution Events"
        >
          <DecisionTable
            rows={decisions}
            selectedId={selected.id}
            onSelect={(id) =>
              dispatch({ type: "select-decision", decisionId: id })
            }
          />
        </Panel>
        <Panel title="选中决策详情" english="Selected Decision Detail">
          <div className="inspector">
            <Badge tone="info">{selected.event}</Badge>
            <h3>{selected.market}</h3>
            <dl>
              <dt>方向</dt>
              <dd>{selected.direction}</dd>
              <dt>校准概率</dt>
              <dd>{selected.probability}</dd>
              <dt>执行价格</dt>
              <dd>{selected.price}</dd>
              <dt>净优势</dt>
              <dd>{selected.edge}</dd>
              <dt>最终状态</dt>
              <dd>{selected.eligibility}</dd>
              <dt>模拟 PnL</dt>
              <dd>{selected.pnl}</dd>
            </dl>
            <h4>双边盘口快照</h4>
            <p>
              YES 0.584 / 0.625　NO 0.369 / 0.381
              <br />
              数据年龄 18 ms · receive stamp local-mono
            </p>
          </div>
        </Panel>
      </div>
      {state.paperTicketOpen && (
        <div
          className="drawer-layer"
          onMouseDown={() =>
            dispatch({ type: "set-paper-ticket-open", open: false })
          }
        >
          <aside
            className="ticket"
            role="dialog"
            aria-modal="true"
            aria-label="模拟订单票据"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="modal__close"
              aria-label="关闭模拟票据"
              onClick={() =>
                dispatch({ type: "set-paper-ticket-open", open: false })
              }
            >
              ×
            </button>
            <Badge tone="warn">PAPER ONLY</Badge>
            <h2>模拟订单票据</h2>
            <div className="ticket__sides">
              <button>
                YES <b>0.625</b>
              </button>
              <button className="active">
                NO <b>0.381</b>
              </button>
            </div>
            <label>
              模拟金额
              <input defaultValue="1000" inputMode="decimal" />
            </label>
            <dl>
              <dt>预估份额</dt>
              <dd>2,624.67</dd>
              <dt>预估手续费</dt>
              <dd>3.42 USDC</dd>
              <dt>最大模拟损失</dt>
              <dd>1,003.42</dd>
            </dl>
            <button className="button button--primary button--wide">
              创建纸面订单
            </button>
            <small>该操作仅更新前端预览状态，不会签名或提交真实订单。</small>
          </aside>
        </div>
      )}
    </>
  );
}

function VerifiedLivePage({
  commands,
}: {
  commands: WorkbenchCommands | null;
}) {
  const [sessions, setSessions] = useState<readonly PaperSessionViewV1[]>([]);
  const [control, setControl] = useState<PaperSystemControlV1 | null>(null);
  const [host, setHost] = useState<PaperMarketHostStatusV1 | null>(null);
  const [marketRuntime, setMarketRuntime] =
    useState<PaperMarketRuntimeV1 | null>(null);
  const [strategyRuntime, setStrategyRuntime] =
    useState<PaperStrategyRuntimeV1 | null>(null);
  const [marketSlug, setMarketSlug] = useState("");
  const [networkApproval, setNetworkApproval] = useState(false);
  const [detail, setDetail] = useState<PaperSessionDetailV1 | null>(null);
  const [orderMarketId, setOrderMarketId] = useState("");
  const [orderToken, setOrderToken] = useState<"YES" | "NO">("YES");
  const [orderPrice, setOrderPrice] = useState("0.5");
  const [orderQuantity, setOrderQuantity] = useState("1");
  const [modelProbabilityYes, setModelProbabilityYes] = useState("0.6");
  const [timeInForce, setTimeInForce] = useState<"GTC" | "GTD" | "FAK" | "FOK">(
    "GTC",
  );
  const [expiresAtUtc, setExpiresAtUtc] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [initialCash, setInitialCash] = useState("10000");
  const [paperError, setPaperError] = useState<string | null>(
    commands === null ? "本地命令桥接不可用；实时模拟保持关闭。" : null,
  );
  const [busy, setBusy] = useState(false);

  async function refresh() {
    if (commands === null) return;
    const [
      nextSessions,
      nextControl,
      nextHost,
      nextMarketRuntime,
      nextRuntime,
    ] = await Promise.all([
      commands.listPaperSessions(),
      commands.getPaperSystemControl(),
      commands.getPaperMarketHostStatus(),
      commands.getPaperMarketRuntime(),
      commands.getPaperStrategyRuntime(),
    ]);
    setSessions(nextSessions);
    setControl(nextControl);
    setHost(nextHost);
    setMarketRuntime(nextMarketRuntime);
    setStrategyRuntime(nextRuntime);
  }

  useEffect(() => {
    if (commands === null) return;
    let active = true;
    Promise.all([
      commands.listPaperSessions(),
      commands.getPaperSystemControl(),
      commands.getPaperMarketHostStatus(),
      commands.getPaperMarketRuntime(),
      commands.getPaperStrategyRuntime(),
    ])
      .then(
        ([
          nextSessions,
          nextControl,
          nextHost,
          nextMarketRuntime,
          nextRuntime,
        ]) => {
          if (active) {
            setSessions(nextSessions);
            setControl(nextControl);
            setHost(nextHost);
            setMarketRuntime(nextMarketRuntime);
            setStrategyRuntime(nextRuntime);
            setPaperError(null);
          }
        },
      )
      .catch((error: unknown) => {
        if (active)
          setPaperError(message(error, "Paper 状态不可用；实时模拟保持关闭。"));
      });
    return () => {
      active = false;
    };
  }, [commands]);
  useEffect(() => {
    const market = marketRuntime?.market;
    if (market === null || market === undefined) return;
    setOrderMarketId((current) => (current === "" ? market.marketId : current));
    setOrderPrice((current) =>
      current === "0.5"
        ? orderToken === "YES"
          ? market.up.ask
          : market.down.ask
        : current,
    );
  }, [marketRuntime?.market?.marketId]);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setPaperError(null);
    try {
      const result = await action();
      await refresh();
      setPaperError(typeof result === "string" ? result : success);
    } catch (error: unknown) {
      setPaperError(message(error, "操作被后端拒绝；实时模拟保持关闭。"));
    } finally {
      setBusy(false);
    }
  }

  async function toggleKillSwitch() {
    if (commands === null || control === null) return;
    await run(
      () =>
        commands.setPaperKillSwitch(
          !control.killSwitchEnabled,
          control.killSwitchEnabled
            ? "OPERATOR_RESUME_FROM_WORKBENCH"
            : "OPERATOR_EMERGENCY_STOP_FROM_WORKBENCH",
        ),
      control.killSwitchEnabled
        ? "Kill Switch 已解除。"
        : "Kill Switch 已启用。",
    );
  }

  function start() {
    if (commands === null) return;
    const normalizedSessionId = sessionId.trim();
    if (
      normalizedSessionId === "" ||
      !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(initialCash) ||
      Number(initialCash) <= 0
    ) {
      setPaperError("会话 ID 和正数初始资金为必填项；未启动任何会话。");
      return;
    }
    void run(
      () =>
        commands.startPaperSession({
          schemaVersion: "paper-session-start-v1",
          sessionId: normalizedSessionId,
          initialCash,
          risk: DEFAULT_RISK,
          startedAtUtc: new Date().toISOString(),
        }),
      "Paper 会话已由后端启动。",
    );
  }

  const disabled = commands === null || busy;
  function startHost() {
    if (commands === null) return;
    const slug = marketSlug.trim();
    if (!/^btc-updown-5m-[0-9]+$/u.test(slug) || !networkApproval) {
      setPaperError(
        "必须填写精确 BTC 五分钟 slug，并明确批准本次公开行情联网采集；尚未启动。",
      );
      return;
    }
    void run(
      () =>
        commands
          .startPublicPaperMarketHost(slug, true)
          .then((value) => setHost(value)),
      "公开只读行情 host 已启动。",
    );
  }
  function loadDetail(id: string) {
    if (commands === null) return;
    void run(async () => {
      setDetail(await commands.getPaperSessionDetail(id));
    }, `会话 ${id} 账本已刷新。`);
  }
  function feeEvidence(marketId: string) {
    const market = marketRuntime?.market;
    if (market === null || market === undefined || market.marketId !== marketId)
      return null;
    return market.feeEvidence;
  }
  function submitOrder() {
    if (commands === null || detail === null) return;
    const marketId = orderMarketId.trim(),
      fee = feeEvidence(marketId);
    if (fee === null) {
      setPaperError("当前市场没有后端费用证据，Paper 下单已拒绝。");
      return;
    }
    const expiry = timeInForce === "GTD" ? expiresAtUtc.trim() : null;
    if (
      timeInForce === "GTD" &&
      (expiry === null || expiry === "" || Number.isNaN(Date.parse(expiry)))
    ) {
      setPaperError("GTD 必须提供有效 UTC 到期时间。");
      return;
    }
    const ordinal = `${Date.now()}`;
    void run(async () => {
      const order = await commands.submitPaperOrder(detail.session.sessionId, {
        schemaVersion: "paper-order-request-v2",
        idempotencyKey: `ui-${ordinal}`,
        clientOrderId: `ui-${ordinal}`,
        marketId,
        token: orderToken,
        limitPrice: orderPrice,
        quantity: orderQuantity,
        timeInForce,
        expiresAtUtc: expiry,
        modelProbabilityYes,
        feeEvidence: fee,
      });
      setDetail(await commands.getPaperSessionDetail(detail.session.sessionId));
      return order.status === "REJECTED"
        ? `订单被风控拒绝：${order.rejectionReason ?? "未提供原因"}`
        : `Paper 订单状态：${order.status}`;
    }, "Paper 订单已提交后端模拟执行。");
  }
  function repriceOrder(order: PaperSessionDetailV1["orders"][number]) {
    if (commands === null || detail === null) return;
    const fee = feeEvidence(order.marketId);
    if (fee === null) {
      setPaperError("当前市场没有后端费用证据，Paper 改价已拒绝。");
      return;
    }
    const ordinal = `${Date.now()}`;
    void run(async () => {
      const replacement: Parameters<WorkbenchCommands["repricePaperOrder"]>[2] =
        {
          schemaVersion: "paper-order-request-v2",
          idempotencyKey: `ui-reprice-${ordinal}`,
          clientOrderId: `ui-reprice-${ordinal}`,
          marketId: order.marketId,
          token: order.token,
          limitPrice: orderPrice,
          quantity: order.remainingQuantity,
          timeInForce: order.timeInForce,
          expiresAtUtc: order.expiresAtUtc,
          modelProbabilityYes,
          feeEvidence: fee,
        };
      const next = await commands.repricePaperOrder(
        detail.session.sessionId,
        order.orderId,
        replacement,
      );
      setDetail(await commands.getPaperSessionDetail(detail.session.sessionId));
      return next.status === "REJECTED"
        ? `改价被风控拒绝：${next.rejectionReason ?? "未提供原因"}`
        : `订单 ${order.orderId} 已改价为 ${orderPrice}。`;
    }, `订单 ${order.orderId} 已改价。`);
  }
  return (
    <>
      <PageHeader
        title="实时驾驶舱（Live Cockpit）"
        subtitle="只展示后端 Paper 会话状态；未获批准或行情主机不可用时安全关闭，不以历史或预览数据冒充实时行情。"
        action={
          <button
            className="button"
            disabled={disabled || control === null}
            onClick={() => void toggleKillSwitch()}
          >
            {control?.killSwitchEnabled === true
              ? "解除 Kill Switch"
              : "启用 Kill Switch"}
          </button>
        }
      />
      <Panel title="Paper 系统控制" english="Paper Safety Control">
        {control === null ? (
          <EmptyState
            title="Paper 控制状态不可用"
            detail={paperError ?? "正在等待后端状态。"}
          />
        ) : (
          <div className="validation-list">
            <span>
              Kill Switch{" "}
              <b
                className={control.killSwitchEnabled ? "negative" : "positive"}
              >
                {control.killSwitchEnabled ? "已启用" : "未启用"}
              </b>
            </span>
            <span>
              最后原因 <b>{control.reason}</b>
            </span>
            <span>
              更新时间 <b>{control.updatedAtUtc}</b>
            </span>
            <span>
              真实交易路径 <b className="positive">不存在</b>
            </span>
          </div>
        )}
      </Panel>
      <Panel title="公开行情宿主" english="Public Market Host">
        <div className="validation-list">
          <span>
            生命周期 <b>{host?.lifecycle ?? "UNAVAILABLE"}</b>
          </span>
          <span>
            连接 <b>{host?.connection ?? "UNAVAILABLE"}</b>
          </span>
          <span>
            可用快照 <b>{host?.ready === true ? "READY" : "NOT READY"}</b>
          </span>
          <span>
            快照 / 缺口 / 错误{" "}
            <b>
              {host === null
                ? "—"
                : `${host.snapshotCount} / ${host.gapCount} / ${host.errorCount}`}
            </b>
          </span>
        </div>
        <div className="form-grid">
          <label>
            BTC 五分钟市场 slug
            <input
              aria-label="BTC 五分钟市场 slug"
              value={marketSlug}
              onChange={(event) => setMarketSlug(event.target.value)}
              placeholder="btc-updown-5m-<epoch>"
              disabled={disabled || host?.lifecycle === "RUNNING"}
            />
          </label>
          <label>
            <input
              aria-label="批准公开行情联网采集"
              type="checkbox"
              checked={networkApproval}
              onChange={(event) => setNetworkApproval(event.target.checked)}
              disabled={disabled || host?.lifecycle === "RUNNING"}
            />{" "}
            我明确批准本次 Gamma/CLOB 公开行情采集
          </label>
        </div>
        <div className="toolbar">
          <button
            className="button button--primary"
            disabled={disabled || host?.lifecycle === "RUNNING"}
            onClick={startHost}
          >
            启动公开行情 host
          </button>
          <button
            className="button"
            disabled={disabled || host?.lifecycle !== "RUNNING"}
            onClick={() =>
              void run(
                () =>
                  commands!
                    .stopPublicPaperMarketHost()
                    .then((value) => setHost(value)),
                "公开行情 host 已停止。",
              )
            }
          >
            停止公开行情 host
          </button>
        </div>
        <small>
          只连接无认证 Gamma/CLOB market
          数据；不连接用户频道、钱包、签名或真实订单。
        </small>
      </Panel>
      <Panel title="实时公开盘口与信号" english="Public Market Runtime">
        {marketRuntime?.market === null || marketRuntime === null ? (
          <EmptyState
            title="实时盘口不可用"
            detail="后端尚未形成同时新鲜的 Polymarket 盘口与 Binance 信号；不会使用预览价格。"
          />
        ) : (
          <>
            <div className="validation-list">
              <span>
                状态 <b>{marketRuntime.status}</b>
              </span>
              <span>
                市场 <b>{marketRuntime.market.slug}</b>
              </span>
              <span>
                Binance 价格 <b>{marketRuntime.market.signal.price}</b>
              </span>
              <span>
                盘口 / 信号年龄{" "}
                <b>
                  {marketRuntime.market.bookAgeMs ?? "不可用"} /{" "}
                  {marketRuntime.market.signalAgeMs ?? "不可用"} ms
                </b>
              </span>
              <span>
                连续性{" "}
                <b className="amber">{marketRuntime.market.continuity}</b>
              </span>
              <span>
                决策时间 <b>{marketRuntime.market.decisionTime}</b>
              </span>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>方向</th>
                  <th>Token</th>
                  <th>买一 / 数量</th>
                  <th>卖一 / 数量</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>YES / UP</td>
                  <td>{marketRuntime.market.up.tokenId}</td>
                  <td>
                    {marketRuntime.market.up.bid} /{" "}
                    {marketRuntime.market.up.bidSize}
                  </td>
                  <td>
                    {marketRuntime.market.up.ask} /{" "}
                    {marketRuntime.market.up.askSize}
                  </td>
                </tr>
                <tr>
                  <td>NO / DOWN</td>
                  <td>{marketRuntime.market.down.tokenId}</td>
                  <td>
                    {marketRuntime.market.down.bid} /{" "}
                    {marketRuntime.market.down.bidSize}
                  </td>
                  <td>
                    {marketRuntime.market.down.ask} /{" "}
                    {marketRuntime.market.down.askSize}
                  </td>
                </tr>
              </tbody>
            </table>
          </>
        )}
      </Panel>
      <Panel title="K/J 策略运行时" english="K/J Paper Strategy Runtime">
        <p className="panel-note">
          权威资金、订单和成交只来自独立的 J/K canonical Paper session。旧 K/J
          wallet 与 FILL 保留为 non-authoritative 研究影子，不会计入余额或 PnL。
        </p>
        {strategyRuntime === null ? (
          <EmptyState
            title="K/J 运行时不可用"
            detail="尚未收到通过严格契约校验的后端策略运行时数据。"
          />
        ) : (
          <>
            <div className="validation-list">
              <span>
                状态 <b>{strategyRuntime.status}</b>
              </span>
              <span>
                执行权威 <b>{strategyRuntime.executionAuthority}</b>
              </span>
              <span>
                规划引擎 <b>{strategyRuntime.planner.engineVersion}</b>
              </span>
              <span>
                日志 / 恢复输入{" "}
                <b>
                  {strategyRuntime.planner.journalRecordCount} /{" "}
                  {strategyRuntime.planner.recoveredInputCount}
                </b>
              </span>
              <span>
                错误 <b>{strategyRuntime.planner.error ?? "无"}</b>
              </span>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>策略</th>
                  <th>Canonical 会话</th>
                  <th>状态</th>
                  <th>权威现金</th>
                  <th>成交</th>
                </tr>
              </thead>
              <tbody>
                {strategyRuntime.canonicalAccounts.map((account) => (
                  <tr key={account.strategy}>
                    <td>{account.strategy}</td>
                    <td>{account.session.sessionId}</td>
                    <td>{account.session.status}</td>
                    <td>{account.session.cash}</td>
                    <td>{account.session.fillCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="validation-list">
              <span>
                协调 links <b>{strategyRuntime.executionLinks.length}</b>
              </span>
              <span>
                已提交{" "}
                <b>
                  {
                    strategyRuntime.executionLinks.filter(
                      (link) => link.state === "SUBMITTED",
                    ).length
                  }
                </b>
              </span>
              <span>
                影子权威性{" "}
                <b className="amber">
                  {strategyRuntime.shadow.nonAuthoritative
                    ? "NON-AUTHORITATIVE"
                    : "INVALID"}
                </b>
              </span>
            </div>
            {strategyRuntime.shadow.snapshot === null ? (
              <EmptyState
                title="尚无 K/J 影子快照"
                detail="后端运行时尚未生成真实策略输入；页面不使用演示快照。"
              />
            ) : (
              <div className="validation-list">
                <span>
                  影子 J 现金{" "}
                  <b>
                    {strategyRuntime.shadow.snapshot.wallets.J_FEE_AWARE.cash}
                  </b>
                </span>
                <span>
                  影子 K 现金{" "}
                  <b>
                    {strategyRuntime.shadow.snapshot.wallets.K_DUAL_VOL.cash}
                  </b>
                </span>
                <span>
                  影子事件 <b>{strategyRuntime.shadow.snapshot.eventCount}</b>
                </span>
              </div>
            )}
            <StrategyDecisionExplanation events={strategyRuntime.shadow.events} />
            <details className="technical-details">
              <summary>查看最近 20 条策略审计事件与技术字段</summary>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>影子事件</th>
                      <th>策略</th>
                      <th>市场</th>
                      <th>技术详情</th>
                    </tr>
                  </thead>
                  <tbody>
                    {strategyRuntime.shadow.events
                      .slice(-20)
                      .reverse()
                      .map((event) => (
                        <tr key={event.eventId}>
                          <td>{event.eventTime}</td>
                          <td>{event.eventType}</td>
                          <td>{event.strategy ?? "SYSTEM"}</td>
                          <td>{event.marketId}</td>
                          <td>
                            {Object.entries(event.details)
                              .map(([key, value]) => `${key}=${String(value)}`)
                              .join(" · ") || "—"}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </Panel>
      <Panel title="启动实时模拟" english="Start Live Paper Session">
        <div className="form-grid">
          <label>
            会话 ID
            <input
              aria-label="Paper 会话 ID"
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              placeholder="例如 btc-paper-001"
              disabled={disabled}
            />
          </label>
          <label>
            初始资金（USDC）
            <input
              aria-label="Paper 初始资金"
              value={initialCash}
              onChange={(event) => setInitialCash(event.target.value)}
              inputMode="decimal"
              disabled={disabled}
            />
          </label>
        </div>
        <div className="toolbar">
          <button
            className="button button--primary"
            disabled={disabled || control?.killSwitchEnabled === true}
            onClick={start}
          >
            启动 Paper 会话
          </button>
          <button
            className="button"
            disabled={disabled}
            onClick={() => void run(refresh, "状态已刷新。")}
          >
            刷新状态
          </button>
        </div>
        <p
          className={paperError?.includes("已") ? "positive" : "negative"}
          role="status"
        >
          {paperError ??
            "启动命令只请求后端连接已批准的公共行情主机；前端不会直接联网或访问数据库。"}
        </p>
      </Panel>
      <Panel title="实时模拟会话" english="Live Paper Sessions">
        {sessions.length === 0 ? (
          <EmptyState
            title="实时快照不可用"
            detail="没有运行中的后端 Paper 会话。若公共行情采集尚未获批准或行情主机离线，启动请求会被后端拒绝。"
          />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>会话</th>
                <th>适配器</th>
                <th>状态</th>
                <th>现金</th>
                <th>挂单</th>
                <th>成交</th>
                <th>控制</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.sessionId}>
                  <td>{session.sessionId}</td>
                  <td>{session.adapterId}</td>
                  <td>{session.status}</td>
                  <td>{session.cash}</td>
                  <td>{session.openOrderCount}</td>
                  <td>{session.fillCount}</td>
                  <td>
                    <div className="toolbar">
                      <button
                        className="button"
                        disabled={disabled || session.status !== "RUNNING"}
                        onClick={() =>
                          void run(
                            () => commands!.stopPaperSession(session.sessionId),
                            `会话 ${session.sessionId} 已停止。`,
                          )
                        }
                      >
                        停止
                      </button>
                      <button
                        className="button"
                        disabled={
                          disabled ||
                          session.status !== "STOPPED" ||
                          control?.killSwitchEnabled === true
                        }
                        onClick={() =>
                          void run(
                            () =>
                              commands!.resumePaperSession(session.sessionId),
                            `会话 ${session.sessionId} 已恢复。`,
                          )
                        }
                      >
                        恢复
                      </button>
                      <button
                        className="button"
                        disabled={disabled}
                        onClick={() => loadDetail(session.sessionId)}
                      >
                        账本
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel title="Paper 模拟订单与账本" english="Paper Orders & Ledger">
        {detail === null ? (
          <EmptyState
            title="尚未选择 Paper 会话"
            detail="从上方会话表点击“账本”；所有订单、成交、仓位和结算均由后端返回。"
          />
        ) : (
          <>
            <div className="form-grid">
              <label>
                市场 ID
                <input
                  aria-label="Paper 市场 ID"
                  value={orderMarketId}
                  onChange={(event) => setOrderMarketId(event.target.value)}
                />
              </label>
              <label>
                方向 / 手动结算胜方
                <select
                  aria-label="Paper 方向"
                  value={orderToken}
                  onChange={(event) =>
                    setOrderToken(event.target.value as "YES" | "NO")
                  }
                >
                  <option>YES</option>
                  <option>NO</option>
                </select>
              </label>
              <label>
                限价 / 改价目标
                <input
                  aria-label="Paper 限价"
                  value={orderPrice}
                  onChange={(event) => setOrderPrice(event.target.value)}
                />
              </label>
              <label>
                数量
                <input
                  aria-label="Paper 数量"
                  value={orderQuantity}
                  onChange={(event) => setOrderQuantity(event.target.value)}
                />
              </label>
              <label>
                模型 YES 概率
                <input
                  aria-label="模型 YES 概率"
                  value={modelProbabilityYes}
                  onChange={(event) =>
                    setModelProbabilityYes(event.target.value)
                  }
                />
              </label>
              <label>
                后端手续费证据
                <input
                  aria-label="后端手续费证据"
                  value={feeEvidence(orderMarketId.trim())?.rate ?? "不可用"}
                  readOnly
                />
              </label>
              <label>
                有效期
                <select
                  aria-label="Paper 有效期"
                  value={timeInForce}
                  onChange={(event) =>
                    setTimeInForce(
                      event.target.value as "GTC" | "GTD" | "FAK" | "FOK",
                    )
                  }
                >
                  <option>GTC</option>
                  <option>GTD</option>
                  <option>FAK</option>
                  <option>FOK</option>
                </select>
              </label>
              {timeInForce === "GTD" ? (
                <label>
                  到期时间（UTC ISO）
                  <input
                    aria-label="Paper 到期时间"
                    value={expiresAtUtc}
                    onChange={(event) => setExpiresAtUtc(event.target.value)}
                    placeholder="2026-07-22T12:00:00.000Z"
                  />
                </label>
              ) : null}
            </div>
            <div className="toolbar">
              <button
                className="button button--primary"
                disabled={
                  disabled ||
                  control?.killSwitchEnabled === true ||
                  orderMarketId.trim() === "" ||
                  feeEvidence(orderMarketId.trim()) === null
                }
                onClick={submitOrder}
              >
                创建 Paper 订单
              </button>
              <button
                className="button"
                disabled={disabled}
                onClick={() =>
                  void run(async () => {
                    const expired = await commands!.expirePaperOrders(
                      detail.session.sessionId,
                    );
                    setDetail(
                      await commands!.getPaperSessionDetail(
                        detail.session.sessionId,
                      ),
                    );
                    return `过期检查完成：${expired.length} 个订单已过期。`;
                  }, "订单过期检查已完成。")
                }
              >
                检查过期订单
              </button>
              <button
                className="button"
                disabled={disabled || orderMarketId.trim() === ""}
                onClick={() =>
                  void run(async () => {
                    const settlement = await commands!.settlePaperMarket(
                      detail.session.sessionId,
                      orderMarketId.trim(),
                      orderToken,
                      "MANUAL_PAPER_TEST",
                    );
                    setDetail(
                      await commands!.getPaperSessionDetail(
                        detail.session.sessionId,
                      ),
                    );
                    return `市场 ${settlement.marketId} 已按 ${settlement.winningToken} 手动模拟结算，派彩 ${settlement.payout}。`;
                  }, "手动模拟结算已完成。")
                }
              >
                手动模拟结算
              </button>
            </div>
            <small>
              创建和改价使用当前市场的 V2 后端手续费证据；GTD
              到期时间由后端校验。手动结算只允许 MANUAL_PAPER_TEST，不会触发真实市场结算。
            </small>
            <table className="data-table">
              <thead>
                <tr>
                  <th>订单</th>
                  <th>市场</th>
                  <th>方向</th>
                  <th>限价 / 数量</th>
                  <th>成交</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {detail.orders.map((order) => (
                  <tr key={order.orderId}>
                    <td>{order.orderId}</td>
                    <td>{order.marketId}</td>
                    <td>{order.token}</td>
                    <td>
                      {order.limitPrice} / {order.quantity}
                    </td>
                    <td>{order.filledQuantity}</td>
                    <td>
                      {order.status}
                      {order.rejectionReason === null
                        ? ""
                        : ` · ${order.rejectionReason}`}
                    </td>
                    <td>
                      <div className="toolbar">
                        <button
                          className="button"
                          disabled={
                            disabled ||
                            !(
                              order.status === "OPEN" ||
                              order.status === "PARTIALLY_FILLED"
                            ) ||
                            feeEvidence(order.marketId) === null
                          }
                          onClick={() => repriceOrder(order)}
                        >
                          改价
                        </button>
                        <button
                          className="button"
                          disabled={
                            disabled ||
                            !(
                              order.status === "OPEN" ||
                              order.status === "PARTIALLY_FILLED"
                            )
                          }
                          onClick={() =>
                            void run(async () => {
                              await commands!.cancelPaperOrder(
                                detail.session.sessionId,
                                order.orderId,
                                "OPERATOR_CANCEL_FROM_WORKBENCH",
                              );
                              setDetail(
                                await commands!.getPaperSessionDetail(
                                  detail.session.sessionId,
                                ),
                              );
                            }, `订单 ${order.orderId} 已撤销。`)
                          }
                        >
                          撤单
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="validation-list">
              <span>
                成交 <b>{detail.fills.length}</b>
              </span>
              <span>
                仓位 <b>{detail.positions.length}</b>
              </span>
              <span>
                结算 <b>{detail.settlements.length}</b>
              </span>
              <span>
                审计事件 <b>{detail.events.length}</b>
              </span>
            </div>
          </>
        )}
      </Panel>
    </>
  );
}

function StrategyDecisionExplanation({
  events,
}: {
  events: PaperStrategyRuntimeV1["shadow"]["events"];
}) {
  const event = [...events]
    .reverse()
    .find((item) => item.eventType === "DECISION" && item.strategy !== null && item.details.riskStatus !== undefined);
  if (event === undefined) return <EmptyState title="尚无可解释的动态策略判断" detail="等待后端策略生成包含概率、净优势、目标仓位和风控结果的真实事件；页面不会用示例数字补齐。" />;
  const details = event.details;
  const approved = details.riskStatus === "APPROVED" ? "批准" : details.riskStatus === "REDUCED" ? "已缩小" : "拒绝";
  return <section className="strategy-explanation" aria-label="最近动态策略判断">
    <header><div><strong>最近策略判断</strong><span>{event.strategy} · {event.eventTime}</span></div><Badge tone={details.riskStatus === "APPROVED" ? "good" : details.riskStatus === "REDUCED" ? "warn" : "bad"}>风控{approved}</Badge></header>
    <p>{details.reason ?? details.riskReasonCodes ?? "后端未记录判断原因"}</p>
    <div className="validation-list">
      <span>模型概率 <b>{details.probabilityUp ?? "未记录"}</b></span>
      <span>扣费后净优势 <b>{details.netEdge ?? "未记录"}</b></span>
      <span>可执行价格 <b>{details.estimatedAveragePrice ?? details.decisionAsk ?? "未记录"}</b></span>
      <span>预估手续费 <b>{details.estimatedFee ?? "未记录"}</b></span>
      <span>目标总仓位 <b>{details.targetPositionQuantity ?? "未记录"}</b></span>
      <span>已有 / 在途仓位 <b>{details.currentPositionQuantity ?? "0"} / {details.openOrderQuantity ?? "0"}</b></span>
      <span>本次获准数量 <b>{details.riskApprovedQuantity ?? "0"}</b></span>
      <span>风控原因 <b>{details.riskReasonCodes ?? details.reason ?? "未记录"}</b></span>
    </div>
    <small>价格为当前最佳可执行卖一价；当前输入仅包含可见一档深度，未观察到多档时不会伪称 VWAP。</small>
  </section>;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : fallback;
}

function MarketState() {
  return (
    <div className="market-state">
      <span>
        BTC 当前价格<b>67,842.31</b>
      </span>
      <span>
        五分钟参考开盘价<b>67,620.00</b>
      </span>
      <span>
        价格差<b className="positive">+222.31</b>
      </span>
      <span>
        基点差 bps<b className="positive">+32.86</b>
      </span>
      <span>
        当前方向<b className="positive">UP 上涨</b>
      </span>
      <span>
        剩余时间<b>00:02:17</b>
      </span>
      <span>
        下一市场<b className="positive">READY 就绪</b>
      </span>
      <span>
        可模拟交易<b className="positive">YES</b>
      </span>
    </div>
  );
}
function OrderBook() {
  const levels = [
    ["0.584", "1,852", "0.625", "1,246"],
    ["0.583", "1,320", "0.626", "1,598"],
    ["0.582", "1,210", "0.627", "1,330"],
    ["0.581", "980", "0.629", "1,220"],
    ["0.580", "918", "0.630", "1,498"],
  ];
  return (
    <>
      <table className="book">
        <thead>
          <tr>
            <th>档位</th>
            <th>买量</th>
            <th>买价</th>
            <th>卖价</th>
            <th>卖量</th>
          </tr>
        </thead>
        <tbody>
          {levels.map((row, index) => (
            <tr key={row[0]}>
              <td>{index + 1}</td>
              <td>{row[1]}</td>
              <td className="positive">{row[0]}</td>
              <td className="negative">{row[2]}</td>
              <td>{row[3]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="book-summary">
        <span>
          买一<b className="positive">0.584</b>
        </span>
        <span>
          点差<b>0.041</b>
        </span>
        <span>
          卖一<b className="negative">0.625</b>
        </span>
      </div>
    </>
  );
}
