import React, { useState, useEffect, useCallback } from 'react';
import {
  Table, Button, Space, Tag, Input, Modal, Form, message, Alert, Divider, Switch
} from 'antd';
import {
  PlusOutlined, ReloadOutlined, EditOutlined, DeleteOutlined,
  SwapOutlined, ExclamationCircleOutlined
} from '@ant-design/icons';
import { Navigate } from 'react-router-dom';
import { Tenant, TenantDeletePreview } from '../types';
import { tenantApi } from '../services/api';
import { formatTimestamp } from '../utils/date';
import { getStoredUser } from '../auth';
import PageContainer from '../components/PageContainer';

/**
 * 租户管理页（仅平台管理员）
 *
 * 业务规则：一个租户 = 一个登录账号。
 *  - 新增租户时同时创建唯一账号（后端同一事务完成）
 *  - 删除租户会连带删除该租户的全部业务数据（站点/设备/历史数据/告警/推送）
 *  - 更换账号只替换账号，租户与业务数据全部保留
 */
const Tenants: React.FC = () => {
  const me = getStoredUser();
  const isPlatformOperator = me?.role === 'admin' && !me?.tenant_id;

  const [loading, setLoading] = useState(false);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [searchText, setSearchText] = useState('');

  // 新增租户弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm();
  const [creating, setCreating] = useState(false);

  // 编辑租户弹窗
  const [editOpen, setEditOpen] = useState(false);
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null);
  const [editForm] = Form.useForm();
  const [saving, setSaving] = useState(false);

  // 更换账号弹窗
  const [swapOpen, setSwapOpen] = useState(false);
  const [swapTenant, setSwapTenant] = useState<Tenant | null>(null);
  const [swapForm] = Form.useForm();
  const [swapping, setSwapping] = useState(false);

  // 删除确认弹窗
  const [delOpen, setDelOpen] = useState(false);
  const [delTenant, setDelTenant] = useState<Tenant | null>(null);
  const [delPreview, setDelPreview] = useState<TenantDeletePreview | null>(null);
  const [delLoading, setDelLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadTenants = useCallback(async () => {
    setLoading(true);
    try {
      const res = await tenantApi.list();
      if (res.data) setTenants(res.data);
    } catch (error: any) {
      message.error(error.message || '加载租户列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadTenants(); }, [loadTenants]);

  // 仅平台管理员可访问（防直输 URL；后端同样强制）
  if (!isPlatformOperator) {
    return <Navigate to="/" replace />;
  }

  /** 新增租户 + 唯一账号 */
  const handleCreate = async () => {
    try {
      const values = await createForm.validateFields();
      setCreating(true);
      await tenantApi.create({
        name: values.name.trim(),
        remark: values.remark?.trim() || undefined,
        username: values.username.trim(),
        password: values.password,
      });
      message.success(`租户「${values.name.trim()}」创建成功`);
      setCreateOpen(false);
      createForm.resetFields();
      loadTenants();
    } catch (error: any) {
      if (error?.errorFields) return;
      message.error(error.message || '创建租户失败');
    } finally {
      setCreating(false);
    }
  };

  /** 编辑租户信息 */
  const openEdit = (tenant: Tenant) => {
    setEditingTenant(tenant);
    editForm.setFieldsValue({
      name: tenant.name,
      remark: tenant.remark || '',
      status: tenant.status === 1,
    });
    setEditOpen(true);
  };

  const handleEdit = async () => {
    if (!editingTenant) return;
    try {
      const values = await editForm.validateFields();
      setSaving(true);
      await tenantApi.update(editingTenant.id, {
        name: values.name.trim(),
        remark: values.remark?.trim() || null,
        status: values.status ? 1 : 0,
      });
      message.success('租户已更新');
      setEditOpen(false);
      setEditingTenant(null);
      loadTenants();
    } catch (error: any) {
      if (error?.errorFields) return;
      message.error(error.message || '更新租户失败');
    } finally {
      setSaving(false);
    }
  };

  /** 更换账号 */
  const openSwap = (tenant: Tenant) => {
    setSwapTenant(tenant);
    swapForm.setFieldsValue({ username: '', password: '' });
    setSwapOpen(true);
  };

  const handleSwap = async () => {
    if (!swapTenant) return;
    try {
      const values = await swapForm.validateFields();
      setSwapping(true);
      await tenantApi.replaceAccount(swapTenant.id, {
        username: values.username.trim(),
        password: values.password || undefined,
      });
      message.success('账号已更换，租户业务数据全部保留');
      setSwapOpen(false);
      setSwapTenant(null);
      loadTenants();
    } catch (error: any) {
      if (error?.errorFields) return;
      message.error(error.message || '更换账号失败');
    } finally {
      setSwapping(false);
    }
  };

  /** 打开删除确认：先拉取该租户的数据统计 */
  const openDelete = async (tenant: Tenant) => {
    setDelTenant(tenant);
    setDelPreview(null);
    setDelOpen(true);
    setDelLoading(true);
    try {
      const res = await tenantApi.deletePreview(tenant.id);
      if (res.data) setDelPreview(res.data);
    } catch (error: any) {
      message.error(error.message || '获取租户数据统计失败');
    } finally {
      setDelLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!delTenant) return;
    try {
      setDeleting(true);
      const res = await tenantApi.remove(delTenant.id);
      message.success(res.message || '租户及其全部业务数据已删除');
      setDelOpen(false);
      setDelTenant(null);
      setDelPreview(null);
      loadTenants();
    } catch (error: any) {
      message.error(error.message || '删除租户失败');
    } finally {
      setDeleting(false);
    }
  };

  const filtered = tenants.filter((t) => {
    if (!searchText) return true;
    const s = searchText.toLowerCase();
    return t.name.toLowerCase().includes(s) || t.id.toLowerCase().includes(s);
  });

  const columns = [
    {
      title: '租户名称',
      dataIndex: 'name',
      key: 'name',
      width: 200,
      render: (name: string) => <span style={{ fontWeight: 500 }}>{name}</span>
    },
    {
      title: '绑定账号',
      dataIndex: 'username',
      key: 'username',
      width: 150,
      render: (username: string | null) =>
        username
          ? <Tag color="blue" style={{ borderRadius: 4 }}>{username}</Tag>
          : <span style={{ color: '#faad14' }}>未绑定账号</span>
    },
    {
      title: '站点数量',
      dataIndex: 'site_count',
      key: 'site_count',
      width: 100,
      render: (n: number) => <span>{n ?? 0} 个</span>
    },
    {
      title: '设备数量',
      dataIndex: 'device_count',
      key: 'device_count',
      width: 100,
      render: (n: number) => <span>{n ?? 0} 台</span>
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (status: number) => (
        status === 1
          ? <Tag color="green" style={{ borderRadius: 4 }}>启用</Tag>
          : <Tag style={{ borderRadius: 4 }}>停用</Tag>
      )
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (ts: number) => (
        <span style={{ fontSize: 12, color: '#666' }}>{formatTimestamp(ts)}</span>
      )
    },
    {
      title: '操作',
      key: 'action',
      width: 230,
      render: (_: any, record: Tenant) => (
        <Space size={4}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Button
            type="link"
            size="small"
            icon={<SwapOutlined />}
            onClick={() => openSwap(record)}
          >
            更换账号
          </Button>
          <Button
            type="link"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => openDelete(record)}
          >
            删除
          </Button>
        </Space>
      )
    }
  ];

  return (
    <PageContainer
      title="租户管理"
      actions={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新增租户
        </Button>
      }
      filters={
        <>
          <Input.Search
            placeholder="搜索租户名称"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{ width: 240 }}
            allowClear
          />
          <Button icon={<ReloadOutlined />} onClick={loadTenants} loading={loading}>刷新</Button>
        </>
      }
    >

        <Table
          columns={columns}
          dataSource={filtered}
          rowKey="id"
          loading={loading}
          scroll={{ x: 1000 }}
          pagination={{
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 个租户`
          }}
        />
      {/* 新增租户（同时创建唯一账号） */}
      <Modal
        title="新增租户"
        open={createOpen}
        onOk={handleCreate}
        onCancel={() => { setCreateOpen(false); createForm.resetFields(); }}
        confirmLoading={creating}
        okText="创建租户"
        cancelText="取消"
        width={520}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="一个租户对应一个登录账号，创建租户时会同时创建该账号（同一事务，不会出现半成品）。"
        />
        <Form form={createForm} layout="vertical">
          <Form.Item
            name="name"
            label="租户名称"
            rules={[
              { required: true, message: '请输入租户名称' },
              { max: 50, message: '不能超过50个字符' }
            ]}
          >
            <Input placeholder="如 江杰、测试公司" maxLength={50} />
          </Form.Item>
          <Form.Item
            name="remark"
            label="备注"
            rules={[{ max: 200, message: '不能超过200个字符' }]}
          >
            <Input placeholder="可选" maxLength={200} />
          </Form.Item>

          <Divider orientation="left" plain style={{ marginTop: 0 }}>租户账号</Divider>

          <Form.Item
            name="username"
            label="登录账号"
            rules={[
              { required: true, message: '请输入登录账号' },
              { pattern: /^[a-zA-Z0-9_]{3,32}$/, message: '账号需为 3~32 位字母、数字或下划线' }
            ]}
          >
            <Input placeholder="如 jj01" maxLength={32} autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="password"
            label="登录密码"
            rules={[
              { required: true, message: '请输入登录密码' },
              { min: 6, max: 64, message: '密码长度需在 6~64 位之间' }
            ]}
          >
            <Input.Password placeholder="6~64 位" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑租户 */}
      <Modal
        title={editingTenant ? `编辑租户：${editingTenant.name}` : '编辑租户'}
        open={editOpen}
        onOk={handleEdit}
        onCancel={() => { setEditOpen(false); setEditingTenant(null); }}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
      >
        <Form form={editForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="name"
            label="租户名称"
            rules={[
              { required: true, message: '请输入租户名称' },
              { max: 50, message: '不能超过50个字符' }
            ]}
          >
            <Input maxLength={50} />
          </Form.Item>
          <Form.Item name="remark" label="备注" rules={[{ max: 200, message: '不能超过200个字符' }]}>
            <Input.TextArea rows={2} maxLength={200} />
          </Form.Item>
          <Form.Item
            name="status"
            label="启用状态"
            valuePropName="checked"
            extra="停用只影响账号登录，不会删除该租户的任何业务数据"
          >
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 更换账号 */}
      <Modal
        title={swapTenant ? `更换账号：${swapTenant.name}` : '更换账号'}
        open={swapOpen}
        onOk={handleSwap}
        onCancel={() => { setSwapOpen(false); setSwapTenant(null); }}
        confirmLoading={swapping}
        okText="确认更换"
        cancelText="取消"
        width={520}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="更换后旧账号立即失效，只能存在一个当前账号。"
          description="该租户的站点、设备、历史数据、告警、推送配置与推送记录全部保留，不受影响。"
        />
        <Form form={swapForm} layout="vertical">
          <Form.Item
            name="username"
            label="新登录账号"
            rules={[
              { required: true, message: '请输入新的登录账号' },
              { pattern: /^[a-zA-Z0-9_]{3,32}$/, message: '账号需为 3~32 位字母、数字或下划线' }
            ]}
          >
            <Input placeholder="如 jj02" maxLength={32} autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="password"
            label="新登录密码"
            rules={[{ min: 6, max: 64, message: '密码长度需在 6~64 位之间' }]}
            extra="留空表示沿用原密码"
          >
            <Input.Password placeholder="留空则不修改密码" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 删除租户确认（显示将删除的数据量） */}
      <Modal
        title="删除租户"
        open={delOpen}
        onCancel={() => { setDelOpen(false); setDelTenant(null); setDelPreview(null); }}
        onOk={handleDelete}
        confirmLoading={deleting}
        okText="确认删除租户"
        okButtonProps={{ danger: true, disabled: delLoading || !delPreview }}
        cancelText="取消"
        width={520}
      >
        {delLoading && <div style={{ padding: '12px 0' }}>正在统计该租户的数据…</div>}
        {!delLoading && delPreview && (
          <div>
            <div style={{ fontSize: 15, marginBottom: 12 }}>
              确定删除租户 <b>【{delPreview.tenant_name}】</b> ？
            </div>
            <div style={{ background: '#fafafa', borderRadius: 6, padding: '12px 16px', marginBottom: 12 }}>
              <div style={{ marginBottom: 6, color: '#595959' }}>将删除：</div>
              <div>绑定账号：<b>{delPreview.username || '（未绑定）'}</b></div>
              <div>站点：<b>{delPreview.site_count}</b> 个</div>
              <div>设备：<b>{delPreview.device_count}</b> 台</div>
              <div>设备历史数据：<b>{delPreview.fsu_history_count}</b> 条</div>
              <div>电表字典：<b>{delPreview.meter_dict_count}</b> 条</div>
              <div>历史告警：<b>{delPreview.alarm_count}</b> 条</div>
              <div>推送配置：<b>{delPreview.notify_config_count}</b> 条</div>
              <div>推送记录：<b>{delPreview.push_log_count}</b> 条</div>
            </div>
            <Alert
              type="error"
              showIcon
              icon={<ExclamationCircleOutlined />}
              message="此操作会永久删除该租户及其全部业务数据，无法恢复。"
            />
          </div>
        )}
      </Modal>
    </PageContainer>
  );
};

export default Tenants;
