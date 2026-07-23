import { useState, type KeyboardEvent, type PointerEvent } from "react";

export type ChartPoint = Readonly<{ x: number | string; value: number }>;
type Series = Readonly<{ label: string; points?: readonly ChartPoint[]; values?: readonly number[]; color: string; lineStyle?: "solid" | "dashed" | "dotted" }>;
export type ChartAnnotation = Readonly<{ x: number | string; label: string; tone?: "info" | "warn" | "bad" }>;

function numericX(value: ChartPoint["x"]): number {
  return typeof value === "number" ? value : Date.parse(value);
}

function points(values: readonly ChartPoint[], min: number, max: number, xMin: number, xMax: number): string {
  const spread = max - min || 1;
  const xSpread = xMax - xMin || 1;
  return values.map((point) => `${8 + ((numericX(point.x) - xMin) / xSpread) * 86},${88 - ((point.value - min) / spread) * 72}`).join(" ");
}

function seriesPoints(item: Series): readonly ChartPoint[] {
  const values = item.points ?? (item.values ?? []).map((value, index) => ({ x: index, value }));
  return [...values].sort((left, right) => numericX(left.x) - numericX(right.x));
}

function formatNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return absolute >= 100 ? value.toFixed(0) : absolute >= 10 ? value.toFixed(1) : value.toFixed(2);
}

export function LineChart({ series, height = 300, unit = "", xLabel = "", annotations = [] }: { series: readonly Series[]; height?: number; unit?: string; xLabel?: string; annotations?: readonly ChartAnnotation[] }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const allValues = series.flatMap((item) => seriesPoints(item).map((point) => point.value)).filter(Number.isFinite);
  const allPoints = series.flatMap(seriesPoints);
  const allX = allPoints.map((point) => numericX(point.x)).filter(Number.isFinite);
  const min = Math.min(...allValues, 0);
  const max = Math.max(...allValues, 0);
  const xMin = Math.min(...allX);
  const xMax = Math.max(...allX);
  const usesTime = allPoints.some((point) => typeof point.x === "string");
  const sharedX = [...new Set(allX)].sort((left, right) => left - right);
  const selectedX = activeIndex === null ? null : sharedX[activeIndex] ?? null;
  function move(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    setActiveIndex((current) => Math.max(0, Math.min(sharedX.length - 1, (current ?? (direction < 0 ? sharedX.length : -1)) + direction)));
  }
  function hover(event: PointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const target = xMin + Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * (xMax - xMin);
    let nearest = 0;
    for (let index = 1; index < sharedX.length; index += 1) {
      if (Math.abs(sharedX[index]! - target) < Math.abs(sharedX[nearest]! - target)) nearest = index;
    }
    setActiveIndex(nearest);
  }
  const labels = [max, min + (max - min) / 2, min];
  const xStartLabel = usesTime ? new Date(xMin).toLocaleDateString("zh-CN") : formatNumber(xMin);
  const xEndLabel = usesTime ? new Date(xMax).toLocaleDateString("zh-CN") : formatNumber(xMax);
  return <div className="chart analytic-chart" style={{ height }} tabIndex={0} onKeyDown={move} aria-label={`图表：${series.map((item) => item.label).join("、")}。使用左右方向键读取数据。`}>
    <div className="chart__y-readout" aria-hidden="true">{labels.map((value, index) => <span key={index}>{formatNumber(value)}{unit}</span>)}</div>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" onPointerMove={hover} onPointerLeave={() => setActiveIndex(null)}>
      {[16, 52, 88].map((y) => <line key={y} x1="8" x2="94" y1={y} y2={y} className="chart__grid" />)}
      {[8, 29.5, 51, 72.5, 94].map((x) => <line key={x} x1={x} x2={x} y1="16" y2="88" className="chart__grid chart__grid--vertical" />)}
      {min <= 0 && max >= 0 ? <line x1="8" x2="94" y1={88 - ((0 - min) / (max - min || 1)) * 72} y2={88 - ((0 - min) / (max - min || 1)) * 72} className="chart__zero" /> : null}
      {series.map((item) => <polyline key={item.label} points={points(seriesPoints(item), min, max, xMin, xMax)} fill="none" stroke={item.color} strokeWidth="1.8" strokeDasharray={item.lineStyle === "dashed" ? "6 4" : item.lineStyle === "dotted" ? "2 4" : undefined} vectorEffect="non-scaling-stroke" />)}
      {annotations.map((item) => {
        const x = 8 + ((numericX(item.x) - xMin) / (xMax - xMin || 1)) * 86;
        return <g key={`${String(item.x)}-${item.label}`} className={`chart__annotation chart__annotation--${item.tone ?? "info"}`}><line x1={x} x2={x} y1="16" y2="88" /><circle cx={x} cy="20" r="1.2"><title>{item.label}</title></circle></g>;
      })}
      {selectedX === null ? null : <line x1={8 + ((selectedX - xMin) / (xMax - xMin || 1)) * 86} x2={8 + ((selectedX - xMin) / (xMax - xMin || 1)) * 86} y1="16" y2="88" className="chart__crosshair" />}
    </svg>
    <div className="chart__x-readout" aria-hidden="true"><span>{xStartLabel}</span><span>{xEndLabel}</span></div>
    {selectedX === null ? null : <div className="chart__tooltip" role="status"><b>{usesTime ? new Date(selectedX).toLocaleString("zh-CN", { hour12: false }) : formatNumber(selectedX)}</b>{series.map((item) => {
      const point = seriesPoints(item).find((candidate) => numericX(candidate.x) === selectedX);
      return <span key={item.label}><i style={{ background: item.color }} />{item.label}<strong>{point === undefined ? "—" : `${formatNumber(point.value)}${unit}`}</strong></span>;
    })}</div>}
    <div className="chart__footer"><div className="chart__legend">{series.map((item) => <span key={item.label}><i style={{ background: item.color }} />{item.label}</span>)}</div><span>{xLabel || (usesTime ? "UTC 时间" : "样本序号")}</span></div>
  </div>;
}

export type ScatterDatum = Readonly<{ label: string; x: number; y: number; color: string; detail?: string }>;

export function ScatterChart({ points, xTitle, yTitle }: { points: readonly ScatterDatum[]; xTitle: string; yTitle: string }) {
  if (points.length === 0) return <div className="chart-empty" role="status">没有可比较的数据点</div>;
  const xMin = Math.min(...points.map((point) => point.x), 0);
  const xMax = Math.max(...points.map((point) => point.x), 0);
  const xPad = (xMax - xMin) * .12 || 1;
  const yMin = Math.min(...points.map((point) => point.y), 0);
  const yMax = Math.max(...points.map((point) => point.y), 0);
  const yPad = (yMax - yMin) * .12 || 1;
  const sx = (value: number) => 72 + (value - xMin + xPad) / (xMax - xMin + xPad * 2) * 880;
  const sy = (value: number) => 245 - (value - yMin + yPad) / (yMax - yMin + yPad * 2) * 205;
  return <div className="chart analytic-chart scatter-chart" tabIndex={0} aria-label={`${yTitle}与${xTitle}散点图`}>
    <svg viewBox="0 0 1000 280" preserveAspectRatio="xMidYMid meet" role="img">
      {[40, 91, 142, 193, 244].map((y) => <line key={y} x1="72" x2="952" y1={y} y2={y} className="chart__grid" />)}
      {points.map((point) => <circle key={point.label} cx={sx(point.x)} cy={sy(point.y)} r="7" fill={point.color}><title>{point.label}：{xTitle} {formatNumber(point.x)}，{yTitle} {formatNumber(point.y)}{point.detail ? `，${point.detail}` : ""}</title></circle>)}
      <text x="72" y="272" className="scatter-chart__axis">{xTitle} →</text><text x="18" y="22" className="scatter-chart__axis">{yTitle} ↑</text>
    </svg>
    <div className="scatter-chart__legend">{points.map((point) => <span key={point.label}><i style={{ background: point.color }} /><b>{point.label}</b><small>{xTitle} {formatNumber(point.x)} · {yTitle} {formatNumber(point.y)}</small></span>)}</div>
  </div>;
}

export type MetricBarGroup = Readonly<{ label: string; direction?: "higher" | "lower"; values: readonly Readonly<{ label: string; value: number; color: string }>[] }>;

export function MetricBars({ groups }: { groups: readonly MetricBarGroup[] }) {
  return <div className="metric-bars" role="img" aria-label="策略指标对比">{groups.map((group) => {
    const max = Math.max(...group.values.map((item) => Math.abs(item.value)), 1);
    return <section key={group.label}><header><h4>{group.label}</h4><small>{group.direction === "lower" ? "越低越好" : "越高越好"}</small></header>{group.values.map((item) => <div key={item.label}><span>{item.label}</span><i className="metric-bars__track"><b className={Math.sign(item.value) === -1 ? "is-negative" : "is-positive"} style={{ width: `${Math.abs(item.value) / max * 50}%`, left: Math.sign(item.value) === -1 ? `${50 - Math.abs(item.value) / max * 50}%` : "50%", background: group.label === "净盈亏" ? undefined : item.color }} /></i><strong className={group.label === "净盈亏" ? Math.sign(item.value) === -1 ? "negative" : "positive" : ""}>{Math.sign(item.value) === 1 ? "+" : ""}{formatNumber(item.value)}</strong></div>)}</section>;
  })}</div>;
}
