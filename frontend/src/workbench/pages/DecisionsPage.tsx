import { useEffect, useState } from "react";

import { useWorkbenchCommands } from "../app/WorkbenchCommandContext.js";
import { Badge, EmptyState, PageHeader, Panel } from "../components/ui.js";
import type { BacktestJobV1, PublicBacktestEventV1, QueryPageV1 } from "../services/workbench-commands.js";

const PAGE_SIZE = 100;
type Ledger = Readonly<{ decisions: QueryPageV1<PublicBacktestEventV1>; orders: QueryPageV1<PublicBacktestEventV1>; fills: QueryPageV1<PublicBacktestEventV1>; settlements: QueryPageV1<PublicBacktestEventV1> }>;

export function DecisionsPage() {
  const commands = useWorkbenchCommands();
  const [runs, setRuns] = useState<readonly BacktestJobV1[]>([]);
  const [runId, setRunId] = useState("");
  const [page, setPage] = useState(1);
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
      setRuns(complete); setRunId(complete[0]?.runId ?? "");
      setStatus(complete.length === 0 ? "没有已完成且可查询的后端回测。" : `已找到 ${complete.length} 个完成运行。`);
    }).catch((error: unknown) => { if (active) setStatus(message(error, "完成运行查询失败；未显示任何预览记录。")); });
    return () => { active = false; };
  }, [commands]);

  useEffect(() => {
    if (commands === null || runId === "") { setLedger(null); setSelected(null); return; }
    let active = true; setBusy(true); setLedger(null); setSelected(null);
    const request = { page, pageSize: PAGE_SIZE } as const;
    Promise.all([commands.getBacktestDecisions(runId, request), commands.getBacktestOrders(runId, request), commands.getBacktestFills(runId, request), commands.getBacktestSettlements(runId, request)])
      .then(([decisions, orders, fills, settlements]) => { if (active) { const next = { decisions, orders, fills, settlements }; setLedger(next); setSelected(decisions.items[0] ?? orders.items[0] ?? fills.items[0] ?? settlements.items[0] ?? null); setStatus(`已加载运行 ${runId} 第 ${page} 页后端账本。`); } })
      .catch((error: unknown) => { if (active) setStatus(message(error, "账本查询失败；未显示任何预览记录。")); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [commands, runId, page]);

  const events = ledger === null ? [] : [...ledger.decisions.items, ...ledger.orders.items, ...ledger.fills.items, ...ledger.settlements.items].sort((a, b) => a.eventTimeUtc.localeCompare(b.eventTimeUtc) || a.eventId.localeCompare(b.eventId));
  const totalPages = ledger === null ? 0 : Math.max(ledger.decisions.totalPages, ledger.orders.totalPages, ledger.fills.totalPages, ledger.settlements.totalPages);
  return <><PageHeader title="决策记录（Decision Log）" subtitle="运行选择、分页决策、订单、成交与结算全部来自后端；查询失败时不会回退到预览数据。" />
    <Panel title="账本查询" english="Backend Ledger Query"><div className="toolbar"><label>已完成运行 <select aria-label="决策运行" value={runId} disabled={busy || commands === null} onChange={(event) => { setPage(1); setRunId(event.target.value); }}><option value="">请选择</option>{runs.map((run) => <option key={run.runId} value={run.runId}>{run.runId}</option>)}</select></label><button className="button" disabled={busy || page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button><span>第 {page} / {totalPages || 1} 页</span><button className="button" disabled={busy || totalPages === 0 || page >= totalPages} onClick={() => setPage((value) => value + 1)}>下一页</button></div><p role="status">{status}</p></Panel>
    {runId === "" ? <Panel title="决策账本" english="Decision Ledger"><EmptyState title="没有可查询的完成运行" detail="先通过后端完成一次回测；这里不会使用演示决策代替。" /></Panel> : ledger === null ? <Panel title="决策账本" english="Decision Ledger"><EmptyState title={busy ? "正在加载后端账本" : "后端账本不可用"} detail={status} /></Panel> : events.length === 0 ? <Panel title="决策账本" english="Decision Ledger"><EmptyState title="本页没有账本事件" detail="后端在本页未返回决策、订单、成交或结算。" /></Panel> : <div className="decisions-grid"><Panel title="后端事件账本" english="Backend Event Ledger"><table className="data-table"><thead><tr><th>时间</th><th>类型</th><th>事件 ID</th><th>概要</th></tr></thead><tbody>{events.map((event) => <tr key={`${event.kind}:${event.eventId}`} onClick={() => setSelected(event)}><td>{event.eventTimeUtc}</td><td><Badge tone="info">{event.kind}</Badge></td><td>{event.eventId}</td><td>{summarize(event.data)}</td></tr>)}</tbody></table></Panel><Panel title="事件检查器" english="Event Inspector">{selected === null ? <EmptyState title="未选择事件" detail="从账本选择一个后端事件。" /> : <div className="inspector"><Badge tone="info">{selected.kind}</Badge><h3>{selected.eventId}</h3><dl><dt>事件时间</dt><dd>{selected.eventTimeUtc}</dd>{Object.entries(selected.data).map(([key, value]) => <span key={key}><dt>{key}</dt><dd>{value === null ? "—" : String(value)}</dd></span>)}</dl></div>}</Panel></div>}
  </>;
}

function summarize(data: PublicBacktestEventV1["data"]): string { const values = Object.entries(data).slice(0, 3).map(([key, value]) => `${key}=${value === null ? "—" : String(value)}`); return values.join(" · ") || "—"; }
function message(error: unknown, fallback: string): string { return error instanceof Error && error.message.trim() !== "" ? error.message : fallback; }
