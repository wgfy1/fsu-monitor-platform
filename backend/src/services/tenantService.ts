import database from '../models/database';
import UserService from './userService';
import { Tenant, TenantWithStats, TenantDeletePreview } from '../types';

/**
 * 租户服务（正式租户模型）
 *
 * 核心业务规则：
 *  - 一个租户 = 一个登录账号（users.tenant_id 唯一约束 + 服务端校验双重保证）
 *  - 平台管理员 tenant_id = NULL，不属于任何普通租户
 *  - 删除租户 = 删除该租户的全部业务数据（事务内完成）
 *  - 更换账号 = 只替换账号，租户与业务数据（站点/设备/历史/告警/推送）全部保留
 */
export class TenantService {
  /**
   * 在同一连接上执行事务：任一步失败即整体回滚
   */
  private static async inTransaction<T>(fn: () => Promise<T>): Promise<T> {
    await database.run('BEGIN TRANSACTION');
    try {
      const result = await fn();
      await database.run('COMMIT');
      return result;
    } catch (err) {
      await database.run('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }

  /** 生成下一个租户ID：T0001、T0002 …（正式租户标识，不再用名称字符串） */
  private static async nextTenantId(): Promise<string> {
    const row = await database.get(
      `SELECT id FROM tenants WHERE id LIKE 'T%'
       ORDER BY CAST(SUBSTR(id, 2) AS INTEGER) DESC LIMIT 1`
    );
    const last = row?.id ? parseInt(String(row.id).slice(1), 10) : 0;
    const next = (Number.isFinite(last) ? last : 0) + 1;
    return `T${String(next).padStart(4, '0')}`;
  }

  /** 租户下的全部设备ID（删除级联用） */
  private static async getTenantDeviceIds(tenantId: string): Promise<string[]> {
    const rows = await database.query('SELECT id FROM devices WHERE tenant_id = ?', [tenantId]);
    return rows.map((r) => String(r.id));
  }

  /**
   * 租户列表（含绑定账号、站点数、设备数）
   */
  static async list(): Promise<TenantWithStats[]> {
    const tenants: Tenant[] = await database.query('SELECT * FROM tenants ORDER BY id');
    if (tenants.length === 0) return [];

    const ids = tenants.map((t) => t.id);
    const ph = ids.map(() => '?').join(',');

    const userRows = await database.query(
      `SELECT tenant_id, username FROM users WHERE tenant_id IN (${ph})`, ids
    );
    const siteRows = await database.query(
      `SELECT tenant_id, COUNT(*) AS c FROM sites WHERE tenant_id IN (${ph}) GROUP BY tenant_id`, ids
    );
    const deviceRows = await database.query(
      `SELECT tenant_id, COUNT(*) AS c FROM devices WHERE tenant_id IN (${ph}) GROUP BY tenant_id`, ids
    );

    const userMap = new Map(userRows.map((r: any) => [String(r.tenant_id), String(r.username)]));
    const siteMap = new Map(siteRows.map((r: any) => [String(r.tenant_id), Number(r.c) || 0]));
    const deviceMap = new Map(deviceRows.map((r: any) => [String(r.tenant_id), Number(r.c) || 0]));

    return tenants.map((t) => ({
      ...t,
      username: userMap.get(t.id) ?? null,
      site_count: siteMap.get(t.id) ?? 0,
      device_count: deviceMap.get(t.id) ?? 0,
    }));
  }

  /**
   * 未绑定账号的租户列表（供「新增用户 → 归属租户」下拉使用）
   * 已绑定账号的租户不会出现在这里，从源头避免一个租户绑定两个用户
   */
  static async listAvailable(): Promise<{ id: string; name: string }[]> {
    const rows = await database.query(
      `SELECT t.id, t.name FROM tenants t
       WHERE t.status = 1
         AND NOT EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id)
       ORDER BY t.id`
    );
    return rows.map((r: any) => ({ id: String(r.id), name: String(r.name) }));
  }

  /** 租户详情 */
  static async getById(id: string): Promise<Tenant | null> {
    const row = await database.get('SELECT * FROM tenants WHERE id = ?', [id]);
    return row || null;
  }

  /**
   * 创建租户 + 该租户的唯一账号（同一个数据库事务）
   * 任何一步失败整体回滚，不会出现"有租户没账号"或"有账号没租户"的半成品
   */
  static async createWithUser(args: {
    name: string;
    remark?: string | null;
    username: string;
    password: string;
  }): Promise<{ ok: boolean; message?: string; id?: string; code?: string }> {
    const name = (args.name || '').trim();
    if (!name) return { ok: false, message: '租户名称不能为空' };
    if (name.length > 50) return { ok: false, message: '租户名称不能超过50个字符' };
    const remark = (args.remark || '').trim() || null;
    if (remark && remark.length > 200) return { ok: false, message: '备注不能超过200个字符' };

    const dup = await database.get('SELECT id FROM tenants WHERE name = ?', [name]);
    if (dup) return { ok: false, message: `租户名称「${name}」已存在` };

    if (!args.username || !args.password) {
      return { ok: false, message: '请输入租户账号与登录密码' };
    }

    try {
      const tenantId = await this.inTransaction(async () => {
        const id = await TenantService.nextTenantId();
        const now = Math.floor(Date.now() / 1000);
        await database.run(
          `INSERT INTO tenants (id, name, remark, status, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?)`,
          [id, name, remark, now, now]
        );
        // 同一事务内创建唯一账号；用户名/密码校验与 bcrypt 加密复用 UserService
        await UserService.createUser({
          username: args.username,
          password: args.password,
          role: 'user',
          tenantId: id,
        });
        return id;
      });
      console.log(`租户创建成功: ${tenantId}（${name}），已绑定唯一账号 ${args.username}`);
      return { ok: true, id: tenantId, code: tenantId };
    } catch (error: any) {
      const msg = String(error?.message || '');
      if (msg.includes('用户名需为') || msg.includes('密码') || msg.includes('用户名已存在')) {
        return { ok: false, message: msg };
      }
      if (msg.includes('UNIQUE') && msg.includes('tenants')) {
        return { ok: false, message: `租户名称「${name}」已存在` };
      }
      // 用户名唯一约束冲突
      if (msg.includes('UNIQUE')) {
        return { ok: false, message: '该登录账号已被占用，请更换' };
      }
      console.error('创建租户失败:', error);
      throw error;
    }
  }

  /**
   * 更新租户信息（名称 / 备注 / 状态）
   */
  static async update(
    id: string,
    patch: { name?: string; remark?: string | null; status?: number }
  ): Promise<{ ok: boolean; notFound?: boolean; message?: string }> {
    const tenant = await TenantService.getById(id);
    if (!tenant) return { ok: false, notFound: true, message: '租户不存在' };

    const name = patch.name !== undefined ? String(patch.name).trim() : tenant.name;
    if (!name) return { ok: false, message: '租户名称不能为空' };
    if (name.length > 50) return { ok: false, message: '租户名称不能超过50个字符' };

    if (name !== tenant.name) {
      const dup = await database.get('SELECT id FROM tenants WHERE name = ? AND id <> ?', [name, id]);
      if (dup) return { ok: false, message: `租户名称「${name}」已存在` };
    }

    const remark = patch.remark !== undefined
      ? (String(patch.remark || '').trim() || null)
      : tenant.remark;
    if (remark && remark.length > 200) return { ok: false, message: '备注不能超过200个字符' };

    const status = patch.status !== undefined ? Number(patch.status) : tenant.status;
    if (status !== 0 && status !== 1) return { ok: false, message: '状态仅支持 0（停用）或 1（启用）' };

    await database.run(
      `UPDATE tenants SET name = ?, remark = ?, status = ?, updated_at = ? WHERE id = ?`,
      [name, remark, status, Math.floor(Date.now() / 1000), id]
    );
    console.log(`租户已更新: ${id}（${name}）`);
    return { ok: true };
  }

  /**
   * 更换账号（租户不变，只替换该租户的唯一账号）
   *
   * 事务内完成：用户名/密码一次性更新，避免改一半。
   * 租户的站点、设备、历史数据、告警、推送配置与记录全部保留。
   * 若该租户当前没有账号，则直接创建（等价于"绑定账号"）。
   */
  static async replaceAccount(
    tenantId: string,
    args: { username: string; password?: string | null }
  ): Promise<{ ok: boolean; notFound?: boolean; message?: string }> {
    const tenant = await TenantService.getById(tenantId);
    if (!tenant) return { ok: false, notFound: true, message: '租户不存在' };

    const current = await database.get('SELECT id FROM users WHERE tenant_id = ?', [tenantId]);

    try {
      await this.inTransaction(async () => {
        if (current) {
          await UserService.replaceAccount(Number(current.id), {
            username: args.username,
            password: args.password,
          });
        } else {
          if (!args.password) throw new Error('请输入登录密码');
          await UserService.createUser({
            username: args.username,
            password: args.password,
            role: 'user',
            tenantId,
          });
        }
      });
      console.log(`租户账号已更换: 租户=${tenantId}, 账号=${args.username}`);
      return { ok: true };
    } catch (error: any) {
      const msg = String(error?.message || '');
      if (msg.includes('用户名需为') || msg.includes('密码') || msg.includes('用户名已存在')) {
        return { ok: false, message: msg };
      }
      console.error('更换租户账号失败:', error);
      throw error;
    }
  }

  /**
   * 删除前的数据统计（确认弹窗展示用）
   */
  static async getDeletePreview(tenantId: string): Promise<TenantDeletePreview | null> {
    const tenant = await TenantService.getById(tenantId);
    if (!tenant) return null;

    const deviceIds = await TenantService.getTenantDeviceIds(tenantId);
    const ph = deviceIds.map(() => '?').join(',');
    const countIn = async (sql: string, params: any[]): Promise<number> => {
      const row = await database.get(sql, params);
      return Number(row?.c) || 0;
    };

    const user = await database.get('SELECT username FROM users WHERE tenant_id = ?', [tenantId]);

    return {
      tenant_id: tenant.id,
      tenant_name: tenant.name,
      username: user?.username ?? null,
      site_count: await countIn('SELECT COUNT(*) AS c FROM sites WHERE tenant_id = ?', [tenantId]),
      device_count: deviceIds.length,
      fsu_history_count: deviceIds.length
        ? await countIn(`SELECT COUNT(*) AS c FROM fsu_data_history WHERE device_id IN (${ph})`, deviceIds)
        : 0,
      meter_dict_count: deviceIds.length
        ? await countIn(`SELECT COUNT(*) AS c FROM device_meters WHERE device_id IN (${ph})`, deviceIds)
        : 0,
      alarm_count: deviceIds.length
        ? await countIn(`SELECT COUNT(*) AS c FROM alarms WHERE device_id IN (${ph})`, deviceIds)
        : 0,
      notify_config_count: await countIn(
        'SELECT COUNT(*) AS c FROM tenant_notify_config WHERE tenant_id = ?', [tenantId]
      ),
      push_log_count: await countIn(
        'SELECT COUNT(*) AS c FROM alarm_push_logs WHERE tenant_id = ?', [tenantId]
      ),
    };
  }

  /**
   * 删除租户及其全部业务数据（事务）
   *
   * 删除顺序（先子后父，避免悬挂引用）：
   *   推送记录 → 推送配置 → 历史告警 → 厂家原始历史数据(fsu_data_history) → 设备扩展数据(device_meters)
   *   → 设备 → 站点 → 租户账号 → 租户
   *
   * 已核对当前库中与租户相关的全部关联路径：
   *   tenant_id : users / sites / devices / tenant_notify_config / alarm_push_logs
   *   device_id : fsu_data_history / device_meters / alarms / alarm_push_logs
   *   site_id   : devices
   * 注意：平台级 alarm_notify_config 不属于任何租户，不删除。
   */
  static async deleteTenant(tenantId: string): Promise<{ ok: boolean; notFound?: boolean; message?: string; preview?: TenantDeletePreview }> {
    const preview = await TenantService.getDeletePreview(tenantId);
    if (!preview) return { ok: false, notFound: true, message: '租户不存在' };

    const deviceIds = await TenantService.getTenantDeviceIds(tenantId);
    const ph = deviceIds.map(() => '?').join(',');

    try {
      await this.inTransaction(async () => {
        const run = (sql: string, params: any[] = []) => database.run(sql, params);

        // 1) 推送记录（按租户 + 按该租户设备，两条路径都清）
        await run('DELETE FROM alarm_push_logs WHERE tenant_id = ?', [tenantId]);
        if (deviceIds.length) {
          await run(`DELETE FROM alarm_push_logs WHERE device_id IN (${ph})`, deviceIds);
        }
        // 2) 租户推送配置
        await run('DELETE FROM tenant_notify_config WHERE tenant_id = ?', [tenantId]);
        // 3) 历史告警
        if (deviceIds.length) {
          await run(`DELETE FROM alarms WHERE device_id IN (${ph})`, deviceIds);
        }
        // 4) 厂家原始历史数据
        if (deviceIds.length) {
          await run(`DELETE FROM fsu_data_history WHERE device_id IN (${ph})`, deviceIds);
        }
        // 5) 设备扩展数据（电表字典）
        if (deviceIds.length) {
          await run(`DELETE FROM device_meters WHERE device_id IN (${ph})`, deviceIds);
        }
        // 6) 设备
        await run('DELETE FROM devices WHERE tenant_id = ?', [tenantId]);
        // 7) 站点
        await run('DELETE FROM sites WHERE tenant_id = ?', [tenantId]);
        // 8) 租户账号
        await run('DELETE FROM users WHERE tenant_id = ?', [tenantId]);
        // 9) 租户本身
        await run('DELETE FROM tenants WHERE id = ?', [tenantId]);
      });

      console.log(
        `租户已删除: ${tenantId}（${preview.tenant_name}）` +
        ` 账号${preview.username ? 1 : 0}个 站点${preview.site_count}个 设备${preview.device_count}台` +
        ` 厂家历史${preview.fsu_history_count}条 告警${preview.alarm_count}条`
      );
      return { ok: true, preview };
    } catch (error) {
      console.error('删除租户失败（已回滚）:', error);
      throw error;
    }
  }
}

export default TenantService;
