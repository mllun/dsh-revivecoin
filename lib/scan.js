/**
 * Environment scanning for dsh-revivecoin.
 *
 * One scan answers: "what makes up this instance of me, and where does it
 * live?" The five scopes are fixed by the coin contract:
 *
 *   sessions     会话记录与上下文   `<DSH_HOME>/sessions/**`
 *   persona      角色卡与预设       `<DSH_HOME>/skills/**` + configured paths
 *   plugins      插件清单及版本     generated inventory (virtual file)
 *   pluginData   插件数据           notebook / memory / configured paths
 *   config       配置文件           profile package.json, patches, extra files
 *
 * A scan only reads: it enumerates regular files and records size and mtime.
 * Hashing and copying happen in coin.mjs so `coin_diff` can hash the live
 * environment without writing anything.
 */
import { readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { dshHome, localConfigFile } from './paths.js';
/** Directories whose contents are noise for a revival coin. */
const EXCLUDED_DIRS = new Set([
    'node_modules',
    '.git',
    '.cache',
    '.pnpm-store',
    '.venv',
    '__pycache__',
    'dist',
    'build',
    '.next',
]);
/** The five scopes, in the order a coin lists them. */
export const SECTIONS = [
    { id: 'sessions', title: '会话记录与上下文' },
    { id: 'persona', title: '角色卡与预设' },
    { id: 'plugins', title: '插件清单及版本' },
    { id: 'pluginData', title: '插件数据（笔记本/日记/语音库/画/说说）' },
    { id: 'config', title: '配置文件' },
];
const SECTION_IDS = new Set(SECTIONS.map((section) => section.id));
/** Files that carry configuration in a DSH profile. */
const PROFILE_CONFIG_FILES = [
    'package.json',
    'cordis.patch.yml',
    'cordis.yml',
    'compatibility.json',
    'pnpm-workspace.yaml',
    '.npmrc',
];
function clampNumber(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}
/**
 * Read the optional machine-local `config.json`.
 *
 * Machine-specific paths (role cards, a voice library, a drawing folder) make
 * a coin useful, but they do not belong in a published package. Keeping them in
 * user data lets the shipped patch stay generic while this machine still
 * collects everything.
 */
function readLocalConfig(onWarning) {
    const file = localConfigFile();
    let text;
    try {
        text = readFileSync(file, 'utf8');
    }
    catch (error) {
        if (error && error.code !== 'ENOENT')
            onWarning(`本机配置 ${file} 读取失败：${error.code ?? error.message}`);
        return {};
    }
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            onWarning(`本机配置 ${file} 不是 JSON 对象，已忽略。`);
            return {};
        }
        return parsed;
    }
    catch {
        onWarning(`本机配置 ${file} 不是合法 JSON，已忽略。`);
        return {};
    }
}
/**
 * Validate and fill the plugin config from `cordis.patch.yml`.
 *
 * Precedence: `<DSH_HOME>/dsh-revivecoin/config.json` first, then the patch
 * config on top — so a user can override anything the local file sets.
 *
 * @returns {{
 *   profile: string, profileDir: string,
 *   maxFileBytes: number, maxTotalBytes: number, maxSessionFiles: number,
 *   maxFiles: number, maxDepth: number,
 *   extraPaths: Array<{ section: string, path: string, mode: 'copy'|'list' }>,
 *   warnings: string[],
 * }}
 */
export function normalizeConfig(raw = {}) {
    const warnings = [];
    const localCfg = readLocalConfig((message) => warnings.push(message));
    const patchCfg = raw && typeof raw === 'object' ? raw : {};
    const cfg = { ...localCfg, ...patchCfg };
    const home = dshHome();
    const profile = typeof cfg.profile === 'string' && cfg.profile.trim() !== ''
        ? cfg.profile.trim()
        : (process.env.DSH_PROFILE && process.env.DSH_PROFILE.trim() !== '' ? process.env.DSH_PROFILE.trim() : 'desktop');
    const profileDir = typeof cfg.profileDir === 'string' && cfg.profileDir.trim() !== ''
        ? cfg.profileDir.trim()
        : join(home, 'profiles', profile);
    const extraPaths = [];
    if (cfg.extraPaths !== undefined && !Array.isArray(cfg.extraPaths)) {
        warnings.push('配置 extraPaths 必须是数组，已忽略。');
    }
    for (const entry of Array.isArray(cfg.extraPaths) ? cfg.extraPaths : []) {
        if (!entry || typeof entry !== 'object') {
            warnings.push('extraPaths 里有一项不是对象，已忽略。');
            continue;
        }
        const section = typeof entry.section === 'string' ? entry.section.trim() : '';
        const path = typeof entry.path === 'string' ? entry.path.trim() : '';
        if (!SECTION_IDS.has(section)) {
            warnings.push(`extraPaths 里有未知的 section「${section}」，已忽略（可用：${[...SECTION_IDS].join(' / ')}）。`);
            continue;
        }
        if (path === '') {
            warnings.push('extraPaths 里有一项没有 path，已忽略。');
            continue;
        }
        extraPaths.push({
            section,
            path,
            mode: entry.mode === 'list' ? 'list' : 'copy',
        });
    }
    return {
        profile,
        profileDir,
        maxFileBytes: clampNumber(cfg.maxFileBytes, 16 * 1024 * 1024, 1024, 2 * 1024 * 1024 * 1024),
        maxTotalBytes: clampNumber(cfg.maxTotalBytes, 512 * 1024 * 1024, 1024, 8 * 1024 * 1024 * 1024),
        maxSessionFiles: clampNumber(cfg.maxSessionFiles, 200, 1, 5000),
        maxFiles: clampNumber(cfg.maxFiles, 5000, 1, 50000),
        maxDepth: clampNumber(cfg.maxDepth, 6, 1, 12),
        extraPaths,
        warnings,
    };
}
/**
 * Walk one directory tree and return regular files.
 *
 * Symlinks are skipped: a coin must never copy something that points outside
 * the scanned tree.
 */
async function walkFiles(root, options) {
    const files = [];
    const limit = options.maxFiles ?? 5000;
    async function visit(dir, depth) {
        if (files.length >= limit || depth > options.maxDepth)
            return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch (error) {
            options.warnings?.push(`无法读取目录 ${dir}：${error.code ?? error.message}`);
            return;
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            if (files.length >= limit)
                return;
            if (entry.isSymbolicLink())
                continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (EXCLUDED_DIRS.has(entry.name))
                    continue;
                await visit(full, depth + 1);
                continue;
            }
            if (!entry.isFile())
                continue;
            if (options.filter && !options.filter(full, entry.name))
                continue;
            try {
                const info = await stat(full);
                files.push({ path: full, size: info.size, mtimeMs: info.mtimeMs });
            }
            catch (error) {
                options.warnings?.push(`无法读取文件信息 ${full}：${error.code ?? error.message}`);
            }
        }
    }
    await visit(root, 0);
    return files;
}
async function statFile(file, warnings) {
    try {
        const info = await stat(file);
        if (!info.isFile())
            return null;
        return { path: file, size: info.size, mtimeMs: info.mtimeMs };
    }
    catch (error) {
        if (error && error.code !== 'ENOENT') {
            warnings?.push(`无法读取 ${file}：${error.code ?? error.message}`);
        }
        return null;
    }
}
/**
 * Collect files from one configured root, accepting either a directory or a
 * single file. A configured path may name one file (a role card, a config, a
 * diary log), so a plain readdir would silently drop it.
 */
async function collectRoot(root, options) {
    let info;
    try {
        info = await stat(root);
    }
    catch (error) {
        if (error && error.code !== 'ENOENT') {
            options.warnings?.push(`无法读取 ${root}：${error.code ?? error.message}`);
        }
        return { files: [], missing: true };
    }
    if (info.isFile()) {
        if (options.filter && !options.filter(root, basename(root)))
            return { files: [], missing: false };
        return { files: [{ path: root, size: info.size, mtimeMs: info.mtimeMs }], missing: false };
    }
    if (!info.isDirectory())
        return { files: [], missing: true };
    return { files: await walkFiles(root, options), missing: false };
}
/** Read an installed package version from the profile's node_modules. */
export async function readInstalledVersion(profileDir, name) {
    try {
        const raw = await readFile(join(profileDir, 'node_modules', name, 'package.json'), 'utf8');
        const parsed = JSON.parse(raw);
        return typeof parsed.version === 'string' ? parsed.version : null;
    }
    catch {
        return null;
    }
}
/** Pull every `name:` row out of a cordis patch so the inventory shows enabled packages. */
async function readConfiguredPackages(patchFile, warnings) {
    let text;
    try {
        text = await readFile(patchFile, 'utf8');
    }
    catch (error) {
        if (error && error.code !== 'ENOENT')
            warnings?.push(`无法读取 ${patchFile}：${error.code ?? error.message}`);
        return [];
    }
    const found = new Set();
    const pattern = /^\s*-?\s*name:\s*['"]?([^'"\s#]+)['"]?/gm;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        if (match[1])
            found.add(match[1]);
    }
    return [...found].sort();
}
/**
 * Build the plugin inventory that a coin stores as `plugin-inventory.json`.
 *
 * This is a virtual file: it is generated from the live profile rather than
 * copied from it, which is exactly what makes `coin_diff` able to report
 * "plugins changed since this coin was made".
 */
export async function buildInventory(config) {
    const warnings = [];
    const pkgFile = join(config.profileDir, 'package.json');
    const patchFile = join(config.profileDir, 'cordis.patch.yml');
    let pkg = null;
    try {
        pkg = JSON.parse(await readFile(pkgFile, 'utf8'));
    }
    catch (error) {
        if (error && error.code !== 'ENOENT')
            warnings.push(`无法解析 ${pkgFile}：${error.code ?? error.message}`);
    }
    const declared = {
        ...(pkg && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}),
        ...(pkg && typeof pkg.devDependencies === 'object' ? pkg.devDependencies : {}),
    };
    const plugins = [];
    for (const name of Object.keys(declared).sort()) {
        plugins.push({
            name,
            declared: String(declared[name]),
            installed: await readInstalledVersion(config.profileDir, name),
        });
    }
    const configuredPackages = await readConfiguredPackages(patchFile, warnings);
    const missing = plugins.filter((entry) => entry.installed === null).map((entry) => entry.name);
    return {
        inventory: {
            formatVersion: 1,
            generatedAt: new Date().toISOString(),
            profile: {
                name: config.profile,
                dir: config.profileDir,
                packageName: pkg && typeof pkg.name === 'string' ? pkg.name : null,
                packageVersion: pkg && typeof pkg.version === 'string' ? pkg.version : null,
            },
            plugins,
            configuredPackages,
            missingOnDisk: missing,
            counts: {
                declared: plugins.length,
                configured: configuredPackages.length,
                missingOnDisk: missing.length,
            },
        },
        warnings,
    };
}
/**
 * Enumerate everything one coin covers.
 *
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {{ sessionId?: string }} [options]
 * @returns {Promise<{
 *   sections: Array<{ id: string, title: string, roots: string[],
 *     files: Array<{ path: string, size: number, mtimeMs: number, virtual?: boolean, content?: string, mode?: 'copy'|'list' }>,
 *     missingRoots: string[] }>,
 *   inventory: object, warnings: string[],
 * }>}
 */
export async function scanEnvironment(config, options = {}) {
    const warnings = [...(config.warnings ?? [])];
    const home = dshHome();
    const wanted = typeof options.sessionId === 'string' ? options.sessionId.trim().toLowerCase() : '';
    const sectionFiles = new Map();
    const sectionRoots = new Map();
    const sectionMissing = new Map();
    for (const section of SECTIONS) {
        sectionFiles.set(section.id, []);
        sectionRoots.set(section.id, []);
        sectionMissing.set(section.id, []);
    }
    const pushRoot = (sectionId, root) => {
        if (!sectionRoots.get(sectionId).includes(root))
            sectionRoots.get(sectionId).push(root);
    };
    // --- sessions -----------------------------------------------------------
    {
        const root = join(home, 'sessions');
        pushRoot('sessions', root);
        const found = await walkFiles(root, {
            maxDepth: 6,
            maxFiles: config.maxFiles,
            warnings,
            filter: (full) => /\.(zstd|jsonl|json)$/i.test(full),
        });
        let picked = found;
        if (wanted !== '') {
            picked = found.filter((file) => file.path.toLowerCase().includes(wanted));
        }
        picked = picked
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .slice(0, config.maxSessionFiles)
            .sort((a, b) => (a.path < b.path ? -1 : 1));
        sectionFiles.get('sessions').push(...picked);
        if (found.length > picked.length) {
            warnings.push(`sessions 只收录了最近 ${picked.length} 个文件（共 ${found.length} 个）。`);
        }
    }
    // --- persona ------------------------------------------------------------
    {
        const roots = [join(home, 'skills')];
        for (const extra of config.extraPaths) {
            if (extra.section === 'persona')
                roots.push(extra.path);
        }
        for (const root of roots) {
            pushRoot('persona', root);
            const collected = await collectRoot(root, {
                maxDepth: config.maxDepth,
                maxFiles: config.maxFiles,
                warnings,
                filter: (full) => /\.(md|markdown|txt|json|ya?ml|png|svg|jpe?g|webp)$/i.test(full),
            });
            if (collected.missing)
                sectionMissing.get('persona').push(root);
            sectionFiles.get('persona').push(...collected.files.map((file) => ({ ...file, mode: 'copy' })));
        }
    }
    // --- pluginData ---------------------------------------------------------
    {
        const roots = [
            join(home, 'dsh-notebook'),
            join(home, 'memos-plugin'),
            join(home, 'whale-audio'),
        ];
        const modes = new Map(roots.map((root) => [root, 'copy']));
        for (const extra of config.extraPaths) {
            if (extra.section !== 'pluginData')
                continue;
            roots.push(extra.path);
            modes.set(extra.path, extra.mode);
        }
        for (const root of roots) {
            pushRoot('pluginData', root);
            const collected = await collectRoot(root, {
                maxDepth: config.maxDepth,
                maxFiles: config.maxFiles,
                warnings,
            });
            if (collected.missing)
                sectionMissing.get('pluginData').push(root);
            sectionFiles.get('pluginData').push(...collected.files.map((file) => ({ ...file, mode: modes.get(root) ?? 'copy' })));
        }
    }
    // --- config -------------------------------------------------------------
    {
        const roots = [];
        const explicit = new Set();
        for (const name of PROFILE_CONFIG_FILES)
            roots.push(join(config.profileDir, name));
        for (const extra of config.extraPaths) {
            if (extra.section === 'config') {
                roots.push(extra.path);
                explicit.add(extra.path);
            }
        }
        for (const root of roots) {
            pushRoot('config', root);
            const info = await statFile(root, warnings);
            if (info === null) {
                // A profile file that is absent is normal; a path the user named is worth reporting.
                if (explicit.has(root))
                    sectionMissing.get('config').push(root);
            }
            else {
                sectionFiles.get('config').push({ ...info, mode: 'copy' });
            }
        }
    }
    // --- plugins (virtual) --------------------------------------------------
    const { inventory, warnings: inventoryWarnings } = await buildInventory(config);
    warnings.push(...inventoryWarnings);
    const inventoryText = JSON.stringify(inventory, null, 2);
    sectionFiles.get('plugins').push({
        path: 'plugin-inventory.json',
        size: Buffer.byteLength(inventoryText, 'utf8'),
        mtimeMs: Date.now(),
        virtual: true,
        content: inventoryText,
        mode: 'copy',
    });
    const sections = SECTIONS.map((section) => {
        const files = sectionFiles.get(section.id);
        return {
            id: section.id,
            title: section.title,
            roots: sectionRoots.get(section.id),
            files,
            missingRoots: sectionMissing.get(section.id),
            fileCount: files.length,
            bytes: files.reduce((sum, file) => sum + file.size, 0),
        };
    });
    return { sections, inventory, warnings };
}
