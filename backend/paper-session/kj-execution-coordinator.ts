import { createHash } from "node:crypto";
import { mkdir, open, readFile, lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Decimal } from "decimal.js";

import type { KJPaperEvent, KJPaperStrategy } from "../core/src/runtime/kj-paper-engine.js";
import {
  assertAutomatedPaperOrderRequestV2,
  type PaperFeeEvidenceV1,
  type PaperOrderRequestV2,
  type PaperOrderStatus,
} from "../paper-simulation/index.js";
import type { PaperSessionService } from "./service.js";

const INTENT_ID = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

export type KJExecutionProposalV1 = Readonly<{
  schemaVersion: "kj-execution-proposal-v1";
  intentId: string;
  proposalEventId: string;
  contextHash: string;
  strategy: KJPaperStrategy;
  marketId: string;
  outcome: "UP" | "DOWN";
  sideProbability: string;
  maximumFillPrice: string;
  quantity: string;
  proposedAtUtc: string;
  feeEvidence: PaperFeeEvidenceV1;
}>;

export type KJExecutionLinkState = "PENDING" | "SUBMITTED";
export type KJExecutionLinkV1 = Readonly<{
  schemaVersion: "kj-execution-link-v1";
  identity: string;
  proposalFingerprint: string;
  strategy: KJPaperStrategy;
  intentId: string;
  sessionId: string;
  idempotencyKey: string;
  request: PaperOrderRequestV2;
  state: KJExecutionLinkState;
  paperOrderId: string | null;
  paperOrderStatus: PaperOrderStatus | null;
  rejectionReason: string | null;
  createdAtUtc: string;
  updatedAtUtc: string;
}>;

export type KJExecutionOutboxRecordV1 = Readonly<{
  schemaVersion: "kj-execution-outbox-record-v1";
  sequence: string;
  previousRecordHash: string | null;
  link: KJExecutionLinkV1;
  recordHash: string;
}>;

export interface KJExecutionOutboxStore {
  load(): Promise<readonly KJExecutionOutboxRecordV1[]>;
  append(record: KJExecutionOutboxRecordV1): Promise<void>;
}

export type KJExecutionAccountsV1 = Readonly<Record<KJPaperStrategy, string>>;

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("outbox JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${stableJson(input[key])}`).join(",")}}`;
  }
  throw new Error("outbox accepts JSON values only");
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function recordHash(record: Omit<KJExecutionOutboxRecordV1, "recordHash">): string { return sha256(stableJson(record)); }
function fingerprint(value: unknown): string { return sha256(stableJson(value)); }
function utc(value: string, field: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`${field} must be a UTC ISO 8601 timestamp`);
}
function positiveDecimal(value: string, field: string, maximumOne = false): Decimal {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) throw new Error(`${field} must be a canonical decimal`);
  const result = new Decimal(value);
  if (!result.gt(0) || (maximumOne && result.gt(1))) throw new Error(`${field} is outside its allowed range`);
  return result;
}
function nonNegativeFraction(value: string, field: string): Decimal {
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) throw new Error(`${field} must be a canonical decimal`);
  const result = new Decimal(value);
  if (result.lt(0) || result.gt(1)) throw new Error(`${field} is outside its allowed range`);
  return result;
}
function detail(event: KJPaperEvent, name: string): string {
  const value = event.details[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`K/J ${event.eventType} event lacks ${name}`);
  return value;
}

export function kjExecutionProposalFromEvents(
  intent: KJPaperEvent,
  fill: KJPaperEvent,
  feeEvidence: PaperFeeEvidenceV1,
): KJExecutionProposalV1 {
  if (intent.eventType !== "INTENT" || fill.eventType !== "FILL") throw new Error("K/J proposal requires one INTENT and its FILL event");
  if (intent.strategy === null || fill.strategy !== intent.strategy || fill.marketId !== intent.marketId) throw new Error("K/J proposal events disagree on strategy or market");
  const intentId = detail(intent, "intentId");
  if (detail(fill, "intentId") !== intentId) throw new Error("K/J proposal events disagree on intentId");
  const outcome = detail(intent, "outcome");
  if (outcome !== "UP" && outcome !== "DOWN") throw new Error("K/J INTENT outcome is invalid");
  return Object.freeze({
    schemaVersion: "kj-execution-proposal-v1",
    intentId,
    proposalEventId: fill.eventId,
    contextHash: detail(intent, "contextHash"),
    strategy: intent.strategy,
    marketId: intent.marketId,
    outcome,
    sideProbability: detail(intent, "probability"),
    maximumFillPrice: detail(intent, "maximumFillPrice"),
    quantity: detail(fill, "quantity"),
    proposedAtUtc: fill.eventTime,
    feeEvidence,
  });
}

export class InMemoryKJExecutionOutboxStore implements KJExecutionOutboxStore {
  readonly records: KJExecutionOutboxRecordV1[] = [];
  failNextAppend = false;
  async load(): Promise<readonly KJExecutionOutboxRecordV1[]> { return structuredClone(this.records); }
  async append(record: KJExecutionOutboxRecordV1): Promise<void> {
    if (this.failNextAppend) { this.failNextAppend = false; throw new Error("injected outbox append failure"); }
    this.records.push(structuredClone(record));
  }
}

export class FileKJExecutionOutboxStore implements KJExecutionOutboxStore {
  readonly #path: string;
  constructor(dataRoot: string) {
    if (!isAbsolute(dataRoot)) throw new Error("K/J execution outbox data root must be absolute");
    this.#path = resolve(dataRoot, "workbench", "paper-sessions", "kj-execution-links.jsonl");
  }
  async load(): Promise<readonly KJExecutionOutboxRecordV1[]> {
    try {
      const bytes = await readFile(this.#path);
      if (bytes.length > 16 * 1024 * 1024) throw new Error("K/J execution outbox exceeds limit");
      const text = bytes.toString("utf8");
      if (text !== "" && !text.endsWith("\n")) throw new Error("K/J execution outbox has an incomplete trailing record");
      return Object.freeze(text === "" ? [] : text.slice(0, -1).split("\n").map((line) => JSON.parse(line) as KJExecutionOutboxRecordV1));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
      throw error;
    }
  }
  async append(record: KJExecutionOutboxRecordV1): Promise<void> {
    const directory = resolve(this.#path, "..");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const state = await lstat(this.#path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (state?.isSymbolicLink()) throw new Error("K/J execution outbox must not be a symlink");
    const handle = await open(this.#path, "a", 0o600);
    try { await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
  }
}

export class KJPaperExecutionCoordinator {
  readonly #paper: PaperSessionService;
  readonly #outbox: KJExecutionOutboxStore;
  readonly #accounts: KJExecutionAccountsV1;
  readonly #links = new Map<string, KJExecutionLinkV1>();
  #recordCount = 0;
  #lastRecordHash: string | null = null;
  #tail: Promise<void> = Promise.resolve();
  #initialized = false;

  constructor(paper: PaperSessionService, outbox: KJExecutionOutboxStore, accounts: KJExecutionAccountsV1) {
    for (const strategy of ["J_FEE_AWARE", "K_DUAL_VOL"] as const) if (!SAFE_ID.test(accounts[strategy])) throw new Error(`invalid ${strategy} Paper sessionId`);
    if (accounts.J_FEE_AWARE === accounts.K_DUAL_VOL) throw new Error("J and K require independent canonical Paper sessions");
    this.#paper = paper; this.#outbox = outbox; this.#accounts = Object.freeze({ ...accounts });
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    const records = await this.#outbox.load();
    for (const raw of records) this.#recoverRecord(raw);
    this.#initialized = true;
    for (const link of [...this.#links.values()]) if (link.state === "PENDING") await this.#submitPending(link);
  }

  coordinate(proposal: KJExecutionProposalV1): Promise<KJExecutionLinkV1> {
    let output: KJExecutionLinkV1 | undefined;
    const operation = this.#tail.then(async () => { output = await this.#coordinate(proposal); });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation.then(() => output!);
  }

  links(): readonly KJExecutionLinkV1[] {
    return Object.freeze([...this.#links.values()].sort((a, b) => a.identity.localeCompare(b.identity)));
  }

  async #coordinate(proposal: KJExecutionProposalV1): Promise<KJExecutionLinkV1> {
    if (!this.#initialized) throw new Error("K/J execution coordinator is not initialized");
    this.#validateProposal(proposal);
    const identity = `${proposal.strategy}:${proposal.intentId}`;
    const proposalFingerprint = fingerprint(proposal);
    const existing = this.#links.get(identity);
    if (existing !== undefined) {
      if (existing.proposalFingerprint !== proposalFingerprint) throw new Error("K/J intent identity has conflicting proposal content");
      return existing.state === "PENDING" ? this.#submitPending(existing) : existing;
    }
    const sessionId = this.#accounts[proposal.strategy];
    const idempotencyKey = `kjexec:v1:${proposal.strategy}:${proposal.intentId}`;
    const probability = new Decimal(proposal.sideProbability);
    const modelProbabilityYes = proposal.outcome === "UP" ? probability : new Decimal(1).minus(probability);
    const request: PaperOrderRequestV2 = Object.freeze({
      schemaVersion: "paper-order-request-v2", idempotencyKey, clientOrderId: idempotencyKey,
      marketId: proposal.marketId, token: proposal.outcome === "UP" ? "YES" : "NO",
      limitPrice: proposal.maximumFillPrice, quantity: proposal.quantity, timeInForce: "FAK", expiresAtUtc: null,
      modelProbabilityYes: modelProbabilityYes.toFixed(), feeEvidence: Object.freeze({ ...proposal.feeEvidence }),
    });
    assertAutomatedPaperOrderRequestV2(request);
    const pending: KJExecutionLinkV1 = Object.freeze({
      schemaVersion: "kj-execution-link-v1", identity, proposalFingerprint, strategy: proposal.strategy,
      intentId: proposal.intentId, sessionId, idempotencyKey, request, state: "PENDING",
      paperOrderId: null, paperOrderStatus: null, rejectionReason: null,
      createdAtUtc: proposal.proposedAtUtc, updatedAtUtc: proposal.proposedAtUtc,
    });
    await this.#append(pending);
    this.#links.set(identity, pending);
    return this.#submitPending(pending);
  }

  async #submitPending(link: KJExecutionLinkV1): Promise<KJExecutionLinkV1> {
    const order = await this.#paper.submitOrder(link.sessionId, link.request, link.updatedAtUtc);
    const terminal: KJExecutionLinkV1 = Object.freeze({
      ...link, state: "SUBMITTED", paperOrderId: order.orderId, paperOrderStatus: order.status,
      rejectionReason: order.rejectionReason, updatedAtUtc: order.updatedAtUtc,
    });
    await this.#append(terminal);
    this.#links.set(link.identity, terminal);
    return terminal;
  }

  async #append(link: KJExecutionLinkV1): Promise<void> {
    const core = Object.freeze({
      schemaVersion: "kj-execution-outbox-record-v1" as const,
      sequence: String(this.#recordCount), previousRecordHash: this.#lastRecordHash, link,
    });
    const record = Object.freeze({ ...core, recordHash: recordHash(core) });
    await this.#outbox.append(record);
    this.#recordCount += 1; this.#lastRecordHash = record.recordHash;
  }

  #recoverRecord(record: KJExecutionOutboxRecordV1): void {
    if (record.schemaVersion !== "kj-execution-outbox-record-v1" || record.sequence !== String(this.#recordCount)
      || record.previousRecordHash !== this.#lastRecordHash) throw new Error("K/J execution outbox chain is invalid");
    if (Object.keys(record).sort().join(",") !== "link,previousRecordHash,recordHash,schemaVersion,sequence") throw new Error("K/J execution outbox record fields are invalid");
    const { recordHash: supplied, ...core } = record;
    if (!/^[a-f0-9]{64}$/u.test(supplied) || recordHash(core) !== supplied) throw new Error("K/J execution outbox record hash mismatch");
    this.#validateRecoveredLink(record.link);
    const prior = this.#links.get(record.link.identity);
    if (prior !== undefined && (prior.proposalFingerprint !== record.link.proposalFingerprint || prior.state === "SUBMITTED")) {
      throw new Error("K/J execution outbox contains a conflicting or post-terminal link");
    }
    if (prior === undefined && record.link.state !== "PENDING") throw new Error("K/J execution outbox terminal record lacks PENDING");
    this.#links.set(record.link.identity, Object.freeze(structuredClone(record.link)));
    this.#recordCount += 1; this.#lastRecordHash = supplied;
  }

  #validateProposal(value: KJExecutionProposalV1): void {
    if (value.schemaVersion !== "kj-execution-proposal-v1" || !INTENT_ID.test(value.intentId)
      || !/^[a-f0-9]{64}$/u.test(value.contextHash) || !/^[a-f0-9]{64}$/u.test(value.proposalEventId)
      || !SAFE_ID.test(value.marketId) || (value.strategy !== "J_FEE_AWARE" && value.strategy !== "K_DUAL_VOL")) {
      throw new Error("K/J execution proposal identity is invalid");
    }
    if (Object.keys(value).sort().join(",") !== "contextHash,feeEvidence,intentId,marketId,maximumFillPrice,outcome,proposalEventId,proposedAtUtc,quantity,schemaVersion,sideProbability,strategy") throw new Error("K/J execution proposal fields are invalid");
    utc(value.proposedAtUtc, "proposal.proposedAtUtc");
    positiveDecimal(value.sideProbability, "proposal.sideProbability", true);
    positiveDecimal(value.maximumFillPrice, "proposal.maximumFillPrice", true);
    positiveDecimal(value.quantity, "proposal.quantity");
    if (value.outcome !== "UP" && value.outcome !== "DOWN") throw new Error("K/J execution proposal outcome is invalid");
    const fee = value.feeEvidence;
    if (fee.schemaVersion !== "paper-fee-evidence-v1" || fee.model !== "POLYMARKET_TAKER_CURVE_V1"
      || !SAFE_ID.test(fee.conditionId) || fee.evidenceReference.trim() === ""
      || !["VERIFIED", "UNVERIFIED", "MISSING"].includes(fee.evidenceStatus)
      || Object.keys(fee).sort().join(",") !== "conditionId,effectiveFromUtc,effectiveToUtc,evidenceReference,evidenceStatus,model,rate,schemaVersion") {
      throw new Error("K/J execution proposal fee evidence is invalid");
    }
    nonNegativeFraction(fee.rate, "proposal.feeEvidence.rate");
    utc(fee.effectiveFromUtc, "proposal.feeEvidence.effectiveFromUtc"); utc(fee.effectiveToUtc, "proposal.feeEvidence.effectiveToUtc");
    if (Date.parse(fee.effectiveFromUtc) >= Date.parse(fee.effectiveToUtc)) throw new Error("K/J execution proposal fee interval is empty");
  }

  #validateRecoveredLink(link: KJExecutionLinkV1): void {
    if (link.schemaVersion !== "kj-execution-link-v1" || !/^[a-f0-9]{64}$/u.test(link.proposalFingerprint)
      || !INTENT_ID.test(link.intentId) || (link.strategy !== "J_FEE_AWARE" && link.strategy !== "K_DUAL_VOL")
      || link.identity !== `${link.strategy}:${link.intentId}` || link.sessionId !== this.#accounts[link.strategy]) {
      throw new Error("K/J execution outbox link identity is invalid");
    }
    const expectedKey = `kjexec:v1:${link.strategy}:${link.intentId}`;
    if (link.idempotencyKey !== expectedKey || link.request.idempotencyKey !== expectedKey || link.request.clientOrderId !== expectedKey
      || link.request.schemaVersion !== "paper-order-request-v2" || link.request.timeInForce !== "FAK" || link.request.expiresAtUtc !== null) {
      throw new Error("K/J execution outbox request contract is invalid");
    }
    assertAutomatedPaperOrderRequestV2(link.request);
    utc(link.createdAtUtc, "link.createdAtUtc"); utc(link.updatedAtUtc, "link.updatedAtUtc");
    if (link.state === "PENDING") {
      if (link.paperOrderId !== null || link.paperOrderStatus !== null || link.rejectionReason !== null) throw new Error("K/J pending link contains a terminal result");
    } else if (link.state === "SUBMITTED") {
      if (link.paperOrderId === null || link.paperOrderStatus === null) throw new Error("K/J submitted link lacks its canonical order result");
    } else throw new Error("K/J execution outbox link state is invalid");
  }
}
