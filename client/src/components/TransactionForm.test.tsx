// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TransactionForm from './TransactionForm';
import { useFormMemoryStore } from '../stores/formMemoryStore';
import type { Category, Tag, TransactionWithDetails } from '../types';

const category: Category = { id: 1, name: '餐饮', type: 'expense', icon: null, color: null, is_preset: 0, sort_order: 0 };

function buildTransaction(overrides: Partial<TransactionWithDetails> = {}): TransactionWithDetails {
  return {
    id: 1,
    type: 'expense',
    amount: 12.5,
    category_id: 1,
    note: null,
    date: '2026-09-01',
    source: null,
    source_transaction_id: null,
    source_merchant_order_id: null,
    source_category: null,
    source_time: null,
    payment_method: null,
    source_status: null,
    import_batch_id: null,
    created_at: '2026-09-01 00:00:00',
    updated_at: '2026-09-01 00:00:00',
    category,
    tags: [],
    ...overrides,
  };
}

function renderForm(props: Partial<Parameters<typeof TransactionForm>[0]> = {}) {
  const onSubmit = vi.fn(async (_data: unknown) => true);
  const onClose = vi.fn();
  render(
    <TransactionForm
      open
      onClose={onClose}
      onSubmit={onSubmit}
      transaction={null}
      categories={[category]}
      tags={[]}
      onCreateTag={vi.fn(async () => null)}
      {...props}
    />,
  );
  return { onSubmit, onClose };
}

afterEach(() => {
  cleanup();
  // 复位表单记忆，避免用例间通过 persist 的 store 互相影响。
  useFormMemoryStore.setState({ transactionForm: { type: 'expense', category_id: null, date: '2026-09-04' } });
});

describe('TransactionForm', () => {
  it('编辑时清空备注必须显式提交空字符串（此前空串被静默丢弃，服务端按"未提供"跳过更新）', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm({ transaction: buildTransaction({ note: '原备注' }) });

    await user.type(screen.getByLabelText(/金额/), '20');
    await user.click(screen.getByRole('option', { name: '餐饮' }));
    await user.clear(screen.getByLabelText(/备注/));
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ note: '' });
  });

  it('"保存并再记"后已选日期必须保留（此前表单记忆写入触发默认值重置，日期被静默改回今天）', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderForm();
    const getDateInput = () => document.querySelector('input[type="date"]') as HTMLInputElement;

    await user.type(screen.getByLabelText(/金额/), '20');
    await user.click(screen.getByRole('option', { name: '餐饮' }));
    await user.click(screen.getByRole('button', { name: '昨天' }));
    const pickedDate = getDateInput().value;
    expect(pickedDate).not.toBe('');

    await user.click(screen.getByRole('button', { name: '保存并再记' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    // 提交成功写入表单记忆（分类从 null 变为 1）后，日期不得被 effect 重置。
    expect(getDateInput().value).toBe(pickedDate);
  });

  it('创建标签的慢请求返回时不得覆盖后选的已有标签（过期 onChange 回调必须丢弃）', async () => {
    const user = userEvent.setup();
    const workTag: Tag = { id: 2, name: '工作' };
    let resolveFirst!: (tag: Tag) => void;
    let createCalls = 0;
    const onCreateTag = vi.fn((name: string) => {
      createCalls += 1;
      // 第一次"新标签"请求挂起，模拟慢网络；后续重复创建立即返回。
      if (createCalls === 1) {
        return new Promise<Tag>((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve({ id: 3, name });
    });
    renderForm({ tags: [workTag], onCreateTag });

    // 回车创建"新标签"，请求挂起中
    const tagInput = screen.getByLabelText('标签');
    await user.type(tagInput, '新标签');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onCreateTag).toHaveBeenCalledTimes(1));

    // 请求返回前从下拉中点选已有标签"工作"
    await user.click(tagInput);
    await user.click(await screen.findByRole('option', { name: '工作' }));
    await waitFor(() => expect(screen.getByText('工作')).toBeInTheDocument());

    // 慢的第一次请求此时才返回：只包含"新标签"的过期结果不得覆盖 ["新标签", "工作"]
    resolveFirst({ id: 3, name: '新标签' });
    await waitFor(() => expect(screen.getByText('新标签')).toBeInTheDocument());
    expect(screen.getByText('工作')).toBeInTheDocument();
  });
});
