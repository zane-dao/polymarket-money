import { expect, test } from "@playwright/test";

const pages = [
  ["总览", "把一个研究判断，推进到可审查的证据"],
  ["实时驾驶舱", "自动 Paper Runner"],
  ["决策记录", "决策记录"],
  ["策略工作室", "策略工作室"],
  ["数据集管理", "数据集管理"],
  ["回测实验室", "回测实验室"],
  ["市场回放", "市场回放"],
  ["策略竞技场", "回测分析 · 策略对比"],
  ["系统健康", "准入与健康"],
] as const;

test("all workbench routes render without browser errors", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/");
  await expect(page.getByText("PAPER ONLY · LIVE OFF")).toBeVisible();
  const helpTrigger = page.getByRole("button", { name: "打开工作台帮助" });
  await helpTrigger.click();
  await expect(page.getByRole("dialog", { name: "研究工作台说明" })).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭工作台帮助" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "研究工作台说明" })).toHaveCount(0);
  await expect(helpTrigger).toBeFocused();
  for (const [navigationLabel, heading] of pages) {
    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: new RegExp(navigationLabel) }).click();
    await expect(page.getByRole("heading", { name: new RegExp(heading) })).toBeVisible();
  }
  expect(browserErrors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  if (testInfo.project.name === "desktop-chromium") {
    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: /总览/ }).click();
    await page.screenshot({ path: "/tmp/polymarket-money-playwright/desktop-overview.png", fullPage: true });
  } else {
    await page.screenshot({ path: "/tmp/polymarket-money-playwright/mobile-health.png", fullPage: true });
  }
});

test("production live page is inert until the operator starts the automatic Runner", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: /实时驾驶舱/ }).click();
  await expect(page.getByText("已停止", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "启动自动 Paper" })).toBeEnabled();
  await expect(page.getByLabel("Paper 会话 ID")).toHaveCount(0);
  await expect(page.getByLabel("精确 BTC 5 分钟 slug")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "模拟订单票据" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /真实|live/i })).toHaveCount(0);
});

test("operator can run automatic Paper and inspect comparable arena results", async ({ page }, testInfo) => {
  let running = false;
  const response = (result: unknown) => ({ schemaVersion: "workbench-web-response-v1", ok: true, result });
  const host = () => ({ schemaVersion:"paper-market-host-status-v1",hostId:"paper-runner",feedId:running?"btc-auto":"unconfigured",source:"PUBLIC_MARKET_DATA",executionMode:"PAPER_ONLY",lifecycle:running?"RUNNING":"STOPPED",connection:running?"CONNECTED":"DISCONNECTED",ready:running,cachedMarketCount:running?1:0,snapshotCount:running?4:0,gapCount:0,errorCount:0,lastSnapshotAtUtc:running?"2026-07-22T12:00:02.000Z":null,lastConnectionAtUtc:running?"2026-07-22T12:00:00.000Z":null,events:[] });
  const definition = (strategyId:string,displayName:string) => ({strategyId,displayName,family:"BTC 概率",researchStatus:"PAPER_READY",riskLevel:"MEDIUM",runtime:"python",allowedModes:["backtest","paper"],parameters:{edgeThreshold:{type:"number",required:true,defaultValue:0.05,minimum:0,maximum:0.25},maxEdge:{type:"number",required:true,defaultValue:0.25,minimum:0,maximum:1},maxStakeUsdc:{type:"number",required:true,defaultValue:400,minimum:1,maximum:100000},bookParticipation:{type:"number",required:true,defaultValue:0.5,minimum:0.000001,maximum:1}}});
  const scope={schemaVersion:"backtest-evaluation-scope-v1",split:"VALIDATION",horizonSeconds:300,scenario:"BASE_1S",cohortHash:"a".repeat(64),cohortSize:1440};
  await page.route("**/api/commands/*", async (route) => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1);
    let result: unknown;
    if(command==="list_strategy_definitions_v1")result=[definition("J_FEE_AWARE","费用感知概率策略（J）"),definition("K_DUAL_VOL","双波动率概率策略（K）")];
    else if(command==="list_strategy_versions_v1")result=["1.0.0"];
    else if(command==="start_public_paper_market_host_v1"){running=true;result=host();}
    else if(command==="get_paper_market_host_status_v1")result=host();
    else if(command==="get_paper_market_runtime_v1")result={schemaVersion:"paper-market-runtime-v1",status:running?"READY":"STOPPED",checkedAtUtc:"2026-07-22T12:00:02.000Z",market:running?{marketId:"market-1",conditionId:"condition-1",slug:"btc-updown-5m-1784721600",intervalStart:"2026-07-22T12:00:00.000Z",intervalEnd:"2026-07-22T12:05:00.000Z",decisionTime:"2026-07-22T12:00:02.000Z",continuity:"UNVERIFIED",bookAgeMs:8,signalAgeMs:5,up:{tokenId:"1",bid:"0.49",ask:"0.5",bidSize:"50",askSize:"50"},down:{tokenId:"2",bid:"0.49",ask:"0.5",bidSize:"50",askSize:"50"},signal:{provider:"BINANCE_SPOT",price:"68000",sourceTime:null,serverTime:null,receiveTime:"2026-07-22T12:00:02.000Z"},feeEvidence:{schemaVersion:"paper-fee-evidence-v1",model:"POLYMARKET_TAKER_CURVE_V1",conditionId:"condition-1",rate:"0.01",effectiveFromUtc:"2026-07-22T12:00:00.000Z",effectiveToUtc:"2026-07-22T12:05:00.000Z",evidenceStatus:"UNVERIFIED",evidenceReference:"e2e"}}:null};
    else if(command==="get_paper_strategy_runtime_v1")result={schemaVersion:"paper-strategy-runtime-v2",status:running?"RUNNING":"STOPPED",executionAuthority:"PAPER_SESSION",planner:{engineVersion:"kj-paper-engine-v2",journalRecordCount:running?4:0,recoveredInputCount:0,lastRecordHash:null,error:null},canonicalAccounts:running?[{strategy:"J_FEE_AWARE",session:{schemaVersion:"paper-session-view-v1",sessionId:"runner-j",status:"RUNNING",adapterId:"paper-runner",startedAtUtc:"2026-07-22T12:00:00Z",updatedAtUtc:"2026-07-22T12:00:02Z",cash:"2490",openOrderCount:0,fillCount:1,systemKillSwitchEnabled:false}}]:[],executionLinks:[],shadow:{nonAuthoritative:true,snapshot:null,events:running?[{schemaVersion:"kj-paper-engine-v2",eventId:"decision-1",eventType:"DECISION",strategy:"J_FEE_AWARE",marketId:"market-1",eventTime:"2026-07-22T12:00:02Z",details:{action:"INTENT",reason:"EDGE_ACCEPTED",probabilityUp:"0.61",netEdge:"0.08",targetPositionQuantity:"20",riskStatus:"APPROVED",riskApprovedQuantity:"20"}}]:[]}};
    else if(command==="get_paper_session_detail_v1")result={schemaVersion:"paper-session-detail-v1",session:{schemaVersion:"paper-session-view-v1",sessionId:"runner-j",status:"RUNNING",adapterId:"paper-runner",startedAtUtc:"2026-07-22T12:00:00Z",updatedAtUtc:"2026-07-22T12:00:02Z",cash:"2490",openOrderCount:0,fillCount:1,systemKillSwitchEnabled:false},orders:[{schemaVersion:"paper-order-v1",orderId:"o1",clientOrderId:"c1",idempotencyKey:"i1",marketId:"market-1",token:"YES",limitPrice:"0.5",quantity:"20",filledQuantity:"20",remainingQuantity:"0",timeInForce:"FAK",expiresAtUtc:null,status:"FILLED",rejectionReason:null,createdAtUtc:"2026-07-22T12:00:02Z",updatedAtUtc:"2026-07-22T12:00:02Z"}],fills:[{fillId:"f1",orderId:"o1",marketId:"market-1",token:"YES",price:"0.5",quantity:"20",fee:"0.05",filledAtUtc:"2026-07-22T12:00:02Z"}],positions:[{marketId:"market-1",token:"YES",quantity:"20",cost:"10"}],settlements:[],events:[]};
    else if(command==="list_backtest_jobs_v1")result=[{schemaVersion:"backtest-job-v1",runId:"j-run",requestId:"j",displayName:"J 验证集",status:"succeeded",progressPermille:1000,error:null},{schemaVersion:"backtest-job-v1",runId:"k-run",requestId:"k",displayName:"K 验证集",status:"succeeded",progressPermille:1000,error:null}];
    else if(command==="list_datasets_v1")result={schemaVersion:"dataset-list-v2",scannedAtUtc:"2026-07-22T00:00:00Z",datasets:[{schemaVersion:"dataset-list-item-v2",datasetId:"btc",versionHash:"b".repeat(64),format:"normalized-events-v1",continuity:"UNVERIFIED",startTimeUtc:"2026-07-01T00:00:00Z",endTimeUtc:"2026-07-02T00:00:00Z",rowCount:1440,quarantineCount:0,status:"available",displayName:"BTC 5m 验证集",description:"固定样本",publishedAtUtc:"2026-07-22T00:00:00Z",source:"e2e-fixture",tags:["validation"],management:"managed"}]};
    else if(command==="compare_backtests_v1")result=[{schemaVersion:"run-comparison-v1",runId:"j-run",displayName:"J 验证集",strategyId:"J_FEE_AWARE",strategyVersion:"1.0.0",datasetId:"btc",completedAtUtc:"2026-07-22T00:00:00Z",evaluationScope:scope,metrics:{netPnl:"18.4",fees:"2.1",maxDrawdown:"-4.2",fillRate:"0.71",winRate:"0.56",brier:"0.19"}},{schemaVersion:"run-comparison-v1",runId:"k-run",displayName:"K 验证集",strategyId:"K_DUAL_VOL",strategyVersion:"1.0.0",datasetId:"btc",completedAtUtc:"2026-07-22T00:00:00Z",evaluationScope:scope,metrics:{netPnl:"12.7",fees:"1.8",maxDrawdown:"-3.8",fillRate:"0.68",winRate:"0.54",brier:"0.18"}}];
    else if(command==="get_backtest_result_v1"){const body=route.request().postDataJSON() as {runId:string};const isJ=body.runId==="j-run";result={schemaVersion:"backtest-result-v1",runId:body.runId,request:{schemaVersion:"backtest-request-v1",requestId:isJ?"j":"k",displayName:isJ?"J 验证集":"K 验证集",strategyId:isJ?"J_FEE_AWARE":"K_DUAL_VOL",strategyVersion:"1.0.0",datasetId:"btc",datasetVersionHash:"b".repeat(64),feeModel:"fee-v2",latencyMs:1000,initialCash:"1000",maxPosition:"100",evaluationSplit:"VALIDATION"},startedAtUtc:"2026-07-21T00:00:00Z",completedAtUtc:"2026-07-22T00:00:00Z",evaluationScope:scope,metrics:{netPnl:isJ?"18.4":"12.7",fees:isJ?"2.1":"1.8",maxDrawdown:isJ?"-4.2":"-3.8",fillRate:isJ?"0.71":"0.68",winRate:isJ?"0.56":"0.54",brier:isJ?"0.19":"0.18"},equityCurve:[{timeUtc:"2026-07-21T00:00:00Z",equity:"1000"},{timeUtc:"2026-07-22T00:00:00Z",equity:isJ?"1018.4":"1012.7"}],events:[]};}
    else {await route.fallback();return;}
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(response(result))});
  });
  await page.goto("/");
  await page.getByRole("navigation",{name:"主导航"}).getByRole("link",{name:/实时驾驶舱/}).click();
  await page.getByLabel("初始资金 USDC").fill("2500");
  await page.getByLabel("最大仓位 USDC").fill("125");
  await page.getByLabel("最低净优势").fill("0.04");
  await page.getByRole("button",{name:"启动自动 Paper"}).click();
  await expect(page.getByText("EDGE_ACCEPTED")).toBeVisible();
  await expect(page.getByText("1",{exact:true}).first()).toBeVisible();
  if (testInfo.project.name === "desktop-chromium") {
    await page.screenshot({ path: "/tmp/polymarket-money-playwright/paper-runner-live.png", fullPage: true });
  }
  await page.getByRole("navigation",{name:"主导航"}).getByRole("link",{name:/策略竞技场/}).click();
  await page.getByRole("button",{name:"比较所选运行（2）"}).click();
  await expect(page.getByText("策略对比",{exact:true})).toBeVisible();
  await expect(page.getByText("风险收益散点",{exact:true})).toBeVisible();
  await expect(page.getByText("累计净盈亏 / 权益曲线",{exact:true})).toBeVisible();
  await expect(page.getByRole("img",{name:"回撤水下图"})).toBeVisible();
  await expect(page.getByRole("cell",{name:/\+18\.4 USDC/})).toBeVisible();
  if (testInfo.project.name === "desktop-chromium") {
    await page.screenshot({ path: "/tmp/polymarket-money-playwright/paper-runner-arena.png", fullPage: true });
  }
});
