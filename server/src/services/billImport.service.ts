// 第三方账单导入服务：解析支付宝 CSV、微信 XLSX 和标准 JSON/CSV，并生成可排查的诊断信息。
import { inflateRawSync } from 'zlib';
import iconv from 'iconv-lite';
import { ImportableTransaction, ImportDiagnostic, ImportResult } from '../types';
import { categoryService } from './category.service';
import { tagService } from './tag.service';
import { transactionService } from './transaction.service';
import { getErrorMessage } from '../utils/errors';
import { isCalendarDate } from '../utils/validation';

// 单个 XLSX ZIP 条目的最大解压体积，防止单条目 zip bomb。
const MAX_XLSX_ENTRY_BYTES = 50 * 1024 * 1024;
// 所有条目累计解压体积上限：即使每个条目都在单条限制内，总量超限也要拒绝，避免聚合 zip bomb。
const MAX_XLSX_TOTAL_BYTES = 100 * 1024 * 1024;
// 条目数量上限，防止海量小条目拖垮解析。
const MAX_XLSX_ENTRIES = 1000;
// 单元格引用合法性：形如 A1 / XFD1048576 的「列字母(1-3 位)+行号」。
const CELL_REF_PATTERN = /^([A-Za-z]{1,3})([1-9]\d*)$/;
// XLSX 规范最大列数（最后一列为 XFD，即第 16384 列）。
// 不设防时恶意超长列名会令稀疏数组长度爆炸（cells[hugeIndex] 后 map 分配 GB 级内存）。
const MAX_XLSX_COLUMN_COUNT = 16384;
// 与手动创建接口的金额上限保持一致（utils/validation.ts 的 MAX_AMOUNT）。
const MAX_IMPORT_AMOUNT = 1e12;

type ImportSource = 'standard' | 'alipay' | 'wechat';
export type FileImportSource = ImportSource | 'auto';

interface ParsedFile {
  source: ImportSource;
  transactions: ImportableTransaction[];
  skipped: number;
  failed: number;
  diagnostics: ImportDiagnostic[];
}

interface ZipEntry {
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

const SOURCE_LABELS: Record<Exclude<ImportSource, 'standard'>, string> = {
  alipay: '支付宝',
  wechat: '微信',
};

const DEFAULT_CATEGORY = {
  income: { icon: '💰' },
  expense: { icon: '📦' },
} as const;

export class BillImportService {
  importTransactions(transactions: ImportableTransaction[]): ImportResult {
    const result = createEmptyImportResult();
    const createdCategoryKeys = new Set<string>();

    // 标准导入和第三方账单最终都会走这条路径，因此这里集中处理校验、去重、建类和入库。
    transactions.forEach((transaction, index) => {
      try {
        const validationErrors = validateImportTransaction(transaction);
        if (validationErrors.length > 0) {
          const reason = validationErrors.join('；');
          result.failed++;
          result.errors.push(`Row ${getDiagnosticRow(transaction, index)}: ${reason}`);
          result.diagnostics.push(createTransactionDiagnostic('error', 'failed', reason, transaction, index));
          return;
        }

        if (
          transaction.source &&
          transaction.source_transaction_id &&
          transactionService.existsBySource(transaction.source, transaction.source_transaction_id)
        ) {
          result.duplicates++;
          result.diagnostics.push(createTransactionDiagnostic('info', 'duplicate', '来源订单号已导入，跳过重复记录', transaction, index));
          return;
        }

        const categoryName = normalizeImportCategoryName(transaction.category);
        const categoryKey = `${transaction.type}:${categoryName}`;
        let category = categoryService.getByNameAndType(categoryName, transaction.type);
        if (!category) {
          // 第三方原始分类不做映射，直接按“类型 + 名称”创建自定义分类，避免误归类。
          const defaults = DEFAULT_CATEGORY[transaction.type];
          category = categoryService.create({
            name: categoryName,
            type: transaction.type,
            icon: defaults.icon,
            color: categoryService.suggestColor(transaction.type, categoryName),
          });
          if (!createdCategoryKeys.has(categoryKey)) {
            result.createdCategories++;
            createdCategoryKeys.add(categoryKey);
          }
        }

        const tagIds = [...new Set(transaction.tags || [])]
          .map((tagName) => tagName.trim())
          .filter(Boolean)
          .map((tagName) => tagService.create(tagName).id);

        transactionService.create({
          type: transaction.type,
          amount: transaction.amount,
          category_id: category.id,
          note: transaction.note || undefined,
          date: transaction.date,
          tag_ids: tagIds,
          source: transaction.source,
          source_transaction_id: transaction.source_transaction_id,
          source_merchant_order_id: transaction.source_merchant_order_id,
          source_category: transaction.source_category,
          source_time: transaction.source_time,
          payment_method: transaction.payment_method,
          source_status: transaction.source_status,
        });

        result.success++;
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          result.duplicates++;
          result.diagnostics.push(createTransactionDiagnostic('info', 'duplicate', '数据库唯一索引判定为重复记录', transaction, index));
          return;
        }
        const reason = (error as Error).message;
        result.failed++;
        result.errors.push(`Row ${getDiagnosticRow(transaction, index)}: ${reason}`);
        result.diagnostics.push(createTransactionDiagnostic('error', 'failed', reason, transaction, index));
      }
    });

    return result;
  }

  importFile(buffer: Buffer, filename: string, requestedSource: FileImportSource): ImportResult {
    const parsed = parseImportedFile(buffer, filename, requestedSource);
    const result = this.importTransactions(parsed.transactions);
    // 解析阶段已经能判断不计收支、关闭交易、格式错误等，这些诊断要并入最终响应。
    result.skipped += parsed.skipped;
    result.failed += parsed.failed;
    result.errors.push(...parsed.diagnostics.filter((item) => item.outcome === 'failed').map((item) => `Row ${item.row ?? '-'}: ${item.reason}`));
    result.diagnostics.unshift(...parsed.diagnostics);
    return result;
  }
}

// 行数超限的统一文案：调用方（导入工作流预览）把行数上限传进解析层，
// 在行物化的源头中止解析，而不是先全量解析完再被上层拒绝。
function rowLimitExceededError(maxRows: number): Error {
  return new Error(`账单行数超过上限（最多 ${maxRows} 行），请拆分文件后导入`);
}

export function parseImportedFile(buffer: Buffer, filename: string, requestedSource: FileImportSource, maxRows = Number.POSITIVE_INFINITY): ParsedFile {
  const lowerName = filename.toLowerCase();
  const utf8Text = buffer.toString('utf8');
  const gb18030Text = iconv.decode(buffer, 'gb18030');
  // 支付宝历史 CSV 常见编码是 GB18030；自动识别时同时检查 UTF-8 和 GB18030 文本。
  const source = detectSource(requestedSource, lowerName, utf8Text, gb18030Text);

  if (source === 'alipay') {
    return { source, ...parseAlipayBillWithSkipped(pickAlipayText(utf8Text, gb18030Text), maxRows) };
  }
  if (source === 'wechat') {
    return { source, ...parseWechatBillWithSkipped(buffer, maxRows) };
  }
  if (lowerName.endsWith('.json')) {
    return { source, transactions: parseStandardJson(utf8Text, maxRows), skipped: 0, failed: 0, diagnostics: [] };
  }
  if (lowerName.endsWith('.csv')) {
    return { source, transactions: parseStandardCsv(utf8Text, maxRows), skipped: 0, failed: 0, diagnostics: [] };
  }

  throw new Error('Unsupported import file format');
}

export function parseAlipayBill(text: string): ImportableTransaction[] {
  return parseAlipayBillWithSkipped(text).transactions;
}

function parseAlipayBillWithSkipped(text: string, maxRows = Number.POSITIVE_INFINITY): { transactions: ImportableTransaction[]; skipped: number; failed: number; diagnostics: ImportDiagnostic[] } {
  const rows = parseCsvRows(text, maxRows);
  const headerIndex = rows.findIndex((row) => row[0]?.trim() === '交易时间');
  if (headerIndex === -1) {
    throw new Error('Alipay header row not found');
  }

  const header = rows[headerIndex];
  let skipped = 0;
  let failed = 0;
  const diagnostics: ImportDiagnostic[] = [];
  const transactions = rows.slice(headerIndex + 1).reduce<ImportableTransaction[]>((items, row, index) => {
    if (!row[0]?.trim()) return items;

    const rowNumber = index + headerIndex + 2;
    const record = rowToRecord(header, row);
    const direction = normalizeValue(record['收/支']);
    const status = normalizeValue(record['交易状态']);

    // “不计收支”是支付宝自己的中性流水，不能入账，但要留下诊断说明为什么跳过。
    if (direction !== '收入' && direction !== '支出') {
      skipped++;
      diagnostics.push(createRawDiagnostic('info', 'skipped', `收/支为“${direction || '空'}”，不属于收入或支出`, 'alipay', rowNumber, record));
      return items;
    }
    if (isClosedOrFailedStatus(status)) {
      skipped++;
      diagnostics.push(createRawDiagnostic('info', 'skipped', `交易状态为“${status}”，不导入关闭、失败或取消交易`, 'alipay', rowNumber, record));
      return items;
    }

    const sourceTime = normalizeValue(record['交易时间']);
    const amount = parseAmount(record['金额']);
    const sourceCategory = normalizeValue(record['交易分类']) || '其他';
    const sourceTransactionId = normalizeOrderId(record['交易订单号']);
    const merchantOrderId = normalizeOrderId(record['商家订单号']);
    const counterparty = normalizeDisplayValue(record['交易对方']);
    const item = normalizeDisplayValue(record['商品说明']);
    const remark = normalizeDisplayValue(record['备注']);
    const paymentMethod = normalizeDisplayValue(record['收/付款方式']);

    const parseErrors = validateParsedRow(sourceTime, amount);
    if (parseErrors.length > 0) {
      failed++;
      diagnostics.push(createRawDiagnostic('error', 'failed', parseErrors.join('；'), 'alipay', rowNumber, record));
      return items;
    }

    items.push({
      type: direction === '收入' ? 'income' : 'expense',
      amount,
      category: sourceCategory,
      // 0 元红包/奖励金抵扣是真实交易事件，但账单没有原价，只能保留 0 元和支付方式。
      note: joinNote([counterparty, item, remark, zeroAmountPaymentNote(amount, paymentMethod)]),
      date: sourceTime.substring(0, 10),
      tags: [SOURCE_LABELS.alipay],
      source: 'alipay',
      source_transaction_id: sourceTransactionId || undefined,
      source_merchant_order_id: merchantOrderId || undefined,
      source_category: sourceCategory,
      source_time: sourceTime,
      payment_method: paymentMethod || undefined,
      source_status: status || undefined,
      import_row: items.length + 1,
      source_row: rowNumber,
      source_raw: record,
    });

    return items;
  }, []);

  return { transactions, skipped, failed, diagnostics };
}

export function parseWechatBill(buffer: Buffer): ImportableTransaction[] {
  return parseWechatBillWithSkipped(buffer).transactions;
}

function parseWechatBillWithSkipped(buffer: Buffer, maxRows = Number.POSITIVE_INFINITY): { transactions: ImportableTransaction[]; skipped: number; failed: number; diagnostics: ImportDiagnostic[] } {
  const rows = parseFirstWorksheet(buffer, maxRows);
  const headerIndex = rows.findIndex((row) => row[0]?.trim() === '交易时间');
  if (headerIndex === -1) {
    throw new Error('WeChat header row not found');
  }

  const header = rows[headerIndex];
  let skipped = 0;
  let failed = 0;
  const diagnostics: ImportDiagnostic[] = [];
  const transactions = rows.slice(headerIndex + 1).reduce<ImportableTransaction[]>((items, row, index) => {
    if (!row[0]?.trim()) return items;

    const rowNumber = index + headerIndex + 2;
    const record = rowToRecord(header, row);
    const direction = normalizeValue(record['收/支']);
    const status = normalizeValue(record['当前状态']);

    // 微信的充值、提现、零钱通等中性流水没有收入/支出方向，按跳过处理并写诊断。
    if (direction !== '收入' && direction !== '支出') {
      skipped++;
      diagnostics.push(createRawDiagnostic('info', 'skipped', `收/支为“${direction || '空'}”，不属于收入或支出`, 'wechat', rowNumber, record));
      return items;
    }
    if (isClosedOrFailedStatus(status)) {
      skipped++;
      diagnostics.push(createRawDiagnostic('info', 'skipped', `当前状态为“${status}”，不导入关闭、失败或取消交易`, 'wechat', rowNumber, record));
      return items;
    }

    const sourceTime = normalizeValue(record['交易时间']);
    const amount = parseAmount(record['金额(元)']);
    const sourceCategory = normalizeValue(record['交易类型']) || '其他';
    const sourceTransactionId = normalizeOrderId(record['交易单号']);
    const merchantOrderId = normalizeOrderId(record['商户单号']);
    const counterparty = normalizeDisplayValue(record['交易对方']);
    const item = normalizeDisplayValue(record['商品']);
    const remark = normalizeDisplayValue(record['备注']);
    const paymentMethod = normalizeDisplayValue(record['支付方式']);

    const parseErrors = validateParsedRow(sourceTime, amount);
    if (parseErrors.length > 0) {
      failed++;
      diagnostics.push(createRawDiagnostic('error', 'failed', parseErrors.join('；'), 'wechat', rowNumber, record));
      return items;
    }

    items.push({
      type: direction === '收入' ? 'income' : 'expense',
      amount,
      category: sourceCategory,
      // 0 元支付同样保留交易事件，支付方式会帮助解释为什么金额为 0。
      note: joinNote([counterparty, item, remark, zeroAmountPaymentNote(amount, paymentMethod)]),
      date: sourceTime.substring(0, 10),
      tags: [SOURCE_LABELS.wechat],
      source: 'wechat',
      source_transaction_id: sourceTransactionId || undefined,
      source_merchant_order_id: merchantOrderId || undefined,
      source_category: sourceCategory,
      source_time: sourceTime,
      payment_method: paymentMethod || undefined,
      source_status: status || undefined,
      import_row: items.length + 1,
      source_row: rowNumber,
      source_raw: record,
    });

    return items;
  }, []);

  return { transactions, skipped, failed, diagnostics };
}

export function parseStandardJson(text: string, maxRows = Number.POSITIVE_INFINITY): ImportableTransaction[] {
  const parsed = JSON.parse(text);
  const transactions = Array.isArray(parsed) ? parsed : parsed.transactions;
  if (!Array.isArray(transactions)) {
    throw new Error('JSON import must be an array or contain transactions array');
  }
  // JSON.parse 本身无法增量中止，但必须在逐行规范化之前拦住超限数组，避免后续映射白白执行。
  if (transactions.length > maxRows) {
    throw rowLimitExceededError(maxRows);
  }
  return transactions.map((transaction, index) => normalizeStandardTransaction(transaction, index + 1));
}

export function parseStandardCsv(text: string, maxRows = Number.POSITIVE_INFINITY): ImportableTransaction[] {
  const rows = parseCsvRows(text, maxRows);
  // 表头检测用“包含”匹配：带前缀的列名（如“交易日期”“交易类型”）也应命中。
  const headerIndex = rows.findIndex((row) =>
    row.some((cell) => cell.includes('日期')) &&
    row.some((cell) => cell.includes('类型')) &&
    row.some((cell) => cell.includes('分类'))
  );
  if (headerIndex === -1) {
    throw new Error('Standard CSV header row not found');
  }

  // 表头可能带前缀，先映射到规范字段名再取值，避免整份导入逐行失败。
  const header = rows[headerIndex].map(normalizeStandardHeaderKey);
  return rows.slice(headerIndex + 1)
    .filter((row) => row.some((cell) => cell.trim()))
    .map((row, index) => normalizeStandardTransaction(rowToRecord(header, row), index + 1, index + headerIndex + 2));
}

// 标准 CSV 表头按包含关系映射到规范字段名（日期/类型/分类/金额/标签/备注），其余列名原样保留。
function normalizeStandardHeaderKey(raw: string): string {
  const key = raw.trim();
  if (key.includes('日期')) return '日期';
  if (key.includes('类型')) return '类型';
  if (key.includes('分类')) return '分类';
  if (key.includes('金额')) return '金额';
  if (key.includes('标签')) return '标签';
  if (key.includes('备注')) return '备注';
  return key;
}

export function parseCsvRows(text: string, maxRows = Number.POSITIVE_INFINITY): string[][] {
  // 自实现 CSV 解析器是为了避免额外依赖，并正确处理支付宝导出中带引号和换行的字段。
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const normalizedText = text.replace(/^\uFEFF/, '');

  for (let index = 0; index < normalizedText.length; index++) {
    const char = normalizedText[index];
    const nextChar = normalizedText[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        cell += '"';
        index++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') index++;
      row.push(cell);
      if (row.some((value) => value.trim())) {
        rows.push(row);
        // 行数上限在行物化的源头检查：超限立即中止整个字符循环，而不是先解析完再被上层拒绝。
        if (rows.length > maxRows) throw rowLimitExceededError(maxRows);
      }
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  if (cell || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim())) {
      rows.push(row);
      if (rows.length > maxRows) throw rowLimitExceededError(maxRows);
    }
  }

  return rows;
}

// 支付宝 CSV 可能是 GB18030 或 UTF-8；按哪种解码能识别出表头/标识来选择解析文本，避免把 UTF-8 文件按 GB18030 解析成乱码。
function pickAlipayText(utf8Text: string, gb18030Text: string): string {
  const looksLikeAlipay = (text: string) => text.includes('支付宝') || text.includes('交易时间');
  const utf8Looks = looksLikeAlipay(utf8Text);
  const gbLooks = looksLikeAlipay(gb18030Text);
  if (utf8Looks && !gbLooks) return utf8Text;
  if (gbLooks && !utf8Looks) return gb18030Text;
  return utf8Looks ? utf8Text : gb18030Text;
}

function detectSource(
  requestedSource: FileImportSource,
  lowerName: string,
  utf8Text: string,
  gb18030Text: string
): ImportSource {
  if (requestedSource !== 'auto') return requestedSource;
  if (lowerName.endsWith('.xlsx')) return 'wechat';
  if (gb18030Text.includes('支付宝') || gb18030Text.includes('交易分类,交易对方')) return 'alipay';
  if (utf8Text.includes('支付宝') || utf8Text.includes('交易分类,交易对方')) return 'alipay';
  return 'standard';
}

function normalizeStandardTransaction(input: Record<string, unknown>, importRow?: number, sourceRow?: number): ImportableTransaction {
  const typeValue = String(input.type ?? input['类型'] ?? '').trim();
  const tagsValue = input.tags ?? input['标签'];
  const tags = Array.isArray(tagsValue)
    ? tagsValue.map(String)
    : String(tagsValue || '').split(/[;；]/).filter(Boolean);

  return {
    // 未知类型（大写、拼写错误等）保留原文而非静默转成 expense，交由 validateTransaction 报错。
    type: typeValue === 'income' || typeValue === '收入'
      ? 'income'
      : typeValue === 'expense' || typeValue === '支出'
        ? 'expense'
        : typeValue as 'income' | 'expense',
    amount: parseAmount(input.amount ?? input['金额']),
    category: String(input.category ?? input['分类'] ?? '其他').trim(),
    date: String(input.date ?? input['日期'] ?? '').trim(),
    note: String(input.note ?? input['备注'] ?? '').trim() || undefined,
    tags,
    source: normalizeOptionalSource(input.source) || 'standard',
    source_transaction_id: normalizeOptionalString(input.source_transaction_id),
    source_merchant_order_id: normalizeOptionalString(input.source_merchant_order_id),
    source_category: normalizeOptionalString(input.source_category),
    source_time: normalizeOptionalString(input.source_time),
    payment_method: normalizeOptionalString(input.payment_method),
    source_status: normalizeOptionalString(input.source_status),
    import_row: importRow,
    source_row: sourceRow,
    source_raw: input,
  };
}

function normalizeOptionalSource(value: unknown): 'standard' | 'alipay' | 'wechat' | undefined {
  return value === 'standard' || value === 'alipay' || value === 'wechat' ? value : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = normalizeValue(value);
  return normalized || undefined;
}

function createEmptyImportResult(): ImportResult {
  return {
    success: 0,
    failed: 0,
    skipped: 0,
    duplicates: 0,
    createdCategories: 0,
    errors: [],
    diagnostics: [],
  };
}

function validateParsedRow(sourceTime: string, amount: number): string[] {
  const errors: string[] = [];
  if (!sourceTime) errors.push('交易时间为空');
  if (!Number.isFinite(amount)) errors.push('金额无法解析');
  if (Number.isFinite(amount) && amount < 0) errors.push('金额不能为负数');
  return errors;
}

export function validateImportTransaction(transaction: ImportableTransaction): string[] {
  const errors: string[] = [];
  if (transaction.type !== 'income' && transaction.type !== 'expense') {
    errors.push('类型必须是收入或支出');
  }
  if (!Number.isFinite(transaction.amount)) {
    errors.push('金额无法解析');
  } else if (transaction.amount < 0) {
    errors.push('金额不能为负数');
  } else if (!Number.isInteger(Math.round(transaction.amount * 1000000) / 10000)) {
    errors.push('金额最多保留两位小数');
  } else if (transaction.amount > MAX_IMPORT_AMOUNT) {
    errors.push('金额过大，超出允许范围');
  }
  if (!transaction.category?.trim()) {
    errors.push('分类为空');
  } else if (transaction.category.trim().length > 64) {
    // 与手动创建接口（requireName 64）对齐：导入不应能绕过长度约束写入超长分类。
    errors.push('分类名称长度不能超过 64 个字符');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(transaction.date)) {
    errors.push('日期格式无效，应为 YYYY-MM-DD');
  } else if (!isCalendarDate(transaction.date)) {
    // 与手动创建接口（requireDate）对齐：拒绝 2026-02-30 这类日历上不存在的日期，
    // 否则记录会永久落入统计/预算的字符串区间盲区，收支被静默算少。
    errors.push('日期无效，请检查年月日');
  }
  if ((transaction.note ?? '').length > 2000) {
    // 与手动创建接口（optionalString 默认 2000）对齐。
    errors.push('备注长度不能超过 2000 个字符');
  }
  if ((transaction.tags || []).some((tag) => tag.length > 64)) {
    errors.push('标签长度不能超过 64 个字符');
  }
  const overlyLongMetadata = [
    transaction.source_transaction_id,
    transaction.source_merchant_order_id,
    transaction.source_category,
    transaction.source_time,
    transaction.payment_method,
    transaction.source_status,
  ].find((value) => (value ?? '').length > 200);
  if (overlyLongMetadata) {
    errors.push('来源信息字段长度不能超过 200 个字符');
  }
  return errors;
}

function createRawDiagnostic(
  level: ImportDiagnostic['level'],
  outcome: ImportDiagnostic['outcome'],
  reason: string,
  source: ImportSource,
  row: number,
  raw: Record<string, unknown>
): ImportDiagnostic {
  // raw 仅供服务内部定位解析问题；预览与历史响应会在 importWorkflow 边界统一脱敏。
  return {
    level,
    outcome,
    row,
    reason,
    source,
    source_transaction_id: extractRawOrderId(raw, source),
    source_merchant_order_id: extractRawMerchantOrderId(raw, source),
    source_category: String(raw[source === 'wechat' ? '交易类型' : '交易分类'] ?? '').trim() || undefined,
    source_time: String(raw['交易时间'] ?? '').trim() || undefined,
    payment_method: String(raw[source === 'wechat' ? '支付方式' : '收/付款方式'] ?? '').trim() || undefined,
    raw,
  };
}

function createTransactionDiagnostic(
  level: ImportDiagnostic['level'],
  outcome: ImportDiagnostic['outcome'],
  reason: string,
  transaction: ImportableTransaction,
  index: number
): ImportDiagnostic {
  return {
    level,
    outcome,
    row: getDiagnosticRow(transaction, index),
    import_row: transaction.import_row ?? index + 1,
    reason,
    source: transaction.source,
    source_transaction_id: transaction.source_transaction_id,
    source_merchant_order_id: transaction.source_merchant_order_id,
    source_category: transaction.source_category,
    source_time: transaction.source_time,
    payment_method: transaction.payment_method,
    raw: transaction.source_raw ?? {
      type: transaction.type,
      amount: transaction.amount,
      category: transaction.category,
      date: transaction.date,
      note: transaction.note,
      tags: transaction.tags,
    },
  };
}

function getDiagnosticRow(transaction: ImportableTransaction, index: number): number {
  return transaction.source_row ?? transaction.import_row ?? index + 1;
}

function extractRawOrderId(raw: Record<string, unknown>, source: ImportSource): string | undefined {
  const key = source === 'wechat' ? '交易单号' : '交易订单号';
  return normalizeOrderId(raw[key]) || undefined;
}

function extractRawMerchantOrderId(raw: Record<string, unknown>, source: ImportSource): string | undefined {
  const key = source === 'wechat' ? '商户单号' : '商家订单号';
  return normalizeOrderId(raw[key]) || undefined;
}

export function normalizeImportCategoryName(category: string): string {
  return normalizeValue(category) || '其他';
}

function normalizeValue(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeDisplayValue(value: unknown): string {
  const normalized = normalizeValue(value);
  return normalized && normalized !== '/' ? normalized : '';
}

function normalizeOrderId(value: unknown): string {
  return normalizeDisplayValue(value).replace(/\t/g, '').trim();
}

function parseAmount(value: unknown): number {
  // 金额字段可能带 ¥、￥、千分位逗号或空白；空字符串必须保持为 NaN，不能误导入为 0。
  const normalized = normalizeValue(value).replace(/[¥￥,\s]/g, '');
  if (!normalized) return Number.NaN;
  return Number(normalized);
}

function joinNote(parts: string[]): string | undefined {
  const note = parts.filter(Boolean).join(' - ');
  return note || undefined;
}

function zeroAmountPaymentNote(amount: number, paymentMethod: string): string {
  return amount === 0 && paymentMethod ? `支付方式: ${paymentMethod}` : '';
}

function isClosedOrFailedStatus(status: string): boolean {
  return /关闭|失败|取消/.test(status);
}

function rowToRecord(header: string[], row: string[]): Record<string, string> {
  return header.reduce<Record<string, string>>((record, key, index) => {
    const normalizedKey = key.trim();
    if (normalizedKey) record[normalizedKey] = row[index] ?? '';
    return record;
  }, {});
}

// 仅匹配唯一索引冲突；不要用宽泛的 /constraint/，否则会把外键失败等误判为“重复记录”。
export function isUniqueConstraintError(error: unknown): boolean {
  return /UNIQUE constraint failed/i.test(getErrorMessage(error));
}

function parseFirstWorksheet(buffer: Buffer, maxRows = Number.POSITIVE_INFINITY): string[][] {
  const files = extractZipFiles(buffer);
  const sharedStrings = parseSharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8') || '');
  const sheetXml = files.get('xl/worksheets/sheet1.xml')?.toString('utf8');
  if (!sheetXml) {
    throw new Error('XLSX first worksheet not found');
  }

  const rows: string[][] = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(sheetXml)) !== null) {
    const cells: string[] = [];
    const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const ref = getXmlAttribute(attrs, 'r');
      const type = getXmlAttribute(attrs, 't');
      // 引用必须形如 A1/XFD1048576；恶意超长列名会让稀疏数组长度爆炸，直接拒绝整个文件。
      const columnIndex = ref ? parseCellColumnIndex(ref) : cells.length;
      cells[columnIndex] = parseCellValue(body, type, sharedStrings);
    }
    rows.push(cells.map((cell) => cell || ''));
    // 与 CSV 同理：行数上限在行物化的源头中止，避免超大工作表全量解析完才被上层拒绝。
    if (rows.length > maxRows) throw rowLimitExceededError(maxRows);
  }

  return rows;
}

// 解析 ZIP 条目。limits 可注入更小的预算供测试验证；默认使用全局上限。
export function extractZipFiles(
  buffer: Buffer,
  limits: { maxTotalBytes?: number; maxEntries?: number } = {}
): Map<string, Buffer> {
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_XLSX_TOTAL_BYTES;
  const maxEntries = limits.maxEntries ?? MAX_XLSX_ENTRIES;
  const files = new Map<string, Buffer>();
  const entries = new Map<string, ZipEntry>();
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let cursor = centralDirectoryOffset;
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;

  while (cursor < centralDirectoryEnd) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Invalid XLSX central directory');
    }
    if (entries.size >= maxEntries) {
      throw new Error('XLSX 文件条目过多，已拒绝解析');
    }

    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString('utf8');

    entries.set(name, { method, compressedSize, localHeaderOffset });
    cursor = nameStart + fileNameLength + extraLength + commentLength;
  }

  let totalInflatedBytes = 0;
  entries.forEach((entry, name) => {
    const localOffset = entry.localHeaderOffset;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Invalid XLSX local file header for ${name}`);
    }
    const fileNameLength = buffer.readUInt16LE(localOffset + 26);
    const extraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + fileNameLength + extraLength;
    const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    // 单条目限制解压输出大小；同时累计所有条目总量，防聚合 zip bomb。
    let content: Buffer;
    if (entry.method === 0) {
      content = compressed;
    } else {
      try {
        content = inflateRawSync(compressed, { maxOutputLength: MAX_XLSX_ENTRY_BYTES });
      } catch (error) {
        // 超限抛带 code 的 RangeError，会被路由层按"有 code 即系统错误"归为 500；
        // 单条目过大是用户文件问题，转成业务错误保持与聚合超限一致的 400 文案。
        if ((error as { code?: unknown } | null)?.code === 'ERR_BUFFER_TOO_LARGE') {
          throw new Error('XLSX 单个工作表条目解压后体积过大，已拒绝解析');
        }
        throw error;
      }
    }
    totalInflatedBytes += content.length;
    if (totalInflatedBytes > maxTotalBytes) {
      throw new Error('XLSX 解压后体积过大，已拒绝解析');
    }
    files.set(name, content);
  });

  return files;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  for (let index = buffer.length - 22; index >= 0; index--) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      return index;
    }
  }
  throw new Error('Invalid XLSX archive');
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const itemRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null) {
    const parts = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)];
    strings.push(parts.map((part) => decodeXml(part[1])).join(''));
  }
  return strings;
}

function parseCellValue(body: string, type: string | undefined, sharedStrings: string[]): string {
  if (type === 's') {
    const value = getXmlTagValue(body, 'v');
    return sharedStrings[Number(value)] || '';
  }
  if (type === 'inlineStr') {
    return decodeXml(getXmlTagValue(body, 't'));
  }
  return decodeXml(getXmlTagValue(body, 'v'));
}

function getXmlAttribute(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`${name}="([^"]*)"`));
  return match?.[1];
}

function getXmlTagValue(xml: string, tagName: string): string {
  const match = xml.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`));
  return match?.[1] || '';
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// 解析单元格引用中的列号（A=1 起算的 26 进制，返回 0 基索引）。
// 只接受 1-3 位列字母 + 非零行号，且列号不得超过 XLSX 规范上限（16384 列）。
function parseCellColumnIndex(ref: string): number {
  const match = CELL_REF_PATTERN.exec(ref);
  if (!match) {
    throw new Error(`XLSX 单元格引用无效: ${ref}`);
  }
  const letters = match[1].toUpperCase();
  const columnIndex = letters
    .split('')
    .reduce((index, char) => index * 26 + char.charCodeAt(0) - 64, 0) - 1;
  if (columnIndex < 0 || columnIndex >= MAX_XLSX_COLUMN_COUNT) {
    throw new Error(`XLSX 列引用超出范围: ${ref}`);
  }
  return columnIndex;
}

export const billImportService = new BillImportService();
