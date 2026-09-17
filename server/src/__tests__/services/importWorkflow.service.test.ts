jest.mock('../../database', () => ({
  __esModule: true,
  default: require('../setup').default,
}));

import db from '../setup';
import { ImportWorkflowService } from '../../services/importWorkflow.service';

function standardFile(transactions: unknown[]): Buffer {
  return Buffer.from(JSON.stringify({ transactions }), 'utf8');
}

describe('ImportWorkflowService', () => {
  let service: ImportWorkflowService;

  beforeEach(() => {
    service = new ImportWorkflowService();
    db.exec(`
      DELETE FROM transaction_tags;
      DELETE FROM transactions;
      DELETE FROM budgets;
      DELETE FROM categories;
      DELETE FROM tags;
      DELETE FROM import_batches;
    `);
  });

  it('previews without writing and marks repeated normalized content', () => {
    const file = standardFile([
      { type: 'expense', amount: 12.34, category: '餐饮', date: '2026-01-01', note: '午餐', tags: ['工作'] },
      { type: 'expense', amount: 12.34, category: '餐饮', date: '2026-01-01', note: '午餐', tags: ['工作'] },
    ]);

    const preview = service.previewFile(file, 'ledger.json', 'auto', 1);

    expect(preview.counts).toMatchObject({ total: 2, ready: 1, contentDuplicates: 1, hardDuplicates: 0 });
    expect(preview.categoryMappings).toEqual([
      expect.objectContaining({ source: '餐饮', target: '餐饮', willCreate: true, count: 2 }),
    ]);
    expect(preview.rows.items).toHaveLength(2);
    expect(preview.selection.count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM transactions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM categories').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM import_batches').get()).toEqual({ count: 0 });
  });

  it('removes raw records and order identifiers from preview diagnostics', () => {
    const alipayCsv = Buffer.from([
      '交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注',
      '2026-01-01 08:00:00,转账,敏感对方,余额调整,不计收支,10.00,余额,交易成功,secret-trade,secret-merchant,敏感备注',
    ].join('\n'));

    const preview = service.previewFile(alipayCsv, 'alipay.csv', 'alipay', 1);

    expect(preview.diagnostics).toHaveLength(1);
    expect(preview.diagnostics[0]).not.toHaveProperty('raw');
    expect(preview.diagnostics[0]).not.toHaveProperty('source_transaction_id');
    expect(preview.diagnostics[0]).not.toHaveProperty('source_merchant_order_id');
    expect(preview.rows.items[0]).toMatchObject({
      outcome: 'skipped',
      row: 2,
      amount: 10,
      category: '转账',
      selectable: false,
      selected: false,
    });
    expect(preview.rows.items[0]).not.toHaveProperty('raw');
  });

  it('paginates, filters and selects records across the whole filtered result', () => {
    const transactions = Array.from({ length: 52 }, (_, index) => ({
      type: 'expense', amount: index + 1, category: '餐饮', date: '2026-01-01', note: `记录 ${index + 1}`,
    }));
    transactions.push({ ...transactions[0] });
    const file = standardFile(transactions);

    const preview = service.previewFile(file, 'ledger.json', 'auto', 1);
    expect(preview.rows).toMatchObject({ total: 53, page: 1, limit: 50, totalPages: 2 });
    expect(preview.rows.items).toHaveLength(50);
    expect(preview.selection.count).toBe(52);

    const duplicatePage = service.getPreviewRows(preview.previewId, 1, {
      outcome: 'content_duplicate', page: 1, limit: 50,
    });
    expect(duplicatePage.items).toHaveLength(1);
    expect(duplicatePage.items[0]).toMatchObject({ selectable: true, selected: false });

    service.updateSelection(preview.previewId, 1, {
      action: 'select', rowKeys: [duplicatePage.items[0].rowKey],
    });
    const selection = service.updateSelection(preview.previewId, 1, {
      action: 'deselect', filter: { outcome: 'ready', type: 'expense' },
    });
    expect(selection.count).toBe(1);

    const result = service.confirmFile(file, 'ledger.json', 'auto', preview.previewId, 1);
    expect(result.success).toBe(1);
    expect(result.batch.excludedCount).toBe(52);
    expect(db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE import_batch_id = ?').get(result.batch.id)).toEqual({ count: 1 });
  });

  it('confirms atomically with individually selected content duplicates', () => {
    const file = standardFile([
      { type: 'expense', amount: 12.34, category: '餐饮', date: '2026-01-01', note: '午餐', tags: ['工作'] },
      { type: 'expense', amount: 12.34, category: '餐饮', date: '2026-01-01', note: '午餐', tags: ['工作'] },
    ]);

    const preview = service.previewFile(file, 'ledger.json', 'auto', 1);
    const duplicate = service.getPreviewRows(preview.previewId, 1, { outcome: 'content_duplicate' }).items[0];
    service.updateSelection(preview.previewId, 1, { action: 'select', rowKeys: [duplicate.rowKey] });
    const result = service.confirmFile(file, 'ledger.json', 'auto', preview.previewId, 1);

    expect(result.success).toBe(2);
    expect(result.batch.status).toBe('completed');
    expect(db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE import_batch_id = ?').get(result.batch.id)).toEqual({ count: 2 });
    expect(db.prepare('SELECT amount_cents FROM transactions LIMIT 1').get()).toEqual({ amount_cents: 1234 });
    expect(db.prepare('SELECT created_by_import_batch_id FROM categories').get()).toEqual({ created_by_import_batch_id: result.batch.id });
    expect(db.prepare('SELECT created_by_import_batch_id FROM tags').get()).toEqual({ created_by_import_batch_id: result.batch.id });
  });

  it('always skips duplicate source order ids', () => {
    const file = standardFile([
      { type: 'expense', amount: 10, category: '餐饮', date: '2026-01-01', source: 'alipay', source_transaction_id: 'order-1' },
      { type: 'expense', amount: 20, category: '餐饮', date: '2026-01-02', source: 'alipay', source_transaction_id: 'order-1' },
    ]);

    const preview = service.previewFile(file, 'ledger.json', 'standard', 1);
    const result = service.confirmFile(file, 'ledger.json', 'standard', preview.previewId, 1);

    expect(result.success).toBe(1);
    expect(result.hardDuplicates).toBe(1);
  });

  it.each([
    ['wechat', '微信'],
    ['alipay', '支付宝'],
  ] as const)(
    'keeps distinct %s transactions when their content matches but source order ids differ',
    (source, sourceTag) => {
      const file = standardFile([
        {
          type: 'expense',
          amount: 20,
          category: '红包',
          date: '2026-01-01',
          note: '红包',
          tags: [sourceTag],
          source,
          source_time: '2026-01-01 08:00:00',
          source_transaction_id: `${source}-order-1`,
        },
        {
          type: 'expense',
          amount: 20,
          category: '红包',
          date: '2026-01-01',
          note: '红包',
          tags: [sourceTag],
          source,
          source_time: '2026-01-01 09:00:00',
          source_transaction_id: `${source}-order-2`,
        },
      ]);

      const preview = service.previewFile(file, 'ledger.json', 'standard', 1);

      expect(preview.counts).toMatchObject({
        total: 2,
        ready: 2,
        contentDuplicates: 0,
        hardDuplicates: 0,
      });
      expect(preview.rows.items).toEqual([
        expect.objectContaining({ outcome: 'ready', selected: true }),
        expect.objectContaining({ outcome: 'ready', selected: true }),
      ]);
    }
  );

  it('keeps a platform transaction whose source order id differs from existing matching content', () => {
    const existingFile = standardFile([{
      type: 'expense',
      amount: 20,
      category: '红包',
      date: '2026-01-01',
      note: '红包',
      tags: ['支付宝'],
      source: 'alipay',
      source_time: '2026-01-01 08:00:00',
      source_transaction_id: 'alipay-existing-order',
    }]);
    const existingPreview = service.previewFile(existingFile, 'existing.json', 'standard', 1);
    service.confirmFile(existingFile, 'existing.json', 'standard', existingPreview.previewId, 1);

    const newFile = standardFile([{
      type: 'expense',
      amount: 20,
      category: '红包',
      date: '2026-01-01',
      note: '红包',
      tags: ['支付宝'],
      source: 'alipay',
      source_time: '2026-01-01 09:00:00',
      source_transaction_id: 'alipay-new-order',
    }]);
    const preview = service.previewFile(newFile, 'new.json', 'standard', 1);

    expect(preview.counts).toMatchObject({
      total: 1,
      ready: 1,
      contentDuplicates: 0,
      hardDuplicates: 0,
    });
  });

  it('rolls back all valid rows on an unexpected database failure', () => {
    db.exec(`
      CREATE TRIGGER reject_boom BEFORE INSERT ON transactions
      WHEN NEW.note = 'boom'
      BEGIN SELECT RAISE(ABORT, 'boom'); END;
    `);
    const file = standardFile([
      { type: 'expense', amount: 10, category: '餐饮', date: '2026-01-01', note: 'ok' },
      { type: 'expense', amount: 20, category: '餐饮', date: '2026-01-02', note: 'boom' },
    ]);

    const preview = service.previewFile(file, 'ledger.json', 'auto', 1);
    expect(() => service.confirmFile(file, 'ledger.json', 'auto', preview.previewId, 1)).toThrow('boom');
    expect(db.prepare('SELECT COUNT(*) AS count FROM transactions').get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT status FROM import_batches ORDER BY id DESC LIMIT 1").get()).toEqual({ status: 'failed' });
    db.exec('DROP TRIGGER reject_boom');
  });

  it('paginates history and undoes a completed batch once', () => {
    const file = standardFile([
      { type: 'expense', amount: 10, category: '临时分类', date: '2026-01-01', tags: ['临时标签'] },
    ]);
    const preview = service.previewFile(file, 'ledger.json', 'auto', 1);
    const result = service.confirmFile(file, 'ledger.json', 'auto', preview.previewId, 1);

    const history = service.getHistory(1, 20);
    expect(history.total).toBe(1);
    expect(history.items[0]).toMatchObject({ id: result.batch.id, income: 0, expense: 10, status: 'completed' });

    const undone = service.undo(result.batch.id);
    expect(undone.undoneCount).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM transactions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM categories').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tags').get()).toEqual({ count: 0 });
    expect(() => service.undo(result.batch.id)).toThrow('已撤销');
  });

  it('repairs legacy UTF-8 filenames that were stored as latin1', () => {
    const filename = '微信支付账单.xlsx';
    const legacyFilename = Buffer.from(filename, 'utf8').toString('latin1');
    db.prepare(`
      INSERT INTO import_batches (filename, source, status)
      VALUES (?, 'wechat', 'completed')
    `).run(legacyFilename);

    expect(service.getHistory(1, 20).items[0].filename).toBe(filename);
  });

  it('expires a preview after 30 minutes of inactivity and refreshes it on access', () => {
    let now = Date.parse('2026-08-18T00:00:00Z');
    service = new ImportWorkflowService({ now: () => now });
    const file = standardFile([{ type: 'expense', amount: 10, category: '餐饮', date: '2026-01-01' }]);
    const preview = service.previewFile(file, 'ledger.json', 'auto', 1);

    now += 29 * 60 * 1000;
    expect(service.getPreviewRows(preview.previewId, 1).total).toBe(1);
    now += 29 * 60 * 1000;
    expect(service.getPreviewRows(preview.previewId, 1).total).toBe(1);
    now += 31 * 60 * 1000;
    expect(() => service.getPreviewRows(preview.previewId, 1)).toThrow(expect.objectContaining({ status: 410 }));
  });

  it('rejects confirmation when duplicate outcomes changed after preview', () => {
    const file = standardFile([{ type: 'expense', amount: 10, category: '餐饮', date: '2026-01-01', note: '午餐' }]);
    const preview = service.previewFile(file, 'ledger.json', 'auto', 1);
    const category = db.prepare("INSERT INTO categories (name, type) VALUES ('餐饮', 'expense')").run();
    db.prepare(`
      INSERT INTO transactions (type, amount_cents, category_id, note, date)
      VALUES ('expense', 1000, ?, '午餐', '2026-01-01')
    `).run(category.lastInsertRowid);

    expect(() => service.confirmFile(file, 'ledger.json', 'auto', preview.previewId, 1))
      .toThrow(expect.objectContaining({ status: 409 }));
    expect(db.prepare('SELECT COUNT(*) AS count FROM import_batches').get()).toEqual({ count: 0 });
  });

  it('超限文件必须在解析阶段快速拒绝，而不是先全量解析再报错', () => {
    // 40 万行远超 20 万行上限。此前上限检查发生在 prepare() 全量解析并逐行指纹之后，
    // 大文件会先吃满 CPU 与内存再被拒；修复后解析器在行数达到上限时立即中止。
    // 以"拒绝耗时 < 3 秒"断言解析确实被提前中止（全量解析 40 万行远超 3 秒）。
    const csv = Buffer.from(
      `日期,类型,分类,金额\n${'2026-01-01,支出,餐饮,1.00\n'.repeat(400_000)}`,
      'utf8',
    );

    const startedAt = Date.now();
    expect(() => service.previewFile(csv, 'big.csv', 'standard', 1)).toThrow('账单行数超过上限');
    expect(Date.now() - startedAt).toBeLessThan(3000);
  }, 60_000);
});
