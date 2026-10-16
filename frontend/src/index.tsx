import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import './styles/global.css';
import App from './App';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          // 字体栈与 global.css 的 --font-sans / --font-mono 同源（同一组 CSS 变量），
          // 保证 antd 组件（Table/Input/Select/Button/Tag/Pagination）与页面自定义元素
          // 使用完全一致的字体，避免"组件内一套、组件外一套"。
          fontFamily: 'var(--font-sans)',
          fontFamilyCode: 'var(--font-mono)',
        },
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
);