import { useEffect, useState } from "react";
import { useWorkbench } from "../app/WorkbenchContext.js";
import { useWorkbenchData } from "../app/WorkbenchDataContext.js";
import { useWorkbenchCommands } from "../app/WorkbenchCommandContext.js";
import type {
  BacktestJobV1,
  BacktestResultV1,
  RunComparisonV1,
  StrategyDefinitionV1,
  StrategyVersionV1,
} from "../services/workbench-commands.js";
import { LineChart } from "../components/LineChart.js";
import { CalibrationComparison } from "../components/QuantAnalysis.js";
import { deriveBacktestAnalytics } from "../domain/backtest-analytics.js";
import { EmptyState, MetricCard, PageHeader, Panel } from "../components/ui.js";
const colors: Record<string, string> = {
  blue: "#4f91ff",
  green: "#4fd17d",
  purple: "#a68aff",
  amber: "#f2c35f",
};
const lParameterStudy = [
  { label: "TRAIN 选定", edge: "0.25", stake: "300", participation: "1.00", netPnl: "305.995", drawdown: "263.528", fills: 46, note: "按 TRAIN 排名第一；此处展示 VALIDATION 持出表现" },
  { label: "较低仓位", edge: "0.25", stake: "200", participation: "1.00", netPnl: "305.920", drawdown: "263.528", fills: 46, note: "持出收益几乎相同，配置上限更保守" },
  { label: "高覆盖候选", edge: "0.50", stake: "200", participation: "1.00", netPnl: "347.133", drawdown: "583.092", fills: 94, note: "持出收益更高，但并非 TRAIN 最优且回撤翻倍" },
  { label: "旧冻结对照", edge: "0.25", stake: "400", participation: "0.50", netPnl: "132.258", drawdown: "232.756", fills: 46, note: "现有 L V2 对照；收益明显低于新候选" },
] as const;
export function ComparePage() {
  const { state, dispatch } = useWorkbench();
  const { sourceKind, chartSeries, runs } = useWorkbenchData();
  const commands = useWorkbenchCommands();
  const [jobs, setJobs] = useState<readonly BacktestJobV1[]>([]);
  const [definitions, setDefinitions] = useState<
    readonly StrategyDefinitionV1[]
  >([]);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [comparisons, setComparisons] = useState<readonly RunComparisonV1[]>(
    [],
  );
  const [comparisonResults, setComparisonResults] = useState<
    readonly BacktestResultV1[]
  >([]);
  const [strategyVersions, setStrategyVersions] = useState<
    ReadonlyMap<string, StrategyVersionV1>
  >(new Map());
  const [queryStatus, setQueryStatus] = useState("正在加载后端回测任务…");
  const [comparing, setComparing] = useState(false);
  const [comparisonError, setComparisonError] = useState(false);
  useEffect(() => {
    if (commands === null || sourceKind !== "verified-local") return;
    let active = true;
    Promise.all([
      commands.listBacktestJobs(),
      commands.listStrategyDefinitions(),
    ])
      .then(([items, nextDefinitions]) => {
        if (!active) return;
        const complete = items.filter((item) => item.status === "succeeded");
        const sessionRuns = state.researchSession.comparisonRunIds.filter(
          (runId) => complete.some((item) => item.runId === runId),
        );
        const requested = state.researchSession.runId;
        const requestedJob = complete.find((item) => item.runId === requested);
        const newestGroupId = complete.find(
          (item) => item.comparisonGroupId !== undefined,
        )?.comparisonGroupId;
        const preferredGroupId =
          requestedJob?.comparisonGroupId ?? newestGroupId;
        const automaticGroup =
          preferredGroupId === undefined
            ? []
            : complete.filter(
                (item) => item.comparisonGroupId === preferredGroupId,
              );
        const requestedRuns = unique([
          ...sessionRuns,
          ...(requestedJob === undefined ? [] : [requestedJob.runId]),
        ]);
        const baseSelection =
          requestedRuns.length >= 2
            ? requestedRuns
            : requestedRuns.length === 1
              ? unique([
                  ...requestedRuns,
                  ...automaticGroup.map((item) => item.runId),
                  ...complete.map((item) => item.runId),
                ]).slice(0, Math.max(2, automaticGroup.length))
              : automaticGroup.length >= 2
                ? automaticGroup.map((item) => item.runId)
                : complete.slice(0, 2).map((item) => item.runId);
        const latestCandidateRuns = latestRunPerStrategy(
          complete.filter(
            (item) =>
              item.strategyId !== undefined &&
              !isBaselineStrategy(item.strategyId),
          ),
        );
        const sessionOnlyContainsPreferredGroup =
          requestedJob !== undefined &&
          requestedRuns.every((runId) =>
            automaticGroup.some((item) => item.runId === runId),
          );
        const initial = sessionOnlyContainsPreferredGroup
          ? unique([
              ...baseSelection,
              ...latestCandidateRuns.map((item) => item.runId),
            ])
          : baseSelection;
        setJobs(complete);
        setDefinitions(nextDefinitions);
        setChosen(initial);
        if (initial.length >= 2) {
          void loadComparison(initial);
        } else {
          setQueryStatus("至少需要两个成功回测才能比较");
        }
      })
      .catch((error: unknown) => {
        if (active)
          setQueryStatus(
            error instanceof Error ? error.message : "回测任务不可用",
          );
      });
    return () => {
      active = false;
    };
  }, [commands, sourceKind]);
  function toggle(runId: string) {
    setChosen((current) => {
      const next = current.includes(runId)
        ? current.filter((item) => item !== runId)
        : [...current, runId];
      dispatch({
        type: "update-research-session",
        patch: { comparisonRunIds: next, stage: "analysis" },
      });
      return next;
    });
    setComparisons([]);
    setComparisonResults([]);
    setComparisonError(false);
    setQueryStatus("选择已更新；至少选择两个运行后开始比较");
  }
  async function compare() {
    if (chosen.length < 2) return;
    await loadComparison(chosen);
  }
  async function loadComparison(runIds: readonly string[]) {
    if (commands === null || runIds.length < 2) return;
    setComparing(true);
    setComparisonError(false);
    setComparisons([]);
    setComparisonResults([]);
    setStrategyVersions(new Map());
    setQueryStatus(`正在自动核对 ${runIds.length} 个同口径运行…`);
    try {
      const value = await commands.compareBacktests(runIds);
      const results = await Promise.all(
        value.map((item) => commands.getBacktestResult(item.runId)),
      );
      const versions = await Promise.all(
        value
          .filter((item) => !isBaselineStrategy(item.strategyId))
          .map(async (item) => {
            try {
              const version = await commands.getStrategyVersion(
                item.strategyId,
                item.strategyVersion,
              );
              return [strategyVersionKey(item), version] as const;
            } catch {
              return null;
            }
          }),
      );
      setComparisons(value);
      setComparisonResults(results);
      setStrategyVersions(
        new Map(
          versions.filter(
            (item): item is readonly [string, StrategyVersionV1] =>
              item !== null,
          ),
        ),
      );
      dispatch({
        type: "update-research-session",
        patch: { comparisonRunIds: runIds, stage: "analysis" },
      });
      setQueryStatus(
        `比较完成：${value.length} 个运行使用相同数据分组、时间跨度、执行场景和样本集合`,
      );
    } catch (error) {
      setComparisonError(true);
      setQueryStatus(`比较失败：${comparisonMessage(error)}`);
    } finally {
      setComparing(false);
    }
  }
  if (sourceKind === "verified-local")
    return (
      <>
        <PageHeader
          title="回测分析 · 策略对比"
          subtitle="同一数据、样本与执行成本"
          action={
            <button
              className="button button--primary"
              disabled={commands === null || chosen.length < 2 || comparing}
              onClick={() => void compare()}
            >
              {comparing ? "正在比较…" : `比较所选运行（${chosen.length}）`}
            </button>
          }
        />
        <LParameterStudy />
        <VerifiedComparisonVisuals
          comparisons={comparisons}
          results={comparisonResults}
          definitions={definitions}
          strategyVersions={strategyVersions}
        />
        <details className="technical-details comparison-run-picker" open={comparisons.length === 0}>
          <summary>选择比较运行 · 已选 {chosen.length} 个</summary>
          <p
            className={comparisonError ? "action-status action-status--error" : "action-status"}
            role={comparisonError ? "alert" : "status"}
          >
            {queryStatus}
          </p>
          {jobs.length === 0 ? (
            <EmptyState title="没有可比较的真实运行" detail="至少需要两个成功回测。" />
          ) : (
            <div className="run-selector">
              {jobs.map((job) => (
                <label key={job.runId}>
                  <input type="checkbox" checked={chosen.includes(job.runId)} onChange={() => toggle(job.runId)} />
                  <span>
                    <strong>
                      {definitions.find((item) => item.strategyId === job.strategyId)?.displayName ??
                        job.displayName ??
                        "历史运行"}
                      {job.strategyVersion === undefined ? null : ` v${job.strategyVersion}`}
                    </strong>
                    <small>{job.displayName ?? "未记录运行名称"}</small>
                  </span>
                </label>
              ))}
            </div>
          )}
        </details>
      </>
    );
  const selectedIds =
    state.selectedRunIds.length === 0
      ? runs.slice(0, 3).map((run) => run.id)
      : state.selectedRunIds;
  const selected = runs.filter((run) => selectedIds.includes(run.id));
  const leader = selected[0] ?? runs[0]!;
  const calibration = [
    0.06, 0.13, 0.21, 0.31, 0.39, 0.51, 0.61, 0.72, 0.82, 0.91, 0.97,
  ];
  return (
    <>
      <PageHeader
        title="策略竞技场（Strategy Arena）"
        subtitle="在完全相同的数据、费用与成交假设下比较冻结运行"
        action={
          <div className="toolbar">
            <select aria-label="数据集">
              <option>BTC 5m · Jul 01–18</option>
            </select>
            <button className="button">导出对比</button>
          </div>
        }
      />
      <div className="compare-summary">
        <article>
          <span>当前领先</span>
          <strong>{leader.name}</strong>
          <small>按风险调整后收益</small>
        </article>
        <article>
          <span>最高净盈亏</span>
          <strong className="positive">{leader.pnl}</strong>
          <small>仅为描述性证据</small>
        </article>
        <article>
          <span>最低 Brier</span>
          <strong>{leader.brier}</strong>
          <small>T−60s 校准窗口</small>
        </article>
        <article>
          <span>有效运行</span>
          <strong>
            {selected.length} / {runs.length}
          </strong>
          <small>相同数据与成本模型</small>
        </article>
      </div>
      <Panel title="策略排名" english="Strategy Ranking">
        <table className="comparison">
          <thead>
            <tr>
              <th>#</th>
              <th>运行</th>
              <th>净盈亏</th>
              <th>最大回撤</th>
              <th>Brier</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run, i) => (
              <tr key={run.id}>
                <td>{i + 1}</td>
                <td>
                  <i
                    className="run-dot"
                    style={{ background: colors[run.color] }}
                  />
                  {run.name}
                </td>
                <td className="positive">{run.pnl}</td>
                <td>{run.drawdown}</td>
                <td>{run.brier}</td>
                <td>DESCRIPTIVE</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <div className="compare-grid compare-grid--fidelity">
        <Panel title="运行选择" english="Run Selector">
          <div className="run-selector">
            {runs.map((run) => (
              <label key={run.id}>
                <input
                  type="checkbox"
                  checked={selectedIds.includes(run.id)}
                  onChange={() =>
                    dispatch({ type: "toggle-run", runId: run.id })
                  }
                />
                <i style={{ background: colors[run.color] }} />
                <span>
                  <strong>{run.name}</strong>
                  <small>
                    PnL {run.pnl} · Brier {run.brier}
                  </small>
                </span>
              </label>
            ))}
          </div>
        </Panel>
        <Panel title="累计净盈亏" english="Cumulative PnL">
          <LineChart
            height={280}
            series={selected.map((run, index) => ({
              label: run.name,
              values: chartSeries.pnl.map(
                (value, i) =>
                  value * (1 - index * 0.2) + Math.sin(i + index) * index * 3,
              ),
              color: colors[run.color]!,
            }))}
          />
        </Panel>
      </div>
      <div className="run-cards">
        {selected.map((run) => (
          <article key={run.id} style={{ borderTopColor: colors[run.color] }}>
            <span>{run.name}</span>
            <strong className="positive">{run.pnl}</strong>
            <dl>
              <dt>最大回撤</dt>
              <dd>{run.drawdown}</dd>
              <dt>Brier</dt>
              <dd>{run.brier}</dd>
            </dl>
          </article>
        ))}
      </div>
      <Panel title="指标对比" english="Metric Comparison">
        <table className="comparison">
          <thead>
            <tr>
              <th>指标</th>
              {selected.map((run) => (
                <th key={run.id}>{run.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>净盈亏</td>
              {selected.map((run) => (
                <td key={run.id} className="positive">
                  {run.pnl}
                </td>
              ))}
            </tr>
            <tr>
              <td>最大回撤</td>
              {selected.map((run) => (
                <td key={run.id}>{run.drawdown}</td>
              ))}
            </tr>
            <tr>
              <td>Brier @ T−60s</td>
              {selected.map((run) => (
                <td key={run.id}>{run.brier}</td>
              ))}
            </tr>
            <tr>
              <td>证据状态</td>
              {selected.map((run) => (
                <td key={run.id}>DESCRIPTIVE</td>
              ))}
            </tr>
          </tbody>
        </table>
      </Panel>
      <Panel
        title="概率校准对比"
        english="Calibration Comparison"
        className="calibration-panel"
      >
        <div className="calibration-axis">
          <span>实际发生率</span>
          <LineChart
            height={260}
            series={[
              {
                label: "理想校准线",
                values: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
                color: "#7890a8",
              },
              ...selected.map((run, index) => ({
                label: run.name,
                values: calibration.map((value, i) =>
                  Math.max(
                    0,
                    Math.min(1, value + index * 0.025 * Math.sin(i * 1.7)),
                  ),
                ),
                color: colors[run.color]!,
              })),
            ]}
          />
          <small>预测概率分箱（0 → 1）</small>
        </div>
      </Panel>
    </>
  );
}

function LParameterStudy() {
  return (
    <Panel title="L V2 参数扫描结论" english="Offline Parameter Study">
      <div className="action-status">
        <strong>稀疏历史基线选定：最大信号优势 0.25、单次最大投入 300 USDC、盘口参与比例 1.00。</strong>
        <br />
        252 个组合先用 2,880 条 TRAIN 样本排名，再查看 1,440 条 VALIDATION 持出样本；fee-v2、模拟 1 秒执行延迟、初始资金 10,000 USDC。
        数据每市场只有 T−60/T−30/T−15 三个决策点，不能代表逐订单簿事件策略，也不是盈利证明。
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead><tr><th>候选</th><th>最大信号优势</th><th>最大投入</th><th>盘口参与</th><th>净收益</th><th>最大回撤</th><th>成交</th><th>判断</th></tr></thead>
          <tbody>{lParameterStudy.map((item) => (
            <tr key={item.label}>
              <td><strong>{item.label}</strong></td><td>{item.edge}</td><td>{item.stake} USDC</td><td>{item.participation}</td>
              <td className="positive">+{item.netPnl}</td><td className="negative">−{item.drawdown}</td><td>{item.fills}</td><td>{item.note}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <details className="technical-details">
        <summary>研究口径与复现信息</summary>
        <p>数据版本 <code>a27d9d1bf4dc5276c7ae5b11abd64250b6e6dc17f01fd432ab0dc10e4425cafc</code>；连续性状态 UNVERIFIED、TOP_OF_BOOK_ONLY、receive time 未观测。选定组合 TRAIN 净收益 995.808、最大回撤 236.172、成交 133；VALIDATION 净收益 305.995、最大回撤 263.528、成交 46。VALIDATION 去掉最佳一天后净收益为 −65.266，结果高度集中。Brier 在执行参数间不变，因为三项参数不改变概率模型。</p>
        <p><code>PYTHONPATH=. /usr/bin/python3 scripts/sweep_l_parameters.py &lt;dataset-version-directory&gt;</code></p>
      </details>
    </Panel>
  );
}

function VerifiedComparisonVisuals({
  comparisons,
  results,
  definitions,
  strategyVersions,
}: {
  comparisons: readonly RunComparisonV1[];
  results: readonly BacktestResultV1[];
  definitions: readonly StrategyDefinitionV1[];
  strategyVersions: ReadonlyMap<string, StrategyVersionV1>;
}) {
  if (comparisons.length === 0) return null;
  const palette = ["#4f91ff", "#4fd17d", "#a68aff", "#f2c35f", "#f06c75"];
  const useUtcEquityAxis = results.every((result) =>
    monotonicUtc(result.equityCurve.map((point) => point.timeUtc)),
  );
  const pnlSeries = results.flatMap((result, index) => {
    const equity = result.equityCurve
      .map((point) => Number(point.equity))
      .filter(Number.isFinite);
    if (equity.length < 2) return [];
    const initial = equity[0] ?? 0;
    const comparison = comparisons.find((item) => item.runId === result.runId);
    const name =
      definitions.find((item) => item.strategyId === comparison?.strategyId)
        ?.displayName ??
      comparison?.displayName ??
      result.runId;
    return [
      {
        label: name,
        points: result.equityCurve.map((point, pointIndex) => ({
          x: useUtcEquityAxis ? point.timeUtc : pointIndex,
          value: equity[pointIndex]! - initial,
        })),
        color: palette[index % palette.length]!,
      },
    ];
  });
  const names = new Map(
    comparisons.map((run) => [
      run.runId,
      definitions.find((item) => item.strategyId === run.strategyId)
        ?.displayName ??
        run.displayName ??
        run.strategyId,
    ]),
  );
  const descriptiveRanked = [...comparisons].sort(
    (left, right) => Number(right.metrics.netPnl) - Number(left.metrics.netPnl),
  );
  const drawdownResult =
    results.find(
      (result) => result.runId === descriptiveRanked[0]?.runId,
    ) ?? results[0];
  const drawdownName =
    drawdownResult === undefined
      ? ""
      : (names.get(drawdownResult.runId) ?? drawdownResult.runId);
  const analytics = new Map(
    results.map((result) => [result.runId, deriveBacktestAnalytics(result)]),
  );
  const candidates = comparisons.filter(
    (run) => !isBaselineStrategy(run.strategyId),
  );
  const completeCandidates = candidates.filter((run) =>
    hasSelectionEvidence(run, analytics.get(run.runId)),
  );
  const paretoRunIds = new Set(
    completeCandidates
      .filter(
        (candidate) =>
          !completeCandidates.some(
            (other) =>
              other.runId !== candidate.runId &&
              dominates(
                other,
                candidate,
                analytics.get(other.runId),
                analytics.get(candidate.runId),
              ),
          ),
      )
      .map((run) => run.runId),
  );
  const descriptiveTop =
    [...candidates].sort(
      (left, right) =>
        Number(right.metrics.netPnl) - Number(left.metrics.netPnl),
    )[0] ?? descriptiveRanked[0];
  const descriptiveTopAnalytics =
    descriptiveTop === undefined
      ? undefined
      : analytics.get(descriptiveTop.runId);
  const descriptiveTopBrier = finiteOrNull(
    descriptiveTopAnalytics?.probability.brier ??
      descriptiveTop?.metrics.brier,
  );
  const baseline =
    comparisons.find(
      (run) =>
        /^B[0-3]_/u.test(run.strategyId) &&
        /(MARKET|IMPLIED|B1)/u.test(run.strategyId),
    ) ?? comparisons.find((run) => /^B[0-3]_/u.test(run.strategyId));
  const baselineBrier =
    baseline === undefined
      ? null
      : finiteOrNull(
          analytics.get(baseline.runId)?.probability.brier ??
            baseline.metrics.brier,
        );
  const brierSkill =
    descriptiveTopBrier !== null &&
    baselineBrier !== null &&
    baselineBrier !== 0 &&
    descriptiveTop?.runId !== baseline?.runId
      ? (baselineBrier - descriptiveTopBrier) / baselineBrier
      : null;
  return (
    <>
      <StrategySelectionSummary
        candidates={candidates}
        paretoRunIds={paretoRunIds}
        analytics={analytics}
        names={names}
        strategyVersions={strategyVersions}
      />
      <div className="metrics-grid">
        <MetricCard
          label="最高净盈亏"
          english="Descriptive only"
          value={descriptiveTop === undefined ? "—" : `${signed(descriptiveTop.metrics.netPnl)} USDC`}
          tone={descriptiveTop !== undefined && Number(descriptiveTop.metrics.netPnl) >= 0 ? "positive" : "negative"}
          footer={<><span>{descriptiveTop === undefined ? "无结果" : names.get(descriptiveTop.runId)}</span><b>不等于胜出</b></>}
        />
        <MetricCard
          label="对应 Brier"
          english="Probability quality"
          value={formatMetric(descriptiveTopBrier, 3)}
          tone="cyan"
          footer={<><span>{descriptiveTop === undefined ? "无结果" : names.get(descriptiveTop.runId)}</span><b>越低越好</b></>}
        />
        <MetricCard
          label="Brier 技能分数"
          english="vs market baseline"
          value={formatPercent(brierSkill)}
          tone={brierSkill !== null && brierSkill >= 0 ? "positive" : "negative"}
          footer={<><span>{baseline === undefined ? "缺少市场基准" : names.get(baseline.runId)}</span><b>同组比较</b></>}
        />
        <MetricCard
          label="期望校准误差"
          english="ECE"
          value={formatPercent(descriptiveTopAnalytics?.probability.ece ?? null)}
          tone="amber"
          footer={<><span>10 个概率分箱</span><b>越低越好</b></>}
        />
        <MetricCard
          label="PnL 夏普"
          english="Per-market normalized"
          value={formatMetric(descriptiveTopAnalytics?.returns.sharpe ?? null, 2)}
          footer={<><span>已结算市场</span><b>风险调整</b></>}
        />
        <MetricCard
          label="最大回撤"
          english="Peak to trough"
          value={descriptiveTop === undefined ? "—" : `${compact(Number(descriptiveTop.metrics.maxDrawdown))} USDC`}
          tone="negative"
          footer={<><span>{descriptiveTop === undefined ? "无结果" : names.get(descriptiveTop.runId)}</span><b>资金曲线</b></>}
        />
      </div>
      <Panel title="候选与淘汰原因">
          <div className="table-scroll">
            <table className="comparison">
              <thead>
                <tr>
                  <th>策略</th>
                  <th>收益率</th>
                  <th>Brier</th>
                  <th>对数损失</th>
                  <th>ECE</th>
                  <th>夏普</th>
                  <th>最大回撤</th>
                  <th>交易</th>
                  <th>本组位置</th>
                </tr>
              </thead>
              <tbody>
                {descriptiveRanked.map((run) => {
                  const derived = analytics.get(run.runId);
                  return <tr key={run.runId}>
                    <td>
                      <i
                        className="run-dot"
                        style={{
                          background:
                            palette[comparisons.indexOf(run) % palette.length],
                        }}
                      />
                      {names.get(run.runId)}
                    </td>
                    <td
                      className={
                        Number(run.metrics.netPnl) >= 0
                          ? "positive"
                          : "negative"
                      }
                    >
                      {formatPercent(derived?.returns.totalReturn ?? null)}
                    </td>
                    <td>{formatMetric(derived?.probability.brier ?? finiteOrNull(run.metrics.brier), 3)}</td>
                    <td>{formatMetric(derived?.probability.logLoss ?? null, 3)}</td>
                    <td>{formatPercent(derived?.probability.ece ?? null)}</td>
                    <td>{formatMetric(derived?.returns.sharpe ?? null, 2)}</td>
                    <td className="negative">{compact(Number(run.metrics.maxDrawdown))} USDC</td>
                    <td>{derived?.execution.settlements ?? 0}</td>
                    <td>
                      <SelectionLabel
                        run={run}
                        hasEvidence={hasSelectionEvidence(run, derived)}
                        pareto={paretoRunIds.has(run.runId)}
                      />
                    </td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
      </Panel>
      <details className="analysis-disclosure">
        <summary>
          <span>收益与风险曲线</span>
          <small>散点、累计净盈亏、回撤水下图</small>
        </summary>
        <div className="analysis-disclosure__body">
          <div className="two-chart-grid">
            <Panel
              title="风险收益散点"
              english="横轴回撤 · 纵轴收益 · 圆点大小为交易数"
            >
              <RiskReturnPlot
                comparisons={comparisons}
                names={names}
                palette={palette}
                tradeCounts={new Map(
                  comparisons.map((run) => [
                    run.runId,
                    analytics.get(run.runId)?.execution.settlements ?? 0,
                  ]),
                )}
              />
            </Panel>
            <Panel title="累计净盈亏 / 权益曲线">
          {pnlSeries.length === comparisons.length ? (
            <>
              <LineChart
                height={286}
                unit=" USDC"
                xLabel={useUtcEquityAxis ? "UTC 时间" : "评估样本序号"}
                series={pnlSeries}
              />
              {useUtcEquityAxis ? null : (
                <p className="panel-note">按冻结评估顺序绘制。</p>
              )}
            </>
          ) : (
            <EmptyState
              title="部分资金曲线不可用"
              detail="后端结果缺少足够资金点。"
            />
          )}
            </Panel>
          </div>
          <Panel title={`回撤水下图 · ${drawdownName}`}>
          {drawdownResult === undefined ? (
            <EmptyState
              title="回撤时序不可用"
              detail="后端结果缺少资金序列。"
            />
          ) : (
            <UnderwaterPlot result={drawdownResult} />
          )}
          </Panel>
        </div>
      </details>
      <details className="analysis-disclosure">
        <summary>
          <span>概率质量对比</span>
          <small>Brier 分桶与概率校准</small>
        </summary>
        <div className="analysis-disclosure__body">
          <CalibrationComparison
            runs={results.map((result, index) => ({
              result,
              color: palette[index % palette.length]!,
              label:
                definitions.find(
                  (item) =>
                    item.strategyId ===
                    comparisons.find(
                      (comparison) => comparison.runId === result.runId,
                    )?.strategyId,
                )?.displayName ?? result.runId,
            }))}
          />
        </div>
      </details>
      <details className="analysis-disclosure baseline-details">
        <summary>
          <span>自动基线判断依据</span>
          <small>仅作比较基准，不参与参数候选</small>
        </summary>
        <div className="analysis-disclosure__body">
          <BaselineVerdict
            comparisons={comparisons}
            definitions={definitions}
          />
        </div>
      </details>
    </>
  );
}

type BacktestAnalytics = ReturnType<typeof deriveBacktestAnalytics>;

function StrategySelectionSummary({
  candidates,
  paretoRunIds,
  analytics,
  names,
  strategyVersions,
}: {
  candidates: readonly RunComparisonV1[];
  paretoRunIds: ReadonlySet<string>;
  analytics: ReadonlyMap<string, BacktestAnalytics>;
  names: ReadonlyMap<string, string>;
  strategyVersions: ReadonlyMap<string, StrategyVersionV1>;
}) {
  const complete = candidates.filter((run) =>
    hasSelectionEvidence(run, analytics.get(run.runId)),
  );
  const groupedFingerprints = new Map<string, Set<string>>();
  candidates.forEach((run) => {
    const version = strategyVersions.get(strategyVersionKey(run));
    if (version === undefined) return;
    const values = groupedFingerprints.get(run.strategyId) ?? new Set<string>();
    values.add(parameterFingerprint(version.parameters));
    groupedFingerprints.set(run.strategyId, values);
  });
  const stableRegionReady = [...groupedFingerprints.values()].some(
    (fingerprints) => fingerprints.size >= 3,
  );
  const preferredCandidates = candidates
    .filter((run) => {
      const derived = analytics.get(run.runId);
      return (
        paretoRunIds.has(run.runId) &&
        (derived?.returns.totalReturn ?? Number.NEGATIVE_INFINITY) > 0 &&
        (derived?.returns.sharpe ?? Number.NEGATIVE_INFINITY) > 0
      );
    })
    .sort(
      (left, right) =>
        (analytics.get(right.runId)?.returns.totalReturn ?? 0) -
        (analytics.get(left.runId)?.returns.totalReturn ?? 0),
    );
  const preferred = preferredCandidates[0];
  const preferredName =
    preferred === undefined ? null : (names.get(preferred.runId) ?? preferred.strategyId);
  const verdict =
    candidates.length < 2
      ? "证据不足：至少需要两个真实候选配置"
      : complete.length !== candidates.length
        ? "证据不足：候选缺少收益、回撤、夏普或 Brier"
        : preferredName !== null
          ? `优先验证 ${preferredName}`
        : stableRegionReady
          ? "已形成候选集，可继续检查相邻参数稳定区"
          : "已形成 Pareto 候选；参数稳定性尚未验证";
  return (
    <section className="strategy-selection-summary" aria-label="策略选择结论">
      <header>
        <span>当前结论</span>
        <strong>{verdict}</strong>
        <small>
          这是下一轮实验优先级，不是盈利结论；候选必须先处于 Pareto
          集合，且验证集收益与夏普同时为正。
        </small>
      </header>
      <div className="selection-evidence-strip">
        <article>
          <span>真实候选</span>
          <strong>{candidates.length}</strong>
          <small>已排除 B0–B3 基线</small>
        </article>
        <article>
          <span>Pareto 候选</span>
          <strong>{paretoRunIds.size}</strong>
          <small>
            {[...paretoRunIds]
              .map((runId) => names.get(runId))
              .filter((name): name is string => name !== undefined)
              .join("、") || "暂无"}
          </small>
        </article>
        <article>
          <span>参数覆盖</span>
          <strong>
            {Math.max(
              0,
              ...[...groupedFingerprints.values()].map(
                (fingerprints) => fingerprints.size,
              ),
            )}
          </strong>
          <small>单策略真实配置数；至少 3 个才检查稳定区</small>
        </article>
        <article>
          <span>下一步</span>
          <strong>
            {stableRegionReady
              ? "检查稳定区"
              : preferredName === null
                ? "补参数扫描"
                : `扫描 ${preferredName}`}
          </strong>
          <small>随后再做滚动前推与成本压力</small>
        </article>
      </div>
      <details className="parameter-evidence">
        <summary>查看候选的真实冻结参数</summary>
        <div>
          {candidates.map((run) => {
            const version = strategyVersions.get(strategyVersionKey(run));
            return (
              <article key={run.runId}>
                <strong>{names.get(run.runId) ?? run.strategyId}</strong>
                <small>
                  {run.strategyId} · v{run.strategyVersion}
                </small>
                <code>
                  {version === undefined
                    ? "版本参数未读取"
                    : formatParameters(version.parameters)}
                </code>
              </article>
            );
          })}
        </div>
      </details>
    </section>
  );
}

function SelectionLabel({
  run,
  hasEvidence,
  pareto,
}: {
  run: RunComparisonV1;
  hasEvidence: boolean;
  pareto: boolean;
}) {
  if (isBaselineStrategy(run.strategyId)) return <span>比较基线</span>;
  if (!hasEvidence) return <b className="warning">证据不足</b>;
  return pareto ? (
    <b className="positive">Pareto 候选</b>
  ) : (
    <span>被其他候选支配</span>
  );
}

function RiskReturnPlot({
  comparisons,
  names,
  palette,
  tradeCounts,
}: {
  comparisons: readonly RunComparisonV1[];
  names: ReadonlyMap<string, string>;
  palette: readonly string[];
  tradeCounts: ReadonlyMap<string, number>;
}) {
  const points = comparisons.map((run, index) => ({
    label: names.get(run.runId) ?? run.strategyId,
    x: Math.abs(Number(run.metrics.maxDrawdown)),
    y: Number(run.metrics.netPnl),
    size: tradeCounts.get(run.runId) ?? 0,
    color: palette[index % palette.length]!,
  }));
  const maxX = Math.max(1, ...points.map((point) => point.x));
  const ys = points.map((point) => point.y);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(1, ...ys);
  const rangeY = maxY - minY || 1;
  const minSize = Math.min(...points.map((point) => point.size));
  const maxSize = Math.max(...points.map((point) => point.size));
  const radius = (size: number) =>
    8 + ((size - minSize) / (maxSize - minSize || 1)) * 7;
  const rendered = points.map((point) => ({
    ...point,
    x: 52 + (point.x / maxX) * 320,
    y: 215 - ((point.y - minY) / rangeY) * 180,
    labelY: 0,
  }));
  const byY = [...rendered].sort((left, right) => left.y - right.y);
  let previousLabelY = 4;
  byY.forEach((point) => {
    point.labelY = Math.max(
      15,
      point.y - radius(point.size) - 7,
      previousLabelY + 21,
    );
    previousLabelY = point.labelY;
  });
  const overflow = Math.max(0, (byY.at(-1)?.labelY ?? 0) - 205);
  if (overflow > 0)
    byY.forEach((point) => {
      point.labelY -= overflow;
    });
  const labelY = new Map(byY.map((point) => [point.label, point.labelY]));
  return (
    <div className="chart" style={{ height: 286 }}>
      <svg viewBox="0 0 420 260" role="img" aria-label="风险收益散点图">
        <g className="chart__grid">
          {[35, 80, 125, 170, 215].map((y) => (
            <line key={y} x1="52" y1={y} x2="400" y2={y} />
          ))}
        </g>
        <line x1="52" y1="22" x2="52" y2="215" stroke="#496070" />
        <line x1="52" y1="215" x2="400" y2="215" stroke="#496070" />
        {rendered.map((point) => {
          const anchor = point.x > 285 ? "end" : "start";
          const labelX = point.x + (anchor === "end" ? -12 : 12);
          const nextLabelY = labelY.get(point.label) ?? point.y;
          return (
            <g key={point.label}>
              <line
                x1={point.x}
                y1={point.y}
                x2={labelX}
                y2={nextLabelY - 4}
                stroke={point.color}
                strokeWidth="1"
                opacity=".7"
              />
              <circle
                cx={point.x}
                cy={point.y}
                r={radius(point.size)}
                fill={point.color}
                opacity=".9"
              />
              <text
                x={labelX}
                y={nextLabelY}
                textAnchor={anchor}
                fill="#dceaf5"
                fontSize="9"
              >
                {point.label}
              </text>
            </g>
          );
        })}
        <text x="226" y="251" textAnchor="middle" fill="#8da2b0" fontSize="10">
          最大回撤（绝对值）
        </text>
        <text
          x="12"
          y="118"
          transform="rotate(-90 12 118)"
          textAnchor="middle"
          fill="#8da2b0"
          fontSize="10"
        >
          净盈亏 USDC
        </text>
        <text x="52" y="232" fill="#8da2b0" fontSize="9">
          0
        </text>
        <text x="395" y="232" textAnchor="end" fill="#8da2b0" fontSize="9">
          {compact(maxX)}
        </text>
        <text x="43" y="217" textAnchor="end" fill="#8da2b0" fontSize="9">
          {compact(minY)}
        </text>
        <text x="43" y="39" textAnchor="end" fill="#8da2b0" fontSize="9">
          {compact(maxY)}
        </text>
      </svg>
    </div>
  );
}

function UnderwaterPlot({ result }: { result: BacktestResultV1 }) {
  const equity = result.equityCurve
    .map((point) => Number(point.equity))
    .filter(Number.isFinite);
  if (equity.length < 2)
    return (
      <EmptyState title="回撤时序不可用" detail="后端结果缺少足够资金点。" />
    );
  let peak = equity[0]!;
  const values = equity.map((value) => {
    peak = Math.max(peak, value);
    return value - peak;
  });
  const min = Math.min(...values, -1);
  const width = 420;
  const left = 46;
  const right = 404;
  const top = 24;
  const bottom = 216;
  const coords = values.map((value, index) => ({
    x: left + (index / Math.max(1, values.length - 1)) * (right - left),
    y: top + (value / min) * (bottom - top),
  }));
  const line = coords.map((point) => `${point.x},${point.y}`).join(" ");
  const area = `M ${left} ${top} L ${line.replaceAll(" ", " L ")} L ${right} ${top} Z`;
  return (
    <div className="chart" style={{ height: 286 }}>
      <svg viewBox={`0 0 ${width} 260`} role="img" aria-label="回撤水下图">
        <defs>
          <linearGradient
            id={`underwater-${result.runId.replace(/[^a-zA-Z0-9]/gu, "")}`}
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop offset="0" stopColor="#ff676f" stopOpacity=".08" />
            <stop offset="1" stopColor="#ff676f" stopOpacity=".52" />
          </linearGradient>
        </defs>
        <g className="chart__grid">
          {[top, 72, 120, 168, bottom].map((y) => (
            <line key={y} x1={left} y1={y} x2={right} y2={y} />
          ))}
        </g>
        <path
          d={area}
          fill={`url(#underwater-${result.runId.replace(/[^a-zA-Z0-9]/gu, "")})`}
        />
        <polyline points={line} fill="none" stroke="#ff7b82" strokeWidth="2" />
        <text
          x={left - 8}
          y={top + 4}
          textAnchor="end"
          fill="#8da2b0"
          fontSize="9"
        >
          0
        </text>
        <text
          x={left - 8}
          y={bottom}
          textAnchor="end"
          fill="#8da2b0"
          fontSize="9"
        >
          {compact(min)}
        </text>
        <text
          x={(left + right) / 2}
          y="246"
          textAnchor="middle"
          fill="#8da2b0"
          fontSize="10"
        >
          评估序列 · 最深回撤 {compact(min)} USDC
        </text>
      </svg>
    </div>
  );
}

function BaselineVerdict({
  comparisons,
  definitions,
}: {
  comparisons: readonly RunComparisonV1[];
  definitions: readonly StrategyDefinitionV1[];
}) {
  const baselines = comparisons.filter((item) =>
    /^B[0-3]_/u.test(item.strategyId),
  );
  const candidates = comparisons.filter(
    (item) => !/^B[0-3]_/u.test(item.strategyId),
  );
  if (baselines.length === 0 || candidates.length === 0) return null;
  const strongest = [...baselines].sort(
    (a, b) => Number(b.metrics.netPnl) - Number(a.metrics.netPnl),
  )[0]!;
  const candidate = [...candidates].sort(
    (a, b) => Number(b.metrics.netPnl) - Number(a.metrics.netPnl),
  )[0]!;
  const passed =
    Number(candidate.metrics.netPnl) > Number(strongest.metrics.netPnl);
  const name = (id: string) =>
    definitions.find((item) => item.strategyId === id)?.displayName ?? id;
  return (
    <section
      className={`baseline-verdict ${passed ? "baseline-verdict--pass" : "baseline-verdict--fail"}`}
      aria-label="自动基线判定"
    >
      <div>
        <span>自动基线门槛</span>
        <strong>
          {passed ? "本次净盈亏超过全部基线" : "本次未超过最强基线"}
        </strong>
        <p>
          候选 {name(candidate.strategyId)}：{candidate.metrics.netPnl}
          ；最强基线 {name(strongest.strategyId)}：{strongest.metrics.netPnl}。
        </p>
      </div>
      <div className="baseline-verdict__metrics">
        <span>
          候选回撤<b>{candidate.metrics.maxDrawdown}</b>
        </span>
        <span>
          基线回撤<b>{strongest.metrics.maxDrawdown}</b>
        </span>
        <span>
          候选 Brier<b>{candidate.metrics.brier ?? "不可用"}</b>
        </span>
        <span>
          基线 Brier<b>{strongest.metrics.brier ?? "不可用"}</b>
        </span>
      </div>
      <small>这是同口径描述性结果，不等于统计显著或未来盈利证明。</small>
    </section>
  );
}

function isBaselineStrategy(strategyId: string): boolean {
  return /^B[0-3]_/u.test(strategyId);
}

function strategyVersionKey(
  run: Pick<RunComparisonV1, "strategyId" | "strategyVersion">,
): string {
  return `${run.strategyId}@${run.strategyVersion}`;
}

function hasSelectionEvidence(
  run: RunComparisonV1,
  analytics: BacktestAnalytics | undefined,
): boolean {
  return [
    analytics?.returns.totalReturn,
    analytics?.returns.sharpe,
    Math.abs(Number(run.metrics.maxDrawdown)),
    analytics?.probability.brier ?? finiteOrNull(run.metrics.brier),
  ].every((value) => value !== null && value !== undefined && Number.isFinite(value));
}

function dominates(
  left: RunComparisonV1,
  right: RunComparisonV1,
  leftAnalytics: BacktestAnalytics | undefined,
  rightAnalytics: BacktestAnalytics | undefined,
): boolean {
  if (
    !hasSelectionEvidence(left, leftAnalytics) ||
    !hasSelectionEvidence(right, rightAnalytics)
  )
    return false;
  const leftValues = [
    leftAnalytics!.returns.totalReturn!,
    leftAnalytics!.returns.sharpe!,
    -Math.abs(Number(left.metrics.maxDrawdown)),
    -(leftAnalytics!.probability.brier ??
      finiteOrNull(left.metrics.brier)!),
  ];
  const rightValues = [
    rightAnalytics!.returns.totalReturn!,
    rightAnalytics!.returns.sharpe!,
    -Math.abs(Number(right.metrics.maxDrawdown)),
    -(rightAnalytics!.probability.brier ??
      finiteOrNull(right.metrics.brier)!),
  ];
  return (
    leftValues.every((value, index) => value >= rightValues[index]!) &&
    leftValues.some((value, index) => value > rightValues[index]!)
  );
}

function parameterFingerprint(
  parameters: Readonly<Record<string, string | number | boolean>>,
): string {
  return JSON.stringify(
    Object.entries(parameters).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function formatParameters(
  parameters: Readonly<Record<string, string | number | boolean>>,
): string {
  const values = Object.entries(parameters).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return values.length === 0
    ? "无可调参数"
    : values.map(([key, value]) => `${key}=${String(value)}`).join(" · ");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function latestRunPerStrategy(
  jobs: readonly BacktestJobV1[],
): BacktestJobV1[] {
  const seen = new Set<string>();
  return jobs.filter((job) => {
    if (job.strategyId === undefined || seen.has(job.strategyId)) return false;
    seen.add(job.strategyId);
    return true;
  });
}

function scopeName(value: RunComparisonV1["evaluationScope"]["split"]): string {
  return value === "TRAIN"
    ? "训练集"
    : value === "VALIDATION"
      ? "验证集"
      : "最终测试集";
}
function compact(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 2,
    notation: Math.abs(value) >= 10000 ? "compact" : "standard",
  }).format(value);
}
function signed(value: string | number): string {
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${compact(number)}`;
}
function finiteOrNull(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function formatMetric(value: number | null, digits: number): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}
function formatPercent(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "—"
    : `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}
function monotonicUtc(values: readonly string[]): boolean {
  let previous = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const current = Date.parse(value);
    if (!Number.isFinite(current) || current < previous) return false;
    previous = current;
  }
  return true;
}
function comparisonMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : "后端未返回错误详情";
  if (value.includes("evaluation cohort evidence is missing"))
    return "所选旧运行缺少数据分组和样本指纹，不能证明使用了同一批样本；请用修复后的新策略版本重新回测";
  if (value.includes("evaluated cohort must match"))
    return "所选运行使用了不同的数据分组、时间跨度、执行场景或样本集合，禁止直接排名";
  if (value.includes("dataset, fee, latency, cash and position"))
    return "所选运行的数据集、费用、延迟、初始资金或最大仓位不一致";
  return value;
}
