// 导入导出路由集成测试：便携导出与预览、确认、历史、撤销工作流。
jest.mock('../../database', () => ({
  __esModule: true,
  default: require('../setup').default,
}));

import request from 'supertest';
import iconv from 'iconv-lite';
import db from '../setup';
import app from '../../app';
import { authService } from '../../services/auth.service';

async function setupAgent(): Promise<ReturnType<typeof request.agent>> {
  process.env.SETUP_TOKEN = 'import-token';
  authService.ensureSetupToken();
  const agent = request.agent(app);
  await agent.post('/api/auth/setup').send({ token: 'import-token', username: 'admin', password: 'password123' });
  delete process.env.SETUP_TOKEN;
  return agent;
}

describe('Import/Export API routes', () => {
  beforeEach(() => {
    process.env.SETUP_TOKEN = 'import-token';
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM users');
    db.exec('DELETE FROM transaction_tags');
    db.exec('DELETE FROM transactions');
    db.exec('DELETE FROM budgets');
    db.exec('DELETE FROM tags');
    db.exec('DELETE FROM categories');
    db.exec('DELETE FROM import_batches');
    db.exec("DELETE FROM app_settings WHERE key = 'setup_token_hash'");
  });

  afterEach(() => {
    delete process.env.SETUP_TOKEN;
  });

  it('导出 JSON 返回全部交易', async () => {
    const agent = await setupAgent();
    const cat = await agent.post('/api/categories').send({ name: '餐饮', type: 'expense' });
    await agent.post('/api/transactions').send({ type: 'expense', amount: 12.5, category_id: cat.body.id, note: '午餐', date: '2026-08-01' });

    const res = await agent.get('/api/export?format=json');
    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].amount).toBe(12.5);
  });

  it('导出 CSV 对公式注入前缀做转义', async () => {
    const agent = await setupAgent();
    const cat = await agent.post('/api/categories').send({ name: '餐饮', type: 'expense' });
    await agent.post('/api/transactions').send({ type: 'expense', amount: 1, category_id: cat.body.id, note: '=cmd', date: '2026-08-01' });

    const res = await agent.get('/api/export?format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain("'=cmd");
  });

  it('未登录不可导出', async () => {
    expect((await request(app).get('/api/export?format=json')).status).toBe(401);
  });

  it('标准 JSON 先预览再确认，并写入历史', async () => {
    const agent = await setupAgent();
    const file = Buffer.from(JSON.stringify({
      transactions: [{ type: 'expense', amount: 5, category: '餐饮', date: '2026-08-01' }],
    }));
    const preview = await agent.post('/api/import/preview').attach('file', file, 'ledger.json').field('source', 'auto');
    expect(preview.status).toBe(200);
    expect(preview.body.counts).toMatchObject({ total: 1, ready: 1 });
    expect(preview.body.rows).toMatchObject({ total: 1, page: 1, limit: 50 });
    expect(preview.body.selection.count).toBe(1);
    expect((await agent.get('/api/transactions')).body.total).toBe(0);

    const confirm = await agent.post('/api/import/confirm')
      .attach('file', file, 'ledger.json')
      .field('source', 'auto')
      .field('previewId', preview.body.previewId);
    expect(confirm.status).toBe(200);
    expect(confirm.body.success).toBe(1);
    expect((await agent.get('/api/transactions')).body.total).toBe(1);
    const history = await agent.get('/api/import/history?page=1&limit=20');
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0].status).toBe('completed');
  });

  it('标准 JSON 预览把非法类型计入失败且不写库', async () => {
    const agent = await setupAgent();
    const file = Buffer.from(JSON.stringify({
      transactions: [{ type: 'INCOME', amount: 5, category: '餐饮', date: '2026-08-01' }],
    }));
    const res = await agent.post('/api/import/preview').attach('file', file, 'ledger.json').field('source', 'auto');
    expect(res.body.counts.failed).toBe(1);
    expect((await agent.get('/api/transactions')).body.total).toBe(0);
  });

  it('支付宝 CSV 可预览并确认', async () => {
    const agent = await setupAgent();
    const csv = [
      '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,',
      '2018-12-31 17:16:48,餐饮美食,店铺,/,奶茶,支出,9.68,余额,交易成功,order-1,merchant-1,,',
    ].join('\n');
    const buffer = iconv.encode(csv, 'gb18030');

    const preview = await agent
      .post('/api/import/preview')
      .attach('file', buffer, 'alipay.csv')
      .field('source', 'auto');
    expect(preview.status).toBe(200);
    expect(preview.body.source).toBe('alipay');

    const confirm = await agent
      .post('/api/import/confirm')
      .attach('file', buffer, 'alipay.csv')
      .field('source', 'auto')
      .field('previewId', preview.body.previewId);
    expect(confirm.status).toBe(200);
    expect(confirm.body.success).toBe(1);
  });

  it('multipart 缺少文件返回 400', async () => {
    const agent = await setupAgent();
    const res = await agent.post('/api/import/preview').field('source', 'auto');
    expect(res.status).toBe(400);
  });

  it('分页筛选并跨页更新选择状态', async () => {
    const agent = await setupAgent();
    const transactions = Array.from({ length: 51 }, (_, index) => ({
      type: 'expense', amount: index + 1, category: '餐饮', date: '2026-08-01', note: `记录 ${index + 1}`,
    }));
    transactions.push({ ...transactions[0] });
    const file = Buffer.from(JSON.stringify({ transactions }));
    const preview = await agent.post('/api/import/preview').attach('file', file, 'ledger.json').field('source', 'auto');

    const page = await agent.get(`/api/import/preview/${preview.body.previewId}/rows`)
      .query({ outcome: 'content_duplicate', type: 'expense', page: 1, limit: 50 });
    expect(page.status).toBe(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.items[0]).toMatchObject({ outcome: 'content_duplicate', selected: false, selectable: true });

    const selection = await agent.patch(`/api/import/preview/${preview.body.previewId}/selection`).send({
      action: 'deselect', filter: { outcome: 'ready', type: 'expense' },
    });
    expect(selection.status).toBe(200);
    expect(selection.body.count).toBe(0);

    const selectDuplicate = await agent.patch(`/api/import/preview/${preview.body.previewId}/selection`).send({
      action: 'select', rowKeys: [page.body.items[0].rowKey],
    });
    expect(selectDuplicate.body.count).toBe(1);

    const confirm = await agent.post('/api/import/confirm')
      .attach('file', file, 'ledger.json')
      .field('source', 'auto')
      .field('previewId', preview.body.previewId);
    expect(confirm.status).toBe(200);
    expect(confirm.body.batch.excludedCount).toBe(51);
  });

  it('返回预览过期和文件变化的明确状态码', async () => {
    const agent = await setupAgent();
    const missing = await agent.get('/api/import/preview/not-found/rows');
    expect(missing.status).toBe(410);

    const file = Buffer.from(JSON.stringify({ transactions: [
      { type: 'expense', amount: 5, category: '餐饮', date: '2026-08-01' },
    ] }));
    const preview = await agent.post('/api/import/preview').attach('file', file, 'ledger.json').field('source', 'auto');
    const changed = Buffer.from(JSON.stringify({ transactions: [
      { type: 'expense', amount: 6, category: '餐饮', date: '2026-08-01' },
    ] }));
    const confirm = await agent.post('/api/import/confirm')
      .attach('file', changed, 'ledger.json')
      .field('source', 'auto')
      .field('previewId', preview.body.previewId);
    expect(confirm.status).toBe(409);
    expect((await agent.get('/api/transactions')).body.total).toBe(0);
  });

  it('可以主动释放预览会话', async () => {
    const agent = await setupAgent();
    const file = Buffer.from(JSON.stringify({ transactions: [
      { type: 'expense', amount: 5, category: '餐饮', date: '2026-08-01' },
    ] }));
    const preview = await agent.post('/api/import/preview').attach('file', file, 'ledger.json').field('source', 'auto');
    expect((await agent.delete(`/api/import/preview/${preview.body.previewId}`)).status).toBe(204);
    expect((await agent.get(`/api/import/preview/${preview.body.previewId}/rows`)).status).toBe(410);
  });

  it('可以从历史撤销已完成批次', async () => {
    const agent = await setupAgent();
    const file = Buffer.from(JSON.stringify({ transactions: [
      { type: 'expense', amount: 5, category: '餐饮', date: '2026-08-01' },
    ] }));
    const preview = await agent.post('/api/import/preview').attach('file', file, 'ledger.json').field('source', 'auto');
    const confirm = await agent.post('/api/import/confirm')
      .attach('file', file, 'ledger.json')
      .field('source', 'auto')
      .field('previewId', preview.body.previewId);

    const undo = await agent.post(`/api/import/history/${confirm.body.batch.id}/undo`);
    expect(undo.status).toBe(200);
    expect(undo.body.undoneCount).toBe(1);
    expect((await agent.get('/api/transactions')).body.total).toBe(0);
    expect((await agent.post(`/api/import/history/${confirm.body.batch.id}/undo`)).status).toBe(400);
  });
});
