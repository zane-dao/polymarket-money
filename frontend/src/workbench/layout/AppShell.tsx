import { useEffect, useState, type PropsWithChildren } from "react";

import { useWorkbench } from "../app/WorkbenchContext.js";
import { WORKBENCH_ROUTE_IDS, type WorkbenchRouteId } from "../domain/workbench.js";
import { Badge } from "../components/ui.js";
import { useTheme, type ThemePreference } from "../app/ThemeContext.js";
import { useWorkbenchData } from "../app/WorkbenchDataContext.js";
import { useWorkbenchCommands } from "../app/WorkbenchCommandContext.js";

const labels: Record<WorkbenchRouteId, readonly [string, string]> = {
  overview: ["总览", "O"], live: ["实时驾驶舱", "L"], decisions: ["决策记录", "D"],
  strategy: ["策略工作室", "S"], datasets: ["数据集管理", "T"], backtest: ["回测实验室", "B"], replay: ["市场回放", "R"],
  compare: ["策略竞技场", "A"], health: ["系统健康", "H"],
};

export function AppShell({ children }: PropsWithChildren) {
  const { state, dispatch } = useWorkbench();
  const { preference, setPreference } = useTheme();
  const { sourceKind } = useWorkbenchData();
  const commands = useWorkbenchCommands();
  const [runtimeIdentity, setRuntimeIdentity] = useState("BACKEND DISCONNECTED");
  useEffect(() => {
    if (commands === null) return;
    let active = true;
    commands.getAppStatus().then((status) => {
      if (!active) return;
      const environment = status.modules.find((module) => module.moduleId.startsWith("runtime-environment:"))?.moduleId.split(":")[1] ?? "local-development";
      const release = status.modules.find((module) => module.moduleId.startsWith("release:"))?.moduleId.split(":")[1] ?? status.appVersion;
      setRuntimeIdentity(`${environment.toUpperCase()} · ${release}`);
    }).catch(() => { if (active) setRuntimeIdentity("BACKEND DISCONNECTED"); });
    return () => { active = false; };
  }, [commands]);
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand__mark">P</div><div><strong>BTC 5m Workbench</strong><span>Research & Paper Simulation</span></div></div>
      <nav aria-label="主导航">{WORKBENCH_ROUTE_IDS.map((id) => <button key={id} className={state.activeRoute === id ? "active" : ""} onClick={() => dispatch({ type: "navigate", routeId: id })}><span>{labels[id][1]}</span>{labels[id][0]}</button>)}</nav>
      <div className="sidebar__footer"><Badge tone={sourceKind === "verified-local" ? "good" : "warn"}>{sourceKind === "verified-local" ? "VERIFIED LOCAL" : "PREVIEW DATA"}</Badge><p>{sourceKind === "verified-local" ? "数据来自本地后端校验后的只读 DTO。" : "界面使用独立预览适配器。未连接账户、私有频道或真实订单。"}</p><small>LIVE_TRADING_ENABLED=false</small></div>
    </aside>
    <main className="main">
      <header className="topbar">
        <div className="topbar__stats">
          {sourceKind === "verified-local" ? <><span>模式 <b>PAPER 模拟</b></span><span className="topbar__warn">运行状态 <b>等待后端数据</b></span></> : <><span>模式 <b>PAPER 模拟</b></span><span>当前市场 <b>BTC 五分钟涨跌</b></span>
          <span>市场时间 <b>23:15 → 23:20</b></span><span className="topbar__warn">剩余 <b>00:01:37</b></span>
          <span>策略 <b>K-Edge v0.4</b></span><span className="topbar__good">Polymarket <b>HEALTHY</b></span>
          <span className="topbar__good">Binance <b>HEALTHY</b></span><span>数据年龄 <b>18 ms</b></span>
          <span className="topbar__warn">连续性 <b>UNVERIFIED</b></span></>}
        </div>
        {sourceKind === "verified-local" && <details className="data-view-diagnostics"><summary>开发者视图</summary><label className="data-view-picker"><span>页面数据</span><select aria-label="页面数据视图" value={state.dataView} onChange={(event) => dispatch({ type: "set-data-view", dataView: event.target.value as "auto" | "verified" | "demo" })}><option value="auto">自动</option><option value="verified">真实数据</option><option value="demo">界面演示</option></select></label></details>}
        <label className="theme-picker"><span aria-hidden="true">◐</span><select aria-label="页面颜色主题" value={preference} onChange={(event) => setPreference(event.target.value as ThemePreference)}><option value="system">随系统</option><option value="light">白天</option><option value="dark">夜晚</option><option value="glass">毛玻璃</option></select></label>
        <Badge tone={runtimeIdentity === "BACKEND DISCONNECTED" ? "warn" : "info"}>{runtimeIdentity}</Badge>
        <Badge tone="info">PAPER ONLY · LIVE OFF</Badge>
        <button className="icon-button" aria-label="帮助" onClick={() => dispatch({ type: "set-help-open", open: true })}>?</button>
      </header>
      <div className="workspace">{children}</div>
    </main>
    {state.helpOpen && <div className="modal-layer" role="presentation" onMouseDown={() => dispatch({ type: "set-help-open", open: false })}><section className="modal" role="dialog" aria-modal="true" aria-label="工作台说明" onMouseDown={(event) => event.stopPropagation()}><button className="modal__close" onClick={() => dispatch({ type: "set-help-open", open: false })}>×</button><Badge tone="info">{sourceKind === "verified-local" ? "LOCAL PAPER + LOCKED DEMO" : "DEVELOPMENT PREVIEW"}</Badge><h2>研究工作台说明</h2><p>{sourceKind === "verified-local" ? "生产入口默认只使用后端命令返回并经严格校验的数据。折叠的开发者视图可打开原 React 静态演示；演示数值醒目标记且整体锁定，不会触发后端。" : "预览数据仅供前端开发和测试，不会触发后端或任何交易操作。"}</p><p>Paper Runner 自动完成公开市场发现、策略决策、风控、模拟成交和结算。LIVE_TRADING_ENABLED=false；不存在钱包、签名、私有频道或真实订单路径。</p></section></div>}
  </div>;
}
