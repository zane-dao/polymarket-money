/** Credential-free local MVP console. It never starts collection or orders. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

function page(snapshot: MvpConsoleSnapshot): string {
  const commands = Object.entries(snapshot.commands).map(([name, command]) => `<section><h2>${name}</h2><pre>${command}</pre></section>`).join("\n");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Polymarket Money MVP</title><style>body{max-width:960px;margin:32px auto;padding:0 18px;font:16px system-ui;background:#f7f8fb;color:#18212f}section{background:#fff;border:1px solid #dce1ea;border-radius:8px;margin:14px 0;padding:14px}.warn{background:#fff2dd;border-left:4px solid #db8414;padding:12px}pre{white-space:pre-wrap;word-break:break-all;background:#101827;color:#e7edf7;padding:12px;border-radius:6px}</style><h1>Polymarket Money MVP</h1><p class="warn">只展示命令和已发布结果：不会自动联网、启动 paper、读取凭据或提交真实订单。</p><section><h2>状态</h2><ul><li>LIVE_TRADING_ENABLED: false</li><li>代码: ${snapshot.gitCommit}</li><li>数据: ${snapshot.datasetAvailable ? "可用" : "缺失"}</li><li>EWMA: ${snapshot.ewmaArtifactAvailable ? "可用" : "缺失"}</li><li>已有 paper 目录: ${snapshot.completedPaperRunDirectories}</li></ul></section><section><h2>本控制台产生的历史结果</h2><pre id="results">加载中…</pre></section>${commands}<p>实时 paper 必须由操作者显式复制并运行；真实下单功能不存在。</p><script>fetch('/api/results').then(r=>r.json()).then(x=>document.getElementById('results').textContent=JSON.stringify(x,null,2)).catch(e=>document.getElementById('results').textContent=String(e))</script></html>`;
}

function handler(dataRoot: string, request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== "GET") { response.writeHead(405, { allow: "GET" }); response.end(); return; }
  const snapshot = createMvpConsoleSnapshot(dataRoot);
  if (request.url === "/api/status") { response.writeHead(200, { "content-type": "application/json; charset=utf-8" }); response.end(`${JSON.stringify(snapshot, null, 2)}\n`); return; }
  if (request.url === "/api/results") { response.writeHead(200, { "content-type": "application/json; charset=utf-8" }); response.end(`${JSON.stringify(listMvpResultSummaries(dataRoot), null, 2)}\n`); return; }
  if (request.url === "/") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(page(snapshot)); return; }
  response.writeHead(404); response.end("not found\n");
}

if (process.argv[1]?.endsWith("mvp-console.js")) {
  const args = process.argv.slice(2); const rootIndex = args.indexOf("--data-root"); const portIndex = args.indexOf("--port");
  const dataRoot = rootIndex >= 0 ? resolve(args[rootIndex + 1] ?? "") : "/root/polymarket-money-data";
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4173;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("--port must be 1024..65535");
  createServer((request, response) => handler(dataRoot, request, response)).listen(port, "127.0.0.1", () => process.stdout.write(`MVP console: http://127.0.0.1:${port}\n`));
}
