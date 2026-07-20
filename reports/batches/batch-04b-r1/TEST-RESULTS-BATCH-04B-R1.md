# Batch 4B-R1 test results

验证日期：2026-07-16

代码复验点：`e4d638e948c42024871d13c21755ed2dbdd40733`

合同文档收口：`08bc6d4`
长期观测：**未启动**

| 检查 | 结果 |
|---|---|
| Python full suite | 190 passed |
| Ruff | All checks passed |
| Clean venv editable install | passed |
| Clean venv pytest | 190 passed |
| Clean venv Ruff | All checks passed |
| pip check | No broken requirements found |
| npm ci | 5 packages audited, 0 vulnerabilities |
| Node full suite | 89 passed |
| TypeScript typecheck | passed |
| npm audit --omit=dev | 0 vulnerabilities |
| git diff --check | passed |

Clean Python environment：`/tmp/polymarket-money-r1-final-6b4b004`。它只安装本地 editable
package 与已声明的 dev/historical 依赖，没有读取凭据或启动网络采集。Node 在 `npm ci` 后
隔离执行 89/89；`decimal.js` 由 lockfile 精确锁定为 10.6.0。

第二次 Sol 复验也得到 Python 190/190、Node 89/89、Ruff、typecheck 和 diff check 通过。
复核期间一次与主代理并发 `tsc` 写同一 `dist` 目录时出现瞬时模块加载失败；停止并发后目标
测试及隔离全量 Node 均稳定通过，判定为验证进程竞争而非代码可复现故障。最终证据采用隔离
运行结果。

专项证据见 `FAIL-FIRST-EVIDENCE-BATCH-04B-R1.md`。每个主要整改组及第二次 Sol 新发现的 Critical 均先有
失败测试提交，再有最小实现提交。本批没有运行 150 分钟观测、创建验收标签、训练模型、进入
shadow/live、连接 User Channel、读取凭据、签名或发送订单。
