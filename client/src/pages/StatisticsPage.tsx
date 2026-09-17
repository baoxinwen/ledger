// 统计页：按时间范围拉取汇总数据并渲染趋势、分类图表。
// 月度收支对比使用独立的近 6 个月请求（不走 store 单槽，避免与上方范围互相覆盖）。
import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Typography,
  ToggleButton,
  ToggleButtonGroup,
  TextField,
  useTheme,
  useMediaQuery,
} from '@mui/material';
import { useTransactionStore, buildStatsKey } from '../stores/transactionStore';
import { useSnackbarStore } from '../stores/snackbarStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useZonedToday } from '../hooks/useZonedToday';
import StatsCharts, { type MonthlySeriesItem } from '../components/StatsCharts';
import { transactionApi } from '../api';
import { getMonthRangeForDate, getMonthRangeForMonth, getQuarterRangeForDate, getYearRangeForDate } from '../utils/format';
import { PageHeader, SectionCard } from '../components/ui';

// 近 6 个月月份序列：'2026-03' ... '2026-08'（含当月）。
function getLast6Months(today: string): string[] {
  const months: string[] = [];
  const [year, month] = today.split('-').map(Number);
  for (let offset = 5; offset >= 0; offset--) {
    const zeroBased = month - 1 - offset;
    const targetYear = year + Math.floor(zeroBased / 12);
    const targetMonth = ((zeroBased % 12) + 12) % 12 + 1;
    months.push(`${targetYear}-${String(targetMonth).padStart(2, '0')}`);
  }
  return months;
}

export default function StatisticsPage() {
  const { stats, statsKey, statsLoading, fetchStats, dataVersion } = useTransactionStore();
  const { showSnackbar } = useSnackbarStore();
  const [period, setPeriod] = useState('month');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  // null = 加载中；[] = 加载失败；非空数组 = 成功（成功必然有 6 个月的元素）
  const [monthlySeries, setMonthlySeries] = useState<MonthlySeriesItem[] | null>(null);
  // 区分"首次进入还没拉到数据"与"拉取失败"：前者显示加载中，后者才显示失败
  const [statsFailed, setStatsFailed] = useState(false);
  // 失败态重试入口：自增触发下方统计 effect 重新发起当前范围的请求。
  const [retryToken, setRetryToken] = useState(0);
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const timeZone = useSettingsStore((state) => state.settings.time_zone);
  const today = useZonedToday(timeZone);

  // 把当前选择解析为请求范围；范围同时用于生成 statsKey，判断 store 里的 stats
  // 是否属于本页当前周期——避免跨页复用时把首页的"本月"数据当成本季/本年渲染。
  const range = useMemo(() => {
    switch (period) {
      case 'month': {
        const monthRange = getMonthRangeForDate(today);
        return { start: monthRange.startDate, end: monthRange.endDate };
      }
      case 'quarter': {
        const quarterRange = getQuarterRangeForDate(today);
        return { start: quarterRange.startDate, end: quarterRange.endDate };
      }
      case 'year': {
        const yearRange = getYearRangeForDate(today);
        return { start: yearRange.startDate, end: yearRange.endDate };
      }
      default:
        return startDate && endDate ? { start: startDate, end: endDate } : null;
    }
  }, [period, today, startDate, endDate]);

  // 自定义范围的开始晚于结束：不发无效请求，直接提示。
  const invalidCustomRange = period === 'custom'
    && Boolean(startDate) && Boolean(endDate)
    && startDate > endDate;

  // 自定义范围只填了一端：不发请求，也不落入加载态误导用户（此前会永远显示"加载中..."）。
  const customIncomplete = period === 'custom' && (!startDate || !endDate);

  useEffect(() => {
    if (!range || invalidCustomRange) return;
    setStatsFailed(false);
    fetchStats({ start_date: range.start, end_date: range.end }).catch(() => {
      setStatsFailed(true);
      showSnackbar('加载统计数据失败', 'error');
    });
    // dataVersion 变化（全局记一笔/编辑/删除）时重拉，保证图表实时
  }, [range, invalidCustomRange, dataVersion, retryToken, fetchStats, showSnackbar]);

  // 近 6 个月序列：直接调 API 聚合，不占用 store 的单槽 stats。
  useEffect(() => {
    let active = true;
    const months = getLast6Months(today);
    const { startDate: seriesStart } = getMonthRangeForMonth(months[0]);
    transactionApi.getStats({ start_date: seriesStart, end_date: today })
      .then((response) => {
        if (!active) return;
        const byMonth = new Map<string, MonthlySeriesItem>();
        for (const month of months) {
          byMonth.set(month, { month, income: 0, expense: 0 });
        }
        for (const row of response.data.dailyStats) {
          const month = row.date.substring(0, 7);
          const entry = byMonth.get(month);
          if (!entry) continue;
          if (row.type === 'income') entry.income += row.total;
          else entry.expense += row.total;
        }
        setMonthlySeries(months.map((month) => byMonth.get(month)!));
      })
      .catch(() => {
        // 失败态用 [] 表示（成功必然有 6 个元素），渲染层据此区分"加载中"与"失败"
        if (active) setMonthlySeries([]);
      });
    return () => { active = false; };
  }, [today, dataVersion]);

  const statsReady = stats !== null && !invalidCustomRange
    && range !== null
    && statsKey === buildStatsKey({ start_date: range.start, end_date: range.end });

  return (
    <Box>
      <PageHeader
        eyebrow="数据分析"
        title="统计分析"
        description="查看您的收支趋势和分类统计"
      />

      {/* Time Period Selector */}
      <SectionCard cardSx={{ mb: 3 }}>
          <Box sx={{
            display: 'flex',
            flexDirection: isMobile ? 'column' : 'row',
            alignItems: isMobile ? 'stretch' : 'center',
            gap: 2,
          }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', minWidth: 80 }}>
              时间范围
            </Typography>
            <ToggleButtonGroup
              value={period}
              exclusive
              onChange={(_, value) => value && setPeriod(value)}
              size="small"
            >
              <ToggleButton value="month">本月</ToggleButton>
              <ToggleButton value="quarter">本季</ToggleButton>
              <ToggleButton value="year">本年</ToggleButton>
              <ToggleButton value="custom">自定义</ToggleButton>
            </ToggleButtonGroup>

            {period === 'custom' && (
              <Box sx={{ display: 'flex', gap: 2, flex: 1 }}>
                <TextField
                  type="date"
                  size="small"
                  label="开始日期"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  fullWidth={isMobile}
                  InputLabelProps={{ shrink: true }}
                  sx={{ '& .MuiOutlinedInput-root': { borderRadius: 1 } }}
                />
                <TextField
                  type="date"
                  size="small"
                  label="结束日期"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  fullWidth={isMobile}
                  InputLabelProps={{ shrink: true }}
                  sx={{ '& .MuiOutlinedInput-root': { borderRadius: 1 } }}
                />
              </Box>
            )}
          </Box>
      </SectionCard>

      {/* Charts：只有 stats 的周期标识与当前选择一致时才渲染，过期数据不展示 */}
      {invalidCustomRange ? (
        <SectionCard>
            <Box sx={{ textAlign: 'center', py: 8 }}>
              <Typography variant="body1" sx={{ color: 'text.secondary' }}>
                开始日期不能晚于结束日期
              </Typography>
            </Box>
        </SectionCard>
      ) : customIncomplete ? (
        <SectionCard>
            <Box sx={{ textAlign: 'center', py: 8 }}>
              <Typography variant="body1" sx={{ color: 'text.secondary' }}>
                请选择完整的开始和结束日期
              </Typography>
            </Box>
        </SectionCard>
      ) : statsReady ? (
        <StatsCharts stats={stats} monthlySeries={monthlySeries} />
      ) : (
        <SectionCard>
            <Box sx={{ textAlign: 'center', py: 8 }}>
              <Typography variant="body1" sx={{ color: statsLoading || !statsFailed ? 'text.secondary' : 'error.main' }}>
                {statsLoading || !statsFailed ? '加载中...' : '加载失败，请重试'}
              </Typography>
              {!statsLoading && statsFailed && (
                <Button sx={{ mt: 2 }} variant="outlined" onClick={() => setRetryToken((token) => token + 1)}>
                  重试
                </Button>
              )}
            </Box>
        </SectionCard>
      )}
    </Box>
  );
}
