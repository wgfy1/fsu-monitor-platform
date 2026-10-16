/**
 * 启动密钥自检（fail-closed）回归验证
 *
 * 验证 src/env.ts 的环境判定与 MQTT/JWT 密钥自检：
 *   NODE_ENV=development / test        → 非生产，缺密钥只告警
 *   NODE_ENV=production                → 生产，缺密钥拒绝启动
 *   NODE_ENV 未设置 / 未知取值          → **按生产处理**（fail-closed），缺密钥拒绝启动
 *
 * 安全性：
 *   - 全程使用临时数据库与高位测试端口（3099 / 18999），绝不触碰生产库与生产 Broker；
 *   - 通过显式传入空字符串来模拟"未配置"（dotenv 不覆盖已存在的进程环境变量，
 *     因此 backend/.env 里的真实密钥不会渗进来）；
 *   - 断言只看输出里有没有出现对应的变量名，不打印任何密钥值。
 *
 * 用法：cd backend && npm run build && node scripts/check-startup-guards.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');
const ENTRY = path.join(BACKEND_DIR, 'dist', 'index.js');
const TMP_DB = path.join(__dirname, 'fsu-protocol-test', 'tmp', 'guard-check.db');

if (!fs.existsSync(ENTRY)) {
  console.error('找不到 dist/index.js，请先执行：npm run build');
  process.exit(2);
}

/**
 * 删除临时库及其衍生文件（-journal/-wal/-shm，以及 DB 迁移自动生成的 .bak 快照）。
 *
 * Windows 上刚被 SIGKILL 的进程有时还占着文件句柄，删除会抛 EBUSY ——
 * 临时文件删不掉不该让校验结果变成失败，忽略即可（目录本身已被 .gitignore 覆盖）。
 */
function cleanupTmpDb() {
  const dir = path.dirname(TMP_DB);
  const base = path.basename(TMP_DB);
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name !== base && !name.startsWith(base + '.')) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch { /* 句柄未释放，留给下次运行覆盖 */ }
  }
}

// 每轮替换一次，避免上一次运行的残留库影响启动
cleanupTmpDb();

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}`);
  if (!pass) console.log(`     ${detail}`);
}

/**
 * 起一个后端进程，观察它是"启动成功"还是"被自检拦下"
 * @returns {Promise<{started: boolean, exited: boolean, output: string}>}
 */
function runBackend(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: BACKEND_DIR,
      env: {
        ...process.env,
        // 与生产库/生产端口硬隔离
        DB_PATH: TMP_DB,
        PORT: '3099',
        MQTT_BROKER_PORT: '18999',
        MQTT_BROKER_HOST: 'localhost',
        EMBEDDED_BROKER: 'true',
        CONNECT_MODE: 'mqtt',
        // 子进程自己会 dotenv 加载 backend/.env；下面这些由各用例覆盖，
        // 显式给空串即代表"未配置"（dotenv 不会覆盖已存在的键）
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let settled = false;
    const finish = (started) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exited = child.exitCode !== null;
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      resolve({ started, exited, output: out });
    };

    const timer = setTimeout(() => finish(false), 25000);

    child.stdout.on('data', (d) => {
      out += d.toString();
      // 启动横幅打出即视为通过自检并成功监听
      if (out.includes('FSU设备监控平台后端服务启动成功')) finish(true);
    });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => {
      if (!settled) {
        out += `\n[进程退出，exitCode=${code}]`;
        finish(false);
      }
    });
  });
}

(async () => {
  console.log('==================================================');
  console.log(' 启动密钥自检回归（fail-closed）');
  console.log('==================================================');
  console.log(' 临时库 :', TMP_DB);
  console.log(' 端口   : HTTP 3099 / MQTT 18999（与生产隔离）');
  console.log('');

  // ---------- 1. production + 缺 MQTT_PASSWORD → 必须启动失败 ----------
  {
    const r = await runBackend({
      NODE_ENV: 'production', MQTT_PASSWORD: '', JWT_SECRET: 'dummy-jwt-for-guard-check',
    });
    record(
      '1 NODE_ENV=production 且缺少 MQTT_PASSWORD → 拒绝启动',
      !r.started && r.exited && r.output.includes('MQTT_PASSWORD'),
      `started=${r.started} exited=${r.exited} 输出是否提到 MQTT_PASSWORD=${r.output.includes('MQTT_PASSWORD')}`
    );
  }

  // ---------- 2. production + 缺 JWT_SECRET → 必须启动失败 ----------
  {
    const r = await runBackend({
      NODE_ENV: 'production', MQTT_PASSWORD: 'dummy-mqtt-for-guard-check', JWT_SECRET: '',
    });
    record(
      '2 NODE_ENV=production 且缺少 JWT_SECRET → 拒绝启动',
      !r.started && r.exited && r.output.includes('JWT_SECRET'),
      `started=${r.started} exited=${r.exited} 输出是否提到 JWT_SECRET=${r.output.includes('JWT_SECRET')}`
    );
  }

  // ---------- 3. NODE_ENV 未设置 + 两个密钥都缺 → 按生产处理，必须启动失败 ----------
  {
    const r = await runBackend({ NODE_ENV: '', MQTT_PASSWORD: '', JWT_SECRET: '' });
    record(
      '3 NODE_ENV 未设置且缺少两个密钥 → 按生产处理并拒绝启动（fail-closed）',
      !r.started && r.exited && r.output.includes('MQTT_PASSWORD') && r.output.includes('production'),
      `started=${r.started} exited=${r.exited} 是否报生产环境=${r.output.includes('production')}`
    );
  }

  // ---------- 4. 未知 NODE_ENV 取值 + 缺密钥 → 同样按生产处理 ----------
  {
    const r = await runBackend({ NODE_ENV: 'staging', MQTT_PASSWORD: '', JWT_SECRET: '' });
    record(
      '4 NODE_ENV 为未知取值（staging）且缺少密钥 → 按生产处理并拒绝启动',
      !r.started && r.exited && r.output.includes('MQTT_PASSWORD'),
      `started=${r.started} exited=${r.exited}`
    );
  }

  // ---------- 5. development + 无密钥 → 必须能正常启动（本地开发不受影响） ----------
  {
    const r = await runBackend({ NODE_ENV: 'development', MQTT_PASSWORD: '', JWT_SECRET: '' });
    record(
      '5 NODE_ENV=development 且未配置密钥 → 正常启动（开发能力保留，仅告警）',
      r.started && !r.exited,
      `started=${r.started} exited=${r.exited}`
    );
    record(
      '5b development 下打印开发默认凭据告警（提醒不要把这种状态带上线）',
      r.output.includes('开发默认'),
      `输出是否含"开发默认"=${r.output.includes('开发默认')}`
    );
  }

  // ---------- 6. test + 无密钥 → 与 development 同等对待 ----------
  {
    const r = await runBackend({ NODE_ENV: 'test', MQTT_PASSWORD: '', JWT_SECRET: '' });
    record(
      '6 NODE_ENV=test 且未配置密钥 → 正常启动',
      r.started && !r.exited,
      `started=${r.started} exited=${r.exited}`
    );
  }

  // ---------- 7. production + 密钥配齐 → 通过启动检查 ----------
  {
    const r = await runBackend({
      NODE_ENV: 'production',
      MQTT_PASSWORD: 'dummy-mqtt-for-guard-check',
      JWT_SECRET: 'dummy-jwt-for-guard-check',
    });
    record(
      '7 NODE_ENV=production 且密钥齐全 → 通过启动检查并正常监听',
      r.started && !r.exited,
      `started=${r.started} exited=${r.exited}`
    );
  }

  // 清理临时库
  cleanupTmpDb();

  const failed = results.filter((r) => !r.pass);
  console.log('');
  console.log(`===== 启动自检回归：${results.length - failed.length}/${results.length} 通过 =====`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('执行失败:', e);
  process.exit(2);
});
