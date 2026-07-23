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
            xLabel="公开市场快照序号 · 概率 0–1 · Paper 观察"
            series={[
              {
                label: "原始概率 p_raw",
                values: chartSeries.raw,
                color: "#7890a8",
                lineStyle: "dashed",
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

function VerifiedLivePage({ commands }: { commands: WorkbenchCommands | null }) {
  const { state, dispatch } = useWorkbench();
  const [definitions, setDefinitions] = useState<readonly import("../services/workbench-commands.js").StrategyDefinitionV1[]>([]);
  const [strategyId, setStrategyId] = useState<"J_FEE_AWARE" | "K_DUAL_VOL" | "L_ADAPTIVE_EXECUTION_V2">("J_FEE_AWARE");
  const [versions, setVersions] = useState<readonly string[]>([]);
  const [strategyVersion, setStrategyVersion] = useState("");
  const [initialCash, setInitialCash] = useState(state.researchSession.initialCash);
  const [maximumPosition, setMaximumPosition] = useState(state.researchSession.maxPosition);
  const [minimumNetEdge, setMinimumNetEdge] = useState("0.05");
  const [host, setHost] = useState<PaperMarketHostStatusV1 | null>(null);
  const [market, setMarket] = useState<PaperMarketRuntimeV1 | null>(null);
  const [runtime, setRuntime] = useState<PaperStrategyRuntimeV1 | null>(null);
  const [detail, setDetail] = useState<PaperSessionDetailV1 | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(commands === null ? "本地后端不可用，Paper Runner 保持关闭。" : "选择策略版本和风险后即可启动。");

  async function refresh() {
    if (commands === null) return;
    const [nextHost, nextMarket, nextRuntime] = await Promise.all([commands.getPaperMarketHostStatus(), commands.getPaperMarketRuntime(), commands.getPaperStrategyRuntime()]);
    setHost(nextHost); setMarket(nextMarket); setRuntime(nextRuntime);
    const activeStrategy = nextRuntime.canonicalAccounts.length === 1
      ? nextRuntime.canonicalAccounts[0]!.strategy
      : strategyId;
    if (activeStrategy !== strategyId) setStrategyId(activeStrategy);
    const account = nextRuntime.canonicalAccounts.find((item) => item.strategy === activeStrategy);
    setDetail(account === undefined ? null : await commands.getPaperSessionDetail(account.session.sessionId));
  }
  useEffect(() => {
    if (commands === null) return;
    let active = true;
    commands.listStrategyDefinitions().then((items) => {
      if (!active) return;
      const available = items.filter((item) => item.allowedModes.includes("paper"));
      setDefinitions(available);
      const requested = state.researchSession.strategyId;
      if ((requested === "J_FEE_AWARE" || requested === "K_DUAL_VOL" || requested === "L_ADAPTIVE_EXECUTION_V2") && available.some((item) => item.strategyId === requested)) setStrategyId(requested);
    }).catch((error: unknown) => { if (active) setNotice(message(error, "策略目录不可用。")); });
    void refresh().catch((error: unknown) => { if (active) setNotice(message(error, "Paper Runner 状态不可用。")); });
    return () => { active = false; };
  }, [commands]);
  useEffect(() => {
    if (commands === null) return;
    let active = true;
    commands.listStrategyVersions(strategyId).then((items) => { if (active) { setVersions(items); const requested = state.researchSession.strategyVersion; const restored = state.researchSession.strategyId === strategyId && requested !== null && items.includes(requested) ? requested : items.at(-1) ?? ""; setStrategyVersion(restored); dispatch({ type: "update-research-session", patch: { strategyId, strategyVersion: restored, stage: "paper-review" } }); } }).catch((error: unknown) => { if (active) setNotice(message(error, "策略版本不可用。")); });
    return () => { active = false; };
  }, [commands, strategyId]);
  useEffect(() => {
    if (commands === null) return;
    let active = true;
    let timer = 0;
    const poll = async () => {
      try { await refresh(); }
      catch { /* Keep the last verified view; the next bounded poll retries. */ }
      finally { if (active) timer = window.setTimeout(() => void poll(), 1_000); }
    };
    timer = window.setTimeout(() => void poll(), 1_000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [commands, strategyId]);

  async function run(operation: () => Promise<unknown>, success: string) {
    setBusy(true);
    try { await operation(); await refresh(); setNotice(success); }
    catch (error: unknown) { setNotice(message(error, "操作被后端拒绝。")); }
    finally { setBusy(false); }
  }
  function validMoney(value: string, allowZero = false) { return /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value) && (allowZero ? Number(value) >= 0 : Number(value) > 0); }
  function startRunner() {
    if (commands === null || strategyVersion === "") { setNotice("必须选择已有策略版本。"); return; }
    if (!validMoney(initialCash) || !validMoney(maximumPosition) || !validMoney(minimumNetEdge, true)) { setNotice("资金、最大仓位和最低净优势必须是有效数值。"); return; }
    void run(() => commands.startPaperRunner({ strategyId, strategyVersion, initialCash, maximumPosition, minimumNetEdge }), "Paper Runner 已启动；市场发现、行情、决策、风控、模拟成交、结算和轮转均由后端自动完成。");
  }
  const decision = [...(runtime?.shadow.events ?? [])].reverse().find((event) => event.eventType === "DECISION" && event.strategy === strategyId);
  const lifecycle = [...(runtime?.shadow.events ?? [])].reverse().find((event) => event.eventType === "MARKET_STATE");
  const waitingForNextMarket = decision === undefined && lifecycle?.details.reason === "MISSED_SIGNAL_OPEN_ANCHOR";
  const running = host?.lifecycle === "RUNNING";
  const markValue = detail?.positions.reduce((total, position) => {
    const current = market?.market;
    const bid = current?.marketId === position.marketId
      ? Number(position.token === "YES" ? current.up.bid : current.down.bid)
      : Number(position.cost) / Number(position.quantity);
    return total + Number(position.quantity) * bid;
  }, 0) ?? 0;
  const paperEquity = detail === null ? "—" : (Number(detail.session.cash) + markValue).toFixed(2);
  return <>
    <PageHeader title="自动 Paper Runner" subtitle="选择策略和风险，启动后由系统自动跨 BTC 五分钟市场运行；全程 PAPER ONLY。" action={<div className="toolbar"><button className="button" disabled={busy || !running} onClick={() => commands && void run(() => commands.stopPublicPaperMarketHost(), "Paper Runner 已停止。")}>停止</button><button className="button button--danger" disabled={busy || commands === null} onClick={() => commands && void run(async () => { await commands.setPaperKillSwitch(true, "OPERATOR_EMERGENCY_STOP"); return commands.stopPublicPaperMarketHost(); }, "紧急停止已启用，模拟执行与公开行情均已停止。")}>紧急停止</button></div>} />
    <Panel title="运行设置" english="Strategy & Risk">
      <div className="form-grid form-grid--12">
        <label className="field span-4"><span>策略</span><select aria-label="Paper 策略" value={strategyId} disabled={busy || running} onChange={(event) => setStrategyId(event.target.value as typeof strategyId)}>{definitions.map((item) => <option key={item.strategyId} value={item.strategyId}>{item.displayName}</option>)}</select></label>
        <label className="field span-2"><span>版本</span><select aria-label="Paper 策略版本" value={strategyVersion} disabled={busy || running} onChange={(event) => { setStrategyVersion(event.target.value); dispatch({ type: "update-research-session", patch: { strategyVersion: event.target.value } }); }}>{versions.map((version) => <option key={version}>{version}</option>)}</select></label>
        <label className="field span-2"><span>初始资金 USDC</span><input value={initialCash} disabled={busy || running} onChange={(event) => { setInitialCash(event.target.value); dispatch({ type: "update-research-session", patch: { initialCash: event.target.value } }); }} /></label>
        <label className="field span-2"><span>最大仓位 USDC</span><input value={maximumPosition} disabled={busy || running} onChange={(event) => { setMaximumPosition(event.target.value); dispatch({ type: "update-research-session", patch: { maxPosition: event.target.value } }); }} /></label>
        <label className="field span-2"><span>最低净优势</span><input value={minimumNetEdge} disabled={busy || running} onChange={(event) => setMinimumNetEdge(event.target.value)} /></label>
      </div>
      <div className="toolbar paper-runner-action"><button className="button button--primary" disabled={busy || running || commands === null || strategyVersion === ""} onClick={startRunner}>启动自动 Paper</button><Badge tone={running ? "good" : "warn"}>{running ? "运行中" : "已停止"}</Badge><span>{notice}</span></div>
    </Panel>
    <div className="metrics-grid live-metrics">
      <MetricCard label="模型概率" value={String(decision?.details.probabilityUp ?? "—")} />
      <MetricCard label="净优势" value={String(decision?.details.netEdge ?? decision?.details.edge ?? "—")} />
      <MetricCard label="目标仓位" value={String(decision?.details.targetPositionQuantity ?? "0")} />
      <MetricCard label="风控结果" value={String(decision?.details.riskStatus ?? decision?.details.reason ?? (waitingForNextMarket ? "等待下一市场" : "等待决策"))} />
      <MetricCard label="Paper 现金" value={detail?.session.cash ?? "—"} />
      <MetricCard label="Paper 权益估值" value={paperEquity} />
      <MetricCard label="核心策略计算 P50" value={runtime?.planner.latency?.strategyComputation?.p50Ms == null ? "—" : `${runtime.planner.latency.strategyComputation.p50Ms} ms`} footer={<><span>P95 / 样本 · 目标</span><strong>{runtime?.planner.latency?.strategyComputation?.p95Ms ?? "—"} ms / {runtime?.planner.latency?.strategyComputation?.count ?? 0} · P95&lt;50ms</strong></>} />
      <MetricCard label="行情→持久化决策 P50" value={runtime?.planner.latency?.inputToDecision.p50Ms == null ? "—" : `${runtime.planner.latency.inputToDecision.p50Ms} ms`} footer={<><span>P95 / 样本</span><strong>{runtime?.planner.latency?.inputToDecision.p95Ms ?? "—"} ms / {runtime?.planner.latency?.inputToDecision.count ?? 0}</strong></>} />
      <MetricCard label="决策→Paper 锁单 P50" value={runtime?.planner.latency?.decisionToPaperLock.p50Ms == null ? "—" : `${runtime.planner.latency.decisionToPaperLock.p50Ms} ms`} footer={<><span>P95 / 样本</span><strong>{runtime?.planner.latency?.decisionToPaperLock.p95Ms ?? "—"} ms / {runtime?.planner.latency?.decisionToPaperLock.count ?? 0}</strong></>} />
    </div>
    <div className="split-grid">
      <Panel title="当前决策" english="Decision → Risk → Fill"><div className="inspector"><Badge tone={decision?.details.action === "INTENT" ? "good" : "info"}>{String(decision?.details.action ?? "NO_TRADE")}</Badge><h3>{String(decision?.details.reason ?? (waitingForNextMarket ? "当前市场已开始，自动等待下一个完整 5 分钟市场" : "等待标准化市场输入"))}</h3><dl><dt>概率</dt><dd>{String(decision?.details.probabilityUp ?? "—")}</dd><dt>净优势</dt><dd>{String(decision?.details.netEdge ?? decision?.details.edge ?? "—")}</dd><dt>最大可接受价格</dt><dd>{String(decision?.details.maximumFillPrice ?? "—")}</dd><dt>风险批准数量</dt><dd>{String(decision?.details.riskApprovedQuantity ?? "0")}</dd></dl></div></Panel>
      <Panel title="订单、成交与持仓" english="Authoritative Paper Ledger">{detail === null ? <EmptyState title="等待 Runner 建立账本" detail="启动后会自动建立内部会话。" /> : <div className="validation-list"><span>订单 <b>{detail.orders.length}</b></span><span>成交 <b>{detail.fills.length}</b></span><span>持仓 <b>{detail.positions.length}</b></span><span>结算 <b>{detail.settlements.length}</b></span></div>}</Panel>
    </div>
    <details className="panel"><summary>开发者诊断</summary><div className="validation-list"><span>当前市场 <b>{market?.market?.slug ?? "尚未发现"}</b></span><span>行情状态 <b>{market?.status ?? "STOPPED"}</b></span><span>内部会话 <b>{detail?.session.sessionId ?? "未创建"}</b></span><span>Journal 记录 <b>{runtime?.planner.journalRecordCount ?? 0}</b></span><span>合并的过时盘口 <b>{runtime?.planner.coalescedInputCount ?? 0}</b></span><span>Outbox 链接 <b>{runtime?.executionLinks.length ?? 0}</b></span><span>LIVE_TRADING_ENABLED <b>false</b></span></div></details>
  </>;
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
