// Express 应用组装：挂载中间件与路由并导出 app，供入口启动与路由测试（supertest）复用。
import express from 'express';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { logger, httpLoggerStream } from './utils/logger';
import { HttpError, isForeignKeyError } from './utils/errors';
import { requireAuth } from './middleware/auth';
import authRoutes from './routes/auth';
import categoryRoutes from './routes/categories';
import tagRoutes from './routes/tags';
import transactionRoutes from './routes/transactions';
import budgetRoutes from './routes/budgets';
import importExportRoutes from './routes/importExport';
import settingsRoutes from './routes/settings';
import backupRoutes from './routes/backups';
import { rejectDuringMaintenance } from './maintenance';

const app = express();

// 默认不信任 X-Forwarded-For（登录限流按直连对端 IP 计数，防止伪造绕过）。
// 部署在反向代理后时通过 TRUST_PROXY 声明可信代理，支持三种取值：
//   TRUST_PROXY=1          信任倒数第 N 跳（推荐：N=反代层数，客户端伪造的 XFF 会被忽略）
//   TRUST_PROXY=true       信任全部跳数（仅当端口无法绕过反代直连时才安全，否则限流可被伪造头重置）
//   TRUST_PROXY=10.0.0.1,loopback   逗号分隔的可信代理 IP/网段/表达式
const trustProxy = process.env.TRUST_PROXY?.trim();
if (trustProxy) {
  if (/^\d+$/.test(trustProxy)) {
    app.set('trust proxy', Number(trustProxy));
  } else if (trustProxy === 'true' || trustProxy === 'false') {
    app.set('trust proxy', trustProxy === 'true');
  } else {
    app.set('trust proxy', trustProxy.split(',').map((value) => value.trim()).filter(Boolean));
  }
}

// 前端 SPA 与 API 始终同源（生产由本服务托管，开发由 Vite 代理），不存在合法跨域调用方，
// 因此不再开放 CORS，避免任意来源读取/调用接口。
// /api/import 需要接受较大的 JSON（导入预览大批量行勾选的 selection 更新会超过全局 100kb 默认值）。
// 该中间件必须先于全局 json 挂载（body-parser 会跳过已解析 req._body 的请求；multipart 不受影响），
// 但解析之前先执行鉴权：匿名请求直接 401，不再为未登录流量缓冲并解析最多 20MB 的请求体。
app.use('/api/import', rejectDuringMaintenance, requireAuth, express.json({ limit: '20mb' }));
app.use(express.json());

// Express 5 不再把 req.body 默认置为 {}：非 JSON Content-Type（或缺省）的请求体为 undefined，
// 路由层解构会抛 TypeError 变成 500。统一归一为空对象，让校验层给出 400 的明确业务错误。
app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
  if (req.body === undefined) req.body = {};
  next();
});

// 安全响应头：CSP（限制脚本/样式来源）、点击劫持、MIME 嗅探、引用策略。
// MUI/emotion 需要内联样式，因此 style-src 放行 'unsafe-inline'；Google Fonts 来自 gstatic。
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    // 放行 Cloudflare 官方统计脚本（域名走 Cloudflare 时自动注入），其余第三方脚本仍被阻止。
    "script-src 'self' https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    // MUI 图标字体（Material Icons）以 data: URI 内联，需放行 data: 否则图标不显示。
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
});

// HTTP 访问日志；健康检查心跳不打日志，避免刷屏。
app.use(morgan('combined', { stream: httpLoggerStream, skip: (req) => req.path === '/api/health' }));

// 健康检查接口保持公开，供容器健康检查与监控使用。
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 恢复期间数据库连接会短暂关闭，在鉴权查询数据库前统一拒绝新 API 请求。
app.use('/api', rejectDuringMaintenance);

// 鉴权相关接口对外公开（创建账户、登录、登出、查询状态）。
app.use('/api/auth', authRoutes);

// 除健康检查和鉴权接口外，其余全部 API 一律要求登录，未登录统一返回 401。
app.use('/api', requireAuth);

app.use('/api/categories', categoryRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/budgets', budgetRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/backups', backupRoutes);
app.use('/api', importExportRoutes);

if (process.env.NODE_ENV === 'production') {
  const clientDistPath = path.join(__dirname, '..', '..', 'client', 'dist');
  const indexPath = path.join(clientDistPath, 'index.html');

  if (fs.existsSync(indexPath)) {
    app.use(express.static(clientDistPath));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) {
        return next();
      }
      res.sendFile(indexPath);
    });
  }
}

// 统一错误处理：HttpError（或带 4xx status 的错误）按对应状态码返回 JSON，其余异常返回 500 且不泄露内部信息。
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // 外键约束违规（引用了不存在的分类/标签等）是调用方输入问题，按 400 处理而非服务器错误。
  if (isForeignKeyError(err)) {
    res.status(400).json({ error: '引用的分类或标签不存在' });
    return;
  }

  const httpError = err as Partial<HttpError> & Error;
  let status: number;
  if (err instanceof HttpError) {
    status = err.status;
  } else if (typeof httpError.status === 'number' && httpError.status >= 400 && httpError.status < 500) {
    status = httpError.status;
  } else {
    status = 500;
  }

  if (status >= 500) {
    logger.error(`Unhandled error: ${httpError.message || 'Unknown'}`, { stack: httpError.stack });
  }
  res.status(status).json({ error: status < 500 ? httpError.message : '服务器内部错误' });
});

export default app;
