/** Credential-free local MVP console. It never starts collection or orders. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const DATASET_HASH = "a27d9d1bf4dc5276c7ae5b11abd64250b6e6dc17f01fd432ab0dc10e4425cafc";
const DATASET = `external-research/normalized/dataset_id=btc-5m-primary-v2-baseline-samples/version=${DATASET_HASH}`;
const EWMA = "external-research/kj-ewma/artifact=387201c1eacbbe54f81d4519407bdb4acf50c9f6ce9f46a2bdb6f924796265da";

export type MvpConsoleSnapshot = {
  liveTradingEnabled: false;
  dataRoot: string;
  datasetAvailable: boolean;
  ewmaArtifactAvailable: boolean;
  gitCommit: string;
  completedPaperRunDirectories: number;
  commands: Record<string, string>;
};

export type MvpResultSummary = {
  runId: string;
  resultHash: string | null;
  split: string | null;
  scenario: string | null;
  summaryIntegrity: "COMPLETE_PUBLICATION_VERIFIED" | "LEGACY_SUMMARY_VERIFIED";
  runs: Record<string, {
    netPnl: string | null;
    filledCount: number | null;
    maxDrawdown: string | null;
    netWithoutBest3Days: string | null;
  }>;
};

/** Matches the Python historical result hash contract: sorted JSON keys, compact separators, UTF-8. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("historical summary contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("historical summary contains a non-JSON value");
}

function verifiedHistoricalResultHash(summary: Record<string, unknown>): string | null {
  const resultHash = summary.result_hash;
  if (typeof resultHash !== "string" || !/^[0-9a-f]{64}$/u.test(resultHash)) return null;
  const core = { ...summary };
  delete core.result_hash;
  const actual = createHash("sha256").update(canonicalJson(core), "utf8").digest("hex");
  return actual === resultHash ? resultHash : null;
}

const HISTORICAL_PUBLICATION_VERSION = "kj-historical-paper-publication-v1";
const MAX_PUBLICATION_SIDECAR_BYTES = 16 * 1024 * 1024;
const PUBLICATION_FILES = ["summary.json", "events.ndjson", "trades.csv"] as const;

function jsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path) || statSync(path).size > 1_000_000) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** New-format output has an intent before sidecars and a full hash manifest only after they are complete. */
function historicalPublicationIntegrity(directory: string, resultHash: string): MvpResultSummary["summaryIntegrity"] | null {
  const intentPath = resolve(directory, "publication-intent.json");
  if (!existsSync(intentPath)) return "LEGACY_SUMMARY_VERIFIED";
  const intent = jsonObject(intentPath);
  const publication = jsonObject(resolve(directory, "publication.json"));
  if (intent === null || publication === null
    || intent.schema_version !== HISTORICAL_PUBLICATION_VERSION || intent.result_hash !== resultHash
    || publication.schema_version !== HISTORICAL_PUBLICATION_VERSION || publication.result_hash !== resultHash) return null;
  const publicationHash = publication.publication_hash;
  if (typeof publicationHash !== "string" || !/^[0-9a-f]{64}$/u.test(publicationHash)) return null;
  const core = { ...publication }; delete core.publication_hash;
  if (createHash("sha256").update(canonicalJson(core), "utf8").digest("hex") !== publicationHash) return null;
  const files = publication.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)
    || Object.keys(files).sort().join(",") !== [...PUBLICATION_FILES].sort().join(",")) return null;
  for (const name of PUBLICATION_FILES) {
    const evidence = (files as Record<string, unknown>)[name];
    const path = resolve(directory, name);
    if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence) || !existsSync(path)) return null;
    const record = evidence as Record<string, unknown>;
    const size = statSync(path).size;
    if (!Number.isSafeInteger(record.bytes) || record.bytes !== size || size > MAX_PUBLICATION_SIDECAR_BYTES
      || typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(record.sha256)) return null;
    if (createHash("sha256").update(readFileSync(path)).digest("hex") !== record.sha256) return null;
  }
  return "COMPLETE_PUBLICATION_VERIFIED";
}

export type MvpPaperSummary = {
  runId: string;
  accepted: boolean | null;
  resultKind: string | null;
  planBinding: string | null;
  targetMarketCount: number | null;
  completedMarketCount: number | null;
  strategies: Record<string, { finalCash: string | null; netPnl: string | null }>;
};

type HistoricalRunKind = "kj" | "l-v1" | "l-v2";
const HISTORICAL_STUDIES: Readonly<Record<HistoricalRunKind, { label: string; outputSlug: string }>> = {
  kj: { label: "K/J frozen FINAL_TEST audit", outputSlug: "kj-final-test" },
  "l-v1": { label: "L V1 TRAIN research", outputSlug: "l-v1-train" },
  "l-v2": { label: "L V2 train-selected VALIDATION research", outputSlug: "l-v2-validation" },
};
type HistoricalRun = {
  id: string;
  kind: HistoricalRunKind;
  output: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};
type ConsoleOptions = { dataRoot: string; enableLocalHistoryRuns: boolean };
const MAX_PROCESS_OUTPUT = 16_000;

function commit(): string {
  try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return "UNAVAILABLE"; }
}

export function createMvpConsoleSnapshot(dataRoot: string): MvpConsoleSnapshot {
  const root = resolve(dataRoot);
  const output = resolve(root, "mvp-runs");
  const paperRoot = resolve(root, "paper-mvp");
  return {
    liveTradingEnabled: false, dataRoot: root, datasetAvailable: existsSync(resolve(root, DATASET)), ewmaArtifactAvailable: existsSync(resolve(root, EWMA)),
    gitCommit: commit(), completedPaperRunDirectories: existsSync(paperRoot) ? readdirSync(paperRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length : 0,
    commands: {
      [HISTORICAL_STUDIES.kj.label]: `.venv/bin/poly-lab ${commandForHistoricalRun(root, "kj", resolve(output, HISTORICAL_STUDIES.kj.outputSlug)).join(" ")}`,
      [HISTORICAL_STUDIES["l-v1"].label]: `.venv/bin/poly-lab ${commandForHistoricalRun(root, "l-v1", resolve(output, HISTORICAL_STUDIES["l-v1"].outputSlug)).join(" ")}`,
      [HISTORICAL_STUDIES["l-v2"].label]: `.venv/bin/poly-lab ${commandForHistoricalRun(root, "l-v2", resolve(output, HISTORICAL_STUDIES["l-v2"].outputSlug)).join(" ")}`,
      "Bounded K/J realtime paper": "npm run paper:mvp -- --markets 1",
    },
  };
}

/** Read only small published summaries; never scan raw data or journals. */
export function listMvpResultSummaries(dataRoot: string): MvpResultSummary[] {
  const root = resolve(dataRoot, "mvp-runs");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => right.name.localeCompare(left.name))
    .flatMap((entry): MvpResultSummary[] => {
      const file = resolve(root, entry.name, "summary.json");
      if (!existsSync(file) || statSync(file).size > 1_000_000) return [];
      try {
        const value: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
        const summary = value as Record<string, unknown>;
        const resultHash = verifiedHistoricalResultHash(summary);
        if (resultHash === null) return [];
        const summaryIntegrity = historicalPublicationIntegrity(resolve(root, entry.name), resultHash);
        if (summaryIntegrity === null) return [];
        const sourceRuns = summary.runs;
        const runs: MvpResultSummary["runs"] = {};
        if (typeof sourceRuns === "object" && sourceRuns !== null && !Array.isArray(sourceRuns)) {
          for (const [strategy, run] of Object.entries(sourceRuns)) {
            if (typeof run !== "object" || run === null || Array.isArray(run)) continue;
            const record = run as Record<string, unknown>;
            runs[strategy] = {
              netPnl: typeof record.net_pnl === "string" ? record.net_pnl : null,
              filledCount: typeof record.filled_count === "number" ? record.filled_count : null,
              maxDrawdown: typeof record.max_drawdown === "string" ? record.max_drawdown : null,
              netWithoutBest3Days: typeof record.net_without_best_3_days === "string" ? record.net_without_best_3_days : null,
            };
          }
        }
        return [{
          runId: entry.name,
          resultHash,
          split: typeof summary.split === "string" ? summary.split : null,
          scenario: typeof summary.scenario === "string" ? summary.scenario : null,
          summaryIntegrity,
          runs,
        }];
      } catch { return []; }
    });
}

/** Read only compact paper acceptance results, never journals, inputs, or metrics. */
export function listMvpPaperSummaries(dataRoot: string): MvpPaperSummary[] {
  const root = resolve(dataRoot, "paper-mvp");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => right.name.localeCompare(left.name))
    .flatMap((entry): MvpPaperSummary[] => {
      const normal = resolve(root, entry.name, "result.json");
      const recovered = resolve(root, entry.name, "final-result.json");
      const file = existsSync(recovered) ? recovered : normal;
      if (!existsSync(file) || statSync(file).size > 1_000_000) return [];
      try {
        const value: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
        const result = value as Record<string, unknown>;
        const strategies: MvpPaperSummary["strategies"] = {};
        if (typeof result.strategies === "object" && result.strategies !== null && !Array.isArray(result.strategies)) {
          for (const [name, candidate] of Object.entries(result.strategies)) {
            if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
            const strategy = candidate as Record<string, unknown>;
            strategies[name] = {
              finalCash: typeof strategy.finalCash === "string" ? strategy.finalCash : null,
              netPnl: typeof strategy.netPnl === "string" ? strategy.netPnl : null,
            };
          }
        }
        return [{
          runId: typeof result.runId === "string" ? result.runId : entry.name,
          accepted: typeof result.accepted === "boolean" ? result.accepted : null,
          resultKind: typeof result.resultKind === "string" ? result.resultKind : null,
          planBinding: typeof result.planBinding === "string" ? result.planBinding : null,
          targetMarketCount: typeof result.targetMarketCount === "number" ? result.targetMarketCount : null,
          completedMarketCount: typeof result.completedMarketCount === "number" ? result.completedMarketCount : null,
          strategies,
        }];
      } catch { return []; }
    });
}

export function commandForHistoricalRun(dataRoot: string, kind: HistoricalRunKind, output: string): string[] {
  const dataset = resolve(dataRoot, DATASET);
  const base = ["--dataset", dataset, "--dataset-hash", DATASET_HASH, "--horizon", "30", "--scenario", "BASE_1S"];
  if (kind === "kj") return ["paper-kj", ...base, "--ewma-artifact", resolve(dataRoot, EWMA), "--strategy", "both", "--split", "FINAL_TEST", "--output", output];
  const candidate = kind === "l-v1" ? "v1-preregistered" : "v2-midrange-train-selected";
  const split = kind === "l-v1" ? "TRAIN" : "VALIDATION";
  return ["paper-l-adaptive", ...base, "--candidate", candidate, "--split", split, "--output", output];
}

function trimProcessOutput(value: string): string {
  return value.length <= MAX_PROCESS_OUTPUT ? value : `${value.slice(-MAX_PROCESS_OUTPUT)}\n[truncated]`;
}

function parseRunKind(value: unknown): HistoricalRunKind | null {
  return value === "kj" || value === "l-v1" || value === "l-v2" ? value : null;
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const part of request) {
    body += String(part);
    if (body.length > 1_024) throw new Error("request body too large");
  }
  return JSON.parse(body) as unknown;
}

class HistoricalRunController {
  private readonly runs: HistoricalRun[] = [];
  private active = false;

  list(): HistoricalRun[] { return this.runs.map((run) => ({ ...run })); }

  start(options: ConsoleOptions, kind: HistoricalRunKind): HistoricalRun {
    if (!options.enableLocalHistoryRuns) throw new Error("local historical runs are disabled");
    if (this.active) throw new Error("a local historical run is already active");
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    const id = `${kind}-${stamp}`;
    const output = resolve(options.dataRoot, "mvp-runs", id);
    const outputRoot = resolve(options.dataRoot, "mvp-runs");
    if (!output.startsWith(`${outputRoot}/`)) throw new Error("unsafe output path");
    if (existsSync(output)) throw new Error("generated run output already exists");
    const executable = resolve(process.cwd(), ".venv/bin/poly-lab");
    if (!existsSync(executable)) throw new Error("local poly-lab executable is unavailable");
    mkdirSync(outputRoot, { recursive: true });
    const run: HistoricalRun = { id, kind, output, status: "RUNNING", startedAt: new Date().toISOString(), endedAt: null, exitCode: null, stdout: "", stderr: "" };
    this.runs.unshift(run); this.active = true;
    const child = spawn(executable, commandForHistoricalRun(options.dataRoot, kind, output), { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => { run.stdout = trimProcessOutput(`${run.stdout}${chunk.toString("utf8")}`); });
    child.stderr.on("data", (chunk: Buffer) => { run.stderr = trimProcessOutput(`${run.stderr}${chunk.toString("utf8")}`); });
    child.on("error", (error) => { run.stderr = trimProcessOutput(`${run.stderr}${error.message}\n`); });
    child.on("close", (code) => { run.exitCode = code; run.status = code === 0 ? "SUCCEEDED" : "FAILED"; run.endedAt = new Date().toISOString(); this.active = false; });
    return { ...run };
  }
}

function page(snapshot: MvpConsoleSnapshot, localRunsEnabled: boolean): string {
  const commands = Object.entries(snapshot.commands).map(([name, command]) => `<section><h2>${name}</h2><pre>${command}</pre></section>`).join("\n");
  const actions = localRunsEnabled ? `<section><h2>离线历史回测</h2><p>仅启动固定、离线的策略配置；不支持任意命令或网络操作。</p><button onclick="run('kj')">运行 K/J</button> <button onclick="run('l-v1')">运行 L V1</button> <button onclick="run('l-v2')">运行 L V2</button><pre id="jobs">加载中…</pre></section>` : `<section><h2>离线历史回测</h2><p>默认只读。使用 <code>--enable-local-history-runs</code> 显式启用固定回测按钮。</p></section>`;
  const jobPolling = localRunsEnabled ? "setInterval(renderJobs,1000);renderJobs();" : "";
  const client = `
const text=(value)=>value===null||value===undefined?'—':String(value);
const table=(id,headers,rows)=>{const root=document.getElementById(id);root.replaceChildren();if(rows.length===0){root.textContent='暂无已发布结果';return;}const t=document.createElement('table'),head=document.createElement('thead'),body=document.createElement('tbody'),hr=document.createElement('tr');headers.forEach(x=>{const th=document.createElement('th');th.textContent=x;hr.append(th)});head.append(hr);rows.forEach(row=>{const tr=document.createElement('tr');row.forEach(value=>{const td=document.createElement('td');td.textContent=text(value);tr.append(td)});body.append(tr)});t.append(head,body);root.append(t)};
const renderHistory=()=>fetch('/api/results').then(r=>r.json()).then(items=>{const rows=[];items.forEach(item=>Object.entries(item.runs).forEach(([strategy,run])=>rows.push([item.runId,item.split,item.scenario,item.summaryIntegrity,strategy,run.netPnl,run.maxDrawdown,run.netWithoutBest3Days,run.filledCount])));table('results',['运行','切分','情景','完整性','策略','净 PnL','最大回撤','去最佳三天','成交数'],rows)}).catch(error=>document.getElementById('results').textContent=String(error));
const renderPaper=()=>fetch('/api/paper-runs').then(r=>r.json()).then(items=>{const rows=items.map(item=>[item.runId,item.accepted,item.planBinding,item.targetMarketCount,item.completedMarketCount,item.strategies.J_FEE_AWARE?.netPnl,item.strategies.K_DUAL_VOL?.netPnl]);table('paper',['运行','验收','计划绑定','目标','完成','J 净 PnL','K 净 PnL'],rows)}).catch(error=>document.getElementById('paper').textContent=String(error));
const renderJobs=()=>fetch('/api/historical-runs').then(r=>r.json()).then(x=>document.getElementById('jobs').textContent=JSON.stringify(x,null,2));
const run=kind=>fetch('/api/historical-runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind})}).then(()=>renderJobs()).then(()=>setTimeout(renderHistory,250));
renderHistory();renderPaper();${jobPolling}`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Polymarket Money MVP</title><style>body{max-width:1080px;margin:32px auto;padding:0 18px;font:16px system-ui;background:#f7f8fb;color:#18212f}section{background:#fff;border:1px solid #dce1ea;border-radius:8px;margin:14px 0;padding:14px}.warn{background:#fff2dd;border-left:4px solid #db8414;padding:12px}pre{white-space:pre-wrap;word-break:break-all;background:#101827;color:#e7edf7;padding:12px;border-radius:6px}button{padding:8px;margin-right:8px}table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:8px;border-bottom:1px solid #dce1ea;text-align:left}th{background:#eef2f8;white-space:nowrap}td{font-family:ui-monospace,monospace}</style><h1>Polymarket Money MVP</h1><p class="warn">不会自动联网、启动 realtime paper、读取凭据或提交真实订单。</p><section><h2>状态</h2><ul><li>LIVE_TRADING_ENABLED: false</li><li>代码: ${snapshot.gitCommit}</li><li>数据: ${snapshot.datasetAvailable ? "可用" : "缺失"}</li><li>EWMA: ${snapshot.ewmaArtifactAvailable ? "可用" : "缺失"}</li><li>已有 paper 目录: ${snapshot.completedPaperRunDirectories}</li></ul></section>${actions}<section><h2>本控制台产生的历史结果</h2><div id="results">加载中…</div></section><section><h2>既有 K/J paper 验收结果</h2><div id="paper">加载中…</div></section>${commands}<p>实时 paper 必须由操作者显式复制并运行；真实下单功能不存在。</p><script>${client}</script></html>`;
}

function handler(options: ConsoleOptions, controller: HistoricalRunController, request: IncomingMessage, response: ServerResponse): void {
  const snapshot = createMvpConsoleSnapshot(options.dataRoot);
  if (request.method === "POST" && request.url === "/api/historical-runs") {
    void readRequestJson(request).then((payload) => {
      const kind = parseRunKind(typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).kind : null);
      if (kind === null) throw new Error("kind must be kj, l-v1, or l-v2");
      response.writeHead(202, { "content-type": "application/json; charset=utf-8" }); response.end(`${JSON.stringify(controller.start(options, kind), null, 2)}\n`);
    }).catch((error: unknown) => { response.writeHead(400, { "content-type": "application/json; charset=utf-8" }); response.end(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`); });
    return;
  }
  if (request.method !== "GET") { response.writeHead(405, { allow: "GET, POST" }); response.end(); return; }
  if (request.url === "/api/status") { response.writeHead(200, { "content-type": "application/json; charset=utf-8" }); response.end(`${JSON.stringify(snapshot, null, 2)}\n`); return; }
  if (request.url === "/api/results") { response.writeHead(200, { "content-type": "application/json; charset=utf-8" }); response.end(`${JSON.stringify(listMvpResultSummaries(options.dataRoot), null, 2)}\n`); return; }
  if (request.url === "/api/paper-runs") { response.writeHead(200, { "content-type": "application/json; charset=utf-8" }); response.end(`${JSON.stringify(listMvpPaperSummaries(options.dataRoot), null, 2)}\n`); return; }
  if (request.url === "/api/historical-runs") { response.writeHead(200, { "content-type": "application/json; charset=utf-8" }); response.end(`${JSON.stringify(controller.list(), null, 2)}\n`); return; }
  if (request.url === "/") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(page(snapshot, options.enableLocalHistoryRuns)); return; }
  response.writeHead(404); response.end("not found\n");
}

if (process.argv[1]?.endsWith("mvp-console.js")) {
  const args = process.argv.slice(2); const rootIndex = args.indexOf("--data-root"); const portIndex = args.indexOf("--port");
  const dataRoot = rootIndex >= 0 ? resolve(args[rootIndex + 1] ?? "") : "/root/polymarket-money-data";
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4173;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("--port must be 1024..65535");
  const options: ConsoleOptions = { dataRoot, enableLocalHistoryRuns: args.includes("--enable-local-history-runs") };
  const controller = new HistoricalRunController();
  createServer((request, response) => handler(options, controller, request, response)).listen(port, "127.0.0.1", () => process.stdout.write(`MVP console: http://127.0.0.1:${port}\n`));
}
