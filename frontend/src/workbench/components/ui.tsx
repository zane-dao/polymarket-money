import { useState, type PropsWithChildren, type ReactNode } from "react";

export function Panel({ title, english, action, className = "", children }: PropsWithChildren<{ title: string; english?: string; action?: ReactNode; className?: string }>) {
  return <section className={`panel ${className}`}><header className="panel__head"><div><strong>{title}</strong>{english && <span>{english}</span>}</div>{action}</header><div className="panel__body">{children}</div></section>;
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return <header className="page-header"><div><h1>{title}</h1><p>{subtitle}</p></div>{action}</header>;
}

export function Badge({ tone = "neutral", children }: PropsWithChildren<{ tone?: "good" | "warn" | "bad" | "info" | "neutral" }>) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function MetricCard({ label, english, value, tone, footer }: { label: string; english: string; value: string; tone?: string; footer: ReactNode }) {
  return <article className="metric"><div className="metric__label">{label}</div><div className="metric__english">{english}</div><div className={`metric__value ${tone ?? ""}`}>{value}</div><div className="metric__footer">{footer}</div></article>;
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><div className="empty-state__icon">◇</div><strong>{title}</strong><p>{detail}</p></div>;
}

export function StatusDot({ tone = "good" }: { tone?: "good" | "warn" | "bad" }) {
  return <i className={`status-dot status-dot--${tone}`} aria-hidden="true" />;
}

export function formatUtc(value: string | null | undefined): string {
  if (value == null) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}

/** Formats an event instant as UTC so event/receive/coverage times are not ambiguous. */
export function formatEventUtc(value: string | null | undefined): string {
  if (value == null) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium", timeZone: "UTC" }).format(date)} UTC`;
}

const EVENT_FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  action: "动作", approvedOrderQuantity: "批准订单数量", bookParticipation: "盘口参与比例",
  currentPositionQuantity: "已有仓位", decisionAsk: "决策卖一价",
  decisionVisibleAskQuantity: "决策可见卖一数量", direction: "方向", edge: "原始优势",
  estimatedFee: "预估费用", executablePrice: "执行价格", fee: "费用", feeRate: "费率",
  intendedQuantity: "策略意向数量", intendedStake: "策略意向投入", marketId: "市场",
  netEdge: "扣费后优势", openOrderQuantity: "在途订单数量", outcome: "结果",
  pnl: "净盈亏", price: "价格", probability: "模型概率", quantity: "数量",
  reason: "原因", reasonCode: "原因代码", requiredEdge: "所需优势",
  riskReasonCodes: "风险原因", riskStatus: "风险审查结果", status: "状态",
  targetPositionQuantity: "目标总仓位", visibleAskQuantity: "执行可见卖一数量",
});

/** Human-facing labels for public event DTO fields; unknown future fields remain readable. */
export function eventFieldLabel(key: string): string { return EVENT_FIELD_LABELS[key] ?? key; }

export function eventPrimaryMeaning(data: Readonly<Record<string, string | number | boolean | null>>): string {
  return String(data.reason ?? data.reasonCode ?? data.status ?? data.action ?? data.outcome ?? "冻结事件");
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

export function humanizeIdentifier(value: string): string {
  return value.replace(/[_-]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

export function CopyButton({ value, label = "复制" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1200); }
  return <button type="button" className="button button--compact" title={value} aria-label={`${label} ${value}`} onClick={() => void copy()}>{copied ? "已复制" : label}</button>;
}
