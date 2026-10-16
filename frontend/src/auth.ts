import { User } from './types';

/**
 * 登录态存取（localStorage）
 * 认证状态变更总是伴随整页跳转（登录/登出/401 重定向），无需跨组件状态同步
 */
const TOKEN_KEY = 'fsu_token';
const USER_KEY = 'fsu_user';

/** 获取 Token */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/** 获取缓存的用户信息 */
export function getStoredUser(): User | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

/** 保存登录态 */
export function setAuth(token: string, user: User): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/** 清除登录态 */
export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}
