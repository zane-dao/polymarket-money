import type { DecisionRow } from "../domain/read-model.js";
import { Badge } from "./ui.js";

function tone(value: DecisionRow["eligibility"]): "good" | "warn" | "bad" {
  return value === "ELIGIBLE" || value === "SETTLED" ? "good" : value === "DATA_STALE" ? "bad" : "warn";
}

export function DecisionTable({ rows, selectedId, onSelect }: { rows: readonly DecisionRow[]; selectedId?: string | null; onSelect?: (id: string) => void }) {
  return <div className="table-scroll"><table className="data-table"><thead><tr>{onSelect === undefined ? null : <th>选择</th>}<th>时间</th><th>事件</th><th>市场</th><th>方向</th><th>p_cal</th><th>执行价</th><th>净优势</th><th>可执行性</th><th>PnL</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className={selectedId === row.id ? "selected" : ""}>{onSelect === undefined ? null : <td><button type="button" className="button table-row-action" aria-label={`查看 ${row.time} 的${row.event}事件`} aria-pressed={selectedId === row.id} onClick={() => onSelect(row.id)}>查看</button></td>}<td>{row.time}</td><td><span className={`event event--${row.event.toLowerCase()}`}>{row.event}</span></td><td>{row.market}</td><td className={row.direction === "YES" ? "positive" : row.direction === "NO" ? "negative" : ""}>{row.direction}</td><td>{row.probability}</td><td>{row.price}</td><td className={row.edge.startsWith("+") ? "positive" : ""}>{row.edge}</td><td><Badge tone={tone(row.eligibility)}>{row.eligibility}</Badge></td><td className={row.pnl.startsWith("+") ? "positive" : row.pnl.startsWith("−") ? "negative" : ""}>{row.pnl}</td></tr>)}</tbody></table></div>;
}
