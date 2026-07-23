import { useEffect, useRef, useState, type MouseEvent, type PropsWithChildren } from "react";

import { useWorkbench } from "../app/WorkbenchContext.js";
import type { WorkbenchRouteId } from "../domain/workbench.js";
import { Badge } from "../components/ui.js";
import { useTheme, type ThemePreference } from "../app/ThemeContext.js";
import { useWorkbenchData } from "../app/WorkbenchDataContext.js";
import { useWorkbenchCommands } from "../app/WorkbenchCommandContext.js";
import { ResearchContextHeader, WorkflowRail } from "../components/ResearchWorkflow.js";
import { workbenchSearch } from "../domain/research-session.js";

const navigationGroups: readonly Readonly<{
  label: string;
  items: readonly Readonly<{ id: WorkbenchRouteId; label: string; legacyLabel: string; mark: string }>[];
}>[] = [
  { label: "研究任务", items: [{ id: "overview", label: "当前研究", legacyLabel: "总览", mark: "W" }, { id: "live", label: "Paper 观察", legacyLabel: "实时驾驶舱", mark: "P" }] },
  { label: "研究资产", items: [{ id: "datasets", label: "数据准备", legacyLabel: "数据集管理", mark: "D" }, { id: "strategy", label: "策略版本", legacyLabel: "策略工作室", mark: "S" }] },
  { label: "分析工具", items: [{ id: "backtest", label: "回测研究", legacyLabel: "回测实验室", mark: "B" }, { id: "compare", label: "效果比较", legacyLabel: "策略竞技场", mark: "C" }, { id: "replay", label: "运行回放", legacyLabel: "市场回放", mark: "R" }, { id: "decisions", label: "决策账本", legacyLabel: "决策记录", mark: "L" }] },
  { label: "系统状态", items: [{ id: "health", label: "准入与健康", legacyLabel: "系统健康", mark: "G" }] },
];

export function AppShell({ children }: PropsWithChildren) {
  const { state, dispatch } = useWorkbench();
  const { preference, setPreference } = useTheme();
  const { sourceKind } = useWorkbenchData();
  const commands = useWorkbenchCommands();
  const [runtimeIdentity, setRuntimeIdentity] = useState("BACKEND DISCONNECTED");
  const helpCloseRef = useRef<HTMLButtonElement>(null);
  function navigate(event: MouseEvent<HTMLAnchorElement>, routeId: WorkbenchRouteId) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    dispatch({ type: "navigate", routeId });
  }
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
  useEffect(() => {
    if (!state.helpOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    helpCloseRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dispatch({ type: "set-help-open", open: false });
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      previouslyFocused?.focus();
    };
  }, [dispatch, state.helpOpen]);
  return <div className="app-shell">
    <a className="skip-link" href="#main-workspace">跳到研究工作区</a>
    <aside className="sidebar">
      <div className="brand"><div className="brand__mark">P</div><div><strong>BTC 5m Workbench</strong><span>Research & Paper Simulation</span></div></div>
      <nav aria-label="主导航">{navigationGroups.map((group) => <section className="nav-group" key={group.label} aria-label={group.label}>
        <h2>{group.label}</h2>
        {group.items.map((item) => <a key={item.id} href={workbenchSearch(state.researchSession, item.id)} className={state.activeRoute === item.id ? "active" : ""} aria-label={item.legacyLabel} aria-current={state.activeRoute === item.id ? "page" : undefined} onClick={(event) => navigate(event, item.id)}><span aria-hidden="true">{item.mark}</span>{item.label}</a>)}
      </section>)}</nav>
      <div className="sidebar__footer"><Badge tone={sourceKind === "verified-local" ? "good" : "warn"}>{sourceKind === "verified-local" ? "VERIFIED LOCAL" : "PREVIEW DATA"}</Badge><p>{sourceKind === "verified-local" ? "数据来自本地后端校验后的只读 DTO。" : "界面使用独立预览适配器。未连接账户、私有频道或真实订单。"}</p><small>LIVE_TRADING_ENABLED=false</small></div>
    </aside>
    <main className="main" id="main-workspace">
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
        <button type="button" className="icon-button" aria-label="打开工作台帮助" aria-haspopup="dialog" onClick={() => dispatch({ type: "set-help-open", open: true })}>?</button>
      </header>
      <div className="workspace"><ResearchContextHeader /><WorkflowRail />{children}</div>
    </main>
    {state.helpOpen && <div className="modal-layer"><button type="button" tabIndex={-1} className="modal-backdrop" aria-label="点击空白区域关闭帮助" onClick={() => dispatch({ type: "set-help-open", open: false })} /><section className="modal" role="dialog" aria-modal="true" aria-labelledby="workbench-help-title"><button ref={helpCloseRef} type="button" className="modal__close" aria-label="关闭工作台帮助" onClick={() => dispatch({ type: "set-help-open", open: false })}>×</button><Badge tone="info">{sourceKind === "verified-local" ? "LOCAL PAPER + LOCKED DEMO" : "DEVELOPMENT PREVIEW"}</Badge><h2 id="workbench-help-title">研究工作台说明</h2><p>{sourceKind === "verified-local" ? "生产入口默认只使用后端命令返回并经严格校验的数据。折叠的开发者视图可打开原 React 静态演示；演示数值醒目标记且整体锁定，不会触发后端。" : "预览数据仅供前端开发和测试，不会触发后端或任何交易操作。"}</p><p>Paper Runner 自动完成公开市场发现、策略决策、风控、模拟成交和结算。LIVE_TRADING_ENABLED=false；不存在钱包、签名、私有频道或真实订单路径。</p></section></div>}
  </div>;
}
