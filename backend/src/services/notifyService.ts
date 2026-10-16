import crypto from 'crypto';
import axios from 'axios';
import database from '../models/database';
import { AlarmNotifyConfig, AlarmPushLog, NotifyChannel } from '../types';
import { AlarmRulesService } from '../utils/alarmRules';
// ⚠️ 必须从**具体模块**引入，不能从 '../protocols/fsu'（index）引入：
//    index 会连带加载 handlers → alarmService → 本文件，形成循环依赖。
//    dictionary 只依赖 models/database，mapping 是纯函数，均无环。
import { loadMeterDictionary } from '../protocols/fsu/dictionary';
import { findDevName } from '../protocols/fsu/mapping';

/**
 * 平台展示当前环境是否已接入短信供应商（预留扩展：未来接入真实供应商时设置 SMS_PROVIDER）
 */
export function isSmsProviderAvailable(): boolean {
  return !!process.env.SMS_PROVIDER;
}

/**
 * 本地时间格式化 YYYY-MM-DD HH:mm:ss（平台运行于中国时区服务器，无时区库依赖）
 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 平台内部严重程度 → 文案
 *
 * 'vendor' 是 FSU 厂家告警的占位值，含义是"**平台未定级**"：
 * 协议只给了厂家自己的 alarmLevel(1~5)，没有给出它与严重/警告的对应关系，
 * 平台不映射、也不冒充已定级，因此这里返回空串让调用方改用厂家原始级别。
 */
function severityLabel(severity: string): string {
  if (severity === 'critical') return '严重';
  if (severity === 'warning') return '警告';
  if (severity === 'vendor') return '';
  return severity;
}

/** 手机号脱敏: 138****5678 */
function maskPhone(phone: string): string {
  if (phone.length === 11) return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
  return `${phone.slice(0, 2)}****${phone.slice(-2)}`;
}

/**
 * 内存去重缓存（第一层：防同一告警并发到达的竞态）
 * key: `${deviceId}|${type}`，value: 推送成功时间戳（秒）
 * 服务重启后缓存清空，由 DB 去重记录兜底
 */
const dedupeCache = new Map<string, number>();

/** 缓存条目保留时长：超过 24 小时一律清理 */
const DEDUPE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 清理过期缓存条目（每 5 分钟执行一次，防止 Map 无限增长）
 */
function pruneDedupeCache(): void {
  const now = Date.now();
  for (const [key, ts] of dedupeCache) {
    if (now - ts * 1000 > DEDUPE_CACHE_MAX_AGE_MS) {
      dedupeCache.delete(key);
    }
  }
}
setInterval(pruneDedupeCache, 5 * 60 * 1000).unref();

/** 告警信息（触发推送的告警 + 可选的设备补充信息） */
interface NotifyAlarmInfo {
  alarmId: number | null;
  deviceId: string;
  /** FSU 告警为**厂家 devId**（平台不再翻译成自造分类）；旧物模型链路为类型名 */
  type: string;
  severity: string;
  message: string;
  action: 'alarm' | 'test';
  /**
   * 厂家原始告警级别（协议 4.4 alarmLevel，取值 1~5）
   * 有值时推送按它展示，不再使用平台 severity
   */
  alarmLevel?: number | null;
  /** 所属租户（NULL=平台级推送；决定使用哪份推送配置与推送到哪个租户） */
  tenantId?: string | null;
  /** 设备显示名（测试推送时直接指定；告警推送由 dispatch 查库补充） */
  deviceName?: string | null;
  /** 设备位置 */
  location?: string | null;
}

/** 未配置时的默认推送配置 */
const DEFAULT_CONFIG: Omit<AlarmNotifyConfig, 'id'> = {
  enabled: 0, dingtalk_enabled: 0, dingtalk_webhook: null, dingtalk_secret: null,
  sms_enabled: 0, sms_numbers: null, dedupe_minutes: 30, updated_at: 0,
};

/**
 * 告警推送服务
 * 通道：钉钉群机器人（完整可用，支持加签）；短信（预留骨架，真实供应商接入后替换 sendSms）
 * 触发：所有新告警经 AlarmService.createAlarm 统一入口异步挂接，同设备同类型在配置窗口内去重
 */
export class NotifyService {
  /**
   * 读取推送配置
   *
   * 两级配置，互相隔离：
   *  - tenantId 非空 → 该租户的配置（tenant_notify_config），租户之间互不可见
   *  - tenantId 为空 → 平台级配置（alarm_notify_config 单行 id=1），
   *                    用于平台自有设备（未分配租户）与平台管理员的默认配置
   *
   * 未配置时返回默认禁用配置（不会误推）。
   */
  static async getConfig(tenantId?: string | null): Promise<AlarmNotifyConfig> {
    try {
      if (tenantId) {
        const row = await database.get(
          'SELECT * FROM tenant_notify_config WHERE tenant_id = ?', [tenantId]
        );
        return row ? (row as AlarmNotifyConfig) : { ...DEFAULT_CONFIG };
      }
      const row = await database.get('SELECT * FROM alarm_notify_config WHERE id = 1');
      return row ? (row as AlarmNotifyConfig) : { ...DEFAULT_CONFIG };
    } catch (error) {
      console.error('读取推送配置失败:', error);
      throw error;
    }
  }

  /**
   * 保存推送配置（白名单字段、幂等 upsert 单行）
   * @param patch 仅接收已校验过的字段；未提供的字段沿用现值
   */
  static async updateConfig(patch: Partial<AlarmNotifyConfig>, tenantId?: string | null): Promise<void> {
    try {
      const current = await this.getConfig(tenantId);

      const to01 = (v: unknown): number => (v === undefined ? undefined : Number(Boolean(v))) as number;
      const enabled = to01(patch.enabled) ?? current.enabled;
      const dingtalkEnabled = to01(patch.dingtalk_enabled) ?? current.dingtalk_enabled;
      const smsEnabled = to01(patch.sms_enabled) ?? current.sms_enabled;
      const dedupeMinutes = patch.dedupe_minutes !== undefined ? Number(patch.dedupe_minutes) : current.dedupe_minutes;

      // 钉钉 Webhook URL 校验
      let webhook: string | null = patch.dingtalk_webhook !== undefined
        ? (patch.dingtalk_webhook || '').trim()
        : current.dingtalk_webhook;
      if (webhook) {
        if (!/^https?:\/\//i.test(webhook)) {
          throw new Error('钉钉 Webhook 地址必须以 http:// 或 https:// 开头');
        }
      } else {
        webhook = null;
      }
      if (dingtalkEnabled && !webhook) {
        throw new Error('开启钉钉通道需填写群机器人 Webhook 地址');
      }

      // 加签密钥可空；仅截断防超长
      let secret: string | null = patch.dingtalk_secret !== undefined
        ? (patch.dingtalk_secret || '').trim() || null
        : current.dingtalk_secret;
      if (secret && secret.length > 200) {
        throw new Error('钉钉加签密钥过长');
      }

      // 手机号：逗号/换行/分号分隔，逐段校验并归一化为逗号分隔（短信通道预留）
      let numbers: string | null = null;
      if (patch.sms_numbers !== undefined) {
        const cleaned = (patch.sms_numbers || '').split(/[,，\n;；]/).map((s) => s.trim()).filter(Boolean);
        for (const p of cleaned) {
          if (!/^1\d{10}$/.test(p)) {
            throw new Error(`手机号格式不正确: ${p}（需 1 开头 11 位）`);
          }
        }
        numbers = cleaned.length > 0 ? cleaned.join(',') : null;
      } else {
        numbers = current.sms_numbers || null;
      }
      if (smsEnabled && !numbers) {
        throw new Error('开启短信通道需至少填写一个接收手机号');
      }

      if (!Number.isInteger(dedupeMinutes) || dedupeMinutes < 1 || dedupeMinutes > 1440) {
        throw new Error('去重窗口需为 1~1440 之间的整数分钟');
      }

      const updatedAt = Date.now();
      if (tenantId) {
        await database.run(`
          INSERT INTO tenant_notify_config
            (tenant_id, enabled, dingtalk_enabled, dingtalk_webhook, dingtalk_secret, sms_enabled, sms_numbers, dedupe_minutes, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id) DO UPDATE SET
            enabled = excluded.enabled,
            dingtalk_enabled = excluded.dingtalk_enabled,
            dingtalk_webhook = excluded.dingtalk_webhook,
            dingtalk_secret = excluded.dingtalk_secret,
            sms_enabled = excluded.sms_enabled,
            sms_numbers = excluded.sms_numbers,
            dedupe_minutes = excluded.dedupe_minutes,
            updated_at = excluded.updated_at
        `, [tenantId, enabled, dingtalkEnabled, webhook, secret, smsEnabled, numbers, dedupeMinutes, updatedAt]);
      } else {
        await database.run(`
          INSERT INTO alarm_notify_config
            (id, enabled, dingtalk_enabled, dingtalk_webhook, dingtalk_secret, sms_enabled, sms_numbers, dedupe_minutes, updated_at)
          VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            enabled = excluded.enabled,
            dingtalk_enabled = excluded.dingtalk_enabled,
            dingtalk_webhook = excluded.dingtalk_webhook,
            dingtalk_secret = excluded.dingtalk_secret,
            sms_enabled = excluded.sms_enabled,
            sms_numbers = excluded.sms_numbers,
            dedupe_minutes = excluded.dedupe_minutes,
            updated_at = excluded.updated_at
        `, [enabled, dingtalkEnabled, webhook, secret, smsEnabled, numbers, dedupeMinutes, updatedAt]);
      }
      console.log(`推送配置已保存: 租户=${tenantId || '平台'}, enabled=${enabled} 钉钉=${dingtalkEnabled} 短信=${smsEnabled} 去重=${dedupeMinutes}分钟`);
    } catch (error) {
      if (error instanceof Error && /^(开启|钉钉|手机号|去重)/.test(error.message)) throw error;
      console.error('保存推送配置失败:', error);
      throw error;
    }
  }

  /**
   * 查询推送记录（最近优先）
   * @param tenantId 非空时仅返回该租户的记录；为空返回平台级记录（tenant_id IS NULL）
   *                 平台管理员可传 allTenants=true 查看全部租户记录
   */
  static async listLogs(
    limit: number = 50,
    offset: number = 0,
    tenantId?: string | null,
    allTenants: boolean = false
  ): Promise<AlarmPushLog[]> {
    try {
      if (allTenants) {
        return await database.query(
          `SELECT * FROM alarm_push_logs ORDER BY id DESC LIMIT ? OFFSET ?`,
          [limit, offset]
        );
      }
      if (tenantId) {
        return await database.query(
          `SELECT * FROM alarm_push_logs WHERE tenant_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
          [tenantId, limit, offset]
        );
      }
      return await database.query(
        `SELECT * FROM alarm_push_logs WHERE tenant_id IS NULL ORDER BY id DESC LIMIT ? OFFSET ?`,
        [limit, offset]
      );
    } catch (error) {
      console.error('查询推送记录失败:', error);
      throw error;
    }
  }

  /**
   * 新告警推送（由 AlarmService.createAlarm 异步挂接，尽力而为绝不抛到主链路）
   * @param alarmId 新告警ID
   * @param alarm 告警摘要（deviceId/type/severity/message 与 alarms 行一致）
   */
  static async pushForAlarm(alarmId: number, alarm: { deviceId: string; type: string; severity: string; message: string; alarmLevel?: number | null; serialNo?: number | null }): Promise<void> {
    try {
      // 先确定设备归属租户：用该租户自己的推送配置推送，绝不串到其他租户
      const device = await database
        .get('SELECT tenant_id FROM devices WHERE id = ?', [alarm.deviceId])
        .catch(() => null);
      const tenantId: string | null = device?.tenant_id ?? null;

      const config = await this.getConfig(tenantId);
      // 总开关关闭或所有通道关闭 → 不推送
      if (!config.enabled || (!config.dingtalk_enabled && !config.sms_enabled)) return;

      // 去重粒度 = **具体的告警**，不是"整台子设备"。
      //
      // 协议 4.4 的 serialNo 是厂家定义的告警唯一标识，同一条告警重复上报时
      // serialNo 相同 → 应去重；同一子设备下的不同点位 / 不同次告警 serialNo 不同
      // → 必须各推各的，不能互相抑制。
      // 若只按 alarm.type（现在承载的是 devId）去重，同一子设备的多个 meterId
      // 会在去重窗口内互相压制，导致漏推。
      // 无 serialNo 的非厂家告警回退用 type，保持既有行为不变。
      const hasSerial = alarm.serialNo != null && String(alarm.serialNo) !== '';
      const alarmKey = hasSerial ? `sn:${alarm.serialNo}` : `t:${alarm.type}`;
      const keyLabel = hasSerial ? `serialNo=${alarm.serialNo}` : `type=${alarm.type}`;
      const cacheKey = `${tenantId || 'platform'}|${alarm.deviceId}|${alarmKey}`;
      const cutoff = Math.floor(Date.now() / 1000) - config.dedupe_minutes * 60;

      // 第一层去重：内存缓存（防并发竞态与高频重复）——命中则直接跳过
      const cachedTs = dedupeCache.get(cacheKey);
      if (cachedTs && cachedTs >= cutoff) {
        console.log(`告警推送去重跳过(内存): 设备=${alarm.deviceId} ${keyLabel} 告警ID=${alarmId}（${config.dedupe_minutes}分钟内已推送）`);
        return;
      }

      // 第二层去重：DB 成功推送记录（服务重启后内存清空由 DB 兜底）——命中回填内存并跳过
      // 同样按租户隔离：只认本租户自己的成功记录。
      // 推送记录表没有 serial_no 列，这里用 alarm_id 关联回 alarms 取厂家 serialNo
      // （NULL 时回退用记录自身的 type），与内存层的键口径保持一致。
      const dupSql = `SELECT l.id, l.created_at FROM alarm_push_logs l
           LEFT JOIN alarms a ON a.id = l.alarm_id
          WHERE l.device_id = ? AND l.status = 'success' AND l.created_at >= ?
            AND COALESCE(CASE WHEN a.serial_no IS NULL THEN NULL ELSE 'sn:' || a.serial_no END,
                         't:' || l.type) = ?`;
      const dup = tenantId
        ? await database.get(`${dupSql} AND l.tenant_id = ? LIMIT 1`, [alarm.deviceId, cutoff, alarmKey, tenantId])
        : await database.get(`${dupSql} AND l.tenant_id IS NULL LIMIT 1`, [alarm.deviceId, cutoff, alarmKey]);
      if (dup) {
        dedupeCache.set(cacheKey, dup.created_at);
        console.log(`告警推送去重跳过(DB): 设备=${alarm.deviceId} ${keyLabel} 告警ID=${alarmId}（${config.dedupe_minutes}分钟内已推送）`);
        return;
      }

      // 通过去重后，推送前先占位写入内存缓存：同源告警并发到达时后到者直接命中第一层，杜绝竞态双发
      dedupeCache.set(cacheKey, Math.floor(Date.now() / 1000));

      const results = await this.dispatch(config, {
        alarmId, deviceId: alarm.deviceId, type: alarm.type,
        severity: alarm.severity, message: alarm.message, action: 'alarm',
        // 厂家原始级别透传给推送文案（平台 severity 对 FSU 告警只是占位）
        alarmLevel: alarm.alarmLevel ?? null,
        tenantId
      });

      // 推送结果回填：全部通道均未成功（failed/skipped）时回滚缓存占位，允许窗口内重试；
      // 至少一个通道成功则保留缓存，后续同源告警在窗口内不再推送
      const anySuccess = results.some((r) => r.status === 'success');
      if (!anySuccess) {
        dedupeCache.delete(cacheKey);
        console.log(`告警推送全部失败，已回滚去重缓存: 设备=${alarm.deviceId} 类型=${alarm.type} 告警ID=${alarmId}`);
      }
    } catch (error) {
      // 推送属尽力而为：任何异常（含配置读取失败）只记录，不影响告警落库
      console.error('告警推送失败:', error);
    }
  }

  /**
   * 发送测试推送（设置页"发送测试"按钮）
   * 使用样例告警走真实通道，不做去重；全部通道关闭时抛错
   * @returns 各通道结果 [{channel, status, detail}]，单通道失败不阻断其他通道
   */
  static async pushTest(tenantId?: string | null): Promise<{ channel: NotifyChannel; status: string; detail: string }[]> {
    const config = await this.getConfig(tenantId);
    if (!config.dingtalk_enabled && !config.sms_enabled) {
      throw new Error('请先启用至少一个推送通道');
    }
    return this.dispatch(config, {
      alarmId: null,
      deviceId: 'demo',
      deviceName: '演示站点',
      type: 'temperature',
      severity: 'critical',
      message: '测试推送：温度超限告警（请忽略）',
      action: 'test',
      tenantId
    });
  }

  /**
   * 构建钉钉 markdown 与短信文案
   */
  private static async formatContent(info: NotifyAlarmInfo): Promise<{ dingtalk: string; sms: string }> {
    // 面向用户的文案：不出现"厂家"字样，也不暴露内部枚举（如 severity='vendor'）。
    // 「级别」一律用协议 4.4 的原始 alarmLevel；缺失时按内部严重程度兜底，
    // 两者都没有则显示"未定级"。
    const levelText = info.alarmLevel != null
      ? `级别 ${info.alarmLevel}`
      : (severityLabel(info.severity) || '未定级');
    // 子设备名称：FSU 告警的 type 存的是 devId，名称取自设备上报的字典；
    // 字典查不到则回退旧物模型的类型名映射（非 FSU 链路仍在用）。
    const vendorDevName = findDevName(await loadMeterDictionary(info.deviceId), info.type);
    const typeName = vendorDevName ?? AlarmRulesService.getAlarmTypeName(info.type);
    const timeStr = formatTime(Date.now());
    const name = info.deviceName || info.deviceId;

    const dingtalk = [
      `### ${levelText}告警通知`,
      `- **级别**：${levelText}`,
      `- **设备**：${name}（${info.deviceId}）`,
      `- **子设备**：${typeName}`,
      `- **时间**：${timeStr}`,
      ...(info.location ? [`- **位置**：${info.location}`] : []),
      `- **内容**：${info.message || '无'}`,
      `---`,
      `请及时登录平台「告警中心」查看处理。`
    ].join('\n');

    const sms = `【FSU监控】${levelText}告警！设备：${name}（${info.deviceId}），${typeName}：${info.message || '无'}，时间 ${timeStr}`.slice(0, 200);

    return { dingtalk, sms };
  }

  /**
   * 按启用通道逐一发送并写推送记录
   */
  private static async dispatch(
    config: AlarmNotifyConfig,
    info: NotifyAlarmInfo
  ): Promise<{ channel: NotifyChannel; status: string; detail: string }[]> {
    const results: { channel: NotifyChannel; status: string; detail: string }[] = [];

    // 告警推送补充设备显示信息；测试推送不查库
    if (info.action === 'alarm' && info.deviceName === undefined) {
      const device = await database.get('SELECT name, location FROM devices WHERE id = ?', [info.deviceId]).catch(() => null);
      info.deviceName = device?.name ?? null;
      info.location = device?.location ?? null;
    }
    const content = await this.formatContent(info);

    // 钉钉通道
    if (config.dingtalk_enabled && config.dingtalk_webhook) {
      const tokenMatch = config.dingtalk_webhook.match(/access_token=([^&\s]+)/);
      const target = `钉钉机器人（token 尾号 ${tokenMatch ? tokenMatch[1].slice(-6) : '未知'}）`;
      try {
        await this.sendDingTalk(config.dingtalk_webhook, config.dingtalk_secret, content.dingtalk);
        await this.addLog({ ...info, channel: 'dingtalk', target, status: 'success', detail: '发送成功' });
        results.push({ channel: 'dingtalk', status: 'success', detail: '发送成功' });
      } catch (error: any) {
        const detail = error?.message || '发送失败';
        await this.addLog({ ...info, channel: 'dingtalk', target, status: 'failed', detail });
        console.error(`钉钉推送失败: ${detail}`);
        results.push({ channel: 'dingtalk', status: 'failed', detail });
      }
    }

    // 短信通道（预留：未接入真实供应商前记录跳过，接入后替换 sendSms 方法体即可）
    if (config.sms_enabled && config.sms_numbers) {
      const numbers = config.sms_numbers.split(',').filter(Boolean);
      const target = numbers.map(maskPhone).join(',');
      try {
        await this.sendSms(numbers, content.sms);
        await this.addLog({ ...info, channel: 'sms', target, status: 'success', detail: '发送成功' });
        results.push({ channel: 'sms', status: 'success', detail: '发送成功' });
      } catch (error: any) {
        const detail = error?.message || '发送失败';
        // 预留通道统一记 skipped（非真实失败），接入供应商后改为 failed
        await this.addLog({ ...info, channel: 'sms', target, status: 'skipped', detail });
        console.log(`短信通道跳过: ${detail}`);
        results.push({ channel: 'sms', status: 'skipped', detail });
      }
    }

    return results;
  }

  /**
   * 写入推送记录
   * created_at 显式传入（秒级），不依赖 DB 默认值，避免默认值未生效导致 NOT NULL 约束违反、
   * 去重记录缺失进而让去重检查永远落空
   */
  private static async addLog(
    entry: NotifyAlarmInfo & { channel: NotifyChannel; target: string; status: 'success' | 'failed' | 'skipped'; detail: string }
  ): Promise<void> {
    try {
      const result = await database.run(`
        INSERT INTO alarm_push_logs (alarm_id, action, device_id, type, severity, message, channel, target, status, detail, created_at, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        entry.alarmId,
        entry.action,
        entry.deviceId,
        entry.type,
        entry.severity,
        entry.message,
        entry.channel,
        entry.target,
        entry.status,
        entry.detail,
        Math.floor(Date.now() / 1000),
        entry.tenantId ?? null
      ]);
      console.log(`推送记录已写入: ID=${result.lastID || 0} 通道=${entry.channel} 设备=${entry.deviceId} 类型=${entry.type} 结果=${entry.status}`);
    } catch (error) {
      console.error(
        '写入推送记录失败:',
        error,
        JSON.stringify({
          alarmId: entry.alarmId, deviceId: entry.deviceId, type: entry.type,
          channel: entry.channel, status: entry.status, detail: entry.detail
        })
      );
    }
  }

  /**
   * 发送钉钉群机器人消息（markdown；支持加签）
   */
  static async sendDingTalk(webhook: string, secret: string | null, content: string): Promise<void> {
    let url = webhook;
    if (secret) {
      const timestamp = Date.now();
      const stringToSign = `${timestamp}\n${secret}`;
      const sign = encodeURIComponent(
        crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64')
      );
      url += `${webhook.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${sign}`;
    }
    // family: 4 —— 强制 IPv4。
    // 本机 DNS 会优先返回 oapi.dingtalk.com 的 AAAA 记录，而到该 IPv6 段不通：
    // Node 18 的 autoSelectFamily 默认关闭，只会尝试 DNS 第一条地址、不回落 IPv4，
    // 结果是 TCP 连接一直不完成，直到 timeout 抛 "timeout of 10000ms exceeded"。
    // 钉钉 IPv4 侧连通正常，显式指定地址族即可，不放大 timeout。
    const response = await axios.post(
      url,
      { msgtype: 'markdown', markdown: { title: 'FSU告警通知', text: content } },
      { timeout: 10000, family: 4, headers: { 'Content-Type': 'application/json' } }
    );
    const data = response.data;
    if (!data || data.errcode !== 0) {
      const msg = data?.errmsg ? `钉钉返回错误(${data.errcode}): ${data.errmsg}` : `钉钉返回异常: ${JSON.stringify(data)}`;
      throw new Error(msg);
    }
  }

  /**
   * 短信通道（预留骨架）
   * 未接入真实供应商：抛出中文说明由上层记录 skipped；接入后在本方法内调用供应商 API 即可
   */
  static async sendSms(_numbers: string[], _content: string): Promise<void> {
    throw new Error('短信通道未接入（预留，待接入供应商后启用）');
  }
}

export default NotifyService;
