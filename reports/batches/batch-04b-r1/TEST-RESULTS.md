# Batch 4B-R1 test results

验证日期：2026-07-16  
代码复验点：`45c3350` 及其前置 R1 提交  
长期观测：**未启动**

| 检查 | 结果 |
|---|---|
| Python full suite | 183 passed |
| R1 fee cross-language + execution targeted | 17 passed（实现阶段） |
| Ruff | All checks passed |
| Clean venv editable install | passed |
| Clean venv pytest | 183 passed |
| pip check | No broken requirements found |
| npm ci | 5 packages audited, 0 vulnerabilities |
| Node full suite | 82 passed |
| TypeScript typecheck | passed |
| npm audit --omit=dev | 0 vulnerabilities |
| git diff --check | passed |

Clean Python environment：`/tmp/polymarket-money-r1-venv-1784196993`。它仅用于验证，没有
读取凭据或运行网络采集。Node clean install 来自已锁定 package-lock；运行依赖
`decimal.js` 精确锁定为 10.6.0。

专项证据见 `FAIL-FIRST-EVIDENCE.md`。每个主要整改组都有独立 fail-first commit 和实现
commit；最终 provenance 加固也采用同样两提交结构。
