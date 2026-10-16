import axios from 'axios';
import { ApiResponse, Device, Alarm, AlarmStats, PlatformConfig, User, UserRole, LoginResult, AlarmNotifyConfig, AlarmPushLog, NotifyChannel, Site, SiteStats, RegionNode, Tenant, TenantDeletePreview, RemoteGetDataResult, RemoteGetAlarmResult, RemoteSetDataResult, RemoteSetDataItem, RemoteMeterOptionsResult, NtpConfig, DeviceImportPreview, DeviceImportConfirm, SubDeviceOption } from '../types';
import { getToken, clearAuth } from '../auth';

// 创建axios实例
const apiClient = axios.create({
  baseURL: '/api',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
});

/**
 * 请求拦截器：附加登录 Token
 */
apiClient.interceptors.request.use(
  (config) => {
    const token = getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    // 只记录方法与地址：请求体可能包含钉钉 Webhook、加签密钥等敏感凭据，绝不打印
    console.log(`[API] ${config.method?.toUpperCase()} ${config.url}`);
    return config;
  },
  (error) => {
    console.error('[API] 请求错误:', error?.message || 'unknown');
    return Promise.reject(error);
  }
);

/**
 * 响应拦截器：解包 {code, data, message}；401 → 清除登录态并跳转登录页
 */
apiClient.interceptors.response.use(
  (response) => {
    // 二进制响应（如 Excel 模板下载）不是 {code,data,message} 信封，原样返回
    if (response.config.responseType === 'blob') {
      return response.data;
    }
    const { code, message } = response.data;
    if (code === 0) {
      return response.data;
    } else if (code === 401) {
      // 未登录/登录过期/账号被禁用：清除登录态并跳转登录页（登录页自身不跳转，避免打断错误提示）
      clearAuth();
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
      return Promise.reject(new Error(message || '未登录或登录已过期'));
    } else if (code === 403) {
      return Promise.reject(new Error(message || '无权限执行此操作'));
    } else {
      console.error('[API] 业务错误:', code, message);
      return Promise.reject(new Error(message || '请求失败'));
    }
  },
  async (error) => {
    // 不打印整个 error 对象：其 config.data 可能包含钉钉 Webhook 等凭据
    console.error('[API] 响应错误:', error?.message || error?.code || 'unknown');
    // 二进制请求失败时，响应体是 Blob 而不是 JSON：取出其中的业务错误文案，
    // 否则前端只能显示无意义的"请求失败"
    if (error.response?.config?.responseType === 'blob' && error.response.data instanceof Blob) {
      try {
        const text = await error.response.data.text();
        const parsed = JSON.parse(text);
        return Promise.reject(new Error(parsed?.message || '下载失败'));
      } catch {
        return Promise.reject(new Error('下载失败'));
      }
    }
    if (error.response) {
      const { status, data } = error.response;
      if (status === 401) {
        clearAuth();
        if (window.location.pathname !== '/login') {
          window.location.href = '/login';
        }
        return Promise.reject(new Error('未登录或登录已过期'));
      } else if (status === 403) {
        return Promise.reject(new Error('无权限执行此操作'));
      } else if (status === 404) {
        return Promise.reject(new Error('接口不存在'));
      } else if (status === 500) {
        return Promise.reject(new Error('服务器内部错误'));
      }
      return Promise.reject(new Error(data?.message || '请求失败'));
    } else if (error.request) {
      return Promise.reject(new Error('网络错误，请检查连接'));
    }
    return Promise.reject(error);
  }
);

/**
 * 设备API
 */
export const deviceApi = {
  /**
   * 获取设备列表
   * @param siteId 站点筛选：'unassigned'=仅未分配；数字=指定站点；不传=全部
   */
  list: (siteId?: number | 'unassigned'): Promise<ApiResponse<Device[]>> => {
    return apiClient.get('/devices', {
      params: siteId !== undefined ? { siteId } : undefined
    });
  },

  /**
   * 获取设备详情
   */
  detail: (id: string): Promise<ApiResponse<Device>> => {
    return apiClient.get(`/devices/${id}`);
  },

  /**
   * 获取厂家 FSU 原始历史数据（正式数据源：fsu_data_history）
   * 按 devId + meterId 查询，返回协议原始点；不返回任何旧物模型字段。
   * 时间单位毫秒；不传 start/end 默认最近 24 小时；limit 默认 1000 上限 5000。
   */
  fsuHistory: (id: string, params?: {
    devId?: string; meterId?: string; start?: number; end?: number; limit?: number;
  }): Promise<ApiResponse<Array<{
    devId: string; meterId: string; value: string; dataTimestamp: number; isHistory: number;
  }>>> => {
    return apiClient.get(`/devices/${id}/fsu-history`, { params });
  },

  /**
   * 创建设备（mqttPassword 不传则后端自动生成 8 位随机密码）
   */
  create: (data: {
    id: string;
    productId?: string;
    name?: string;
    imei?: string;
    iccid?: string;
    manufacturer?: string;
    terminalType?: string;
    location?: string;
    mqttPassword?: string;
    /** 归属租户（正式 tenants.id；仅平台管理员有效，留空=未分配） */
    tenantId?: string | null;
  }): Promise<ApiResponse<{ id: string; mqttUsername: string; mqttPassword: string }>> => {
    return apiClient.post('/devices', data);
  },

  /**
   * 删除设备
   */
  remove: (id: string): Promise<ApiResponse<null>> => {
    return apiClient.delete(`/devices/${id}`);
  },

  /**
   * 批量删除设备（仅管理员；权限与单删一致）
   * 后端先校验全部设备合法再整体删除，任一不合法则整体拒绝
   */
  removeBatch: (ids: string[]): Promise<ApiResponse<{ deleted: number }>> => {
    return apiClient.delete('/devices/batch', { data: { ids } });
  },

  /**
   * 修改设备归属租户（仅平台管理员；tenantId 传 null/空 = 取消分配）
   */
  updateTenant: (id: string, tenantId: string | null): Promise<ApiResponse<{ id: string; tenantId: string | null }>> => {
    return apiClient.put(`/devices/${id}/tenant`, { tenantId });
  },

  /**
   * 修改设备信息（详情页「编辑」只提交 name；其余字段保持后端既有能力）
   * 空字符串 = 清空名称（详情页显示 "-"）
   */
  update: (id: string, data: { name?: string | null }): Promise<ApiResponse<null>> => {
    return apiClient.put(`/devices/${id}`, data);
  },

  /**
   * 远程重启网关（厂家协议 4.9）
   * @param type 1-sys 2-app 3-4g 4-vpn
   */
  reboot: (id: string, type: number = 1): Promise<ApiResponse<{ code: number }>> => {
    return apiClient.post(`/devices/${id}/reboot`, { type });
  },

  /**
   * OTA 升级下发（厂家协议 4.10）
   * 只下发升级指令，固件由厂家服务器提供
   */
  ota: (id: string, urls: string[]): Promise<ApiResponse<{ code: number }>> => {
    return apiClient.post(`/devices/${id}/ota`, { urls });
  },

  /**
   * 获取实时数据（厂家协议 4.5 getData）
   * 平台主动下发给网关；网关响应后，实时数据会回写 devices.latest_meters，
   * 因此成功后重新调用 detail() 即可看到最新实时数据。
   * @param devIds 子设备列表；不传/空数组 = 该网关全部设备
   */
  remoteGetData: (id: string, devIds?: string[]): Promise<ApiResponse<RemoteGetDataResult>> => {
    return apiClient.post(`/devices/${id}/remote/get-data`, devIds ? { devIds } : {});
  },

  /**
   * 获取实时告警（厂家协议 4.6 getAlarm）
   * ⚠️ 只返回网关的实时查询结果，**不写平台告警记录**（返回体 synced=false）。
   * @param devIds 子设备列表；不传/空数组 = 该网关全部设备
   */
  remoteGetAlarm: (id: string, devIds?: string[]): Promise<ApiResponse<RemoteGetAlarmResult>> => {
    return apiClient.post(`/devices/${id}/remote/get-alarm`, devIds ? { devIds } : {});
  },

  /**
   * 设置数据（厂家协议 4.7 setData，仅管理员）
   * ⚠️ 网关返回 code=0 只代表指令已受理，不代表设备已完成设置；
   *    需要确认实际值时请再调用 remoteGetData。
   */
  remoteSetData: (id: string, items: RemoteSetDataItem[]): Promise<ApiResponse<RemoteSetDataResult>> => {
    return apiClient.post(`/devices/${id}/remote/set-data`, { items });
  },

  /**
   * 读取设备校时配置（协议 4.8）
   * ⚠️ enabled 只控制**定时**校时；上线校时不受开关影响。
   */
  ntpConfig: (id: string): Promise<ApiResponse<NtpConfig>> => {
    return apiClient.get(`/devices/${id}/ntp-config`);
  },

  /**
   * 保存设备校时配置（协议 4.8，仅管理员）
   * 修改间隔后会同时重算"下一次计划校时时间"，立即生效，无需重启后端。
   */
  updateNtpConfig: (id: string, patch: { enabled?: boolean; intervalHours?: number }): Promise<ApiResponse<NtpConfig>> => {
    return apiClient.put(`/devices/${id}/ntp-config`, patch);
  },

  /**
   * 「远程设置」候选点位（来自厂家 uploadDevInfo 字典，只读平台数据，不下发 MQTT）
   */
  remoteMeterOptions: (id: string): Promise<ApiResponse<RemoteMeterOptionsResult>> => {
    return apiClient.get(`/devices/${id}/remote/meter-options`);
  },

  /**
   * 下载 Excel 批量导入模板（xlsx 二进制）
   * 后端生成，含「设备导入」与「填写说明」两个 Sheet；
   * IMEI/ICCID/网关ID 列已预设为文本格式，避免长数字变科学计数法。
   */
  downloadImportTemplate: (): Promise<Blob> => {
    return apiClient.get('/devices/import/template', { responseType: 'blob' });
  },

  /**
   * 批量导入第一步：上传 Excel 预校验（**不写数据库**）
   */
  importPreview: (file: File): Promise<ApiResponse<DeviceImportPreview>> => {
    const form = new FormData();
    form.append('file', file);
    // 显式交给浏览器设置 multipart 边界（axios 会据此补 boundary）
    return apiClient.post('/devices/import/preview', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  /**
   * 批量导入第二步：携预校验令牌确认导入（服务端重新校验 + 单事务写入）
   */
  importConfirm: (token: string): Promise<ApiResponse<DeviceImportConfirm>> => {
    return apiClient.post('/devices/import/confirm', { token });
  }
};

/**
 * 告警API
 */
export const alarmApi = {
  /**
   * 获取告警列表
   */
  list: (params?: {
    deviceId?: string;
    resolved?: number;
    /**
     * 子设备筛选：传**设备上报的 devId**（如 1246001），按 alarms.type 精确过滤。
     * 不传 = 全部子设备。旧的 `type` 参数名仅后端保留兼容，前端一律用 devId。
     */
    devId?: string;
    limit?: number;
    offset?: number;
    /** 告警产生时间下界（秒级时间戳，含） */
    startTime?: number;
    /** 告警产生时间上界（秒级时间戳，含） */
    endTime?: number;
    /** 关键词：匹配 设备ID / 告警内容 / 设备名称（后端 SQL 全量查询，非当前页过滤） */
    search?: string;
  }): Promise<ApiResponse<{ items: Alarm[]; total: number }>> => {
    return apiClient.get('/alarms', { params });
  },

  /**
   * 告警中心的「子设备」筛选选项
   *
   * 选项来自**设备上报的点位字典**（不是从当前告警列表提取），
   * 因此某个子设备暂时没有告警时依然会出现；
   * 厂家新增功能子设备后选项自动增加，前端不维护任何分类表。
   */
  subDevices: (): Promise<ApiResponse<{
    options: SubDeviceOption[];
    conflicts: Array<{ devId: string; names: string[] }>;
  }>> => {
    return apiClient.get('/alarms/sub-devices');
  },

  /**
   * 获取告警详情
   */
  detail: (id: number): Promise<ApiResponse<Alarm>> => {
    return apiClient.get(`/alarms/${id}`);
  },

  /**
   * 解决告警
   */
  resolve: (id: number): Promise<ApiResponse<null>> => {
    return apiClient.put(`/alarms/${id}/resolve`);
  },

  /**
   * 删除单条告警
   */
  remove: (id: number): Promise<ApiResponse<null>> => {
    return apiClient.delete(`/alarms/${id}`);
  },

  /**
   * 批量删除告警
   */
  removeBatch: (ids: number[]): Promise<ApiResponse<{ deleted: number }>> => {
    return apiClient.delete('/alarms/batch', { data: { ids } });
  },

  /**
   * 获取告警统计
   */
  stats: (): Promise<ApiResponse<AlarmStats>> => {
    return apiClient.get('/alarms/stats');
  },

  /**
   * 获取告警趋势
   */
  trend: (days: number = 7): Promise<ApiResponse<any[]>> => {
    return apiClient.get('/alarms/trend', { params: { days } });
  }
};

/**
 * 健康检查API
 */
export const healthApi = {
  /**
   * 健康检查
   */
  check: (): Promise<ApiResponse<{ status: string; timestamp: number }>> => {
    return apiClient.get('/webhook/health');
  }
};

/**
 * 平台配置API
 */
export const configApi = {
  /**
   * 获取平台配置和连接状态（首页连接状态标签用）
   */
  get: (): Promise<ApiResponse<PlatformConfig>> => {
    return apiClient.get('/config');
  }
};

/**
 * 认证API
 */
export const authApi = {
  /**
   * 登录
   */
  login: (username: string, password: string): Promise<ApiResponse<LoginResult>> => {
    return apiClient.post('/auth/login', { username, password });
  },

  /**
   * 获取当前登录用户信息
   */
  me: (): Promise<ApiResponse<User>> => {
    return apiClient.get('/auth/me');
  },

  /**
   * 退出登录
   */
  logout: (): Promise<ApiResponse<null>> => {
    return apiClient.post('/auth/logout');
  },

  /**
   * 修改自己的密码
   */
  changePassword: (oldPassword: string, newPassword: string): Promise<ApiResponse<null>> => {
    return apiClient.post('/auth/change-password', { oldPassword, newPassword });
  }
};

/**
 * 用户管理API（仅管理员）
 */
export const usersApi = {
  /**
   * 用户列表
   */
  list: (): Promise<ApiResponse<User[]>> => {
    return apiClient.get('/users');
  },

  /**
   * 创建用户
   */
  create: (data: { username: string; password: string; role: UserRole; tenantId?: string }): Promise<ApiResponse<User>> => {
    return apiClient.post('/users', data);
  },

  /**
   * 编辑用户（仅 role / status）
   */
  update: (id: number, data: { role?: UserRole; status?: number }): Promise<ApiResponse<null>> => {
    return apiClient.put(`/users/${id}`, data);
  },

  /**
   * 删除用户
   */
  remove: (id: number): Promise<ApiResponse<null>> => {
    return apiClient.delete(`/users/${id}`);
  },

  /**
   * 重置密码
   */
  resetPassword: (id: number, newPassword: string): Promise<ApiResponse<null>> => {
    return apiClient.post(`/users/${id}/reset-password`, { newPassword });
  }
};

/**
 * 站点管理API（租户 → 站点 → 设备）
 * 租户隔离由后端按登录态强制，前端只负责传参
 */
export const siteApi = {
  /** 站点列表（租户账号仅返回本租户） */
  list: (): Promise<ApiResponse<Site[]>> => {
    return apiClient.get('/sites');
  },

  /** 站点统计（首页卡片） */
  stats: (): Promise<ApiResponse<SiteStats>> => {
    return apiClient.get('/sites/stats');
  },

  /** 站点详情 */
  detail: (id: number): Promise<ApiResponse<Site>> => {
    return apiClient.get(`/sites/${id}`);
  },

  /** 创建站点（tenant_id 仅平台管理员有效） */
  create: (data: {
    name: string;
    province_code?: string | null;
    city_code?: string | null;
    district_code?: string | null;
    address?: string | null;
    remark?: string | null;
    tenant_id?: string | null;
    /** 站点经纬度（选填；GCJ-02 高德坐标） */
    latitude?: number | null;
    longitude?: number | null;
  }): Promise<ApiResponse<Site>> => {
    return apiClient.post('/sites', data);
  },

  /** 更新站点 */
  update: (id: number, data: {
    name?: string;
    province_code?: string | null;
    city_code?: string | null;
    district_code?: string | null;
    address?: string | null;
    remark?: string | null;
    /** 传 null 清空坐标；不传保持原值 */
    latitude?: number | null;
    longitude?: number | null;
  }): Promise<ApiResponse<Site>> => {
    return apiClient.put(`/sites/${id}`, data);
  },

  /** 删除站点（仅删站点，设备保留并变为未分配） */
  remove: (id: number): Promise<ApiResponse<{ unboundDevices: number }>> => {
    return apiClient.delete(`/sites/${id}`);
  },

  /** 站点已关联设备ID */
  deviceIds: (id: number): Promise<ApiResponse<string[]>> => {
    return apiClient.get(`/sites/${id}/devices`);
  },

  /** 可绑定设备候选（同租户且未被其他站点占用） */
  deviceCandidates: (id: number): Promise<ApiResponse<{ id: string; name: string | null; status: string; site_id: number | null }[]>> => {
    return apiClient.get(`/sites/${id}/device-candidates`);
  },

  /** 绑定设备到站点 */
  bindDevices: (id: number, deviceIds: string[]): Promise<ApiResponse<{ bound: string[]; failed: { id: string; reason: string }[] }>> => {
    return apiClient.post(`/sites/${id}/devices`, { deviceIds });
  },

  /** 解绑设备（设备回到未分配） */
  unbindDevices: (id: number, deviceIds: string[]): Promise<ApiResponse<{ unbound: string[] }>> => {
    return apiClient.delete(`/sites/${id}/devices`, { data: { deviceIds } });
  }
};

/**
 * 全国行政区划API（省/市/区县级联，只读基础数据）
 */
export const regionApi = {
  provinces: (): Promise<ApiResponse<RegionNode[]>> => apiClient.get('/regions/provinces'),
  cities: (provinceCode: string): Promise<ApiResponse<RegionNode[]>> =>
    apiClient.get('/regions/cities', { params: { province: provinceCode } }),
  districts: (cityCode: string): Promise<ApiResponse<RegionNode[]>> =>
    apiClient.get('/regions/districts', { params: { city: cityCode } })
};

/**
 * 租户管理API（仅平台管理员）
 * 一个租户 = 一个登录账号；删除租户会连带删除该租户全部业务数据
 */
export const tenantApi = {
  /** 租户列表（含绑定账号、站点数、设备数） */
  list: (): Promise<ApiResponse<Tenant[]>> => apiClient.get('/tenants'),

  /** 未绑定账号的租户（新增用户时的归属租户下拉） */
  available: (): Promise<ApiResponse<{ id: string; name: string }[]>> => apiClient.get('/tenants/available'),

  /** 租户详情 */
  detail: (id: string): Promise<ApiResponse<Tenant>> => apiClient.get(`/tenants/${id}`),

  /** 创建租户 + 唯一账号（后端同一事务完成） */
  create: (data: {
    name: string;
    remark?: string;
    username: string;
    password: string;
  }): Promise<ApiResponse<Tenant>> => apiClient.post('/tenants', data),

  /** 更新租户（名称 / 备注 / 状态） */
  update: (id: string, data: { name?: string; remark?: string | null; status?: number }): Promise<ApiResponse<Tenant>> =>
    apiClient.put(`/tenants/${id}`, data),

  /** 更换账号（租户不变，只替换唯一账号） */
  replaceAccount: (id: string, data: { username: string; password?: string }): Promise<ApiResponse<null>> =>
    apiClient.put(`/tenants/${id}/account`, data),

  /** 删除前的数据统计（确认弹窗展示） */
  deletePreview: (id: string): Promise<ApiResponse<TenantDeletePreview>> =>
    apiClient.get(`/tenants/${id}/delete-preview`),

  /** 删除租户及其全部业务数据（事务） */
  remove: (id: string): Promise<ApiResponse<{ preview: TenantDeletePreview }>> =>
    apiClient.delete(`/tenants/${id}`)
};

/**
 * 告警推送API（仅管理员）
 * 平台管理员可通过 tenantId 查看/管理指定租户的配置；租户账号只能管理自身
 */
export const notifyApi = {
  /**
   * 获取推送配置
   */
  getConfig: (tenantId?: string | null): Promise<ApiResponse<AlarmNotifyConfig>> => {
    return apiClient.get('/notify/config', {
      params: tenantId ? { tenantId } : undefined
    });
  },

  /**
   * 保存推送配置（可传任意子集）
   */
  updateConfig: (data: Partial<AlarmNotifyConfig>, tenantId?: string | null): Promise<ApiResponse<null>> => {
    return apiClient.put('/notify/config', data, {
      params: tenantId ? { tenantId } : undefined
    });
  },

  /**
   * 发送测试推送（样例告警走真实通道）
   */
  testSend: (tenantId?: string | null): Promise<ApiResponse<{ channel: NotifyChannel; status: string; detail: string }[]>> => {
    // 请求体必须传 {}：axios 对 data=null 会 JSON.stringify 成字符串 "null" 发出，
    // 后端 body-parser 严格模式只接受对象/数组，会报
    // "Unexpected token n in JSON at position 0"（本接口不读 body，仅用 query 传租户）
    return apiClient.post('/notify/test', {}, {
      params: tenantId ? { tenantId } : undefined
    });
  },

  /**
   * 推送记录列表
   * @param all true=全部租户（仅平台管理员有效）
   */
  listLogs: (params?: { limit?: number; offset?: number; tenantId?: string | null; all?: boolean }): Promise<ApiResponse<AlarmPushLog[]>> => {
    const query: Record<string, any> = {};
    if (params?.limit !== undefined) query.limit = params.limit;
    if (params?.offset !== undefined) query.offset = params.offset;
    if (params?.tenantId) query.tenantId = params.tenantId;
    if (params?.all) query.all = 'true';
    return apiClient.get('/notify/logs', { params: query });
  },

  /** 租户列表（平台管理员配置租户推送时选择目标租户） */
  listTenants: (): Promise<ApiResponse<{ tenantId: string }[]>> => {
    return apiClient.get('/notify/tenants');
  }
};

export default apiClient;