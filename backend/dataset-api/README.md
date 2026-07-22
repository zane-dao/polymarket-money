# Dataset API

本目录是工作台数据集页面与历史数据目录之间的后端应用边界。前端只能通过固定 Tauri 命令取得无路径 DTO，不能直接读取文件或数据库。

## 添加外部历史数据

“添加”只登记用户明确输入的、仓库外部的绝对 `normalized` 发布根目录。目录必须使用以下只读布局，并且每个 manifest 与输出文件都要通过现有哈希验证：

```text
normalized/
  dataset_id=<id>/
    version=<dataset-hash>/
      manifest.json
      <manifest 声明的输出文件>
```

后端拒绝相对路径、仓库内路径、符号链接、普通文件、未知或不完整布局。原始文件不会复制或修改。受控 registry 仅保存于数据根的 `workbench/dataset-sources/`，其中路径是后端私有状态；注册、扫描、详情与选择 DTO 均不返回路径。

回测 worker 需要打开已选择版本时，只能调用后端专用 `resolveForExecution`。该方法重新扫描固定根和 registry 根、核对数据集 ID 与完整版本 hash、拒绝符号链接逃逸及多根歧义，然后返回仅供后端 worker 使用的 publication 目录。这个内部 capability 不得加入 Web/前端 DTO。

## Web 原始数据归一化

Web 工作台还提供固定的 `normalize_raw_dataset_v1` 命令。用户必须明确提交仓库外绝对文件或平铺目录以及数据集 ID；后端只读 CSV、JSON、NDJSON/JSONL，严格限制文件数和大小，拒绝符号链接、嵌套目录及未知字段。

统一输入事件的 `event_type` 只允许：

- `binance_price`：`BINANCE_SPOT`、`BTCUSDT`、价格；
- `polymarket_market`：市场身份、五分钟窗口、UP/DOWN token 和接单状态；
- `polymarket_book`：UP/DOWN 双边最优价与数量；
- `polymarket_settlement`：胜方和离线 evidence reference。

JSON 可直接使用事件数组，或 `{ "schemaVersion": "workbench-raw-events-v1", "events": [...] }`；NDJSON 每行一个事件；CSV 表头必须与对应事件 schema 完全一致。不同格式最终都生成 `unified-market-event-v1` 的 `events.jsonl`，并写入 `dataRoot/normalized/dataset_id=<id>/version=<hash>/`。版本 hash 由规范化 manifest 内容决定；重复输入幂等返回同一版本。manifest 只记录原始输入内容 hash，不记录原始路径，且不会把原始全量复制进数据库。

Parquet 不属于该命令的支持格式。既有 external historical Parquet adapter 继续独立运行；缺少 `pyarrow` 时必须 fail closed，不能把 Parquet 当作 JSON/CSV 猜测解析。

## 修改规则

- 新格式先扩展 `backend/market-data/dataset-catalog.ts` 的哈希验证，再开放注册，不能只靠文件名识别。
- 新响应字段必须同步更新前端严格 parser，并继续禁止路径、数据库连接和原始记录进入 DTO。
- 注册根每次扫描前都重新检查真实路径和布局；不能因曾经注册而绕过安全检查。
- 保持原始发布只读。需要转换时应由独立后端流程生成新的 immutable normalized 版本。
- 修改 raw schema 时必须同步修改三种格式测试、前端严格 DTO 和本 README；禁止宽松接收未知列或字段。
