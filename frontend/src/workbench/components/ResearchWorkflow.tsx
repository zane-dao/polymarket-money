import { useWorkbench } from "../app/WorkbenchContext.js";
import type { WorkflowStage } from "../domain/research-session.js";
import type { WorkbenchRouteId } from "../domain/workbench.js";
import { Badge } from "./ui.js";

const STAGES: readonly Readonly<{ id: WorkflowStage; label: string; routeId: WorkbenchRouteId; anchorId?: string }>[] = [
  { id: "scope", label: "数据与策略", routeId: "datasets" },
  { id: "assumptions", label: "检查执行假设", routeId: "backtest", anchorId: "execution-assumptions" },
  { id: "run", label: "运行与任务", routeId: "backtest", anchorId: "backtest-jobs" },
  { id: "analysis", label: "分析与证据", routeId: "compare" },
  { id: "paper-review", label: "Paper 评审", routeId: "live" },
];

export function ResearchContextHeader() {
  const { state } = useWorkbench();
  const session = state.researchSession;
  return <section className="research-context" aria-label="当前研究会话">
    <div className="research-context__lead">
      <span>RESEARCH SESSION</span>
      <strong>{session.runId ? "证据已绑定" : "配置进行中"}</strong>
      <small>{session.sessionId}</small>
    </div>
    <dl>
      <div><dt>数据集</dt><dd>{session.datasetId ?? "待选择"}</dd></div>
      <div><dt>策略版本</dt><dd>{session.strategyId ? `${session.strategyId} · ${session.strategyVersion ?? "待选择版本"}` : "待选择"}</dd></div>
      <div><dt>研究口径</dt><dd>{session.evaluationSplit === "FINAL_TEST" ? "最终测试（冻结）" : "验证集"} · {session.feeModel} · {session.latencyMs} ms</dd></div>
      <div><dt>当前运行</dt><dd>{session.runId ?? "尚未运行"}</dd></div>
    </dl>
    <details className="research-context__inspector">
      <summary>上下文证据</summary>
      <div><span>数据 hash</span><code>{session.datasetVersionHash ?? "not available"}</code><span>初始资金 / 最大仓位</span><code>{session.initialCash} / {session.maxPosition}</code><span>分析区间</span><code>{session.analysisFromUtc ?? "full run"} → {session.analysisToUtc ?? "full run"}</code></div>
    </details>
  </section>;
}

export function WorkflowRail() {
  const { state, dispatch } = useWorkbench();
  const activeIndex = STAGES.findIndex((stage) => stage.id === state.researchSession.stage);
  function goToStage(stage: (typeof STAGES)[number]) {
    dispatch({ type: "navigate", routeId: stage.routeId });
    if (stage.anchorId !== undefined) window.requestAnimationFrame(() => document.getElementById(stage.anchorId!)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  return <nav className="workflow-rail" aria-label="研究工作流">
    {STAGES.map((stage, index) => <button
      key={stage.id}
      type="button"
      className={index === activeIndex ? "active" : index < activeIndex ? "complete" : ""}
      aria-current={index === activeIndex ? "step" : undefined}
      onClick={() => goToStage(stage)}
    ><i>{index < activeIndex ? "✓" : index + 1}</i><span>{stage.label}</span>{stage.id === "paper-review" ? <Badge tone="warn">GATED</Badge> : null}</button>)}
  </nav>;
}
