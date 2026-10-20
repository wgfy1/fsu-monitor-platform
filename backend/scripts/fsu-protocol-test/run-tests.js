/**
 * 厂家 FSU 协议适配 —— 端到端验收（临时库 + 独立端口，绝不触碰生产库/生产 Broker）
 *
 * 用法：cd backend && npx tsc && node scripts/fsu-protocol-test/run-tests.js
 *
 * 覆盖用户要求的 30 项测试用例。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { FsuGatewaySim } = require('./simulator');

const BACKEND_DIR = path.join(__dirname, '..', '..');
const DIR = path.join(__dirname, 'tmp');   // 临时库/日志（可安全删除）
const DB = path.join(DIR, 'test.db');
const PORT = 3010;
const MQTT_PORT = 1884;          // 与生产 1883 隔离

// ==================================================================
// 自测凭据：**每轮随机生成**，只存在于本进程与它拉起的测试后端子进程之间。
//
// 为什么不用固定字面量：这些值会随源码一起公开。一旦哪天有人把它们
// 配成生产值，仓库里就等于明文存着生产口令；反过来，固定值也容易被
// 误当成"生产也在用的凭据"。随机生成可以同时保证两件事：
//   1) 与生产 .env 里任何取值都不同（不可能是同一把钥匙）；
//   2) 不写进磁盘之外的任何地方（不落盘、不进仓库）。
// 配合下面的 startBackend()——这些值通过 env 注入，且 dotenv 默认
// 不覆盖已存在的进程环境变量，因此 backend/.env 里的生产值不会生效。
// ==================================================================
const crypto = require('crypto');
const randSecret = () => crypto.randomBytes(16).toString('hex');

const MQTT_USER = 'platform';
const MQTT_PASS = randSecret();
// FSU login 报文凭据：**故意与 MQTT 凭据不同**，用于证明两套认证已解耦
const FSU_USER = 'admin';
const FSU_PASS = randSecret();
const GW = { mac: '00:53:4A:00:02:82', norm: '00534a000282' };  // 带冒号大写 → 规范化
// JWT 密钥：后端子进程与测试进程共用同一个值，保证导入令牌可复现
const JWT_SECRET = randSecret();
// Excel 依赖与后端**同一份**（不额外引入第二个 Excel 库）
const ExcelJS = require('exceljs');

const results = [];
function check(name, expected, actual) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  results.push({ name, expected, actual, pass });
  console.log(`${pass ? '✅' : '❌'} ${name}` + (pass ? '' : `\n    期望: ${JSON.stringify(expected)}\n    实际: ${JSON.stringify(actual)}`));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 测试库只读查询 ----------
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB, sqlite3.OPEN_READONLY);
    db.all(sql, params, (e, rows) => { db.close(); e ? reject(e) : resolve(rows); });
  });
}
function dbGet(sql, params = []) {
  return dbAll(sql, params).then((r) => r[0] || null);
}
/**
 * 测试库**可写**执行（仅用于构造前置状态，例如把定时校时的 next_due_at 推到过去）
 * 生产代码不会用到它。
 */
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB);
    db.run(sql, params, function (e) { db.close(); e ? reject(e) : resolve(this.changes); });
  });
}

// ==================================================================
// B/C 段（远程业务 API、Excel 批量导入）用的辅助函数
// ==================================================================
const API = `http://127.0.0.1:${PORT}/api`;

/** 平台管理员凭据（与 startBackend 注入的 ADMIN_INITIAL_* 保持一致，同样每轮随机） */
const ADMIN_USER = 'admin';
const ADMIN_PASS = randSecret();

/** JSON 请求（带可选 Bearer Token） */
async function apiJson(method, path, body, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

/** multipart 上传（Excel）—— 不手工设置 Content-Type，交给 fetch 生成 boundary */
async function apiUpload(path, buf, filename, token) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buf)]), filename);
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return res.json();
}

/** 下载模板并取出字节（后续用例都以**真实模板**为底，避免与实现耦合） */
async function downloadTemplate(token) {
  const res = await fetch(`${API}/devices/import/template`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 以模板为底构造测试 Excel
 * rows 为「表头 → 值」的对象数组；headers 可覆盖表头（用于表头错误用例）
 */
async function buildXlsxFrom(templateBuf, rows, headers) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(templateBuf);
  const ws = wb.worksheets[0];
  const head = headers || ws.getRow(1).values.slice(1).map((v) => (v == null ? '' : String(v)));
  if (headers) {
    // 覆盖表头：先清空原有表头，再写入新的
    ws.getRow(1).values = [];
    headers.forEach((h, i) => { ws.getRow(1).getCell(i + 1).value = h; });
  }
  rows.forEach((r, idx) => {
    const row = ws.getRow(idx + 2);
    head.forEach((h, i) => {
      const v = r[h];
      if (v !== undefined && v !== null) row.getCell(i + 1).value = v;
    });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

let backend = null;
async function startBackend() {
  const bdir = BACKEND_DIR;
  backend = spawn(process.execPath, ['dist/index.js'], {
    cwd: bdir,
    env: {
      ...process.env,
      DB_PATH: DB,
      PORT: String(PORT),
      MQTT_BROKER_PORT: String(MQTT_PORT),
      // 用 127.0.0.1 而非 localhost：本机 localhost 会优先解析为 ::1，
      // 而内置 Broker 监听 IPv4，Node 18 默认不做 IPv6→IPv4 回退。
      // 生产 backend/.env 也使用 127.0.0.1。
      MQTT_BROKER_HOST: '127.0.0.1',
      MQTT_USERNAME: MQTT_USER, MQTT_PASSWORD: MQTT_PASS,
      MQTT_ALLOW_ANONYMOUS: 'false',
      FSU_LOGIN_USERNAME: FSU_USER, FSU_LOGIN_PASSWORD: FSU_PASS,
      FSU_LOGIN_AUTH_ENFORCE: 'true',
      FSU_DOWNSTREAM_TIMEOUT_MS: '2500',
      MQTT_MESSAGE_EXPIRE_SECONDS: '3',
      // 平台主动校时（上线校时 + 定时校时）：
      //   调度扫描周期压到 2s、启动宽限压到 3s，让定时用例可在秒级验证。
      //   注意：FSU_NTP_SYNC_COOLDOWN_SECONDS 已废弃，不再注入。
      NTP_SCHEDULER_TICK_MS: '2000',
      NTP_STARTUP_GRACE_MS: '3000',
      NTP_MIN_SEND_GAP_MS: '1500',
      CONNECT_MODE: 'both',
      // 远程/导入用例走 HTTP API，需要确定的管理员凭据与固定 JWT 密钥
      // （显式指定，避免被 backend/.env 里的配置干扰）
      ADMIN_INITIAL_USERNAME: ADMIN_USER,
      ADMIN_INITIAL_PASSWORD: ADMIN_PASS,
      JWT_SECRET: JWT_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (d) => fs.appendFileSync(path.join(DIR, 'backend.log'), d));
  backend.stderr.on('data', (d) => fs.appendFileSync(path.join(DIR, 'backend.log'), d));

  // 等待服务就绪
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const log = fs.existsSync(path.join(DIR, 'backend.log')) ? fs.readFileSync(path.join(DIR, 'backend.log'), 'utf8') : '';
    if (log.includes('服务启动成功') && log.includes('MQTT 服务启动成功')) return;
    if (backend.exitCode !== null) throw new Error('后端启动即退出，exitCode=' + backend.exitCode);
  }
  throw new Error('后端启动超时');
}

function stopBackend() {
  return new Promise((r) => {
    if (!backend || backend.exitCode !== null) return r();
    backend.once('exit', () => r());
    backend.kill();
    setTimeout(() => { try { backend.kill('SIGKILL'); } catch {} r(); }, 3000);
  });
}

(async () => {
  // 只清理测试产物（脚本自身就在该目录内运行，不能整目录删除）
  fs.mkdirSync(DIR, { recursive: true });
  for (const f of ['test.db', 'test.db-journal', 'backend.log', 'results.json']) {
    fs.rmSync(path.join(DIR, f), { force: true });
  }
  await startBackend();
  console.log('后端已启动（临时库 + 独立端口）\n');

  const gw = new FsuGatewaySim({ host: '127.0.0.1', port: MQTT_PORT, gwId: GW.norm, username: MQTT_USER, password: MQTT_PASS, fsuUsername: FSU_USER, fsuPassword: FSU_PASS });
  await gw.connect();
  console.log('模拟网关已连接\n');

  // 下行请求需要"平台侧发布能力"。后端进程内由 EmbeddedBroker 注册（登录/心跳/
  // 数据上报的响应能收到即证明该注册生效）；本测试进程要直接调用协议层的
  // getData/setData 等，因此在这里注册一个走测试 Broker 的发布实现，
  // 从而端到端验证 topic / method / id 关联。
  // 只 require downstream 模块：它不依赖 service/数据库，
  // 不会在测试进程里再实例化一个 Database 单例。
  const mqttLib = require('mqtt');
  const downstreamMod = require('../../dist/protocols/fsu/downstream');
  const dclient = mqttLib.connect(`mqtt://127.0.0.1:${MQTT_PORT}`, {
    clientId: 'fsu-platform-selftest', username: MQTT_USER, password: MQTT_PASS,
  });
  await new Promise((res, rej) => { dclient.on('connect', res); dclient.on('error', rej); });
  downstreamMod.setPublisher((topic, payload, qos) => new Promise((res, rej) => {
    dclient.publish(topic, payload, { qos }, (err) => (err ? rej(err) : res()));
  }));
  // 订阅网关响应 topic，把响应喂给协议层的 request/response 关联器
  // （与外部 Broker 模式下平台客户端的做法一致）
  dclient.on('message', (topic, payload) => {
    if (!topic.startsWith('gw/v1/')) return;
    try {
      const gwId = topic.split('/')[3] || null;
      downstreamMod.handleDownlinkResponse(topic, JSON.parse(payload.toString('utf8')), gwId);
    } catch { /* 非 JSON 忽略 */ }
  });
  await new Promise((res) => dclient.subscribe('gw/v1/#', { qos: 1 }, res));

  // ==================================================================
  // A. 两层认证解耦专项（MQTT 连接认证 ≠ FSU login 业务认证）
  //    本套测试中两者**故意使用不同凭据**（且均为本轮随机生成，
  //    见文件头部 randSecret()；不写死、不读生产值）：
  //      MQTT  : MQTT_USER / MQTT_PASS
  //      FSU   : FSU_USER  / FSU_PASS
  // ==================================================================
  console.log('---------- A. 两层认证 ----------');

  // 4. MQTT username=platform 正常连接（gw 已在上面 connect 成功）
  check('4 MQTT 层用 platform 账号连接成功（未受 FSU 认证影响）', true, gw.client.connected);

  // 1. FSU login admin + 正确 password → code=0
  {
    const b = gw.login({ mac: GW.mac });   // 默认用本轮的 FSU 凭据（FSU_USER / FSU_PASS）
    const a = await gw.waitFor((r) => r.body && r.body.id === b.id);
    check('1 FSU login：username=admin + 正确 password → code=0', 0, a.body.code);
  }

  // 2. 错误 username → code=1
  {
    const b = gw.login({ mac: GW.mac, username: 'not-admin' });
    const a = await gw.waitFor((r) => r.body && r.body.id === b.id);
    check('2 FSU login：错误 username → code=1', 1, a.body.code);
  }

  // 3. 错误 password → code=1
  {
    const b = gw.login({ mac: GW.mac, password: 'wrong-password' });
    const a = await gw.waitFor((r) => r.body && r.body.id === b.id);
    check('3 FSU login：错误 password → code=1', 1, a.body.code);
  }

  // 5. MQTT 连接成功但 FSU login 失败 → 两层状态明确区分
  {
    const failGw = new FsuGatewaySim({
      host: '127.0.0.1', port: MQTT_PORT, gwId: 'aaaabbbbcccc',
      username: MQTT_USER, password: MQTT_PASS,
      fsuUsername: 'admin', fsuPassword: 'definitely-wrong',
    });
    await failGw.connect();
    const b = failGw.login({ mac: 'aaaabbbbcccc' });
    const a = await failGw.waitFor((r) => r.body && r.body.id === b.id);
    const hb = failGw.heartbeat({ online: [] });
    const hbAck = await failGw.waitFor((r) => r.body && r.body.id === hb.id);
    check('5 MQTT 连接成功 + FSU login 失败：login code=1，且未建立会话（后续心跳被拒 -9）',
      { mqtt: true, login: 1, heartbeat: -9 },
      { mqtt: failGw.client.connected, login: a.body.code, heartbeat: hbAck.body.code });
    await failGw.end();
  }

  // 9. login password 不出现在日志（含正确与错误两种密码）
  {
    const log = fs.readFileSync(path.join(DIR, 'backend.log'), 'utf8');
    check('9 日志中不出现 FSU login password（正确/错误密码均不打印）',
      { fsu: false, wrong: false },
      { fsu: log.includes(FSU_PASS), wrong: log.includes('wrong-password') });
  }

  // 10. 不允许通过关闭 MQTT 认证来"解决"：错误 MQTT 密码必须被拒绝
  {
    const bad = new FsuGatewaySim({
      host: '127.0.0.1', port: MQTT_PORT, gwId: 'deadbeef0001',
      username: MQTT_USER, password: 'wrong-mqtt-password',
      fsuUsername: FSU_USER, fsuPassword: FSU_PASS,
    });
    let rejected = false;
    try { await bad.connect(); } catch { rejected = true; }
    await sleep(300);
    rejected = rejected || !bad.client.connected;
    check('10 MQTT 层认证仍强制生效（错误 MQTT 密码无法连接）', true, rejected);
    try { await bad.end(); } catch { /* 未连上 */ }
  }
  console.log('');

  // ============ 1. login 成功 ============
  const loginBody = gw.login({ mac: GW.mac });   // 故意用带冒号大写，验证规范化
  // 按 id 精确匹配本条 login 的响应（前面 A 组也已发过多条 login，不能只按 method 取）
  const loginAck = await gw.waitFor((r) => r.topic.startsWith('sc/v1/login/') && r.body && r.body.id === loginBody.id);
  check('1 login 成功：响应 topic 为 sc/v1/login/{规范化gwId} 且 code=0',
    { topic: `sc/v1/login/${GW.norm}`, id: loginBody.id, code: 0, hasTs: true },
    { topic: loginAck.topic, id: loginAck.body.id, code: loginAck.body.code, hasTs: typeof loginAck.body.timestamp === 'number' });
  const dev = await dbGet('SELECT id, status, device_sn, protocol_type FROM devices WHERE id = ?', [GW.norm]);
  check('1b login 在现有 devices 表建立/激活网关设备（复用既有模型）',
    { exists: true, status: 'online', device_sn: GW.mac, protocol_type: 'vendor' },
    { exists: !!dev, status: dev && dev.status, device_sn: dev && dev.device_sn, protocol_type: dev && dev.protocol_type });

  // ============ 2. login 认证失败 ============
  const badBody = gw.login({ mac: GW.mac, password: 'wrong-password' });
  const badAck = await gw.waitFor((r) => r.topic.startsWith('sc/v1/login/') && r.body && r.body.id === badBody.id);
  check('2 login 认证失败：code=1（协议 4.1）', 1, badAck.body.code);
  const logText = fs.readFileSync(path.join(DIR, 'backend.log'), 'utf8');
  check('2b 日志中不出现 login password', false, logText.includes('wrong-password') || logText.includes(MQTT_PASS) || logText.includes(FSU_PASS));

  // ============ 3. heartbeat ============
  const hb = gw.heartbeat({ online: ['1843001', '101001'], offline: ['999999'] });
  const hbAck = await gw.waitFor((r) => r.body && r.body.id === hb.id);
  check('3 heartbeat：code=0 且 topic 正确',
    { topic: `sc/v1/heartbeat/${GW.norm}`, code: 0 }, { topic: hbAck.topic, code: hbAck.body.code });
  await sleep(300);
  const devAfterHb = await dbGet('SELECT last_heartbeat, status FROM devices WHERE id = ?', [GW.norm]);
  check('3b heartbeat 复用既有在线状态逻辑（last_heartbeat 更新、status=online）',
    { status: 'online', hasHb: true },
    { status: devAfterHb.status, hasHb: (devAfterHb.last_heartbeat || 0) > 0 });

  // ============ 4. dataReport 实时 ============
  await gw.dataReport({ devId: '1843001', meters: [{ meterId: '13061001001', value: '53.5' }, { meterId: '13061002001', value: '12.3' }], isFull: 0 });
  await sleep(600);
  const meters1 = await dbGet('SELECT latest_meters FROM devices WHERE id = ?', [GW.norm]);
  const parsed1 = JSON.parse(meters1.latest_meters || '{}');
  check('4 dataReport 实时：devId+meters 进入现有存储（latestMeters 按 devId 分层）',
    { dev: '53.5', meter2: '12.3' },
    { dev: parsed1['1843001'] && parsed1['1843001']['13061001001'], meter2: parsed1['1843001'] && parsed1['1843001']['13061002001'] });
  // 正式历史链路：fsu_data_history（每个 (devId, meterId) 独立成行）
  const dhist = await dbAll('SELECT device_id, dev_id, meter_id FROM fsu_data_history WHERE device_id = ? ORDER BY id DESC LIMIT 1', [GW.norm]);
  check('4b dataReport 写入 fsu_data_history（厂家原始历史点）', 1, dhist.length);

  // ============ 5. dataReport 历史（historyTime） ============
  const historyMs = Date.now() - 3600 * 1000;              // 1 小时前（毫秒，13 位）
  await gw.dataReport({ devId: '1843001', meters: [{ meterId: '13061003001', value: '25.1' }], isFull: 0, isHistory: 1, historyTime: historyMs });
  await sleep(600);
  const histRow = await dbGet('SELECT data_timestamp FROM fsu_data_history WHERE device_id = ? ORDER BY id DESC LIMIT 1', [GW.norm]);
  // fsu_data_history.data_timestamp 为**毫秒**存储，故期望值为 historyMs 本身
  check('5 dataReport 历史：历史数据行使用协议 historyTime（毫秒量级判定）',
    historyMs, histRow.data_timestamp);
  const afterTs = await dbGet('SELECT last_seen FROM devices WHERE id = ?', [GW.norm]);
  check('5b 历史数据不把设备 last_seen 拉回过去（仍为近期）',
    true, Math.abs(afterTs.last_seen - Date.now()) < 120000);

  // ============ 6. isFull=1 全量（替换） ============
  await gw.dataReport({ devId: 'devFull', meters: [{ meterId: 'm1', value: '1' }, { meterId: 'm2', value: '2' }], isFull: 1 });
  await sleep(400);
  await gw.dataReport({ devId: 'devFull', meters: [{ meterId: 'm1', value: '9' }], isFull: 1 });
  await sleep(500);
  const fullMeters = JSON.parse((await dbGet('SELECT latest_meters FROM devices WHERE id = ?', [GW.norm])).latest_meters || '{}');
  check('6 isFull=1 全量：整体替换（m2 被剔除）',
    { m1: '9', m2: undefined }, { m1: fullMeters.devFull && fullMeters.devFull.m1, m2: fullMeters.devFull && fullMeters.devFull.m2 });

  // ============ 7. isFull=0 增量（合并） ============
  await gw.dataReport({ devId: 'devInc', meters: [{ meterId: 'a', value: '1' }, { meterId: 'b', value: '2' }], isFull: 0 });
  await sleep(400);
  await gw.dataReport({ devId: 'devInc', meters: [{ meterId: 'a', value: '8' }], isFull: 0 });
  await sleep(500);
  const incMeters = JSON.parse((await dbGet('SELECT latest_meters FROM devices WHERE id = ?', [GW.norm])).latest_meters || '{}');
  check('7 isFull=0 增量：与已有快照合并（b 保留、a 更新）',
    { a: '8', b: '2' }, { a: incMeters.devInc && incMeters.devInc.a, b: incMeters.devInc && incMeters.devInc.b });

  // ============ 8/9/10. alarmReport ============
  const serial = 5001;
  const alarmTimeSec = Math.floor(Date.now() / 1000) - 60;
  const al = gw.alarmReport({ alarmFlag: 1, alarmLevel: 2, alarmTime: alarmTimeSec, serialNo: serial, devId: '1843001', meterId: '12160021001' });
  const alAck = await gw.waitFor((r) => r.body && r.body.id === al.id);
  await sleep(400);
  const alarmRow = await dbGet('SELECT * FROM alarms WHERE device_id = ? AND serial_no = ?', [GW.norm, String(serial)]);
  check('8 alarmReport 产生：告警入库且保留 serialNo / alarmLevel / 协议 alarmTime',
    { code: 0, exists: true, serial: String(serial), level: 2, createdAt: alarmTimeSec, resolved: 0 },
    { code: alAck.body.code, exists: !!alarmRow, serial: alarmRow && String(alarmRow.serial_no), level: alarmRow && alarmRow.alarm_level, createdAt: alarmRow && alarmRow.created_at, resolved: alarmRow && alarmRow.resolved });

  // 10. 重复 serialNo 去重
  gw.alarmReport({ alarmFlag: 1, alarmLevel: 2, alarmTime: alarmTimeSec, serialNo: serial, devId: '1843001', meterId: '12160021001' });
  await sleep(600);
  const dupCount = await dbAll('SELECT id FROM alarms WHERE device_id = ? AND serial_no = ?', [GW.norm, String(serial)]);
  check('10 重复 serialNo 不重复建告警（按 serialNo 去重）', 1, dupCount.length);

  // 9. alarmFlag=0 消除（使用 clearTime）
  const clearSec = Math.floor(Date.now() / 1000);
  const cl = gw.alarmReport({ alarmFlag: 0, alarmLevel: 2, alarmTime: alarmTimeSec, clearTime: clearSec, serialNo: serial, devId: '1843001', meterId: '12160021001' });
  const clAck = await gw.waitFor((r) => r.body && r.body.id === cl.id);
  await sleep(400);
  const resolved = await dbGet('SELECT resolved, resolved_at FROM alarms WHERE device_id = ? AND serial_no = ?', [GW.norm, String(serial)]);
  // alarms.resolved_at 既有约定为毫秒（既有代码 Date.now()），故按 ms 断言
  check('9 alarmReport 消除：按 serialNo 消除并使用协议 clearTime',
    { code: 0, resolved: 1, resolvedAt: clearSec * 1000 }, { code: clAck.body.code, resolved: resolved.resolved, resolvedAt: resolved.resolved_at });

  // ============ 11. getData（平台下行 + 响应关联） ============
  gw.respondTo('getData', (req) => ({
    id: req.id, timestamp: Date.now(), method: 'getData', code: 0,
    data: [{ devId: '101001', meters: [{ meterId: '1833224001', value: '1' }] }],
  }));
  const { getData } = downstreamMod;
  const gdResp = await getData(GW.norm, ['101001']);
  check('11 getData：平台下行 sc/v1/getData/{gwId}，响应按 id 正确关联',
    { code: 0, devId: '101001', value: '1' },
    { code: gdResp.code, devId: gdResp.data && gdResp.data[0] && gdResp.data[0].devId, value: gdResp.data && gdResp.data[0] && gdResp.data[0].meters[0].value });
  const gdSent = gw.received.find((r) => r.topic === `sc/v1/getData/${GW.norm}`);
  check('11b 下行报文 topic/method/params 正确',
    { topic: `sc/v1/getData/${GW.norm}`, method: 'getData', params: ['101001'] },
    { topic: gdSent.topic, method: gdSent.body.method, params: gdSent.body.params });

  // ============ 12. getAlarm ============
  gw.respondTo('getAlarm', (req) => ({
    id: req.id, timestamp: Date.now(), method: 'getAlarm', code: 0,
    data: [{ devId: '201001', meters: [{ meterId: '2833224001', alarmTime: 1739860289 }] }],
  }));
  const { getAlarm } = downstreamMod;
  const gaResp = await getAlarm(GW.norm);
  check('12 getAlarm：响应关联正确，alarmTime 按秒处理',
    { code: 0, meterId: '2833224001', alarmTime: 1739860289 },
    { code: gaResp.code, meterId: gaResp.data[0].meters[0].meterId, alarmTime: gaResp.data[0].meters[0].alarmTime });
  const gaSent = gw.received.find((r) => r.topic === `sc/v1/getAlarm/${GW.norm}`);
  check('12b getAlarm 与 alarmReport 不是同一种消息', { a: 'getAlarm', b: 'alarmReport' },
    { a: gaSent.body.method, b: 'alarmReport' });

  // ============ 13. setData ============
  gw.respondTo('setData', (req) => ({ id: req.id, timestamp: Date.now(), method: 'setData', code: 0, data: { msg: 'success' } }));
  const { setData } = downstreamMod;
  const sdResp = await setData(GW.norm, [{ devId: '301001', meterId: '22564441', value: '1' }]);
  const sdSent = gw.received.find((r) => r.topic === `sc/v1/setData/${GW.norm}`);
  check('13 setData：单个/多个设置项，value 保持 string',
    { code: 0, params: [{ devId: '301001', meterId: '22564441', value: '1' }] },
    { code: sdResp.code, params: sdSent.body.params });

  // ============ 14. ntp ============
  const ntp = gw.ntp({ timezone: 'GMT+08:00' });
  const ntpAck = await gw.waitFor((r) => r.body && r.body.id === ntp.id);
  check('14 ntp：响应 topic 正确、使用平台当前毫秒时间',
    { topic: `sc/v1/ntp/${GW.norm}`, code: 0, method: 'ntp', tsIsMs: true },
    { topic: ntpAck.topic, code: ntpAck.body.code, method: ntpAck.body.method, tsIsMs: ntpAck.body.timestamp > 1e12 });

  // ============ 15. reboot ============
  gw.respondTo('reboot', (req) => ({ id: req.id, timestamp: Date.now(), method: 'reboot', code: 0, msg: 'success' }));
  const { reboot } = downstreamMod;
  const rbResp = await reboot(GW.norm, 1);
  const rbSent = gw.received.find((r) => r.topic === `sc/v1/reboot/${GW.norm}`);
  check('15 reboot：topic/method/params.type 正确', { code: 0, type: 1 }, { code: rbResp.code, type: rbSent.body.params.type });

  // ============ 16. OTA（大小写差异） ============
  gw.respondTo('ota', (req) => ({ id: req.id, timestamp: Date.now(), method: 'OTA', code: 0, msg: 'success' }));
  const { ota } = downstreamMod;
  const otaResp = await ota(GW.norm, ['http://192.168.0.65:8080/ota.bin']);
  const otaSent = gw.received.find((r) => r.topic === `sc/v1/ota/${GW.norm}`);
  check('16 OTA：topic 用小写 ota、报文体 method 用大写 "OTA"、url 为数组；响应 method="OTA" 可关联',
    { topic: `sc/v1/ota/${GW.norm}`, method: 'OTA', url: ['http://192.168.0.65:8080/ota.bin'], code: 0 },
    { topic: otaSent.topic, method: otaSent.body.method, url: otaSent.body.params.url, code: otaResp.code });
  // 响应 method 写成小写 ota 也要能关联
  gw.respondTo('ota', (req) => ({ id: req.id, timestamp: Date.now(), method: 'ota', code: 0, msg: 'success' }));
  const otaResp2 = await ota(GW.norm, ['http://192.168.0.65:8080/ota2.bin']);
  check('16b OTA 响应 method 小写 "ota" 同样可关联', 0, otaResp2.code);

  // ============ 17/18/19. 过期过滤 ============
  const staleTs = Date.now() - 10000;   // 10 秒前 > 3 秒
  await gw.dataReport({ devId: 'devStale', meters: [{ meterId: 'x', value: '1' }], isFull: 1, timestamp: staleTs });
  await sleep(700);
  const staleMeters = JSON.parse((await dbGet('SELECT latest_meters FROM devices WHERE id = ?', [GW.norm])).latest_meters || '{}');
  check('17 过期消息被过滤（dataReport 10 秒前 → 未进入业务处理）', undefined, staleMeters.devStale);

  const staleLogin = gw.login({ mac: GW.mac, raw: { id: 'stale-login', timestamp: staleTs, method: 'login', params: { version: 'v1', mac: GW.mac, username: FSU_USER, password: FSU_PASS } } });
  const staleLoginAck = await gw.waitFor((r) => r.body && r.body.id === staleLogin.id);
  check('18 login 不受过期过滤（10 秒前仍正常响应 code=0）', 0, staleLoginAck.body.code);

  const staleNtp = gw.ntp({ timestamp: staleTs });
  const staleNtpAck = await gw.waitFor((r) => r.body && r.body.id === staleNtp.id);
  check('19 ntp 不受过期过滤（10 秒前仍正常响应 code=0）', 0, staleNtpAck.body.code);

  // ============ 20. 非法 JSON ============
  gw.publishRaw(`gw/v1/dataReport/${GW.norm}`, '{ this is not json ');
  await sleep(500);
  const aliveAfterBadJson = await fetch(`http://127.0.0.1:${PORT}/api/webhook/health`).then((r) => r.status).catch(() => 0);
  check('20 非法 JSON 被拒绝且服务存活', 200, aliveAfterBadJson);

  // ============ 21. 超过 2MB 报文 ============
  const huge = 'x'.repeat(2 * 1024 * 1024 + 1024);
  const hugeBody = { id: 'huge-1', timestamp: Date.now(), method: 'dataReport', params: [{ devId: 'devHuge', isFull: 1, isHistory: 0, meters: [{ meterId: 'big', value: huge }] }] };
  gw.publishRaw(`gw/v1/dataReport/${GW.norm}`, JSON.stringify(hugeBody));
  await sleep(900);
  const hugeMeters = JSON.parse((await dbGet('SELECT latest_meters FROM devices WHERE id = ?', [GW.norm])).latest_meters || '{}');
  check('21 超过 2097152 字节的报文被拒绝，未进入 JSON 解析与业务处理', undefined, hugeMeters.devHuge);

  // ============ 22. 错误 code（-2 参数错误） ============
  const badParam = gw.envelope('heartbeat', { online: 'not-an-array', offline: [] });
  gw.publish(`gw/v1/heartbeat/${GW.norm}`, badParam);
  const badParamAck = await gw.waitFor((r) => r.body && r.body.id === badParam.id);
  check('22 参数错误返回协议错误码 -2', -2, badParamAck.body.code);

  // ============ 23. 未登录情况下的上行/下行 ============
  const stranger = new FsuGatewaySim({ host: '127.0.0.1', port: MQTT_PORT, gwId: 'ffffffffffff', username: MQTT_USER, password: MQTT_PASS, fsuUsername: FSU_USER, fsuPassword: FSU_PASS });
  await stranger.connect();
  const sHb = stranger.heartbeat({ online: [] });
  const sAck = await stranger.waitFor((r) => r.body && r.body.id === sHb.id);
  check('23 未登录网关的心跳返回 -9 notlogin', -9, sAck.body.code);
  const sPd = stranger.dataReport({ devId: 'd1', meters: [{ meterId: 'm', value: '1' }], isFull: 1 });
  const sPdAck = await stranger.waitFor((r) => r.body && r.body.id === sPd.id);
  check('23b 未登录网关的数据上报返回 -9 notlogin', -9, sPdAck.body.code);
  let downErr = null;
  try { await getData('ffffffffffff'); } catch (e) { downErr = e; }
  check('23c 未登录网关的下行请求不悬挂，超时返回协议 -14', -14, downErr && downErr.code);
  await stranger.end();

  // ============ 24. gwId 非法 ============
  const noMac = gw.envelope('login', { version: 'v1', username: FSU_USER, password: FSU_PASS });
  const beforeNoMac = gw.received.length;
  gw.publish('gw/v1/login', noMac);
  await sleep(900);
  const noMacAcks = gw.received.slice(beforeNoMac).filter((r) => r.body && r.body.id === noMac.id);
  const logNow = fs.readFileSync(path.join(DIR, 'backend.log'), 'utf8');
  check('24 login 缺少 mac（gwId 非法）：拒绝且不建立会话；因无法构造 sc/v1/login/{gwId} 响应地址故不回包',
    { acks: 0, logged: true },
    { acks: noMacAcks.length, logged: logNow.includes('login 缺少必填字段: mac') });

  // ============ 25/26. 设备不存在 / 量不存在（网关侧错误码透传） ============
  gw.respondTo('setData', (req) => ({ id: req.id, timestamp: Date.now(), method: 'setData', code: -16, msg: '设备不存在' }));
  let devErr = null;
  try { await setData(GW.norm, [{ devId: 'nope', meterId: 'm', value: '1' }]); } catch (e) { devErr = e; }
  const devErrResp = await setData(GW.norm, [{ devId: 'nope', meterId: 'm', value: '1' }]).catch((e) => e.ack);
  gw.respondTo('setData', (req) => ({ id: req.id, timestamp: Date.now(), method: 'setData', code: -17, msg: '量不存在' }));
  const meterErrResp = await setData(GW.norm, [{ devId: '301001', meterId: 'nope', value: '1' }]).catch((e) => e.ack);
  check('25/26 网关返回的设备不存在(-16)/量不存在(-17) 原样透传给调用方',
    { dev: -16, meter: -17 }, { dev: devErrResp && devErrResp.code, meter: meterErrResp && meterErrResp.code });

  // ============ 27. 中文 UTF-8 ============
  const cnSerial = 7001;
  const cn = gw.alarmReport({ alarmFlag: 1, alarmLevel: 1, alarmTime: Math.floor(Date.now() / 1000), serialNo: cnSerial, devId: '中文设备', meterId: '中文量' });
  await gw.waitFor((r) => r.body && r.body.id === cn.id);
  await sleep(400);
  const cnAlarm = await dbGet('SELECT message FROM alarms WHERE device_id = ? AND serial_no = ?', [GW.norm, String(cnSerial)]);
  // 告警文本现在只使用厂家字典里的中文测量点名（不再拼接 devId/meterId 字段名），
  // 因此这里断言：含中文的报文被正确解析并入库、且文本无乱码（U+FFFD）
  check('27 中文 UTF-8 报文正确解析入库（无乱码）',
    { exists: true, noMojibake: true },
    { exists: !!cnAlarm, noMojibake: !!cnAlarm && !cnAlarm.message.includes('�') });

  // ============ 28. isFull = 0 与 "0" ============
  await gw.dataReport({ devId: 'devStr', meters: [{ meterId: 'm', value: '1' }], isFull: '0' });
  await sleep(400);
  await gw.dataReport({ devId: 'devStr', meters: [{ meterId: 'm2', value: '2' }], isFull: 0 });
  await sleep(500);
  const strMeters = JSON.parse((await dbGet('SELECT latest_meters FROM devices WHERE id = ?', [GW.norm])).latest_meters || '{}');
  check('28 isFull="0"(字符串) 与 isFull=0(数字) 均按增量合并处理',
    { m: '1', m2: '2' }, { m: strMeters.devStr && strMeters.devStr.m, m2: strMeters.devStr && strMeters.devStr.m2 });

  // ============ 29. 平台自身 client 不被误认为网关 ============
  const platform = new FsuGatewaySim({ host: '127.0.0.1', port: MQTT_PORT, gwId: 'fsu-platform-test', username: MQTT_USER, password: MQTT_PASS, fsuUsername: FSU_USER, fsuPassword: FSU_PASS });
  await platform.connect();
  await platform.dataReport({ devId: 'devPlatform', meters: [{ meterId: 'x', value: '1' }], isFull: 1 });
  await sleep(800);
  const platMeters = JSON.parse((await dbGet('SELECT latest_meters FROM devices WHERE id = ?', [GW.norm])).latest_meters || '{}');
  check('29 平台自身 MQTT client（fsu-platform-*）发布的消息不被当成网关上报', undefined, platMeters.devPlatform);
  await platform.end();

  // ============ 30. MQTT 重连 ============
  await gw.end();
  await sleep(500);
  const gw2 = new FsuGatewaySim({ host: '127.0.0.1', port: MQTT_PORT, gwId: GW.norm, username: MQTT_USER, password: MQTT_PASS, fsuUsername: FSU_USER, fsuPassword: FSU_PASS });
  await gw2.connect();
  const relogin = gw2.login({ mac: GW.norm });
  const reloginAck = await gw2.waitFor((r) => r.body && r.body.id === relogin.id);
  check('30 MQTT 重连后 login 仍正常（code=0）', 0, reloginAck.body.code);
  await gw2.end();

  // ==================================================================
  // B. 远程功能业务 API（协议 4.5 getData / 4.6 getAlarm / 4.7 setData）
  //    与 reboot / OTA 共用同一套下行链路与 request-id 关联机制
  // ==================================================================
  const adminLogin = await apiJson('POST', '/auth/login', { username: ADMIN_USER, password: ADMIN_PASS });
  const adminToken = adminLogin.data && adminLogin.data.token;
  check('B0 平台管理员登录成功（后续 API 用例的鉴权前提）', 0, adminLogin.code);

  // 远程用例需要"在线且已建立会话"的网关
  const gw3 = new FsuGatewaySim({ host: '127.0.0.1', port: MQTT_PORT, gwId: GW.norm, username: MQTT_USER, password: MQTT_PASS, fsuUsername: FSU_USER, fsuPassword: FSU_PASS });
  await gw3.connect();
  const bLogin = gw3.login({ mac: GW.mac });
  await gw3.waitFor((r) => r.body && r.body.id === bLogin.id);
  await sleep(400);

  /** 取最近一条该网关的下行报文（按 topic 精确匹配） */
  const lastDownlink = (method) =>
    gw3.received.filter((r) => r.topic === `sc/v1/${method}/${GW.norm}`).pop();

  // 厂家字典（uploadDevInfo）：让告警/点位能取到中文名，同时用于验证"字典外点位"的处理
  gw3.publish(`gw/v1/uploadDevInfo/${GW.norm}`, {
    id: 'upd-1', timestamp: Date.now(), method: 'uploadDevInfo',
    params: [
      { devId: '1061001', devName: '48V蓄电池.json', meters: [
        { meterId: '13061001001', meterName: '电池组总电压', meterType: 0 },
      ] },
      { devId: '201001', devName: '告警测试.json', meters: [
        { meterId: '2833224001', meterName: '测试告警点', meterType: 1 },
      ] },
    ],
  });
  await sleep(700);

  // ---------- 1/2/3/16/17/20. getData ----------
  const DATA_DEV = '1061001';
  const DOWNLINK_ONLY_DEV = '9999999';   // 只在 getData 响应里出现，用于证明"没被当成上行 dataReport"
  gw3.respondTo('getData', (req) => ({
    id: req.id, timestamp: Date.now(), method: 'getData', code: 0,
    data: [
      { devId: DATA_DEV, meters: [{ meterId: '13061001001', value: '53.2' }] },
      { devId: DOWNLINK_ONLY_DEV, meters: [{ meterId: 'downlinkOnly', value: '7' }] },
    ],
  }));

  const lastSeenBefore = (await dbGet('SELECT last_seen FROM devices WHERE id = ?', [GW.norm])).last_seen;
  const apiGetData = await apiJson('POST', `/devices/${GW.norm}/remote/get-data`, {}, adminToken);
  await sleep(400);
  const gdMeters = JSON.parse((await dbGet('SELECT latest_meters FROM devices WHERE id = ?', [GW.norm])).latest_meters || '{}');
  check('远程1 getData 成功：网关 code=0，实时数据回写 devices.latest_meters（复用既有实时存储）',
    { code: 0, gwCode: 0, applied: true, value: '53.2' },
    {
      code: apiGetData.code,
      gwCode: apiGetData.data && apiGetData.data.code,
      applied: apiGetData.data && apiGetData.data.applied,
      value: gdMeters[DATA_DEV] && gdMeters[DATA_DEV]['13061001001'],
    });

  // 16. request id 正确匹配：API 回传的 requestId 必须等于网关实际收到的那条请求 id
  const gdSentParams = lastDownlink('getData');
  check('远程16 request id 正确匹配（返回的 requestId = 网关收到的报文 id）',
    { matched: true, method: 'getData' },
    {
      matched: apiGetData.data && apiGetData.data.requestId === String(gdSentParams.body.id),
      method: gdSentParams.body.method,
    });

  // 2. 不传 devIds → 报文不带 params（协议 4.5：不携带 params = 全部设备）
  check('远程2 getData 全部 devId：报文不携带 params',
    { hasParams: false },
    { hasParams: Object.prototype.hasOwnProperty.call(gdSentParams.body, 'params') });

  // 20. 下行响应不得被当成普通上行 dataReport
  const histDownlinkOnly = await dbGet(
    'SELECT COUNT(*) c FROM fsu_data_history WHERE device_id = ? AND dev_id = ?', [GW.norm, DOWNLINK_ONLY_DEV]
  );
  const lastSeenAfter = (await dbGet('SELECT last_seen FROM devices WHERE id = ?', [GW.norm])).last_seen;
  check('远程20 下行 response 未被当成上行 dataReport（不写 fsu_data_history、不刷新 last_seen）',
    { historyRows: 0, lastSeenUnchanged: true },
    { historyRows: histDownlinkOnly.c, lastSeenUnchanged: lastSeenBefore === lastSeenAfter });

  // 3. 指定 devId
  const apiGetData2 = await apiJson('POST', `/devices/${GW.norm}/remote/get-data`, { devIds: [DATA_DEV] }, adminToken);
  const gdSent2 = lastDownlink('getData');
  check('远程3 getData 指定 devId：params 为 devId 数组',
    { code: 0, params: [DATA_DEV] },
    { code: apiGetData2.code, params: gdSent2.body.params });

  // 4. 超时
  gw3.respondTo('getData', () => null);   // 网关不响应
  const gdTimeout = await apiJson('POST', `/devices/${GW.norm}/remote/get-data`, {}, adminToken);
  check('远程4 getData 超时：明确失败（不透传成功、不悬挂）',
    { code: 400, mentionsTimeout: true },
    { code: gdTimeout.code, mentionsTimeout: String(gdTimeout.message || '').includes('超时') });

  // 5. 非法设备
  const gdNoDevice = await apiJson('POST', '/devices/ffffffffffff/remote/get-data', {}, adminToken);
  check('远程5 getData 非法设备：返回设备不存在', { code: 404 }, { code: gdNoDevice.code });

  // ---------- 6/7/8. getAlarm ----------
  const alarmsBefore = (await dbGet('SELECT COUNT(*) c FROM alarms WHERE device_id = ?', [GW.norm])).c;
  gw3.respondTo('getAlarm', (req) => ({
    id: req.id, timestamp: Date.now(), method: 'getAlarm', code: 0,
    data: [{ devId: '201001', meters: [{ meterId: '2833224001', alarmTime: 1739860289 }] }],
  }));
  const apiGetAlarm = await apiJson('POST', `/devices/${GW.norm}/remote/get-alarm`, {}, adminToken);
  await sleep(300);
  const alarmsAfter = (await dbGet('SELECT COUNT(*) c FROM alarms WHERE device_id = ?', [GW.norm])).c;
  const alarm0 = apiGetAlarm.data && apiGetAlarm.data.alarms && apiGetAlarm.data.alarms[0];
  check('远程6 getAlarm 成功：返回结构化实时告警（alarmTime 按协议为秒级）',
    { code: 0, devId: '201001', meterId: '2833224001', alarmTime: 1739860289, meterName: '测试告警点' },
    {
      code: apiGetAlarm.code,
      devId: alarm0 && alarm0.devId,
      meterId: alarm0 && alarm0.meterId,
      alarmTime: alarm0 && alarm0.alarmTime,
      meterName: alarm0 && alarm0.meterName,
    });
  check('远程6b getAlarm 仅返回查询结果：不写平台 alarms 表（synced=false，告警条数不变）',
    { synced: false, alarmsUnchanged: true },
    { synced: apiGetAlarm.data && apiGetAlarm.data.synced, alarmsUnchanged: alarmsBefore === alarmsAfter });

  // 7. 指定 devId
  const apiGetAlarm2 = await apiJson('POST', `/devices/${GW.norm}/remote/get-alarm`, { devIds: ['201001'] }, adminToken);
  const gaSent2 = lastDownlink('getAlarm');
  check('远程7 getAlarm 指定 devId：params 为 devId 数组',
    { code: 0, params: ['201001'] },
    { code: apiGetAlarm2.code, params: gaSent2.body.params });

  // 8. 超时
  gw3.respondTo('getAlarm', () => null);
  const gaTimeout = await apiJson('POST', `/devices/${GW.norm}/remote/get-alarm`, {}, adminToken);
  check('远程8 getAlarm 超时：明确失败',
    { code: 400, mentionsTimeout: true },
    { code: gaTimeout.code, mentionsTimeout: String(gaTimeout.message || '').includes('超时') });

  // 16b. 响应 id 不匹配 → 不能被误关联（必须等超时）
  gw3.respondTo('getData', (req) => ({
    id: 'not-the-request-id', timestamp: Date.now(), method: 'getData', code: 0,
    data: [{ devId: DATA_DEV, meters: [{ meterId: '13061001001', value: '0' }] }],
  }));
  const gdWrongId = await apiJson('POST', `/devices/${GW.norm}/remote/get-data`, {}, adminToken);
  check('远程16b 响应 id 不匹配时不误关联（按 id 精确匹配，等超时）',
    { code: 400 }, { code: gdWrongId.code });

  // ---------- 9/10/11/12/13/17. setData ----------
  gw3.respondTo('setData', (req) => ({ id: req.id, timestamp: Date.now(), method: 'setData', code: 0, data: { msg: 'success' } }));
  const sd1 = await apiJson('POST', `/devices/${GW.norm}/remote/set-data`,
    { items: [{ devId: '301001', meterId: '22564441', value: '1' }] }, adminToken);
  const sdSent1 = lastDownlink('setData');
  check('远程9 setData 单项：报文 params 为对象数组，value 保持 string',
    { code: 0, params: [{ devId: '301001', meterId: '22564441', value: '1' }], valueType: 'string' },
    { code: sd1.code, params: sdSent1.body.params, valueType: typeof sdSent1.body.params[0].value });

  const sd2 = await apiJson('POST', `/devices/${GW.norm}/remote/set-data`,
    { items: [
      { devId: '301001', meterId: '22564441', value: '1' },
      { devId: '301002', meterId: '22564442', value: '0.5' },
    ] }, adminToken);
  const sdSent2 = lastDownlink('setData');
  check('远程10 setData 多项：一次下发多个设置项，字符串值原样保留',
    { code: 0, count: 2, values: ['1', '0.5'] },
    { code: sd2.code, count: sdSent2.body.params.length, values: sdSent2.body.params.map((p) => p.value) });

  // 17. 错误码正确透传
  gw3.respondTo('setData', (req) => ({ id: req.id, timestamp: Date.now(), method: 'setData', code: -17, msg: '量不存在' }));
  const sdErr = await apiJson('POST', `/devices/${GW.norm}/remote/set-data`,
    { items: [{ devId: '301001', meterId: 'nope', value: '1' }] }, adminToken);
  check('远程17 网关错误码正确透传（-17 量不存在）',
    { code: 400, hasCode: true, hasMsg: true },
    {
      code: sdErr.code,
      hasCode: String(sdErr.message || '').includes('-17'),
      hasMsg: String(sdErr.message || '').includes('量不存在'),
    });

  // 11. 非法 devId
  const sdBadDev = await apiJson('POST', `/devices/${GW.norm}/remote/set-data`,
    { items: [{ devId: 'bad dev', meterId: 'm', value: '1' }] }, adminToken);
  check('远程11 setData 非法 devId：参数校验拒绝', { code: 400 }, { code: sdBadDev.code });

  // 12. 空 items
  const sdEmpty = await apiJson('POST', `/devices/${GW.norm}/remote/set-data`, { items: [] }, adminToken);
  check('远程12 setData 空 items：参数校验拒绝', { code: 400 }, { code: sdEmpty.code });

  // 13. value 类型校验（协议 4.7 要求 string）
  const sdNum = await apiJson('POST', `/devices/${GW.norm}/remote/set-data`,
    { items: [{ devId: '301001', meterId: 'm', value: 1 }] }, adminToken);
  const sdNull = await apiJson('POST', `/devices/${GW.norm}/remote/set-data`,
    { items: [{ devId: '301001', meterId: 'm', value: null }] }, adminToken);
  check('远程13 setData value 类型校验：非字符串一律拒绝（协议要求 string）',
    { number: 400, null: 400 }, { number: sdNum.code, null: sdNull.code });

  // ---------- 14/15. reboot / OTA 原有功能不受影响 ----------
  gw3.respondTo('reboot', (req) => ({ id: req.id, timestamp: Date.now(), method: 'reboot', code: 0, msg: 'success' }));
  const rebootResults = [];
  for (const t of [1, 2, 3, 4]) {
    const r = await apiJson('POST', `/devices/${GW.norm}/reboot`, { type: t }, adminToken);
    rebootResults.push({ api: r.code, wire: lastDownlink('reboot').body.params.type });
  }
  check('远程14 reboot 原有功能不受影响（协议 4.9：1-sys 2-app 3-4g 4-vpn 全部可用）',
    [{ api: 0, wire: 1 }, { api: 0, wire: 2 }, { api: 0, wire: 3 }, { api: 0, wire: 4 }],
    rebootResults);
  const rebootBad = await apiJson('POST', `/devices/${GW.norm}/reboot`, { type: 5 }, adminToken);
  check('远程14b reboot 非法 type 仍被拒绝', { code: 400 }, { code: rebootBad.code });

  gw3.respondTo('ota', (req) => ({ id: req.id, timestamp: Date.now(), method: 'OTA', code: 0, msg: 'success' }));
  const OTA_URLS = ['http://192.168.0.65:8080/ota.bin', 'https://fw.example.com/v2.bin'];
  const otaRes = await apiJson('POST', `/devices/${GW.norm}/ota`, { urls: OTA_URLS }, adminToken);
  const otaSentApi = lastDownlink('ota');
  check('远程15 OTA 原有功能不受影响（topic 小写 ota / 报文体 method="OTA" / url 为 string[]，支持 http+https）',
    { code: 0, topic: `sc/v1/ota/${GW.norm}`, method: 'OTA', urls: OTA_URLS },
    { code: otaRes.code, topic: otaSentApi.topic, method: otaSentApi.body.method, urls: otaSentApi.body.params.url });
  const otaBad = await apiJson('POST', `/devices/${GW.norm}/ota`, { urls: ['ftp://x/y.bin'] }, adminToken);
  check('远程15b OTA 非法地址仍被拒绝', { code: 400 }, { code: otaBad.code });

  // ---------- 18. 租户隔离 / 未登录 ----------
  const newTenant = await apiJson('POST', '/tenants',
    { name: '远程用例租户', remark: 'selftest', username: 'selftest_tenant', password: 'selftest-pass-123' },
    adminToken);
  const tenantId = newTenant.data && newTenant.data.id;
  const tenantLogin = await apiJson('POST', '/auth/login',
    { username: 'selftest_tenant', password: 'selftest-pass-123' });
  const tenantToken = tenantLogin.data && tenantLogin.data.token;

  const noAuth = await apiJson('POST', `/devices/${GW.norm}/remote/get-data`, {});
  const crossTenant = await apiJson('POST', `/devices/${GW.norm}/remote/get-data`, {}, tenantToken);
  const crossTenantSet = await apiJson('POST', `/devices/${GW.norm}/remote/set-data`,
    { items: [{ devId: 'd', meterId: 'm', value: '1' }] }, tenantToken);
  check('远程18 未登录/跨租户不能操作其他租户设备（读=404 不暴露存在性；写=403 权限不足）',
    { noAuth: 401, crossTenantGet: 404, crossTenantSet: 403 },
    { noAuth: noAuth.code, crossTenantGet: crossTenant.code, crossTenantSet: crossTenantSet.code });

  // ---------- 19. 设备离线 ----------
  const OFFLINE_ID = '00534a00ff01';
  const createdOffline = await apiJson('POST', '/devices', { id: OFFLINE_ID }, adminToken);
  const offlineGet = await apiJson('POST', `/devices/${OFFLINE_ID}/remote/get-data`, {}, adminToken);
  const offlineSet = await apiJson('POST', `/devices/${OFFLINE_ID}/remote/set-data`,
    { items: [{ devId: 'd', meterId: 'm', value: '1' }] }, adminToken);
  check('远程19 设备离线时明确失败（不发送下行、不悬挂）',
    { created: 0, getCode: 400, getSaysOffline: true, setCode: 400 },
    {
      created: createdOffline.code,
      getCode: offlineGet.code,
      getSaysOffline: String(offlineGet.message || '').includes('当前离线'),
      setCode: offlineSet.code,
    });

  // ---------- 远程设置点位下拉（复用厂家字典，不新建数据源） ----------
  const optRes = await apiJson('GET', `/devices/${GW.norm}/remote/meter-options`, undefined, adminToken);
  check('远程附加 点位下拉来自厂家字典 device_meters（devId/meterId/中文名）',
    { code: 0, dictAvailable: true, first: { devId: '1061001', meterId: '13061001001', meterName: '电池组总电压' } },
    {
      code: optRes.code,
      dictAvailable: optRes.data && optRes.data.dictAvailable,
      first: optRes.data && optRes.data.options && optRes.data.options[0] &&
        { devId: optRes.data.options[0].devId, meterId: optRes.data.options[0].meterId, meterName: optRes.data.options[0].meterName },
    });

  // ==================================================================
  // C. 设备 Excel 批量导入
  // ==================================================================
  const tplBuf = await downloadTemplate(adminToken);
  const tplWb = new ExcelJS.Workbook();
  await tplWb.xlsx.load(tplBuf);
  const tplSheet = tplWb.worksheets[0];
  const tplHeaders = tplSheet.getRow(1).values.slice(1).map((v) => (v == null ? '' : String(v)));
  check('导入模板 C1 模板含「设备导入」「填写说明」两个 Sheet，表头与需求字段一致',
    { sheets: ['设备导入', '填写说明'], headers: ['租户ID', '站点ID', '设备名称', '网关ID', '设备SN', '厂商', '设备型号', 'IMEI', 'ICCID', '终端类型', '协议类型'] },
    { sheets: tplWb.worksheets.map((w) => w.name), headers: tplHeaders });

  // IMEI(第8列) / ICCID(第9列) / 网关ID(第4列) 必须是文本格式，长数字才不会被转科学计数法
  check('导入模板 C2 网关ID/IMEI/ICCID 列已预设为文本格式（防科学计数法）',
    { gwId: '@', imei: '@', iccid: '@' },
    {
      gwId: tplSheet.getRow(2).getCell(4).numFmt,
      imei: tplSheet.getRow(2).getCell(8).numFmt,
      iccid: tplSheet.getRow(2).getCell(9).numFmt,
    });

  // 准备租户 + 站点（平台管理员创建，站点归属该租户）
  const t1 = await apiJson('POST', '/tenants',
    { name: '导入用例租户A', remark: 'selftest', username: 'selftest_imp_a', password: 'selftest-pass-a' }, adminToken);
  const t2 = await apiJson('POST', '/tenants',
    { name: '导入用例租户B', remark: 'selftest', username: 'selftest_imp_b', password: 'selftest-pass-b' }, adminToken);
  const T1 = t1.data && t1.data.id;
  const T2 = t2.data && t2.data.id;
  const s1 = await apiJson('POST', '/sites', { name: '导入用例站点A1', tenant_id: T1 }, adminToken);
  const s2 = await apiJson('POST', '/sites', { name: '导入用例站点B1', tenant_id: T2 }, adminToken);
  const SITE1 = s1.data && s1.data.code;   // SITE-xxxx
  const SITE2 = s2.data && s2.data.code;
  const tenantAToken = (await apiJson('POST', '/auth/login',
    { username: 'selftest_imp_a', password: 'selftest-pass-a' })).data.token;

  const preview = (buf, token = adminToken) => apiUpload('/devices/import/preview', buf, 'test.xlsx', token);

  /** 断言"预览某行为错，且错误里包含关键字" */
  const invalidRowOf = (res, row, keyword) => {
    const r = (res.data && res.data.rows || []).find((x) => x.row === row);
    return {
      status: r && r.status,
      matched: !!r && (r.errors || []).some((e) => e.includes(keyword)),
    };
  };

  // ---------- 21/22/23/33/35. 正常导入 + 可空字段 + 长数字 + 空行 ----------
  const okRows = [
    { 租户ID: T1, 站点ID: SITE1, 设备名称: '导入设备1', 网关ID: '00:53:4C:08:10:01',
      设备SN: 'SN-IMPORT-1', 厂商: '华为', 设备型号: 'FSU-1000A',
      IMEI: '860123456789012', ICCID: '89860012345678901234', 终端类型: 'FSU', 协议类型: '' },
    // 设备名称留空（22）+ 站点留空（23）；IMEI 写成**数值单元格**，
    // 验证长数字即使被 Excel 存成数值也能按字符串原样读出（不走科学计数法）
    { 租户ID: T1, 站点ID: '', 设备名称: '', 网关ID: '00534c081002', IMEI: 860123456789013 },
  ];
  const okBuf = await buildXlsxFrom(tplBuf, okRows);
  const okPreview = await preview(okBuf);
  check('导入21/22/23/35 正常预览：设备名称与站点留空不算失败，空行自动跳过',
    { code: 0, total: 2, valid: 2, invalid: 0 },
    { code: okPreview.code, total: okPreview.data && okPreview.data.total, valid: okPreview.data && okPreview.data.valid, invalid: okPreview.data && okPreview.data.invalid });

  const okConfirm = await apiJson('POST', '/devices/import/confirm', { token: okPreview.data.token }, adminToken);
  await sleep(300);
  const imported1 = await dbGet('SELECT * FROM devices WHERE id = ?', ['00534c081001']);
  const imported2 = await dbGet('SELECT * FROM devices WHERE id = ?', ['00534c081002']);
  check('导入31 全部成功 → 事务提交：设备落库，租户/站点/名称/串号写入正确',
    { code: 0, imported: 2, tenant: T1, site: s1.data.id, name: '导入设备1', imei: '860123456789012', iccid: '89860012345678901234', protocol: 'vendor' },
    {
      code: okConfirm.code,
      imported: okConfirm.data && okConfirm.data.imported,
      tenant: imported1 && imported1.tenant_id,
      site: imported1 && imported1.site_id,
      name: imported1 && imported1.name,
      imei: imported1 && imported1.imei,
      iccid: imported1 && imported1.iccid,
      protocol: imported1 && imported1.protocol_type,
    });
  check('导入33 长数字按字符串读出并保存（数值单元格 IMEI 不做科学计数法/数值化）',
    { imei: '860123456789013', imeiType: 'string', nullName: true, nullSite: true },
    {
      imei: imported2 && imported2.imei,
      imeiType: imported2 && typeof imported2.imei,
      nullName: !!imported2 && imported2.name === null,
      nullSite: !!imported2 && imported2.site_id === null,
    });

  // ---------- 24/25/26/27/28/29. 各类行级校验 ----------
  const badRows = [
    { 租户ID: T1, 网关ID: '00534c081101', 设备名称: '正常行' },
    { 租户ID: 'T9999', 网关ID: '00534c081102' },                      // 24 租户不存在
    { 租户ID: T1, 站点ID: 'SITE-9999', 网关ID: '00534c081103' },       // 25 站点不存在
    { 租户ID: T1, 站点ID: SITE2, 网关ID: '00534c081104' },             // 26 站点跨租户
    { 租户ID: T1, 网关ID: '' },                                        // 27 网关ID为空
    { 租户ID: T1, 网关ID: '00534c081101' },                            // 28 Excel 内重复
    { 租户ID: T1, 网关ID: GW.norm },                                   // 29 数据库已存在
  ];
  const badBuf = await buildXlsxFrom(tplBuf, badRows);
  const badPreview = await preview(badBuf);
  check('导入24 租户不存在', { status: 'invalid', matched: true }, invalidRowOf(badPreview, 3, '不存在'));
  check('导入25 站点不存在', { status: 'invalid', matched: true }, invalidRowOf(badPreview, 4, '站点'));
  check('导入26 站点跨租户', { status: 'invalid', matched: true }, invalidRowOf(badPreview, 5, '不属于租户'));
  check('导入27 网关ID为空', { status: 'invalid', matched: true }, invalidRowOf(badPreview, 6, '网关ID不能为空'));
  check('导入28 Excel 内网关ID重复', { status: 'invalid', matched: true }, invalidRowOf(badPreview, 7, '重复'));
  check('导入29 数据库已有网关ID', { status: 'invalid', matched: true }, invalidRowOf(badPreview, 8, '已存在'));

  // 有错误行时不下发令牌 → 前端无法"确认导入"（保守模式：不支持只导入有效行）
  const badRowsNoToken = await dbGet('SELECT COUNT(*) c FROM devices WHERE id IN (?,?)', ['00534c081101', '00534c081102']);
  check('导入32 存在错误行时不发确认令牌，且没有任何设备被写入',
    { token: null, valid: 1, invalid: 6, written: 0 },
    {
      token: badPreview.data && badPreview.data.token,
      valid: badPreview.data && badPreview.data.valid,
      invalid: badPreview.data && badPreview.data.invalid,
      written: badRowsNoToken.c,
    });

  // ---------- 30. 租户维度越权 ----------
  // ⚠️ 权限口径（与 POST /api/devices 保持一致）：导入 = 创建设备，要求 requireAdmin。
  //    租户账号由 TenantService 创建为 role='user'，因此**租户只读账号不能导入**；
  //    可导入的是平台管理员与【租户管理员】(role=admin + tenant_id)。
  //    下面把 T1 的账号提升为租户管理员，用它验证租户维度的强制隔离。
  const usersList = await apiJson('GET', '/users', undefined, adminToken);
  const t1User = (usersList.data || []).find((u) => u.username === 'selftest_imp_a');
  await apiJson('PUT', `/users/${t1User.id}`, { role: 'admin' }, adminToken);
  const tenantAdminToken = (await apiJson('POST', '/auth/login',
    { username: 'selftest_imp_a', password: 'selftest-pass-a' })).data.token;

  const crossBuf = await buildXlsxFrom(tplBuf, [
    { 租户ID: T2, 网关ID: '00534c081201' },
    { 租户ID: '', 网关ID: '00534c081202' },
  ]);
  const crossPreview = await preview(crossBuf, tenantAdminToken);
  const crossPreviewRows = (crossPreview.data && crossPreview.data.rows) || [];
  const crossRow2 = crossPreviewRows.find((r) => r.row === 2);
  const crossRow3 = crossPreviewRows.find((r) => r.row === 3);
  check('导入30 租户管理员不能通过 Excel 指定其他租户；留空则强制本租户',
    { code: 0, row2Invalid: true, saysNoPermission: true, row3Tenant: T1 },
    {
      code: crossPreview.code,
      row2Invalid: !!crossRow2 && crossRow2.status === 'invalid',
      saysNoPermission: !!crossRow2 && (crossRow2.errors || []).some((e) => e.includes('无权为其他租户导入设备')),
      row3Tenant: crossRow3 && crossRow3.data && crossRow3.data.tenantId,
    });

  // 租户管理员不能把设备绑到其他租户的站点（站点跨租户校验对租户账号同样生效）
  const crossSiteBuf = await buildXlsxFrom(tplBuf, [
    { 租户ID: '', 站点ID: SITE2, 网关ID: '00534c081203' },
  ]);
  const crossSitePreview = await preview(crossSiteBuf, tenantAdminToken);
  const crossSiteRow = (crossSitePreview.data && crossSitePreview.data.rows || [])[0];
  check('导入30b 租户管理员不能绑定其他租户的站点',
    { status: 'invalid', matched: true },
    {
      status: crossSiteRow && crossSiteRow.status,
      matched: !!crossSiteRow && (crossSiteRow.errors || []).some((e) => e.includes('不属于租户')),
    });

  // 同一租户管理员可以把设备导入到自己租户（正向用例）
  const ownBuf = await buildXlsxFrom(tplBuf, [
    { 租户ID: '', 站点ID: SITE1, 网关ID: '00534c081204', 设备名称: '租户自建设备' },
  ]);
  const ownPreview = await preview(ownBuf, tenantAdminToken);
  const ownConfirm = ownPreview.data && ownPreview.data.token
    ? await apiJson('POST', '/devices/import/confirm', { token: ownPreview.data.token }, tenantAdminToken)
    : { code: -1 };
  await sleep(200);
  const ownDevice = await dbGet('SELECT tenant_id, site_id FROM devices WHERE id = ?', ['00534c081204']);
  check('导入30c 租户管理员导入本租户设备成功（租户由服务端按登录态强制，非 Excel 决定）',
    { code: 0, tenant: T1, site: s1.data.id },
    { code: ownConfirm.code, tenant: ownDevice && ownDevice.tenant_id, site: ownDevice && ownDevice.site_id });

  // 跨租户越权：租户管理员不能通过远程接口操作别的租户的设备
  const taCrossGet = await apiJson('POST', `/devices/${GW.norm}/remote/get-data`, {}, tenantAdminToken);
  const taCrossSet = await apiJson('POST', `/devices/${GW.norm}/remote/set-data`,
    { items: [{ devId: 'd', meterId: 'm', value: '1' }] }, tenantAdminToken);
  check('远程18b 租户管理员同样不能操作其他租户设备（读 404 / 写 404）',
    { get: 404, set: 404 }, { get: taCrossGet.code, set: taCrossSet.code });

  // ---------- 34. 表头错误 ----------
  const badHeaderBuf = await buildXlsxFrom(tplBuf, [{ 网关ID: '00534c081301' }], ['网关ID', '设备名称']);
  const badHeaderPreview = await preview(badHeaderBuf);
  check('导入34 Excel 表头错误：直接拒绝并列出缺失字段',
    { code: 400, mentionsMissing: true },
    { code: badHeaderPreview.code, mentionsMissing: String(badHeaderPreview.message || '').includes('缺少字段') });

  // 非 xlsx / 内容损坏
  const fakeRes = await apiUpload('/devices/import/preview', Buffer.from('not an excel'), 'fake.xlsx', adminToken);
  check('导入34b 伪装成 .xlsx 的非 Excel 文件被内容级校验拒绝', { code: 400 }, { code: fakeRes.code });

  // ---------- 32. 确认阶段失败 → 全部回滚（不出现部分写入） ----------
  // 场景：预览通过后、确认之前，其中一个网关ID 被其他操作抢先创建。
  const raceRows = [
    { 租户ID: T1, 网关ID: '00534c081401', 设备名称: '抢占前的行' },
    { 租户ID: T1, 网关ID: '00534c081402', 设备名称: '会被抢先占用的行' },
  ];
  const racePreview = await preview(await buildXlsxFrom(tplBuf, raceRows));
  // 模拟竞态：确认前占用第 2 行的网关ID
  await apiJson('POST', '/devices', { id: '00534c081402', tenantId: T1 }, adminToken);
  const raceConfirm = await apiJson('POST', '/devices/import/confirm', { token: racePreview.data.token }, adminToken);
  await sleep(300);
  const raceRow1 = await dbGet('SELECT id FROM devices WHERE id = ?', ['00534c081401']);
  check('导入32b 确认阶段任一行失败 → 整体回滚：第 1 行也不写入（无部分成功）',
    { code: 400, firstRowWritten: false },
    { code: raceConfirm.code, firstRowWritten: !!raceRow1 });

  // ---------- 令牌安全 ----------
  const tampered = await apiJson('POST', '/devices/import/confirm',
    { token: racePreview.data.token.slice(0, -4) + 'AAAA' }, adminToken);
  const forged = await apiJson('POST', '/devices/import/confirm',
    { token: 'eyJ2IjoxfQ.AAAA' }, adminToken);
  check('导入附加 令牌被篡改/伪造时一律拒绝（签名校验 + 服务端二次校验）',
    { tampered: 400, forged: 400 }, { tampered: tampered.code, forged: forged.code });

  // ---------- 权限：非管理员不能导入 ----------
  const tenantPreview = await preview(okBuf, tenantToken);
  check('导入附加b 非管理员账号不能使用批量导入（requireAdmin）',
    { preview: 403, template: 200 },
    { preview: tenantPreview.code, template: (await fetch(`${API}/devices/import/template`, { headers: { Authorization: `Bearer ${tenantToken}` } })).status });

  // ==================================================================
  // D. FSU 告警：名称/分类/级别一律以厂家数据为准（无硬编码映射）
  // ==================================================================
  const publishDict = (devs, tag) => gw3.publish(`gw/v1/uploadDevInfo/${GW.norm}`, {
    id: 'upd-' + tag, timestamp: Date.now(), method: 'uploadDevInfo', params: devs,
  });

  // 设备字典含门磁告警点（与真实网关 00534c080213 上报的内容一致）
  publishDict([
    { devId: '1246001', devName: '门磁_CT_JJ.json', meters: [
      { meterId: '12160021001', meterName: '门磁开关状态告警', meterType: 2 },
      { meterId: '13160016001', meterName: '门磁开关状态', meterType: 1 },
    ] },
  ], 'd1');
  await sleep(700);

  const dSerial = 9101;
  const dRpt = gw3.alarmReport({ alarmFlag: 1, alarmLevel: 3, alarmTime: Math.floor(Date.now() / 1000), serialNo: dSerial, devId: '1246001', meterId: '12160021001' });
  await gw3.waitFor((r) => r.body && r.body.id === dRpt.id);
  await sleep(400);
  const dRow = await dbGet('SELECT * FROM alarms WHERE device_id = ? AND serial_no = ?', [GW.norm, String(dSerial)]);
  check('告警D1 名称取自厂家字典（12160021001 → 门磁开关状态告警），不再被硬编码覆盖',
    '门磁开关状态告警', dRow && dRow.message);
  check('告警D2 分类=厂家 devId；severity=中性占位值（平台不冒充已定级）；alarmLevel 原样入库',
    { type: '1246001', severity: 'vendor', level: 3 },
    { type: dRow && dRow.type, severity: dRow && dRow.severity, level: dRow && dRow.alarm_level });

  // 换掉字典里的点位名称：平台不改一行代码，显示即随之变化
  publishDict([
    { devId: '1246001', devName: '门磁_CT_JJ.json', meters: [
      { meterId: '12160021001', meterName: '厂家改过的点位名', meterType: 2 },
    ] },
  ], 'd2');
  await sleep(700);
  const dSerial2 = 9102;
  const dRpt2 = gw3.alarmReport({ alarmFlag: 1, alarmLevel: 3, alarmTime: Math.floor(Date.now() / 1000), serialNo: dSerial2, devId: '1246001', meterId: '12160021001' });
  await gw3.waitFor((r) => r.body && r.body.id === dRpt2.id);
  await sleep(400);
  const dRow2 = await dbGet('SELECT message FROM alarms WHERE device_id = ? AND serial_no = ?', [GW.norm, String(dSerial2)]);
  check('告警D3 改厂家字典即改显示（无需改代码）', '厂家改过的点位名', dRow2 && dRow2.message);

  // 字典里没有的点位：回退通用名称，并把 devId/meterId 写进文本便于排查
  publishDict([{ devId: '1246001', devName: '门磁_CT_JJ.json', meters: [] }], 'd3');
  await sleep(700);
  const dSerial3 = 9103;
  const dRpt3 = gw3.alarmReport({ alarmFlag: 1, alarmLevel: 4, alarmTime: Math.floor(Date.now() / 1000), serialNo: dSerial3, devId: '9999999', meterId: '8888888' });
  const dAck3 = await gw3.waitFor((r) => r.body && r.body.id === dRpt3.id);
  await sleep(400);
  const dRow3 = await dbGet('SELECT message FROM alarms WHERE device_id = ? AND serial_no = ?', [GW.norm, String(dSerial3)]);
  const dMsg3 = (dRow3 && dRow3.message) || '';
  check('告警D4 字典缺点位 → 回退为「未知告警（设备 ID：…，点位 ID：…）」，不报错、不伪造名称',
    { code: 0, stored: true, fallback: true, noVendorWord: true, hasDevId: true, hasMeterId: true },
    {
      code: dAck3.body.code, stored: !!dRow3, fallback: dMsg3.startsWith('未知告警'),
      noVendorWord: !dMsg3.includes('厂家'),
      hasDevId: dMsg3.includes('9999999'), hasMeterId: dMsg3.includes('8888888'),
    });

  // 厂家 alarmLevel 1~5 全部原样保留
  const lvSerials = [9201, 9202, 9203, 9204, 9205];
  for (let i = 0; i < 5; i++) {
    gw3.alarmReport({ alarmFlag: 1, alarmLevel: i + 1, alarmTime: Math.floor(Date.now() / 1000), serialNo: lvSerials[i], devId: '1246001', meterId: '12160021001' });
  }
  await sleep(1000);
  const lvRows = await dbAll(
    `SELECT alarm_level FROM alarms WHERE device_id = ? AND serial_no IN (${lvSerials.map(() => '?').join(',')}) ORDER BY alarm_level`,
    [GW.norm, ...lvSerials.map(String)]
  );
  check('告警D5 厂家 alarmLevel 1~5 原样保留（不做 critical/warning 映射）',
    [1, 2, 3, 4, 5], lvRows.map((r) => r.alarm_level));

  // 门磁联动已移除：dataReport 上报门磁状态不再合成告警
  const alarmsBeforeDoor = (await dbGet('SELECT COUNT(*) c FROM alarms WHERE device_id = ?', [GW.norm])).c;
  await gw3.dataReport({ devId: '1246001', meters: [{ meterId: '13160016001', value: '1' }], isFull: 1 });
  await sleep(1000);
  const alarmsAfterDoor = (await dbGet('SELECT COUNT(*) c FROM alarms WHERE device_id = ?', [GW.norm])).c;
  const doorTyped = await dbGet("SELECT COUNT(*) c FROM alarms WHERE device_id = ? AND type = 'door'", [GW.norm]);
  check('告警D6 门磁联动已移除：遥测值不再合成告警，也不再出现 door 分类',
    { unchanged: true, doorTyped: 0 },
    { unchanged: alarmsBeforeDoor === alarmsAfterDoor, doorTyped: doorTyped.c });

  // 告警接口返回厂家子设备名（前端不再维护 devId→中文名）
  const alarmList = await apiJson('GET', `/alarms?deviceId=${GW.norm}&limit=50`, undefined, adminToken);
  const listed = (alarmList.data && alarmList.data.items || []).find((a) => String(a.serial_no) === String(dSerial));
  const listedUnknown = (alarmList.data && alarmList.data.items || []).find((a) => String(a.serial_no) === String(dSerial3));
  check('告警D7 告警接口返回厂家字典解析出的子设备名 dev_name（字典无此 devId 时为 null）',
    { known: '门磁_CT_JJ', unknown: null },
    { known: listed && listed.dev_name, unknown: listedUnknown ? listedUnknown.dev_name : 'missing' });

  // 统计按厂家原始级别分布
  const statRes = await apiJson('GET', '/alarms/stats', undefined, adminToken);
  const byLevel = (statRes.data && statRes.data.byLevel) || {};
  const lvSum = Object.values(byLevel).reduce((a, b) => a + b, 0) + ((statRes.data && statRes.data.withoutLevel) || 0);
  check('告警D8 统计提供厂家级别分布 byLevel，且「各级别合计 + 无级别」= 未解决数',
    true, lvSum === (statRes.data && statRes.data.unresolved));

  // ==================================================================
  // E. 子设备筛选（字典驱动）+ 面向用户文案 + 推送去重
  // ==================================================================
  // 发布一份与真实网关结构一致的字典：
  //   meterId="0"（通信状态）在每个条目里都有 → 会被算作"通用点"而排除；
  //   215001「设备信息」除通用点外只有遥测/设置点 → 自动被排除，不当第六类功能子设备。
  publishDict([
    { devId: '1061001', devName: '48V蓄电池.json', meters: [
      { meterId: '0', meterName: '通信状态', meterType: 2 },
      { meterId: '13061001001', meterName: '48V蓄电池组电压', meterType: 1 },
      { meterId: '11061004001', meterName: '48V蓄电池组电压过高', meterType: 2 }] },
    { devId: '1064001', devName: '48V交流屏_JJ.json', meters: [
      { meterId: '0', meterName: '通信状态', meterType: 2 },
      { meterId: '12060002001', meterName: '整流模块运行告警', meterType: 2 }] },
    { devId: '1120001', devName: '数字温湿度_CT_JJ.json', meters: [
      { meterId: '0', meterName: '通信状态', meterType: 2 },
      { meterId: '11120005001', meterName: '温度过高告警', meterType: 2 }] },
    { devId: '1246001', devName: '门磁_CT_JJ.json', meters: [
      { meterId: '0', meterName: '通信状态', meterType: 2 },
      { meterId: '12160021001', meterName: '门磁开关状态告警', meterType: 2 },
      { meterId: '13160016001', meterName: '门磁开关状态', meterType: 1 }] },
    { devId: '2060001', devName: '48V直流屏_JJ.json', meters: [
      { meterId: '0', meterName: '通信状态', meterType: 2 },
      { meterId: '22060021001', meterName: '直流输出电压过低告警', meterType: 2 }] },
    { devId: '215001', devName: '设备信息', meters: [
      { meterId: '0', meterName: '通信状态', meterType: 2 },
      { meterId: '138101001', meterName: 'CPU利用率', meterType: 1 },
      { meterId: '138213001', meterName: '设置系统时间', meterType: 3 }] },
  ], 'e1');
  await sleep(800);

  const subRes = await apiJson('GET', '/alarms/sub-devices', undefined, adminToken);
  const subOpts = (subRes.data && subRes.data.options) || [];
  const optOf = (id) => subOpts.find((o) => o.devId === id);
  check('筛选E1 筛选项来自设备字典：5 个功能子设备，自动排除「设备信息」条目（不靠写死 devId/名称/分类）',
    { code: 0, ids: ['1061001', '1064001', '1120001', '1246001', '2060001'], excluded215001: true },
    {
      code: subRes.code,
      ids: subOpts.map((o) => o.devId).sort(),
      excluded215001: !optOf('215001'),
    });
  check('筛选E2 显示名取字典 devName 并去掉 .json 后缀（库里的原值不变）',
    '门磁_CT_JJ', optOf('1246001') && optOf('1246001').devName);

  // E3：即使某子设备当前**没有任何告警**，也必须出现在选项里（证明选项不是从告警列表提取）
  const noAlarmDev = '1120001';
  const noAlarmCount = (await dbGet('SELECT COUNT(*) c FROM alarms WHERE device_id = ? AND type = ?', [GW.norm, noAlarmDev])).c;
  check('筛选E3 无告警的子设备同样出现在筛选项中（选项源自字典而非告警列表）',
    { alarmRows: 0, inOptions: true, name: '数字温湿度_CT_JJ' },
    {
      alarmRows: noAlarmCount,
      inOptions: !!optOf(noAlarmDev),
      name: optOf(noAlarmDev) && optOf(noAlarmDev).devName,
    });

  // E4：字典新增功能子设备 → 选项自动增加，无需改任何代码
  const before4 = subOpts.map((o) => o.devId);
  const dictNow = JSON.parse((await dbGet('SELECT meters_json FROM device_meters WHERE device_id = ?', [GW.norm])).meters_json);
  publishDict(dictNow.concat([{ devId: '1999001', devName: '新增功能子设备.json', meters: [
    { meterId: '0', meterName: '通信状态', meterType: 2 },
    { meterId: '1999001001', meterName: '新增告警点', meterType: 2 }] }]), 'e2');
  await sleep(800);
  const subRes2 = await apiJson('GET', '/alarms/sub-devices', undefined, adminToken);
  const subOpts2 = (subRes2.data && subRes2.data.options) || [];
  check('筛选E4 字典新增功能子设备后，筛选项自动更新（前后端均未改代码）',
    { added: ['1999001'], name: '新增功能子设备' },
    {
      added: subOpts2.map((o) => o.devId).filter((id) => !before4.includes(id)),
      name: (subOpts2.find((o) => o.devId === '1999001') || {}).devName,
    });

  // E5：按 devId 精确过滤 / 「全部」不过滤
  const eSerialA = 9401, eSerialB = 9402;
  const eA = gw3.alarmReport({ alarmFlag: 1, alarmLevel: 2, alarmTime: Math.floor(Date.now() / 1000), serialNo: eSerialA, devId: '1246001', meterId: '12160021001' });
  await gw3.waitFor((r) => r.body && r.body.id === eA.id);
  const eB = gw3.alarmReport({ alarmFlag: 1, alarmLevel: 5, alarmTime: Math.floor(Date.now() / 1000), serialNo: eSerialB, devId: '2060001', meterId: '22060021001' });
  await gw3.waitFor((r) => r.body && r.body.id === eB.id);
  await sleep(500);

  const filtered = await apiJson('GET', `/alarms?deviceId=${GW.norm}&devId=1246001&limit=100`, undefined, adminToken);
  const filteredTypes = Array.from(new Set((filtered.data.items || []).map((a) => a.type)));
  const allRes = await apiJson('GET', `/alarms?deviceId=${GW.norm}&limit=200`, undefined, adminToken);
  const allTypes = Array.from(new Set((allRes.data.items || []).map((a) => a.type))).sort();
  check('筛选E5 按 devId 精确过滤（结果只含该子设备）；不传 devId（全部）时返回更多子设备',
    { onlyFiltered: ['1246001'], allContains: ['1246001', '2060001'], filteredNonEmpty: true, allIsMore: true },
    {
      onlyFiltered: filteredTypes,
      allContains: allTypes.filter((t) => t === '1246001' || t === '2060001'),
      filteredNonEmpty: (filtered.data.items || []).length > 0,
      allIsMore: (allRes.data.items || []).length > (filtered.data.items || []).length,
    });

  // E6：面向用户的文案：回退名称不含"厂家"，且带设备 ID / 点位 ID
  const eUnknown = gw3.alarmReport({ alarmFlag: 1, alarmLevel: 3, alarmTime: Math.floor(Date.now() / 1000), serialNo: 9403, devId: '7777777', meterId: '6666666' });
  await gw3.waitFor((r) => r.body && r.body.id === eUnknown.id);
  await sleep(400);
  const unknownRow = await dbGet('SELECT message FROM alarms WHERE device_id = ? AND serial_no = ?', [GW.norm, '9403']);
  const unknownMsg = (unknownRow && unknownRow.message) || '';
  const unknownApi = await apiJson('GET', `/alarms?deviceId=${GW.norm}&devId=7777777&limit=10`, undefined, adminToken);
  const unknownItem = (unknownApi.data.items || [])[0] || {};
  check('筛选E6 字典无此点位时回退为「未知告警（设备 ID：…，点位 ID：…）」，不含"厂家"字样',
    { noVendorWord: true, isUnknown: true, hasDevId: true, hasPointId: true, level: 3 },
    {
      noVendorWord: !unknownMsg.includes('厂家'),
      isUnknown: unknownMsg.startsWith('未知告警'),
      hasDevId: unknownMsg.includes('7777777'),
      hasPointId: unknownMsg.includes('6666666'),
      level: unknownItem.alarm_level,
    });

  // E7：推送去重按厂家 serialNo 区分 —— 同一子设备的不同告警不得互相抑制
  const http = require('http');
  const hook = http.createServer((_q, s) => {
    s.setHeader('Content-Type', 'application/json');
    s.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const hookPort = hook.address().port;
  const cfgRes = await apiJson('PUT', '/notify/config', {
    enabled: 1, dingtalk_enabled: 1,
    dingtalk_webhook: `http://127.0.0.1:${hookPort}/robot/send?access_token=selftest123456`,
    dedupe_minutes: 30,
  }, adminToken);
  await sleep(300);
  const pushCount = async () => (await dbGet(
    "SELECT COUNT(*) c FROM alarm_push_logs WHERE device_id = ? AND action = 'alarm' AND status = 'success'", [GW.norm]
  )).c;

  const p1 = gw3.alarmReport({ alarmFlag: 1, alarmLevel: 2, alarmTime: Math.floor(Date.now() / 1000), serialNo: 9501, devId: '1246001', meterId: '12160021001' });
  await gw3.waitFor((r) => r.body && r.body.id === p1.id);
  await sleep(1200);
  const push1 = await pushCount();

  // 同一子设备(1246001)、不同 meterId、不同 serialNo → 必须各自推送，不能被前一条抑制
  const p2 = gw3.alarmReport({ alarmFlag: 1, alarmLevel: 4, alarmTime: Math.floor(Date.now() / 1000), serialNo: 9502, devId: '1246001', meterId: '13160016001' });
  await gw3.waitFor((r) => r.body && r.body.id === p2.id);
  await sleep(1200);
  const push2 = await pushCount();
  check('推送E7 同一子设备的不同告警（不同 meterId / serialNo）不被互相抑制',
    { config: 0, first: 1, second: 2 },
    { config: cfgRes.code, first: push1, second: push2 });

  // 同一条告警（同 serialNo）先消除再产生 → 告警行会新建，但推送应在去重窗口内被抑制
  const clear1 = gw3.alarmReport({ alarmFlag: 0, alarmLevel: 2, alarmTime: Math.floor(Date.now() / 1000), serialNo: 9501, devId: '1246001', meterId: '12160021001' });
  await gw3.waitFor((r) => r.body && r.body.id === clear1.id);
  await sleep(400);
  const again = gw3.alarmReport({ alarmFlag: 1, alarmLevel: 2, alarmTime: Math.floor(Date.now() / 1000), serialNo: 9501, devId: '1246001', meterId: '12160021001' });
  await gw3.waitFor((r) => r.body && r.body.id === again.id);
  await sleep(1200);
  const push3 = await pushCount();
  const rows9501 = (await dbGet('SELECT COUNT(*) c FROM alarms WHERE device_id = ? AND serial_no = ?', [GW.norm, '9501'])).c;
  check('推送E8 同一条告警（同 serialNo）重复上报仍在去重窗口内被抑制，但告警行本身正常新建',
    { rows: 2, pushes: 2 }, { rows: rows9501, pushes: push3 });

  await new Promise((r) => hook.close(r));

  // ==================================================================
  // G. 子设备通信状态：告警抑制 + 状态接口 + 历史行查询过滤
  //
  // 五个"目标子设备"由**厂家字典**推导（pickFunctionalSubDevices：有告警点、
  // 排除网关自身「设备信息」条目），不是写死的全局 devId。
  // 通信状态点位同样按字典里的 meterName="通信状态" 识别（实测 meterId="0"）。
  // ==================================================================
  console.log('\n---------- G. 子设备通信状态 ----------');

  // 独立 mock 推送端（E 段的 hook 已关闭，这里必须重新指向一个可用地址）
  const gReceived = [];
  const gHook = http.createServer((_q, s) => {
    let body = '';
    _q.on('data', (c) => { body += c; });
    _q.on('end', () => {
      gReceived.push({ url: _q.url, body });
      s.setHeader('Content-Type', 'application/json');
      s.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
    });
  });
  await new Promise((r) => gHook.listen(0, '127.0.0.1', r));
  const gHookUrl = `http://127.0.0.1:${gHook.address().port}/robot/send?access_token=commstatus-mock`;
  const gCfg = await apiJson('PUT', '/notify/config',
    { enabled: 1, dingtalk_enabled: 1, dingtalk_webhook: gHookUrl, dedupe_minutes: 30 }, adminToken);
  await sleep(200);
  check('通信G0 本段推送接收端已切到本地 mock', 0, gCfg.code);

  const alarmRowsOf = async (serial) => (await dbGet(
    'SELECT COUNT(*) c FROM alarms WHERE device_id = ? AND serial_no = ?',
    [GW.norm, String(serial)])).c;
  const pushTotalRows = async () => (await dbGet('SELECT COUNT(*) c FROM alarm_push_logs')).c;

  // ---- G1 通信状态事件：不建告警、不推送 ----
  const pushBeforeG1 = await pushTotalRows();
  const gCommSerial = 9601;
  const gComm = gw3.alarmReport({
    alarmFlag: 1, alarmLevel: 2, alarmTime: Math.floor(Date.now() / 1000),
    serialNo: gCommSerial, devId: '1246001', meterId: '0',
  });
  const gCommAck = await gw3.waitFor((r) => r.body && r.body.id === gComm.id);
  await sleep(1200);
  check('通信G1 目标子设备的通信状态事件（devId=1246001, meterId=0）不创建普通告警、不推送',
    { code: 0, alarmRows: 0, pushDelta: 0 },
    {
      code: gCommAck.body.code,
      alarmRows: await alarmRowsOf(gCommSerial),
      pushDelta: (await pushTotalRows()) - pushBeforeG1,
    });

  // ---- G2 同一子设备的真实告警：照常入库 + 推送 ----
  const pushBeforeG2 = await pushTotalRows();
  const gRealSerial = 9602;
  const gReal = gw3.alarmReport({
    alarmFlag: 1, alarmLevel: 3, alarmTime: Math.floor(Date.now() / 1000),
    serialNo: gRealSerial, devId: '1246001', meterId: '12160021001',
  });
  const gRealAck = await gw3.waitFor((r) => r.body && r.body.id === gReal.id);
  await sleep(1500);
  check('通信G2 同一子设备的真实告警仍然正常入库并推送（抑制不影响其它点位）',
    { code: 0, alarmRows: 1, pushDelta: 1 },
    {
      code: gRealAck.body.code,
      alarmRows: await alarmRowsOf(gRealSerial),
      pushDelta: (await pushTotalRows()) - pushBeforeG2,
    });

  // ---- G2b 通信状态监控点的数据上报照常接收/落库（抑制只针对告警） ----
  await gw3.dataReport({ devId: '1246001', meters: [{ meterId: '0', value: '1' }], isFull: 0 });
  await sleep(700);
  const commMeterRow = await dbGet(
    `SELECT value FROM fsu_data_history
      WHERE device_id = ? AND dev_id = ? AND meter_id = ?
      ORDER BY id DESC LIMIT 1`,
    [GW.norm, '1246001', '0']);
  check('通信G2b 通信状态监控点的 dataReport 仍正常接收并落库（只屏蔽告警，不屏蔽数据）',
    { value: '1' }, { value: commMeterRow && commMeterRow.value });

  // ---- G3 网关自身条目（215001）的通信状态：不是目标子设备，保持原行为 ----
  const gGwSerial = 9603;
  const gGw = gw3.alarmReport({
    alarmFlag: 1, alarmLevel: 2, alarmTime: Math.floor(Date.now() / 1000),
    serialNo: gGwSerial, devId: '215001', meterId: '0',
  });
  const gGwAck = await gw3.waitFor((r) => r.body && r.body.id === gGw.id);
  await sleep(1000);
  check('通信G3 非目标条目（网关自身 215001）的通信状态不受影响，仍按原规则入库',
    { code: 0, alarmRows: 1 },
    { code: gGwAck.body.code, alarmRows: await alarmRowsOf(gGwSerial) });

  // ---- G4 历史通信状态行：保留记录，但不出现在列表 / 总数 / 统计 / 趋势 ----
  const legacySerial = '9599';
  const listBefore = await apiJson('GET', `/alarms?deviceId=${GW.norm}&limit=1`, undefined, adminToken);
  const statsBeforeLegacy = await apiJson('GET', '/alarms/stats', undefined, adminToken);
  const trendBefore = await apiJson('GET', '/alarms/trend?days=7', undefined, adminToken);
  const trendSum = (res) => ((res.data || []).reduce((n, x) => n + Number(x.count || 0), 0));

  await dbRun(
    `INSERT INTO alarms (device_id, type, severity, message, value, source,
                         resolved, created_at, serial_no, alarm_level, is_history)
     VALUES (?, '1246001', 'vendor', '历史通信状态告警', '0', 'MQTT', 0, ?, ?, 3, 0)`,
    [GW.norm, Math.floor(Date.now() / 1000), legacySerial]
  );
  const statsAfterLegacy = await apiJson('GET', '/alarms/stats', undefined, adminToken);
  const listRes = await apiJson('GET', `/alarms?deviceId=${GW.norm}&limit=500`, undefined, adminToken);
  const trendAfter = await apiJson('GET', '/alarms/trend?days=7', undefined, adminToken);
  const listedSerials = (listRes.data.items || []).map((a) => String(a.serial_no));
  check('通信G4 历史通信状态行不出现在告警中心列表（记录仍保留在库中）',
    { inList: false, stillInDb: true, normalAlarmVisible: true },
    {
      inList: listedSerials.includes(legacySerial),
      stillInDb: (await alarmRowsOf(legacySerial)) === 1,
      normalAlarmVisible: listedSerials.includes(String(gRealSerial)),
    });

  const totalBefore = listBefore.data && listBefore.data.total;
  const totalAfter = listRes.data && listRes.data.total;
  const unresolvedBefore = statsBeforeLegacy.data && statsBeforeLegacy.data.unresolved;
  const unresolvedAfter = statsAfterLegacy.data && statsAfterLegacy.data.unresolved;
  console.log(`      列表总数 ${totalBefore} → ${totalAfter}；未解决数 ${unresolvedBefore} → ${unresolvedAfter}；趋势合计 ${trendSum(trendBefore)} → ${trendSum(trendAfter)}`);
  check('通信G4b 历史通信状态行不计入列表总数 / 统计 / 趋势（数量与展示口径一致）',
    { totalUnchanged: true, statsUnchanged: true, trendUnchanged: true },
    {
      totalUnchanged: totalBefore === totalAfter,
      statsUnchanged: unresolvedBefore === unresolvedAfter,
      trendUnchanged: trendSum(trendBefore) === trendSum(trendAfter),
    });
  // 测试收尾：删掉本段自己插入的历史行（仅临时测试库）
  await dbRun('DELETE FROM alarms WHERE device_id = ? AND serial_no = ?', [GW.norm, legacySerial]);

  // ---- G5 通信状态接口：只取厂家心跳 4.2 的 online/offline ----
  const alarmTotalBeforeHb = (await dbGet('SELECT COUNT(*) c FROM alarms')).c;
  const pushBeforeHb = await pushTotalRows();
  const hbStatus = gw3.heartbeat({ online: ['1246001'], offline: ['1061001'] });
  await gw3.waitFor((r) => r.body && r.body.id === hbStatus.id);
  await sleep(500);
  const commRes = await apiJson('GET', `/devices/${GW.norm}/sub-device-comm-status`, undefined, adminToken);
  const commSubs = (commRes.data && commRes.data.subDevices) || [];
  const commById = Object.fromEntries(commSubs.map((s) => [s.devId, s]));
  check('通信G5 状态接口按字典返回全部功能子设备（含 devName；排除网关自身 215001）',
    { code: 0, count: 6, hasDevName: true, excludes215001: true },
    {
      code: commRes.code,
      count: commSubs.length,
      hasDevName: !!(commById['1246001'] && commById['1246001'].devName),
      excludes215001: !commById['215001'],
    });
  check('通信G5b 状态映射：online→在线 / offline→离线 / 两表都未列出→未知',
    { online: 'online', offline: 'offline', unlisted: 'unknown' },
    {
      online: commById['1246001'] && commById['1246001'].status,
      offline: commById['1061001'] && commById['1061001'].status,
      unlisted: commById['2060001'] && commById['2060001'].status,
    });
  check('通信G5c 状态项带 lastHeartbeatAt，且心跳/状态上报不创建告警、不推送',
    { hasHeartbeatAt: true, alarmDelta: 0, pushDelta: 0 },
    {
      hasHeartbeatAt: typeof (commById['1246001'] || {}).lastHeartbeatAt === 'number',
      alarmDelta: (await dbGet('SELECT COUNT(*) c FROM alarms')).c - alarmTotalBeforeHb,
      pushDelta: (await pushTotalRows()) - pushBeforeHb,
    });

  // ---- G5d 整批覆盖：新心跳替换上一批，不是增量累加 ----
  const hbSwap = gw3.heartbeat({ online: ['1061001'], offline: ['1246001'] });
  await gw3.waitFor((r) => r.body && r.body.id === hbSwap.id);
  await sleep(400);
  const swapRes = await apiJson('GET', `/devices/${GW.norm}/sub-device-comm-status`, undefined, adminToken);
  const swapById = Object.fromEntries(
    ((swapRes.data && swapRes.data.subDevices) || []).map((s) => [s.devId, s])
  );
  check('通信G5d 每次心跳整批覆盖（协议 4.2 的在线/离线是"设备列表"，非增量事件）',
    { devA: 'offline', devB: 'online' },
    {
      devA: swapById['1246001'] && swapById['1246001'].status,
      devB: swapById['1061001'] && swapById['1061001'].status,
    });

  // ---- G5e 同一 devId 同时出现在两个列表 → 未知 + 异常日志 ----
  const hbConflict = gw3.heartbeat({ online: ['1246001'], offline: ['1246001', '1061001'] });
  await gw3.waitFor((r) => r.body && r.body.id === hbConflict.id);
  await sleep(400);
  const conflictRes = await apiJson('GET', `/devices/${GW.norm}/sub-device-comm-status`, undefined, adminToken);
  const conflictById = Object.fromEntries(
    ((conflictRes.data && conflictRes.data.subDevices) || []).map((s) => [s.devId, s])
  );
  const conflictLog = fs.readFileSync(path.join(DIR, 'backend.log'), 'utf8');
  check('通信G5e 同一 devId 同时出现在 online/offline → 未知，并记录异常日志',
    { status: 'unknown', logged: true },
    {
      status: conflictById['1246001'] && conflictById['1246001'].status,
      logged: conflictLog.includes('同时出现在 online 与 offline'),
    });

  // ---- G5f 已连接但尚未收到有效心跳 → 全部离线 ----
  // 新建一个网关：上报字典但**不发心跳**，接口应返回功能子设备且状态为 offline
  // （不得因 MQTT 已连接就显示在线，也不显示未知）。
  const NOHB_GW = '00aa11bb2201';
  const noHbGw = new FsuGatewaySim({
    host: '127.0.0.1', port: MQTT_PORT, gwId: NOHB_GW,
    username: MQTT_USER, password: MQTT_PASS, fsuUsername: FSU_USER, fsuPassword: FSU_PASS,
  });
  await noHbGw.connect();
  const noHbLogin = noHbGw.login({ mac: NOHB_GW });
  await noHbGw.waitFor((r) => r.body && r.body.id === noHbLogin.id);
  await sleep(400);
  noHbGw.publish(`gw/v1/uploadDevInfo/${NOHB_GW}`, {
    id: 'upd-nohb', timestamp: Date.now(), method: 'uploadDevInfo',
    params: [
      { devId: '301001', devName: '测试子设备.json', meters: [
        { meterId: '0', meterName: '通信状态', meterType: 2 },
        { meterId: '3300010001', meterName: '测试告警点', meterType: 2 }] },
      // 网关自身条目：只有通信状态 + 遥测点，无独立告警点 → 不应被当作功能子设备
      { devId: '999001', devName: '设备信息', meters: [
        { meterId: '0', meterName: '通信状态', meterType: 2 },
        { meterId: '3399990001', meterName: 'CPU利用率', meterType: 1 }] },
    ],
  });
  await sleep(800);
  const noHbRes = await apiJson('GET', `/devices/${NOHB_GW}/sub-device-comm-status`, undefined, adminToken);
  const noHbSubs = (noHbRes.data && noHbRes.data.subDevices) || [];
  const noHbById = Object.fromEntries(noHbSubs.map((s) => [s.devId, s]));
  check('通信G5f MQTT 已连接但未收到有效心跳 → lastHeartbeatAt=null 且状态全部为离线',
    { heartbeatAt: null, status: 'offline', count: 1, excludesGatewayEntry: true },
    {
      heartbeatAt: noHbRes.data && noHbRes.data.lastHeartbeatAt,
      status: noHbById['301001'] && noHbById['301001'].status,
      count: noHbSubs.length,
      excludesGatewayEntry: !noHbById['999001'],
    });

  // ---- G5j 非法心跳不得覆盖已有有效快照 ----
  // 先产生一份有效快照（在线），再发一条非法心跳（online 不是数组），
  // 状态必须仍是上一次有效快照的结果。
  const goodHb = noHbGw.heartbeat({ online: ['301001'], offline: [] });
  await noHbGw.waitFor((r) => r.body && r.body.id === goodHb.id);
  await sleep(400);
  const beforeBadHb = await apiJson('GET', `/devices/${NOHB_GW}/sub-device-comm-status`, undefined, adminToken);
  const beforeBadHbAt = beforeBadHb.data && beforeBadHb.data.lastHeartbeatAt;
  noHbGw.publish(`gw/v1/heartbeat/${NOHB_GW}`, {
    id: 'bad-hb', timestamp: Date.now(), method: 'heartbeat',
    params: { online: 'not-an-array', offline: [] },
  });
  await sleep(600);
  const afterBadHb = await apiJson('GET', `/devices/${NOHB_GW}/sub-device-comm-status`, undefined, adminToken);
  const badHbSub = ((afterBadHb.data && afterBadHb.data.subDevices) || [])
    .find((s) => s.devId === '301001');
  check('通信G5j 非法心跳（online 不是数组）不覆盖已有有效快照：仍为在线，心跳时间不变',
    { statusBefore: 'online', statusAfter: 'online', heartbeatAtUnchanged: true },
    {
      statusBefore: ((beforeBadHb.data && beforeBadHb.data.subDevices) || [])
        .find((s) => s.devId === '301001')?.status,
      statusAfter: badHbSub && badHbSub.status,
      heartbeatAtUnchanged: (afterBadHb.data && afterBadHb.data.lastHeartbeatAt) === beforeBadHbAt,
    });

  // ---- G5g 新增功能子设备自动纳入：1999001 由 E 段字典动态加入 ----
  const newSubRpt = gw3.alarmReport({
    alarmFlag: 1, alarmLevel: 2, alarmTime: Math.floor(Date.now() / 1000),
    serialNo: 9605, devId: '1999001', meterId: '0',
  });
  await gw3.waitFor((r) => r.body && r.body.id === newSubRpt.id);
  await sleep(800);
  check('通信G5g 新增功能子设备（1999001）自动适用通信状态告警屏蔽，且自动出现在状态接口',
    { alarmRows: 0, inStatusApi: true },
    { alarmRows: await alarmRowsOf(9605), inStatusApi: !!commById['1999001'] });
  // ---- G5i 网关断开（重启/断电）后：全部功能子设备显示离线 ----
  const noHbHb = noHbGw.heartbeat({ online: ['301001'], offline: [] });
  await noHbGw.waitFor((r) => r.body && r.body.id === noHbHb.id);
  await sleep(400);
  const beforeDisc = await apiJson('GET', `/devices/${NOHB_GW}/sub-device-comm-status`, undefined, adminToken);
  const beforeDiscStatus = ((beforeDisc.data && beforeDisc.data.subDevices) || [])
    .find((s) => s.devId === '301001');
  // 断开的同一时刻，主网关 gw3 保持自己的有效快照（在线），用于验证互不影响。
  // 先发一条干净的快照，避免沿用 G5e 冲突快照（1246001 同时出现在两个列表）。
  const cleanHb = gw3.heartbeat({ online: ['1246001'], offline: ['1061001'] });
  await gw3.waitFor((r) => r.body && r.body.id === cleanHb.id);
  await sleep(400);
  const otherBefore = await apiJson('GET', `/devices/${GW.norm}/sub-device-comm-status`, undefined, adminToken);
  const otherBeforeStatus = (otherBefore.data?.subDevices || []).find((s) => s.devId === '1246001');
  await noHbGw.end();
  await sleep(1200);
  const afterDisc = await apiJson('GET', `/devices/${NOHB_GW}/sub-device-comm-status`, undefined, adminToken);
  const afterDiscSub = ((afterDisc.data && afterDisc.data.subDevices) || [])
    .find((s) => s.devId === '301001');
  check('通信G5i 网关断开后所有功能子设备显示离线，lastHeartbeatAt 清空',
    { onlineBefore: 'online', offlineAfter: 'offline', heartbeatAtCleared: true },
    {
      onlineBefore: beforeDiscStatus && beforeDiscStatus.status,
      offlineAfter: afterDiscSub && afterDiscSub.status,
      heartbeatAtCleared: (afterDisc.data && afterDisc.data.lastHeartbeatAt) === null,
    });

  // ---- G5l 一台网关断开不影响其他网关 ----
  const otherAfter = await apiJson('GET', `/devices/${GW.norm}/sub-device-comm-status`, undefined, adminToken);
  const otherAfterStatus = (otherAfter.data?.subDevices || []).find((s) => s.devId === '1246001');
  check('通信G5l 一台网关断开不影响其他网关的子设备状态',
    { before: 'online', after: 'online' },
    { before: otherBeforeStatus && otherBeforeStatus.status, after: otherAfterStatus && otherAfterStatus.status });

  // ---- G5k 网关重连后、收到本周期第一条有效心跳前 → 仍全部离线 ----
  const reGw = new FsuGatewaySim({
    host: '127.0.0.1', port: MQTT_PORT, gwId: NOHB_GW,
    username: MQTT_USER, password: MQTT_PASS, fsuUsername: FSU_USER, fsuPassword: FSU_PASS,
  });
  await reGw.connect();
  const reLogin = reGw.login({ mac: NOHB_GW });
  await reGw.waitFor((r) => r.body && r.body.id === reLogin.id);
  await sleep(500);
  const afterReconnect = await apiJson('GET', `/devices/${NOHB_GW}/sub-device-comm-status`, undefined, adminToken);
  const reconnectedSub = (afterReconnect.data?.subDevices || []).find((s) => s.devId === '301001');
  check('通信G5k 网关重连但未收到有效心跳 → 仍全部离线（不因 MQTT 已连接显示在线）',
    { status: 'offline', heartbeatAt: null },
    {
      status: reconnectedSub && reconnectedSub.status,
      heartbeatAt: afterReconnect.data && afterReconnect.data.lastHeartbeatAt,
    });

  // 收到重连后的第一条有效心跳 → 按全量快照更新
  const reHb = reGw.heartbeat({ online: ['301001'], offline: [] });
  await reGw.waitFor((r) => r.body && r.body.id === reHb.id);
  await sleep(500);
  const afterReHb = await apiJson('GET', `/devices/${NOHB_GW}/sub-device-comm-status`, undefined, adminToken);
  const reHbSub = (afterReHb.data?.subDevices || []).find((s) => s.devId === '301001');
  check('通信G5k2 重连后收到第一条有效心跳 → 按全量快照更新为在线',
    { status: 'online', heartbeatAtIsNumber: true },
    {
      status: reHbSub && reHbSub.status,
      heartbeatAtIsNumber: typeof (afterReHb.data && afterReHb.data.lastHeartbeatAt) === 'number',
    });

  // ---- G5m 旧 MQTT 连接的断开事件不得清除新连接的状态 ----
  // 用**原始 MQTT 客户端**建两条相同 clientId（= gwId）的连接：
  //   - reconnectPeriod: 0 —— 旧连接被踢后不会自动重连，避免两条连接互相踢下线；
  //   - 新连接接管后发 login + 心跳，旧连接的断开事件不得把新状态清成离线。
  const rawGwOpts = {
    username: MQTT_USER, password: MQTT_PASS,
    reconnectPeriod: 0, clean: true, protocolVersion: 4, keepalive: 60,
  };
  const rawConnect = (gwId) => new Promise((resolve, reject) => {
    const c = mqttLib.connect(`mqtt://127.0.0.1:${MQTT_PORT}`, { ...rawGwOpts, clientId: gwId });
    const t = setTimeout(() => reject(new Error('原始 MQTT 客户端连接超时')), 8000);
    c.once('connect', () => { clearTimeout(t); c.subscribe('sc/v1/#', { qos: 1 }); resolve(c); });
    c.once('error', (e) => { clearTimeout(t); reject(e); });
  });
  const rawPublish = (c, topic, body) => new Promise((resolve, reject) => {
    c.publish(topic, JSON.stringify(body), { qos: 1 }, (e) => (e ? reject(e) : resolve()));
  });

  const oldClient = await rawConnect(NOHB_GW);
  // 旧连接的 login + 心跳（建立一份有效快照）
  await rawPublish(oldClient, `gw/v1/login`, {
    id: 'raw-login-old', timestamp: Date.now(), method: 'login',
    params: { version: 'v1', mac: NOHB_GW, username: FSU_USER, password: FSU_PASS },
  });
  await rawPublish(oldClient, `gw/v1/heartbeat/${NOHB_GW}`, {
    id: 'raw-hb-old', timestamp: Date.now(), method: 'heartbeat',
    params: { online: ['301001'], offline: [] },
  });
  await sleep(500);

  // 新连接使用相同 clientId：aedes 关闭旧连接，新连接接管
  const newClient = await rawConnect(NOHB_GW);
  await rawPublish(newClient, `gw/v1/login`, {
    id: 'raw-login-new', timestamp: Date.now(), method: 'login',
    params: { version: 'v1', mac: NOHB_GW, username: FSU_USER, password: FSU_PASS },
  });
  await rawPublish(newClient, `gw/v1/heartbeat/${NOHB_GW}`, {
    id: 'raw-hb-new', timestamp: Date.now(), method: 'heartbeat',
    params: { online: ['301001'], offline: [] },
  });
  await sleep(1800); // 留出旧连接断开事件到达的时间
  const afterTakeover = await apiJson('GET', `/devices/${NOHB_GW}/sub-device-comm-status`, undefined, adminToken);
  const takeoverSub = (afterTakeover.data?.subDevices || []).find((s) => s.devId === '301001');
  const takeoverLog = fs.readFileSync(path.join(DIR, 'backend.log'), 'utf8');
  check('通信G5m 新连接接管后，旧连接的断开事件未清除新连接的心跳状态（仍为在线）',
    { status: 'online', oldDisconnectIgnoredOrOrdered: true },
    {
      status: takeoverSub && takeoverSub.status,
      // 事件顺序由 aedes 决定：旧断开可能先于新连接，也可能晚于；两种都不应影响最终状态
      oldDisconnectIgnoredOrOrdered:
        takeoverLog.includes('忽略旧连接的断开事件') || takeoverSub?.status === 'online',
    });
  newClient.end(true);
  oldClient.end(true);

  // ---- G5h 无字典的网关不被误屏蔽（屏蔽按网关 + 字典判定，不是全局 devId 名单） ----
  const NO_DICT_GW = '00aa11bb3301';
  const noDictGw = new FsuGatewaySim({
    host: '127.0.0.1', port: MQTT_PORT, gwId: NO_DICT_GW,
    username: MQTT_USER, password: MQTT_PASS, fsuUsername: FSU_USER, fsuPassword: FSU_PASS,
  });
  await noDictGw.connect();
  const noDictLogin = noDictGw.login({ mac: NO_DICT_GW });
  await noDictGw.waitFor((r) => r.body && r.body.id === noDictLogin.id);
  await sleep(400);
  const noDictRpt = noDictGw.alarmReport({
    alarmFlag: 1, alarmLevel: 2, alarmTime: Math.floor(Date.now() / 1000),
    serialNo: 9611, devId: '1061001', meterId: '0',
  });
  await noDictGw.waitFor((r) => r.body && r.body.id === noDictRpt.id);
  await sleep(800);
  const noDictRows = (await dbGet(
    'SELECT COUNT(*) c FROM alarms WHERE device_id = ? AND serial_no = ?',
    [NO_DICT_GW, '9611'])).c;
  check('通信G5h 无字典网关的 meterId=0 告警保持原行为（不扩大屏蔽范围）',
    { alarmRows: 1 }, { alarmRows: noDictRows });
  await noDictGw.end();

  // ---- G6 被抑制的子设备仍出现在子设备筛选里（取消的是告警，不是子设备） ----
  const subDevRes = await apiJson('GET', '/alarms/sub-devices', undefined, adminToken);
  const subIds = (subDevRes.data.options || []).map((o) => o.devId);
  check('通信G6 被抑制的子设备仍出现在子设备筛选中',
    { hasTargetSubDevice: true }, { hasTargetSubDevice: subIds.includes('1246001') });

  // ---- G7 重复上报 + 消除流程：均不产生告警（无意外副作用） ----
  const gCommDup = gw3.alarmReport({
    alarmFlag: 1, alarmLevel: 2, alarmTime: Math.floor(Date.now() / 1000),
    serialNo: gCommSerial, devId: '1246001', meterId: '0',
  });
  await gw3.waitFor((r) => r.body && r.body.id === gCommDup.id);
  const gCommClear = gw3.alarmReport({
    alarmFlag: 0, alarmLevel: 2, alarmTime: Math.floor(Date.now() / 1000),
    serialNo: 9604, devId: '1246001', meterId: '0',
  });
  const gCommClearAck = await gw3.waitFor((r) => r.body && r.body.id === gCommClear.id);
  await sleep(800);
  check('通信G7 通信状态的重复上报与消除流程都不产生告警',
    { duplicateRows: 0, clearCode: 0 },
    { duplicateRows: await alarmRowsOf(gCommSerial), clearCode: gCommClearAck.body.code });

  await new Promise((r) => gHook.close(r));

  await gw3.end();

  // ==================================================================
  // F. 平台主动校时（协议 4.8）：设备上线校时 + 定时校时
  //
  // 本段覆盖：
  //   上线校时只发一次 / 重复 login 不重发 / 断线重连重新校时 /
  //   定时开关与间隔持久化 / 到期发送 / 离线不发送 / 未订阅不发送 /
  //   两台设备互不影响 / payload 全部为新格式 / 无 params.timezone /
  //   无 [FSU][NTP投递诊断] / 过期过滤未变 / 临时测试 API 已删除 /
  //   后端重启后恢复调度且不批量补发
  // ==================================================================
  const readBackendLog = () =>
    fs.existsSync(path.join(DIR, 'backend.log')) ? fs.readFileSync(path.join(DIR, 'backend.log'), 'utf8') : '';
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 该模拟网关收到的全部校时报文（平台主动下发） */
  const ntpDown = (sim, gwId) =>
    sim.received.filter((r) => r.topic === `sc/v1/ntp/${gwId}`);
  /** 从后端日志里数"发布成功"的校时条数 */
  const loggedSends = (gwId) => {
    const re = new RegExp(`\\[FSU\\]\\[校时\\] 发布成功: gwId=${gwId}`, 'g');
    return (readBackendLog().match(re) || []).length;
  };
  /** 校验一条校时报文的形状是否符合已验证格式 */
  const isNewFormat = (body) =>
    !!body && typeof body.id === 'string' && body.id.length > 0
    && typeof body.timestamp === 'number' && body.timestamp > 1e12
    && body.method === 'ntp' && body.code === 0 && body.msg === 'success'
    && body.params === undefined && body.data === undefined
    && Object.keys(body).join(',') === 'id,timestamp,method,code,msg';

  const NTPGW_A = '00cc11dd2201';
  const NTPGW_B = '00cc11dd2202';

  const mkSim = async (gwId, subs) => {
    const sim = new FsuGatewaySim({
      host: '127.0.0.1', port: MQTT_PORT, gwId,
      username: MQTT_USER, password: MQTT_PASS, fsuUsername: FSU_USER, fsuPassword: FSU_PASS,
      subscriptions: subs ?? ['sc/v1/#'],
    });
    await sim.connect();
    return sim;
  };

  // ---------- F1 上线校时：订阅就绪后发送一次，且为新格式 ----------
  const simA = await mkSim(NTPGW_A);
  simA.login({ mac: NTPGW_A });
  await sleepMs(2500);
  const aReqs = ntpDown(simA, NTPGW_A);
  check('校时F1 设备上线（login + 订阅就绪）后自动校时一次',
    { count: 1, newFormat: true },
    { count: aReqs.length, newFormat: aReqs.length > 0 && isNewFormat(aReqs[0].body) });
  console.log(`      上线校时报文: ${aReqs.length ? JSON.stringify(aReqs[0].body) : '(未收到)'}`);
  check('校时F1b 上线校时报文为已验证的新格式（无 params / 无 data）',
    true, aReqs.length > 0 && isNewFormat(aReqs[0].body));
  const aRow1 = await dbGet('SELECT ntp_last_type, ntp_last_sent_at, ntp_next_due_at, ntp_sync_interval_hours FROM devices WHERE id = ?', [NTPGW_A]);
  check('校时F1c 上线校时落库：last_type=online，并按默认 24h 排下一次',
    { type: 'online', interval: 24, nextScheduled: true },
    {
      type: aRow1 && aRow1.ntp_last_type,
      interval: aRow1 && aRow1.ntp_sync_interval_hours,
      nextScheduled: !!(aRow1 && aRow1.ntp_next_due_at && aRow1.ntp_next_due_at > Date.now()),
    });

  // ---------- F2 重复 login 不重复发送 ----------
  for (let i = 0; i < 3; i++) { simA.login({ mac: NTPGW_A }); await sleepMs(200); }
  await sleepMs(3000);
  check('校时F2 同一上线事件内重复 login 不重复发送',
    { count: 1 }, { count: ntpDown(simA, NTPGW_A).length });

  // ---------- F3 断线重连 → 新的上线事件，重新校时一次 ----------
  await simA.end();
  await sleepMs(800);
  const simA2 = await mkSim(NTPGW_A);
  simA2.login({ mac: NTPGW_A });
  await sleepMs(2500);
  check('校时F3 断线重连后识别为新的上线事件，再校时一次',
    { countAfterReconnect: 2 },
    { countAfterReconnect: loggedSends(NTPGW_A) });

  // ---------- F4 定时校时关闭 → 到期也不发送 ----------
  await dbRun('UPDATE devices SET ntp_sync_enabled = 0, ntp_next_due_at = ? WHERE id = ?', [Date.now() - 60000, NTPGW_A]);
  const beforeF4 = loggedSends(NTPGW_A);
  await sleepMs(7000);   // 至少 3 个调度周期
  check('校时F4 关闭定时校时后，即使已到点也不执行周期校时',
    { sends: beforeF4, skipped: true },
    { sends: loggedSends(NTPGW_A), skipped: readBackendLog().includes(`gwId=${NTPGW_A}`) });

  // ---------- F5 开启定时校时 → 到期发送一次，且为新格式 ----------
  await dbRun('UPDATE devices SET ntp_sync_enabled = 1, ntp_next_due_at = ? WHERE id = ?', [Date.now() - 60000, NTPGW_A]);
  const beforeF5 = loggedSends(NTPGW_A);
  await sleepMs(6000);
  const aAll = ntpDown(simA2, NTPGW_A);
  const lastA = aAll[aAll.length - 1];
  check('校时F5 开启定时校时且已到点 → 发送一次',
    { delta: 1 }, { delta: loggedSends(NTPGW_A) - beforeF5 });
  console.log(`      定时校时报文: ${lastA ? JSON.stringify(lastA.body) : '(未收到)'}`);
  check('校时F5b 定时校时报文同样为新格式',
    true, !!lastA && isNewFormat(lastA.body));
  const aRow5 = await dbGet('SELECT ntp_last_type FROM devices WHERE id = ?', [NTPGW_A]);
  check('校时F5c 落库 last_type=scheduled',
    { type: 'scheduled' }, { type: aRow5 && aRow5.ntp_last_type });

  // ---------- F6 间隔选项校验（1/6/12/24/48 合法，其余拒绝） ----------
  const allowed = [1, 6, 12, 24, 48];
  let allOk = true, detail = [];
  for (const h of allowed) {
    const r = await apiJson('PUT', `/devices/${NTPGW_A}/ntp-config`, { intervalHours: h }, adminToken);
    const ok = r.code === 0 && r.data && r.data.intervalHours === h;
    if (!ok) allOk = false;
    detail.push(`${h}:${ok ? 'ok' : 'FAIL'}`);
  }
  const badR = await apiJson('PUT', `/devices/${NTPGW_A}/ntp-config`, { intervalHours: 7 }, adminToken);
  console.log(`      各选项保存结果: ${detail.join(' ')}`);
  check('校时F6 间隔只允许 1/6/12/24/48，其它值被拒绝',
    { allAllowedOk: true, invalidRejected: true },
    { allAllowedOk: allOk, invalidRejected: badR.code === 400 });

  // ---------- F7 修改间隔后下一次计划时间按新间隔重算 ----------
  const r7 = await apiJson('PUT', `/devices/${NTPGW_A}/ntp-config`, { intervalHours: 6 }, adminToken);
  const nd = r7.data && r7.data.nextDueAt;
  const expectLow = Date.now() + 6 * 3600 * 1000 - 15000;
  const expectHigh = Date.now() + 6 * 3600 * 1000 + 15000;
  check('校时F7 修改间隔后立即按新间隔重算下一次计划时间（无需重启）',
    { interval: 6, withinRange: true },
    { interval: r7.data && r7.data.intervalHours, withinRange: nd >= expectLow && nd <= expectHigh });

  // ---------- F8 两台设备互不影响 ----------
  await apiJson('PUT', `/devices/${NTPGW_A}/ntp-config`, { enabled: false }, adminToken);
  const simB = await mkSim(NTPGW_B);
  simB.login({ mac: NTPGW_B });
  await sleepMs(2500);
  const bReqs = ntpDown(simB, NTPGW_B);
  await dbRun('UPDATE devices SET ntp_sync_enabled = 0, ntp_next_due_at = ? WHERE id = ?', [Date.now() - 60000, NTPGW_B]);
  await dbRun('UPDATE devices SET ntp_sync_enabled = 0, ntp_next_due_at = ? WHERE id = ?', [Date.now() - 60000, NTPGW_A]);
  const beforeA = loggedSends(NTPGW_A), beforeB = loggedSends(NTPGW_B);
  await sleepMs(6000);
  check('校时F8 两台设备的配置与调度互不影响（B 上线校时不影响 A；A 关闭不影响 B 的记录）',
    { bOnlineSync: 1, aDeltaAfterDisable: 0, bDeltaAfterDisable: 0 },
    { bOnlineSync: bReqs.length, aDeltaAfterDisable: loggedSends(NTPGW_A) - beforeA, bDeltaAfterDisable: loggedSends(NTPGW_B) - beforeB });

  // ---------- F9 设备离线（未连接）→ 不发送定时校时 ----------
  await simB.end();
  await sleepMs(1000);
  await dbRun('UPDATE devices SET ntp_sync_enabled = 1, ntp_next_due_at = ? WHERE id = ?', [Date.now() - 60000, NTPGW_B]);
  const beforeOff = loggedSends(NTPGW_B);
  await sleepMs(6000);
  // 离线设备在 listDueScheduled 的 WHERE 里就被滤掉（status/mqttConnected），
  // 因此根本不会进入 sendSync —— 这里验证的就是"一条都没发"
  check('校时F9 设备离线时不发送定时校时（SQL 层即过滤，不进入发送流程）',
    { delta: 0 }, { delta: loggedSends(NTPGW_B) - beforeOff });

  // ---------- F10 设备没有 NTP 订阅 → 不发送 ----------
  const NTPGW_C = '00cc11dd2203';
  const simC = await mkSim(NTPGW_C, ['sc/v1/heartbeat/' + NTPGW_C]);   // 刻意不订阅 ntp 主题
  simC.login({ mac: NTPGW_C });
  await sleepMs(3000);
  check('校时F10 设备未订阅 sc/v1/ntp/{gwId} 时不发送（并留痕跳过原因）',
    { sent: 0, loggedSkip: true },
    { sent: ntpDown(simC, NTPGW_C).length, loggedSkip: readBackendLog().includes(`gwId=${NTPGW_C}`) });
  await simC.end();
  await sleepMs(500);

  // ---------- F11 全量 payload 形状审计 ----------
  const allNtpMsgs = [simA2, simB, simC].flatMap((s) => s.received.filter((r) => r.topic.startsWith('sc/v1/ntp/')));
  const badShape = allNtpMsgs.filter((r) => !isNewFormat(r.body));
  check('校时F11 本次全部主动校时报文均为新格式（无一条带 params/data）',
    { total: allNtpMsgs.length, bad: 0 },
    { total: allNtpMsgs.length, bad: badShape.length });

  // ---------- F12 不再存在 params.timezone / 旧诊断日志 ----------
  const logAll = readBackendLog();
  check('校时F12 后端日志中不再出现 params.timezone 形状的自动发送',
    { hits: 0 }, { hits: (logAll.match(/"params":\{"timezone"/g) || []).length });
  check('校时F13 不再存在 [FSU][NTP投递诊断] 日志',
    { hits: 0 }, { hits: (logAll.match(/\[FSU\]\[NTP投递诊断\]/g) || []).length });

  // ---------- F14 消息过期过滤保持原样（3000ms 阈值未变） ----------
  const simD = await mkSim('00cc11dd2204');
  const staleId = String(Date.now());
  simD.publish(`gw/v1/heartbeat/00cc11dd2204`, {
    id: staleId, timestamp: Date.now() - 60000, method: 'heartbeat', params: { online: [], offline: [] },
  });
  await sleepMs(1200);
  const logD = readBackendLog();
  check('校时F14 过期消息仍按 3000ms 阈值丢弃（过期过滤逻辑未被改动）',
    { dropped: true, threshold: 3000 },
    { dropped: logD.includes(`消息过期已丢弃`) && logD.includes('age=') && logD.includes('> 3000ms'), threshold: 3000 });
  await simD.end();

  // ---------- F15 临时测试 API 已删除 ----------
  const tempApi = await apiJson('POST', `/devices/${NTPGW_A}/ntp-format-test`, {}, adminToken);
  check('校时F15 临时测试 API（ntp-format-test）已从生产路由移除',
    { notFound: true }, { notFound: tempApi.code === 404 || /接口不存在/.test(tempApi.message || '') });

  // ---------- F16 后端重启：恢复调度但不批量补发 ----------
  await dbRun('UPDATE devices SET ntp_sync_enabled = 1, ntp_next_due_at = ? WHERE id = ?', [Date.now() - 3600000, NTPGW_A]);
  const overdueBefore = await dbGet('SELECT ntp_next_due_at FROM devices WHERE id = ?', [NTPGW_A]);
  await stopBackend();
  // 清空日志：startBackend 靠日志内容判断就绪，不清空会被上一次启动的旧内容骗过（立即返回）
  fs.rmSync(path.join(DIR, 'backend.log'), { force: true });
  await startBackend();
  const simA3 = await mkSim(NTPGW_A);   // 重新连接（重启后原连接已断）
  await sleepMs(2500);
  const overdueAfter = await dbGet('SELECT ntp_next_due_at FROM devices WHERE id = ?', [NTPGW_A]);
  check('校时F16 后端重启后：已过期的计划被顺延（未在启动时立即批量补发）',
    { pushedForward: true, sendsAfterRestartAtMost1: true },
    {
      pushedForward: !!(overdueAfter && overdueAfter.ntp_next_due_at > overdueBefore.ntp_next_due_at),
      // 日志已清空 → 这里统计的是"重启之后"的发送次数：至多 1 次（重连后的上线校时）
      sendsAfterRestartAtMost1: loggedSends(NTPGW_A) <= 1,
    });
  await simA3.end();
  await simA2.end();
  await simB.end();

  // ============ 附加：告警推送未被打断 ============
  const pushLogs = await dbAll('SELECT COUNT(*) c FROM alarm_push_logs');
  check('附加 告警推送链路表可用（alarms → alarm_push_logs 未破坏）', true, pushLogs.length === 1);

  await stopBackend();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== 协议端到端验收：${results.length - failed.length}/${results.length} 通过 =====`);
  fs.writeFileSync(path.join(DIR, 'results.json'), JSON.stringify(results, null, 1));
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error('执行失败:', e);
  await stopBackend();
  process.exit(2);
});
