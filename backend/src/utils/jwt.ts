import jwt from 'jsonwebtoken';
import { UserRole } from '../types';
import { isProduction, readEnv } from '../env';

/**
 * JWT 配置
 *
 * 批量导入的「预校验令牌」签名复用同一把密钥（避免多处各写一份默认值，
 * 两处不一致会让令牌永远校验失败），因此统一通过 getJwtSecret() 取值。
 */

/**
 * 开发环境专用的 JWT 默认密钥
 *
 * ⚠️ 该值随源码公开，**只允许**在 NODE_ENV=development / test 时使用。
 *    生产环境（含 NODE_ENV 未设置或未知取值）一旦缺少 JWT_SECRET，
 *    getJwtSecret() 会直接抛错，绝不回退到这里 —— 否则任何人都能用
 *    这把公开密钥伪造管理员令牌。
 */
export const DEV_DEFAULT_JWT_SECRET = 'fsu-monitor-dev-secret-change-me';

const JWT_EXPIRES_IN: jwt.SignOptions['expiresIn'] =
  (process.env.JWT_EXPIRES_IN || '7d') as jwt.SignOptions['expiresIn'];

/** 惰性缓存：首次取用时才读环境，避免模块加载顺序影响取值 */
let cachedSecret: string | null = null;

/**
 * 取 JWT 签名密钥
 *
 *  - 优先读 backend/.env 的 JWT_SECRET；
 *  - 未配置时：development / test 回退到开发默认密钥（仅告警）；
 *    **生产环境直接抛错**，不返回任何可用值。
 *
 * 用函数而不是模块顶层常量：常量在 import 时求值，一旦加载顺序有变
 * （例如 dotenv 尚未执行）就会永久固化成默认值且无从补救。
 *
 * @throws Error 生产环境缺少 JWT_SECRET 时抛出
 */
export function getJwtSecret(): string {
  if (cachedSecret !== null) return cachedSecret;

  const fromEnv = readEnv('JWT_SECRET');
  if (fromEnv) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }

  if (isProduction()) {
    throw new Error(
      '[JWT] 缺少必需的环境变量 JWT_SECRET（当前按生产环境处理）。' +
      '生产环境不会回退到源码中的开发默认密钥 —— ' +
      '请在 backend/.env 中显式配置 JWT_SECRET 后重启。' +
      '若这是本地开发环境，请显式设置 NODE_ENV=development。'
    );
  }

  cachedSecret = DEV_DEFAULT_JWT_SECRET;
  return cachedSecret;
}

/**
 * 启动自检：生产环境必须显式配置 JWT_SECRET（fail-fast）
 *
 * 与 getJwtSecret() 的分工：这里只做检查并给出**面向运维的清晰提示**，
 * 由 index.ts 捕获后终止启动；getJwtSecret() 是最后一道防线 ——
 * 即使有调用路径绕过启动检查，也不会静默使用公开密钥。
 *
 * @throws Error 生产环境缺失 JWT_SECRET 时抛出
 */
export function assertJwtSecretConfigured(): void {
  if (readEnv('JWT_SECRET')) return;

  if (isProduction()) {
    throw new Error(
      '[JWT] 缺少必需的环境变量 JWT_SECRET（当前按生产环境处理）。' +
      '生产环境不会回退到源码中的开发默认密钥（该密钥随源码公开，' +
      '一旦生效任何人都能伪造登录令牌）—— 请在 backend/.env 中显式配置 JWT_SECRET 后重启' +
      '（不要重新生成服务器上已有的密钥，否则所有已登录会话会失效）。' +
      '若这是本地开发环境，请显式设置 NODE_ENV=development。'
    );
  }

  console.warn(
    '[JWT] ⚠ 未配置 JWT_SECRET，正在使用源码中的**开发默认密钥**。' +
    '当前 NODE_ENV 为 development/test，因此仅告警不阻断；' +
    '部署到生产环境前必须显式配置，否则服务会拒绝启动。'
  );
}

/**
 * JWT 载荷
 */
export interface JwtPayload {
  uid: number;
  username: string;
  role: UserRole;
  /** 归属租户（NULL=平台运维账号，可查看全部租户数据） */
  tenantId?: string | null;
}

/**
 * 签发 Token
 */
export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: JWT_EXPIRES_IN });
}

/**
 * 校验 Token
 * @returns 载荷；过期/篡改/格式错误统一返回 null
 */
export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, getJwtSecret()) as JwtPayload;
  } catch {
    return null;
  }
}
