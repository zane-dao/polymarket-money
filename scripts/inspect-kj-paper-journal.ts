import { isAbsolute, resolve } from "node:path";
import { writeSync } from "node:fs";

import { KJPaperJournal } from "../backend/core/src/storage/kj-paper-journal.js";

const input = process.argv[2];
if (input === undefined || process.argv.length !== 3) {
  throw new Error("usage: inspect-kj-paper-journal <absolute-journal-path>");
}
if (!isAbsolute(input)) throw new Error("K/J journal inspection path must be absolute");

const journal = await KJPaperJournal.open(resolve(input));
try {
  const output = `${JSON.stringify({
    schemaVersion: "kj-paper-journal-inspection-v1",
    journalPath: journal.path,
    journalRecordCount: String(journal.recordCount),
    recoveredInputCount: String(journal.recoveredInputCount),
    lastRecordHash: journal.lastRecordHash,
    runPlanEvidence: journal.runPlanEvidence,
    state: journal.engine.snapshot(),
  }, null, 2)}\n`;
  writeSync(process.stdout.fd, output);
} finally {
  await journal.close();
}
