import React from 'react';

/**
 * 设备状态类型
 */
type DeviceStatus = 'online' | 'offline' | 'warning' | 'inactive';

/**
 * 设备状态标签组件属性
 */
interface DeviceStatusTagProps {
  /** 状态 */
  status: DeviceStatus;
  /** 是否有告警 */
  hasAlarm?: boolean;
  /** 激活状态: inactive=未激活（灰色），首次 MQTT 连接后变为 active */
  activationStatus?: 'inactive' | 'active';
}

/**
 * 自定义状态标签 — 圆角矩形，带背景色和文字颜色
 * 未激活 → 灰色
 * 在线 → 绿色
 * 离线 → 红色
 * 告警 → 橙色
 */
/** 状态 → 统一状态色 class（见 styles/global.css 的 .status-tag--*） */
const STATUS_CLASS: Record<string, string> = {
  online: 'status-tag--online',
  offline: 'status-tag--error',
  warning: 'status-tag--alarm',
  inactive: 'status-tag--idle',
};

const STATUS_TEXT: Record<string, string> = {
  online: '在线',
  offline: '离线',
  warning: '告警',
  inactive: '未激活',
};

/**
 * 设备状态标签组件
 * 未激活优先于其他状态（设备创建后从未连接过 → 灰色"未激活"）
 */
const DeviceStatusTag: React.FC<DeviceStatusTagProps> = ({ status, hasAlarm, activationStatus }) => {
  // 设备未激活（从未连接过）→ 显示灰色"未激活"
  const displayStatus: DeviceStatus = activationStatus === 'inactive'
    ? 'inactive'
    : (status === 'online' && hasAlarm ? 'warning' : status);

  return (
    <span className={`status-tag ${STATUS_CLASS[displayStatus]}`}>
      {STATUS_TEXT[displayStatus]}
    </span>
  );
};

export default DeviceStatusTag;
