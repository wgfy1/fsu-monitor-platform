/**
 * 子设备通信状态图标 —— 组件级验证
 *
 * 覆盖：
 *   1) 厂家上报 online / offline 时的展示；
 *   2) 字段缺失、空值、非法取值一律显示「未知」，绝不默认成在线或离线；
 *   3) 不只靠颜色：同时有中文文字与 aria-label；
 *   4) 组件是纯展示，不依赖告警/网关状态等任何推断输入。
 *
 * 运行：cd frontend && CI=true npx react-scripts test --watchAll=false
 */
import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import CommStatusTag, { normalizeCommStatus } from '../CommStatusTag';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (global as any).IS_REACT_ACT_ENVIRONMENT = true;
  // antd 组件在 jsdom 下需要这两个浏览器 API
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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

/** 渲染并返回组件文字（复用同一个 root，避免重复 createRoot 的告警） */
async function renderText(status?: string | null): Promise<string> {
  await act(async () => {
    root.render(<CommStatusTag status={status} />);
  });
  return (container.textContent || '').trim();
}

describe('子设备通信状态图标', () => {
  it('厂家上报 online → 显示「在线」', async () => {
    expect(await renderText('online')).toBe('在线');
  });

  it('厂家上报 offline → 显示「离线」', async () => {
    expect(await renderText('offline')).toBe('离线');
  });

  it('字段缺失 → 显示「未知」，不会被默认成在线或离线', async () => {
    const text = await renderText(undefined);
    expect(text).toBe('未知');
    expect(text).not.toBe('在线');
    expect(text).not.toBe('离线');
  });

  it('空值 / 非法取值 → 一律「未知」', async () => {
    for (const raw of [null, '', 'ONLINE', '1', '0', 'true', 'unknown', 'offline ']) {
      const text = await renderText(raw as any);
      expect(text).toBe('未知');
    }
  });

  it('不只靠颜色：带中文文字与 aria-label 可访问性标签', async () => {
    await act(async () => {
      root.render(<CommStatusTag status="offline" />);
    });
    const el = container.querySelector('[role="status"]') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.getAttribute('aria-label')).toBe('通信状态：离线');
    // 同时渲染了图标（svg）与文字
    expect(el.querySelector('svg')).toBeTruthy();
    expect((el.textContent || '').trim()).toBe('离线');
  });

  describe('normalizeCommStatus', () => {
    it('只把厂家明确定义的两个值当作已知状态', () => {
      expect(normalizeCommStatus('online')).toBe('online');
      expect(normalizeCommStatus('offline')).toBe('offline');
    });

    it('其余输入全部归为 unknown', () => {
      for (const raw of [undefined, null, '', 0, 1, 'unknown', 'Online', {}, []]) {
        expect(normalizeCommStatus(raw)).toBe('unknown');
      }
    });
  });
});
