import { useEffect, useState } from "react";
import { useWorkbenchCommands } from "../app/WorkbenchCommandContext.js";
import type { DatasetDetailV1, DatasetListV1, DatasetListItemV1 } from "../services/workbench-commands.js";
import { Badge, EmptyState, PageHeader, Panel } from "../components/ui.js";

export function DatasetPage() {
  const commands = useWorkbenchCommands();
  const [value, setValue] = useState<DatasetListV1 | null>(null);
  const [detail, setDetail] = useState<DatasetDetailV1 | null>(null);
  const [sourceDirectory, setSourceDirectory] = useState("");
  const [rawInputPath, setRawInputPath] = useState("");
  const [rawDatasetId, setRawDatasetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(commands === null ? "本地后端命令不可用" : "正在扫描已发布的只读历史数据…");
  const load = async () => {
    if (commands === null) return;
    try { const next = await commands.listDatasets(); setValue(next); setMessage(`扫描完成：${next.datasets.length} 个已验证版本`); }
    catch (error: unknown) { setValue(null); setMessage(error instanceof Error ? error.message : "数据集扫描失败"); }
  };
  const scan = async () => {
    if (commands === null) return;
    setBusy(true); setDetail(null);
    try { const result = await commands.scanDatasets(); setValue({ schemaVersion: "dataset-list-v1", scannedAtUtc: result.scannedAtUtc, datasets: result.datasets }); setMessage(`后端扫描完成：${result.datasetCount} 个已验证版本`); }
    catch (error: unknown) { setValue(null); setMessage(error instanceof Error ? error.message : "数据集扫描失败"); }
    finally { setBusy(false); }
  };
  const inspect = async (item: DatasetListItemV1) => {
    if (commands === null) return;
    setBusy(true);
    try { const next = await commands.getDataset(item.datasetId, item.versionHash); const validated = await commands.validateDatasetSelection({ schemaVersion: "dataset-selection-request-v1", datasetId: item.datasetId, versionHash: item.versionHash }); setDetail(next); setMessage(`后端已验证选择 ${validated.datasetId} · ${validated.validatedAtUtc}`); }
    catch (error: unknown) { setDetail(null); setMessage(error instanceof Error ? error.message : "数据集详情不可用"); }
    finally { setBusy(false); }
  };
  const registerSource = async () => {
    if (commands === null || sourceDirectory.trim() === "") return;
    setBusy(true); setDetail(null);
    try { const registered = await commands.registerDatasetSource({ schemaVersion: "dataset-source-registration-request-v1", sourceDirectory: sourceDirectory.trim() }); const result = await commands.scanDatasets(); setValue({ schemaVersion: "dataset-list-v1", scannedAtUtc: result.scannedAtUtc, datasets: result.datasets }); setSourceDirectory(""); setMessage(`后端已登记只读数据源 ${registered.sourceId.slice(0, 12)}…，发现 ${registered.datasetCount} 个版本；当前共 ${result.datasetCount} 个版本`); }
    catch (error: unknown) { setMessage(error instanceof Error ? error.message : "本地历史数据添加失败"); }
    finally { setBusy(false); }
  };
  const normalizeRaw = async () => {
    if (commands === null || rawInputPath.trim() === "" || rawDatasetId.trim() === "") return;
    setBusy(true); setDetail(null);
    try { const publication = await commands.normalizeRawDataset({ schemaVersion: "raw-dataset-normalization-request-v1", inputPath: rawInputPath.trim(), datasetId: rawDatasetId.trim() }); const result = await commands.scanDatasets(); setValue({ schemaVersion: "dataset-list-v1", scannedAtUtc: result.scannedAtUtc, datasets: result.datasets }); setRawInputPath(""); setRawDatasetId(""); setMessage(`后端已归一化 ${publication.rowCount} 条事件并发布 ${publication.datasetId} · ${publication.versionHash.slice(0, 12)}…`); }
    catch (error: unknown) { setMessage(error instanceof Error ? error.message : "原始历史数据归一化失败"); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, [commands]);
  return <><PageHeader title="数据集管理（Datasets）" subtitle="前端只读取后端返回的无路径 DTO；原始历史文件始终只读。" action={<button className="button" disabled={commands === null || busy} onClick={() => void scan()}>重新扫描</button>} />
    <Panel title="添加原始历史数据并归一化" english="Web Backend Raw Normalization"><div className="form-grid"><label>数据集 ID<input aria-label="原始数据集 ID" value={rawDatasetId} placeholder="btc-five-minute-local" onChange={(event) => setRawDatasetId(event.target.value)} /></label><label className="field-wide">CSV / JSON / NDJSON 文件或平铺目录（仓外绝对路径）<input aria-label="原始历史数据路径" value={rawInputPath} placeholder="/absolute/path/to/raw-events.ndjson" onChange={(event) => setRawInputPath(event.target.value)} /></label><label>Web 后端操作<button className="button button--primary" disabled={commands === null || busy || rawInputPath.trim() === "" || rawDatasetId.trim() === ""} onClick={() => void normalizeRaw()}>归一化并发布</button></label></div><p>后端严格校验统一事件 schema、文件安全和大小限制；原始输入保持只读，输出写入内容寻址的 immutable publication。</p></Panel>
    <Panel title="添加本地历史数据" english="Register Read-Only Normalized Publication"><div className="form-grid"><label className="field-wide">外部 normalized 发布根（绝对目录）<input aria-label="外部 normalized 发布根" value={sourceDirectory} placeholder="/absolute/path/to/normalized" onChange={(event) => setSourceDirectory(event.target.value)} /></label><label>后端操作<button className="button button--primary" disabled={commands === null || busy || sourceDirectory.trim() === ""} onClick={() => void registerSource()}>由后端添加</button></label></div><p>后端只登记受控引用并校验哈希发布结构；不复制、修改或把本地路径返回给页面。</p></Panel>
    <Panel title="历史数据版本" english="Verified Dataset Publications" action={<Badge tone={value === null ? "warn" : "good"}>{value === null ? "UNAVAILABLE" : `${value.datasets.length} AVAILABLE`}</Badge>}>
      <p role="status">{message}</p>
      {value !== null && value.datasets.length === 0 ? <EmptyState title="没有可用数据集" detail="请先由后端发布带完整哈希清单的 normalized 数据；页面不会直接读取文件或数据库。" /> : value === null ? null : <table className="data-table"><thead><tr><th>数据集</th><th>版本哈希</th><th>格式</th><th>时间范围</th><th>行数</th><th>连续性</th><th>操作</th></tr></thead><tbody>{value.datasets.map((item) => <tr key={`${item.datasetId}:${item.versionHash}`}><td>{item.datasetId}</td><td title={item.versionHash}>{item.versionHash.slice(0, 12)}…</td><td>{item.format}</td><td>{item.startTimeUtc ?? "—"}<br />{item.endTimeUtc ?? "—"}</td><td>{item.rowCount}</td><td>{item.continuity}</td><td><button className="button" disabled={busy} onClick={() => void inspect(item)}>详情与校验</button></td></tr>)}</tbody></table>}
    </Panel>
    {detail === null ? null : <Panel title="数据集详情" english="Backend-Verified Detail" action={<Badge tone="good">SELECTION READY</Badge>}><div className="metadata-grid"><span>数据集 ID<b>{detail.datasetId}</b></span><span>完整版本哈希<b title={detail.versionHash}>{detail.versionHash}</b></span><span>格式<b>{detail.format}</b></span><span>时间范围<b>{detail.startTimeUtc ?? "—"}<br />{detail.endTimeUtc ?? "—"}</b></span><span>记录 / 隔离<b>{detail.rowCount} / {detail.quarantineCount}</b></span><span>原始数据策略<b>{detail.rawDataPolicy}</b></span></div></Panel>}
  </>;
}
