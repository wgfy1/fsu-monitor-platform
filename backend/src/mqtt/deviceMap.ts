/**
 * MAC → 平台设备ID 关联表（内存）
 *
 * 背景：平台所有厂家 FSU 使用**统一 MQTT 账号**连接（全平台共用一套用户名/密码），
 * MQTT 用户名不再标识设备；设备身份由厂家协议报文中的 mac 决定，
 * 平台设备ID 即 mac（与厂家 FSU 匿名接入时期的既有行为保持一致）。
 *
 * mac 在首次 gw/v1/login 时获取，因此用本表在 login 时登记，
 * 后续数据上报（gw/v1/dataReport/{mac}）通过 mac 反查平台设备ID。
 *
 * 注意：映射只在内存中，重启后失效；设备重连后再次 login 会重新登记。
 */
const macToDeviceIdMap = new Map<string, string>();

/**
 * 登记映射：mac → 平台设备ID
 * @param mac 厂家协议中的设备 mac（如 00534e080280）
 * @param deviceId 平台设备ID
 */
export function setDeviceIdByMac(mac: string, deviceId: string): void {
  macToDeviceIdMap.set(mac, deviceId);
  console.log(`[映射] MAC ${mac} -> 设备 ${deviceId}`);
}

/**
 * 查询映射：mac → 平台设备ID
 * @returns 映射的平台设备ID；未登记返回 undefined
 */
export function getDeviceIdByMac(mac: string): string | undefined {
  return macToDeviceIdMap.get(mac);
}

/**
 * 判断 mac 是否已登记映射
 */
export function hasMacMapping(mac: string): boolean {
  return macToDeviceIdMap.has(mac);
}
