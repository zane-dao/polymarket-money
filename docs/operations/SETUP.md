# 开发环境

要求：Python 3.11+ 与 Node.js 24+。安装项目依赖后，常用验证为：

```bash
npm ci
npm test
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

Python 开发依赖与完整命令以 `pyproject.toml` 为准。原始数据、journal 与 paper artifact 必须位于仓外的绝对 `POLY_DATA_ROOT`，不得写入 Git。任何联网运行或长期采集均须取得当次明确批准。
