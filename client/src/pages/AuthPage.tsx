// 登录/初始化页：首次运行时展示“创建账户”，之后展示登录表单。
// 视觉沿用主布局的 grain 纹理与 Playfair 字体，保持品牌一致。
import { useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  TextField,
  Button,
  Alert,
  IconButton,
  InputAdornment,
  CircularProgress,
} from '@mui/material';
import { Brightness4, Brightness7, LockOutlined, Visibility, VisibilityOff } from '@mui/icons-material';
import { useLocation, useNavigate } from 'react-router-dom';
import Logo from '../components/Layout/Logo';
import { useAuthStore } from '../stores/authStore';
import { getApiErrorMessage } from '../api';
import { ROUTES } from '../constants/routes';

interface AuthPageProps {
  isDarkMode: boolean;
  onThemeToggle: () => void;
}

export default function AuthPage({ isDarkMode, onThemeToggle }: AuthPageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const status = useAuthStore((state) => state.status);
  const setup = useAuthStore((state) => state.setup);
  const login = useAuthStore((state) => state.login);

  const isSetup = status === 'setup';

  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError('');

    if (isSetup && !token.trim()) {
      setFormError('请输入初始化 Token');
      return;
    }
    if (!username.trim()) {
      setFormError('请输入用户名');
      return;
    }
    if (password.length < 8) {
      setFormError('密码长度至少需要 8 位');
      return;
    }
    if (isSetup && password !== confirmPassword) {
      setFormError('两次输入的密码不一致');
      return;
    }

    setSubmitting(true);
    try {
      if (isSetup) {
        await setup(token.trim(), username.trim(), password);
      } else {
        await login(username.trim(), password);
      }
      // 登录/初始化成功后回到用户原本要访问的页面；
      // 仅允许同源单斜杠相对路径，防止 //evil.com 这类协议相对 URL 造成开放重定向；
      // 且目标必须是应用内已注册的业务路由（或其子路径），未知路径一律回首页，
      // 避免登录后落入无 404 兜底的空白内容区。
      const candidate = location.pathname.startsWith('/') && !location.pathname.startsWith('//')
        ? `${location.pathname}${location.search}`
        : '/';
      const knownRoutes = Object.values(ROUTES);
      const isKnownRoute = knownRoutes.some((route) => (
        candidate === route || candidate.startsWith(`${route}/`)
      ));
      navigate(isKnownRoute ? candidate : '/');
    } catch (error) {
      // 复用 api 层的错误文案提取：本地重复实现的版本在网络错误时回退英文 axios 文案
      setFormError(getApiErrorMessage(error, '登录失败，请稍后重试'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        bgcolor: 'background.default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        px: 2,
        '&::before': {
          content: '""',
          position: 'fixed',
          inset: 0,
          opacity: isDarkMode ? 0.03 : 0.02,
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
          pointerEvents: 'none',
        },
      }}
    >
      {/* 主题切换按钮 */}
      <IconButton
        aria-label="切换主题"
        onClick={onThemeToggle}
        sx={{
          position: 'absolute',
          top: 20,
          right: 20,
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 1,
          p: 1,
        }}
      >
        {isDarkMode ? (
          <Brightness7 sx={{ fontSize: 18, color: 'secondary.main' }} />
        ) : (
          <Brightness4 sx={{ fontSize: 18 }} />
        )}
      </IconButton>

      <Paper
        component="form"
        onSubmit={handleSubmit}
        elevation={0}
        sx={{
          width: '100%',
          maxWidth: 420,
          p: { xs: 3, sm: 5 },
          borderRadius: 2,
          border: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Box sx={{ mb: 3, display: 'flex', justifyContent: 'center' }}>
          <Logo isDarkMode={isDarkMode} />
        </Box>

        <Typography
          variant="h4"
          align="center"
          sx={{ fontSize: '1.6rem', mb: 0.5 }}
        >
          {isSetup ? '创建登录账户' : '欢迎回来'}
        </Typography>
        <Typography
          variant="body2"
          align="center"
          sx={{ color: 'text.secondary', mb: 3 }}
        >
          {isSetup ? '使用日志中的初始化 Token 创建唯一账户' : '请登录后继续使用记账本'}
        </Typography>

        {isSetup && (
          <Alert severity="info" sx={{ mb: 3 }}>
            请到服务器日志查看初始化 Token，例如：<code>docker compose logs -f app</code>
          </Alert>
        )}

        {formError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {formError}
          </Alert>
        )}

        {isSetup && (
          <TextField
            label="初始化 Token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            fullWidth
            required
            margin="dense"
            autoComplete="off"
          />
        )}

        <TextField
          label="用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          fullWidth
          required
          margin="dense"
          autoComplete="username"
          inputProps={{ maxLength: 32 }}
        />

        <TextField
          label="密码"
          type={showPassword ? 'text' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          fullWidth
          required
          margin="dense"
          autoComplete={isSetup ? 'new-password' : 'current-password'}
          InputProps={{
            endAdornment: (
              <InputAdornment position="end">
                <IconButton
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  onClick={() => setShowPassword((prev) => !prev)}
                  edge="end"
                >
                  {showPassword ? <VisibilityOff /> : <Visibility />}
                </IconButton>
              </InputAdornment>
            ),
          }}
        />

        {isSetup && (
          <TextField
            label="确认密码"
            type={showPassword ? 'text' : 'password'}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            fullWidth
            required
            margin="dense"
            autoComplete="new-password"
          />
        )}

        <Button
          type="submit"
          variant="contained"
          fullWidth
          disabled={submitting}
          startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : <LockOutlined />}
          sx={{ mt: 3, minHeight: 46 }}
        >
          {submitting ? '请稍候…' : isSetup ? '创建账户并登录' : '登录'}
        </Button>
      </Paper>
    </Box>
  );
}
