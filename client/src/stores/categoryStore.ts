// 分类 store：提供分类列表缓存和刷新能力。
import { create } from 'zustand';
import { categoryApi } from '../api';
import type { Category } from '../types';

interface CategoryState {
  categories: Category[];
  loading: boolean;
  /** 拉取失败标记：让表单区分"没有分类"与"加载失败"，避免把网络故障误导为未配置。 */
  loadFailed: boolean;
  fetchCategories: (type?: 'income' | 'expense') => Promise<void>;
}

export const useCategoryStore = create<CategoryState>((set) => ({
  categories: [],
  loading: false,
  loadFailed: false,

  fetchCategories: async (type?: 'income' | 'expense') => {
    set({ loading: true });
    try {
      const response = await categoryApi.getAll(type);
      set({ categories: response.data, loadFailed: false });
    } catch (error) {
      console.error('Failed to fetch categories:', error);
      set({ loadFailed: true });
    } finally {
      set({ loading: false });
    }
  },
}));
