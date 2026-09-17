// 交易表单：复用在新增和编辑场景，并把常用字段写入表单记忆 store。
// 高频操作优先级设计：金额大输入框 + 分类图标网格一次点选 + 今天/昨天快捷键 + 保存并再记。
import { useState, useEffect, useRef } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Box,
  ToggleButton,
  ToggleButtonGroup,
  Chip,
  Autocomplete,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import type { TransactionWithDetails, Category, Tag } from '../types';
import type { TransactionPayload } from '../api';
import { useFormMemoryStore } from '../stores/formMemoryStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useCategoryStore } from '../stores/categoryStore';
import { useSnackbarStore } from '../stores/snackbarStore';
import { useZonedToday } from '../hooks/useZonedToday';
import { CategoryAvatar } from './ui';
import { FONT_SERIF, NUMERIC_TEXT } from '../theme';

interface TransactionFormProps {
  open: boolean;
  onClose: () => void;
  /** 提交成功 resolve(true)，失败 resolve(false)——失败时弹窗保持打开、用户输入不丢失。 */
  onSubmit: (data: TransactionPayload) => Promise<boolean>;
  transaction?: TransactionWithDetails | null;
  categories: Category[];
  tags: Tag[];
  onCreateTag: (name: string) => Promise<Tag | null>;
}

export default function TransactionForm({
  open,
  onClose,
  onSubmit,
  transaction,
  categories,
  tags,
  onCreateTag,
}: TransactionFormProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const { transactionForm, setTransactionForm } = useFormMemoryStore();
  const timeZone = useSettingsStore((state) => state.settings.time_zone);
  const today = useZonedToday(timeZone);
  const showSnackbar = useSnackbarStore((state) => state.showSnackbar);
  // 区分"没有分类"与"分类加载失败"：拉取失败时空网格不能误导用户去设置页创建。
  const categoriesLoadFailed = useCategoryStore((state) => state.loadFailed);
  const [type, setType] = useState<'income' | 'expense'>(transactionForm.type);
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState<number | ''>(transactionForm.category_id || '');
  const [note, setNote] = useState('');
  // 新建记录永远以"今天"为默认日期：表单记忆只保留类型与分类偏好，不再记忆日期，
  // 避免隔天记账时把昨天日期静默预填进去（记错天）。
  const [date, setDate] = useState(today);
  const handleDateChange = (nextDate: string) => {
    setDate(nextDate);
    setDateTouched(true);
  };
  const [selectedTags, setSelectedTags] = useState<Tag[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const amountInputRef = useRef<HTMLDivElement>(null);
  // 标签创建的在途请求登记：并发 onChange 对同名标签共享同一个 Promise，既避免重复 POST，
  // 也让"后一次提交"能等待并合并"前一次挂起中的创建"，不随过期调用一起被丢弃。
  const tagChangeSeqRef = useRef(0);
  const pendingTagCreationsRef = useRef(new Map<string, Promise<Tag | null>>());

  useEffect(() => {
    if (transaction) {
      setType(transaction.type);
      setAmount(String(transaction.amount));
      setCategoryId(transaction.category_id);
      setNote(transaction.note || '');
      setDate(transaction.date);
      setSelectedTags(transaction.tags);
    } else {
      setType(transactionForm.type);
      setAmount('');
      setCategoryId(transactionForm.category_id || '');
      setNote('');
      setDate(today);
      setDateTouched(false);
      setSelectedTags([]);
    }
    // 注意：today 不进依赖数组——跨午夜时由下方独立 effect 仅滚动日期，
    // 否则 useZonedToday 的分钟级 tick 会把用户正在填写的金额/备注整体清空。
    // 依赖只保留 [transaction, open]：默认值重置只应发生在弹窗打开/目标记录切换时。
    // 若依赖表单记忆的 category_id/type，"保存并再记"写入记忆会触发重跑，
    // 把用户已选的日期静默重置回今天（记错天）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transaction, open]);

  // 跨天（含弹窗打开期间跨零点）时仅把新建模式的日期滚动到新的"今天"，其余字段不动。
  // 用户手动改过日期（选了昨天/任意日期）则不覆盖，尊重用户输入。
  const [dateTouched, setDateTouched] = useState(false);
  useEffect(() => {
    if (!transaction && !dateTouched) setDate(today);
  }, [today, transaction, dateTouched]);

  const filteredCategories = categories.filter((c) => c.type === type);

  // 切换收支类型后，若当前选中的分类不属于新类型则清空，避免“收入交易配支出分类”这类错配提交。
  const handleTypeChange = (value: 'income' | 'expense') => {
    setType(value);
    const stillValid = categories.some((c) => c.type === value && c.id === categoryId);
    if (!stillValid) setCategoryId('');
  };

  const buildPayload = () => {
    if (!amount || !categoryId || !date) return null;
    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
      showSnackbar('请输入有效的非负金额', 'error');
      return null;
    }
    // 过滤掉已不在最新标签列表里的选中项：标签可能刚被删除，携带死 tag_id 提交会被外键拒绝。
    const liveTagIds = selectedTags
      .filter((selectedTag) => tags.some((tag) => tag.id === selectedTag.id))
      .map((t) => t.id);
    // 空备注必须显式提交空串：服务端按 note 字段是否存在决定是否更新，
    // 转成 undefined 会被 JSON 序列化丢弃，"清空备注"被静默跳过。
    return { type, amount: parsedAmount, category_id: categoryId, note: note, date, tag_ids: liveTagIds };
  };

  const handleSubmit = async (keepOpen = false) => {
    if (submitting) return; // 提交进行中禁止重复提交（连点会写入两笔相同交易）
    const payload = buildPayload();
    if (!payload) return;

    setSubmitting(true);
    try {
      const success = await onSubmit(payload);
      if (!success) return; // 失败：保留弹窗与全部输入，错误提示由页面层给出

      // Save form memory for next use（只记忆类型与分类，日期不再记忆）
      setTransactionForm({ type, category_id: typeof categoryId === 'number' ? categoryId : undefined });

      if (keepOpen && !transaction) {
        // 连续记账：清金额/备注/标签（避免串笔），分类与日期保留，焦点回金额框
        setAmount('');
        setNote('');
        setSelectedTags([]);
        amountInputRef.current?.querySelector('input')?.focus();
      } else {
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  };

  // 仅在用户提交（选择已有标签或回车创建新标签）时按完整名称解析标签，
  // 避免 MUI Autocomplete 的 onInputChange 逐键触发导致垃圾标签入库。
  // 标签解析是异步的，连续两次 onChange 并发执行时有两个方向的竞态：
  // 慢的旧调用最后落笔会整体覆盖后一次已写入的选择（静默丢标签）；
  // 反过来后一次提交若直接无视旧调用，又会丢掉用户回车创建、尚在途的新标签。
  // 处理：同名创建共享在途 Promise（不重复 POST）；最新一次调用整体替换 selectedTags，
  // 过期调用只把自己解析出的标签按名称合并进最新状态，两个方向都不丢。
  const handleTagChange = async (value: Array<string | Tag>) => {
    const seq = ++tagChangeSeqRef.current;
    const nextTags: Tag[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        const name = item.trim();
        if (!name) continue;
        const existing = tags.find((tag) => tag.name === name);
        if (existing) {
          nextTags.push(existing);
          continue;
        }
        let pending = pendingTagCreationsRef.current.get(name);
        if (!pending) {
          pending = onCreateTag(name);
          pendingTagCreationsRef.current.set(name, pending);
          void pending.finally(() => {
            if (pendingTagCreationsRef.current.get(name) === pending) {
              pendingTagCreationsRef.current.delete(name);
            }
          });
        }
        const tag = await pending;
        // 创建失败必须可见地反馈：静默丢弃会让用户以为已带上标签，实际保存的记录没有该标签。
        if (!tag) {
          showSnackbar(`标签「${name}」创建失败，请稍后重试`, 'error');
          continue;
        }
        nextTags.push(tag);
      } else {
        nextTags.push(item);
      }
    }
    if (seq === tagChangeSeqRef.current) {
      setSelectedTags(nextTags);
    } else {
      // 过期调用：不能整体替换覆盖后一次的选择，只按名称合并自己解析出的标签。
      setSelectedTags((prev) => {
        const merged = [...prev];
        for (const tag of nextTags) {
          if (!merged.some((selected) => selected.name === tag.name)) merged.push(tag);
        }
        return merged;
      });
    }
  };

  const yesterday = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      fullScreen={isMobile}
      PaperProps={{ sx: isMobile ? { borderRadius: 0 } : undefined }}
    >
      <DialogTitle>{transaction ? '编辑记录' : '记一笔'}</DialogTitle>
      <DialogContent
        sx={{
          px: { xs: 2, sm: 3 },
          // 注意：flex 布局放在内层 Box 而不是 DialogContent 上——
          // DialogContent 高度受限时 flex 子项会被压缩（overflow hidden 的子项 min-height 归零），
          // 导致类型切换按钮组塌陷成 2px。内层 Box 让内容自然撑高、由 DialogContent 滚动。
          pb: { xs: 10, sm: 2 },
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        {/* 类型切换 */}
        <ToggleButtonGroup
          value={type}
          exclusive
          onChange={(_, value) => value && handleTypeChange(value)}
          fullWidth
        >
          <ToggleButton value="expense" aria-label="支出">
            支出
          </ToggleButton>
          <ToggleButton value="income" aria-label="收入">
            收入
          </ToggleButton>
        </ToggleButtonGroup>

        {/* 金额：大号输入 + ¥ 前缀，移动端唤起数字键盘 */}
        <TextField
          label="金额"
          type="number"
          inputMode="decimal"
          inputProps={{ step: '0.01', min: '0' }}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
          fullWidth
          autoFocus={!isMobile}
          InputProps={{
            startAdornment: (
              <Box component="span" sx={{ mr: 1, fontFamily: FONT_SERIF, fontSize: '1.4rem', color: 'text.secondary', lineHeight: 1 }}>
                ¥
              </Box>
            ),
            sx: { '& input': { fontSize: '1.5rem', fontWeight: 700, ...NUMERIC_TEXT, fontFamily: FONT_SERIF } },
          }}
          ref={amountInputRef}
        />

        {/* 分类：图标网格一次点选 */}
        <Box>
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1 }}>
            分类 *
          </Typography>
          <Box
            role="listbox"
            aria-label="分类选择"
            sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 1 }}
          >
            {filteredCategories.map((cat) => {
              const selected = cat.id === categoryId;
              return (
                <Box
                  key={cat.id}
                  component="button"
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-category-id={cat.id}
                  onClick={() => setCategoryId(cat.id)}
                  sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 0.75,
                    px: 1,
                    py: 1.25,
                    bgcolor: selected ? 'secondary.main' : 'subcard',
                    color: selected ? '#0a0a0f' : 'text.primary',
                    border: '1px solid',
                    borderColor: selected ? 'secondary.dark' : 'divider',
                    borderRadius: 1,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    transition: 'all 160ms cubic-bezier(0.23, 1, 0.32, 1)',
                    '&:hover': { borderColor: 'secondary.main' },
                    '&:focus-visible': { outline: '2px solid', outlineColor: 'secondary.main', outlineOffset: 1 },
                  }}
                >
                  <Box sx={{ opacity: selected ? 1 : 0.9, filter: selected ? 'grayscale(0.2)' : 'none' }}>
                    <CategoryAvatar category={cat} size={30} />
                  </Box>
                  <Typography
                    variant="caption"
                    noWrap
                    sx={{ maxWidth: '100%', fontWeight: selected ? 700 : 500, color: 'inherit' }}
                  >
                    {cat.name}
                  </Typography>
                </Box>
              );
            })}
            {filteredCategories.length === 0 && (
              <Typography variant="body2" sx={{ color: 'text.secondary', gridColumn: '1 / -1' }}>
                {categoriesLoadFailed ? '分类加载失败，请稍后重试' : '该类型下暂无分类，请先在设置中创建'}
              </Typography>
            )}
          </Box>
        </Box>

        {/* 日期：今天/昨天快捷键 + 日期选择 */}
        <Box>
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1 }}>
            日期 *
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <Chip
              label="今天"
              size="small"
              color={date === today ? 'primary' : 'default'}
              variant={date === today ? 'filled' : 'outlined'}
              onClick={() => handleDateChange(today)}
            />
            <Chip
              label="昨天"
              size="small"
              color={date === yesterday ? 'primary' : 'default'}
              variant={date === yesterday ? 'filled' : 'outlined'}
              onClick={() => handleDateChange(yesterday)}
            />
            <TextField
              type="date"
              size="small"
              value={date}
              onChange={(e) => handleDateChange(e.target.value)}
              required
              sx={{ flex: { xs: '1 1 140px', sm: '0 1 180px' }, minWidth: 140 }}
              InputLabelProps={{ shrink: true }}
            />
          </Box>
        </Box>

        <Autocomplete
          multiple
          freeSolo
          options={tags}
          value={selectedTags}
          onChange={(_, value) => {
            void handleTagChange(value);
          }}
          getOptionLabel={(option) => typeof option === 'string' ? option : option.name}
          renderTags={(value, getTagProps) =>
            value.map((option, index) => (
              <Chip label={typeof option === 'string' ? option : option.name} {...getTagProps({ index })} />
            ))
          }
          renderInput={(params) => (
            <TextField {...params} label="标签" placeholder="选择或创建标签" />
          )}
        />

        <TextField
          label="备注"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          fullWidth
          multiline
          rows={2}
        />
        </Box>
      </DialogContent>

      <DialogActions
        sx={{
          px: { xs: 2, sm: 3 },
          py: 2,
          // 移动端全屏时固定底部操作条
          position: isMobile ? 'fixed' : 'static',
          bottom: 0,
          left: 0,
          right: 0,
          bgcolor: 'background.paper',
          borderTop: isMobile ? '1px solid' : 'none',
          borderColor: 'divider',
          gap: 1,
        }}
      >
        <Button onClick={onClose} disabled={submitting}>取消</Button>
        {!transaction && (
          <Button
            onClick={() => void handleSubmit(true)}
            variant="outlined"
            disabled={!amount || !categoryId || !date || submitting}
          >
            保存并再记
          </Button>
        )}
        <Button
          onClick={() => void handleSubmit(false)}
          variant="contained"
          disabled={!amount || !categoryId || !date || submitting}
        >
          {submitting ? '保存中…' : transaction ? '保存' : '添加'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
