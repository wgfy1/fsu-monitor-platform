/**
 * FSU 告警收发集成测试（**走真实 MQTT 链路**，不直接写库）
 *
 * 覆盖：MQTT 接收 → 协议响应 → 过期检查 → 字典取名 → 入库 →
 *       查询接口 → 动态子设备筛选 → 推送（本地 mock 抓请求体）→ 重复上报去重 →
 *       alarmFlag=0 协议消除 → 精确清理 → 环境还原
 *
 * ⚠️ 本脚本会**连接正在运行的生产后端与其数据库**，因此：
 *    - 必须显式带 --yes 才执行；
 *    - 管理员口令必须通过 FSU_INTEG_ADMIN_PASSWORD 显式传入，脚本内不保留任何默认口令，
 *      也绝不复用生产管理员口令；
 *    - 测试告警使用 88xxxx 段 serialNo，清理只按这些 serialNo 与记录的主键精确删除，
 *      绝不做无条件的 DELETE FROM alarms，也不清空推送日志表；
 *    - 推送接收端**全程**为本地 mock（抓取真实请求体），
 *      测试期间不向真实钉钉群发送任何消息，结束后恢复原配置；
 *    - 为通过 isLoggedIn 会发一次 login，用**与现有档案相同的 mac/版本**，
 *      使其只改动 devices 的 status/last_seen/mqttConnected，测试后逐字还原。
 *
 * 用法：
 *   cd backend && FSU_INTEG_ADMIN_PASSWORD=<独立测试口令> node scripts/fsu-alarm-integration.js --yes
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const sqlite3 = require('sqlite3');
const mqttLib = require('mqtt');
const { FsuGatewaySim } = require('./fsu-protocol-test/simulator');

const BACKEND_DIR = path.join(__dirname, '..');
if (!process.argv.includes('--yes')) {
  console.error('拒绝执行：本脚本会连接生产后端与生产库，请确认后加 --yes 参数运行。');
  process.exit(2);
}

// ---------- 平台管理员凭据：必须由调用方显式提供 ----------
// ⚠️ 不在仓库里硬编码任何口令，也不把生产管理员口令当默认值：
//    本脚本要连真实后端，写死在源码里的口令会随代码一起公开。
//    用**独立测试环境变量**传入，不要复用生产口令。
const ADMIN_USER = process.env.FSU_INTEG_ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.FSU_INTEG_ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
  console.error('拒绝执行：未提供平台管理员口令（FSU_INTEG_ADMIN_PASSWORD）。');
  console.error('请用独立测试变量显式传入，例如：');
  console.error('  FSU_INTEG_ADMIN_PASSWORD=<独立测试口令> node scripts/fsu-alarm-integration.js --yes');
  console.error('注意：不要使用生产管理员口令，也不要把口令写进任何文件或脚本。');
  process.exit(2);
}

// ---------- 读取后端配置（与运行实例同一份）----------
const env = {};
for (const line of fs.readFileSync(path.join(BACKEND_DIR, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2];
}
const DB_PATH = path.resolve(BACKEND_DIR, env.DB_PATH || './data/fsu.db');
const API = `http://127.0.0.1:${env.PORT || 3001}/api`;
const MQTT_URL = `mqtt://127.0.0.1:${env.MQTT_BROKER_PORT || 1883}`;

const GW = '00534c080213';                 // 真实网关 gwId
// ⚠️ serialNo 必须**每轮不同**：服务端有 30 分钟内存去重窗口，
//    上一轮用过的 serialNo 会被判为「重复告警」而跳过推送（实测踩过）。
//    这里用时间派生，保证逐轮唯一，同时保持 8xxxxxx 段的测试可识别性。
const RUN_TAG = Math.floor(Date.now() / 1000) % 100000;
const SERIALS = [0, 1, 2, 3].map((i) => 8000000 + RUN_TAG * 10 + i);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---------- 数据库（生产库）----------
const dbAll = (sql, p = []) => new Promise((res, rej) => {
  const d = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
  d.all(sql, p, (e, r) => { d.close(); e ? rej(e) : res(r); });
});
const dbGet = (sql, p = []) => dbAll(sql, p).then((r) => r[0] || null);
const dbRun = (sql, p = []) => new Promise((res, rej) => {
  const d = new sqlite3.Database(DB_PATH);
  d.run(sql, p, function (e) { d.close(); e ? rej(e) : res(this); });
});

async function apiJson(method, p, body, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${API}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return r.json();
}

/**
 * 构造"还原推送配置"的 PUT body
 *
 * ⚠️ 不能带 `sms_numbers: null`：路由对该字段做 String(null) 得到字符串 'null'，
 *    会触发手机号格式校验失败 → 整个 PUT 返回 400 且什么都不保存。
 *    表现为"还原静默失败"（实测踩过）。原值为 null 时省略该字段即可保持 null。
 */
function restoreCfg(c) {
  const patch = {
    enabled: c.enabled, dingtalk_enabled: c.dingtalk_enabled,
    dingtalk_webhook: c.dingtalk_webhook, dingtalk_secret: c.dingtalk_secret,
    sms_enabled: c.sms_enabled, dedupe_minutes: c.dedupe_minutes,
  };
  if (typeof c.sms_numbers === 'string' && c.sms_numbers.trim() !== '') {
    patch.sms_numbers = c.sms_numbers;
  }
  return patch;
}

/**
 * 取 webhook 的主机名，用于失败提示里确认"打到了哪里"。
 * ⚠️ 只输出主机名，不输出完整 URL —— 完整 URL 里的 access_token 是真实凭据，
 *    一旦被写进 report.json 就等于把钉钉机器人令牌落盘。
 */
const hostOf = (w) => String(w || '').replace(/^(https?:\/\/[^/]+).*/, '$1');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : '  ← ' + JSON.stringify(detail)}`);
}

(async () => {
  const started = Date.now();
  log('==================================================');
  log(' FSU 告警收发集成测试（真实 MQTT 链路）');
  log('==================================================');
  log('数据库 :', DB_PATH);
  log('Broker :', MQTT_URL, ' API :', API, ' gwId :', GW);

  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.tmp-integ', 'baseline.json'), 'utf8'));
  const dictJson = fs.readFileSync(path.join(__dirname, '..', '..', '.tmp-integ', 'real-dict.json'), 'utf8');
  const dict = JSON.parse(dictJson);
  // 设备所属租户 + 该租户的推送配置
  // ⚠️ 租户设备的告警推送用的是**租户级**配置（tenant_notify_config），
  //    平台级配置对它们不生效 —— 切 mock 时必须两级都切。
  const DEV_TENANT = (await dbGet('SELECT tenant_id FROM devices WHERE id = ?', [GW])).tenant_id;
  const tenantCfg = await dbGet('SELECT * FROM tenant_notify_config WHERE tenant_id = ?', [DEV_TENANT]);
  log('设备所属租户 :', DEV_TENANT, '（其告警推送使用该租户的推送配置）');
  const nameOf = (devId, meterId) => {
    const e = dict.find((d) => String(d.devId) === String(devId));
    const m = e && (e.meters || []).find((x) => String(x.meterId) === String(meterId));
    return m ? m.meterName : null;
  };

  // 测试选点：全部来自生产库导出的**真实字典**，覆盖 3 个子设备，
  // 其中 #1/#2 同属 devId 1061001 但 meterId/serialNo 不同（用于验证不互相抑制）
  const cases = [
    { serialNo: SERIALS[0], devId: '1061001', meterId: '11061004001', level: 2 },
    { serialNo: SERIALS[1], devId: '1061001', meterId: '11061005001', level: 4 },
    { serialNo: SERIALS[2], devId: '1246001', meterId: '12160021001', level: 3 },
    { serialNo: SERIALS[3], devId: '2060001', meterId: '22060021001', level: 5 },
  ];
  // ---------- 本地 mock 推送接收端 ----------
  // 本次测试的**唯一**推送接收端。不存在任何切回真实钉钉的步骤。
  const received = [];
  const hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const hookPort = hook.address().port;
  const mockUrl = `http://127.0.0.1:${hookPort}/robot/send?access_token=integ-mock`;
  log('本地 mock webhook :', mockUrl);

  let token = null;
  let gw = null;
  let configSwitched = false;
  // 必须在 try 之外声明：finally 里的还原逻辑要用（否则抛 ReferenceError 导致还原中断）
  let origTenant = null;
  let deviceTouched = false;
  const createdAlarmIds = [];

  try {
    // ---------- 登录平台 API ----------
    const login = await apiJson('POST', '/auth/login', { username: ADMIN_USER, password: ADMIN_PASSWORD });
    token = login.data && login.data.token;
    if (!token) throw new Error('平台管理员登录失败：' + login.message);
    log('\n[1] 平台管理员 API 登录成功');

    // ---------- 切换推送接收端为本地 mock ----------
    // ⚠️ 关键：本设备属于租户 T0001，NotifyService.pushForAlarm 取的是
    // **该租户自己的**租户级配置（tenant_notify_config），平台级配置对租户设备不生效。
    // 因此两级都要切到 mock，否则测试告警会真的投递到群。
    const orig = baseline.cfg;
    origTenant = tenantCfg;
    const mockPatch = {
      enabled: 1, dingtalk_enabled: 1, dingtalk_webhook: mockUrl,
      dingtalk_secret: '', dedupe_minutes: orig.dedupe_minutes || 30,
    };
    await apiJson('PUT', '/notify/config', mockPatch, token);
    const tenantPatch = await apiJson('PUT', `/notify/config?tenantId=${DEV_TENANT}`, mockPatch, token);
    configSwitched = true;
    const verifyCfg = await apiJson('GET', '/notify/config', undefined, token);
    const verifyTenant = await apiJson('GET', `/notify/config?tenantId=${DEV_TENANT}`, undefined, token);
    // 失败详情只打印主机名：万一切换失败还指向真实钉钉，完整 URL 里的
    // access_token 会随 report.json 落盘。
    check('推送接收端已切到本地 mock（平台级 + 设备所属租户级，均未指向真实钉钉）',
      /127\.0\.0\.1/.test((verifyCfg.data || {}).dingtalk_webhook || '')
      && /127\.0\.0\.1/.test((verifyTenant.data || {}).dingtalk_webhook || ''),
      { 平台级: hostOf((verifyCfg.data || {}).dingtalk_webhook), 租户级: hostOf((verifyTenant.data || {}).dingtalk_webhook), tenantPatchCode: tenantPatch.code });

    // ---------- 建立 MQTT 连接（clientId = gwId，协议 3.4）----------
    gw = new FsuGatewaySim({
      host: '127.0.0.1', port: Number(env.MQTT_BROKER_PORT || 1883), gwId: GW,
      username: env.MQTT_USERNAME, password: env.MQTT_PASSWORD,
      fsuUsername: env.FSU_LOGIN_USERNAME, fsuPassword: env.FSU_LOGIN_PASSWORD,
    });
    await gw.connect();
    log('[2] 模拟网关已连接真实 Broker（clientId =', GW, '）');

    // login：**复用现有档案值**，使 device_sn/protocol_type/softwareVersion/hardwareVersion 不变
    const lg = gw.login({
      mac: GW,
      username: env.FSU_LOGIN_USERNAME, password: env.FSU_LOGIN_PASSWORD,
      version: baseline.dev.softwareVersion,
      extra: { hardwareVersion: baseline.dev.hardwareVersion },
    });
    const lgAck = await gw.waitFor((r) => r.body && r.body.id === lg.id);
    deviceTouched = true;
    check('网关 login 成功（建立会话，后续告警才不会被判 -9 notlogin）',
      lgAck.body.code === 0, { code: lgAck.body.code, topic: lgAck.topic });

    // 上报**真实字典**（与生产库同一份内容）
    gw.publish(`gw/v1/uploadDevInfo/${GW}`, {
      id: 'integ-upd-1', timestamp: Date.now(), method: 'uploadDevInfo', params: dict,
    });
    await sleep(800);
    // 注意：SQLite 的 LENGTH() 对 TEXT 返回**字符数**（不是字节数），
    // 中文点位名一字 3 字节，用字节数比会误判。
    const dictRow = await dbGet('SELECT LENGTH(meters_json) chars FROM device_meters WHERE device_id = ?', [GW]);
    check('真实设备字典已上报入库（供告警取名）',
      dictRow && dictRow.chars === dictJson.length,
      { sqliteChars: dictRow && dictRow.chars, exportChars: dictJson.length, exportBytes: Buffer.byteLength(dictJson) });

    // ============================================================
    // [3] 发送告警 + 逐项验证
    // ============================================================
    log('\n[3] 发送 %d 条告警（经真实 Broker → 解析 → 过期检查 → 入库 → 推送）', cases.length);
    const beforeCounts = {
      alarms: (await dbGet('SELECT COUNT(*) c FROM alarms')).c,
      push: (await dbGet('SELECT COUNT(*) c FROM alarm_push_logs')).c,
    };

    for (const c of cases) {
      const expectName = nameOf(c.devId, c.meterId);
      const alarmTime = Math.floor(Date.now() / 1000);
      log(`\n  --- serialNo=${c.serialNo} devId=${c.devId} meterId=${c.meterId}（${expectName}）level=${c.level} ---`);

      // 3.1 MQTT 报文发送 + 协议响应
      const rpt = gw.alarmReport({
        alarmFlag: 1, alarmLevel: c.level, alarmTime,
        serialNo: c.serialNo, devId: c.devId, meterId: c.meterId, isHistory: 0,
      });
      let ack = null;
      try {
        ack = await gw.waitFor((r) => r.body && r.body.id === rpt.id, 6000);
      } catch (e) { /* 超时下面按失败记录 */ }
      check(`#${c.serialNo} ① MQTT 报文已接收并得到协议响应（topic=sc/v1/alarmReport/${GW}）`,
        !!ack && ack.body.code === 0 && ack.topic === `sc/v1/alarmReport/${GW}`,
        ack ? { code: ack.body.code, topic: ack.topic } : { error: '未收到响应（超时）' });

      await sleep(1500);   // 等入库 + 异步推送

      // 3.2 入库字段
      const row = await dbGet('SELECT * FROM alarms WHERE device_id = ? AND serial_no = ?', [GW, String(c.serialNo)]);
      if (row) createdAlarmIds.push(row.id);
      check(`#${c.serialNo} ② 告警入库且 devId/meterId/serialNo/alarmLevel/时间字段正确`,
        !!row && row.type === c.devId && row.value === c.meterId
          && String(row.serial_no) === String(c.serialNo) && row.alarm_level === c.level
          && row.resolved === 0 && row.created_at === alarmTime && row.source === 'MQTT',
        row ? { type: row.type, value: row.value, serial_no: row.serial_no, level: row.alarm_level,
          resolved: row.resolved, created_at: row.created_at, source: row.source, alarmTime } : { row: null });

      // 3.3 名称来自字典
      check(`#${c.serialNo} ③ 告警名称取自设备字典（未被硬编码覆盖）`,
        !!row && row.message === expectName, { message: row && row.message, expectName });

      // 3.4 查询接口 + 动态子设备筛选
      const q = await apiJson('GET', `/alarms?deviceId=${GW}&devId=${c.devId}&limit=200`, undefined, token);
      const found = (q.data.items || []).find((a) => String(a.serial_no) === String(c.serialNo));
      const sub = await apiJson('GET', '/alarms/sub-devices', undefined, token);
      const inFilter = (sub.data.options || []).some((o) => o.devId === c.devId);
      check(`#${c.serialNo} ④ 告警中心可按 devId 查到 + 子设备筛选中存在该子设备`,
        !!found && found.dev_name !== undefined && inFilter,
        { found: !!found, dev_name: found && found.dev_name, inFilter });

      // 3.5 推送
      const pl = await dbGet(
        `SELECT * FROM alarm_push_logs WHERE alarm_id = ? AND action = 'alarm' ORDER BY id DESC LIMIT 1`, [row ? row.id : -1]);
      const hookHit = received.length;
      check(`#${c.serialNo} ⑤ 独立触发一次推送（钉钉通道成功 + mock 已收到请求）`,
        !!pl && pl.status === 'success' && pl.channel === 'dingtalk' && hookHit >= cases.indexOf(c) + 1,
        { pushLog: pl && { status: pl.status, channel: pl.channel }, mockReceived: hookHit });
    }

    // 3.6 推送请求体内容
    log('\n[4] 校验本地 mock 收到的推送请求体');
    const bodies = received.map((r) => r.body);
    const bodyOf = (name) => bodies.find((b) => b.includes(name)) || '';
    check('推送请求体包含“级别 N”（用协议原始 alarmLevel，不做严重/警告映射）',
      bodyOf(nameOf('1061001', '11061004001')).includes('级别 2')
      && bodyOf(nameOf('1246001', '12160021001')).includes('级别 3'),
      { sample: bodyOf(nameOf('1061001', '11061004001')).slice(0, 260) });
    check('推送请求体包含字典里的点位名（告警内容取自字典）',
      bodyOf(nameOf('1061001', '11061004001')).includes('48V蓄电池组电压过高'),
      { name: nameOf('1061001', '11061004001') });
    check('推送文案不含"厂家"字样、不暴露内部枚举 vendor',
      !bodies.some((b) => b.includes('厂家') || b.includes('vendor')),
      { hit: bodies.filter((b) => b.includes('厂家') || b.includes('vendor')).slice(0, 1) });

    // ============================================================
    // [5] 同一子设备不同告警不互相抑制 + 重复上报去重
    // ============================================================
    log('\n[5] 去重语义验证');
    const pushAfter4 = (await dbGet('SELECT COUNT(*) c FROM alarm_push_logs')).c;
    check('同一子设备(1061001)的两条不同告警各自推送，未互相抑制',
      received.length === cases.length,
      { mockRequests: received.length, expect: cases.length });

    const dupBefore = { a: (await dbGet('SELECT COUNT(*) c FROM alarms WHERE device_id = ?', [GW])).c, p: pushAfter4 };
    const dup = gw.alarmReport({
      alarmFlag: 1, alarmLevel: 2, alarmTime: Math.floor(Date.now() / 1000),
      serialNo: cases[0].serialNo, devId: cases[0].devId, meterId: cases[0].meterId, isHistory: 0,
    });
    const dupAck = await gw.waitFor((r) => r.body && r.body.id === dup.id);
    await sleep(1500);
    const dupAfter = { a: (await dbGet('SELECT COUNT(*) c FROM alarms WHERE device_id = ?', [GW])).c,
      p: (await dbGet('SELECT COUNT(*) c FROM alarm_push_logs')).c, hook: received.length };
    check('重复上报同一 serialNo：不新建告警、不重复推送（协议仍回 code=0）',
      dupAck.body.code === 0 && dupAfter.a === dupBefore.a && dupAfter.p === dupBefore.p && dupAfter.hook === cases.length,
      { ackCode: dupAck.body.code, alarms: `${dupBefore.a}→${dupAfter.a}`, push: `${dupBefore.p}→${dupAfter.p}`, mock: dupAfter.hook });

    // ============================================================
    // [6] 协议消除（alarmFlag=0）
    // ============================================================
    log('\n[6] 发送 alarmFlag=0 消除告警（携带协议秒级 clearTime）');
    const clearTimes = {};
    for (const c of cases) {
      const clearSec = Math.floor(Date.now() / 1000);
      clearTimes[c.serialNo] = clearSec;
      const cl = gw.alarmReport({
        alarmFlag: 0, alarmLevel: c.level, alarmTime: Math.floor(Date.now() / 1000),
        clearTime: clearSec, serialNo: c.serialNo, devId: c.devId, meterId: c.meterId, isHistory: 0,
      });
      const clAck = await gw.waitFor((r) => r.body && r.body.id === cl.id);
      await sleep(400);
      const rAfter = await dbGet('SELECT * FROM alarms WHERE device_id = ? AND serial_no = ?', [GW, String(c.serialNo)]);
      const rowsForSerial = (await dbGet('SELECT COUNT(*) c FROM alarms WHERE device_id = ? AND serial_no = ?', [GW, String(c.serialNo)])).c;
      check(`#${c.serialNo} 消除：标记 resolved=1 且 resolved_at=clearTime×1000，未新建独立告警`,
        clAck.body.code === 0 && rAfter.resolved === 1 && rAfter.resolved_at === clearSec * 1000 && rowsForSerial === 1,
        { ack: clAck.body.code, resolved: rAfter.resolved, resolved_at: rAfter.resolved_at, expect: clearSec * 1000, rows: rowsForSerial });
    }
    const stillUnresolved = await dbGet(
      `SELECT COUNT(*) c FROM alarms WHERE device_id = ? AND serial_no IN (${SERIALS.map(() => '?').join(',')}) AND resolved = 0`,
      [GW, ...SERIALS.map(String)]);
    check('不同告警之间未发生错误关联：四条 serialNo 全部各自消除，无残留未解决',
      stillUnresolved.c === 0, { unresolved: stillUnresolved.c });

    // ============================================================
    // [7] 复核：全程只投递到本地 mock
    // ============================================================
    // 原实现会在本段把两级配置切回**真实钉钉 webhook** 并故意投递一条消息到测试群。
    // 那会在每次跑测试时向真实群刷屏、且把真实 webhook 令牌写进报告，已移除。
    // 现在改为一律停在 mock：本段只复核地址仍指向本地 mock，不触碰任何真实接收端。
    log('\n[7] 复核推送接收端全程为本地 mock（本次测试未向真实钉钉发送任何消息）');
    const stillPlat = await apiJson('GET', '/notify/config', undefined, token);
    const stillTenant = await apiJson('GET', `/notify/config?tenantId=${DEV_TENANT}`, undefined, token);
    const platHook = (stillPlat.data || {}).dingtalk_webhook || '';
    const tenantHook = (stillTenant.data || {}).dingtalk_webhook || '';
    check('[7] 平台级与租户级推送地址在测试全程均指向本地 mock（从未切回真实钉钉）',
      /127\.0\.0\.1/.test(platHook) && /127\.0\.0\.1/.test(tenantHook),
      { 平台级: hostOf(platHook), 租户级: hostOf(tenantHook), mockReceived: received.length });

  } finally {
    // ============================================================
    // [8] 精确清理 + 环境还原（无论成败都执行）
    // ============================================================
    log('\n[8] 清理本轮测试数据并还原环境');
    try { if (gw) await gw.end(); } catch (e) { /* ignore */ }
    await new Promise((r) => hook.close(r));

    // 8.1 定位本轮测试记录（只按测试 serialNo，绝不无条件 DELETE）
    const testAlarms = await dbAll(
      `SELECT id, serial_no FROM alarms WHERE device_id = ? AND serial_no IN (${SERIALS.map(() => '?').join(',')})`,
      [GW, ...SERIALS.map(String)]);
    const ids = testAlarms.map((r) => r.id);
    let deletedPush = 0;
    let deletedAlarms = 0;
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(',');
      deletedPush = (await dbRun(`DELETE FROM alarm_push_logs WHERE alarm_id IN (${ph})`, ids)).changes || 0;
      deletedAlarms = (await dbRun(`DELETE FROM alarms WHERE id IN (${ph})`, ids)).changes || 0;
    }
    check('测试告警已按主键精确删除（未使用无条件 DELETE FROM alarms）',
      deletedAlarms === testAlarms.length, { found: testAlarms.length, deleted: deletedAlarms, serials: SERIALS });
    check('关联测试推送记录已删除（未清空整张推送日志表）',
      deletedPush >= 0 && (await dbGet('SELECT COUNT(*) c FROM alarm_push_logs')).c >= baseline.base.push - 1,
      { deletedPush });

    // 8.2 还原推送配置（平台级 + 租户级都要还原）
    if (configSwitched) {
      // ⚠️ 不能带 sms_numbers: null —— 路由会 String(null) 得到字符串 'null'，
      //    触发手机号格式校验失败 → 整个 PUT 返回 400 且什么都不保存（实测踩过，
      //    表现为"还原静默失败"）。原值为 null 时直接省略该字段即可保持 null。
      // 还原请求的响应必须显式检查：PUT 失败会静默不保存（见 restoreCfg 注释）
      const rPlat = await apiJson('PUT', '/notify/config', restoreCfg(baseline.cfg), token);
      const rTen = await apiJson('PUT', `/notify/config?tenantId=${DEV_TENANT}`, restoreCfg(origTenant), token);
      check('推送配置还原请求均被接受（PUT 返回 code=0）',
        rPlat.code === 0 && rTen.code === 0,
        { 平台级: rPlat.code === 0 ? 'ok' : rPlat.message, 租户级: rTen.code === 0 ? 'ok' : rTen.message });
      const now = await apiJson('GET', '/notify/config', undefined, token);
      const nowT = await apiJson('GET', `/notify/config?tenantId=${DEV_TENANT}`, undefined, token);
      check('推送配置已还原为测试前的原值（平台级 + 租户级）',
        (now.data || {}).dingtalk_webhook === baseline.cfg.dingtalk_webhook
        && (nowT.data || {}).dingtalk_webhook === origTenant.dingtalk_webhook,
        { 平台级: (now.data || {}).dingtalk_webhook, 租户级: (nowT.data || {}).dingtalk_webhook });
    }

    // 8.3 还原设备行（login 只应改动 status/last_seen/mqttConnected）
    if (deviceTouched) {
      const cur = await dbGet('SELECT * FROM devices WHERE id = ?', [GW]);
      const differing = Object.keys(cur).filter((k) => String(cur[k]) !== String(baseline.dev[k]));
      await dbRun('UPDATE devices SET status = ?, last_seen = ?, mqttConnected = ?, activationStatus = ? WHERE id = ?',
        [baseline.dev.status, baseline.dev.last_seen, baseline.dev.mqttConnected, baseline.dev.activationStatus, GW]);
      const after = await dbGet('SELECT * FROM devices WHERE id = ?', [GW]);
      const left = Object.keys(after).filter((k) => String(after[k]) !== String(baseline.dev[k]));
      check('设备行已逐字还原（测试期间 login 改动的列已回填）',
        left.length === 0, { login改动列: differing, 还原后仍不同: left });
    }

    // 8.4 收尾核对
    const finalCounts = {
      alarms: (await dbGet('SELECT COUNT(*) c FROM alarms')).c,
      push: (await dbGet('SELECT COUNT(*) c FROM alarm_push_logs')).c,
    };
    log('\n[9] 测试前后计数对比');
    log('    alarms          : %d → %d', baseline.base.alarms, finalCounts.alarms);
    log('    alarm_push_logs : %d → %d', baseline.base.push, finalCounts.push);
    check('本轮测试告警已全部清除', finalCounts.alarms === baseline.base.alarms,
      { before: baseline.base.alarms, after: finalCounts.alarms });
    check('推送记录回到测试前水平（仅新增了测试期间的真实钉钉投递记录差异）',
      finalCounts.push === baseline.base.push,
      { before: baseline.base.push, after: finalCounts.push });

    const failed = checks.filter((c) => !c.ok);
    log('\n==================================================');
    log(` 集成测试结果：${checks.length - failed.length}/${checks.length} 项通过，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
    log(` mock webhook 收到请求数：${received.length}`);
    log('==================================================');
    fs.writeFileSync(path.join(__dirname, '..', '..', '.tmp-integ', 'report.json'),
      JSON.stringify({ checks, received: received.map((r) => r.url), finalCounts, baseline: baseline.base }, null, 1));
    process.exit(failed.length ? 1 : 0);
  }
})().catch((e) => {
  console.error('执行失败:', e);
  process.exit(3);
});
