import { Router, Request, Response } from 'express';

const router = Router();

/**
 * 通用健康检查（独立保留，与已下线的第三方 webhook 无关）
 *
 * GET /webhook/health —— **对外路径保持不变**，避免打断任何外部探活。
 * 返回结构与 HTTP 状态码与原实现完全一致。
 */
router.get('/health', (_req: Request, res: Response) => {
  res.sendSuccess({
    status: 'ok',
    timestamp: Date.now()
  }, '服务正常');
});

export default router;
