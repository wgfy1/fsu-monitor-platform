import Aedes from 'aedes';
import { createServer, Server } from 'net';
import DeviceService from '../services/deviceService';
import {
  resolveMqttCredentials,
  PLATFORM_CLIENT_ID_PREFIX,
} from '../utils/mqttCredentials';
import { handleDeviceMessage } from './messageHandler';
import {
  routeUplink, registerPublisher, TOPIC_LOGIN, normalizeGwId, downlinkTopic, METHODS,
  onGatewayOffline, onGatewaySubscribed, clearHeartbeatStatus,
} from '../protocols/fsu';

/**
 * MQTT topic filter 匹配（协议 4.7.1）
 *   '+' 匹配**恰好一层**；'#' 匹配**剩余所有层**（只能出现在末尾）
 *
 * 用于"该设备是否订阅了某个下行 topic"这一**功能性判断**
 * （平台主动校时发送前的前置条件），不是诊断统计。
 */
export function topicMatchesFilter(filter: string, topic: string): boolean {
  if (filter === topic) return true;
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

/**
 * 内置 MQTT Broker（基于 aedes）
 * 让平台自带 Broker，客户无需再安装 / 部署外部 Mosquitto。
 * 默认监听 1883，设备按原有方式 mqtt://host:1883 上报即可。
 *
 * 注意：aedes 1.x 为纯 ESM 包，与后端 CommonJS（module: commonjs）不兼容，
 * 因此锁定 CommonJS 版本 aedes 0.x。
 *
 * MQTT 认证（统一账号，非一机一密）：
 *  - 所有厂家 FSU 与平台内部客户端共用同一套账号：
 *      username = MQTT_USERNAME（统一为 platform）
 *      password = MQTT_PASSWORD（仅存于部署环境 .env）
 *  - 匿名连接：仅当 MQTT_ALLOW_ANONYMOUS=true 时放行，生产必须设为 false
 *  - 用户名或密码错误一律拒绝
 *
 * 设备身份识别（不依赖 MQTT 用户名）：
 *  因所有设备共用同一用户名，设备之间通过厂家协议报文中的 mac / Topic 区分，
 *  平台设备ID 即 mac（与匿名接入时期的既有识别机制一致）。
 *  平台自身发布的指令则用 clientId 前缀（PLATFORM_CLIENT_ID_PREFIX）识别。
 */
export class EmbeddedBroker {
  private aedes: Aedes;
  private server: Server | null = null;
  private listening = false;
  /** 当前已连接（且可识别为平台设备）的客户端集合 */
  private connectedDeviceIds = new Set<string>();
  /** MQTT clientId → 平台设备ID（厂家协议 login 时登记，断开时清理） */
  private clientDeviceIds = new Map<string, string>();
  /**
   * MQTT clientId → 当前连接对象引用
   *
   * 用于区分"新连接接管"与"旧连接断开"：
   * 厂家快速重连时 aedes 会用相同 clientId 建立新连接并关闭旧连接，
   * 旧连接的 clientDisconnect 事件可能在新连接已登录、已收到心跳之后才到达。
   * 只有当前连接的断开事件才作废心跳快照，避免旧事件清掉新连接的状态。
   */
  private gatewayConnections = new Map<string, any>();

  constructor(private port = 1883) {
    this.aedes = new Aedes({
      // 注意：aedes 0.51 的 heartbeatInterval 是 Broker 集群心跳（多实例协调用），
      // 与客户端保活无关。客户端保活由设备 CONNECT 包中的 keepalive 字段决定
      // （keepalive × 1.5s 无任何报文则断开）。显式声明以保持默认值。
      heartbeatInterval: 60000,
      // 等待客户端发送 CONNECT 包的超时：默认 30s → 120s，
      // 给网络不稳定的 FSU 设备更充足的上线时间
      connectTimeout: 120000,
    });
    this.setupAuthentication();
    this.trackClientConnection();
    this.trackDevicePublishes();
    this.setupConnectionLogging();
  }

  /**
   * 当前 MQTT 已连接的设备ID集合
   * 用于超时扫描时排除"连接中但暂未上报数据"的设备
   */
  get connectedDevices(): Set<string> {
    return this.connectedDeviceIds;
  }

  /**
   * 构造带 CONNACK 返回码的认证错误
   * 4 = BAD_USERNAME_OR_PASSWORD（用户名或密码错误）
   * 5 = NOT_AUTHORIZED（未授权）
   */
  private static authError(
    message: string,
    returnCode: number = 4,
  ): Error & { returnCode: number } {
    const err: any = new Error(message);
    err.returnCode = returnCode;
    return err;
  }

  /**
   * 配置 MQTT 认证（统一账号，禁止匿名）
   */
  private setupAuthentication(): void {
    this.aedes.authenticate = async (
      client: any,
      username: string | undefined,
      password: Buffer | undefined,
      callback: (err: (Error & { returnCode: number }) | null, success: boolean | null) => void,
    ) => {
      try {
        // 打印认证尝试，便于排查设备连接问题。
        // 安全：绝不打印密码明文（生产日志会被采集/留存），只记录是否提供了密码
        const hasPassword = !!password && password.length > 0;
        console.log(
          `[MQTT] 认证尝试: username=${username || '(无)'}, clientId=${client?.id || '(无)'}, 提供密码=${hasPassword ? '是' : '否'}`
        );

        // aedes 0.51 不会在 client 对象上暴露 username（仅存在于 CONNECT 包内），
        // 手动回填，供连接日志使用
        client.username = username;

        // 匿名连接（未提供用户名或密码）：默认禁止，仅当显式 MQTT_ALLOW_ANONYMOUS=true 时放行
        if (!username || !password || password.length === 0) {
          if (process.env.MQTT_ALLOW_ANONYMOUS !== 'false') {
            console.warn('[MQTT] 匿名连接已放行（MQTT_ALLOW_ANONYMOUS 未设为 false）');
            return callback(null, true);
          }
          console.warn('[MQTT] 认证失败: 匿名连接被禁止');
          return callback(EmbeddedBroker.authError('匿名连接被禁止', 5), false);
        }

        // 统一账号校验：全平台 FSU 与平台内部客户端共用同一套用户名/密码。
        // 取值统一走 resolveMqttCredentials()，与 client.ts 共用同一实现 ——
        // 两边各自读 process.env 时，任何一处回退逻辑不一致都会导致
        // 平台自己的客户端被自己拒绝（或设备用默认口令混入）。
        const { username: expectedUser, password: expectedPass } = resolveMqttCredentials();

        if (username !== expectedUser) {
          console.warn(`[MQTT] 认证失败: 用户名错误, username=${username}`);
          return callback(EmbeddedBroker.authError('用户名或密码错误', 4), false);
        }
        if (password.toString() !== expectedPass) {
          console.warn(`[MQTT] 认证失败: 密码错误, username=${username}`);
          return callback(EmbeddedBroker.authError('用户名或密码错误', 4), false);
        }

        const kind = EmbeddedBroker.isPlatformClient(client) ? '平台客户端' : '设备';
        console.log(`[MQTT] ✓ ${kind}认证通过: clientId=${client?.id || username}`);
        return callback(null, true);
      } catch (err: any) {
        console.error('[MQTT] 认证异常:', err);
        callback(EmbeddedBroker.authError('认证服务异常', 3), false);
      }
    };
  }

  /**
   * 判断是否为平台内部客户端（指令下发用）。
   *
   * 统一账号下用户名与设备完全相同，必须按 clientId 前缀识别，
   * 否则平台无法区分"自己发的指令"和"设备上报的数据"。
   */
  private static isPlatformClient(client: any): boolean {
    return !!client?.id && String(client.id).startsWith(PLATFORM_CLIENT_ID_PREFIX);
  }

  /**
   * 跟踪设备断开事件，更新设备在线状态
   *
   * 统一账号下所有 FSU 共用同一用户名，连接建立时无法从用户名识别设备；
   * 设备身份在厂家协议 gw/v1/login 报文中（mac）才能确定，届时登记
   * clientId → 设备ID（见 rememberDeviceClient）。
   * 因此：
   *  - 上线：由 login（upsertDevice）与心跳（setHeartbeat）标记 online + mqttConnected=1，
   *          与厂家 FSU 匿名接入时期的既有行为一致
   *  - 断开：按 clientId 反查设备并标记离线，保持"断开即离线"的原有语义
   * 平台内部客户端不参与设备状态跟踪。
   */
  private trackClientConnection(): void {
    // 新连接建立（认证通过后）：同一 clientId 被新连接接管时，
    // 作废上一连接周期的心跳快照 → 在收到新周期第一条有效心跳前，
    // 子设备一律显示"离线"（不因 MQTT 已连接就显示在线/未知）。
    this.aedes.on('client', (client: any) => {
      if (!client?.id || EmbeddedBroker.isPlatformClient(client)) return;
      const clientId = String(client.id);
      const prev = this.gatewayConnections.get(clientId);
      this.gatewayConnections.set(clientId, client);
      if (prev === client) return; // 同一连接（不应发生），不重复处理

      const knownDeviceId = this.clientDeviceIds.get(clientId);
      clearHeartbeatStatus(knownDeviceId ?? normalizeGwId(clientId));
    });

    this.aedes.on('clientDisconnect', (client: any) => {
      const clientId = client?.id ? String(client.id) : '';
      if (!clientId || EmbeddedBroker.isPlatformClient(client)) return;

      // 旧连接的断开事件：该 clientId 已被新连接接管 → 不得清除新连接的状态
      if (this.gatewayConnections.get(clientId) !== client) {
        console.log(`[MQTT] 忽略旧连接的断开事件: clientId=${clientId}（已被新连接接管）`);
        return;
      }
      this.gatewayConnections.delete(clientId);

      const deviceId = this.clientDeviceIds.get(clientId);
      // 未完成 login 的连接（如认证后被拒绝）没有设备可标记，
      // 但仍按 clientId 作废可能存在的会话快照（幂等）。
      this.clientDeviceIds.delete(clientId);
      clearHeartbeatStatus(deviceId ?? normalizeGwId(clientId));
      if (!deviceId) return;

      this.connectedDeviceIds.delete(deviceId);
      // 平台主动校时：结束本次上线事件（下次重连算新的上线，会再校时一次）
      onGatewayOffline(deviceId);
      // 网关断开后，所有功能子设备显示"离线"（快照已作废，不再沿用旧状态）
      DeviceService.setMqttConnectionState(deviceId, false).catch((err) => {
        console.error(`[MQTT] 处理设备断开事件失败: deviceId=${deviceId}`, err);
      });
    });
  }

  /**
   * 登记 clientId → 平台设备ID 关联（厂家协议 login 时调用）
   * 供断开事件与在线设备集合使用
   */
  private rememberDeviceClient(client: any, deviceId: string): void {
    const clientId = client?.id ? String(client.id) : '';
    if (!clientId) return;
    this.clientDeviceIds.set(clientId, deviceId);
    this.connectedDeviceIds.add(deviceId);
  }

  /**
   * Broker 层直接处理设备上报（内置 Broker 模式的主处理路径）
   * 分流：
   *  - gw/v1/# 厂家协议：登录时登记 mac → 平台设备ID，数据上报按 mac 关联设备
   *  - 平台自身发布（按 clientId 判定）与 /cmd 指令：跳过，不会被当作设备数据
   *  - 其它 Topic：交统一入口留痕忽略（旧物模型 topic 已下线，不会再落库）
   */
  private trackDevicePublishes(): void {
    this.aedes.on('publish', (packet: any, client: any) => {
      const topic: string = packet?.topic;
      if (!topic) return;

      // 临时调试：Broker 层全 Topic 抓包（MQTT_DEBUG_ALL=true 时生效）
      if (process.env.MQTT_DEBUG_ALL === 'true') {
        if (!topic.startsWith('$') && !topic.includes('login')) {
          console.log(`[Broker抓包] ${topic} 来自: ${client?.username || '(无)'} 内容: ${packet.payload.toString().substring(0, 200)}`);
        }
      }

      // 忽略 $SYS 等 Broker 保留 Topic（以 $ 开头，如 $SYS/.../heartbeat、$queue 等），
      // 它们不是设备业务消息，不打印"未匹配"告警
      if (topic.startsWith('$')) return;

      // 平台回给设备的 ack（sc/v1/...）不是设备上报，跳过避免二次处理
      if (topic.startsWith('sc/v1/')) return;

      // 跳过平台自身发布（指令下发等），避免把 cmd 当设备数据。
      // 注意：全平台设备与平台共用同一 MQTT 用户名，这里**只能按 clientId 判断**，
      // 若沿用"用户名 === MQTT_USERNAME"的旧判断，设备上报会被整体丢弃。
      if (EmbeddedBroker.isPlatformClient(client)) return;
      if (topic.includes('/cmd')) return;

      // 厂家协议：登录登记 mac 映射，数据通过 mac → 平台设备ID 关联
      if (topic.startsWith('gw/v1/')) {
        this.handleGatewayPublish(topic, packet, client);
        return;
      }

      // 非厂家协议的其它 Topic：交给统一入口留痕忽略（旧物模型已下线，不会再落库）
      handleDeviceMessage(null, topic, packet.payload).catch((err) => {
        console.error(`[MQTT] Broker 处理消息失败: topic=${topic}`, err);
      });
    });
  }

  /**
   * 厂家协议消息处理（gw/v1/#）
   * 上报消息用 mac 标识设备，通过 mac → 平台设备ID 映射定位设备：
   *  - 已映射：按映射的平台设备ID 处理数据
   *  - 未映射：用 mac 自身作为设备ID（同连接内 login 之前的首次上报）
   * 统一账号下 MQTT 用户名不参与设备识别。
   */
  private handleGatewayPublish(topic: string, packet: any, client: any): void {
    // 跳过平台回给设备的 ack 响应（避免被当成设备数据）
    if (topic.endsWith('/ack')) return;

    // 厂家协议层统一处理（protocols/fsu）：
    //   上行 login/heartbeat/dataReport/alarmReport/ntp → 校验 + 过期过滤 + 会话 + 落库 + 回响应
    //   平台下行请求的响应（getData/getAlarm/setData/reboot/ota）→ 关联回待响应请求
    // 返回值 false = 不是协议定义的上行方法（如 uploadDevInfo），交回既有兼容路径。
    routeUplink(topic, packet.payload, client?.id)
      .then((handled) => {
        if (handled) {
          // login 后登记 clientId → 设备ID，用于连接断开时标记离线
          if (topic === TOPIC_LOGIN) {
            try {
              const mac = normalizeGwId(JSON.parse(packet.payload.toString())?.params?.mac);
              if (mac) this.rememberDeviceClient(client, mac);
            } catch {
              // 非 JSON 的 login 已在协议层拒绝，这里无需处理
            }
          }
          return;
        }
        handleDeviceMessage(null, topic, packet.payload).catch((err) => {
          console.error(`[MQTT] Broker 处理厂家自定义方法失败: topic=${topic}`, err);
        });
      })
      .catch((err) => {
        console.error(`[MQTT] Broker 处理厂家消息失败: topic=${topic}`, err);
      });
  }

  // 说明：原 handleVendorLogin（login 处理 + mac→设备ID 登记 + login 响应）
  // 已整体迁移到 protocols/fsu/handlers.handleLogin（协议 4.1），
  // 本类不再保留第二套实现；login 的 clientId→设备 关联在 handleGatewayPublish 中完成。

  /**
   * 底层连接日志：记录每一次连接、断开、错误与 CONNACK 应答，
   * 用于排查"设备能连上网络但连不上平台"这类问题
   */
  private setupConnectionLogging(): void {
    // 记录 clientId → 连接信息（含 client 对象引用），用于：
    //  - 检测重复 clientId 互踢（aedes 在相同 clientId 重连时会强制关闭旧连接）
    //  - 计算连接时长，便于排查"收到心跳但被断开"
    const clientsById = new Map<string, { client: any; connectedAt: number }>();

    // 客户端连接成功（认证通过后才触发）
    this.aedes.on('client', (client: any) => {
      const prev = clientsById.get(client.id);
      if (prev) {
        console.warn(
          `⚠ [MQTT] clientId 重复连接: ${client.id} (username=${client?.username || '(无)'}), ` +
          `旧连接将被 Broker 强制关闭 — 设备快速重连时会出现"收到心跳但被断开"`
        );
      }
      clientsById.set(client.id, { client, connectedAt: Date.now() });
      // 订阅数用于排查 FSU 是否为纯发布者（若从不发 SUBSCRIBE 包，此处恒为 0，
      // 且后续不会出现 [subscribe] 日志 → 响应不能依赖 Topic 订阅下发）
      console.log(`✓ [MQTT] 客户端已连接: clientId=${client?.id}, username=${client?.username || '(无)'}, 订阅数=${Object.keys(client?.subscriptions || {}).length}`);
    });

    // 客户端订阅 Topic（排查 FSU 是否订阅任何 Topic，厂家响应机制依赖此判断）
    this.aedes.on('subscribe', (subscriptions: any, client: any) => {
      console.log(`[subscribe] ${client?.username || '(无)'} clientId: ${client?.id} 订阅: ${subscriptions.map((s: any) => `${s.topic}(qos${s.qos})`).join(', ')}`);
      // 设备订阅建立后，尽快推进"等待订阅就绪"的上线校时
      const deviceId = this.clientDeviceIds.get(String(client?.id ?? ''));
      if (deviceId) onGatewaySubscribed(deviceId);
      else onGatewaySubscribed(normalizeGwId(client?.id));
    });

    // 客户端取消订阅
    this.aedes.on('unsubscribe', (unsubscriptions: any, client: any) => {
      console.log(`[unsubscribe] ${client?.username || '(无)'} 取消: ${unsubscriptions.join(', ')}`);
    });

    // 客户端断开
    this.aedes.on('clientDisconnect', (client: any) => {
      const entry = clientsById.get(client.id);
      if (entry) {
        if (entry.client === client) {
          const duration = Math.round((Date.now() - entry.connectedAt) / 1000);
          console.log(`✗ [MQTT] 客户端已断开: clientId=${client?.id}, username=${client?.username || '(无)'}, 连接时长=${duration}s`);
          clientsById.delete(client.id);
        } else {
          // 该 clientId 已有新连接接管，这是被踢掉的旧连接
          console.log(`✗ [MQTT] 旧连接已被替换关闭: clientId=${client?.id}, username=${client?.username || '(无)'}`);
        }
      } else {
        console.log(`✗ [MQTT] 客户端已断开: clientId=${client?.id}, username=${client?.username || '(无)'}`);
      }
    });

    // 客户端协议/网络错误
    this.aedes.on('clientError', (client: any, err: any) => {
      console.log(`✗ [MQTT] 客户端错误: clientId=${client?.id}, username=${client?.username || '(无)'}, error=${err?.message}`);
    });

    // CONNACK 应答码：0=接受, 1=协议版本不支持, 2=标识符被拒绝, 3=服务器不可用, 4=用户名密码错误, 5=未授权
    // 注意：aedes 0.51 的参数顺序是 (connack, client)
    this.aedes.on('connackSent', (packet: any, client: any) => {
      const code = packet?.returnCode ?? -1;
      if (code === 0) {
        console.log(`✓ [MQTT] CONNACK 接受: clientId=${client?.id}`);
      } else {
        console.warn(`✗ [MQTT] CONNACK 拒绝: clientId=${client?.id}, returnCode=${code} (4=用户名密码错误, 5=未授权, 3=服务器不可用)`);
      }
    });

    // 心跳超时（设备静默掉线）
    this.aedes.on('keepaliveTimeout', (client: any) => {
      console.warn(`✗ [MQTT] 心跳超时: clientId=${client?.id}, username=${client?.username || '(无)'}`);
    });

    // 收到客户端 PINGREQ 心跳包（参数顺序: packet, client）
    this.aedes.on('ping', (_packet: any, client: any) => {
      // 平台自身客户端每 60 秒保活一次，与设备无关且不走物联网卡，
      // 过滤掉避免刷屏；只留设备心跳日志
      if (EmbeddedBroker.isPlatformClient(client)) return;
      console.log(`[MQTT] 心跳: clientId=${client?.id}`);
    });

    // 连接阶段错误（如 connectTimeout 内未收到 CONNECT 包）
    this.aedes.on('connectionError', (client: any, err: any) => {
      console.warn(`✗ [MQTT] 连接阶段错误: clientId=${client?.id || '(尚未标识)'}, error=${err?.message}`);
    });
  }

  get isListening(): boolean {
    return this.listening;
  }

  /**
   * 启动 Broker 监听
   * 若端口被占用（如外部 Mosquitto 已在运行）会 reject，
   * 由调用方决定回退到外部 Broker。
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer(this.aedes.handle);

      this.server.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          reject(new Error(`端口 ${this.port} 已被占用，可能已有 MQTT Broker 在运行`));
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, () => {
        this.listening = true;
        console.log(`✓ 内置 MQTT Broker 已启动，端口 ${this.port}`);
        // 把 Broker 发布能力注册给厂家协议层（下行 getData/setData/reboot/OTA 等）
        registerPublisher((topic, payload, qos) => this.publishDownlink(topic, payload, qos));
        resolve();
      });
    });
  }

  /**
   * 该网关此刻是否投得出去：MQTT 已连接 且 订阅了 sc/v1/ntp/{gwId}
   *
   * 平台主动校时在发送前必须过这一关：设备没连上、或没订阅校时主题时发了也白发。
   * 判据直接取自 aedes 的在线客户端表与客户端订阅表（与真实投递用的是同一份数据）。
   */
  canDeliverNtp(gwId: string): boolean {
    if (!gwId) return false;
    const clients: Record<string, any> = (this.aedes as any)?.clients ?? {};
    const client = clients[gwId];
    if (!client || client.connected !== true) return false;
    const topic = downlinkTopic(METHODS.NTP, gwId);
    return Object.keys(client.subscriptions ?? {}).some((f) => topicMatchesFilter(f, topic));
  }

  /**
   * 发布下行消息（供厂家协议层调用）
   * 内置 Broker 模式下由 aedes 直接投递给已订阅的网关。
   */
  private publishDownlink(topic: string, payload: Buffer, qos: 0 | 1): Promise<void> {
    return new Promise((resolve, reject) => {
      this.aedes.publish(
        { cmd: 'publish', topic, payload, qos, dup: false, retain: false },
        (err?: Error) => (err ? reject(err) : resolve()),
      );
    });
  }

  /**
   * 停止 Broker（关闭监听并断开所有客户端）
   */
  async stop(): Promise<void> {
    registerPublisher(null); // 注销下行发布能力，避免向已关闭的 Broker 发布
    this.connectedDeviceIds.clear();
    this.clientDeviceIds.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
      this.listening = false;
    }
    await new Promise<void>((resolve) => this.aedes.close(() => resolve()));
  }
}

// 单例（端口与 MQTT_BROKER_PORT 保持一致，默认 1883）
export const embeddedBroker = new EmbeddedBroker(
  Number(process.env.MQTT_BROKER_PORT) || 1883,
);
export default embeddedBroker;
