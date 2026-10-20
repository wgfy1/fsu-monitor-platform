import database from '../models/database';
import { Alarm, AlarmType, AlarmSeverity } from '../types';
import NotifyService from './notifyService';
// ⚠️ 从具体模块引入（不要用 '../protocols/fsu' index，避免 handlers 反向依赖造成循环）
import {
  loadMeterDictionary, parseMeterDictionary, pickFunctionalSubDevices,
  getCommStatusEventScope, SubDeviceOption,
} from '../protocols/fsu/dictionary';
import { findDevName } from '../protocols/fsu/mapping';

/**
 * 告警服务类
 * 告警由厂家 FSU 协议的 alarmReport 写入（平台不做主动判断）
 */
export class AlarmService {
  /**
   * 创建告警记录（厂家 FSU alarmReport / 门磁联动 调用）
   */
  static async createAlarm(
    deviceId: string,
    type: AlarmType,
    severity: AlarmSeverity,
    message: string,
    value: string | null = null,
    source: string = 'MQTT',
    /**
     * 厂家协议扩展字段（可选，不影响既有调用方）
     * 协议 4.4：serialNo 是告警唯一标识（去重/关联依据），alarmLevel 为告警级别[1,5]，
     * alarmTime 为秒级时间戳（落库前已转毫秒）。isHistory 保留历史告警语义。
     */
    protocol?: {
      serialNo?: number;
      alarmLevel?: number;
      createdAtMs?: number;
      isHistory?: number;
    }
  ): Promise<number> {
    try {
      const sql = `
        INSERT INTO alarms (device_id, type, severity, message, value, source,
                            serial_no, alarm_level, is_history, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%s','now')))
      `;
      const result = await database.run(sql, [
        deviceId,
        type,
        severity,
        message,
        value,
        source,
        protocol?.serialNo ?? null,
        protocol?.alarmLevel ?? null,
        protocol?.isHistory ?? null,
        // created_at 为秒级：协议 alarmTime 是秒级时间戳，直接使用（未提供时用当前时间）
        protocol?.createdAtMs != null ? Math.floor(protocol.createdAtMs / 1000) : null
      ]);
      const alarmId = result.lastID || 0;
      console.log(`告警创建成功: ${deviceId}, 类型: ${type}, 来源: ${source}, 消息: ${message}`);

      // 异步挂接告警推送（钉钉/短信，含同源去重）；尽力而为，推送失败绝不影响告警主链路
      // alarmLevel 一并透传：FSU 告警的 severity 只是"平台未定级"占位值，
      // 推送文案要展示的是**厂家原始级别**。
      if (alarmId > 0) {
        void NotifyService.pushForAlarm(alarmId, {
          deviceId, type, severity, message,
          alarmLevel: protocol?.alarmLevel ?? null,
          // serialNo 一并透传：它是协议 4.4 的告警唯一标识，
          // 推送去重按它区分"同一条告警的重复上报"与"不同的实际告警"
          serialNo: protocol?.serialNo ?? null,
        }).catch((error) => console.error('告警推送未捕获异常:', error));
      }
      return alarmId;
    } catch (error) {
      console.error('创建告警失败:', error);
      throw error;
    }
  }

  /**
   * 构建告警查询 WHERE 子句（列表查询与 COUNT 查询**共用**，保证条件完全一致）
   *
   * 支持的组合条件：租户隔离 / 设备 / 状态 / 类型 / 时间范围 / 关键词
   * 全部使用参数化占位符，不做任何字符串拼接。
   */
  /**
   * 构造「子设备通信状态事件」的查询排除条件
   *
   * 背景：通信状态自本次修改起不再作为普通告警创建（见 handlers.handleAlarmReport），
   * 但数据库里可能仍有**升级前**写入的历史行。按要求保留记录、不批量删除，
   * 只在查询层排除 —— 告警中心列表、总数、统计、趋势都不会再出现它们。
   *
   * 判据与创建侧**共用同一套字典推导**（protocols/fsu/dictionary）：
   *   device_id = 该网关
   *   AND type  ∈ 该网关的功能子设备 devId
   *   AND value ∈ 该网关字典里「通信状态」的 meterId
   * 不写死任何 devId / meterId，也不影响子设备的其它真实告警。
   *
   * @param prefix 列前缀：告警列表查询带别名 'a.'；统计/趋势的裸表传 ''
   */
  private static async buildCommStatusExclusion(
    prefix: string = ''
  ): Promise<{ sql: string; params: any[] }> {
    try {
      const rows = await database.query('SELECT device_id, meters_json FROM device_meters');
      const groups: Array<{ deviceId: string; devIds: string[]; meterIds: string[] }> = [];
      for (const row of rows as any[]) {
        const scope = getCommStatusEventScope(parseMeterDictionary(row?.meters_json));
        if (scope.subDeviceIds.length === 0 || scope.meterIds.length === 0) continue;
        groups.push({
          deviceId: String(row.device_id),
          devIds: scope.subDeviceIds,
          meterIds: scope.meterIds,
        });
      }
      if (groups.length === 0) return { sql: '', params: [] };

      const parts: string[] = [];
      const params: any[] = [];
      for (const g of groups) {
        parts.push(
          `(${prefix}device_id = ? AND ${prefix}type IN (${g.devIds.map(() => '?').join(',')})` +
          ` AND ${prefix}value IN (${g.meterIds.map(() => '?').join(',')}))`
        );
        params.push(g.deviceId, ...g.devIds, ...g.meterIds);
      }
      return { sql: ` AND NOT (${parts.join(' OR ')})`, params };
    } catch (error) {
      // 字典读不到时**不排除任何行**：宁可多显示，也不能因异常把真实告警藏掉
      console.error('构造通信状态排除条件失败（本次查询不做排除）:', error);
      return { sql: '', params: [] };
    }
  }

  private static async buildAlarmWhere(q: {
    deviceId?: string;
    resolved?: number;
    type?: AlarmType;
    tenantId?: string | null;
    startTime?: number | null;
    endTime?: number | null;
    search?: string | null;
  }): Promise<{ where: string; params: any[] }> {
    let where = '';
    const params: any[] = [];

    // 租户隔离优先：租户账号只能看到本租户设备产生的告警
    if (q.tenantId) {
      where += ' AND a.device_id IN (SELECT id FROM devices WHERE tenant_id = ?)';
      params.push(q.tenantId);
    }
    if (q.deviceId) {
      where += ' AND a.device_id = ?';
      params.push(q.deviceId);
    }
    if (q.resolved !== undefined) {
      where += ' AND a.resolved = ?';
      params.push(q.resolved);
    }
    if (q.type) {
      where += ' AND a.type = ?';
      params.push(q.type);
    }
    // 告警产生时间范围（created_at，秒级时间戳，左闭右闭）
    if (q.startTime != null) {
      where += ' AND a.created_at >= ?';
      params.push(q.startTime);
    }
    if (q.endTime != null) {
      where += ' AND a.created_at <= ?';
      params.push(q.endTime);
    }

    // 关键词搜索：**仅设备ID**（厂家协议 gwId）。
    // 告警信息(a.message)与设备名称(d.name)不参与匹配：输入告警文本不应命中任何记录。
    // 通配符转义，避免用户输入 % _ 被当作通配符
    const keyword = (q.search || '').trim();
    if (keyword) {
      const escaped = keyword.replace(/[\\%_]/g, (m) => '\\' + m);
      where += " AND a.device_id LIKE ? ESCAPE '\\'";
      params.push(`%${escaped}%`);
    }

    // 历史通信状态行：记录保留在库里，但不出现在列表与总数中。
    // 条件追加在最后，占位符顺序与 params.push 顺序一致。
    const exclusion = await AlarmService.buildCommStatusExclusion('a.');
    where += exclusion.sql;
    params.push(...exclusion.params);

    return { where, params };
  }

  /**
   * 告警中心「子设备」筛选选项
   *
   * 数据来源：**设备上报的厂家字典**（device_meters），不是告警列表 ——
   * 因此某个子设备当前没有告警时，它依然会出现在选项里。
   * 哪些条目算「功能子设备」由 protocols/fsu/dictionary 的
   * pickFunctionalSubDevices() 按字典数据推导，本服务不写死任何 devId/名称/分类。
   *
   * 多网关合并：同一个 devId 只出一个选项（名称为 null 时回退显示 devId）。
   * 若同一 devId 在不同网关字典里名称不一致，**不静默取一个**，
   * 而是原样保留全部名称并在 conflicts 里返回（同时打日志），交由调用方呈现/排查。
   *
   * @param tenantId 租户范围：传入时只看该租户设备；平台管理员传 null
   */
  static async listSubDeviceOptions(tenantId?: string | null): Promise<{
    options: SubDeviceOption[];
    conflicts: Array<{ devId: string; names: string[] }>;
  }> {
    try {
      // 一次取回当前可见设备的全部字典（device_meters 一台网关一行，量很小）
      const rows = tenantId
        ? await database.query(
            `SELECT dm.device_id, dm.meters_json FROM device_meters dm
             WHERE dm.device_id IN (SELECT id FROM devices WHERE tenant_id = ?)`,
            [tenantId]
          )
        : await database.query('SELECT device_id, meters_json FROM device_meters');

      // 按 device_id 排序，保证合并结果稳定可复现
      rows.sort((a: any, b: any) => String(a.device_id).localeCompare(String(b.device_id)));

      const byDev = new Map<string, { names: Set<string>; alarmPointCount: number }>();
      for (const row of rows) {
        const entries = parseMeterDictionary((row as any).meters_json);
        for (const opt of pickFunctionalSubDevices(entries)) {
          const cur = byDev.get(opt.devId) ?? { names: new Set<string>(), alarmPointCount: 0 };
          if (opt.devName) cur.names.add(opt.devName);
          cur.alarmPointCount += opt.alarmPointCount;
          byDev.set(opt.devId, cur);
        }
      }

      const options: SubDeviceOption[] = [];
      const conflicts: Array<{ devId: string; names: string[] }> = [];
      for (const [devId, v] of byDev) {
        const names = Array.from(v.names).sort();
        if (names.length > 1) {
          conflicts.push({ devId, names });
          console.warn(
            `[告警] 子设备 ${devId} 在不同网关的字典里名称不一致，未做静默覆盖: ${names.join(' | ')}`
          );
        }
        options.push({
          devId,
          devName: names.length > 0 ? names[0] : null,
          alarmPointCount: v.alarmPointCount,
        });
      }
      // devId 数值序优先，便于页面稳定展示
      options.sort((a, b) => a.devId.localeCompare(b.devId, undefined, { numeric: true }));

      return { options, conflicts };
    } catch (error) {
      console.error('获取子设备筛选选项失败:', error);
      return { options: [], conflicts: [] };
    }
  }

  /**
   * 为告警行补充「厂家子设备名称」（dev_name）
   *
   * FSU 告警的 alarms.type 存的是**厂家 devId**；子设备名称一律取自厂家字典
   * （device_meters），平台不内建 devId→名称 表。字典没有该 devId 时为 null，
   * 前端回退显示 devId 原文，绝不编造名称。
   *
   * 批量处理：一次查询页内涉及的 device_id 去重后逐个取字典（主键查询，开销很小），
   * 避免逐行 N+1。
   */
  private static async attachDevNames(rows: Alarm[]): Promise<any[]> {
    if (rows.length === 0) return rows;
    const deviceIds = Array.from(new Set(rows.map((r) => r.device_id).filter(Boolean)));
    const dicts = new Map<string, string | null>();
    await Promise.all(deviceIds.map(async (id) => {
      dicts.set(id, await loadMeterDictionary(id));
    }));
    return rows.map((r) => ({
      ...r,
      // r.type 即厂家 devId；旧物模型的历史行（type='door' 等）查不到，返回 null
      dev_name: findDevName(dicts.get(r.device_id) ?? null, r.type),
    }));
  }

  /**
   * 获取告警列表（分页参数在 SQL 内完成）
   *
   * @param search 关键词：**仅匹配设备ID**（告警内容与设备名称不参与）
   */
  static async getAlarms(
    deviceId?: string,
    resolved?: number,
    type?: AlarmType,
    limit: number = 100,
    offset: number = 0,
    tenantId?: string | null,
    startTime?: number | null,
    endTime?: number | null,
    search?: string | null
  ): Promise<Alarm[]> {
    try {
      const { where, params } = await AlarmService.buildAlarmWhere({
        deviceId, resolved, type, tenantId, startTime, endTime, search,
      });
      const sql = `
        SELECT a.*, d.name as device_name, d.location
        FROM alarms a
        LEFT JOIN devices d ON a.device_id = d.id
        WHERE 1=1${where}
        ORDER BY a.created_at DESC
        LIMIT ? OFFSET ?
      `;
      const rows = (await database.query(sql, [...params, limit, offset])) as Alarm[];
      // 补厂家子设备名称（取自设备上报字典，非平台内建表）
      return await AlarmService.attachDevNames(rows);
    } catch (error) {
      console.error('获取告警列表失败:', error);
      throw error;
    }
  }

  /**
   * 统计符合条件的告警总数
   *
   * 与 getAlarms 使用**同一个** buildAlarmWhere，保证列表与总数条件永远一致
   * （不会出现"列表过滤了时间、总数没过滤"或"总数把其他租户算进来"）。
   */
  static async countAlarms(q: {
    deviceId?: string;
    resolved?: number;
    type?: AlarmType;
    tenantId?: string | null;
    startTime?: number | null;
    endTime?: number | null;
    search?: string | null;
  }): Promise<number> {
    try {
      const { where, params } = await AlarmService.buildAlarmWhere(q);
      const row = await database.get(
        `SELECT COUNT(*) AS count
         FROM alarms a
         LEFT JOIN devices d ON a.device_id = d.id
         WHERE 1=1${where}`,
        params
      );
      return Number(row?.count) || 0;
    } catch (error) {
      console.error('统计告警总数失败:', error);
      throw error;
    }
  }

  /**
   * 告警分页列表：返回当前页数据 + 符合条件的总数
   * 列表与总数在同一处调用，条件由 buildAlarmWhere 统一生成
   */
  static async getAlarmsPaged(q: {
    deviceId?: string;
    resolved?: number;
    type?: AlarmType;
    tenantId?: string | null;
    startTime?: number | null;
    endTime?: number | null;
    search?: string | null;
    limit?: number;
    offset?: number;
  }): Promise<{ items: Alarm[]; total: number }> {
    const limit = q.limit ?? 100;
    const offset = q.offset ?? 0;
    const [items, total] = await Promise.all([
      AlarmService.getAlarms(
        q.deviceId, q.resolved, q.type, limit, offset,
        q.tenantId, q.startTime, q.endTime, q.search
      ),
      AlarmService.countAlarms({
        deviceId: q.deviceId, resolved: q.resolved, type: q.type,
        tenantId: q.tenantId, startTime: q.startTime, endTime: q.endTime, search: q.search,
      }),
    ]);
    return { items, total };
  }

  /**
   * 根据ID获取告警详情
   * @param tenantId 租户ID：传入时校验告警设备归属（不匹配返回 null）
   */
  static async getAlarmById(alarmId: number, tenantId?: string | null): Promise<Alarm | null> {
    try {
      const sql = tenantId
        ? `
          SELECT a.*, d.name as device_name, d.location
          FROM alarms a
          LEFT JOIN devices d ON a.device_id = d.id
          WHERE a.id = ? AND a.device_id IN (SELECT id FROM devices WHERE tenant_id = ?)
        `
        : `
          SELECT a.*, d.name as device_name, d.location
          FROM alarms a
          LEFT JOIN devices d ON a.device_id = d.id
          WHERE a.id = ?
        `;
      const alarm = await database.get(sql, tenantId ? [alarmId, tenantId] : [alarmId]);
      return alarm || null;
    } catch (error) {
      console.error('获取告警详情失败:', error);
      throw error;
    }
  }

  /**
   * 解决告警
   * @param tenantId 租户ID：传入时仅解决该租户设备的告警
   */
  /**
   * 按厂家协议 serialNo 查找未解决告警（协议 4.4：serialNo 是告警唯一标识）
   *
   * 这是厂家告警去重/关联的**唯一依据**：不再按类型+文本猜测，
   * 避免不同告警点内容相同时被误判为重复、或同一点告警被漏判。
   * @returns 未解决的告警；不存在返回 null
   */
  static async findUnresolvedBySerialNo(deviceId: string, serialNo: number): Promise<Alarm | null> {
    try {
      const row = await database.get(
        'SELECT * FROM alarms WHERE device_id = ? AND serial_no = ? AND resolved = 0 ORDER BY id DESC LIMIT 1',
        [deviceId, serialNo]
      );
      return (row as Alarm) || null;
    } catch (error) {
      console.error('按 serialNo 查询告警失败:', error);
      return null;
    }
  }

  /**
   * 解决告警
   * @param resolvedAtMs 消除时间（毫秒，可选）
   *   厂家协议 4.4 alarmFlag=0 时若携带 clearTime（秒级），
   *   用协议给的消除时间落库；不传时用当前时间（保持既有行为）
   */
  static async resolveAlarm(
    alarmId: number,
    tenantId?: string | null,
    resolvedAtMs?: number
  ): Promise<boolean> {
    try {
      // 优先使用协议给出的消除时间（厂家 alarmFlag=0 的 clearTime），未提供时用当前时间
      const resolvedAt = resolvedAtMs != null && Number.isFinite(resolvedAtMs) ? resolvedAtMs : Date.now();
      const sql = tenantId
        ? `UPDATE alarms SET resolved = 1, resolved_at = ? WHERE id = ? AND device_id IN (SELECT id FROM devices WHERE tenant_id = ?)`
        : `UPDATE alarms SET resolved = 1, resolved_at = ? WHERE id = ?`;
      const result = await database.run(sql, tenantId ? [resolvedAt, alarmId, tenantId] : [resolvedAt, alarmId]);
      const affected = result.changes || 0;

      if (affected > 0) {
        console.log(`告警已解决: ID=${alarmId}`);
        return true;
      }

      return false;
    } catch (error) {
      console.error('解决告警失败:', error);
      throw error;
    }
  }

  /**
   * 获取告警统计信息
   *
   * - critical / warning：**保留字段**，统计平台自行定级的历史告警（旧物模型链路）。
   *   FSU 厂家告警的 severity 是 'vendor'（平台未定级），不计入这两个数。
   * - byLevel：**未解决**告警按**厂家原始 alarmLevel**（协议 4.4，取值 1~5）的分布。
   *   这是 FSU 告警的唯一定级口径 —— 平台不把 1~5 翻译成严重/警告。
   * - withoutLevel：未解决但无 alarm_level 的条数（历史行 / 非厂家告警）。
   *
   * @param tenantId 租户ID：传入时仅统计该租户设备的告警
   */
  static async getAlarmStats(tenantId?: string | null): Promise<{
    total: number;
    unresolved: number;
    critical: number;
    warning: number;
    byLevel: Record<string, number>;
    withoutLevel: number;
  }> {
    try {
      // 统计口径与告警中心列表一致：历史通信状态行不计入任何计数
      const exclusion = await AlarmService.buildCommStatusExclusion('');
      const scope = (tenantId
        ? ' AND device_id IN (SELECT id FROM devices WHERE tenant_id = ?)'
        : '') + exclusion.sql;
      const scopeParams = [...(tenantId ? [tenantId] : []), ...exclusion.params];
      const total = await database.get(`SELECT COUNT(*) as count FROM alarms WHERE 1=1${scope}`, scopeParams);
      const unresolved = await database.get(`SELECT COUNT(*) as count FROM alarms WHERE resolved = 0${scope}`, scopeParams);
      const critical = await database.get(`SELECT COUNT(*) as count FROM alarms WHERE severity = ? AND resolved = 0${scope}`, ['critical', ...scopeParams]);
      const warning = await database.get(`SELECT COUNT(*) as count FROM alarms WHERE severity = ? AND resolved = 0${scope}`, ['warning', ...scopeParams]);

      // 厂家原始级别分布（未解决）。按库中实际出现的值分组，不预先过滤取值范围，
      // 厂家若上报 1~5 之外的值也如实统计，不丢弃。
      const levelRows = await database.query(
        `SELECT alarm_level AS level, COUNT(*) as count FROM alarms
         WHERE resolved = 0 AND alarm_level IS NOT NULL${scope}
         GROUP BY alarm_level`,
        scopeParams
      );
      const byLevel: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
      for (const r of levelRows) {
        byLevel[String(r.level)] = Number(r.count) || 0;
      }
      const withoutLevel = await database.get(
        `SELECT COUNT(*) as count FROM alarms WHERE resolved = 0 AND alarm_level IS NULL${scope}`,
        scopeParams
      );

      return {
        total: total?.count || 0,
        unresolved: unresolved?.count || 0,
        critical: critical?.count || 0,
        warning: warning?.count || 0,
        byLevel,
        withoutLevel: withoutLevel?.count || 0,
      };
    } catch (error) {
      console.error('获取告警统计失败:', error);
      return {
        total: 0, unresolved: 0, critical: 0, warning: 0,
        byLevel: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }, withoutLevel: 0,
      };
    }
  }

  /**
   * 获取告警趋势数据（按天）
   * @param tenantId 租户ID：传入时仅统计该租户设备的告警
   */
  static async getAlarmTrend(days: number = 7, tenantId?: string | null): Promise<any[]> {
    try {
      // created_at 由 DB DEFAULT strftime('%s') 生成，是秒级时间戳
      const startTime = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
      // 趋势口径与列表/统计一致：历史通信状态行不计入
      const exclusion = await AlarmService.buildCommStatusExclusion('');
      const sql = `
        SELECT
          DATE(created_at, 'unixepoch') as date,
          COUNT(*) as count,
          SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical_count,
          SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) as warning_count
        FROM alarms
        WHERE created_at >= ?${tenantId ? ' AND device_id IN (SELECT id FROM devices WHERE tenant_id = ?)' : ''}${exclusion.sql}
        GROUP BY DATE(created_at, 'unixepoch')
        ORDER BY date ASC
      `;
      return await database.query(
        sql,
        [...(tenantId ? [startTime, tenantId] : [startTime]), ...exclusion.params]
      );
    } catch (error) {
      console.error('获取告警趋势失败:', error);
      return [];
    }
  }

  /**
   * 删除单条告警
   * @param tenantId 租户ID：传入时仅删除该租户设备的告警
   */
  static async deleteAlarm(alarmId: number, tenantId?: string | null): Promise<boolean> {
    try {
      const sql = tenantId
        ? `DELETE FROM alarms WHERE id = ? AND device_id IN (SELECT id FROM devices WHERE tenant_id = ?)`
        : `DELETE FROM alarms WHERE id = ?`;
      const result = await database.run(sql, tenantId ? [alarmId, tenantId] : [alarmId]);
      const affected = result.changes || 0;
      if (affected > 0) {
        console.log(`告警已删除: ID=${alarmId}`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('删除告警失败:', error);
      throw error;
    }
  }

  /**
   * 批量删除告警
   * @param tenantId 租户ID：传入时仅删除该租户设备的告警（其他租户的 ID 静默跳过）
   */
  static async deleteAlarmsBatch(ids: number[], tenantId?: string | null): Promise<number> {
    try {
      const placeholders = ids.map(() => '?').join(',');
      const sql = tenantId
        ? `DELETE FROM alarms WHERE id IN (${placeholders}) AND device_id IN (SELECT id FROM devices WHERE tenant_id = ?)`
        : `DELETE FROM alarms WHERE id IN (${placeholders})`;
      const result = await database.run(sql, tenantId ? [...ids, tenantId] : ids);
      const deleted = result.changes || 0;
      console.log(`批量删除告警: ${deleted} 条`);
      return deleted;
    } catch (error) {
      console.error('批量删除告警失败:', error);
      throw error;
    }
  }

  /**
   * 清理已解决的旧告警
   */
  static async cleanOldResolvedAlarms(days: number = 30): Promise<number> {
    try {
      // created_at 由 DB DEFAULT strftime('%s') 生成，是秒级时间戳
      const cutoffTime = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
      const sql = `DELETE FROM alarms WHERE resolved = 1 AND created_at < ?`;
      const result = await database.run(sql, [cutoffTime]);
      const deletedCount = result.changes || 0;
      if (deletedCount > 0) {
        console.log(`清理旧告警完成，删除 ${deletedCount} 条记录`);
      }
      return deletedCount;
    } catch (error) {
      console.error('清理旧告警失败:', error);
      throw error;
    }
  }
}

export default AlarmService;