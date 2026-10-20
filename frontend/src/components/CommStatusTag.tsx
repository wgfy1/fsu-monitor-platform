import React from 'react';
import { CheckCircleFilled, CloseCircleFilled, MinusCircleFilled } from '@ant-design/icons';

/**
 * 子设备通信状态
 *
 * 数据**唯一来源** = 厂家心跳报文（协议 4.2）的 params.online / params.offline，
 * 由后端 GET /api/devices/:id/sub-device-comm-status 提供。
 * 不使用最后上报时间、网关 MQTT 状态、是否存在告警等任何推断方式。
 */
export type CommStatus = 'online' | 'offline' | 'unknown';

/**
 * 后端上报值 → 展示状态
 *
 * 只认厂家明确给出的两个值；字段缺失、空值、未到达或任何非法取值
 * 一律归为 **unknown（未知）**，绝不默认成在线或离线。
 */
export function normalizeCommStatus(raw: unknown): CommStatus {
  return raw === 'online' || raw === 'offline' ? raw : 'unknown';
}

/** 状态 → 文案 / 图标 / 颜色类（沿用全站 .status-tag 配色） */
const STATUS_META: Record<CommStatus, {
  text: string;
  icon: React.ReactNode;
  className: string;
}> = {
  online: { text: '在线', icon: <CheckCircleFilled />, className: 'status-tag--online' },
  offline: { text: '离线', icon: <CloseCircleFilled />, className: 'status-tag--error' },
  unknown: { text: '未知', icon: <MinusCircleFilled />, className: 'status-tag--idle' },
};

interface CommStatusTagProps {
  /** 后端返回的状态值（缺失/非法自动显示未知） */
  status?: string | null;
  /** 附加样式（用于紧贴在标题右侧时微调间距） */
  style?: React.CSSProperties;
}

/**
 * 子设备通信状态标签：小图标 + 文字
 *
 * - 不能只靠颜色区分：始终带中文文字，并提供 aria-label / title。
 * - 纯展示组件，不触发任何告警或推送。
 */
const CommStatusTag: React.FC<CommStatusTagProps> = ({ status, style }) => {
  const key = normalizeCommStatus(status);
  const meta = STATUS_META[key];
  const label = `通信状态：${meta.text}`;

  return (
    <span
      className={`status-tag comm-status ${meta.className}`}
      style={style}
      role="status"
      aria-label={label}
      title={label}
    >
      <span className="comm-status__icon" aria-hidden="true">{meta.icon}</span>
      <span>{meta.text}</span>
    </span>
  );
};

export default CommStatusTag;
