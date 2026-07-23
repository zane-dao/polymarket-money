import { useEffect, useState } from "react";
import { useWorkbenchCommands } from "../app/WorkbenchCommandContext.js";
import { useWorkbench } from "../app/WorkbenchContext.js";
import { useWorkbenchData } from "../app/WorkbenchDataContext.js";
import { AdvancedBacktestAnalysis, DerivedMetricSummary, ExecutionEvidence } from "../components/BacktestAnalysisPanels.js";
import { DecisionTable } from "../components/DecisionTable.js";
import { LineChart } from "../components/LineChart.js";
import { CalibrationDashboard, PnlDistribution } from "../components/QuantAnalysis.js";
import { Badge, EmptyState, formatCount, formatUtc, humanizeIdentifier, PageHeader, Panel } from "../components/ui.js";
import { deriveBacktestAnalytics } from "../domain/backtest-analytics.js";

import type { BacktestJobV1, BacktestRequestV1, BacktestResultV1, DatasetListItemV1, StrategyDefinitionV1 } from "../services/workbench-commands.js";

export function BacktestPage() {
  const commands = useWorkbenchCommands();
  const { state: workbenchState, dispatch } = useWorkbench();
  const { sourceKind, chartSeries, decisions, refresh: refreshWorkbench } = useWorkbenchData();
  const [request, setRequest] = useState<BacktestRequestV1>({ schemaVersion: "backtest-request-v1", requestId: `request-${Date.now()}`, strategyId: "", strategyVersion: "", datasetId: "", datasetVersionHash: "", feeModel: "fee-v2", latencyMs: 1000, initialCash: "1000", maxPosition: "100", evaluationSplit:"VALIDATION" }); const [definitions, setDefinitions] = useState<readonly StrategyDefinitionV1[]>([]); const [versions, setVersions] = useState<readonly string[]>([]); const [datasets, setDatasets] = useState<readonly DatasetListItemV1[]>([]); const [jobs,setJobs]=useState<readonly BacktestJobV1[]>([]); const [job, setJob] = useState<BacktestJobV1 | null>(null); const [result, setResult] = useState<BacktestResultV1 | null>(null); const [message, setMessage] = useState(commands === null ? "本地命令桥接不可用，回测启动已安全禁用" : "正在从后端加载策略与数据集…"); const [busy, setBusy] = useState(false); const [initializingResult, setInitializingResult] = useState(commands !== null);
  useEffect(() => {
    if (commands === null) return;
    let active = true;
    Promise.all([
      commands.listStrategyDefinitions(),
      commands.listDatasets(),
      commands.listBacktestJobs(),
    ])
      .then(async ([nextDefinitions, nextDatasets, nextJobs]) => {
        if (!active) return;
        setDefinitions(nextDefinitions);
        setDatasets(nextDatasets.datasets);
        setJobs(nextJobs);
        const session = workbenchState.researchSession;
        const requested =
          session.strategyId ?? workbenchState.selectedStrategyId;
        const requestedStrategy = nextDefinitions.find(
          (item) =>
            item.strategyId === requested &&
            item.allowedModes.includes("backtest") &&
            !/^B[0-3]_/u.test(item.strategyId),
        );
        const strategy =
          requestedStrategy ??
          nextDefinitions.find(
            (item) =>
              item.allowedModes.includes("backtest") &&
              !/^B[0-3]_/u.test(item.strategyId),
          );
        const dataset =
          nextDatasets.datasets.find(
            (item) =>
              item.datasetId === session.datasetId &&
              item.versionHash === session.datasetVersionHash,
          ) ?? nextDatasets.datasets[0];
        const nextVersions =
          strategy === undefined
            ? []
            : await commands.listStrategyVersions(strategy.strategyId);
        if (!active) return;
        const requestedVersion =
          session.strategyVersion ?? workbenchState.selectedStrategyVersion;
        const selectedVersion =
          requestedVersion !== null &&
          nextVersions.includes(requestedVersion)
            ? requestedVersion
            : (nextVersions.at(-1) ?? "");
        setVersions(nextVersions);
        const restored = {
          strategyId: strategy?.strategyId ?? "",
          strategyVersion: selectedVersion,
          datasetId: dataset?.datasetId ?? "",
          datasetVersionHash: dataset?.versionHash ?? "",
          evaluationSplit: session.evaluationSplit,
          feeModel: session.feeModel,
          latencyMs: session.latencyMs,
          initialCash: session.initialCash,
          maxPosition: session.maxPosition,
        };
        setRequest((current) => ({ ...current, ...restored }));
        dispatch({
          type: "update-research-session",
          patch: { ...restored, stage: "assumptions" },
        });

        const succeeded = nextJobs.filter(
          (item) => item.status === "succeeded",
        );
        const restoredJob = succeeded.find(
          (item) => item.runId === session.runId,
        );
        const latestCandidate = succeeded.find(
          (item) => !/^B[0-3]_/u.test(item.strategyId ?? ""),
        );
        const initialJob = restoredJob ?? latestCandidate ?? succeeded[0];
        if (initialJob !== undefined) {
          setJob(initialJob);
          const nextResult = await commands.getBacktestResult(initialJob.runId);
          if (!active) return;
          applyResult(nextResult);
          await refreshWorkbench();
          if (!active) return;
          setMessage(`已自动恢复运行结果 ${nextResult.runId}`);
          setInitializingResult(false);
          return;
        }
        setMessage(
          strategy === undefined ||
            dataset === undefined ||
            nextVersions.length === 0
            ? "请先保存策略版本并发布可验证的数据集"
            : "尚无成功运行；确认假设并运行后将自动进入分析视图",
        );
        setInitializingResult(false);
      })
      .catch((error: unknown) => {
        if (active) {
          setMessage(
            error instanceof Error ? error.message : "回测配置加载失败",
          );
          setInitializingResult(false);
        }
      });
    return () => {
      active = false;
    };
  }, [commands]);
  useEffect(()=>{if(commands===null||job===null||!(job.status==="queued"||job.status==="running"||job.status==="stopping"))return;let active=true;const timer=window.setInterval(()=>{commands.getBacktestJob(job.runId).then(async(next)=>{if(!active)return;setJob(next);setJobs(await commands.listBacktestJobs());if(next.status==="succeeded")await loadResult(next.runId);else setMessage(`任务状态：${next.status} · ${next.progressPermille/10}%`);}).catch((error:unknown)=>{if(active)setMessage(error instanceof Error?error.message:"任务轮询失败");});},1000);return()=>{active=false;window.clearInterval(timer);};},[commands,job?.runId,job?.status]);
  async function selectStrategy(strategyId: string) { field("strategyId", strategyId); if (commands === null) return; const next = await commands.listStrategyVersions(strategyId); setVersions(next); field("strategyVersion", next.at(-1) ?? ""); }
  function selectDataset(value: string) { const dataset = datasets.find((item) => `${item.datasetId}:${item.versionHash}` === value); if (dataset !== undefined) { setRequest((current) => ({ ...current, datasetId: dataset.datasetId, datasetVersionHash: dataset.versionHash })); dispatch({ type: "update-research-session", patch: { datasetId: dataset.datasetId, datasetVersionHash: dataset.versionHash } }); } }
  function field<K extends keyof BacktestRequestV1>(key: K, value: BacktestRequestV1[K]) { setRequest((current) => ({ ...current, [key]: value })); if (["strategyId","strategyVersion","evaluationSplit","feeModel","latencyMs","initialCash","maxPosition"].includes(key)) dispatch({ type: "update-research-session", patch: { [key]: value } }); }
  function applyResult(nextResult: BacktestResultV1) {
    setResult(nextResult);
    setRequest((current) => ({
      ...current,
      strategyId: nextResult.request.strategyId,
      strategyVersion: nextResult.request.strategyVersion,
      datasetId: nextResult.request.datasetId,
      datasetVersionHash: nextResult.request.datasetVersionHash,
      feeModel: nextResult.request.feeModel,
      latencyMs: nextResult.request.latencyMs,
      initialCash: nextResult.request.initialCash,
      maxPosition: nextResult.request.maxPosition,
      evaluationSplit: nextResult.request.evaluationSplit ?? "VALIDATION",
    }));
    dispatch({
      type: "update-research-session",
      patch: {
        runId: nextResult.runId,
        strategyId: nextResult.request.strategyId,
        strategyVersion: nextResult.request.strategyVersion,
        datasetId: nextResult.request.datasetId,
        datasetVersionHash: nextResult.request.datasetVersionHash,
        feeModel: nextResult.request.feeModel,
        latencyMs: nextResult.request.latencyMs,
        initialCash: nextResult.request.initialCash,
        maxPosition: nextResult.request.maxPosition,
        evaluationSplit: nextResult.request.evaluationSplit ?? "VALIDATION",
        comparisonRunIds: [nextResult.runId],
        stage: "analysis",
      },
    });
  }
  async function loadResult(runId: string) {
    if (commands === null) return;
    const nextResult = await commands.getBacktestResult(runId);
    applyResult(nextResult);
    await refreshWorkbench();
    setMessage(`已进入运行结果 ${nextResult.runId}`);
  }
  async function start() { if (commands === null) return; const strategy = definitions.find((item) => item.strategyId === request.strategyId); const dataset = datasets.find((item) => item.datasetId === request.datasetId && item.versionHash === request.datasetVersionHash); const requestId = `backtest-${Date.now()}-${request.strategyId}`; const namedRequest = { ...request, requestId, displayName: request.displayName?.trim() || `${strategy?.displayName ?? request.strategyId} · ${dataset?.displayName ?? humanizeIdentifier(request.datasetId)} · ${request.evaluationSplit === "FINAL_TEST" ? "最终测试" : "验证"}`, description: request.description?.trim() || `${strategy?.displayName ?? request.strategyId} ${request.strategyVersion}，${dataset?.displayName ?? request.datasetId}，${request.evaluationSplit === "FINAL_TEST" ? "最终测试" : "验证"}。` }; setBusy(true); setResult(null); try { const next = await commands.startBacktest(namedRequest); setJob(next); setJobs(await commands.listBacktestJobs()); setMessage(`后端已接受任务 ${next.displayName ?? next.runId}`); if (next.status === "succeeded") await loadResult(next.runId); } catch (error) { setMessage(error instanceof Error ? error.message : "回测启动失败"); } finally { setBusy(false); } }
  async function refresh() { if (commands === null || job === null) return; setBusy(true); try { const next = await commands.getBacktestJob(job.runId); setJob(next); setMessage(`任务状态：${next.status} · ${next.progressPermille / 10}%`); if (next.status === "succeeded") await loadResult(next.runId); } catch (error) { setMessage(error instanceof Error ? error.message : "状态查询失败"); } finally { setBusy(false); } }
  async function stop() { if (commands === null || job === null) return; setBusy(true); try { const next = await commands.stopBacktest(job.runId); setJob(next); setMessage(`停止请求已提交：${next.status}`); } catch (error) { setMessage(error instanceof Error ? error.message : "停止失败"); } finally { setBusy(false); } }
  async function deleteRun(run:BacktestJobV1){if(commands===null||["queued","running","stopping"].includes(run.status)||!window.confirm(`删除回测任务及结果？\n\n${run.runId}\n\n此操作不可撤销。`))return;setBusy(true);try{await commands.deleteBacktest(run.runId);const next=await commands.listBacktestJobs();setJobs(next);if(job?.runId===run.runId){setJob(null);setResult(null);}setMessage(`已删除回测任务及结果 ${run.runId}`);}catch(error){setMessage(error instanceof Error?error.message:"回测删除失败");}finally{setBusy(false);}}
  const availableDefinitions = definitions.filter((item) => item.allowedModes.includes("backtest") && !/^B[0-3]_/u.test(item.strategyId));
  const runnable = commands !== null && request.strategyId !== "" && request.strategyVersion !== "" && request.datasetId !== "" && request.datasetVersionHash !== "";
  const selectedDataset = datasets.find((item) => item.datasetId === request.datasetId && item.versionHash === request.datasetVersionHash);
  return <><PageHeader title="回测实验室（Backtest Lab）" subtitle={result === null ? "先检查数据与执行假设，再提交一次可审计的 Paper 回测。" : "已恢复最近成功运行，以下指标和图表均来自该运行的后端结果。"} action={<div className="toolbar"><button className="button" disabled={commands === null || job === null || busy} onClick={() => void refresh()}>刷新状态</button><button className="button" disabled={commands === null || job === null || busy || !["queued", "running"].includes(job.status)} onClick={() => void stop()}>停止任务</button><button className="button button--primary" aria-label="运行回测" disabled={!runnable || busy} onClick={() => void start()}>确认假设并运行回测</button></div>} />
    {sourceKind !== "preview" && result !== null ? <VerifiedBacktestResult result={result} definitions={definitions} datasets={datasets} onNavigate={(routeId) => dispatch({ type: "navigate", routeId })} /> : null}
    <details className="backtest-workflow-details" open={result === null && !initializingResult}>
      <summary>{result === null ? "配置并运行回测" : "运行配置与任务历史"}</summary>
    <section className="summary-strip summary-strip--workflow" aria-label="当前回测配置"><span>策略<b>{definitions.find((item) => item.strategyId === request.strategyId)?.displayName ?? "未选择"}</b></span><span>版本<b>{request.strategyVersion || "未选择"}</b></span><span>数据集<b>{selectedDataset?.displayName ?? "未选择"}</b></span><span>数据覆盖<b>{selectedDataset === undefined ? "—" : `${formatUtc(selectedDataset.startTimeUtc)} — ${formatUtc(selectedDataset.endTimeUtc)}`}</b></span></section>
    <div id="execution-assumptions" className="analysis-anchor"><Panel title="执行假设" english="Execution Assumptions"><div className="assumption-summary"><span><small>数据分组</small><select aria-label="回测数据分组" value={request.evaluationSplit} onChange={(event)=>field("evaluationSplit",event.target.value as "VALIDATION"|"FINAL_TEST")}><option value="VALIDATION">验证集（允许同批样本比较）</option><option value="FINAL_TEST">最终测试集（冻结检验）</option></select></span><span><small>手续费</small><b>{request.feeModel}</b></span><span><small>执行延迟</small><b>{request.latencyMs} ms</b></span><span><small>成交性质</small><b>Paper 模拟成交</b></span></div><p className="panel-note">这些字段会随请求提交并由后端校验；比较页只接受数据分组、时间跨度、执行场景和样本指纹完全一致的运行。</p></Panel></div>
    <Panel title="1. 配置模拟回测" english="Create Paper Backtest" action={<Badge tone={job?.status === "failed" ? "bad" : job === null ? "info" : "good"}>{job === null ? "尚未启动" : `${job.status.toUpperCase()} · ${job.progressPermille / 10}%`}</Badge>}>
      <div className="adaptive-form">
        <label className="field-span-4">策略<select aria-label="回测策略" value={request.strategyId} onChange={(event) => void selectStrategy(event.target.value)}><option value="">请选择</option>{availableDefinitions.map((item) => <option key={item.strategyId} value={item.strategyId}>{item.displayName}</option>)}</select></label>
        <label className="field-span-2">策略版本<select aria-label="回测策略版本" value={request.strategyVersion} onChange={(event) => field("strategyVersion", event.target.value)}><option value="">请选择</option>{versions.map((version) => <option key={version}>{version}</option>)}</select></label>
        <label className="field-span-6">数据集<select aria-label="回测数据集" value={request.datasetId === "" ? "" : `${request.datasetId}:${request.datasetVersionHash}`} onChange={(event) => selectDataset(event.target.value)}><option value="">请选择后端已验证版本</option>{datasets.map((item) => <option key={`${item.datasetId}:${item.versionHash}`} value={`${item.datasetId}:${item.versionHash}`}>{item.displayName} · {formatCount(item.rowCount)} 条 · {item.versionHash.slice(0, 8)}</option>)}</select></label>
        <label className="field-span-3">初始资金（USDC）<input aria-label="初始资金" value={request.initialCash} onChange={(event) => field("initialCash", event.target.value)} /></label>
        <label className="field-span-3">最大仓位（USDC）<input aria-label="最大仓位" value={request.maxPosition} onChange={(event) => field("maxPosition", event.target.value)} /></label>
        <label className="field-span-3">执行延迟<input aria-label="延迟毫秒" type="number" min="1000" max="1000" value={request.latencyMs} readOnly /><small>固定 1000 ms</small></label>
        <label className="field-span-3">手续费模型<input aria-label="手续费模型" value={request.feeModel} readOnly /></label>
        <label className="field-span-6">运行名称<input aria-label="回测运行名称" maxLength={240} placeholder="留空则按当前策略与数据集自动生成" value={request.displayName ?? ""} onChange={(event) => field("displayName", event.target.value || undefined)} /></label>
        <label className="field-span-6">运行说明<input aria-label="回测运行说明" maxLength={240} placeholder="留空则按当前配置自动生成" value={request.description ?? ""} onChange={(event) => field("description", event.target.value || undefined)} /></label>
      </div>
      <p className="panel-note">点击一次会由后端自动追加 B0–B3 四个同口径研究对照；请求与运行 ID 仅用于审计。</p>
      <pre className="console strategy-log" role="status">{message}</pre>
    </Panel>
    <div id="backtest-jobs" className="analysis-anchor"><Panel title="2. 回测任务历史" english="Persisted Backtest Jobs">
      {jobs.length===0 ? <EmptyState title="尚无后端回测任务" detail="创建任务后会持久化并显示在这里。"/> : <table className="data-table"><thead><tr><th>实际策略</th><th>运行名称</th><th>技术标识</th><th>状态</th><th>进度</th><th>操作</th></tr></thead><tbody>{jobs.map((item)=><tr key={item.runId}><td>{definitions.find((definition) => definition.strategyId === item.strategyId)?.displayName ?? (item.strategyId === undefined ? "旧任务未记录" : item.strategyId)}{item.strategyVersion === undefined ? null : <> <small>v{item.strategyVersion}</small></>}</td><td>{item.displayName ?? "历史运行（未记录名称）"}</td><td><details className="technical-details"><summary>查看 ID</summary><code>{item.runId}<br />{item.requestId}</code></details></td><td>{item.status}</td><td>{item.progressPermille/10}%</td><td><div className="toolbar"><button className="button" onClick={()=>{setJob(item);if(item.status==="succeeded")void loadResult(item.runId);}}>选择</button><button className="button button--danger" disabled={busy||["queued","running","stopping"].includes(item.status)} onClick={()=>void deleteRun(item)}>删除</button></div></td></tr>)}</tbody></table>}
    </Panel></div>
    </details>
    {sourceKind === "preview" ? <><div className="backtest-summary"><Panel title="运行元数据" english="Run Metadata" action={<Badge tone="good">COMPLETE 完成</Badge>}><div className="metadata-grid"><span>运行 ID<b>BT-20260718-0042</b></span><span>策略<b>K-Edge v0.4</b></span><span>数据集<b>BTC5M-L2-v2</b></span><span>时间区间<b>06-01 → 07-15</b></span><span>Git 提交<b>73c0b8d</b></span><span>配置哈希<b>e41a2c9</b></span></div></Panel><div className="backtest-kpis"><MiniKpi label="净盈亏" value="+214.80" tone="positive"/><MiniKpi label="毛盈亏" value="+278.61"/><MiniKpi label="手续费" value="−63.81" tone="negative"/><MiniKpi label="最大回撤" value="−41.70" tone="negative"/><MiniKpi label="成交笔数" value="286"/><MiniKpi label="成交率" value="71.5%"/><MiniKpi label="胜率" value="58.7%"/><MiniKpi label="平均每笔" value="+0.75" tone="positive"/><MiniKpi label="Brier @ T−60s" value="0.0941"/><MiniKpi label="Log Loss" value="0.318"/><MiniKpi label="可估市场" value="412"/><MiniKpi label="未验证市场" value="37" tone="amber"/></div></div>
    <div className="backtest-chart-grid"><Panel title="累计净盈亏与回撤" english="Cumulative Net PnL & Drawdown"><LineChart series={[{label:"累计净盈亏",points:chartSeries.pnl.map((value,index)=>({x:index,value})),color:"#4fd17d"},{label:"回撤",points:chartSeries.pnl.map((value,index)=>({x:index,value:value-Math.max(...chartSeries.pnl.slice(0,index+1))})),color:"#ff676f"}]} /></Panel><Panel title="概率校准图" english="Reliability Diagram"><LineChart series={[{label:"实际频率",points:[6,16,27,42,50,64,75,79,90].map((value,index)=>({x:index,value})),color:"#4f91ff"},{label:"理想校准",points:[8,18,29,39,51,61,72,83,92].map((value,index)=>({x:index,value})),color:"#71818d"}]} /></Panel></div>
    <div className="backtest-lower"><Panel title="滚动布里尔分数" english="Rolling Brier Score"><LineChart height={230} series={[{label:"Brier",points:chartSeries.brier.map((value,index)=>({x:index,value})),color:"#4f91ff"}]} /></Panel><Panel title="分组表现" english="Grouped Performance"><div className="bar-list">{[["0–0.25%","−8.4",18,"negative"],["0.25–0.5%","+21.7",42,"positive"],["0.5–1.0%","+76.2",68,"positive"],["1.0–2.0%","+102.1",88,"positive"],[">2.0%","+23.2",36,"positive"]].map(([label,value,width,tone])=><div key={String(label)}><span>{label}</span><i><b style={{width:`${width}%`}} /></i><strong className={String(tone)}>{value}</strong></div>)}</div></Panel></div>
    <Panel title="回测决策账本" english="Backtest Decision Ledger"><DecisionTable rows={decisions} /></Panel></> : result === null ? <Panel title="回测结果" english="Backtest Result"><EmptyState title={initializingResult ? "正在恢复最近运行" : "尚无成功回测结果"} detail={initializingResult ? "正在读取成功任务及其后端结果；完成后会自动进入分析视图。" : job === null ? "当前没有成功运行。确认假设并运行后，结果会自动显示在页面顶部。" : `任务 ${job.runId} 当前状态为 ${job.status}。`} /></Panel> : null}
  </>;
}

function MiniKpi({label,value,tone=""}:{label:string;value:string;tone?:string}){return <article><span>{label}</span><strong className={tone}>{value}</strong></article>}

function VerifiedBacktestResult({ result, definitions, datasets, onNavigate }: { result: BacktestResultV1; definitions: readonly StrategyDefinitionV1[]; datasets: readonly DatasetListItemV1[]; onNavigate: (routeId: "replay" | "compare" | "live") => void }) {
  const analytics = deriveBacktestAnalytics(result);
  const equity = result.equityCurve.map((point) => Number(point.equity)).filter(Number.isFinite);
  const initialEquity = equity[0] ?? 0;
  const cumulativePnl = equity.map((value) => value - initialEquity);
  let peak = equity[0] ?? 0;
  const drawdown = equity.map((value) => { peak = Math.max(peak, value); return value - peak; });
  const useUtcEquityAxis = monotonicUtc(result.equityCurve.map((point) => point.timeUtc));
  const strategy = definitions.find((item) => item.strategyId === result.request.strategyId);
  const dataset = datasets.find((item) => item.datasetId === result.request.datasetId && item.versionHash === result.request.datasetVersionHash);
  const pnl = Number(result.metrics.netPnl);
  const profitable = Number.isFinite(pnl) && pnl > 0;
  return <>
    <nav className="analysis-navigator" aria-label="结果分析目录">
      <a href="#core-risk">核心收益风险</a><a href="#probability-quality">概率质量</a><a href="#execution-diagnostics">交易与执行</a><a href="#parameter-robustness">参数稳健性</a>
    </nav>
    <section className="decision-overview" id="decision-overview" aria-label="回测决策总览">
      <div className="decision-overview__verdict"><span>决策总览</span><strong>{profitable ? "本次为正，但尚不足以进入 Paper" : "本次未证明值得进入 Paper"}</strong><p>当前只有单次后端结果。稳定性、风险调整收益和相对基准改善尚未形成完整证据。</p></div>
      <div className="decision-overview__questions">
        <span>是否盈利<b className={profitable ? "positive" : "negative"}>{profitable ? `是 · ${storedNumber(result.metrics.netPnl)}` : `否 · ${storedNumber(result.metrics.netPnl)}`}</b></span>
        <span>是否稳定<b className="amber">证据不足</b></span>
        <span>风险多大<b>{storedNumber(result.metrics.maxDrawdown)} 最大回撤</b></span>
        <span>相比基准<b>请在效果比较查看</b></span>
        <span>Paper 准入<b className="negative">未通过</b></span>
      </div>
      <div className="workflow-action-bar"><button className="button" onClick={() => onNavigate("replay")}>回放这次运行</button><button className="button" onClick={() => onNavigate("compare")}>加入同口径比较</button><button className="button button--primary" title="进入评审不代表 Gate 已通过，也不会自动启动 Paper" onClick={() => onNavigate("live")}>进入 Paper 评审</button></div>
    </section>
    <section id="core-risk" className="core-risk">
      <div className="backtest-summary">
        <div className="backtest-kpis">
          <MiniKpi label="净盈亏" value={storedNumber(result.metrics.netPnl)} tone={profitable ? "positive" : "negative"} />
          <MiniKpi label="总回报" value={metricPercent(analytics.returns.totalReturn)} tone={profitable ? "positive" : "negative"} />
          <MiniKpi label="Sharpe（夏普）" value={metricNumber(analytics.returns.sharpe)} />
          <MiniKpi label="Sortino（索提诺）" value={metricNumber(analytics.returns.sortino)} />
          <MiniKpi label="Profit Factor" value={metricNumber(analytics.returns.profitFactor)} />
          <MiniKpi label="最大回撤 / CVaR95" value={`${storedNumber(result.metrics.maxDrawdown)} / ${metricNumber(analytics.returns.cvar95, 2)}`} tone="negative" />
        </div>
        <details className="technical-details backtest-metadata-details">
          <summary>运行口径 · {result.request.displayName ?? strategy?.displayName ?? "历史运行"} · 已完成</summary>
          {result.request.description === undefined ? null : <p className="panel-note">{result.request.description}</p>}
          <div className="metadata-grid"><span>策略<b>{strategy?.displayName ?? "历史策略（未记录名称）"} v{result.request.strategyVersion}</b></span><span>数据集<b>{dataset?.displayName ?? "历史数据集（未记录名称）"}</b></span><span>数据分组<b>{result.evaluationScope === undefined ? "未记录" : result.evaluationScope.split}</b></span><span>样本数<b>{result.evaluationScope?.cohortSize ?? "未记录"}</b></span><span>开始时间<b>{formatUtc(result.startedAtUtc)}</b></span><span>完成时间<b>{formatUtc(result.completedAtUtc)}</b></span><span>事件数<b>{result.events.length}</b></span></div>
          <code className="backtest-technical-ids">运行：{result.runId}<br />请求：{result.request.requestId}<br />策略：{result.request.strategyId}<br />数据集：{result.request.datasetId}</code>
        </details>
      </div>
      <div className="backtest-chart-grid"><Panel title="累计 PnL + 回撤" english={`Cumulative Net PnL · ${useUtcEquityAxis ? "UTC" : "Evaluation Sequence"}`}>{cumulativePnl.length > 1 ? <><LineChart unit=" USDC" xLabel={useUtcEquityAxis ? "UTC 时间" : "评估样本序号"} series={[{ label: "累计净盈亏", points: result.equityCurve.map((point,index)=>({x:useUtcEquityAxis?point.timeUtc:index,value:cumulativePnl[index]!})), color: "#4fd17d" },{ label: "回撤", points: result.equityCurve.map((point,index)=>({x:useUtcEquityAxis?point.timeUtc:index,value:drawdown[index]!})), color: "#ff676f" }]} />{useUtcEquityAxis ? null : <p className="panel-note">资金点时间非单调，按冻结评估顺序绘制；不会伪装成连续 UTC 时间线。</p>}</> : <EmptyState title="收益与回撤曲线不可用" detail="后端结果未包含足够的真实资金点。" />}</Panel><Panel title="单市场 PnL 分布" english="Tail Risk & Outliers"><PnlDistribution result={result} /></Panel></div>
    </section>

    <details className="analysis-disclosure" id="return-risk-detail">
      <summary><span>补充风险指标</span><small>Calmar、VaR、恢复期与收益尾部</small></summary>
      <div className="analysis-disclosure__body">
        <DerivedMetricSummary result={result} />
        <AnalysisSection id="return-risk-metrics" title="收益与风险明细" english="Return & Risk Evidence" metrics={[["Net PnL",storedNumber(result.metrics.netPnl),"verified"],["Sharpe / Sortino / Calmar",`${metricNumber(analytics.returns.sharpe)} / ${metricNumber(analytics.returns.sortino)} / ${metricNumber(analytics.returns.calmar)}`,analytics.returns.sharpe===null?"missing":"verified"],["最大回撤",storedNumber(result.metrics.maxDrawdown),"verified"],["恢复样本数",analytics.returns.recoverySamples===null?"尚未恢复":String(analytics.returns.recoverySamples),"verified"],["VaR95 / CVaR95",`${metricNumber(analytics.returns.var95)} / ${metricNumber(analytics.returns.cvar95)}`,analytics.returns.var95===null?"missing":"verified"],["Profit Factor",metricNumber(analytics.returns.profitFactor),analytics.returns.profitFactor===null?"missing":"verified"],["收益集中度","后端待计算","missing"],["滚动 Sharpe",analytics.returns.rollingSharpe.length>1?"已计算":"样本不足",analytics.returns.rollingSharpe.length>1?"verified":"missing"]]} />
      </div>
    </details>

    <details className="analysis-disclosure" id="probability-quality">
      <summary><span>概率质量</span><small>Brier {storedNumber(result.metrics.brier, 4)} · ECE {metricPercent(analytics.probability.ece)} · 点击展开校准图和分桶</small></summary>
      <div className="analysis-disclosure__body">
        <AnalysisSection id="probability-metrics" title="概率质量明细" english="Probability Quality Evidence" metrics={[["Brier Score", storedNumber(result.metrics.brier, 4), analytics.probability.brier === null ? "missing" : "verified"],["Log Loss",metricNumber(analytics.probability.logLoss),analytics.probability.logLoss === null ? "missing" : "verified"],["ECE / MCE",`${metricPercent(analytics.probability.ece)} / ${metricPercent(analytics.probability.mce)}`,analytics.probability.ece === null ? "missing" : "verified"],["Calibration slope / intercept","后端待计算","missing"],["Brier decomposition",analytics.probability.reliability === null ? "不可用" : "已计算","verified"],["概率分桶",analytics.probability.buckets.some((bucket)=>bucket.count>0)?"10 桶已计算":"不可用",analytics.probability.observations.length===0?"missing":"verified"],["Rolling Brier",analytics.probability.rollingBrier.length>1?"已计算":"样本不足",analytics.probability.rollingBrier.length>1?"verified":"missing"]]} />
        <CalibrationDashboard result={result} strategyName={strategy?.displayName ?? result.request.strategyId} />
      </div>
    </details>

    <details className="analysis-disclosure" id="execution-diagnostics">
      <summary><span>交易与执行</span><small>{analytics.execution.decisions} 次决策 · {analytics.execution.fills} 次模拟成交 · 费用 {storedNumber(result.metrics.fees)}</small></summary>
      <div className="analysis-disclosure__body">
        <AnalysisSection id="execution-metrics" title="执行证据明细" english="Trading & Execution Evidence" metrics={[["决策 / 订单 / 成交",`${analytics.execution.decisions} / ${analytics.execution.orders} / ${analytics.execution.fills}`,"verified"],["成交率",storedPercent(result.metrics.fillRate),"verified"],["胜率",storedPercent(result.metrics.winRate),result.metrics.winRate === null ? "missing" : "verified"],["累计意向 / 批准数量",`${metricNumber(analytics.execution.intendedQuantity)} / ${metricNumber(analytics.execution.approvedQuantity)}`,"verified"],["费用",storedNumber(result.metrics.fees),"verified"],["平均盘口参与率",metricPercent(analytics.execution.meanBookParticipation),analytics.execution.meanBookParticipation===null?"missing":"verified"],["Gross Edge → Net Edge",`${metricPercent(analytics.execution.meanGrossEdge)} → ${metricPercent(analytics.execution.meanNetEdge)}`,analytics.execution.meanGrossEdge===null?"missing":"verified"],["风险审查状态",Object.keys(analytics.execution.riskStatusCounts).length===0?"未记录":`${Object.keys(analytics.execution.riskStatusCounts).length} 类`,Object.keys(analytics.execution.riskStatusCounts).length===0?"missing":"verified"]]} />
        <ExecutionEvidence result={result} />
      </div>
    </details>

    <details className="analysis-disclosure" id="parameter-robustness">
      <summary><span>参数与稳健性</span><small>冻结配置、真实滚动指标与尚未生成的实验</small></summary>
      <div className="analysis-disclosure__body"><AdvancedBacktestAnalysis result={result} /></div>
    </details>

    <details className="analysis-disclosure">
      <summary><span>原始回测事件</span><small>{result.events.length} 条 · 仅在审计时展开</small></summary>
      <div className="analysis-disclosure__body"><Panel title="回测事件" english="Backtest Events">{result.events.length === 0 ? <EmptyState title="没有回测事件" detail="后端结果未返回决策、订单、成交或结算事件。" /> : <table className="data-table"><thead><tr><th>时间</th><th>类型</th><th>原因/状态</th><th>技术详情</th></tr></thead><tbody>{result.events.map((event) => <tr key={event.eventId}><td>{formatUtc(event.eventTimeUtc)}</td><td>{eventKindName(event.kind)}</td><td>{String(event.payload.reason ?? event.payload.status ?? "—")}</td><td><details className="technical-details"><summary>查看事件 ID</summary>{event.eventId}</details></td></tr>)}</tbody></table>}</Panel></div>
    </details>
  </>;
}

function AnalysisSection({ id, title, english, metrics }: { id: string; title: string; english: string; metrics: readonly (readonly [string,string,"verified"|"partial"|"missing"])[] }) {
  return <div id={id} className="analysis-anchor"><Panel title={title} english={english} className="analysis-section"><div className="analysis-metrics">{metrics.map(([label,value,state])=><article key={label} data-state={state}><span>{label}</span><strong>{value}</strong><small>{state === "verified" ? "后端证据" : state === "partial" ? "部分证据" : "未计算"}</small></article>)}</div></Panel></div>;
}

function eventKindName(kind: string): string { return ({ decision: "策略判断", order: "模拟订单", fill: "模拟成交", settlement: "结算" } as Readonly<Record<string, string>>)[kind] ?? humanizeIdentifier(kind); }
function monotonicUtc(values:readonly string[]):boolean{let previous=Number.NEGATIVE_INFINITY;for(const value of values){const current=Date.parse(value);if(!Number.isFinite(current)||current<previous)return false;previous=current;}return true;}
function metricNumber(value:number|null,digits=3):string{return value===null||!Number.isFinite(value)?"—":value.toFixed(digits);}
function metricPercent(value:number|null):string{return value===null||!Number.isFinite(value)?"—":`${(value*100).toFixed(2)}%`;}
function storedNumber(value:string|null|undefined,digits=2):string{if(value===null||value===undefined)return "—";const number=Number(value);return Number.isFinite(number)?number.toLocaleString("zh-CN",{minimumFractionDigits:digits,maximumFractionDigits:digits}):"—";}
function storedPercent(value:string|null|undefined):string{if(value===null||value===undefined)return "—";const number=Number(value);return Number.isFinite(number)?`${(number*100).toFixed(1)}%`:"—";}
