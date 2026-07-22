import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { loadAppStatus, type AppStatusTransport } from "../src/services/app-status.js";
import {
  APP_STATUS_SCHEMA_V1,
  AppStatusContractError,
  parseAppStatusV1,
} from "../src/types/app-status.js";

const fixturePath = resolve("data/fixtures/app-status-v1.golden.json");

async function fixture(): Promise<unknown> {
  return JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
}

test("AppStatusV1 golden is paper-only and contract-valid", async () => {
  const status = parseAppStatusV1(await fixture());
  assert.equal(status.schemaVersion, APP_STATUS_SCHEMA_V1);
  assert.equal(status.mode, "paper-only");
  assert.equal(status.liveTradingEnabled, false);
});

test("AppStatusV1 fails closed on live, unknown fields and duplicate modules", async () => {
  const source = parseAppStatusV1(await fixture());
  assert.throws(
    () => parseAppStatusV1({ ...source, liveTradingEnabled: true }),
    AppStatusContractError,
  );
  assert.throws(
    () => parseAppStatusV1({ ...source, secretPath: "/hidden" }),
    AppStatusContractError,
  );
  assert.throws(
    () => parseAppStatusV1({ ...source, modules: [...source.modules, source.modules[0]] }),
    AppStatusContractError,
  );
});

test("app status service invokes only the fixed read-only command", async () => {
  const calls: string[] = [];
  const transport: AppStatusTransport = {
    async invoke(command) {
      calls.push(command);
      return fixture();
    },
  };
  assert.equal((await loadAppStatus(transport)).liveTradingEnabled, false);
  assert.deepEqual(calls, ["get_app_status_v1"]);
});
