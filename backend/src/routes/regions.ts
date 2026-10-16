import { Router, Request, Response } from 'express';
import RegionService from '../services/regionService';

const router = Router();

/**
 * 全国行政区划级联查询（省 / 市 / 区县）
 * 供站点表单的级联选择使用，前端不硬编码任何区划数组。
 * 已挂在全局 /api 鉴权之后，需登录访问。
 */

/**
 * 获取省级列表
 * GET /api/regions/provinces
 */
router.get('/provinces', (_req: Request, res: Response) => {
  try {
    res.sendSuccess(RegionService.getProvinces(), '获取省份列表成功');
  } catch (error) {
    console.error('获取省份列表失败:', error);
    res.sendServerError('获取省份列表失败');
  }
});

/**
 * 获取指定省下的市级列表
 * GET /api/regions/cities?province=11
 */
router.get('/cities', (req: Request, res: Response) => {
  try {
    const province = String(req.query.province || '').trim();
    if (!province) {
      return res.sendBadRequest('缺少 province 参数');
    }
    res.sendSuccess(RegionService.getCities(province), '获取城市列表成功');
  } catch (error) {
    console.error('获取城市列表失败:', error);
    res.sendServerError('获取城市列表失败');
  }
});

/**
 * 获取指定市下的区县列表
 * GET /api/regions/districts?city=1101
 */
router.get('/districts', (req: Request, res: Response) => {
  try {
    const city = String(req.query.city || '').trim();
    if (!city) {
      return res.sendBadRequest('缺少 city 参数');
    }
    res.sendSuccess(RegionService.getDistricts(city), '获取区县列表成功');
  } catch (error) {
    console.error('获取区县列表失败:', error);
    res.sendServerError('获取区县列表失败');
  }
});

export default router;
