import React, { useState, useEffect, useCallback } from 'react';
import { Radio, Select, Space, Empty, Spin, Table } from 'antd';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from 'recharts';
import { deviceApi } from '../services/api';
import { buildChartTicks, formatTickLabel, formatTimestamp, CHART_RANGE_MS, ChartRange } from '../utils/date';
import {
  BATTERY_METERS, AC_METERS, DC_METERS, MODULE_METERS, ENV_METERS,
  getCellVoltageMeterIds,
} from '../utils/meterMapping';

/**
 * 厂家 FSU 子设备历史数据（曲线 + 明细表）
 *
 * 数据源：GET /api/devices/:id/fsu-history（fsu_data_history 表）
 * 只按 **厂家 devId + meterId** 取数，不经过任何旧物模型字段，
 * 不读取 device_data（旧 /history 接口本组件完全不调用）。
 *
 * 子设备由调用方（设备详情页对应的「详情」入口）确定，组件内不再提供子设备下拉。
 */

type Range = ChartRange;

const COLOR_PALETTE = ['#1890ff', '#52c41a', '#faad14', '#722ed1', '#13c2c2',
  '#eb2f96', '#fa541c', '#2f54eb', '#a0d911', '#08979c'];

/** 时间窗长度统一由 utils/date 提供（与刻度生成共用同一份定义） */
const RANGE_MS = CHART_RANGE_MS;

/** 历史数据单页条数（明细按时间倒序，最新在前） */
const TABLE_PAGE_SIZE = 10;

/**
 * 各子设备的曲线配置：直接使用厂家真实 meterId
 * （来自 meterMapping 的既有映射，不新建第二套厂家字典）
 */
export const SUB_DEVICE_SERIES: Array<{
  key: string;
  label: string;
  devId: string;
  meters: Array<{ meterId: string; label: string }>;
}> = [
  {
    key: 'battery', label: '电池', devId: '1061001',
    meters: [
      ...Object.entries(BATTERY_METERS).map(([meterId, label]) => ({ meterId, label })),
      ...getCellVoltageMeterIds().map((meterId, i) => ({ meterId, label: `单体${i + 1}` })),
    ],
  },
  {
    key: 'ac', label: '交流', devId: '1064001',
    meters: [
      ...Object.entries(AC_METERS).map(([meterId, label]) => ({ meterId, label })),
      ...Object.entries(MODULE_METERS).map(([meterId, label]) => ({ meterId, label })),
    ],
  },
  {
    key: 'dc', label: '直流', devId: '2060001',
    meters: Object.entries(DC_METERS).map(([meterId, label]) => ({ meterId, label })),
  },
  {
    key: 'env', label: '温湿度', devId: '1120001',
    meters: Object.entries(ENV_METERS).map(([meterId, label]) => ({ meterId, label })),
  },
  {
    key: 'door', label: '门磁', devId: '1246001',
    meters: [{ meterId: '13160016001', label: '门磁状态' }],
  },
];

/** 卡片内分区小标题（与设备详情页保持同一视觉风格） */
const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 15, fontWeight: 600, color: '#333', margin: '4px 0 10px' }}>{children}</div>
);

interface HistoryChartProps {
  /** 网关设备ID（平台设备 = gwId） */
  deviceId: string;
  /** 子设备 key：battery / ac / dc / env / door（由打开详情的入口确定） */
  subDevice: string;
}

const HistoryChart: React.FC<HistoryChartProps> = ({ deviceId, subDevice }) => {
  const [range, setRange] = useState<Range>('24h');
  const [loading, setLoading] = useState(false);
  const [points, setPoints] = useState<Array<{ devId: string; meterId: string; value: string; dataTimestamp: number }>>([]);
  /**
   * 当前查询窗口 [start, end]（毫秒）
   * 用于给 X 轴设定**固定的时间轴范围**——X 轴是参考刻度，与数据点解耦：
   * 无论这段时间内有多少个数据点，横轴始终完整覆盖所选窗口。
   */
  const [win, setWin] = useState<{ start: number; end: number }>({ start: 0, end: 0 });

  const current = SUB_DEVICE_SERIES.find((d) => d.key === subDevice) || SUB_DEVICE_SERIES[0];
  // 默认只画前 3 条（如电池的 总电压/电流/温度）；单体等其它点由用户按需勾选，避免 16 条线挤在一起
  const [selected, setSelected] = useState<string[]>([]);

  // 进入某个子设备详情（或切换子设备）时重置勾选：默认前 3 条
  useEffect(() => {
    setSelected(current.meters.slice(0, 3).map((m) => m.meterId));
  }, [current.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    setLoading(true);
    const end = Date.now();
    const start = end - RANGE_MS[range];
    setWin({ start, end });
    try {
      const res = await deviceApi.fsuHistory(deviceId, {
        devId: current.devId,
        start,
        end,
        limit: 5000,
      });
      setPoints(res.data || []);
    } catch {
      setPoints([]);
    } finally {
      setLoading(false);
    }
  }, [deviceId, range, current.devId]);

  useEffect(() => { load(); }, [load]);

  // 按 dataTimestamp 聚合为曲线数据：{ time, [meterId]: number }
  const byTime = new Map<number, Record<string, number | undefined>>();
  for (const p of points) {
    const n = Number(p.value);
    if (!Number.isFinite(n)) continue;   // 非数值点（如状态字符串）不绘图
    if (!byTime.has(p.dataTimestamp)) byTime.set(p.dataTimestamp, {});
    byTime.get(p.dataTimestamp)![p.meterId] = n;
  }
  // 曲线数据：**按真实 dataTimestamp 定位**（不做任何按天汇总/取整），
  // X 轴刻度另由 buildChartTicks 独立生成，二者互不影响。
  const chartData = [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, vals]) => ({ dataTimestamp: ts, ...vals }));

  // X 轴参考刻度：落在自然边界（整点 / 本地零点），数量控制在 6~8 个
  const xTicks = buildChartTicks(win.start, win.end, range);

  const series = current.meters
    .filter((m) => selected.includes(m.meterId))
    .map((m, i) => ({ ...m, color: COLOR_PALETTE[i % COLOR_PALETTE.length] }));

  // 明细表：只显示上方**已勾选**的测点（按 meterId 精确匹配，与曲线口径一致），时间倒序（最新在前）；
  // 测量点名称按本子设备的 meterId 映射
  const labelOf = new Map(current.meters.map((m) => [m.meterId, m.label]));
  const rows = [...points]
    .filter((p) => selected.includes(p.meterId))
    .sort((a, b) => b.dataTimestamp - a.dataTimestamp)
    .map((p, i) => ({ key: `${p.meterId}-${p.dataTimestamp}-${i}`, ...p }));

  return (
    <>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          size="small"
          mode="multiple"
          style={{ minWidth: 320, maxWidth: 620 }}
          placeholder="选择测量点"
          value={selected}
          onChange={setSelected}
          maxTagCount="responsive"
          options={current.meters.map((m) => ({ value: m.meterId, label: m.label }))}
        />
        <Radio.Group value={range} onChange={(e) => setRange(e.target.value)} size="small">
          <Radio.Button value="24h">24小时</Radio.Button>
          <Radio.Button value="7d">7天</Radio.Button>
          <Radio.Button value="30d">30天</Radio.Button>
        </Radio.Group>
      </Space>

      <SectionTitle>历史数据曲线</SectionTitle>
      {chartData.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 0' }}>
          {loading ? <Spin /> : <Empty description="暂无历史数据" />}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            {/* X 轴为**数值时间轴**：数据点按真实 dataTimestamp 定位，
                刻度由 xTicks 独立给出（与数据点解耦，疏化到 6~8 个） */}
            <XAxis
              dataKey="dataTimestamp"
              type="number"
              domain={[win.start, win.end]}
              ticks={xTicks}
              tickFormatter={(ts: number) => formatTickLabel(ts, range)}
            />
            <YAxis domain={['auto', 'auto']} />
            {/* tooltip 标题显示完整时间（YYYY-MM-DD HH:mm:ss） */}
            <Tooltip labelFormatter={(ts: number) => formatTimestamp(ts)} />
            <Legend />
            {series.map((s) => (
              <Line
                key={s.meterId}
                type="monotone"
                dataKey={s.meterId}
                stroke={s.color}
                dot={false}
                name={s.label}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}

      <div style={{ marginTop: 24 }}>
        <SectionTitle>历史数据</SectionTitle>
        <Table
          columns={[
            {
              title: '时间', dataIndex: 'dataTimestamp', key: 'dataTimestamp', width: 190,
              render: (ts: number) => (
                <span style={{ fontSize: 13, color: '#666', fontFamily: 'var(--font-mono)' }}>
                  {formatTimestamp(ts)}
                </span>
              ),
            },
            {
              title: '测量点', dataIndex: 'meterId', key: 'meter',
              render: (meterId: string) => <span style={{ fontSize: 13 }}>{labelOf.get(meterId) || meterId}</span>,
            },
            {
              title: 'meterId', dataIndex: 'meterId', key: 'meterId', width: 140,
              render: (meterId: string) => (
                <span style={{ fontSize: 12, color: '#999', fontFamily: 'var(--font-mono)' }}>{meterId}</span>
              ),
            },
            {
              title: '测量值', dataIndex: 'value', key: 'value', width: 140,
              render: (v: string) => (
                <span style={{ fontSize: 13, fontFamily: 'var(--font-mono)' }}>{v}</span>
              ),
            },
          ]}
          dataSource={rows}
          size="small"
          loading={loading}
          pagination={{ pageSize: TABLE_PAGE_SIZE, size: 'small', showSizeChanger: false }}
          locale={{ emptyText: '暂无历史数据' }}
        />
      </div>
    </>
  );
};

export default HistoryChart;
