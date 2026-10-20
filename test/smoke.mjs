/**
 * Smoke test for dsh-revivecoin.
 *
 * Builds a throwaway DSH environment in the OS temp directory and walks the
 * whole contract: create, list, diff, restore, plus the constraints that
 * matter most — a pre-restore backup, never deleting user data, and refusing
 * to restore without an explicit confirmation.
 *
 * Run: node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoin, diffCoin, listCoins, restoreCoin } from '../lib/coin.mjs';
import { coinsDir, logFile } from '../lib/paths.mjs';

const root = await mkdtemp(join(tmpdir(), 'rc-'));
const dshHome = join(root, 'dsh-home');
const profileDir = join(dshHome, 'profiles', 'testprofile');
const extraDir = join(root, 'extra');

async function put(file, content) {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content, 'utf8');
}

/** Backdate a file so it does not look like a session being written right now. */
async function backdate(file, hours = 2) {
  const when = new Date(Date.now() - hours * 3600 * 1000);
  await utimes(file, when, when);
}

try {
  // --- fixtures -----------------------------------------------------------
  const oldSessionA = join(dshHome, 'sessions', 'proj-a', 'session-aaaa', 'session.v4.jsonl.zstd');
  const oldSessionB = join(dshHome, 'sessions', 'proj-a', 'session-bbbb', 'session.v4.jsonl.zstd');
  const liveSession = join(dshHome, 'sessions', 'proj-a', 'session-live', 'session.v4.jsonl.zstd');
  await put(oldSessionA, 'session-a');
  await put(oldSessionB, 'session-b');
  await put(liveSession, 'session-live');
  await backdate(oldSessionA);
  await backdate(oldSessionB);
  await put(join(dshHome, 'skills', 'greet', 'SKILL.md'), '# greet\n');
  await put(join(dshHome, 'dsh-notebook', 'notes.md'), '2026-10-21 | test | hello\n');
  await put(join(dshHome, 'memos-plugin', 'data', 'memos.db'), randomBytes(256));
  await put(join(profileDir, 'package.json'), JSON.stringify({
    name: 'test-profile',
    version: '0.0.1',
    dependencies: { '@local/dsh-notebook': '1.0.0' },
  }, null, 2));
  await put(join(profileDir, 'cordis.patch.yml'), '- id: x\n  name: \'@local/dsh-notebook\'\n');
  await put(join(extraDir, 'role.md'), '# 角色卡\n');
  await put(join(extraDir, 'diary.jsonl'), '{"entry":1}\n');
  await put(join(extraDir, 'audio', 'song.mp3'), randomBytes(2048));
  await put(join(extraDir, 'data', 'big.bin'), randomBytes(4096));

  process.env.DSH_HOME = dshHome;

  const config = {
    profile: 'testprofile',
    profileDir,
    maxFileBytes: 1024,
    maxTotalBytes: 64 * 1024,
    extraPaths: [
      { section: 'persona', path: join(extraDir, 'role.md') },
      { section: 'pluginData', path: join(extraDir, 'diary.jsonl') },
      { section: 'pluginData', path: join(extraDir, 'audio'), mode: 'list' },
      { section: 'pluginData', path: join(extraDir, 'data') },
    ],
  };

  // --- create -------------------------------------------------------------
  const created = await createCoin(config, { daily: true });
  assert.equal(created.ok, true);
  assert.equal(created.refreshed, false);
  assert.match(created.coinId, /^\d{8}-\d{6}$/);
  assert.ok(existsSync(join(created.path, 'manifest.json')), 'manifest.json 应存在');
  assert.ok(existsSync(join(created.path, 'manifest.md')), 'manifest.md 应存在');
  assert.ok(created.stats.fileCount >= 8, `应有至少 8 个文件，实际 ${created.stats.fileCount}`);
  assert.ok(created.stats.copiedCount >= 7, '大部分文件应被复制');

  const manifest = JSON.parse(await readFile(join(created.path, 'manifest.json'), 'utf8'));
  const bigFile = manifest.files.find((file) => file.path.endsWith('big.bin'));
  assert.equal(bigFile.copied, false, '超过单文件上限的文件不应复制');
  assert.equal(bigFile.skipReason, 'too-large');
  const audioFile = manifest.files.find((file) => file.path.endsWith('song.mp3'));
  assert.equal(audioFile.copied, false, 'mode=list 的文件不应复制');
  assert.equal(audioFile.skipReason, 'list-only');
  const inventoryFile = manifest.files.find((file) => file.virtual === true);
  assert.ok(inventoryFile, '应有一份插件清单虚拟文件');
  assert.ok(manifest.inventory.plugins.length >= 1);
  assert.equal(manifest.inventory.plugins[0].installed, null, '测试 profile 里包未安装，版本应为 null');

  // daily refresh keeps one coin
  const refreshed = await createCoin(config, { daily: true });
  assert.equal(refreshed.coinId, created.coinId);
  assert.equal(refreshed.refreshed, true);
  let listed = await listCoins();
  assert.equal(listed.total, 1, 'daily 模式一天只应有一枚币');

  // daily=false creates another
  const second = await createCoin(config, { daily: false });
  assert.notEqual(second.coinId, created.coinId);
  listed = await listCoins();
  assert.equal(listed.total, 2);

  // --- session filter -----------------------------------------------------
  const scoped = await createCoin(config, { daily: false, sessionId: 'session-aaaa' });
  const scopedManifest = JSON.parse(await readFile(join(scoped.path, 'manifest.json'), 'utf8'));
  const sessionFiles = scopedManifest.files.filter((file) => file.section === 'sessions');
  assert.equal(sessionFiles.length, 1, 'sessionId 过滤后只应有一个会话文件');
  assert.ok(sessionFiles[0].path.includes('session-aaaa'));

  // --- diff: clean state --------------------------------------------------
  const clean = await diffCoin(config, created.coinId);
  assert.equal(clean.counts.changed, 0);
  assert.equal(clean.counts.added, 0, `干净状态下不应有新增，实际：${JSON.stringify(clean.added)}`);
  assert.equal(clean.counts.missing, 0);

  // --- mutate the environment --------------------------------------------
  const notesPath = join(dshHome, 'dsh-notebook', 'notes.md');
  const originalNotes = await readFile(notesPath, 'utf8');
  await put(notesPath, '被改过的内容\n');
  await put(join(dshHome, 'skills', 'greet', 'NEW.md'), '新文件\n');
  await unlink(join(dshHome, 'skills', 'greet', 'SKILL.md'));

  const dirty = await diffCoin(config, created.coinId);
  assert.equal(dirty.counts.changed, 1, `应有 1 个变化，实际 ${dirty.counts.changed}`);
  assert.equal(dirty.changed[0].path, notesPath);
  assert.equal(dirty.counts.added, 1, '应有 1 个新增');
  assert.equal(dirty.counts.missing, 1, '应有 1 个缺失');

  // --- restore refuses without confirmation -------------------------------
  await assert.rejects(
    () => restoreCoin(config, created.coinId, false),
    /confirm=true/,
    '没有 confirm=true 时必须拒绝还原',
  );

  // --- restore ------------------------------------------------------------
  const restored = await restoreCoin(config, created.coinId, true);
  const restorableCount = manifest.files.filter((file) => file.copied && !file.virtual).length;
  assert.equal(restored.restoredCount + restored.skippedCount, restorableCount);
  assert.ok(existsSync(restored.backupDir), '应有还原前备份目录');
  assert.ok(existsSync(join(restored.backupDir, 'backup-manifest.json')));
  assert.ok(existsSync(restored.reportPath), '应写出还原报告');

  const restoredPaths = restored.restored.map((item) => item.path);
  assert.ok(!restoredPaths.includes(liveSession), '活跃会话文件不应被写回');
  assert.ok(
    restored.skipped.some((item) => item.path === liveSession),
    '活跃会话应记入跳过并说明原因',
  );
  assert.ok(restoredPaths.includes(oldSessionA), '非活跃的旧会话应正常写回');

  assert.equal(await readFile(notesPath, 'utf8'), originalNotes, '笔记应被还原成币里的内容');
  assert.ok(existsSync(join(dshHome, 'skills', 'greet', 'SKILL.md')), '被删的文件应回来');
  assert.ok(
    existsSync(join(dshHome, 'skills', 'greet', 'NEW.md')),
    '还原不能删除用户后来新增的文件',
  );

  // the backup really holds the pre-restore content
  const backupNotes = await readFile(
    join(restored.backupDir, 'files', 'pluginData', 'dsh-home', 'dsh-notebook', 'notes.md'),
    'utf8',
  );
  assert.equal(backupNotes, '被改过的内容\n', '备份里应是还原前的内容');

  // --- diff after restore -------------------------------------------------
  const after = await diffCoin(config, created.coinId);
  assert.equal(after.counts.changed, 0);
  assert.equal(after.counts.missing, 0);
  assert.equal(after.counts.added, 1, '新增文件仍应存在（还原不删数据）');

  // --- log ----------------------------------------------------------------
  assert.ok(existsSync(logFile()), '应有可读日志');
  const logText = await readFile(logFile(), 'utf8');
  assert.match(logText, /coin_create/);
  assert.match(logText, /coin_restore/);

  // --- readable errors ----------------------------------------------------
  await assert.rejects(() => diffCoin(config, 'not-a-coin'), /格式不对/);
  await assert.rejects(() => diffCoin(config, '20200101-000000'), /manifest/);
  await assert.rejects(() => restoreCoin(config, created.coinId, undefined), /confirm=true/);

  console.log('smoke ok');
  console.log(`  coins: ${coinsDir()}`);
  console.log(`  files: ${created.stats.fileCount} (copied ${created.stats.copiedCount})`);
  console.log(`  log:   ${logFile()}`);
} finally {
  await rm(root, { recursive: true, force: true });
  delete process.env.DSH_HOME;
}
