import database from '../models/database';
import { Device } from '../types';
import { generateMqttPassword, getDefaultMqttUsername } from '../utils/mqttCredentials';

/**
 * 设备服务类
 */
export class DeviceService {
  /**
   * 根据设备ID获取设备信息
   * @param tenantId 租户ID：传入时校验设备归属（不匹配返回 null）；不传（null/undefined）不过滤（内部路径用）
   */
  static async getDeviceById(deviceId: string, tenantId?: string | null): Promise<Device | null> {
    try {
      const sql = tenantId
        ? 'SELECT * FROM devices WHERE id = ? AND tenant_id = ?'
        : 'SELECT * FROM devices WHERE id = ?';
      const device = await database.get(sql, tenantId ? [deviceId, tenantId] : [deviceId]);
      return device || null;
    } catch (error) {
      console.error('获取设备失败:', error);
      throw error;
    }
  }

  /**
   * 根据 MQTT 用户名查找设备（mqttUsername 默认为设备ID，也兼容直接使用设备ID连接）
   */
  static async getDeviceByMqttUsername(username: string): Promise<Device | null> {
    try {
      const sql = 'SELECT * FROM devices WHERE mqttUsername = ? OR id = ? LIMIT 1';
      const device = await database.get(sql, [username, username]);
      return device || null;
    } catch (error) {
      console.error('按 MQTT 用户名获取设备失败:', error);
      throw error;
    }
  }

  /**
   * 获取设备列表
   * @param tenantId 租户ID：传入时只返回该租户设备；不传（null/undefined）返回全部（平台管理员/内部路径）
   */
  static async getAllDevices(tenantId?: string | null): Promise<Device[]> {
    try {
      const sql = tenantId
        ? 'SELECT * FROM devices WHERE tenant_id = ? ORDER BY created_at DESC'
        : 'SELECT * FROM devices ORDER BY created_at DESC';
      return await database.query(sql, tenantId ? [tenantId] : []);
    } catch (error) {
      console.error('获取设备列表失败:', error);
      throw error;
    }
  }

  /**
   * 创建或更新设备
   * @param deviceId 设备ID
   * @param productId 产品ID
   * @param timestamp 时间戳
   * @param status 设备状态
   * @param extraInfo 可选：设备额外信息（imei, iccid, 厂商, 型号等）
   */
  /**
   * 所有可更新字段的列表 — 用于 UPDATE 和 INSERT 的动态构建
   * [列名, extraInfo键名] 或 [列名, extraInfo键名, 默认值]
   */
  private static readonly DEVICE_COLUMNS: [string, string, any?][] = [
    ['imei', 'imei'],
    ['iccid', 'iccid'],
    ['manufacturer', 'manufacturer'],
    ['terminalType', 'terminalType'],
    ['moduleType', 'moduleType'],
    ['hardwareVersion', 'hardwareVersion'],
    ['softwareVersion', 'softwareVersion'],
    ['reportPeriod', 'reportPeriod'],
    ['device_sn', 'deviceSn'],
    ['protocol_type', 'protocolType'],
    // 厂家协议原始电表数据（JSON 字符串：{ devId: { meterId: value } }）
    ['latest_meters', 'latestMeters'],
  ];

  static async upsertDevice(
    deviceId: string,
    productId: string,
    timestamp: number,
    status: 'online' | 'offline' = 'online',
    extraInfo?: {
      imei?: string;
      iccid?: string;
      manufacturer?: string;
      terminalType?: string;
      moduleType?: string;
      hardwareVersion?: string;
      softwareVersion?: string;
      reportPeriod?: number;
      deviceSn?: string;
      protocolType?: string;
      // 历史遗留的 MQTT 凭据字段（平台已改用统一 MQTT 账号，不参与认证）
      mqttUsername?: string;
      mqttPassword?: string;
      /** 厂家协议原始电表数据 JSON 字符串（{ devId: { meterId: value } }） */
      latestMeters?: string;
    }
  ): Promise<void> {
    try {
      const existing = await this.getDeviceById(deviceId);

      if (existing) {
        // 动态构建 SET 子句，只更新有值的字段
        const sets: string[] = ['product_id = ?', 'last_seen = ?', 'status = ?'];
        const params: any[] = [productId, timestamp, status];
        // 状态联动：上报/上线说明设备活跃（激活 + 连接中）；离线则标记未连接
        if (status === 'online') {
          sets.push('activationStatus = ?', 'mqttConnected = ?');
          params.push('active', 1);
        } else {
          sets.push('mqttConnected = ?');
          params.push(0);
        }

        for (const [col, key] of DeviceService.DEVICE_COLUMNS) {
          if (extraInfo?.[key as keyof typeof extraInfo] !== undefined) {
            sets.push(`${col} = ?`);
            params.push(extraInfo[key as keyof typeof extraInfo]);
          }
        }

        params.push(deviceId);
        const sql = `UPDATE devices SET ${sets.join(', ')} WHERE id = ?`;
        await database.run(sql, params);
        console.log(`设备更新成功: ${deviceId}, 状态: ${status}`);
      } else {
        // 历史遗留字段：仅为兼容旧数据结构生成占位值，不参与 MQTT 认证
        const mqttUsername = extraInfo?.mqttUsername || getDefaultMqttUsername(deviceId);
        const mqttPassword = extraInfo?.mqttPassword || generateMqttPassword();

        // 数据上报自动创建的新设备：上报/上线 → 已激活+连接中；仅离线事件 → 保持未激活
        const activationStatus = status === 'online' ? 'active' : 'inactive';
        const mqttConnected = status === 'online' ? 1 : 0;

        const cols = ['id', 'product_id', 'status', 'activationStatus', 'mqttConnected', 'last_seen', 'created_at',
          'mqttUsername', 'mqttPassword',
          ...DeviceService.DEVICE_COLUMNS.map(c => c[0])];
        const placeholders = cols.map(() => '?').join(', ');
        const params: any[] = [
          deviceId, productId, status, activationStatus, mqttConnected, timestamp, timestamp,
          mqttUsername, mqttPassword,
        ];

        for (const [_col, key, def] of DeviceService.DEVICE_COLUMNS) {
          const v = extraInfo?.[key as keyof typeof extraInfo];
          params.push(v !== undefined ? v : (def !== undefined ? def : null));
        }

        const sql = `INSERT INTO devices (${cols.join(', ')}) VALUES (${placeholders})`;
        await database.run(sql, params);
        console.log(`新设备创建成功: ${deviceId}, 状态: ${status}`);
      }
    } catch (error) {
      console.error('创建/更新设备失败:', error);
      throw error;
    }
  }

  /**
   * 创建新设备
   * @returns 设备档案中的 MQTT 凭据字段（历史遗留，不参与统一账号认证）
   */
  static async createDevice(
    deviceId: string,
    productId: string,
    name?: string,
    imei?: string,
    iccid?: string,
    manufacturer?: string,
    terminalType?: string,
    location?: string,
    mqttPassword?: string,
    tenantId?: string | null
  ): Promise<{ mqttUsername: string; mqttPassword: string }> {
    try {
      const now = Date.now();
      const mqttUsername = getDefaultMqttUsername(deviceId);
      const finalPassword = mqttPassword?.trim() || generateMqttPassword();
      // 新设备默认未激活：status=offline, activationStatus=inactive, mqttConnected=0
      // 首次 MQTT 连接/数据上报后才变为 已激活 + 在线
      const sql = `
        INSERT INTO devices (id, product_id, name, imei, iccid, manufacturer, terminalType, location, tenant_id, status, activationStatus, mqttConnected, last_seen, created_at, mqttUsername, mqttPassword)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline', 'inactive', 0, ?, ?, ?, ?)
      `;
      await database.run(sql, [
        deviceId, productId || '', name || null,
        imei || null, iccid || null, manufacturer || null,
        terminalType || null, location || null,
        tenantId ?? null,
        now, now, mqttUsername, finalPassword
      ]);
      console.log(`新设备创建成功: ${deviceId} (MQTT用户: ${mqttUsername})`);
      return { mqttUsername, mqttPassword: finalPassword };
    } catch (error: any) {
      if (error.message && error.message.includes('UNIQUE')) {
        throw new Error(`设备 ${deviceId} 已存在`);
      }
      console.error('创建设备失败:', error);
      throw error;
    }
  }

  /**
   * 删除设备及其关联数据
   * @param tenantId 租户ID：传入时仅允许删除该租户的设备（路由层已校验归属，此为纵深防御）
   */
  /**
   * 删除单台设备及其关联数据（**事务内的一个步骤**）
   *
   * 注意：本方法内部**不 BEGIN / COMMIT**，事务边界由调用方控制——
   * 这样单删与批删就能共用同一套删除规则，批删也能形成"一个整体事务"。
   *
   * 删除范围（设备级关联数据，已按真实 schema 核对，均通过 device_id 直接关联设备）：
   *   1. fsu_data_history（厂家原始历史点，device_id = 网关 gwId）
   *   2. device_meters    （电表字典，device_id 即主键，一台网关一行）
   *   3. alarms           （历史告警，device_id → devices.id）
   *   4. alarm_push_logs  （推送记录，device_id 指向设备）
   *   5. devices          （设备主记录，最后删除）
   *
   * 明确**不删除**：sites / tenants / users / 其他设备 /
   * 平台级配置(alarm_notify_config) / 非设备级数据。
   *
   * `alarm_push_logs` 按 device_id 精确删除：只删该设备的推送记录，
   * 不会误删其他设备的记录，也不会清空整表（测试推送的 device_id='demo' 不受影响）。
   *
   * @param tenantId 传入时仅删除该租户的设备（租户隔离）
   * @returns true=设备确实被删除；false=设备不存在或不在该租户范围内
   */
  private static async deleteDeviceRows(deviceId: string, tenantId?: string | null): Promise<boolean> {
    // 租户隔离前置校验：不在可见范围内直接返回，避免"关联数据已删、设备却没删"的越权副作用
    if (tenantId) {
      const owned = await database.get(
        'SELECT id FROM devices WHERE id = ? AND tenant_id = ?', [deviceId, tenantId]
      );
      if (!owned) return false;
    }

    // 先删设备关联数据（4 张设备级表）
    await database.run('DELETE FROM fsu_data_history WHERE device_id = ?', [deviceId]);
    await database.run('DELETE FROM device_meters WHERE device_id = ?', [deviceId]);
    await database.run('DELETE FROM alarms WHERE device_id = ?', [deviceId]);
    await database.run('DELETE FROM alarm_push_logs WHERE device_id = ?', [deviceId]);

    // 最后删设备主记录
    const result = await database.run(
      tenantId
        ? 'DELETE FROM devices WHERE id = ? AND tenant_id = ?'
        : 'DELETE FROM devices WHERE id = ?',
      tenantId ? [deviceId, tenantId] : [deviceId]
    );
    return (result.changes || 0) > 0;
  }

  /**
   * 删除单台设备（单删入口）
   * 事务：BEGIN → deleteDeviceRows → COMMIT，失败整体回滚
   */
  static async deleteDevice(deviceId: string, tenantId?: string | null): Promise<boolean> {
    try {
      await database.run('BEGIN TRANSACTION');
      let deleted = false;
      try {
        deleted = await this.deleteDeviceRows(deviceId, tenantId);
        await database.run('COMMIT');
      } catch (err) {
        await database.run('ROLLBACK').catch(() => undefined);
        throw err;
      }

      if (deleted) {
        console.log(`设备删除成功: ${deviceId}`);
        return true;
      }
      console.warn(`设备删除失败（不存在）: ${deviceId}`);
      return false;
    } catch (error) {
      console.error('删除设备失败:', error);
      throw error;
    }
  }

  /**
   * 批量删除设备
   *
   * 与单删共用同一个 deleteDeviceRows：**单删删什么，批删就删什么**。
   * 全部设备在**同一个事务**内删除 —— 要么全部成功，要么全部回滚，
   * 不会出现"删了 3 台、第 4 台失败、只剩 3 台被删"的部分删除状态。
   *
   * @param tenantId 传入时仅删除该租户的设备（租户隔离）
   * @returns { deleted } 实际删除的设备台数
   */
  static async deleteDevicesBatch(deviceIds: string[], tenantId?: string | null): Promise<{ deleted: number }> {
    try {
      await database.run('BEGIN TRANSACTION');
      let deleted = 0;
      try {
        for (const deviceId of deviceIds) {
          const ok = await this.deleteDeviceRows(deviceId, tenantId);
          if (ok) deleted++;
        }
        await database.run('COMMIT');
      } catch (err) {
        await database.run('ROLLBACK').catch(() => undefined);
        throw err;
      }
      console.log(`批量删除设备完成: 目标 ${deviceIds.length} 台，实际删除 ${deleted} 台`);
      return { deleted };
    } catch (error) {
      console.error('批量删除设备失败（已回滚）:', error);
      throw error;
    }
  }

  /**
   * 修改设备归属租户（平台管理员操作）
   * @param tenantId 租户ID；null=取消分配（设备变未分配，仅平台管理员可见）
   */
  /**
   * 修改设备归属租户
   *
   * 业务规则（租户 ↔ 站点强关联）：
   *  设备的租户**一旦发生变化**，必须同时解除其站点分配（site_id = NULL）——
   *  因为站点属于原租户，设备换了租户后不应再挂在原租户的站点下。
   *   · 租户变了 + 原来有站点 → tenant_id 更新，site_id 置空
   *   · 租户变了 + 原来没站点 → tenant_id 更新，site_id 保持 NULL
   *   · 租户没变（重复分配同一租户）→ 只更新 tenant_id，**不动 site_id**
   *
   * tenant_id 与 site_id 的更新在**同一个事务**里完成，任一步失败整体回滚，
   * 不会出现"租户已改、站点还挂在原租户下"的中间状态。
   *
   * 注意：站点本身不做任何修改（站点仍属于原租户）。
   *
   * @returns true=设备存在且已更新；false=设备不存在
   */
  static async setDeviceTenant(deviceId: string, tenantId: string | null): Promise<boolean> {
    try {
      const existing: any = await this.getDeviceById(deviceId);
      if (!existing) return false;

      const currentTenant = existing.tenant_id ?? null;
      const nextTenant = tenantId ?? null;
      const tenantChanged = currentTenant !== nextTenant;
      const hadSite = existing.site_id != null;

      await database.run('BEGIN TRANSACTION');
      try {
        if (tenantChanged) {
          await database.run(
            'UPDATE devices SET tenant_id = ?, site_id = NULL WHERE id = ?',
            [nextTenant, deviceId]
          );
        } else {
          await database.run(
            'UPDATE devices SET tenant_id = ? WHERE id = ?',
            [nextTenant, deviceId]
          );
        }
        await database.run('COMMIT');
      } catch (err) {
        await database.run('ROLLBACK').catch(() => undefined);
        throw err;
      }

      if (tenantChanged && hadSite) {
        console.log(
          `设备租户变更: ${deviceId} ${currentTenant ?? '未分配'} -> ${nextTenant ?? '未分配'}，` +
          `已自动解除站点分配（原 site_id=${existing.site_id}）`
        );
      }
      return true;
    } catch (error) {
      console.error('修改设备租户失败:', error);
      throw error;
    }
  }

  /**
   * 更新设备的 MQTT 连接状态（由内置 Broker 的 client / clientDisconnect 事件触发）
   * @param deviceId 设备ID
   * @param connected true=已连接, false=已断开
   * 连接 → 激活 + 在线；断开 → 未连接 + 离线（激活状态不回落）
   */
  static async setMqttConnectionState(deviceId: string, connected: boolean): Promise<void> {
    try {
      const existing = await this.getDeviceById(deviceId);
      if (!existing) {
        console.warn(`MQTT连接状态更新失败（设备不存在）: ${deviceId}`);
        return;
      }

      if (connected) {
        await database.run(
          `UPDATE devices SET status = 'online', mqttConnected = 1, activationStatus = 'active' WHERE id = ?`,
          [deviceId]
        );
        console.log(`MQTT 设备已连接: ${deviceId} -> 激活 + 在线`);
      } else {
        await database.run(
          `UPDATE devices SET status = 'offline', mqttConnected = 0 WHERE id = ?`,
          [deviceId]
        );
        console.log(`MQTT 设备已断开: ${deviceId} -> 离线`);
      }
    } catch (error) {
      console.error(`更新 MQTT 连接状态失败: ${deviceId}`, error);
    }
  }

  /**
   * 更新设备心跳时间（厂家协议 gw/v1/heartbeat）
   * 心跳只证明设备在线：更新 last_heartbeat 与在线状态，
   * 不更新 last_seen（last_seen 仅由数据上报/上下线事件更新，
   * 前端"最后上报时间"据此显示真实数据时间，不被心跳刷新造成"有上报"假象）
   */
  /**
   * 修改设备名称（详情页"编辑"唯一允许修改的字段）
   *
   * 说明：upsertDevice 不处理 name 列（它只在 createDevice 时写入），
   * 因此这里单独提供最小更新入口；空串/空值一律存 NULL（详情页显示 "-"）。
   * 只动 name 一列，不触碰 tenant_id / site_id / 任何测量字段。
   * @returns 是否更新成功（设备不存在返回 false）
   */
  static async updateDeviceName(deviceId: string, name: string | null): Promise<boolean> {
    try {
      const trimmed = name != null ? String(name).trim() : '';
      const result = await database.run(
        'UPDATE devices SET name = ? WHERE id = ?',
        [trimmed.length > 0 ? trimmed : null, deviceId]
      );
      return (result.changes || 0) > 0;
    } catch (error) {
      console.error('更新设备名称失败:', error);
      throw error;
    }
  }

  /**
   * 仅更新最新电表快照（devices.latest_meters）
   *
   * 用途：平台**主动查询**类下行（协议 4.5 getData）拿到实时数据后回写实时快照。
   * 与 dataReport 的回写刻意区分开：
   *   - dataReport 走 upsertDevice(msgTs,...)，会同时刷新 last_seen / status
   *     （那是"设备上报"，理应更新上报时间）；
   *   - 这里是平台查询的结果，**仅刷新实时数据本身**，不刷新 last_seen / status，
   *     否则"平台查询一次"会伪装成"设备上报了一次"，污染离线判定与"最后上报时间"。
   *
   * 只动 latest_meters 一列，不新增列、不新增第二份实时数据存储。
   * @returns true=设备存在且已更新；false=设备不存在（不创建假设备）
   */
  static async updateLatestMeters(deviceId: string, latestMetersJson: string): Promise<boolean> {
    try {
      const result = await database.run(
        'UPDATE devices SET latest_meters = ? WHERE id = ?',
        [latestMetersJson, deviceId]
      );
      return (result.changes || 0) > 0;
    } catch (error) {
      console.error('更新实时数据快照失败:', error);
      throw error;
    }
  }

  /**
   * 更新网关 SIM 卡号（厂家协议 4.2 heartbeat.params.ICCID）
   *
   * 复用既有 devices.iccid 列（与其它接入通道共用同一字段），
   * **不新增列、不新增数据结构**。
   * 协议说明 ICCID 是可选字段且"整个程序周期只会上报一次"，
   * 因此调用方只应在拿到非空值时才调用；空值不会覆盖已有值。
   * 只动 iccid 一列，不触碰 last_seen / last_heartbeat / 状态。
   */
  static async updateDeviceIccid(deviceId: string, iccid: string): Promise<boolean> {
    const value = iccid != null ? String(iccid).trim() : '';
    if (!value) return false;
    try {
      const result = await database.run(
        'UPDATE devices SET iccid = ? WHERE id = ?',
        [value, deviceId]
      );
      return (result.changes || 0) > 0;
    } catch (error) {
      console.error('更新设备 ICCID 失败:', error);
      return false;
    }
  }

  static async setHeartbeat(deviceId: string, timestamp: number): Promise<void> {
    try {
      const existing = await this.getDeviceById(deviceId);
      if (!existing) {
        // 心跳先于数据上报到达时自动创建设备（复用创建逻辑，随后补心跳时间）
        await this.upsertDevice(deviceId, '', timestamp, 'online', { protocolType: 'vendor' });
      }
      await database.run(
        `UPDATE devices SET last_heartbeat = ?, status = 'online', mqttConnected = 1, activationStatus = 'active' WHERE id = ?`,
        [timestamp, deviceId]
      );
    } catch (error) {
      console.error('更新设备心跳失败:', error);
    }
  }

  /**
   * 心跳超时离线扫描：厂家设备（last_heartbeat 非空）心跳超时未更新 → 标记离线
   * 用于断电/断网快速感知：心跳每 20 秒一次，默认 3 分钟（≈9 次心跳）未到即判定离线，
   * 比数据上报阈值（10 分钟）快得多。不做"已连接"排除——正常设备心跳持续到达，
   * 心跳超时本身就说明设备已失联（断电后 TCP 半开连接不会主动断开，Broker 侧
   * keepalive 依赖设备 CONNECT 参数，可能很久才触发）。
   */
  static async markStaleHeartbeatOffline(thresholdTs: number): Promise<number> {
    try {
      const result = await database.run(
        `UPDATE devices SET status = 'offline', mqttConnected = 0
         WHERE status = 'online' AND last_heartbeat IS NOT NULL AND last_heartbeat < ?`,
        [thresholdTs]
      );
      const affected = result.changes || 0;
      if (affected > 0) {
        console.log(`心跳超时扫描: ${affected} 台设备心跳超时（断电/断网），已标记离线`);
      }
      return affected;
    } catch (error) {
      console.error('心跳超时扫描失败:', error);
      return 0;
    }
  }

  /**
   * 超时扫描：超过 thresholdTs 无数据且未被 Broker 判定为连接中的设备 → 标记离线
   * @param thresholdTs 时间阈值（毫秒），last_seen 早于该值的视为超时
   * @param connectedIds 当前 MQTT 已连接的设备ID集合（连接中但暂未上报数据的设备不标记离线）
   * @returns 被标记离线的设备数
   */
  static async markStaleDevicesOffline(
    thresholdTs: number,
    connectedIds: Set<string> = new Set()
  ): Promise<number> {
    try {
      let result;
      if (connectedIds.size > 0) {
        const placeholders = Array.from(connectedIds).map(() => '?').join(', ');
        result = await database.run(
          `UPDATE devices SET status = 'offline', mqttConnected = 0
           WHERE status = 'online' AND last_seen < ? AND id NOT IN (${placeholders})`,
          [thresholdTs, ...connectedIds]
        );
      } else {
        result = await database.run(
          `UPDATE devices SET status = 'offline', mqttConnected = 0
           WHERE status = 'online' AND last_seen < ?`,
          [thresholdTs]
        );
      }
      const affected = result.changes || 0;
      if (affected > 0) {
        console.log(`超时扫描: ${affected} 台设备超过时限无数据，已标记离线`);
      }
      return affected;
    } catch (error) {
      console.error('超时扫描失败:', error);
      return 0;
    }
  }

  /**
   * 获取设备统计信息
   */
  static async getDeviceStats(): Promise<{
    total: number;
    online: number;
    offline: number;
  }> {
    try {
      const total = await database.get('SELECT COUNT(*) as count FROM devices');
      const online = await database.get('SELECT COUNT(*) as count FROM devices WHERE status = ?', ['online']);
      const offline = await database.get('SELECT COUNT(*) as count FROM devices WHERE status = ?', ['offline']);

      return {
        total: total?.count || 0,
        online: online?.count || 0,
        offline: offline?.count || 0
      };
    } catch (error) {
      console.error('获取设备统计失败:', error);
      return { total: 0, online: 0, offline: 0 };
    }
  }
}

export default DeviceService;