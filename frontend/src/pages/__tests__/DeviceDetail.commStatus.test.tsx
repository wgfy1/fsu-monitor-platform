/**
 * 设备详情页 · 五个子设备卡片的通信状态图标
 *
 * 验证 GET /api/devices/:id/sub-device-comm-status 返回的 subDevices
 * 被正确映射到五张卡片：
 *   - online → 在线、offline → 离线；
 *   - status=unknown 或该 devId 未出现在返回里 → 未知（不默认在线/离线）；
 *   - 原有卡片标题与「详情」入口仍在（图标不影响布局结构）。
 *
 * 数据来源约定：状态只来自厂家心跳 4.2 的 online/offline，不看告警、不看网关状态。
 * 运行：cd frontend && CI=true npx react-scripts test --watchAll=false
 */
import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

jest.mock('../../services/api', () => {
  const ok = (data: any) => () => Promise.resolve({ code: 0, data, message: 'ok' });
  const now = Date.now();
  return {
    deviceApi: {
      detail: ok({
        id: '00534c080213', name: '台州电信13', status: 'online', activationStatus: 'active',
        softwareVersion: 'V1.0.0', device_sn: '00534c080213', last_seen: now,
        latestMeters: {}, site_name: 'XX路基站',
      }),
      // 后端按字典返回全部功能子设备；这里刻意让 2060001 / 1246001 缺失，
      // 用来验证"没返回的 devId 显示未知"。
      subDeviceCommStatus: ok({
        deviceId: '00534c080213', lastHeartbeatAt: now,
        subDevices: [
          { devId: '1061001', devName: '48V蓄电池', status: 'online', lastHeartbeatAt: now },
          { devId: '1064001', devName: '48V交流屏_JJ', status: 'offline', lastHeartbeatAt: now },
          { devId: '1120001', devName: '数字温湿度_CT_JJ', status: 'unknown', lastHeartbeatAt: now },
        ],
      }),
      ntpConfig: ok({ enabled: false, intervalHours: 24, intervalOptions: [1, 2, 4, 8, 12, 24] }),
      remoteMeterOptions: ok({ options: [], dictAvailable: false }),
      fsuHistory: ok([]),
      update: ok({}), updateNtpConfig: ok({}),
    },
    alarmApi: {
      list: () => Promise.resolve({ code: 0, data: { items: [], total: 0 }, message: 'ok' }),
      resolve: ok({}), stats: ok({}),
    },
    siteApi: ok([]), tenantApi: ok([]), notifyApi: ok({}), usersApi: ok([]),
    configApi: ok({}), authApi: ok({}), healthApi: ok({}), regionApi: ok([]),
    default: {},
  };
});

jest.mock('../../auth', () => ({
  getStoredUser: () => ({ id: 1, username: 'admin', role: 'admin', tenant_id: null }),
  getToken: () => 't', setAuth: () => {}, clearAuth: () => {},
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const DeviceDetail = require('../DeviceDetail').default;

beforeAll(() => {
  (global as any).IS_REACT_ACT_ENVIRONMENT = true;
  (global as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (window as any).matchMedia = (window as any).matchMedia || ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  }));
});

it('五个子设备卡片各有一个通信状态标签，缺失项显示未知', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={['/devices/00534c080213']}>
        <Routes><Route path="/devices/:id" element={<DeviceDetail />} /></Routes>
      </MemoryRouter>
    );
  });
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });

  const tags = Array.from(container.querySelectorAll('.comm-status')) as HTMLElement[];
  const texts = tags.map((t) => (t.textContent || '').trim());

  expect(tags.length).toBe(5);
  expect(texts.filter((t) => t === '在线').length).toBe(1);
  expect(texts.filter((t) => t === '离线').length).toBe(1);
  expect(texts.filter((t) => t === '未知').length).toBe(3);
  // 原有卡片标题仍然存在（图标没有顶掉原有信息）
  expect(container.textContent).toContain('电池信息');
  expect(container.textContent).toContain('门磁/门禁');

  await act(async () => { root.unmount(); });
  container.remove();
}, 60000);
