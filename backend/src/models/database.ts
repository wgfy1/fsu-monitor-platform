import sqlite3 from 'sqlite3';
import path from 'path';
import { generateMqttPassword } from '../utils/mqttCredentials';

/**
 * 数据库配置
 */
const DB_CONFIG = {
  path: process.env.DB_PATH || './data/fsu.db'
};

/**
 * 数据库类
 */
export class Database {
  private static instance: Database;
  private db: sqlite3.Database;

  private constructor() {
    const fs = require('fs');
    const dbDir = path.dirname(DB_CONFIG.path);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = new sqlite3.Database(DB_CONFIG.path, (err) => {
      if (err) {
        console.error('数据库连接失败:', err.message);
        throw err;
      }
      console.log('SQLite数据库已连接:', DB_CONFIG.path);
    });

    this.initTables();
    // 索引必须在迁移（ALTER TABLE 补列）完成后创建：
    // tenant_id 等新列在存量库上由 migrateColumns 添加，先建索引会因列不存在而失败。
    //
    // 迁移链是**串行**的：migrateColumns 失败即中断，后续 migrateToFormalTenants /
    // dropLegacyWorkOrderTable / dropUsersNameColumn / createIndexes 都不会执行
    // （不会"前面失败后面继续跑"）。
    //
    // dropUsersNameColumn 必须排在 createIndexes 之前：它通过重建表实现，
    // 表被重建后其上的索引会一并消失，需由 createIndexes 在最后统一补齐。
    const migration = this.migrateColumns()
      .then(() => this.migrateToFormalTenants())
      .then(() => this.dropLegacyWorkOrderTable())
      .then(() => this.dropUsersNameColumn())
      .then(() => this.addAlarmProtocolColumns())
      .then(() => this.createFsuDataHistoryTable())
      // device_data 最终退出：必须在 createIndexes 之前（否则会为已删表建索引）
      .then(() => this.dropLegacyDeviceData())
      // devices 历史列退出：同样必须在 createIndexes 之前（重建/删除列会影响索引）
      .then(() => this.dropLegacyDeviceColumns())
      .then(() => this.createIndexes());

    // 先挂一个空 catch：避免调用方 attach handler 之前触发 unhandledRejection 告警。
    // ready 本身仍会 reject，由启动入口 await 并 fail-fast。
    migration.catch(() => undefined);
    this.ready = migration;
  }

  /**
   * 启动阶段迁移完成信号
   *
   * 迁移全部成功 → resolve；任一步失败 → reject。
   * 启动入口**必须** await 本 Promise 后再监听端口，实现 fail-fast
   * （数据库结构不完整时禁止服务带病启动）。
   */
  public readonly ready: Promise<void>;

  static getInstance(): Database {
    if (!Database.instance) {
      Database.instance = new Database();
    }
    return Database.instance;
  }

  getConnection(): sqlite3.Database {
    return this.db;
  }

  private initTables(): void {
    this.db.serialize(() => {
      // 设备信息表（包含新列，CREATE OR REPLACE 不会影响已有表）
      this.db.run(`
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL,
          -- 归属租户（NULL=未分配设备，仅平台管理员可见）
          tenant_id TEXT,
          name TEXT,
          imei TEXT,
          iccid TEXT,
          manufacturer TEXT,
          terminalType TEXT,
          moduleType TEXT,
          hardwareVersion TEXT,
          softwareVersion TEXT,
          reportPeriod INTEGER,
          location TEXT,
          status TEXT NOT NULL DEFAULT 'offline',
          activationStatus TEXT NOT NULL DEFAULT 'inactive',
          mqttConnected INTEGER NOT NULL DEFAULT 0,
          last_seen INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          -- 设备序列号等接入信息（历史字段）
          device_sn TEXT,
          protocol_type TEXT,
          -- 历史遗留的 MQTT 凭据字段。平台已改为全设备统一账号认证
          -- （MQTT_USERNAME/MQTT_PASSWORD），这两列不再参与认证，仅作设备档案留档
          mqttUsername TEXT,
          mqttPassword TEXT,
          -- 厂家协议原始电表数据（JSON: { devId: { meterId: value } }）
          latest_meters TEXT,
          -- 最后心跳时间（厂家协议 heartbeat，仅证明设备在线；last_seen 仅由数据上报更新）
          last_heartbeat INTEGER
        )
      `, (err) => {
        if (err) console.error('创建设备表失败:', err.message);
        else console.log('设备表创建/已存在');
      });

      // 告警记录表
      this.db.run(`
        CREATE TABLE IF NOT EXISTS alarms (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          device_id TEXT NOT NULL,
          type TEXT NOT NULL,
          severity TEXT NOT NULL,
          message TEXT NOT NULL,
          value TEXT,
          source TEXT NOT NULL DEFAULT 'MQTT',
          resolved INTEGER NOT NULL DEFAULT 0,
          resolved_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          -- 厂家协议（4.4 告警上报）扩展字段，均为可空：
          -- serial_no  = 厂家告警唯一标识（去重/关联依据）
          -- alarm_level= 告警级别 [1,5]
          -- is_history = 1 历史告警 / 0 非历史
          serial_no TEXT,
          alarm_level INTEGER,
          is_history INTEGER,
          FOREIGN KEY (device_id) REFERENCES devices (id)
        )
      `, (err) => {
        if (err) console.error('创建告警表失败:', err.message);
        else console.log('告警表创建/已存在');
      });

      // 厂家电表字典表（gw/v1/uploadDevInfo 上传的 meterId→meterName/meterType 定义）
      this.db.run(`
        CREATE TABLE IF NOT EXISTS device_meters (
          device_id TEXT PRIMARY KEY,
          meters_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `, (err) => {
        if (err) console.error('创建电表字典表失败:', err.message);
        else console.log('电表字典表创建/已存在');
      });

      // 用户账号表（多角色账号管理）
      // username 不区分大小写（UNIQUE COLLATE NOCASE），密码仅存 bcrypt 哈希
      this.db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user',
          -- 归属租户（NULL=平台运维账号，可查看全部租户数据）
          -- UNIQUE：一个租户最多只能绑定一个用户（NULL 不受限，平台管理员可多个）
          tenant_id TEXT UNIQUE,
          status INTEGER NOT NULL DEFAULT 1,
          last_login_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        )
      `, (err) => {
        if (err) console.error('创建用户表失败:', err.message);
        else console.log('用户表创建/已存在');
      });

      // 站点表（租户 → 站点 → 设备）
      // 站点状态不作为列存储：由关联设备与告警实时计算（避免维护一份与设备脱节的假状态）
      this.db.run(`
        CREATE TABLE IF NOT EXISTS sites (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          -- 站点编号（系统生成，全局唯一，如 SITE-0001）
          code TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          -- 所属租户（NULL=平台未分配）
          tenant_id TEXT,
          -- 行政区划只存 code，名称由 RegionService 解析，保证与基础数据一致
          province_code TEXT,
          city_code TEXT,
          district_code TEXT,
          -- 详细地址（用户自行填写，不含省市县）
          address TEXT,
          remark TEXT,
          -- 站点经纬度（可为空；未填写时首页地图不显示该站点 Marker）
          -- 坐标系：GCJ-02（高德/腾讯坐标），与前端高德地图底图一致
          latitude REAL,
          longitude REAL,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        )
      `, (err) => {
        if (err) console.error('创建站点表失败:', err.message);
        else console.log('站点表创建/已存在');
      });

      // 租户级告警推送配置（与平台级 alarm_notify_config 同结构）
      // 平台管理员用 alarm_notify_config(id=1)；租户账号用本表，一租户一行，互不可见
      this.db.run(`
        CREATE TABLE IF NOT EXISTS tenant_notify_config (
          tenant_id TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 0,
          dingtalk_enabled INTEGER NOT NULL DEFAULT 0,
          dingtalk_webhook TEXT,
          dingtalk_secret TEXT,
          sms_enabled INTEGER NOT NULL DEFAULT 0,
          sms_numbers TEXT,
          dedupe_minutes INTEGER NOT NULL DEFAULT 30,
          updated_at INTEGER NOT NULL
        )
      `, (err) => {
        if (err) console.error('创建租户推送配置表失败:', err.message);
        else console.log('租户推送配置表创建/已存在');
      });

      // 告警推送配置表（单行: id 恒为 1，整体 upsert；钉钉群机器人 + 短信通道(短信暂预留)）
      this.db.run(`
        CREATE TABLE IF NOT EXISTS alarm_notify_config (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          enabled INTEGER NOT NULL DEFAULT 0,
          dingtalk_enabled INTEGER NOT NULL DEFAULT 0,
          dingtalk_webhook TEXT,
          dingtalk_secret TEXT,
          sms_enabled INTEGER NOT NULL DEFAULT 0,
          sms_numbers TEXT,
          dedupe_minutes INTEGER NOT NULL DEFAULT 30,
          updated_at INTEGER NOT NULL
        )
      `, (err) => {
        if (err) console.error('创建告警推送配置表失败:', err.message);
        else console.log('告警推送配置表创建/已存在');
      });

      // 告警推送记录表（每次真实发送尝试留痕：成败/原因/目标脱敏）
      this.db.run(`
        CREATE TABLE IF NOT EXISTS alarm_push_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          alarm_id INTEGER,
          action TEXT NOT NULL DEFAULT 'alarm',
          device_id TEXT,
          type TEXT,
          severity TEXT,
          message TEXT,
          channel TEXT NOT NULL,
          target TEXT,
          status TEXT NOT NULL,
          detail TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        )
      `, (err) => {
        if (err) console.error('创建告警推送记录表失败:', err.message);
        else console.log('告警推送记录表创建/已存在');
      });
    });
  }

  /**
   * 为已有表添加新列（迁移兼容）
   */
  /**
   * 判断是否为「列已存在」错误（迁移中唯一可以安全忽略的异常）
   *
   * SQLite 添加已存在的列时报：`SQLITE_ERROR: duplicate column name: latitude`
   * 取 message 与 code 一起匹配，避免不同驱动封装导致漏判。
   */
  private static isDuplicateColumnError(err: unknown): boolean {
    const message = String((err as any)?.message ?? '').toLowerCase();
    const code = String((err as any)?.code ?? '').toLowerCase();
    return message.includes('duplicate column name') || code.includes('duplicate column name');
  }

  private async migrateColumns(): Promise<void> {
    const migrations = [
      // devices 表新列
      `ALTER TABLE devices ADD COLUMN imei TEXT`,
      `ALTER TABLE devices ADD COLUMN iccid TEXT`,
      `ALTER TABLE devices ADD COLUMN manufacturer TEXT`,
      `ALTER TABLE devices ADD COLUMN terminalType TEXT`,
      `ALTER TABLE devices ADD COLUMN moduleType TEXT`,
      `ALTER TABLE devices ADD COLUMN hardwareVersion TEXT`,
      `ALTER TABLE devices ADD COLUMN softwareVersion TEXT`,
      `ALTER TABLE devices ADD COLUMN reportPeriod INTEGER`,
      `ALTER TABLE devices ADD COLUMN activationStatus TEXT DEFAULT 'inactive'`,
      `ALTER TABLE devices ADD COLUMN mqttConnected INTEGER DEFAULT 0`,
      `ALTER TABLE devices ADD COLUMN device_sn TEXT`,
      `ALTER TABLE devices ADD COLUMN protocol_type TEXT`,
      `ALTER TABLE devices ADD COLUMN mqttUsername TEXT`,
      `ALTER TABLE devices ADD COLUMN mqttPassword TEXT`,
      `ALTER TABLE devices ADD COLUMN latest_meters TEXT`,
      `ALTER TABLE devices ADD COLUMN last_heartbeat INTEGER`,
      // 多租户：devices/users 归属租户（存量数据均为 NULL=平台/未分配）
      `ALTER TABLE devices ADD COLUMN tenant_id TEXT`,
      `ALTER TABLE users ADD COLUMN tenant_id TEXT`,
      // 站点：设备归属站点（NULL=未分配）。仅新增列，不动存量数据
      `ALTER TABLE devices ADD COLUMN site_id INTEGER`,
      // 告警推送记录归属租户（存量记录为 NULL=平台级）
      `ALTER TABLE alarm_push_logs ADD COLUMN tenant_id TEXT`,
      // 站点经纬度（存量站点保持 NULL，不影响任何现有数据）
      // 列已存在时 ALTER 会报错并被下面的 catch 忽略，因此不会重复添加
      `ALTER TABLE sites ADD COLUMN latitude REAL`,
      `ALTER TABLE sites ADD COLUMN longitude REAL`,
      // 平台主动校时配置（协议 4.8，平台→网关；每台设备独立持久化）
      //   ntp_sync_enabled       是否启用**定时**校时（上线校时不受此开关影响）
      //   ntp_sync_interval_hours 定时校时间隔（小时），只允许 1/6/12/24/48
      //   ntp_last_sent_at       最近一次校时发布时间（毫秒）
      //   ntp_last_type          最近一次校时类型：online | scheduled
      //   ntp_next_due_at        下一次计划校时时间（毫秒）；NULL=尚未安排
      // 存量设备默认：启用、24 小时、尚未安排（首次上线校时时写入）
      `ALTER TABLE devices ADD COLUMN ntp_sync_enabled INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE devices ADD COLUMN ntp_sync_interval_hours INTEGER NOT NULL DEFAULT 24`,
      `ALTER TABLE devices ADD COLUMN ntp_last_sent_at INTEGER`,
      `ALTER TABLE devices ADD COLUMN ntp_last_type TEXT`,
      `ALTER TABLE devices ADD COLUMN ntp_next_due_at INTEGER`,
    ];

    for (const sql of migrations) {
      try {
        await this.run(sql);
      } catch (err) {
        // 只忽略"列已存在"（重复添加列）：SQLite 报
        //   SQLITE_ERROR: duplicate column name: xxx
        // 其他任何数据库异常（表不存在、语法错误、磁盘/权限问题等）都必须抛出，
        // 否则迁移失败会被静默吞掉，后续代码将在缺列的表上运行。
        if (!Database.isDuplicateColumnError(err)) {
          console.error(`[迁移] 执行失败: ${sql}`);
          throw err;
        }
      }
    }

    // 为存量设备回填激活状态：当前在线的设备视为已激活、已连接
    await this.run(
      `UPDATE devices SET activationStatus = 'active', mqttConnected = 1 WHERE status = 'online' AND activationStatus = 'inactive'`
    );

    // 为存量设备回填 MQTT 凭据字段（历史遗留：平台现已使用统一 MQTT 账号，
    // 该字段不再参与认证，仅为兼容旧数据结构、避免列值为空）
    const legacyDevices = await this.query(
      `SELECT id FROM devices WHERE mqttUsername IS NULL OR mqttUsername = '' OR mqttPassword IS NULL OR mqttPassword = ''`
    );
    if (legacyDevices.length > 0) {
      for (const device of legacyDevices) {
        await this.run(
          `UPDATE devices SET mqttUsername = ?, mqttPassword = ? WHERE id = ?`,
          [device.id, generateMqttPassword(), device.id]
        );
      }
      console.log(`已为 ${legacyDevices.length} 台存量设备生成 MQTT 凭据`);
    }
  }

  /**
   * 一次性迁移：把「字符串租户」升级为「正式租户模型」
   *
   * 迁移前：users/sites/devices/... 的 tenant_id 直接存租户名称字符串（如 "江杰"），
   *         且没有独立的租户实体。
   * 迁移后：新增 tenants 表（id 为正式租户标识，name 唯一），各表 tenant_id 关联 tenants.id；
   *         users.tenant_id 加唯一约束（一个租户最多一个用户）。
   *
   * 迁移是**一次性**的：以 tenants 表是否存在作为标记（本方法内创建，成功提交后才存在）。
   * 新库首次启动同样会走一遍（无旧数据可清理，只是建表 + 建约束）。
   *
   * 关于旧测试数据的处理（经用户确认，当前为测试阶段）：
   *   - 只清理【租户维度】的数据（字符串租户的账号/站点/设备/历史数据/告警/推送配置与记录）
   *   - 【平台级】数据一律保留：平台管理员账号、平台推送配置(alarm_notify_config)、
   *     未归属租户的设备与站点、MQTT/FSU 相关数据
   *   - 不保留 "tenant_id = 名称字符串" 的旧值
   *
   * 全过程在一个事务内完成，任一步失败即整体回滚。
   */
  private async migrateToFormalTenants(): Promise<void> {
    try {
      const migrated = await this.get(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenants'`
      );
      if (migrated) return; // 已迁移过

      console.log('[租户迁移] 检测到旧版租户模型，开始一次性迁移（平台数据保留，旧租户测试数据清理）...');

      const statements: string[] = [
        // 1) 清理旧的字符串租户数据（平台级数据不动）
        `DELETE FROM alarm_push_logs WHERE tenant_id IS NOT NULL`,
        `DELETE FROM tenant_notify_config`,
        `DELETE FROM alarms WHERE device_id IN (SELECT id FROM devices WHERE tenant_id IS NOT NULL)`,
        `DELETE FROM device_meters WHERE device_id IN (SELECT id FROM devices WHERE tenant_id IS NOT NULL)`,
        `DELETE FROM devices WHERE tenant_id IS NOT NULL`,
        `DELETE FROM sites WHERE tenant_id IS NOT NULL`,
        `DELETE FROM users WHERE tenant_id IS NOT NULL`,

        // 2) 重建 users：为 tenant_id 加唯一约束（一个租户最多一个用户）
        `CREATE TABLE users_new (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           username TEXT NOT NULL UNIQUE COLLATE NOCASE,
           password TEXT NOT NULL,
           role TEXT NOT NULL DEFAULT 'user',
           tenant_id TEXT UNIQUE,
           status INTEGER NOT NULL DEFAULT 1,
           last_login_at INTEGER,
           created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
         )`,
        `INSERT INTO users_new (id, username, password, role, tenant_id, status, last_login_at, created_at)
           SELECT id, username, password, role, tenant_id, status, last_login_at, created_at FROM users`,
        `DROP TABLE users`,
        `ALTER TABLE users_new RENAME TO users`,

        // 3) 正式租户表（id 为正式租户标识；name 唯一）
        `CREATE TABLE tenants (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL UNIQUE,
           remark TEXT,
           status INTEGER NOT NULL DEFAULT 1,
           created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
           updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
         )`,
      ];

      await this.run('BEGIN TRANSACTION');
      try {
        for (const sql of statements) {
          await this.run(sql);
        }
        await this.run('COMMIT');
      } catch (err) {
        await this.run('ROLLBACK').catch(() => undefined);
        throw err;
      }

      console.log('[租户迁移] 完成：已建立正式 tenants 表，users.tenant_id 已加唯一约束');
    } catch (error) {
      // 迁移失败不阻断服务启动（事务已回滚，数据保持一致）
      console.error('[租户迁移] 失败（已回滚）:', error);
    }
  }

  /**
   * 一次性迁移：删除已下线的工单表 work_orders（及其随表删除的 4 个索引）。
   *
   * 安全策略：仅当表存在且为空时才 DROP。若表中仍有数据则跳过并告警，
   * 交由运维自行备份后手工处理——绝不静默丢弃业务数据。
   * 只动 work_orders 一张表，devices/alarms/users/device_meters
   * 以及告警推送相关表（alarm_notify_config / alarm_push_logs）一律不受影响。
   */
  private async dropLegacyWorkOrderTable(): Promise<void> {
    try {
      const table = await this.get(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_orders'`
      );
      if (!table) return; // 全新库或已迁移过，无需处理

      const counted = await this.get(`SELECT COUNT(*) as count FROM work_orders`);
      const rows = counted?.count || 0;
      if (rows > 0) {
        console.warn(
          `[迁移] work_orders 表存在 ${rows} 条历史工单数据，为免误删已跳过 DROP。` +
          `请确认无需保留后手工执行: DROP TABLE work_orders;`
        );
        return;
      }

      await this.run(`DROP TABLE work_orders`);
      console.log('[迁移] 已删除下线的空表 work_orders（工单功能已移除）');
    } catch (error) {
      // 迁移失败不应阻断服务启动：表保留也不影响告警/设备等主链路
      console.error('[迁移] 删除 work_orders 表失败:', error);
    }
  }

  /**
   * 自动备份数据库文件（迁移前调用，失败即抛错中止迁移）
   *
   * 仅做整库文件拷贝：迁移在启动阶段串行执行，此刻不会有并发写入，
   * 且当前库未开启 WAL，拷贝 fsu.db 即为完整快照。
   */
  private backupDatabase(reason: string): string {
    const fs = require('fs');
    const src = DB_CONFIG.path;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const dest = `${src}.bak-${stamp}-${reason}`;
    fs.copyFileSync(src, dest);
    console.log(`[迁移] 已备份数据库: ${dest}`);
    return dest;
  }

  /**
   * 正式迁移：删除 users.name 列（"用户姓名"业务概念已废弃）
   *
   * 最终用户模型只保留：username（登录账号）/ password（登录密码）/ role / status /
   * tenant_id / last_login_at / created_at —— 不再有"姓名"。
   *
   * 实现方式：SQLite 旧版本不支持 DROP COLUMN，采用**表重建**：
   *   1) 迁移前整库文件备份（失败即中止，不进入重建）
   *   2) 事务内：建 users_new（无 name，其余列与约束逐字保留）→ 全量拷贝数据
   *              → DROP users → RENAME users_new TO users
   *   3) 任一步失败整体 ROLLBACK，不会留下半迁移状态
   *
   * 失败策略：**fail-fast** —— 本方法任何一步失败都会向上抛错，
   * database.ready 随之 reject，启动入口 process.exit(1)，
   * 进程在监听端口 / 启动 MQTT 之前就退出。
   * 幂等：users 表不存在该列时直接正常返回，不重复迁移。
   *
   * 保留项：id / username（含 UNIQUE COLLATE NOCASE）/ password / role /
   *        tenant_id（含 UNIQUE，即"一个租户最多一个账号"）/ status /
   *        last_login_at / created_at，数据逐行原样拷贝。
   * 受影响项：仅 name 列的取值（admin 的"系统管理员"）随列删除，属预期结果。
   */
  private async dropUsersNameColumn(): Promise<void> {
    const LEGACY_COLUMN = 'name';
    try {
      // 1) 是否需要迁移：users 表存在且仍含 name 列
      const table = await this.get(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'`
      );
      if (!table) return; // 全新库（users 表由 initTables 建出，本就走无 name 结构）

      const cols = await this.query(`PRAGMA table_info(users)`);
      if (!cols.some((c: any) => c.name === LEGACY_COLUMN)) return; // 已迁移过

      const before = await this.get(`SELECT COUNT(*) AS count FROM users`);
      console.log(
        `[迁移] 检测到 users.name 列，开始重建 users 表删除该列（现有 ${before?.count || 0} 个账号，先备份）...`
      );

      // 2) 自动备份（备份失败会抛错，直接中止，不进入重建）
      const backupFile = this.backupDatabase('before-drop-users-name');

      // 3) 事务内重建表
      await this.run('BEGIN TRANSACTION');
      try {
        await this.run(`CREATE TABLE users_new (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           username TEXT NOT NULL UNIQUE COLLATE NOCASE,
           password TEXT NOT NULL,
           role TEXT NOT NULL DEFAULT 'user',
           tenant_id TEXT UNIQUE,
           status INTEGER NOT NULL DEFAULT 1,
           last_login_at INTEGER,
           created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
         )`);
        await this.run(
          `INSERT INTO users_new (id, username, password, role, tenant_id, status, last_login_at, created_at)
             SELECT id, username, password, role, tenant_id, status, last_login_at, created_at FROM users`
        );
        await this.run(`DROP TABLE users`);
        await this.run(`ALTER TABLE users_new RENAME TO users`);
        await this.run('COMMIT');
      } catch (err) {
        await this.run('ROLLBACK').catch(() => undefined);
        throw err;
      }

      const after = await this.get(`SELECT COUNT(*) AS count FROM users`);
      console.log(
        `[迁移] users.name 已删除：账号数 ${before?.count || 0} → ${after?.count || 0}，` +
        `备份文件 ${path.basename(backupFile)}`
      );
    } catch (error) {
      // fail-fast：本迁移失败必须向上抛出，让 database.ready reject，
      // 由启动入口 process.exit(1) 终止进程（不监听端口，也不启动 MQTT / API），
      // 避免"结构迁移只做了一半还对外服务"。
      //
      // 失败发生在事务内的，上面的 catch 已执行 ROLLBACK，
      // users 表保持迁移前原样（仍含 name 列），不会留下半迁移状态；
      // 备份阶段失败则根本没有进入重建。
      console.error('[迁移] 删除 users.name 失败，数据库结构未完成，服务将终止启动:', error);
      throw error;
    }
  }

  /**
   * 正式迁移：为厂家协议补充 alarms 表字段
   *
   * 背景（厂家《网关 MQTT 通信协议》4.4 网关上报告警数据）：
   *   - serialNo 是厂家定义的**告警唯一标识**，协议要求按它做告警去重/关联；
   *   - alarmLevel 是告警级别 [1,5]，协议要求保留；
   *   - isHistory 表示历史告警，需保留其历史语义。
   * 现有 alarms 表只有 (device_id,type,severity,message,value,source,resolved,...)，
   * 无法表达这三个字段，故按"最小化数据库变更"原则**新增三个可空列**：
   *   - 纯新增可空列，不重写任何既有行，不改表结构其余部分；
   *   - 不动 devices / sites / tenants / tenant_id / site_id / device_id；
   *   - 不删除任何历史告警。
   *
   * 安全策略（与 dropUsersNameColumn 一致）：迁移前整库备份 → 事务内执行 →
   * 任一步失败整体 ROLLBACK 并抛错（fail-fast，database.ready 随之 reject，
   * 启动入口 process.exit(1)，不带病对外服务）。
   * 幂等：三个列都已存在时直接返回，不重复迁移、不重复备份。
   */
  private async addAlarmProtocolColumns(): Promise<void> {
    const COLUMNS: [string, string][] = [
      ['serial_no', 'TEXT'],
      ['alarm_level', 'INTEGER'],
      ['is_history', 'INTEGER'],
    ];
    try {
      const table = await this.get(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alarms'`
      );
      if (!table) return; // 全新库：initTables 已按最新结构建表

      const cols = await this.query(`PRAGMA table_info(alarms)`);
      const existing = new Set(cols.map((c: any) => c.name));
      const missing = COLUMNS.filter(([name]) => !existing.has(name));
      if (missing.length === 0) return; // 已迁移过

      console.log(
        `[迁移] 检测到 alarms 表缺少厂家协议字段，开始补充: ${missing.map((m) => m[0]).join(', ')}（先备份）`
      );

      // 自动备份（备份失败会抛错，直接中止，不进入 ALTER）
      this.backupDatabase('before-add-alarm-protocol-columns');

      await this.run('BEGIN TRANSACTION');
      try {
        for (const [name, type] of missing) {
          await this.run(`ALTER TABLE alarms ADD COLUMN ${name} ${type}`);
        }
        await this.run('COMMIT');
      } catch (err) {
        await this.run('ROLLBACK').catch(() => undefined);
        throw err;
      }

      console.log(`[迁移] alarms 厂家协议字段已补充: ${missing.map((m) => m[0]).join(', ')}`);
    } catch (error) {
      // fail-fast：抛给 database.ready，由启动入口退出进程
      console.error('[迁移] 补充 alarms 厂家协议字段失败，数据库结构未完成，服务将终止启动:', error);
      throw error;
    }
  }

  /**
   * 正式迁移：新增厂家 FSU 协议历史数据表 fsu_data_history
   *
   * 旧 device_data.properties 属于**旧物模型**结构（把 devId/meterId 转成
   * powerOutputVoltage / temperature 等平台字段），无法表达"哪个子设备的哪个测量点"。
   * 本表为厂家 FSU 协议建立**独立**的正式历史存储，语义严格对应协议原始数据：
   *   device_id = 网关 gwId ｜ dev_id = 厂家子设备 ｜ meter_id = 厂家测量点
   *   value     = 厂家原始值（string，不做任何转换）
   *
   * 时间字段统一毫秒：data_timestamp 数据时间 / received_at 接收时间 / created_at 入库时间。
   *
   * 安全策略：整库备份 → 事务内建表+建索引 → 失败 ROLLBACK 并抛错（fail-fast）。
   * 幂等：表已存在直接返回；SQL 全部 IF NOT EXISTS。
   * 不删除任何已有数据、不修改任何现有表结构。
   */
  private async createFsuDataHistoryTable(): Promise<void> {
    try {
      const exists = await this.get(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fsu_data_history'`
      );
      if (exists) return; // 幂等

      console.log('[迁移] 创建厂家 FSU 历史数据表 fsu_data_history（先备份）...');
      this.backupDatabase('before-create-fsu-data-history');

      await this.run('BEGIN TRANSACTION');
      try {
        await this.run(`CREATE TABLE IF NOT EXISTS fsu_data_history (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          device_id      TEXT    NOT NULL,
          dev_id         TEXT    NOT NULL,
          meter_id       TEXT    NOT NULL,
          value          TEXT    NOT NULL,
          is_history     INTEGER NOT NULL DEFAULT 0,
          data_timestamp INTEGER NOT NULL,
          received_at    INTEGER NOT NULL,
          created_at     INTEGER NOT NULL
        )`);
        await this.run(`CREATE INDEX IF NOT EXISTS idx_fsu_hist_dev_meter_ts
          ON fsu_data_history(device_id, dev_id, meter_id, data_timestamp)`);
        await this.run(`CREATE INDEX IF NOT EXISTS idx_fsu_hist_device_ts
          ON fsu_data_history(device_id, data_timestamp)`);
        await this.run('COMMIT');
      } catch (err) {
        await this.run('ROLLBACK').catch(() => undefined);
        throw err;
      }
      console.log('[迁移] fsu_data_history 已创建（含 2 个索引）');
    } catch (error) {
      console.error('[迁移] 创建 fsu_data_history 失败，数据库结构未完成，服务将终止启动:', error);
      throw error;
    }
  }

  /**
   * 正式迁移：删除旧物模型遗留表 device_data（最终退出）
   *
   * device_data 属旧物模型（CTWING 物模型）时代的历史数据表。正式链路早已迁移为：
   *   实时 → devices.latest_meters ｜ 历史 → fsu_data_history ｜ 字典 → device_meters
   * 运行代码已**无任何读写方**（含设备删除链、租户删除链、每日清理任务均已移除依赖），
   * 仅剩本文件的历史 migration 会创建它——因此新库也走完整路径后在此自删，保证幂等。
   *
   * 实现（备份 → 事务 → DROP → 校验）：
   *   1) 表不存在 → 直接返回（全新库或已迁移过）
   *   2) 记录行数 + **整库备份**（备份失败即中止，绝不无备份 DROP）
   *   3) 事务内 DROP TABLE，任何一步失败整体 ROLLBACK
   *   4) DROP 后校验 sqlite_master 中确实不再存在该表
   *
   * 失败策略：**fail-fast** —— 任何一步失败都向上抛错，database.ready 随之 reject，
   * 启动入口 process.exit(1)，进程在监听端口 / 启动 MQTT 之前退出。
   *
   * 表中历史数据**不迁移**：属已废弃的旧物模型历史，经确认无需保留（有整库备份兜底）。
   */
  private async dropLegacyDeviceData(): Promise<void> {
    const table = await this.get(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'device_data'`
    );
    if (!table) return; // 全新库或已迁移过，无需处理

    const counted = await this.get(`SELECT COUNT(*) as count FROM device_data`);
    const rows = counted?.count || 0;

    // 幂等：新库不再创建该表，现存库中也已删除 → 稳态下每次启动到这里即 return。
    // 仅**旧版本数据库**（仍带 device_data）会走到备份 + DROP。
    // 另：若该表存在但为空（异常残留），不备份、静默删除，避免产生无意义的备份文件。
    if (rows > 0) {
      console.log(`[迁移] 检测到旧物模型遗留表 device_data（${rows} 行），准备删除（历史数据不迁移）...`);
      // 整库备份：失败即抛错中止，绝不进入 DROP
      this.backupDatabase('before-drop-device-data');
    }

    await this.run('BEGIN TRANSACTION');
    try {
      await this.run('DROP TABLE device_data');
      await this.run('COMMIT');
    } catch (err) {
      await this.run('ROLLBACK').catch(() => undefined);
      throw err;
    }

    // DROP 后校验：表必须确实已不存在
    const still = await this.get(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'device_data'`
    );
    if (still) {
      throw new Error('[迁移] device_data 删除后校验失败：sqlite_master 中仍存在该表');
    }

    if (rows > 0) {
      console.log(
        `[迁移] 已删除旧物模型遗留表 device_data（${rows} 行，未迁移历史数据）。` +
        `删除原因：正式链路为 devices.latest_meters + fsu_data_history + device_meters，运行代码已无依赖。`
      );
    }
  }

  /** devices 表中已废弃的历史列（旧物模型 17 个测量字段 + device_name 孤儿列） */
  private static readonly LEGACY_DEVICE_COLUMNS: string[] = [
    'door_state',
    'powerOutputVoltage', 'powerOutputCurrent',
    'inputVoltage', 'inputCurrent',
    'loopType', 'loadRate',
    'temperature', 'humidity', 'signal',
    'sinr', 'pci', 'ecl', 'cellId', 'powerStatus', 'errorCode', 'deviceTime',
    // 历史孤儿列：源码 schema 中从未定义，仅存在于老库，全库零数据
    'device_name',
  ];

  /**
   * 正式迁移：删除 devices 表中的历史遗留列（旧物模型 17 列 + 孤儿列 device_name）
   *
   * 这 18 列已无任何运行时代码引用（读写均为 0）。正式链路为：
   *   实时 devices.latest_meters ｜ 历史 fsu_data_history ｜ 字典 device_meters
   *
   * 实现（幂等 + 动态判断 + fail-fast）：
   *   1) 读 PRAGMA table_info(devices)，取**实际存在**的待删列（不假设 18 列全在）
   *   2) 一列都不存在 → 直接返回（新库 / 已迁移库；不备份、不打日志）
   *   3) 整库备份（失败即中止，绝不无备份 DROP）
   *   4) 事务内**逐列** ALTER TABLE devices DROP COLUMN（便于失败定位），
   *      任一列失败整体 ROLLBACK 并抛错
   *   5) 再次 PRAGMA table_info(devices) 校验待删列全部消失，否则抛错
   *
   * 失败策略：**fail-fast** —— 任一步失败向上抛错，database.ready reject，
   * 启动入口 process.exit(1)，进程在监听端口 / 启动 MQTT 之前退出。
   */
  private async dropLegacyDeviceColumns(): Promise<void> {
    const info = await this.query(`PRAGMA table_info(devices)`);
    const existing = new Set<string>(info.map((c: any) => String(c.name)));
    const toDrop = Database.LEGACY_DEVICE_COLUMNS.filter((c) => existing.has(c));
    if (toDrop.length === 0) return; // 全新库或已迁移过

    console.log(
      `[迁移] devices 表存在 ${toDrop.length} 个历史遗留列，准备删除: ${toDrop.join(', ')}`
    );

    // 整库备份：失败即抛错中止，绝不进入 DROP
    this.backupDatabase('before-drop-legacy-device-columns');

    await this.run('BEGIN TRANSACTION');
    try {
      // 逐列执行：便于失败时定位具体是哪一列
      for (const col of toDrop) {
        await this.run(`ALTER TABLE devices DROP COLUMN "${col}"`);
      }
      await this.run('COMMIT');
    } catch (err) {
      await this.run('ROLLBACK').catch(() => undefined);
      throw err;
    }

    // DROP 后校验：待删列必须全部消失
    const after = await this.query(`PRAGMA table_info(devices)`);
    const afterCols = new Set<string>(after.map((c: any) => String(c.name)));
    const remaining = toDrop.filter((c) => afterCols.has(c));
    if (remaining.length > 0) {
      throw new Error(`[迁移] devices 历史列删除后校验失败，仍存在: ${remaining.join(', ')}`);
    }

    console.log(
      `[迁移] 已删除 devices 历史遗留列 ${toDrop.length} 个（旧物模型测量字段 + device_name 孤儿列）`
    );
  }

  private createIndexes(): void {
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_devices_tenant_id
      ON devices(tenant_id)
    `, (err) => {
      if (err) console.error('设备tenant_id索引失败:', err.message);
    });

    // 设备按站点筛选（列表"未分配/各站点"过滤）与站点删除时解绑
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_devices_site_id
      ON devices(site_id)
    `, (err) => {
      if (err) console.error('设备site_id索引失败:', err.message);
    });

    // 站点按租户隔离查询
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_sites_tenant_id
      ON sites(tenant_id)
    `, (err) => {
      if (err) console.error('站点tenant_id索引失败:', err.message);
    });

    // 推送记录按租户查询
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_alarm_push_logs_tenant
      ON alarm_push_logs(tenant_id)
    `, (err) => {
      if (err) console.error('推送记录tenant索引失败:', err.message);
    });

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_alarms_device_id
      ON alarms(device_id)
    `, (err) => {
      if (err) console.error('告警device_id索引失败:', err.message);
    });

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_alarms_resolved
      ON alarms(resolved)
    `, (err) => {
      if (err) console.error('告警resolved索引失败:', err.message);
    });

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_alarms_created_at
      ON alarms(created_at DESC)
    `, (err) => {
      if (err) console.error('告警created_at索引失败:', err.message);
    });

    // 推送去重按 device_id+type 查最近成功记录，列表按时间倒序
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_alarm_push_logs_device_type
      ON alarm_push_logs(device_id, type)
    `, (err) => {
      if (err) console.error('推送记录device_type索引失败:', err.message);
    });

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_alarm_push_logs_created_at
      ON alarm_push_logs(created_at DESC)
    `, (err) => {
      if (err) console.error('推送记录created_at索引失败:', err.message);
    });

    // 厂家协议告警按 (device_id, serial_no) 做去重/关联查询，建索引避免全表扫描。
    // 该索引在 addAlarmProtocolColumns() 之后创建（列必须先存在）。
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_alarms_device_serial
      ON alarms(device_id, serial_no)
    `, (err) => {
      if (err) console.error('告警serial_no索引失败:', err.message);
    });
  }

  query(sql: string, params: any[] = []): Promise<any[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  get(sql: string, params: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  run(sql: string, params: any[] = []): Promise<sqlite3.RunResult> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else {
          console.log('数据库连接已关闭');
          resolve();
        }
      });
    });
  }
}

export default Database.getInstance();