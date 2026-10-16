import * as mqtt from 'mqtt';
import {
  resolveMqttCredentials,
  PLATFORM_CLIENT_ID_PREFIX,
} from '../utils/mqttCredentials';
import { handleDeviceMessage } from './messageHandler';
import { registerPublisher } from '../protocols/fsu';

/**
 * 平台 MQTT 客户端
 * 职责：
 *  - 内置 Broker 模式（EMBEDDED_BROKER=true，默认）：设备直连平台内置 Broker，
 *    消息由 Broker 层（aedes publish 事件，见 broker.ts）直接处理，
 *    本客户端不订阅任何 Topic，仅用于向设备下发指令。
 *  - 外部 Broker 模式（EMBEDDED_BROKER=false）：本客户端订阅业务 Topic
 *    接收设备上报，作为兜底路径交给 messageHandler 处理。
 *
 * 业务 Topic（厂家 FSU 协议）：
 *   gw/v1/#                                 厂家上行；平台下行响应为 sc/v1/...
 */

/**
 * MQTT 连接客户端
 * 负责连接 Broker、向设备下发指令；消息接收见 broker.ts（Broker 层）
 */
export class MqttClient {
  private client: mqtt.MqttClient | null = null;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * 连接 MQTT Broker
   */
  async connect(): Promise<void> {
    const host = process.env.MQTT_BROKER_HOST || 'localhost';
    const port = process.env.MQTT_BROKER_PORT || '1883';
    // MQTT 统一账号：平台内部客户端与所有厂家 FSU 共用同一套凭据。
    // 必须与 broker.ts 走同一个解析函数，否则两边取值不一致时平台会连不上自己的 Broker。
    const { username, password, usingDevDefaults } = resolveMqttCredentials();
    if (usingDevDefaults) {
      console.warn('[MQTT] ⚠ 平台客户端正在使用开发默认口令连接 Broker（生产环境不应出现）');
    }
    const brokerUrl = `mqtt://${host}:${port}`;

    console.log(`[MQTT] 正在连接 Broker: ${brokerUrl}`);

    return new Promise((resolve, reject) => {
      const opts: mqtt.IClientOptions = {
        clientId: `${PLATFORM_CLIENT_ID_PREFIX}${Math.random().toString(16).substring(2, 10)}`,
        clean: true,
        reconnectPeriod: 0, // 手动控制重连
        connectTimeout: 10000,
      };
      if (username) opts.username = username;
      if (password) opts.password = password;

      this.client = mqtt.connect(brokerUrl, opts);

      this.client.on('connect', () => {
        console.log(`[MQTT] ✓ 已连接到 ${brokerUrl}`);
        this.connected = true;
        // 外部 Broker 模式：协议层的下行消息（getData/setData/reboot/OTA 等）
        // 通过本客户端发布；内置 Broker 模式由 EmbeddedBroker 注册发布能力。
        if (process.env.EMBEDDED_BROKER === 'false') {
          registerPublisher((topic, payload, qos) => new Promise<void>((res, rej) => {
            if (!this.client) return rej(new Error('MQTT 客户端未就绪'));
            this.client.publish(topic, payload, { qos }, (err) => (err ? rej(err) : res()));
          }));
        }
        this.subscribe();
        resolve();
      });

      this.client.on('message', (topic, message) => {
        this.handleMessage(topic, message);
      });

      this.client.on('error', (err) => {
        console.error('[MQTT] 连接错误:', err.message);
        if (!this.connected) {
          reject(err);
        }
      });

      this.client.on('close', () => {
        console.log('[MQTT] 连接已断开');
        this.connected = false;
        this.scheduleReconnect();
      });

      // 连接超时
      setTimeout(() => {
        if (!this.connected) {
          reject(new Error('MQTT 连接超时'));
        }
      }, 15000);
    });
  }

  /**
   * 订阅业务 Topic（仅外部 Broker 模式需要）
   * 内置 Broker 模式下消息在 Broker 层直接处理，客户端不订阅，
   * 避免同一消息被处理两次。
   */
  private subscribe(): void {
    if (!this.client) return;

    // 临时调试：全 Topic 抓包（MQTT_DEBUG_ALL=true 时生效，排查 FSU 实际发布位置，生产不要开）
    if (process.env.MQTT_DEBUG_ALL === 'true') {
      this.client.subscribe('#', { qos: 0 }, (err) => {
        if (err) console.error('[调试] 订阅 # 失败:', err);
        else console.log('[调试] 已订阅 # (全 Topic 抓包)');
      });
      return;
    }

    if (process.env.EMBEDDED_BROKER !== 'false') {
      console.log('[MQTT] 内置 Broker 模式：消息由 Broker 层处理，平台客户端不订阅');
      return;
    }

    // 只订阅厂家 FSU 协议 Topic（旧物模型 fsu/+/data|status|event 已下线）
    const topics = [
      'gw/v1/#',
    ];

    this.client.subscribe(topics, { qos: 1 }, (err) => {
      if (err) {
        console.error(`[MQTT] 订阅失败: ${topics.join(', ')}`, err.message);
      } else {
        console.log(`[MQTT] ✓ 已订阅(外部Broker模式): ${topics.join(', ')}`);
      }
    });
  }

  /**
   * 收到设备消息（仅外部 Broker 模式兜底路径）
   * 无连接用户名身份，设备ID由 messageHandler 从 topic 提取；
   * 解析逻辑与 Broker 层共用同一模块。
   */
  private handleMessage(topic: string, message: Buffer): void {
    // 忽略 $SYS 等 Broker 保留 Topic（$ 开头），不当作设备业务消息
    if (topic.startsWith('$')) return;

    // 平台回给设备的 ack（sc/v1/...）不是设备上报，跳过避免二次处理
    if (topic.startsWith('sc/v1/')) return;

    // 说明：厂家协议（gw/v1/...）的响应统一由 protocols/fsu 协议层在
    // routeUplink 内发送（与内置 Broker 模式共用同一实现），
    // 此处**不再**单独构造 ack，避免同一消息被回两次响应。

    // 临时调试：抓包打印所有非 login 消息（login 已能确认，过滤减少噪音）
    if (process.env.MQTT_DEBUG_ALL === 'true') {
      if (!topic.includes('login')) {
        const raw = message.toString();
        console.log('=== [抓包] 收到消息 ===');
        console.log('Topic:', topic);
        console.log('内容:', raw.substring(0, 500));
        console.log('长度:', message.length);
        console.log('========================');
      }
      // 抓包模式下业务 Topic 仍正常处理，其余 Topic 静默（避免"未匹配"告警刷屏）
      if (topic.startsWith('gw/v1/')) {
        handleDeviceMessage(null, topic, message);
      }
      return;
    }

    handleDeviceMessage(null, topic, message);
  }


  /**
   * 断线重连（每 5 秒重试）
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    console.log('[MQTT] 5秒后尝试重连...');
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch {
        // 连接失败会自动再次触发 close → scheduleReconnect
      }
    }, 5000);
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      await this.client.endAsync();
      this.client = null;
      this.connected = false;
      console.log('[MQTT] 已断开连接');
    }
  }
}

// 单例
export const mqttClient = new MqttClient();
export default mqttClient;
