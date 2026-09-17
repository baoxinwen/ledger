// 收支记录页：顶部工具条（搜索/类型/筛选面板）+ 筛选结果汇总条 + 紧凑列表 + 详情抽屉。
import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Box,
  Button,
  Typography,
  Card,
  CardContent,
  TextField,
  MenuItem,
  Chip,
  InputAdornment,
  Popover,
  Badge,
  useTheme,
  useMediaQuery,
} from '@mui/material';
import {
  Add as AddIcon,
  FilterList as FilterListIcon,
  Search as SearchIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTransactionStore } from '../stores/transactionStore';
import { useCategoryStore } from '../stores/categoryStore';
import { useTagStore } from '../stores/tagStore';
import { useQuickAddStore } from '../stores/quickAddStore';
import { useSnackbarStore } from '../stores/snackbarStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useZonedToday } from '../hooks/useZonedToday';
import type { TransactionWithDetails, TransactionFilter } from '../types';
import { transactionApi, getApiErrorMessage, type TransactionPayload } from '../api';
import { formatAmount } from '../utils/format';
import TransactionList from '../components/TransactionList';
import TransactionForm from '../components/TransactionForm';
import TransactionDetailDrawer from '../components/TransactionDetailDrawer';
import { ConfirmDialog, PageHeader } from '../components/ui';

export default function TransactionsPage() {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const location = useLocation();
  const navigate = useNavigate();
  const { id: transactionIdParam } = useParams();
  const transactionId = transactionIdParam && /^\d+$/.test(transactionIdParam) ? Number(transactionIdParam) : null;
  const { transactions, total, summary, filter, loading, dataVersion, fetchTransactions, setFilter, notifyDataChanged } = useTransactionStore();
  const { categories, fetchCategories } = useCategoryStore();
  const { tags, fetchTags, createTag } = useTagStore();
  const openQuickAdd = useQuickAddStore((state) => state.openQuickAdd);
  const { showSnackbar } = useSnackbarStore();
  const timeZone = useSettingsStore((state) => state.settings.time_zone);
  const today = useZonedToday(timeZone);

  const [editingTransaction, setEditingTransaction] = useState<TransactionWithDetails | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TransactionWithDetails | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [detailRefreshKey, setDetailRefreshKey] = useState(0);
  const [keywordInput, setKeywordInput] = useState(filter.keyword || '');
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // 始终持有最新 filter，供防抖回调读取，避免闭包捕获过期筛选条件（如在防抖窗口内切换了类型/分类）。
  const filterRef = useRef(filter);
  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);

  const handleFilterChange = useCallback((newFilter: TransactionFilter) => {
    setFilter(newFilter);
    fetchTransactions(newFilter).catch(() => showSnackbar('加载记录失败，请重试', 'error'));
  }, [setFilter, fetchTransactions, showSnackbar]);

  useEffect(() => {
    // 不传 {} 以保留 store 中上次的筛选条件（含分页与关键词），跨页面返回时恢复原视图。
    fetchTransactions().catch(() => showSnackbar('加载记录失败，请重试', 'error'));
    fetchCategories();
    fetchTags();
  }, [fetchCategories, fetchTags, fetchTransactions, showSnackbar]);

  // 全局记一笔/编辑/删除后重拉当前视图。
  // 用 ref 记录上次见过的版本号：挂载时数据由上方 effect 拉取，这里只在版本真正变化时补拉，
  // 避免"挂载 effect + dataVersion effect"双重请求。
  const lastDataVersion = useRef(dataVersion);
  useEffect(() => {
    if (dataVersion === lastDataVersion.current) return;
    lastDataVersion.current = dataVersion;
    if (dataVersion > 0) {
      fetchTransactions().catch(() => undefined);
    }
  }, [dataVersion, fetchTransactions]);

  // Debounce keyword search
  useEffect(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    debounceTimer.current = setTimeout(() => {
      const latestFilter = filterRef.current;
      if (keywordInput !== (latestFilter.keyword || '')) {
        handleFilterChange({ ...latestFilter, keyword: keywordInput || undefined, page: 1 });
      }
    }, 400);
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [handleFilterChange, keywordInput]);

  const handleClearFilter = () => {
    const defaultFilter: TransactionFilter = { page: 1, limit: 20 };
    setFilter(defaultFilter);
    setKeywordInput('');
    fetchTransactions(defaultFilter).catch(() => showSnackbar('加载记录失败，请重试', 'error'));
  };

  const handlePageChange = (page: number) => {
    handleFilterChange({ ...filter, page });
  };

  const handleRowsPerPageChange = (limit: number) => {
    handleFilterChange({ ...filter, limit, page: 1 });
  };

  // 提交结果以 boolean 返回给表单：失败时表单保持打开、用户输入不丢失（修复"假成功"）。
  const handleUpdate = async (data: TransactionPayload): Promise<boolean> => {
    if (!editingTransaction) return false;
    try {
      await transactionApi.update(editingTransaction.id, data);
    } catch (err) {
      showSnackbar(getApiErrorMessage(err, '更新记录失败，请重试'), 'error');
      console.error('Failed to update transaction:', err);
      return false;
    }
    // 更新已成功；列表刷新由 notifyDataChanged → dataVersion effect 统一驱动，
    // 这里不再手动 fetchTransactions（同一保存会发出两个并发请求，多拉一次）。
    setDetailRefreshKey((value) => value + 1);
    showSnackbar('记录更新成功', 'success');
    notifyDataChanged();
    return true;
  };

  const handleDelete = (transaction: TransactionWithDetails) => {
    setDeleteTarget(transaction);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;


    try {
      setDeleting(true);
      const deletedDetail = transactionId === deleteTarget.id;
      await transactionApi.delete(deleteTarget.id);
      showSnackbar('记录删除成功', 'success');
      setDeleteTarget(null);
      // 删掉当前页最后一条且不在第一页时回退一页，否则重拉会对超界 offset 返回空列表，
      // 页面停在"暂无记录"的越界空页上，而前面页仍有数据。
      if (transactions.length === 1 && (filter.page ?? 1) > 1) {
        setFilter({ ...filter, page: (filter.page ?? 1) - 1 });
      }
      notifyDataChanged();
      if (deletedDetail) handleCloseDetail();
    } catch (err) {
      showSnackbar('删除记录失败，请重试', 'error');
      console.error('Failed to delete transaction:', err);
    } finally {
      setDeleting(false);
    }
  };

  const handleEdit = (transaction: TransactionWithDetails) => {
    setEditingTransaction(transaction);
    setFormOpen(true);
  };

  const handleView = (transaction: TransactionWithDetails) => {
    navigate(`/transactions/${transaction.id}`, { state: { detailFromList: true } });
  };

  const handleCloseDetail = () => {
    const state = location.state as { detailFromList?: boolean } | null;
    if (state?.detailFromList) navigate(-1);
    else navigate('/transactions', { replace: true });
  };

  const handleCloseForm = () => {
    setFormOpen(false);
    setEditingTransaction(null);
  };

  const hasFilters = filter.type || filter.category_id != null || filter.tag_id != null ||
    filter.start_date || filter.end_date || filter.keyword ||
    filter.min_amount != null || filter.max_amount != null;

  const hasAmountError = filter.min_amount != null && filter.max_amount != null &&
    filter.min_amount > filter.max_amount;

  const activeFilterCount = [
    filter.type,
    filter.category_id,
    filter.tag_id,
    filter.start_date,
    filter.end_date,
    filter.keyword,
    filter.min_amount,
    filter.max_amount,
  ].filter((value) => value !== undefined && value !== null && value !== '').length;

  // 已选筛选 chips（可单独删除）
  const categoryName = categories.find((c) => c.id === filter.category_id)?.name;
  const tagName = tags.find((t) => t.id === filter.tag_id)?.name;
  const activeChips: Array<{ label: string; onRemove: () => void }> = [];
  if (filter.keyword) {
    activeChips.push({ label: `备注含「${filter.keyword}」`, onRemove: () => { setKeywordInput(''); handleFilterChange({ ...filterRef.current, keyword: undefined, page: 1 }); } });
  }
  if (filter.type) {
    activeChips.push({ label: filter.type === 'expense' ? '支出' : '收入', onRemove: () => handleFilterChange({ ...filterRef.current, type: undefined, page: 1 }) });
  }
  if (categoryName) {
    activeChips.push({ label: `分类 ${categoryName}`, onRemove: () => handleFilterChange({ ...filterRef.current, category_id: undefined, page: 1 }) });
  }
  if (tagName) {
    activeChips.push({ label: `标签 ${tagName}`, onRemove: () => handleFilterChange({ ...filterRef.current, tag_id: undefined, page: 1 }) });
  }
  if (filter.start_date || filter.end_date) {
    activeChips.push({
      label: `${filter.start_date ?? '…'} ~ ${filter.end_date ?? '…'}`,
      onRemove: () => handleFilterChange({ ...filterRef.current, start_date: undefined, end_date: undefined, page: 1 }),
    });
  }
  if (filter.min_amount != null || filter.max_amount != null) {
    activeChips.push({
      label: `金额 ${filter.min_amount ?? '0'}-${filter.max_amount ?? '∞'}`,
      onRemove: () => handleFilterChange({ ...filterRef.current, min_amount: undefined, max_amount: undefined, page: 1 }),
    });
  }

  const balance = summary ? summary.income - summary.expense : null;

  const filterPanel = (
    <Box sx={{ width: isMobile ? 'auto' : 320, p: 2 }}>
      <Box sx={{ mb: 2.5 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', mb: 1, display: 'block' }}>分类</Typography>
        <TextField
          select
          fullWidth
          size="small"
          value={filter.category_id ?? ''}
          onChange={(e) => handleFilterChange({ ...filterRef.current, category_id: e.target.value ? Number(e.target.value) : undefined, page: 1 })}
        >
          <MenuItem value="">全部分类</MenuItem>
          {categories.map((cat) => (
            <MenuItem key={cat.id} value={cat.id}>
              {cat.icon} {cat.name}
            </MenuItem>
          ))}
        </TextField>
      </Box>

      <Box sx={{ mb: 2.5 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', mb: 1, display: 'block' }}>标签</Typography>
        <TextField
          select
          fullWidth
          size="small"
          value={filter.tag_id ?? ''}
          onChange={(e) => handleFilterChange({ ...filterRef.current, tag_id: e.target.value ? Number(e.target.value) : undefined, page: 1 })}
        >
          <MenuItem value="">全部标签</MenuItem>
          {tags.map((tag) => (
            <MenuItem key={tag.id} value={tag.id}>{tag.name}</MenuItem>
          ))}
        </TextField>
      </Box>

      <Box sx={{ mb: 2.5 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', mb: 1, display: 'block' }}>日期范围</Typography>
        <TextField
          type="date"
          fullWidth
          size="small"
          label="开始日期"
          value={filter.start_date || ''}
          onChange={(e) => handleFilterChange({ ...filterRef.current, start_date: e.target.value || undefined, page: 1 })}
          InputLabelProps={{ shrink: true }}
          sx={{ mb: 1.5 }}
        />
        <TextField
          type="date"
          fullWidth
          size="small"
          label="结束日期"
          value={filter.end_date || ''}
          onChange={(e) => handleFilterChange({ ...filterRef.current, end_date: e.target.value || undefined, page: 1 })}
          InputLabelProps={{ shrink: true }}
        />
      </Box>

      <Box sx={{ mb: 1 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', mb: 1, display: 'block' }}>金额范围</Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <TextField
            type="number"
            size="small"
            placeholder="最小"
            value={filter.min_amount ?? ''}
            onChange={(e) => handleFilterChange({ ...filterRef.current, min_amount: e.target.value !== '' ? Number(e.target.value) : undefined, page: 1 })}
            fullWidth
            error={hasAmountError}
          />
          <Typography sx={{ color: 'text.secondary' }}>—</Typography>
          <TextField
            type="number"
            size="small"
            placeholder="最大"
            value={filter.max_amount ?? ''}
            onChange={(e) => handleFilterChange({ ...filterRef.current, max_amount: e.target.value !== '' ? Number(e.target.value) : undefined, page: 1 })}
            fullWidth
            error={hasAmountError}
          />
        </Box>
        {hasAmountError && (
          <Typography variant="caption" color="error" sx={{ mt: 0.5, display: 'block' }}>
            最小值不能大于最大值
          </Typography>
        )}
      </Box>

      {hasFilters && (
        <Button fullWidth onClick={handleClearFilter} sx={{ mt: 1, color: 'text.secondary' }}>
          清除所有筛选
        </Button>
      )}
    </Box>
  );

  return (
    <Box>
      <PageHeader
        eyebrow="财务记录"
        title="收支记录"
        meta={summary ? `共 ${summary.count} 笔记录` : `共 ${total} 条记录`}
        action={(
          <Button variant="contained" startIcon={<AddIcon />} onClick={openQuickAdd}>
            新增记录
          </Button>
        )}
      />

      {/* 工具条：搜索 + 类型 + 筛选面板入口 */}
      <Card sx={{ mb: hasFilters || summary ? 1.5 : 2.5 }}>
        <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 }, display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField
            size="small"
            placeholder="搜索备注..."
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            sx={{ flex: { xs: '1 1 100%', sm: '0 1 280px' } }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                </InputAdornment>
              ),
            }}
          />

          <Box sx={{ display: 'flex', gap: 0.75 }}>
            <Chip
              label="全部"
              size="small"
              variant={!filter.type ? 'filled' : 'outlined'}
              color={!filter.type ? 'primary' : 'default'}
              onClick={() => handleFilterChange({ ...filterRef.current, type: undefined, page: 1 })}
            />
            <Chip
              label="支出"
              size="small"
              variant={filter.type === 'expense' ? 'filled' : 'outlined'}
              color={filter.type === 'expense' ? 'error' : 'default'}
              onClick={() => handleFilterChange({ ...filterRef.current, type: 'expense', page: 1 })}
            />
            <Chip
              label="收入"
              size="small"
              variant={filter.type === 'income' ? 'filled' : 'outlined'}
              color={filter.type === 'income' ? 'success' : 'default'}
              onClick={() => handleFilterChange({ ...filterRef.current, type: 'income', page: 1 })}
            />
          </Box>

          <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1 }}>
            {summary && (
              <Typography
                variant="body2"
                sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums', display: { xs: 'none', md: 'block' } }}
              >
                收入 <Box component="span" sx={{ color: 'success.main', fontWeight: 600 }}>{formatAmount(summary.income)}</Box>
                {'  ·  '}支出 <Box component="span" sx={{ color: 'error.main', fontWeight: 600 }}>{formatAmount(summary.expense)}</Box>
                {'  ·  '}结余{' '}
                <Box component="span" sx={{ fontWeight: 700, color: (balance ?? 0) >= 0 ? 'success.main' : 'error.main' }}>
                  {formatAmount(balance ?? 0)}
                </Box>
              </Typography>
            )}
            <Badge badgeContent={activeFilterCount} color="secondary">
              <Button
                aria-label={activeFilterCount > 0 ? `筛选条件，已启用 ${activeFilterCount} 项` : '筛选条件'}
                aria-expanded={Boolean(filterAnchor)}
                color="inherit"
                size="small"
                variant="outlined"
                startIcon={<FilterListIcon />}
                onClick={(event) => setFilterAnchor(event.currentTarget)}
                sx={{ px: 1.5, color: 'text.primary', whiteSpace: 'nowrap' }}
              >
                筛选
              </Button>
            </Badge>
          </Box>
        </CardContent>
      </Card>

      {/* 已选筛选 chips */}
      {activeChips.length > 0 && (
        <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', alignItems: 'center', mb: 1.5 }}>
          {activeChips.map((chip) => (
            <Chip
              key={chip.label}
              label={chip.label}
              size="small"
              onClick={chip.onRemove}
              deleteIcon={<CloseIcon />}
              onDelete={chip.onRemove}
              sx={{ bgcolor: 'secondary.main', color: '#0a0a0f', fontWeight: 600, '& .MuiChip-deleteIcon': { color: 'rgba(10,10,15,0.6)' } }}
            />
          ))}
          <Button size="small" onClick={handleClearFilter} sx={{ color: 'text.secondary' }}>
            清除全部
          </Button>
        </Box>
      )}

      <TransactionList
        transactions={transactions}
        total={total}
        page={filter.page || 1}
        rowsPerPage={filter.limit || 20}
        today={today}
        onPageChange={handlePageChange}
        onRowsPerPageChange={handleRowsPerPageChange}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onView={handleView}
      />
      {loading && (
        <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block', textAlign: 'center', mt: 1 }}>
          加载中…
        </Typography>
      )}

      {/* 筛选面板 */}
      <Popover
        open={Boolean(filterAnchor)}
        anchorEl={filterAnchor}
        onClose={() => setFilterAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { elevation: 0, sx: { border: '1px solid', borderColor: 'divider', mt: 1, maxHeight: 'calc(100vh - 180px)', overflow: 'auto' } } }}
      >
        {filterPanel}
      </Popover>

      <TransactionForm
        open={formOpen}
        onClose={handleCloseForm}
        onSubmit={handleUpdate}
        transaction={editingTransaction}
        categories={categories}
        tags={tags}
        onCreateTag={createTag}
      />

      <TransactionDetailDrawer
        transactionId={transactionId}
        refreshKey={detailRefreshKey}
        onClose={handleCloseDetail}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除这条记录？"
        description={
          deleteTarget
            ? `将删除「${deleteTarget.note || deleteTarget.category.name}」这条记录。此操作无法恢复。`
            : undefined
        }
        loading={deleting}
        onCancel={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        onConfirm={handleConfirmDelete}
      />
    </Box>
  );
}
