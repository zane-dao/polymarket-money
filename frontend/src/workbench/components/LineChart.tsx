type Series = Readonly<{ label: string; values: readonly number[]; color: string }>;

function points(values: readonly number[], min: number, max: number): string {
  const spread = max - min || 1;
  return values.map((value, index) => `${values.length === 1 ? 0 : (index / (values.length - 1)) * 100},${92 - ((value - min) / spread) * 78}`).join(" ");
}

export function LineChart({ series, height = 260 }: { series: readonly Series[]; height?: number }) {
  const allValues = series.flatMap((item) => item.values).filter(Number.isFinite);
  const min = allValues.length === 0 ? 0 : Math.min(...allValues);
  const max = allValues.length === 0 ? 1 : Math.max(...allValues);
  return <div className="chart" style={{ height }}>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={series.map((item) => item.label).join("、")}>
      {[18, 36, 54, 72, 90].map((y) => <line key={y} x1="0" x2="100" y1={y} y2={y} className="chart__grid" />)}
      {[20, 40, 60, 80].map((x) => <line key={x} x1={x} x2={x} y1="10" y2="92" className="chart__grid" />)}
      {series.map((item) => <polyline key={item.label} points={points(item.values, min, max)} fill="none" stroke={item.color} strokeWidth="1.3" vectorEffect="non-scaling-stroke" />)}
    </svg>
    <div className="chart__legend">{series.map((item) => <span key={item.label}><i style={{ background: item.color }} />{item.label}</span>)}</div>
  </div>;
}
