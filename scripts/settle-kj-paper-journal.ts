import { isAbsolute, resolve } from "node:path";
import { writeFile } from "node:fs/promises";

import { fetchPublicMarketBySlug } from "../backend/core/src/adapters/market-data/public-sources.js";
import {
  createKJOfficialSettlementFromGamma,
  GammaResolutionPending,
} from "../backend/core/src/adapters/settlement/gamma-resolution.js";
import {
  KJ_SETTLEMENT_RECOVERY_VERSION,
  selectKJSettlementRecoveryMarkets,
} from "../backend/core/src/product/kj-settlement-recovery.js";
import { KJPaperJournal } from "../backend/core/src/storage/kj-paper-journal.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write([
      "Usage: npm run paper:settle -- /absolute/journal.ndjson",
      "       --start-at <UTC> --start-before <UTC> [--wait-seconds 600]",
      "       [--output /absolute/recovery-result.json]",
      "",
    ].join("\n"));
    return;
  }
  const journalInput = process.argv[2];
  if (journalInput === undefined || !isAbsolute(journalInput)) {
    throw new Error("paper:settle requires an absolute journal path");
  }
  const startAt = argument("--start-at");
  const startBefore = argument("--start-before");
  if (startAt === undefined || startBefore === undefined) {
    throw new Error("paper:settle requires --start-at and --start-before");
  }
  const waitSeconds = positiveInteger(argument("--wait-seconds") ?? "600", "wait-seconds");
  if (waitSeconds > 1_800) throw new Error("wait-seconds must not exceed 1800");
  const outputInput = argument("--output");
  if (outputInput !== undefined && !isAbsolute(outputInput)) {
    throw new Error("paper:settle output must be absolute");
  }
  const deadline = Date.now() + waitSeconds * 1_000;
  const journal = await KJPaperJournal.open(resolve(journalInput));
  let attempts = 0;
  let transientErrors = 0;
  try {
    while (Date.now() < deadline) {
      const targets = selectKJSettlementRecoveryMarkets(
        journal.unsettledMarkets(),
        startAt,
        startBefore,
        new Date().toISOString(),
      );
      if (targets.length === 0) break;
      for (const market of targets) {
        attempts += 1;
        let response;
        try {
          response = await fetchPublicMarketBySlug(market.slug, {
            timeoutMilliseconds: 10_000,
            maxResponseBytes: 2 * 1024 * 1024,
          });
        } catch (error) {
          transientErrors += 1;
          process.stderr.write(`[paper:settle] fetch deferred ${market.slug}: ${String(error)}\n`);
          continue;
        }
        try {
          createKJOfficialSettlementFromGamma({
            expectedMarket: market,
            responseStatus: response.status,
            rawPayload: response.rawPayload,
            receiveTime: response.receiveTime,
          });
          await journal.appendGammaResolution({
            expectedMarket: market,
            responseStatus: response.status,
            rawPayload: response.rawPayload,
            receiveTime: response.receiveTime,
          });
          process.stdout.write(`[paper:settle] settled ${market.slug}\n`);
        } catch (error) {
          if (!(error instanceof GammaResolutionPending)) throw error;
        }
      }
      if (Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
    }
    const pending = selectKJSettlementRecoveryMarkets(
      journal.unsettledMarkets(),
      startAt,
      startBefore,
      new Date().toISOString(),
    );
    const result = Object.freeze({
      schemaVersion: KJ_SETTLEMENT_RECOVERY_VERSION,
      accepted: pending.length === 0,
      journalPath: journal.path,
      attempts,
      transientErrors,
      recordCount: journal.recordCount,
      lastRecordHash: journal.lastRecordHash,
      pending: pending.map((market) => ({
        marketId: market.marketId,
        slug: market.slug,
        intervalEnd: market.intervalEnd,
      })),
      state: journal.engine.snapshot(),
    });
    if (outputInput !== undefined) {
      await writeFile(resolve(outputInput), `${JSON.stringify(result, null, 2)}\n`, {
        flag: "wx",
        mode: 0o400,
      });
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.accepted) process.exitCode = 2;
  } finally {
    await journal.close();
  }
}

await main();
