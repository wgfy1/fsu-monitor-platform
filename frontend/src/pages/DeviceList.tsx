import React, { useState, useEffect } from 'react';
import { Table, Input, Button, Space, message, Modal, Tooltip, Form, Input as AntInput, Select, Alert, Upload, Tag, Spin } from 'antd';
import { ReloadOutlined, PlusOutlined, DeleteOutlined, ExclamationCircleOutlined, TeamOutlined, UploadOutlined, DownloadOutlined, ImportOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { Device, Site, DeviceImportPreview } from '../types';
import { deviceApi, siteApi, tenantApi } from '../services/api';
import { formatTimestamp } from '../utils/date';
import { PillTag, NoData } from '../utils/format';
import DeviceStatusTag from '../components/DeviceStatusTag';
import PageContainer from '../components/PageContainer';
import { getStoredUser } from '../auth';

/** 归属筛选框的「全部」选项值：归属租户/归属站点两个下拉共用（不选/清空等价于它） */
const FILTER_ALL = '__all__';
/** 归属租户筛选：平台自有的未分配设备（tenant_id IS NULL） */
const FILTER_PLATFORM = '__platform__';

/**
 * 关键词匹配：**仅设备ID**（厂家协议 gwId）
 * 设备名称不参与匹配：输入名称不应命中任何设备。
 */
function matchKeyword(d: Device, search: string): boolean {
  const s = search.trim().toLowerCase();
  if (!s) return true;
  return d.id.toLowerCase().includes(s);
}

/**
 * 归属租户匹配（**平台管理员**的筛选用）
 * 一律比对后端返回的 tenant_id，绝不用设备名/站点名/用户名推断：
 *  - FILTER_ALL / 空 → 不过滤（平台管理员可见的全部设备）
 *  - FILTER_PLATFORM → tenant_id 为空的平台设备
 *  - 其他            → 该租户ID的设备
 */
function matchTenant(d: Device, tenantFilter?: string): boolean {
  if (!tenantFilter || tenantFilter === FILTER_ALL) return true;
  if (tenantFilter === FILTER_PLATFORM) return !d.tenant_id;
  return d.tenant_id === tenantFilter;
}

/**
 * 归属站点匹配（**普通租户**的筛选用）
 *  - 不选/清空/FILTER_ALL → 不过滤（本租户全部设备）
 *  - 站点ID               → 只保留 devices.site_id = 该站点ID 的设备
 * 站点下拉只含本租户站点，故这里无需再判断站点归属。
 */
function matchSite(d: Device, siteFilter?: number | string): boolean {
  if (siteFilter === undefined || siteFilter === null || siteFilter === FILTER_ALL) return true;
  return Number(d.site_id) === Number(siteFilter);
}

/**
 * 设备列表页面
 * 支持平台手动添加设备，也接受厂家 FSU 网关推送创建
 */
const DeviceList: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [searchText, setSearchText] = useState('');
  // 批量删除：已勾选的设备ID（preserveSelectedRowKeys 保证翻页不丢）
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [batchDeleting, setBatchDeleting] = useState(false);
  // 分页受控：批量删除后当前页可能被删空，需要回退页码避免空白页
  const [pagination, setPagination] = useState({ current: 1, pageSize: 10 });
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addForm] = Form.useForm();
  const [adding, setAdding] = useState(false);
  // 归属筛选按角色二选一（互斥）：
  //  - 平台管理员：归属租户（不选/清空=全部 | FILTER_PLATFORM=平台 | 租户ID=指定租户）
  //  - 普通租户  ：归属站点（不选/清空=全部 | 站点ID=指定站点）
  // 两者都默认不选中，控件显示各自占位文字。
  const [filterTenant, setFilterTenant] = useState<string | undefined>(undefined);
  const [filterSite, setFilterSite] = useState<number | string | undefined>(undefined);
  // 本租户站点（下拉选项；后端 /api/sites 已按登录租户强制隔离）
  const [sites, setSites] = useState<Site[]>([]);
  // 全部正式租户（一个租户可拥有多个设备，因此**不排除**已绑定账号的租户）
  const [tenants, setTenants] = useState<{ id: string; name: string }[]>([]);
  // 设备归属分配（仅平台管理员）
  const [tenantModalOpen, setTenantModalOpen] = useState(false);
  const [tenantTarget, setTenantTarget] = useState<Device | null>(null);
  const [tenantForm] = Form.useForm();
  const [tenantSaving, setTenantSaving] = useState(false);

  // ===== Excel 批量导入（两步：预校验预览 → 确认导入）=====
  const [importOpen, setImportOpen] = useState(false);
  const [importFileName, setImportFileName] = useState('');
  const [importPreview, setImportPreview] = useState<DeviceImportPreview | null>(null);
  const [importParsing, setImportParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [templateLoading, setTemplateLoading] = useState(false);

  const me = getStoredUser();
  const isAdmin = me?.role === 'admin';
  const isPlatformOperator = isAdmin && !me?.tenant_id;

  /** 关闭导入弹窗时清空全部临时状态（避免下次打开看到上次的预览结果） */
  const resetImportState = () => {
    setImportFileName('');
    setImportPreview(null);
  };

  /** 下载导入模板（后端实时生成，含「设备导入」+「填写说明」两个 Sheet） */
  const handleDownloadTemplate = async () => {
    setTemplateLoading(true);
    try {
      const blob = await deviceApi.downloadImportTemplate();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '设备导入模板.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (error: any) {
      message.error(error.message || '模板下载失败');
    } finally {
      setTemplateLoading(false);
    }
  };

  /**
   * 上传 Excel 并预校验（**不写数据库**）
   * 前端只做轻量的格式/大小拦截，真正的校验全部由服务端完成。
   */
  const handleImportFile = async (file: File) => {
    if (!/\.xlsx$/i.test(file.name)) {
      message.error('仅支持 .xlsx 格式的 Excel 文件，请使用平台提供的模板');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      message.error('Excel 文件不能超过 5MB');
      return;
    }
    resetImportState();
    setImportFileName(file.name);
    setImportParsing(true);
    try {
      const res = await deviceApi.importPreview(file);
      setImportPreview(res.data);
    } catch (error: any) {
      message.error(error.message || 'Excel 预校验失败');
    } finally {
      setImportParsing(false);
    }
  };

  /** 确认导入（服务端重新校验 + 单事务写入，全部成功或全部回滚） */
  const handleConfirmImport = async () => {
    const token = importPreview?.token;
    if (!token) return;
    setImporting(true);
    try {
      const res = await deviceApi.importConfirm(token);
      const imported = res.data?.imported ?? 0;
      message.success(`成功导入 ${imported} 台设备`);
      setImportOpen(false);
      resetImportState();
      loadDevices();
    } catch (error: any) {
      // 失败时保留预览结果，方便用户对照错误处理后重新上传
      message.error(error.message || '设备导入失败');
    } finally {
      setImporting(false);
    }
  };

  const importInvalidRows = (importPreview?.rows ?? []).filter((r) => r.status === 'invalid');
  const importValidRows = (importPreview?.rows ?? []).filter((r) => r.status === 'valid');

  const handleAssignTenant = async () => {
    if (!tenantTarget) return;
    try {
      const values = await tenantForm.validateFields();
      setTenantSaving(true);
      await deviceApi.updateTenant(tenantTarget.id, values.tenantId || null);
      message.success(`设备 ${tenantTarget.id} 归属已更新`);
      setTenantModalOpen(false);
      tenantForm.resetFields();
      loadDevices();
    } catch (error: any) {
      message.error(error.message || '分配租户失败');
    } finally {
      setTenantSaving(false);
    }
  };

  const loadDevices = async (): Promise<Device[]> => {
    setLoading(true);
    try {
      // 一次取回当前账号可见的全部设备（租户隔离由后端强制），
      // 归属租户筛选在前端做——后端 /api/devices 只有 siteId 入参，
      // 本轮不动后端接口，因此不向它传筛选条件。
      const res = await deviceApi.list();
      if (res.data) {
        setDevices(res.data);
        return res.data;
      }
      return [];
    } catch (error: any) {
      message.error(error.message || '加载设备列表失败');
      return [];
    } finally {
      setLoading(false);
    }
  };

  // 「归属站点」下拉选项（普通租户用）：复用现有 /api/sites，
  // 该接口后端按登录态强制租户隔离（WHERE tenant_id = ?），只会返回本租户站点，
  // 前端不再二次过滤，也不新增站点接口。
  useEffect(() => {
    if (isPlatformOperator) return;
    siteApi.list()
      .then((res) => { if (res.data) setSites(res.data); })
      .catch(() => { /* 站点加载失败不影响设备列表 */ });
  }, [isPlatformOperator]);

  // 「归属租户」下拉选项：取【全部】正式租户（复用 /api/tenants，不新增接口），
  // 不能用 /api/tenants/available —— 那个只返回未绑定账号的租户，
  // 会把"已绑定账号但可以拥有多台设备"的租户错误地排除掉。
  // 仅平台管理员拉取：该接口本身也要求平台管理员权限，普通租户不会触发。
  useEffect(() => {
    if (!isPlatformOperator) return;
    tenantApi.list()
      .then((res) => {
        if (res.data) setTenants(res.data.map((t) => ({ id: t.id, name: t.name })));
      })
      .catch(() => { /* 租户加载失败不影响设备列表 */ });
  }, [isPlatformOperator]);

  useEffect(() => { loadDevices(); }, []);

  // 关键词 / 归属筛选变化后回到第 1 页：
  // 筛选是在已加载列表上做的客户端过滤，结果集可能比当前页码还短，
  // 停留在旧页码会渲染出空白页（分页是受控的，不会自动回退）。
  useEffect(() => {
    setPagination((prev) => (prev.current === 1 ? prev : { ...prev, current: 1 }));
  }, [searchText, filterTenant, filterSite]);

  const handleDelete = (deviceId: string) => {
    Modal.confirm({
      title: '确认删除设备',
      icon: <ExclamationCircleOutlined />,
      content: `确定要删除设备 ${deviceId} 吗？此操作将删除该设备在本平台的所有数据和告警记录，不会影响设备本身的运行。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await deviceApi.remove(deviceId);
          message.success('设备已删除');
          // 同步移除已删除设备的勾选，避免遗留幽灵选择
          setSelectedRowKeys((prev) => prev.filter((k) => String(k) !== deviceId));
          loadDevices();
        } catch (error: any) {
          message.error(error.message || '删除设备失败');
        }
      }
    });
  };

  const handleAddDevice = async () => {
    try {
      const values = await addForm.validateFields();
      setAdding(true);
      await deviceApi.create({
        id: values.id.trim(),
        name: values.name?.trim() || undefined,
        imei: values.imei?.trim() || undefined,
        iccid: values.iccid?.trim() || undefined,
        tenantId: values.tenantId || undefined,
      });
      message.success(`设备 ${values.id} 添加成功`);
      setAddModalOpen(false);
      addForm.resetFields();
      loadDevices();
    } catch (error: any) {
      if (error.message) {
        message.error(error.message || '添加设备失败');
      }
    } finally {
      setAdding(false);
    }
  };

  /**
   * 批量删除设备
   *  - 二次确认（危险样式按钮「确认删除」）
   *  - 成功：刷新列表、清空选择、按最新数据回退页码（避免空白页）
   *  - 失败：显示后端返回的错误信息，**保留选择状态**方便重试，绝不谎报成功
   */
  const handleBatchDelete = () => {
    const ids = selectedRowKeys.map((k) => String(k));
    if (ids.length === 0) return;

    Modal.confirm({
      title: `确认删除选中的 ${ids.length} 台设备？`,
      icon: <ExclamationCircleOutlined />,
      content: '此操作将永久删除所选设备及其关联业务数据，无法恢复。',
      okText: '确认删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setBatchDeleting(true);
        try {
          const res = await deviceApi.removeBatch(ids);
          const deleted = res.data?.deleted ?? ids.length;
          message.success(`成功删除 ${deleted} 台设备`);
          setSelectedRowKeys([]);

          // 重新拉取；若当前页已被删空则回退到最后一页
          // （按当前生效的同一套筛选条件统计剩余条数，避免页码与列表对不上）
          const fresh = await loadDevices();
          const remain = applyFilters(fresh).length;
          setPagination((prev) => {
            const maxPage = Math.max(1, Math.ceil(remain / prev.pageSize));
            return prev.current > maxPage ? { ...prev, current: maxPage } : prev;
          });
        } catch (error: any) {
          // 保留选择状态，方便用户处理后重试
          message.error(error.message || '批量删除设备失败');
        } finally {
          setBatchDeleting(false);
        }
      }
    });
  };

  /**
   * 关键词 + 归属筛选（两个角色用**不同字段**，互斥生效）：
   *  - 平台管理员：关键词 AND tenant_id
   *  - 普通租户  ：关键词 AND site_id
   */
  const applyFilters = (list: Device[]): Device[] =>
    list.filter(
      (d) =>
        matchKeyword(d, searchText) &&
        (isPlatformOperator ? matchTenant(d, filterTenant) : matchSite(d, filterSite))
    );

  const filteredDevices = applyFilters(devices);

  const columns: any[] = [
    {
      title: '设备名称',
      dataIndex: 'name',
      key: 'name',
      width: 220,
      render: (name: string | null) => {
        // 设备名称**只能**来自 devices.name，绝不用设备ID兜底
        // （名称与ID是两个独立字段，互相替代会让人误以为设备已命名）。
        // 未填写名称时统一显示 "-"，与「站点管理 → 关联设备」保持一致。
        if (!name) return <NoData />;
        return (
          <Tooltip title={name} placement="topLeft">
            <span style={{ fontSize: 14 }}>{name}</span>
          </Tooltip>
        );
      }
    },
    // 设备ID：独立成列（方便检索/核对，点击可复制）
    // 字段名与「站点管理 → 关联设备」统一为「设备ID」，字体复用已有 .cell-mono
    // （= var(--font-mono) + 13px），与站点管理页的同一字段渲染完全一致。
    {
      title: '设备ID',
      dataIndex: 'id',
      key: 'id',
      width: 170,
      render: (id: string) => (
        <Tooltip title={`点击复制：${id}`} placement="topLeft">
          <span
            className="cell-mono"
            style={{ cursor: 'pointer', userSelect: 'none' }}
            onClick={(e) => {
              e.stopPropagation();
              navigator.clipboard.writeText(id);
              message.success({ content: `已复制 ${id}`, key: id });
            }}
          >
            {id}
          </span>
        </Tooltip>
      )
    },
    // 归属方：平台管理员看「归属租户」（跨租户管理需要，用 tenants.name 展示，
    // tenant_id 为空表示平台设备）；普通租户只看「归属站点」（自己租户内的运维需要）
    ...(isPlatformOperator
      ? [{
          title: '归属租户',
          dataIndex: 'tenant_name',
          key: 'tenant_name',
          width: 160,
          ellipsis: { showTitle: false },
          render: (tenantName: string | null | undefined) => {
            const text = tenantName || '平台';
            return (
              <Tooltip title={text} placement="topLeft">
                <span style={{ fontSize: 13, color: tenantName ? 'inherit' : '#8c8c8c' }}>{text}</span>
              </Tooltip>
            );
          }
        }]
      : [{
          title: '归属站点',
          dataIndex: 'site_name',
          key: 'site_name',
          width: 170,
          // 只显示站点名称，不展示 SITE-xxxx 这类内部编号
          render: (siteName: string | null | undefined) => (
            siteName
              ? <span style={{ fontSize: 13 }}>{siteName}</span>
              : <span style={{ color: '#999' }}>未分配</span>
          )
        }]),
    {
      title: '在线状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (status: string, record: Device) => (
        <DeviceStatusTag status={status as 'online' | 'offline'} activationStatus={record.activationStatus} />
      )
    },
    {
      title: '告警状态',
      key: 'hasAlarm',
      width: 90,
      render: (_: any, r: Device) => (
        // 存在未恢复告警 → 红色"告警"，否则绿色"正常"
        r.activationStatus === 'inactive'
          ? <NoData />
          : <PillTag green={!r.hasAlarm} text={r.hasAlarm ? '告警' : '正常'} />
      )
    },
    {
      title: '最后上报时间',
      dataIndex: 'last_seen',
      key: 'last_seen',
      width: 175,
      render: (ts: number, r: Device) => (
        r.activationStatus === 'inactive'
          ? <NoData />
          : <span style={{ fontSize: 13, color: '#999', fontFamily: 'var(--font-mono)' }}>
              {formatTimestamp(ts)}
            </span>
      )
    },
    {
      title: '操作',
      key: 'action',
      width: isAdmin ? 150 : 75,
      render: (_: any, record: Device) => (
        <Space size={4}>
          {/* 分配租户：仅平台管理员（无租户的 admin）可见 */}
          {isPlatformOperator && (
            <Button
              type="link"
              size="small"
              icon={<TeamOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                setTenantTarget(record);
                tenantForm.setFieldsValue({ tenantId: record.tenant_id || undefined });
                setTenantModalOpen(true);
              }}
            >
              分配
            </Button>
          )}
          {/* 删除设备：仅管理员可见（后端已强制 requireAdmin） */}
          {isAdmin && (
            <Button
              type="link"
              danger
              icon={<DeleteOutlined />}
              onClick={(e) => { e.stopPropagation(); handleDelete(record.id); }}
              size="small"
            >
              删除
            </Button>
          )}
        </Space>
      )
    }
  ];

  return (
    <PageContainer
      title="设备管理"
      actions={
        <Space wrap>
          {/* 批量删除：仅平台管理员可用；未选择设备时不显示（危险操作，独立于主操作） */}
          {isAdmin && selectedRowKeys.length > 0 && (
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={handleBatchDelete}
              loading={batchDeleting}
            >
              批量删除（已选择 {selectedRowKeys.length} 台）
            </Button>
          )}
          {isAdmin && (
            <Button
              icon={<ImportOutlined />}
              onClick={() => { resetImportState(); setImportOpen(true); }}
            >
              批量导入
            </Button>
          )}
          {isAdmin && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddModalOpen(true)}>
              添加设备
            </Button>
          )}
        </Space>
      }
      filters={
        <>
          <Input.Search
            placeholder="请输入设备ID"
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            style={{ width: 240 }}
            allowClear
          />
          {/* 归属筛选按角色使用**不同字段**（不是"隐藏筛选框"）：
              - 平台管理员 → 归属租户：选项文本用租户名称（tenants.name），
                筛选值用 tenant_id；「平台」= tenant_id 为空的平台自有设备。
              - 普通租户   → 归属站点：选项只含本租户站点（/api/sites 后端已隔离），
                筛选值用 site_id。 */}
          {isPlatformOperator ? (
            <Select
              placeholder="归属租户"
              style={{ width: 200 }}
              value={filterTenant}
              onChange={(v) => setFilterTenant(v)}
              allowClear
              showSearch
              optionFilterProp="label"
              options={[
                { value: FILTER_ALL, label: '全部' },
                { value: FILTER_PLATFORM, label: '平台' },
                ...tenants.map((t) => ({ value: t.id, label: t.name }))
              ]}
            />
          ) : (
            <Select
              placeholder="归属站点"
              style={{ width: 200 }}
              value={filterSite}
              onChange={(v) => setFilterSite(v)}
              allowClear
              showSearch
              optionFilterProp="label"
              options={[
                { value: FILTER_ALL, label: '全部' },
                // 只显示站点名称，不展示 SITE-xxxx 这类内部编号
                ...sites.map((s) => ({ value: s.id, label: s.name }))
              ]}
            />
          )}
          <Button icon={<ReloadOutlined />} onClick={() => loadDevices()} loading={loading}>刷新</Button>
        </>
      }
    >
        <Table
          columns={columns}
          dataSource={filteredDevices}
          rowKey="id"
          loading={loading}
          scroll={{ x: 700 }}
          rowSelection={isAdmin ? {
            selectedRowKeys,
            onChange: (keys) => setSelectedRowKeys(keys),
            // 翻页时保留已勾选项，避免分页导致选择丢失
            preserveSelectedRowKeys: true
          } : undefined}
          onRow={(record) => ({
            onClick: () => navigate(`/devices/${record.id}`),
            style: { cursor: 'pointer', height: 48 }
          })}
          pagination={{
            current: pagination.current,
            pageSize: pagination.pageSize,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 台设备`,
            onChange: (page, pageSize) => setPagination({ current: page, pageSize })
          }}
        />

      {/* 添加设备弹窗 */}
      <Modal
        title="添加设备"
        open={addModalOpen}
        onOk={handleAddDevice}
        onCancel={() => { setAddModalOpen(false); addForm.resetFields(); }}
        confirmLoading={adding}
        okText="添加"
        cancelText="取消"
      >
        <Form form={addForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="id"
            label="设备ID"
            rules={[{ required: true, message: '请输入设备ID' }]}
          >
            <AntInput placeholder="如 FSU001" maxLength={64} />
          </Form.Item>
          <Form.Item name="name" label="设备名称">
            <AntInput placeholder="可选，如 机房A-1号柜" maxLength={128} />
          </Form.Item>
          <Form.Item name="imei" label="IMEI">
            <AntInput placeholder="可选" maxLength={32} />
          </Form.Item>
          <Form.Item name="iccid" label="ICCID">
            <AntInput placeholder="可选" maxLength={32} />
          </Form.Item>
          {/* 归属租户：仅平台管理员可见；一个租户可拥有多台设备 */}
          {isPlatformOperator && (
            <Form.Item
              name="tenantId"
              label="归属租户"
              extra={tenants.length === 0
                ? '还没有租户，可先留空，稍后在「租户管理」中创建后再分配'
                : '留空 = 暂不分配（设备变为未分配）'}
            >
              <Select
                placeholder="选择租户（留空=未分配）"
                allowClear
                showSearch
                optionFilterProp="label"
                options={tenants.map((t) => ({ value: t.id, label: t.name }))}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* ===== 设备批量导入 =====
          第一步：下载模板 → 选择 Excel（预校验，不写库）
          第二步：查看预览 → 确认导入（有错误则不能确认，需修改后重传） */}
      <Modal
        title="设备批量导入"
        open={importOpen}
        onCancel={() => { setImportOpen(false); resetImportState(); }}
        width={900}
        footer={
          <Space>
            <Button onClick={() => { setImportOpen(false); resetImportState(); }}>取消</Button>
            <Button
              type="primary"
              disabled={!importPreview?.token || importPreview.invalid > 0}
              loading={importing}
              onClick={handleConfirmImport}
            >
              确认导入
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="导入的是设备基础档案，不包含实时数据"
          description="流程：下载模板 → 填写 → 选择文件预校验 → 确认导入。确认后在一个事务内写入全部设备，任意一行失败则全部回滚。"
        />

        <Space wrap style={{ marginBottom: 12 }}>
          <Button
            icon={<DownloadOutlined />}
            loading={templateLoading}
            onClick={handleDownloadTemplate}
          >
            下载Excel模板
          </Button>
          <Upload
            accept=".xlsx"
            maxCount={1}
            showUploadList={false}
            // 返回 false：阻止 antd 自动上传，改由下方 handleImportFile 走带鉴权的接口
            beforeUpload={(file) => { handleImportFile(file as unknown as File); return false; }}
          >
            <Button icon={<UploadOutlined />} loading={importParsing}>选择Excel文件</Button>
          </Upload>
          {importFileName && (
            <Tag color="blue" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {importFileName}
            </Tag>
          )}
        </Space>

        {importParsing && (
          <div style={{ textAlign: 'center', padding: 24 }}><Spin tip="正在解析并校验..." /></div>
        )}

        {!importParsing && importPreview && (
          <>
            <div style={{ marginBottom: 12, fontSize: 14 }}>
              总计：<b>{importPreview.total}</b> 行
              可导入：<b style={{ color: '#52c41a' }}>{importPreview.valid}</b> 行
              错误：<b style={{ color: importPreview.invalid > 0 ? '#ff4d4f' : '#999' }}>
                {importPreview.invalid}
              </b> 行
            </div>

            {importPreview.ignoredColumns.length > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message={`以下列不在模板中，已被忽略：${importPreview.ignoredColumns.join('、')}`}
              />
            )}

            {/* 存在错误：明确告知不能导入，并给出可执行的修复方式 */}
            {importPreview.invalid > 0 && (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 12 }}
                message={`存在 ${importPreview.invalid} 行错误，本次不能导入`}
                description={
                  <>
                    <div style={{ marginBottom: 6 }}>
                      请按下述原因修改 Excel 后**重新选择文件**上传（本轮不支持只导入有效行）。
                    </div>
                    <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                      {importInvalidRows.map((r) => (
                        <div key={r.row} style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                          第 {r.row} 行：{(r.errors ?? []).join('；')}
                        </div>
                      ))}
                    </div>
                  </>
                }
              />
            )}

            {importPreview.valid > 0 && (
              <Table
                columns={[
                  { title: '行号', dataIndex: 'row', key: 'row', width: 70 },
                  { title: '网关ID', key: 'id', width: 170,
                    render: (_: any, r: any) => <span className="cell-mono">{r.data?.id}</span> },
                  { title: '设备名称', key: 'name', width: 180,
                    render: (_: any, r: any) => r.data?.name || <span style={{ color: '#999' }}>-</span> },
                  { title: '租户', key: 'tenant', width: 150,
                    render: (_: any, r: any) => r.data?.tenantName
                      || (r.data?.tenantId
                        ? <span className="cell-mono">{r.data.tenantId}</span>
                        : <span style={{ color: '#999' }}>未分配</span>) },
                  { title: '站点', key: 'site', width: 180,
                    render: (_: any, r: any) => r.data?.siteName
                      || <span style={{ color: '#999' }}>未分配</span> },
                ]}
                dataSource={importValidRows}
                rowKey="row"
                size="small"
                pagination={false}
                scroll={{ y: 240 }}
              />
            )}
          </>
        )}
      </Modal>

      {/* 分配设备归属弹窗（仅平台管理员） */}
      <Modal
        title={tenantTarget ? `分配设备归属：${tenantTarget.id}` : '分配设备归属'}
        open={tenantModalOpen}
        onOk={handleAssignTenant}
        onCancel={() => { setTenantModalOpen(false); tenantForm.resetFields(); }}
        confirmLoading={tenantSaving}
        okText="保存"
        cancelText="取消"
      >
        <Form form={tenantForm} layout="vertical" style={{ marginTop: 16 }}>
          {tenantTarget?.site_name && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={`该设备当前归属站点「${tenantTarget.site_name}」`}
              description="修改归属租户后，将自动解除该设备的站点分配（归属站点变为「未分配」）。站点本身不受影响。"
            />
          )}
          <Form.Item
            name="tenantId"
            label="归属租户"
            tooltip="选择租户管理中的正式租户；留空 = 取消分配（设备变为未分配）。"
            extra={tenants.length === 0
              ? '还没有租户，请先在「租户管理」中创建'
              : '一个租户可以拥有多台设备，已绑定账号的租户同样可以继续分配设备'}
          >
            <Select
              placeholder="选择租户（留空=未分配）"
              allowClear
              showSearch
              optionFilterProp="label"
              options={tenants.map((t) => ({ value: t.id, label: t.name }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
};

export default DeviceList;
