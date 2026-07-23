import { useEffect, useState } from "react";

import { useWorkbenchCommands } from "../app/WorkbenchCommandContext.js";
import { useWorkbench } from "../app/WorkbenchContext.js";
import { EventComposition, ProbabilityEventTimeline } from "../components/QuantAnalysis.js";
import { Badge, EmptyState, eventFieldLabel, eventPrimaryMeaning, formatEventUtc, PageHeader, PaginationControls, Panel } from "../components/ui.js";
import type { BacktestJobV1, PublicBacktestEventV1, QueryPageV1 } from "../services/workbench-commands.js";

type Ledger = Readonly<{
  page: QueryPageV1<PublicBacktestEventV1>;
  totals: Readonly<{ decisions: number; orders: number; fills: number; settlements: number }>;
}>;

export function DecisionsPage() {
  const commands = useWorkbenchCommands();
  const { state, dispatch } = useWorkbench();
  const [runs, setRuns] = useState<readonly BacktestJobV1[]>([]);
  const [runId, setRunId] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<10 | 20 | 50>(20);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [selected, setSelected] = useState<PublicBacktestEventV1 | null>(null);
  const [status, setStatus] = useState(commands === null ? "本地命令桥接不可用；决策账本保持关闭。" : "正在查询已完成的后端回测…");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (commands === null) return;
    let active = true;
    commands.listBacktestJobs().then((items) => {
      if (!active) return;
      const complete = items.filter((item) => item.status === "succeeded");
      const requestedRun = state.researchSession.runId;
      setRuns(complete); setRunId(complete.some((item) => item.runId === requestedRun) ? requestedRun! : complete[0]?.runId ?? "");
      setStatus(complete.length === 0 ? "没有已完成且可查询的后端回测。" : requestedRun ? "已从研究会话恢复运行与账本范围。" : `已找到 ${complete.length} 个完成运行。`);
    }).catch((error: unknown) => { if (active) setStatus(message(error, "完成运行查询失败；未显示任何预览记录。")); });
    return () => { active = false; };
  }, [commands]);

  useEffect(() => {
    if (commands === null || runId === "") { setLedger(null); setSelected(null); return; }
    let active = true; setBusy(true); setLedger(null); setSelected(null);
    const request = { page, pageSize } as const;
    const totalRequest = { page: 1, pageSize: 10 } as const;
    Promise.all([
      commands.getBacktestReplay(runId, request),
      commands.getBacktestDecisions(runId, totalRequest),
      commands.getBacktestOrders(runId, totalRequest),
      commands.getBacktestFills(runId, totalRequest),
      commands.getBacktestSettlements(runId, totalRequest),
    ])
      .then(([eventPage, decisions, orders, fills, settlements]) => { if (active) { const next = { page: eventPage, totals: { decisions: decisions.totalItems, orders: orders.totalItems, fills: fills.totalItems, settlements: settlements.totalItems } }; setLedger(next); setSelected(eventPage.items[0] ?? null); setStatus(`已加载所选运行第 ${page} 页后端事件账本。`); } })
      .catch((error: unknown) => { if (active) setStatus(message(error, "账本查询失败；未显示任何预览记录。")); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [commands, runId, page, pageSize]);

  const events = ledger === null ? [] : [...ledger.page.items].sort((a, b) => a.eventTimeUtc.localeCompare(b.eventTimeUtc) || a.eventId.localeCompare(b.eventId));
  const totalPages = ledger?.page.totalPages ?? 0;
  const selectedRun = runs.find((run) => run.runId === runId);
  return <><PageHeader title="决策账本（Decision Ledger · 决策记录）" subtitle="回答“系统留下了什么证据”：分页查询后端决策、模拟订单、成交与结算，供筛选、核对和审计。" />
    <section className="page-purpose page-purpose--ledger" aria-label="决策账本用途">
      <span>LEDGER · EVIDENCE</span><strong>同一事件证据的查询与审计视图</strong><p>与运行回放读取同一冻结事件页；这里按页核对数量、字段和技术标识，不提供自动播放。</p>
    </section>
    <Panel title="账本查询" english="Backend Ledger Query"><div className="toolbar"><label>已完成运行 <select aria-label="决策运行" value={runId} disabled={busy || commands === null} onChange={(event) => { setPage(1); setRunId(event.target.value); dispatch({ type: "update-research-session", patch: { runId: event.target.value || null, stage: "analysis" } }); }}><option value="">请选择</option>{runs.map((run) => <option key={run.runId} value={run.runId}>{run.displayName ?? "历史运行（未记录名称）"}</option>)}</select></label></div><PaginationControls label="决策账本" page={page} totalPages={totalPages} pageSize={pageSize} totalItems={ledger?.page.totalItems ?? 0} busy={busy} onPageChange={setPage} onPageSizeChange={(value) => { setPage(1); setPageSize(value); }} />{selectedRun === undefined ? null : <div className="panel-note">{selectedRun.displayName ?? "历史运行（未记录名称）"}<details className="technical-details"><summary>查看运行 ID</summary>{selectedRun.runId}</details></div>}<p role="status">{status}</p></Panel>
    {runId === "" ? <Panel title="决策账本" english="Decision Ledger"><EmptyState title="没有可查询的完成运行" detail="先通过后端完成一次回测；这里不会使用演示决策代替。" /></Panel> : ledger === null ? <Panel title="决策账本" english="Decision Ledger"><EmptyState title={busy ? "正在加载后端账本" : "后端账本不可用"} detail={status} /></Panel> : events.length === 0 ? <Panel title="决策账本" english="Decision Ledger"><EmptyState title="本页没有账本事件" detail="后端在本页未返回决策、订单、成交或结算。" /></Panel> : <>
      <div className="ledger-analysis-grid"><Panel title="决策概率审计" english="Recorded Probability · UTC"><ProbabilityEventTimeline events={events} /></Panel><Panel title="本页事件构成" english="Evidence Composition"><EventComposition events={events} /></Panel></div>
      <div className="ledger-kpis" aria-label="账本类型汇总"><span>决策<strong>{ledger.totals.decisions}</strong></span><span>模拟订单<strong>{ledger.totals.orders}</strong></span><span>模拟成交<strong>{ledger.totals.fills}</strong></span><span>结算<strong>{ledger.totals.settlements}</strong></span></div>
      <div className="decisions-grid"><Panel title="后端事件账本" english="Backend Event Ledger"><div className="table-scroll"><table className="data-table"><thead><tr><th>时间</th><th>类型</th><th>原因 / 状态</th><th>详情</th></tr></thead><tbody>{events.map((event) => <tr key={`${event.kind}:${event.eventId}`} onClick={() => setSelected(event)}><td>{formatTime(event.eventTimeUtc)}</td><td><Badge tone="info">{event.kind}</Badge></td><td>{decisionReason(event.data)}</td><td><details className="technical-details"><summary>查看技术事件</summary>{event.eventId}</details></td></tr>)}</tbody></table></div></Panel><Panel title="事件检查器" english="Event Inspector">{selected === null ? <EmptyState title="未选择事件" detail="从账本选择一个后端事件。" /> : <div className="inspector"><Badge tone="info">{selected.kind}</Badge><h3>{decisionReason(selected.data)}</h3><dl><dt>事件时间</dt><dd>{formatTime(selected.eventTimeUtc)}</dd>{Object.entries(selected.data).map(([key, value]) => <span key={key}><dt>{fieldLabel(key)}</dt><dd>{value === null ? "未记录" : String(value)}</dd></span>)}</dl><details className="technical-details"><summary>查看技术事件 ID</summary>{selected.eventId}</details></div>}</Panel></div></>}
  </>;
}

function decisionReason(data: PublicBacktestEventV1["data"]): string { return eventPrimaryMeaning(data); }
function formatTime(value:string):string{return formatEventUtc(value);}
function fieldLabel(key:string):string{return eventFieldLabel(key);}
function message(error: unknown, fallback: string): string { return error instanceof Error && error.message.trim() !== "" ? error.message : fallback; }
