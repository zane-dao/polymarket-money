# Batch 02.5 test results

日期：2026-07-15  
环境：WSL Linux；Python 3.14.4；Node `/usr/local/bin/node`；npm
`/usr/local/bin/npm`；`process.platform=linux`

## Fail-first evidence

提交 `1121538` 只加入 Batch 2.5 测试。执行：

```text
python3 -m unittest tests.unit.test_point_in_time tests.replay.test_normalized_dataset
```

结果：2 个 test module import error，均为预期的
`ModuleNotFoundError: research.polymarket_money.normalized`。随后才添加实现。

## Python full suite

```text
python3 -m unittest discover -s tests -p 'test_*.py' -q
----------------------------------------------------------------------
Ran 119 tests in 1.376s

OK
```

同一 worktree 的 pytest 结果为 `119 passed in 2.24s`。其中 Batch 2.5 专项 56/56，Batch 1/2
既有 63 项继续通过。

## Clean Python installation

在新的 `/tmp/polymarket-money-batch-2-5-repro-venv` 执行：

```text
python3 -m venv /tmp/polymarket-money-batch-2-5-venv
python -m pip install --upgrade pip
python -m pip install -e '.[dev]'
python -m pytest -q
ruff check .
```

结果：editable wheel 构建/安装成功；pytest `119 passed in 2.35s`；Ruff
`All checks passed!`。环境版本为 Python 3.14.4、pytest 8.4.2、Ruff 0.15.21。项目未新增
runtime dependency；只安装 pyproject 已声明的 pytest/Ruff dev extras。

## Clean Node installation and tests

```text
npm ci
npm test
npm run typecheck
```

结果：安装 3 packages，audit 0 vulnerabilities；Node v24.18.0、npm 11.16.0、
`process.platform=linux`；Node `40/40 PASS`；TypeScript `tsc -p tsconfig.json --noEmit` PASS。

## Contract/integrity checks

- normalized schema JSON parse：PASS；
- exact Decimal + UTC round trip：PASS；
- raw manifest/segment verify 后篡改拒绝：PASS；
- published output tamper load 拒绝：PASS；
- completed version no-overwrite：PASS；
- same inputs/code/config same bytes/hash：PASS；
- changed input/code/config different hash：PASS；
- DrvFS reject-before-write：PASS；
- bind-mounted Windows-backed filesystem type reject：PASS；
- duplicate raw dataset ID 与 conflicting cross-manifest event ID reject：PASS；
- CLOB real audit trace/no-op/terminal 与 envelope mismatch fail-closed：PASS；
- Gamma future market/condition/slug claim 延迟依赖 quarantine、无 future leakage：PASS；
- sibling token stale/empty/crossed/ambiguous/quarantine market-wide fail-closed：PASS；
- `git diff --check`：PASS。

## Git/diff evidence

- branch：`batch/2-5-point-in-time-data`；base tag：`batch-2-accepted`（`d353eca`）；
- fail-first：`1121538`；初始实现：`6ab1552`；最终合同/实现/测试硬化：`ba13ccd`；
- 硬化提交只改动两个 normalized contracts、Python normalizer、PIT unit tests 与 normalized replay
  tests；批次设计/结果和证据仅写入本批规定的 docs/reports 目录；
- `git diff --check` PASS；未修改、复制或写入任何参考项目；未 push。

最终 documentation commit 与 annotated tag 由外部 `HANDOFF-BATCH-02-5.md` 记录，避免项目内
commit 自引用导致哈希循环。

## Limited read-only protocol review

官方 RTDS 文档只读复核：PASS，specific filter、symbol 和两个 provider timestamp 的语义与离线
合同一致。

BTC-only public probe：`15s timeout`、`maxFrames=20`、`maxFrameBytes=256KiB`、
`maxTotalBytes=1MiB`；无凭据、不落盘、不访问 User Channel。结果：

```json
{"mode":"btc-only","outcome":"timeout-or-public-network-failure","frames":1,"parsed":0,"quarantined":0,"credentials":false,"storedRaw":false}
```

该 probe 未证明当前 BTC-only transport 能在 15 秒内产生目标更新，记录为 evidence debt；没有
启用 all-symbol fallback。
