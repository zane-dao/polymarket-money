import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalOpportunityObservationJson,
  createOpportunityObservationV1,
  createRouteEvaluationV1,
  parseOpportunityObservationV1,
} from "../../execution/src/domain/opportunity-observation.js";

const draft = {
  opportunityFamily: "COMPLETE_SET_ARBITRAGE" as const,
  marketId: "market-1",
  observedAtWall: "2026-07-16T00:00:00.000Z",
  receiveStamp: {
    clock_domain: "process-1",
    local_monotonic_receive_ns: "1000",
    local_receive_ordinal: "7",
  },
  inputLineage: [{
    source: "POLYMARKET_CLOB",
    parent_input_reference: "raw-event-v2:abc",
    input_hash: "a".repeat(64),
    receive_stamp: {
      clock_domain: "process-1",
      local_monotonic_receive_ns: "999",
      local_receive_ordinal: "6",
    },
  }],
  provenance: {
    producer: "batch-4b-r1",
    gitCommit: "d".repeat(64),
    sessionId: "session-1",
    configHash: "b".repeat(64),
  },
  quality: { status: "PASS" as const, rejectionReasons: [] },
  feeEvidenceReference: "fee-evidence-1",
  continuity: "CONTINUOUS" as const,
  grossEdge: "0.04",
  scenarioNetEdge: "0.00507",
  visibleSize: "1.5",
  eligibility: "ELIGIBLE" as const,
  rejectionReason: null,
  facts: { executable_visible_size: "1.5", nested: { up_ask: "0.48" } },
};

test("OpportunityObservationV1 is deeply immutable and round-trips canonically", () => {
  const observation = createOpportunityObservationV1(draft);
  assert.equal(observation.schema_version, "opportunity-observation-v1");
  assert.equal(observation.observation_id, observation.observation_hash);
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(Object.isFrozen(observation.facts), true);
  assert.equal(Object.isFrozen(observation.facts.nested), true);
  assert.equal(Object.isFrozen(observation.input_lineage[0]?.receive_stamp), true);
  assert.throws(() => {
    (observation.facts.nested as Record<string, unknown>).up_ask = "0.01";
  }, TypeError);
  const parsed = parseOpportunityObservationV1(canonicalOpportunityObservationJson(observation));
  assert.deepEqual(parsed, observation);
  assert.equal(canonicalOpportunityObservationJson(parsed), canonicalOpportunityObservationJson(observation));
});

test("full ReceiveStamp and every input fact affect the deterministic observation hash", () => {
  const first = createOpportunityObservationV1(draft);
  const same = createOpportunityObservationV1({ ...draft });
  const futureOrdinal = createOpportunityObservationV1({
    ...draft,
    receiveStamp: { ...draft.receiveStamp, local_receive_ordinal: "8" },
  });
  const changedInput = createOpportunityObservationV1({
    ...draft,
    facts: { ...draft.facts, executable_visible_size: "1.4" },
  });
  assert.equal(first.observation_hash, same.observation_hash);
  assert.notEqual(first.observation_hash, futureOrdinal.observation_hash);
  assert.notEqual(first.observation_hash, changedInput.observation_hash);
});

test("missing provenance, invalid quality, and route conclusions on one observation fail closed", () => {
  assert.throws(
    () => createOpportunityObservationV1({
      ...draft,
      provenance: { ...draft.provenance, configHash: "" },
    }),
    /config/i,
  );
  assert.throws(
    () => createOpportunityObservationV1({
      ...draft,
      provenance: { ...draft.provenance, sessionId: "" },
    }),
    /session/i,
  );
  assert.throws(
    () => createOpportunityObservationV1({
      ...draft,
      quality: { status: "REJECTED", rejectionReasons: [] },
    }),
    /rejection/i,
  );
  assert.throws(
    () => createOpportunityObservationV1({ ...draft, routeDecision: "CANDIDATE" } as never),
    /route|unknown/i,
  );
});

test("input lineage must be causal and inside the observation clock domain", () => {
  const parent = draft.inputLineage[0]!;
  assert.throws(
    () => createOpportunityObservationV1({
      ...draft,
      inputLineage: [{
        ...parent,
        receive_stamp: { ...parent.receive_stamp, clock_domain: "process-2" },
      }],
    }),
    /clock.domain/i,
  );
  assert.throws(
    () => createOpportunityObservationV1({
      ...draft,
      inputLineage: [{
        ...parent,
        receive_stamp: {
          ...parent.receive_stamp,
          local_monotonic_receive_ns: "1001",
          local_receive_ordinal: "8",
        },
      }],
    }),
    /future|watermark|causal/i,
  );
  assert.throws(
    () => createOpportunityObservationV1({
      ...draft,
      inputLineage: [{
        ...parent,
        receive_stamp: {
          ...parent.receive_stamp,
          local_monotonic_receive_ns: "1000",
          local_receive_ordinal: "8",
        },
      }],
    }),
    /future|watermark|causal/i,
  );
});

test("RouteEvaluationV1 is a separate aggregate and remains DATA_INSUFFICIENT", () => {
  const observation = createOpportunityObservationV1(draft);
  const evaluation = createRouteEvaluationV1({
    route: "COMPLETE_SET_ARBITRAGE",
    configHash: "c".repeat(64),
    observationHashes: [observation.observation_hash],
    rawTriggerCount: 1,
    uniqueEpisodeCount: 1,
    uniqueMarketCount: 1,
  });
  assert.equal(evaluation.decision, "DATA_INSUFFICIENT");
  assert.equal(evaluation.raw_trigger_count, 1);
  assert.equal(evaluation.unique_episode_count, 1);
  assert.equal(evaluation.unique_market_count, 1);
  assert.equal(Object.isFrozen(evaluation.observation_hashes), true);
});
