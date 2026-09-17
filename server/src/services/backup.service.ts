import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database, { Database as DatabaseType } from 'better-sqlite3';
import {
  closeDatabase,
  dbPath,
  getDatabase,
  initDatabase,
  reopenDatabase,
} from '../database';
import { CURRENT_SCHEMA_VERSION, LEDGER_APPLICATION_ID } from '../databaseSchema';
import { setMaintenanceMode } from '../maintenance';
import { settingsService } from './settings.service';
import { logger } from '../utils/logger';

export const BACKUP_FORMAT_VERSION = 1;
export const DEFAULT_BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');
// pre_restore 快照保留上限：超出后从最旧开始清理（见 cleanupPreRestoreBackups）。
const MAX_PRE_RESTORE_BACKUPS = 10;

export type BackupType = 'manual' | 'automatic' | 'pre_restore';

export interface BackupRecord {
  id: string;
  path: string;
  type: BackupType;
  formatVersion: number;
  schemaVersion: number;
  createdAt: string;
  size: number;
}

interface BackupCandidate {
  id?: string;
  createdAt: string;
  type: BackupType;
}

interface BackupDependencies {
  databasePath: string;
  backupDir: string;
  getDatabase: () => DatabaseType;
  closeDatabase: () => void;
  reopenDatabase: () => DatabaseType;
  initializeDatabase: () => void;
  installDatabase: (source: string, destination: string) => void;
  setMaintenance: (value: boolean) => void;
  getTimeZone: () => string;
  now: () => Date;
}

const defaultDependencies: BackupDependencies = {
  databasePath: dbPath,
  backupDir: process.env.LEDGER_BACKUP_DIR
    ? path.resolve(process.env.LEDGER_BACKUP_DIR)
    : DEFAULT_BACKUP_DIR,
  getDatabase,
  closeDatabase,
  reopenDatabase,
  initializeDatabase: initDatabase,
  installDatabase: (source, destination) => fs.renameSync(source, destination),
  setMaintenance: setMaintenanceMode,
  getTimeZone: () => settingsService.getSettings().time_zone,
  now: () => new Date(),
};

export class BackupService {
  private readonly dependencies: BackupDependencies;
  private automaticBackupRunning = false;
  private scheduler?: NodeJS.Timeout;

  constructor(dependencies: Partial<BackupDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  async createSnapshot(type: BackupType = 'manual'): Promise<BackupRecord> {
    this.ensureBackupDirectory();
    const createdAt = this.dependencies.now().toISOString();
    const id = buildBackupFilename(type, createdAt);
    const destination = path.join(this.dependencies.backupDir, id);

    await this.dependencies.getDatabase().backup(destination);
    try {
      const snapshot = new Database(destination);
      try {
        snapshot.pragma('journal_mode = DELETE');
        snapshot.exec(`
          CREATE TABLE IF NOT EXISTS ledger_backup_manifest (
            application_id INTEGER NOT NULL,
            format_version INTEGER NOT NULL,
            schema_version INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            backup_type TEXT NOT NULL CHECK(backup_type IN ('manual', 'automatic', 'pre_restore'))
          )
        `);
        snapshot.prepare('DELETE FROM ledger_backup_manifest').run();
        snapshot.prepare(`
          INSERT INTO ledger_backup_manifest (
            application_id, format_version, schema_version, created_at, backup_type
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          LEDGER_APPLICATION_ID,
          BACKUP_FORMAT_VERSION,
          Number(snapshot.pragma('user_version', { simple: true })),
          createdAt,
          type
        );
      } finally {
        snapshot.close();
      }
      return this.validateBackup(destination);
    } catch (error) {
      removeIfExists(destination);
      throw error;
    }
  }

  validateBackup(filename: string, options: { deep?: boolean } = {}): BackupRecord {
    const resolved = path.resolve(filename);
    let snapshot: DatabaseType | undefined;
    try {
      snapshot = new Database(resolved, { readonly: true, fileMustExist: true });
      // deep=false 跳过全库完整性扫描：调度器每分钟都要列一次备份，大快照上全量校验代价过高。
      // 下载/恢复等用户触发路径保持默认 deep=true，仍做完整校验。
      if (options.deep !== false) {
        const integrity = String(snapshot.pragma('integrity_check', { simple: true }));
        if (integrity !== 'ok') throw new Error(`完整性校验失败: ${integrity}`);
      }

      // WAL 模式的主文件单独拷贝时（缺 -wal/-shm），已提交在 WAL 里的数据会静默丢失且
      // 完整性校验照样通过。应用自身备份收尾是 DELETE 模式，检测到 WAL 即明确拒绝，
      // 提示用户改用应用内"创建备份"导出完整快照。
      const journalMode = String(snapshot.pragma('journal_mode', { simple: true })).toLowerCase();
      if (journalMode === 'wal') {
        throw new Error('该文件是 WAL 模式的数据库主文件，单独恢复会丢失 -wal 中已提交的数据；请在应用内创建完整备份后恢复');
      }

      const applicationId = Number(snapshot.pragma('application_id', { simple: true }));
      if (applicationId !== LEDGER_APPLICATION_ID) throw new Error('备份文件不属于 ledger 应用');

      const hasManifest = snapshot.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_backup_manifest'
      `).get();
      if (!hasManifest) throw new Error('文件缺少 ledger 备份清单');

      const manifest = snapshot.prepare(`
        SELECT application_id, format_version, schema_version, created_at, backup_type
        FROM ledger_backup_manifest
        LIMIT 1
      `).get() as {
        application_id: number;
        format_version: number;
        schema_version: number;
        created_at: string;
        backup_type: BackupType;
      } | undefined;
      if (!manifest) throw new Error('文件缺少 ledger 备份清单');
      if (manifest.application_id !== LEDGER_APPLICATION_ID) throw new Error('备份清单不属于 ledger 应用');
      if (manifest.format_version !== BACKUP_FORMAT_VERSION) {
        throw new Error(`不支持的备份格式版本 ${manifest.format_version}`);
      }
      if (manifest.schema_version > CURRENT_SCHEMA_VERSION) {
        throw new Error(`备份 schema 版本 ${manifest.schema_version} 高于当前支持版本 ${CURRENT_SCHEMA_VERSION}`);
      }
      if (!isBackupType(manifest.backup_type) || !isIsoDate(manifest.created_at)) {
        throw new Error('ledger 备份清单无效');
      }
      const pragmaVersion = Number(snapshot.pragma('user_version', { simple: true }));
      if (pragmaVersion !== manifest.schema_version) throw new Error('备份清单与数据库 schema 版本不一致');

      return {
        id: path.basename(resolved),
        path: resolved,
        type: manifest.backup_type,
        formatVersion: manifest.format_version,
        schemaVersion: manifest.schema_version,
        createdAt: manifest.created_at,
        size: fs.statSync(resolved).size,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('ledger') || message.includes('备份') || message.includes('schema') || message.includes('完整性')) {
        throw error;
      }
      throw new Error(`SQLite 备份文件损坏或不可读: ${message}`);
    } finally {
      if (snapshot?.open) snapshot.close();
    }
  }

  listBackups(options: { deep?: boolean } = {}): BackupRecord[] {
    this.ensureBackupDirectory();
    const records: BackupRecord[] = [];
    for (const entry of fs.readdirSync(this.dependencies.backupDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.db')) continue;
      try {
        records.push(this.validateBackup(path.join(this.dependencies.backupDir, entry.name), options));
      } catch {
        // 目录中的临时或损坏文件不作为可恢复快照暴露。
      }
    }
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getBackupPath(id: string): string {
    const backupPath = this.resolveManagedBackup(id);
    this.validateBackup(backupPath);
    return backupPath;
  }

  deleteBackup(id: string): void {
    const backupPath = this.resolveManagedBackup(id);
    if (!fs.existsSync(backupPath)) throw new Error('备份不存在');
    fs.unlinkSync(backupPath);
  }

  async restoreBackup(id: string): Promise<void> {
    await this.restoreFromFile(this.resolveManagedBackup(id));
  }

  // 启动自检：恢复流程在"旧库已改名 rollback、新库尚未就位"的窗口内被强杀（OOM/断电）
  // 会留下 *.restore-rollback-* 残留且主库缺失——不处理的话下次启动会静默新建空账本。
  // 主库缺失时把最近一份 rollback 改回原名；主库健在时只清理过期残留。
  recoverInterruptedRestore(): void {
    const databasePath = this.dependencies.databasePath;
    const rollbackFiles = fs.readdirSync(path.dirname(databasePath))
      .filter((name) => name.startsWith(`${path.basename(databasePath)}.restore-rollback-`))
      .map((name) => path.join(path.dirname(databasePath), name));
    if (rollbackFiles.length === 0) return;

    const mainDbMissing = !fs.existsSync(databasePath);
    if (mainDbMissing) {
      // 取主文件（不带 -wal/-shm 后缀）中最新的一份做回滚
      const mainRollbacks = rollbackFiles.filter((file) => !/-wal$|-shm$/.test(file));
      if (mainRollbacks.length > 0) {
        const latest = mainRollbacks.reduce((a, b) => (fs.statSync(a).mtimeMs >= fs.statSync(b).mtimeMs ? a : b));
        for (const ending of ['', '-wal', '-shm']) {
          const rollbackFile = `${latest}${ending}`;
          if (!fs.existsSync(rollbackFile)) continue;
          fs.renameSync(rollbackFile, `${databasePath}${ending}`);
        }
        logger.warn(`检测到中断的恢复流程，已回滚到恢复前快照: ${path.basename(latest)}`);
      }
    }
    // 剩余残留（回滚后多余的同族文件/主库健在时的孤儿文件）一律清掉，避免无限累积
    for (const file of rollbackFiles) {
      if (fs.existsSync(file)) removeIfExists(file);
    }
  }

  async restoreFromFile(sourcePath: string): Promise<void> {
    this.validateBackup(sourcePath);
    await this.createSnapshot('pre_restore');
    this.cleanupPreRestoreBackups();

    const suffix = crypto.randomBytes(6).toString('hex');
    const stagedPath = `${this.dependencies.databasePath}.restore-staged-${suffix}`;
    const rollbackPath = `${this.dependencies.databasePath}.restore-rollback-${suffix}`;
    const rollbackFiles: Array<{ original: string; rollback: string }> = [];
    fs.copyFileSync(sourcePath, stagedPath);
    this.validateBackup(stagedPath);

    this.dependencies.setMaintenance(true);
    try {
      this.dependencies.closeDatabase();
      for (const ending of ['', '-wal', '-shm']) {
        const original = `${this.dependencies.databasePath}${ending}`;
        if (!fs.existsSync(original)) continue;
        const rollback = `${rollbackPath}${ending}`;
        fs.renameSync(original, rollback);
        rollbackFiles.push({ original, rollback });
      }
      this.dependencies.installDatabase(stagedPath, this.dependencies.databasePath);
      this.dependencies.reopenDatabase();
      this.dependencies.initializeDatabase();
      this.dependencies.getDatabase().prepare('DELETE FROM sessions').run();

      for (const item of rollbackFiles) removeIfExists(item.rollback);
    } catch (error) {
      try {
        this.dependencies.closeDatabase();
      } catch {
        // 连接可能尚未成功打开。
      }
      removeIfExists(this.dependencies.databasePath);
      removeIfExists(`${this.dependencies.databasePath}-wal`);
      removeIfExists(`${this.dependencies.databasePath}-shm`);
      for (const item of rollbackFiles) {
        if (fs.existsSync(item.rollback)) fs.renameSync(item.rollback, item.original);
      }
      if (fs.existsSync(this.dependencies.databasePath)) {
        this.dependencies.reopenDatabase();
        this.dependencies.initializeDatabase();
      }
      throw error;
    } finally {
      removeIfExists(stagedPath);
      this.dependencies.setMaintenance(false);
    }
  }

  async runAutomaticBackupIfDue(): Promise<BackupRecord | null> {
    if (this.automaticBackupRunning) return null;
    const now = this.dependencies.now();
    const timeZone = this.dependencies.getTimeZone();
    const existing = this.listBackups({ deep: false });
    if (!shouldCreateAutomaticBackup(now, timeZone, existing)) return null;

    this.automaticBackupRunning = true;
    try {
      const backup = await this.createSnapshot('automatic');
      this.cleanupAutomaticBackups(now, timeZone);
      return backup;
    } finally {
      this.automaticBackupRunning = false;
    }
  }

  startAutomaticBackups(onError: (error: unknown) => void): void {
    void this.runAutomaticBackupIfDue().catch(onError);
    if (this.scheduler) return;
    this.scheduler = setInterval(() => {
      void this.runAutomaticBackupIfDue().catch(onError);
    }, 60 * 1000);
    this.scheduler.unref();
  }

  stopAutomaticBackups(): void {
    if (!this.scheduler) return;
    clearInterval(this.scheduler);
    this.scheduler = undefined;
  }

  private cleanupAutomaticBackups(now: Date, timeZone: string): void {
    // 清理决策只依赖清单里的类型与创建时间，无需每次全量完整性扫描。
    const automatic = this.listBackups({ deep: false }).filter((item) => item.type === 'automatic');
    const keep = selectAutomaticBackupsToKeep(automatic, now, timeZone);
    for (const backup of automatic) {
      if (!keep.has(backup.id)) removeIfExists(backup.path);
    }
  }

  // pre_restore 快照保留策略：每次恢复前都会生成一份账本全量快照，反复试恢复
  // 不同备份包会按账本大小无限累积占满磁盘，只保留最近 MAX_PRE_RESTORE_BACKUPS 份。
  private cleanupPreRestoreBackups(): void {
    const preRestore = this.listBackups({ deep: false })
      .filter((item) => item.type === 'pre_restore')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    for (const backup of preRestore.slice(MAX_PRE_RESTORE_BACKUPS)) {
      removeIfExists(backup.path);
    }
  }

  private ensureBackupDirectory(): void {
    fs.mkdirSync(this.dependencies.backupDir, { recursive: true });
  }

  private resolveManagedBackup(id: string): string {
    if (!id || id !== path.basename(id) || !/^ledger-(manual|automatic|pre_restore)-[A-Za-z0-9._-]+\.db$/.test(id)) {
      throw new Error('无效的备份 ID');
    }
    return path.join(this.dependencies.backupDir, id);
  }
}

export function shouldCreateAutomaticBackup(
  now: Date,
  timeZone: string,
  backups: BackupCandidate[]
): boolean {
  const today = zonedDate(now, timeZone);
  const hour = zonedHour(now, timeZone);
  if (hour < 3) return false;
  return !backups.some((backup) =>
    backup.type === 'automatic' && zonedDate(new Date(backup.createdAt), timeZone) === today
  );
}

export function selectAutomaticBackupsToKeep<T extends BackupCandidate>(
  backups: T[],
  now: Date,
  timeZone: string
): Set<string> {
  const sorted = [...backups]
    .filter((item) => item.type === 'automatic' && item.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const keep = new Set<string>();
  sorted.slice(0, 7).forEach((item) => keep.add(item.id!));

  const recentWeeks = new Set<string>();
  const currentWeek = weekStart(zonedDate(now, timeZone));
  for (let offset = 0; offset < 4; offset += 1) recentWeeks.add(addDays(currentWeek, -7 * offset));
  for (const item of sorted) {
    const week = weekStart(zonedDate(new Date(item.createdAt), timeZone));
    if (!recentWeeks.has(week)) continue;
    const alreadyKeptForWeek = sorted.some((candidate) =>
      keep.has(candidate.id!) && weekStart(zonedDate(new Date(candidate.createdAt), timeZone)) === week
    );
    if (!alreadyKeptForWeek) keep.add(item.id!);
  }
  return keep;
}

function buildBackupFilename(type: BackupType, createdAt: string): string {
  const timestamp = createdAt.replace(/[-:.]/g, '').replace('Z', 'Z');
  return `ledger-${type}-${timestamp}-${crypto.randomBytes(4).toString('hex')}.db`;
}

function isBackupType(value: string): value is BackupType {
  return value === 'manual' || value === 'automatic' || value === 'pre_restore';
}

function isIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function zonedDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function zonedHour(date: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).find((part) => part.type === 'hour')?.value;
  return Number(hour);
}

function weekStart(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  const day = parsed.getUTCDay() || 7;
  parsed.setUTCDate(parsed.getUTCDate() - day + 1);
  return parsed.toISOString().slice(0, 10);
}

function addDays(date: string, amount: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + amount);
  return parsed.toISOString().slice(0, 10);
}

function removeIfExists(filename: string): void {
  if (fs.existsSync(filename)) fs.rmSync(filename, { force: true });
}

export const backupService = new BackupService();
