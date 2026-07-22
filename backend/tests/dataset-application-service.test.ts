import assert from "node:assert/strict";
import test from "node:test";

import { DatasetApplicationService, type DatasetSelectionRequestV1 } from "../dataset-api/index.js";
import type { DatasetSummaryV1 } from "../market-data/dataset-catalog.js";

const hash = "a".repeat(64);
const summary: DatasetSummaryV1 = {
  schemaVersion: "dataset-summary-v1",
  datasetId: "btc-five-minute",
  versionHash: hash,
  format: "normalized-events-v1",
  continuity: "UNVERIFIED",
  startTimeUtc: "2026-01-01T00:00:00Z",
  endTimeUtc: "2026-01-01T00:05:00Z",
  rowCount: 10,
  quarantineCount: 0,
  status: "available",
};
const now = "2026-07-21T00:00:00Z";

test("dataset facade scans through the catalog boundary and returns path-free list/detail DTOs", async () => {
  let receivedRoot = "";
  const service = new DatasetApplicationService("/private/data-root", { scanner: async (root) => { receivedRoot = root; return [{ ...summary, manifestPath: "/private/manifest.json" } as DatasetSummaryV1]; }, clock: () => now });
  const scan = await service.scan();
  assert.equal(receivedRoot, "/private/data-root");
  assert.equal(scan.datasetCount, 1);
  assert.equal(service.list().datasets[0]?.datasetId, summary.datasetId);
  assert.equal(service.get(summary.datasetId, hash).rawDataPolicy, "read-only-not-copied");
  assert.equal(JSON.stringify({ scan, list: service.list(), detail: service.get(summary.datasetId, hash) }).includes("/private/"), false);
});

test("a backtest dataset selection is accepted only after the exact id and hash were verified by scan", async () => {
  const service = new DatasetApplicationService("/data", { scanner: async () => [summary], clock: () => now });
  const request: DatasetSelectionRequestV1 = { schemaVersion: "dataset-selection-request-v1", datasetId: summary.datasetId, versionHash: hash };
  assert.throws(() => service.validateSelection(request), /not been scanned/u);
  await service.scan();
  assert.deepEqual(service.validateSelection(request), { schemaVersion: "validated-dataset-selection-v1", datasetId: summary.datasetId, versionHash: hash, validatedAtUtc: now });
  assert.throws(() => service.validateSelection({ ...request, versionHash: "b".repeat(64) }), /verified scan/u);
  assert.throws(() => service.get("../escape", hash), /datasetId is invalid/u);
  assert.throws(() => service.validateSelection({ ...request, databasePath: "/private/db" } as DatasetSelectionRequestV1), /unknown fields/u);
});

test("failed or malformed scans never replace the last verified snapshot", async () => {
  let invocation = 0;
  const service = new DatasetApplicationService("/data", { scanner: async () => {
    invocation += 1;
    if (invocation === 1) return [summary];
    return [{ ...summary, datasetId: "../../leak" }];
  }, clock: () => now });
  await service.scan();
  await assert.rejects(() => service.scan(), /datasetId is invalid/u);
  assert.equal(service.list().datasets.length, 1);
  assert.equal(service.get(summary.datasetId, hash).selectionReady, true);
});

test("concurrent scan requests are serialized and publish complete snapshots", async () => {
  let invocation = 0;
  const service = new DatasetApplicationService("/data", { scanner: async () => {
    invocation += 1;
    const current = invocation;
    await new Promise((resolve) => setTimeout(resolve, current === 1 ? 10 : 0));
    return [{ ...summary, datasetId: `dataset-${current}` }];
  }, clock: () => now });
  const [first, second] = await Promise.all([service.scan(), service.scan()]);
  assert.equal(first.datasets[0]?.datasetId, "dataset-1");
  assert.equal(second.datasets[0]?.datasetId, "dataset-2");
  assert.equal(service.list().datasets[0]?.datasetId, "dataset-2");
});
