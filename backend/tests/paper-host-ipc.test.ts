import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DESKTOP_KJ_ACCOUNTS, PaperHostRuntime, parsePaperHostRequest } from "../../scripts/paper-market-host.js";
import { FileOfficialPaperSettlementStore, FilePaperSessionStateStore, OfficialGammaPaperSettlementCoordinator, PaperSessionService, type CallerManagedPublicMarketAdapter, type OfficialPaperSettlementRecordV1, type OfficialPaperSettlementStore, type PublicGammaResolutionSource, type PublicPaperFeedObserver, type PublicPaperMarketFeed } from "../paper-session/index.js";
import type { KJStrategyContextV1 } from "../../strategies/src/kj-context.js";
import { createKJStrategyContext } from "../../strategies/src/kj-context.js";

function request(command: Parameters<PaperHostRuntime["execute"]>[0]["command"], payload: Record<string, unknown> = {}) {
  return { schemaVersion: "paper-host-ipc-request-v1" as const, requestId: `request-${command}`, command, payload };
}

test("Paper host IPC is inert, closed and refuses network start without explicit approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "paper-host-ipc-"));
  const runtime = new PaperHostRuntime(root); await runtime.initialize();
  const status = await runtime.execute(request("host-status")) as Record<string, unknown>;
  assert.equal(status.lifecycle, "STOPPED"); assert.equal(status.ready, false);
  const marketRuntime = await runtime.execute(request("get-paper-market-runtime")) as Record<string, unknown>;
  assert.deepEqual(marketRuntime, {
    schemaVersion: "paper-market-runtime-v1", status: "STOPPED",
    checkedAtUtc: marketRuntime.checkedAtUtc,
    market: null,
  });
  assert.deepEqual(await runtime.execute(request("get-paper-strategy-runtime")), {
    schemaVersion: "paper-strategy-runtime-v2",
    status: "STOPPED",
    executionAuthority: "PAPER_SESSION",
    planner: { engineVersion: "kj-paper-engine-v2", journalRecordCount: 0, recoveredInputCount: 0, lastRecordHash: null, error: null },
    canonicalAccounts: [], executionLinks: [], shadow: { nonAuthoritative: true, snapshot: null, events: [] },
  });
  await assert.rejects(runtime.execute(request("start-public-feed", { slug: "btc-updown-5m-1775181000" })), /explicit network approval/);
  assert.deepEqual(await runtime.execute(request("list-paper-sessions")), []);
  await runtime.close();
});

function fixtureFeed(slug: string): PublicPaperMarketFeed {
  return {
    feedId: `fixture-${slug}`, source: "PUBLIC_MARKET_DATA", access: "READ_ONLY",
    async start(observer) {
      const now = new Date().toISOString(); observer.connection(true, now, "OFFLINE_FIXTURE_CONNECTED");
      observer.snapshot({ schemaVersion: "paper-market-snapshot-v1", marketId: "fixture-market", observedAtUtc: now, receivedAtUtc: now, eligible: true, yesAsks: [{ price: "0.5", quantity: "2" }], noAsks: [{ price: "0.5", quantity: "2" }] });
    },
    async stop() {},
  };
}

test("desktop host creates and restores fixed J/K canonical sessions before exposing v2 runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "paper-host-canonical-")); const slug = "btc-updown-5m-1775181000";
  const first = new PaperHostRuntime(root, undefined, { feedFactory: fixtureFeed }); await first.initialize();
  await first.execute(request("start-public-feed", { slug, explicitNetworkApproval: true }));
  const runtime = await first.execute(request("get-paper-strategy-runtime")) as Record<string, unknown>;
  assert.equal(runtime.schemaVersion, "paper-strategy-runtime-v2"); assert.equal(runtime.executionAuthority, "PAPER_SESSION");
  const accounts = runtime.canonicalAccounts as Array<{ strategy: string; session: { sessionId: string; cash: string } }>;
  assert.deepEqual(accounts.map((value) => [value.strategy, value.session.sessionId, value.session.cash]), [["J_FEE_AWARE", "desktop-kj-j", "10000"], ["K_DUAL_VOL", "desktop-kj-k", "10000"]]);
  assert.equal((runtime.shadow as { nonAuthoritative: boolean }).nonAuthoritative, true); await first.close();

  const second = new PaperHostRuntime(root, undefined, { feedFactory: fixtureFeed }); await second.initialize();
  await second.execute(request("start-public-feed", { slug, explicitNetworkApproval: true }));
  const sessions = await second.execute(request("list-paper-sessions")) as Array<{ sessionId: string }>;
  assert.deepEqual(sessions.map((value) => value.sessionId), ["desktop-kj-j", "desktop-kj-k"]); await second.close();
});

test("Paper host IPC parser rejects extra fields, unknown commands and oversized input", () => {
  const valid = JSON.stringify(request("host-status"));
  assert.equal(parsePaperHostRequest(valid).command, "host-status");
  assert.equal(parsePaperHostRequest(JSON.stringify(request("get-paper-strategy-runtime"))).command, "get-paper-strategy-runtime");
  assert.equal(parsePaperHostRequest(JSON.stringify(request("get-paper-market-runtime"))).command, "get-paper-market-runtime");
  assert.throws(() => parsePaperHostRequest(JSON.stringify({ ...request("host-status"), path: "/tmp" })), /fields are invalid/);
  assert.throws(() => parsePaperHostRequest(JSON.stringify({ ...request("host-status"), command: "shell" })), /unsupported/);
  assert.throws(() => parsePaperHostRequest("x".repeat(1024 * 1024 + 1)), /exceeds limit/);
});

test("persistent Paper host runtime preserves one session and order ledger across IPC requests", async()=>{
  const root=await mkdtemp(join(tmpdir(),"paper-host-state-")); const now="2026-07-21T14:00:00.000Z"; const adapter:CallerManagedPublicMarketAdapter={adapterId:"fixture-host",source:"PUBLIC_MARKET_DATA",lifecycle:"CALLER_MANAGED",isReady:()=>true,latest:(marketId)=>{const receivedAtUtc=new Date(Date.now()-1000).toISOString();return{schemaVersion:"paper-market-snapshot-v1",marketId,observedAtUtc:receivedAtUtc,receivedAtUtc,eligible:true,yesAsks:[{price:"0.5",quantity:"2"}],noAsks:[{price:"0.5",quantity:"2"}]};}};
  const runtime=new PaperHostRuntime(root,adapter);await runtime.initialize();await runtime.execute(request("start-paper-session",{request:{schemaVersion:"paper-session-start-v1",sessionId:"ipc-session",initialCash:"100",risk:{schemaVersion:"paper-risk-config-v1",maximumQuoteAgeMs:3600000,minimumNetEdge:"0.01",maximumOrderNotional:"100",maximumMarketExposure:"100",maximumTotalExposure:"100"},startedAtUtc:now}}));
  const order=await runtime.execute(request("submit-paper-order",{sessionId:"ipc-session",request:{schemaVersion:"paper-order-request-v1",idempotencyKey:"ipc-idem",clientOrderId:"ipc-client",marketId:"market-1",token:"YES",limitPrice:"0.5",quantity:"1",timeInForce:"GTC",expiresAtUtc:null,modelProbabilityYes:"0.7",feeRate:"0.01"}})) as Record<string,unknown>;assert.equal(order.status,"FILLED");
  const detail=await runtime.execute(request("get-paper-session-detail",{sessionId:"ipc-session"})) as Record<string,unknown>;assert.equal((detail.orders as unknown[]).length,1);assert.equal((detail.fills as unknown[]).length,1);await runtime.close();
});

class LifecycleFeed implements PublicPaperMarketFeed {
  readonly feedId="lifecycle-fixture"; readonly source="PUBLIC_MARKET_DATA" as const; readonly access="READ_ONLY" as const;
  observer:PublicPaperFeedObserver|null=null;
  async start(observer:PublicPaperFeedObserver){this.observer=observer;const now=new Date().toISOString();observer.connection(true,now,"offline lifecycle fixture");this.emit("0.6","10");}
  emit(price:string,quantity:string){const now=new Date().toISOString();this.observer?.snapshot({schemaVersion:"paper-market-snapshot-v1",marketId:"lifecycle-market",observedAtUtc:now,receivedAtUtc:now,eligible:true,yesAsks:[{price,quantity}],noAsks:[{price:"0.5",quantity:"10"}]});}
  async stop(){this.observer=null;}
}

test("long-running Web host rematches a persisted v2 GTC on each new public snapshot",async()=>{
  const root=await mkdtemp(join(tmpdir(),"paper-host-lifecycle-"));const feed=new LifecycleFeed();const runtime=new PaperHostRuntime(root,undefined,{feedFactory:()=>feed});await runtime.initialize();
  await runtime.execute(request("start-public-feed",{slug:"btc-updown-5m-1775181000",explicitNetworkApproval:true}));
  const now=Date.now();const order=await runtime.execute(request("submit-paper-order",{sessionId:DESKTOP_KJ_ACCOUNTS.J_FEE_AWARE,request:{schemaVersion:"paper-order-request-v2",idempotencyKey:"host-resting-v2",clientOrderId:"host-resting-v2",marketId:"lifecycle-market",token:"YES",limitPrice:"0.5",quantity:"2",timeInForce:"GTC",expiresAtUtc:null,modelProbabilityYes:"0.8",feeEvidence:{schemaVersion:"paper-fee-evidence-v1",model:"POLYMARKET_TAKER_CURVE_V1",conditionId:"host-lifecycle-condition",rate:"0.02",effectiveFromUtc:new Date(now-60_000).toISOString(),effectiveToUtc:new Date(now+60_000).toISOString(),evidenceStatus:"VERIFIED",evidenceReference:"offline-fixture:host-lifecycle"}}})) as {orderId:string;status:string};
  assert.equal(order.status,"OPEN");feed.emit("0.5","2");
  for(let attempt=0;attempt<100;attempt+=1){const detail=await runtime.execute(request("get-paper-session-detail",{sessionId:DESKTOP_KJ_ACCOUNTS.J_FEE_AWARE})) as {orders:Array<{orderId:string;status:string}>;fills:unknown[]};const current=detail.orders.find((value)=>value.orderId===order.orderId);if(current?.status==="FILLED"){assert.equal(detail.fills.length,1);await runtime.close();return;}await flush();}
  await runtime.close();throw new Error("snapshot lifecycle did not fill the resting order");
});

class SettlementFeed implements PublicPaperMarketFeed{readonly feedId="settlement-fixture";readonly source="PUBLIC_MARKET_DATA" as const;readonly access="READ_ONLY" as const;observer:PublicPaperFeedObserver|null=null;constructor(readonly now:()=>string){}async start(observer:PublicPaperFeedObserver){this.observer=observer;observer.connection(true,this.now(),"fixture connected");observer.snapshot({schemaVersion:"paper-market-snapshot-v1",marketId:"golden-market-1",observedAtUtc:this.now(),receivedAtUtc:this.now(),eligible:true,yesAsks:[{price:"0.5",quantity:"2"}],noAsks:[{price:"0.5",quantity:"2"}]});}async stop(){this.observer=null;}}
class SettlementClock{now=Date.parse("2026-07-17T00:04:59.000Z");tasks:Array<{id:object;callback:()=>void;delay:number;cleared:boolean}>=[];setTimer=(callback:()=>void,delay:number)=>{const id={};this.tasks.push({id,callback,delay,cleared:false});return id as ReturnType<typeof setTimeout>;};clearTimer=(timer:ReturnType<typeof setTimeout>)=>{const task=this.tasks.find((item)=>item.id===timer);if(task!==undefined)task.cleared=true;};fire(){const task=this.tasks.find((item)=>!item.cleared);assert.ok(task);task.cleared=true;this.now+=task.delay;task.callback();}}
class SettlementGamma implements PublicGammaResolutionSource{readonly source="PUBLIC_GAMMA" as const;readonly access="READ_ONLY" as const;calls=0;constructor(readonly payload:string,readonly pendingFirst=false){}async fetch(slug:string){this.calls+=1;assert.equal(slug,"btc-updown-5m-1784246400");return{responseStatus:200,rawPayload:this.pendingFirst&&this.calls===1?JSON.stringify({...JSON.parse(this.payload),umaResolutionStatus:"proposed"}):this.payload,receiveTime:"2026-07-17T00:05:53.000Z"};}}
function settlementContext():KJStrategyContextV1{const bookStamp={schemaVersion:"receive-stamp-v1" as const,clockDomain:"host-settlement-test",localWallReceiveTime:"2026-07-17T00:04:59.000Z",localMonotonicReceiveNs:"1",localReceiveOrdinal:"1"};const signalStamp={...bookStamp,localMonotonicReceiveNs:"2",localReceiveOrdinal:"2"};const result=createKJStrategyContext({decisionTime:"2026-07-17T00:04:59.000Z",market:{marketId:"golden-market-1",conditionId:`0x${"a".repeat(64)}`,slug:"btc-updown-5m-1784246400",intervalStart:"2026-07-17T00:00:00.000Z",intervalEnd:"2026-07-17T00:05:00.000Z",upTokenId:"111",downTokenId:"222",active:true,closed:false,acceptingOrders:true,collectible:true,takerFeeRate:"0.07",rawPayload:"{}"},book:{state:"ACTIVE_UNVERIFIED",continuity:"UNVERIFIED",up:{bid:"0.49",ask:"0.5",bidSize:"2",askSize:"2"},down:{bid:"0.49",ask:"0.5",bidSize:"2",askSize:"2"},receiveStamp:bookStamp},signal:{provider:"BINANCE_SPOT",price:"67000",sourceTime:null,serverTime:null,receiveTime:"2026-07-17T00:04:59.000Z",receiveStamp:signalStamp,connectionId:"fixture-binance",inputHash:"a".repeat(64)}});if(!result.ready)throw new Error(result.reason);return result.context;}
const flush=async()=>{await new Promise<void>((resolve)=>setImmediate(resolve));await new Promise<void>((resolve)=>setImmediate(resolve));};
async function waitForSettlement(runtime:PaperHostRuntime,sessionId:string){for(let attempt=0;attempt<100;attempt+=1){const detail=await runtime.execute(request("get-paper-session-detail",{sessionId})) as {settlements:unknown[]};if(detail.settlements.length===1)return;await flush();}throw new Error(`timed out waiting for ${sessionId} settlement`);}

test("long-running host polls approved public Gamma after interval end and settles canonical J/K",async()=>{const root=await mkdtemp(join(tmpdir(),"paper-host-official-settlement-"));const clock=new SettlementClock();const gamma=new SettlementGamma(await readFile(new URL("../../../data/fixtures/batch-06/gamma-resolved-market.json",import.meta.url),"utf8"));const feed=new SettlementFeed(()=>new Date(clock.now).toISOString());const runtime=new PaperHostRuntime(root,undefined,{feedFactory:()=>feed,gammaSource:gamma,nowMs:()=>clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer,settlementRetryDelaysMs:[10]});await runtime.initialize();await runtime.execute(request("start-public-feed",{slug:"btc-updown-5m-1784246400",explicitNetworkApproval:true}));feed.observer?.strategyContext?.(settlementContext());const strategy=await runtime.execute(request("get-paper-strategy-runtime")) as {planner:{error:string|null}};assert.equal(strategy.planner.error,null);assert.equal(gamma.calls,0);clock.fire();await flush();assert.equal(gamma.calls,1);for(const sessionId of ["desktop-kj-j","desktop-kj-k"])await waitForSettlement(runtime,sessionId);await runtime.close();assert.equal(clock.tasks.filter((task)=>!task.cleared).length,0);});

test("host retries unresolved Gamma with a finite delay and stop cancels pending polling",async()=>{const root=await mkdtemp(join(tmpdir(),"paper-host-settlement-retry-"));const clock=new SettlementClock();const gamma=new SettlementGamma(await readFile(new URL("../../../data/fixtures/batch-06/gamma-resolved-market.json",import.meta.url),"utf8"),true);const feed=new SettlementFeed(()=>new Date(clock.now).toISOString());const runtime=new PaperHostRuntime(root,undefined,{feedFactory:()=>feed,gammaSource:gamma,nowMs:()=>clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer,settlementRetryDelaysMs:[10]});await runtime.initialize();await runtime.execute(request("start-public-feed",{slug:"btc-updown-5m-1784246400",explicitNetworkApproval:true}));feed.observer?.strategyContext?.(settlementContext());await runtime.execute(request("get-paper-strategy-runtime"));clock.fire();await flush();assert.equal(gamma.calls,1);assert.equal(clock.tasks.filter((task)=>!task.cleared).length,1);await runtime.execute(request("stop-public-feed"));assert.equal(clock.tasks.filter((task)=>!task.cleared).length,0);assert.equal(gamma.calls,1);await runtime.close();});

class FailOfficialTerminalFileStore implements OfficialPaperSettlementStore{attempt=0;constructor(readonly inner:FileOfficialPaperSettlementStore){}load(){return this.inner.load();}async append(record:OfficialPaperSettlementRecordV1){this.attempt+=1;if(this.attempt===2)throw new Error("injected host recovery terminal failure");await this.inner.append(record);}}
test("host restart completes a pending official outbox locally without a Gamma request",async()=>{const root=await mkdtemp(join(tmpdir(),"paper-host-settlement-recovery-"));const state=new FilePaperSessionStateStore(root);const setupPaper=new PaperSessionService({adapterId:"setup-official",source:"PUBLIC_MARKET_DATA",lifecycle:"CALLER_MANAGED",isReady:()=>true,latest:()=>null},state);await setupPaper.initialize();for(const sessionId of Object.values(DESKTOP_KJ_ACCOUNTS))await setupPaper.start({schemaVersion:"paper-session-start-v1",sessionId,initialCash:"10000",risk:{schemaVersion:"paper-risk-config-v1",maximumQuoteAgeMs:15000,minimumNetEdge:"0.05",maximumOrderNotional:"400",maximumMarketExposure:"400",maximumTotalExposure:"4000"},startedAtUtc:"2026-07-17T00:00:01.000Z"});const fileStore=new FileOfficialPaperSettlementStore(root);const crashed=new OfficialGammaPaperSettlementCoordinator(setupPaper,new FailOfficialTerminalFileStore(fileStore),DESKTOP_KJ_ACCOUNTS);await crashed.initialize();const payload=await readFile(new URL("../../../data/fixtures/batch-06/gamma-resolved-market.json",import.meta.url),"utf8");await assert.rejects(crashed.applyGamma({expectedMarket:{marketId:"golden-market-1",conditionId:`0x${"a".repeat(64)}`,slug:"btc-updown-5m-1784246400",intervalStart:"2026-07-17T00:00:00.000Z",intervalEnd:"2026-07-17T00:05:00.000Z",upTokenId:"111",downTokenId:"222",active:true,closed:false,acceptingOrders:true,collectible:true,takerFeeRate:"0.07",rawPayload:"{}"},responseStatus:200,rawPayload:payload,receiveTime:"2026-07-17T00:05:53.000Z"}),/terminal failure/u);const gamma=new SettlementGamma(payload);const runtime=new PaperHostRuntime(root,undefined,{feedFactory:fixtureFeed,gammaSource:gamma});await runtime.initialize();await runtime.execute(request("start-public-feed",{slug:"btc-updown-5m-1784246400",explicitNetworkApproval:true}));const lines=(await readFile(join(root,"workbench","paper-sessions","kj-official-settlement-links.jsonl"),"utf8")).trim().split("\n");assert.equal(lines.length,2);assert.equal(gamma.calls,0);await runtime.close();});
