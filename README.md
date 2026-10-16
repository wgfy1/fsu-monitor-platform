# FSU设备监控可视化平台

## 概述

FSU设备监控可视化平台。厂家 FSU 网关通过 MQTT（`gw/v1/#`）上报设备数据与告警，
平台解析后落库，提供设备状态监控、实时/历史数据查询、告警管理与推送等功能。

## 技术栈

- **后端**: Node.js + Express + TypeScript + SQLite
- **前端**: React + TypeScript + Ant Design + Recharts
- **部署**: Docker + Docker Compose

## 项目结构

```
fsu-monitor-platform/
│
├── backend/                    # 后端服务（同时托管前端构建产物，单端口部署）
│   ├── src/
│   │   ├── index.ts            # 入口文件（启动 HTTP + MQTT）
│   │   ├── app.ts              # Express应用配置
│   │   ├── routes/             # HTTP 路由
│   │   │   ├── health.ts       # 通用健康检查（GET /webhook/health）
│   │   │   ├── devices.ts      # 设备API
│   │   │   ├── alarms.ts       # 告警API
│   │   │   ├── notify.ts       # 告警推送配置与记录API（仅管理员）
│   │   │   ├── sites.ts        # 站点API
│   │   │   ├── tenants.ts      # 租户API
│   │   │   ├── users.ts        # 用户API
│   │   │   ├── regions.ts      # 行政区划API
│   │   │   ├── auth.ts         # 登录认证API
│   │   │   └── config.ts       # 平台配置API
│   │   ├── mqtt/               # MQTT 接入层
│   │   │   ├── broker.ts       # 内置 Broker（aedes），厂家协议主处理路径
│   │   │   ├── client.ts       # 平台 MQTT 客户端（指令下发 / 外部 Broker 兜底订阅）
│   │   │   ├── messageHandler.ts # 上行消息统一入口
│   │   │   └── deviceMap.ts    # mac → 平台设备ID 映射
│   │   ├── protocols/fsu/      # 厂家 FSU 协议适配层（gw/v1/#）
│   │   │   ├── index.ts        # 上行路由入口（同一网关串行处理）
│   │   │   ├── handlers.ts     # login / heartbeat / dataReport / alarmReport / ntp
│   │   │   ├── downstream.ts   # 平台下行指令（getData / getAlarm / setData / reboot / ota）
│   │   │   ├── mapping.ts      # 厂家测量点映射
│   │   │   ├── session.ts      # 会话与 serialNo 去重
│   │   │   ├── topics.ts       # Topic 常量
│   │   │   ├── codec.ts        # 报文编解码
│   │   │   ├── expire.ts       # 消息过期过滤
│   │   │   └── types.ts
│   │   ├── services/           # 业务逻辑
│   │   │   ├── deviceService.ts
│   │   │   ├── dataService.ts
│   │   │   ├── alarmService.ts
│   │   │   └── notifyService.ts # 告警推送（钉钉/短信，与告警落库解耦）
│   │   ├── models/
│   │   │   └── database.ts     # 数据库初始化
│   │   ├── middleware/
│   │   │   └── auth.ts         # 登录态与角色校验
│   │   ├── utils/
│   │   │   ├── response.ts     # 统一响应格式
│   │   │   ├── alarmRules.ts   # 告警类型名称映射
│   │   │   ├── jwt.ts
│   │   │   └── mqttCredentials.ts
│   │   └── types/
│   │       └── index.ts        # TypeScript类型
│   ├── scripts/
│   │   └── fsu-protocol-test/  # 厂家协议模拟器与端到端验收脚本（独立临时库，不碰生产数据）
│   ├── data/                   # SQLite数据库文件
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── .env.example
│
├── frontend/                   # 前端应用
│   ├── src/
│   │   ├── App.tsx             # 主应用+路由
│   │   ├── index.tsx           # 入口文件
│   │   ├── pages/              # 页面
│   │   │   ├── Dashboard.tsx   # 仪表盘
│   │   │   ├── DeviceList.tsx  # 设备列表
│   │   │   ├── DeviceDetail.tsx # 设备详情
│   │   │   ├── AlarmCenter.tsx # 告警中心
│   │   │   ├── AlarmNotify.tsx # 告警推送（仅管理员）
│   │   │   ├── Sites.tsx       # 站点管理
│   │   │   ├── Tenants.tsx     # 租户管理（仅平台管理员）
│   │   │   ├── Users.tsx       # 用户管理（仅管理员）
│   │   │   └── Login.tsx       # 登录页
│   │   ├── components/         # 组件
│   │   │   ├── StatCard.tsx
│   │   │   ├── DeviceStatusTag.tsx
│   │   │   ├── HistoryChart.tsx  # 历史曲线（按厂家 devId + meterId 取数）
│   │   │   ├── PageContainer.tsx
│   │   │   └── SiteMap.tsx
│   │   ├── services/
│   │   │   └── api.ts          # API调用封装
│   │   ├── utils/
│   │   │   ├── date.ts         # 日期处理
│   │   │   ├── format.tsx
│   │   │   └── meterMapping.ts # 测量点取值映射
│   │   └── types/
│   │       └── index.ts        # TypeScript类型
│   ├── public/
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── nginx.conf
│
├── docker-compose.yml
├── .env.example
└── README.md
```

## 本地开发

### 前提条件

- Node.js 18+
- npm 8+

### 1. 克隆项目

```bash
git clone <项目地址>
cd fsu-monitor-platform
```

### 2. 后端启动

```bash
cd backend
npm install
npm run dev
```

后端服务将在 http://localhost:3001 启动。

### 3. 前端启动

```bash
cd frontend
npm install
npm start
```

前端应用将在 http://localhost:3000 启动，API请求会自动代理到后端3001端口。

### 4. 厂家协议验收（可选）

`backend/scripts/fsu-protocol-test/` 提供厂家协议模拟器与端到端验收脚本，
覆盖 login / heartbeat / dataReport / alarmReport / ntp 上行与平台下行请求响应：

```bash
cd backend
npx tsc    # 脚本依赖 dist/
node scripts/fsu-protocol-test/run-tests.js
```

脚本会自行拉起一个独立后端实例（临时数据库 + 独立端口 3010 / 1884），
不会写入生产数据、也不会干扰生产 Broker。详见 `backend/scripts/fsu-protocol-test/README.md`。

### 接入方式

设备接入只有一种正式方式：**厂家 FSU 网关经 MQTT 连接平台**（协议见下文
「MQTT 接入认证」与「厂家 FSU 协议数据流」）。平台不提供 HTTP 推送接收接口。

### API接口列表

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | /webhook/health | 健康检查（对外探活路径保持不变） |
| GET | /api/info | 平台信息 |
| GET | /api/devices | 获取设备列表（含 `latestMeters` 实时点） |
| GET | /api/devices/:id | 获取设备详情（含 `latestMeters` 实时点） |
| GET | /api/devices/:id/fsu-history | 获取厂家原始历史数据（`fsu_data_history`，按 devId + meterId） |
| GET | /api/devices/:id/history | 获取归档历史数据（读取旧 `device_data` 表，仅供历史查阅） |
| GET | /api/alarms | 获取告警列表 |
| GET | /api/alarms/stats | 获取告警统计 |
| GET | /api/alarms/trend | 获取告警趋势 |
| GET | /api/alarms/:id | 获取告警详情 |
| PUT | /api/alarms/:id/resolve | 解决告警 |
| GET | /api/notify/config | 获取告警推送配置（仅管理员） |
| PUT | /api/notify/config | 保存告警推送配置（仅管理员） |
| POST | /api/notify/test | 发送测试推送（仅管理员） |
| GET | /api/notify/logs | 获取推送记录（仅管理员） |

### 统一响应格式

```json
{
  "code": 0,
  "data": {},
  "message": "操作成功"
}
```

## Docker部署

后端单容器托管前端页面与 API（3001 端口），已无需独立的 Nginx 前端容器。

### 生产环境变量（部署前必做）

**应用配置的唯一来源是 `backend/.env`**（`docker-compose.yml` 通过 `env_file` 读取它）。
**不需要也不要在项目根目录创建 `.env`**，密码只保存这一份。

首次部署：

```bash
cd backend
cp .env.example .env
vi .env    # 至少填写：MQTT_USERNAME / MQTT_PASSWORD / MQTT_ALLOW_ANONYMOUS / JWT_SECRET / ADMIN_INITIAL_PASSWORD
```

从 `backend/.env` 读取的配置项：

| 变量 | 说明 |
|---|---|
| `MQTT_USERNAME` | 统一 MQTT 账号用户名（`platform`） |
| `MQTT_PASSWORD` | 统一 MQTT 账号密码（生产密码，只存于本文件） |
| `MQTT_ALLOW_ANONYMOUS` | 必须 `false`：禁止匿名连接 |
| `JWT_SECRET` | 登录态签名密钥 |
| `ADMIN_INITIAL_USERNAME` / `ADMIN_INITIAL_PASSWORD` | 首次启动默认管理员 |
| `OFFLINE_THRESHOLD` / `DATA_RETENTION_DAYS` / `DATA_CLEANUP_TIME` | 离线判定与数据清理策略 |

`backend/.env` 已在 `.gitignore` 中，不会被提交到 Git，也不会被复制进 Docker 镜像
（`.dockerignore` 已排除 `**/.env`）。生产密码请只写在服务器的该文件里，
不要硬编码进源码或 `docker-compose.yml`。

> ⚠️ `docker-compose.yml` 的 `environment` 段优先级**高于** `env_file`，
> 同名变量会覆盖 `backend/.env` 的值。因此 `environment` 中只保留容器内部固定值
> （`PORT` / `DB_PATH` / `EMBEDDED_BROKER` / `MQTT_BROKER_HOST` / `MQTT_BROKER_PORT` /
> `CONNECT_MODE` / `STATIC_DIR`），**不要把 `MQTT_*` 加回 `environment`**，否则会覆盖密码。
>
> 其中 `CONNECT_MODE` 在 compose 中固定为 `mqtt` 是有意为之：厂家 FSU 协议接入必须启用
> MQTT，固定写死可避免 `.env` 缺项导致内置 Broker 与 MQTT 不启动。后端代码默认值同样是 `mqtt`。

### 构建和启动

```bash
# 在项目根目录执行
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

### 数据持久化

SQLite数据库文件保存在宿主机的 `./backend/data` 目录下（容器内路径 `/app/data`），
重启或重建容器都不会丢失数据。

> 该目录与本地开发（`cd backend && npm run dev`）使用的是**同一个** `backend/data/fsu.db`，
> 本地与线上数据库路径已统一，不会出现两份库。

### 访问

- 平台页面与 API：http://localhost:3001（单端口，`/` 为页面，`/api/*` 为接口，`/webhook/health` 为探活）
- 设备接入：MQTT 1883（内置 Broker），厂家 FSU 网关直连

## cpolar 内网穿透（单地址访问平台）

开发或演示时用 cpolar 将本地 3001 端口穿透为公网地址，即可用一个地址同时访问页面与 API：

```bash
cpolar http 3001
# 得到 https://xxx.cpolar.top → 浏览器直接访问该地址
```

注意：

- 若穿透的是**开发服务器**（`npm start`，默认 3000 端口），已在 `frontend/.env` 设置 `DANGEROUSLY_DISABLE_HOST_CHECK=true` 放行隧道域名（CRA 等价于 Vite 的 `allowedHosts`，报 "Invalid Host header" 即此原因）。
- 生产模式（后端托管构建产物）穿透 3001 端口即可，后端对任意 Host 不做校验。

## 上云部署步骤

### 1. 云服务器准备

推荐配置：
- CPU: 2核
- 内存: 4GB
- 系统: Ubuntu 20.04 / CentOS 7+
- 带宽: 5Mbps+

### 2. 安装Docker和Docker Compose

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
```

### 3. 部署项目

```bash
# 上传项目文件到服务器
scp -r fsu-monitor-platform user@your-server-ip:~/

# 部署
cd ~/fsu-monitor-platform
docker-compose up -d

# 验证服务
curl http://localhost:3001/webhook/health
curl http://localhost:3001/api/info
# 页面（后端托管前端产物，单端口）
curl -I http://localhost:3001
```

### 4. Nginx反向代理（HTTPS）

在云服务器上安装Nginx，配置域名和SSL：

```nginx
# /etc/nginx/sites-available/fsu-monitor
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/ssl/cert.pem;
    ssl_certificate_key /path/to/ssl/key.pem;

    # 页面 / API / 探活全部由后端 3001 端口服务（后端托管前端产物）
    location / {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### 5. 配置厂家 FSU 网关接入

平台侧无需配置推送地址。厂家 FSU 网关按下表连接平台的 MQTT Broker 即可接入：

| 项 | 值 |
|---|---|
| MQTT 地址 | `mqtt://<公网IP或域名>:1883` |
| 用户名 / 密码 | 见下文「MQTT 接入认证（统一账号）」的 `MQTT_USERNAME` / `MQTT_PASSWORD` |
| FSU login 报文凭据 | `FSU_LOGIN_USERNAME` / `FSU_LOGIN_PASSWORD`（与 MQTT 账号是两套独立认证） |

请确认云服务器安全组已放行 **1883** 端口，否则网关无法连接、设备会全部离线。

### 6. 监控和运维

```bash
# 查看服务日志
docker-compose logs -f backend

# 重启服务
docker-compose restart

# 查看资源使用
docker stats

# 数据备份（SQLite文件）
cp ./backend/data/fsu.db ./backups/fsu-$(date +%Y%m%d).db
```

## 告警

告警**完全由厂家 FSU 网关上报**（协议 `gw/v1/alarmReport`），平台不做任何阈值判断。
`utils/alarmRules.ts` 只保留类型中文名称映射，不含主动规则。

平台按报文中的 `devId` 归类到 5 个子设备类型：

| 类型 | devId | 子设备 |
|------|-------|--------|
| `battery` | `1061001` | 电池 |
| `ac` | `1064001` | 交流 |
| `dc` | `2060001` | 直流 |
| `env` | `1120001` | 温湿度 |
| `door` | `1246001` | 门磁 |

未知 `devId` 回退为通用厂家告警类型。协议携带的 `serialNo` / `alarmLevel` / `isHistory`
一并落库（`alarms.serial_no` / `alarm_level` / `is_history`），用于去重与历史告警标记。

设备在线状态由心跳超时判定（`OFFLINE_THRESHOLD`，默认 10 分钟），写入 `devices.status`，
**不产生告警记录**。

## 厂家 FSU 协议数据流

厂家网关经 MQTT 上行，Topic 前缀统一为 `gw/v1/`（平台下行请求的响应为 `sc/v1/`）。
平台按 `mac` 关联到平台设备ID（即设备主键）。

| 上行方法 | 说明 | 落库位置 |
|---|---|---|
| `gw/v1/login` | 网关登录（含 `params.username` / `params.password` 认证） | `devices`（登记 mac、激活状态） |
| `gw/v1/heartbeat` | 心跳 | `devices.last_heartbeat`（仅证明在线） |
| `gw/v1/dataReport` | 测量点上报（`{ devId: { meterId: value } }`） | `devices.latest_meters`（增量合并）+ `fsu_data_history`（原始点逐条） |
| `gw/v1/alarmReport` | 告警上报 | `alarms` |
| `gw/v1/uploadDevInfo` | 电表字典（协议文档未定义，抓包实测存在） | `device_meters`（仅字典，不写测量数据） |
| `gw/v1/ntp` | 对时 | — |

下行指令（`getData` / `getAlarm` / `setData` / `reboot` / `ota`）由平台发布到 `gw/v1/<method>/<mac>`，
网关在 `sc/v1/` 回响应；平台重启/OTA 页面复用同一链路。

数据表职责：

| 表 | 含义 |
|---|---|
| `devices.latest_meters` | 每台设备**最新一次**的厂家原始点，设备详情「实时数据」即取此处 |
| `fsu_data_history` | 厂家原始历史点，每 `(devId, meterId)` 独立成行，按 `DATA_RETENTION_DAYS` 清理 |
| `device_meters` | 厂家电表字典（点名称/meterType），供页面按名称展示 |
| `alarms` | 告警记录（来源见 `alarms.source`） |
| `device_data` | **已停写的归档表**，仅保留历史数据；租户删除时会一并清理 |

> `device_data` 及其相关列属于历史归档，不再参与实时链路，请勿据此排查设备实时状态。

## MQTT 接入认证（统一账号）

平台采用**统一 MQTT 账号**接入厂家 FSU，**不使用一机一密**：

| 项 | 值 |
|---|---|
| 服务器地址 | 云服务器公网IP或域名 |
| MQTT 端口 | 1883 |
| 用户名 | `platform`（环境变量 `MQTT_USERNAME`） |
| 密码 | 生产环境统一密码（环境变量 `MQTT_PASSWORD`，只写在部署环境 `.env`） |
| 匿名连接 | 禁止（`MQTT_ALLOW_ANONYMOUS=false`） |

- **所有 FSU 共用同一套账号密码**，不为每台设备创建独立 MQTT 账号。
- 设备之间通过**厂家协议报文中的 mac**（以及 SN / IMEI / Topic）区分，平台设备ID 即 mac。
  这与厂家 FSU 此前匿名接入时的设备识别机制一致，未做改变。
- 平台内部客户端（指令下发）与设备共用同一账号，通过 **clientId 前缀 `fsu-platform-`** 区分，
  不会把设备上报误判为平台自身消息。
- 平台管理员账号（Web 登录）与 MQTT 账号是**两套独立认证**，互不影响。

### 认证行为

| 场景 | 结果 |
|---|---|
| 正确用户名 + 正确密码 | ✅ 连接成功 |
| 用户名错误 | ❌ 连接失败（CONNACK 4） |
| 密码错误 | ❌ 连接失败（CONNACK 4） |
| 不提供用户名/密码 | ❌ 连接失败（CONNACK 5） |
| 匿名连接 | ❌ 禁止 |

### 密码配置（不要写进源码）

真实 MQTT 密码**只配置在部署环境的 `.env`**，例如云服务器 `/home/ubuntu/app/.env`：

```bash
MQTT_USERNAME=platform
MQTT_PASSWORD=<生产环境统一密码>
MQTT_ALLOW_ANONYMOUS=false
```

`.env` 已被 `.gitignore` 忽略，不会提交到 Git；`.env.example` 中 `MQTT_PASSWORD` 保持为空。

## 告警推送

告警推送为独立功能模块（前端「告警推送」菜单 / 后端 `/api/notify`），与告警落库链路完全解耦：

- **触发链路**：设备/FSU 上报 → MQTT → 平台解析 → 产生告警写入 `alarms` 表 → 异步挂接推送。
  推送为「尽力而为」，任何推送异常都不会影响告警正常记录。
- **推送通道**：钉钉群机器人（支持加签）；短信通道为预留骨架，未接入供应商时记录「跳过」。
- **去重**：同一设备同一类型告警在配置窗口（默认 30 分钟）内只推送一次，两层去重（内存 + DB 记录）。
- **留痕**：每次真实发送尝试写入 `alarm_push_logs`（通道/目标脱敏/结果/原因）。
- **配置入口**：平台「告警推送」页，仅管理员可见（后端 `requireAdmin`）。

相关数据表：`alarm_notify_config`（配置单行）、`alarm_push_logs`（推送记录）。
告警本身的数据表为 `alarms`（列表/状态/恢复/统计），推送功能不会修改告警数据。

## 功能变更记录

### 工单管理已下线

平台已彻底移除「工单管理」功能（前端页面/菜单/路由、后端 `/api/work-orders` 全部接口、
TypeScript 类型与 `work_orders` 数据表）。告警相关功能（告警产生、告警列表、告警状态、
告警恢复、告警推送、告警历史、告警统计）全部保留且不受影响。

数据库迁移是安全的一次性操作：服务启动时若检测到 `work_orders` 表**且表内无数据**，
自动执行 `DROP TABLE`；若表中仍有历史工单数据，则跳过删除并打印告警日志，
由运维确认无需保留后手工执行 `DROP TABLE work_orders;`。
迁移只涉及 `work_orders` 一张表，`devices` / `device_data` / `alarms` / `users` /
`device_meters` / `alarm_notify_config` / `alarm_push_logs` 均不受影响。

## License

MIT