// 数据导入导出路由：便携式导出与“预览 -> 确认 -> 历史/撤销”导入流程。
import { Router, Request, Response } from 'express';
import { transactionService } from '../services/transaction.service';
import { FileImportSource } from '../services/billImport.service';
import { importWorkflowService } from '../services/importWorkflow.service';
import { logger } from '../utils/logger';
import { buildLedgerCsv } from '../utils/csv';
import { parseMultipartToMemory } from '../utils/multipart';
import { optionalPositiveId, requirePositiveId } from '../utils/validation';
import { HttpError, isInternalSystemError } from '../utils/errors';
import { AuthenticatedRequest } from '../middleware/auth';
import { ImportOutcome, ImportSelectionUpdate, ImportTransactionType } from '../services/importWorkflow.service';

const router = Router();
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

router.get('/export', (req: Request, res: Response) => {
  const format = (req.query.format as 'json' | 'csv') || 'json';
  const data = transactionService.getAllForExport();
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=ledger-export.csv');
    res.send(buildLedgerCsv(data));
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=ledger-export.json');
  res.json({
    transactions: data.map((transaction) => ({
      date: transaction.date,
      type: transaction.type,
      category: transaction.category.name,
      amount: transaction.amount,
      tags: transaction.tags.map((tag) => tag.name),
      note: transaction.note,
      source: transaction.source,
      source_transaction_id: transaction.source_transaction_id,
      source_merchant_order_id: transaction.source_merchant_order_id,
      source_category: transaction.source_category,
      source_time: transaction.source_time,
      payment_method: transaction.payment_method,
      source_status: transaction.source_status,
    })),
  });
});

router.post('/import/preview', async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const upload = await parseMultipartToMemory(req, MAX_IMPORT_BYTES);
    if (!upload.file) return res.status(400).json({ error: '请选择导入文件' });
    const preview = importWorkflowService.previewFile(
      upload.file.buffer,
      upload.file.filename,
      normalizeSource(upload.fields.source),
      (req as AuthenticatedRequest).auth.id
    );
    logImportEvent('账单导入预览完成', {
      filename: upload.file.filename,
      source: preview.source,
      durationMs: Date.now() - startedAt,
      counts: preview.counts,
    });
    res.json(preview);
  } catch (error) {
    logImportEvent('账单导入预览失败', { durationMs: Date.now() - startedAt, error: getErrorMessage(error) }, 'error');
    sendImportError(res, error);
  }
});

router.get('/import/preview/:previewId/rows', (req: Request, res: Response) => {
  try {
    res.json(importWorkflowService.getPreviewRows(
      routeParam(req.params.previewId),
      (req as AuthenticatedRequest).auth.id,
      {
        outcome: normalizeOutcome(req.query.outcome),
        type: normalizeTransactionType(req.query.type),
        page: optionalPositiveId(req.query.page, '页码'),
        limit: optionalPositiveId(req.query.limit, '每页条数'),
      }
    ));
  } catch (error) {
    sendImportError(res, error);
  }
});

router.patch('/import/preview/:previewId/selection', (req: Request, res: Response) => {
  try {
    const body = req.body as Record<string, unknown>;
    const action = body.action;
    if (action !== 'select' && action !== 'deselect') throw new HttpError(400, '选择操作无效');
    let update: ImportSelectionUpdate;
    if (Array.isArray(body.rowKeys)) {
      if (!body.rowKeys.every((key) => typeof key === 'string' && key.length > 0)) {
        throw new HttpError(400, '预览记录标识无效');
      }
      update = { action, rowKeys: body.rowKeys as string[] };
    } else if (body.filter && typeof body.filter === 'object') {
      const filter = body.filter as Record<string, unknown>;
      update = {
        action,
        filter: {
          outcome: normalizeOutcome(filter.outcome),
          type: normalizeTransactionType(filter.type),
        },
      };
    } else {
      throw new HttpError(400, '请选择记录或筛选范围');
    }
    res.json(importWorkflowService.updateSelection(
      routeParam(req.params.previewId),
      (req as AuthenticatedRequest).auth.id,
      update
    ));
  } catch (error) {
    sendImportError(res, error);
  }
});

router.delete('/import/preview/:previewId', (req: Request, res: Response) => {
  importWorkflowService.deletePreview(routeParam(req.params.previewId), (req as AuthenticatedRequest).auth.id);
  res.status(204).end();
});

router.post('/import/confirm', async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const upload = await parseMultipartToMemory(req, MAX_IMPORT_BYTES);
    if (!upload.file) return res.status(400).json({ error: '请选择导入文件' });
    if (!upload.fields.previewId) return res.status(400).json({ error: '导入预览标识不能为空' });
    const result = importWorkflowService.confirmFile(
      upload.file.buffer,
      upload.file.filename,
      normalizeSource(upload.fields.source),
      upload.fields.previewId,
      (req as AuthenticatedRequest).auth.id
    );
    logImportEvent('账单导入确认完成', {
      filename: upload.file.filename,
      source: result.batch.source,
      batchId: result.batch.id,
      success: result.success,
      durationMs: Date.now() - startedAt,
    });
    res.json(result);
  } catch (error) {
    logImportEvent('账单导入确认失败', { durationMs: Date.now() - startedAt, error: getErrorMessage(error) }, 'error');
    sendImportError(res, error);
  }
});

router.get('/import/history', (req: Request, res: Response) => {
  const page = optionalPositiveId(req.query.page, '页码') ?? 1;
  const limit = optionalPositiveId(req.query.limit, '每页条数') ?? 20;
  res.json(importWorkflowService.getHistory(page, limit));
});

router.post('/import/history/:id/undo', (req: Request, res: Response) => {
  const id = requirePositiveId(req.params.id, '导入批次');
  res.json(importWorkflowService.undo(id));
});

function normalizeSource(value: string | undefined): FileImportSource {
  return value === 'standard' || value === 'alipay' || value === 'wechat' || value === 'auto'
    ? value
    : 'auto';
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeOutcome(value: unknown): ImportOutcome | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'ready' || value === 'hard_duplicate' || value === 'content_duplicate' || value === 'skipped' || value === 'failed') {
    return value;
  }
  throw new HttpError(400, '处理结果筛选无效');
}

function normalizeTransactionType(value: unknown): ImportTransactionType | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'income' || value === 'expense') return value;
  throw new HttpError(400, '收支类型筛选无效');
}

function sendImportError(res: Response, error: unknown): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: getErrorMessage(error) });
    return;
  }
  // 系统级错误（SQLite/文件系统）按 500 处理且不泄露内部信息（此前一切错误压成 400 并透传原文）；
  // 其余视为解析/输入问题，保留可操作的原文案。调用方已把完整错误写入服务端日志。
  if (isInternalSystemError(error)) {
    res.status(500).json({ error: '服务器内部错误' });
    return;
  }
  res.status(400).json({ error: getErrorMessage(error) });
}

function logImportEvent(message: string, details: Record<string, unknown>, level: 'info' | 'error' = 'info'): void {
  const payload = { scope: 'import', ...details };
  if (level === 'error') logger.error(message, payload);
  else logger.info(message, payload);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default router;
