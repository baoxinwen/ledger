import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  DeleteOutline as DeleteIcon,
  Download as DownloadIcon,
  Restore as RestoreIcon,
  UploadFile as UploadIcon,
} from '@mui/icons-material';
import { backupApi } from '../../api';
import { formatUtcAwareDateTime } from '../../utils/format';
import { useAuthStore } from '../../stores/authStore';
import { useSnackbarStore } from '../../stores/snackbarStore';
import type { BackupRecord } from '../../types';
import { ConfirmDialog, EmptyState, SectionCard } from '../ui';

type RestoreTarget = { kind: 'listed'; backup: BackupRecord } | { kind: 'upload'; file: File };

export default function BackupRestoreManager() {
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'create' | 'restore' | 'delete' | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupRecord | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const showSnackbar = useSnackbarStore((state) => state.showSnackbar);

  const loadBackups = useCallback(async () => {
    try {
      const response = await backupApi.list();
      setBackups(response.data);
    } catch (error) {
      console.error('加载备份失败:', error);
      showSnackbar('加载备份失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showSnackbar]);

  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);

  const handleCreate = async () => {
    setBusy('create');
    try {
      await backupApi.create();
      showSnackbar('完整备份已创建', 'success');
      await loadBackups();
    } catch (error) {
      console.error('创建备份失败:', error);
      showSnackbar('创建备份失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const handleDownload = async (backup: BackupRecord) => {
    try {
      const response = await backupApi.download(backup.id);
      const url = URL.createObjectURL(response.data);
      const link = document.createElement('a');
      link.href = url;
      link.download = backup.id;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('下载备份失败:', error);
      showSnackbar('下载备份失败', 'error');
    }
  };

  const handleRestore = async () => {
    if (!restoreTarget) return;
    setBusy('restore');
    try {
      if (restoreTarget.kind === 'listed') await backupApi.restore(restoreTarget.backup.id);
      else await backupApi.restoreUpload(restoreTarget.file);
      useAuthStore.setState({ status: 'login', user: null });
      showSnackbar('备份恢复完成，请重新登录', 'success');
      setRestoreTarget(null);
    } catch (error) {
      console.error('恢复备份失败:', error);
      showSnackbar('恢复备份失败，原账本未被替换', 'error');
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setBusy('delete');
    try {
      await backupApi.delete(deleteTarget.id);
      setDeleteTarget(null);
      showSnackbar('备份已删除', 'success');
      await loadBackups();
    } catch (error) {
      console.error('删除备份失败:', error);
      showSnackbar('删除备份失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const handleUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) setRestoreTarget({ kind: 'upload', file });
  };

  return (
    <Stack spacing={2.5}>
      <Alert severity="warning" variant="outlined">
        完整备份包含账户凭据哈希和全部账本数据，未应用层加密。请将下载文件保存在可信位置。
      </Alert>

      <SectionCard
        title="完整备份"
        subtitle="自动快照每天在业务时区 03:00 创建；手动和恢复前快照不会被自动清理"
        headerSx={{
          flexDirection: { xs: 'column', sm: 'row' },
          alignItems: { xs: 'stretch', sm: 'flex-start' },
        }}
        action={
          <Stack direction="row" spacing={1} sx={{ width: { xs: '100%', sm: 'auto' }, '& > button': { flex: { xs: 1, sm: 'initial' } } }}>
            <input ref={fileInputRef} hidden type="file" accept=".db,application/octet-stream" onChange={handleUpload} />
            <Button variant="outlined" startIcon={<UploadIcon />} onClick={() => fileInputRef.current?.click()} disabled={busy !== null}>
              上传恢复
            </Button>
            <Button variant="contained" startIcon={busy === 'create' ? <CircularProgress size={16} /> : <AddIcon />} onClick={handleCreate} disabled={busy !== null}>
              创建备份
            </Button>
          </Stack>
        }
      >
        {loading ? (
          <Box sx={{ minHeight: 160, display: 'grid', placeItems: 'center' }}><CircularProgress size={28} /></Box>
        ) : backups.length === 0 ? (
          <EmptyState title="暂无完整备份" description="创建第一份手动快照后会显示在这里" />
        ) : (
          <Stack divider={<Divider flexItem />}>
            {backups.map((backup) => (
              <Box
                key={backup.id}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr auto', sm: 'minmax(130px, 0.7fr) minmax(210px, 1fr) auto' },
                  alignItems: 'center',
                  gap: { xs: 1, sm: 2 },
                  py: 1.75,
                }}
              >
                <Box>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>{backupTypeLabel(backup.type)}</Typography>
                    {/* 手动/恢复前快照用金色徽章与自动快照区分（自动是例行产物，手动的更珍贵） */}
                    {backup.type !== 'automatic' && (
                      <Typography
                        variant="caption"
                        sx={{
                          px: 0.75,
                          py: 0.1,
                          fontSize: '0.6rem',
                          fontWeight: 700,
                          bgcolor: 'secondary.main',
                          color: '#0a0a0f',
                          borderRadius: 0.5,
                        }}
                      >
                        {backup.type === 'pre_restore' ? '安全快照' : '手动'}
                      </Typography>
                    )}
                  </Box>
                  <Typography variant="caption" color="text.secondary">schema v{backup.schemaVersion}</Typography>
                </Box>
                <Box sx={{ gridColumn: { xs: '1 / -1', sm: 'auto' }, gridRow: { xs: 2, sm: 'auto' } }}>
                  <Typography variant="body2">{formatUtcAwareDateTime(backup.createdAt)}</Typography>
                  <Typography variant="caption" color="text.secondary">{formatSize(backup.size)}</Typography>
                </Box>
                <Stack direction="row" spacing={0.25} sx={{ gridColumn: { xs: 2, sm: 'auto' }, gridRow: { xs: 1, sm: 'auto' } }}>
                  {/* 任一破坏性操作进行中时禁用全部行内按钮，避免恢复/删除并发交错。 */}
                  <Tooltip title="下载"><IconButton aria-label="下载备份" disabled={busy !== null} onClick={() => void handleDownload(backup)}><DownloadIcon /></IconButton></Tooltip>
                  <Tooltip title="恢复"><IconButton aria-label="恢复此备份" disabled={busy !== null} onClick={() => setRestoreTarget({ kind: 'listed', backup })}><RestoreIcon /></IconButton></Tooltip>
                  <Tooltip title="删除"><IconButton aria-label="删除备份" color="error" disabled={busy !== null} onClick={() => setDeleteTarget(backup)}><DeleteIcon /></IconButton></Tooltip>
                </Stack>
              </Box>
            ))}
          </Stack>
        )}
      </SectionCard>

      <ConfirmDialog
        open={restoreTarget !== null}
        title="恢复完整备份"
        description={`当前数据将被替换，系统会先创建安全快照。恢复成功后全部会话失效并需要重新登录${restoreTarget?.kind === 'upload' ? `。文件：${restoreTarget.file.name}` : ''}。`}
        confirmText="确认恢复"
        loadingText="恢复中..."
        loading={busy === 'restore'}
        // 强确认：必须输入备份文件名/上传文件名才能执行，防止误触覆盖整个账本。
        confirmKeyword={restoreTarget?.kind === 'upload' ? restoreTarget.file.name : restoreTarget?.backup.id}
        onCancel={() => setRestoreTarget(null)}
        onConfirm={() => void handleRestore()}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除备份"
        description="删除后无法从服务器恢复；已下载的副本不受影响。"
        confirmText="确认删除"
        loadingText="删除中..."
        loading={busy === 'delete'}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
      />
    </Stack>
  );
}

function backupTypeLabel(type: BackupRecord['type']): string {
  if (type === 'automatic') return '自动备份';
  if (type === 'pre_restore') return '恢复前快照';
  return '手动备份';
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
