/**
 * DSH host plugin: revival coins for the assistant itself.
 *
 * Registers four agent tools that package and restore one whole "me":
 *  - coin_create  scan the environment and write a coin (daily-refreshable)
 *  - coin_list    show the coins on disk
 *  - coin_diff    compare the live environment with one coin (read-only)
 *  - coin_restore back up the current state, then write a coin back
 *
 * A coin covers five scopes: session records, persona and presets, the plugin
 * inventory and versions, plugin data (notebook / diary / voice library /
 * drawings / Qzone posts), and configuration files. Coins live under the
 * plugin data directory: `$DSH_HOME/dsh-revivecoin/coins/<coinId>/`.
 *
 * @module dsh-revivecoin
 */
import { createCoin, diffCoin, listCoins, restoreCoin } from './coin.js';
import { coinsDir, logFile } from './paths.js';
import z from '@deepseek-ai/schemastery';
/**
 * Settings schema for the Plugin Manager page.
 *
 * This is the whole Host half of the settings UI on DSH 0.1.7+: there is no
 * `installSection()` and no `register()` any more - the settings service
 * derives the namespace from this schema and the row's own entry id, projects
 * it into a form, and stores edits in the profile patch.
 *
 * No field here is a secret, so none carries `.role('secret')`. Add that role
 * the day this plugin grows a token or password field.
 *
 * Nothing here needs a restart: every tool call re-reads the merged config, so
 * edits apply on the next invocation. DSH 0.2.1-rc.2 has no `applies: 'restart'`
 * metadata, so this schema does not pretend to have one.
 */
export const Config = z.object({
    profile: z.string().default('').description('DSH profile name; empty means $DSH_PROFILE, then desktop.'),
    profileDir: z.string().default('').description('Profile directory; empty derives it from the profile name.'),
    maxFileBytes: z.number().step(1).min(1024).default(16 * 1024 * 1024)
        .description('Files larger than this are listed but not copied into a coin.'),
    maxTotalBytes: z.number().step(1).min(1024).default(512 * 1024 * 1024)
        .description('Total copy budget for one coin.'),
    maxSessionFiles: z.number().step(1).min(1).max(5000).default(200)
        .description('How many session files to keep (most recently modified first).'),
    maxFiles: z.number().step(1).min(1).max(50000).default(5000)
        .description('Per-scan file cap.'),
    maxDepth: z.number().step(1).min(1).max(12).default(6)
        .description('Directory recursion depth.'),
});
export const name = 'dsh-revivecoin';
export const inject = ['tools'];
/** One section row in a coin summary. */
const SECTION_SCHEMA = {
    type: 'object',
    properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        fileCount: { type: 'integer' },
        copiedCount: { type: 'integer' },
        listedOnly: { type: 'integer' },
        bytes: { type: 'integer' },
    },
    additionalProperties: true,
};
const WARNINGS_SCHEMA = { type: 'array', items: { type: 'string' } };
function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024)
        return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function renderCreate(value) {
    const lines = [];
    lines.push(value.refreshed
        ? `今天的复活币已刷新：${value.coinId}`
        : `新复活币已生成：${value.coinId}`);
    lines.push(`位置：${value.path}`);
    lines.push(`文件：共 ${value.stats.fileCount} 个，已复制 ${value.stats.copiedCount} 个（${formatBytes(value.stats.copiedBytes)}），`
        + `只记清单 ${value.stats.listedOnly} 个。`);
    lines.push('');
    lines.push('清单摘要：');
    for (const section of value.sections) {
        const copied = section.copiedCount ?? 0;
        const listed = section.listedOnly ?? 0;
        const detail = listed > 0 ? `（复制 ${copied} / 只清单 ${listed}）` : '';
        lines.push(`- ${section.title}：${section.fileCount} 个${detail} · ${formatBytes(section.bytes)}`);
    }
    if (value.warnings.length > 0) {
        lines.push('');
        lines.push(`提醒（${value.warnings.length} 条）：`);
        for (const warning of value.warnings.slice(0, 8))
            lines.push(`- ${warning}`);
        if (value.warnings.length > 8)
            lines.push(`- ……还有 ${value.warnings.length - 8} 条，见 manifest.md`);
    }
    lines.push('');
    lines.push(`操作日志：${value.log}`);
    return [{ type: 'text', text: lines.join('\n') }];
}
function renderList(value) {
    if (value.total === 0) {
        return [{
                type: 'text',
                text: `还没有任何复活币。\n币目录：${value.root}\n先调用 coin_create 生成一枚。`,
            }];
    }
    const lines = [`共 ${value.total} 枚复活币（目录 ${value.root}）：`];
    for (const item of value.items) {
        if (item.broken) {
            lines.push(`- ${item.coinId}  ⚠ 读取失败：${item.error}`);
            continue;
        }
        const stats = item.stats ?? {};
        const size = stats.copiedBytes === undefined ? '' : ` · ${formatBytes(stats.copiedBytes)}`;
        const daily = item.daily ? '每日' : '手动';
        lines.push(`- ${item.coinId}  ${item.updatedAt ?? item.createdAt ?? ''}  [${daily}]  `
            + `${stats.copiedCount ?? '?'}/${stats.fileCount ?? '?'} 个文件${size}`
            + (item.warningCount ? ` · ${item.warningCount} 条提醒` : ''));
    }
    lines.push('');
    lines.push(`操作日志：${value.log}`);
    return [{ type: 'text', text: lines.join('\n') }];
}
function renderDiff(value) {
    const c = value.counts;
    const lines = [`复活币 ${value.coinId} 与当前环境的差异：`];
    lines.push(`未变 ${c.unchanged} · 有变化 ${c.changed} · 新增 ${c.added} · 已缺失 ${c.missing} · 未打包 ${c.notPackaged}`);
    if (c.changed > 0) {
        lines.push('');
        lines.push('有变化：');
        for (const item of value.changed) {
            const delta = item.deltaBytes >= 0 ? `+${item.deltaBytes}` : String(item.deltaBytes);
            lines.push(`- ${item.path}（${delta} B）`);
        }
        if (value.truncated.changed > 0)
            lines.push(`- ……还有 ${value.truncated.changed} 个`);
    }
    if (c.added > 0) {
        lines.push('');
        lines.push('当前有、币里没有：');
        for (const item of value.added)
            lines.push(`- ${item.path}（${formatBytes(item.size)}）`);
        if (value.truncated.added > 0)
            lines.push(`- ……还有 ${value.truncated.added} 个`);
    }
    if (c.missing > 0) {
        lines.push('');
        lines.push('币里有、当前已经不在：');
        for (const item of value.missing)
            lines.push(`- ${item.path}`);
        if (value.truncated.missing > 0)
            lines.push(`- ……还有 ${value.truncated.missing} 个`);
    }
    const inv = value.inventoryDiff;
    if (inv.pluginsAdded.length > 0 || inv.pluginsRemoved.length > 0 || inv.versionChanged.length > 0) {
        lines.push('');
        lines.push('插件清单变化：');
        for (const item of inv.versionChanged)
            lines.push(`- ${item.name}：${item.before ?? '未装'} → ${item.after ?? '未装'}`);
        for (const item of inv.pluginsAdded)
            lines.push(`- 新增 ${item.name} ${item.installed ?? ''}`);
        for (const item of inv.pluginsRemoved)
            lines.push(`- 移除 ${item.name} ${item.installed ?? ''}`);
    }
    if (value.warnings.length > 0) {
        lines.push('');
        lines.push(`提醒（${value.warnings.length} 条）：`);
        for (const warning of value.warnings.slice(0, 6))
            lines.push(`- ${warning}`);
    }
    lines.push('');
    lines.push('这次只做对比，没有修改任何文件。要还原则调用 coin_restore（会自动先备份现状）。');
    return [{ type: 'text', text: lines.join('\n') }];
}
function renderRestore(value) {
    const lines = [value.message];
    lines.push(`备份目录：${value.backupDir}`);
    lines.push(`报告：${value.reportPath}`);
    const created = value.restored.filter((item) => item.status === 'created').length;
    const overwritten = value.restored.filter((item) => item.status === 'overwritten').length;
    const identical = value.restored.filter((item) => item.status === 'identical').length;
    lines.push(`写回明细：新建 ${created} · 覆盖 ${overwritten} · 内容相同 ${identical}`);
    if (value.skippedCount > 0) {
        lines.push('');
        lines.push('跳过：');
        for (const item of value.skipped)
            lines.push(`- ${item.path} — ${item.reason}`);
    }
    if (value.versionReport.length > 0) {
        lines.push('');
        lines.push('版本差异（只报告）：');
        for (const line of value.versionReport)
            lines.push(`- ${line}`);
    }
    if (value.dependencyReport.missing.length > 0) {
        lines.push('');
        lines.push(`插件依赖缺失 ${value.dependencyReport.missing.length} 个，未自动安装：`);
        if (value.dependencyReport.installHint)
            lines.push(value.dependencyReport.installHint);
    }
    lines.push('');
    lines.push('下一步：重启 DSH 让配置与插件生效。');
    return [{ type: 'text', text: lines.join('\n') }];
}
export function apply(ctx, config = {}) {
    const tools = ctx.get('tools');
    if (!tools || typeof tools.register !== 'function') {
        throw new Error('[dsh-revivecoin] tools 服务不可用，无法注册复活币工具。');
    }
    ctx.logger?.info?.(`[dsh-revivecoin] coins: ${coinsDir()}`);
    ctx.logger?.info?.(`[dsh-revivecoin] log: ${logFile()}`);
    ctx.effect(() => tools.register({
        name: 'coin_create',
        description: '把一个会话的完整「我」打包成复活币：扫描会话记录与上下文、角色卡与预设、插件清单及版本、'
            + '插件数据（笔记本/日记/语音库清单/画/说说）、配置文件，复制到插件数据目录的 coins/<时间戳>/，'
            + '并写出 manifest.json（机器可读）与 manifest.md（人可读）。'
            + 'daily=true（默认）时一天只保留一枚：今天已有就刷新它，没有就新建；daily=false 时总是新建一枚。'
            + '给出 sessionId 时只收录这一个会话的记录。'
            + '只读取、不修改用户数据；超过单文件大小上限或总量预算的文件只记入清单不复制。返回币路径与清单摘要。',
        parameters: {
            type: 'object',
            properties: {
                sessionId: {
                    type: 'string',
                    description: '可选：只打包这个会话的会话记录（匹配会话目录或文件名里的 id）。省略则收录最近若干会话。',
                },
                daily: {
                    type: 'boolean',
                    description: '是否按「每日一枚」处理，默认 true：今天已有币就刷新它，没有才新建。',
                },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    coinId: { type: 'string' },
                    path: { type: 'string' },
                    refreshed: { type: 'boolean' },
                    createdAt: { type: 'string' },
                    updatedAt: { type: 'string' },
                    daily: { type: 'boolean' },
                    sessionId: { type: 'string' },
                    stats: {
                        type: 'object',
                        properties: {
                            fileCount: { type: 'integer' },
                            copiedCount: { type: 'integer' },
                            copiedBytes: { type: 'integer' },
                            listedOnly: { type: 'integer' },
                        },
                        additionalProperties: true,
                    },
                    sections: { type: 'array', items: SECTION_SCHEMA },
                    warnings: WARNINGS_SCHEMA,
                    log: { type: 'string' },
                },
                required: [
                    'ok', 'coinId', 'path', 'refreshed', 'createdAt', 'updatedAt',
                    'daily', 'sessionId', 'stats', 'sections', 'warnings', 'log',
                ],
                additionalProperties: false,
            },
            render: (_args, value) => renderCreate(value),
        },
        async execute(args = {}) {
            return createCoin(config, {
                sessionId: args.sessionId,
                daily: args.daily !== false,
            });
        },
    }), 'dsh-revivecoin: coin_create');
    ctx.effect(() => tools.register({
        name: 'coin_list',
        description: '列出所有历史复活币：币 id、生成/更新时间、是否每日币、文件数与体积、提醒条数。'
            + '读取失败的币也会列出来并给出可读原因，不会因为某一枚坏掉就报错。',
        parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    total: { type: 'integer' },
                    items: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    root: { type: 'string' },
                    log: { type: 'string' },
                },
                required: ['ok', 'total', 'items', 'root', 'log'],
                additionalProperties: false,
            },
            render: (_args, value) => renderList(value),
        },
        async execute() {
            return listCoins();
        },
    }), 'dsh-revivecoin: coin_list');
    ctx.effect(() => tools.register({
        name: 'coin_diff',
        description: '对比当前环境与某枚复活币的差异，只读：算出「有变化 / 当前新增 / 已缺失 / 未打包」的文件，'
            + '并比较插件清单与版本（新增、移除、版本变化）。coinId 从 coin_list 里拿。'
            + '这个工具不会修改任何文件；想看差异后再决定要不要 coin_restore。',
        parameters: {
            type: 'object',
            properties: {
                coinId: { type: 'string', description: '复活币 id，例如 20261021-031500。' },
            },
            required: ['coinId'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    coinId: { type: 'string' },
                    path: { type: 'string' },
                    createdAt: { type: 'string' },
                    counts: { type: 'object', additionalProperties: true },
                    changed: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    added: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    missing: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    notPackaged: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    inventoryDiff: { type: 'object', additionalProperties: true },
                    truncated: { type: 'object', additionalProperties: true },
                    warnings: WARNINGS_SCHEMA,
                    log: { type: 'string' },
                },
                required: [
                    'ok', 'coinId', 'path', 'createdAt', 'counts', 'changed', 'added',
                    'missing', 'notPackaged', 'inventoryDiff', 'truncated', 'warnings', 'log',
                ],
                additionalProperties: false,
            },
            render: (_args, value) => renderDiff(value),
        },
        async execute(args = {}) {
            return diffCoin(config, args.coinId);
        },
    }), 'dsh-revivecoin: coin_diff');
    ctx.effect(() => tools.register({
        name: 'coin_restore',
        description: '把一枚复活币还原到当前环境。流程固定：① 先把现存的同路径文件备份到 backups/<币id>-<时间>/；'
            + '② 报告版本差异（Node / 平台 / profile，只报告不改）；③ 把币里已复制的文件写回原路径（从不删除任何文件）；'
            + '④ 检查插件依赖缺失并在报告里给出补装提示（不自动安装）；⑤ 写 restore-report.md。'
            + '本次 DSH 运行期间还在被写的会话文件会跳过，避免写坏正在记录的当前会话。'
            + '必须显式传 confirm=true 才会真正写回；不传时直接报错、不写任何文件。还原后需要重启 DSH 才生效。',
        parameters: {
            type: 'object',
            properties: {
                coinId: { type: 'string', description: '要还原的复活币 id，例如 20261021-031500。' },
                confirm: {
                    type: 'boolean',
                    description: '必须显式传 true。确认会把币里的文件覆盖回原路径（还原前会自动备份现状）。',
                },
            },
            required: ['coinId', 'confirm'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    coinId: { type: 'string' },
                    backupDir: { type: 'string' },
                    reportPath: { type: 'string' },
                    restoredCount: { type: 'integer' },
                    skippedCount: { type: 'integer' },
                    restored: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    skipped: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    versionReport: { type: 'array', items: { type: 'string' } },
                    dependencyReport: { type: 'object', additionalProperties: true },
                    restartRequired: { type: 'boolean' },
                    message: { type: 'string' },
                    log: { type: 'string' },
                },
                required: [
                    'ok', 'coinId', 'backupDir', 'reportPath', 'restoredCount', 'skippedCount',
                    'restored', 'skipped', 'versionReport', 'dependencyReport', 'restartRequired',
                    'message', 'log',
                ],
                additionalProperties: false,
            },
            render: (_args, value) => renderRestore(value),
        },
        async execute(args = {}) {
            return restoreCoin(config, args.coinId, args.confirm === true);
        },
    }), 'dsh-revivecoin: coin_restore');
}
