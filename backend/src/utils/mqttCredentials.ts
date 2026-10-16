/**
 * MQTT 凭据与客户端标识工具
 *
 * 【安全约定】
 *  - 源码里只保留**开发默认口令**，且仅在 NODE_ENV 非 production 时生效。
 *  - 生产环境（NODE_ENV=production）必须显式配置 MQTT_PASSWORD，
 *    否则 assertMqttCredentialsConfigured() 会抛错，由 index.ts 终止启动。
 *  - broker.ts（服务端校验）与 client.ts（平台自身连接）**必须**共用本文件的
 *    resolveMqttCredentials()，任何一处单独读 process.env 都可能造成两边不一致
 *    （一边用配置值、一边用默认值 → 平台自己的客户端连不上自己的 Broker）。
 *
 * 【环境判定】统一走 ../env 的 isProduction()：只有显式 NODE_ENV=development / test
 * 才被当作非生产；未设置或未知取值一律按生产处理（fail-closed）。
 */
import { isProduction, readEnv } from '../env';

/**
 * 生成随机密码（默认 8 位）
 * 字符集排除易混淆字符（0/O、1/l/I），避免抄写错误
 *
 * 注：平台 MQTT 已改为全设备统一账号，本函数不再用于 MQTT 认证，
 * 仅保留给设备档案字段（devices.mqttPassword）做占位值。
 */
export function generateMqttPassword(length = 8): string {
  const charset = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset[bytes[i] % charset.length];
  }
  return password;
}

/**
 * 设备档案默认用户名（等于设备ID）
 *
 * 注：仅用于设备档案字段展示，平台 MQTT 认证使用全设备统一的
 * MQTT_USERNAME / MQTT_PASSWORD，该值不参与认证。
 */
export function getDefaultMqttUsername(deviceId: string): string {
  return deviceId;
}

/**
 * 平台内部 MQTT 客户端 clientId 前缀
 *
 * 重要：全平台 FSU 设备与平台内部客户端共用同一套 MQTT 账号（MQTT_USERNAME），
 * 因此**不能再用用户名区分**"平台自己发的指令"和"设备上报的数据"，
 * 否则设备上报会被整体丢弃。统一改用 clientId 前缀识别。
 * client.ts（生成）与 broker.ts（判断）必须引用本常量，避免两处不一致。
 */
export const PLATFORM_CLIENT_ID_PREFIX = 'fsu-platform-';

/**
 * 开发默认口令：**只允许在非生产环境**使用。
 *
 * 这两个值随源码公开，等同公开凭据；生产环境一旦回退到它们，
 * 任何人都能以该账号连上平台的 MQTT Broker 收发设备报文。
 * 生产环境必须通过 .env 显式配置 MQTT_USERNAME / MQTT_PASSWORD。
 */
export const DEV_DEFAULT_MQTT_USERNAME = 'platform';
export const DEV_DEFAULT_MQTT_PASSWORD = 'platform-password';

/** 兼容既有引用（语义同开发默认值，不要再当作可用凭据使用） */
export const PLATFORM_MQTT_USERNAME = DEV_DEFAULT_MQTT_USERNAME;
export const PLATFORM_MQTT_PASSWORD = DEV_DEFAULT_MQTT_PASSWORD;

export interface ResolvedMqttCredentials {
  username: string;
  password: string;
  /** true = 至少有一项回退到了源码中的开发默认值 */
  usingDevDefaults: boolean;
}

/**
 * 解析平台 MQTT 账号 —— broker.ts 与 client.ts 的唯一取值入口。
 *
 * 生产环境（含 NODE_ENV 未设置/未知）**绝不**回退到源码里的默认口令：
 * 此时若 MQTT_PASSWORD 为空会返回空串，认证必然失败 —— 宁可连不上，
 * 也不能用一把随源码公开的钥匙把 Broker 打开。
 * 正常路径下 assertMqttCredentialsConfigured() 已在启动阶段拦下这种情况。
 */
export function resolveMqttCredentials(): ResolvedMqttCredentials {
  const username = readEnv('MQTT_USERNAME') || DEV_DEFAULT_MQTT_USERNAME;
  const password = readEnv('MQTT_PASSWORD');

  if (isProduction()) {
    return { username, password, usingDevDefaults: false };
  }

  return {
    username,
    password: password || DEV_DEFAULT_MQTT_PASSWORD,
    usingDevDefaults: !readEnv('MQTT_USERNAME') || !password,
  };
}

/**
 * 生产环境 MQTT 凭据自检（fail-fast）
 *
 * 缺少 MQTT_PASSWORD 时抛错，由 index.ts 捕获后终止进程 ——
 * 绝不允许生产环境静默使用源码中的默认口令。
 *
 * @throws Error 生产环境缺失 MQTT_PASSWORD 时抛出
 */
export function assertMqttCredentialsConfigured(): void {
  if (!isProduction()) return;

  if (!readEnv('MQTT_PASSWORD')) {
    throw new Error(
      '[MQTT] 缺少必需的环境变量 MQTT_PASSWORD（当前按生产环境处理）。' +
      '出于安全考虑，生产环境不会回退到源码中的开发默认口令 —— ' +
      '请在 backend/.env 中显式配置 MQTT_PASSWORD（不要与 FSU_LOGIN_PASSWORD 复用同一个值）后重启。' +
      '若这是本地开发环境，请显式设置 NODE_ENV=development。'
    );
  }

  if (!readEnv('MQTT_USERNAME')) {
    console.warn(
      '[MQTT] ⚠ 未配置 MQTT_USERNAME，将使用默认用户名 "platform"。' +
      '用户名不是密钥，但建议在 .env 中显式声明，避免与其它 MQTT 服务混淆。'
    );
  }
}

/**
 * 非生产环境的凭据自检：只告警不终止，保证本地开发开箱可用。
 */
export function warnIfUsingDevMqttCredentials(): void {
  if (isProduction()) return;
  const { usingDevDefaults } = resolveMqttCredentials();
  if (!usingDevDefaults) return;
  console.warn(
    '[MQTT] ⚠ 未配置 MQTT_USERNAME / MQTT_PASSWORD，正在使用源码中的**开发默认口令**。' +
    '当前 NODE_ENV 为 development/test，因此仅告警不阻断；' +
    '部署到生产环境前必须显式配置，否则服务会拒绝启动。'
  );
}
