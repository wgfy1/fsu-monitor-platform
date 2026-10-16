import React, { useEffect, useRef, useState } from 'react';
import { Spin } from 'antd';
import { useNavigate } from 'react-router-dom';
import { Site } from '../types';

/**
 * 站点分布（真实地图）
 *
 * 地图方案：高德地图 JS API 2.0
 *  - Key 与安全密钥来自**环境变量**，不硬编码进源码：
 *      REACT_APP_AMAP_KEY            高德 JS API Key
 *      REACT_APP_AMAP_SECURITY_CODE  安全密钥（2021-12 之后申请的 Key 必填）
 *  - 未配置 Key 时地图区域保留占位，不影响页面其他功能
 *  - 站点经纬度为空则不渲染 Marker（不做任何坐标猜测）
 *  - 坐标系：GCJ-02（高德/腾讯坐标）
 *
 * 视野策略（固定视野，不自动适配）：
 *  - 地图**始终**使用初始化时设定的默认中心与缩放级别，站点只作为 Marker 叠加显示
 *  - 站点数量为 0 / 1 / 多个，都不触发视野变化（无 fitBounds / setFitView / setZoom / setCenter）
 *  - 组件重渲染、重新进入首页、站点数据刷新，均不会改变当前中心与缩放
 *  - 用户手动拖动或缩放后，代码不会将其重置
 */

declare global {
  interface Window {
    AMap: any;
    _AMapSecurityConfig?: { securityJsCode: string };
  }
}

const AMAP_KEY = process.env.REACT_APP_AMAP_KEY || '';
const AMAP_SECURITY_CODE = process.env.REACT_APP_AMAP_SECURITY_CODE || '';

/** 脚本只加载一次，多个页面引用时复用同一个 Promise */
let amapLoading: Promise<any> | null = null;

function loadAMap(): Promise<any> {
  if (amapLoading) return amapLoading;
  amapLoading = new Promise((resolve, reject) => {
    if (window.AMap) {
      resolve(window.AMap);
      return;
    }
    if (AMAP_SECURITY_CODE) {
      window._AMapSecurityConfig = { securityJsCode: AMAP_SECURITY_CODE };
    }
    const script = document.createElement('script');
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(AMAP_KEY)}`;
    script.async = true;
    script.onload = () => {
      if (window.AMap) resolve(window.AMap);
      else reject(new Error('高德地图初始化失败'));
    };
    script.onerror = () => reject(new Error('高德地图脚本加载失败'));
    document.head.appendChild(script);
  });
  return amapLoading;
}

/** 站点状态 → Marker 配色（只表达状态） */
const MARKER_COLOR: Record<string, string> = {
  normal: '#389e0d',
  alarm: '#cf1322',
  offline: '#8c8c8c',
  unassigned: '#bfbfbf',
};

interface SiteMapProps {
  sites: Site[];
  loading?: boolean;
}

const SiteMap: React.FC<SiteMapProps> = ({ sites, loading }) => {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const infoWindowRef = useRef<any>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  const located = sites.filter(
    (s) => typeof s.latitude === 'number' && typeof s.longitude === 'number'
  );

  /* ── 初始化地图（仅一次）── */
  useEffect(() => {
    if (!AMAP_KEY) return;
    let cancelled = false;

    loadAMap()
      .then((AMap) => {
        if (cancelled || !containerRef.current || mapRef.current) return;
        mapRef.current = new AMap.Map(containerRef.current, {
          zoom: 4,
          center: [104.2, 35.8], // 中国中心
          zooms: [3, 18],
          dragEnable: true,
          zoomEnable: true,
          scrollWheel: true,
          doubleClickZoom: true,
        });
        setMapReady(true);
      })
      .catch((err) => {
        if (!cancelled) setMapError(err?.message || '地图加载失败');
      });

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.destroy();
        mapRef.current = null;
      }
    };
  }, []);

  /* ── 站点变化时重绘 Marker ── */
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    const AMap = window.AMap;

    // 清除旧 Marker 与信息窗体
    if (markersRef.current.length > 0) {
      map.remove(markersRef.current);
      markersRef.current = [];
    }
    if (infoWindowRef.current) {
      infoWindowRef.current.close();
      infoWindowRef.current = null;
    }

    markersRef.current = located.map((site) => {
      const lng = site.longitude as number;
      const lat = site.latitude as number;
      const color = MARKER_COLOR[site.status || 'unassigned'] || MARKER_COLOR.unassigned;

      const marker = new AMap.Marker({
        position: [lng, lat],
        anchor: 'center',
        content: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.15);cursor:pointer"></div>`,
      });

      marker.on('click', () => {
        const total = site.device_count ?? 0;
        const online = site.online_count ?? 0;
        const alarms = site.alarm_count ?? 0;

        // 信息窗体：只展示数据 + 跳转，无解释文字
        const box = document.createElement('div');
        box.style.minWidth = '190px';
        box.innerHTML = `
          <div style="font-weight:600;font-size:14px;color:rgba(0,0,0,.88);margin-bottom:8px">${site.name}</div>
          <div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0"><span style="color:rgba(0,0,0,.45)">设备总数</span><span style="font-weight:600">${total} 台</span></div>
          <div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0"><span style="color:rgba(0,0,0,.45)">在线设备</span><span style="font-weight:600;color:#389e0d">${online}</span></div>
          <div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0"><span style="color:rgba(0,0,0,.45)">离线设备</span><span style="font-weight:600;color:#8c8c8c">${Math.max(0, total - online)}</span></div>
          <div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0"><span style="color:rgba(0,0,0,.45)">告警数量</span><span style="font-weight:600;color:${alarms > 0 ? '#cf1322' : 'rgba(0,0,0,.88)'}">${alarms}</span></div>
          <a style="display:inline-block;margin-top:6px;font-size:13px;color:#1677ff;cursor:pointer">查看站点</a>
        `;
        const link = box.querySelector('a');
        link?.addEventListener('click', () => {
          navigate('/sites', { state: { expandSiteId: site.id } });
        });

        if (infoWindowRef.current) infoWindowRef.current.close();
        infoWindowRef.current = new AMap.InfoWindow({
          content: box,
          offset: new AMap.Pixel(0, -12),
        });
        infoWindowRef.current.open(map, [lng, lat]);
      });

      return marker;
    });

    if (markersRef.current.length > 0) {
      map.add(markersRef.current);
      // 注意：**不做任何视野调整**（不调用 setFitView / setZoom / setCenter）。
      // 地图中心与缩放级别永远取自初始化时设定的默认值，
      // 站点数量为 0 / 1 / 多 个都不影响视野，用户手动拖动或缩放后也不会被重置。
    }
  }, [mapReady, sites, navigate, located.length]);

  /* ── 未配置 Key：保留地图区域占位 ── */
  if (!AMAP_KEY) {
    return (
      <div
        style={{
          flex: 1, minHeight: 320, background: '#fafbfc', borderRadius: 6,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, color: 'rgba(0,0,0,.45)',
        }}
      >
        未配置地图密钥（REACT_APP_AMAP_KEY）
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 320, borderRadius: 6, overflow: 'hidden' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', minHeight: 320 }} />

      {/* 地图加载中 / 加载失败：保留底图区域 */}
      {!mapReady && !mapError && (
        <div
          style={{
            position: 'absolute', inset: 0, background: '#fafbfc',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Spin />
        </div>
      )}
      {mapError && (
        <div
          style={{
            position: 'absolute', inset: 0, background: '#fafbfc',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, color: 'rgba(0,0,0,.45)',
          }}
        >
          {mapError}
        </div>
      )}

      {/* 无坐标站点：轻量提示，地图底图照常显示 */}
      {mapReady && !loading && located.length === 0 && (
        <div
          style={{
            position: 'absolute', top: 12, left: 12,
            background: 'rgba(255,255,255,.92)', border: '1px solid #f0f0f0',
            borderRadius: 4, padding: '3px 10px', fontSize: 12, color: 'rgba(0,0,0,.45)',
          }}
        >
          暂无站点位置
        </div>
      )}

      {/* 状态图例 */}
      {mapReady && located.length > 0 && (
        <div
          style={{
            position: 'absolute', left: 12, bottom: 12,
            background: 'rgba(255,255,255,.92)', border: '1px solid #f0f0f0',
            borderRadius: 4, padding: '4px 10px', display: 'flex', gap: 14,
          }}
        >
          {([['normal', '正常'], ['alarm', '告警'], ['offline', '离线']] as const).map(([k, label]) => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'rgba(0,0,0,.45)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: MARKER_COLOR[k] }} />
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

export default SiteMap;
