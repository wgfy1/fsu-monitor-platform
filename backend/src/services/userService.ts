import bcrypt from 'bcryptjs';
import database from '../models/database';
import { User, SafeUser, UserRole } from '../types';
import { signToken } from '../utils/jwt';

/**
 * 首次初始化管理员时的兜底口令（仅当 users 表为空且未配置 ADMIN_INITIAL_PASSWORD 时使用）。
 *
 * ⚠️ 安全提示：该值随源码公开，等同公开凭据。生产部署**必须**在 backend/.env 中
 *    配置 ADMIN_INITIAL_PASSWORD；未配置时 ensureDefaultAdmin 会打印醒目告警。
 *    这里刻意保留常量形式（而不是散落的字面量），便于安全检查时一眼定位。
 */
const DEFAULT_ADMIN_PASSWORD = 'admin123';

/**
 * 用户账号服务类
 * 密码仅存 bcrypt 哈希；用户名统一 trim + 小写存储（配合 UNIQUE COLLATE NOCASE 双保险）
 */
export class UserService {

  /** 用户名格式：3~32 位字母/数字/下划线 */
  private static readonly USERNAME_REGEX = /^[a-zA-Z0-9_]{3,32}$/;
  private static readonly SALT_ROUNDS = 10;
  private static readonly PASSWORD_MIN = 6;
  private static readonly PASSWORD_MAX = 64;

  /** 归一化用户名（trim + 小写） */
  private static normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
  }

  /** 校验密码长度（6~64），返回错误信息或 null */
  private static validatePassword(password: string): string | null {
    if (password.length < this.PASSWORD_MIN || password.length > this.PASSWORD_MAX) {
      return `密码长度需在 ${this.PASSWORD_MIN}~${this.PASSWORD_MAX} 位之间`;
    }
    return null;
  }

  /** 数据库行 → User（去除可能的敏感列） */
  private static toUser(row: any): User {
    return row as User;
  }

  /** User → SafeUser（剔除 password） */
  private static toSafeUser(user: User): SafeUser {
    const { password: _password, ...safe } = user;
    return safe;
  }

  /**
   * 按用户名查找（入参需已归一化）
   */
  static async findByUsername(username: string): Promise<User | null> {
    const row = await database.get('SELECT * FROM users WHERE username = ?', [username]);
    return row ? this.toUser(row) : null;
  }

  /**
   * 按 ID 查找
   */
  static async getById(id: number): Promise<User | null> {
    const row = await database.get('SELECT * FROM users WHERE id = ?', [id]);
    return row ? this.toUser(row) : null;
  }

  /**
   * 用户列表（不含密码）
   * @param tenantId 租户ID：传入时只返回该租户用户；不传（null/undefined）返回全部（平台管理员用）
   */
  static async list(tenantId?: string | null): Promise<SafeUser[]> {
    const sql = tenantId
      ? 'SELECT id, username, role, tenant_id, status, last_login_at, created_at FROM users WHERE tenant_id = ? ORDER BY id ASC'
      : 'SELECT id, username, role, tenant_id, status, last_login_at, created_at FROM users ORDER BY id ASC';
    const rows = await database.query(sql, tenantId ? [tenantId] : []);
    return rows.map((r: any) => this.toSafeUser(this.toUser(r)));
  }

  /**
   * 更换账号（修改用户名 / 密码；**不改动归属租户与角色**）
   *
   * 用于「租户管理 → 更换账号」：租户不变，只替换该租户的唯一账号。
   * 用户名与密码校验、bcrypt 加密逻辑与 createUser 保持一致。
   *
   * @throws Error('用户名已存在' / 校验失败信息)
   */
  static async replaceAccount(
    userId: number,
    params: { username: string; password?: string | null }
  ): Promise<void> {
    const username = this.normalizeUsername(params.username);
    if (!this.USERNAME_REGEX.test(username)) {
      throw new Error('用户名需为 3~32 位字母、数字或下划线');
    }

    const fields: string[] = ['username = ?'];
    const values: any[] = [username];

    if (params.password) {
      const pwdError = this.validatePassword(params.password);
      if (pwdError) throw new Error(pwdError);
      fields.push('password = ?');
      values.push(await bcrypt.hash(params.password, this.SALT_ROUNDS));
    }

    values.push(userId);
    try {
      await database.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
    } catch (error: any) {
      if (error.message && error.message.includes('UNIQUE')) {
        throw new Error('用户名已存在');
      }
      throw error;
    }
  }

  /**
   * 创建用户
   * @throws Error('用户名已存在' / 校验失败信息)
   */
  static async createUser(params: {
    username: string;
    password: string;
    role?: UserRole;
    /** 归属租户：null=平台运维账号；路由层负责约束（租户管理员强制本租户） */
    tenantId?: string | null;
  }): Promise<SafeUser> {
    const username = this.normalizeUsername(params.username);
    if (!this.USERNAME_REGEX.test(username)) {
      throw new Error('用户名需为 3~32 位字母、数字或下划线');
    }
    const pwdError = this.validatePassword(params.password);
    if (pwdError) throw new Error(pwdError);
    const role: UserRole = params.role === 'admin' ? 'admin' : 'user';

    const hash = await bcrypt.hash(params.password, this.SALT_ROUNDS);
    try {
      const result = await database.run(
        'INSERT INTO users (username, password, role, tenant_id) VALUES (?, ?, ?, ?)',
        [username, hash, role, params.tenantId ?? null]
      );
      const user = await this.getById(result.lastID);
      if (!user) throw new Error('创建用户失败');
      return this.toSafeUser(user);
    } catch (error: any) {
      if (error.message && error.message.includes('UNIQUE')) {
        throw new Error('用户名已存在');
      }
      throw error;
    }
  }

  /**
   * 更新用户（仅允许 role / status）
   */
  static async updateUser(
    id: number,
    fields: { role?: UserRole; status?: number }
  ): Promise<boolean> {
    const sets: string[] = [];
    const params: any[] = [];
    if (fields.role !== undefined) { sets.push('role = ?'); params.push(fields.role); }
    if (fields.status !== undefined) { sets.push('status = ?'); params.push(fields.status); }
    if (sets.length === 0) return false;

    params.push(id);
    const result = await database.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
    return (result.changes || 0) > 0;
  }

  /**
   * 删除用户
   */
  static async deleteUser(id: number): Promise<boolean> {
    const result = await database.run('DELETE FROM users WHERE id = ?', [id]);
    return (result.changes || 0) > 0;
  }

  /**
   * 重置密码（管理员操作）
   * @throws Error(校验失败信息)
   */
  static async resetPassword(id: number, newPassword: string): Promise<boolean> {
    const pwdError = this.validatePassword(newPassword);
    if (pwdError) throw new Error(pwdError);
    const hash = await bcrypt.hash(newPassword, this.SALT_ROUNDS);
    const result = await database.run('UPDATE users SET password = ? WHERE id = ?', [hash, id]);
    return (result.changes || 0) > 0;
  }

  /**
   * 修改自己的密码
   * @throws Error('原密码不正确' / 校验失败信息)
   */
  static async changePassword(uid: number, oldPassword: string, newPassword: string): Promise<void> {
    const user = await this.getById(uid);
    if (!user || !user.password) throw new Error('用户不存在');
    const matched = await bcrypt.compare(oldPassword, user.password);
    if (!matched) throw new Error('原密码不正确');
    const pwdError = this.validatePassword(newPassword);
    if (pwdError) throw new Error(pwdError);
    const hash = await bcrypt.hash(newPassword, this.SALT_ROUNDS);
    await database.run('UPDATE users SET password = ? WHERE id = ?', [hash, uid]);
  }

  /**
   * 登录校验
   * @returns { token, user }；用户名/密码错误或账号禁用统一返回 null（不区分原因）
   */
  static async login(username: string, password: string): Promise<{ token: string; user: SafeUser } | null> {
    const user = await this.findByUsername(this.normalizeUsername(username));
    if (!user || !user.password) return null;
    const matched = await bcrypt.compare(password, user.password);
    if (!matched || user.status !== 1) return null;

    // 更新最后登录时间（失败不阻断登录），并重读返回最新 last_login_at
    try {
      await database.run('UPDATE users SET last_login_at = ? WHERE id = ?', [Date.now(), user.id]);
    } catch (e) {
      console.warn('更新 last_login_at 失败:', e);
    }

    const token = signToken({
      uid: user.id,
      username: user.username,
      role: user.role,
      tenantId: user.tenant_id ?? null,
    });
    const fresh = await this.getById(user.id);
    return { token, user: this.toSafeUser(fresh ?? user) };
  }

  /**
   * 首次启动种子默认管理员（仅 users 表为空时生效）
   */
  static async ensureDefaultAdmin(): Promise<void> {
    const row = await database.get('SELECT COUNT(*) AS count FROM users');
    if ((row?.count || 0) > 0) return;

    const username = (process.env.ADMIN_INITIAL_USERNAME || 'admin').trim().toLowerCase();
    const fromEnv = !!process.env.ADMIN_INITIAL_PASSWORD;
    const password = process.env.ADMIN_INITIAL_PASSWORD || DEFAULT_ADMIN_PASSWORD;
    const hash = await bcrypt.hash(password, this.SALT_ROUNDS);
    // tenant_id 不指定 = NULL → 平台运维账号（可查看全部租户数据）
    await database.run(
      'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
      [username, hash, 'admin']
    );
    // 安全：绝不把口令明文写进日志 —— 日志会被采集、留存，容器日志还常被转发到第三方。
    // 这里只说明口令来源，口令本身由配置方自己掌握。
    console.log(`✓ 已创建默认管理员: ${username}（口令来源：${fromEnv ? 'ADMIN_INITIAL_PASSWORD 环境变量' : '源码内置默认值'}）`);
    if (!fromEnv) {
      console.warn(
        '⚠ 未配置 ADMIN_INITIAL_PASSWORD，已用源码中的**内置默认口令**创建管理员账号。' +
        '该口令随源码公开，任何拿到代码的人都能登录 —— ' +
        '请立即在平台内修改密码，并在 backend/.env 中配置 ADMIN_INITIAL_PASSWORD（仅首次初始化生效）。'
      );
    }
  }
}

export default UserService;
