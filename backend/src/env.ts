/**
 * 环境变量加载 + 运行环境识别 —— 必须是 src/index.ts 的**第一个 import**。
 *
 * 为什么单独成一个模块：
 *   ES 模块（含 TS 编译产物）的 import 会被提升到文件顶部并先于本文件的其它语句执行。
 *   因此 index.ts 里原本那句 `dotenv.config()` 其实跑在所有业务模块**之后** ——
 *   任何在模块顶层读取 process.env 的代码（utils/jwt.ts 的 JWT_SECRET、
 *   app.ts 的 STATIC_DIR）在 dotenv 执行前就已求值完毕。
 *
 *   后果：环境变量只要没有提前注入进程环境（Docker 的 env_file 会注入，
 *   但裸跑 `node dist/index.js` 时不会），这些值就会静默回退到源码里的默认值。
 *   其中 JWT_SECRET 最危险 —— 默认密钥随源码公开，等于任何人都能伪造登录令牌。
 *
 *   把 dotenv.config() 放进本模块并第一个 import，可保证它先于所有业务模块执行。
 */
import dotenv from 'dotenv';

dotenv.config();

/** 运行环境 */
export type EnvironmentMode = 'production' | 'development' | 'test';

/**
 * 识别运行环境（**fail-closed**）
 *
 *   NODE_ENV=development → development
 *   NODE_ENV=test        → test
 *   NODE_ENV=production  → production
 *   NODE_ENV 未设置 / 其它未知取值 → **按 production 处理**
 *
 * 为什么未设置按生产处理：漏配 NODE_ENV 时若默认当成开发环境，平台会带着
 * 源码里公开的默认口令启动（MQTT 直接对外可连、JWT 可直接伪造），
 * 而且没有任何提示。宁可让缺少配置的进程起不来，也不能让它带着公开凭据对外服务。
 *
 * 代价：本地开发必须显式声明 NODE_ENV=development —— 已写入 backend/.env.example，
 * 复制为 backend/.env 即可；docker-compose 里已固定 NODE_ENV=production。
 */
export function getEnvironmentMode(): EnvironmentMode {
  const raw = String(process.env.NODE_ENV ?? '').trim().toLowerCase();
  if (raw === 'development') return 'development';
  if (raw === 'test') return 'test';
  // production / 空 / 拼写错误 / 其它未知值 一律按生产处理
  return 'production';
}

/** 是否生产环境（含 NODE_ENV 未设置与未知取值） */
export function isProduction(): boolean {
  return getEnvironmentMode() === 'production';
}

/** 是否本地开发环境（需显式 NODE_ENV=development） */
export function isDevelopment(): boolean {
  return getEnvironmentMode() === 'development';
}

/** 是否自动化测试环境（需显式 NODE_ENV=test） */
export function isTest(): boolean {
  return getEnvironmentMode() === 'test';
}

/**
 * 环境变量的原始值（去空白）。空字符串与未设置同等对待 ——
 * `MQTT_PASSWORD=` 这种"配了但配成空"的写法同样视为缺失。
 */
export function readEnv(name: string): string {
  return String(process.env[name] ?? '').trim();
}
