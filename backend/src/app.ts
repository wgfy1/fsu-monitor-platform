import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import bodyParser from 'body-parser';
import { responseMiddleware } from './utils/response';
import healthRouter from './routes/health';
import authRouter from './routes/auth';
import usersRouter from './routes/users';
import devicesRouter from './routes/devices';
import deviceImportRouter from './routes/deviceImport';
import alarmsRouter from './routes/alarms';
import configRouter from './routes/config';
import sitesRouter from './routes/sites';
import regionsRouter from './routes/regions';
import tenantsRouter from './routes/tenants';
import notifyRouter from './routes/notify';
import { authMiddleware } from './middleware/auth';

/**
 * 前端构建产物目录（后端托管前端，单端口部署，配合 cpolar 一个地址访问平台）
 * 默认 <backend>/../frontend/build；可用环境变量 STATIC_DIR 覆盖（如 Docker 内 /app/frontend-build）
 */
const STATIC_DIR = process.env.STATIC_DIR || path.resolve(__dirname, '../../frontend/build');

/**
 * 创建Express应用
 * 设备在线/离线状态由 MQTT 连接状态、心跳超时与数据超时共同判定
 */
function createApp(): express.Application {
  const app = express();

  // 中间件配置
  app.use(cors());

  // ============================================================
  // body-parser 配置：显式错误处理，防止静默失败
  // ============================================================
  app.use(bodyParser.json({
    // 严格模式：Content-Type 必须是 application/json，否则 req.body 保持原始形态
    type: 'application/json',
    // 限制请求体大小
    limit: '1mb'
  }));
  app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));

  // body-parser 错误处理（捕获 JSON 解析错误）
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      console.error('[body-parser] JSON 解析错误:', err.message);
      console.error('[body-parser] 原始请求体:', (req as any).rawBody);
      res.status(400).json({
        code: 400,
        data: null,
        message: '请求体 JSON 格式错误: ' + err.message
      });
      return;
    }
    next(err);
  });

  // 注册响应扩展中间件
  app.use(responseMiddleware);

  // ============================================================
  // 请求日志中间件（增强版：打印完整请求概览）
  // ============================================================
  app.use((req, _res, next) => {
    const ts = new Date().toISOString();
    console.log(`[${ts}] >>> ${req.method} ${req.originalUrl}`);
    console.log(`[${ts}]     Headers: content-type=${req.headers['content-type']}, content-length=${req.headers['content-length']}`);
    // 在开发阶段打印 body 前 500 字符用于调试
    if (req.body && Object.keys(req.body).length > 0) {
      const bodyStr = JSON.stringify(req.body);
      console.log(`[${ts}]     Body(${bodyStr.length}bytes): ${bodyStr.substring(0, 500)}`);
    }
    next();
  });

  // ============================================================
  // 路由注册
  // ============================================================
  // /webhook 下只剩通用健康检查（原第三方推送 webhook 已下线删除）
  app.use('/webhook', healthRouter);

  // 认证路由（/api/auth/login 公开；/me、/change-password、/logout 内部自挂 authMiddleware）
  app.use('/api/auth', authRouter);

  // 服务信息（公开，供部署验证/健康探测）
  app.get('/api/info', (_req, res) => {
    res.sendSuccess({
      name: 'FSU设备监控平台API',
      version: '1.0.0',
      timestamp: Date.now()
    }, '服务正常运行');
  });

  // 全量 API 鉴权：覆盖 /api/devices、/api/alarms、/api/config、/api/users 等全部业务接口
  app.use('/api', authMiddleware);

  // 租户管理（仅平台管理员；路由内部 requirePlatformAdmin）
  app.use('/api/tenants', tenantsRouter);

  // 用户管理（路由内部 requireAdmin，仅管理员）
  app.use('/api/users', usersRouter);

  // 设备批量导入：必须注册在 devicesRouter **之前**，
  // 否则 /api/devices/:id 系列路由会把 "import" 当成设备ID。
  app.use('/api/devices/import', deviceImportRouter);
  app.use('/api/devices', devicesRouter);
  app.use('/api/alarms', alarmsRouter);
  // 站点管理（租户 → 站点 → 设备；路由内部按登录态做租户隔离）
  app.use('/api/sites', sitesRouter);
  // 全国行政区划级联基础数据（省市县选择用，只读）
  app.use('/api/regions', regionsRouter);
  app.use('/api/config', configRouter);
  // 告警推送配置与记录（路由内部 requireAdmin，仅管理员）
  app.use('/api/notify', notifyRouter);

  // ============================================================
  // 前端静态托管（单端口部署：一个地址同时服务页面与 API）
  // ============================================================
  const indexHtml = path.join(STATIC_DIR, 'index.html');
  const hasFrontend = fs.existsSync(indexHtml);
  if (hasFrontend) {
    app.use(express.static(STATIC_DIR, {
      // 带 hash 的静态资源可长期缓存
      maxAge: '1d',
      setHeaders: (res, filePath) => {
        // index.html 必须不缓存：它引用的是带 hash 的资源文件名，
        // 若被缓存，重新构建后浏览器仍用旧 HTML 去请求已不存在的旧 hash 资源 → 整页白屏
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }));
    // SPA 路由回退：非 /api、/webhook 的 GET 一律返回 index.html（由前端路由接管）
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/webhook')) return next();
      // 静态资源路径不参与回退：缺失的 /static/* 返回真实 404。
      // 否则会把 index.html 当成 JS/CSS 返回（HTTP 200 + text/html），
      // 浏览器解析 HTML 得到 SyntaxError，React 无法挂载 → 白屏
      if (req.path.startsWith('/static/')) {
        res.status(404).type('text/plain').send('静态资源不存在');
        return;
      }
      res.sendFile(indexHtml, { headers: { 'Cache-Control': 'no-cache' } });
    });
    console.log(`[静态托管] 前端产物: ${STATIC_DIR}`);
  } else {
    // 无前端产物：兼容纯 API 部署，保留根路径信息
    app.get('/', (_req, res) => {
      res.sendSuccess({
        name: 'FSU设备监控平台API',
        version: '1.0.0',
        timestamp: Date.now()
      }, '服务正常运行');
    });
  }

  // ============================================================
  // 兜底：记录所有未匹配的 POST 请求（便于排查推错地址）
  // ============================================================
  app.post('*', (req, res) => {
    console.warn(`[UNMATCHED POST] ${req.method} ${req.originalUrl}`);
    console.warn(`[UNMATCHED POST] Headers:`, JSON.stringify(req.headers, null, 2));
    console.warn(`[UNMATCHED POST] Body:`, JSON.stringify(req.body, null, 2));
    res.sendNotFound(`接口不存在: ${req.method} ${req.originalUrl}`);
  });

  // 404处理
  app.use((req, res) => {
    res.sendNotFound(`接口不存在: ${req.method} ${req.originalUrl}`);
  });

  // 错误处理中间件
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(`[${new Date().toISOString()}] 服务器错误:`, err);
    console.error(`[服务器错误] 请求: ${req.method} ${req.originalUrl}`);
    console.error(`[服务器错误] Body:`, JSON.stringify(req.body, null, 2));
    res.status(500).json({
      code: 500,
      data: null,
      message: err.message || '服务器内部错误'
    });
  });

  return app;
}

export { createApp };