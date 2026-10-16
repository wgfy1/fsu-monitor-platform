// ⚠️ 必须第一行：先把 .env 加载进 process.env，再加载任何业务模块。
// 否则模块顶层读取的环境变量（JWT_SECRET / STATIC_DIR 等）会拿到 undefined 并
// 永久回退到源码里的默认值，即使 .env 里已经配置。详见 src/env.ts。
import './env';
import database from './models/database';
import { createApp } from './app';
import mqttClient from './mqtt/client';
import embeddedBroker from './mqtt/broker';
import DeviceService from './services/deviceService';
import UserService from './services/userService';
import DataService from './services/dataService';
import AlarmService from './services/alarmService';
import { warnIfLoginAuthUnconfigured } from './protocols/fsu/constants';
import {
  assertMqttCredentialsConfigured,
  warnIfUsingDevMqttCredentials,
} from './utils/mqttCredentials';
import { assertJwtSecretConfigured } from './utils/jwt';
import { getEnvironmentMode } from './env';
// 平台主动校时（协议 4.8）：依赖注入 + 统一调度器
import { initNtpSync, startNtpScheduler, stopNtpScheduler } from './protocols/fsu';
import NtpConfigService from './services/ntpConfigService';

const PORT = process.env.PORT || 3001;
const CONNECT_MODE = process.env.CONNECT_MODE || 'mqtt'; // 正式只有 mqtt（历史取值已废弃）
const EMBEDDED_BROKER = process.env.EMBEDDED_BROKER !== 'false'; // 默认启用内置 Broker
// 离线判定阈值（分钟）：超过该时长无数据上报 → 设备标记为离线
const OFFLINE_THRESHOLD_MIN = Number(process.env.OFFLINE_THRESHOLD) || 10;
// 心跳超时离线阈值（分钟）：厂家设备心跳（20 秒一次）超过该时长未更新 → 离线，
// 用于断电/断网快速感知（默认 3 分钟，比数据上报阈值快得多）
const HEARTBEAT_OFFLINE_MIN = Number(process.env.HEARTBEAT_OFFLINE_MIN) || 3;
const OFFLINE_SWEEP_INTERVAL_MS = 60 * 1000; // 每分钟扫描一次

// ============================================================
// 每日数据清理配置
// ============================================================
// 数据保留天数：超过该天数的历史数据与已解决告警会被删除（默认 30 天）
const DATA_RETENTION_DAYS = Number(process.env.DATA_RETENTION_DAYS) || 30;
// 每日清理时间 HH:MM（24 小时制）。设备 5 秒级上报无真正低峰，
// 但 SQLite 大批量 DELETE 会短暂占用写锁，选凌晨执行影响最小。
// 非法配置回退到 03:30。
const [cleanupHourRaw, cleanupMinuteRaw] = (process.env.DATA_CLEANUP_TIME || '03:30').split(':').map(Number);
const CLEANUP_TIME_VALID =
  Number.isInteger(cleanupHourRaw) && cleanupHourRaw >= 0 && cleanupHourRaw <= 23 &&
  Number.isInteger(cleanupMinuteRaw) && cleanupMinuteRaw >= 0 && cleanupMinuteRaw <= 59;
const DATA_CLEANUP_HOUR = CLEANUP_TIME_VALID ? cleanupHourRaw : 3;
const DATA_CLEANUP_MINUTE = CLEANUP_TIME_VALID ? cleanupMinuteRaw : 30;

/**
 * 计算距离下一个 HH:MM 的毫秒数（今天已过则顺延到明天）
 */
function msUntilNextTime(): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(DATA_CLEANUP_HOUR, DATA_CLEANUP_MINUTE, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

const app = createApp();

// ============================================================
// 根据 CONNECT_MODE 启动对应的接入方式
// ============================================================
async function startServices(): Promise<void> {
  // ── fail-fast：密钥自检（MQTT / JWT） ──
  // 环境判定见 src/env.ts：只有显式 NODE_ENV=development / test 才算非生产，
  // **未设置或未知取值一律按生产处理**（fail-closed）。
  // 生产环境缺少 MQTT_PASSWORD 或 JWT_SECRET 时打印明确错误并终止启动 ——
  // 绝不静默回退到源码里公开的默认值（那等于把 Broker 口令与令牌签名密钥
  // 连同源码一起公开）。非生产环境只告警，保证本地开发开箱可用。
  try {
    assertMqttCredentialsConfigured();
    assertJwtSecretConfigured();
    warnIfUsingDevMqttCredentials();
  } catch (err: any) {
    console.error(err?.message || err);
    console.error(
      `启动自检未通过（运行环境：${getEnvironmentMode()}），服务终止启动` +
      '（不会监听端口，也不会启动 MQTT / API）'
    );
    process.exit(1);
  }

  // ── fail-fast：数据库迁移必须全部成功，才允许对外提供服务 ──
  // 迁移失败 → 打印详细错误 → 退出进程（不监听端口、不启动 MQTT / FSU / API）
  try {
    await database.ready;
  } catch (err) {
    console.error('数据库迁移失败:', err);
    console.error('数据库结构不完整，服务终止启动（不会监听端口，也不会启动 MQTT / API）');
    process.exit(1);
  }

  // 首次启动种子默认管理员（users 表为空时）
  await UserService.ensureDefaultAdmin();

  // FSU login 认证配置自检：未配置时打印醒目告警（不阻断启动，但所有网关 login 都会 code=1）
  warnIfLoginAuthUnconfigured();

  // 启动 HTTP 服务器
  app.listen(PORT, () => {
    console.log('=================================');
    console.log('FSU设备监控平台后端服务启动成功');
    console.log('=================================');
    console.log(`服务地址: http://localhost:${PORT}`);
    console.log(`运行环境: ${getEnvironmentMode()}（由 NODE_ENV 决定，未设置按 production 处理）`);
    console.log('接入模式: mqtt（厂家 FSU 协议）');
    const host = process.env.MQTT_BROKER_HOST || 'localhost';
    const port = process.env.MQTT_BROKER_PORT || '1883';
    console.log(`[MQTT] Broker: mqtt://${host}:${port}${EMBEDDED_BROKER ? '（内置）' : '（外部）'}`);
    console.log('=================================');
  });

  // MQTT 是唯一正式接入方式，始终启动
  if (CONNECT_MODE !== 'mqtt') {
    console.warn(`[MQTT] CONNECT_MODE="${CONNECT_MODE}" 为已废弃取值（旧协议已下线），按 mqtt 模式启动`);
  }
  {
    // 先启动内置 Broker（若启用），失败则回退到外部 Broker
    if (EMBEDDED_BROKER) {
      try {
        await embeddedBroker.start();
      } catch (err: any) {
        console.error('[MQTT] 内置 Broker 启动失败:', err.message);
        // 关键：端口被占用（如外部 Mosquitto）时降级为外部模式，
        // 让平台客户端订阅业务 Topic 兜底接收，避免消息全部丢失
        process.env.EMBEDDED_BROKER = 'false';
        console.log('[MQTT] 已降级为外部 Broker 模式，平台客户端将订阅消息兜底...');
      }
    }
    try {
      await mqttClient.connect();
      console.log('[MQTT] MQTT 服务启动成功');
    } catch (err: any) {
      console.error('[MQTT] MQTT 连接失败:', err.message);
      console.log('[MQTT] 将在后台自动重连...');
    }
  }

  // 超时离线扫描：超过 OFFLINE_THRESHOLD 分钟无数据上报的设备标记为离线
  // （排除当前 MQTT 连接中的设备，避免误杀连接正常但暂未上报的设备）
  const offlineSweep = setInterval(async () => {
    const thresholdTs = Date.now() - OFFLINE_THRESHOLD_MIN * 60 * 1000;
    await DeviceService.markStaleDevicesOffline(thresholdTs, embeddedBroker.connectedDevices);
    // 断电/断网快速感知：心跳超时（默认 3 分钟）→ 离线
    const hbThresholdTs = Date.now() - HEARTBEAT_OFFLINE_MIN * 60 * 1000;
    await DeviceService.markStaleHeartbeatOffline(hbThresholdTs);
  }, OFFLINE_SWEEP_INTERVAL_MS);
  console.log(`超时离线扫描已启动: 数据阈值 ${OFFLINE_THRESHOLD_MIN} 分钟, 心跳阈值 ${HEARTBEAT_OFFLINE_MIN} 分钟, 每 60 秒检查一次`);

  // 每日数据清理：删除超过 DATA_RETENTION_DAYS 天的历史数据与已解决告警。
  // setTimeout 自续调（比 setInterval 防漂移更省事）：执行完毕后排下一次，
  // 失败也照常续调，保证清理不会因一次异常而永久停止。
  let cleanupTimer: ReturnType<typeof setTimeout>;
  const scheduleDailyCleanup = () => {
    cleanupTimer = setTimeout(async () => {
      try {
        const start = Date.now();
        const fsuCount = await DataService.cleanOldFsuData(DATA_RETENTION_DAYS);
        const alarmCount = await AlarmService.cleanOldResolvedAlarms(DATA_RETENTION_DAYS);
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`每日数据清理完成: FSU历史 ${fsuCount} 条, 已解决告警 ${alarmCount} 条, 耗时 ${elapsed}s`);
      } catch (err) {
        console.error('每日数据清理失败:', err);
      }
      scheduleDailyCleanup(); // 无论成败都排下一次
    }, msUntilNextTime());
  };
  scheduleDailyCleanup();
  console.log(`每日数据清理已启动: 保留 ${DATA_RETENTION_DAYS} 天, 每天 ${String(DATA_CLEANUP_HOUR).padStart(2, '0')}:${String(DATA_CLEANUP_MINUTE).padStart(2, '0')} 执行`);

  // 平台主动校时（协议 4.8）：注入依赖并启动统一调度器
  //   - 依赖注入后协议层才能判断"投得出去"、读写设备校时配置
  //   - 调度器基于持久化的 ntp_next_due_at 恢复；启动宽限期内不执行定时校时，
  //     且会把因停机而过期的计划顺延，**不会重启后批量补发**
  initNtpSync(NtpConfigService.deps());
  await startNtpScheduler();

  // 优雅退出
  const gracefulShutdown = async () => {
    clearInterval(offlineSweep);
    clearTimeout(cleanupTimer);
    stopNtpScheduler();
    console.log('正在关闭服务...');
    if (mqttClient.isConnected) {
      await mqttClient.disconnect();
    }
    if (embeddedBroker.isListening) {
      await embeddedBroker.stop();
    }
    process.exit(0);
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}

startServices().catch((err) => {
  console.error('服务启动失败:', err);
  process.exit(1);
});
