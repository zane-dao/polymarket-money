import type { BacktestResultV1 } from "../services/workbench-commands.js";
import {
  calibrationBuckets,
  deriveBacktestAnalytics,
  probabilityObservations,
  probabilityValue,
} from "../domain/backtest-analytics.js";
import { LineChart } from "./LineChart.js";
import { EmptyState, Panel } from "./ui.js";

function number(value: number, digits = 4): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

type ProbabilityBucket = ReturnType<typeof calibrationBuckets>[number];

function CalibrationChart({
  buckets,
  label,
  color = "#33c7ea",
  height = 300,
}: {
  buckets: readonly ProbabilityBucket[];
  label: string;
  color?: string;
  height?: number;
}) {
  const width = 520;
  const left = 52;
  const right = 494;
  const top = 18;
  const bottom = 270;
  const maxCount = Math.max(...buckets.map((bucket) => bucket.count), 1);
  const x = (value: number) => left + value * (right - left);
  const y = (value: number) => bottom - value * (bottom - top);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div className="chart" aria-label={`${label}概率校准图`}>
      <svg
        viewBox={`0 0 ${width} 300`}
        role="img"
        style={{ width: "100%", height, display: "block" }}
      >
        <g stroke="#21394d" strokeWidth="1">
          {ticks.map((tick) => (
            <line
              key={`y-${tick}`}
              x1={left}
              y1={y(tick)}
              x2={right}
              y2={y(tick)}
            />
          ))}
          {ticks.map((tick) => (
            <line
              key={`x-${tick}`}
              x1={x(tick)}
              y1={top}
              x2={x(tick)}
              y2={bottom}
              opacity=".35"
            />
          ))}
        </g>
        <line
          x1={left}
          y1={bottom}
          x2={right}
          y2={top}
          stroke="#74849b"
          strokeWidth="1.5"
          strokeDasharray="6 6"
        />
        {buckets.length > 1 ? (
          <polyline
            points={buckets
              .map(
                (bucket) =>
                  `${x(bucket.meanProbability)},${y(bucket.observedRate)}`,
              )
              .join(" ")}
            fill="none"
            stroke={color}
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
        ) : null}
        <g fill={color} stroke="#07131e" strokeWidth="2">
          {buckets.map((bucket) => (
            <circle
              key={bucket.lower}
              cx={x(bucket.meanProbability)}
              cy={y(bucket.observedRate)}
              r={5 + Math.sqrt(bucket.count / maxCount) * 8}
            >
              <title>{`${Math.round(bucket.lower * 100)}–${Math.round(bucket.upper * 100)}%：预测 ${number(bucket.meanProbability, 3)}，实际 ${number(bucket.observedRate, 3)}，${bucket.count} 个样本`}</title>
            </circle>
          ))}
        </g>
        <g fill="#8499aa" fontSize="10" fontFamily="ui-monospace, monospace">
          {ticks.map((tick) => (
            <text
              key={`yl-${tick}`}
              x={left - 9}
              y={y(tick) + 4}
              textAnchor="end"
            >
              {Math.round(tick * 100)}%
            </text>
          ))}
          {ticks.map((tick) => (
            <text key={`xl-${tick}`} x={x(tick)} y="291" textAnchor="middle">
              {Math.round(tick * 100)}%
            </text>
          ))}
        </g>
      </svg>
      <div className="histogram-axis">
        <span>预测概率</span>
        <span>气泡越大，样本越多</span>
        <span>实际发生率</span>
      </div>
    </div>
  );
}

function CalibrationComparisonChart({
  series,
}: {
  series: readonly Readonly<{
    label: string;
    color: string;
    buckets: readonly ProbabilityBucket[];
  }>[];
}) {
  const left = 54;
  const right = 654;
  const top = 20;
  const bottom = 276;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const x = (value: number) => left + value * (right - left);
  const y = (value: number) => bottom - value * (bottom - top);
  const maxCount = Math.max(
    ...series.flatMap((run) => run.buckets.map((bucket) => bucket.count)),
    1,
  );
  return (
    <div className="chart" aria-label="策略概率校准对比">
      <div className="histogram-axis" style={{ justifyContent: "flex-start", gap: 18 }}>
        {series.map((run) => (
          <span key={run.label}>
            <i aria-hidden="true" style={{ display: "inline-block", width: 8, height: 8, marginRight: 5, borderRadius: "50%", background: run.color }} />
            {run.label}
          </span>
        ))}
        <span>虚线：理想校准</span>
      </div>
      <svg viewBox="0 0 680 310" role="img" style={{ width: "100%", height: 310, display: "block" }}>
        <g stroke="#21394d" strokeWidth="1">
          {ticks.map((tick) => <line key={`cy-${tick}`} x1={left} y1={y(tick)} x2={right} y2={y(tick)} />)}
          {ticks.map((tick) => <line key={`cx-${tick}`} x1={x(tick)} y1={top} x2={x(tick)} y2={bottom} opacity=".35" />)}
        </g>
        <line x1={left} y1={bottom} x2={right} y2={top} stroke="#74849b" strokeWidth="1.5" strokeDasharray="6 6" />
        {series.map((run) => (
          <g key={run.label}>
            {run.buckets.length > 1 ? <polyline
              points={run.buckets.map((bucket) => `${x(bucket.meanProbability)},${y(bucket.observedRate)}`).join(" ")}
              fill="none"
              stroke={run.color}
              strokeWidth="2"
              strokeLinejoin="round"
            /> : null}
            {run.buckets.map((bucket) => <circle
              key={bucket.lower}
              cx={x(bucket.meanProbability)}
              cy={y(bucket.observedRate)}
              r={4 + Math.sqrt(bucket.count / maxCount) * 7}
              fill={run.color}
              fillOpacity=".82"
              stroke="#07131e"
              strokeWidth="1.5"
            ><title>{`${run.label} · ${Math.round(bucket.lower * 100)}–${Math.round(bucket.upper * 100)}% · n=${bucket.count} · 预测 ${number(bucket.meanProbability, 3)} · 实际 ${number(bucket.observedRate, 3)}`}</title></circle>)}
          </g>
        ))}
        <g fill="#8499aa" fontSize="10" fontFamily="ui-monospace, monospace">
          {ticks.map((tick) => <text key={`cyl-${tick}`} x={left - 9} y={y(tick) + 4} textAnchor="end">{Math.round(tick * 100)}%</text>)}
          {ticks.map((tick) => <text key={`cxl-${tick}`} x={x(tick)} y="298" textAnchor="middle">{Math.round(tick * 100)}%</text>)}
        </g>
      </svg>
      <div className="histogram-axis"><span>预测概率</span><span>气泡越大，样本越多</span><span>实际发生率</span></div>
    </div>
  );
}

function RollingBrierChart({ values }: { values: readonly number[] }) {
  const width = 270;
  const left = 30;
  const right = 260;
  const top = 12;
  const bottom = 105;
  const lower = Math.min(...values);
  const upper = Math.max(...values);
  const padding = Math.max((upper - lower) * 0.2, 0.005);
  const min = Math.max(0, lower - padding);
  const max = upper + padding;
  const x = (index: number) =>
    left + (index / Math.max(1, values.length - 1)) * (right - left);
  const y = (value: number) =>
    bottom - ((value - min) / Math.max(0.0001, max - min)) * (bottom - top);
  const points = values
    .map((value, index) => `${x(index)},${y(value)}`)
    .join(" ");
  return (
    <div className="chart" aria-label="滚动 Brier 曲线">
      <svg
        viewBox={`0 0 ${width} 120`}
        role="img"
        style={{ width: "100%", height: 120, display: "block" }}
      >
        <g stroke="#21394d" strokeWidth="1">
          {[top, (top + bottom) / 2, bottom].map((position) => (
            <line
              key={position}
              x1={left}
              y1={position}
              x2={right}
              y2={position}
            />
          ))}
        </g>
        <polyline
          points={points}
          fill="none"
          stroke="#33c7ea"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <circle
          cx={x(values.length - 1)}
          cy={y(values[values.length - 1])}
          r="4"
          fill="#33c7ea"
        />
        <g fill="#8499aa" fontSize="9" fontFamily="ui-monospace, monospace">
          <text x="1" y={top + 3}>
            {number(max, 3)}
          </text>
          <text x="1" y={bottom + 3}>
            {number(min, 3)}
          </text>
          <text x={right} y="118" textAnchor="end">
            最新 {number(values[values.length - 1], 3)}
          </text>
        </g>
      </svg>
    </div>
  );
}

export function CalibrationDashboard({
  result,
  strategyName,
}: {
  result: BacktestResultV1;
  strategyName: string;
}) {
  const analytics = deriveBacktestAnalytics(result);
  const observations = analytics.probability.observations;
  if (observations.length === 0)
    return (
      <Panel title="概率质量">
        <EmptyState
          title="逐样本概率证据不可用"
          detail="该旧运行没有同时保存预测概率与最终结局；请重新回测，不能从汇总 Brier 反推校准曲线。"
        />
      </Panel>
    );
  const buckets = analytics.probability.buckets;
  const populated = buckets.filter((bucket) => bucket.count > 0);
  const reliability = analytics.probability.reliability ?? 0;
  const resolution = analytics.probability.resolution ?? 0;
  const uncertainty = analytics.probability.uncertainty ?? 0;
  const rolling = analytics.probability.rollingBrier;
  const minBucket = Math.min(...populated.map((bucket) => bucket.count));
  const maxBucket = Math.max(...populated.map((bucket) => bucket.count));
  return (
    <section className="quant-analysis" aria-label="概率质量分析">
      <div className="quant-analysis__hero">
        <Panel title="概率校准图">
          <CalibrationChart buckets={populated} label={strategyName} />
        </Panel>
        <div className="quant-analysis__side">
          <Panel title="Brier 分解">
            <dl className="quant-breakdown">
              <div>
                <dt>可靠性</dt>
                <dd className="positive">{number(reliability)}</dd>
              </div>
              <div>
                <dt>分辨率</dt>
                <dd className="cyan">{number(resolution)}</dd>
              </div>
              <div>
                <dt>不确定性</dt>
                <dd>{number(uncertainty)}</dd>
              </div>
              <div>
                <dt>合计 Brier</dt>
                <dd>{number(reliability - resolution + uncertainty)}</dd>
              </div>
            </dl>
          </Panel>
          <Panel title="滚动 Brier">
            {rolling.length > 1 ? (
              <RollingBrierChart values={rolling} />
            ) : (
              <EmptyState
                title="滚动序列不足"
                detail="至少需要两个有效概率样本。"
              />
            )}
          </Panel>
        </div>
        <div className="quant-analysis__side">
          <Panel title="预测概率分布">
            <div className="probability-histogram" aria-label="预测概率直方图">
              {buckets.map((bucket) => (
                <i
                  key={bucket.lower}
                  style={{
                    height: `${Math.max(3, (bucket.count / maxBucket) * 100)}%`,
                  }}
                  title={`${Math.round(bucket.lower * 100)}–${Math.round(bucket.upper * 100)}%：${bucket.count} 个样本`}
                />
              ))}
            </div>
            <div className="histogram-axis">
              <span>0%</span>
              <span>50%</span>
              <span>100%</span>
            </div>
          </Panel>
          <Panel title="样本覆盖">
            <div className="coverage-kpis">
              <span>
                总样本<b>{observations.length}</b>
              </span>
              <span>
                最小桶
                <b className={minBucket < 20 ? "negative" : ""}>{minBucket}</b>
              </span>
              <span>
                最大桶<b>{maxBucket}</b>
              </span>
              <span>
                空桶<b>{buckets.length - populated.length}</b>
              </span>
            </div>
            {minBucket < 20 ? (
              <p className="quant-callout">
                最小桶少于 20 个样本，校准差仅作描述。
              </p>
            ) : null}
          </Panel>
        </div>
      </div>
      <Panel title="概率分桶明细">
        <div className="table-scroll">
          <table className="comparison bucket-audit">
            <thead>
              <tr>
                <th>区间</th>
                <th>平均预测</th>
                <th>实际发生率</th>
                <th>校准差</th>
                <th>样本数</th>
                <th>分桶 Brier</th>
                <th>净 PnL</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr key={bucket.lower}>
                  <td>
                    {Math.round(bucket.lower * 100)}–
                    {Math.round(bucket.upper * 100)}%
                  </td>
                  <td>{bucket.count > 0 ? number(bucket.meanProbability) : "—"}</td>
                  <td>{bucket.count > 0 ? number(bucket.observedRate) : "—"}</td>
                  <td
                    className={
                      bucket.count > 0 &&
                      Math.abs(bucket.observedRate - bucket.meanProbability) > 0.05
                        ? "negative"
                        : ""
                    }
                  >
                    {bucket.count > 0
                      ? number(bucket.observedRate - bucket.meanProbability)
                      : "—"}
                  </td>
                  <td>{bucket.count}</td>
                  <td>{bucket.count > 0 ? number(bucket.brier) : "—"}</td>
                  <td
                    className={
                      bucket.pnl > 0
                        ? "positive"
                        : bucket.pnl < 0
                          ? "negative"
                          : ""
                    }
                  >
                    {bucket.count > 0
                      ? `${bucket.pnl > 0 ? "+" : ""}${number(bucket.pnl, 2)}`
                      : "—"}
                  </td>
                  <td>
                    {bucket.count === 0 ? (
                      <b className="muted">无样本</b>
                    ) : bucket.count < 20 ? (
                      <b className="amber">样本少</b>
                    ) : (
                      <b className="positive">可描述</b>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </section>
  );
}

export function CalibrationComparison({
  runs,
}: {
  runs: readonly Readonly<{
    result: BacktestResultV1;
    label: string;
    color: string;
  }>[];
}) {
  const evidence = runs
    .map((run) => ({
      ...run,
      buckets: calibrationBuckets(probabilityObservations(run.result)).filter(
        (bucket) => bucket.count > 0,
      ),
    }))
    .filter((run) => run.buckets.length > 0);
  if (evidence.length === 0)
    return (
      <Panel title="概率校准对比">
        <EmptyState
          title="校准分箱对比不可用"
          detail="所选旧运行没有逐样本预测概率与最终结局，无法生成真实校准曲线；请重新回测。"
        />
      </Panel>
    );
  return (
    <>
      <Panel title="概率校准对比">
        <CalibrationComparisonChart series={evidence} />
      </Panel>
      <Panel title="Brier 分桶明细">
        <div className="table-scroll">
          <table className="comparison bucket-audit">
            <thead>
              <tr>
                <th>策略</th>
                <th>预测区间</th>
                <th>样本数</th>
                <th>平均预测概率</th>
                <th>实际发生率</th>
                <th>校准差</th>
                <th>分桶 Brier</th>
              </tr>
            </thead>
            <tbody>
              {evidence.flatMap((run) =>
                run.buckets.map((bucket) => (
                  <tr key={`${run.result.runId}-${bucket.lower}`}>
                    <td>
                      <i
                        className="run-dot"
                        style={{ background: run.color }}
                      />
                      {run.label}
                    </td>
                    <td>
                      {Math.round(bucket.lower * 100)}–
                      {Math.round(bucket.upper * 100)}%
                    </td>
                    <td>{bucket.count}</td>
                    <td>{number(bucket.meanProbability)}</td>
                    <td>{number(bucket.observedRate)}</td>
                    <td
                      className={
                        Math.abs(bucket.observedRate - bucket.meanProbability) >
                        0.05
                          ? "negative"
                          : ""
                      }
                    >
                      {number(bucket.observedRate - bucket.meanProbability)}
                    </td>
                    <td>{number(bucket.brier)}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

export function PnlDistribution({ result }: { result: BacktestResultV1 }) {
  const values = result.events
    .filter((event) => event.kind === "settlement")
    .map((event) => Number(event.payload.pnl))
    .filter(Number.isFinite);
  if (values.length === 0)
    return (
      <EmptyState
        title="单市场 PnL 分布不可用"
        detail="结果没有带净盈亏的结算事件。"
      />
    );
  const lower = Math.min(...values);
  const upper = Math.max(...values);
  const spread = upper - lower || 1;
  const bins = Array.from(
    { length: 11 },
    (_, index) =>
      values.filter(
        (value) =>
          value >= lower + (spread * index) / 11 &&
          (index === 10
            ? value <= upper
            : value < lower + (spread * (index + 1)) / 11),
      ).length,
  );
  const largest = Math.max(...bins, 1);
  const ordered = [...values].sort((left, right) => left - right);
  const var95 =
    ordered[Math.max(0, Math.floor(ordered.length * 0.05) - 1)] ?? 0;
  const tail = ordered.filter((value) => value <= var95);
  return (
    <div className="pnl-distribution">
      <div className="pnl-histogram" aria-label="单市场净盈亏直方图">
        {bins.map((count, index) => {
          const midpoint = lower + (spread * (index + 0.5)) / bins.length;
          return (
            <i
              key={index}
              className={midpoint < 0 ? "loss" : "gain"}
              style={{ height: `${Math.max(3, (count / largest) * 100)}%` }}
              title={`${count} 个结算`}
            />
          );
        })}
      </div>
      <div className="histogram-axis">
        <span>{number(lower, 2)}</span>
        <span>0</span>
        <span>
          {upper > 0 ? "+" : ""}
          {number(upper, 2)}
        </span>
      </div>
      <div className="coverage-kpis">
        <span>
          结算数<b>{values.length}</b>
        </span>
        <span>
          盈利<b>{values.filter((value) => value > 0).length}</b>
        </span>
        <span>
          VaR95<b className="negative">{number(var95, 2)}</b>
        </span>
        <span>
          CVaR95
          <b className="negative">
            {number(
              tail.reduce((sum, value) => sum + value, 0) /
                Math.max(1, tail.length),
              2,
            )}
          </b>
        </span>
      </div>
    </div>
  );
}

export function EventComposition({
  events,
}: {
  events: readonly Readonly<{ kind: string }>[];
}) {
  const kinds = [
    ["market_context", "市场快照", "#33c7ea"],
    ["decision", "决策", "#5b8cff"],
    ["order", "模拟订单", "#a176f4"],
    ["fill", "模拟成交", "#3bd190"],
    ["settlement", "结算", "#f5aa33"],
  ] as const;
  const largest = Math.max(
    ...kinds.map(
      ([kind]) => events.filter((event) => event.kind === kind).length,
    ),
    1,
  );
  return (
    <div className="event-composition" aria-label="事件类型构成">
      {kinds.map(([kind, label, color]) => {
        const count = events.filter((event) => event.kind === kind).length;
        return (
          <span key={kind}>
            <b>{label}</b>
            <i>
              <em
                style={{
                  width: `${(count / largest) * 100}%`,
                  background: color,
                }}
              />
            </i>
            <strong>{count}</strong>
          </span>
        );
      })}
    </div>
  );
}

type TimelineEvent = Readonly<{
  eventTimeUtc: string;
  kind: string;
  data: Readonly<Record<string, string | number | boolean | null>>;
}>;

export function ProbabilityEventTimeline({
  events,
}: {
  events: readonly TimelineEvent[];
}) {
  const points = events.flatMap((event) => {
    if (event.kind !== "decision") return [];
    const raw =
      event.data.probability ??
      event.data.modelProbabilityYes ??
      event.data.p_cal;
    const probability = probabilityValue(raw);
    return probability !== null
      ? [{ x: event.eventTimeUtc, value: probability }]
      : [];
  });
  if (points.length < 2)
    return (
      <EmptyState
        title="概率轨迹不可用"
        detail="本页后端事件没有至少两个有效决策概率；不会补静态示例线。"
      />
    );
  return (
    <LineChart
      height={250}
      xLabel="后端事件时间 · UTC"
      series={[
        { label: "决策概率", points, color: "#33c7ea" },
        {
          label: "50% 中性线",
          points: points.map((point) => ({ x: point.x, value: 0.5 })),
          color: "#71818d",
          lineStyle: "dashed",
        },
      ]}
    />
  );
}
