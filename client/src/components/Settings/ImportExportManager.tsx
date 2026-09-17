import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid,
  MenuItem,
  Pagination,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { FileDownloadOutlined as FileDownloadIcon } from '@mui/icons-material';
import { importExportApi, getApiErrorMessage } from '../../api';
import { useSnackbarStore } from '../../stores/snackbarStore';
import type {
  ImportBatch,
  ImportFileSource,
  ImportHistory,
  ImportPreview,
  ImportPreviewFilter,
  ImportPreviewOutcome,
  ImportSelectionSummary,
} from '../../types';
import { formatAmount, formatUtcAwareDateTime } from '../../utils/format';
import { ConfirmDialog, SectionCard } from '../ui';

interface ImportExportManagerProps {
  onImportComplete: () => void;
}

type PreviewRow = ImportPreview['rows']['items'][number];
const PREVIEW_PAGE_LIMIT = 50;
const EMPTY_HISTORY: ImportHistory = { items: [], total: 0, page: 1, limit: 20, totalPages: 0 };
const EMPTY_SELECTION: ImportSelectionSummary = { count: 0, income: 0, expense: 0 };

const OUTCOME_LABELS: Record<ImportPreviewOutcome, string> = {
  ready: '可导入',
  hard_duplicate: '订单重复',
  content_duplicate: '内容重复',
  skipped: '已跳过',
  failed: '失败',
};

export default function ImportExportManager({ onImportComplete }: ImportExportManagerProps) {
  const { showSnackbar } = useSnackbarStore();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const [importSource, setImportSource] = useState<ImportFileSource>('auto');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewFilter, setPreviewFilter] = useState<ImportPreviewFilter>({});
  const [previewRowsLoading, setPreviewRowsLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [history, setHistory] = useState<ImportHistory>(EMPTY_HISTORY);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [expandedBatchId, setExpandedBatchId] = useState<number | null>(null);
  const [undoTarget, setUndoTarget] = useState<ImportBatch | null>(null);
  const [undoing, setUndoing] = useState(false);
  // "总行数"视图下批量选择会把内容重复行一并选中：先经用户确认，避免静默导入重复账目。
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  // 预览行请求代际：快速切换筛选时丢弃过期响应，防止表格与筛选标签不一致。
  const previewRowsRequestId = useRef(0);

  // 历史分页请求代际：快速连点分页时丢弃后到的过期响应，防止列表与分页器停在旧页。
  const historyRequestId = useRef(0);
  const loadHistory = useCallback(async (page = 1) => {
    const requestId = ++historyRequestId.current;
    try {
      setHistoryLoading(true);
      const response = await importExportApi.getHistory(page, 20);
      if (requestId !== historyRequestId.current) return; // 已有更新的分页请求，丢弃过期响应
      setHistory(response.data);
    } catch (error) {
      console.error('Failed to load import history:', error);
      if (requestId === historyRequestId.current) showSnackbar('加载导入历史失败', 'error');
    } finally {
      if (requestId === historyRequestId.current) setHistoryLoading(false);
    }
  }, [showSnackbar]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const handleExport = async (format: 'json' | 'csv') => {
    try {
      const response = await importExportApi.export(format);
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.download = `ledger-export.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      showSnackbar('导出成功', 'success');
    } catch (error) {
      console.error('Failed to export:', error);
      showSnackbar('导出失败，请重试', 'error');
    }
  };

  const closePreview = useCallback(() => {
    if (preview) void importExportApi.deletePreview(preview.previewId).catch(() => undefined);
    setPreview(null);
    setSelectedFile(null);
    setPreviewFilter({});
  }, [preview]);

  const handlePreviewError = useCallback((error: unknown, fallback = '加载预览记录失败') => {
    const response = (error as { response?: { status?: number; data?: { error?: string } } }).response;
    const message = response?.data?.error;
    if (response?.status === 410 || response?.status === 409) {
      setPreview(null);
      setSelectedFile(null);
      setPreviewFilter({});
      showSnackbar(message || '导入预览已失效，请重新预览', 'warning');
      return;
    }
    showSnackbar(message || fallback, 'error');
  }, [showSnackbar]);

  const loadPreviewRows = useCallback(async (filter: ImportPreviewFilter, page: number) => {
    if (!preview) return;
    const requestId = ++previewRowsRequestId.current;
    try {
      setPreviewRowsLoading(true);
      const response = await importExportApi.getPreviewRows(preview.previewId, {
        ...filter,
        page,
        limit: PREVIEW_PAGE_LIMIT,
      });
      if (requestId !== previewRowsRequestId.current) return; // 过期响应，丢弃
      setPreview((current) => {
        if (!current) return current;
        const selection = response.data.selection ?? current.selection ?? EMPTY_SELECTION;
        return { ...current, rows: { ...response.data, selection }, selection };
      });
    } catch (error) {
      if (requestId !== previewRowsRequestId.current) return;
      console.error('Failed to load preview rows:', error);
      handlePreviewError(error);
    } finally {
      if (requestId === previewRowsRequestId.current) setPreviewRowsLoading(false);
    }
  }, [handlePreviewError, preview]);

  const handleSelectFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void handleImportFile(file);
  };

  const handleImportFile = async (file: File) => {
    closePreview();
    try {
      setPreviewing(true);
      setSelectedFile(file);
      const response = await importExportApi.previewFile(file, importSource);
      setPreview(normalizePreview(response.data));
      setPreviewFilter({});
    } catch (error) {
      console.error('Failed to preview import:', error);
      setSelectedFile(null);
      // 透传后端具体原因（如"上传文件过大"），固定兜底文案只用于无后端信息的场景
      showSnackbar(getApiErrorMessage(error, '预览失败，请检查文件格式'), 'error');
    } finally {
      setPreviewing(false);
    }
  };

  const handleFilterChange = (filter: ImportPreviewFilter) => {
    setPreviewFilter(filter);
    void loadPreviewRows(filter, 1);
  };

  const handleRowSelection = async (row: PreviewRow, selected: boolean) => {
    if (!preview || !row.selectable) return;
    try {
      const response = await importExportApi.updatePreviewSelection(preview.previewId, {
        action: selected ? 'select' : 'deselect',
        rowKeys: [row.rowKey],
      });
      setPreview((current) => current ? {
        ...current,
        selection: response.data,
        rows: { ...current.rows, selection: response.data, items: current.rows.items.map((item) => item.rowKey === row.rowKey ? { ...item, selected } : item) },
      } : current);
    } catch (error) {
      console.error('Failed to update preview selection:', error);
      handlePreviewError(error, '更新选择失败');
    }
  };

  const handleBulkSelection = async (action: 'select' | 'deselect') => {
    if (!preview) return;
    try {
      const response = await importExportApi.updatePreviewSelection(preview.previewId, { action, filter: previewFilter });
      setPreview((current) => current ? {
        ...current,
        selection: response.data,
        rows: {
          ...current.rows,
          selection: response.data,
          items: current.rows.items.map((item) => matchesFilter(item, previewFilter) && item.selectable ? { ...item, selected: action === 'select' } : item),
        },
      } : current);
    } catch (error) {
      console.error('Failed to bulk update preview selection:', error);
      handlePreviewError(error, '更新选择失败');
    }
  };

  // 批量选择的入口：在"总行数"视图下选中会把内容重复行一并勾上，需要用户显式确认。
  const handleBulkSelectionRequest = (action: 'select' | 'deselect') => {
    if (action === 'select' && !previewFilter.outcome && (preview?.counts.contentDuplicates ?? 0) > 0) {
      setBulkConfirmOpen(true);
      return;
    }
    void handleBulkSelection(action);
  };

  const handleConfirmImport = async () => {
    if (!selectedFile || !preview) return;
    try {
      setConfirming(true);
      const response = await importExportApi.confirmFile(selectedFile, importSource, preview.previewId);
      showSnackbar(`导入完成，共写入 ${response.data.success} 条`, 'success');
      setPreview(null);
      setSelectedFile(null);
      setPreviewFilter({});
      onImportComplete();
      await loadHistory(1);
    } catch (error) {
      console.error('Failed to confirm import:', error);
      handlePreviewError(error, '导入失败，数据未写入');
    } finally {
      setConfirming(false);
    }
  };

  const handleUndo = async () => {
    if (!undoTarget) return;
    try {
      setUndoing(true);
      const response = await importExportApi.undoImport(undoTarget.id);
      showSnackbar(`已撤销 ${response.data.undoneCount} 条交易`, 'success');
      setUndoTarget(null);
      onImportComplete();
      await loadHistory(history.page);
    } catch (error) {
      console.error('Failed to undo import:', error);
      showSnackbar('撤销导入失败', 'error');
    } finally {
      setUndoing(false);
    }
  };

  return (
    <Box>
      <Box sx={{ mb: 2 }}>
        <Typography variant="h5">数据导入导出</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.25 }}>
          便携式交易数据与第三方账单
        </Typography>
      </Box>

      <Grid container spacing={3} alignItems="stretch">
        <Grid size={{ xs: 12, md: 6 }}>
          <SectionCard testId="export-card" title="导出交易数据" subtitle="JSON 保留完整交易字段，CSV 便于表格处理" contentSx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, flexWrap: 'wrap' }}>
            <Button size="small" variant="outlined" startIcon={<FileDownloadIcon />} onClick={() => handleExport('json')}>导出 JSON</Button>
            <Button size="small" variant="outlined" startIcon={<FileDownloadIcon />} onClick={() => handleExport('csv')}>导出 CSV</Button>
          </SectionCard>
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <SectionCard testId="import-card" title="导入账单" subtitle="支持标准 JSON/CSV、支付宝 CSV 和微信 XLSX" contentSx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <TextField
              select
              label="导入类型"
              size="small"
              value={importSource}
              onChange={(event) => setImportSource(event.target.value as ImportFileSource)}
              fullWidth
            >
              <MenuItem value="auto">自动识别</MenuItem>
              <MenuItem value="standard">标准 JSON/CSV</MenuItem>
              <MenuItem value="alipay">支付宝 CSV</MenuItem>
              <MenuItem value="wechat">微信 XLSX</MenuItem>
            </TextField>
            {/* 拖拽区：拖入文件与点击按钮走同一个预览入口 */}
            <Box
              onDragOver={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragActive(false);
                if (previewing) return;
                const file = event.dataTransfer.files?.[0];
                if (file) void handleImportFile(file);
              }}
              sx={{
                border: '1px dashed',
                borderColor: dragActive ? 'secondary.main' : 'divider',
                bgcolor: dragActive ? 'action.hover' : 'transparent',
                borderRadius: 1,
                px: 2,
                py: 2.5,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 1,
                textAlign: 'center',
                transition: 'border-color 160ms cubic-bezier(0.23, 1, 0.32, 1), background-color 160ms cubic-bezier(0.23, 1, 0.32, 1)',
              }}
            >
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                {dragActive ? '松开以解析文件' : '把账单文件拖到这里，或点击选择'}
              </Typography>
              <Button variant="contained" component="label" disabled={previewing}>
                {previewing ? '正在解析...' : '选择文件并预览'}
                <input type="file" hidden accept=".json,.csv,.xlsx" onChange={handleSelectFile} />
              </Button>
            </Box>
          </SectionCard>
        </Grid>
      </Grid>

      <Box sx={{ mt: 3 }}>
        <SectionCard title="导入历史" subtitle={`${history.total} 个批次`}>
          {history.items.length === 0 ? (
            <Typography variant="body2" sx={{ color: 'text.secondary', py: 3, textAlign: 'center' }}>
              {historyLoading ? '正在加载...' : '暂无导入记录'}
            </Typography>
          ) : (
            <Stack spacing={1}>
              {history.items.map((batch) => (
                <Box key={batch.id} sx={{ border: '1px solid', borderColor: 'divider', bgcolor: 'background.default' }}>
                  <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr auto', md: 'minmax(180px, 1fr) 100px 280px auto' }, gap: 1.5, alignItems: 'center', p: 1.5 }}>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="body2" noWrap sx={{ fontWeight: 700 }}>{batch.filename}</Typography>
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>{formatUtcAwareDateTime(batch.createdAt)}</Typography>
                    </Box>
                    <Chip size="small" label={formatBatchStatus(batch.status)} color={batch.status === 'completed' ? 'success' : batch.status === 'failed' ? 'error' : 'default'} />
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: { xs: 'none', md: 'block' } }}>
                      写入 {batch.successCount} · 未选择 {batch.excludedCount} · 重复 {batch.duplicateCount} · 失败 {batch.failedCount}
                    </Typography>
                    <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                      <Button size="small" onClick={() => setExpandedBatchId(expandedBatchId === batch.id ? null : batch.id)}>
                        {expandedBatchId === batch.id ? '收起' : '详情'}
                      </Button>
                      {batch.status === 'completed' && (
                        <Button size="small" color="error" onClick={() => setUndoTarget(batch)} aria-label="撤销导入">
                          撤销
                        </Button>
                      )}
                    </Stack>
                  </Box>
                  <Collapse in={expandedBatchId === batch.id}>
                    <Box sx={{ px: 1.5, pb: 1.5, borderTop: '1px solid', borderColor: 'divider', pt: 1.25 }}>
                      <Typography variant="body2">收入 {formatAmount(batch.income)} · 支出 {formatAmount(batch.expense)} · 未选择 {batch.excludedCount} 条</Typography>
                      {batch.diagnostics.length > 0 && (
                        <Box component="ul" sx={{ my: 1, pl: 2.5, color: 'text.secondary' }}>
                          {batch.diagnostics.map((item, index) => <li key={`${item.row}-${index}`}>{item.reason}</li>)}
                        </Box>
                      )}
                    </Box>
                  </Collapse>
                </Box>
              ))}
              {history.totalPages > 1 && (
                <Pagination count={history.totalPages} page={history.page} onChange={(_, page) => void loadHistory(page)} sx={{ alignSelf: 'center', pt: 1 }} />
              )}
            </Stack>
          )}
        </SectionCard>
      </Box>

      <Dialog open={Boolean(preview)} onClose={confirming ? undefined : closePreview} maxWidth="lg" fullWidth fullScreen={fullScreen}>
        <DialogTitle>导入预览</DialogTitle>
        {preview && (
          <DialogContent dividers>
            <Stack spacing={2.5}>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                <PreviewChip label={`总行数 ${preview.counts.total}`} selected={!previewFilter.outcome} onClick={() => handleFilterChange({ type: previewFilter.type })} />
                <PreviewChip label={`可导入 ${preview.counts.ready}`} color="success" selected={previewFilter.outcome === 'ready'} onClick={() => handleFilterChange({ ...previewFilter, outcome: 'ready' })} />
                <PreviewChip label={`硬重复 ${preview.counts.hardDuplicates}`} selected={previewFilter.outcome === 'hard_duplicate'} onClick={() => handleFilterChange({ ...previewFilter, outcome: 'hard_duplicate' })} />
                <PreviewChip label={`内容重复 ${preview.counts.contentDuplicates}`} color={preview.counts.contentDuplicates ? 'warning' : 'default'} selected={previewFilter.outcome === 'content_duplicate'} onClick={() => handleFilterChange({ ...previewFilter, outcome: 'content_duplicate' })} />
                <PreviewChip label={`跳过 ${preview.counts.skipped}`} selected={previewFilter.outcome === 'skipped'} onClick={() => handleFilterChange({ ...previewFilter, outcome: 'skipped' })} />
                <PreviewChip label={`失败 ${preview.counts.failed}`} color={preview.counts.failed ? 'error' : 'default'} selected={previewFilter.outcome === 'failed'} onClick={() => handleFilterChange({ ...previewFilter, outcome: 'failed' })} />
              </Box>

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} alignItems={{ sm: 'center' }}>
                <TextField
                  select
                  size="small"
                  label="收支类型"
                  value={previewFilter.type || ''}
                  onChange={(event) => handleFilterChange({ ...previewFilter, type: event.target.value ? event.target.value as 'income' | 'expense' : undefined })}
                  sx={{ minWidth: 150 }}
                >
                  <MenuItem value="">全部</MenuItem>
                  <MenuItem value="income">收入</MenuItem>
                  <MenuItem value="expense">支出</MenuItem>
                </TextField>
                <Button size="small" variant="outlined" onClick={() => handleBulkSelectionRequest('select')} disabled={!canBulkSelect(preview.rows.total, previewFilter) || previewRowsLoading || confirming}>
                  选择筛选结果
                </Button>
                <Button size="small" variant="text" onClick={() => handleBulkSelectionRequest('deselect')} disabled={!canBulkSelect(preview.rows.total, previewFilter) || previewRowsLoading || confirming}>
                  取消筛选选择
                </Button>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  已选 {preview.selection.count} 条 · 收入 {formatAmount(preview.selection.income)} · 支出 {formatAmount(preview.selection.expense)}
                </Typography>
              </Stack>

              <Alert severity={preview.counts.failed > 0 || preview.counts.skipped > 0 ? 'warning' : 'info'}>
                筛选结果 {preview.rows.total} 条 · 可导入收入 {formatAmount(preview.income)}，支出 {formatAmount(preview.expense)}；跳过和失败记录仅供核对。
              </Alert>

              <Box>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>分类映射</Typography>
                <Stack direction="row" gap={1} flexWrap="wrap">
                  {preview.categoryMappings.map((mapping) => (
                    <Chip key={`${mapping.type}:${mapping.target}`} variant="outlined" label={`${mapping.source} → ${mapping.target}${mapping.willCreate ? '（新建）' : ''} · ${mapping.count}`} />
                  ))}
                </Stack>
              </Box>

              <Box>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>导入记录（共 {preview.rows.total} 条）</Typography>
                <TableContainer sx={{ maxHeight: fullScreen ? 'none' : 390, border: '1px solid', borderColor: 'divider' }}>
                  <Table size="small" stickyHeader>
                    <TableHead><TableRow><TableCell padding="checkbox" /><TableCell>行</TableCell><TableCell>日期</TableCell><TableCell>分类</TableCell><TableCell>备注</TableCell><TableCell align="right">金额</TableCell><TableCell>结果</TableCell></TableRow></TableHead>
                    <TableBody>
                      {previewRowsLoading ? (
                        <TableRow><TableCell colSpan={7} align="center">正在加载记录...</TableCell></TableRow>
                      ) : preview.rows.items.length === 0 ? (
                        <TableRow><TableCell colSpan={7} align="center">当前筛选没有记录</TableCell></TableRow>
                      ) : preview.rows.items.map((row) => (
                        <TableRow key={row.rowKey} selected={row.selected}>
                          <TableCell padding="checkbox">
                            <Checkbox
                              checked={row.selected}
                              disabled={!row.selectable || confirming}
                              onChange={(event) => void handleRowSelection(row, event.target.checked)}
                              inputProps={{ 'aria-label': `选择第 ${row.row} 行` }}
                            />
                          </TableCell>
                          <TableCell>{row.row}</TableCell>
                          <TableCell>{row.date || '-'}</TableCell>
                          <TableCell>{row.category || '-'}</TableCell>
                          <TableCell sx={{ maxWidth: 260, whiteSpace: 'normal', wordBreak: 'break-word' }}>{row.note || '-'}</TableCell>
                          <TableCell align="right" sx={{ color: row.type === 'income' ? 'success.main' : row.type === 'expense' ? 'error.main' : 'text.secondary' }}>{row.amount === null ? '-' : formatAmount(row.amount)}</TableCell>
                          <TableCell>
                            <Stack spacing={0.25} alignItems="flex-start">
                              <Chip size="small" label={OUTCOME_LABELS[row.outcome]} color={outcomeColor(row.outcome)} variant={row.selected ? 'filled' : 'outlined'} />
                              {row.reason && <Typography variant="caption" sx={{ color: 'text.secondary', maxWidth: 230 }}>{row.reason}</Typography>}
                            </Stack>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
                {preview.rows.totalPages > 1 && (
                  <Pagination count={preview.rows.totalPages} page={preview.rows.page} onChange={(_, page) => void loadPreviewRows(previewFilter, page)} sx={{ display: 'flex', justifyContent: 'center', pt: 1.25 }} />
                )}
              </Box>
            </Stack>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={closePreview} disabled={confirming}>取消</Button>
          <Button variant="contained" onClick={handleConfirmImport} disabled={confirming || !preview || preview.selection.count === 0}>
            {confirming ? '正在导入...' : `确认导入（${preview?.selection.count || 0} 条）`}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={Boolean(undoTarget)}
        title="撤销导入"
        description={`将删除批次“${undoTarget?.filename || ''}”创建的全部交易；之后手动编辑过的交易也会删除。`}
        confirmText="确认撤销"
        loading={undoing}
        onCancel={() => setUndoTarget(null)}
        onConfirm={handleUndo}
      />

      <ConfirmDialog
        open={bulkConfirmOpen}
        title="选择结果包含内容重复记录"
        description={`当前未按结果筛选，本次将把 ${preview?.counts.contentDuplicates ?? 0} 条"内容重复"行一并选中（与已有记录的日期、金额、分类、备注、标签相同）。如只想导入新记录，请先切换到「可导入」筛选。`}
        confirmText="仍要全部选中"
        cancelText="返回调整"
        loading={confirming}
        onCancel={() => setBulkConfirmOpen(false)}
        onConfirm={() => {
          setBulkConfirmOpen(false);
          void handleBulkSelection('select');
        }}
      />
    </Box>
  );
}

function PreviewChip({ label, color = 'default', selected, onClick }: { label: string; color?: 'default' | 'success' | 'warning' | 'error'; selected: boolean; onClick: () => void }) {
  return <Chip component="button" clickable label={label} color={color} variant={selected ? 'filled' : 'outlined'} onClick={onClick} />;
}

function canBulkSelect(total: number, filter: ImportPreviewFilter): boolean {
  if (total === 0) return false;
  return !filter.outcome || filter.outcome === 'ready' || filter.outcome === 'content_duplicate';
}

function normalizePreview(value: ImportPreview): ImportPreview {
  const selection = value.selection ?? value.rows?.selection ?? EMPTY_SELECTION;
  return {
    ...value,
    selection,
    rows: {
      ...value.rows,
      selection,
    },
  };
}

function matchesFilter(row: PreviewRow, filter: ImportPreviewFilter): boolean {
  return (!filter.outcome || row.outcome === filter.outcome) && (!filter.type || row.type === filter.type);
}

function outcomeColor(outcome: ImportPreviewOutcome): 'default' | 'success' | 'warning' | 'error' {
  if (outcome === 'ready') return 'success';
  if (outcome === 'content_duplicate') return 'warning';
  if (outcome === 'failed') return 'error';
  return 'default';
}

function formatBatchStatus(status: ImportBatch['status']): string {
  if (status === 'completed') return '已完成';
  if (status === 'undone') return '已撤销';
  return '失败';
}
