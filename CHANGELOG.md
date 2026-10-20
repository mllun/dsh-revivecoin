# Changelog

## 1.1.0 — 2026-10-21

设置 UI（两半配对）。

- Host 半改为 TypeScript（`src/index.ts`），导出 schemastery `Config`：设置页据此生成表单，
  命名空间由设置服务从 schema 与 profile entry 派生。
- 新增浏览器半（`src/client/index.tsx` → `lib/client.js`）：向 `plugins.bundle.config` 槽位注册
  卡片，key 为包名；通过 `ctx.get('configForms')` 订阅并写回配置。
- 打包：`exports['./client']`、`dsh.client`（platform/immediately/inject），`main` 指向 `lib/index.js`，
  根 `index.js` 作为入口转发 shim。
- 构建：`npm run build`（tsc 编译 Host 与浏览器两半）。
- 新增 `test/client-smoke.mjs`：在 VM 里执行编译后的客户端，断言工厂 id、槽位 key、无配置服务时安全跳过。
- 文档：补「设置 UI（两半配对）」与目标版本 0.2.1-rc.2 的实测差异表。

## 1.0.0 — 2026-10-21

首个版本。

- 四个工具：`coin_create` / `coin_list` / `coin_diff` / `coin_restore`。
- 五类扫描范围：会话记录与上下文、角色卡与预设、插件清单及版本、插件数据、配置文件。
- `daily` 模式：一天一枚，同日重复调用刷新当天那枚。
- 每枚币产出 `manifest.json`（机器可读）与 `manifest.md`（人可读），文件按原路径镜像。
- 还原固定流程：备份现状 → 版本报告 → 写回 → 依赖提示 → 报告 → 重启提示。
- 安全约束：拒绝系统目录、不删用户数据、备份失败即中止、版本不符只报告、全程可读日志、
  `confirm=true` 硬门槛。
- 还原时跳过本次运行期间仍在写的会话文件，避免写坏当前对话。
- 本机专属路径放在 `$DSH_HOME/dsh-revivecoin/config.json`，发行包保持通用。
