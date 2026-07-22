# 本地 stable/candidate 服务器模拟

时间：2026-07-22 15:06 Asia/Singapore

## 事实

- 4173定义为 stable 模拟环境，4273定义为 candidate 模拟环境；4174仅是可选 Vite 热更新工具。
- 两个后端分别只写 `production-sim` 与 `staging-sim`，环境和目录不匹配时拒绝启动。
- release 位于 Git 忽略的 `.local/`，候选通过后晋升同一构建，不重新构建。
- 执行时发现4173和4174已有从当前工作区启动的旧进程；用户随后批准并已正常终止。当前改动已移入
  主题分支，4173保持停止，避免把开发分支或脏main冒充稳定版本。

## 证据

- `npm test`：253/253。
- `npm run frontend:test -- --run`：23/23。
- TypeScript typecheck、Vite production build、candidate 构建和晋升成功。
- 4273、4174代理、临时4373 production-sim 均返回正确环境和相同 release ID。

## 决定

- 不引入多用户、Docker、Nginx或第三套部署环境。
- Vite不拥有数据；所有写入继续由4273 staging 后端完成。
- 生产模拟只运行不可变 stable release，不跟随 main 或当前工作区变化。
- 开发分支可生成4273 candidate；只有干净main构建并由4273最终验证的release可以晋升到4173。

## 未决问题与下一步

- 将主题分支审阅并合并main后，在干净main生成最终candidate，于4273验证，再晋升并启动4173。
