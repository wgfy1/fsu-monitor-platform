import { Router, Request, Response } from 'express';
import mqttClient from '../mqtt/client';

const router = Router();

/**
 * 获取平台配置状态
 * GET /api/config
 */
router.get('/', (_req: Request, res: Response) => {
  // 正式接入方式只有厂家 FSU MQTT
  const connectMode = process.env.CONNECT_MODE || 'mqtt';

  res.sendSuccess({
    connectMode,
    mqtt: {
      enabled: true, // MQTT 为唯一正式接入方式
      connected: mqttClient.isConnected,
      broker: `mqtt://${process.env.MQTT_BROKER_HOST || 'localhost'}:${process.env.MQTT_BROKER_PORT || '1883'}`,
    },
  }, '获取配置成功');
});

export default router;
