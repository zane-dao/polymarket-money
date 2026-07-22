import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lstat, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

import { executeWorkbenchCommand } from "./workbench-command.js";
import { PaperHostRuntime, type PaperHostIpcRequestV1 } from "./paper-market-host.js";
import { PaperRuntimeEvidenceStore } from "../backend/paper-session/runtime-evidence.js";
import { BackendQueryService, type PageRequestV1, type SystemStatusSource } from "../backend/query/index.js";
import { FileBacktestResultStore } from "../backend/backtest/jobs.js";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_STATIC_BYTES = 16 * 1024 * 1024;
const SAFE_COMMAND = /^[a-z][a-z0-9_]{0,95}$/u;

const BACKEND_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  get_workbench_manifest_v1: "manifest", get_workbench_view_v1: "view",
  list_strategy_definitions_v1: "list-strategy-definitions", list_strategy_versions_v1: "list-strategy-versions",
  get_strategy_version_v1: "get-strategy-version", validate_strategy_parameters_v1: "validate-strategy-parameters",
  save_strategy_version_v1: "save-strategy-version", register_dataset_source_v1: "register-dataset-source",
  normalize_raw_dataset_v1: "normalize-raw-dataset",
  scan_datasets_v1: "scan-datasets", list_datasets_v1: "list-datasets", get_dataset_v1: "get-dataset",
  validate_dataset_selection_v1: "validate-dataset-selection", start_backtest_v1: "start-backtest",
  get_backtest_job_v1: "get-backtest-job", list_backtest_jobs_v1: "list-backtest-jobs",
  stop_backtest_v1: "stop-backtest", get_backtest_result_v1: "get-backtest-result",
  get_backtest_decisions_v1: "get-backtest-decisions", get_backtest_orders_v1: "get-backtest-orders",
  get_backtest_fills_v1: "get-backtest-fills", get_backtest_settlements_v1: "get-backtest-settlements",
  get_backtest_equity_v1: "get-backtest-equity", get_backtest_replay_v1: "get-backtest-replay",
  compare_backtests_v1: "compare-backtests", get_system_health_v1: "get-system-health",
  list_system_incidents_v1: "list-system-incidents",
});

const PAPER_COMMANDS: Readonly<Record<string, PaperHostIpcRequestV1["command"]>> = Object.freeze({
  get_paper_market_host_status_v1: "host-status", get_paper_market_runtime_v1: "get-paper-market-runtime",
  get_paper_strategy_runtime_v1: "get-paper-strategy-runtime", start_public_paper_market_host_v1: "start-public-feed",
  stop_public_paper_market_host_v1: "stop-public-feed", list_paper_sessions_v1: "list-paper-sessions",
  get_paper_replay_v1: "get-paper-replay", start_paper_session_v1: "start-paper-session",
  get_paper_session_status_v1: "get-paper-session-status", stop_paper_session_v1: "stop-paper-session",
  resume_paper_session_v1: "resume-paper-session", get_paper_session_detail_v1: "get-paper-session-detail",
  submit_paper_order_v1: "submit-paper-order", cancel_paper_order_v1: "cancel-paper-order",
  reprice_paper_order_v1: "reprice-paper-order", expire_paper_orders_v1: "expire-paper-orders",
  settle_paper_market_v1: "settle-paper-market", get_paper_system_control_v1: "get-paper-system-control",
  set_paper_kill_switch_v1: "set-paper-kill-switch",
});

type WebResponse = Readonly<{ schemaVersion:"workbench-web-response-v1";ok:true;result:unknown }>|Readonly<{ schemaVersion:"workbench-web-response-v1";ok:false;error:Readonly<{code:string;message:string}> }>;

function json(response:ServerResponse,status:number,value:WebResponse):void {
  const body=JSON.stringify(value);response.writeHead(status,{"content-type":"application/json; charset=utf-8","content-length":Buffer.byteLength(body),"cache-control":"no-store","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; frame-ancestors 'none'"});response.end(body);
}

function fail(response:ServerResponse,status:number,code:string,message:string):void { json(response,status,{schemaVersion:"workbench-web-response-v1",ok:false,error:{code,message:message.slice(0,500)}}); }

async function body(request:IncomingMessage):Promise<Readonly<Record<string,unknown>>> {
  if (!(request.headers["content-type"]??"").toLowerCase().startsWith("application/json"))throw new Error("Content-Type must be application/json");
  const chunks:Buffer[]=[];let size=0;for await(const chunk of request){const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=value.length;if(size>MAX_BODY_BYTES)throw new Error("request body exceeds limit");chunks.push(value);}
  const parsed:unknown=JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}");if(parsed===null||typeof parsed!=="object"||Array.isArray(parsed))throw new Error("request body must be an object");return parsed as Record<string,unknown>;
}

function appStatus():unknown { return Object.freeze({schemaVersion:"app-status-v1",generatedAtUtc:new Date().toISOString().replace(/\.\d{3}Z$/u,"Z"),appVersion:"0.1.0",mode:"paper-only",liveTradingEnabled:false,dataRootConfigured:true,modules:Object.freeze([{moduleId:"web-backend",availability:"available"},{moduleId:"typescript-execution",availability:"available"},{moduleId:"python-research",availability:"available"}])}); }

export class WorkbenchWebApplication {
  readonly #paper:PaperHostRuntime;readonly #evidence:PaperRuntimeEvidenceStore;#sequence=0;
  constructor(readonly dataRoot:string){if(!dataRoot.startsWith("/"))throw new Error("dataRoot must be absolute");this.#paper=new PaperHostRuntime(dataRoot);this.#evidence=new PaperRuntimeEvidenceStore(dataRoot);}
  async initialize():Promise<void>{await this.#paper.initialize();}
  async close():Promise<void>{await this.#paper.close();}
  async execute(command:string,payload:Readonly<Record<string,unknown>>):Promise<unknown>{
    if(command==="get_app_status_v1")return appStatus();
    const now=new Date().toISOString();
    const backend=BACKEND_COMMANDS[command];
    if(backend!==undefined){
      if(backend==="get-system-health"||backend==="list-system-incidents"){
        const base=await executeWorkbenchCommand("get-system-health",{},now,this.dataRoot) as Awaited<ReturnType<SystemStatusSource["health"]>>;
        const incidents=await this.#evidence.incidents();
        const source:SystemStatusSource={async health(){return{...base,status:incidents.some(item=>!item.resolved&&item.severity==="error")?"degraded":base.status};},async incidents(){return incidents;}};
        const queries=new BackendQueryService(new FileBacktestResultStore(this.dataRoot),source);
        return backend==="get-system-health"?queries.health():queries.incidents(payload.page as PageRequestV1);
      }
      return executeWorkbenchCommand(backend,payload,now,this.dataRoot);
    }
    const paper=PAPER_COMMANDS[command];if(paper!==undefined){
      try{
        const result=await this.#paper.execute({schemaVersion:"paper-host-ipc-request-v1",requestId:`web-${++this.#sequence}`,command:paper,payload});
        const status=await this.#paper.execute({schemaVersion:"paper-host-ipc-request-v1",requestId:`web-${++this.#sequence}`,command:"host-status",payload:{}});
        await this.#evidence.observeHost(status as never,now);
        if(paper==="get-paper-market-runtime")await this.#evidence.observeSnapshot(result,now);
        if(paper==="get-paper-strategy-runtime")await this.#evidence.observeRuntimeFailure(result,now);
        return result;
      }catch(error:unknown){if(paper==="settle-paper-market")await this.#evidence.recordSettlementFailure(error instanceof Error?error.message:"Paper settlement failed",now);throw error;}
    }
    throw new Error("unsupported Web backend command");
  }
}

export type WorkbenchWebServerOptions=Readonly<{dataRoot:string;staticRoot?:string;port?:number}>;

export async function createWorkbenchWebServer(options:WorkbenchWebServerOptions):Promise<{server:Server;application:WorkbenchWebApplication;port:number;close():Promise<void>}> {
  const application=new WorkbenchWebApplication(options.dataRoot);await application.initialize();const staticRoot=resolve(options.staticRoot??resolve(process.cwd(),"frontend","dist"));const requestedPort=options.port??4173;if(!Number.isSafeInteger(requestedPort)||requestedPort<0||requestedPort>65535)throw new Error("Web port is invalid");
  let actualPort=0;const server=createServer(async(request,response)=>{try{const host=request.headers.host??"";if(actualPort!==0&&host!==`127.0.0.1:${actualPort}`&&host!==`localhost:${actualPort}`){fail(response,403,"HOST_REJECTED","Host is not allowed");return;}const origin=request.headers.origin;if(origin!==undefined&&origin!==`http://${host}`){fail(response,403,"ORIGIN_REJECTED","Origin is not allowed");return;}const url=new URL(request.url??"/",`http://${host||"127.0.0.1"}`);if(url.pathname.startsWith("/api/commands/")){if(request.method!=="POST"||request.headers["x-workbench-client"]!=="web-v1"){fail(response,405,"REQUEST_REJECTED","fixed JSON POST client is required");return;}const command=decodeURIComponent(url.pathname.slice("/api/commands/".length));if(!SAFE_COMMAND.test(command)){fail(response,404,"COMMAND_NOT_FOUND","command is unavailable");return;}const result=await application.execute(command,await body(request));json(response,200,{schemaVersion:"workbench-web-response-v1",ok:true,result});return;}if(request.method!=="GET"&&request.method!=="HEAD"){fail(response,405,"METHOD_NOT_ALLOWED","method is unavailable");return;}const requested=url.pathname==="/"?"index.html":decodeURIComponent(url.pathname.slice(1));const path=resolve(staticRoot,requested);if(relative(staticRoot,path).startsWith("..")){fail(response,404,"ASSET_NOT_FOUND","asset is unavailable");return;}const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_STATIC_BYTES)throw new Error("asset is unavailable");const bytes=await readFile(path);const types:Record<string,string>={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".map":"application/json"};response.writeHead(200,{"content-type":types[extname(path)]??"application/octet-stream","content-length":bytes.length,"x-content-type-options":"nosniff","referrer-policy":"no-referrer","content-security-policy":"default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});response.end(request.method==="HEAD"?undefined:bytes);}catch(error:unknown){fail(response,400,"REQUEST_FAILED",error instanceof Error?error.message:"request failed");}});
  await new Promise<void>((resolveListen,reject)=>{server.once("error",reject);server.listen(requestedPort,"127.0.0.1",()=>{server.off("error",reject);const address=server.address();actualPort=typeof address==="object"&&address!==null?address.port:requestedPort;resolveListen();});});
  return{server,application,port:actualPort,async close(){await new Promise<void>((resolveClose,reject)=>server.close(error=>error===undefined?resolveClose():reject(error)));await application.close();}};
}

if(process.argv[1]?.endsWith("workbench-web-server.js")){
  const dataRoot=process.env.POLYMARKET_DATA_ROOT;if(dataRoot===undefined)throw new Error("POLYMARKET_DATA_ROOT is required");const portText=process.env.POLYMARKET_WEB_PORT??"4173";if(!/^[0-9]+$/u.test(portText))throw new Error("POLYMARKET_WEB_PORT is invalid");const runtime=await createWorkbenchWebServer({dataRoot,port:Number(portText)});process.stdout.write(`Paper-only workbench: http://127.0.0.1:${runtime.port}\n`);const shutdown=async()=>{await runtime.close();process.exit(0);};process.once("SIGINT",()=>void shutdown());process.once("SIGTERM",()=>void shutdown());
}
