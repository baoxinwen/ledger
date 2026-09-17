import { test, expect } from '@playwright/test';
import { ensureAuthenticated } from './helpers';

test.describe('错误路径', () => {
  test('错误密码登录显示错误并停留在登录页', async ({ page }) => {
    // 确保账户存在，再登出，进入未登录态
    await ensureAuthenticated(page);
    await page.request.post('/api/auth/logout');
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.getByRole('textbox', { name: '用户名' }).fill('admin');
    await page.getByRole('textbox', { name: '密码' }).fill('wrong-password');
    await page.getByRole('button', { name: '登录' }).click();

    await expect(page.getByText('用户名或密码错误')).toBeVisible();
    await expect(page.getByText('欢迎回来')).toBeVisible();
  });

  test('退出登录回到登录页且会话失效', async ({ page }) => {
    await ensureAuthenticated(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: '账户菜单' }).click();
    await page.getByRole('menuitem', { name: '退出登录' }).click();
    await expect(page.getByText('欢迎回来')).toBeVisible();

    const me = (await (await page.request.get('/api/auth/me')).json()) as { authenticated: boolean };
    expect(me.authenticated).toBe(false);
  });

  test('导入格式错误的文件显示错误提示', async ({ page }) => {
    await ensureAuthenticated(page);
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    await page.getByRole('tab', { name: '数据导入导出' }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'bad.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('this is not a valid bill'),
    });

    // 预览失败提示改为透传后端具体原因；无后端信息时兜底"预览失败，请检查文件格式"
    await expect(page.getByText('Standard CSV header row not found')).toBeVisible();
  });
});
