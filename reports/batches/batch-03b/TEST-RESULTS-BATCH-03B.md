# Batch 3B Test Results

结论：全部通过。

最终验收使用新建 venv `/tmp/polymarket-money-batch-3b-final-20260716`：

- Python 3.14.4；`pip install -e '.[dev,historical]'` 成功。
- pyarrow 25.0.0、pytest 8.4.2、Ruff 0.15.21。
- `ruff check .`：passed。
- `pytest -q`：172 passed in 3.57s。
- `npm run typecheck`：passed。
- `npm test`：40 passed、0 failed；TypeScript build passed。
- Node v24.18.0，npm 11.16.0。
- `which node=/usr/local/bin/node`，`which npm=/usr/local/bin/npm`，
  `node -p "process.platform"=linux`。
- `git diff --check`：passed。

开发与失败优先证据：

- Batch 3B fail-first：3 个 collection import error，证明新合同尚不存在。
- 新增历史合同、可见性与 baseline 黄金测试：初版 14 passed。
- 精确 source URL 与冻结诊断补强后：17 passed。
- 补强前全套：Ruff passed；pytest 169 passed。
- 全部联网读取均无凭据、只读；未连接 User Channel，未调用交易接口。
