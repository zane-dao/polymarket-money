import type { AppStatusV1 } from "../../types/app-status.js";
import type { PaperMarketHostStatusV1, QueryPageV1, SystemHealthV1, SystemIncidentV1 } from "../services/workbench-commands.js";
import { Badge, EmptyState, formatEventUtc, humanizeIdentifier, Panel } from "./ui.js";

type Props = Readonly<{
  status: AppStatusV1 | null;
  health: SystemHealthV1 | null;
  host: PaperMarketHostStatusV1 | null;
  incidents: QueryPageV1<SystemIncidentV1> | null;
  statusError: string | null;
}>;

const healthLabels = {
  healthy: "健康",
  degraded: "降级",
  unavailable: "不可用",
} as const;

const lifecycleLabels: Readonly<Record<PaperMarketHostStatusV1["lifecycle"], string>> = {
  STOPPED: "已停止",
  STARTING: "启动中",
  RUNNING: "运行中",
  STOPPING: "停止中",
  FAILED: "失败",
};

const connectionLabels: Readonly<Record<PaperMarketHostStatusV1["connection"], string>> = {
  DISCONNECTED: "未连接",
  CONNECTED: "已连接",
  DEGRADED: "连接降级",
};

const moduleLabels: Readonly<Record<string, string>> = {
  backtest: "回测引擎",
  dataset: "数据集",
  datasets: "数据集",
  paper: "Paper 模拟",
  "paper-execution": "Paper 模拟执行",
  strategy: "策略运行时",
  strategies: "策略运行时",
  storage: "证据存储",
  web: "本地 Web 服务",
};

const incidentLabels: Readonly<Record<string, Readonly<{ title: string; detail: string }>>> = {
  GAP: { title: "公共行情出现连续性缺口", detail: "后端记录到行情序列缺口；相关窗口不能作为可交易证据。" },
  ERROR: { title: "Paper 运行记录到错误", detail: "后端运行证据包含错误记录；请通过技术详情核对原始信息。" },
  SETTLEMENT_FAILURE: { title: "模拟结算失败", detail: "Paper 结算证据未能完成；该市场结果不能视为已结算。" },
  PUBLIC_FEED_CONNECTION: { title: "公共行情连接状态变化", detail: "公共数据连接发生连接、断开或恢复；以当前连接状态为准。" },
  SNAPSHOT_LATENCY: { title: "公共快照延迟统计", detail: "后端已记录快照延迟与数据年龄分位数，供判断数据时效性。" },
  STALE_DATA: { title: "数据集长时间未更新", detail: "后端将数据状态标记为过期；更新前不应继续依赖该数据。" },
  BOOK_GAP: { title: "盘口序列出现缺口", detail: "盘口接收序号不连续；相关窗口已失去连续性证据。" },
  STALE_BOOK: { title: "盘口数据超过时效门槛", detail: "盘口年龄超过准入阈值；策略资格应保持关闭。" },
  RECONNECT: { title: "公共行情连接已恢复", detail: "连接身份已经更新，旧连接状态不得继续复用。" },
};

export function VerifiedHealthDashboard({ status, health, host, incidents, statusError }: Props) {
  if (status === null || health === null || host === null) {
    return <Panel title="准入与健康" english="Verified Runtime Health"><EmptyState title="详细健康数据不可用" detail={statusError ?? "正在等待后端状态探针。"} /></Panel>;
  }
  const unavailableModules = status.modules.filter((module) => module.availability === "unavailable").length;
  const healthTone = health.status === "healthy" ? "good" : health.status === "degraded" ? "warn" : "bad";
  const hostTone = host.lifecycle === "FAILED" || host.errorCount > 0 ? "bad" : host.ready ? "good" : "warn";
  return <>
    <div className="health-top health-top--verified">
      <HealthCard title="应用与安全边界" badge={health.status === "healthy" ? "健康" : "需检查"} value="PAPER ONLY" tone={healthTone} rows={[
        ["应用版本", status.appVersion],
        ["真实交易", status.liveTradingEnabled ? "异常启用" : "已禁用"],
        ["数据根", status.dataRootConfigured ? "已配置" : "未配置"],
      ]} />
      <HealthCard title="数据与证据" badge={healthLabels[health.datasets]} value={healthLabels[health.database]} tone={health.database === "healthy" && health.datasets === "healthy" ? "good" : "warn"} rows={[
        ["数据库", healthLabels[health.database]],
        ["数据集", healthLabels[health.datasets]],
        ["不可用模块", String(unavailableModules)],
      ]} />
      <HealthCard title="回测任务" badge={healthLabels[health.jobs]} value={`${health.activeJobs} 活动`} tone={health.failedJobs === 0 ? "good" : "warn"} rows={[
        ["活动任务", String(health.activeJobs)],
        ["失败任务", String(health.failedJobs)],
        ["探针时间", formatEventUtc(health.checkedAtUtc)],
      ]} />
      <HealthCard title="Paper 公共行情主机" badge={connectionLabels[host.connection]} value={lifecycleLabels[host.lifecycle]} tone={hostTone} rows={[
        ["可执行快照", host.ready ? "已就绪" : "未就绪"],
        ["缓存市场", String(host.cachedMarketCount)],
        ["最近快照", formatEventUtc(host.lastSnapshotAtUtc)],
      ]} />
    </div>

    <div className="health-control-grid">
      <Panel title="模块与服务状态" english="Module & Service Status" action={<Badge tone={unavailableModules === 0 ? "good" : "warn"}>{unavailableModules === 0 ? "全部可用" : `${unavailableModules} 项不可用`}</Badge>}>
        <div className="service-status-grid">{status.modules.map((module) => <article key={module.moduleId}>
          <span><strong>{moduleLabels[module.moduleId] ?? humanizeIdentifier(module.moduleId)}</strong><small>{module.availability === "available" ? "后端探针已确认模块可用" : "后端探针报告模块不可用"}</small></span>
          <Badge tone={module.availability === "available" ? "good" : "warn"}>{module.availability === "available" ? "可用" : "不可用"}</Badge>
          {module.availability === "unavailable" ? <details className="technical-details"><summary>查看后端原因</summary>{module.reason}</details> : null}
        </article>)}</div>
      </Panel>
      <Panel title="数据质量计数器" english="Data Quality Counters">
        <div className="counter-grid">
          <Counter label="累计快照" value={host.snapshotCount} />
          <Counter label="连续性缺口" value={host.gapCount} tone={host.gapCount > 0 ? "amber" : undefined} />
          <Counter label="主机错误" value={host.errorCount} tone={host.errorCount > 0 ? "negative" : undefined} />
          <Counter label="缓存市场" value={host.cachedMarketCount} />
          <Counter label="活动回测" value={health.activeJobs} />
          <Counter label="失败回测" value={health.failedJobs} tone={health.failedJobs > 0 ? "negative" : undefined} />
        </div>
        <div className="validation-list health-probe-times">
          <span>最后连接 <b>{formatEventUtc(host.lastConnectionAtUtc)}</b></span>
          <span>最后快照 <b>{formatEventUtc(host.lastSnapshotAtUtc)}</b></span>
          <span>应用状态生成 <b>{formatEventUtc(status.generatedAtUtc)}</b></span>
        </div>
      </Panel>
    </div>

    <Panel title="运行时异常" english="Runtime Incidents & Alerts" action={incidents === null ? undefined : <Badge tone={incidents.items.some((item) => !item.resolved && item.severity === "error") ? "bad" : incidents.items.some((item) => !item.resolved) ? "warn" : "good"}>{incidents.items.filter((item) => !item.resolved).length} 条未解决</Badge>}>
      {incidents === null ? <EmptyState title="异常查询不可用" detail={statusError ?? "正在等待异常仓库。"} /> : incidents.items.length === 0 ? <EmptyState title="没有已记录的系统异常" detail="后端异常仓库当前为空；不会从日志文字推断或伪造异常。" /> : <div className="incident-list">{incidents.items.map((incident) => <IncidentRow key={incident.incidentId} incident={incident} />)}</div>}
    </Panel>
  </>;
}

function HealthCard({ title, badge, value, rows, tone }: { title: string; badge: string; value: string; rows: readonly (readonly [string, string])[]; tone: "good" | "warn" | "bad" }) {
  return <article className="health-kpi"><strong>{title}</strong><Badge tone={tone}>{badge}</Badge><b className={tone === "good" ? "positive" : tone === "bad" ? "negative" : "amber"}>{value}</b><dl>{rows.map(([label, item]) => <span key={label}><dt>{label}</dt><dd>{item}</dd></span>)}</dl></article>;
}

function Counter({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return <article><span>{label}</span><strong className={tone}>{value.toLocaleString("zh-CN")}</strong></article>;
}

function IncidentRow({ incident }: { incident: SystemIncidentV1 }) {
  const presentation = incidentLabels[incident.code] ?? {
    title: `后端异常：${humanizeIdentifier(incident.code)}`,
    detail: "后端尚未配置这类异常的中文说明；请在技术详情中核对原始记录。",
  };
  const severity = incident.severity === "error" ? "严重" : incident.severity === "warning" ? "警告" : "提示";
  const component = incident.component === "database" ? "数据库" : incident.component === "dataset" ? "数据集" : incident.component === "backtest" ? "回测" : incident.component === "paper-execution" ? "Paper 模拟执行" : "系统";
  return <article className={incident.severity === "error" ? "incident-list__critical" : incident.severity === "warning" ? "incident-list__warning" : "incident-list__info"}>
    <Badge tone={incident.severity === "error" ? "bad" : incident.severity === "warning" ? "warn" : "info"}>{severity}</Badge>
    <div><strong>{presentation.title}</strong><p>{presentation.detail}</p><small>{component} · {incident.resolved ? "已解决" : "未解决"}</small></div>
    <time>{formatEventUtc(incident.occurredAtUtc)}</time>
    <details className="technical-details incident-technical"><summary>技术详情</summary><dl><dt>代码</dt><dd>{incident.code}</dd><dt>原始后端信息</dt><dd>{incident.message}</dd><dt>异常 ID</dt><dd>{incident.incidentId}</dd></dl></details>
  </article>;
}
