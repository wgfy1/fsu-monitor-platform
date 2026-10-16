import database from '../models/database';
import RegionService from './regionService';
import { Site, SiteStatus, SiteWithStats } from '../types';

/**
 * 站点服务
 *
 * 层级：租户 → 站点 → 设备
 *  - 站点归属租户；租户只能看到/操作自己租户的站点
 *  - 设备最多归属一个站点（devices.site_id）
 *  - 站点状态不落库，由关联设备状态 + 未解决告警实时计算
 */
/**
 * 解析并校验经纬度（可为空）
 * @returns ok=false 时 message 为提示；ok=true 时 value 为数字或 null
 */
function parseCoordinate(
  raw: unknown,
  kind: 'lat' | 'lng'
): { ok: boolean; value?: number | null; message?: string } {
  const label = kind === 'lat' ? '纬度' : '经度';
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  const num = Number(raw);
  if (!Number.isFinite(num)) return { ok: false, message: `${label}必须是数字` };
  const min = kind === 'lat' ? -90 : -180;
  const max = kind === 'lat' ? 90 : 180;
  if (num < min || num > max) return { ok: false, message: `${label}需在 ${min} ~ ${max} 之间` };
  return { ok: true, value: num };
}

export class SiteService {
  /**
   * 站点编号生成：SITE-0001、SITE-0002 ...
   * 取当前最大编号 +1；唯一约束兜底，并发冲突时由调用方重试
   */
  private static async nextSiteCode(): Promise<string> {
    const row = await database.get(
      `SELECT code FROM sites WHERE code LIKE 'SITE-%' ORDER BY CAST(SUBSTR(code, 6) AS INTEGER) DESC LIMIT 1`
    );
    const last = row?.code ? parseInt(String(row.code).slice(5), 10) : 0;
    const next = (Number.isFinite(last) ? last : 0) + 1;
    return `SITE-${String(next).padStart(4, '0')}`;
  }

  /**
   * 计算站点状态
   *  - 无关联设备        → unassigned（未分配设备）
   *  - 有未解决告警      → alarm（告警）
   *  - 设备全部离线      → offline（离线）
   *  - 其余              → normal（正常）
   * 告警优先级高于离线：有告警时即使设备离线也先报"告警"
   */
  private static computeStatus(deviceCount: number, onlineCount: number, alarmCount: number): SiteStatus {
    if (deviceCount === 0) return 'unassigned';
    if (alarmCount > 0) return 'alarm';
    if (onlineCount === 0) return 'offline';
    return 'normal';
  }

  /**
   * 为一批站点补充统计信息（设备数/在线数/告警数/状态/区划名称）
   * 采用聚合查询，避免逐站点 N+1
   */
  private static async attachStats(sites: Site[]): Promise<SiteWithStats[]> {
    if (sites.length === 0) return [];

    const ids = sites.map((s) => s.id);
    const placeholders = ids.map(() => '?').join(',');

    // 各站点设备数 / 在线数
    const deviceRows = await database.query(
      `SELECT site_id,
              COUNT(*) AS device_count,
              SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online_count
       FROM devices
       WHERE site_id IN (${placeholders})
       GROUP BY site_id`,
      ids
    );
    const deviceMap = new Map<number, { deviceCount: number; onlineCount: number }>();
    for (const r of deviceRows) {
      deviceMap.set(Number(r.site_id), {
        deviceCount: Number(r.device_count) || 0,
        onlineCount: Number(r.online_count) || 0,
      });
    }

    // 各站点未解决告警数（按站点下设备聚合，只统计未解决的）
    const alarmRows = await database.query(
      `SELECT d.site_id AS site_id, COUNT(*) AS alarm_count
       FROM alarms a
       JOIN devices d ON a.device_id = d.id
       WHERE a.resolved = 0 AND d.site_id IN (${placeholders})
       GROUP BY d.site_id`,
      ids
    );
    const alarmMap = new Map<number, number>();
    for (const r of alarmRows) {
      alarmMap.set(Number(r.site_id), Number(r.alarm_count) || 0);
    }

    return sites.map((site) => {
      const dev = deviceMap.get(site.id) || { deviceCount: 0, onlineCount: 0 };
      const alarmCount = alarmMap.get(site.id) || 0;
      return {
        ...site,
        province_name: RegionService.getName(site.province_code),
        city_name: RegionService.getName(site.city_code),
        district_name: RegionService.getName(site.district_code),
        device_count: dev.deviceCount,
        online_count: dev.onlineCount,
        alarm_count: alarmCount,
        status: SiteService.computeStatus(dev.deviceCount, dev.onlineCount, alarmCount),
      };
    });
  }

  /**
   * 站点列表
   * @param tenantId 传入时仅返回该租户站点；不传（平台管理员）返回全部
   */
  static async getSites(tenantId?: string | null): Promise<SiteWithStats[]> {
    try {
      const sql = tenantId
        ? `SELECT * FROM sites WHERE tenant_id = ? ORDER BY id DESC`
        : `SELECT * FROM sites ORDER BY id DESC`;
      const sites: Site[] = await database.query(sql, tenantId ? [tenantId] : []);
      return await SiteService.attachStats(sites);
    } catch (error) {
      console.error('获取站点列表失败:', error);
      throw error;
    }
  }

  /**
   * 站点详情
   * @param tenantId 传入时校验归属（不匹配返回 null，不暴露存在性）
   */
  static async getSiteById(id: number, tenantId?: string | null): Promise<SiteWithStats | null> {
    try {
      const sql = tenantId
        ? `SELECT * FROM sites WHERE id = ? AND tenant_id = ?`
        : `SELECT * FROM sites WHERE id = ?`;
      const site: Site | undefined = await database.get(sql, tenantId ? [id, tenantId] : [id]);
      if (!site) return null;
      const [withStats] = await SiteService.attachStats([site]);
      return withStats;
    } catch (error) {
      console.error('获取站点详情失败:', error);
      throw error;
    }
  }

  /**
   * 站点统计（首页用）
   * @param tenantId 传入时仅统计该租户
   */
  static async getSiteStats(tenantId?: string | null): Promise<{
    total: number; normal: number; alarm: number; offline: number; unassigned: number;
  }> {
    try {
      const sites = await SiteService.getSites(tenantId);
      return {
        total: sites.length,
        normal: sites.filter((s) => s.status === 'normal').length,
        alarm: sites.filter((s) => s.status === 'alarm').length,
        offline: sites.filter((s) => s.status === 'offline').length,
        unassigned: sites.filter((s) => s.status === 'unassigned').length,
      };
    } catch (error) {
      console.error('获取站点统计失败:', error);
      return { total: 0, normal: 0, alarm: 0, offline: 0, unassigned: 0 };
    }
  }

  /**
   * 创建站点
   * @param tenantId 站点归属租户（租户账号为其自身租户；平台管理员可指定，可为 null）
   */
  static async createSite(args: {
    name: string;
    tenantId?: string | null;
    provinceCode?: string | null;
    cityCode?: string | null;
    districtCode?: string | null;
    address?: string | null;
    remark?: string | null;
    latitude?: number | string | null;
    longitude?: number | string | null;
  }): Promise<{ ok: boolean; message?: string; id?: number; code?: string }> {
    try {
      const name = (args.name || '').trim();
      if (!name) return { ok: false, message: '站点名称不能为空' };
      if (name.length > 100) return { ok: false, message: '站点名称不能超过100个字符' };

      const chainError = RegionService.validateChain(
        args.provinceCode, args.cityCode, args.districtCode
      );
      if (chainError) return { ok: false, message: chainError };

      const address = (args.address || '').trim() || null;
      if (address && address.length > 200) return { ok: false, message: '详细地址不能超过200个字符' };
      const remark = (args.remark || '').trim() || null;
      if (remark && remark.length > 500) return { ok: false, message: '备注不能超过500个字符' };

      // 经纬度可为空；填写时必须合法（不做任何坐标猜测）
      const lat = parseCoordinate(args.latitude, 'lat');
      if (!lat.ok) return { ok: false, message: lat.message };
      const lng = parseCoordinate(args.longitude, 'lng');
      if (!lng.ok) return { ok: false, message: lng.message };

      const now = Math.floor(Date.now() / 1000);

      // 编号唯一约束兜底：极小概率并发冲突时重试一次
      for (let attempt = 0; attempt < 2; attempt++) {
        const code = await SiteService.nextSiteCode();
        try {
          const result = await database.run(
            `INSERT INTO sites (code, name, tenant_id, province_code, city_code, district_code, address, remark, latitude, longitude, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              code, name, args.tenantId ?? null,
              args.provinceCode || null, args.cityCode || null, args.districtCode || null,
              address, remark, lat.value ?? null, lng.value ?? null, now, now,
            ]
          );
          const id = result.lastID || 0;
          console.log(`站点创建成功: ID=${id}, 编号=${code}, 租户=${args.tenantId ?? '未分配'}`);
          return { ok: true, id, code };
        } catch (err: any) {
          const isDup = String(err?.message || '').includes('UNIQUE');
          if (!isDup || attempt === 1) throw err;
          // 编号撞车 → 重试
        }
      }
      return { ok: false, message: '站点编号生成失败，请重试' };
    } catch (error) {
      console.error('创建站点失败:', error);
      throw error;
    }
  }

  /**
   * 更新站点
   * @param tenantId 传入时仅允许更新该租户的站点
   */
  static async updateSite(
    id: number,
    patch: {
      name?: string;
      provinceCode?: string | null;
      cityCode?: string | null;
      districtCode?: string | null;
      address?: string | null;
      remark?: string | null;
      /** 传 null 表示清空坐标；不传表示保持原值 */
      latitude?: number | string | null;
      longitude?: number | string | null;
    },
    tenantId?: string | null
  ): Promise<{ ok: boolean; notFound?: boolean; message?: string }> {
    try {
      const existing = await SiteService.getSiteById(id, tenantId);
      if (!existing) return { ok: false, notFound: true, message: '站点不存在' };

      const name = patch.name !== undefined ? String(patch.name).trim() : existing.name;
      if (!name) return { ok: false, message: '站点名称不能为空' };
      if (name.length > 100) return { ok: false, message: '站点名称不能超过100个字符' };

      const provinceCode = patch.provinceCode !== undefined ? patch.provinceCode : existing.province_code;
      const cityCode = patch.cityCode !== undefined ? patch.cityCode : existing.city_code;
      const districtCode = patch.districtCode !== undefined ? patch.districtCode : existing.district_code;

      const chainError = RegionService.validateChain(provinceCode, cityCode, districtCode);
      if (chainError) return { ok: false, message: chainError };

      const address = patch.address !== undefined
        ? (String(patch.address || '').trim() || null)
        : existing.address;
      if (address && address.length > 200) return { ok: false, message: '详细地址不能超过200个字符' };
      const remark = patch.remark !== undefined
        ? (String(patch.remark || '').trim() || null)
        : existing.remark;
      if (remark && remark.length > 500) return { ok: false, message: '备注不能超过500个字符' };

      // 坐标：不传=保持原值；传空=清空；传值=校验后写回
      let latitude = (existing as any).latitude ?? null;
      if (patch.latitude !== undefined) {
        const lat = parseCoordinate(patch.latitude, 'lat');
        if (!lat.ok) return { ok: false, message: lat.message };
        latitude = lat.value ?? null;
      }
      let longitude = (existing as any).longitude ?? null;
      if (patch.longitude !== undefined) {
        const lng = parseCoordinate(patch.longitude, 'lng');
        if (!lng.ok) return { ok: false, message: lng.message };
        longitude = lng.value ?? null;
      }

      await database.run(
        `UPDATE sites SET name = ?, province_code = ?, city_code = ?, district_code = ?,
                          address = ?, remark = ?, latitude = ?, longitude = ?, updated_at = ?
         WHERE id = ?`,
        [name, provinceCode || null, cityCode || null, districtCode || null, address, remark,
          latitude, longitude, Math.floor(Date.now() / 1000), id]
      );
      console.log(`站点已更新: ID=${id}, 名称=${name}`);
      return { ok: true };
    } catch (error) {
      console.error('更新站点失败:', error);
      throw error;
    }
  }

  /**
   * 删除站点
   *
   * 安全规则（重要）：只删站点本身。
   * 关联设备、设备历史数据、历史告警一律保留，设备仅被解绑变为"未分配"。
   * 整个过程放在事务里，避免中途失败导致设备被解绑但站点还在。
   */
  static async deleteSite(id: number, tenantId?: string | null): Promise<{
    ok: boolean; notFound?: boolean; unboundDevices?: number;
  }> {
    try {
      const existing = await SiteService.getSiteById(id, tenantId);
      if (!existing) return { ok: false, notFound: true };

      const db = database.getConnection();
      const unboundDevices: number = await new Promise((resolve, reject) => {
        db.serialize(() => {
          db.run('BEGIN TRANSACTION');
          db.run('UPDATE devices SET site_id = NULL WHERE site_id = ?', [id], function (err) {
            if (err) {
              db.run('ROLLBACK');
              return reject(err);
            }
            const changes = this.changes || 0;
            db.run('DELETE FROM sites WHERE id = ?', [id], function (err2) {
              if (err2) {
                db.run('ROLLBACK');
                return reject(err2);
              }
              db.run('COMMIT', (err3) => (err3 ? reject(err3) : resolve(changes)));
            });
          });
        });
      });

      console.log(`站点已删除: ID=${id}（设备保留，${unboundDevices} 台设备已解绑为未分配）`);
      return { ok: true, unboundDevices };
    } catch (error) {
      console.error('删除站点失败:', error);
      throw error;
    }
  }

  /**
   * 绑定设备到站点（幂等：重复绑定已在站点内的设备视为成功）
   *
   * 校验：
   *  - 站点归属与调用方租户一致
   *  - 设备存在，且属于同一租户（租户不能绑定别人的设备）
   *  - 设备当前未绑定到其他站点（一个设备最多归属一个站点）
   *
   * @returns { ok, message?, bound?, failed? } failed 为逐台失败原因
   */
  static async bindDevices(
    siteId: number,
    deviceIds: string[],
    tenantId?: string | null
  ): Promise<{ ok: boolean; notFound?: boolean; message?: string; bound?: string[]; failed?: { id: string; reason: string }[] }> {
    try {
      const site = await SiteService.getSiteById(siteId, tenantId);
      if (!site) return { ok: false, notFound: true, message: '站点不存在' };

      const bound: string[] = [];
      const failed: { id: string; reason: string }[] = [];

      for (const rawId of deviceIds) {
        const deviceId = String(rawId || '').trim();
        if (!deviceId) continue;

        const device = await database.get(
          'SELECT id, tenant_id, site_id FROM devices WHERE id = ?',
          [deviceId]
        );
        if (!device) {
          failed.push({ id: deviceId, reason: '设备不存在' });
          continue;
        }
        // 租户隔离：设备归属必须与站点归属一致（防止把别的租户设备挂到本站点）
        const siteTenant = site.tenant_id ?? null;
        const deviceTenant = device.tenant_id ?? null;
        if (siteTenant !== deviceTenant) {
          failed.push({ id: deviceId, reason: '设备不属于该站点所属租户' });
          continue;
        }
        // 已在本站点 → 幂等成功
        if (device.site_id === siteId) {
          bound.push(deviceId);
          continue;
        }
        // 已属于其他站点 → 拒绝（需先解绑）
        if (device.site_id != null) {
          failed.push({ id: deviceId, reason: '设备已归属其他站点，请先解绑' });
          continue;
        }

        await database.run('UPDATE devices SET site_id = ? WHERE id = ?', [siteId, deviceId]);
        bound.push(deviceId);
      }

      if (bound.length > 0) {
        await database.run('UPDATE sites SET updated_at = ? WHERE id = ?', [Math.floor(Date.now() / 1000), siteId]);
        console.log(`站点绑定设备: 站点=${siteId}, 成功 ${bound.length} 台, 失败 ${failed.length} 台`);
      }
      return { ok: true, bound, failed };
    } catch (error) {
      console.error('绑定设备到站点失败:', error);
      throw error;
    }
  }

  /**
   * 解绑设备（设备回到"未分配"；设备本身与其历史数据、告警全部保留）
   */
  static async unbindDevices(
    siteId: number,
    deviceIds: string[],
    tenantId?: string | null
  ): Promise<{ ok: boolean; notFound?: boolean; message?: string; unbound?: string[] }> {
    try {
      const site = await SiteService.getSiteById(siteId, tenantId);
      if (!site) return { ok: false, notFound: true, message: '站点不存在' };

      const unbound: string[] = [];
      for (const rawId of deviceIds) {
        const deviceId = String(rawId || '').trim();
        if (!deviceId) continue;
        const device = await database.get('SELECT id, site_id FROM devices WHERE id = ?', [deviceId]);
        if (!device || device.site_id !== siteId) continue;
        await database.run('UPDATE devices SET site_id = NULL WHERE id = ?', [deviceId]);
        unbound.push(deviceId);
      }

      if (unbound.length > 0) {
        await database.run('UPDATE sites SET updated_at = ? WHERE id = ?', [Math.floor(Date.now() / 1000), siteId]);
        console.log(`站点解绑设备: 站点=${siteId}, ${unbound.length} 台设备变为未分配`);
      }
      return { ok: true, unbound };
    } catch (error) {
      console.error('解绑站点设备失败:', error);
      throw error;
    }
  }

  /**
   * 站点下已关联的设备ID列表
   */
  static async getSiteDeviceIds(siteId: number, tenantId?: string | null): Promise<string[]> {
    try {
      const site = await SiteService.getSiteById(siteId, tenantId);
      if (!site) return [];
      const rows = await database.query('SELECT id FROM devices WHERE site_id = ?', [siteId]);
      return rows.map((r) => r.id);
    } catch (error) {
      console.error('获取站点设备失败:', error);
      return [];
    }
  }
}

export default SiteService;
