# 厂家 FSU 协议模拟器 / 验收脚本

对应协议：《网关MQTT通信协议_V1.0.0 - 20260923 - WF.pdf》（文件内修改记录标注 V1.0.2）

## 用途

- `simulator.js`：模拟一台厂家网关（clientId = gwId，订阅 `sc/v1/#`，
  支持 login / heartbeat / dataReport / alarmReport / ntp 上行，
  并能按协议对平台下行的 getData / getAlarm / setData / reboot / ota 回响应）
- `run-tests.js`：端到端验收，共 94 项断言，分三段：
  - **A 段（协议层，30 项）**：login/heartbeat/dataReport/alarmReport/ntp、
    下行 getData/getAlarm/setData/reboot/OTA、过期过滤、报文上限、错误码透传
  - **B 段（远程业务 API）**：`/api/devices/:id/remote/*` —— getData 回写实时快照、
    request id 精确匹配、超时、离线拒绝、租户隔离、reboot/OTA 未被破坏、
    下行响应不被当成上行 dataReport
  - **C 段（Excel 批量导入）**：模板校验、各类行级校验、租户越权、
    事务提交/回滚、令牌防篡改、long-number 保真

## 运行

```bash
cd backend
npx tsc                # 先编译（脚本依赖 dist/）
node scripts/fsu-protocol-test/run-tests.js
```

## 安全隔离（重要）

脚本会**自行拉起一个后端实例**，并使用：

| 项 | 值 | 说明 |
|---|---|---|
| 数据库 | `scripts/fsu-protocol-test/tmp/test.db` | 临时库，用后即删；**绝不使用生产库** |
| HTTP 端口 | 3010 | 与生产 3001 隔离 |
| MQTT 端口 | 1884 | 与生产 1883 隔离 |

因此可以在生产环境旁安全运行，不会写入生产数据、也不会干扰生产 Broker。

## 连真实网关前的准备

1. 生产网关的 login 报文中 `params.username/password` 必须与
   `MQTT_USERNAME/MQTT_PASSWORD` 一致（或用 `FSU_LOGIN_USERNAME/FSU_LOGIN_PASSWORD` 覆盖），
   否则会被拒绝（协议 4.1：code = 1）。先用 `FSU_LOGIN_AUTH_ENFORCE=false` 可放行观察。
2. 确认网关订阅了 `sc/v1/{method}/{gwId}`，否则收不到平台响应。
3. 用 `MQTT_DEBUG_ALL=true` 抓一条真实报文，核对字段与本文档一致后再全量接入。
