// 交易详情抽屉：金额头 + 关键事实 + 来源/批次信息 + 弱化的记录时间。
// 通过 /transactions/:id 路由驱动；数据自取，refreshKey 变化时重拉（编辑后同步）。
import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Divider,
  Drawer,
  IconButton,
  Skeleton,
  Stack,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { Close as CloseIcon, DeleteOutline as DeleteIcon, Edit as EditIcon } from '@mui/icons-material';
import { transactionApi } from '../api';
import type { TransactionDetail, TransactionWithDetails } from '../types';
import { formatRelativeDay, formatUtcAwareDateTime } from '../utils/format';
import { useSettingsStore } from '../stores/settingsStore';
import { useZonedToday } from '../hooks/useZonedToday';
import { Amount, CategoryAvatar, TagChip, TypeBadge } from './ui';

interface TransactionDetailDrawerProps {
  transactionId: number | null;
  refreshKey?: number;
  onClose: () => void;
  onEdit: (transaction: TransactionWithDetails) => void;
  onDelete: (transaction: TransactionWithDetails) => void;
}

export default function TransactionDetailDrawer({
  transactionId,
  refreshKey = 0,
  onClose,
  onEdit,
  onDelete,
}: TransactionDetailDrawerProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const timeZone = useSettingsStore((state) => state.settings.time_zone);
  // 传业务时区的"今天"：与列表的相对日期口径一致（否则今天记的账在列表显示"今天"、在抽屉显示具体日期）。
  const today = useZonedToday(timeZone);
  const [transaction, setTransaction] = useState<TransactionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!transactionId) {
      setTransaction(null);
      setError('');
      return;
    }
    let active = true;
    setLoading(true);
    setError('');
    transactionApi.getById(transactionId)
      .then((response) => {
        if (active) setTransaction(response.data);
      })
      .catch(() => {
        if (active) {
          setTransaction(null);
          setError('未找到这条交易，记录可能已被删除');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [refreshKey, transactionId]);

  return (
    <Drawer
      anchor="right"
      open={transactionId !== null}
      onClose={onClose}
      PaperProps={{
        sx: {
          width: isMobile ? '100vw' : 440,
          maxWidth: '100vw',
        },
      }}
    >
      <Box sx={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ px: { xs: 2, sm: 3 }, py: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
          <Box>
            <Typography variant="caption" color="text.secondary">交易记录</Typography>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>交易详情</Typography>
          </Box>
          <IconButton aria-label="关闭交易详情" onClick={onClose}><CloseIcon /></IconButton>
        </Box>
        <Divider />

        <Box sx={{ px: { xs: 2, sm: 3 }, py: 3, flex: 1, overflowY: 'auto' }}>
          {loading ? <DetailSkeleton /> : error ? <Alert severity="error">{error}</Alert> : transaction ? (
            <Stack spacing={3}>
              {/* 金额头：类型徽章 + 分类图标 + 大金额 */}
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <CategoryAvatar category={transaction.category} size={48} />
                <Box sx={{ minWidth: 0 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <TypeBadge type={transaction.type} />
                    <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
                      {transaction.category.name}
                    </Typography>
                  </Box>
                  <Amount
                    value={transaction.amount}
                    tone={transaction.type}
                    variant="h3"
                    sx={{ mt: 0.5, fontWeight: 700, display: 'block', lineHeight: 1.1 }}
                  />
                </Box>
              </Box>

              <DetailSection title="账本信息">
                <DetailRow label="日期" value={transaction.date} hint={formatRelativeDay(transaction.date, today)} />
                <DetailRow label="备注" value={transaction.note || '-'} />
                <Box>
                  <Typography variant="caption" color="text.secondary">标签</Typography>
                  <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ mt: 0.75 }}>
                    {transaction.tags.length > 0
                      ? transaction.tags.map((tag) => <TagChip key={tag.id} label={tag.name} />)
                      : <Typography variant="body2">-</Typography>}
                  </Stack>
                </Box>
              </DetailSection>

              {hasSourceMetadata(transaction) && (
                <DetailSection title="来源信息">
                  <DetailRow label="来源" value={sourceLabel(transaction.source)} />
                  <DetailRow label="平台交易号" value={transaction.source_transaction_id || '-'} />
                  <DetailRow label="商户订单号" value={transaction.source_merchant_order_id || '-'} />
                  <DetailRow label="原始分类" value={transaction.source_category || '-'} />
                  <DetailRow label="来源时间" value={transaction.source_time || '-'} />
                  <DetailRow label="支付方式" value={transaction.payment_method || '-'} />
                  <DetailRow label="来源状态" value={transaction.source_status || '-'} />
                </DetailSection>
              )}

              {transaction.importBatch && (
                <DetailSection title="导入批次">
                  <DetailRow label="文件" value={transaction.importBatch.filename} />
                  <DetailRow label="批次" value={`#${transaction.importBatch.id}`} />
                  <DetailRow label="状态" value={batchStatusLabel(transaction.importBatch.status)} />
                  <DetailRow label="导入时间" value={formatUtcAwareDateTime(transaction.importBatch.createdAt)} />
                </DetailSection>
              )}

              {/* 记录时间：对用户价值低，弱化为底部小字 */}
              <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block' }}>
                创建于 {formatUtcAwareDateTime(transaction.created_at)} · 更新于 {formatUtcAwareDateTime(transaction.updated_at)}
              </Typography>
            </Stack>
          ) : null}
        </Box>

        {transaction && !loading && (
          <>
            <Divider />
            <Stack direction="row" spacing={1.5} sx={{ px: { xs: 2, sm: 3 }, py: 2 }}>
              <Button fullWidth variant="outlined" startIcon={<EditIcon />} onClick={() => onEdit(transaction)}>编辑</Button>
              <Button fullWidth color="error" variant="outlined" startIcon={<DeleteIcon />} onClick={() => onDelete(transaction)}>删除</Button>
            </Stack>
          </>
        )}
      </Box>
    </Drawer>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1.5 }}>{title}</Typography>
      <Stack spacing={1.5}>{children}</Stack>
    </Box>
  );
}

function DetailRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '96px minmax(0, 1fr)', gap: 2, alignItems: 'baseline' }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', pt: '2px' }}>{label}</Typography>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        {value}
        {hint && <Box component="span" sx={{ color: 'text.disabled', ml: 1 }}>（{hint}）</Box>}
      </Typography>
    </Box>
  );
}

function DetailSkeleton() {
  return <Stack spacing={2}><Skeleton width="36%" /><Skeleton height={54} /><Skeleton /><Skeleton /><Skeleton /></Stack>;
}

function hasSourceMetadata(transaction: TransactionDetail): boolean {
  return Boolean(transaction.source || transaction.source_transaction_id || transaction.source_merchant_order_id || transaction.source_category || transaction.source_time || transaction.payment_method || transaction.source_status);
}

function sourceLabel(source: string | null): string {
  if (source === 'alipay') return '支付宝';
  if (source === 'wechat') return '微信支付';
  if (source === 'standard') return '标准导入';
  return source || '-';
}

function batchStatusLabel(status: NonNullable<TransactionDetail['importBatch']>['status']): string {
  if (status === 'undone') return '已撤销';
  if (status === 'failed') return '失败';
  return '已完成';
}
