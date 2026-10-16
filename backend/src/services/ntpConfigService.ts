/**
 * 设备校时配置与调度依赖（协议 4.8，平台→网关）
 *
 * 职责边界：
 *   - 本文件 = **持久化与配置**（devices 表的 5 个 ntp_* 列）
 *   - protocols/fsu/ntpSync.ts = **调度与发送**（上线校时 + 定时校时）
 *   - mqtt/broker.ts = **投递能力判断**（是否已连接且订阅了 sc/v1/ntp/{gwId}）
 *
 * ntpSync 通过 `initNtpSync(deps)` 注入依赖，因此协议层不反向依赖 services/mqtt。
 */
import database from '../models/database';
import embeddedBroker from '../mqtt/broker';
import {
  NTP_SYNC_DEFAULT_INTERVAL_HOURS, NTP_SYNC_INTERVAL_OPTIONS, ntpStartupGraceMs,
  isValidNtpIntervalHours,
} from '../protocols/fsu/constants';
import type { NtpSyncDeps, NtpSyncRecord, NtpSyncType } from '../protocols/fsu/ntpSync';

/** 对外展示/返回的校时配置视图 */
export interface NtpConfigView {
  /** 是否启用定时校时（上线校时不受此开关影响，始终执行） */
  enabled: boolean;
  /** 定时校时间隔（小时） */
  intervalHours: number;
  /** 最近一次校时发布时间（毫秒）；从未校时为 null */
  lastSentAt: number | null;
  /** 最近一次校时类型：online=上线校时 / scheduled=定时校时 */
  lastType: NtpSyncType | null;
  /** 下一次计划校时时间（毫秒）；尚未安排为 null */
  nextDueAt: number | null;
  /** 允许的间隔选项（供前端渲染下拉） */
  intervalOptions: readonly number[];
  /** 默认间隔（小时） */
  defaultIntervalHours: number;
}

/** 数值列 → number | null（SQLite 可能返回 null） */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default class NtpConfigService {
  /** devices 行 → 校时配置视图（列缺失/非法时回退默认值，不抛错） */
  static view(device: any): NtpConfigView {
    const rawInterval = numOrNull(device?.ntp_sync_interval_hours);
    const intervalHours = isValidNtpIntervalHours(rawInterval)
      ? Number(rawInterval)
      : NTP_SYNC_DEFAULT_INTERVAL_HOURS;
    const lastType = device?.ntp_last_type;
    return {
      // 列缺省视为启用（与迁移默认值一致）
      enabled: device?.ntp_sync_enabled === null || device?.ntp_sync_enabled === undefined
        ? true
        : Number(device.ntp_sync_enabled) === 1,
      intervalHours,
      lastSentAt: numOrNull(device?.ntp_last_sent_at),
      lastType: lastType === 'online' || lastType === 'scheduled' ? lastType : null,
      nextDueAt: numOrNull(device?.ntp_next_due_at),
      intervalOptions: NTP_SYNC_INTERVAL_OPTIONS,
      defaultIntervalHours: NTP_SYNC_DEFAULT_INTERVAL_HOURS,
    };
  }

  /**
   * 更新设备校时配置（只改传入的字段；未传的保持原值）
   * @returns ok=false 时 reason 为面向使用者的中文说明
   */
  static async update(
    deviceId: string,
    patch: { enabled?: unknown; intervalHours?: unknown },
  ): Promise<{ ok: boolean; reason?: string; view?: NtpConfigView }> {
    const sets: string[] = [];
    const params: any[] = [];

    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') {
        return { ok: false, reason: 'enabled 必须是布尔值' };
      }
      sets.push('ntp_sync_enabled = ?');
      params.push(patch.enabled ? 1 : 0);
    }

    if (patch.intervalHours !== undefined) {
      if (!isValidNtpIntervalHours(patch.intervalHours)) {
        return {
          ok: false,
          reason: `intervalHours 必须是以下之一：${NTP_SYNC_INTERVAL_OPTIONS.join(' / ')}（小时）`,
        };
      }
      sets.push('ntp_sync_interval_hours = ?');
      params.push(Number(patch.intervalHours));
      // 间隔变了 → 下一次计划时间必须按新间隔重算（否则要等旧间隔走完才生效）
      sets.push('ntp_next_due_at = ?');
      params.push(Date.now() + Number(patch.intervalHours) * 3600 * 1000);
    }

    if (sets.length === 0) {
      return { ok: false, reason: '未提供任何要修改的字段' };
    }

    params.push(deviceId);
    const r = await database.run(
      `UPDATE devices SET ${sets.join(', ')} WHERE id = ?`, params,
    );
    if (!r || (r.changes || 0) === 0) {
      return { ok: false, reason: '设备不存在' };
    }
    const rows = await database.query('SELECT * FROM devices WHERE id = ?', [deviceId]);
    return { ok: true, view: NtpConfigService.view(rows[0]) };
  }

  /** 读取设备的校时配置（不存在返回 null） */
  static async get(deviceId: string): Promise<NtpConfigView | null> {
    const rows = await database.query(
      'SELECT ntp_sync_enabled, ntp_sync_interval_hours, ntp_last_sent_at, ntp_last_type, ntp_next_due_at FROM devices WHERE id = ?',
      [deviceId],
    );
    return rows.length ? NtpConfigService.view(rows[0]) : null;
  }

  /**
   * 构造 ntpSync 所需的依赖
   *
   * `canDeliver` 复用 Broker 的判断：MQTT 已连接 **且** 订阅了 sc/v1/ntp/{gwId}。
   */
  static deps(): NtpSyncDeps {
    return {
      canDeliver: (gwId: string) => embeddedBroker.canDeliverNtp(gwId),

      getIntervalHours: async (gwId: string) => {
        const cfg = await NtpConfigService.get(gwId);
        return cfg ? cfg.intervalHours : null;
      },

      listDueScheduled: async (now: number, limit: number) => {
        // 只取：启用定时校时 + 已到点 + 设备在线（两个在线标记都必须为真）
        const rows = await database.query(
          `SELECT id, ntp_sync_interval_hours AS iv
             FROM devices
            WHERE ntp_sync_enabled = 1
              AND ntp_next_due_at IS NOT NULL
              AND ntp_next_due_at <= ?
              AND status = 'online'
              AND mqttConnected = 1
            ORDER BY ntp_next_due_at ASC
            LIMIT ?`,
          [now, limit],
        );
        return rows.map((r: any) => ({
          gwId: String(r.id),
          intervalHours: isValidNtpIntervalHours(r.iv) ? Number(r.iv) : NTP_SYNC_DEFAULT_INTERVAL_HOURS,
        }));
      },

      recordSync: async (gwId: string, rec: NtpSyncRecord) => {
        // 成功：写入最近发送时间/类型/下一次计划
        // 失败：只顺延下一次计划并留痕（requestId 不写、不改"最近成功"语义）
        if (rec.ok) {
          await database.run(
            `UPDATE devices
                SET ntp_last_sent_at = ?, ntp_last_type = ?, ntp_next_due_at = ?
              WHERE id = ?`,
            [rec.at, rec.type, rec.nextDueAt, gwId],
          );
        } else {
          await database.run(
            'UPDATE devices SET ntp_next_due_at = ? WHERE id = ?',
            [rec.nextDueAt, gwId],
          );
        }
      },

      /**
       * 启动时修正因停机而"已过期"的计划
       *
       * **不立即批量补发**：把已过期的 next_due_at 统一顺延到"启动宽限之后 + 一个间隔"，
       * 让设备重新上线时的上线校时去刷新它，避免后端一启动就向所有设备连发。
       */
      onSchedulerStart: async () => {
        const now = Date.now();
        const base = now + ntpStartupGraceMs();
        const r = await database.run(
          `UPDATE devices
              SET ntp_next_due_at = ? + ntp_sync_interval_hours * 3600000
            WHERE ntp_sync_enabled = 1
              AND ntp_next_due_at IS NOT NULL
              AND ntp_next_due_at <= ?`,
          [base, now],
        );
        const n = r?.changes || 0;
        if (n > 0) {
          console.log(`[FSU][校时] 启动恢复：${n} 台设备的定时校时计划已顺延（不立即补发）`);
        }
      },
    };
  }
}
