# Batch 4B-R1 fail-first evidence

每节记录实现前的真实失败。后续实现提交不得删除这些失败证据。

## Group 1 — ReceiveStamp and raw-event-v2

Fail-first commit input: `tests/unit/receive-time-r1.test.ts`。

Command:

```text
npm test
```

Expected failure observed:

```text
tests/unit/receive-time-r1.test.ts(9,8): error TS2307: Cannot find module '../../execution/src/domain/receive-time.js' or its corresponding type declarations.
tests/unit/receive-time-r1.test.ts(11,3): error TS2724: '"../../execution/src/domain/raw-event.js"' has no exported member named 'createEnvelopeDraftV2'. Did you mean 'createEnvelopeDraft'?
tests/unit/receive-time-r1.test.ts(13,3): error TS2305: Module '"../../execution/src/domain/raw-event.js"' has no exported member 'requireSubsecondReceiveStamp'.
```

This proves the reviewed baseline had no comparable ReceiveStamp contract, no active raw-event-v2
constructor, and no guard preventing v1 records from entering subsecond work.
