// 预算页：概览（总预算/已花费/剩余，状态阶梯色）+ 期间 Tab + 分类预算卡（ProportionBar + 单一状态表达）。
// 总预算只在概览出现，不再在分类网格重复；卡片带期间标识，同分类多期预算可区分。
import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Typography,
  Button,
  Grid,
  Card,
  CardContent,
  IconButton,
  Tabs,
  Tab,
} from '@mui/material';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  AccountBalance as BudgetIcon,
  TrendingDown as SpentIcon,
  Savings as RemainingIcon,
  Warning as WarningIcon,
} from '@mui/icons-material';
import { useCategoryStore } from '../stores/categoryStore';
import { useTransactionStore } from '../stores/transactionStore';
import { useSnackbarStore } from '../stores/snackbarStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useZonedToday } from '../hooks/useZonedToday';
import { computeBudgetOverview, useBudgetStore } from '../stores/budgetStore';
import type { Budget, BudgetStatus } from '../types';
import { formatAmount, formatYearMonth } from '../utils/format';
import BudgetFormDialog from '../components/Budgets/BudgetFormDialog';
import {
  CategoryAvatar,
  ConfirmDialog,
  EmptyState,
  HoverActions,
  MetricCard,
  PageHeader,
  ProportionBar,
  StatusChip,
} from '../components/ui';
import { budgetHealth } from '../utils/budgetHealth';

type PeriodTab = 'monthly' | 'yearly';

export default function BudgetsPage() {
  const { categories, fetchCategories } = useCategoryStore();
  const { showSnackbar } = useSnackbarStore();
  const {
    status, statusMonth, fetchStatus,
    createBudget, updateBudget, deleteBudget,
  } = useBudgetStore();
  // 全局记一笔/编辑/删除交易后重拉预算执行状态
  const dataVersion = useTransactionStore((state) => state.dataVersion);
  const [periodTab, setPeriodTab] = useState<PeriodTab>('monthly');
  const [formOpen, setFormOpen] = useState(false);
  const [editingBudget, setEditingBudget] = useState<Budget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BudgetStatus | null>(null);
  const [deleting, setDeleting] = useState(false);
  const timeZone = useSettingsStore((state) => state.settings.time_zone);
  const today = useZonedToday(timeZone);
  const currentMonth = today.substring(0, 7);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  useEffect(() => {
    fetchStatus(currentMonth).catch(() => {
      showSnackbar('加载预算数据失败', 'error');
    });
  }, [currentMonth, dataVersion, fetchStatus, showSnackbar]);

  // 分类网格：只显示分类预算（总预算已在上方概览体现，不重复渲染）
  const currentPeriodRows = useMemo(
    () => status.filter((row) => row.budget.period === periodTab && row.budget.category_id !== null),
    [status, periodTab],
  );

  // 概览口径：总预算优先，否则月度分类预算汇总（年度预算不参与月度加总）。
  const overview = useMemo(
    () => (statusMonth === currentMonth ? computeBudgetOverview(status, currentMonth) : null),
    [status, statusMonth, currentMonth],
  );
  const totalBudget = overview?.totalBudget ?? 0;
  const totalSpent = overview?.spent ?? 0;
  const totalRemaining = totalBudget - totalSpent;
  const totalRatio = overview && overview.totalBudget > 0 ? overview.spent / overview.totalBudget : 0;
  const overviewHealth = budgetHealth(totalRatio);

  const getCategoryName = (budget: Budget) => {
    if (!budget.category_id) return '总预算';
    const category = categories.find((c) => c.id === budget.category_id);
    return category ? category.name : '未知分类';
  };

  const handleCreate = async (data: Parameters<typeof createBudget>[0]): Promise<boolean> => {
    const created = await createBudget(data);
    if (!created) {
      showSnackbar('保存预算失败，请重试', 'error');
      return false;
    }
    showSnackbar('预算创建成功', 'success');
    return true;
  };

  const handleUpdate = async (data: Parameters<typeof updateBudget>[1]): Promise<boolean> => {
    if (!editingBudget) return false;
    const ok = await updateBudget(editingBudget.id, data);
    if (!ok) {
      showSnackbar('保存预算失败，请重试', 'error');
      return false;
    }
    showSnackbar('预算更新成功', 'success');
    return true;
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const ok = await deleteBudget(deleteTarget.budget.id);
    setDeleting(false);
    if (ok) {
      showSnackbar('预算删除成功', 'success');
      setDeleteTarget(null);
    } else {
      showSnackbar('删除预算失败', 'error');
    }
  };

  return (
    <Box>
      <PageHeader
        eyebrow="预算管理"
        title="预算概览"
        description={`${formatYearMonth(currentMonth)} 执行情况`}
        action={(
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => {
              setEditingBudget(null);
              setFormOpen(true);
            }}
          >
            新增预算
          </Button>
        )}
      />

      {/* 概览：状态阶梯色（正常→≥80% 琥珀→超支红），三张卡同一语义 */}
      <Grid container spacing={2} sx={{ mb: 2.5 }}>
        <Grid size={{ xs: 12, sm: 4 }}>
          <MetricCard
            testId="budget-total-card"
            label="总预算"
            value={formatAmount(totalBudget)}
            helper={overview?.hasBudget ? '月度口径（优先总预算）' : '尚未设置预算'}
            icon={<BudgetIcon />}
            tone="gold"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 4 }}>
          <MetricCard
            testId="budget-spent-card"
            label="已花费"
            value={formatAmount(totalSpent)}
            helper={overview?.hasBudget ? `${(totalRatio * 100).toFixed(1)}% 已使用` : undefined}
            icon={<SpentIcon />}
            tone={overviewHealth === 'over' ? 'expense' : overviewHealth === 'caution' ? 'warning' : 'neutral'}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 4 }}>
          <MetricCard
            testId="budget-remaining-card"
            label={totalRemaining >= 0 ? '剩余预算' : '超支金额'}
            value={formatAmount(Math.abs(totalRemaining))}
            helper={overviewHealth === 'over' ? '本月已超支' : overviewHealth === 'caution' ? '接近预算上限' : undefined}
            icon={overviewHealth === 'over' ? <WarningIcon /> : <RemainingIcon />}
            tone={overviewHealth === 'over' ? 'expense' : overviewHealth === 'caution' ? 'warning' : 'income'}
          />
        </Grid>
      </Grid>

      {/* 总体进度（带 100% 分界的比例条） */}
      {overview?.hasBudget && (
        <Card sx={{ mb: 2.5 }}>
          <CardContent sx={{ py: 2.5, '&:last-child': { pb: 2.5 } }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 1 }}>
              <Typography variant="subtitle2" fontWeight={600}>
                总体使用情况
              </Typography>
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 700,
                  fontVariantNumeric: 'tabular-nums',
                  color: overviewHealth === 'over' ? 'error.main' : overviewHealth === 'caution' ? 'warning.main' : 'success.main',
                }}
              >
                {(totalRatio * 100).toFixed(1)}%
              </Typography>
            </Box>
            <ProportionBar ratio={totalRatio} height={10} />
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.75 }}>
              <Typography variant="caption" color="text.secondary">
                已使用 {formatAmount(totalSpent)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                总预算 {formatAmount(totalBudget)}
              </Typography>
            </Box>
          </CardContent>
        </Card>
      )}

      {/* 期间 Tab + 分类预算卡片（不含总预算——总预算只在上方概览出现） */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
        <Tabs
          value={periodTab}
          onChange={(_, value: PeriodTab) => setPeriodTab(value)}
          sx={{ minHeight: 40, '& .MuiTab-root': { minHeight: 40, px: 2 } }}
        >
          <Tab value="monthly" label="月度预算" />
          <Tab value="yearly" label="年度预算" />
        </Tabs>
        <Typography variant="caption" sx={{ color: 'text.disabled' }}>
          {currentPeriodRows.length} 项
        </Typography>
      </Box>

      <Grid container spacing={2}>
        {currentPeriodRows.map((row) => {
          const { budget, spent, remaining } = row;
          const ratio = budget.amount > 0 ? spent / budget.amount : 0;
          const category = categories.find((c) => c.id === budget.category_id) ?? null;
          const name = getCategoryName(budget);
          const periodLabel = budget.period === 'monthly'
            ? `月度 · 自 ${formatYearMonth(budget.start_date.substring(0, 7))}`
            : `年度 · 自 ${budget.start_date.substring(0, 4)}年`;

          return (
            <Grid size={{ xs: 12, sm: 6, lg: 4 }} key={budget.id}>
              <Card
                className="hover-actions-host"
                sx={{
                  height: '100%',
                  border: '1px solid',
                  borderColor: budgetHealth(ratio) === 'over' ? 'error.main' : 'divider',
                }}
              >
                <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, '&:last-child': { pb: 2.5 } }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                    <CategoryAvatar category={category} size={34} />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="subtitle2" noWrap sx={{ fontWeight: 700 }}>
                        {name}
                      </Typography>
                      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                        {periodLabel}
                      </Typography>
                    </Box>
                    <HoverActions>
                      <IconButton
                        size="small"
                        aria-label={`编辑${name}预算`}
                        onClick={() => {
                          setEditingBudget(budget);
                          setFormOpen(true);
                        }}
                      >
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton
                        size="small"
                        aria-label={`删除${name}预算`}
                        onClick={() => setDeleteTarget(row)}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </HoverActions>
                  </Box>

                  <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      已花费 {formatAmount(spent)} / {formatAmount(budget.amount)}
                    </Typography>
                    <Typography
                      variant="h6"
                      sx={{
                        fontWeight: 700,
                        fontVariantNumeric: 'tabular-nums',
                        color: budgetHealth(ratio) === 'over'
                          ? 'error.main'
                          : budgetHealth(ratio) === 'caution'
                            ? 'warning.main'
                            : 'text.primary',
                      }}
                    >
                      {(ratio * 100).toFixed(0)}%
                    </Typography>
                  </Box>

                  <ProportionBar ratio={ratio} />

                  {/* 单一状态表达：超支只在这里用红色，不再叠加"超支预警"重复警示 */}
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <StatusChip
                      ratio={ratio}
                      label={remaining >= 0 ? `剩余 ${formatAmount(remaining)}` : `超支 ${formatAmount(Math.abs(remaining))}`}
                    />
                    {budget.start_date > `${currentMonth}-01` && budget.period === 'monthly' && (
                      <Typography variant="caption" sx={{ color: 'text.disabled' }}>
                        下期生效
                      </Typography>
                    )}
                  </Box>
                </CardContent>
              </Card>
            </Grid>
          );
        })}

        {currentPeriodRows.length === 0 && (
          <Grid size={{ xs: 12 }}>
            <EmptyState
              icon={<BudgetIcon sx={{ fontSize: 56 }} />}
              title={periodTab === 'monthly' ? '暂无月度预算' : '暂无年度预算'}
              description={periodTab === 'monthly'
                ? '为总支出或常用分类设置月度预算，追踪执行进度'
                : '设置年度预算，从全年视角控制大额支出'}
              action={(
                <Button
                  variant="outlined"
                  startIcon={<AddIcon />}
                  onClick={() => {
                    setEditingBudget(null);
                    setFormOpen(true);
                  }}
                >
                  创建预算
                </Button>
              )}
            />
          </Grid>
        )}
      </Grid>

      <BudgetFormDialog
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditingBudget(null);
        }}
        onSubmit={editingBudget ? handleUpdate : handleCreate}
        budget={editingBudget}
        categories={categories}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除这个预算？"
        description={
          deleteTarget
            ? `将删除「${getCategoryName(deleteTarget.budget)}」的${deleteTarget.budget.period === 'monthly' ? '月度' : '年度'}预算。此操作无法恢复。`
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
