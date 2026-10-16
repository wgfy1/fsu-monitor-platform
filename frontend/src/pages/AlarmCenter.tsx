import React, { useState, useEffect } from 'react';
import { Table, Button, Space, Tag, Select, Input, DatePicker, message, Modal } from 'antd';
import { CheckCircleOutlined, DeleteOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { Alarm, SubDeviceOption } from '../types';
import { alarmApi } from '../services/api';
import { formatTimestamp, formatRelativeTime } from '../utils/date';
import PageContainer from '../components/PageContainer';
import dayjs, { Dayjs } from 'dayjs';

/** 子设备筛选框的「全部」选项值：不传子设备条件 */
const FILTER_ALL = '__all__';

const AlarmCenter: React.FC = () => {
  const navigate = useNavigate();

  const [loading, setLoading] = useState(false);
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  // 草稿条件：用户正在编辑、尚未点「查询」
  const [filterResolved, setFilterResolved] = useState<number | undefined>(0);
  // 子设备筛选值：FILTER_ALL = 全部；否则为**厂家 devId**
  const [filterDevId, setFilterDevId] = useState<string | undefined>(FILTER_ALL);
  const [searchText, setSearchText] = useState('');
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  // 已生效的条件：实际用于请求（「查询」提交后写入）
  const [applied, setApplied] = useState<{
    resolved?: number; devId?: string; startTime?: number; endTime?: number; search?: string;
  }>({ resolved: 0 });
  // 子设备筛选项：**来自设备上报字典**（后端 /api/alarms/sub-devices），
  // 不是从告警列表提取 —— 没有告警的子设备同样会出现。
  const [subDevices, setSubDevices] = useState<SubDeviceOption[]>([]);
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 });
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  // 请求序号：快速切换条件时丢弃过期响应，保证页面显示最后一次查询结果
  const reqSeqRef = React.useRef(0);

  const loadAlarms = async (
    page: number = 1,
    pageSize: number = 20,
    cond: {
      resolved?: number; devId?: string; startTime?: number; endTime?: number; search?: string;
    } = applied
  ) => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    try {
      // 全部筛选条件（关键词 / 状态 / 类型 / 时间 / 租户）由后端 SQL 统一查询，
      // 分页在 SQL 内完成；total 为后端 COUNT(*) 的真实总数
      const res = await alarmApi.list({
        resolved: cond.resolved,
        // 按厂家 devId 精确过滤（"全部"时不传该参数）
        devId: cond.devId,
        startTime: cond.startTime,
        endTime: cond.endTime,
        search: cond.search || undefined,
        limit: pageSize,
        offset: (page - 1) * pageSize
      });
      if (seq !== reqSeqRef.current) return; // 过期响应，丢弃
      if (res.data) {
        setAlarms(res.data.items);
        setPagination({ current: page, pageSize, total: res.data.total });
      }
    } catch (error: any) {
      if (seq !== reqSeqRef.current) return;
      message.error(error.message || '加载告警列表失败');
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  };

  /**
   * 把当前选中的时间范围换算为秒级时间戳
   * 结束时间取所选的**整秒**（RangePicker showTime 已精确到秒），保证包含该时刻
   */
  const timeRangeToParams = (r: [Dayjs, Dayjs] | null) => {
    if (!r || !r[0] || !r[1]) return { startTime: undefined, endTime: undefined };
    return {
      startTime: r[0].startOf('second').unix(),
      endTime: r[1].endOf('second').unix()
    };
  };

  /** 点击「查询」：提交草稿条件 */
  const handleSearch = () => {
    const { startTime, endTime } = timeRangeToParams(range);
    const cond = {
      resolved: filterResolved,
      // "全部" = 不做子设备过滤（传 undefined，后端不下发该条件）
      devId: filterDevId && filterDevId !== FILTER_ALL ? filterDevId : undefined,
      startTime,
      endTime,
      search: searchText.trim() || undefined,
    };
    setApplied(cond);
    // 条件变化后回到第 1 页，并清空勾选（避免跨结果集误删）
    setSelectedRowKeys([]);
    loadAlarms(1, pagination.pageSize, cond);
  };

  /**
   * 加载「子设备」筛选项（仅一次）
   *
   * 来源是**设备上报的点位字典**（后端 /api/alarms/sub-devices），
   * 不是当前告警列表 —— 因此某个子设备暂时没有告警时依然会出现在选项里；
   * 字典新增功能子设备后选项自动更新，前端不维护任何分类映射。
   * 加载失败不影响告警列表主流程（下拉里只剩「全部」）。
   */
  useEffect(() => {
    alarmApi.subDevices()
      .then((res) => {
        const data = res.data;
        if (data?.options) setSubDevices(data.options);
        if (data?.conflicts && data.conflicts.length > 0) {
          // 同一 devId 在不同网关字典里名称不一致：后端已记录，这里再提示一次，不静默覆盖
          console.warn('[告警] 子设备名称冲突:', data.conflicts);
        }
      })
      .catch((error: any) => {
        console.warn('[告警] 子设备筛选项加载失败:', error?.message || error);
      });
  }, []);

  /** 点击「重置」：清空全部筛选条件，恢复默认列表（默认 resolved=0 未解决） */
  const handleReset = () => {
    setSearchText('');
    setFilterResolved(0);
    setFilterDevId(FILTER_ALL);
    setRange(null);
    setSelectedRowKeys([]);
    const cond = { resolved: 0 };
    setApplied(cond);
    loadAlarms(1, pagination.pageSize, cond);
  };

  const handleResolve = async (alarmId: number) => {
    Modal.confirm({
      title: '确认解决告警',
      content: '确定要标记该告警为已解决吗？',
      okText: '确定',
      cancelText: '取消',
      onOk: async () => {
        try {
          await alarmApi.resolve(alarmId);
          message.success('告警已解决');
          loadAlarms(pagination.current, pagination.pageSize);
        } catch (error: any) {
          message.error(error.message || '解决告警失败');
        }
      }
    });
  };

  const handleDelete = (alarmId: number) => {
    Modal.confirm({
      title: '确认删除',
      icon: <ExclamationCircleOutlined />,
      content: '确定要删除该告警记录吗？此操作不可撤销。',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await alarmApi.remove(alarmId);
          message.success('告警已删除');
          setSelectedRowKeys(prev => prev.filter(k => k !== alarmId));
          loadAlarms(pagination.current, pagination.pageSize);
        } catch (error: any) {
          message.error(error.message || '删除告警失败');
        }
      }
    });
  };

  const handleBatchDelete = () => {
    if (selectedRowKeys.length === 0) {
      message.warning('请选择要删除的告警');
      return;
    }
    Modal.confirm({
      title: '确认批量删除',
      icon: <ExclamationCircleOutlined />,
      content: `确定要删除选中的 ${selectedRowKeys.length} 条告警吗？此操作不可撤销。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          const ids = selectedRowKeys.map(k => Number(k));
          const res = await alarmApi.removeBatch(ids);
          message.success(`已删除 ${res.data?.deleted || ids.length} 条告警`);
          setSelectedRowKeys([]);
          loadAlarms(pagination.current, pagination.pageSize);
        } catch (error: any) {
          message.error(error.message || '批量删除失败');
        }
      }
    });
  };

  useEffect(() => {
    // 首次进入：默认查询未解决告警，不设置时间范围（与原有行为一致）
    loadAlarms(1, pagination.pageSize, applied);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 说明：原先这里维护了 battery/ac/dc/env/door 五个「告警类型」选项，
  // 那套分类是平台自行编造的，厂家协议里没有。现已移除：
  // FSU 告警的 type 直接存**厂家 devId**，子设备名称由后端用厂家字典解析后
  // 通过 dev_name 返回，前端不再维护任何 meterId/devId 中文名表。
  const columns = [
    {
      // 原「告警ID」列已按需求移除（数据库字段保留，仅页面不展示）
      title: '设备ID',
      dataIndex: 'device_id',
      key: 'device_id',
      render: (deviceId: string) => (
        <a onClick={() => navigate(`/devices/${deviceId}`)}>{deviceId}</a>
      )
    },
    {
      // 「子设备」列：名称由后端用**设备上报的点位字典**按 devId 解析后返回。
      // 字典没有该 devId 时（字典未上报）回退显示 devId 原文，不编造名称。
      title: '子设备',
      key: 'dev',
      width: 160,
      render: (_: any, r: Alarm) =>
        r.dev_name
          ? <Tag>{r.dev_name}</Tag>
          : <span className="cell-mono">{r.type || '-'}</span>
    },
    {
      // 「级别」列：直接展示协议 4.4 的 alarmLevel 原始值（1~5），不做任何映射。
      // 没有原始级别时显示"未定级"（不显示内部枚举）。
      title: '级别',
      dataIndex: 'alarm_level',
      key: 'alarm_level',
      width: 90,
      render: (level: number | null | undefined) =>
        level == null
          ? <span style={{ color: '#999' }}>未定级</span>
          : <Tag color="geekblue">{`级别 ${level}`}</Tag>
    },
    {
      // 说明：原「严重程度 / 告警等级」列已按需求移除，
      // alarm_level 字段仍保留在库与接口中，仅页面不展示。
      title: '告警信息',
      dataIndex: 'message',
      key: 'message',
      ellipsis: true,
      // 按需求不在告警信息里展示等级；等级另有 alarm_level 字段。
      // 后端已不再往 message 里写"(等级N)"，此处再兜底剥离历史数据里的后缀。
      render: (msg: string) => (msg || '').replace(/\s*\(等级\d+\)\s*$/, '')
    },
    // 原「来源」列已按需求移除（source 字段保留在库与接口中，仅页面不展示）
    {
      title: '状态',
      dataIndex: 'resolved',
      key: 'resolved',
      width: 80,
      render: (resolved: number) => (
        <Tag color={resolved ? 'green' : 'red'}>{resolved ? '已解决' : '未解决'}</Tag>
      )
    },
    {
      title: '时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 150,
      render: (ts: number) => (
        <div>
          <div style={{ fontSize: 13, fontFamily: 'var(--font-mono)' }}>{formatTimestamp(ts)}</div>
          <div style={{ color: '#999', fontSize: 12 }}>{formatRelativeTime(ts)}</div>
        </div>
      )
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_: any, record: Alarm) => (
        <Space size="small">
          <Button
            type="link" size="small"
            icon={<CheckCircleOutlined />}
            onClick={() => handleResolve(record.id)}
            disabled={record.resolved === 1}
          >
            解决
          </Button>
          <Button
            type="link" size="small" danger
            icon={<DeleteOutlined />}
            onClick={() => handleDelete(record.id)}
          >
            删除
          </Button>
        </Space>
      )
    }
  ];

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys: React.Key[]) => setSelectedRowKeys(keys),
  };

  return (
    <PageContainer
      title="告警中心"
      actions={
        <Space wrap>
          {selectedRowKeys.length > 0 && (
            <Button danger icon={<DeleteOutlined />} onClick={handleBatchDelete}>
              批量删除（已选择 {selectedRowKeys.length} 条）
            </Button>
          )}
        </Space>
      }
      filters={
        <>
          <Input
            placeholder="请输入设备ID"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{ width: 220 }}
            allowClear
          />
          <Select
            placeholder="处理状态" value={filterResolved} onChange={setFilterResolved}
            style={{ width: 120 }} allowClear
          >
            <Select.Option value={0}>未解决</Select.Option>
            <Select.Option value={1}>已解决</Select.Option>
          </Select>
          {/* 子设备筛选：选项由**设备上报的点位字典**动态生成（devId 作筛选值、
              devName 作显示名），不再是写死的五类告警类型。
              选中后按厂家 devId 精确过滤；「全部」= 不做子设备过滤。 */}
          <Select
            placeholder="子设备"
            value={filterDevId}
            onChange={setFilterDevId}
            style={{ width: 170 }}
            showSearch
            optionFilterProp="label"
            options={[
              { value: FILTER_ALL, label: '全部' },
              ...subDevices.map((o) => ({ value: o.devId, label: o.devName || o.devId })),
            ]}
          />
          <DatePicker.RangePicker
            showTime={{ format: 'HH:mm:ss' }}
            format="YYYY-MM-DD HH:mm:ss"
            value={range}
            onChange={(v) => setRange(v as [Dayjs, Dayjs] | null)}
            placeholder={['开始时间', '结束时间']}
            style={{ width: 360 }}
            presets={[
              { label: '今天', value: [dayjs().startOf('day'), dayjs()] },
              { label: '近7天', value: [dayjs().subtract(7, 'day'), dayjs()] },
              { label: '近30天', value: [dayjs().subtract(30, 'day'), dayjs()] }
            ]}
          />
          <Button type="primary" onClick={handleSearch} loading={loading}>查询</Button>
          <Button onClick={handleReset}>重置</Button>
        </>
      }
    >
      <Table
        columns={columns}
        dataSource={alarms}
        rowKey="id"
        loading={loading}
        rowSelection={rowSelection}
        pagination={{
          current: pagination.current,
          pageSize: pagination.pageSize,
          total: pagination.total,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 条告警`,
          onChange: (page, pageSize) => {
            // 翻页保持当前已生效的筛选条件（含时间范围）
            loadAlarms(page, pageSize, applied);
          }
        }}
        locale={{ emptyText: '暂无告警' }}
        rowClassName={(record) => (record.resolved ? '' : 'alarm-unresolved')}
      />
      <style>{`
        .alarm-unresolved { background-color: #fff2f0; }
        .alarm-unresolved:hover td { background-color: #ffebe8 !important; }
      `}</style>
    </PageContainer>
  );
};

export default AlarmCenter;
