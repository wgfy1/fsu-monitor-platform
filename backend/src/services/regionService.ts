import regionsData from '../data/regions.json';

/**
 * 全国行政区划基础数据服务（省 / 市 / 区县 三级）
 *
 * 数据来源：backend/src/data/regions.json（随代码发布，只读基础数据）
 * 覆盖：31 个省级行政区（大陆），342 个市级，2978 个区县级。
 *
 * 设计说明：
 *  - 区划数据是只读基础数据，不做成数据库表：避免每次部署多一次 migration，
 *    也避免把 3000 行静态数据塞进业务库。
 *  - 前端只通过接口级联获取，不在前端硬编码区划数组。
 *  - 站点表只存 code，展示时由本服务解析出名称（保证名称始终与基础数据一致）。
 */

/** 行政区划节点 */
export interface RegionNode {
  code: string;
  name: string;
  children?: RegionNode[];
}

/** 区划扁平索引项 */
interface RegionIndexEntry {
  name: string;
  /** 1=省 2=市 3=区县 */
  level: number;
  parentCode: string | null;
}

const REGIONS = regionsData as RegionNode[];

/**
 * code → { name, level, parentCode } 扁平索引
 * 用于把站点存的 code 反解成名称；构建一次，进程内复用
 */
const regionIndex = new Map<string, RegionIndexEntry>();

(function buildIndex(): void {
  for (const province of REGIONS) {
    regionIndex.set(province.code, { name: province.name, level: 1, parentCode: null });
    for (const city of province.children || []) {
      regionIndex.set(city.code, { name: city.name, level: 2, parentCode: province.code });
      for (const district of city.children || []) {
        regionIndex.set(district.code, { name: district.name, level: 3, parentCode: city.code });
      }
    }
  }
})();

export class RegionService {
  /** 省级列表（不含下级，减小响应体） */
  static getProvinces(): { code: string; name: string }[] {
    return REGIONS.map((p) => ({ code: p.code, name: p.name }));
  }

  /** 指定省下的市级列表 */
  static getCities(provinceCode: string): { code: string; name: string }[] {
    const province = REGIONS.find((p) => p.code === provinceCode);
    if (!province) return [];
    return (province.children || []).map((c) => ({ code: c.code, name: c.name }));
  }

  /** 指定市下的区县列表 */
  static getDistricts(cityCode: string): { code: string; name: string }[] {
    for (const province of REGIONS) {
      const city = (province.children || []).find((c) => c.code === cityCode);
      if (city) return (city.children || []).map((d) => ({ code: d.code, name: d.name }));
    }
    return [];
  }

  /** code 是否存在且层级正确（用于站点保存时校验，防止伪造 code） */
  static isValid(code: string | null | undefined, level: 1 | 2 | 3): boolean {
    if (!code) return false;
    const entry = regionIndex.get(code);
    return !!entry && entry.level === level;
  }

  /**
   * code → 名称（找不到返回 null）
   */
  static getName(code: string | null | undefined): string | null {
    if (!code) return null;
    return regionIndex.get(code)?.name ?? null;
  }

  /**
   * 校验省/市/区三级是否构成合法的上下级关系
   * 用于站点保存：避免出现「广东省 / 长沙市」这类不匹配的组合
   * 允许只填到省或市（区县选填）
   */
  static validateChain(
    provinceCode: string | null | undefined,
    cityCode: string | null | undefined,
    districtCode: string | null | undefined
  ): string | null {
    if (!provinceCode) return null; // 允许不填地区
    if (!RegionService.isValid(provinceCode, 1)) {
      return '省份不存在';
    }
    if (cityCode) {
      if (!RegionService.isValid(cityCode, 2)) return '城市不存在';
      if (regionIndex.get(cityCode)?.parentCode !== provinceCode) {
        return '所选城市不属于所选省份';
      }
    }
    if (districtCode) {
      if (!cityCode) return '请先选择城市再选择区县';
      if (!RegionService.isValid(districtCode, 3)) return '区县不存在';
      if (regionIndex.get(districtCode)?.parentCode !== cityCode) {
        return '所选区县不属于所选城市';
      }
    }
    return null;
  }

  /** 基础数据规模（健康检查/调试用） */
  static getStats(): { provinces: number; cities: number; districts: number } {
    let cities = 0;
    let districts = 0;
    for (const p of REGIONS) {
      cities += (p.children || []).length;
      for (const c of p.children || []) districts += (c.children || []).length;
    }
    return { provinces: REGIONS.length, cities, districts };
  }
}

export default RegionService;
