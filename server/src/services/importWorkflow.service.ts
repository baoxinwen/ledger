import { createHash, randomBytes } from 'crypto';
import db from '../database';
import { ImportDiagnostic, ImportableTransaction, TransactionWithDetails } from '../types';
import { fromCents, toCents } from '../utils/amount';
import { decodeUploadedFilename } from '../utils/multipart';
import { HttpError, getErrorMessage } from '../utils/errors';
import { logger } from '../utils/logger';
import { categoryService } from './category.service';
import {
  FileImportSource,
  normalizeImportCategoryName,
  parseImportedFile,
  validateImportTransaction,
} from './billImport.service';
import { tagService } from './tag.service';
import { transactionService } from './transaction.service';

export type ImportOutcome = 'ready' | 'hard_duplicate' | 'content_duplicate' | 'skipped' | 'failed';
export type ImportTransactionType = 'income' | 'expense';

const PREVIEW_TTL_MS = 30 * 60 * 1000;
// 预览会话把全量解析记录（含每行 rowKey/勾选集）驻留在内存里，必须设上限防滥用：
// 会话数上限（超出时淘汰最久未访问的）+ 单文件行数上限。
const MAX_ACTIVE_SESSIONS = 3;
const MAX_PREVIEW_ROWS = 200_000;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

interface PreparedItem {
  transaction: ImportableTransaction;
  categoryName: string;
  tagNames: string[];
  fingerprint: string;
  outcome: Exclude<ImportOutcome, 'skipped'>;
  reason?: string;
}

interface ImportCounts {
  total: number;
  ready: number;
  hardDuplicates: number;
  contentDuplicates: number;
  skipped: number;
  failed: number;
}

interface CategoryMapping {
  source: string;
  target: string;
  type: ImportTransactionType;
  willCreate: boolean;
  count: number;
}

export interface ImportPreviewRow {
  rowKey: string;
  row: number;
  type: ImportTransactionType | null;
  amount: number | null;
  date: string | null;
  category: string | null;
  note: string | null;
  tags: string[];
  outcome: ImportOutcome;
  reason?: string;
  selectable: boolean;
  selected: boolean;
}

export interface ImportSelectionSummary {
  count: number;
  income: number;
  expense: number;
}

export interface ImportPreviewPage {
  items: ImportPreviewRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  selection: ImportSelectionSummary;
}

export interface ImportPreview {
  previewId: string;
  expiresAt: string;
  source: 'standard' | 'alipay' | 'wechat';
  filename: string;
  counts: ImportCounts;
  income: number;
  expense: number;
  categoryMappings: CategoryMapping[];
  rows: ImportPreviewPage;
  selection: ImportSelectionSummary;
  diagnostics: ImportDiagnostic[];
}

export interface ImportRowFilter {
  outcome?: ImportOutcome;
  type?: ImportTransactionType;
  page?: number;
  limit?: number;
}

export type ImportSelectionUpdate = {
  action: 'select' | 'deselect';
  rowKeys: string[];
  filter?: never;
} | {
  action: 'select' | 'deselect';
  filter: Pick<ImportRowFilter, 'outcome' | 'type'>;
  rowKeys?: never;
};

export interface ImportBatchView {
  id: number;
  filename: string;
  source: string;
  status: 'completed' | 'failed' | 'undone';
  totalCount: number;
  readyCount: number;
  successCount: number;
  skippedCount: number;
  duplicateCount: number;
  failedCount: number;
  excludedCount: number;
  income: number;
  expense: number;
  diagnostics: ImportDiagnostic[];
  createdAt: string;
  completedAt: string | null;
  undoneAt: string | null;
  undoneCount: number;
}

interface ImportBatchRow {
  id: number;
  filename: string;
  source: string;
  status: ImportBatchView['status'];
  total_count: number;
  ready_count: number;
  success_count: number;
  skipped_count: number;
  duplicate_count: number;
  failed_count: number;
  excluded_count: number;
  income_cents: number;
  expense_cents: number;
  diagnostics_json: string;
  created_at: string;
  completed_at: string | null;
  undone_at: string | null;
  undone_count: number;
}

interface PreparedRecord {
  row: number;
  ordinal: number;
  type: ImportTransactionType | null;
  amount: number | null;
  date: string | null;
  category: string | null;
  note: string | null;
  tags: string[];
  outcome: ImportOutcome;
  reason?: string;
  selectable: boolean;
  identity: string;
  item?: PreparedItem;
}

interface PreparedImport {
  source: 'standard' | 'alipay' | 'wechat';
  counts: ImportCounts;
  income: number;
  expense: number;
  categoryMappings: CategoryMapping[];
  diagnostics: ImportDiagnostic[];
  records: PreparedRecord[];
  validationSignature: string;
}

interface SessionRecord extends Omit<PreparedRecord, 'item'> {
  sequence: number;
  rowKey: string;
}

interface PreviewSession {
  id: string;
  ownerUserId: number;
  filename: string;
  requestedSource: FileImportSource;
  fileHash: string;
  source: PreparedImport['source'];
  counts: ImportCounts;
  income: number;
  expense: number;
  categoryMappings: CategoryMapping[];
  diagnostics: ImportDiagnostic[];
  validationSignature: string;
  records: SessionRecord[];
  selectedKeys: Set<string>;
  lastAccessAt: number;
}

interface ImportWorkflowOptions {
  now?: () => number;
  previewTtlMs?: number;
}

export class ImportWorkflowService {
  private readonly sessions = new Map<string, PreviewSession>();
  private readonly now: () => number;
  private readonly previewTtlMs: number;

  constructor(options: ImportWorkflowOptions = {}) {
    this.now = options.now ?? Date.now;
    this.previewTtlMs = options.previewTtlMs ?? PREVIEW_TTL_MS;
  }

  previewFile(
    buffer: Buffer,
    filename: string,
    requestedSource: FileImportSource,
    ownerUserId: number
  ): ImportPreview {
    this.purgeExpiredSessions();
    const prepared = this.prepare(buffer, filename, requestedSource);
    if (prepared.records.length > MAX_PREVIEW_ROWS) {
      throw new HttpError(400, `账单行数超过上限（最多 ${MAX_PREVIEW_ROWS} 行），请拆分文件后导入`);
    }
    // 会话数达到上限时淘汰最久未访问的活跃会话（单个用户实例，3 个并发预览已远超实际需要）
    while (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
      let oldestId: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [sessionId, session] of this.sessions) {
        if (session.lastAccessAt < oldestAt) {
          oldestAt = session.lastAccessAt;
          oldestId = sessionId;
        }
      }
      if (!oldestId) break;
      this.sessions.delete(oldestId);
    }
    const id = randomBytes(24).toString('hex');
    const lastAccessAt = this.now();
    const records = prepared.records.map<SessionRecord>((record, sequence) => {
      const { item: _item, ...safeRecord } = record;
      return { ...safeRecord, sequence, rowKey: randomBytes(16).toString('hex') };
    });
    const selectedKeys = new Set(
      records.filter((record) => record.outcome === 'ready').map((record) => record.rowKey)
    );
    const session: PreviewSession = {
      id,
      ownerUserId,
      filename,
      requestedSource,
      fileHash: hashBuffer(buffer),
      source: prepared.source,
      counts: prepared.counts,
      income: prepared.income,
      expense: prepared.expense,
      categoryMappings: prepared.categoryMappings,
      diagnostics: prepared.diagnostics,
      validationSignature: prepared.validationSignature,
      records,
      selectedKeys,
      lastAccessAt,
    };
    this.sessions.set(id, session);
    const selection = selectionSummary(session);
    return {
      previewId: id,
      expiresAt: this.expiresAt(session),
      source: session.source,
      filename,
      counts: session.counts,
      income: session.income,
      expense: session.expense,
      categoryMappings: session.categoryMappings,
      rows: this.buildPage(session, {}),
      selection,
      diagnostics: session.diagnostics,
    };
  }

  getPreviewRows(previewId: string, ownerUserId: number, filter: ImportRowFilter = {}): ImportPreviewPage {
    const session = this.getSession(previewId, ownerUserId);
    return this.buildPage(session, filter);
  }

  updateSelection(
    previewId: string,
    ownerUserId: number,
    update: ImportSelectionUpdate
  ): ImportSelectionSummary {
    const session = this.getSession(previewId, ownerUserId);
    if (update.action !== 'select' && update.action !== 'deselect') {
      throw new HttpError(400, '选择操作无效');
    }

    let records: SessionRecord[];
    if ('rowKeys' in update && update.rowKeys) {
      if (!Array.isArray(update.rowKeys) || update.rowKeys.length === 0) {
        throw new HttpError(400, '请选择至少一条记录');
      }
      const keys = new Set(update.rowKeys);
      records = session.records.filter((record) => keys.has(record.rowKey));
      if (records.length !== keys.size) throw new HttpError(400, '预览记录不存在');
      if (records.some((record) => !record.selectable)) {
        throw new HttpError(400, '订单重复、跳过或失败记录不能选择');
      }
    } else if ('filter' in update && update.filter) {
      records = filterRecords(session.records, update.filter).filter((record) => record.selectable);
    } else {
      throw new HttpError(400, '请选择记录或筛选范围');
    }

    for (const record of records) {
      if (update.action === 'select') session.selectedKeys.add(record.rowKey);
      else session.selectedKeys.delete(record.rowKey);
    }
    return selectionSummary(session);
  }

  deletePreview(previewId: string, ownerUserId: number): boolean {
    const session = this.sessions.get(previewId);
    if (!session || session.ownerUserId !== ownerUserId) return false;
    return this.sessions.delete(previewId);
  }

  confirmFile(
    buffer: Buffer,
    filename: string,
    requestedSource: FileImportSource,
    previewId: string,
    ownerUserId: number
  ): { batch: ImportBatchView; success: number; hardDuplicates: number; contentDuplicates: number } {
    const session = this.getSession(previewId, ownerUserId);
    if (session.fileHash !== hashBuffer(buffer) || session.requestedSource !== requestedSource) {
      this.sessions.delete(previewId);
      throw new HttpError(409, '导入文件或来源已变化，请重新预览');
    }

    const prepared = this.prepare(buffer, filename, requestedSource);
    if (prepared.source !== session.source || prepared.validationSignature !== session.validationSignature) {
      this.sessions.delete(previewId);
      throw new HttpError(409, '账本数据已变化，导入预览已失效，请重新预览');
    }

    const selectedSequences = session.records
      .filter((record) => session.selectedKeys.has(record.rowKey))
      .map((record) => record.sequence);
    const candidates = selectedSequences.map((sequence) => prepared.records[sequence]?.item).filter(isPreparedItem);
    if (candidates.length === 0) throw new HttpError(400, '请至少选择一条可导入记录');
    if (candidates.length !== selectedSequences.length) {
      this.sessions.delete(previewId);
      throw new HttpError(409, '导入预览已失效，请重新预览');
    }

    const selectableCount = session.records.filter((record) => record.selectable).length;
    const excludedCount = selectableCount - candidates.length;
    const incomeCents = sumCents(candidates, 'income');
    const expenseCents = sumCents(candidates, 'expense');
    const diagnostics = sanitizeDiagnostics(prepared.diagnostics);

    try {
      const batchId = db.transaction(() => {
        const batchResult = db.prepare(`
          INSERT INTO import_batches (
            filename, source, status, total_count, ready_count, success_count,
            skipped_count, duplicate_count, failed_count, excluded_count,
            income_cents, expense_cents, diagnostics_json, completed_at
          ) VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          filename,
          prepared.source,
          prepared.counts.total,
          selectableCount,
          candidates.length,
          prepared.counts.skipped,
          prepared.counts.hardDuplicates + prepared.counts.contentDuplicates,
          prepared.counts.failed,
          excludedCount,
          incomeCents,
          expenseCents,
          JSON.stringify(diagnostics)
        );
        const batchId = Number(batchResult.lastInsertRowid);

        for (const item of candidates) {
          let category = categoryService.getByNameAndType(item.categoryName, item.transaction.type);
          if (!category) {
            category = categoryService.create({
              name: item.categoryName,
              type: item.transaction.type,
              icon: item.transaction.type === 'income' ? '💰' : '📦',
              created_by_import_batch_id: batchId,
            });
          }
          const tagIds = item.tagNames.map((name) => tagService.create(name, batchId).id);
          transactionService.create({
            type: item.transaction.type,
            amount: item.transaction.amount,
            category_id: category.id,
            note: item.transaction.note || undefined,
            date: item.transaction.date,
            tag_ids: tagIds,
            source: item.transaction.source,
            source_transaction_id: item.transaction.source_transaction_id,
            source_merchant_order_id: item.transaction.source_merchant_order_id,
            source_category: item.transaction.source_category,
            source_time: item.transaction.source_time,
            payment_method: item.transaction.payment_method,
            source_status: item.transaction.source_status,
            import_batch_id: batchId,
            import_fingerprint: item.fingerprint,
          });
        }
        return batchId;
      })();

      this.sessions.delete(previewId);
      return {
        batch: this.getBatch(batchId)!,
        success: candidates.length,
        hardDuplicates: prepared.counts.hardDuplicates,
        contentDuplicates: prepared.counts.contentDuplicates,
      };
    } catch (error) {
      // 补偿性失败批次记录自身也可能因同一故障（SQLITE_FULL/锁）失败：
      // 必须吞掉它的异常，保证原始错误优先传播，否则真实失败原因既不响应也不落日志。
      try {
        db.prepare(`
          INSERT INTO import_batches (
            filename, source, status, total_count, ready_count, success_count,
            skipped_count, duplicate_count, failed_count, excluded_count,
            income_cents, expense_cents, diagnostics_json
          ) VALUES (?, ?, 'failed', ?, ?, 0, ?, ?, ?, ?, 0, 0, ?)
        `).run(
          filename,
          prepared.source,
          prepared.counts.total,
          selectableCount,
          prepared.counts.skipped,
          prepared.counts.hardDuplicates + prepared.counts.contentDuplicates,
          prepared.counts.failed + candidates.length,
          excludedCount,
          JSON.stringify([...diagnostics, { level: 'error', outcome: 'failed', reason: getErrorMessage(error) }].slice(0, 100))
        );
      } catch (logError) {
        logger.error('记录失败导入批次时出错（原始错误将优先抛出）', {
          scope: 'import',
          originalError: getErrorMessage(error),
          logError: getErrorMessage(logError),
        });
      }
      throw error;
    }
  }

  getHistory(page = 1, limit = 20): { items: ImportBatchView[]; total: number; page: number; limit: number; totalPages: number } {
    const safePage = Math.max(1, Math.floor(page));
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const total = (db.prepare('SELECT COUNT(*) AS count FROM import_batches').get() as { count: number }).count;
    const rows = db.prepare(`
      SELECT * FROM import_batches
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(safeLimit, (safePage - 1) * safeLimit) as ImportBatchRow[];
    return {
      items: rows.map(mapBatch),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  getBatch(id: number): ImportBatchView | undefined {
    const row = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(id) as ImportBatchRow | undefined;
    return row ? mapBatch(row) : undefined;
  }

  undo(id: number): { batch: ImportBatchView; undoneCount: number } {
    const batch = this.getBatch(id);
    if (!batch) throw new HttpError(404, '导入记录不存在');
    if (batch.status === 'undone') throw new HttpError(400, '该导入批次已撤销');
    if (batch.status !== 'completed') throw new HttpError(400, '只有已完成的导入批次可以撤销');

    const undoneCount = db.transaction(() => {
      const categoryIds = (db.prepare(
        'SELECT id FROM categories WHERE created_by_import_batch_id = ?'
      ).all(id) as { id: number }[]).map((item) => item.id);
      const tagIds = (db.prepare(
        'SELECT id FROM tags WHERE created_by_import_batch_id = ?'
      ).all(id) as { id: number }[]).map((item) => item.id);
      const deleted = db.prepare('DELETE FROM transactions WHERE import_batch_id = ?').run(id).changes;

      for (const categoryId of categoryIds) {
        const referenced = db.prepare(`
          SELECT EXISTS(SELECT 1 FROM transactions WHERE category_id = ?)
            OR EXISTS(SELECT 1 FROM budgets WHERE category_id = ?) AS value
        `).get(categoryId, categoryId) as { value: number };
        if (!referenced.value) db.prepare('DELETE FROM categories WHERE id = ?').run(categoryId);
      }
      for (const tagId of tagIds) {
        const referenced = db.prepare(
          'SELECT EXISTS(SELECT 1 FROM transaction_tags WHERE tag_id = ?) AS value'
        ).get(tagId) as { value: number };
        if (!referenced.value) db.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
      }
      db.prepare(`
        UPDATE import_batches
        SET status = 'undone', undone_at = datetime('now'), undone_count = ?
        WHERE id = ?
      `).run(deleted, id);
      return deleted;
    })();

    return { batch: this.getBatch(id)!, undoneCount };
  }

  private prepare(buffer: Buffer, filename: string, requestedSource: FileImportSource): PreparedImport {
    // 行数上限传给解析层在源头中止：此前 prepare 会先全量解析并逐行指纹，
    // 超限文件要吃满 CPU/内存后才被 previewFile 的检查拒绝（个人实例上等于放大的 DoS 面）。
    const parsed = parseImportedFile(buffer, filename, requestedSource, MAX_PREVIEW_ROWS);
    const existingFingerprints = new Set(
      transactionService.getAllForExport().map((transaction) => fingerprintExistingTransaction(transaction))
    );
    const existingCategoryKeys = new Set(categoryService.getAll().map((category) => `${category.type}:${category.name}`));
    const seenHardKeys = new Set<string>();
    const seenFingerprints = new Set<string>();
    const diagnostics = [...parsed.diagnostics];
    const mappingCounts = new Map<string, CategoryMapping>();
    const records: PreparedRecord[] = parsed.diagnostics.map((diagnostic, index) => diagnosticRecord(diagnostic, index));

    parsed.transactions.forEach((transaction, index) => {
      const categoryName = normalizeImportCategoryName(transaction.category);
      const tagNames = normalizeTagNames(transaction.tags);
      const fingerprint = createImportFingerprint(transaction, categoryName, tagNames);
      const errors = validateImportTransaction(transaction);
      let outcome: PreparedItem['outcome'] = 'ready';
      let reason: string | undefined;
      const hardKey = transaction.source && transaction.source_transaction_id
        ? `${transaction.source}:${transaction.source_transaction_id}`
        : undefined;

      if (errors.length > 0) {
        outcome = 'failed';
        reason = errors.join('；');
      } else if (hardKey && (seenHardKeys.has(hardKey) || transactionService.existsBySource(transaction.source!, transaction.source_transaction_id!))) {
        outcome = 'hard_duplicate';
        reason = '来源订单号已存在';
      } else if (!hardKey && (seenFingerprints.has(fingerprint) || existingFingerprints.has(fingerprint))) {
        outcome = 'content_duplicate';
        reason = '日期、金额、分类、备注和标签与已有记录相同';
      }

      if (hardKey) seenHardKeys.add(hardKey);
      seenFingerprints.add(fingerprint);
      const type = normalizedType(transaction.type);
      if (type) {
        const mappingKey = `${type}:${categoryName}`;
        const mapping = mappingCounts.get(mappingKey) || {
          source: transaction.category,
          target: categoryName,
          type,
          willCreate: !existingCategoryKeys.has(mappingKey),
          count: 0,
        };
        mapping.count += 1;
        mappingCounts.set(mappingKey, mapping);
      }

      const item: PreparedItem = { transaction, categoryName, tagNames, fingerprint, outcome, reason };
      const row = diagnosticRow(transaction, index);
      records.push({
        row,
        ordinal: parsed.diagnostics.length + index,
        type,
        amount: Number.isFinite(transaction.amount) ? transaction.amount : null,
        date: transaction.date || null,
        category: categoryName || null,
        note: transaction.note || null,
        tags: tagNames,
        outcome,
        reason,
        selectable: outcome === 'ready' || outcome === 'content_duplicate',
        identity: `transaction:${index}:${fingerprint}:${hashText(hardKey || '')}`,
        item,
      });

      if (outcome !== 'ready') {
        diagnostics.push({
          level: outcome === 'failed' ? 'error' : 'info',
          outcome: outcome === 'failed' ? 'failed' : 'duplicate',
          row,
          reason: reason!,
          source: transaction.source,
          source_transaction_id: transaction.source_transaction_id,
        });
      }
    });

    records.sort((left, right) => left.row - right.row || left.ordinal - right.ordinal);
    const readyItems = records
      .filter((record) => record.outcome === 'ready')
      .map((record) => record.item)
      .filter(isPreparedItem);
    const counts: ImportCounts = {
      total: parsed.transactions.length + parsed.skipped + parsed.failed,
      ready: records.filter((record) => record.outcome === 'ready').length,
      hardDuplicates: records.filter((record) => record.outcome === 'hard_duplicate').length,
      contentDuplicates: records.filter((record) => record.outcome === 'content_duplicate').length,
      skipped: records.filter((record) => record.outcome === 'skipped').length,
      failed: records.filter((record) => record.outcome === 'failed').length,
    };
    const validationSignature = hashText(records.map((record) => (
      `${record.row}\u001f${record.identity}\u001f${record.outcome}`
    )).join('\u001e'));

    return {
      source: parsed.source,
      counts,
      income: fromCents(sumCents(readyItems, 'income')),
      expense: fromCents(sumCents(readyItems, 'expense')),
      categoryMappings: [...mappingCounts.values()],
      diagnostics: sanitizeDiagnostics(diagnostics),
      records,
      validationSignature,
    };
  }

  private getSession(previewId: string, ownerUserId: number): PreviewSession {
    const session = this.sessions.get(previewId);
    const now = this.now();
    if (!session || session.ownerUserId !== ownerUserId || now - session.lastAccessAt >= this.previewTtlMs) {
      if (session) this.sessions.delete(previewId);
      throw new HttpError(410, '导入预览已过期，请重新选择文件预览');
    }
    session.lastAccessAt = now;
    return session;
  }

  private buildPage(session: PreviewSession, filter: ImportRowFilter): ImportPreviewPage {
    const page = Math.max(1, Math.floor(filter.page ?? 1));
    const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(filter.limit ?? DEFAULT_PAGE_LIMIT)));
    const filtered = filterRecords(session.records, filter);
    const items = filtered.slice((page - 1) * limit, page * limit).map((record) => publicRecord(record, session));
    return {
      items,
      total: filtered.length,
      page,
      limit,
      totalPages: Math.ceil(filtered.length / limit),
      selection: selectionSummary(session),
    };
  }

  private expiresAt(session: PreviewSession): string {
    return new Date(session.lastAccessAt + this.previewTtlMs).toISOString();
  }

  private purgeExpiredSessions(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastAccessAt >= this.previewTtlMs) this.sessions.delete(id);
    }
  }
}

export function createImportFingerprint(
  transaction: Pick<ImportableTransaction, 'type' | 'amount' | 'date' | 'note'>,
  categoryName: string,
  tagNames: string[]
): string {
  const normalized = [
    transaction.type,
    String(toCents(transaction.amount)),
    transaction.date,
    normalizeFingerprintText(categoryName),
    normalizeFingerprintText(transaction.note || ''),
    [...tagNames].map(normalizeFingerprintText).sort().join('|'),
  ].join('\u001f');
  return hashText(normalized);
}

function diagnosticRecord(diagnostic: ImportDiagnostic, index: number): PreparedRecord {
  const raw = diagnostic.raw || {};
  const source = diagnostic.source;
  const direction = safeText(raw['收/支']);
  const type = direction === '收入' ? 'income' : direction === '支出' ? 'expense' : null;
  const amountKey = source === 'wechat' ? '金额(元)' : '金额';
  const parsedAmount = parseSafeAmount(raw[amountKey]);
  const category = diagnostic.source_category || safeText(raw[source === 'wechat' ? '交易类型' : '交易分类']) || null;
  const sourceTime = diagnostic.source_time || safeText(raw['交易时间']);
  const note = buildDiagnosticNote(raw, source);
  const outcome: ImportOutcome = diagnostic.outcome === 'skipped' ? 'skipped' : 'failed';
  const row = diagnostic.row ?? diagnostic.import_row ?? index + 1;
  return {
    row,
    ordinal: index,
    type,
    amount: parsedAmount,
    date: sourceTime ? sourceTime.slice(0, 10) : null,
    category,
    note,
    tags: source === 'alipay' ? ['支付宝'] : source === 'wechat' ? ['微信'] : [],
    outcome,
    reason: diagnostic.reason,
    selectable: false,
    identity: `diagnostic:${index}:${row}:${hashText(JSON.stringify([outcome, type, parsedAmount, sourceTime, category, note, diagnostic.reason]))}`,
  };
}

function publicRecord(record: SessionRecord, session: PreviewSession): ImportPreviewRow {
  return {
    rowKey: record.rowKey,
    row: record.row,
    type: record.type,
    amount: record.amount,
    date: record.date,
    category: record.category,
    note: record.note,
    tags: record.tags,
    outcome: record.outcome,
    reason: record.reason,
    selectable: record.selectable,
    selected: session.selectedKeys.has(record.rowKey),
  };
}

function filterRecords<T extends Pick<SessionRecord, 'outcome' | 'type'>>(records: T[], filter: Pick<ImportRowFilter, 'outcome' | 'type'>): T[] {
  return records.filter((record) =>
    (!filter.outcome || record.outcome === filter.outcome) &&
    (!filter.type || record.type === filter.type)
  );
}

function selectionSummary(session: PreviewSession): ImportSelectionSummary {
  let count = 0;
  let incomeCents = 0;
  let expenseCents = 0;
  for (const record of session.records) {
    if (!session.selectedKeys.has(record.rowKey)) continue;
    count += 1;
    const amountCents = record.amount === null ? 0 : toCents(record.amount);
    if (record.type === 'income') incomeCents += amountCents;
    if (record.type === 'expense') expenseCents += amountCents;
  }
  return { count, income: fromCents(incomeCents), expense: fromCents(expenseCents) };
}

function fingerprintExistingTransaction(transaction: TransactionWithDetails): string {
  return createImportFingerprint(transaction, transaction.category.name, transaction.tags.map((tag) => tag.name));
}

function normalizeTagNames(tags: string[] | undefined): string[] {
  return [...new Set((tags || []).map((tag) => tag.trim()).filter(Boolean))].sort();
}

function normalizeFingerprintText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN');
}

function sumCents(items: PreparedItem[], type: ImportTransactionType): number {
  return items
    .filter((item) => item.transaction.type === type)
    .reduce((total, item) => total + toCents(item.transaction.amount), 0);
}

function sanitizeDiagnostics(items: ImportDiagnostic[]): ImportDiagnostic[] {
  return items.slice(0, 100).map(({ raw: _raw, source_transaction_id: _order, source_merchant_order_id: _merchant, ...item }) => item);
}

function mapBatch(row: ImportBatchRow): ImportBatchView {
  let diagnostics: ImportDiagnostic[] = [];
  try {
    diagnostics = JSON.parse(row.diagnostics_json) as ImportDiagnostic[];
  } catch {
    diagnostics = [];
  }
  return {
    id: row.id,
    filename: decodeUploadedFilename(row.filename),
    source: row.source,
    status: row.status,
    totalCount: row.total_count,
    readyCount: row.ready_count,
    successCount: row.success_count,
    skippedCount: row.skipped_count,
    duplicateCount: row.duplicate_count,
    failedCount: row.failed_count,
    excludedCount: row.excluded_count,
    income: fromCents(row.income_cents),
    expense: fromCents(row.expense_cents),
    diagnostics,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    undoneAt: row.undone_at,
    undoneCount: row.undone_count,
  };
}

function isPreparedItem(item: PreparedItem | undefined): item is PreparedItem {
  return Boolean(item);
}

function normalizedType(type: string): ImportTransactionType | null {
  return type === 'income' || type === 'expense' ? type : null;
}

function diagnosticRow(transaction: ImportableTransaction, index: number): number {
  return transaction.source_row ?? transaction.import_row ?? index + 1;
}

function safeText(value: unknown): string {
  const normalized = String(value ?? '').trim();
  return normalized === '/' ? '' : normalized;
}

function parseSafeAmount(value: unknown): number | null {
  const normalized = safeText(value).replace(/[¥￥,\s]/g, '');
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function buildDiagnosticNote(raw: Record<string, unknown>, source: ImportDiagnostic['source']): string | null {
  const itemKey = source === 'wechat' ? '商品' : '商品说明';
  const values = [raw['交易对方'], raw[itemKey], raw['备注']].map(safeText).filter(Boolean);
  return values.join(' - ') || null;
}

function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export const importWorkflowService = new ImportWorkflowService();
