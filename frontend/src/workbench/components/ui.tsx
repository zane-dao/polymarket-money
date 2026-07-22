import type { PropsWithChildren, ReactNode } from "react";

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
