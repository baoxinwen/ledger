import fs from 'fs';
import os from 'os';
import path from 'path';
import Database, { Database as DatabaseType } from 'better-sqlite3';
import { migrateDatabase, CURRENT_SCHEMA_VERSION, LEDGER_APPLICATION_ID } from '../../databaseSchema';
import {
  BackupService,
  selectAutomaticBackupsToKeep,
  shouldCreateAutomaticBackup,
} from '../../services/backup.service';

describe('BackupService', () => {
  let tempDir: string;
  let databasePath: string;
  let backupDir: string;
  let currentDb: DatabaseType;
  let maintenance = false;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-backup-'));
    databasePath = path.join(tempDir, 'ledger.db');
    backupDir = path.join(tempDir, 'backups');
    currentDb = openDatabase(databasePath);
    migrateDatabase(currentDb);
    currentDb.prepare("INSERT INTO app_settings (key, value) VALUES ('marker', 'original')").run();
    currentDb.prepare("INSERT INTO users (username, password_hash) VALUES ('admin', 'hash')").run();
    currentDb.prepare("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (1, 'token', '2999-01-01T00:00:00.000Z')").run();
  });

  afterEach(() => {
    if (currentDb.open) currentDb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createService(initializeDatabase = () => migrateDatabase(currentDb)): BackupService {
    return new BackupService({
      databasePath,
      backupDir,
      getDatabase: () => currentDb,
      closeDatabase: () => currentDb.close(),
      reopenDatabase: () => {
        if (currentDb.open) currentDb.close();
        currentDb = openDatabase(databasePath);
        return currentDb;
      },
      initializeDatabase,
      setMaintenance: (value) => { maintenance = value; },
      getTimeZone: () => 'Asia/Shanghai',
      now: () => new Date('2026-08-18T05:00:00.000Z'),
    });
  }

  function createServiceWithInstallFailure(): BackupService {
    return new BackupService({
      databasePath,
      backupDir,
      getDatabase: () => currentDb,
      closeDatabase: () => currentDb.close(),
      reopenDatabase: () => {
        if (currentDb.open) currentDb.close();
        currentDb = openDatabase(databasePath);
        return currentDb;
      },
      initializeDatabase: () => migrateDatabase(currentDb),
      installDatabase: () => { throw new Error('rename failed'); },
      setMaintenance: (value) => { maintenance = value; },
      getTimeZone: () => 'Asia/Shanghai',
      now: () => new Date('2026-08-18T05:00:00.000Z'),
    });
  }

  it('在线快照包含应用标识、格式版本、schema 版本、时间和类型', async () => {
    const service = createService();
    const backup = await service.createSnapshot('manual');

    expect(fs.existsSync(backup.path)).toBe(true);
    expect(backup).toMatchObject({
      type: 'manual',
      formatVersion: 1,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: '2026-08-18T05:00:00.000Z',
    });

    const snapshot = new Database(backup.path, { readonly: true });
    expect(Number(snapshot.pragma('application_id', { simple: true }))).toBe(LEDGER_APPLICATION_ID);
    expect(snapshot.prepare("SELECT value FROM app_settings WHERE key = 'marker'").pluck().get()).toBe('original');
    expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok');
    snapshot.close();
  });

  it('拒绝损坏、错误应用、缺少清单和更高 schema 版本的文件', async () => {
    const service = createService();
    const valid = await service.createSnapshot('manual');

    const damaged = path.join(tempDir, 'damaged.db');
    fs.writeFileSync(damaged, 'not sqlite');
    expect(() => service.validateBackup(damaged)).toThrow('SQLite');

    const bare = path.join(tempDir, 'bare.db');
    const bareDb = new Database(bare);
    migrateDatabase(bareDb);
    bareDb.close();
    expect(() => service.validateBackup(bare)).toThrow('备份清单');

    const wrong = path.join(tempDir, 'wrong.db');
    fs.copyFileSync(valid.path, wrong);
    const wrongDb = new Database(wrong);
    wrongDb.pragma('application_id = 123');
    wrongDb.close();
    expect(() => service.validateBackup(wrong)).toThrow('ledger');

    const future = path.join(tempDir, 'future.db');
    fs.copyFileSync(valid.path, future);
    const futureDb = new Database(future);
    futureDb.prepare('UPDATE ledger_backup_manifest SET schema_version = ?').run(CURRENT_SCHEMA_VERSION + 1);
    futureDb.close();
    expect(() => service.validateBackup(future)).toThrow('高于当前支持版本');
  });

  it('恢复快照后重新初始化数据库、清空会话并退出维护模式', async () => {
    const service = createService();
    const backup = await service.createSnapshot('manual');
    currentDb.prepare("UPDATE app_settings SET value = 'changed' WHERE key = 'marker'").run();

    await service.restoreFromFile(backup.path);

    expect(currentDb.prepare("SELECT value FROM app_settings WHERE key = 'marker'").pluck().get()).toBe('original');
    expect(currentDb.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(0);
    expect(maintenance).toBe(false);
    expect(service.listBackups().some((item) => item.type === 'pre_restore')).toBe(true);
  });

  it('恢复初始化失败时换回原库', async () => {
    let initializeCalls = 0;
    const service = createService(() => {
      initializeCalls += 1;
      if (initializeCalls === 1) throw new Error('init failed');
      migrateDatabase(currentDb);
    });
    const backup = await service.createSnapshot('manual');
    currentDb.prepare("UPDATE app_settings SET value = 'keep-me' WHERE key = 'marker'").run();

    await expect(service.restoreFromFile(backup.path)).rejects.toThrow('init failed');

    expect(currentDb.prepare("SELECT value FROM app_settings WHERE key = 'marker'").pluck().get()).toBe('keep-me');
    expect(maintenance).toBe(false);
  });

  it('安装新数据库文件失败时也换回原库', async () => {
    const service = createServiceWithInstallFailure();
    const backup = await service.createSnapshot('manual');
    currentDb.prepare("UPDATE app_settings SET value = 'keep-after-rename-error' WHERE key = 'marker'").run();

    await expect(service.restoreFromFile(backup.path)).rejects.toThrow('rename failed');

    expect(currentDb.open).toBe(true);
    expect(currentDb.prepare("SELECT value FROM app_settings WHERE key = 'marker'").pluck().get()).toBe('keep-after-rename-error');
    expect(maintenance).toBe(false);
  });

  it('pre_restore 快照按保留上限清理，反复恢复不无限累积', async () => {
    let tick = 0;
    let db = currentDb;
    // 每次恢复推进一分钟，保证 pre_restore 快照文件名/createdAt 唯一。
    const service = new BackupService({
      databasePath,
      backupDir,
      getDatabase: () => db,
      closeDatabase: () => db.close(),
      reopenDatabase: () => {
        if (db.open) db.close();
        db = openDatabase(databasePath);
        currentDb = db;
        return db;
      },
      initializeDatabase: () => migrateDatabase(db),
      setMaintenance: (value) => { maintenance = value; },
      getTimeZone: () => 'Asia/Shanghai',
      now: () => new Date(Date.parse('2026-08-18T05:00:00.000Z') + tick++ * 60_000),
    });

    const source = await service.createSnapshot('manual');
    for (let i = 0; i < 12; i++) {
      await service.restoreFromFile(source.path);
    }

    const remaining = service.listBackups({ deep: false }).filter((item) => item.type === 'pre_restore');
    expect(remaining).toHaveLength(10);
  });
});

describe('automatic backup scheduling and retention', () => {
  it('仅在业务时区 03:00 后且当天尚无自动快照时补做', () => {
    expect(shouldCreateAutomaticBackup(new Date('2026-08-17T18:59:00Z'), 'Asia/Shanghai', [])).toBe(false);
    expect(shouldCreateAutomaticBackup(new Date('2026-08-17T19:01:00Z'), 'Asia/Shanghai', [])).toBe(true);
    expect(shouldCreateAutomaticBackup(new Date('2026-08-18T08:00:00Z'), 'Asia/Shanghai', [
      { createdAt: '2026-08-17T20:00:00.000Z', type: 'automatic' },
    ])).toBe(false);
  });

  it('保留最近 7 个自动快照和最近 4 个自然周各自最新快照', () => {
    const backups = [
      '2026-08-18', '2026-08-17', '2026-08-16', '2026-08-15', '2026-08-14', '2026-08-13', '2026-08-12',
      '2026-08-10', '2026-08-03', '2026-07-27', '2026-07-20',
    ].map((date) => ({ id: date, createdAt: `${date}T04:00:00.000Z`, type: 'automatic' as const }));

    const kept = selectAutomaticBackupsToKeep(backups, new Date('2026-08-18T12:00:00Z'), 'UTC');

    expect(kept).toEqual(new Set([
      '2026-08-18', '2026-08-17', '2026-08-16', '2026-08-15', '2026-08-14', '2026-08-13', '2026-08-12',
      '2026-08-03', '2026-07-27',
    ]));
  });
});

function openDatabase(filename: string): DatabaseType {
  const database = new Database(filename);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  return database;
}
