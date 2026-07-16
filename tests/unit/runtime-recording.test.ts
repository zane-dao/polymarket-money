import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_LOCAL_RAW_BYTES,
  MAX_LOCAL_RAW_MILLISECONDS,
  MIN_FREE_BYTES,
  SharedByteBudget,
  validateRecordingOptions,
} from "../../execution/src/runtime/recording.js";

test("raw mode requires explicit bounded duration, bytes, and Linux-native output", () => {
  const input = {
    mode: "raw",
    durationMilliseconds: MAX_LOCAL_RAW_MILLISECONDS,
    maxBytes: MAX_LOCAL_RAW_BYTES,
    outputPath: "/root/capture",
    filesystemType: "ext4",
    freeBytes: MIN_FREE_BYTES + MAX_LOCAL_RAW_BYTES,
  } as const;
  const options = validateRecordingOptions(input);
  assert.equal(options.mode, "raw");
  if (options.mode !== "raw") throw new Error("expected raw options");
  assert.equal(options.maxBytes, 2 * 1024 ** 3);
  assert.throws(
    () => validateRecordingOptions({ ...input, outputPath: "/mnt/d/capture", filesystemType: "9p" }),
    /Linux-native/,
  );
  assert.throws(
    () => validateRecordingOptions({ ...input, durationMilliseconds: MAX_LOCAL_RAW_MILLISECONDS + 1 }),
    /60 minutes/,
  );
  assert.throws(
    () => validateRecordingOptions({ ...input, freeBytes: MIN_FREE_BYTES + MAX_LOCAL_RAW_BYTES - 1 }),
    /safety reserve/,
  );
});

test("metrics mode cannot retain raw payloads", () => {
  const options = validateRecordingOptions({ mode: "metrics" });
  assert.equal(options.writesRaw, false);
  assert.equal(options.writesMetrics, true);
  assert.equal("rawPayload" in options, false);
});

test("shared byte budget never permits a write past the hard limit", () => {
  const budget = new SharedByteBudget(10);
  assert.equal(budget.reserve(6), true);
  assert.equal(budget.reserve(5), false);
  assert.equal(budget.used, 6);
  assert.equal(budget.remaining, 4);
  assert.equal(budget.reserve(4), true);
  assert.equal(budget.used, 10);
});
