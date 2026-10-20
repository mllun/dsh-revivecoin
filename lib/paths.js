/**
 * Path helpers for dsh-revivecoin.
 *
 * Everything the plugin owns lives under one data directory:
 *
 *   <DSH_HOME>/dsh-revivecoin/
 *     coins/<coinId>/          one revival coin (manifest + files/)
 *     backups/<stamp>/         snapshot taken right before a restore
 *     logs/revivecoin.log      human-readable operation log
 *
 * User data is never moved or deleted by these helpers; they only compute
 * paths and refuse writes into operating-system or DSH-installation paths.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
const DATA_DIR_NAME = 'dsh-revivecoin';
/** Absolute DSH home: `$DSH_HOME`, else `~/.dsh`. */
export function dshHome() {
    const raw = process.env.DSH_HOME;
    return raw && raw.trim() !== '' ? resolve(raw.trim()) : join(homedir(), '.dsh');
}
/** Absolute user home directory. */
export function homeDir() {
    return homedir();
}
/** Plugin data directory. */
export function dataDir() {
    return join(dshHome(), DATA_DIR_NAME);
}
/** Where every revival coin is stored. */
export function coinsDir() {
    return join(dataDir(), 'coins');
}
/** Where pre-restore snapshots are stored. */
export function backupsDir() {
    return join(dataDir(), 'backups');
}
/** Where the operation log is stored. */
export function logsDir() {
    return join(dataDir(), 'logs');
}
/** Absolute path of the operation log file. */
export function logFile() {
    return join(logsDir(), 'revivecoin.log');
}
/**
 * Machine-local settings that must not ship with the public package.
 *
 * A profile patch is a poor place for machine-specific paths: the bundle's own
 * `cordis.patch.yml` travels with the package, so anything written there is
 * published with it. Instead the plugin reads an optional
 * `<DSH_HOME>/dsh-revivecoin/config.json` and merges it under the patch config
 * (the patch wins on conflicts). That file is user data, never published.
 */
export function localConfigFile() {
    return join(dataDir(), 'config.json');
}
/** mkdir -p and return the directory. */
export function ensureDir(dir) {
    mkdirSync(dir, { recursive: true });
    return dir;
}
/** Normalize a path for comparison: resolve, unify separators, drop trailing one. */
function comparable(target) {
    let p = resolve(String(target)).replace(/[\\/]+/g, sep);
    while (p.length > 3 && p.endsWith(sep))
        p = p.slice(0, -1);
    return p.toLowerCase();
}
/** Directories this plugin must never write into. */
function forbiddenPrefixes() {
    const list = [];
    if (process.platform === 'win32') {
        const sysDrive = (process.env.SystemDrive || 'C:').toLowerCase();
        list.push(`${sysDrive}\\windows`, `${sysDrive}\\program files`, `${sysDrive}\\program files (x86)`, `${sysDrive}\\programdata`, `${sysDrive}\\$recycle.bin`, `${sysDrive}\\system volume information`);
        // A bare drive root is never a valid write target either.
        list.push(`${sysDrive}\\`);
    }
    else {
        list.push('/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/proc', '/sys', '/dev');
    }
    // The running DSH installation (executable + resources) is read-only for us.
    try {
        list.push(dirname(process.execPath));
    }
    catch {
        /* ignore: execPath is always available, but never fail a write over it */
    }
    return list;
}
/** True when `target` is the OS or the running DSH installation. */
export function isForbiddenPath(target) {
    const p = comparable(target);
    for (const prefix of forbiddenPrefixes()) {
        const pp = comparable(prefix);
        // A filesystem root only forbids itself, never everything below it.
        const isRoot = pp === sep || pp === '/' || /^[a-z]:\\$/.test(pp);
        if (p === pp)
            return true;
        if (!isRoot && p.startsWith(pp + sep))
            return true;
    }
    // Windows drive root such as "d:\".
    if (/^[a-z]:\\$/.test(p))
        return true;
    return false;
}
/** Throw a readable error when `target` may not be written. */
export function assertWritable(target) {
    if (typeof target !== 'string' || target.trim() === '') {
        throw new Error('写入目标为空，已取消这次写入。');
    }
    if (!isAbsolute(target)) {
        throw new Error(`写入目标必须是绝对路径：${target}`);
    }
    if (isForbiddenPath(target)) {
        throw new Error(`拒绝写入系统目录或 DSH 安装目录：${target}`);
    }
    return resolve(target);
}
/**
 * Map an absolute user path to a location inside a coin's `files/` tree.
 *
 * The mapping is readable (a human can browse a coin) and collision-free
 * within one scope:
 *   - inside DSH home  -> dsh-home/<relative>
 *   - inside user home -> home/<relative>
 *   - elsewhere        -> drive-c/<relative> (or abs/<relative> on POSIX)
 *
 * Restores never derive the original path from this mapping: `manifest.json`
 * records the absolute original path for every file.
 */
export function containerPathFor(absolutePath) {
    const abs = resolve(absolutePath);
    const lower = abs.toLowerCase();
    const dsh = dshHome();
    const home = homeDir();
    const dshLower = dsh.toLowerCase();
    if (lower === dshLower) {
        return { base: 'dsh-home', rel: '' };
    }
    if (lower.startsWith(dshLower + sep)) {
        return { base: 'dsh-home', rel: relativeTail(abs, dsh) };
    }
    const homeLower = home.toLowerCase();
    if (lower.startsWith(homeLower + sep)) {
        return { base: 'home', rel: relativeTail(abs, home) };
    }
    const drive = /^([a-zA-Z]):[\\/](.*)$/.exec(abs);
    if (drive) {
        return { base: `drive-${drive[1].toLowerCase()}`, rel: drive[2].replace(/[\\/]+/g, '/') };
    }
    return { base: 'abs', rel: abs.replace(/^[\\/]+/, '').replace(/[\\/]+/g, '/') };
}
/** Tail of `abs` below `root`, using forward slashes. */
function relativeTail(abs, root) {
    const tail = abs.slice(root.length);
    return tail.replace(/^[\\/]+/, '').replace(/[\\/]+/g, '/');
}
/** Absolute on-disk path of one container-relative file inside `coinDir`. */
export function coinFilePath(coinDir, sectionId, container) {
    return join(coinDir, 'files', sectionId, ...container.split('/').filter((part) => part !== ''));
}
/** True when `child` stays inside `parent` after resolution. */
export function isInside(child, parent) {
    const c = comparable(child);
    const p = comparable(parent);
    return c === p || c.startsWith(p + sep);
}
