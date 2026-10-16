/**
 * 平台主动校时：**设备上线校时一次 + 在线期间按配置的间隔定时校时**
 *
 * 报文一律使用 4.8「平台响应」形状，由 downstream.ts 的 `ntp()` 统一构造
 * （该形状已在真实设备 00534c080213 上验证有效），本模块**不再有第二套报文构造**。
 *
 * ⚠️ 旧实现（"普通上行消息因 timestamp 过期被丢弃时触发校时"）已整体移除：
 *    本模块不再被 routeUplink 的过期分支调用，也不使用 params.timezone 形状。
 *    消息过期判定与过滤逻辑保持原样、未做任何改动。
 *
 * 分层：本模块不 import services/ 或 mqtt/，依赖由外部通过 `initNtpSync()` 注入，
 *      避免协议层反向依赖造成循环依赖（与 downstream 注入 publisher 同一手法）。
 */
import { ntp } from './downstream';
import {
  NTP_SYNC_DEFAULT_INTERVAL_HOURS, ntpSchedulerTickMs, ntpMinSendGapMs,
  ntpStartupGraceMs, NTP_ONLINE_WAIT_SUBSCRIBE_MS,
} from './constants';

/** 校时类型 */
export type NtpSyncType = 'online' | 'scheduled';

/** 一次校时的结果记录（由外部落库） */
export interface NtpSyncRecord {
  at: number;
  type: NtpSyncType;
  ok: boolean;
  /** 成功时：平台侧报文 id；失败时 null */
  requestId: string | null;
  /** 失败原因（成功时为空） */
  reason: string;
  /** 下一次计划时间（失败时按同一间隔顺延，避免无限重试） */
  nextDueAt: number;
}

/** 外部注入的依赖 */
export interface NtpSyncDeps {
  /** 该网关此刻是否"连得上"：MQTT 已连接 **且** 已订阅 sc/v1/ntp/{gwId} */
  canDeliver(gwId: string): boolean;
  /** 读取设备的校时间隔（小时）；设备不存在返回 null */
  getIntervalHours(gwId: string): Promise<number | null>;
  /** 列出**已到点**的定时校时设备（只含启用定时校时且在线的） */
  listDueScheduled(now: number, limit: number): Promise<Array<{ gwId: string; intervalHours: number }>>;
  /** 记录一次校时结果（成功/失败都记） */
  recordSync(gwId: string, rec: NtpSyncRecord): Promise<void>;
  /**
   * 调度器启动钩子：修正因停机而"已过期"的下一次计划时间。
   * **不得**在这里立即批量发送校时。
   */
  onSchedulerStart(): Promise<void>;
}

let deps: NtpSyncDeps | null = null;

/** 正在执行校时的网关（同一设备同一时刻只允许一个） */
const inFlight = new Set<string>();
/** gwId → 上一次成功提交发布的时间（最小发送间隔兜底） */
const lastSendAt = new Map<string, number>();
/** 本次上线事件已发过上线校时（断线时清除） */
const onlineSent = new Set<string>();
/** 正在等待"订阅就绪"的上线校时：gwId → 截止时刻 */
const onlinePending = new Map<string, number>();

let ticker: NodeJS.Timeout | null = null;
let startupGraceUntil = 0;
let running = false;

/** 注入依赖（由 backend 启动流程调用一次） */
export function initNtpSync(d: NtpSyncDeps): void {
  deps = d;
}

/** 读取当前配置的间隔（小时），设备不存在或依赖未就绪时回退默认值 */
async function intervalHoursOf(gwId: string): Promise<number> {
  if (!deps) return NTP_SYNC_DEFAULT_INTERVAL_HOURS;
  try {
    const v = await deps.getIntervalHours(gwId);
    return v && v > 0 ? v : NTP_SYNC_DEFAULT_INTERVAL_HOURS;
  } catch {
    return NTP_SYNC_DEFAULT_INTERVAL_HOURS;
  }
}

/**
 * 执行一次校时（上线校时与定时校时共用，只有 type 不同）
 *
 * 语义边界：这里判定的是**平台发布操作**是否成功；
 *          "发布成功" **不等于** 设备已校时（真实设备对此报文不回包）。
 */
async function sendSync(gwId: string, type: NtpSyncType): Promise<void> {
  if (!deps) {
    console.warn(`[FSU][校时] 跳过: gwId=${gwId}, reason=校时模块未初始化`);
    return;
  }
  if (inFlight.has(gwId)) {
    console.log(`[FSU][校时] 跳过: gwId=${gwId}, reason=该设备已有校时在执行`);
    return;
  }
  const now = Date.now();
  const gapMs = ntpMinSendGapMs();
  const last = lastSendAt.get(gwId) ?? 0;
  if (now - last < gapMs) {
    console.log(
      `[FSU][校时] 跳过: gwId=${gwId}, reason=距上次发送仅 ${Math.round((now - last) / 1000)}s（最小间隔 ${gapMs / 1000}s）`
    );
    return;
  }
  if (!deps.canDeliver(gwId)) {
    console.log(`[FSU][校时] 跳过: gwId=${gwId}, reason=未连接或未订阅 sc/v1/ntp/${gwId}`);
    return;
  }

  inFlight.add(gwId);
  const intervalHours = await intervalHoursOf(gwId);
  const nextDueAt = Date.now() + intervalHours * 3600 * 1000;
  try {
    const r = await ntp(gwId);
    lastSendAt.set(gwId, Date.now());
    console.log(
      `[FSU][校时] 发布成功: gwId=${gwId}, requestId=${r.id}, type=${type === 'online' ? '上线校时' : `定时校时(interval=${intervalHours}h)`}`
    );
    await deps.recordSync(gwId, {
      at: r.publishedAt, type, ok: true, requestId: r.id, reason: '', nextDueAt,
    });
  } catch (err: any) {
    const reason = err?.message || String(err);
    console.warn(`[FSU][校时] 发布失败: gwId=${gwId}, reason=${reason}`);
    // 失败不重试：直接把下一次计划按同一间隔顺延
    await deps.recordSync(gwId, {
      at: Date.now(), type, ok: false, requestId: null, reason, nextDueAt,
    }).catch(() => undefined);
  } finally {
    inFlight.delete(gwId);
  }
}

/**
 * 设备上线（login 成功）时调用
 *
 * 只标记"本次上线需要校时"，真正的发送由 `tryOnlineSync()` 在
 * **确认订阅就绪之后**执行 —— 不在 MQTT 刚连上、订阅尚未建立时抢发。
 *
 * 幂等：同一连接内重复 login（厂家固件每 ~10s 重发一次 login）不会重复触发；
 *      只有断线（`onGatewayOffline`）才会重新识别为新的上线事件。
 */
export function onGatewayOnline(gwId: string | null | undefined): void {
  if (!gwId) return;
  if (onlineSent.has(gwId) || onlinePending.has(gwId)) return;   // 本次上线已处理过
  onlinePending.set(gwId, Date.now() + NTP_ONLINE_WAIT_SUBSCRIBE_MS);
  console.log(`[FSU][校时] 设备上线校时: gwId=${gwId}（等待订阅就绪）`);
  void tryOnlineSync(gwId);
}

/** 设备断线时调用：结束本次上线事件，并清理与该连接相关的临时状态 */
export function onGatewayOffline(gwId: string | null | undefined): void {
  if (!gwId) return;
  onlineSent.delete(gwId);
  onlinePending.delete(gwId);
  // 不清 lastSendAt：它是"最小发送间隔"保护，必须跨重连保留，否则频繁重连会连发
}

/** 设备新增订阅时调用（用于尽快满足"订阅就绪"条件） */
export function onGatewaySubscribed(gwId: string | null | undefined): void {
  if (!gwId) return;
  if (onlinePending.has(gwId)) void tryOnlineSync(gwId);
}

/** 尝试执行上线校时；订阅未就绪则等到截止时刻后放弃（不反复发送） */
async function tryOnlineSync(gwId: string): Promise<void> {
  const deadline = onlinePending.get(gwId);
  if (deadline === undefined) return;
  if (!deps) {
    onlinePending.delete(gwId);
    return;
  }
  if (deps.canDeliver(gwId)) {
    onlinePending.delete(gwId);
    if (onlineSent.has(gwId)) return;
    onlineSent.add(gwId);
    await sendSync(gwId, 'online');
    return;
  }
  if (Date.now() > deadline) {
    onlinePending.delete(gwId);
    console.log(
      `[FSU][校时] 跳过: gwId=${gwId}, reason=上线后 ${NTP_ONLINE_WAIT_SUBSCRIBE_MS / 1000}s 内未建立 NTP 订阅`
    );
  }
}

/** 调度器单次扫描 */
async function tick(): Promise<void> {
  if (!deps || !running) return;
  // 1) 处理还在等待订阅的上线校时
  for (const gwId of Array.from(onlinePending.keys())) {
    await tryOnlineSync(gwId).catch(() => undefined);
  }
  // 2) 定时校时（启动宽限期内不执行，避免重启后批量补发）
  if (Date.now() < startupGraceUntil) return;
  try {
    const due = await deps.listDueScheduled(Date.now(), 50);
    for (const d of due) {
      if (inFlight.has(d.gwId)) continue;
      await sendSync(d.gwId, 'scheduled');
    }
  } catch (err: any) {
    console.error(`[FSU][校时] 定时调度扫描失败: ${err?.message || err}`);
  }
}

/**
 * 启动调度器（后端启动完成后调用一次）
 *
 * 使用**统一调度器**（单个 interval 扫描），不为每台设备各建一个永不清理的
 * setInterval；重启后依据持久化的 next_due_at 恢复调度。
 */
export async function startNtpScheduler(): Promise<void> {
  if (running) return;
  running = true;
  startupGraceUntil = Date.now() + ntpStartupGraceMs();
  if (deps) {
    // 修正因停机而过期的计划：顺延，不立即批量发送
    await deps.onSchedulerStart().catch((err) => {
      console.error(`[FSU][校时] 启动时修正计划失败: ${err?.message || err}`);
    });
  }
  ticker = setInterval(() => { void tick(); }, ntpSchedulerTickMs());
  ticker.unref?.();
  console.log(`[FSU][校时] 调度器已启动（扫描周期 ${ntpSchedulerTickMs() / 1000}s，启动宽限 ${ntpStartupGraceMs() / 1000}s）`);
}

/** 停止调度器（进程退出时调用） */
export function stopNtpScheduler(): void {
  running = false;
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

/** 供健康检查 / 测试读取的运行时状态（只读快照） */
export function ntpSyncState(): {
  running: boolean;
  inFlight: string[];
  onlineSent: string[];
  onlinePending: string[];
  lastSendAt: Record<string, number>;
} {
  return {
    running,
    inFlight: Array.from(inFlight),
    onlineSent: Array.from(onlineSent),
    onlinePending: Array.from(onlinePending.keys()),
    lastSendAt: Object.fromEntries(lastSendAt),
  };
}

/** 仅供测试：清空全部运行时状态 */
export function resetNtpSyncState(): void {
  inFlight.clear();
  lastSendAt.clear();
  onlineSent.clear();
  onlinePending.clear();
}
