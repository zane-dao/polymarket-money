# Batch 02 环境证据

## WSL 原生工具链

```text
which node                    /usr/local/bin/node
which npm                     /usr/local/bin/npm
node -p "process.platform"    linux
node --version                v24.18.0
npm --version                 11.16.0
python3 --version             Python 3.14.4
```

没有调用 Windows Node/npm。HTTP/HTTPS proxy 在进程环境中存在，但只记录了布尔存在性，
没有读取、打印或写入代理值。`node --use-env-proxy` 只用于公开 endpoint 的有限 smoke。

## Git

```text
branch       batch/2-readonly-data
batch 1      7f3c1c4429217c36edf0f018a5f3efb065cea312
tag          batch-1-accepted
identity     Codex <codex@local.invalid>  (repository-local)
remote push  not performed
```

## 文件系统

- 仓库：WSL Linux 路径 `/root/projects/polymarket-money`
- smoke：仓库外 `/tmp/...`
- closed segments/manifests：mode 0400
- DrvFS `/mnt/c`、`/mnt/d` 未作为可信 raw store 验收
