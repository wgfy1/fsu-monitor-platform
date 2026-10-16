import React, { useState, useEffect, useCallback } from 'react';
import { Card, Tag, Space, message, Button, InputNumber, Form, Switch, Checkbox, Input, Table, Select } from 'antd';
import {
  SendOutlined,
  ReloadOutlined,
  BellOutlined,
  SaveOutlined
} from '@ant-design/icons';
import { notifyApi } from '../services/api';
import { AlarmPushLog, NotifyChannel } from '../types';
import { formatTimestamp } from '../utils/date';
import { getStoredUser } from '../auth';
import PageContainer from '../components/PageContainer';

const CHANNEL_LABEL: Record<NotifyChannel, string> = {
  dingtalk: '钉钉',
  sms: '短信'
};

const CHANNEL_COLOR: Record<NotifyChannel, string> = {
  dingtalk: 'blue',
  sms: 'gold'
};

const STATUS_LABEL: Record<AlarmPushLog['status'], { text: string; color: string }> = {
  success: { text: '成功', color: 'green' },
  failed: { text: '失败', color: 'red' },
  skipped: { text: '跳过', color: 'default' }
};

/** 告警推送配置卡片
 * @param tenantId 当前管理的租户（平台管理员可切换；租户账号恒为自身，由后端强制）
 * @param canTest  是否显示「发送测试推送」（仅平台管理员；后端同样校验，见 routes/notify.ts）
 */
const NotifyConfigCard: React.FC<{ tenantId?: string | null; canTest: boolean }> = ({ tenantId, canTest }) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  // 当前勾选的通道（决定钉钉/短信字段区显隐）
  const channels: string[] = Form.useWatch('channels', form) || [];

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await notifyApi.getConfig(tenantId);
      const c = res.data;
      if (c) {
        form.setFieldsValue({
          enabled: !!c.enabled,
          channels: [
            ...(c.dingtalk_enabled ? ['dingtalk'] : []),
            ...(c.sms_enabled ? ['sms'] : [])
          ],
          dingtalk_webhook: c.dingtalk_webhook || '',
          dingtalk_secret: c.dingtalk_secret || '',
          sms_numbers: c.sms_numbers || '',
          dedupe_minutes: c.dedupe_minutes
        });
      }
    } catch (error: any) {
      message.error(error.message || '加载推送配置失败');
    } finally {
      setLoading(false);
    }
  }, [tenantId, form]);

  // 切换租户时重新加载该租户的配置（各租户配置互相隔离）
  useEffect(() => { loadConfig(); }, [loadConfig]);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const channelList: string[] = values.channels || [];
      await notifyApi.updateConfig({
        enabled: values.enabled ? 1 : 0,
        dingtalk_enabled: channelList.includes('dingtalk') ? 1 : 0,
        dingtalk_webhook: (values.dingtalk_webhook || '').trim(),
        dingtalk_secret: (values.dingtalk_secret || '').trim(),
        sms_enabled: channelList.includes('sms') ? 1 : 0,
        sms_numbers: (values.sms_numbers || '').trim(),
        dedupe_minutes: values.dedupe_minutes ?? 30
      }, tenantId);
      message.success('推送配置已保存');
      loadConfig();
    } catch (error: any) {
      if (error?.errorFields) return; // 表单校验失败，交由表单展示
      message.error(error.message || '保存推送配置失败');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await notifyApi.testSend(tenantId);
      const results = res.data || [];
      if (results.length === 0) message.warning('未配置推送通道');
      results.forEach((r) => {
        const label = CHANNEL_LABEL[r.channel];
        if (r.status === 'success') message.success(`${label}：${r.detail}`);
        else message.warning(`${label}：${r.detail}`);
      });
    } catch (error: any) {
      message.error(error.message || '测试推送失败');
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card
      className="notify-config-card"
      title={<Space><BellOutlined />告警推送配置</Space>}
      loading={loading}
    >
      <Form
        form={form}
        layout="vertical"
        // 紧凑型配置区：字段由 CSS 排成 3 列网格（.notify-config-form），
        // 不再限宽 800，也不再一列到底占满整个纵向空间。
        className="notify-config-form"
        initialValues={{ enabled: false, channels: [], dedupe_minutes: 30 }}
      >
        <Form.Item name="enabled" label="启用推送" valuePropName="checked">
          <Switch checkedChildren="开" unCheckedChildren="关" />
        </Form.Item>

        <Form.Item name="channels" label="推送通道">
          <Checkbox.Group
            options={[
              { label: '钉钉群机器人', value: 'dingtalk' },
              { label: '短信', value: 'sms' }
            ]}
          />
        </Form.Item>

        {/* 三个全局配置项排在第 1 行（横向），通道专属字段排在其后 */}
        <Form.Item name="dedupe_minutes" label="同源去重窗口">
          <InputNumber min={1} max={1440} addonAfter="分钟" style={{ width: 160 }} />
        </Form.Item>

        {channels.includes('dingtalk') && (
          <>
            <Form.Item
              name="dingtalk_webhook"
              label="钉钉群机器人 Webhook 地址"
              className="notify-field--wide"
              rules={[{ required: true, message: '请输入钉钉群机器人 Webhook 地址' }]}
            >
              <Input.Password
                placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
                autoComplete="new-password"
                visibilityToggle
              />
            </Form.Item>
            <Form.Item name="dingtalk_secret" label="加签密钥（可选）">
              <Input.Password
                placeholder="机器人安全设置开启「加签」时填写，未开启留空"
                autoComplete="new-password"
              />
            </Form.Item>
          </>
        )}

        {channels.includes('sms') && (
          <Form.Item
            name="sms_numbers"
            label="短信接收手机号"
            className="notify-field--wide"
          >
            <Input.TextArea rows={2} placeholder="13800138000, 13900139000" />
          </Form.Item>
        )}

        {/* 操作按钮跟随最后一个字段所在的网格行，不再单独占一整行 */}
        <Space>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSave}
            loading={saving}
          >
            保存配置
          </Button>
          {canTest && (
            <Button
              icon={<SendOutlined />}
              onClick={handleTest}
              loading={testing}
              disabled={channels.length === 0}
            >
              发送测试推送
            </Button>
          )}
        </Space>
      </Form>
    </Card>
  );
};

/** 推送记录卡片（最近 50 条）
 * @param tenantId 指定租户；@param allTenants 平台管理员查看全部租户
 */
const PushLogsCard: React.FC<{ tenantId?: string | null; allTenants?: boolean }> = ({ tenantId, allTenants }) => {
  const [logs, setLogs] = useState<AlarmPushLog[]>([]);
  const [loading, setLoading] = useState(false);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await notifyApi.listLogs({ limit: 50, tenantId, all: allTenants });
      if (res.data) setLogs(res.data);
    } catch (error: any) {
      message.error(error.message || '加载推送记录失败');
    } finally {
      setLoading(false);
    }
  }, [tenantId, allTenants]);

  useEffect(() => { loadLogs(); }, [loadLogs]);

  const columns = [
    // 原「ID」列已按需求移除（alarm_push_logs.id 字段保留，仅页面不展示）
    {
      title: '通道',
      dataIndex: 'channel',
      key: 'channel',
      width: 70,
      render: (channel: NotifyChannel) => (
        <Tag color={CHANNEL_COLOR[channel]} style={{ borderRadius: 4 }}>{CHANNEL_LABEL[channel]}</Tag>
      )
    },
    {
      title: '类型',
      dataIndex: 'action',
      key: 'action',
      width: 80,
      render: (action: string) => (
        <Tag color={action === 'test' ? 'geekblue' : 'purple'} style={{ borderRadius: 4 }}>
          {action === 'test' ? '测试' : '告警推送'}
        </Tag>
      )
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 70,
      render: (status: AlarmPushLog['status']) => {
        const cfg = STATUS_LABEL[status];
        return <Tag color={cfg.color} style={{ borderRadius: 4 }}>{cfg.text}</Tag>;
      }
    },
    {
      title: '目标',
      dataIndex: 'target',
      key: 'target',
      width: 170,
      ellipsis: true
    },
    {
      title: '告警内容',
      key: 'content',
      width: 240,
      render: (_: any, record: AlarmPushLog) => (
        <div>
          {record.device_id && (
            <span style={{ fontSize: 13, color: '#999', fontFamily: 'var(--font-mono)', marginRight: 6 }}>
              {record.device_id}
            </span>
          )}
          {record.severity && (
            <Tag
              color={record.severity === 'critical' ? 'red' : 'orange'}
              style={{ marginInlineEnd: 4 }}
            >
              {record.severity === 'critical' ? '严重' : '警告'}
            </Tag>
          )}
          <span style={{ fontSize: 13, color: '#666' }}>{record.message}</span>
        </div>
      )
    },
    {
      title: '详情',
      dataIndex: 'detail',
      key: 'detail',
      width: 200,
      ellipsis: { showTitle: true }
    },
    {
      title: '时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 150,
      render: (ts: number) => (
        <span style={{ fontSize: 13, color: '#666', fontFamily: 'var(--font-mono)' }}>{formatTimestamp(ts)}</span>
      )
    }
  ];

  return (
    <Card
      className="push-logs-card"
      title="推送记录"
      extra={
        <Button icon={<ReloadOutlined />} onClick={loadLogs} loading={loading}>
          刷新
        </Button>
      }
    >
      <Table
        columns={columns}
        dataSource={logs}
        rowKey="id"
        size="small"
        loading={loading}
        pagination={false}
        locale={{ emptyText: '暂无推送记录' }}
      />
    </Card>
  );
};

/**
 * 告警推送页（独立功能模块）
 * 上：推送通道配置（钉钉群机器人 / 短信预留）；下：推送记录留痕
 * 数据来源：/api/notify/*，与告警落库链路完全解耦——推送失败不影响告警正常记录
 *
 * 租户隔离：
 *  - 租户账号：只能看到并配置本租户的推送（后端按登录态强制，无租户选择器）
 *  - 平台管理员：可切换查看平台级或任一租户的配置与记录
 *
 * 页面可见范围（仅前端展示层，后端另行校验）：
 *  - 平台管理员：配置 + 推送记录 + 发送测试推送
 *  - 其他账号：只保留推送配置（不给「推送记录」卡片，也不给「发送测试推送」按钮）
 */
const AlarmNotify: React.FC = () => {
  const me = getStoredUser();
  const isPlatformOperator = me?.role === 'admin' && !me?.tenant_id;

  // 平台管理员：'' = 平台级配置；其他 = 指定租户
  const [selectedTenant, setSelectedTenant] = useState<string>('');
  const [tenants, setTenants] = useState<string[]>([]);

  useEffect(() => {
    if (!isPlatformOperator) return;
    notifyApi.listTenants()
      .then((res) => { if (res.data) setTenants(res.data.map((t) => t.tenantId)); })
      .catch(() => { /* 租户列表加载失败不阻塞页面 */ });
  }, [isPlatformOperator]);

  const tenantId = isPlatformOperator ? (selectedTenant || null) : null;

  return (
    <PageContainer
      title="告警推送"
      // 「管理范围」是筛选条件而非操作：与标题同处工具栏，放在搜索/筛选区，
      // 右侧操作区留给真正的动作按钮（本页当前没有）。
      filters={
        isPlatformOperator ? (
          <Space wrap>
            <span style={{ color: 'var(--text-body)', fontSize: 13 }}>管理范围</span>
            <Select
              style={{ width: 240 }}
              value={selectedTenant}
              onChange={setSelectedTenant}
              options={[
                { value: '', label: '平台级配置（平台自有设备）' },
                ...tenants.map((t) => ({ value: t, label: `租户：${t}` }))
              ]}
            />
          </Space>
        ) : undefined
      }
      card={false}
      fill
    >
      {/* 配置区按内容高度，推送记录区占满剩余高度并**内部滚动**：
          记录再多也不会把整页撑长，表头保持可见 */}
      <div className="alarm-notify-page">
        <NotifyConfigCard tenantId={tenantId} canTest={isPlatformOperator} />
        {isPlatformOperator && <PushLogsCard tenantId={tenantId} allTenants={false} />}
      </div>
    </PageContainer>
  );
};

export default AlarmNotify;
