import { useEffect, useState } from "react";

import { WorkbenchProvider, useWorkbench } from "../workbench/app/WorkbenchContext.js";
import { WorkbenchDataProvider, useWorkbenchData } from "../workbench/app/WorkbenchDataContext.js";
import { AppShell } from "../workbench/layout/AppShell.js";
import { BacktestPage } from "../workbench/pages/BacktestPage.js";
import { ComparePage } from "../workbench/pages/ComparePage.js";
import { DecisionsPage } from "../workbench/pages/DecisionsPage.js";
import { HealthPage } from "../workbench/pages/HealthPage.js";
import { LivePage } from "../workbench/pages/LivePage.js";
import { OverviewPage } from "../workbench/pages/OverviewPage.js";
import { ReplayPage } from "../workbench/pages/ReplayPage.js";
import { StrategyPage } from "../workbench/pages/StrategyPage.js";
import { DatasetPage } from "../workbench/pages/DatasetPage.js";
import type { WorkbenchRouteId } from "../workbench/domain/workbench.js";
import { ThemeProvider } from "../workbench/app/ThemeContext.js";
import type { WorkbenchViewData } from "../workbench/domain/read-model.js";
import type { WorkbenchDataSource } from "../workbench/ports/workbench-data-source.js";
import { WorkbenchCommandProvider, useWorkbenchCommands } from "../workbench/app/WorkbenchCommandContext.js";
import type { WorkbenchCommands } from "../workbench/services/workbench-commands.js";
import { PREVIEW_WORKBENCH_DATA } from "../workbench/data/preview-data.js";
import { Badge } from "../workbench/components/ui.js";

const pages: Record<WorkbenchRouteId, () => React.JSX.Element> = {
  overview: OverviewPage,
  live: LivePage,
  decisions: DecisionsPage,
  strategy: StrategyPage,
  datasets: DatasetPage,
  backtest: BacktestPage,
  replay: ReplayPage,
  compare: ComparePage,
  health: HealthPage,
};

const EMPTY_VERIFIED_WORKBENCH_DATA: WorkbenchViewData = Object.freeze({
  sourceKind: "verified-local",
  decisions: Object.freeze([]),
  runs: Object.freeze([]),
  chartSeries: Object.freeze({ raw: Object.freeze([]), calibrated: Object.freeze([]), bid: Object.freeze([]), ask: Object.freeze([]), pnl: Object.freeze([]), brier: Object.freeze([]) }),
});

function RoutedWorkbench() {
  const { state } = useWorkbench();
  const data = useWorkbenchData();
  const commands = useWorkbenchCommands();
  const Page = pages[state.activeRoute];
  const verifiedDataMissing = data.sourceKind === "verified-local" &&
    data.decisions.length === 0 && data.runs.length === 0 &&
    Object.values(data.chartSeries).every((series) => series.length === 0);
  const showDemo = data.sourceKind === "verified-local" &&
    (state.dataView === "demo" || (state.dataView === "auto" && verifiedDataMissing && (commands === null || data.loadError !== null)));
  return <AppShell>{showDemo ? <>
    <section className="demo-data-banner" role="status" aria-live="polite">
      <Badge tone="warn">DEMO DATA · 非真实数据</Badge>
      <div><strong>{data.loadError !== null ? "真实数据接入失败，正在展示界面演示" : verifiedDataMissing ? "真实数据尚未接入或当前为空，正在展示界面演示" : "正在查看界面演示"}</strong><p>{data.loadError !== null ? `失败原因：${data.loadError}。` : ""} 以下数值仅用于保留和检查原 HTML/React 信息结构；所有输入与操作均已锁定，不会进入回测、Paper 账本、导出或后端命令。</p></div>
    </section>
    <WorkbenchDataProvider data={PREVIEW_WORKBENCH_DATA}><div className="demo-surface" aria-disabled="true" inert onClickCapture={(event) => { event.preventDefault(); event.stopPropagation(); }}><Page /></div></WorkbenchDataProvider>
  </> : <Page />}</AppShell>;
}

export function App({ dataSource, commands = null, initialData }: { dataSource?: WorkbenchDataSource; commands?: WorkbenchCommands | null; initialData?: WorkbenchViewData }) {
  const [data, setData] = useState<WorkbenchViewData | null>(dataSource === undefined ? initialData ?? null : null);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => { if (dataSource === undefined) return; setData(await dataSource.loadViewData()); };
  useEffect(() => {
    if (dataSource === undefined) return;
    const controller = new AbortController();
    dataSource.loadViewData(controller.signal).then(setData).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "工作台数据不可用");
    });
    return () => controller.abort();
  }, [dataSource]);
  if (data === null && error === null) return <main className="boot-state"><h1>正在连接本地后端</h1><p>通过本机固定 Web API 加载已校验的只读数据；连接完成前不会把演示数据当作真实数据。</p></main>;
  const resolvedData = data ?? EMPTY_VERIFIED_WORKBENCH_DATA;
  return <ThemeProvider><WorkbenchDataProvider data={resolvedData} refresh={refresh} loadError={error}><WorkbenchCommandProvider commands={commands}><WorkbenchProvider><RoutedWorkbench /></WorkbenchProvider></WorkbenchCommandProvider></WorkbenchDataProvider></ThemeProvider>;
}
