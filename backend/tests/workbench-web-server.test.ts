import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createWorkbenchWebServer, validateWorkbenchEnvironment } from "../../scripts/workbench-web-server.js";
import { PaperRuntimeEvidenceStore } from "../paper-session/runtime-evidence.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workbench-web-data-"));
  const assets = await mkdtemp(join(tmpdir(), "workbench-web-assets-"));
  await mkdir(join(root, "normalized"), { recursive: true });
  await writeFile(join(assets, "index.html"), "<!doctype html><title>workbench</title>", "utf8");
  const runtime = await createWorkbenchWebServer({ dataRoot: root, staticRoot: assets, port: 0 });
  return { ...runtime, base: `http://127.0.0.1:${runtime.port}` };
}

async function command(base: string, name: string, payload: unknown = {}) {
  return fetch(`${base}/api/commands/${name}`, {
    method: "POST", headers: { "content-type": "application/json", "x-workbench-client": "web-v1" },
    body: JSON.stringify(payload),
  });
}

test("loopback Web API serves the app and strict path-free backend DTOs", async () => {
  const runtime = await fixture();
  try {
    const page = await fetch(runtime.base); assert.equal(page.status, 200); assert.match(await page.text(), /workbench/);
    const response = await command(runtime.base, "get_workbench_view_v1"); assert.equal(response.status, 200);
    const envelope = await response.json() as { ok: boolean; result: unknown };
    assert.equal(envelope.ok, true); assert.equal(JSON.stringify(envelope.result).includes(runtime.application.dataRoot), false);
    const status = await (await command(runtime.base, "get_app_status_v1")).json() as { result: { liveTradingEnabled: boolean; modules: Array<{moduleId:string}> } };
    assert.equal(status.result.liveTradingEnabled, false); assert.equal(status.result.modules.some((item) => item.moduleId === "web-backend"), true);
  } finally { await runtime.close(); }
});

test("Web API rejects unknown commands, cross-origin calls and non-fixed clients", async () => {
  const runtime = await fixture();
  try {
    assert.equal((await command(runtime.base, "arbitrary_shell_v1", { command: "whoami" })).status, 400);
    assert.equal((await fetch(`${runtime.base}/api/commands/get_workbench_view_v1`, { method:"POST", headers:{"content-type":"application/json"}, body:"{}" })).status, 405);
    assert.equal((await fetch(`${runtime.base}/api/commands/get_workbench_view_v1`, { method:"POST", headers:{"content-type":"application/json","x-workbench-client":"web-v1","origin":"https://attacker.invalid"}, body:"{}" })).status, 403);
  } finally { await runtime.close(); }
});

test("simulation environments fail closed when their data roots are crossed", () => {
  assert.equal(validateWorkbenchEnvironment("staging-sim", "/tmp/workbench/staging-sim", "candidate-1"), "staging-sim");
  assert.equal(validateWorkbenchEnvironment("production-sim", "/tmp/workbench/production-sim", "stable-1"), "production-sim");
  assert.throws(() => validateWorkbenchEnvironment("staging-sim", "/tmp/workbench/production-sim", "candidate-1"), /staging-sim data root/u);
  assert.throws(() => validateWorkbenchEnvironment("production-sim", "/tmp/workbench/staging-sim", "stable-1"), /production-sim data root/u);
  assert.throws(() => validateWorkbenchEnvironment("production-sim", "/tmp/workbench/production-sim", "bad release"), /RELEASE_ID/u);
});

test("candidate release refreshes 4273 and verifies the actual runtime", async () => {
  const source = await readFile(resolve("scripts/local-environments.mjs"), "utf8");
  assert.match(source, /async function refreshCandidate\(\)/u);
  assert.match(source, /async function restartOrStartCandidateService\(\)/u);
  assert.match(source, /systemctl", \["--user", "restart", candidateUnit\]/u);
  assert.match(source, /systemd-run", \["--user", "--unit=polymarket-staging-4273"/u);
  assert.match(source, /waitForCandidateRelease\(releaseId\)/u);
  assert.match(source, /assertWarningRegression\(\)/u);
});

test("Web API normalizes an explicit raw file through one fixed path-free command",async()=>{const runtime=await fixture(),rawRoot=await mkdtemp(join(tmpdir(),"workbench-web-raw-")),input=join(rawRoot,"events.ndjson");await writeFile(input,JSON.stringify({event_type:"binance_price",event_time_utc:"2026-01-01T00:00:01Z",market_id:"btc-web",provider:"BINANCE_SPOT",symbol:"BTCUSDT",price:"100000"})+"\n");try{const response=await command(runtime.base,"normalize_raw_dataset_v1",{request:{schemaVersion:"raw-dataset-normalization-request-v1",inputPath:input,datasetId:"btc-web-raw"}});assert.equal(response.status,200);const envelope=await response.json() as {result:{datasetId:string;rowCount:number;versionHash:string}};assert.equal(envelope.result.datasetId,"btc-web-raw");assert.equal(envelope.result.rowCount,1);assert.equal(JSON.stringify(envelope).includes(input),false);const listed=await(await command(runtime.base,"list_datasets_v1")).json() as {result:{datasets:Array<{datasetId:string}>}};assert.equal(listed.result.datasets[0]?.datasetId,"btc-web-raw");}finally{await runtime.close();}});

test("one Web process preserves Paper session state across requests", async () => {
  const runtime = await fixture();
  try {
    const listed = await (await command(runtime.base, "list_paper_sessions_v1")).json() as {result:Array<{sessionId:string}>};
    assert.deepEqual(listed.result, []);
    const enabled = await (await command(runtime.base, "set_paper_kill_switch_v1", {enabled:true,reason:"WEB_TEST"})).json() as {result:{killSwitchEnabled:boolean}};
    assert.equal(enabled.result.killSwitchEnabled, true);
    const recovered = await (await command(runtime.base, "get_paper_system_control_v1")).json() as {result:{killSwitchEnabled:boolean}};
    assert.equal(recovered.result.killSwitchEnabled, true);
  } finally { await runtime.close(); }
});

test("Web health commands recover persisted Paper incidents with fixed pagination",async()=>{
  const root=await mkdtemp(join(tmpdir(),"workbench-web-evidence-"));const assets=await mkdtemp(join(tmpdir(),"workbench-web-evidence-assets-"));await mkdir(join(root,"normalized"),{recursive:true});await writeFile(join(assets,"index.html"),"<!doctype html><title>workbench</title>");
  const evidence=new PaperRuntimeEvidenceStore(root);await evidence.recordSettlementFailure("official settlement source unavailable","2026-07-22T00:00:00.000Z");await evidence.recordSettlementFailure("official settlement evidence conflicted","2026-07-22T00:00:01.000Z");
  const runtime=await createWorkbenchWebServer({dataRoot:root,staticRoot:assets,port:0});const base=`http://127.0.0.1:${runtime.port}`;
  try{const first=await(await command(base,"list_system_incidents_v1",{page:{page:1,pageSize:1}})).json() as {result:{totalItems:number;totalPages:number;items:Array<{code:string}>}};assert.equal(first.result.totalItems,2);assert.equal(first.result.totalPages,2);assert.equal(first.result.items.length,1);assert.equal(first.result.items[0]?.code,"SETTLEMENT_FAILURE");const health=await(await command(base,"get_system_health_v1")).json() as {result:{status:string;liveTradingEnabled:boolean}};assert.equal(health.result.status,"degraded");assert.equal(health.result.liveTradingEnabled,false);assert.equal(JSON.stringify(first).includes(root),false);}finally{await runtime.close();}
});
