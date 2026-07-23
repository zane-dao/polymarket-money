import assert from "node:assert/strict";
import test from "node:test";
import { PaperMarketHost, PublicBtcPaperMarketFeed, RotatingPublicBtcPaperMarketFeed, type BinanceSpotObservationV1, type PublicBinanceSpotObserver, type PublicBinanceSpotSource, type PublicPaperFeedObserver, type PublicPaperMarketFeed, type PublicClobStrategySource, type PublicClobStrategyObservationV1, type RotationTimer } from "../paper-session/index.js";
import type { PaperMarketSnapshotV1 } from "../paper-simulation/index.js";
import type { KJStrategyContextV1 } from "../../strategies/src/kj-context.js";

class FakeClob implements PublicClobStrategySource { readonly feedId="clob"; readonly source="PUBLIC_MARKET_DATA" as const; readonly access="READ_ONLY" as const; observer: PublicPaperFeedObserver|null=null; observation:PublicClobStrategyObservationV1|null=null; async start(value: PublicPaperFeedObserver){this.observer=value;} async stop(){this.observer=null;} latestStrategyObservation(){return this.observation;} }
class FakeBinance implements PublicBinanceSpotSource { readonly source="PUBLIC_BINANCE_SPOT" as const; readonly access="READ_ONLY" as const; observer:PublicBinanceSpotObserver|null=null; value:BinanceSpotObservationV1|null=null; async start(value:PublicBinanceSpotObserver){this.observer=value;} async stop(){this.observer=null;this.value=null;} latest(){return this.value;} }
const NOW="2026-07-21T14:00:00.000Z";
const snapshot:PaperMarketSnapshotV1={schemaVersion:"paper-market-snapshot-v1",marketId:"btc-5m",observedAtUtc:NOW,receivedAtUtc:NOW,eligible:true,yesAsks:[{price:"0.5",quantity:"1"}],noAsks:[{price:"0.5",quantity:"1"}]};
const ticker:BinanceSpotObservationV1={symbol:"BTCUSDT",bid:"67000",bidSize:"1",ask:"67001",askSize:"2",sourceTime:NOW,serverTime:NOW,updateId:"1",receivedAtUtc:NOW,connectionId:"bn-1",inputHash:"a".repeat(64)};

test("combined BTC feed publishes execution snapshots only while both public sources are connected and fresh", async()=>{
  const clob=new FakeClob(); const binance=new FakeBinance(); let now=NOW; let mono=0n; const combined=new PublicBtcPaperMarketFeed("combined",clob,binance,{maximumSignalAgeMs:1000,now:()=>now,receiveClock:new (await import("../core/src/domain/receive-time.js")).ReceiveClock({clockDomain:"combined-test",wallNow:()=>now,monotonicNowNs:()=>++mono})}); const snapshots:PaperMarketSnapshotV1[]=[]; const contexts:KJStrategyContextV1[]=[]; const connections:boolean[]=[];
  await combined.start({snapshot:(value)=>snapshots.push(value),strategyContext:(value)=>contexts.push(value),connection:(value)=>connections.push(value),gap:()=>undefined,error:()=>undefined});
  clob.observation={market:{marketId:"btc-5m",conditionId:"condition",slug:"btc-updown-5m-1753106400",intervalStart:"2026-07-21T14:00:00.000Z",intervalEnd:"2026-07-21T14:05:00.000Z",upTokenId:"1",downTokenId:"2",active:true,closed:false,acceptingOrders:true,collectible:true,takerFeeRate:"0.01",rawPayload:"{}"},receivedAtUtc:NOW,state:"ACTIVE_UNVERIFIED",continuity:"UNVERIFIED",up:{bid:"0.49",ask:"0.5",bidSize:"1",askSize:"1"},down:{bid:"0.49",ask:"0.5",bidSize:"1",askSize:"1"}};
  clob.observer?.connection(true,NOW,"clob"); clob.observer?.snapshot(snapshot); assert.equal(snapshots.length,0);
  binance.observer?.connection(true,NOW,"binance"); binance.value=ticker; binance.observer?.ticker(ticker); assert.equal(snapshots.length,1); assert.equal(contexts.length,1); assert.equal(contexts[0]?.book.receiveStamp.clockDomain,"combined-test"); assert.equal(contexts[0]?.signal.receiveStamp.clockDomain,"combined-test"); assert.deepEqual(connections,[true]);
  now="2026-07-21T14:00:00.500Z";const freshTicker={...ticker,receivedAtUtc:now,updateId:"2"};binance.value=freshTicker;binance.observer?.ticker(freshTicker);clob.observer?.snapshot(snapshot);assert.equal(snapshots.length,1,"standardized strategy input is emitted at most once per second");
  now="2026-07-21T14:00:01.001Z"; clob.observer?.snapshot(snapshot); assert.equal(snapshots.length,2);now="2026-07-21T14:00:01.501Z";assert.equal(combined.latestBinance(),null);
  binance.observer?.connection(false,now,"disconnect"); assert.deepEqual(connections,[true,false]); await combined.stop();
});

class FakeMarketFeed implements PublicPaperMarketFeed {
  readonly source="PUBLIC_MARKET_DATA" as const; readonly access="READ_ONLY" as const; observer:PublicPaperFeedObserver|null=null; stopCount=0;
  constructor(readonly feedId:string,readonly failStart=false){}
  async start(observer:PublicPaperFeedObserver){if(this.failStart)throw new Error(`failed ${this.feedId}`);this.observer=observer;}
  async stop(){this.stopCount+=1;}
}
class FakeRotationClock {
  now=1_753_106_400_000; tasks:Array<{id:object;callback:()=>void;delay:number;cleared:boolean}>=[];
  readonly setTimer=(callback:()=>void,delay:number):RotationTimer=>{const id={};this.tasks.push({id,callback,delay,cleared:false});return id as RotationTimer;};
  readonly clearTimer=(timer:RotationTimer)=>{const task=this.tasks.find((item)=>item.id===timer);if(task!==undefined)task.cleared=true;};
  fireNext(){const task=this.tasks.find((item)=>!item.cleared);assert.ok(task);task.cleared=true;this.now+=task.delay;task.callback();}
}
const observer=()=>{const snapshots:PaperMarketSnapshotV1[]=[];const connections:boolean[]=[];const errors:unknown[]=[];return{snapshots,connections,errors,value:{snapshot:(value:PaperMarketSnapshotV1)=>snapshots.push(value),connection:(value:boolean)=>connections.push(value),gap:()=>undefined,error:(error:unknown)=>errors.push(error)}};};
const flush=async()=>{await new Promise<void>((resolve)=>setImmediate(resolve));};

test("rotating BTC feed switches at the five-minute boundary and isolates the old generation",async()=>{
  const clock=new FakeRotationClock();const feeds:FakeMarketFeed[]=[];const slugs:string[]=[];const feed=new RotatingPublicBtcPaperMarketFeed("btc-updown-5m-1753106400",(slug)=>{slugs.push(slug);const value=new FakeMarketFeed(`fake-${slug}`);feeds.push(value);return value;},{nowMs:()=>clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer,retryDelaysMs:[10]});const output=observer();
  await feed.start(output.value);assert.deepEqual(slugs,["btc-updown-5m-1753106400"]);const oldObserver=feeds[0]?.observer;assert.ok(oldObserver);clock.fireNext();await flush();assert.deepEqual(slugs,["btc-updown-5m-1753106400","btc-updown-5m-1753106700"]);assert.equal(feeds[0]?.stopCount,1);
  oldObserver.snapshot(snapshot);assert.equal(output.snapshots.length,0);feeds[1]?.observer?.snapshot({...snapshot,marketId:"next-market",observedAtUtc:new Date(clock.now).toISOString(),receivedAtUtc:new Date(clock.now).toISOString()});assert.equal(output.snapshots.length,1);
  await feed.stop();assert.equal(feeds[1]?.stopCount,1);assert.equal(output.connections.at(-1),false);assert.equal(clock.tasks.filter((task)=>!task.cleared).length,0);
});

test("rotation failures degrade the host, retry only within the configured bound, and recover",async()=>{
  const clock=new FakeRotationClock();let attempts=0;const feeds:FakeMarketFeed[]=[];const feed=new RotatingPublicBtcPaperMarketFeed("btc-updown-5m-1753106400",(slug)=>{const value=new FakeMarketFeed(`attempt-${++attempts}-${slug}`,attempts<3);feeds.push(value);return value;},{nowMs:()=>clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer,retryDelaysMs:[10,20]});const host=new PaperMarketHost(feed,{hostId:"rotating-host",now:()=>new Date(clock.now).toISOString()});
  await host.start();assert.equal(host.status().connection,"DEGRADED");assert.equal(attempts,1);clock.fireNext();await flush();assert.equal(attempts,2);assert.equal(host.status().connection,"DEGRADED");clock.fireNext();await flush();assert.equal(attempts,3);
  feeds[2]?.observer?.connection(true,new Date(clock.now).toISOString(),"recovered");assert.equal(host.status().connection,"CONNECTED");assert.equal(clock.tasks.filter((task)=>!task.cleared).length,1);await host.stop();assert.equal(clock.tasks.filter((task)=>!task.cleared).length,0);
});

test("rotation exhausts bounded retries and waits for the next boundary",async()=>{
  const clock=new FakeRotationClock();let attempts=0;const feed=new RotatingPublicBtcPaperMarketFeed("btc-updown-5m-1753106400",(slug)=>new FakeMarketFeed(`failed-${++attempts}-${slug}`,true),{nowMs:()=>clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer,retryDelaysMs:[10]});const output=observer();await feed.start(output.value);assert.equal(attempts,1);clock.fireNext();await flush();assert.equal(attempts,2);const pending=clock.tasks.find((task)=>!task.cleared);assert.ok(pending);assert.ok(pending.delay>299_000);assert.equal(output.errors.length,2);await feed.stop();
});
