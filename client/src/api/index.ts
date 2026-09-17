// API 客户端集中封装所有后端请求，页面和 store 不直接拼接接口地址。
import axios from 'axios';
import type {
  TransactionFilter,
  TransactionWithDetails,
  Category,
  Tag,
  StatsData,
  Budget,
  BudgetStatus,
  AppSettings,
  ImportFileSource,
  ImportPreview,
  ImportBatch,
  ImportHistory,
  ImportPreviewFilter,
  ImportPreviewRows,
  ImportPreviewSelectionUpdate,
  AuthUser,
  AuthStatus,
  BackupRecord,
  TransactionDetail,
} from '../types';

const api = axios.create({
  baseURL: '/api',
});

// 供 authStore 注册 401 拦截器（登录过期时自动回到登录页）。
export { api as http };

// 从 Axios 错误中提取后端返回的中文错误信息，供页面统一提示；
// 后端不可达或返回结构异常时回退到调用方提供的兜底文案。
export function getApiErrorMessage(error: unknown, fallback: string): string {
  const response = (error as { response?: { data?: { error?: unknown } } } | undefined)?.response;
  const message = response?.data?.error;
  return typeof message === 'string' && message ? message : fallback;
}

export const authApi = {
  me: () =>
    api.get<AuthStatus>('/auth/me'),
  setup: (data: { token: string; username: string; password: string }) =>
    api.post<{ user: AuthUser }>('/auth/setup', data),
  login: (data: { username: string; password: string }) =>
    api.post<{ user: AuthUser }>('/auth/login', data),
  logout: () =>
    api.post<{ ok: boolean }>('/auth/logout'),
};

/** 记账表单提交载荷：create 与表单链路共用，替代 any 让字段拼错在编译期暴露。 */
export type TransactionPayload = {
  type: 'income' | 'expense';
  amount: number;
  category_id: number;
  note?: string;
  date: string;
  tag_ids?: number[];
};

export const transactionApi = {
  getAll: (filter: TransactionFilter = {}) =>
    api.get<{
      data: TransactionWithDetails[];
      total: number;
      /** 当前筛选全量汇总（非当前页）：汇总条数据源 */
      summary: { income: number; expense: number; count: number };
    }>('/transactions', { params: filter }),
  getById: (id: number) =>
    api.get<TransactionDetail>(`/transactions/${id}`),
  create: (data: TransactionPayload) =>
    api.post<TransactionWithDetails>('/transactions', data),
  update: (id: number, data: Partial<TransactionWithDetails>) =>
    api.put<TransactionWithDetails>(`/transactions/${id}`, data),
  delete: (id: number) =>
    api.delete(`/transactions/${id}`),
  getStats: (params: { start_date?: string; end_date?: string; type?: 'income' | 'expense' }) =>
    api.get<StatsData>('/transactions/stats', { params }),
};

export const categoryApi = {
  getAll: (type?: 'income' | 'expense') =>
    api.get<Category[]>('/categories', { params: { type } }),
  create: (data: { name: string; type: 'income' | 'expense'; icon?: string; color?: string }) =>
    api.post<Category>('/categories', data),
  update: (id: number, data: { name?: string; icon?: string; color?: string }) =>
    api.put<Category>(`/categories/${id}`, data),
  delete: (id: number) =>
    api.delete(`/categories/${id}`),
};

export const tagApi = {
  getAll: () =>
    api.get<Tag[]>('/tags'),
  create: (name: string) =>
    api.post<Tag>('/tags', { name }),
  delete: (id: number) =>
    api.delete(`/tags/${id}`),
};

export const budgetApi = {
  getAll: () =>
    api.get<Budget[]>('/budgets'),
  getStatus: (month: string) =>
    api.get<BudgetStatus[]>('/budgets/status', { params: { month } }),
  create: (data: { category_id?: number | null; amount: number; period: 'monthly' | 'yearly'; start_date: string }) =>
    api.post<Budget>('/budgets', data),
  update: (id: number, data: Partial<Budget>) =>
    api.put<Budget>(`/budgets/${id}`, data),
  delete: (id: number) =>
    api.delete(`/budgets/${id}`),
};

export const settingsApi = {
  get: () =>
    api.get<AppSettings>('/settings'),
  update: (data: Partial<AppSettings>) =>
    api.put<AppSettings>('/settings', data),
};

export const importExportApi = {
  export: (format: 'json' | 'csv') =>
    api.get('/export', { params: { format }, responseType: 'blob' }),
  previewFile: (file: File, source: ImportFileSource) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('source', source);
    return api.post<ImportPreview>('/import/preview', formData);
  },
  getPreviewRows: (previewId: string, filter: ImportPreviewFilter & { page?: number; limit?: number } = {}) =>
    api.get<ImportPreviewRows>(`/import/preview/${encodeURIComponent(previewId)}/rows`, { params: filter }),
  updatePreviewSelection: (previewId: string, update: ImportPreviewSelectionUpdate) =>
    api.patch<{ count: number; income: number; expense: number }>(`/import/preview/${encodeURIComponent(previewId)}/selection`, update),
  deletePreview: (previewId: string) =>
    api.delete(`/import/preview/${encodeURIComponent(previewId)}`),
  confirmFile: (file: File, source: ImportFileSource, previewId: string) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('source', source);
    formData.append('previewId', previewId);
    return api.post<{ batch: ImportBatch; success: number; hardDuplicates: number; contentDuplicates: number }>('/import/confirm', formData);
  },
  getHistory: (page = 1, limit = 20) =>
    api.get<ImportHistory>('/import/history', { params: { page, limit } }),
  undoImport: (id: number) =>
    api.post<{ batch: ImportBatch; undoneCount: number }>(`/import/history/${id}/undo`),
};

export const backupApi = {
  list: () => api.get<BackupRecord[]>('/backups'),
  create: () => api.post<BackupRecord>('/backups'),
  download: (id: string) => api.get(`/backups/${encodeURIComponent(id)}/download`, { responseType: 'blob' }),
  delete: (id: string) => api.delete(`/backups/${encodeURIComponent(id)}`),
  restore: (id: string) => api.post<{ ok: boolean; requiresLogin: boolean }>(`/backups/${encodeURIComponent(id)}/restore`),
  restoreUpload: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post<{ ok: boolean; requiresLogin: boolean }>('/backups/restore', formData);
  },
};
