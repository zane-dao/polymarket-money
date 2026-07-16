# Batch 4B-R2 experiment preregistration

状态：**FROZEN BEFORE OBSERVATION / NOT YET LAUNCHED**

本批只用 R1 已验收的公共只读 runtime 做一次 metrics-only 观测。冻结配置是
`experiments/batch-04b-r2-24-market-observation.yaml`；该文件使用 JSON 语法，因 JSON 是
YAML 的严格子集，所以无需引入新的 YAML 解析依赖。精确文件 SHA-256 由同目录 `.sha256`
文件和启动包装器共同校验。

配置中的 `git_commit` 是本批创建时的 R1 验收基线。实际运行 commit 单独写入 session
元数据和 runtime provenance；这是为了避免“文件包含其自身 Git commit”形成不可解的
自引用。开始运行前，配置、包装器和测试必须已提交，工作树必须干净。

固定范围：24 个合格完整市场，最长 150 分钟，最低剩余磁盘 10 GiB，raw=false，
continuity=`UNVERIFIED`，fair-value=false。Lead-lag 固定为四来源、3 个阈值、3 个 trigger
window、7 个 horizon，共 252 格（包括零计数组合）。任何质量失败只进入拒绝或 censor
统计，不得填零冒充结果。

本批不训练、不调参、不生成 OrderIntent/Fill、不连接 User Channel、不读取凭据、不签名、
不下单，也不创建第二套 monitor/order book/fee/clock/opportunity 实现。
