/**
 * 消息过期校验（协议 3.6 b）
 *
 * 协议原文：
 *   "每个消息都有时间戳，接收方应根据消息的时间戳来过滤掉过期的消息
 *     (login 和 ntp 除外)，建议默认消息过期时间为 3 秒。"
 *
 * 全平台**只有这一处**做时间判断，禁止在各 handler 里复制一套。
 * 过期时间由 MQTT_MESSAGE_EXPIRE_SECONDS 配置（秒），未配置时默认 3 秒。
 *
 * 单位说明（协议混用，务必区分）：
 *   - 信封 timestamp ：毫秒（协议所有报文"消息产生的时间戳"，uint64 毫秒级）
 *   - alarmTime/clearTime：秒（4.6 表格明确"秒级时间戳"）
 *   - historyTime     ：协议未标注单位（见 mapping.ts）
 * 本模块只处理**信封毫秒时间戳**。
 */
import { EXPIRE_EXEMPT_METHODS, messageExpireMs } from './constants';

export interface ExpiryResult {
  /** 是否过期（true = 应丢弃，不进入业务处理） */
  expired: boolean;
  /** 判断依据（日志排查用） */
  reason: string;
  /** 消息年龄（毫秒，now - timestamp） */
  ageMs: number;
}

/**
 * 判断消息是否过期
 * @param method    协议方法名（login / ntp 豁免）
 * @param timestamp 信封毫秒时间戳（调用前应已通过 validateEnvelope 校验为数字）
 * @param now       当前时间（毫秒），默认 Date.now()（便于测试注入）
 */
export function checkExpiry(method: string, timestamp: number, now: number = Date.now()): ExpiryResult {
  const expireMs = messageExpireMs();
  const ageMs = now - timestamp;

  // login / ntp 不参与过期过滤（协议 3.6 b）
  if (EXPIRE_EXEMPT_METHODS.includes(String(method).toLowerCase())) {
    return { expired: false, reason: `${method} 不参与过期过滤`, ageMs };
  }

  // 未来时间戳（设备时钟超前）不算过期：时钟偏差不应当成"过期"丢弃数据
  if (ageMs < 0) {
    return { expired: false, reason: `时间戳超前 ${-ageMs}ms，按未过期处理`, ageMs };
  }

  if (ageMs > expireMs) {
    return {
      expired: true,
      reason: `消息已过期：age=${ageMs}ms > ${expireMs}ms`,
      ageMs,
    };
  }
  return { expired: false, reason: `未过期：age=${ageMs}ms <= ${expireMs}ms`, ageMs };
}
