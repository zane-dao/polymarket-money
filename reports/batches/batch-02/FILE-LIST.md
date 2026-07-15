# Batch 02 实际文件清单

相对 `batch-1-accepted`，最终候选共涉及 62 个 Git 文件。`A` 为新增，`M` 为修改。

## 根配置（7）

- M `.env.example`
- A `.gitattributes`
- M `AGENTS.md`
- M `README.md`
- M `package-lock.json`
- M `package.json`
- M `tsconfig.json`

## 合同与 fixture（7）

- A `contracts/raw-event-v1.schema.json`
- A `data/fixtures/batch-2/PROVENANCE.md`
- A `data/fixtures/batch-2/clob-market-events.json`
- A `data/fixtures/batch-2/gamma-btc-5m.json`
- A `data/fixtures/batch-2/raw-event-v1.golden.expected.json`
- A `data/fixtures/batch-2/raw-event-v1.golden.jsonl`
- A `data/fixtures/batch-2/rtds-events.json`

## TypeScript 实现（12）

- A `execution/src/adapters/market-data/book-state.ts`
- A `execution/src/adapters/market-data/index.ts`
- A `execution/src/adapters/market-data/parsers.ts`
- A `execution/src/adapters/market-data/public-sources.ts`
- M `execution/src/domain/index.ts`
- A `execution/src/domain/raw-event.ts`
- M `execution/src/risk/index.ts`
- A `execution/src/storage/index.ts`
- A `execution/src/storage/raw-segment.ts`
- M `execution/src/strategy/index.ts`
- A `scripts/smoke-capture.ts`
- A `scripts/verify-smoke.py`

## Python 实现（5）

- M `research/polymarket_money/__init__.py`
- A `research/polymarket_money/data_quality.py`
- A `research/polymarket_money/market_identity.py`
- A `research/polymarket_money/raw_events.py`
- A `research/polymarket_money/replay.py`

## 测试（11）

- A `tests/replay/__init__.py`
- A `tests/replay/test_raw_replay.py`
- M `tests/unit/contracts.test.ts`
- A `tests/unit/public-data-hardening.test.ts`
- A `tests/unit/raw-contract-hardening.test.ts`
- A `tests/unit/raw-data.test.ts`
- A `tests/unit/raw-storage-hardening.test.ts`
- M `tests/unit/test_configuration.py`
- A `tests/unit/test_data_quality.py`
- A `tests/unit/test_market_identity.py`
- A `tests/unit/test_raw_contract.py`

## 工程与批次文档（10）

- M `docs/architecture.md`
- M `docs/migration-plan.md`
- M `docs/target-architecture.md`
- A `docs/batches/batch-02-readonly-data/data-contract.md`
- A `docs/batches/batch-02-readonly-data/data-provenance.md`
- A `docs/batches/batch-02-readonly-data/data-quality.md`
- A `docs/batches/batch-02-readonly-data/market-identity.md`
- A `docs/batches/batch-02-readonly-data/raw-storage.md`
- A `docs/batches/batch-02-readonly-data/batch-2-result.md`
- A `docs/batches/batch-02-readonly-data/HANDOFF-BATCH-02.md`

## 验证报告（10）

- A `reports/batches/batch-02/BATCH-2-VERDICT.md`
- A `reports/batches/batch-02/ENVIRONMENT-BATCH-2.md`
- A `reports/batches/batch-02/FAIL-FIRST-EVIDENCE.md`
- A `reports/batches/batch-02/FILE-LIST.md`
- A `reports/batches/batch-02/GIT-DIFF-BATCH-2.md`
- A `reports/batches/batch-02/SECURITY-SCAN-BATCH-2.md`
- A `reports/batches/batch-02/SMOKE-CAPTURE-QUALITY.md`
- A `reports/batches/batch-02/TEST-RESULTS-BATCH-2.md`
- A `reports/batches/batch-02/UNRESOLVED-ISSUES.md`
- A `reports/batches/batch-02/dataset-manifest.example.json`

未进入 Git：任何 raw smoke segment、真实 manifest、`.partial`、日志、凭据、数据库、
`node_modules`、venv、build/dist、review pack 副本或参考项目文件。
