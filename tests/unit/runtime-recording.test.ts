import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_LOCAL_RAW_BYTES,
  MAX_LOCAL_RAW_MILLISECONDS,
  MIN_FREE_BYTES,
  validateRecordingOptions,
} from "../../execution/src/runtime/recording.js";

test("raw mode requires explicit bounded duration, bytes, and Linux-native output", () => {
  const options = validateRecordingOptions({
    mode: "raw",
    durationMilliseconds: MAX_LOCAL_RAW_MILLISECONDS,
    maxBytes: MAX_LOCAL_RAW_BYTES,
    outputPath: "/root/capture",
    filesystemType: "ext4",
    freeBytes: MIN_FREE_BYTES + MAX_LOCAL_RAW_BYTES,
  });
  assert.equal(options.maxBytes, 2 * 1024 ** 3);
  assert.throws(
    () => validateRecordingOptions({ ...options, outputPath: "/mnt/d/capture", filesystemType: "9p" }),
    /Linux-native/,
  );
  assert.throws(
    () => validateRecordingOptions({ ...options, durationMilliseconds: MAX_LOCAL_RAW_MILLISECONDS + 1 }),
    /60 minutes/,
  );
  assert.throws(
    () => validateRecordingOptions({ ...options, freeBytes: MIN_FREE_BYTES + MAX_LOCAL_RAW_BYTES - 1 }),
    /safety reserve/,
  );
});

test("metrics mode cannot retain raw payloads", () => {
  const options = validateRecordingOptions({ mode: "metrics" });
  assert.equal(options.writesRaw, false);
  assert.equal(options.writesMetrics, true);
  assert.equal("rawPayload" in options, false);
});
