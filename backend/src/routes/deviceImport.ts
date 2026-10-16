/**
 * 设备 Excel 批量导入路由
 *
 *   POST /api/devices/import/preview   上传 Excel → 解析 → 预校验 → 返回预览（**不写库**）
 *   POST /api/devices/import/confirm   携预校验令牌确认 → 事务写入（全成功或全回滚）
 *   GET  /api/devices/import/template  下载 Excel 模板（设备导入 + 填写说明 两个 Sheet）
 *
 * 挂载点：必须注册在 devicesRouter **之前**（见 app.ts），
 * 避免 /api/devices/:id 系列路由把 "import" 当成设备ID。
 *
 * 权限：导入 = 创建设备，因此与 POST /api/devices 保持一致（requireAdmin）。
 *      租户隔离由 service 按**登录态**强制（普通租户不可能指定其他租户）。
 */
import { Router, Request, Response } from 'express';
import multer from 'multer';
import {
  previewImport, confirmImport, buildTemplateWorkbook, ImportError,
  MAX_IMPORT_FILE_BYTES, MAX_IMPORT_ROWS, TEMPLATE_SHEET,
} from '../services/deviceImportService';
import { requireAdmin, isPlatformOperator } from '../middleware/auth';

const router = Router();

/**
 * 上传中间件：内存存储 + 大小/数量限制
 * 不落磁盘：导入是一次性的解析任务，没有留存原始文件的必要（也不引入清理逻辑）。
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_FILE_BYTES, files: 1 },
});

/** xlsx 是 zip 容器，头部固定为 PK\x03\x04 —— 用它做内容级校验，不轻信前端声明的类型 */
function isZipContainer(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b
    && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

/**
 * 包装 multer 中间件，把 MulterError 翻译成明确的中文提示
 * （超限时 multer 会中断请求，必须由这里兜住，否则会变成 500）
 */
function uploadSingle(req: Request, res: Response, next: (err?: any) => void): void {
  upload.single('file')(req, res, (err: any) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.sendBadRequest(
          `Excel 文件过大，最大允许 ${Math.floor(MAX_IMPORT_FILE_BYTES / 1024 / 1024)}MB`
        );
        return;
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        res.sendBadRequest('文件字段名必须为 file（一次只能上传一个文件）');
        return;
      }
      res.sendBadRequest(`文件上传失败：${err.message}`);
      return;
    }
    console.error('[设备导入] 文件上传异常:', err);
    res.sendBadRequest(`文件上传失败：${err?.message || err}`);
  });
}

/**
 * 导入权限上下文：登录租户（普通租户强制本租户；平台管理员为 null）
 * ⚠️ 一律以**登录态**为准，绝不读取 Excel / 请求体里的 tenantId 作为授权依据。
 */
function importContext(req: Request): { loginTenantId: string | null } {
  return {
    loginTenantId: isPlatformOperator(req.user) ? null : (req.user?.tenantId ?? null),
  };
}

/**
 * 上传 Excel 并预校验（**不写数据库**）
 * POST /api/devices/import/preview   multipart/form-data, field: file
 */
router.post('/preview', requireAdmin, uploadSingle, async (req: Request, res: Response) => {
  try {
    const file = req.file;
    if (!file) {
      return res.sendBadRequest('请选择要导入的 Excel 文件');
    }
    if (!/\.xlsx$/i.test(file.originalname || '')) {
      return res.sendBadRequest('仅支持 .xlsx 格式的 Excel 文件，请使用平台提供的模板');
    }
    if (!isZipContainer(file.buffer)) {
      return res.sendBadRequest('文件内容不是有效的 .xlsx 文件（可能已损坏或仅是改了扩展名）');
    }

    const result = await previewImport(file.buffer, importContext(req));
    console.log(
      `[设备导入] 预校验: 文件=${file.originalname}, 总 ${result.total} 行, ` +
      `可导入 ${result.valid} 行, 错误 ${result.invalid} 行`
    );
    res.sendSuccess(
      { ...result, sheet: TEMPLATE_SHEET, maxRows: MAX_IMPORT_ROWS },
      `预校验完成：可导入 ${result.valid} 行，错误 ${result.invalid} 行`
    );
  } catch (error: any) {
    if (error instanceof ImportError) {
      return res.sendBadRequest(error.message);
    }
    console.error('设备导入预校验失败:', error);
    res.sendServerError('设备导入预校验失败');
  }
});

/**
 * 确认导入（事务写入）
 * POST /api/devices/import/confirm   Body: { token }
 *
 * token 由 /preview 返回；服务端验签 + 对数据库**重新校验**后，
 * 在单个事务内写入全部设备，任一行失败整体回滚。
 */
router.post('/confirm', requireAdmin, async (req: Request, res: Response) => {
  try {
    const result = await confirmImport(req.body?.token, importContext(req));
    res.sendSuccess(result, `成功导入 ${result.imported} 台设备`);
  } catch (error: any) {
    if (error instanceof ImportError) {
      return res.sendBadRequest(error.message);
    }
    console.error('设备导入失败:', error);
    res.sendServerError('设备导入失败');
  }
});

/**
 * 下载 Excel 模板
 * GET /api/devices/import/template
 */
router.get('/template', async (_req: Request, res: Response) => {
  try {
    const buf = await buildTemplateWorkbook();
    const asciiName = 'device-import-template.xlsx';
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; ` +
      `filename*=UTF-8''${encodeURIComponent('设备导入模板.xlsx')}`
    );
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  } catch (error) {
    console.error('生成导入模板失败:', error);
    res.sendServerError('生成导入模板失败');
  }
});

export default router;
