import React from 'react';

/**
 * 无数据占位符 — 灰色 "-"
 * 用于未激活设备（所有字段无数据）或字段确实为空的情况
 */
export const NoData: React.FC = () => (
  <span style={{ color: '#999', fontSize: 14 }}>-</span>
);

/**
 * 数值显示格式 — 值为24px bold #333，单位为14px normal #999
 * 例：<ValueUnit value={24.5} unit="V" />
 *     <ValueUnit value={12.3} unit="°C" />
 */
interface ValueUnitProps {
  value: number | string | null | undefined;
  unit?: string;
  /** 小数位数（仅在 value 是 number 时有效） */
  decimals?: number;
  /** 智能小数位：<1 时显示 3 位，>=1 时使用 decimals（默认 1 位） */
  smartDecimals?: boolean;
  /** 高亮阈值：超过此值的数值将显示指定颜色 */
  threshold?: number;
  /** 高亮颜色（配合 threshold 使用） */
  highlightColor?: string;
}

export const ValueUnit: React.FC<ValueUnitProps> = ({ value, unit, decimals, smartDecimals, threshold, highlightColor }) => {
  if (value == null) return <span style={{ color: '#999', fontSize: 14 }}>-</span>;

  const isNumber = typeof value === 'number';
  let displayValue: string;
  if (isNumber) {
    if (smartDecimals && value < 1) {
      displayValue = value.toFixed(3);
    } else if (smartDecimals) {
      displayValue = value.toFixed(decimals ?? 1);
    } else {
      displayValue = decimals != null ? value.toFixed(decimals) : String(value);
    }
  } else {
    displayValue = String(value);
  }
  const exceeded = isNumber && threshold != null && value > threshold;
  const color = exceeded && highlightColor ? highlightColor : '#333';

  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 2 }}>
      <span style={{ fontSize: 24, fontWeight: 'bold', color, lineHeight: 1.2 }}>
        {displayValue}
      </span>
      {unit && (
        <span style={{ fontSize: 14, fontWeight: 'normal', color: '#999', marginLeft: 1 }}>
          {unit}
        </span>
      )}
    </span>
  );
};

/**
 * 市电状态标签（3态：正常/停电/告警）
 * power_outage_sensor: 0=市电正常, 1=市电停电, 2=市电故障
 */
interface PowerTagProps {
  status: number;
}

export const PowerTag: React.FC<PowerTagProps> = ({ status }) => {
  const config: Record<number, { text: string; bg: string; color: string }> = {
    0: { text: '正常', bg: '#e6ffed', color: '#389e0d' },
    1: { text: '停电', bg: '#fff1f0', color: '#cf1322' },
    2: { text: '故障', bg: '#fff7e6', color: '#d46b08' },
  };
  const { text, bg, color } = config[status] || { text: `未知(${status})`, bg: '#f5f5f5', color: '#999' };

  return (
    <span
      style={{
        display: 'inline-block',
        borderRadius: 4,
        padding: '2px 8px',
        fontSize: 13,
        fontWeight: 500,
        lineHeight: '22px',
        backgroundColor: bg,
        color,
      }}
    >
      {text}
    </span>
  );
};

/**
 * 圆角状态标签（非 Ant Design Tag）
 * green=true → 绿色背景 + 绿色文字；green=false → 红色背景 + 红色文字
 */
interface PillTagProps {
  green: boolean;
  text: string;
}

export const PillTag: React.FC<PillTagProps> = ({ green, text }) => (
  <span className={`status-tag ${green ? 'status-tag--online' : 'status-tag--error'}`}>
    {text}
  </span>
);