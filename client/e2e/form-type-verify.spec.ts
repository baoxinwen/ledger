import { test, expect } from '@playwright/test';
import { ensureAuthenticated } from './helpers';

test('M-2 验证：切换收支类型后已选分类被重置，避免类型错配', async ({ page }) => {
  await ensureAuthenticated(page);
  await page.goto('/transactions');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '新增记录' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // 填金额 + 选一个支出分类（默认支出类型）；分类为图标网格瓦片（role=option）。
  await dialog.getByRole('spinbutton', { name: '金额' }).fill('100');
  await dialog.getByRole('option', { name: /餐饮/ }).click();

  const submit = dialog.getByRole('button', { name: '添加' });
  await expect(submit).toBeEnabled();

  // 切到收入：分类应被清空 → 提交按钮禁用（修复前仍可用，会提交类型错配）
  await dialog.getByRole('button', { name: '收入' }).click();
  await expect(submit).toBeDisabled();
});
