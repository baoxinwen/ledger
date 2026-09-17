// 展示层格式化工具：统一金额、日期、百分比和业务时区下的日期范围。
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

export function formatAmount(amount: number, options?: { minimumFractionDigits?: number; maximumFractionDigits?: number }): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: options?.minimumFractionDigits ?? 2,
    maximumFractionDigits: options?.maximumFractionDigits ?? 2,
  }).format(amount);
}

/**
 * Format a number as compact currency (no decimals)
 */
export function formatCompactAmount(amount: number): string {
  return formatAmount(amount, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/**
 * Get current month date range
 */
export function getCurrentMonthRange(timeZone: string = DEFAULT_TIME_ZONE, referenceDate: Date = new Date()): { startDate: string; endDate: string } {
  const { year, month } = getZonedDateParts(referenceDate, timeZone);
  return getMonthRangeForMonth(`${year}-${pad2(month)}`);
}

export function getTodayInTimeZone(timeZone: string = DEFAULT_TIME_ZONE, referenceDate: Date = new Date()): string {
  const { year, month, day } = getZonedDateParts(referenceDate, timeZone);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function getMonthRangeForMonth(month: string): { startDate: string; endDate: string } {
  const [year, monthPart] = month.split('-').map(Number);
  const lastDay = getLastDayOfMonth(year, monthPart);
  return {
    startDate: `${month}-01`,
    endDate: `${month}-${pad2(lastDay)}`,
  };
}

export function getMonthRangeForDate(date: string): { startDate: string; endDate: string } {
  return getMonthRangeForMonth(date.substring(0, 7));
}

export function getQuarterRangeForDate(date: string): { startDate: string; endDate: string } {
  const parsedDate = parsePlainDate(date);
  if (!parsedDate) return getCurrentMonthRange();

  const quarterStartMonth = Math.floor((parsedDate.month - 1) / 3) * 3 + 1;
  const quarterEndMonth = quarterStartMonth + 2;
  const endDay = getLastDayOfMonth(parsedDate.year, quarterEndMonth);

  return {
    startDate: `${parsedDate.year}-${pad2(quarterStartMonth)}-01`,
    endDate: `${parsedDate.year}-${pad2(quarterEndMonth)}-${pad2(endDay)}`,
  };
}

export function getYearRangeForDate(date: string): { startDate: string; endDate: string } {
  const parsedDate = parsePlainDate(date);
  const year = parsedDate?.year ?? getZonedDateParts(new Date(), DEFAULT_TIME_ZONE).year;
  return {
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
  };
}

export function formatYearMonth(month: string): string {
  const [year, monthPart] = month.split('-');
  return `${year}年${Number(monthPart)}月`;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;

  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZone(timeZone?: string | null): string {
  return timeZone && isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
}

export function getSupportedTimeZones(): string[] {
  const preferredTimeZones = [
    'Asia/Shanghai',
    'Asia/Hong_Kong',
    'Asia/Taipei',
    'Asia/Tokyo',
    'Asia/Singapore',
    'Europe/London',
    'Europe/Paris',
    'America/New_York',
    'America/Los_Angeles',
    'UTC',
  ];
  const intlWithTimeZones = Intl as typeof Intl & {
    supportedValuesOf?: (key: 'timeZone') => string[];
  };
  const supportedTimeZones = intlWithTimeZones.supportedValuesOf?.('timeZone') ?? [];

  return [
    ...preferredTimeZones,
    ...supportedTimeZones.filter((timeZone) => !preferredTimeZones.includes(timeZone)),
  ];
}

/**
 * Calculate percentage with bounds
 */
export function calculatePercentage(value: number, total: number, max: number = 100): number {
  if (total === 0) return 0;
  return Math.min((value / total) * 100, max);
}

function getZonedDateParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);

  return { year, month, day };
}

function parsePlainDate(dateStr: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function getLastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

// ── 展示层增补：相对日期、金额缩写、带符号百分比 ─────────────────────────

/**
 * 把 YYYY-MM-DD 显示为相对日期：今天 / 昨天 / M月D日 / 跨年时带年份。
 * todayStr 用于业务时区下的"今天"判定，由调用方传 useZonedToday 的结果。
 */
export function formatRelativeDay(dateStr: string, todayStr?: string): string {
  if (todayStr) {
    if (dateStr === todayStr) return '今天';
    const yesterday = new Date(`${todayStr}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    if (dateStr === yesterday.toISOString().slice(0, 10)) return '昨天';
  }
  const parsed = parsePlainDate(dateStr);
  if (!parsed) return dateStr;
  // 跨年判定以调用方业务时区的"今天"为准；用固定默认时区取当前年份时，
  // 业务时区与默认时区跨年时刻不同，边界数小时内的相对日期会多带/少带年份。
  const today = todayStr ? parsePlainDate(todayStr) : null;
  const currentYear = today ? today.year : getZonedDateParts(new Date(), DEFAULT_TIME_ZONE).year;
  if (parsed.year !== currentYear) return `${parsed.year}年${parsed.month}月${parsed.day}日`;
  return `${parsed.month}月${parsed.day}日`;
}

/**
 * 服务端存 UTC naive 字符串（无时区标记）或 ISO-Z 时间戳，统一补 Z / 原样解析后
 * 按浏览器本地时区展示。此前详情抽屉、导入导出、备份恢复各有一份实现，容易漂移。
 */
export function formatUtcAwareDateTime(value: string): string {
  const normalized = /Z$|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/**
 * 金额缩写： >= 1万 显示 x.x万，否则无小数元；图表坐标轴与紧凑展示统一用它。
 */
export function formatWan(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (abs >= 10000) {
    const wan = abs / 10000;
    const text = wan >= 100 ? Math.round(wan).toString() : (Math.round(wan * 10) / 10).toString();
    return `${sign}¥${text}万`;
  }
  return `${sign}¥${Math.round(abs).toLocaleString('zh-CN')}`;
}

/**
 * 环比变化率显示：+21.1% / -1.9%；null（无上期数据）显示占位符。
 */
export function formatPercentChange(change: number | null | undefined): string {
  if (change === null || change === undefined || !Number.isFinite(change)) return '—';
  const sign = change > 0 ? '+' : '';
  return `${sign}${change.toFixed(1)}%`;
}
