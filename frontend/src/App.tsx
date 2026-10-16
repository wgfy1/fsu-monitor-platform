import React, { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu, Tag, Dropdown, Modal, Form, Input, message, ConfigProvider } from 'antd';
import {
  DashboardOutlined,
  AppstoreOutlined,
  AlertOutlined,
  SendOutlined,
  EnvironmentOutlined,
  ApartmentOutlined,
  TeamOutlined,
  LogoutOutlined,
  KeyOutlined,
  DownOutlined
} from '@ant-design/icons';
import Dashboard from './pages/Dashboard';
import Sites from './pages/Sites';
import Tenants from './pages/Tenants';
import DeviceList from './pages/DeviceList';
import DeviceDetail from './pages/DeviceDetail';
import AlarmCenter from './pages/AlarmCenter';
import AlarmNotify from './pages/AlarmNotify';
import Login from './pages/Login';
import Users from './pages/Users';
import { User } from './types';
import { authApi } from './services/api';
import { getToken, getStoredUser, setAuth, clearAuth } from './auth';

const { Header, Content, Sider } = Layout;

/**
 * 是否可使用「告警推送」
 *  - 平台管理员：管理平台级配置，并可切换查看各租户
 *  - 有租户归属的账号（租户管理员 / 普通租户用户）：管理本租户配置
 * 与后端 /api/notify 的访问控制保持一致
 */
const canUseNotify = (user: User): boolean => user.role === 'admin' || !!user.tenant_id;

/**
 * 菜单项配置（按角色过滤）
 */
const MENU_ITEMS = (user: User) => [
  {
    key: '/',
    icon: <DashboardOutlined />,
    label: '首页'
  },
  {
    key: '/sites',
    icon: <EnvironmentOutlined />,
    label: '站点管理'
  },
  {
    key: '/devices',
    icon: <AppstoreOutlined />,
    label: '设备管理'
  },
  {
    key: '/alarms',
    icon: <AlertOutlined />,
    label: '告警中心'
  },
  // 告警推送：平台管理员（可切换各租户）与租户账号（含普通租户用户，只能配置本租户）
  // 无权访问的账号（无租户归属的非管理员）由后端拒绝，前端也不展示入口
  ...(canUseNotify(user)
    ? [{
        key: '/notify',
        icon: <SendOutlined />,
        label: '告警推送'
      }]
    : []),
  // 租户管理：仅平台管理员（租户账号看不到，后端同样强制 requirePlatformAdmin）
  ...(user.role === 'admin' && !user.tenant_id
    ? [{
        key: '/tenants',
        icon: <ApartmentOutlined />,
        label: '租户管理'
      }]
    : []),
  ...(user.role === 'admin'
    ? [{
        key: '/users',
        icon: <TeamOutlined />,
        label: '用户管理'
      }]
    : [])
];

/** 修改密码弹窗 */
const ChangePasswordModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await authApi.changePassword(values.oldPassword, values.newPassword);
      message.success('密码修改成功');
      onClose();
      form.resetFields();
    } catch (error: any) {
      message.error(error.message || '密码修改失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="修改密码"
      open={open}
      onOk={handleOk}
      onCancel={() => { onClose(); form.resetFields(); }}
      confirmLoading={submitting}
      okText="确定"
      cancelText="取消"
    >
      <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
        <Form.Item
          name="oldPassword"
          label="原密码"
          rules={[{ required: true, message: '请输入原密码' }]}
        >
          <Input.Password placeholder="请输入原密码" autoComplete="off" />
        </Form.Item>
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
  );
};

/**
 * 应用主布局组件（包裹在Router内部使用导航hook）
 */
const AppLayout: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [user, setUser] = useState<User | null>(() => getStoredUser());
  const [pwdModalOpen, setPwdModalOpen] = useState(false);

  // 挂载时刷新用户信息（管理员改了角色/状态后刷新页面即时生效；token 失效由拦截器 401 兜底跳转）
  useEffect(() => {
    authApi.me().then((res) => {
      if (res.data) {
        const token = getToken();
        if (token) setAuth(token, res.data);
        setUser(res.data);
      }
    }).catch(() => { /* 401 由拦截器统一处理 */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 登录守卫：未登录 → 跳转登录页
  if (!user || !getToken()) {
    return <Navigate to="/login" replace />;
  }

  // 当前激活的菜单key：取路径的第一段。
  // 首页的 pathname 是 '/'，取不到任何段 —— 必须回落到 '/'，
  // 否则会拼出 '/undefined'，首页时菜单一项都不高亮。
  // 子路径（如 /devices/xxx 设备详情）同样归属其一级菜单。
  const firstSegment = location.pathname.split('/').filter(Boolean)[0];
  const selectedKey = firstSegment ? `/${firstSegment}` : '/';

  const handleLogout = () => {
    authApi.logout().catch(() => { /* 无状态登出，忽略失败 */ });
    clearAuth();
    message.success('已退出登录');
    navigate('/login', { replace: true });
  };

  return (
    /* 应用框架：整体锁定为一屏高，浏览器窗口不再被页面内容撑长。
       外层 Layout 横向排列 → 左侧 Sidebar 从页面最顶端一直延伸到底部，
       右侧是独立的竖向 Layout（Header + Content），白色 Header 只属于右侧主体，
       不横跨左侧导航。滚动只发生在 Content 或页面内部的指定区域。 */
    <Layout style={{ height: '100vh', overflow: 'hidden' }}>
      <Sider width={200} className="app-sider">
        {/* 平台名称固定在最顶部（属于侧栏深色区域），菜单区内部滚动 */}
        <div className="app-sider__logo">基站监控平台</div>
        <div className="app-sider__menu">
          {/* 深蓝绿侧栏配色：只作用于本侧栏的菜单，不影响页面里的其它 Menu */}
          <ConfigProvider
            theme={{
              components: {
                Menu: {
                  darkItemBg: '#0B3D50',        // 侧栏背景
                  darkSubMenuItemBg: '#0B3D50',
                  darkPopupBg: '#0B3D50',
                  darkItemColor: '#E6F0F4',     // 普通菜单文字
                  darkItemHoverBg: '#14516A',   // 悬停背景
                  darkItemHoverColor: '#FFFFFF',
                  darkItemSelectedBg: '#174E6B',// 选中背景
                  darkItemSelectedColor: '#FFFFFF',
                  itemMarginInline: 8,
                  itemBorderRadius: 6,
                  itemHeight: 42
                }
              }
            }}
          >
            <Menu
              theme="dark"
              mode="inline"
              selectedKeys={[selectedKey]}
              style={{ background: 'transparent', borderRight: 0 }}
              items={MENU_ITEMS(user)}
              onClick={({ key }) => navigate(key)}
            />
          </ConfigProvider>
        </div>
      </Sider>
      <Layout style={{ minWidth: 0, overflow: 'hidden' }}>
        <Header
          style={{
            flexShrink: 0,
            background: '#fff',
            padding: '0 24px',
            borderBottom: '1px solid #f0f0f0',
            display: 'flex',
            alignItems: 'center'
          }}
        >
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
            <Tag color={user.role === 'admin' ? 'gold' : 'blue'} style={{ borderRadius: 4, marginInlineEnd: 0 }}>
              {user.role === 'admin' ? '管理员' : '普通用户'}
            </Tag>
            <Dropdown
              menu={{
                // 租户账号（存在 tenant_id）不提供自助修改密码，菜单里不出现该项；
                // 后端 /api/auth/change-password 也会拒绝，前端隐藏仅为体验一致
                items: [
                  ...(user.tenant_id
                    ? []
                    : [
                        { key: 'change-password', icon: <KeyOutlined />, label: '修改密码' },
                        { type: 'divider' as const }
                      ]),
                  { key: 'logout', icon: <LogoutOutlined />, label: '退出登录' }
                ],
                onClick: ({ key }) => {
                  if (key === 'logout') handleLogout();
                  if (key === 'change-password') setPwdModalOpen(true);
                }
              }}
            >
              <span style={{ cursor: 'pointer', fontSize: 14, color: '#333', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {/* 只显示登录账号（users.username） */}
                {user.username}
                <DownOutlined style={{ fontSize: 10, color: '#999' }} />
              </span>
            </Dropdown>
          </div>
        </Header>
        <Content style={{ background: '#f0f2f5', padding: 24 }}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/sites" element={<Sites />} />
            <Route path="/devices" element={<DeviceList />} />
            <Route path="/devices/:id" element={<DeviceDetail />} />
            <Route path="/alarms" element={<AlarmCenter />} />
            {/* 与后端 /api/notify 的访问控制对齐：无权限账号直达该路径回首页 */}
            <Route
              path="/notify"
              element={canUseNotify(user) ? <AlarmNotify /> : <Navigate to="/" replace />}
            />
            {/* 与后端 /api/tenants 的 requirePlatformAdmin 对齐 */}
            <Route
              path="/tenants"
              element={user.role === 'admin' && !user.tenant_id ? <Tenants /> : <Navigate to="/" replace />}
            />
            <Route path="/users" element={<Users />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Content>
      </Layout>

      <ChangePasswordModal open={pwdModalOpen} onClose={() => setPwdModalOpen(false)} />
    </Layout>
  );
};

/**
 * 应用主组件
 */
const App: React.FC = () => {
  return (
    <Router>
      <Routes>
        {/* 登录页独立布局 */}
        <Route path="/login" element={<Login />} />
        {/* 其余路由进入主布局（内部有登录守卫） */}
        <Route path="/*" element={<AppLayout />} />
      </Routes>
    </Router>
  );
};

export default App;
