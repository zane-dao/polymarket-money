import { useEffect, useState } from "react";
import { useWorkbench } from "../app/WorkbenchContext.js";
import { useWorkbenchCommands } from "../app/WorkbenchCommandContext.js";
import type { DatasetDetailV1, DatasetListV1, DatasetListItemV1 } from "../services/workbench-commands.js";
import { Badge, CopyButton, EmptyState, formatCount, formatUtc, humanizeIdentifier, PageHeader, Panel } from "../components/ui.js";

export function DatasetPage() {
  const commands = useWorkbenchCommands();
  const { dispatch } = useWorkbench();
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
    try { const result = await commands.scanDatasets(); setValue({ schemaVersion: "dataset-list-v2", scannedAtUtc: result.scannedAtUtc, datasets: result.datasets }); setMessage(`后端扫描完成：${result.datasetCount} 个已验证版本`); }
    catch (error: unknown) { setValue(null); setMessage(error instanceof Error ? error.message : "数据集扫描失败"); }
    finally { setBusy(false); }
  };
  const inspect = async (item: DatasetListItemV1) => {
    if (commands === null) return;
    setBusy(true);
    try { const next = await commands.getDataset(item.datasetId, item.versionHash); const validated = await commands.validateDatasetSelection({ schemaVersion: "dataset-selection-request-v1", datasetId: item.datasetId, versionHash: item.versionHash }); setDetail(next); dispatch({ type: "update-research-session", patch: { datasetId: validated.datasetId, datasetVersionHash: validated.versionHash, runId: null, comparisonRunIds: [], stage: "scope" } }); setMessage(`后端已验证并绑定数据集 ${validated.datasetId} · ${validated.validatedAtUtc}`); }
    catch (error: unknown) { setDetail(null); setMessage(error instanceof Error ? error.message : "数据集详情不可用"); }
    finally { setBusy(false); }
  };
  const registerSource = async () => {
    if (commands === null || sourceDirectory.trim() === "") return;
    setBusy(true); setDetail(null);
    try { const registered = await commands.registerDatasetSource({ schemaVersion: "dataset-source-registration-request-v1", sourceDirectory: sourceDirectory.trim() }); const result = await commands.scanDatasets(); setValue({ schemaVersion: "dataset-list-v2", scannedAtUtc: result.scannedAtUtc, datasets: result.datasets }); setSourceDirectory(""); setMessage(`后端已登记只读数据源 ${registered.sourceId.slice(0, 12)}…，发现 ${registered.datasetCount} 个版本；当前共 ${result.datasetCount} 个版本`); }
    catch (error: unknown) { setMessage(error instanceof Error ? error.message : "本地历史数据添加失败"); }
    finally { setBusy(false); }
  };
  const normalizeRaw = async () => {
    if (commands === null || rawInputPath.trim() === "" || rawDatasetId.trim() === "") return;
    setBusy(true); setDetail(null);
    try { const publication = await commands.normalizeRawDataset({ schemaVersion: "raw-dataset-normalization-request-v1", inputPath: rawInputPath.trim(), datasetId: rawDatasetId.trim() }); const result = await commands.scanDatasets(); setValue({ schemaVersion: "dataset-list-v2", scannedAtUtc: result.scannedAtUtc, datasets: result.datasets }); setRawInputPath(""); setRawDatasetId(""); setMessage(`后端已归一化 ${publication.rowCount} 条事件并发布 ${publication.datasetId} · ${publication.versionHash.slice(0, 12)}…`); }
    catch (error: unknown) { setMessage(error instanceof Error ? error.message : "原始历史数据归一化失败"); }
    finally { setBusy(false); }
  };
  const deleteDataset = async (item:DatasetListItemV1) => {
    if(commands===null||item.management!=="managed"||!window.confirm(`删除生成的数据集版本？\n\n${item.datasetId}\n${item.versionHash}\n\n此操作不可撤销。`))return;
    setBusy(true);setDetail(null);try{await commands.deleteDataset(item.datasetId,item.versionHash);await scan();setMessage(`已删除生成的数据集版本 ${item.datasetId} · ${item.versionHash.slice(0,12)}…`);}catch(error){setMessage(error instanceof Error?error.message:"数据集删除失败");}finally{setBusy(false);}
  };
  useEffect(() => { void load(); }, [commands]);
  return <><PageHeader title="数据集管理（Datasets）" subtitle="先选择可信的数据版本；添加和归一化操作收在次级区域。" action={<button className="button button--primary" disabled={commands === null || busy} onClick={() => void scan()}>重新扫描</button>} />
    <section className="summary-strip" aria-label="数据集摘要"><span>可用版本<b>{value === null ? "—" : value.datasets.length}</b></span><span>最近扫描<b title={value?.scannedAtUtc}>{formatUtc(value?.scannedAtUtc ?? null)}</b></span><span>连续性状态<b className="amber">尚未验证</b></span><span>原始数据策略<b>只读、不复制</b></span></section>
    <Panel title="可用历史数据版本" english="Verified Dataset Publications" action={<Badge tone={value === null ? "warn" : "good"}>{value === null ? "UNAVAILABLE" : `${value.datasets.length} AVAILABLE`}</Badge>}>
      <p role="status">{message}</p>
      {value !== null && value.datasets.length === 0 ? <EmptyState title="没有可用数据集" detail="请先由后端发布带完整哈希清单的 normalized 数据；页面不会直接读取文件或数据库。" /> : value === null ? null : <div className="dataset-cards">{value.datasets.map((item) => <article key={`${item.datasetId}:${item.versionHash}`} className="dataset-card"><div className="dataset-card__head"><div><h3>{item.displayName || humanizeIdentifier(item.datasetId)}</h3><small>{item.description}</small></div><Badge tone="warn">连续性未验证</Badge></div><div className="dataset-card__facts"><span>数据覆盖<b title={item.startTimeUtc ?? undefined}>{formatUtc(item.startTimeUtc)} — {formatUtc(item.endTimeUtc)}</b></span><span>事件数量<b>{formatCount(item.rowCount)}</b></span><span>来源<b>{item.source}</b></span><span>生成时间<b>{formatUtc(item.publishedAtUtc)}</b></span></div><div className="dataset-card__footer"><details className="technical-details"><summary>查看技术身份</summary><code>{item.datasetId}<br />{item.versionHash}</code></details><div className="toolbar"><button className="button" disabled={busy} onClick={() => void inspect(item)}>详情与校验</button>{item.management==="managed"?<button className="button button--danger" disabled={busy} onClick={()=>void deleteDataset(item)}>删除生成版本</button>:<span title="外部只读数据不会由工作台删除"><Badge>只读来源</Badge></span>}</div></div></article>)}</div>}
    </Panel>
    {detail === null ? null : <Panel title={`${detail.displayName} · 已绑定当前研究`} english="Backend-Verified Selection" action={<div className="toolbar"><Badge tone="good">DATASET READY</Badge><button className="button button--primary" onClick={() => dispatch({ type: "navigate", routeId: "strategy" })}>下一步：选择策略 →</button></div>}><div className="metadata-grid"><span>数据覆盖<b>{formatUtc(detail.startTimeUtc)}<br />{formatUtc(detail.endTimeUtc)}</b></span><span>记录 / 隔离<b>{formatCount(detail.rowCount)} / {formatCount(detail.quarantineCount)}</b></span><span>生成时间<b>{formatUtc(detail.publishedAtUtc)}</b></span></div><details className="inline-details"><summary>查看技术身份</summary><dl className="compact-dl"><dt>数据集 ID</dt><dd>{detail.datasetId} <CopyButton value={detail.datasetId}/></dd><dt>完整版本哈希</dt><dd className="break-all">{detail.versionHash} <CopyButton value={detail.versionHash}/></dd><dt>原始数据策略</dt><dd>{detail.rawDataPolicy}</dd></dl></details></Panel>}
    <details className="technical-details"><summary>添加或归一化历史数据</summary><div className="technical-details__body stack"><Panel title="归一化原始历史数据"><div className="adaptive-form"><label className="field-span-4">数据集 ID<input name="dataset-id" autoComplete="off" spellCheck={false} aria-label="原始数据集 ID" value={rawDatasetId} placeholder="例如：btc-five-minute-local…" onChange={(event) => setRawDatasetId(event.target.value)} /></label><label className="field-span-8">CSV / JSON / NDJSON 文件或平铺目录<input name="raw-dataset-path" autoComplete="off" spellCheck={false} aria-label="原始历史数据路径" value={rawInputPath} placeholder="例如：/absolute/path/to/raw-events.ndjson…" onChange={(event) => setRawInputPath(event.target.value)} /></label><div className="field-span-12 form-actions"><button type="button" className="button button--primary" aria-label="归一化并发布历史数据" disabled={commands === null || busy || rawInputPath.trim() === "" || rawDatasetId.trim() === ""} onClick={() => void normalizeRaw()}>归一化并发布</button></div></div><p>后端校验统一事件 schema；原始输入保持只读。</p></Panel><Panel title="登记已有的标准化发布"><div className="adaptive-form"><label className="field-span-9">外部 normalized 发布根<input name="normalized-source-directory" autoComplete="off" spellCheck={false} aria-label="外部 normalized 发布根" value={sourceDirectory} placeholder="例如：/absolute/path/to/normalized…" onChange={(event) => setSourceDirectory(event.target.value)} /></label><div className="field-span-3 form-actions"><button type="button" className="button button--primary" aria-label="登记标准化数据源" disabled={commands === null || busy || sourceDirectory.trim() === ""} onClick={() => void registerSource()}>由后端添加</button></div></div></Panel></div></details>
  </>;
}
