/**
 * 厂家 MQTT 协议模拟器（协议验收用模拟器）
 *
 * 模拟一台厂家网关：
 *   - clientId = gwId，username/password = 平台统一 MQTT 账号
 *   - 订阅 sc/v1/# 接收平台下行与响应
 *   - 提供 login / heartbeat / dataReport / alarmReport / ntp 上行方法
 *   - 对平台下行的 getData/getAlarm/setData/reboot/ota 按协议回响应
 */
// 依赖后端已有的 mqtt 包（backend/node_modules）
const mqtt = require('mqtt');

class FsuGatewaySim {
  /**
   * @param subscriptions 连接后订阅的 topic filter 列表
   *   默认 ['sc/v1/#']（与真实厂家网关"订阅平台下行"的既有行为一致）。
   *   传 [] 表示**只连接不订阅**；也可传精确/通配符组合，用于验证平台侧的
   *   "下行投递匹配情况"诊断。
   */
  constructor({ host = 'localhost', port, gwId, username, password, fsuUsername, fsuPassword, subscriptions }) {
    this.gwId = gwId;
    // FSU login 报文凭据（与 MQTT 连接凭据是两套，默认取 FSU 凭据）
    this.fsuUsername = fsuUsername ?? username;
    this.fsuPassword = fsuPassword ?? password;
    this.subscriptions = subscriptions ?? ['sc/v1/#'];
    this.received = [];        // 收到的所有下行报文 { topic, body }
    this.waiters = [];
    this.handlers = {};        // method → (body) => responseBody | null
    this.seq = 0;
    this.url = `mqtt://${host}:${port}`;
    this.opts = {
      clientId: gwId,          // 协议 3.4：clientId = gwId
      username,
      password,
      keepalive: 60,
      clean: true,             // cleanStart true
      reconnectPeriod: 500,
      protocolVersion: 5 === 4 ? 4 : 4, // MQTT 3.1.1
    };
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.client = mqtt.connect(this.url, this.opts);
      const t = setTimeout(() => reject(new Error('模拟网关连接超时')), 8000);
      this.client.on('connect', () => { clearTimeout(t); resolve(); });
      this.client.on('error', (e) => { clearTimeout(t); reject(e); });
      this.client.on('message', (topic, payload) => this._onMessage(topic, payload));
      // 空数组 = 不订阅（MQTT 客户端对空数组的 SUBSCRIBE 行为不一致，显式跳过）
      if (this.subscriptions.length > 0) {
        this.client.subscribe(this.subscriptions, { qos: 1 });
      }
    });
  }

  _onMessage(topic, payload) {
    let body = null;
    try { body = JSON.parse(payload.toString('utf8')); } catch { /* 非 JSON */ }
    const rec = { topic, body, raw: payload.toString('utf8'), at: Date.now() };
    this.received.push(rec);
    // 自动按协议回响应（模拟网关行为）
    const parts = topic.split('/');
    if (parts[0] === 'sc' && parts[1] === 'v1' && parts.length >= 4) {
      const method = parts[2];
      const handler = this.handlers[method.toLowerCase()];
      if (handler) {
        const resp = handler(body, method);
        if (resp) {
          const respTopic = `gw/v1/${method}/${this.gwId}`;
          this.publish(respTopic, resp);
        }
      }
    }
    for (const w of [...this.waiters]) {
      if (w.pred(rec)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(rec); }
    }
  }

  /** 等待满足条件的下行报文 */
  waitFor(pred, timeout = 6000, desc = '') {
    const hit = this.received.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`等待下行报文超时${desc ? ': ' + desc : ''}`));
      }, timeout);
    });
  }

  /** 等待指定 method 的响应 */
  waitForMethod(method, timeout = 6000) {
    return this.waitFor((r) => r.topic.startsWith(`sc/v1/${method}/`), timeout, method);
  }

  publish(topic, body) {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
    this.client.publish(topic, payload, { qos: 0, retain: false });
  }

  /** 生成协议报文（id 由网关生成） */
  envelope(method, params, timestamp) {
    this.seq += 1;
    const body = {
      id: String(1000 + this.seq),
      timestamp: timestamp ?? Date.now(),
      method,
    };
    if (params !== undefined) body.params = params;
    return body;
  }

  // ---------- 上行方法 ----------
  login({ mac = this.gwId, username, password, version = 'v1.0.1##V2.04.02', extra = {}, raw } = {}) {
    const body = raw ?? this.envelope('login', {
      version, mac,
      username: username ?? this.fsuUsername,
      password: password ?? this.fsuPassword,
      upgradeVersion: '1001',
      hardwareVersion: '0000',
      ...extra,
    });
    this.publish('gw/v1/login', body);
    return body;
  }

  heartbeat({ online = [], offline = [], extra = {}, timestamp } = {}) {
    const body = this.envelope('heartbeat', {
      ICCID: '89860012345678901234', carrier: 'CU', vpnip: '172.17.5.234',
      online, offline, ...extra,
    }, timestamp);
    this.publish(`gw/v1/heartbeat/${this.gwId}`, body);
    return body;
  }

  dataReport({ devId = '1843001', meters = [], isFull = 0, isHistory = 0, historyTime, timestamp, rawParams } = {}) {
    const entry = { devId, isFull, isHistory };
    if (historyTime !== undefined) entry.historyTime = historyTime;
    entry.meters = meters;
    const body = this.envelope('dataReport', rawParams ?? [entry], timestamp);
    this.publish(`gw/v1/dataReport/${this.gwId}`, body);
    return body;
  }

  alarmReport({ alarmFlag = 1, alarmLevel = 1, alarmTime, clearTime, devId = '1843001', meterId = '0', serialNo = 163, isHistory = 0, timestamp } = {}) {
    const nowSec = Math.floor(Date.now() / 1000);
    const params = {
      alarmFlag, alarmLevel,
      alarmTime: alarmTime ?? nowSec,
      devId, meterId, serialNo, isHistory,
    };
    if (clearTime !== undefined) params.clearTime = clearTime;
    const body = this.envelope('alarmReport', params, timestamp);
    this.publish(`gw/v1/alarmReport/${this.gwId}`, body);
    return body;
  }

  ntp({ timezone = 'GMT+08:00', timestamp } = {}) {
    const body = this.envelope('ntp', { timezone }, timestamp);
    this.publish(`gw/v1/ntp/${this.gwId}`, body);
    return body;
  }

  /** 发布任意原始 payload（非法 JSON / 超长报文等测试用） */
  publishRaw(topic, raw) {
    this.client.publish(topic, Buffer.isBuffer(raw) ? raw : Buffer.from(raw), { qos: 0, retain: false });
  }

  /** 模拟网关对平台下行请求的响应 */
  respondTo(method, fn) { this.handlers[method.toLowerCase()] = fn; }

  clearReceived() { this.received.length = 0; }

  end() { return new Promise((r) => { if (!this.client) return r(); this.client.end(true, {}, () => r()); }); }
}

module.exports = { FsuGatewaySim };
