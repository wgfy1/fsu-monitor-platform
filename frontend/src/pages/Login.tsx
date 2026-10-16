import React, { useEffect } from 'react';
import { Card, Form, Input, Button, message } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../services/api';
import { getToken, setAuth } from '../auth';

/**
 * 登录页（独立布局，无侧边栏）
 */
const Login: React.FC = () => {
  const navigate = useNavigate();
  const [form] = Form.useForm();

  // 已登录用户访问登录页 → 直接进入系统
  useEffect(() => {
    if (getToken()) {
      navigate('/', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = async (values: { username: string; password: string }) => {
    try {
      const res = await authApi.login(values.username.trim(), values.password);
      if (res.data) {
        setAuth(res.data.token, res.data.user);
        message.success('登录成功');
        navigate('/', { replace: true });
      }
    } catch (error: any) {
      message.error(error.message || '登录失败');
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f0f2f5',
      }}
    >
      <Card style={{ width: 380, borderRadius: 8, boxShadow: '0 2px 12px rgba(0,0,0,0.08)' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 13, color: '#999', letterSpacing: 0.5 }}>杭州江杰信息科技有限公司</div>
          <div style={{ fontSize: 22, fontWeight: 'bold', color: '#333', marginTop: 6 }}>基站监控平台</div>
        </div>
        <Form form={form} onFinish={handleSubmit} size="large">
          <Form.Item
            name="username"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input prefix={<UserOutlined style={{ color: '#bfbfbf' }} />} placeholder="用户名" autoComplete="off" />
          </Form.Item>
          <Form.Item
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password prefix={<LockOutlined style={{ color: '#bfbfbf' }} />} placeholder="密码" autoComplete="off" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" block>
              登 录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
};

export default Login;
