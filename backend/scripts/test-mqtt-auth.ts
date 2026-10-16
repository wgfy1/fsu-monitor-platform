/**
 * MQTT 统一账号认证端到端测试
 *
 * 验证平台 MQTT 认证行为（统一账号 + 禁止匿名）：
 *   正确用户名 + 正确密码 → 连接成功
 *   用户名错误            → 连接失败
 *   密码错误              → 连接失败
 *   不提供用户名/密码     → 连接失败
 *
 * 用法:
 *   MQTT_PASSWORD=<测试密码> MQTT_ALLOW_ANONYMOUS=false node -r ts-node/register scripts/test-mqtt-auth.ts
 *
 * 注意：本脚本使用独立的测试端口与测试密码，不读取也不写入生产密码。
 */
import process from 'process';
import * as mqtt from 'mqtt';

const MQTT_PORT = 18883; // 用独立端口避免与运行中的平台冲突

// 测试用统一账号（仅本脚本内部使用，非生产密码）
const TEST_USERNAME = 'platform';
const TEST_PASSWORD = process.env.TEST_MQTT_PASSWORD || 'test-only-mqtt-pass';

// 必须先设置环境变量，再加载 Broker：
// embeddedBroker 单例在模块加载时读取 MQTT_BROKER_PORT，静态 import 会被提升到本行之前
process.env.MQTT_BROKER_PORT = String(MQTT_PORT);
process.env.MQTT_ALLOW_ANONYMOUS = 'false';
process.env.MQTT_USERNAME = TEST_USERNAME;
process.env.MQTT_PASSWORD = TEST_PASSWORD;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { embeddedBroker } = require('../src/mqtt/broker');

const brokerUrl = `mqtt://localhost:${MQTT_PORT}`;

/** 记录每条用例的通过情况，供退出码判定 */
const results: { label: string; pass: boolean }[] = [];

function tryConnect(
  label: string,
  opts: { username?: string; password?: string },
  expectSuccess: boolean,
): Promise<void> {
  return new Promise((resolve) => {
    const client = mqtt.connect(brokerUrl, {
      clientId: `test-${Math.random().toString(16).slice(2, 10)}`,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 3000,
      ...opts,
    });
    let settled = false;
    const done = (ok: boolean, detail = '') => {
      if (settled) return;
      settled = true;
      const pass = ok === expectSuccess;
      results.push({ label, pass });
      console.log(
        `${pass ? '✓' : '✗'} ${label}: 期望${expectSuccess ? '连接成功' : '连接失败'}, 实际: ${detail}`,
      );
      try { client.end(true); } catch { /* noop */ }
      resolve();
    };
    client.on('connect', () => done(true, 'CONNECT 成功'));
    client.on('error', (err: any) => done(false, `CONNACK 拒绝(${err.message})`));
  });
}

async function main(): Promise<void> {
  await embeddedBroker.start();
  console.log('--- MQTT 统一账号认证测试 (MQTT_ALLOW_ANONYMOUS=false) ---');
  console.log(`统一账号: username=${TEST_USERNAME}`);

  // 正确用户名 + 正确密码 → 成功
  await tryConnect('正确用户名+正确密码', { username: TEST_USERNAME, password: TEST_PASSWORD }, true);
  // 用户名错误 → 失败
  await tryConnect('用户名错误', { username: 'wrong-user', password: TEST_PASSWORD }, false);
  // 密码错误 → 失败
  await tryConnect('密码错误', { username: TEST_USERNAME, password: 'wrong-password' }, false);
  // 之前的一机一密设备账号（设备ID作用户名）→ 已不再受理，失败
  await tryConnect('设备ID作用户名(一机一密已下线)', { username: 'TEST-AUTH-001', password: TEST_PASSWORD }, false);
  // 不提供用户名/密码 → 失败（禁止匿名）
  await tryConnect('匿名连接(无凭据)', {}, false);
  // 只提供用户名不提供密码 → 失败
  await tryConnect('只给用户名不给密码', { username: TEST_USERNAME }, false);

  await embeddedBroker.stop();

  const failed = results.filter((r) => !r.pass);
  console.log(`--- 测试结束: ${results.length - failed.length}/${results.length} 通过 ---`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
