import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { IncidentInput } from "../query/index.js";
import type { PaperMarketHostStatusV1 } from "./host.js";

const MAX_RECORDS = 500;
const GENESIS = "0".repeat(64);

type EvidenceKind = "SNAPSHOT" | "CONNECTION" | "GAP" | "ERROR" | "SETTLEMENT_FAILURE";
type EvidenceRecord = Readonly<{ ordinal:number; kind:EvidenceKind; observedAtUtc:string; marketId:string|null; detail:string; latencyMs:number|null; ageMs:number|null; previousHash:string; recordHash:string }>;
type EvidenceState = Readonly<{ schemaVersion:"paper-runtime-evidence-state-v1"; records:readonly EvidenceRecord[]; stateHash:string }>;

function canonical(value:unknown):string { if(value===null||typeof value==="boolean"||typeof value==="string"||typeof value==="number")return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(canonical).join(",")}]`;const item=value as Record<string,unknown>;return`{${Object.keys(item).sort().map(key=>`${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`; }
function digest(value:unknown):string{return createHash("sha256").update(canonical(value)).digest("hex");}
function clean(value:string):string{return value.trim().replaceAll(/\s+/gu," ").replaceAll(/(?:\/[^\s]+|[A-Za-z]:\\[^\s]+)/gu,"[redacted]").slice(0,300)||"UNSPECIFIED";}
function utc(value:string):void{if(!value.endsWith("Z")||!Number.isFinite(Date.parse(value)))throw new Error("runtime evidence timestamp is invalid");}

export class PaperRuntimeEvidenceStore {
  readonly #directory:string;readonly #path:string;#queue:Promise<void>=Promise.resolve();
  constructor(dataRoot:string){if(!isAbsolute(dataRoot))throw new Error("dataRoot must be absolute");this.#directory=resolve(dataRoot,"workbench","paper-runtime-evidence");this.#path=join(this.#directory,"state.json");}

  async observeHost(status:PaperMarketHostStatusV1, nowUtc:string):Promise<void>{
    utc(nowUtc);await this.#mutate(async state=>{
      let records=[...state.records];const known=new Set(records.map(item=>`${item.kind}\0${item.observedAtUtc}\0${item.marketId??""}\0${item.detail}`));
      for(const event of status.events){const key=`${event.kind}\0${event.observedAtUtc}\0${event.marketId??""}\0${clean(event.detail)}`;if(known.has(key))continue;records=this.#append(records,event.kind,event.observedAtUtc,event.marketId,event.detail,null,null);known.add(key);}
      if(status.connection==="DISCONNECTED"&&status.lastConnectionAtUtc!==null){const detail="Public Paper market feed is disconnected";const key=`CONNECTION\0${status.lastConnectionAtUtc}\0\0${detail}`;if(!known.has(key))records=this.#append(records,"CONNECTION",status.lastConnectionAtUtc,null,detail,null,null);}
      return records;
    });
  }

  async observeSnapshot(value:unknown, nowUtc:string):Promise<void>{
    if(typeof value!=="object"||value===null||Array.isArray(value))return;const root=value as Record<string,unknown>;const market=root.market;if(typeof market!=="object"||market===null||Array.isArray(market))return;const item=market as Record<string,unknown>;
    if(typeof item.marketId!=="string")return;const marketId=item.marketId;utc(nowUtc);let observedAtUtc=nowUtc;let latency:number|null=null;let age:number|null=null;let timingDetail="Verified public snapshot timing";
    if(typeof item.observedAtUtc==="string"&&typeof item.receivedAtUtc==="string"){utc(item.observedAtUtc);utc(item.receivedAtUtc);observedAtUtc=item.receivedAtUtc;latency=Math.max(0,Date.parse(item.receivedAtUtc)-Date.parse(item.observedAtUtc));age=Math.max(0,Date.parse(nowUtc)-Date.parse(item.receivedAtUtc));}
    else if(typeof root.checkedAtUtc==="string"&&typeof item.bookAgeMs==="number"&&Number.isSafeInteger(item.bookAgeMs)&&item.bookAgeMs>=0){utc(root.checkedAtUtc);observedAtUtc=root.checkedAtUtc;age=item.bookAgeMs;timingDetail=`Verified public snapshot age; signal age ${typeof item.signalAgeMs==="number"?item.signalAgeMs:"unavailable"} ms`;}
    else return;
    await this.#mutate(async state=>state.records.some(record=>record.kind==="SNAPSHOT"&&record.observedAtUtc===observedAtUtc&&record.marketId===marketId)?[...state.records]:this.#append([...state.records],"SNAPSHOT",observedAtUtc,marketId,timingDetail,latency,age));
  }

  async recordSettlementFailure(message:string,nowUtc:string):Promise<void>{utc(nowUtc);await this.#mutate(async state=>this.#append([...state.records],"SETTLEMENT_FAILURE",nowUtc,null,message,null,null));}

  async observeRuntimeFailure(value:unknown,nowUtc:string):Promise<void>{if(typeof value!=="object"||value===null||Array.isArray(value))return;const planner=(value as Record<string,unknown>).planner;if(typeof planner!=="object"||planner===null||Array.isArray(planner))return;const error=(planner as Record<string,unknown>).error;if(typeof error!=="string"||error.trim()==="")return;const kind:EvidenceKind=error.startsWith("official settlement ")?"SETTLEMENT_FAILURE":"ERROR";const normalized=clean(error);utc(nowUtc);await this.#mutate(async state=>state.records.some(record=>record.kind===kind&&record.detail===normalized)?[...state.records]:this.#append([...state.records],kind,nowUtc,null,normalized,null,null));}

  async incidents():Promise<readonly IncidentInput[]>{
    const records=(await this.#load()).records;const latestConnection=[...records].reverse().find(item=>item.kind==="CONNECTION");const snapshotRecords=records.filter(item=>item.kind==="SNAPSHOT");
    const values:IncidentInput[]=[];
    for(const record of records.filter(item=>item.kind==="GAP"||item.kind==="ERROR"||item.kind==="SETTLEMENT_FAILURE"))values.push(Object.freeze({incidentId:`paper-${record.recordHash.slice(0,24)}`,occurredAtUtc:record.observedAtUtc,severity:record.kind==="GAP"?"warning":"error",component:"paper-execution",code:record.kind,message:clean(record.detail),resolved:false}));
    if(latestConnection!==undefined)values.push(Object.freeze({incidentId:`paper-connection-${latestConnection.recordHash.slice(0,13)}`,occurredAtUtc:latestConnection.observedAtUtc,severity:"warning",component:"paper-execution",code:"PUBLIC_FEED_CONNECTION",message:clean(latestConnection.detail),resolved:!latestConnection.detail.toLowerCase().includes("disconnect")}));
    if(snapshotRecords.length>0){const latencies=snapshotRecords.flatMap(item=>item.latencyMs===null?[]:[item.latencyMs]).sort((a,b)=>a-b);const ages=snapshotRecords.flatMap(item=>item.ageMs===null?[]:[item.ageMs]).sort((a,b)=>a-b);const latest=snapshotRecords.at(-1)!;const p95=(values:number[])=>values[Math.max(0,Math.ceil(values.length*.95)-1)];values.push(Object.freeze({incidentId:`paper-latency-${latest.recordHash.slice(0,16)}`,occurredAtUtc:latest.observedAtUtc,severity:"info",component:"paper-execution",code:"SNAPSHOT_LATENCY",message:`Snapshot latency p95 ${latencies.length===0?"unavailable":p95(latencies)} ms across ${latencies.length} samples; age p95 ${ages.length===0?"unavailable":p95(ages)} ms across ${ages.length} persisted samples`,resolved:true}));}
    return Object.freeze(values);
  }

  async #mutate(change:(state:EvidenceState)=>Promise<EvidenceRecord[]>):Promise<void>{let failure:unknown;const operation=this.#queue.then(async()=>{const state=await this.#load();await this.#save(await change(state));}).catch(error=>{failure=error;});this.#queue=operation;await operation;if(failure!==undefined)throw failure;}
  #append(records:EvidenceRecord[],kind:EvidenceKind,observedAtUtc:string,marketId:string|null,eventDetail:string,latencyMs:number|null,ageMs:number|null):EvidenceRecord[]{utc(observedAtUtc);const ordinal=(records.at(-1)?.ordinal??0)+1;const previousHash=records.at(-1)?.recordHash??GENESIS;const core={ordinal,kind,observedAtUtc,marketId,detail:clean(eventDetail),latencyMs,ageMs,previousHash};records.push(Object.freeze({...core,recordHash:digest(core)}));if(records.length>MAX_RECORDS){records=records.slice(-MAX_RECORDS);records=records.map((record,index)=>{const previousHash=index===0?GENESIS:records[index-1]!.recordHash;const core={ordinal:record.ordinal,kind:record.kind,observedAtUtc:record.observedAtUtc,marketId:record.marketId,detail:record.detail,latencyMs:record.latencyMs,ageMs:record.ageMs,previousHash};return Object.freeze({...core,recordHash:digest(core)});});}return records;}
  async #load():Promise<EvidenceState>{const raw=await readFile(this.#path,"utf8").catch((error:NodeJS.ErrnoException)=>error.code==="ENOENT"?null:Promise.reject(error));if(raw===null)return Object.freeze({schemaVersion:"paper-runtime-evidence-state-v1",records:Object.freeze([]),stateHash:digest([])});const value=JSON.parse(raw) as EvidenceState;if(value.schemaVersion!=="paper-runtime-evidence-state-v1"||!Array.isArray(value.records)||value.records.length>MAX_RECORDS||value.stateHash!==digest(value.records))throw new Error("paper runtime evidence state is invalid or tampered");let previous=GENESIS;for(const record of value.records){const core={ordinal:record.ordinal,kind:record.kind,observedAtUtc:record.observedAtUtc,marketId:record.marketId,detail:record.detail,latencyMs:record.latencyMs,ageMs:record.ageMs,previousHash:record.previousHash};if(record.previousHash!==previous||record.recordHash!==digest(core))throw new Error("paper runtime evidence hash chain is invalid");previous=record.recordHash;}return value;}
  async #save(records:EvidenceRecord[]):Promise<void>{await mkdir(this.#directory,{recursive:true,mode:0o700});const state:EvidenceState=Object.freeze({schemaVersion:"paper-runtime-evidence-state-v1",records:Object.freeze(records),stateHash:digest(records)});const temporary=join(this.#directory,`state.${process.pid}.${randomUUID()}.partial`);await writeFile(temporary,`${JSON.stringify(state)}\n`,{flag:"wx",mode:0o600});await rename(temporary,this.#path);}
}
