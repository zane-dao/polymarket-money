# Batch 02 测试结果

执行日期：2026-07-15（WSL，Asia/Singapore 会话；所有合同时间使用 UTC）。

## 最终离线测试

| 命令 | 结果 |
|---|---|
| `python3 -m unittest discover -s tests -v` | 63/63 passed |
| `npm test` | 40/40 passed；先执行 TypeScript build |
| `npm run typecheck` | passed，`tsc --noEmit` |
| `git diff --check` | passed |

Python 63 项包含第一批全部黄金/安全裁判；第二批覆盖 raw contract、严格 UTC、市场身份、
label-token 映射、RTDS 时钟/Decimal、off-topic quarantine、CLOB 全事件、重连后 snapshot、
manifest/path/hash/count、验证后字节、partial、幂等与 quality。

Node 40 项覆盖合同编译、public endpoint/subscription 闭集、认证字段拒绝、HTTP/WS byte
budget、heartbeat、当前 CLOB schema、订单簿状态、严格 manifest、并发 append/no-clobber、
RTDS 传输范围和非 BTC quarantine。

## 干净 Python 安装

在仓库外新建全新 venv，执行：

```text
python3 -m venv <temporary>/venv
<temporary>/venv/bin/python -m pip install --no-deps .
<temporary>/venv/bin/python -m pip check
cd /tmp
<temporary>/venv/bin/python -m unittest discover -s /root/projects/polymarket-money/tests -v
```

结果：wheel 构建/安装成功，`pip check` 无 broken requirements，63/63 通过。Python runtime
dependencies 为 0。

## 干净 Node 安装

```text
npm ci
npm test
npm run typecheck
npm ls --all
npm audit --omit=dev
```

结果：40/40 通过，typecheck 通过，dependency tree 完整，0 vulnerabilities。只有开发依赖
TypeScript 5.9.3、`@types/node` 24.13.3 及其 `undici-types` 7.18.2；runtime dependencies
为 0。

## 联机验证

`scripts/verify-smoke.py` 对成功 run `smoke-20260715125957-6347222a` 返回：

- `passed=true`
- `manifest_count=4`
- `partial_file_count=0`
- 9/9 checks 为 true
- 四段 checksum/manifest/replay 验证通过
- `continuity=UNVERIFIED`

联机结果只证明一次有限公开协议路径，不代替长期采集测试。
