import { runDesktopBacktestWorker } from "../backend/backtest/desktop-service.js";

const dataRoot = process.env.POLYMARKET_DATA_ROOT;
const runId = process.argv[2];
if (dataRoot === undefined || runId === undefined) process.exitCode = 1;
else await runDesktopBacktestWorker(dataRoot, runId);
