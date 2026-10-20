import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, Row, Col, Button, Descriptions, Table, Tag, Space, message, Spin, Modal, Form, Input, Dropdown, Alert, Tooltip, Select, Switch, Divider } from 'antd';
import { ArrowLeftOutlined, ReloadOutlined, EditOutlined, PoweroffOutlined, CloudUploadOutlined, SyncOutlined, BellOutlined, SettingOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { getStoredUser } from '../auth';
import { Device, Alarm, RemoteGetAlarmResult, RemoteMeterOption, RemoteSetDataItem, NtpConfig } from '../types';
import { deviceApi, alarmApi } from '../services/api';
import { formatTimestamp } from '../utils/date';
import { ValueUnit, PillTag, NoData } from '../utils/format';
import DeviceStatusTag from '../components/DeviceStatusTag';
import CommStatusTag from '../components/CommStatusTag';
import HistoryChart, { SUB_DEVICE_SERIES } from '../components/HistoryChart';
import PageContainer from '../components/PageContainer';
import {
  DEV_BATTERY, DEV_RECTIFIER, DEV_DC, DEV_ENV, DEV_DOOR,
  BATTERY_METERS, AC_METERS, DC_METERS, MODULE_METERS, ENV_METERS,
  DOOR_METER_ID,
  getCellVoltageMeterIds,
  getMeterValue, findMeterValue, toNumber,
  CELL_VOLTAGE_MIN, CELL_VOLTAGE_MAX,
} from '../utils/meterMapping';

/** 告警标识：active → 红色"告警"，否则绿色"正常" */
const AlarmTag: React.FC<{ active: boolean }> = ({ active }) => (
  <PillTag green={!active} text={active ? '告警' : '正常'} />
);

/** 卡片内分区小标题 */
const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 15, fontWeight: 600, color: '#333', margin: '14px 0 8px' }}>{children}</div>
);

/** 由字段名推断单位（电压 V / 电流 A / 温度 °C / 频率 Hz） */
function meterUnit(label: string): string {
  if (label.includes('电流')) return 'A';
  if (label.includes('温度')) return '°C';
  if (label.includes('频率')) return 'Hz';
  return 'V';
}

/**
 * 遥测详情弹窗的标题用名（key = meterMapping / HistoryChart 的 series key）
 *
 * ⚠️ 这张表只服务于**遥测展示**（设备详情页的实时数据与历史曲线），
 * 与告警无关：告警的子设备名一律由后端按厂家字典解析后通过 dev_name 返回，
 * 前端不参与告警名称/分类的判定。
 */
const SUB_DEVICE_LABEL: Record<string, string> = {
  battery: '电池', ac: '交流', dc: '直流', env: '温湿度', door: '门磁',
};

/**
 * 子设备详情（点击子设备名称旁的「详情」打开）
 *
 * 只展示该子设备的**历史数据**：fsu_data_history，经由 /api/devices/:id/fsu-history。
 * 实时数据不在此重复展示——外层对应子设备卡片已按 devices.latest_meters 呈现。
 */
const SubDeviceDetail: React.FC<{ device: Device; subDevice: string }> = ({ device, subDevice }) => {
  const cfg = SUB_DEVICE_SERIES.find((d) => d.key === subDevice) || SUB_DEVICE_SERIES[0];

  return (
    <>
      <Descriptions bordered size="small" column={2} style={{ marginBottom: 20 }}>
        <Descriptions.Item label="子设备名称">{cfg.label}</Descriptions.Item>
        <Descriptions.Item label="devId">
          <span className="cell-mono" style={{ fontSize: 13 }}>{cfg.devId}</span>
        </Descriptions.Item>
      </Descriptions>

      <HistoryChart deviceId={device.id} subDevice={subDevice} />
    </>
  );
};

const DeviceDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(false);
  const [device, setDevice] = useState<Device | null>(null);
  const [alarms, setAlarms] = useState<Alarm[]>([]);

  // ===== 子设备通信状态 =====
  // { devId: 'online' | 'offline' }，唯一来源 = 厂家心跳报文（协议 4.2）的
  // params.online / params.offline。未列出的 devId 由 CommStatusTag 显示"未知"，
  // 前端**不做任何推断**（不看网关在线、不看告警、不看最后上报时间）。
  const [commStatuses, setCommStatuses] = useState<Record<string, string>>({});

  // ===== 编辑设备名称 =====
  const [editOpen, setEditOpen] = useState(false);
  const [editForm] = Form.useForm();
  const [saving, setSaving] = useState(false);
  // ===== 远程功能 =====
  const [rebooting, setRebooting] = useState(false);
  const [otaOpen, setOtaOpen] = useState(false);
  const [otaForm] = Form.useForm();
  const [otaSending, setOtaSending] = useState(false);
  // 远程功能（重启/OTA/setData）后端要求管理员权限，非管理员不展示入口
  const isAdmin = getStoredUser()?.role === 'admin';

  // ===== 远程操作：查询类（4.5 实时数据 / 4.6 实时告警）=====
  // remoteBusy 同时只能有一个操作：既用于按钮 loading，也用于禁用其它按钮，
  // 避免连点造成同一时刻多个 MQTT 下行请求
  const [remoteBusy, setRemoteBusy] = useState<'' | 'data' | 'alarm'>('');
  // 实时告警查询结果（弹窗展示；与平台告警记录区分，见下方说明）
  const [alarmQueryResult, setAlarmQueryResult] = useState<RemoteGetAlarmResult | null>(null);

  // ===== 远程操作：设置类（4.7 setData）=====
  const [setOpen, setSetOpen] = useState(false);
  const [setForm] = Form.useForm();
  const [setSending, setSetSending] = useState(false);
  const [meterOptions, setMeterOptions] = useState<RemoteMeterOption[]>([]);
  const [dictAvailable, setDictAvailable] = useState(false);
  const [meterOptionsLoading, setMeterOptionsLoading] = useState(false);
  // 表单里当前设置项（用于联动显示"当前值"）
  const setItems = Form.useWatch('items', setForm) as Array<{ devId?: string; meterId?: string }> | undefined;
  // 子设备告警详情弹窗：null=关闭，否则为**厂家 devId**（与 alarms.type 比对）
  const [alarmModalType, setAlarmModalType] = useState<string | null>(null);
  // 子设备详情弹窗（实时数据 + 历史曲线 + 历史数据）：null=关闭
  const [detailType, setDetailType] = useState<string | null>(null);

  // ===== 校时设置（协议 4.8，平台→网关）=====
  // 每台设备独立配置；enabled 只控制**定时**校时，上线校时始终执行
  const [ntpConfig, setNtpConfig] = useState<NtpConfig | null>(null);
  const [ntpSaving, setNtpSaving] = useState(false);

  /** 子设备卡片标题右侧的「详情」入口（五个子设备统一样式） */
  const detailButton = (deviceType: string) => (
    <Button size="small" onClick={() => setDetailType(deviceType)}>详情</Button>
  );

  /**
   * 子设备卡片标题右侧：通信状态标签 +「详情」入口
   *
   * 状态直接取自厂家心跳上报（后端接口透传），缺失时显示"未知"。
   * 该标签纯展示，不触发任何告警或推送。
   */
  const subDeviceExtra = (devId: string, deviceType: string) => (
    <Space size={8}>
      <CommStatusTag status={commStatuses[devId]} />
      {detailButton(deviceType)}
    </Space>
  );

  /** 打开编辑弹窗：仅设备名称可编辑 */
  const openEdit = () => {
    editForm.setFieldsValue({ name: device?.name || '' });
    setEditOpen(true);
  };

  /** 保存设备名称（唯一可编辑字段），保存后立即刷新详情页 */
  const handleSaveName = async () => {
    if (!id) return;
    try {
      const values = await editForm.validateFields();
      setSaving(true);
      // 空串 → null（后端存 NULL，页面显示 "-"）
      await deviceApi.update(id, { name: values.name?.trim() ? values.name.trim() : null });
      message.success('设备名称已保存');
      setEditOpen(false);
      await loadDevice();
    } catch (error: any) {
      if (error?.errorFields) return; // 表单校验失败，交由表单展示
      message.error(error.message || '保存设备名称失败');
    } finally {
      setSaving(false);
    }
  };

  /** 远程重启网关（协议 4.9：1-sys 2-app 3-4g 4-vpn） */
  const doReboot = (type: number) => {
    const label = { 1: '重启系统', 2: '重启应用', 3: '重启 4G 模块', 4: '重启 VPN' }[type] || '重启';
    Modal.confirm({
      title: `确认${label}？`,
      content: '指令下发后网关将执行重启，期间该网关下的设备会短暂离线。',
      okText: '确认下发',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setRebooting(true);
        try {
          await deviceApi.reboot(id!, type);
          message.success(`${label}指令已下发`);
        } catch (error: any) {
          message.error(error.message || '重启指令下发失败');
        } finally {
          setRebooting(false);
        }
      }
    });
  };

  /** OTA 升级下发：支持单个或多个固件地址（每行一个） */
  const handleOta = async () => {
    if (!id) return;
    try {
      const values = await otaForm.validateFields();
      const urls = String(values.urls || '')
        .split(/[\s,，]+/)
        .map((u) => u.trim())
        .filter(Boolean);
      if (urls.length === 0) {
        message.warning('请输入固件下载地址');
        return;
      }
      if (urls.some((u) => !/^https?:\/\//i.test(u))) {
        message.error('固件地址必须是 http/https 链接');
        return;
      }
      setOtaSending(true);
      await deviceApi.ota(id, urls);
      message.success('OTA 升级指令已下发');
      setOtaOpen(false);
      otaForm.resetFields();
    } catch (error: any) {
      if (error?.errorFields) return;
      message.error(error.message || 'OTA 下发失败');
    } finally {
      setOtaSending(false);
    }
  };

  /**
   * 刷新实时数据（厂家协议 4.5 getData）
   *
   * 查询类操作，不做二次确认。后端会把网关返回的实时数据回写
   * devices.latest_meters，因此成功后重新读取设备详情即可看到最新值。
   */
  const doRefreshData = async () => {
    if (!id || remoteBusy) return;
    setRemoteBusy('data');
    try {
      const res = await deviceApi.remoteGetData(id);
      const result = res.data;
      const devCount = result?.devices?.length ?? 0;
      const pointCount = (result?.devices ?? [])
        .reduce((n, d) => n + (d.meters?.length ?? 0), 0);
      message.success(
        `实时数据已刷新（网关 code=${result?.code ?? 0}，${devCount} 个子设备 / ${pointCount} 个点）`
      );
      // 回写失败时如实告知：网关有数据但平台没存下来，页面不会变
      if (result && !result.applied) {
        message.warning('网关已返回数据，但平台未能回写实时快照，请联系管理员查看服务日志');
      }
      // 陌生点（厂家字典里没有）明确提示，不静默
      if (result && result.unknownPoints?.length > 0) {
        message.warning(
          `有 ${result.unknownPoints.length} 个点不在设备点位字典中（已原样保存，未创建任何设备）`
        );
      }
      await loadDevice();
    } catch (error: any) {
      message.error(error.message || '刷新实时数据失败');
    } finally {
      setRemoteBusy('');
    }
  };

  /**
   * 刷新实时告警（厂家协议 4.6 getAlarm）
   *
   * 只查询、不落平台告警库（后端 synced 恒为 false）——平台告警记录的
   * 唯一来源仍是网关主动 alarmReport，二者在前端明确区分展示。
   */
  const doRefreshAlarm = async () => {
    if (!id || remoteBusy) return;
    setRemoteBusy('alarm');
    try {
      const res = await deviceApi.remoteGetAlarm(id);
      if (res.data) setAlarmQueryResult(res.data);
    } catch (error: any) {
      message.error(error.message || '刷新实时告警失败');
    } finally {
      setRemoteBusy('');
    }
  };

  /** 打开「远程设置」弹窗：先取厂家点位字典（只读平台数据，不下发 MQTT） */
  const openSetData = async () => {
    if (!id) return;
    setForm.setFieldsValue({ items: [{ devId: undefined, meterId: undefined, value: '' }] });
    setSetOpen(true);
    setMeterOptionsLoading(true);
    try {
      const res = await deviceApi.remoteMeterOptions(id);
      setMeterOptions(res.data?.options ?? []);
      setDictAvailable(!!res.data?.dictAvailable);
    } catch (error: any) {
      // 字典取不到不阻断：允许手工填写 devId / meterId
      setMeterOptions([]);
      setDictAvailable(false);
      message.warning(error.message || '获取点位字典失败，可手工填写 devId / meterId');
    } finally {
      setMeterOptionsLoading(false);
    }
  };

  /** 实际下发（确认框之后调用） */
  const submitSetData = async () => {
    if (!id) return;
    let values: any;
    try {
      values = await setForm.validateFields();
    } catch {
      return; // 表单校验失败，交由表单展示
    }
    const items: RemoteSetDataItem[] = (values.items ?? []).map((it: any) => ({
      devId: String(it.devId).trim(),
      meterId: String(it.meterId).trim(),
      // 协议 4.7 要求 value 为 string：表单值一律按字符串下发
      value: String(it.value ?? ''),
    }));

    Modal.confirm({
      title: '确定向设备下发设置命令吗？',
      content: `共 ${items.length} 项。指令下发后由网关执行，平台无法撤销。`,
      okText: '确认下发',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setSetSending(true);
        try {
          const res = await deviceApi.remoteSetData(id, items);
          const r = res.data;
          message.success(`设置指令已下发（网关 code=${r?.code ?? 0}，${r?.msg || 'success'}）`);
          setSetOpen(false);
          setForm.resetFields();
          // 网关受理 ≠ 设备已设置完成：再拉一次实时数据以确认设备实际值
          // （顺序执行，不与本次下发并发）
          await doRefreshData();
        } catch (error: any) {
          message.error(error.message || '设置指令下发失败');
        } finally {
          setSetSending(false);
        }
      }
    });
  };

  const loadDevice = async () => {
    if (!id) return;
    try {
      const res = await deviceApi.detail(id);
      if (res.data) setDevice(res.data);
    } catch (error: any) {
      message.error(error.message || '加载设备详情失败');
    }
    await loadNtpConfig();
  };

  /** 读取校时配置（协议 4.8）；失败不打断页面，仅置空由界面提示 */
  const loadNtpConfig = async () => {
    if (!id) return;
    try {
      const res = await deviceApi.ntpConfig(id);
      if (res.data) setNtpConfig(res.data);
    } catch (error: any) {
      console.error('加载校时配置失败:', error?.message || error);
      setNtpConfig(null);
    }
  };

  /** 保存校时配置（仅管理员入口可见；后端同样有 requireAdmin 校验） */
  const saveNtpConfig = async (patch: { enabled?: boolean; intervalHours?: number }) => {
    if (!id || ntpSaving) return;
    setNtpSaving(true);
    try {
      const res = await deviceApi.updateNtpConfig(id, patch);
      if (res.data) setNtpConfig(res.data);
      message.success('校时配置已保存');
    } catch (error: any) {
      message.error(error.message || '保存校时配置失败');
      await loadNtpConfig();   // 失败时回读真实值，避免界面与后端不一致
    } finally {
      setNtpSaving(false);
    }
  };


  const loadAlarms = async () => {
    if (!id) return;
    try {
      const res = await alarmApi.list({ deviceId: id, limit: 50 });
      if (res.data) setAlarms(res.data.items);
    } catch (_) { /* no data */ }
  };

  /**
   * 读取子设备通信状态（只读）。
   *
   * 后端返回的是厂家心跳里明确列出的 devId；未列出的保持"未知"。
   * 失败时静默保持原值 —— 状态图标不可用不应影响设备详情其它数据。
   */
  const loadCommStatus = useCallback(async () => {
    if (!id) return;
    try {
      const res = await deviceApi.subDeviceCommStatus(id);
      // 后端已按字典返回全部功能子设备（status 只会是 online/offline/unknown）。
      // 这里只做 devId → status 的索引，缺失的 devId 由 CommStatusTag 显示"未知"。
      const map: Record<string, string> = {};
      for (const s of res.data?.subDevices ?? []) {
        if (s?.devId) map[s.devId] = s.status;
      }
      setCommStatuses(map);
    } catch {
      /* 保持原值（缺失=未知），不弹提示：状态不可用不应影响页面其它数据 */
    }
  }, [id]);

  const handleRefresh = async () => {
    setLoading(true);
    await Promise.all([loadDevice(), loadAlarms(), loadCommStatus()]);
    setLoading(false);
  };

  // 厂家心跳是周期上报：用轻量轮询让图标跟随最新上报更新。
  // 只请求状态接口，不触碰告警/推送链路；卸载时清理定时器。
  useEffect(() => {
    if (!id) return;
    const timer = setInterval(loadCommStatus, 30000);
    return () => clearInterval(timer);
  }, [id, loadCommStatus]);

  useEffect(() => {
    handleRefresh();
    // 仅在设备ID变化时重新加载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);


  if (!device) return <div style={{ textAlign: 'center', padding: 50 }}><Spin size="large" /></div>;

  // 未激活设备（从未连接过）：所有数据字段显示 "-"，不展示任何历史/默认值
  const inactive = device.activationStatus === 'inactive';
  const unresolvedAlarms = alarms.filter(a => !a.resolved);

  // ====== 远程操作可用性 ======
  // 设备离线（status != online）时禁用全部远程按钮：后端也会拒绝下发，
  // 前端禁用只是把"点了必然失败"提前告知，避免误以为已下发。
  const remoteDisabled = device.status !== 'online';

  /** 「远程设置」devId 下拉选项（按厂家字典去重；点位数量很小，直接计算即可） */
  const devOptionsRaw = new Map<string, string | null>();
  for (const o of meterOptions) {
    if (!devOptionsRaw.has(o.devId)) devOptionsRaw.set(o.devId, o.devName);
  }
  const devOptions = Array.from(devOptionsRaw, ([value, label]) => ({
    value,
    label: label ? `${label}（${value}）` : value,
  }));

  /** 某 devId 下的 meterId 下拉选项 */
  const meterOptionsOf = (devId?: string) =>
    devId
      ? meterOptions
          .filter((o) => o.devId === devId)
          .map((o) => ({
            value: o.meterId,
            label: o.meterName ? `${o.meterName}（${o.meterId}）` : o.meterId,
          }))
      : [];

  /** 取某点位的当前实时值（来自 devices.latest_meters；无值显示 "-"） */
  const currentMeterValue = (devId?: string, meterId?: string): string => {
    if (!devId || !meterId) return '-';
    const v = device.latestMeters?.[devId]?.[meterId];
    return v === undefined || v === null || v === '' ? '-' : String(v);
  };

  // ====== 子设备告警状态：**唯一依据 = 当前未恢复告警** ======
  // 归属按**厂家上报的 devId** 匹配：后端把 alarmReport 的 devId 原样存进
  // alarms.type（不再翻译成 battery/ac/dc/env/door 那套自造分类），
  // 因此这里直接用厂家 devId 比对，不依赖任何前端分类表。
  // 卡片用的是 meterMapping 里的 DEV_* 常量（遥测展示用，与告警分类无关）。
  // 网关自身系统模块（如 215001）不属于这 5 张卡片，其告警不会点亮任何卡片。
  const hasAlarmOf = (devId: string) => unresolvedAlarms.some(a => a.type === devId);
  // 子设备告警详情：该子设备的**全部**告警（含已恢复），供弹窗展示
  const alarmsOfSubDevice = (devId: string) => alarms.filter(a => a.type === devId);

  /**
   * 子设备告警入口：状态标签（只看未恢复）+「详情」（**始终可点**，不因当前正常而消失）
   * @param devId    厂家子设备 ID（与 alarms.type 比对）
   * @param rowLabel 整行标签（卡片自己的标题，如 "电池告警"）
   */
  const renderSubDeviceAlarmEntry = (devId: string, rowLabel: string) => (
    <Descriptions bordered size="small" column={2}>
      <Descriptions.Item label={rowLabel}>
        <Space size={12}>
          <AlarmTag active={hasAlarmOf(devId)} />
          <a onClick={() => setAlarmModalType(devId)}>详情</a>
        </Space>
      </Descriptions.Item>
    </Descriptions>
  );

  // 告警弹窗标题里的子设备名：用后端按**厂家字典**解析出的 dev_name；
  // 字典没有该 devId 时回退显示 devId 原文，前端不维护 devId→中文名 映射。
  const alarmModalDevName =
    (alarmModalType ? alarmsOfSubDevice(alarmModalType)[0]?.dev_name : null) || alarmModalType || '';

  // ====== 电池信息（子设备 48V蓄电池）======

  // 电池组基础量：只取厂家 FSU 实时点（devices.latest_meters）。
  // 不再回退 devices.powerOutputVoltage / powerOutputCurrent / temperature ——
  // 这些旧物模型列已无写入方（写入随旧链路一并下线），回退只会显示历史冻结值。

  // 16 节单体电压：只取厂家实时点 latestMeters 中该子设备的单体电压 meterId
  const cellsFromMeters = getCellVoltageMeterIds().map(id => toNumber(getMeterValue(device, DEV_BATTERY, id)));
  // 单体电压只来自厂家实时点 latestMeters（不再回退旧 device_data.properties）
  const cellVoltages: (number | undefined)[] = cellsFromMeters;

  // 单体高压/低压不再单独判定：告警已按子设备级统一入口展示（见电池告警行）

  // ====== 电源信息（子设备 交流屏 + 直流屏）======

  // ====== 门磁/门禁（子设备 devId 1246001）======
  // 门禁实时状态**唯一来源**：厂家 FSU 实时点 latest_meters[1246001][13160016001]。
  //
  // 厂家字典只给出 meterName="门磁开关状态"、meterType=1，**未定义枚举取值**，
  // 因此这里只认当前已知的 0/1：0 = 关门，1 = 开门；
  // 其他值一律视为**未知**（显示 "-"），不判定为开门、也不判定为关门。
  // 原始值照常保存在 latest_meters / fsu_data_history 中，此处只做展示判定。
  // 不回退旧物模型列 devices.door_state —— 该列已无 FSU 写入来源，回退只会显示历史冻结值。
  const doorRaw = getMeterValue(device, DEV_DOOR, DOOR_METER_ID);
  const doorValue = doorRaw === undefined || doorRaw === null ? '' : String(doorRaw).trim();
  const doorState: 'open' | 'closed' | null =
    doorValue === '0' ? 'closed'
      : doorValue === '1' ? 'open'
        : null;

  // ====== 温湿度（子设备 devId 1120001，只取厂家 FSU 实时点）======
  // 无数据即显示 "-"：不回退旧物模型列（devices.temperature / devices.humidity）。
  // 子设备是否存在与当前是否有数据是两回事——没有数据不代表设备没有温湿度传感器。
  const envTemp = toNumber(getMeterValue(device, DEV_ENV, '13120003001'));
  const envHumi = toNumber(getMeterValue(device, DEV_ENV, '13120004001'));

  return (
    <>
      <style>{`
        .page-container .ant-descriptions-item-label {
          font-size: 14px !important;
          color: #666 !important;
          white-space: nowrap;
        }
        .device-detail .ant-descriptions-item-content {
          vertical-align: middle !important;
        }
        .alarm-table .ant-table-thead > tr > th {
          font-size: 14px;
          color: #666;
          padding: 12px 8px !important;
        }
        .alarm-table .ant-table-tbody > tr {
          height: 48px;
        }
        .alarm-table .ant-table-tbody > tr > td {
          padding: 8px 8px !important;
          vertical-align: middle;
        }
      `}</style>
      <PageContainer
        title="设备详情"
        // 有名称才显示"名称（ID）"；未命名设备明确标注为设备ID，不用ID冒充名称
        description={device.name ? `${device.name}（${device.id}）` : `设备ID：${device.id}`}
        actions={
          <Space>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/devices')}>返回列表</Button>
            <Button icon={<ReloadOutlined />} onClick={handleRefresh} loading={loading}>刷新</Button>
          </Space>
        }
        card={false}
      >
        <Card
          title="网关基本信息"
          extra={
            <Button size="small" icon={<EditOutlined />} onClick={openEdit}>编辑</Button>
          }
        >
        {/* 网关基本信息：设备名称 / 设备ID / 版本 / 在线状态 / 所属站点 / 所属租户 */}
        <Descriptions bordered column={2}>
          {/* 设备名称：来自 devices.name，可通过「编辑」修改；未命名显示 "-" */}
          <Descriptions.Item label="设备名称">
            {device.name
              ? <span style={{ fontSize: 14 }}>{device.name}</span>
              : <NoData />}
          </Descriptions.Item>
          {/* 设备ID：厂家协议 gwId（网关 MAC），只读、不可编辑 */}
          <Descriptions.Item label="设备ID">
            <span className="cell-mono">{device.id}</span>
          </Descriptions.Item>
          {/* 版本：来自厂家 FSU login 报文 params.version，登录时自动保存，只读 */}
          <Descriptions.Item label="版本">
            {device.softwareVersion
              ? <span style={{ fontSize: 13, fontFamily: 'var(--font-mono)' }}>{device.softwareVersion}</span>
              : <NoData />}
          </Descriptions.Item>
          <Descriptions.Item label="在线状态">
            <DeviceStatusTag status={device.status as 'online' | 'offline'} activationStatus={device.activationStatus} />
          </Descriptions.Item>
          {/* 归属站点：未关联站点时显示"未分配"；可在站点管理页调整（不在本页编辑弹窗内） */}
          <Descriptions.Item label="所属站点">
            {(device as any).site_name
              ? <span>{(device as any).site_name}</span>
              : <span style={{ color: '#999' }}>未分配</span>}
          </Descriptions.Item>
          {/* 所属租户：显示 tenants.name（不是 T0001 这样的内部ID） */}
          <Descriptions.Item label="所属租户">
            {(device as any).tenant_name
              ? <Tag color="geekblue" style={{ borderRadius: 4 }}>{(device as any).tenant_name}</Tag>
              : <span style={{ color: '#999' }}>未分配</span>}
          </Descriptions.Item>
          {/* ICCID：来自厂家 heartbeat.params.ICCID，落既有 devices.iccid 列；未上报显示 "-" */}
          <Descriptions.Item label="ICCID">
            {device.iccid
              ? <span style={{ fontSize: 13, fontFamily: 'var(--font-mono)' }}>{device.iccid}</span>
              : <NoData />}
          </Descriptions.Item>
          {/* 最后心跳：来自厂家 gw/v1/heartbeat（非 MQTT ping/pong），复用既有 last_heartbeat */}
          <Descriptions.Item label="最后心跳">
            {device.last_heartbeat != null
              ? <span style={{ fontSize: 13, color: '#999', fontFamily: 'var(--font-mono)' }}>
                  {formatTimestamp(device.last_heartbeat)}
                </span>
              : <NoData />}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {/* ====== 远程操作（统一入口，全部复用后端厂家协议下行能力）======
          查询类：刷新实时数据(4.5) / 刷新实时告警(4.6) —— 不需二次确认
          写操作：远程设置(4.7) / 重启(4.9) / OTA(4.10) —— 需二次确认，仅管理员 */}
      <Card title="🛠️ 远程操作" style={{ marginTop: 16 }} loading={loading}>
        {remoteDisabled && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="设备当前离线"
            description="网关未在线时无法下发远程指令（平台需要收到网关的 MQTT 连接与登录）。请等待设备重新上线后再操作。"
          />
        )}
        <Space wrap>
          <Button
            icon={<SyncOutlined />}
            loading={remoteBusy === 'data'}
            disabled={remoteDisabled || (!!remoteBusy && remoteBusy !== 'data')}
            onClick={doRefreshData}
          >
            刷新实时数据
          </Button>
          <Button
            icon={<BellOutlined />}
            loading={remoteBusy === 'alarm'}
            disabled={remoteDisabled || (!!remoteBusy && remoteBusy !== 'alarm')}
            onClick={doRefreshAlarm}
          >
            刷新实时告警
          </Button>
          {isAdmin && (
            <Button
              icon={<SettingOutlined />}
              disabled={remoteDisabled || setSending}
              onClick={openSetData}
            >
              远程设置
            </Button>
          )}
          {isAdmin && (
            /* 重启类型按协议 4.9：1-sys 2-app 3-4g 4-vpn */
            <Dropdown
              disabled={remoteDisabled}
              menu={{
                items: [
                  { key: '1', label: '重启系统 (sys)' },
                  { key: '2', label: '重启应用 (app)' },
                  { key: '3', label: '重启 4G 模块' },
                  { key: '4', label: '重启 VPN' },
                ],
                onClick: ({ key }) => doReboot(Number(key)),
              }}
            >
              <Button icon={<PoweroffOutlined />} loading={rebooting} disabled={remoteDisabled}>
                重启网关
              </Button>
            </Dropdown>
          )}
          {isAdmin && (
            <Button
              icon={<CloudUploadOutlined />}
              disabled={remoteDisabled}
              onClick={() => { otaForm.resetFields(); setOtaOpen(true); }}
            >
              OTA升级
            </Button>
          )}
        </Space>

        {/* 校时设置（协议 4.8，平台→网关）：开关 + 间隔 */}
        {ntpConfig && (
          <>
            <Divider style={{ margin: '12px 0' }} />
            <Space wrap align="center">
              <span>定时校时：</span>
              <Switch
                checked={ntpConfig.enabled}
                loading={ntpSaving}
                disabled={!isAdmin}
                onChange={(v) => saveNtpConfig({ enabled: v })}
              />
              <span style={{ marginLeft: 12 }}>校时间隔：</span>
              <Select
                style={{ width: 130 }}
                value={ntpConfig.intervalHours}
                disabled={!isAdmin || !ntpConfig.enabled || ntpSaving}
                onChange={(v) => saveNtpConfig({ intervalHours: v })}
                options={ntpConfig.intervalOptions.map((h) => ({ value: h, label: `${h} 小时` }))}
              />
            </Space>
          </>
        )}

        {!isAdmin && (
          <div style={{ marginTop: 8, fontSize: 13, color: '#999' }}>
            「远程设置 / 重启网关 / OTA升级」为写操作，仅管理员可执行。
          </div>
        )}
      </Card>

      {/* 编辑设备名称 */}
      <Modal
        title="编辑设备名称"
        open={editOpen}
        onOk={handleSaveName}
        onCancel={() => setEditOpen(false)}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={editForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="name"
            label="设备名称"
            rules={[{ max: 128, message: '设备名称不能超过128个字符' }]}
            extra="留空表示清除名称（列表与详情显示为 “-”）"
          >
            <Input placeholder="如 台州电信-机房A网关" maxLength={128} allowClear />
          </Form.Item>
        </Form>
      </Modal>

      {/* OTA 升级下发（不实现固件服务器，仅按协议下发地址） */}
      <Modal
        title="OTA 升级"
        open={otaOpen}
        onOk={handleOta}
        onCancel={() => setOtaOpen(false)}
        confirmLoading={otaSending}
        okText="下发升级"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={otaForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="urls"
            label="固件下载地址"
            rules={[{ required: true, message: '请输入固件下载地址' }]}
            extra="支持单个或多个文件，每行一个；需为 http/https 链接"
          >
            <Input.TextArea rows={4} placeholder={'http://192.168.0.65:8080/ota.bin'} />
          </Form.Item>
        </Form>
      </Modal>

      {/* ====== 远程设置（厂家协议 4.7 setData）======
          点位优先从厂家字典选择（不让用户手工拼 devId/meterId）；
          字典缺失时退化为手工输入，仍然可以下发。 */}
      <Modal
        title="远程设置"
        open={setOpen}
        onOk={submitSetData}
        onCancel={() => setSetOpen(false)}
        confirmLoading={setSending}
        okText="确认下发"
        cancelText="取消"
        width={860}
        destroyOnClose
      >
        {!meterOptionsLoading && !dictAvailable && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="该网关还没有点位字典"
            description="网关尚未上传过 uploadDevInfo 字典，无法提供点位下拉；可手工填写 devId / meterId 后下发。"
          />
        )}
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="网关返回成功仅代表指令已被受理"
          description="下发成功后平台会自动刷新一次实时数据以确认设备实际值，但请以设备实际状态为准。"
        />
        <Form form={setForm} layout="vertical" initialValues={{ items: [{}] }}>
          <Form.List name="items">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field, index) => {
                  const devId = setItems?.[index]?.devId;
                  const meterId = setItems?.[index]?.meterId;
                  return (
                    <Row gutter={8} key={field.key} align="top">
                      <Col span={6}>
                        <Form.Item
                          name={[field.name, 'devId']}
                          label="子设备 devId"
                          rules={[{ required: true, message: '请填写 devId' }]}
                        >
                          {dictAvailable ? (
                            <Select
                              options={devOptions}
                              placeholder="选择子设备"
                              loading={meterOptionsLoading}
                              showSearch
                              optionFilterProp="label"
                              // 换子设备后原 meterId 必然失效：一并清空，避免下发错点位
                              onChange={() => setForm.setFieldValue(['items', field.name, 'meterId'], undefined)}
                            />
                          ) : (
                            <Input placeholder="如 1061001" />
                          )}
                        </Form.Item>
                      </Col>
                      <Col span={7}>
                        <Form.Item
                          name={[field.name, 'meterId']}
                          label="测点 meterId"
                          rules={[{ required: true, message: '请填写 meterId' }]}
                        >
                          {dictAvailable ? (
                            <Select
                              options={meterOptionsOf(devId)}
                              placeholder={devId ? '选择测点' : '请先选择子设备'}
                              disabled={!devId}
                              showSearch
                              optionFilterProp="label"
                            />
                          ) : (
                            <Input placeholder="如 22564441" />
                          )}
                        </Form.Item>
                      </Col>
                      <Col span={4}>
                        <Form.Item label="当前值">
                          <Input value={currentMeterValue(devId, meterId)} readOnly />
                        </Form.Item>
                      </Col>
                      <Col span={5}>
                        <Form.Item
                          name={[field.name, 'value']}
                          label="新值"
                          rules={[{ required: true, message: '请填写新值' }]}
                        >
                          <Input placeholder="按字符串下发" />
                        </Form.Item>
                      </Col>
                      <Col span={2}>
                        <Form.Item label=" ">
                          <Tooltip title="删除本条">
                            <Button
                              danger
                              icon={<DeleteOutlined />}
                              disabled={fields.length <= 1}
                              onClick={() => remove(field.name)}
                            />
                          </Tooltip>
                        </Form.Item>
                      </Col>
                    </Row>
                  );
                })}
                <Button
                  type="dashed"
                  block
                  icon={<PlusOutlined />}
                  onClick={() => add({ devId: undefined, meterId: undefined, value: '' })}
                >
                  新增一条设置项
                </Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>

      {/* ====== 实时告警查询结果（厂家协议 4.6 getAlarm）======
          与平台「告警记录」明确区分：这里是**网关当下的实时状态**，不落平台告警库。 */}
      <Modal
        title="网关实时告警"
        open={alarmQueryResult !== null}
        onCancel={() => setAlarmQueryResult(null)}
        footer={<Button onClick={() => setAlarmQueryResult(null)}>关闭</Button>}
        width={820}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`这是平台主动查询网关得到的实时告警（网关 code=${alarmQueryResult?.code ?? 0}）`}
          description="仅作实时状态展示，不写入平台告警记录。下方「告警统计」与子设备告警状态仍以网关主动上报的告警为准。"
        />
        <Table
          columns={[
            { title: '子设备', key: 'dev', width: 200,
              render: (_: any, r: any) =>
                r.devName ? `${r.devName}（${r.devId}）` : <span className="cell-mono">{r.devId}</span> },
            { title: '告警点', key: 'meter', width: 240,
              render: (_: any, r: any) =>
                r.meterName ? `${r.meterName}（${r.meterId}）` : <span className="cell-mono">{r.meterId}</span> },
            { title: '告警时间', dataIndex: 'alarmTimeMs', key: 'alarmTimeMs', width: 180,
              render: (ts: number) => (
                <span style={{ fontSize: 13, color: '#999', fontFamily: 'var(--font-mono)' }}>
                  {formatTimestamp(ts)}
                </span>
              ) },
          ]}
          dataSource={alarmQueryResult?.alarms ?? []}
          rowKey={(r: any) => `${r.devId}-${r.meterId}`}
          size="small"
          pagination={false}
          locale={{ emptyText: '网关当前无实时告警' }}
        />
      </Modal>

      {/* 子设备告警详情：显示该子设备**全部**告警（未恢复 + 已恢复） */}
      <Modal
        title={`${alarmModalDevName}告警`}
        open={alarmModalType !== null}
        onCancel={() => setAlarmModalType(null)}
        footer={null}
        width={860}
      >
        <Table
          columns={[
            { title: '告警信息', dataIndex: 'message', key: 'message',
              render: (m: string) => (m || '').replace(/\s*\(等级\d+\)\s*$/, '') },
            // 厂家告警点编号（meterId，如 11061004001）；序列号另有 serial_no 列，不在此展示
            { title: '告警点编号', dataIndex: 'value', key: 'value', width: 150,
              render: (v: string | null) => v || '-' },
            { title: '发生时间', dataIndex: 'created_at', key: 'created_at', width: 170,
              render: (ts: number) => (
                <span style={{ fontSize: 13, color: '#999', fontFamily: 'var(--font-mono)' }}>
                  {formatTimestamp(ts)}
                </span>
              ) },
            { title: '状态', dataIndex: 'resolved', key: 'resolved', width: 90,
              render: (r: number) => <PillTag green={!!r} text={r ? '已恢复' : '告警中'} /> },
            { title: '恢复时间', dataIndex: 'resolved_at', key: 'resolved_at', width: 170,
              render: (ts: number | null) => ts != null
                ? <span style={{ fontSize: 13, color: '#999', fontFamily: 'var(--font-mono)' }}>{formatTimestamp(ts)}</span>
                : <NoData /> },
          ]}
          dataSource={alarmModalType ? alarmsOfSubDevice(alarmModalType) : []}
          rowKey="id"
          size="small"
          pagination={false}
          locale={{ emptyText: '暂无告警记录' }}
        />
      </Modal>

      {/* 子设备详情：实时数据（latest_meters）+ 历史曲线/明细（fsu_data_history） */}
      <Modal
        title={`${SUB_DEVICE_LABEL[detailType || ''] || ''}详情`}
        open={detailType !== null}
        onCancel={() => setDetailType(null)}
        footer={null}
        width={1000}
        destroyOnClose
        styles={{ body: { maxHeight: '72vh', overflowY: 'auto', paddingRight: 8 } }}
      >
        {detailType && <SubDeviceDetail device={device} subDevice={detailType} />}
      </Modal>

      {/* ====== 1. 电池信息 ====== */}
      <Card title="🔋 电池信息" style={{ marginTop: 16 }} loading={loading} extra={subDeviceExtra(DEV_BATTERY, 'battery')}>
        <Descriptions bordered size="small" column={3}>
          {Object.entries(BATTERY_METERS).map(([meterId, label]) => {
            const v = toNumber(getMeterValue(device, DEV_BATTERY, meterId));
            return (
              <Descriptions.Item key={meterId} label={label}>
                {inactive || v == null
                  ? <NoData />
                  : <ValueUnit value={v} unit={meterUnit(label)} decimals={label.includes('总电压') ? 2 : 1} />}
              </Descriptions.Item>
            );
          })}
        </Descriptions>

        <SectionTitle>单体电池电压（16 节）</SectionTitle>
        {cellVoltages.length > 0 ? (
          <Row gutter={[8, 8]}>
            {cellVoltages.slice(0, 16).map((v, i) => {
              const abnormal = v != null && (v < CELL_VOLTAGE_MIN || v > CELL_VOLTAGE_MAX);
              return (
                <Col span={6} key={i}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '6px 10px',
                      background: '#fafafa',
                      border: `1px solid ${abnormal ? '#ffa39e' : '#f0f0f0'}`,
                      borderRadius: 6,
                    }}
                  >
                    <span style={{ color: '#999', fontSize: 13 }}>单体 {i + 1}</span>
                    {v != null ? (
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 13,
                          fontWeight: 500,
                          color: abnormal ? '#ff4d4f' : '#389e0d',
                        }}
                      >
                        {v.toFixed(3)}V
                      </span>
                    ) : (
                      <span style={{ color: '#ccc' }}>-</span>
                    )}
                  </div>
                </Col>
              );
            })}
          </Row>
        ) : (
          <div style={{ color: '#999', padding: '12px 0', textAlign: 'center' }}>暂无单体电压数据</div>
        )}

        <SectionTitle>电池告警</SectionTitle>
        {renderSubDeviceAlarmEntry(DEV_BATTERY, '电池告警')}
      </Card>

      {/* ====== 2. 交流 ====== */}
      <Card title="⚡ 交流" style={{ marginTop: 16 }} loading={loading} extra={subDeviceExtra(DEV_RECTIFIER, 'ac')}>
        {renderSubDeviceAlarmEntry(DEV_RECTIFIER, '交流告警')}
        {/* 交流输入（整流设备） */}
        <SectionTitle>交流输入（整流设备）</SectionTitle>
        <Descriptions bordered size="small" column={3}>
          {Object.entries(AC_METERS).map(([meterId, label]) => {
            const v = toNumber(getMeterValue(device, DEV_RECTIFIER, meterId));
            return (
              <Descriptions.Item key={meterId} label={label}>
                {inactive || v == null ? <NoData /> : <ValueUnit value={v} unit={meterUnit(label)} decimals={1} />}
              </Descriptions.Item>
            );
          })}
        </Descriptions>

        {/* 整流模块 */}
        <SectionTitle>整流模块</SectionTitle>
        <Descriptions bordered size="small" column={3}>
          {Object.entries(MODULE_METERS).map(([meterId, label]) => {
            const v = toNumber(findMeterValue(device, meterId));
            if (meterId === '12060029001') {
              // 均/浮充状态：0=浮充, 1=均充
              return (
                <Descriptions.Item key={meterId} label={label}>
                  {inactive || v == null
                    ? <NoData />
                    : (v === 1 ? <Tag color="geekblue" style={{ borderRadius: 4 }}>均充</Tag>
                        : v === 0 ? <Tag color="green" style={{ borderRadius: 4 }}>浮充</Tag>
                        : <Tag style={{ borderRadius: 4 }}>{`状态 ${v}`}</Tag>)}
                </Descriptions.Item>
              );
            }
            return (
              <Descriptions.Item key={meterId} label={label}>
                {inactive || v == null ? <NoData /> : <ValueUnit value={v} unit={meterUnit(label)} decimals={1} />}
              </Descriptions.Item>
            );
          })}
        </Descriptions>
      </Card>

      {/* ====== 3. 直流 ====== */}
      <Card title="⚡ 直流" style={{ marginTop: 16 }} loading={loading} extra={subDeviceExtra(DEV_DC, 'dc')}>
        {renderSubDeviceAlarmEntry(DEV_DC, '直流告警')}
        {/* 直流输出（直流系统） */}
        <SectionTitle>直流输出（直流系统）</SectionTitle>
        <Descriptions bordered size="small" column={3}>
          {Object.entries(DC_METERS).map(([meterId, label]) => {
            const v = toNumber(getMeterValue(device, DEV_DC, meterId));
            return (
              <Descriptions.Item key={meterId} label={label}>
                {inactive || v == null ? <NoData /> : <ValueUnit value={v} unit={meterUnit(label)} decimals={1} />}
              </Descriptions.Item>
            );
          })}
        </Descriptions>
      </Card>

      {/* ====== 4. 温湿度 ====== */}
      <Card title="🌡️ 温湿度" style={{ marginTop: 16 }} loading={loading} extra={subDeviceExtra(DEV_ENV, 'env')}>
        {renderSubDeviceAlarmEntry(DEV_ENV, '温湿度告警')}
        <Descriptions bordered size="small" column={2}>
          {Object.entries(ENV_METERS).map(([meterId, label]) => (
            <Descriptions.Item key={meterId} label={label}>
              <ValueUnit
                value={meterId === '13120003001' ? envTemp : envHumi}
                unit={meterId === '13120003001' ? '°C' : '%'}
                decimals={1}
                threshold={meterId === '13120003001' ? 40 : undefined}
                highlightColor={meterId === '13120003001' ? '#ff4d4f' : undefined}
              />
            </Descriptions.Item>
          ))}
        </Descriptions>
      </Card>

      {/* ====== 5. 门磁/门禁 ====== */}
      <Card title="🚪 门磁/门禁" style={{ marginTop: 16 }} loading={loading} extra={subDeviceExtra(DEV_DOOR, 'door')}>
        {renderSubDeviceAlarmEntry(DEV_DOOR, '告警')}
        <Descriptions bordered size="small" column={2}>
          <Descriptions.Item label="门禁状态">
            {doorState === 'open' ? <PillTag green={false} text="开门" />
              : doorState === 'closed' ? <PillTag green text="关门" />
                : <NoData />}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {/* ====== 告警统计 ====== */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={12}>
          <Card title="告警统计" loading={loading}>
            <Row gutter={16}>
              <Col span={8}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 24, fontWeight: 'bold', color: '#ff4d4f', lineHeight: 1.2 }}>
                    {unresolvedAlarms.length}
                  </div>
                  <div style={{ fontSize: 14, color: '#666', marginTop: 4 }}>未解决</div>
                </div>
              </Col>
              <Col span={8}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 24, fontWeight: 'bold', color: '#52c41a', lineHeight: 1.2 }}>
                    {alarms.filter(a => a.resolved).length}
                  </div>
                  <div style={{ fontSize: 14, color: '#666', marginTop: 4 }}>已解决</div>
                </div>
              </Col>
              <Col span={8}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 24, fontWeight: 'bold', color: '#333', lineHeight: 1.2 }}>
                    {alarms.length}
                  </div>
                  <div style={{ fontSize: 14, color: '#666', marginTop: 4 }}>总计</div>
                </div>
              </Col>
            </Row>
          </Card>
        </Col>
      </Row>

      </PageContainer>
    </>
  );
};

export default DeviceDetail;
