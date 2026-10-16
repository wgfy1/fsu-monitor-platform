import React, { useState, useEffect, useCallback } from 'react';
import { Row, Col, Card } from 'antd';
import { deviceApi, siteApi, alarmApi } from '../services/api';
import { Site } from '../types';
import PageContainer from '../components/PageContainer';
import SiteMap from '../components/SiteMap';

/**
 * 首页 · 基站总览
 *
 * 布局：左侧「站点分布」地图（占主要宽度、高度占满剩余区域）
 *      + 右侧「设备状态 / 告警统计 / 站点状态」三张卡片纵向均分同一高度
 * 数据全部来自已有接口：/api/devices、/api/sites、/api/alarms/stats
 *
 * 说明：本页不提供独立刷新按钮，刷新请直接使用浏览器刷新。
 */

/** 主体区域最小高度：低于此值时由主内容区纵向滚动，避免地图被压得过小 */
const MAIN_MIN_HEIGHT = 420;

/** 紧凑统计行（左标签右数值，数字突出） */
const StatRow: React.FC<{
  label: string;
  value: React.ReactNode;
  tone?: 'online' | 'alarm' | 'error' | 'idle';
}> = ({ label, value, tone }) => (
  <div className="stat-row">
    <span className="stat-row__label">{label}</span>
    <span className={`stat-row__value${tone ? ` stat-row__value--${tone}` : ''}`}>{value}</span>
  </div>
);

const Dashboard: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [totalDevices, setTotalDevices] = useState(0);
  const [onlineCount, setOnlineCount] = useState(0);
  const [offlineCount, setOfflineCount] = useState(0);
  // byLevel = 未解决告警按**厂家原始 alarmLevel**（1~5）的分布，FSU 告警的唯一定级口径
  const [alarmStats, setAlarmStats] = useState<{
    unresolved: number; byLevel: Record<string, number>; withoutLevel: number;
  }>({ unresolved: 0, byLevel: {}, withoutLevel: 0 });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [devRes, siteRes, alarmRes] = await Promise.all([
        deviceApi.list(),
        siteApi.list().catch(() => ({ data: null })),
        alarmApi.stats().catch(() => ({ data: null }))
      ]);

      if (devRes.data) {
        const devices: any[] = devRes.data;
        setTotalDevices(devices.length);
        setOnlineCount(devices.filter((d) => d.status === 'online').length);
        setOfflineCount(devices.filter((d) => d.status === 'offline').length);
      }
      if ((siteRes as any).data) setSites((siteRes as any).data);
      if ((alarmRes as any).data) {
        const a = (alarmRes as any).data;
        setAlarmStats({
          unresolved: a.unresolved ?? 0,
          // FSU 告警的级别用厂家原始 alarmLevel；平台不再把它映射成严重/警告
          byLevel: a.byLevel ?? {},
          withoutLevel: a.withoutLevel ?? 0
        });
      }
    } catch (error) {
      console.error('加载首页数据失败:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  /* 站点状态：按后端计算的 status 归类 */
  const siteNormal = sites.filter((s) => s.status === 'normal').length;
  const siteAlarm = sites.filter((s) => s.status === 'alarm').length;
  const siteOffline = sites.filter((s) => s.status === 'offline').length;

  return (
    // 不传 title：首页不再有独立的"基站总览"标题卡片，地图与统计卡片直接铺满内容区
    <PageContainer card={false}>
      {/* 主体：左地图（约 2/3）+ 右侧三块统计（约 1/3），整体占满剩余高度 */}
      <Row gutter={[16, 16]} style={{ flex: 1, minHeight: MAIN_MIN_HEIGHT }}>
        <Col xs={24} lg={16}>
          {/* 站点总数放在卡片标题栏右侧，与「站点分布」同一行；
              高度改挂在卡片**整体**上（body 用 flex 撑满），随剩余空间自动伸缩。
              地图视野不受影响：SiteMap 仍使用自身默认中心与 zoom。 */}
          <Card
            title="站点分布"
            className="dashboard-map-card"
            style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
            styles={{ body: { flex: 1, minHeight: 0, padding: 12, display: 'flex', flexDirection: 'column' } }}
            extra={
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                站点总数
                <b style={{ margin: '0 4px', fontSize: 15, fontWeight: 600, color: 'var(--text-title)' }}>
                  {sites.length}
                </b>
                个
              </span>
            }
          >
            <SiteMap sites={sites} loading={loading} />
          </Card>
        </Col>

        {/* 右侧三块统计：等分与地图卡片同一高度，页面不出现无意义空白 */}
        <Col xs={24} lg={8}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
            <Card
              title="设备状态"
              className="dashboard-stat-card"
              style={{ flex: 1, minHeight: 0 }}
              styles={{ body: { padding: '0 16px', display: 'flex', flexDirection: 'column', justifyContent: 'center' } }}
              loading={loading}
            >
              <div className="stat-list">
                <StatRow label="设备总数" value={`${totalDevices} 台`} />
                <StatRow label="在线" value={onlineCount} tone="online" />
                <StatRow label="离线" value={offlineCount} tone={offlineCount > 0 ? 'error' : 'idle'} />
              </div>
            </Card>

            <Card
              title="告警统计"
              className="dashboard-stat-card"
              style={{ flex: 1, minHeight: 0 }}
              styles={{ body: { padding: '0 16px', display: 'flex', flexDirection: 'column', justifyContent: 'center' } }}
              loading={loading}
            >
              <div className="stat-list">
                {/* 级别一律用**厂家原始 alarmLevel**（协议 4.4，1~5）。
                    平台不把 1~5 映射成"严重/警告"—— 厂家文档没有给出这个对应关系。 */}
                <StatRow
                  label="未解决"
                  value={alarmStats.unresolved}
                  tone={alarmStats.unresolved > 0 ? 'error' : 'idle'}
                />
                {['1', '2', '3', '4', '5'].map((lv) => (
                  <StatRow
                    key={lv}
                    label={`级别 ${lv}`}
                    value={alarmStats.byLevel[lv] ?? 0}
                    tone={(alarmStats.byLevel[lv] ?? 0) > 0 ? 'alarm' : 'idle'}
                  />
                ))}
              </div>
            </Card>

            <Card
              title="站点状态"
              className="dashboard-stat-card"
              style={{ flex: 1, minHeight: 0 }}
              styles={{ body: { padding: '0 16px', display: 'flex', flexDirection: 'column', justifyContent: 'center' } }}
              loading={loading}
            >
              <div className="stat-list">
                <StatRow label="正常站点" value={siteNormal} tone="online" />
                <StatRow label="告警站点" value={siteAlarm} tone={siteAlarm > 0 ? 'error' : 'idle'} />
                <StatRow label="离线站点" value={siteOffline} tone="idle" />
              </div>
            </Card>
          </div>
        </Col>
      </Row>
    </PageContainer>
  );
};

export default Dashboard;
