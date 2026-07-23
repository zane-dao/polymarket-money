import { useEffect, useState } from "react";
import { useWorkbench } from "../app/WorkbenchContext.js";
import { useWorkbenchData } from "../app/WorkbenchDataContext.js";
import { useWorkbenchCommands } from "../app/WorkbenchCommandContext.js";
import type { BacktestJobV1, DatasetListV1, StrategyDefinitionV1, SystemHealthV1 } from "../services/workbench-commands.js";
import { Badge, EmptyState, Panel } from "../components/ui.js";

export function OverviewPage() {
  const { state, dispatch } = useWorkbench();
  const { sourceKind, runs, decisions } = useWorkbenchData();
  const commands = useWorkbenchCommands();
  const [backendSummary, setBackendSummary] = useState<Readonly<{ strategies: readonly StrategyDefinitionV1[]; datasets: DatasetListV1; jobs: readonly BacktestJobV1[]; health: SystemHealthV1 }> | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  useEffect(() => { if (commands === null || sourceKind !== "verified-local") return; let active = true; Promise.all([commands.listStrategyDefinitions(), commands.listDatasets(), commands.listBacktestJobs(), commands.getSystemHealth()]).then(([strategies, datasets, jobs, health]) => { if (active) { setBackendSummary({strategies,datasets,jobs,health}); setSummaryError(null); } }).catch((error: unknown) => { if (active) setSummaryError(error instanceof Error ? error.message : "后端摘要不可用"); }); return () => { active = false; }; }, [commands, sourceKind]);
  if (sourceKind === "verified-local") {
    const session = state.researchSession;
    const next = session.datasetId === null
      ? { label: "选择研究数据", detail: "先绑定一个已处理、已验证的数据集版本。", routeId: "datasets" as const }
      : session.strategyId === null
        ? { label: "选择策略版本", detail: "把策略与版本绑定到当前研究会话。", routeId: "strategy" as const }
        : session.runId === null
          ? { label: "配置并运行回测", detail: "数据与策略已就绪；检查执行假设后运行。", routeId: "backtest" as const }
          : { label: "审查运行证据", detail: "回测已绑定；比较基准、回放事件并形成判断。", routeId: "compare" as const };
    const latestJobs = backendSummary?.jobs.slice(-4).reverse() ?? [];
    return <div className="research-home">
      <section className="research-home__hero">
        <div className="research-home__brief">
          <span className="eyebrow">ACTIVE RESEARCH TASK · PAPER ONLY</span>
          <h1>把一个研究判断，推进到可审查的证据</h1>
          <p>数据、策略、执行假设和运行结果由同一研究会话串联。你只需要决定下一步，不需要记住每个页面里选过什么。</p>
          <div className="research-home__next">
            <span>NEXT ACTION</span>
            <strong>{next.label}</strong>
            <p>{next.detail}</p>
            <button className="button button--primary" onClick={() => dispatch({ type: "navigate", routeId: next.routeId })}>{next.label} →</button>
          </div>
        </div>
        <aside className="evidence-spine" aria-label="当前研究证据">
          <header><span>EVIDENCE SPINE</span><Badge tone={session.runId === null ? "warn" : "good"}>{session.runId === null ? "BUILDING" : "RUN BOUND"}</Badge></header>
          <ol>
            <li data-state={session.datasetId === null ? "pending" : "ready"}><i>D</i><span><small>Dataset</small><strong>{session.datasetId ?? "待选择数据版本"}</strong></span></li>
            <li data-state={session.strategyId === null ? "pending" : "ready"}><i>S</i><span><small>Strategy</small><strong>{session.strategyId === null ? "待选择策略版本" : `${session.strategyId} · ${session.strategyVersion ?? "待选版本"}`}</strong></span></li>
            <li data-state={session.runId === null ? "pending" : "ready"}><i>R</i><span><small>Experiment</small><strong>{session.runId ?? "尚未生成 Run"}</strong></span></li>
            <li data-state="blocked"><i>G</i><span><small>Paper Gate</small><strong>等待比较与评审</strong></span></li>
          </ol>
        </aside>
      </section>
      <section className="research-home__grid">
        <Panel title="研究资产与运行状态" english="Research Inventory">{backendSummary === null ? <EmptyState title="后端摘要数据不可用" detail={summaryError ?? "正在加载策略、数据集、任务与健康状态。"} /> : <div className="session-status session-status--inventory"><article><span>已注册策略</span><strong>{backendSummary.strategies.length}</strong><small>后端定义</small></article><article><span>可用数据集</span><strong>{backendSummary.datasets.datasets.length}</strong><small>已验证版本</small></article><article><span>历史回测</span><strong>{backendSummary.jobs.length}</strong><small>持久任务</small></article><article><span>当前证据事件</span><strong>{decisions.length}</strong><small>可回放</small></article></div>}</Panel>
        <Panel title="准入判断" english="Readiness Gate" action={<Badge tone="warn">NOT LIVE READY</Badge>}><div className="gate-ledger"><span><i className="ready" />数据与策略可追溯<b>{session.datasetVersionHash !== null && session.strategyVersion !== null ? "READY" : "PENDING"}</b></span><span><i />独立样本稳定性<b>NOT COMPUTED</b></span><span><i />同口径基准改善<b>NOT REVIEWED</b></span><span><i />真实交易路径<b>DISABLED</b></span></div></Panel>
      </section>
      <Panel title="最近研究运行" english="Recent Experiments" action={<button className="button" onClick={() => dispatch({ type: "navigate", routeId: "backtest" })}>查看全部</button>}>
        {latestJobs.length === 0 ? <EmptyState title="尚无回测运行" detail="完成数据和策略绑定后，从当前研究任务直接创建第一次回测。" /> : <div className="experiment-ledger">{latestJobs.map((item) => <button key={item.runId} onClick={() => dispatch({ type: "navigate", routeId: "backtest" })}><span><b>{item.displayName ?? item.runId}</b><small>{item.strategyId ?? "历史策略"} · {item.strategyVersion ?? "未记录版本"}</small></span><em data-status={item.status}>{item.status}</em><strong>{item.progressPermille / 10}%</strong></button>)}</div>}
      </Panel>
    </div>;
  }
  return <>
    <section className="command-hero">
      <div><span className="eyebrow">RESEARCH & SIMULATION COMMAND CENTER</span><h1>从行情观察，到策略验证，再到逐事件复盘</h1><p>这一版保留旧平台最有价值的首页说明、纸面订单票、实验台账、策略日志、模拟竞技场和进程看护，同时使用更清楚的决策链：市场状态 → 模型概率 → 可执行优势 → 模拟成交 → 最终盈亏。</p><div className="toolbar"><button className="button button--primary" onClick={() => dispatch({ type: "navigate", routeId: "live" })}>进入实时驾驶舱</button><button className="button" onClick={() => dispatch({ type: "navigate", routeId: "strategy" })}>打开策略工作室</button><button className="button" onClick={() => dispatch({ type: "navigate", routeId: "live" })}>打开纸面订单票</button></div></div>
      <div className="hero-kpis"><article><span>当前候选策略</span><strong>K-Edge v0.4</strong><small>扣费后可执行优势 + 深度门槛</small></article><article><span>最新回测净盈亏</span><strong className="positive">+214.80 USDC</strong><small>BT-20260718-0042</small></article><article><span>模拟滚动 Brier @ T−60s</span><strong>0.0941</strong><small>最近 50 个已结算市场</small></article><article><span>系统可信状态</span><strong className="amber">可用但未完全验证</strong><small>盘口连续性 UNVERIFIED</small></article></div>
    </section>
    <div className="overview-command-grid">
      <Panel title="推荐工作流" english="Recommended Workflow"><ol className="workflow-list"><li><b>1</b><span><strong>实时观察</strong><small>确认数据健康、盘口完整、当前概率和可执行优势。</small></span></li><li><b>2</b><span><strong>检查决策</strong><small>查看为什么买入、跳过或持有，以及手续费门槛。</small></span></li><li><b>3</b><span><strong>设计与回测</strong><small>修改策略和参数，保存版本并检查费用、回撤和概率校准。</small></span></li><li><b>4</b><span><strong>回放与对比</strong><small>逐事件复盘，并在策略竞技场比较多个版本。</small></span></li></ol></Panel>
      <Panel title="最近实验与记录" english="Recent Experiments & Logs"><div className="quick-list"><button>BT-0042 · K-Edge v0.4 回测 <em>完成</em></button><button>sweep-20260712-02 · edge-max <em>293 组</em></button><button>参数变更：max_entry_price 400→560 <em>已记录</em></button><button>异常：BOOK_GAP 盘口缺口 <em className="amber">已标记</em></button></div></Panel>
      <Panel title="快捷说明" english="Quick Documentation"><div className="quick-list"><button>运行模式：LIVE DATA / PAPER / REPLAY <em>查看</em></button><button>策略字段与输出契约 <em>查看</em></button><button>手续费与可执行优势公式 <em>查看</em></button><button>版本变更记录 Changelog <em>查看</em></button></div></Panel>
    </div>
    <Panel title="本次会话状态" english="Session Status" action={<Badge tone="warn">SIMULATION ONLY · 仅模拟</Badge>}><div className="session-status"><article><span>Polymarket WebSocket</span><strong className="positive">健康</strong></article><article><span>Binance WebSocket</span><strong className="positive">健康</strong></article><article><span>事件记录器 Recorder</span><strong className="positive">运行中</strong></article><article><span>真实交易 Live Trading</span><strong className="negative">禁用</strong></article></div></Panel>
  </>;
}
