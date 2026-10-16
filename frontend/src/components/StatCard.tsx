import React from 'react';
import { Card, Statistic } from 'antd';
import { ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons';

/**
 * 统计卡片组件属性
 */
interface StatCardProps {
  /** 标题 */
  title: string;
  /** 数值 */
  value: number | string;
  /** 前缀 */
  prefix?: React.ReactNode;
  /** 后缀 */
  suffix?: string;
  /** 趋势（可选） */
  trend?: 'up' | 'down' | 'neutral';
  /** 趋势值 */
  trendValue?: number;
  /** 颜色 */
  color?: string;
  /** 点击回调 */
  onClick?: () => void;
}

/**
 * 统计卡片组件
 */
const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  prefix,
  suffix,
  trend,
  trendValue,
  color,
  onClick
}) => {
  const renderTrend = () => {
    if (trend === 'up') {
      return (
        <span style={{ color: '#52c41a', fontSize: 12, marginLeft: 8 }}>
          <ArrowUpOutlined />
          {trendValue !== undefined && ` ${trendValue}%`}
        </span>
      );
    } else if (trend === 'down') {
      return (
        <span style={{ color: '#ff4d4f', fontSize: 12, marginLeft: 8 }}>
          <ArrowDownOutlined />
          {trendValue !== undefined && ` ${trendValue}%`}
        </span>
      );
    }
    return null;
  };

  return (
    <Card
      hoverable={!!onClick}
      onClick={onClick}
      style={{ height: '100%' }}
      bodyStyle={{ padding: '24px' }}
    >
      <Statistic
        title={title}
        value={value}
        prefix={prefix}
        suffix={suffix}
        valueStyle={{ color }}
        formatter={(value) => {
          // 如果有趋势，添加趋势图标
          return value;
        }}
      />
      {renderTrend()}
    </Card>
  );
};

export default StatCard;