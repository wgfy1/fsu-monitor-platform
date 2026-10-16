import React from 'react';
import { Card } from 'antd';

interface PageContainerProps {
  /**
   * 页面标题（统一 20px 加粗，位于白色卡片内工具栏的最左侧）。
   * 不传表示本页不需要工具栏行（如首页：地图与统计卡片直接铺满，
   * 顶部不再单独占一张"标题卡"）。
   */
  title?: string;
  /** 可选的一句话说明；确实有必要时才传（渲染在标题下方） */
  description?: React.ReactNode;
  /** 右侧主要操作按钮（主操作 primary，危险操作 danger），贴在工具栏最右端 */
  actions?: React.ReactNode;
  /** 筛选/搜索区：与标题同处一行工具栏的中部 */
  filters?: React.ReactNode;
  /** 是否让工具栏与内容共用同一张卡片：列表页保持默认 true；自带卡片的页面（如首页）传 false */
  card?: boolean;
  /**
   * 是否让容器填满内容视口高度（超出部分由内部指定区域滚动，而不是整页滚动）。
   * 默认跟随 card：列表页 true（工具栏固定，表格区内部滚动）；
   * 长详情页保持 false（由主内容区自然纵向滚动）。
   */
  fill?: boolean;
  children: React.ReactNode;
}

/**
 * 后台页面统一容器
 *
 * 布局：**工具栏与内容同处一张白色卡片**，灰色页面背景上不再直接摆放标题或操作栏。
 *
 *   card={true}（列表页，默认）
 *   ┌──────────────────────────────────────────────────────────┐  ← .page-container__main
 *   │ 站点管理  [搜索框] [刷新] …………………  [新增站点]          │     （单张白卡）
 *   ├──────────────────────────────────────────────────────────┤
 *   │  数据表格                                                 │
 *   │  分页（右下角）                                           │
 *   └──────────────────────────────────────────────────────────┘
 *
 *   card={false}（首页 / 设备详情 / 告警推送等自带卡片的页面）
 *   ┌──────────────────────────────────────────────────────────┐  ← .page-container__toolbar
 *   │ 设备详情  台州电信9（…） ……………………  [返回列表] [刷新]   │     （工具栏独立成卡）
 *   └──────────────────────────────────────────────────────────┘
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  页面自带的卡片……                                         │
 *   └──────────────────────────────────────────────────────────┘
 *
 * 宽度不足时由工具栏中部的筛选区在内部换行，标题与操作区始终保持在首行两端，
 * 不会出现控件重叠或横向溢出。
 *
 * 不承载任何业务逻辑，仅做布局与视觉规范。
 */
const PageContainer: React.FC<PageContainerProps> = ({
  title,
  description,
  actions,
  filters,
  card = true,
  fill,
  children,
}) => {
  // 只有标题、没有筛选也没有操作时，这一行没有任何可交互内容——不渲染，
  // 避免在内容区顶部多出一条空的白色标题条（首页就是这种情况）。
  const hasToolbar = !!title || !!filters || !!actions;

  const toolbar = (
    <div className="page-toolbar">
      <div className="page-toolbar__heading">
        {title && <h1 className="page-toolbar__title">{title}</h1>}
        {description && <div className="page-toolbar__desc">{description}</div>}
      </div>
      {filters && <div className="page-toolbar__filters">{filters}</div>}
      {actions && <div className="page-toolbar__actions">{actions}</div>}
    </div>
  );

  return (
    <div className={`page-container${(fill ?? card) ? ' page-container--fill' : ''}`}>
      {card ? (
        // 列表页：工具栏与表格、分页同在**同一张**白卡内，
        // 不会出现"工具栏一张卡、表格另一张卡"的分裂。
        <Card className="page-container__main">
          {hasToolbar && toolbar}
          {children}
        </Card>
      ) : (
        // 自带卡片的页面：工具栏独立成卡，视觉与页面自身的卡片一致。
        <>
          {hasToolbar && <Card className="page-container__toolbar">{toolbar}</Card>}
          {children}
        </>
      )}
    </div>
  );
};

export default PageContainer;
