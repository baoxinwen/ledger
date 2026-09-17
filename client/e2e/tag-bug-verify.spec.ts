import { test, expect } from '@playwright/test';
import { ensureAuthenticated } from './helpers';

test('H2 验证：逐字输入新标签不创建，回车才创建', async ({ page }) => {
  await ensureAuthenticated(page);
  const uniqueTag = `逐字标签${Date.now()}`;

  await page.goto('/transactions');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '新增记录' }).click();

  const tagInput = page.getByRole('dialog').locator('.MuiAutocomplete-root input');
  await tagInput.click();
  await tagInput.pressSequentially(uniqueTag, { delay: 60 });
  // 条件等待替代硬编码 sleep：输入完成后才继续（此前 waitForTimeout(800) 在慢 runner 上不够）
  await expect(tagInput).toHaveValue(uniqueTag);

  const tagsBeforeEnter = (await (await page.request.get('/api/tags')).json()) as { name: string }[];
  const partialHits = tagsBeforeEnter.filter(
    (t) => uniqueTag.startsWith(t.name) && t.name !== uniqueTag
  );
  // 逐字输入期间不应产生任何中间态标签
  expect(partialHits).toHaveLength(0);

  // 回车触发的创建请求完成后再查列表，而不是等固定毫秒数
  const tagCreated = page.waitForResponse(
    (resp) => resp.url().includes('/api/tags') && resp.request().method() === 'POST'
  );
  await tagInput.press('Enter');
  await tagCreated;

  const tagsAfterEnter = (await (await page.request.get('/api/tags')).json()) as { name: string }[];
  // 回车后才出现完整标签
  expect(tagsAfterEnter.some((t) => t.name === uniqueTag)).toBe(true);

  // 清理：删掉这次验证创建的标签，避免污染后续用例
  const created = tagsAfterEnter.find((t) => t.name === uniqueTag);
  if (created) {
    const id = (await (await page.request.get('/api/tags')).json()) as { id: number; name: string }[];
    const full = id.find((t) => t.name === uniqueTag);
    if (full) await page.request.delete(`/api/tags/${full.id}`);
  }
});
