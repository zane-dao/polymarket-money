import assert from "node:assert/strict";
import test from "node:test";

import { ReceiveClock } from "../../backend/core/src/domain/receive-time.js";
import {
  FailClosedRuntime,
  createRuntimeIncident,
  type EmergencyTerminalReceipt,
  type RuntimeIncidentV1,
} from "../../backend/core/src/runtime/incidents.js";

function incident(): RuntimeIncidentV1 {
  const stamp = new ReceiveClock({
    clockDomain: "process-session-incident",
    wallNow: () => "2026-07-16T00:00:00.000Z",
    monotonicNowNs: () => 10n,
  }).capture();
  return createRuntimeIncident({
    errorClass: "WriterError",
    message: "disk unavailable",
    stream: "clob",
    connectionRole: "polymarket",
    connectionId: "clob-1",
    receiveStamp: stamp,
    rawReference: null,
    actionTaken: "TERMINATE_SESSION",
    stopReason: "WRITER_FAILURE",
  });
}

test("writer failure is not recursively sent back to the failed writer", async () => {
  let writerCalls = 0;
  const receipts: EmergencyTerminalReceipt[] = [];
  const stderr: string[] = [];
  let exitCode = 0;
  const runtime = new FailClosedRuntime({
    incidentWriter: {
      write: async () => {
        writerCalls += 1;
        throw new Error("incident writer failed");
      },
    },
    emergencySink: { write: async (receipt) => { receipts.push(receipt); } },
    writeStderr: (line) => { stderr.push(line); },
    setExitCode: (code) => { exitCode = code; },
  });
  runtime.noteObservation();
  const termination = await runtime.terminate(incident());
  assert.equal(writerCalls, 1);
  assert.equal(receipts.length, 1);
  assert.equal(exitCode, 1);
  assert.equal(termination.graceful, false);
  assert.equal(termination.stopReason, "WRITER_FAILURE");
  assert.match(stderr.join("\n"), /incident writer failed/);
  assert.throws(() => runtime.noteObservation(), /terminated/i);
  assert.equal(runtime.observationCount, 1);
});

test("emergency sink failure still leaves a non-zero non-graceful termination", async () => {
  let exitCode = 0;
  const stderr: string[] = [];
  const runtime = new FailClosedRuntime({
    incidentWriter: { write: async () => { throw new Error("writer failed"); } },
    emergencySink: { write: async () => { throw new Error("receipt failed"); } },
    writeStderr: (line) => { stderr.push(line); },
    setExitCode: (code) => { exitCode = code; },
  });
  const termination = await runtime.terminate(incident());
  assert.equal(exitCode, 1);
  assert.equal(termination.graceful, false);
  assert.equal(termination.exitCode, 1);
  assert.match(stderr.join("\n"), /receipt failed/);
});

test("recoverable incident writer failure switches directly to the terminal fallback", async () => {
  let writerCalls = 0;
  let exitCode = 0;
  const runtime = new FailClosedRuntime({
    incidentWriter: { write: async () => { writerCalls += 1; throw new Error("log disk failed"); } },
    emergencySink: { write: async () => undefined },
    writeStderr: () => undefined,
    setExitCode: (code) => { exitCode = code; },
  });
  const termination = await runtime.recordIncident(incident());
  assert.equal(writerCalls, 1);
  assert.equal(exitCode, 1);
  assert.equal(runtime.terminated, true);
  assert.equal(termination?.graceful, false);
  assert.throws(() => runtime.noteObservation(), /terminated/i);
});
