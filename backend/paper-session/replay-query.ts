import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { KJPaperJournal } from "../core/src/storage/kj-paper-journal.js";
import { kjPaperContextFingerprint, type KJPaperEvent } from "../core/src/runtime/kj-paper-engine.js";
import type { KJStrategyContextV1 } from "../../strategies/src/kj-context.js";
import type { PaperSessionService } from "./service.js";

const MAX_PAGE_SIZE = 100;
const MAX_REPLAY_EVENTS = 100_000;
const JOURNAL = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}\.kj-input-journal\.jsonl$/u;
type PublicValue = string | number | boolean | null;

export type PaperReplayEventV1 = Readonly<{
  schemaVersion: "paper-replay-event-v1";
  eventId: string;
  eventTimeUtc: string;
  kind: "market_context" | "decision" | "order" | "fill" | "settlement";
  source: "KJ_JOURNAL" | "PAPER_LEDGER";
  sessionId: string | null;
  marketId: string | null;
  data: Readonly<Record<string, PublicValue>>;
}>;

export type PaperReplayPageV1 = Readonly<{
  schemaVersion: "paper-replay-page-v1";
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  items: readonly PaperReplayEventV1[];
}>;

function contextEvent(context: KJStrategyContextV1): PaperReplayEventV1 {
  return Object.freeze({ schemaVersion: "paper-replay-event-v1", eventId: `context-${kjPaperContextFingerprint(context)}`, eventTimeUtc: context.decisionTime, kind: "market_context", source: "KJ_JOURNAL", sessionId: null, marketId: context.market.marketId, data: Object.freeze({ conditionId: context.market.conditionId, slug: context.market.slug, intervalStart: context.market.intervalStart, intervalEnd: context.market.intervalEnd, upBid: context.book.up.bid, upAsk: context.book.up.ask, downBid: context.book.down.bid, downAsk: context.book.down.ask, signalProvider: context.signal.provider, signalPrice: context.signal.price, signalReceiveTime: context.signal.receiveTime, continuity: context.book.continuity }) });
}

function decisionEvent(event: KJPaperEvent): PaperReplayEventV1 {
  const allowed = ["action", "reason", "probability", "decisionAsk", "edge", "outcome", "maximumFillPrice"] as const; const data: Record<string, PublicValue> = {};
  for (const key of allowed) { const value = event.details[key]; if (value === null || typeof value === "string" || typeof value === "boolean") data[key] = value; }
  if (event.strategy !== null) data.strategy = event.strategy;
  return Object.freeze({ schemaVersion: "paper-replay-event-v1", eventId: event.eventId, eventTimeUtc: event.eventTime, kind: "decision", source: "KJ_JOURNAL", sessionId: null, marketId: event.marketId, data: Object.freeze(data) });
}

async function journalEvents(journal: KJPaperJournal): Promise<readonly PaperReplayEventV1[]> {
  return Object.freeze([...journal.contexts().map(contextEvent), ...journal.engine.events().filter((event) => event.eventType === "DECISION").map(decisionEvent)]);
}

export async function queryPaperReplay(dataRoot: string, paper: PaperSessionService, page: number, pageSize: number, active: Readonly<{ fileName: string; journal: KJPaperJournal }> | null = null): Promise<PaperReplayPageV1> {
  if (!isAbsolute(dataRoot)) throw new Error("dataRoot must be absolute");
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) throw new Error("Paper replay page is invalid");
  const events: PaperReplayEventV1[] = [];
  const sessions = await paper.list();
  for (const session of sessions) {
    const detail = await paper.detail(session.sessionId);
    for (const order of detail.orders) events.push(Object.freeze({ schemaVersion: "paper-replay-event-v1", eventId: order.orderId, eventTimeUtc: order.createdAtUtc, kind: "order", source: "PAPER_LEDGER", sessionId: session.sessionId, marketId: order.marketId, data: Object.freeze({ clientOrderId: order.clientOrderId, token: order.token, limitPrice: order.limitPrice, quantity: order.quantity, filledQuantity: order.filledQuantity, status: order.status, timeInForce: order.timeInForce, rejectionReason: order.rejectionReason }) }));
    for (const fill of detail.fills) events.push(Object.freeze({ schemaVersion: "paper-replay-event-v1", eventId: fill.fillId, eventTimeUtc: fill.filledAtUtc, kind: "fill", source: "PAPER_LEDGER", sessionId: session.sessionId, marketId: fill.marketId, data: Object.freeze({ orderId: fill.orderId, token: fill.token, price: fill.price, quantity: fill.quantity, fee: fill.fee }) }));
    for (const settlement of detail.settlements) events.push(Object.freeze({ schemaVersion: "paper-replay-event-v1", eventId: `settlement-${session.sessionId}-${settlement.marketId}-${settlement.settledAtUtc}`, eventTimeUtc: settlement.settledAtUtc, kind: "settlement", source: "PAPER_LEDGER", sessionId: session.sessionId, marketId: settlement.marketId, data: Object.freeze({ winningToken: settlement.winningToken, payout: settlement.payout }) }));
  }
  if (active !== null) events.push(...await journalEvents(active.journal));
  const directory = resolve(dataRoot, "workbench", "paper-host");
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  if (entries.length > 256) throw new Error("Paper replay journal limit exceeded");
  for (const entry of entries) {
    if (entry.name === active?.fileName || !entry.isFile() || entry.isSymbolicLink() || !JOURNAL.test(entry.name)) continue;
    const path = join(directory, entry.name); const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) continue;
    const journal = await KJPaperJournal.open(path); try { events.push(...await journalEvents(journal)); } finally { await journal.close(); }
    if (events.length > MAX_REPLAY_EVENTS) throw new Error("Paper replay event limit exceeded");
  }
  events.sort((left, right) => left.eventTimeUtc.localeCompare(right.eventTimeUtc) || left.eventId.localeCompare(right.eventId));
  const totalItems = events.length; const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize); const start = (page - 1) * pageSize;
  return Object.freeze({ schemaVersion: "paper-replay-page-v1", page, pageSize, totalItems, totalPages, items: Object.freeze(events.slice(start, start + pageSize)) });
}
