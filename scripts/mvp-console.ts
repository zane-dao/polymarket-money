/** Credential-free local MVP console. It never starts collection or orders. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync, spawn } from "node:child_process";
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
  runs: Record<string, { netPnl: string | null; filledCount: number | null }>;
};

type HistoricalRunKind = "kj" | "l-v1" | "l-v2";
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
  const dataset = resolve(root, DATASET);
  const ewma = resolve(root, EWMA);
  const output = resolve(root, "mvp-runs");
  const base = `--dataset ${dataset} --dataset-hash ${DATASET_HASH} --horizon 30 --scenario BASE_1S`;
  const paperRoot = resolve(root, "paper-mvp");
  return {
    liveTradingEnabled: false, dataRoot: root, datasetAvailable: existsSync(dataset), ewmaArtifactAvailable: existsSync(ewma),
    gitCommit: commit(), completedPaperRunDirectories: existsSync(paperRoot) ? readdirSync(paperRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length : 0,
    commands: {
      "K/J historical replay": `.venv/bin/poly-lab paper-kj ${base} --ewma-artifact ${ewma} --strategy both --split FINAL_TEST --output ${resolve(output, "kj-final-test")}`,
      "L V1 historical replay": `.venv/bin/poly-lab paper-l-adaptive ${base} --candidate v1-preregistered --split TRAIN --output ${resolve(output, "l-v1-train")}`,
      "L V2 historical replay": `.venv/bin/poly-lab paper-l-adaptive ${base} --candidate v2-midrange-train-selected --split VALIDATION --output ${resolve(output, "l-v2-validation")}`,
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
        const sourceRuns = summary.runs;
        const runs: MvpResultSummary["runs"] = {};
        if (typeof sourceRuns === "object" && sourceRuns !== null && !Array.isArray(sourceRuns)) {
          for (const [strategy, run] of Object.entries(sourceRuns)) {
            if (typeof run !== "object" || run === null || Array.isArray(run)) continue;
            const record = run as Record<string, unknown>;
            runs[strategy] = {
              netPnl: typeof record.net_pnl === "string" ? record.net_pnl : null,
              filledCount: typeof record.filled_count === "number" ? record.filled_count : null,
            };
          }
        }
        return [{
          runId: entry.name,
          resultHash: typeof summary.result_hash === "string" ? summary.result_hash : null,
          split: typeof summary.split === "string" ? summary.split : null,
          scenario: typeof summary.scenario === "string" ? summary.scenario : null,
          runs,
        }];
      } catch { return []; }
    });
}

function commandForHistoricalRun(dataRoot: string, kind: HistoricalRunKind, output: string): string[] {
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
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Polymarket Money MVP</title><style>body{max-width:960px;margin:32px auto;padding:0 18px;font:16px system-ui;background:#f7f8fb;color:#18212f}section{background:#fff;border:1px solid #dce1ea;border-radius:8px;margin:14px 0;padding:14px}.warn{background:#fff2dd;border-left:4px solid #db8414;padding:12px}pre{white-space:pre-wrap;word-break:break-all;background:#101827;color:#e7edf7;padding:12px;border-radius:6px}button{padding:8px;margin-right:8px}</style><h1>Polymarket Money MVP</h1><p class="warn">不会自动联网、启动 realtime paper、读取凭据或提交真实订单。</p><section><h2>状态</h2><ul><li>LIVE_TRADING_ENABLED: false</li><li>代码: ${snapshot.gitCommit}</li><li>数据: ${snapshot.datasetAvailable ? "可用" : "缺失"}</li><li>EWMA: ${snapshot.ewmaArtifactAvailable ? "可用" : "缺失"}</li><li>已有 paper 目录: ${snapshot.completedPaperRunDirectories}</li></ul></section>${actions}<section><h2>本控制台产生的历史结果</h2><pre id="results">加载中…</pre></section>${commands}<p>实时 paper 必须由操作者显式复制并运行；真实下单功能不存在。</p><script>const show=(id,url)=>fetch(url).then(r=>r.json()).then(x=>document.getElementById(id).textContent=JSON.stringify(x,null,2)).catch(e=>document.getElementById(id).textContent=String(e));const run=k=>fetch('/api/historical-runs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:k})}).then(r=>r.json()).then(()=>show('jobs','/api/historical-runs'));show('results','/api/results');${localRunsEnabled ? "setInterval(()=>show('jobs','/api/historical-runs'),1000);show('jobs','/api/historical-runs');" : ""}</script></html>`;
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
