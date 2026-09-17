import { test, expect } from '@playwright/test';
import { ensureAuthenticated } from './helpers';

const EDITORIAL_CATEGORY_COLORS = [
  '#5F6F52',
  '#4F6F6B',
  '#5C6478',
  '#8A5A61',
  '#9A7B4F',
  '#6D597A',
  '#6B7A8F',
  '#7C6F55',
  '#4F5D75',
  '#7A8450',
  '#8B6F71',
  '#5D737E',
  '#A06A4B',
  '#6D8A74',
  '#8B7D63',
  '#536271',
  '#7F5F72',
  '#466A66',
  '#9A8A4E',
  '#6E6658',
  '#59656F',
  '#8A6F47',
  '#6F7D64',
  '#766A8A',
];

test.describe('个人记账本应用', () => {
  test.beforeEach(async ({ page }) => {
    await ensureAuthenticated(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test.describe('首页仪表盘', () => {
    test('应该显示本月概览', async ({ page }) => {
      await expect(page.locator('main').getByText('本月概览')).toBeVisible();
    });

    test('应该显示收入、支出、结余卡片', async ({ page }) => {
      await expect(page.getByText('本月收入')).toBeVisible();
      await expect(page.getByText('本月支出')).toBeVisible();
      await expect(page.getByText('本月结余')).toBeVisible();
    });

    test('首页指标卡不再使用旧高饱和渐变', async ({ page }) => {
      // 先等卡片真实挂载：此前在网络空闲即取样，骨架屏阶段取到空数组使断言恒真通过。
      const homeCards = page.locator('[data-testid^="home-"][data-testid$="-card"]');
      await expect(homeCards.first()).toBeAttached();
      const backgroundImages = await homeCards.evaluateAll((cards) =>
        cards.map((card) => window.getComputedStyle(card as HTMLElement).backgroundImage)
      );
      // 数量护栏：[].every() 恒真——testid 被重命名后此断言会静默假通过，必须先确认选中了元素。
      expect(backgroundImages.length).toBeGreaterThan(0);
      expect(backgroundImages.every((backgroundImage) => backgroundImage === 'none')).toBeTruthy();
    });

    test('应该显示最近记录区域', async ({ page }) => {
      await expect(page.getByText('最近记录')).toBeVisible();
    });

    test('应该显示记一笔按钮', async ({ page }) => {
      await expect(page.getByRole('button', { name: '记一笔' })).toBeVisible();
    });

    test('点击记一笔应该原地打开全局快速记账弹窗', async ({ page }) => {
      await page.getByRole('button', { name: '记一笔' }).click();
      await expect(page).toHaveURL('/');
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByRole('spinbutton', { name: '金额' })).toBeVisible();
    });

    test('点击查看账单应该只跳转到收支记录页面', async ({ page }) => {
      await page.getByRole('button', { name: '查看账单' }).click();
      await expect(page).toHaveURL('/transactions');
      await expect(page.getByRole('dialog')).not.toBeVisible();
    });
  });

  test.describe('导航功能', () => {
    test('应该显示Logo', async ({ page }) => {
      await expect(page.getByText('ledger').first()).toBeVisible();
    });

    test('应该能够通过侧边栏导航到收支记录页面', async ({ page }) => {
      await page.locator('aside').getByRole('button', { name: '记账' }).click();
      await expect(page).toHaveURL('/transactions');
    });

    test('应该能够通过侧边栏导航到统计分析页面', async ({ page }) => {
      await page.locator('aside').getByRole('button', { name: '统计' }).click();
      await expect(page).toHaveURL('/statistics');
    });

    test('应该能够通过侧边栏导航到预算管理页面', async ({ page }) => {
      await page.locator('aside').getByRole('button', { name: '预算' }).click();
      await expect(page).toHaveURL('/budgets');
    });

    test('应该能够通过侧边栏导航到设置页面', async ({ page }) => {
      await page.locator('aside').getByRole('button', { name: '设置' }).click();
      await expect(page).toHaveURL('/settings');
    });

    test('应该能够切换深色模式', async ({ page }) => {
      await page.getByRole('button', { name: '切换主题' }).click();
    });
  });

  test.describe('收支记录页面', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/transactions');
      await page.waitForLoadState('networkidle');
    });

    test('应该显示页面标题', async ({ page }) => {
      await expect(page.locator('main').getByText('收支记录')).toBeVisible();
    });

    test('应该显示新增记录按钮', async ({ page }) => {
      await expect(page.getByRole('button', { name: '新增记录' })).toBeVisible();
    });

    test('应该显示筛选入口与搜索框', async ({ page }) => {
      await expect(page.getByRole('button', { name: /筛选/ })).toBeVisible();
      await expect(page.getByPlaceholder('搜索备注...')).toBeVisible();
    });

    test('移动端筛选收纳进面板并可展开', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await page.waitForLoadState('networkidle');

      await expect(page.getByPlaceholder('搜索备注...')).toBeVisible();
      await page.getByRole('button', { name: /筛选/ }).click();
      // Popover 面板出现，包含分类/标签/日期/金额筛选
      await expect(page.getByText('日期范围')).toBeVisible();
      await expect(page.getByText('金额范围')).toBeVisible();
    });

    test('筛选结果汇总条完整显示收入、支出、结余三段金额', async ({ page }) => {
      // 必须匹配到"收入 ¥x · 支出 ¥y · 结余 ¥z"整体结构：
      // 此前用 getByText(/收入/) 被工具条常驻的"收入"筛选 Chip 短路，金额算错也测不出。
      await expect(
        page.getByText(/收入 ¥[\d,.]+\s*·\s*支出 ¥[\d,.]+\s*·\s*结余 ¥[\d,.]+/)
      ).toBeVisible();
    });

    test('应该能够打开新增记录对话框', async ({ page }) => {
      await page.getByRole('button', { name: '新增记录' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByRole('spinbutton', { name: '金额' })).toBeVisible();
    });

    test('应该能够新增一笔支出', async ({ page }) => {
      await page.getByRole('button', { name: '新增记录' }).click();
      const dialog = page.getByRole('dialog');

      await dialog.getByRole('spinbutton', { name: '金额' }).fill('100');
      // 分类为图标网格：瓦片带 role=option
      await dialog.getByRole('option', { name: /餐饮/ }).click();
      await dialog.getByRole('textbox', { name: '备注' }).fill('测试支出');
      await dialog.getByRole('button', { name: '添加' }).click();

      await expect(page.getByRole('dialog')).not.toBeVisible();
      await expect(page.getByRole('cell', { name: '测试支出' }).first()).toBeVisible();
    });

    test('应该能够新增一笔收入', async ({ page }) => {
      await page.getByRole('button', { name: '新增记录' }).click();
      const dialog = page.getByRole('dialog');

      await dialog.getByRole('button', { name: '收入' }).click();
      await dialog.getByRole('spinbutton', { name: '金额' }).fill('5000');
      await dialog.getByRole('option', { name: /工资/ }).click();
      await dialog.getByRole('textbox', { name: '备注' }).fill('测试收入');
      await dialog.getByRole('button', { name: '添加' }).click();

      await expect(page.getByRole('dialog')).not.toBeVisible();
      await expect(page.getByRole('cell', { name: '测试收入' }).first()).toBeVisible();
    });

    test('删除记录前应该显示应用内确认弹窗', async ({ page }) => {
      await page.route('**/api/transactions**', async (route) => {
        if (route.request().method() === 'GET') {
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
              data: [{
                id: 999,
                type: 'expense',
                amount: 12.34,
                category_id: 1,
                category: { id: 1, name: '餐饮', type: 'expense', icon: '🍽️', color: '#8A5A61', is_preset: 1, sort_order: 0 },
                note: '待删除测试记录',
                date: '2026-06-23',
                tags: [],
                created_at: '2026-06-23T00:00:00.000Z',
                updated_at: '2026-06-23T00:00:00.000Z',
              }],
              total: 1,
              summary: { income: 0, expense: 12.34, count: 1 },
            }),
          });
          return;
        }

        await route.fulfill({ status: 204, body: '' });
      });
      await page.goto('/transactions');
      await page.waitForLoadState('networkidle');

      await expect(page.getByRole('cell', { name: '待删除测试记录', exact: true })).toBeVisible();
      const targetRow = page.getByRole('row').filter({ hasText: '待删除测试记录' });
      await targetRow.hover();
      await targetRow.getByRole('button', { name: '删除待删除测试记录' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByText('删除这条记录？')).toBeVisible();

      await page.getByRole('button', { name: '取消' }).click();
      await expect(page.getByRole('dialog')).not.toBeVisible();
    });
  });

  test.describe('统计分析页面', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/statistics');
      await page.waitForLoadState('networkidle');
    });

    test('应该显示页面标题', async ({ page }) => {
      await expect(page.locator('main').getByText('统计分析')).toBeVisible();
    });

    test('应该显示时间选择器', async ({ page }) => {
      await expect(page.getByRole('button', { name: '本月' })).toBeVisible();
      await expect(page.getByRole('button', { name: '本季' })).toBeVisible();
      await expect(page.getByRole('button', { name: '本年' })).toBeVisible();
      await expect(page.getByRole('button', { name: '自定义' })).toBeVisible();
    });

    test('应该显示收支概览', async ({ page }) => {
      // 环形图中心默认也显示"总支出"，这里用 .first() 兼容概览标签与图中心两处
      await expect(page.getByText('总收入', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('总支出', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('结余', { exact: true }).first()).toBeVisible();
    });

    test('有交易时显示图表，无交易时显示紧凑空态', async ({ page }) => {
      const emptyState = page.getByText('所选时间范围内没有交易记录', { exact: true });
      if (await emptyState.isVisible()) {
        await expect(page.getByText('每日收支趋势')).not.toBeVisible();
      } else {
        await expect(page.getByText('分类金额占比')).toBeVisible();
        await expect(page.getByText('每日收支趋势')).toBeVisible();
      }
    });
  });

  test.describe('预算管理页面', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/budgets');
      await page.waitForLoadState('networkidle');
    });

    test('应该显示页面标题', async ({ page }) => {
      await expect(page.locator('main').getByText('预算概览')).toBeVisible();
    });

    test('应该显示新增预算按钮', async ({ page }) => {
      await expect(page.getByRole('button', { name: '新增预算' })).toBeVisible();
    });

    test('预算总览卡不再使用旧高饱和渐变', async ({ page }) => {
      // 先等卡片真实挂载：此前在网络空闲即取样，骨架屏阶段取到空数组使断言恒真通过。
      const budgetCards = page.locator('[data-testid^="budget-"][data-testid$="-card"]');
      await expect(budgetCards.first()).toBeAttached();
      const backgroundImages = await budgetCards.evaluateAll((cards) =>
        cards.map((card) => window.getComputedStyle(card as HTMLElement).backgroundImage)
      );
      // 数量护栏：[].every() 恒真——testid 被重命名后此断言会静默假通过，必须先确认选中了元素。
      expect(backgroundImages.length).toBeGreaterThan(0);
      expect(backgroundImages.every((backgroundImage) => backgroundImage === 'none')).toBeTruthy();
    });

    test('应该能够打开新增预算对话框', async ({ page }) => {
      await page.getByRole('button', { name: '新增预算' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByRole('spinbutton', { name: '预算金额' })).toBeVisible();
    });

    test('应该能够新增预算', async ({ page }) => {
      await page.getByRole('button', { name: '新增预算' }).click();
      
      await page.getByRole('spinbutton', { name: '预算金额' }).fill('5000');
      await page.getByRole('combobox', { name: '预算周期' }).click();
      await page.getByRole('option', { name: '月度预算' }).click();
      await page.getByRole('button', { name: '创建预算' }).click();
      
      await expect(page.getByRole('dialog')).not.toBeVisible();
      await expect(page.getByText('5,000').first()).toBeVisible();
    });
  });

  test.describe('设置页面', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/settings');
      await page.waitForLoadState('networkidle');
    });

    test('应该显示页面标题', async ({ page }) => {
      await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
    });

    test('应该显示分类管理标签', async ({ page }) => {
      await expect(page.getByRole('tab', { name: '分类管理' })).toBeVisible();
    });

    test('应该显示标签管理标签', async ({ page }) => {
      await expect(page.getByRole('tab', { name: '标签管理' })).toBeVisible();
    });

    test('应该显示数据导入导出标签', async ({ page }) => {
      await expect(page.getByRole('tab', { name: '数据导入导出' })).toBeVisible();
    });

    test('应该显示支出分类', async ({ page }) => {
      await expect(page.getByText('支出分类')).toBeVisible();
      await expect(page.getByText('餐饮')).toBeVisible();
    });

    test('应该显示收入分类', async ({ page }) => {
      await expect(page.getByText('收入分类')).toBeVisible();
      await expect(page.getByText('工资')).toBeVisible();
    });

    test('应该能够切换到标签管理', async ({ page }) => {
      await page.getByRole('tab', { name: '标签管理' }).click();
      await expect(page.getByRole('textbox', { name: '新标签名称' })).toBeVisible();
    });

    test('应该能够切换到数据导入导出', async ({ page }) => {
      await page.getByRole('tab', { name: '数据导入导出' }).click();
      await expect(page.getByText('导出交易数据')).toBeVisible();
      await expect(page.getByText('导入账单')).toBeVisible();
    });
  });
});

test.describe('统计图表交互优化', () => {
  test.beforeEach(async ({ page }) => {
    const categoryStats = Array.from({ length: 10 }, (_, index) => ({
      name: `分类${index + 1}`,
      icon: '📦',
      color: '#2ECC71',
      type: 'expense',
      total: 1000 - index * 70,
    }));

    await page.route('**/api/transactions/stats**', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          totalIncome: 5000,
          totalExpense: 4200,
          balance: 800,
          transactionCount: 12,
          days: 2,
          dailyAverages: { income: 2500, expense: 2100 },
          previousPeriod: {
            startDate: '2026-05-30',
            endDate: '2026-05-31',
            totalIncome: 0,
            totalExpense: 0,
            balance: 0,
            transactionCount: 0,
            days: 2,
          },
          changes: { income: null, expense: null, transactionCount: null, balance: 800 },
          tagStats: { income: [], expense: [] },
          categoryStats: [
            ...categoryStats,
            { name: '零元分类', icon: '📦', color: '#BDC3C7', type: 'expense', total: 0 },
          ],
          dailyStats: [
            { date: '2026-06-01', type: 'income', total: 5000 },
            { date: '2026-06-02', type: 'expense', total: 4200 },
          ],
        }),
      });
    });

    await ensureAuthenticated(page);
    await page.goto('/statistics');
    await page.waitForLoadState('networkidle');
  });

  test('应该聚合过多分类、去重图例颜色并支持悬停中心信息', async ({ page }) => {
    await expect(page.getByText('分类金额占比')).toBeVisible();
    await expect(page.getByTestId('pie-legend-item-其他分类')).toBeVisible();

    const colors = await page.locator('[data-testid^="pie-legend-swatch-"]').evaluateAll((nodes) =>
      nodes.map((node) => window.getComputedStyle(node as HTMLElement).backgroundColor)
    );
    // 数量护栏：[].every() / 空集合的 Set 去重都恒真，testid 变更时不得静默假通过。
    expect(colors.length).toBeGreaterThan(0);
    expect(new Set(colors).size).toBe(colors.length);
    const hexColors = await page.locator('[data-testid^="pie-legend-swatch-"]').evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.color)
    );
    expect(hexColors.length).toBeGreaterThan(0);
    expect(hexColors.every((color) => color && EDITORIAL_CATEGORY_COLORS.includes(color))).toBeTruthy();

    await page.getByTestId('pie-legend-item-分类3').hover();
    await expect(page.getByTestId('pie-center-name')).toContainText('分类3');
  });

  test('移动端点击图例后保持选中且没有黑色焦点框', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.waitForLoadState('networkidle');

    await page.getByTestId('pie-legend-item-分类4').click();
    await expect(page.getByTestId('pie-center-name')).toContainText('分类4');

    const outlineStyles = await page.locator('.recharts-sector').evaluateAll((nodes) =>
      nodes.map((node) => window.getComputedStyle(node as SVGElement).outlineStyle)
    );
    expect(outlineStyles.every((outlineStyle) => outlineStyle === 'none')).toBeTruthy();
  });
});

test.describe('设置页布局优化', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/categories**', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 1, name: '餐饮', type: 'expense', icon: '🍽️', color: '#8A5A61', is_preset: 1, sort_order: 0 },
          { id: 2, name: '交通', type: 'expense', icon: '🚗', color: '#5D737E', is_preset: 1, sort_order: 1 },
          { id: 3, name: '工资', type: 'income', icon: '💰', color: '#5F6F52', is_preset: 1, sort_order: 0 },
        ]),
      });
    });
    await page.route('**/api/tags**', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 1, name: '支付宝', usage_count: 0 },
          { id: 2, name: '微信', usage_count: 0 },
        ]),
      });
    });
    await ensureAuthenticated(page);
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
  });

  test('分类卡片显示颜色，标签表单对齐，导入导出卡片等高', async ({ page }) => {
    await expect(page.getByTestId('category-color-餐饮')).toBeVisible();

    await page.getByRole('tab', { name: '标签管理' }).click();
    const tagInputBox = await page.getByTestId('tag-name-field').boundingBox();
    const addButtonBox = await page.getByRole('button', { name: '添加标签' }).boundingBox();
    expect(Math.round(tagInputBox?.y || 0)).toBe(Math.round(addButtonBox?.y || 0));
    expect(Math.round(tagInputBox?.height || 0)).toBe(Math.round(addButtonBox?.height || 0));

    await page.getByRole('tab', { name: '数据导入导出' }).click();
    const exportCardBox = await page.getByTestId('export-card').boundingBox();
    const importCardBox = await page.getByTestId('import-card').boundingBox();
    expect(Math.round(exportCardBox?.y || 0)).toBe(Math.round(importCardBox?.y || 0));
    expect(Math.round(exportCardBox?.height || 0)).toBe(Math.round(importCardBox?.height || 0));

    const exportJsonBox = await page.getByRole('button', { name: '导出 JSON' }).boundingBox();
    const exportCsvBox = await page.getByRole('button', { name: '导出 CSV' }).boundingBox();
    expect(exportJsonBox?.height).toBeLessThanOrEqual(40);
    expect(exportCsvBox?.height).toBeLessThanOrEqual(40);
  });

  test('移动端备份操作不挤压说明且页面无水平溢出', async ({ page }) => {
    await page.route('**/api/backups', async (route) => {
      await route.fulfill({ contentType: 'application/json', body: '[]' });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('tab', { name: '备份与恢复' }).click();

    const subtitle = page.getByText(/自动快照每天在业务时区 03:00 创建/);
    const subtitleBox = await subtitle.boundingBox();
    expect(subtitleBox?.width).toBeGreaterThan(200);
    await expect(page.getByRole('button', { name: '上传恢复' })).toBeVisible();
    await expect(page.getByRole('button', { name: '创建备份' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('移动端设置标签提供明确的横向滚动按钮', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.waitForLoadState('networkidle');

    const scrollButtons = page.locator('.MuiTabs-scrollButtons');
    await expect(scrollButtons).toHaveCount(2);
    await expect(scrollButtons.last()).toBeVisible();
    await expect(scrollButtons.last()).toBeEnabled();
  });
});
