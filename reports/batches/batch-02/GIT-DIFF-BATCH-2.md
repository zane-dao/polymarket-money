# Batch 02 Git diff 摘要

比较基线：`batch-1-accepted` (`7f3c1c4`) 到 Batch 2 分支交付。

最终候选统计为：

```text
62 files changed, 7634 insertions(+), 125 deletions(-)
```

标签建立后可用以下命令复核：

```text
git diff --stat batch-1-accepted..batch-2-accepted
git diff --name-status batch-1-accepted..batch-2-accepted
```

为准。主要变化：

- 新增 raw JSON Schema、共享 fixture/provenance；
- 新增 public Gamma/CLOB/RTDS adapter、parser、book state；
- 新增 immutable raw writer、strict DatasetManifest；
- 新增 Python raw contract、market identity、quality、manifest verifier/replay；
- 执行 domain 的时间与 Decimal 边界收敛；
- 新增 33 项 Python（30→63）和 25 项 Node（15→40）测试；
- 新增批次设计、结果和 evidence 文档。

未修改两个只读参考项目，未提交 raw smoke、日志、凭据、数据库、模型或大文件。每个代码
提交均可用 `git revert` 回滚；没有外部数据库迁移或远程 push。
