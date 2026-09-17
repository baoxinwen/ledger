// 分类服务封装分类表操作，账单导入会按“名称 + 类型”精确匹配分类。
import db from '../database';
import { Category } from '../types';
import { normalizeHexColor, suggestCategoryColor } from '../utils/categoryColor';
import { chunkArray } from '../utils/array';
import { HttpError } from '../utils/errors';

export class CategoryService {
  getAll(type?: 'income' | 'expense'): Category[] {
    if (type) {
      return db.prepare('SELECT * FROM categories WHERE type = ? ORDER BY sort_order').all(type) as Category[];
    }
    return db.prepare('SELECT * FROM categories ORDER BY type, sort_order').all() as Category[];
  }

  getById(id: number): Category | undefined {
    return db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as Category | undefined;
  }

  // 批量取分类，供交易列表联查去 N+1；IN 分批避免超过 SQLite 变量上限。
  getByIds(ids: number[]): Map<number, Category> {
    const map = new Map<number, Category>();
    const uniqueIds = [...new Set(ids)];
    for (const batch of chunkArray(uniqueIds, 500)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = db.prepare(`SELECT * FROM categories WHERE id IN (${placeholders})`).all(...batch) as Category[];
      rows.forEach((row) => map.set(row.id, row));
    }
    return map;
  }

  getByNameAndType(name: string, type: 'income' | 'expense'): Category | undefined {
    return db.prepare('SELECT * FROM categories WHERE name = ? AND type = ?').get(name, type) as Category | undefined;
  }

  create(data: { name: string; type: 'income' | 'expense'; icon?: string; color?: string; created_by_import_batch_id?: number }): Category {
    // 名称+类型查重：categories 表没有唯一约束，不拦截的话 API 可以创建完全重复的分类，
    // 统计按 c.id 分组会把同一分类拆成多行。导入路径已先经 getByNameAndType 复用，不受影响。
    if (this.getByNameAndType(data.name.trim(), data.type)) {
      throw new HttpError(400, '该收支类型下已存在同名分类');
    }
    const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM categories WHERE type = ?').get(data.type) as { max: number | null };
    const sortOrder = (maxOrder.max || 0) + 1;
    const color = normalizeHexColor(data.color) || this.suggestColor(data.type, data.name);

    const result = db.prepare(
      'INSERT INTO categories (name, type, icon, color, is_preset, sort_order, created_by_import_batch_id) VALUES (?, ?, ?, ?, 0, ?, ?)'
    ).run(data.name, data.type, data.icon || null, color, sortOrder, data.created_by_import_batch_id || null);

    return this.getById(result.lastInsertRowid as number)!;
  }

  suggestColor(type: 'income' | 'expense', name: string): string {
    // 建类入口统一通过这里选色，避免支付宝/微信批量导入的新分类都落到同一个默认色。
    return suggestCategoryColor(type, name, this.getAll(type));
  }

  update(id: number, data: { name?: string; icon?: string; color?: string }): Category | null {
    const category = this.getById(id);
    if (!category || category.is_preset) return null;

    let trimmedName: string | undefined;
    if (data.name) {
      trimmedName = data.name.trim();
      if (!trimmedName) {
        throw new HttpError(400, '分类名称不能为空');
      }
      const duplicate = this.getByNameAndType(trimmedName, category.type);
      if (duplicate && duplicate.id !== id) {
        throw new HttpError(400, '该收支类型下已存在同名分类');
      }
    }

    // 多字段更新放进同一事务：中途失败（如磁盘满 SQLITE_FULL）不留"名称已改、颜色未改"的半更新行。
    db.transaction(() => {
      if (trimmedName !== undefined) {
        db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(trimmedName, id);
      }
      if (data.icon !== undefined) {
        db.prepare('UPDATE categories SET icon = ? WHERE id = ?').run(data.icon, id);
      }
      if (data.color !== undefined) {
        db.prepare('UPDATE categories SET color = ? WHERE id = ?').run(data.color, id);
      }
    })();

    return this.getById(id) ?? null;
  }

  delete(id: number): boolean {
    const category = this.getById(id);
    if (!category || category.is_preset) return false;

    // 前置检查引用关系，给出明确原因而不是让外键约束抛错误导（如“引用的分类或标签不存在”）。
    const transactionCount = db.prepare('SELECT COUNT(*) as count FROM transactions WHERE category_id = ?').get(id) as { count: number };
    if (transactionCount.count > 0) {
      throw new HttpError(400, '该分类下已有交易记录，无法删除');
    }
    const budgetCount = db.prepare('SELECT COUNT(*) as count FROM budgets WHERE category_id = ?').get(id) as { count: number };
    if (budgetCount.count > 0) {
      throw new HttpError(400, '该分类已被预算使用，无法删除');
    }

    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    return true;
  }
}

export const categoryService = new CategoryService();
