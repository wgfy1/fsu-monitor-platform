/**
 * 告警中心「子设备」筛选 —— 组件级验证
 *
 * 验证的不是"能不能编译"，而是筛选功能本身：
 *   1) 下拉选项来自**后端返回的字典**（/api/alarms/sub-devices），逐个 devId 渲染；
 *   2) 选项里**没有**旧的 battery/ac/dc/env/door 硬编码分类；
 *   3) 没有告警的子设备同样出现在选项里（因为选项不是从告警列表提取的）；
 *   4) 选中某子设备后，列表请求带的参数是 `devId=<厂家 devId>`；
 *   5) 切回「全部」时不带子设备参数；
 *   6) 级别列展示原始 alarmLevel；缺失时显示"未定级"，不出现内部枚举 vendor；
 *   7) 界面上不出现"厂家"字样。
 *
 * 运行：cd frontend && CI=true npx react-scripts test --watchAll=false
 */
import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import AlarmCenter from '../AlarmCenter';
import { alarmApi } from '../../services/api';

jest.mock('../../services/api', () => ({
  alarmApi: {
    list: jest.fn(),
    subDevices: jest.fn(),
    resolve: jest.fn(),
    remove: jest.fn(),
    removeBatch: jest.fn(),
  },
  // 其他 api 导出保持存在（组件树里可能间接引用）
  deviceApi: {},
  siteApi: {},
  tenantApi: {},
  notifyApi: {},
  configApi: {},
  authApi: {},
  usersApi: {},
  regionApi: {},
  healthApi: {},
}));

const mockedList = alarmApi.list as unknown as jest.Mock;
const mockedSubDevices = alarmApi.subDevices as unknown as jest.Mock;

/** 后端字典返回的筛选项（含一个当前**没有任何告警**的子设备） */
const DICT_OPTIONS = [
  { devId: '1061001', devName: '48V蓄电池', alarmPointCount: 34 },
  { devId: '1064001', devName: '48V交流屏_JJ', alarmPointCount: 16 },
  { devId: '1120001', devName: '数字温湿度_CT_JJ', alarmPointCount: 5 },
  { devId: '1246001', devName: '门磁_CT_JJ', alarmPointCount: 1 },
  { devId: '2060001', devName: '48V直流屏_JJ', alarmPointCount: 2 },
];

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // React 18 并发模式下 jsdom 需要显式声明 act 环境（否则刷屏告警，不影响结果）
  (global as any).IS_REACT_ACT_ENVIRONMENT = true;
  // antd v5 在 jsdom 下需要这两个浏览器 API
  (global as any).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
  (window as any).matchMedia = (window as any).matchMedia || ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  }));
});

beforeEach(async () => {
  jest.clearAllMocks();
  mockedSubDevices.mockResolvedValue({
    data: { options: DICT_OPTIONS, conflicts: [] },
  });
  mockedList.mockResolvedValue({
    data: {
      items: [
        {
          id: 1, device_id: '00534c080213', type: '1246001', severity: 'vendor',
          message: '门磁开关状态告警', value: '12160021001', resolved: 0,
          resolved_at: null, created_at: Math.floor(Date.now() / 1000),
          serial_no: '9101', alarm_level: 3, is_history: 0, dev_name: '门磁_CT_JJ',
        },
        {
          id: 2, device_id: '00534c080213', type: '2060001', severity: 'vendor',
          message: '直流输出电压过低告警', value: '22060021001', resolved: 0,
          resolved_at: null, created_at: Math.floor(Date.now() / 1000),
          serial_no: '9102', alarm_level: null, is_history: 0, dev_name: '48V直流屏_JJ',
        },
      ],
      total: 2,
    },
  });

  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<MemoryRouter><AlarmCenter /></MemoryRouter>);
  });
  // 等 subDevices / list 的 Promise 落地
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

/**
 * 打开「子设备」下拉并取出全部选项文本
 *
 * 页面上有多个 antd Select（处理状态 / 子设备），这里按**当前显示值**定位：
 * 子设备下拉默认选中「全部」，因此找文本为「全部」的那个 select。
 */
async function openSelectAndReadOptions(): Promise<string[]> {
  const selects = Array.from(container.querySelectorAll('.ant-select')) as HTMLElement[];
  const target = selects.find((s) => (s.textContent || '').trim() === '全部');
  expect(target).toBeTruthy();
  const selector = target!.querySelector('.ant-select-selector') as HTMLElement;
  await act(async () => {
    selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  });
  await act(async () => { await Promise.resolve(); });
  return Array.from(document.querySelectorAll('.ant-select-item-option-content'))
    .map((n) => (n.textContent || '').trim());
}

describe('告警中心 · 子设备筛选（字典驱动）', () => {
  it('挂载时从后端字典接口拉取筛选项', () => {
    expect(mockedSubDevices).toHaveBeenCalledTimes(1);
  });

  it('下拉选项 = 全部 + 字典里的 5 个子设备（devName 作显示名，devId 作值）', async () => {
    const labels = await openSelectAndReadOptions();
    expect(labels).toEqual([
      '全部',
      '48V蓄电池',
      '48V交流屏_JJ',
      '数字温湿度_CT_JJ',
      '门磁_CT_JJ',
      '48V直流屏_JJ',
    ]);
  });

  it('没有告警的子设备（1061001 等）同样出现在选项里 —— 选项源自字典而非告警列表', async () => {
    const labels = await openSelectAndReadOptions();
    // 列表里只有 1246001 / 2060001 两条告警，但 5 个子设备一个不少
    expect(labels).toContain('48V蓄电池');
    expect(labels).toContain('48V交流屏_JJ');
    expect(labels).toContain('数字温湿度_CT_JJ');
  });

  it('选项里不再有旧的硬编码分类（battery/ac/dc/env/door 及其中文名）', async () => {
    const labels = await openSelectAndReadOptions();
    const html = container.innerHTML + document.body.innerHTML;
    for (const legacy of ['battery', 'door', 'env']) {
      expect(html).not.toContain(`value="${legacy}"`);
    }
    expect(labels).not.toContain('电池');
    expect(labels).not.toContain('交流');
    expect(labels).not.toContain('门磁'); // 只有"门磁_CT_JJ"这种字典名
  });

  it('界面文案不出现"厂家"，也不直接显示内部枚举 vendor', () => {
    const html = container.innerHTML;
    expect(html).not.toContain('厂家');
    expect(html).not.toContain('vendor');
  });

  it('级别列展示协议原始 alarmLevel；缺失时显示"未定级"', () => {
    const html = container.innerHTML;
    expect(html).toContain('级别 3');
    expect(html).toContain('未定级');
  });

  it('选中某子设备并查询 → 列表请求带 devId=<厂家 devId>；切回「全部」→ 不带该参数', async () => {
    // 初始查询（挂载时）：不带子设备条件
    expect(mockedList).toHaveBeenCalled();
    expect(mockedList.mock.calls[0][0].devId).toBeUndefined();

    // 打开下拉并选中「门磁_CT_JJ」
    const selects = Array.from(container.querySelectorAll('.ant-select')) as HTMLElement[];
    const target = selects.find((s) => (s.textContent || '').trim() === '全部')!;
    await act(async () => {
      target.querySelector('.ant-select-selector')!.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0 })
      );
    });
    const option = Array.from(document.querySelectorAll('.ant-select-item-option'))
      .find((n) => (n.textContent || '').includes('门磁_CT_JJ')) as HTMLElement;
    expect(option).toBeTruthy();
    await act(async () => {
      option.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });

    // 点「查询」使条件生效
    mockedList.mockClear();
    // 注意：antd 会在两个汉字的按钮文案间自动插空格（"查 询"），比较时去空白
    const btnByText = (label: string) =>
      Array.from(container.querySelectorAll('button'))
        .find((b) => (b.textContent || '').replace(/\s/g, '') === label) as HTMLElement;
    const searchBtn = btnByText('查询');
    expect(searchBtn).toBeTruthy();
    await act(async () => { searchBtn.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(mockedList).toHaveBeenCalledTimes(1);
    expect(mockedList.mock.calls[0][0].devId).toBe('1246001');

    // 切回「全部」→ devId 不再下发
    mockedList.mockClear();
    await act(async () => { searchBtn.click(); }); // 先确保状态稳定
    const resetBtn = btnByText('重置');
    expect(resetBtn).toBeTruthy();
    await act(async () => { resetBtn.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(mockedList).toHaveBeenCalled();
    expect(mockedList.mock.calls[mockedList.mock.calls.length - 1][0].devId).toBeUndefined();
  });
});
