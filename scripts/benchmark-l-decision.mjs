import { decideLAdaptiveV2 } from "../dist/strategies/src/l-adaptive.js";

const input = Object.freeze({
  currentPrice: "67030",
  openingPrice: "67000",
  remainingSeconds: "120",
  elapsedSeconds: "180",
  sigmaShort: "0.00008",
  sigmaMedium: "0.00006",
  sigmaLong: "0.00005",
  upBid: "0.54",
  upAsk: "0.55",
  upAskSize: "300",
  downBid: "0.44",
  downAsk: "0.45",
  downAskSize: "250",
  feeRate: "0.07",
  bankroll: "10000",
  maxSignalEdge: "0.25",
  maxStakeUsdc: "300",
  bookParticipation: "1",
});

const warmupCount = 2_000;
const sampleCount = 20_000;
for (let index = 0; index < warmupCount; index += 1) decideLAdaptiveV2(input);

const samples = [];
for (let index = 0; index < sampleCount; index += 1) {
  const started = process.hrtime.bigint();
  decideLAdaptiveV2(input);
  samples.push(Number(process.hrtime.bigint() - started) / 1_000_000);
}
samples.sort((left, right) => left - right);
const percentile = (fraction) =>
  samples[Math.min(samples.length - 1, Math.ceil(samples.length * fraction) - 1)];
const result = Object.freeze({
  schemaVersion: "l-decision-benchmark-v1",
  runtime: `node-${process.versions.node}`,
  warmupCount,
  sampleCount,
  p50Ms: percentile(0.5),
  p95Ms: percentile(0.95),
  p99Ms: percentile(0.99),
  maxMs: samples.at(-1),
  targets: Object.freeze({ p50MsAtMost: 20, p95MsBelow: 50 }),
});
console.log(JSON.stringify(result, null, 2));
if (result.p50Ms > result.targets.p50MsAtMost || result.p95Ms >= result.targets.p95MsBelow) {
  process.exitCode = 1;
}
