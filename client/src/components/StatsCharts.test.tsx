// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import StatsCharts from './StatsCharts';
import type { StatsData } from '../types';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const stats = {
  totalIncome: 100,
  totalExpense: 75,
  balance: 25,
  transactionCount: 3,
  days: 3,
  dailyAverages: { income: 33.33, expense: 25 },
  previousPeriod: {
    startDate: '2025-12-29', endDate: '2025-12-31', totalIncome: 50, totalExpense: 0,
    balance: 50, transactionCount: 1, days: 3,
  },
  changes: { income: 100, expense: null, transactionCount: 200, balance: -25 },
  tagStats: {
    income: [{ id: 1, name: '奖金', total: 100, count: 1, percentage: 100 }],
    expense: [
      { id: 2, name: '工作', total: 50, count: 1, percentage: 66.67 },
      { id: 3, name: '聚餐', total: 50, count: 1, percentage: 66.67 },
    ],
  },
  categoryStats: [{ name: '餐饮', icon: 'F', color: '#8A5A61', type: 'expense' as const, total: 75 }],
  dailyStats: [
    { date: '2026-01-01', type: 'income', total: 100 },
    { date: '2026-01-02', type: 'expense', total: 50 },
    { date: '2026-01-03', type: 'expense', total: 25 },
  ],
} as StatsData;

describe('StatsCharts', () => {
  afterEach(cleanup);

  it('展示自然日日均、上期变化和默认支出标签，可切换收入标签', async () => {
    const user = userEvent.setup();
    render(<StatsCharts stats={stats} />);

    expect(screen.getByText('交易笔数')).toBeInTheDocument();
    expect(screen.getByText('3 笔')).toBeInTheDocument();
    expect(screen.getByText('自然日日均收入')).toBeInTheDocument();
    expect(screen.getByText('上期为 0')).toBeInTheDocument();
    expect(screen.getByText(/占比总和可能超过 100%/)).toBeInTheDocument();
    expect(screen.getByText('工作')).toBeInTheDocument();
    expect(screen.getByText('聚餐')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '收入标签' }));
    expect(screen.getByText('奖金')).toBeInTheDocument();
    expect(screen.queryByText('聚餐')).not.toBeInTheDocument();
  });

  it('零交易时显示紧凑空态且不挂载无意义图表', () => {
    const emptyStats: StatsData = {
      ...stats,
      totalIncome: 0,
      totalExpense: 0,
      balance: 0,
      transactionCount: 0,
      dailyAverages: { income: 0, expense: 0 },
      changes: { income: null, expense: null, transactionCount: null, balance: 0 },
      categoryStats: [],
      dailyStats: [],
      tagStats: { income: [], expense: [] },
    };

    render(<StatsCharts stats={emptyStats} />);

    expect(screen.getByText('所选时间范围内没有交易记录')).toBeInTheDocument();
    expect(screen.queryByText('每日收支趋势')).not.toBeInTheDocument();
    expect(screen.queryByText('每日净额变化')).not.toBeInTheDocument();
    expect(screen.queryByText('月度收支对比')).not.toBeInTheDocument();
    expect(screen.queryByText('分类金额排行')).not.toBeInTheDocument();
  });
});
