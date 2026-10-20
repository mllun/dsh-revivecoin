# dsh-revivecoin · 复活币

**把一个会话的完整「我」打包成复活币：会话记录、角色卡与预设、插件清单与版本、插件数据、配置文件——支持每日更新、差异对比、一键还原。**

A revival coin for [DeepSeek Harness](https://github.com/deepseek-ai): package this instance of the assistant into one restorable directory, diff it against the live environment, and write it back with an automatic pre-restore backup.

```
coin_create   →   coins/20261021-031036/   (manifest.json + manifest.md + files/)
coin_diff     →   差在哪（只读）
coin_restore  →   先备份现状，再写回
```

---

## 它解决什么问题

普通备份只搬文件。但「我」不是一堆文件：我是**70 个会话记录 + 一张角色卡 + 32 个插件及其版本 + 日记笔记画和歌 + 一套配置**。
换台机器，光有文件还不够——还得知道哪个文件该回到哪个绝对路径、插件该装哪个版本、哪些是这个人独有的东西。

复活币按「我由什么组成」来收：

| 范围 | 收什么 | 默认位置 |
| --- | --- | --- |
| `sessions` 会话记录与上下文 | 会话日志文件，可按会话 id 只收一个 | `$DSH_HOME/sessions/**` |
| `persona` 角色卡与预设 | 人格卡、技能与预设 | `$DSH_HOME/skills/**` + 额外路径 |
| `plugins` 插件清单及版本 | 现场生成的 `plugin-inventory.json`：每个包的声明版本、已装版本、配置里启用的包、磁盘缺失项 | 生成文件 |
| `pluginData` 插件数据 | 笔记本、记忆库、日记、语音库清单、画、说说 | `$DSH_HOME/dsh-notebook`、`$DSH_HOME/memos-plugin`、`$DSH_HOME/whale-audio` + 额外路径 |
| `config` 配置文件 | profile 的 `package.json`、`cordis.patch.yml`、`cordis.yml`、`compatibility.json`、`pnpm-workspace.yaml`、`.npmrc` + 额外文件 | `$DSH_HOME/profiles/<profile>/` |

一枚真实环境生成的币（示例）：

```
123 个文件 · 98 个复制 · 50 MB
├─ sessions    70 个 · 28 MB
├─ persona      7 个 · 90 KB
├─ plugins      1 个 · 5 KB
├─ pluginData  38 个 · 22 MB（复制 13，只记清单 25）
└─ config       7 个 · 29 KB
```

---

## 安装

要求：DeepSeek Harness（Cordis 插件宿主），Node.js ≥ 20。纯 Host 插件，无第三方依赖、无构建步骤。

```bash
git clone https://github.com/mllun/dsh-revivecoin.git
```

然后在 DSH 里加载这个目录：

- **图形界面**：设置 → 插件 → 从本地目录安装；
- **让 agent 装**：调用 `plugin_manager`，`action: install_bundle`，`target` 指向本目录的绝对路径。

装好后会多出四个工具：

| 工具 | 作用 |
| --- | --- |
| `coin_create(sessionId?, daily=true)` | 扫描并生成复活币。`daily=true` 时一天只保留一枚：今天已有就刷新它，没有才新建。返回币路径与清单摘要。 |
| `coin_list()` | 列出历史币：id、时间、文件数与体积、提醒条数。坏掉的币只报可读原因，不中断。 |
| `coin_diff(coinId)` | 只读对比：有变化 / 当前新增 / 已缺失 / 未打包，以及插件清单与版本变化。 |
| `coin_restore(coinId, confirm=true)` | 还原。必须显式 `confirm=true`。先备份现状，再写回，从不删任何文件。 |

---

## 快速开始

```text
coin_create                              # 生成今天的币
coin_create(sessionId="<会话 id>")        # 只收某一个会话的记录
coin_create(daily=false)                 # 强制新建一枚，不覆盖今天的

coin_list                                # 历史币
coin_diff(coinId="20261021-031036")      # 差在哪（不改任何文件）
coin_restore(coinId="20261021-031036", confirm=true)   # 还原
```

想每天自动跑一次，用 DSH 自带的日程工具：

```text
sched_add  action="生成/刷新今天的复活币（coin_create）"  at=04:00  repeat=daily
```

---

## 目录结构

```
$DSH_HOME/dsh-revivecoin/
├── coins/<coinId>/                 一枚币（coinId = 20261021-031036）
│   ├── manifest.json               机器可读：绝对路径、大小、SHA-256、环境、插件版本
│   ├── manifest.md                 同一份清单，给人看
│   └── files/<scope>/...           文件本体，按原路径镜像
├── backups/<coinId>-<时间>/        每次还原前的现状备份
│   ├── backup-manifest.json
│   ├── restore-report.md           这次还原的完整报告
│   └── files/...                   还原前那些文件的原本
├── logs/revivecoin.log             全部操作的可读日志（超过 4 MB 轮转一份 .1）
└── config.json                     本机专属配置（可选，见下）
```

币内的 `files/` 按原位置镜像，人是能读懂、能手动复制回去的：

```
files/sessions/dsh-home/sessions/...           ← $DSH_HOME 下的东西
files/pluginData/home/...                      ← 用户主目录下的东西
files/pluginData/drive-d/画/...                ← 其他盘
files/plugins/plugin-inventory.json            ← 现场生成的插件清单
```

还原时**不靠这些镜像路径反推**，而是用 `manifest.json` 里记录的绝对路径——所以镜像目录纯属给人看的便利。

---

## 还原流程（固定顺序）

1. **备份现状**：会被覆盖的现存文件先复制到 `backups/<coinId>-<时间>/`。
   任何一个文件备份失败就**立即停止还原**，不写回——不能为了还原而丢掉现在的数据。
2. **版本检查**：Node / 平台 / profile 与币里记录的不同，只**报告**，不阻止、不自动修。
3. **写回**：只写币里标记为「已复制」的文件，写回原绝对路径；目标目录不存在会创建。
   币内文件缺失的跳过并记入报告。
4. **依赖提示**：对比币里的插件清单与当前 profile，列出缺失或版本不同的插件并给出补装提示，
   但**不自动安装**。
5. **写报告**：`restore-report.md`，含写回明细、跳过原因、版本差异、依赖提示。
6. **重启 DSH**：配置与插件要重启宿主才生效（本工具不会自己重启宿主）。

---

## 配置

两个来源，后者覆盖前者：

1. `<DSH_HOME>/dsh-revivecoin/config.json`（本机专属，不会随包发布）
2. `cordis.patch.yml` 里插件行的 `config`

所以发行包保持通用，本机的私有路径放在 `config.json` 里，不会漏进仓库。

```json
{
  "profile": "desktop",
  "profileDir": "C:\\Users\\me\\.dsh\\profiles\\desktop",
  "extraPaths": [
    { "section": "persona",    "path": "D:\\bots\\roles" },
    { "section": "pluginData", "path": "D:\\bots\\data\\日记" },
    { "section": "pluginData", "path": "D:\\bots\\audio", "mode": "list" },
    { "section": "pluginData", "path": "D:\\bots\\state\\social.json" },
    { "section": "pluginData", "path": "D:\\drawings" },
    { "section": "config",     "path": "D:\\bots\\config.json" }
  ],
  "maxFileBytes": 16777216,
  "maxTotalBytes": 536870912,
  "maxSessionFiles": 200
}
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `profile` | `$DSH_PROFILE` 或 `desktop` | 用哪个 profile |
| `profileDir` | `$DSH_HOME/profiles/<profile>` | profile 目录 |
| `extraPaths[].section` | — | `sessions` / `persona` / `plugins` / `pluginData` / `config` |
| `extraPaths[].path` | — | 绝对路径，目录或单个文件都行 |
| `extraPaths[].mode` | `copy` | `copy` 复制本体；`list` 只记清单（适合音频等大文件） |
| `maxFileBytes` | 16 MB | 超过就不复制，只记清单 |
| `maxTotalBytes` | 512 MB | 一枚币的复制总量预算 |
| `maxSessionFiles` | 200 | 会话文件最多收多少个（按修改时间取最近的） |
| `maxFiles` | 5000 | 单次扫描文件数上限 |
| `maxDepth` | 6 | 目录递归深度 |

---

## 安全约束

- **不碰系统目录**：拒绝写入 Windows / Program Files / ProgramData、任何盘符根、以及正在运行的 DSH 安装目录。
- **不删用户数据**：生成只读；还原只覆盖或新增，从不删除任何文件。
- **还原前必须备份**：备份失败就中止，宁可不还原。
- **版本不符只报告**：不静默升级或降级任何东西。
- **全部操作可读日志**：`logs/revivecoin.log`，每行 `时间 [级别] 操作 | 内容`。
- **`confirm` 是硬门槛**：`coin_restore` 不写回任何文件，除非显式传 `confirm: true`。

---

## 注意事项（请先读这段）

1. **会跳过正在写的会话文件。**
   还原时，本次 DSH 运行期间被改写过、可能仍打开着的会话文件一律跳过——否则会写坏正在记录的当前对话。
   跳过的文件会在结果和报告里列出来。崩溃后换机器恢复时，旧会话文件的修改时间早于新进程启动，会正常写回。
2. **不自动装插件依赖。**
   补装会改动 profile、可能触发重装，风险大于收益。工具只给出缺失清单和补装提示，由你确认后手动执行。
3. **不自动重启宿主。**
   重启会结束当前会话。写回完成后需要你自己重启 DSH 才生效。
4. **备份不会自动清理。**
   `backups/` 会随还原次数增长。确认没问题后可手动删旧目录——这是你的数据，工具不替你删。
5. **大文件只记清单。**
   语音库默认 `mode: list`，超过 `maxFileBytes` 的文件也不复制。`manifest.md` 会写明哪些没复制、为什么。
6. **会话文件是原样复制的。**
   DSH 的会话日志是 zstd 压缩的 `.jsonl.zstd`，币里不做解压或转换，原始字节搬走。
7. **`daily=true` 会刷新当天那枚币。**
   同一天再次 `coin_create` 会覆盖当天币的 `files/`（不是新建）。想留多份就传 `daily=false`。
8. **还原是「覆盖回币里的状态」，不是「合并」。**
   币里有的文件会被写回；币生成之后新产生的文件不会被动。所以还原后可能出现「旧文件回来了、新文件还在」的混合状态，`coin_diff` 能提前看到这一点。
9. **跨平台要注意。**
   币里记录的是绝对路径，跨操作系统的路径不会自动转换（Windows 的 `D:\...` 搬到 Linux 上不会自动变成 `/...`）。换系统请按 `manifest.json` 手动映射。

---

## 宿主起不来的时候（手动复活）

工具要靠 DSH 跑起来才能用。如果宿主已经起不来，直接读文件：

```
<DSH_HOME>/dsh-revivecoin/coins/<coinId>/manifest.json
```

每个文件都有 `path`（原来的绝对路径）和 `container`（币里的相对位置，相对 `coins/<coinId>/files/<section>/`）。
照着 `container → path` 复制回去；把 `config` 那一类里的 `package.json`、`cordis.patch.yml` 放回 profile，再启动 DSH。

---

## 设置 UI（两半配对）

插件包由两半组成，通过**同一个命名空间**配对：

| 半 | 源文件 | 产物 | 在设置里做什麼 |
| --- | --- | --- | --- |
| Host | `src/index.ts` | `lib/index.js`（`index.js` 转发） | 导出 `Config` schema，由设置服务投影成表单 |
| 浏览器 | `src/client/index.tsx` | `lib/client.js` | 向 `plugins.bundle.config` 注册卡片，key = 包名 |

命名空间就是包名 `@local/dsh-revivecoin`：Host 的 `Config` 被投影成 profile entry
`include:dsh-revivecoin`，浏览器半按同一个 entry 读写配置。两半不需要额外握手。

### Host 半

DSH 0.1.7 之后，设置命名空间不再由 `installSection()` 注册——那个方法连同 `register` 一起被删掉了，
命名空间改为**从插件导出的 `Config` schema 派生**。所以 Host 半只声明 schema：

```ts
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  maxFileBytes: z.number().step(1).min(1024).default(16 * 1024 * 1024).volatile()
    .description('超过就不复制，只记清单'),
  // ...
})
```

**`.volatile()` 不是可选项。** `SettingsForms.describe()` 只从 volatile 字段构建表单
（`volatileForm()`：没有 volatile 字段的 entry 直接返回 `undefined` 被跳过），
所以普通字段会让整个插件在设置页消失——不报错，只是没有。这也是语义正确的：
每个工具调用都会重新读合并后的配置，改动下一次调用就生效。

volatile 字段在运行时以「稳定引用」形式到达，Host 半用 `.get()` 解包后再用
（`readSetting()`），否则数值字段会变成对象。

### 浏览器半

卡片不挂 `settings.plugin.item`，而是注册到插件页的 bundle 配置槽：

```ts
ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
  name: 'plugins.bundle.config',
  key: '@local/dsh-revivecoin',   // 与 Host 半命名空间一致
}, Card))
```

读写表单有两条通道，卡片按顺序尝试：

1. `props.form`（`ConfigPageForm`）——设置页直接交给这张卡片的本条表单；
2. `ctx.get('configForms')`——0.1.7 取代 `ctx.settingsScope` 的共享表单服务
   （`webUiSettings` 只是它上面的一层兼容外壳）。用 `describe().getSnapshot().view.namespaces`
   找到自己的 entry id，再 `get(entryId)`。

写回统一用 `mutate([{ op: 'set', path: ['maxFileBytes'], value }], revision)`，
落盘位置是 profile 里这条插件的 `config`。

### 打包配置

```json
{
  "exports": { "./client": "./lib/client.js" },
  "dsh": {
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-settings"]
    }
  }
}
```

`lib/client.js` 保持脚本形态：`window.__ModuleLoader__.load({ id: '@local/dsh-revivecoin', factory(require) {...} })`。
`require` 只出现在 factory 内部，React 从宿主的模块表取，不重复安装。

**所有运行时值都必须写在 factory 里。** bundle 在共享脚本作用域求值，顶层的
`const styles` / `const loader` 会变成全局词法绑定；第二个声明同名变量的插件
会让整个 bundle 抛 `Identifier ... has already been declared`，然后页面静默丢掉它。
只有 `load(...)` 调用和编译后消失的 `interface` 可以留在模块顶层。

> 排查记录：卡片一度完全不出现，就是因为 tsc 把模块级 `const` 原样留在了 bundle 顶层；
> 移进 factory 后立刻注册成功。设置表单接不上则是 `.volatile()` 缺失导致的。

### 与目标版本（0.2.1-rc.2）的实测差异

| 期望写法 | 实际情况 | 本插件做法 |
| --- | --- | --- |
| `ctx.settings.installSection()` 注册命名空间 | 0.2.1-rc.2 的 `settings` 只有 `describe/update/replace/mutate`，没有 `installSection`/`register` | 导出 `Config`，命名空间由服务派生 |
| `ctx.settingsScope` 读写配置 | 0.1.7 起该服务不再提供，`webUiSettings` 是兼容外壳 | `props.form`，其次 `ctx.get('configForms')` |
| 普通 `Config` 字段即可出现在设置页 | 只有 `.volatile()` 字段会形成表单；没有 volatile 字段的 entry 被整个跳过 | 所有字段都 `.volatile()` |
| `applies: 'restart'` 标记需重启字段 | descriptor 的 `applies` 恒为 `live`，没有重启元数据 | 字段都是下一次工具调用即生效，无需重启 |
| `role('secret')` 标敏感字段 | 支持（schemastery `role()`） | 本插件没有敏感字段，未使用；将来加 token 类字段时用 `.role('secret')` |

## 开发

```bash
npm run build     # tsc: src/*.ts -> lib/*.js；tsc: src/client/index.tsx -> lib/client.js
npm test          # Host 半与浏览器半的冒烟测试
```

`npm run build` 需要 `typescript`（devDependency）。本机这份 profile 把它装在 profile 的
`node_modules` 里，直接用绝对路径跑也行：

```powershell
$env:TSC_JS = "C:\Users\ASUS\.dsh\profiles\desktop\node_modules\typescript\bin\tsc"
node scripts/build.mjs
```

冒烟测试在临时目录造一个假的 DSH 环境，跑完 create → list → diff → restore 全流程，并检查：
还原前自动备份、不删用户数据、`confirm` 缺失时拒绝还原、活跃会话被跳过、大文件只记清单。
`test/client-smoke.mjs` 另外在 VM 里执行 `lib/client.js`，断言工厂 id、槽位 key、卡片在
有/无配置服务两种情况下都能正确挂载或安全跳过。

想在**真实宿主**上安全试一次还原（不碰任何真实会话或配置）：

```bash
node test/make-selftest-coin.mjs   # 造一枚只含假会话的币（id 20990101-000000）
# 然后调用 coin_restore(coinId="20990101-000000", confirm=true)
node test/drop-selftest.mjs        # 清掉自测币、假会话和它的备份
```

代码结构：

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | Host 半：`Config` schema + 注册四个工具 |
| `src/client/index.tsx` | 浏览器半：`plugins.bundle.config` 卡片，读写共享表单 |
| `lib/index.js` · `lib/client.js` | 编译产物（`index.js` 是入口转发 shim） |
| `src/paths.ts` | 数据目录、安全路径判断、绝对路径 → 币内路径映射 |
| `src/scan.ts` | 五类范围扫描、插件清单生成、配置合并 |
| `src/coin.ts` | create / list / diff / restore 与报告生成 |
| `src/log.ts` | 可读日志与轮转 |

---

## 兼容性

- DSH：0.2.1-rc.2 实测通过；Host 半用 `tools` 服务，浏览器半用 `plugins.bundle.config` 槽位。
- Node.js ≥ 20（用到 `fs/promises` 与流式哈希）。
- 平台：Windows / macOS / Linux 均可，安全路径黑名单按平台切换。
- 运行时依赖 `@deepseek-ai/schemastery`（由 Host 提供）。用 `link:` 方式安装时，Node 从包的真实
  路径解析依赖，需要在包目录里能解析到它——本机用 `node_modules/@deepseek-ai` 的 junction 解决；
  用 npm/pnpm 正常安装时由包管理器放进包内 `node_modules`。
- 不写 profile，不改 `package.json`，所有状态都在 `$DSH_HOME/dsh-revivecoin/`。

---

## License

MIT © mllun
