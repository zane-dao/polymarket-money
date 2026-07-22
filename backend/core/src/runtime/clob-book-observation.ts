import type { ParserStatus } from "../domain/raw-event.js";

export type ClobBookObservationDisposition = "REFRESH" | "INVALIDATE" | "IGNORE";

export function classifyClobBookObservation(input: {
  readonly eventTypes: readonly string[];
  readonly parserStatus: ParserStatus;
  readonly bookMutationApplied: boolean;
}): ClobBookObservationDisposition {
  const attemptedMutation = input.eventTypes.some((eventType) =>
    eventType === "book" || eventType === "price_change");
  if (input.parserStatus === "error" || input.parserStatus === "quarantined") {
    return attemptedMutation || input.parserStatus === "error" ? "INVALIDATE" : "IGNORE";
  }
  if (input.parserStatus === "unparsed") return "IGNORE";
  if (input.bookMutationApplied) {
    if (!attemptedMutation) throw new Error("bookMutationApplied requires a book or price_change event");
    return "REFRESH";
  }
  return attemptedMutation ? "INVALIDATE" : "IGNORE";
}
