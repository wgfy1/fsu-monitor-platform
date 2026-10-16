import { ApiResponse } from '../types';

/**
 * 统一响应格式工具类
 */
export class ResponseUtil {
  /**
   * 成功响应
   * @param data 返回数据
   * @param message 提示信息
   */
  static success<T>(data?: T, message: string = '操作成功'): ApiResponse<T> {
    return {
      code: 0,
      data: data ?? null,
      message
    };
  }

  /**
   * 失败响应
   * @param message 错误信息
   * @param code 错误码，默认1
   */
  static error(message: string = '操作失败', code: number = 1): ApiResponse {
    return {
      code,
      data: null,
      message
    };
  }

  /**
   * 参数错误响应
   * @param message 错误信息
   */
  static badRequest(message: string = '参数错误'): ApiResponse {
    return this.error(message, 400);
  }

  /**
   * 未找到响应
   * @param message 错误信息
   */
  static notFound(message: string = '资源不存在'): ApiResponse {
    return this.error(message, 404);
  }

  /**
   * 未登录/登录过期响应
   * @param message 错误信息
   */
  static unauthorized(message: string = '未登录或登录已过期'): ApiResponse {
    return this.error(message, 401);
  }

  /**
   * 无权限响应
   * @param message 错误信息
   */
  static forbidden(message: string = '无权限执行此操作'): ApiResponse {
    return this.error(message, 403);
  }

  /**
   * 服务器错误响应
   * @param message 错误信息
   */
  static serverError(message: string = '服务器内部错误'): ApiResponse {
    return this.error(message, 500);
  }
}

/**
 * Express响应扩展接口
 */
declare global {
  namespace Express {
    interface Response {
      sendSuccess: <T>(data?: T, message?: string) => void;
      sendError: (message?: string, code?: number) => void;
      sendBadRequest: (message?: string) => void;
      sendNotFound: (message?: string) => void;
      sendUnauthorized: (message?: string) => void;
      sendForbidden: (message?: string) => void;
      sendServerError: (message?: string) => void;
    }
  }
}

/**
 * 中间件：注册响应扩展方法
 */
export function responseMiddleware(_req: any, res: any, next: any) {
  res.sendSuccess = function <T>(data?: T, message?: string) {
    this.json(ResponseUtil.success(data, message));
  };

  res.sendError = function (message?: string, code?: number) {
    this.json(ResponseUtil.error(message, code));
  };

  res.sendBadRequest = function (message?: string) {
    this.json(ResponseUtil.badRequest(message));
  };

  res.sendNotFound = function (message?: string) {
    this.json(ResponseUtil.notFound(message));
  };

  res.sendUnauthorized = function (message?: string) {
    this.json(ResponseUtil.unauthorized(message));
  };

  res.sendForbidden = function (message?: string) {
    this.json(ResponseUtil.forbidden(message));
  };

  res.sendServerError = function (message?: string) {
    this.json(ResponseUtil.serverError(message));
  };

  next();
}