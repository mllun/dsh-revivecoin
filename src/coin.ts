/**
 * Revival coins: create, list, diff and restore.
 *
 * A coin is one directory that can put this instance of the assistant back
 * together on a fresh machine or after a crash:
 *
 *   coins/<coinId>/
 *     manifest.json   machine-readable inventory (absolute paths + hashes)
 *     manifest.md     the same thing for a human
 *     files/<scope>/  the actual bytes, mirroring the original layout
 *
 * Rules this module enforces:
 *  - creating a coin only reads user data;
 *  - restoring never deletes anything: it backs the current state up first,
 *    then writes the coin's files back;
 *  - version mismatches are reported, never silently "fixed";
 *  - every step is written to the readable log.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assertWritable,
  backupsDir,
  coinFilePath,
  coinsDir,
  containerPathFor,
  dshHome,
  ensureDir,
} from './paths.js';
import { logInfo, logWarn, logPath } from './log.js';
import {
  buildInventory,
  normalizeConfig,
  readInstalledVersion,
  scanEnvironment,
} from './scan.js';

const MANIFEST_FORMAT = 1;
/** Readable report cap for lists inside tool results. */
const PREVIEW_ROWS = 20;

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** Local-time `YYYYMMDD-HHMMSS`, the coin id. */
export function stampId(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
    + `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

function dayKey(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

function isoNow() {
  return new Date().toISOString();
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** stat a file without throwing; null when absent or not a regular file. */
async function statFileQuiet(file) {
  try {
    const info = await stat(file);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

async function writeJson(file, value) {
  ensureDir(dirname(file));
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Coin ids present on disk, oldest first. */
async function listCoinIds() {
  try {
    const entries = await readdir(coinsDir(), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^\d{8}-\d{6}(-\d+)?$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Absolute directory of one coin, validated to stay under coins/. */
export function coinDirOf(coinId) {
  const id = String(coinId ?? '').trim();
  if (!/^\d{8}-\d{6}(-\d+)?$/.test(id)) {
    throw new Error(`币 id 格式不对：${id || '(空)'}。正确格式像 20261021-031500，可用 coin_list 查看。`);
  }
  return join(coinsDir(), id);
}

async function readManifest(coinDir, coinId) {
  const file = join(coinDir, 'manifest.json');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`复活币 ${coinId} 没有 manifest.json，可能未生成完整，请重新 coin_create。`);
    }
    throw new Error(`无法读取复活币 ${coinId} 的 manifest.json：${error.code ?? error.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error(`复活币 ${coinId} 的 manifest.json 不是合法 JSON，已停止操作。`);
  }
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.files)) {
    throw new Error(`复活币 ${coinId} 的 manifest.json 结构不完整，已停止操作。`);
  }
  return manifest;
}

/**
 * Create (or, in daily mode, refresh today's) revival coin.
 *
 * @param {object} rawConfig plugin config from cordis.patch.yml
 * @param {{ sessionId?: string, daily?: boolean }} [options]
 */
export async function createCoin(rawConfig = {}, options: any = {}) {
  const cfg = normalizeConfig(rawConfig);
  const daily = options.daily !== false;
  const sessionId = typeof options.sessionId === 'string' && options.sessionId.trim() !== ''
    ? options.sessionId.trim()
    : null;
  logInfo('coin_create', `开始生成复活币（daily=${daily}${sessionId ? `，session=${sessionId}` : ''}）`);

  const scan = await scanEnvironment(cfg, { sessionId: sessionId ?? undefined });
  const warnings = [...scan.warnings];

  const existing = await listCoinIds();
  let coinId;
  let refreshed = false;
  if (daily) {
    const today = dayKey(new Date());
    const todayIds = existing.filter((id) => id.startsWith(`${today}-`));
    if (todayIds.length > 0) {
      coinId = todayIds[todayIds.length - 1];
      refreshed = true;
    } else {
      coinId = stampId();
    }
  } else {
    coinId = stampId();
    let suffix = 2;
    while (existing.includes(coinId)) {
      coinId = `${stampId()}-${suffix}`;
      suffix += 1;
    }
  }

  const coinDir = join(coinsDir(), coinId);
  ensureDir(coinDir);
  if (refreshed) {
    // Only this coin's own copy is replaced; user data is untouched.
    await rm(join(coinDir, 'files'), { recursive: true, force: true });
    logInfo('coin_create', `今天的币 ${coinId} 已存在，按 daily 规则刷新内容。`);
  }

  const files = [];
  const seen = new Set();
  const sections = [];
  let copiedCount = 0;
  let copiedBytes = 0;
  let totalBudget = 0;

  for (const section of scan.sections) {
    let sectionCopied = 0;
    let sectionBytes = 0;
    const sectionFiles = [];
    for (const file of section.files) {
      const dedupeKey = `${section.id}:${file.path}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const container = file.virtual
        ? file.path
        : (() => {
          const mapped = containerPathFor(file.path);
          return mapped.rel === '' ? mapped.base : `${mapped.base}/${mapped.rel}`;
        })();

      let copied = false;
      let sha256 = null;
      let skipReason = null;

      if (file.virtual) {
        const target = coinFilePath(coinDir, section.id, container);
        ensureDir(dirname(target));
        await writeFile(target, `${file.content}\n`, 'utf8');
        sha256 = sha256Text(`${file.content}\n`);
        copied = true;
        copiedCount += 1;
        copiedBytes += file.size;
        sectionCopied += 1;
        sectionBytes += file.size;
      } else if (file.mode === 'list') {
        skipReason = 'list-only';
      } else if (file.size > cfg.maxFileBytes) {
        skipReason = 'too-large';
        warnings.push(`${file.path} 超过单文件上限（${cfg.maxFileBytes} 字节），只记入清单未复制。`);
      } else if (totalBudget + file.size > cfg.maxTotalBytes) {
        skipReason = 'budget';
        warnings.push(`${file.path} 超出本次币的总量预算，只记入清单未复制。`);
      } else {
        const target = coinFilePath(coinDir, section.id, container);
        try {
          ensureDir(dirname(target));
          await copyFile(file.path, target);
          sha256 = await sha256File(target);
          copied = true;
          totalBudget += file.size;
          copiedCount += 1;
          copiedBytes += file.size;
          sectionCopied += 1;
          sectionBytes += file.size;
        } catch (error) {
          skipReason = `copy-failed:${error.code ?? error.message}`;
          warnings.push(`复制失败 ${file.path}：${error.code ?? error.message}`);
        }
      }

      const entry = {
        section: section.id,
        path: file.path,
        container,
        size: file.size,
        mtimeMs: Math.round(file.mtimeMs),
        sha256,
        copied,
        virtual: Boolean(file.virtual),
        skipReason,
      };
      files.push(entry);
      sectionFiles.push(entry);
    }

    sections.push({
      id: section.id,
      title: section.title,
      roots: section.roots,
      missingRoots: section.missingRoots,
      fileCount: sectionFiles.length,
      copiedCount: sectionCopied,
      bytes: sectionBytes,
      listedOnly: sectionFiles.filter((entry) => !entry.copied).length,
    });
  }

  const manifest = {
    formatVersion: MANIFEST_FORMAT,
    coinId,
    createdAt: refreshed
      ? (await readPreviousCreatedAt(coinDir)) ?? isoNow()
      : isoNow(),
    updatedAt: isoNow(),
    daily,
    sessionId,
    plugin: { name: 'dsh-revivecoin', config: publicConfig(cfg) },
    environment: {
      dshHome: dshHome(),
      profile: cfg.profile,
      profileDir: cfg.profileDir,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      hostname: hostnameSafe(),
      cwd: process.cwd(),
    },
    inventory: scan.inventory,
    sections,
    files,
    stats: {
      fileCount: files.length,
      copiedCount,
      copiedBytes,
      listedOnly: files.length - copiedCount,
    },
    warnings: uniqueStrings(warnings),
  };
  await writeJson(join(coinDir, 'manifest.json'), manifest);
  await writeFile(join(coinDir, 'manifest.md'), renderManifestMarkdown(manifest), 'utf8');

  logInfo(
    'coin_create',
    `复活币 ${coinId} 完成：${copiedCount}/${files.length} 个文件已复制（${formatBytes(copiedBytes)}），`
    + `${manifest.warnings.length} 条提醒。`,
  );

  return {
    ok: true,
    coinId,
    path: coinDir,
    refreshed,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    daily,
    sessionId: sessionId ?? '',
    stats: manifest.stats,
    sections: sections.map((section) => ({
      id: section.id,
      title: section.title,
      fileCount: section.fileCount,
      copiedCount: section.copiedCount,
      bytes: section.bytes,
      listedOnly: section.listedOnly,
    })),
    warnings: manifest.warnings,
    log: logPath(),
  };
}

async function readPreviousCreatedAt(coinDir) {
  try {
    const raw = await readFile(join(coinDir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.createdAt === 'string' ? parsed.createdAt : null;
  } catch {
    return null;
  }
}

function hostnameSafe() {
  try {
    return hostname();
  } catch {
    return null;
  }
}

function publicConfig(cfg) {
  return {
    profile: cfg.profile,
    profileDir: cfg.profileDir,
    extraPaths: cfg.extraPaths,
    maxFileBytes: cfg.maxFileBytes,
    maxTotalBytes: cfg.maxTotalBytes,
    maxSessionFiles: cfg.maxSessionFiles,
  };
}

function uniqueStrings(list) {
  return [...new Set(list.filter((item) => typeof item === 'string' && item.trim() !== ''))];
}

/** Human-readable byte size. */
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function renderManifestMarkdown(manifest) {
  const lines = [];
  lines.push(`# 复活币 ${manifest.coinId}`, '');
  lines.push(`- 生成时间：${manifest.createdAt}`);
  lines.push(`- 最近更新：${manifest.updatedAt}`);
  lines.push(`- 每日更新模式：${manifest.daily ? '是' : '否'}`);
  if (manifest.sessionId) lines.push(`- 限定会话：${manifest.sessionId}`);
  lines.push(`- 环境：${manifest.environment.platform} / Node ${manifest.environment.node} / profile ${manifest.environment.profile}`);
  lines.push(`- 文件：共 ${manifest.stats.fileCount} 个，已复制 ${manifest.stats.copiedCount} 个（${formatBytes(manifest.stats.copiedBytes)}）`);
  lines.push('');
  lines.push('## 清单', '');
  lines.push('| 范围 | 文件数 | 已复制 | 体积 |', '| --- | ---: | ---: | ---: |');
  for (const section of manifest.sections) {
    lines.push(`| ${section.title}（${section.id}） | ${section.fileCount} | ${section.copiedCount} | ${formatBytes(section.bytes)} |`);
  }
  lines.push('');

  const listedOnly = manifest.files.filter((file) => !file.copied);
  if (listedOnly.length > 0) {
    lines.push('## 只记清单未复制的文件', '');
    for (const file of listedOnly.slice(0, 50)) {
      lines.push(`- \`${file.path}\` — ${file.skipReason ?? '未复制'}（${formatBytes(file.size)}）`);
    }
    if (listedOnly.length > 50) lines.push(`- ……其余 ${listedOnly.length - 50} 个见 manifest.json`);
    lines.push('');
  }

  lines.push('## 插件', '');
  lines.push(`- 声明安装：${manifest.inventory.counts.declared} 个，配置里出现：${manifest.inventory.counts.configured} 个，磁盘缺失：${manifest.inventory.counts.missingOnDisk} 个`);
  for (const plugin of manifest.inventory.plugins.slice(0, 60)) {
    lines.push(`  - ${plugin.name} ${plugin.installed ?? '（未安装）'}`);
  }
  lines.push('');

  if (manifest.warnings.length > 0) {
    lines.push('## 提醒', '');
    for (const warning of manifest.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  lines.push('## 怎么用', '');
  lines.push('- 看有哪些币：`coin_list`');
  lines.push('- 和现状比差异：`coin_diff`');
  lines.push('- 还原：`coin_restore`（会先把现状备份到 `backups/`）');
  lines.push('');
  return lines.join('\n');
}

/** Overview of every coin on disk. */
export async function listCoins() {
  const ids = await listCoinIds();
  const items = [];
  for (const coinId of ids) {
    const dir = join(coinsDir(), coinId);
    try {
      const manifest = await readManifest(dir, coinId);
      items.push({
        coinId,
        path: dir,
        createdAt: manifest.createdAt ?? null,
        updatedAt: manifest.updatedAt ?? null,
        daily: Boolean(manifest.daily),
        sessionId: manifest.sessionId ?? null,
        stats: manifest.stats ?? { fileCount: manifest.files.length },
        sections: Array.isArray(manifest.sections)
          ? manifest.sections.map((section) => ({ id: section.id, fileCount: section.fileCount }))
          : [],
        warningCount: Array.isArray(manifest.warnings) ? manifest.warnings.length : 0,
        broken: false,
      });
    } catch (error) {
      items.push({ coinId, path: dir, broken: true, error: error.message });
    }
  }
  return {
    ok: true,
    total: items.length,
    items,
    root: coinsDir(),
    log: logPath(),
  };
}

/**
 * Compare the live environment with one coin. Read-only.
 *
 * @param {object} rawConfig
 * @param {string} coinId
 */
export async function diffCoin(rawConfig = {}, coinId) {
  const cfg = normalizeConfig(rawConfig);
  const dir = coinDirOf(coinId);
  const manifest = await readManifest(dir, coinId);
  logInfo('coin_diff', `开始对比 ${coinId}`);
  const warnings = [];

  const scan = await scanEnvironment(cfg, { sessionId: manifest.sessionId ?? undefined });
  warnings.push(...scan.warnings);

  const currentByPath = new Map();
  for (const section of scan.sections) {
    for (const file of section.files) {
      if (file.virtual) continue;
      currentByPath.set(file.path, { ...file, section: section.id });
    }
  }

  const changed = [];
  const missing = [];
  const unchanged = [];
  const notPackaged = [];
  const knownPaths = new Set();

  for (const entry of manifest.files) {
    knownPaths.add(entry.path);
    if (entry.virtual) continue;
    if (!entry.copied) {
      notPackaged.push({ path: entry.path, reason: entry.skipReason ?? '未复制', size: entry.size });
      continue;
    }
    const live = currentByPath.get(entry.path);
    if (!live) {
      missing.push({ path: entry.path, section: entry.section, size: entry.size });
      continue;
    }
    let liveSha = null;
    try {
      liveSha = await sha256File(entry.path);
    } catch (error) {
      warnings.push(`无法计算 ${entry.path} 的校验值：${error.code ?? error.message}`);
    }
    if (liveSha !== null && entry.sha256 && liveSha !== entry.sha256) {
      changed.push({
        path: entry.path,
        section: entry.section,
        beforeBytes: entry.size,
        afterBytes: live.size,
        deltaBytes: live.size - entry.size,
      });
    } else {
      unchanged.push(entry.path);
    }
  }

  const added = [];
  for (const [path, live] of currentByPath) {
    if (!knownPaths.has(path)) {
      added.push({ path, section: live.section, size: live.size });
    }
  }

  const inventoryDiff = compareInventory(manifest.inventory, scan.inventory);

  logInfo(
    'coin_diff',
    `${coinId} 对比完成：新增 ${added.length}，变化 ${changed.length}，缺失 ${missing.length}，未打包 ${notPackaged.length}。`,
  );

  return {
    ok: true,
    coinId,
    path: dir,
    createdAt: manifest.createdAt ?? '',
    counts: {
      unchanged: unchanged.length,
      changed: changed.length,
      added: added.length,
      missing: missing.length,
      notPackaged: notPackaged.length,
    },
    changed: changed.slice(0, PREVIEW_ROWS),
    added: added.slice(0, PREVIEW_ROWS),
    missing: missing.slice(0, PREVIEW_ROWS),
    notPackaged: notPackaged.slice(0, PREVIEW_ROWS),
    inventoryDiff,
    truncated: {
      changed: Math.max(0, changed.length - PREVIEW_ROWS),
      added: Math.max(0, added.length - PREVIEW_ROWS),
      missing: Math.max(0, missing.length - PREVIEW_ROWS),
      notPackaged: Math.max(0, notPackaged.length - PREVIEW_ROWS),
    },
    warnings: uniqueStrings(warnings),
    log: logPath(),
  };
}

function compareInventory(before, after) {
  const result = { pluginsAdded: [], pluginsRemoved: [], versionChanged: [], same: 0 };
  const beforeMap = new Map((before?.plugins ?? []).map((entry) => [entry.name, entry.installed]));
  const afterMap = new Map((after?.plugins ?? []).map((entry) => [entry.name, entry.installed]));
  for (const [name, version] of afterMap) {
    if (!beforeMap.has(name)) {
      result.pluginsAdded.push({ name, installed: version });
    } else if (beforeMap.get(name) !== version) {
      result.versionChanged.push({ name, before: beforeMap.get(name), after: version });
    } else {
      result.same += 1;
    }
  }
  for (const [name, version] of beforeMap) {
    if (!afterMap.has(name)) result.pluginsRemoved.push({ name, installed: version });
  }
  return result;
}

/**
 * Restore one coin: back up the current state, then write the coin's files back.
 *
 * @param {object} rawConfig
 * @param {string} coinId
 * @param {boolean} confirm must be exactly `true`
 */
export async function restoreCoin(rawConfig = {}, coinId, confirm) {
  if (confirm !== true) {
    throw new Error('还原会写回文件，必须显式传 confirm=true 才会执行；不传时本工具只做检查，不写任何文件。');
  }
  const cfg = normalizeConfig(rawConfig);
  const dir = coinDirOf(coinId);
  const manifest = await readManifest(dir, coinId);
  logInfo('coin_restore', `开始还原 ${coinId}`);

  const restorable = manifest.files.filter((entry) => entry.copied && !entry.virtual);
  if (restorable.length === 0) {
    throw new Error(`复活币 ${coinId} 里没有可写回的文件，已取消还原。`);
  }

  // Any session file touched around this process's start may still be open for
  // appends; overwriting it would corrupt a live transcript.
  const processStartedAt = Date.now() - Math.round(process.uptime() * 1000);
  const activeSessionCutoff = processStartedAt - 60_000;

  // --- 1. back up the current state ---------------------------------------
  const backupDir = join(backupsDir(), `${coinId}-${stampId()}`);
  ensureDir(join(backupDir, 'files'));
  const backedUp = [];
  const backupFailed = [];
  for (const entry of restorable) {
    if (!existsSync(entry.path)) continue;
    const target = join(backupDir, 'files', entry.section, ...entry.container.split('/').filter(Boolean));
    try {
      ensureDir(dirname(target));
      await copyFile(entry.path, target);
      backedUp.push({ path: entry.path, section: entry.section, container: entry.container, size: entry.size });
    } catch (error) {
      backupFailed.push({ path: entry.path, error: error.code ?? error.message });
    }
  }
  if (backupFailed.length > 0) {
    logWarn('coin_restore', `备份有 ${backupFailed.length} 个文件失败，已停止还原。`);
    throw new Error(
      `还原前备份没做完（${backupFailed.length} 个文件复制失败），为了不丢现有数据已停止。`
      + `第一个失败：${backupFailed[0].path}（${backupFailed[0].error}）。备份目录：${backupDir}`,
    );
  }
  await writeJson(join(backupDir, 'backup-manifest.json'), {
    kind: 'pre-restore-backup',
    coinId,
    createdAt: isoNow(),
    files: backedUp,
  });
  logInfo('coin_restore', `现状已备份：${backedUp.length} 个文件 → ${backupDir}`);

  // --- 2. version report (report only, never block) ------------------------
  const versionReport = [];
  const env = manifest.environment ?? {};
  if (env.node && env.node !== process.version) {
    versionReport.push(`Node 版本不同：币里是 ${env.node}，当前是 ${process.version}。`);
  }
  if (env.platform && env.platform !== process.platform) {
    versionReport.push(`平台不同：币里是 ${env.platform}，当前是 ${process.platform}。`);
  }
  if (env.profile && env.profile !== cfg.profile) {
    versionReport.push(`profile 不同：币里是 ${env.profile}，当前是 ${cfg.profile}。`);
  }

  // --- 3. write the coin's files back -------------------------------------
  const restored = [];
  const skipped = [];
  for (const entry of restorable) {
    const source = coinFilePath(dir, entry.section, entry.container);
    if (!existsSync(source)) {
      skipped.push({ path: entry.path, reason: '币内文件缺失' });
      continue;
    }
    try {
      assertWritable(entry.path);
      const live = await statFileQuiet(entry.path);
      // A session file touched during this DSH run may still be open for appends.
      // Overwriting it would corrupt the live transcript, so skip and say why.
      if (entry.section === 'sessions' && live && live.mtimeMs >= activeSessionCutoff) {
        skipped.push({
          path: entry.path,
          reason: '当前 DSH 运行期间被改写过，可能是活跃会话，已跳过以免写坏正在记录的会话',
        });
        continue;
      }
      if (live) {
        let same = false;
        try {
          same = (await sha256File(entry.path)) === entry.sha256;
        } catch {
          same = false;
        }
        if (same) {
          restored.push({ path: entry.path, section: entry.section, size: entry.size, status: 'identical' });
          continue;
        }
        ensureDir(dirname(entry.path));
        await copyFile(source, entry.path);
        restored.push({ path: entry.path, section: entry.section, size: entry.size, status: 'overwritten' });
      } else {
        ensureDir(dirname(entry.path));
        await copyFile(source, entry.path);
        restored.push({ path: entry.path, section: entry.section, size: entry.size, status: 'created' });
      }
    } catch (error) {
      skipped.push({ path: entry.path, reason: error.message });
      logWarn('coin_restore', `写回失败 ${entry.path}：${error.message}`);
    }
  }

  // --- 4. dependency report (never auto-installs) -------------------------
  const dependencyReport = await offlineDependencyReport(manifest, cfg);
  if (dependencyReport.missing.length > 0) {
    logWarn('coin_restore', `插件依赖缺失 ${dependencyReport.missing.length} 个，已写入报告，未自动安装。`);
  }

  // --- 5. readable report -------------------------------------------------
  const reportPath = join(backupDir, 'restore-report.md');
  await writeFile(
    reportPath,
    renderRestoreReport({
      coinId,
      manifest,
      backupDir,
      restored,
      skipped,
      versionReport,
      dependencyReport,
      restoredAt: isoNow(),
    }),
    'utf8',
  );

  logInfo(
    'coin_restore',
    `还原完成：写回 ${restored.length} 个，跳过 ${skipped.length} 个，备份 ${backedUp.length} 个。`,
  );

  return {
    ok: skipped.length === 0,
    coinId,
    backupDir,
    reportPath,
    restoredCount: restored.length,
    skippedCount: skipped.length,
    restored: restored.slice(0, PREVIEW_ROWS),
    skipped: skipped.slice(0, PREVIEW_ROWS),
    versionReport: uniqueStrings(versionReport),
    dependencyReport,
    restartRequired: true,
    message: skipped.length === 0
      ? `已还原 ${restored.length} 个文件，重启 DSH 后生效。`
      : `写回 ${restored.length} 个，${skipped.length} 个跳过（见报告），重启 DSH 后生效。`,
    log: logPath(),
  };
}

async function offlineDependencyReport(manifest, cfg) {
  const declared = new Map();
  for (const plugin of manifest.inventory?.plugins ?? []) {
    declared.set(plugin.name, plugin.declared);
  }
  const missing = [];
  const versionMismatch = [];
  for (const [name, spec] of declared) {
    const installed = await readInstalledVersion(cfg.profileDir, name);
    if (installed === null) {
      missing.push({ name, declared: spec });
    } else if (manifest.inventory?.plugins?.some((entry) => entry.name === name && entry.installed && entry.installed !== installed)) {
      versionMismatch.push({ name, coinVersion: manifest.inventory.plugins.find((entry) => entry.name === name)?.installed, installed });
    }
  }
  const names = missing.map((entry) => entry.name);
  return {
    missing,
    versionMismatch,
    installHint: names.length > 0
      ? `用 DSH 的插件管理（设置页「插件」，或 plugin_manager install_bundle）补装：${names.join('、')}`
      : null,
    note: '插件依赖只报告、不自动安装：补装会改动 profile，请在确认后手动执行。',
  };
}

function renderRestoreReport(data) {
  const { coinId, manifest, backupDir, restored, skipped, versionReport, dependencyReport, restoredAt } = data;
  const lines = [];
  lines.push(`# 还原报告：${coinId}`, '');
  lines.push(`- 还原时间：${restoredAt}`);
  lines.push(`- 币生成时间：${manifest.createdAt ?? '未知'}`);
  lines.push(`- 备份目录：${backupDir}`);
  lines.push(`- 写回文件：${restored.length} 个`);
  lines.push(`- 跳过：${skipped.length} 个`);
  lines.push('');

  lines.push('## 写回的文件', '');
  if (restored.length === 0) {
    lines.push('（无）', '');
  } else {
    for (const item of restored) lines.push(`- \`${item.path}\``);
    lines.push('');
  }

  if (skipped.length > 0) {
    lines.push('## 跳过的文件', '');
    for (const item of skipped) lines.push(`- \`${item.path}\` — ${item.reason}`);
    lines.push('');
  }

  if (versionReport.length > 0) {
    lines.push('## 版本差异（只报告，未改动）', '');
    for (const line of versionReport) lines.push(`- ${line}`);
    lines.push('');
  }

  lines.push('## 插件依赖', '');
  lines.push(`- 缺失：${dependencyReport.missing.length} 个`);
  if (dependencyReport.missing.length > 0) {
    for (const item of dependencyReport.missing) lines.push(`  - ${item.name}（币里记录 ${item.declared}）`);
  }
  if (dependencyReport.versionMismatch.length > 0) {
    lines.push(`- 版本不同：${dependencyReport.versionMismatch.length} 个`);
    for (const item of dependencyReport.versionMismatch) {
      lines.push(`  - ${item.name}：币里 ${item.coinVersion ?? '?'}，当前 ${item.installed}`);
    }
  }
  if (dependencyReport.installHint) {
    lines.push('', dependencyReport.installHint);
  }
  lines.push('');

  lines.push('## 下一步', '');
  lines.push('1. 重启 DSH（宿主重启后插件与配置才生效）。');
  lines.push('2. 若上面有缺失依赖，按提示补装后再重启一次。');
  lines.push('3. 想回到还原前的状态：备份目录里的文件就是还原前的原样，可手工复制回去。');
  lines.push('');
  return lines.join('\n');
}
