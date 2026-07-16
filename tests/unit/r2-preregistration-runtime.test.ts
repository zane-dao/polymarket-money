import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadR2Preregistration } from "../../execution/src/runtime/r2-preregistration.js";

test("R2 runtime loads and hashes the exact frozen preregistration", async () => {
  const config = await loadR2Preregistration("experiments/batch-04b-r2-24-market-observation.yaml");
  assert.equal(config.config_sha256, "074324aaf10d867dfb3c40f5722dcf4354e77cf4f98802b55299ef2d8009127c");
  assert.equal(config.raw_recording, false);
  assert.equal(config.target_completed_markets, 24);
});

test("R2 runtime rejects a post-registration threshold change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "r2-prereg-"));
  try {
    const original = JSON.parse(await (await import("node:fs/promises")).readFile(
      "experiments/batch-04b-r2-24-market-observation.yaml", "utf8",
    )) as Record<string, any>;
    original.lead_lag.thresholds_bps = ["2", "5"];
    const path = join(directory, "changed.yaml");
    await writeFile(path, JSON.stringify(original));
    await assert.rejects(loadR2Preregistration(path), /thresholds_bps.*frozen/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
