# 2026-07-20 20:42 Asia/Singapore｜文档体系审计与整改

## 目标

按单一事实来源、关注点分离、渐进披露、可追溯和全局唯一文档名整理主仓文档。

## 事实与证据

- 整改前 `CURRENT.md` 有 395 行，混合当前停点、逐次提交、测试数字和历史运行过程。
- 文档中有三个 `INDEX.md`、两个 `README.md`、七个 `TEST-RESULTS.md`、四个
  `UNRESOLVED-ISSUES.md`、两个 `FAIL-FIRST-EVIDENCE.md` 和两个
  `experiment-preregistration.md`。
- 根 `docs/` 散落 Batch 1 设计、旧系统审计、reuse gate 和报告说明。
- 整改后仓库自有 Markdown/MDX 文档名无重复，本地 Markdown 相对链接检查为 0 断链，
  `git diff --check` 通过；环境未安装 MkDocs，未执行站点构建。

## 修改

- 将旧 `CURRENT.md` 原样归档，重写短的当前状态、当前 Batch、下一步和硬边界。
- 新增 Batch 与 archive 职责索引，报告入口改名为 `REPORTS-INDEX.md`。
- 将 Batch 1 文档、旧系统审计、reuse gate 和报告说明迁入对应目录。
- 为所有重复文档名增加 Batch 或职责限定，并同步修复引用和 MkDocs 导航。
- 收敛 `AGENTS.md`、`docs/INDEX.md` 与维护协议的渐进阅读顺序。

## 验证

- Markdown/MDX 全局 basename 重复数：0。
- 本地 Markdown 相对链接断链数：0。
- 旧路径残留扫描：0。
- `git diff --check`：通过。

## 决定

- 文档全局唯一命名不扩展到 `__init__.py`、`index.ts`、`.gitkeep` 等非文档约定文件。
- 不删除历史内容；过期但有追溯价值的材料全部迁入 archive 或对应历史 Batch。

## 未决问题

- 当前环境没有 MkDocs，站点渲染未实际构建；导航目标已做路径存在性检查。
- `data/fixtures/batch-2/PROVENANCE.md` 是 fixture 的局部来源说明，保留原位，不纳入项目管理文档路由。

## 下一步

后续新增文档按 `docs/operations/MAINTENANCE.md` 检查职责、入口、链接和文件名唯一性。
