import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PaperRuntimeEvidenceStore } from "../paper-session/runtime-evidence.js";
import type { PaperMarketHostStatusV1 } from "../paper-session/host.js";

const T0="2026-07-22T00:00:00.000Z";const T1="2026-07-22T00:00:00.025Z";const T2="2026-07-22T00:00:01.000Z";
function status(events:PaperMarketHostStatusV1["events"],connection:PaperMarketHostStatusV1["connection"]="DEGRADED"):PaperMarketHostStatusV1{return{schemaVersion:"paper-market-host-status-v1",hostId:"web-paper-host",feedId:"public-feed",source:"PUBLIC_MARKET_DATA",executionMode:"PAPER_ONLY",lifecycle:"RUNNING",connection,ready:false,cachedMarketCount:0,snapshotCount:0,gapCount:events.filter(item=>item.kind==="GAP").length,errorCount:events.filter(item=>item.kind==="ERROR").length,lastSnapshotAtUtc:null,lastConnectionAtUtc:events.find(item=>item.kind==="CONNECTION")?.observedAtUtc??null,events};}

test("Paper runtime evidence recovers incidents and aggregate snapshot latency",async()=>{const root=await mkdtemp(join(tmpdir(),"paper-evidence-"));const first=new PaperRuntimeEvidenceStore(root);await first.observeHost(status([{kind:"GAP",observedAtUtc:T0,marketId:"btc-5m",detail:"sequence gap"}]),T2);await first.observeSnapshot({market:{marketId:"btc-5m",observedAtUtc:T0,receivedAtUtc:T1}},T2);const recovered=await new PaperRuntimeEvidenceStore(root).incidents();assert.equal(recovered.some(item=>item.code==="GAP"&&!item.resolved),true);assert.match(recovered.find(item=>item.code==="SNAPSHOT_LATENCY")?.message??"",/latency p95 25 ms.*age p95 975 ms/u);assert.equal(JSON.stringify(recovered).includes(root),false);});

test("Paper runtime evidence resolves latest connection state and rejects tampering",async()=>{const root=await mkdtemp(join(tmpdir(),"paper-evidence-tamper-"));const store=new PaperRuntimeEvidenceStore(root);await store.observeHost(status([{kind:"CONNECTION",observedAtUtc:T0,marketId:null,detail:"feed disconnected"}],"DISCONNECTED"),T0);await store.observeHost(status([{kind:"CONNECTION",observedAtUtc:T0,marketId:null,detail:"feed disconnected"},{kind:"CONNECTION",observedAtUtc:T1,marketId:null,detail:"feed connected"}],"CONNECTED"),T1);assert.equal((await new PaperRuntimeEvidenceStore(root).incidents()).find(item=>item.code==="PUBLIC_FEED_CONNECTION")?.resolved,true);const path=join(root,"workbench","paper-runtime-evidence","state.json");const raw=await readFile(path,"utf8");await writeFile(path,raw.replace("feed connected","feed corrupted"));await assert.rejects(new PaperRuntimeEvidenceStore(root).incidents(),/tampered|hash chain/u);});

test("Paper runtime evidence keeps a valid bounded chain after compaction",async()=>{
  const root=await mkdtemp(join(tmpdir(),"paper-evidence-compact-"));
  const store=new PaperRuntimeEvidenceStore(root);
  for(let index=0;index<501;index+=1){
    const at=new Date(Date.parse(T0)+index).toISOString();
    await store.observeHost(status([{kind:"GAP",observedAtUtc:at,marketId:"btc-5m",detail:`gap ${index}`}]),at);
  }
  const recovered=await new PaperRuntimeEvidenceStore(root).incidents();
  assert.equal(recovered.filter(item=>item.code==="GAP").length,500);
});
