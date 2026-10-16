import React, { useState, useEffect, useCallback } from 'react';
import {
  Table, Button, Space, Tag, Input, InputNumber, Modal, Form, Select,
  message, Popconfirm, Transfer, Alert, Divider, Tooltip
} from 'antd';
import {
  PlusOutlined, ReloadOutlined, EditOutlined, DeleteOutlined,
  ExclamationCircleOutlined, LinkOutlined, EyeOutlined
} from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import { Site, Device } from '../types';
import { siteApi, regionApi, deviceApi, tenantApi } from '../services/api';
import { formatTimestamp } from '../utils/date';
import { PillTag, NoData } from '../utils/format';
import DeviceStatusTag from '../components/DeviceStatusTag';
import { getStoredUser } from '../auth';
import PageContainer from '../components/PageContainer';

interface RegionOption { code: string; name: string }

/**
 * 站点管理页（租户 → 站点 → 设备）
 *
 * 布局：站点列表表格，点击行首展开按钮，在该站点行下方直接展开其关联设备，
 * 不跳转新页面、不弹新窗口。
 *
 * 权限：
 *  - 平台管理员：可见全部站点，创建时可指定归属租户
 *  - 租户账号：仅可见/管理本租户站点（由后端强制），归属自动锁定为本租户
 */
const Sites: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const me = getStoredUser();
  const isPlatformOperator = me?.role === 'admin' && !me?.tenant_id;

  const [loading, setLoading] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [searchText, setSearchText] = useState('');

  // 展开行：站点ID → 该站点设备（懒加载，展开时才请求）
  const [expandedRowKeys, setExpandedRowKeys] = useState<React.Key[]>([]);
  const [siteDevices, setSiteDevices] = useState<Record<number, Device[]>>({});
  const [deviceLoading, setDeviceLoading] = useState<Record<number, boolean>>({});

  // 新建/编辑弹窗
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Site | null>(null);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  // 监听已选地区，控制下级下拉的可用状态（Form.useWatch 会触发重渲染）
  const selectedProvince = Form.useWatch('province_code', form);
  const selectedCity = Form.useWatch('city_code', form);

  // 租户列表（仅平台管理员）：用于把 tenant_id 显示为租户名称，并作为站点表单的租户下拉
  const [tenants, setTenants] = useState<{ id: string; name: string }[]>([]);

  // 行政区划级联
  const [provinces, setProvinces] = useState<RegionOption[]>([]);
  const [cities, setCities] = useState<RegionOption[]>([]);
  const [districts, setDistricts] = useState<RegionOption[]>([]);

  // 设备关联弹窗
  const [bindOpen, setBindOpen] = useState(false);
  const [bindSite, setBindSite] = useState<Site | null>(null);
  const [bindTargetKeys, setBindTargetKeys] = useState<string[]>([]);
  const [bindDataSource, setBindDataSource] = useState<{ key: string; title: string }[]>([]);
  const [binding, setBinding] = useState(false);

  const loadSites = useCallback(async () => {
    setLoading(true);
    try {
      const res = await siteApi.list();
      if (res.data) setSites(res.data);
    } catch (error: any) {
      message.error(error.message || '加载站点列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadSites(); }, [loadSites]);

  // 首页「站点分布」点击“查看站点”跳转过来时，自动展开对应站点
  useEffect(() => {
    const targetId = (location.state as any)?.expandSiteId;
    if (!targetId) return;
    setExpandedRowKeys((prev) => (prev.includes(targetId) ? prev : [...prev, targetId]));
    loadSiteDevices(targetId);
    // 清掉 state，避免返回本页时重复展开
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  // 租户列表只加载一次（仅平台管理员：租户账号看不到该列，也不需要租户下拉）
  useEffect(() => {
    if (!isPlatformOperator) return;
    tenantApi.list()
      .then((res) => {
        if (res.data) setTenants(res.data.map((t) => ({ id: t.id, name: t.name })));
      })
      .catch(() => { /* 租户列表加载失败不影响站点列表 */ });
  }, [isPlatformOperator]);

  /** tenant_id → 租户名称；为空表示平台站点 */
  const tenantNameOf = (tenantId: string | null | undefined): string => {
    if (!tenantId) return '平台';
    return tenants.find((t) => t.id === tenantId)?.name || '平台';
  };

  // 省份基础数据只加载一次
  useEffect(() => {
    regionApi.provinces()
      .then((res) => { if (res.data) setProvinces(res.data); })
      .catch(() => message.error('加载省份数据失败'));
  }, []);

  /**
   * 加载某站点下的设备（复用现有 GET /api/devices?siteId=，租户隔离由后端保证）
   */
  const loadSiteDevices = useCallback(async (siteId: number) => {
    setDeviceLoading((prev) => ({ ...prev, [siteId]: true }));
    try {
      const res = await deviceApi.list(siteId);
      setSiteDevices((prev) => ({ ...prev, [siteId]: res.data || [] }));
    } catch (error: any) {
      message.error(error.message || '加载站点设备失败');
    } finally {
      setDeviceLoading((prev) => ({ ...prev, [siteId]: false }));
    }
  }, []);

  /** 展开/收起站点行：展开时懒加载该站点设备 */
  const handleExpand = (expanded: boolean, record: Site) => {
    setExpandedRowKeys((prev) =>
      expanded ? [...prev, record.id] : prev.filter((k) => k !== record.id)
    );
    if (expanded) loadSiteDevices(record.id);
  };

  /** 省变化 → 加载市，并清空下级 */
  const handleProvinceChange = async (code?: string) => {
    form.setFieldsValue({ city_code: undefined, district_code: undefined });
    setCities([]);
    setDistricts([]);
    if (!code) return;
    try {
      const res = await regionApi.cities(code);
      if (res.data) setCities(res.data);
    } catch {
      message.error('加载城市数据失败');
    }
  };

  /** 市变化 → 加载区县 */
  const handleCityChange = async (code?: string) => {
    form.setFieldsValue({ district_code: undefined });
    setDistricts([]);
    if (!code) return;
    try {
      const res = await regionApi.districts(code);
      if (res.data) setDistricts(res.data);
    } catch {
      message.error('加载区县数据失败');
    }
  };

  /** 打开新建/编辑弹窗 */
  const openModal = async (site: Site | null) => {
    setEditing(site);
    setModalOpen(true);
    setCities([]);
    setDistricts([]);
    if (!site) {
      form.resetFields();
      return;
    }
    form.setFieldsValue({
      name: site.name,
      tenant_id: site.tenant_id || undefined,
      province_code: site.province_code || undefined,
      city_code: site.city_code || undefined,
      district_code: site.district_code || undefined,
      address: site.address || '',
      remark: site.remark || '',
      // 坐标回显：未设置时为 null，InputNumber 显示为空
      longitude: site.longitude ?? null,
      latitude: site.latitude ?? null
    });
    // 回显已选地区：逐级加载下级选项
    if (site.province_code) {
      const cityRes = await regionApi.cities(site.province_code).catch(() => null);
      if (cityRes?.data) setCities(cityRes.data);
    }
    if (site.city_code) {
      const distRes = await regionApi.districts(site.city_code).catch(() => null);
      if (distRes?.data) setDistricts(distRes.data);
    }
  };

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const payload = {
        name: values.name,
        province_code: values.province_code || null,
        city_code: values.city_code || null,
        district_code: values.district_code || null,
        address: values.address || null,
        remark: values.remark || null,
        // 经纬度选填；留空提交 null（清空坐标）
        longitude: values.longitude ?? null,
        latitude: values.latitude ?? null
      };
      if (editing) {
        await siteApi.update(editing.id, payload);
        message.success('站点已更新');
      } else {
        await siteApi.create({
          ...payload,
          tenant_id: isPlatformOperator ? (values.tenant_id || null) : undefined
        });
        message.success('站点创建成功');
      }
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
      loadSites();
    } catch (error: any) {
      if (error?.errorFields) return; // 表单校验失败，交由表单展示
      message.error(error.message || '保存站点失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (site: Site) => {
    try {
      const res = await siteApi.remove(site.id);
      message.success(res.message || '站点已删除');
      // 清理该站点的展开状态与缓存，避免残留
      setExpandedRowKeys((prev) => prev.filter((k) => k !== site.id));
      setSiteDevices((prev) => {
        const next = { ...prev };
        delete next[site.id];
        return next;
      });
      loadSites();
    } catch (error: any) {
      message.error(error.message || '删除站点失败');
    }
  };

  /** 打开设备关联弹窗：候选 = 同租户且未被其他站点占用的设备 */
  const openBind = async (site: Site) => {
    setBindSite(site);
    setBindOpen(true);
    setBindDataSource([]);
    setBindTargetKeys([]);
    try {
      const [candRes, boundRes] = await Promise.all([
        siteApi.deviceCandidates(site.id),
        siteApi.deviceIds(site.id)
      ]);
      const candidates = candRes.data || [];
      setBindDataSource(candidates.map((d) => ({
        key: d.id,
        // 有名称才显示"名称（ID）"；无名称只显示ID本身，
        // 不用ID冒充名称（否则会出现"台州电信9（台州电信9）"这种重复）
        title: d.name ? `${d.name}（${d.id}）` : d.id
      })));
      setBindTargetKeys(boundRes.data || []);
    } catch (error: any) {
      message.error(error.message || '加载设备列表失败');
    }
  };

  /**
   * 保存设备关联
   *
   * 关键原则：**提示必须与服务端实际结果一致**。
   *  1) 无差异时明确告知，不发请求、不谎报成功；
   *  2) 解绑是破坏性操作，先二次确认；
   *  3) 以服务端返回的 bound/failed 为准提示，逐条列出失败原因；
   *  4) 最后回读服务端确认已持久化。
   */
  const handleBindSave = async () => {
    if (!bindSite) return;
    const siteId = bindSite.id;
    setBinding(true);
    try {
      const allKeys = bindDataSource.map((d) => d.key);
      // 以服务端当前关联状态为基准算差异（不使用可能过期的本地状态）
      const originalKeys = await siteApi.deviceIds(siteId).then((r) => r.data || []);
      const toBind = bindTargetKeys.filter((k) => !originalKeys.includes(k));
      const toUnbind = allKeys.filter((k) => originalKeys.includes(k) && !bindTargetKeys.includes(k));

      // 没有任何变更：明确告知，绝不谎报成功（保持弹窗打开，便于继续操作）
      if (toBind.length === 0 && toUnbind.length === 0) {
        message.info('未检测到变更：请把设备从左侧「可选设备」移到右侧「已关联设备」后再保存');
        return;
      }

      // 解绑是破坏性操作，先二次确认，避免误清空
      if (toUnbind.length > 0) {
        const confirmed = await new Promise<boolean>((resolve) => {
          Modal.confirm({
            title: '确认解除关联',
            content: (
              <div>
                将从本站点解除以下 {toUnbind.length} 台设备的关联：<br />
                <b>{toUnbind.join('、')}</b>
                <div style={{ marginTop: 8, color: '#666' }}>
                  设备本身与历史数据、历史告警都不会被删除，仅变为「未分配」。
                </div>
              </div>
            ),
            okText: '确认解绑',
            okType: 'danger',
            cancelText: '取消',
            onOk: () => resolve(true),
            onCancel: () => resolve(false)
          });
        });
        if (!confirmed) return;
      }

      const failures: string[] = [];
      let boundDevices: string[] = [];
      let unboundDevices: string[] = [];

      if (toBind.length > 0) {
        const res = await siteApi.bindDevices(siteId, toBind);
        boundDevices = res.data?.bound || [];
        const failedList = res.data?.failed || [];
        failedList.forEach((f) => failures.push(`${f.id}：${f.reason}`));
        // 服务端应逐台给出结论，数量对不上说明有设备被静默忽略
        if (boundDevices.length + failedList.length !== toBind.length) {
          failures.push(`提交 ${toBind.length} 台，服务端仅返回 ${boundDevices.length + failedList.length} 台结果`);
        }
      }

      if (toUnbind.length > 0) {
        const res = await siteApi.unbindDevices(siteId, toUnbind);
        unboundDevices = res.data?.unbound || [];
        if (unboundDevices.length !== toUnbind.length) {
          failures.push(`请求解绑 ${toUnbind.length} 台，实际解绑 ${unboundDevices.length} 台`);
        }
      }

      // 回读服务端真实关联状态，确认已持久化（不轻信本地 state）
      const confirmedKeys = await siteApi.deviceIds(siteId)
        .then((r) => r.data || null)
        .catch(() => null);
      if (confirmedKeys) {
        const notSaved = bindTargetKeys.filter((k) => !confirmedKeys.includes(k));
        if (notSaved.length > 0) {
          failures.push(`以下设备未成功关联（服务端回读确认）：${notSaved.join('、')}`);
        }
      }

      if (failures.length > 0) {
        Modal.warning({
          title: '部分操作未成功',
          width: 520,
          content: (
            <div>
              {boundDevices.length > 0 && (
                <div>已成功关联 {boundDevices.length} 台：{boundDevices.join('、')}</div>
              )}
              {unboundDevices.length > 0 && (
                <div>已解除关联 {unboundDevices.length} 台：{unboundDevices.join('、')}</div>
              )}
              <div style={{ marginTop: 8, color: '#ff4d4f', fontWeight: 600 }}>未成功：</div>
              {failures.map((f, i) => (
                <div key={i} style={{ color: '#ff4d4f' }}>· {f}</div>
              ))}
            </div>
          ),
          okText: '知道了'
        });
      } else {
        message.success(
          `关联已更新：绑定 ${boundDevices.length} 台，解绑 ${unboundDevices.length} 台`
        );
      }

      setBindOpen(false);
      setBindSite(null);
      loadSites();
      // 展开状态下同步刷新该站点的设备列表
      if (expandedRowKeys.includes(siteId)) loadSiteDevices(siteId);
    } catch (error: any) {
      message.error(error.message || '保存设备关联失败');
    } finally {
      setBinding(false);
    }
  };

  const filteredSites = sites.filter((s) => {
    if (!searchText) return true;
    const t = searchText.toLowerCase();
    return (
      s.name.toLowerCase().includes(t) ||
      (s.address || '').toLowerCase().includes(t)
    );
  });

  /** 所在地区（省/市/区县） */
  const renderRegion = (site: Site) => {
    const parts = [site.province_name, site.city_name, site.district_name].filter(Boolean);
    if (parts.length === 0) return <span style={{ color: '#999' }}>-</span>;
    return <span style={{ fontSize: 13 }}>{parts.join(' / ')}</span>;
  };

  /** 站点下的设备表格列 */
  const deviceColumns = [
    {
      // 字段名统一为「设备ID」：dataIndex 仍是真实字段 id（设备唯一标识），
      // 只改展示名称，不动数据字段/API。
      title: '设备ID',
      dataIndex: 'id',
      key: 'id',
      width: 180,
      // 字体与「设备管理 → 设备ID」共用同一套：var(--font-mono) + 13px，
      // 不额外声明 font-weight / line-height / letter-spacing，全部由上下文继承。
      render: (id: string) => (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{id}</span>
      )
    },
    {
      title: '设备名称',
      dataIndex: 'name',
      key: 'name',
      width: 180,
      // 名称只取 devices.name，未填写时显示 "-"（与「设备管理」页一致）
      render: (name: string | null) => name || <NoData />
    },
    {
      title: '在线状态',
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (status: string, r: Device) => (
        <DeviceStatusTag
          status={status as 'online' | 'offline'}
          activationStatus={r.activationStatus}
        />
      )
    },
    {
      title: '告警状态',
      key: 'hasAlarm',
      width: 100,
      render: (_: any, r: Device) => (
        r.activationStatus === 'inactive'
          ? <NoData />
          : <PillTag green={!r.hasAlarm} text={r.hasAlarm ? '告警' : '正常'} />
      )
    },
    {
      title: '最后上报时间',
      dataIndex: 'last_seen',
      key: 'last_seen',
      width: 180,
      render: (ts: number, r: Device) => (
        r.activationStatus === 'inactive'
          ? <NoData />
          : <span style={{ fontSize: 13, color: '#666', fontFamily: 'var(--font-mono)' }}>
              {formatTimestamp(ts)}
            </span>
      )
    },
    {
      title: '操作',
      key: 'action',
      width: 110,
      render: (_: any, r: Device) => (
        <Button
          type="link"
          size="small"
          icon={<EyeOutlined />}
          onClick={() => navigate(`/devices/${r.id}`)}
        >
          查看详情
        </Button>
      )
    }
  ];

  /** 展开行内容：站点下的设备列表 */
  const renderSiteDevices = (site: Site) => {
    const devices = siteDevices[site.id] || [];
    return (
      <div className="expand-panel">
        <div className="expand-panel__bar">
          <span className="expand-panel__title">
            已关联设备：<b>{devices.length}</b> 台
          </span>
          <Button
            type="primary"
            size="small"
            icon={<LinkOutlined />}
            onClick={() => openBind(site)}
          >
            关联设备
          </Button>
        </div>
        {/* 无设备时只给一行紧凑状态，不渲染整张空表格（避免大片空白） */}
        {devices.length === 0 && !deviceLoading[site.id] ? (
          <div style={{ padding: '4px 0 2px', fontSize: 13, color: 'var(--text-muted)' }}>
            暂无关联设备
          </div>
        ) : (
          <Table
            columns={deviceColumns}
            dataSource={devices}
            rowKey="id"
            size="small"
            loading={!!deviceLoading[site.id]}
            pagination={false}
          />
        )}
      </div>
    );
  };

  const columns: any[] = [
    {
      title: '站点名称',
      dataIndex: 'name',
      key: 'name',
      width: 200,
      render: (name: string) => <span style={{ fontWeight: 500 }}>{name}</span>
    },
    // 所属租户：仅平台管理员需要（可跨租户管理）；
    // 普通租户只能看到自己租户的站点，该列无意义，直接不渲染（不留空白列）
    ...(isPlatformOperator
      ? [{
          title: '所属租户',
          dataIndex: 'tenant_id',
          key: 'tenant_id',
          width: 120,
          // 显示租户名称（tenants.name），不展示 T0001 这类内部编号
          render: (tenantId: string | null) => {
            const name = tenantNameOf(tenantId);
            return tenantId
              ? <Tag color="geekblue" style={{ borderRadius: 4 }}>{name}</Tag>
              : <span style={{ color: '#8c8c8c' }}>平台</span>;
          }
        }]
      : []),
    {
      title: '所在地区',
      key: 'region',
      width: 220,
      render: (_: any, r: Site) => renderRegion(r)
    },
    {
      title: '详细地址',
      dataIndex: 'address',
      key: 'address',
      width: 220,
      ellipsis: true,
      render: (address: string | null) =>
        address
          ? <Tooltip title={address}><span style={{ fontSize: 13 }}>{address}</span></Tooltip>
          : <span style={{ color: '#999' }}>-</span>
    },
    {
      title: '设备数',
      key: 'device_count',
      width: 90,
      render: (_: any, r: Site) => (
        <span>
          <span style={{ fontWeight: 600 }}>{r.device_count ?? 0}</span>
          <span style={{ color: '#999', fontSize: 12 }}> 台</span>
        </span>
      )
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_: any, record: Site) => (
        <Space size={4}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openModal(record)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除站点"
            icon={<ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />}
            description={
              <div style={{ maxWidth: 260 }}>
                仅删除站点本身。<br />
                <b>关联设备不会被删除</b>，设备历史数据与历史告警全部保留，
                设备将变为「未分配」。
              </div>
            }
            okText="删除"
            okType="danger"
            cancelText="取消"
            onConfirm={() => handleDelete(record)}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <PageContainer
      title="站点管理"
      actions={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openModal(null)}>
          新增站点
        </Button>
      }
      filters={
        <>
          <Input.Search
            placeholder="搜索站点名称 / 地址"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{ width: 260 }}
            allowClear
          />
          <Button icon={<ReloadOutlined />} onClick={loadSites} loading={loading}>刷新</Button>
          <span className="page-toolbar__hint">点击左侧箭头展开查看站点设备</span>
        </>
      }
    >

        {/* 站点表格：行首展开显示该站点设备 */}
        <Table
          columns={columns}
          dataSource={filteredSites}
          rowKey="id"
          loading={loading}
          scroll={{ x: 1080 }}
          expandable={{
            expandedRowKeys,
            onExpand: handleExpand,
            expandedRowRender: renderSiteDevices,
            rowExpandable: () => true
          }}
          pagination={{
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 个站点`
          }}
        />

      {/* 新建 / 编辑站点 */}
      <Modal
        title={editing ? `编辑站点：${editing.name}` : '新建站点'}
        open={modalOpen}
        onOk={handleSave}
        onCancel={() => { setModalOpen(false); setEditing(null); form.resetFields(); }}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        width={560}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="name"
            label="站点名称"
            rules={[
              { required: true, message: '请输入站点名称' },
              { max: 100, message: '不能超过100个字符' }
            ]}
            extra="由您自行定义，例如：XX路基站、XX村通信机房"
          >
            <Input placeholder="如 XX路基站" maxLength={100} showCount />
          </Form.Item>

          {isPlatformOperator && (
            <Form.Item
              name="tenant_id"
              label="所属租户"
              extra="留空表示平台自建站点"
            >
              <Select
                placeholder="选择租户（留空=平台）"
                allowClear
                showSearch
                optionFilterProp="label"
                options={tenants.map((t) => ({ value: t.id, label: t.name }))}
              />
            </Form.Item>
          )}

          <Divider orientation="left" plain style={{ marginTop: 0 }}>所在地区</Divider>

          <Space style={{ display: 'flex' }} align="start">
            <Form.Item name="province_code" label="省" style={{ marginBottom: 12 }}>
              <Select
                placeholder="请选择省份"
                style={{ width: 158 }}
                showSearch
                optionFilterProp="label"
                options={provinces.map((p) => ({ value: p.code, label: p.name }))}
                onChange={handleProvinceChange}
                allowClear
              />
            </Form.Item>
            <Form.Item name="city_code" label="市" style={{ marginBottom: 12 }}>
              <Select
                placeholder="请选择城市"
                style={{ width: 158 }}
                showSearch
                optionFilterProp="label"
                options={cities.map((c) => ({ value: c.code, label: c.name }))}
                onChange={handleCityChange}
                disabled={!selectedProvince}
                allowClear
              />
            </Form.Item>
            <Form.Item name="district_code" label="区/县" style={{ marginBottom: 12 }}>
              <Select
                placeholder="请选择区县"
                style={{ width: 158 }}
                showSearch
                optionFilterProp="label"
                options={districts.map((d) => ({ value: d.code, label: d.name }))}
                disabled={!selectedCity}
                allowClear
              />
            </Form.Item>
          </Space>

          <Form.Item
            name="address"
            label="详细地址"
            rules={[{ max: 200, message: '不能超过200个字符' }]}
            extra="填写省市区以外的详细地址，如：XX镇XX村3号机房"
          >
            <Input placeholder="如 XX镇XX村3号机房" maxLength={200} />
          </Form.Item>

          <Divider orientation="left" plain>站点位置</Divider>

          <Space style={{ display: 'flex' }} align="start">
            <Form.Item name="longitude" label="经度" style={{ marginBottom: 12 }}>
              <InputNumber
                min={-180}
                max={180}
                step={0.000001}
                style={{ width: 180 }}
                placeholder="如 113.264385"
              />
            </Form.Item>
            <Form.Item
              name="latitude"
              label="纬度"
              style={{ marginBottom: 12 }}
              extra="选填（GCJ-02 高德坐标）"
            >
              <InputNumber
                min={-90}
                max={90}
                step={0.000001}
                style={{ width: 180 }}
                placeholder="如 23.129112"
              />
            </Form.Item>
          </Space>

          <Form.Item
            name="remark"
            label="备注"
            rules={[{ max: 500, message: '不能超过500个字符' }]}
          >
            <Input.TextArea rows={2} placeholder="可选" maxLength={500} showCount />
          </Form.Item>
        </Form>
      </Modal>

      {/* 关联设备 */}
      <Modal
        title={bindSite ? `关联设备：${bindSite.name}` : '关联设备'}
        open={bindOpen}
        onOk={handleBindSave}
        onCancel={() => { setBindOpen(false); setBindSite(null); }}
        confirmLoading={binding}
        okText="保存关联"
        cancelText="取消"
        width={620}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="操作方式：在左栏勾选设备，点「>」箭头（或双击）把它移动到右栏「已关联设备」，再点保存。"
          description="只能选择本租户已拥有、且未归属其他站点的设备；一个设备最多归属一个站点。移回左栏即为解除关联（设备不会被删除）。"
        />
        <Transfer
          dataSource={bindDataSource}
          targetKeys={bindTargetKeys}
          onChange={(keys) => setBindTargetKeys(keys as string[])}
          render={(item) => item.title}
          titles={['可选设备', '已关联设备']}
          listStyle={{ width: 260, height: 300 }}
          locale={{ itemUnit: '台', itemsUnit: '台', searchPlaceholder: '搜索设备' }}
          showSearch
        />
      </Modal>
    </PageContainer>
  );
};

export default Sites;
