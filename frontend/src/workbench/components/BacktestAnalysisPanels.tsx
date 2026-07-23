import { deriveBacktestAnalytics } from "../domain/backtest-analytics.js";
import type { BacktestResultV1 } from "../services/workbench-commands.js";
import {
  EmptyState,
  formatEventUtc,
  humanizeIdentifier,
  Panel,
} from "./ui.js";

export function DerivedMetricSummary({ result }: { result: BacktestResultV1 }) {
  const analytics = deriveBacktestAnalytics(result);
  const metrics = [
    [
      "Log Loss（对数损失）",
      decimal(analytics.probability.logLoss),
      "逐决策概率",
    ],
    [
      "ECE（期望校准误差）",
      percent(analytics.probability.ece),
      "10 个等宽分桶",
    ],
    ["MCE（最大校准误差）", percent(analytics.probability.mce), "最差概率桶"],
    ["总回报", percent(analytics.returns.totalReturn), "净盈亏 / 初始资金"],
    [
      "PnL Sharpe（夏普）",
      decimal(analytics.returns.sharpe),
      "逐市场 √N 标准化",
    ],
    ["Sortino（索提诺）", decimal(analytics.returns.sortino), "仅使用下行波动"],
    [
      "Profit Factor（盈利因子）",
      ratio(analytics.returns.profitFactor),
      "总盈利 / 总亏损",
    ],
    ["CVaR95", signed(analytics.returns.cvar95), "最差 5% 市场均值"],
  ] as const;
  return (
    <section
      className="analysis-derived-metrics"
      aria-label="前端确定性派生指标"
    >
      {metrics.map(([label, value, detail]) => (
        <article key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
          <small>{detail}</small>
        </article>
      ))}
    </section>
  );
}

export function ExecutionEvidence({ result }: { result: BacktestResultV1 }) {
  const { execution } = deriveBacktestAnalytics(result);
  const reasons = Object.entries(execution.riskReasonCounts).sort(
    (left, right) => right[1] - left[1],
  );
  const statuses = Object.entries(execution.riskStatusCounts).sort(
    (left, right) => right[1] - left[1],
  );
  return (
    <div className="backtest-lower">
      <Panel title="执行损耗证据" english="Gross Edge → Net Edge">
        <div className="execution-evidence">
          <EvidenceValue
            label="平均原始优势"
            value={percent(execution.meanGrossEdge)}
          />
          <EvidenceValue
            label="平均要求优势"
            value={percent(execution.meanRequiredEdge)}
          />
          <EvidenceValue
            label="平均净优势"
            value={percent(execution.meanNetEdge)}
          />
          <EvidenceValue
            label="平均预计费用"
            value={decimal(execution.meanEstimatedFee, 4)}
          />
          <EvidenceValue
            label="平均盘口参与率"
            value={percent(execution.meanBookParticipation)}
          />
          <EvidenceValue
            label="风险批准数量比"
            value={percent(execution.approvalRatio)}
          />
        </div>
        <p className="quant-callout">
          以上数值直接汇总后端逐决策冻结字段，不从最终 PnL
          反推。滑点仍需订单与成交的稳定关联口径后再计算。
        </p>
      </Panel>
      <Panel title="风险审查与拒绝原因" english="Risk Review Evidence">
        {statuses.length === 0 && reasons.length === 0 ? (
          <EmptyState
            title="风险审查证据不可用"
            detail="历史运行没有记录 riskStatus 或 riskReasonCodes。"
          />
        ) : (
          <div className="risk-evidence-grid">
            <section>
              <h4>审查状态</h4>
              {statuses.map(([label, count]) => (
                <span key={label}>
                  <b>{humanizeIdentifier(label)}</b>
                  <strong>{count}</strong>
                </span>
              ))}
            </section>
            <section>
              <h4>原因分桶</h4>
              {reasons.length === 0 ? (
                <p>没有记录拒绝或缩量原因</p>
              ) : (
                reasons.slice(0, 8).map(([label, count]) => (
                  <span key={label}>
                    <b>{humanizeIdentifier(label)}</b>
                    <strong>{count}</strong>
                  </span>
                ))
              )}
            </section>
          </div>
        )}
      </Panel>
    </div>
  );
}

export function AdvancedBacktestAnalysis({
  result,
}: {
  result: BacktestResultV1;
}) {
  const analytics = deriveBacktestAnalytics(result);
  const scope = result.evaluationScope;
  return (
    <section className="advanced-analysis" aria-label="完整回测分析模块">
      <Panel title="滚动指标">
        {analytics.returns.rollingSharpe.length > 1 ||
        analytics.probability.rollingBrier.length > 1 ? (
          <RollingMetricsChart
            sharpe={analytics.returns.rollingSharpe}
            brier={analytics.probability.rollingBrier}
          />
        ) : (
          <EmptyState
            title="样本不足"
            detail="需要至少两个有效结算与概率样本。"
          />
        )}
      </Panel>

      <Panel title="冻结配置">
        <div className="frozen-config-grid">
          <ConfigGroup
            title="数据与切分"
            rows={[
              ["数据集", result.request.datasetId],
              ["版本哈希", result.request.datasetVersionHash],
              ["数据分组", result.request.evaluationSplit],
              [
                "样本数",
                scope === undefined ? "未记录" : String(scope.cohortSize),
              ],
              ["开始时间", formatEventUtc(result.startedAtUtc)],
              ["结束时间", formatEventUtc(result.completedAtUtc)],
            ]}
          />
          <ConfigGroup
            title="策略与执行"
            rows={[
              ["策略", result.request.strategyId],
              ["策略版本", result.request.strategyVersion],
              ["初始资金", `${result.request.initialCash} USDC`],
              ["最大仓位", `${result.request.maxPosition} USDC`],
              ["手续费模型", result.request.feeModel],
              ["执行延迟", `${result.request.latencyMs} ms`],
            ]}
          />
        </div>
      </Panel>

      <div className="backtest-lower">
        <Panel title="尚未生成的稳健性证据">
          <div className="evidence-gap-list" role="list">
            <article role="listitem">
              <strong>参数稳定区</strong>
              <span>缺少同口径参数网格运行</span>
              <small>下一步：对真实策略版本执行参数扫描</small>
            </article>
            <article role="listitem">
              <strong>滚动前推</strong>
              <span>缺少连续训练与验证窗口</span>
              <small>下一步：按 UTC 时间顺序生成多个窗口</small>
            </article>
            <article role="listitem">
              <strong>执行压力</strong>
              <span>缺少费用、延迟与成交率压力运行</span>
              <small>下一步：以当前冻结运行为基准重跑</small>
            </article>
          </div>
          <p className="quant-callout">
            未生成实验结果时不绘图，也不把当前切分包装成滚动验证。
          </p>
        </Panel>
        <Panel title="数据质量与可复现性">
          <EvidenceTable
            headers={["证据", "冻结值", "状态"]}
            rows={[
              ["运行 ID", result.runId, "已记录"],
              ["数据集版本", result.request.datasetVersionHash, "已记录"],
              ["样本指纹", scope?.cohortHash ?? "—", scope?.cohortHash ? "已记录" : "缺失"],
              ["执行场景", scope?.scenario ?? "—", scope?.scenario ? "已记录" : "缺失"],
              ["事件 / 资金点", `${result.events.length} / ${result.equityCurve.length}`, "已记录"],
              ["Git / 配置哈希", "—", "缺失"],
            ]}
          />
        </Panel>
      </div>
    </section>
  );
}

function ConfigGroup({
  title,
  rows,
}: {
  title: string;
  rows: readonly (readonly [string, string])[];
}) {
  return (
    <section>
      <h3>{title}</h3>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function RollingMetricsChart({
  sharpe,
  brier,
}: {
  sharpe: readonly number[];
  brier: readonly number[];
}) {
  return (
    <svg viewBox="0 0 590 245" role="img" aria-label="滚动夏普与滚动 Brier">
      <text x="12" y="18" fill="#a9bed0" fontSize="11">
        滚动夏普 · 最多 100 个市场
      </text>
      <ChartGrid top={30} bottom={120} />
      {sharpe.length > 1 ? (
        <polyline
          points={chartPoints(sharpe, 45, 570, 38, 116)}
          fill="none"
          stroke="#4fd17d"
          strokeWidth="2.5"
        />
      ) : (
        <text x="260" y="82" fill="#8095a2" fontSize="11">
          样本不足
        </text>
      )}
      <text x="12" y="153" fill="#a9bed0" fontSize="11">
        滚动 Brier · 最多 100 个市场
      </text>
      <ChartGrid top={165} bottom={240} />
      {brier.length > 1 ? (
        <polyline
          points={chartPoints(brier, 45, 570, 170, 236)}
          fill="none"
          stroke="#33c7ea"
          strokeWidth="2.5"
        />
      ) : (
        <text x="260" y="205" fill="#8095a2" fontSize="11">
          样本不足
        </text>
      )}
    </svg>
  );
}

function ChartGrid({ top, bottom }: { top: number; bottom: number }) {
  const step = (bottom - top) / 3;
  return (
    <g stroke="#203746" strokeWidth="1">
      {[0, 1, 2, 3].map((index) => (
        <line
          key={index}
          x1="45"
          y1={top + step * index}
          x2="570"
          y2={top + step * index}
        />
      ))}
    </g>
  );
}

function chartPoints(
  values: readonly number[],
  left: number,
  right: number,
  top: number,
  bottom: number,
): string {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return "";
  const low = Math.min(...finite);
  const high = Math.max(...finite);
  const span = high - low || 1;
  return finite
    .map((value, index) => {
      const x = left + (index / (finite.length - 1)) * (right - left);
      const y = bottom - ((value - low) / span) * (bottom - top);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function EvidenceTable({
  headers,
  rows,
}: {
  headers: readonly string[];
  rows: readonly (readonly string[])[];
}) {
  return (
    <div className="table-scroll">
      <table className="comparison">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((value, cell) => (
                <td key={cell}>{value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EvidenceValue({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <small>{label}</small>
      <strong>{value}</strong>
    </span>
  );
}

function decimal(value: number | null, digits = 3): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : value.toFixed(digits);
}
function percent(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}
function signed(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}
function ratio(value: number | null): string {
  return value === Number.POSITIVE_INFINITY ? "∞" : decimal(value);
}
