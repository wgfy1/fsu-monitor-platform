import React, { useState, useEffect } from 'react';
import { Table, Button, Space, Tag, Modal, Form, Input, Select, Switch, Popconfirm, message } from 'antd';
import { PlusOutlined, ReloadOutlined, EditOutlined, DeleteOutlined, KeyOutlined } from '@ant-design/icons';
import { Navigate } from 'react-router-dom';
import { User, UserRole } from '../types';
import { usersApi, tenantApi } from '../services/api';
import { formatTimestamp } from '../utils/date';
import { getStoredUser } from '../auth';
import PageContainer from '../components/PageContainer';

const ROLE_LABEL: Record<UserRole, { text: string; color: string }> = {
  admin: { text: '管理员', color: 'gold' },
  user: { text: '普通用户', color: 'blue' },
};

const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,32}$/;

/**
 * 用户管理页（仅管理员）
 */
const Users: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  // 可绑定的租户（未绑定账号的租户；一个租户最多一个用户）
  const [availableTenants, setAvailableTenants] = useState<{ id: string; name: string }[]>([]);

  // 创建弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm();
  const [creating, setCreating] = useState(false);

  // 编辑弹窗
  const [editOpen, setEditOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editForm] = Form.useForm();
  const [editing, setEditing] = useState(false);

  // 重置密码弹窗
  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdUser, setPwdUser] = useState<User | null>(null);
  const [pwdForm] = Form.useForm();
  const [pwdSubmitting, setPwdSubmitting] = useState(false);

  const me = getStoredUser();

  const loadUsers = async () => {
    setLoading(true);
    try {
      const res = await usersApi.list();
      if (res.data) setUsers(res.data);
    } catch (error: any) {
      message.error(error.message || '加载用户列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadUsers(); }, []);

  // 每次打开新增弹窗都重新拉取，保证已被占用的租户不会出现在下拉里
  useEffect(() => {
    if (!createOpen) return;
    tenantApi.available()
      .then((res) => { if (res.data) setAvailableTenants(res.data); })
      .catch(() => { /* 加载失败不阻塞弹窗，下拉为空即可 */ });
  }, [createOpen]);

  // 管理员访问守卫（防直输 URL）
  if (me?.role !== 'admin') {
    return <Navigate to="/" replace />;
  }

  /** 用户名/密码公共校验项 */
  const passwordRules = [
    { required: true, message: '请输入密码' },
    { min: 6, max: 64, message: '密码长度需在 6~64 位之间' }
  ];

  const handleCreate = async () => {
    try {
      const values = await createForm.validateFields();
      setCreating(true);
      await usersApi.create({
        username: values.username.trim(),
        password: values.password,
        role: values.role,
        // name 字段已从界面移除（数据库保留该列，不再要求用户填写）
        // 平台管理员可指定归属租户（下拉选择正式租户ID；租户管理员后端强制本租户，此字段被忽略）
        tenantId: values.tenantId || undefined,
      });
      message.success('创建用户成功');
      setCreateOpen(false);
      createForm.resetFields();
      loadUsers();
    } catch (error: any) {
      message.error(error.message || '创建用户失败');
    } finally {
      setCreating(false);
    }
  };

  const handleEdit = async () => {
    if (!editingUser) return;
    try {
      const values = await editForm.validateFields();
      setEditing(true);
      // name 字段已从界面移除：不再提交，保持库中已有值不变
      await usersApi.update(editingUser.id, {
        role: values.role,
        status: values.status ? 1 : 0,
      });
      message.success('更新用户成功');
      setEditOpen(false);
      setEditingUser(null);
      loadUsers();
    } catch (error: any) {
      message.error(error.message || '更新用户失败');
    } finally {
      setEditing(false);
    }
  };

  const handleResetPassword = async () => {
    if (!pwdUser) return;
    try {
      const values = await pwdForm.validateFields();
      setPwdSubmitting(true);
      await usersApi.resetPassword(pwdUser.id, values.newPassword);
      message.success('密码重置成功');
      setPwdOpen(false);
      setPwdUser(null);
      pwdForm.resetFields();
    } catch (error: any) {
      message.error(error.message || '密码重置失败');
    } finally {
      setPwdSubmitting(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await usersApi.remove(id);
      message.success('删除用户成功');
      loadUsers();
    } catch (error: any) {
      message.error(error.message || '删除用户失败');
    }
  };

  const columns = [
    {
      title: '用户名',
      dataIndex: 'username',
      key: 'username',
      render: (username: string) => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{username}</span>
    },
    {
      // 归属租户显示正式租户名称（tenants.name）；平台管理员显示"平台"
      title: '所属租户',
      dataIndex: 'tenant_name',
      key: 'tenant_name',
      width: 150,
      render: (tenantName: string | null | undefined) =>
        tenantName
          ? <Tag color="geekblue" style={{ borderRadius: 4 }}>{tenantName}</Tag>
          : <span style={{ color: '#999' }}>平台</span>
    },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      width: 100,
      render: (role: UserRole) => {
        const cfg = ROLE_LABEL[role] || { text: role, color: 'default' };
        return <Tag color={cfg.color} style={{ borderRadius: 4 }}>{cfg.text}</Tag>;
      }
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (status: number) => (
        <Tag color={status === 1 ? 'green' : 'red'} style={{ borderRadius: 4 }}>
          {status === 1 ? '启用' : '禁用'}
        </Tag>
      )
    },
    {
      title: '最后登录',
      dataIndex: 'last_login_at',
      key: 'last_login_at',
      width: 170,
      render: (ts: number | null) => (
        ts != null
          ? <span style={{ fontSize: 13, color: '#999', fontFamily: 'var(--font-mono)' }}>{formatTimestamp(ts)}</span>
          : <span style={{ color: '#999' }}>-</span>
      )
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 170,
      render: (ts: number) => (
        <span style={{ fontSize: 13, color: '#999', fontFamily: 'var(--font-mono)' }}>{formatTimestamp(ts)}</span>
      )
    },
    {
      title: '操作',
      key: 'action',
      width: 210,
      render: (_: any, record: User) => {
        const isSelf = record.id === me?.id;
        return (
          <Space size={4}>
            <Button
              type="link"
              size="small"
              icon={<EditOutlined />}
              onClick={() => {
                setEditingUser(record);
                editForm.setFieldsValue({
                  role: record.role,
                  status: record.status === 1,
                });
                setEditOpen(true);
              }}
            >
              编辑
            </Button>
            <Button
              type="link"
              size="small"
              icon={<KeyOutlined />}
              onClick={() => {
                setPwdUser(record);
                setPwdOpen(true);
              }}
            >
              重置密码
            </Button>
            {/* 租户账号不提供"删除"：一个租户 = 一个账号，
                单独删账号会留下"有租户没有账号"的孤儿租户。
                需要清理整个租户请走「租户管理 → 删除租户」。 */}
            {!isSelf && !record.tenant_id && (
              <Popconfirm
                title={`确定删除用户 ${record.username} 吗？`}
                description="删除后该账号将无法登录，此操作不可恢复"
                okText="删除"
                okType="danger"
                cancelText="取消"
                onConfirm={() => handleDelete(record.id)}
              >
                <Button type="link" danger size="small" icon={<DeleteOutlined />}>
                  删除
                </Button>
              </Popconfirm>
            )}
          </Space>
        );
      }
    }
  ];

  return (
    <PageContainer
      title="用户管理"
      actions={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={loadUsers} loading={loading}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建用户
          </Button>
        </Space>
      }
    >
      <Table
        columns={columns}
        dataSource={users}
        rowKey="id"
        loading={loading}
        pagination={false}
      />

      {/* 新建用户 */}
      <Modal
        title="新建用户"
        open={createOpen}
        onOk={handleCreate}
        onCancel={() => { setCreateOpen(false); createForm.resetFields(); }}
        confirmLoading={creating}
        okText="创建"
        cancelText="取消"
      >
        <Form form={createForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="username"
            label="用户名"
            rules={[
              { required: true, message: '请输入用户名' },
              { pattern: USERNAME_REGEX, message: '3~32 位字母、数字或下划线' }
            ]}
          >
            <Input placeholder="如 zhangsan" maxLength={32} autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={passwordRules}
          >
            <Input.Password placeholder="6~64 位" autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="确认密码"
            dependencies={['password']}
            rules={[
              { required: true, message: '请再次输入密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('password') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('两次输入的密码不一致'));
                }
              })
            ]}
          >
            <Input.Password placeholder="再次输入密码" autoComplete="off" />
          </Form.Item>
          <Form.Item name="role" label="角色" initialValue="user">
            <Select
              options={[
                { value: 'user', label: '普通用户' },
                { value: 'admin', label: '管理员' }
              ]}
            />
          </Form.Item>
          {/* 归属租户：仅平台管理员建号时可见，且只能从未绑定账号的租户中选择
              （一个租户最多绑定一个用户，已绑定的租户不会出现在下拉里） */}
          {!me?.tenant_id && (
            <Form.Item
              name="tenantId"
              label="归属租户"
              tooltip="只能选择尚未绑定账号的租户；留空则创建平台运维账号。"
              extra={availableTenants.length === 0
                ? '当前没有可绑定的租户（租户均已有账号，或尚未创建租户）'
                : undefined}
            >
              <Select
                placeholder="选择租户（留空=平台运维账号）"
                allowClear
                showSearch
                optionFilterProp="label"
                options={availableTenants.map((t) => ({ value: t.id, label: t.name }))}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* 编辑用户 */}
      <Modal
        title={`编辑用户 - ${editingUser?.username || ''}`}
        open={editOpen}
        onOk={handleEdit}
        onCancel={() => { setEditOpen(false); setEditingUser(null); }}
        confirmLoading={editing}
        okText="保存"
        cancelText="取消"
      >
        <Form form={editForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="role"
            label="角色"
            extra={editingUser?.id === me?.id ? '不能修改自己的角色' : undefined}
          >
            <Select
              disabled={editingUser?.id === me?.id}
              options={[
                { value: 'user', label: '普通用户' },
                { value: 'admin', label: '管理员' }
              ]}
            />
          </Form.Item>
          <Form.Item
            name="status"
            label="启用状态"
            valuePropName="checked"
            extra={editingUser?.id === me?.id ? '不能禁用自己' : undefined}
          >
            <Switch checkedChildren="启用" unCheckedChildren="禁用" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 重置密码 */}
      <Modal
        title={`重置密码 - ${pwdUser?.username || ''}`}
        open={pwdOpen}
        onOk={handleResetPassword}
        onCancel={() => { setPwdOpen(false); setPwdUser(null); pwdForm.resetFields(); }}
        confirmLoading={pwdSubmitting}
        okText="重置"
        cancelText="取消"
      >
        <Form form={pwdForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 6, max: 64, message: '密码长度需在 6~64 位之间' }
            ]}
          >
            <Input.Password placeholder="6~64 位" autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="确认新密码"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('newPassword') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('两次输入的密码不一致'));
                }
              })
            ]}
          >
            <Input.Password placeholder="再次输入新密码" autoComplete="off" />
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
};

export default Users;
