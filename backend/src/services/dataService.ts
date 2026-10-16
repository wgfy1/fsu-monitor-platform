import database from '../models/database';

/**
 * 设备数据服务类
 */
export class DataService {
  /**
   * 清理超过保留期的厂家 FSU 历史数据（fsu_data_history）
   *
   * 复用现有 DATA_RETENTION_DAYS（默认 30 天），依据 **data_timestamp（毫秒）** 判断。
   * 这是**唯一**的厂家历史数据清理入口（旧物模型 device_data 已下线，不再有对应任务）。
   * 只删本表：不影响 devices.latest_meters，也不影响 device_meters。
   * 删除失败**不静默吞掉**：抛给调用方（每日清理任务会打印失败日志）。
   */
  static async cleanOldFsuData(days: number = 30): Promise<number> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    try {
      const result = await database.run(
        'DELETE FROM fsu_data_history WHERE data_timestamp < ?', [cutoff]
      );
      const deleted = result.changes || 0;
      console.log(`[清理] 厂家 FSU 历史数据: 保留 ${days} 天, 删除 ${deleted} 条`);
      return deleted;
    } catch (error) {
      console.error('[清理] 厂家 FSU 历史数据失败:', error);
      throw error;
    }
  }
  /**
   * 批量写入厂家 FSU 历史数据（一条 dataReport 的全部点在同一事务内完成）
   *
   * 语义严格对应协议原始数据，**不做任何字段转换**：
   *   device_id = 网关 gwId ｜ dev_id = 厂家子设备 ｜ meter_id = 厂家测量点
   *   value     = 厂家原始字符串（保持 string，不转 number）
   * 每个 (devId, meterId) 独立成行 —— 既不合并也不覆盖。
   *
   * 实现：单事务 + 分块多值 INSERT（避免 N 次往返 / N 个事务）。
   * 失败抛错（不静默吞掉），由调用方打印含 gwId/devId/点数的错误日志。
   */
  static async saveFsuHistory(points: Array<{
    deviceId: string; devId: string; meterId: string; value: string;
    isHistory: number; dataTimestamp: number;
  }>): Promise<number> {
    if (!points.length) return 0;
    const receivedAt = Date.now();
    const createdAt = receivedAt;   // 三个时间字段统一毫秒
    const CHUNK = 200;

    try {
      await database.run('BEGIN TRANSACTION');
      try {
        let inserted = 0;
        for (let i = 0; i < points.length; i += CHUNK) {
          const chunk = points.slice(i, i + CHUNK);
          const placeholders = chunk.map(() => '(?,?,?,?,?,?,?,?)').join(',');
          const params: any[] = [];
          for (const p of chunk) {
            params.push(
              p.deviceId, p.devId, p.meterId, p.value,
              p.isHistory, p.dataTimestamp, receivedAt, createdAt
            );
          }
          const r = await database.run(
            `INSERT INTO fsu_data_history
               (device_id, dev_id, meter_id, value, is_history, data_timestamp, received_at, created_at)
             VALUES ${placeholders}`,
            params
          );
          inserted += r.changes || 0;
        }
        await database.run('COMMIT');
        return inserted;
      } catch (err) {
        await database.run('ROLLBACK').catch(() => undefined);
        throw err;
      }
    } catch (error) {
      console.error('写入厂家 FSU 历史数据失败:', error);
      throw error;
    }
  }

  /**
   * 查询厂家 FSU 原始历史数据
   *
   * 过滤条件全部下推数据库（走 idx_fsu_hist_dev_meter_ts / idx_fsu_hist_device_ts），
   * 不在 Node 内存过滤。按 data_timestamp 升序返回，便于前端直接画时间序列。
   * 只返回协议原始点，**不返回任何旧物模型字段**。
   */
  static async getFsuHistory(q: {
    deviceId: string;
    devIds?: string[];
    meterIds?: string[];
    startTime: number;
    endTime: number;
    limit: number;
  }): Promise<Array<{ devId: string; meterId: string; value: string; dataTimestamp: number; isHistory: number }>> {
    const where: string[] = ['device_id = ?', 'data_timestamp >= ?', 'data_timestamp <= ?'];
    const params: any[] = [q.deviceId, q.startTime, q.endTime];

    if (q.devIds && q.devIds.length) {
      where.push(`dev_id IN (${q.devIds.map(() => '?').join(',')})`);
      params.push(...q.devIds);
    }
    if (q.meterIds && q.meterIds.length) {
      where.push(`meter_id IN (${q.meterIds.map(() => '?').join(',')})`);
      params.push(...q.meterIds);
    }
    params.push(q.limit);

    const rows = await database.query(
      `SELECT dev_id, meter_id, value, is_history, data_timestamp
         FROM fsu_data_history
        WHERE ${where.join(' AND ')}
        ORDER BY data_timestamp ASC, id ASC
        LIMIT ?`,
      params
    );

    return rows.map((r: any) => ({
      devId: String(r.dev_id),
      meterId: String(r.meter_id),
      value: String(r.value),          // 保持厂家原始字符串
      dataTimestamp: Number(r.data_timestamp),
      isHistory: Number(r.is_history),
    }));
  }
}

export default DataService;