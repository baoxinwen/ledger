import { test, expect } from '@playwright/test';
import { ensureAuthenticated } from './helpers';

test('M4 验证：支出与收入分区都有新增按钮，收入分类可创建', async ({ page }) => {
  await ensureAuthenticated(page);
  await page.goto('/settings');
  await page.waitForLoadState('networkidle');

  // 支出、收入两个分区各有一个「新增分类」按钮
  const addButtons = page.getByRole('button', { name: '新增分类' });
  await expect(addButtons).toHaveCount(2);

  // 点击收入分区的按钮（第二个），新建分类应属于收入类型
  await addButtons.nth(1).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // 类型选择器存在且当前为「收入」
  const typeCombobox = dialog.getByRole('combobox', { name: '类型' });
  await expect(typeCombobox).toBeVisible();
  await expect(typeCombobox).toHaveText(/收入/);

  const name = `收入验证${Date.now()}`;
  await dialog.getByRole('textbox', { name: '分类名称' }).fill(name);
  await dialog.getByRole('button', { name: '创建' }).click();
  await expect(dialog).not.toBeVisible();

  // 新分类出现在收入分类区
  await expect(page.locator('main').getByText(name)).toBeVisible();
});
