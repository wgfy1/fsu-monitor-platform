/**
 * 厂家协议编解码与校验（协议 3.2 报文格式）
 *
 * 职责：
 *   1. 报文大小校验（最大 2097152 字节）—— 超限直接拒绝，不进入 JSON 解析
 *   2. JSON 解析（UTF-8，只接受 object / array）
 *   3. 信封字段校验（id / timestamp / method）
 *   4. 各方法 params 结构校验
 *   5. 厂家 Demo 类型差异的**受控兼容**（协议 3.5/4.3：isFull 表格是 int、Demo 是 "0"）
 *
 * 设计约束（用户要求 §18）：只对协议中明确存在 int/string 差异的字段做兼容，
 * 不做无脑 String()。目前存在该差异的字段仅有：
 *   isFull / isHistory / alarmFlag（0|1 与 "0"|"1"）与 alarmLevel（数值）。
 */
import { MAX_PAYLOAD_BYTES, CODES } from './constants';
import {
  ParseResult, FsuEnvelope, LoginParams, HeartbeatParams,
  DataReportDevice, MeterValue, AlarmReportParams, NtpParams,
} from './types';

/** 大小校验：超过协议上限直接拒绝 */
export function checkPayloadSize(payload: Buffer): ParseResult<Buffer> {
  if (payload.length > MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      code: CODES.PARAM_ERROR,
      reason: `报文长度 ${payload.length} 超过协议上限 ${MAX_PAYLOAD_BYTES} 字节`,
    };
  }
  return { ok: true, value: payload };
}

/**
 * JSON 解析（UTF-8）
 * 只接受 JSON object / array；非法 JSON、非法结构一律拒绝，不进入业务层。
 */
export function parseJsonPayload(payload: Buffer): ParseResult<any> {
  let text: string;
  try {
    text = payload.toString('utf8');
  } catch {
    return { ok: false, code: CODES.PARAM_ERROR, reason: '报文不是合法 UTF-8' };
  }
  if (!text.trim()) {
    return { ok: false, code: CODES.PARAM_ERROR, reason: '报文为空' };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e: any) {
    return { ok: false, code: CODES.PARAM_ERROR, reason: `JSON 解析失败: ${e?.message || 'unknown'}` };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, code: CODES.PARAM_ERROR, reason: '报文必须是 JSON object 或 array' };
  }
  return { ok: true, value: parsed };
}

// ============================================================
// 字段标准化（受控兼容）
// ============================================================

/**
 * 0/1 标志位标准化：接受 0 / 1 / "0" / "1" / true / false
 * 仅用于协议中明确存在 int 与 string 两种写法的字段：isFull、isHistory、alarmFlag。
 * @returns 0 或 1；无法识别返回 null
 */
export function toFlag(raw: unknown): number | null {
  if (raw === 0 || raw === '0' || raw === false) return 0;
  if (raw === 1 || raw === '1' || raw === true) return 1;
  return null;
}

/**
 * 整数字段标准化（alarmLevel / serialNo / alarmTime / clearTime / historyTime）
 * @returns 整数；无法解析返回 null
 */
export function toInt(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Math.trunc(raw) : null;
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

/** 字符串字段标准化：只接受 string / number（协议中 id、mac、meterId 等均为 string） */
export function toStr(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return null;
}

/** 字符串数组标准化（online/offline/devId 列表） */
export function toStrArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    const s = toStr(item);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}

// ============================================================
// 信封与各方法校验
// ============================================================

/** 校验信封公共字段：id（string，必须）、timestamp（数字毫秒，必须）、method（string，必须） */
export function validateEnvelope(body: any): ParseResult<FsuEnvelope> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: CODES.PARAM_ERROR, reason: '报文不是 object' };
  }
  const id = toStr(body.id);
  if (!id) return { ok: false, code: CODES.PARAM_ERROR, reason: '缺少 id' };

  const timestamp = toInt(body.timestamp);
  if (timestamp === null) {
    return { ok: false, code: CODES.PARAM_ERROR, reason: '缺少或非法的 timestamp' };
  }

  const method = toStr(body.method);
  if (!method) return { ok: false, code: CODES.PARAM_ERROR, reason: '缺少 method' };

  return { ok: true, value: { id, timestamp, method } };
}

/** 4.1 login params 校验：version/mac/username/password 必须；upgradeVersion/hardwareVersion 可选 */
export function validateLoginParams(body: any): ParseResult<LoginParams> {
  const params = body?.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, code: CODES.PARAM_ERROR, reason: '缺少 params' };
  }
  const version = toStr(params.version);
  const mac = toStr(params.mac);
  const username = toStr(params.username);
  const password = toStr(params.password);
  const missing = [
    !version && 'version', !mac && 'mac', !username && 'username', !password && 'password',
  ].filter(Boolean);
  if (missing.length > 0) {
    return { ok: false, code: CODES.PARAM_ERROR, reason: `login 缺少必填字段: ${missing.join(', ')}` };
  }
  return {
    ok: true,
    value: {
      version: version!,
      mac: mac!,
      username: username!,
      password: password!,
      upgradeVersion: toStr(params.upgradeVersion) ?? undefined,
      hardwareVersion: toStr(params.hardwareVersion) ?? undefined,
    },
  };
}

/** 4.2 heartbeat params 校验：online/offline 必须为数组；ICCID/carrier/vpnip 可选 */
export function validateHeartbeatParams(body: any): ParseResult<HeartbeatParams> {
  const params = body?.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, code: CODES.PARAM_ERROR, reason: '缺少 params' };
  }
  const online = toStrArray(params.online);
  const offline = toStrArray(params.offline);
  if (online === null || offline === null) {
    return { ok: false, code: CODES.PARAM_ERROR, reason: 'online / offline 必须是字符串数组' };
  }
  return {
    ok: true,
    value: {
      online,
      offline,
      ICCID: toStr(params.ICCID) ?? undefined,
      carrier: toStr(params.carrier) ?? undefined,
      vpnip: toStr(params.vpnip) ?? undefined,
    },
  };
}

/**
 * 4.3 dataReport params 校验
 * params 是数组，每个元素：devId（必须）、isFull（必须，0/1 兼容）、meters（必须）
 * isHistory 协议标注必须，但 Demo 中缺省 → 缺省按 0（非历史）处理。
 * historyTime 仅在 isHistory=1 时有意义。
 */
export function validateDataReport(body: any): ParseResult<DataReportDevice[]> {
  const params = body?.params;
  if (!Array.isArray(params)) {
    return { ok: false, code: CODES.PARAM_ERROR, reason: 'dataReport 的 params 必须是数组' };
  }
  if (params.length === 0) {
    return { ok: false, code: CODES.PARAM_ERROR, reason: 'dataReport 的 params 为空数组' };
  }

  const out: DataReportDevice[] = [];
  for (let i = 0; i < params.length; i++) {
    const entry = params[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, code: CODES.PARAM_ERROR, reason: `params[${i}] 不是 object` };
    }
    const devId = toStr(entry.devId);
    if (!devId) {
      return { ok: false, code: CODES.PARAM_ERROR, reason: `params[${i}] 缺少 devId` };
    }
    // isFull：协议表格是 int，Demo 出现 "0" 字符串 → 受控兼容
    const isFull = toFlag(entry.isFull);
    if (isFull === null) {
      return { ok: false, code: CODES.PARAM_ERROR, reason: `params[${i}].isFull 非法（应为 0/1 或 "0"/"1"）` };
    }
    // isHistory：表格必须、Demo 缺省 → 缺省按 0
    const isHistoryRaw = entry.isHistory === undefined ? 0 : toFlag(entry.isHistory);
    if (isHistoryRaw === null) {
      return { ok: false, code: CODES.PARAM_ERROR, reason: `params[${i}].isHistory 非法` };
    }
    if (!Array.isArray(entry.meters)) {
      return { ok: false, code: CODES.PARAM_ERROR, reason: `params[${i}].meters 必须是数组` };
    }
    const meters: MeterValue[] = [];
    for (let j = 0; j < entry.meters.length; j++) {
      const m = entry.meters[j];
      if (!m || typeof m !== 'object') {
        return { ok: false, code: CODES.PARAM_ERROR, reason: `params[${i}].meters[${j}] 不是 object` };
      }
      const meterId = toStr(m.meterId);
      // value 协议规定 string：数字也接受并转字符串（不改变其文本表示）
      const value = toStr(m.value);
      if (!meterId || value === null) {
        return { ok: false, code: CODES.PARAM_ERROR, reason: `params[${i}].meters[${j}] 缺少 meterId 或 value` };
      }
      meters.push({ meterId, value });
    }
    const historyTime = entry.historyTime === undefined ? null : toInt(entry.historyTime);

    out.push({
      devId,
      isFull,
      isHistory: isHistoryRaw,
      historyTime: historyTime === null ? undefined : historyTime,
      meters,
    });
  }
  return { ok: true, value: out };
}

/**
 * 4.4 alarmReport params 校验
 * alarmFlag/alarmLevel/alarmTime/devId/meterId/serialNo 必须；clearTime 可选。
 * isHistory 表格标注必须但 Demo 缺省 → 缺省按 0。
 */
export function validateAlarmReport(body: any): ParseResult<AlarmReportParams> {
  const p = body?.params;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return { ok: false, code: CODES.PARAM_ERROR, reason: '缺少 params' };
  }
  const alarmFlag = toFlag(p.alarmFlag);
  if (alarmFlag === null) {
    return { ok: false, code: CODES.PARAM_ERROR, reason: 'alarmFlag 非法（应为 0/1 或 "0"/"1"）' };
  }
  const alarmLevel = toInt(p.alarmLevel);
  if (alarmLevel === null) {
    return { ok: false, code: CODES.PARAM_ERROR, reason: '缺少或非法的 alarmLevel' };
  }
  const alarmTime = toInt(p.alarmTime);
  if (alarmTime === null) {
    return { ok: false, code: CODES.PARAM_ERROR, reason: '缺少或非法的 alarmTime' };
  }
  const devId = toStr(p.devId);
  const meterId = toStr(p.meterId);
  const serialNo = toInt(p.serialNo);
  const missing = [
    !devId && 'devId', meterId === null && 'meterId', serialNo === null && 'serialNo',
  ].filter(Boolean);
  if (missing.length > 0) {
    return { ok: false, code: CODES.PARAM_ERROR, reason: `alarmReport 缺少必填字段: ${missing.join(', ')}` };
  }
  const isHistoryRaw = p.isHistory === undefined ? 0 : toFlag(p.isHistory);
  if (isHistoryRaw === null) {
    return { ok: false, code: CODES.PARAM_ERROR, reason: 'isHistory 非法' };
  }
  const clearTime = p.clearTime === undefined ? null : toInt(p.clearTime);

  return {
    ok: true,
    value: {
      alarmFlag,
      alarmLevel,
      alarmTime,
      clearTime: clearTime === null ? undefined : clearTime,
      devId: devId!,
      meterId: meterId!,
      serialNo: serialNo!,
      isHistory: isHistoryRaw,
    },
  };
}

/** 4.8 ntp params 校验：timezone 必须（GMT±HH:MM） */
export function validateNtpParams(body: any): ParseResult<NtpParams> {
  const params = body?.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, code: CODES.PARAM_ERROR, reason: '缺少 params' };
  }
  const timezone = toStr(params.timezone);
  if (!timezone) {
    return { ok: false, code: CODES.PARAM_ERROR, reason: '缺少 timezone' };
  }
  // 协议 4.8：取值范围 GMT-12:00 ~ GMT+13:00
  if (!/^GMT[+-]\d{1,2}:\d{2}$/.test(timezone)) {
    return { ok: false, code: CODES.PARAM_ERROR, reason: `timezone 格式非法: ${timezone}` };
  }
  return { ok: true, value: { timezone } };
}

/**
 * 方法名标准化（协议大小写差异兼容）
 * 上行方法名与 topic 段名一律按小写比较；
 * OTA 例外：报文体可能是 "OTA"，统一折叠为常量里的 topic 段名 'ota'。
 */
export function normalizeMethod(raw: string): string {
  const lower = String(raw).toLowerCase();
  return lower;
}
