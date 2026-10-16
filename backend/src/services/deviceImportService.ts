/**
 * 设备 Excel 批量导入（预览 → 确认 → 事务写入）
 *
 * 设计要点（对应本轮需求）：
 *   1. **不新建表**：直接复用现有 devices / sites / tenants；
 *      导入任务本身不落库（第一版无此必要），预校验结果以**签名令牌**回传，
 *      服务端不保存任何临时数据。
 *   2. **两段式**：preview 只解析+校验+返回预览（**不写数据库**）；
 *      confirm 校验令牌签名 → 再对数据库**重新校验一次** → 单事务写入。
 *      前端改不了任何东西：令牌签名 + confirm 的二次校验双保险。
 *   3. **全成功或全回滚**：confirm 在同一个事务里插入全部设备，
 *      任一行失败整体 ROLLBACK，绝不出现"100 台成功 97 台"的静默部分成功。
 *   4. 字段规则严格按本轮需求：网关ID 必填且唯一、站点可空、设备名称可空、
 *      普通租户不允许通过 Excel 指定其他租户、站点必须属于设备租户。
 */
import ExcelJS from 'exceljs';
import crypto from 'crypto';
import database from '../models/database';
import DeviceService from './deviceService';
import { normalizeGwId } from '../protocols/fsu/topics';
import { getJwtSecret } from '../utils/jwt';

// ============================================================
// 模板定义（字段顺序 = 模板列顺序 = 解析列顺序）
// ============================================================

/** 设备导入 Sheet 名 */
export const TEMPLATE_SHEET = '设备导入';
/** 填写说明 Sheet 名 */
export const GUIDE_SHEET = '填写说明';

/** 模板字段（key 为内部字段名，header 为 Excel 表头） */
export interface TemplateColumn {
  header: string;
  key: string;
  /** 是否必填（仅用于说明与文档；真正的必填校验在行校验里） */
  required: boolean;
  /** 填写说明 */
  guide: string;
  /** 示例 */
  example: string;
}

export const TEMPLATE_COLUMNS: TemplateColumn[] = [
  {
    header: '租户ID', key: 'tenantId', required: false,
    guide: '设备归属租户（如 T0001）。租户账号登录时**不必填写**，留空即使用当前登录租户；'
      + '填写其他租户会被拒绝。平台管理员填写时必须填写，留空表示"未分配"。',
    example: 'T0001（租户账号可留空）',
  },
  {
    header: '站点ID', key: 'siteId', required: false,
    guide: '设备归属站点。可留空 = 暂不绑定站点（设备显示"未分配"）。'
      + '可填站点编号（SITE-0001）或站点数字ID；填写时必须存在且属于该设备租户。',
    example: 'SITE-0001（或留空）',
  },
  {
    header: '设备名称', key: 'name', required: false,
    guide: '可留空。留空不视为导入失败，列表与详情显示"-"。最长 128 字符。',
    example: '台州电信-机房A网关',
  },
  {
    header: '网关ID', key: 'gwId', required: true,
    guide: '**必填**。厂家 FSU 网关的 MAC（gwId），冒号可带可不带，平台统一转为小写去冒号。'
      + '同一个 Excel 内不能重复，数据库中已有的也不能重复。',
    example: '00:53:4C:08:02:13 或 00534c080213',
  },
  {
    header: '设备SN', key: 'deviceSn', required: false,
    guide: '设备序列号，可留空。', example: 'SN20260901001',
  },
  {
    header: '厂商', key: 'manufacturer', required: false,
    guide: '设备厂商，可留空。', example: '华为',
  },
  {
    header: '设备型号', key: 'moduleType', required: false,
    guide: '设备/模块型号，可留空。', example: 'FSU-1000A',
  },
  {
    header: 'IMEI', key: 'imei', required: false,
    guide: '**请务必按文本填写**：IMEI 是 15 位数字，若单元格为数值格式，'
      + 'Excel 会显示成 1.23E+14 并可能丢失精度。本模板该列已预设为文本格式。',
    example: '860123456789012',
  },
  {
    header: 'ICCID', key: 'iccid', required: false,
    guide: '**请务必按文本填写**（同 IMEI，20 位数字易被转成科学计数法）。'
      + '本模板该列已预设为文本格式。', example: '89860012345678901234',
  },
  {
    header: '终端类型', key: 'terminalType', required: false,
    guide: '终端类型，可留空（自由文本，平台不限定取值）。', example: 'FSU',
  },
  {
    header: '协议类型', key: 'protocolType', required: false,
    guide: '可留空，留空按平台默认值 vendor（厂家 FSU 协议）处理。'
      + '平台不新增协议类型枚举。', example: 'vendor（留空即默认）',
  },
];

/** 协议类型默认值（与 handlers.login 落库值一致，不发明新枚举） */
export const DEFAULT_PROTOCOL_TYPE = 'vendor';

/**
 * 说明 Sheet 里"不允许导入"的系统维护字段
 * （属于平台自维护：主键、状态、时间戳、实时数据等）
 */
const FORBIDDEN_FIELDS = [
  'id / 设备ID（网关ID 即主键，由「网关ID」列提供）',
  'device_id',
  'created_at / updated_at',
  'latest_meters（实时快照）',
  'last_seen / last_heartbeat（上报与心跳时间）',
  'status / activationStatus / mqttConnected（在线状态，由 MQTT 连接与报文决定）',
  'mqttUsername / mqttPassword（平台统一账号，不按设备维护）',
];

// ============================================================
// 限制
// ============================================================

/** 上传文件大小上限（5MB） */
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
/** 单次导入行数上限 */
export const MAX_IMPORT_ROWS = 1000;
/** 预校验令牌有效期（30 分钟） */
export const IMPORT_TOKEN_TTL_MS = 30 * 60 * 1000;

/** 各字段长度上限（与现有表单/列语义一致，超限即报错而不是静默截断） */
const MAX_LEN: Record<string, number> = {
  name: 128,
  deviceSn: 64,
  manufacturer: 64,
  moduleType: 64,
  imei: 32,
  iccid: 32,
  terminalType: 64,
  protocolType: 32,
  tenantId: 64,
};

/** 网关ID 规范化后的格式：MAC 去冒号小写 = 6~64 位十六进制 */
const GW_ID_PATTERN = /^[0-9a-f]{6,64}$/;

/**
 * 是否形如科学计数法（1.23E+14 / 8.986E+19）
 *
 * 用于识别"长数字被 Excel 当成数值处理"的典型症状：
 * 单元格若不是文本格式，15 位以上的数字会显示/保存成科学计数法。
 * 这时值已经失真（IEEE754 双精度只有 15~16 位有效数字），
 * 必须**明确报错**让用户改格式重填，而不是把一个错的 IMEI/ICCID 导进去。
 */
const SCIENTIFIC_PATTERN = /^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/;

// ============================================================
// 类型
// ============================================================

/** 解析后的一行（字段已 trim / 规范化） */
export interface ParsedRow {
  /** Excel 中的行号（含表头，第 1 行为表头） */
  row: number;
  tenantId: string;
  siteId: string;
  name: string;
  gwId: string;
  deviceSn: string;
  manufacturer: string;
  moduleType: string;
  imei: string;
  iccid: string;
  terminalType: string;
  protocolType: string;
}

/**
 * 一行通过校验后的**最终写入值**
 * 租户与站点都是服务端查库确认过的结果，不是 Excel 里填的原始文本。
 */
export interface ResolvedDevice {
  /** 网关ID（已规范化：去冒号 + 小写），同时是 devices.id */
  id: string;
  tenantId: string | null;
  tenantName: string | null;
  siteId: number | null;
  siteCode: string | null;
  siteName: string | null;
  name: string | null;
  deviceSn: string | null;
  manufacturer: string | null;
  moduleType: string | null;
  imei: string | null;
  iccid: string | null;
  terminalType: string | null;
  protocolType: string;
}

/** 预览结果中的一行 */
export interface PreviewRow {
  row: number;
  status: 'valid' | 'invalid';
  /** status=valid 时的规范化数据（含服务端最终确定的租户/站点） */
  data?: ResolvedDevice;
  /** status=invalid 时的错误原因（可多条） */
  errors?: string[];
}

export interface ImportPreviewResult {
  total: number;
  valid: number;
  invalid: number;
  /** 本次导入最终使用的租户（普通租户=登录租户；平台管理员=null 表示按行取值） */
  scopeTenantId: string | null;
  /** 被忽略的未知列（存在时提示用户，但不阻断导入） */
  ignoredColumns: string[];
  rows: PreviewRow[];
  /** 校验通过时返回的签名令牌，confirm 时原样回传；全部无效时为 null */
  token: string | null;
}

/** 确认导入结果 */
export interface ImportConfirmResult {
  imported: number;
  /** 导入的设备ID（网关ID）列表），便于前端提示与核对 */
  deviceIds: string[];
}

/** 导入业务异常（消息面向使用者） */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

// ============================================================
// Excel 解析
// ============================================================

/**
 * 读取单元格文本
 *
 * 目标：**长数字（IMEI/ICCID/网关ID）绝不被转成科学计数法**。
 *   - 数值单元格：整数用 toFixed(0) 输出（避免 1e21 以上出现指数写法），
 *     非整数用 String()（非法内容会在行校验里被挡下）
 *   - 公式单元格：取其计算结果
 *   - 富文本 / 超链接：拼接其文本
 *   - 日期：按 ISO 字符串（本模板无日期列，仅为防御）
 */
function readCellText(cell: ExcelJS.Cell): string {
  const v: any = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? v.toFixed(0) : String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('result' in v && v.result !== undefined && v.result !== null) {
      return typeof v.result === 'number' && Number.isInteger(v.result)
        ? v.result.toFixed(0)
        : String(v.result);
    }
    if (Array.isArray(v.richText)) {
      return v.richText.map((t: any) => String(t?.text ?? '')).join('');
    }
    if (typeof v.text === 'string') return v.text;
    if (typeof v.hyperlink === 'string') return v.hyperlink;
  }
  return String(v);
}

/** 规范化单元格文本：去首尾空格 + 去零宽字符 */
function clean(raw: string): string {
  return raw.replace(/[​-‍﻿]/g, '').trim();
}

/**
 * 解析工作簿为「行号 → 字段」列表
 *
 * - 空行（所有模板字段均为空）直接跳过，不计入 total
 * - 表头必须包含全部模板字段（顺序无关）；缺失即拒绝（防止用错模板导致列错位）
 * - 未知列忽略，但在结果里列出提示
 */
export async function parseWorkbook(buffer: Buffer): Promise<{
  rows: ParsedRow[];
  ignoredColumns: string[];
}> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as any);
  } catch (err: any) {
    throw new ImportError(`Excel 文件无法解析（请确认是 .xlsx 文件且未损坏）：${err?.message || err}`);
  }

  // 优先取名为「设备导入」的 Sheet；没有则退回第一个 Sheet（表头校验仍会兜底）
  const ws = wb.getWorksheet(TEMPLATE_SHEET) ?? wb.worksheets[0];
  if (!ws) {
    throw new ImportError('Excel 中没有任何工作表，请使用平台提供的模板');
  }

  // === 表头解析：header 文本 → 列号 ===
  const headerRow = ws.getRow(1);
  const headerToCol = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = clean(readCellText(cell));
    if (text && !headerToCol.has(text)) headerToCol.set(text, colNumber);
  });

  const missing = TEMPLATE_COLUMNS.filter((c) => !headerToCol.has(c.header)).map((c) => c.header);
  if (missing.length > 0) {
    throw new ImportError(
      `Excel 表头与模板不一致，缺少字段：${missing.join('、')}。请下载最新模板后重新填写。`
    );
  }

  const knownHeaders = new Set(TEMPLATE_COLUMNS.map((c) => c.header));
  const ignoredColumns = Array.from(headerToCol.keys()).filter((h) => !knownHeaders.has(h));

  // === 数据行解析 ===
  const rows: ParsedRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const record: Record<string, string> = {};
    for (const col of TEMPLATE_COLUMNS) {
      const colNumber = headerToCol.get(col.header)!;
      record[col.key] = clean(readCellText(row.getCell(colNumber)));
    }
    // 空行跳过：所有模板字段均为空
    if (TEMPLATE_COLUMNS.every((c) => record[c.key] === '')) continue;

    if (rows.length >= MAX_IMPORT_ROWS) {
      throw new ImportError(
        `单次最多导入 ${MAX_IMPORT_ROWS} 行，当前文件已超出。请拆分后分批导入。`
      );
    }
    rows.push({ row: r, ...(record as unknown as Omit<ParsedRow, 'row'>) });
  }

  return { rows, ignoredColumns };
}

// ============================================================
// 预校验
// ============================================================

/** 站点查询结果 */
interface SiteLookup {
  id: number;
  code: string;
  name: string;
  tenant_id: string | null;
}

/**
 * 按「站点ID」列的值查站点：纯数字按 sites.id，其它按 sites.code（不区分大小写）
 * @returns 站点；不存在返回 null
 */
async function lookupSite(raw: string): Promise<SiteLookup | null> {
  const value = raw.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const byId = await database.get(
      'SELECT id, code, name, tenant_id FROM sites WHERE id = ?', [Number(value)]
    );
    if (byId) return byId as SiteLookup;
    return null;
  }
  const byCode = await database.get(
    'SELECT id, code, name, tenant_id FROM sites WHERE UPPER(code) = UPPER(?)', [value]
  );
  return (byCode as SiteLookup) || null;
}

/** 行校验上下文（预校验与 confirm 二次校验共用同一套规则） */
export interface ValidateContext {
  /** 登录租户：非 null = 普通租户账号（强制本租户）；null = 平台管理员 */
  loginTenantId: string | null;
}

/**
 * 校验单行并给出「最终写入值」
 *
 * 预校验（preview）与最终校验（confirm）**调用同一个函数**，
 * 保证"预览时说能导"和"确认时真能导"用的是同一套规则（不会出现规则漂移）。
 *
 * @returns ok=true 时 value 为最终写入值；ok=false 时 errors 为错误原因
 */
export async function validateRow(
  row: ParsedRow,
  ctx: ValidateContext,
  /** 同一 Excel 内已出现过的网关ID（规范化后）→ 首次出现的行号 */
  seenGwIds: Map<string, number>,
): Promise<{ ok: true; value: ResolvedDevice } | { ok: false; errors: string[] }> {
  const errors: string[] = [];

  // === 1. 网关ID（必填 + 格式 + Excel 内唯一 + 数据库唯一）===
  const rawGwId = row.gwId;
  let gwId = '';
  if (!rawGwId) {
    errors.push('网关ID不能为空');
  } else {
    gwId = normalizeGwId(rawGwId) ?? '';
    if (!gwId || !GW_ID_PATTERN.test(gwId)) {
      errors.push(
        `网关ID格式不合法：${rawGwId}（应为厂家网关 MAC，去掉冒号小写后为 6~64 位十六进制字符）`
      );
      gwId = '';
    }
  }
  if (gwId) {
    const firstRow = seenGwIds.get(gwId);
    if (firstRow !== undefined) {
      errors.push(`网关ID ${gwId} 在本次 Excel 中重复（第 ${firstRow} 行已出现）`);
    } else {
      seenGwIds.set(gwId, row.row);
      const existing = await database.get('SELECT id FROM devices WHERE id = ?', [gwId]);
      if (existing) errors.push(`网关ID ${gwId} 已存在`);
    }
  }

  // === 2. 租户（服务端最终裁定，绝不相信 Excel 里填的 tenantId）===
  let tenantId: string | null = null;
  let tenantName: string | null = null;
  const excelTenant = row.tenantId.trim();

  if (ctx.loginTenantId) {
    // 普通租户账号：强制使用登录租户。
    // Excel 里填了**别的**租户 → 直接判错（不静默改写，让用户明确知道被拒的原因）
    if (excelTenant && excelTenant !== ctx.loginTenantId) {
      errors.push(
        `无权为其他租户导入设备（第 ${row.row} 行填写租户 ${excelTenant}，当前账号租户为 ${ctx.loginTenantId}）`
      );
    }
    tenantId = ctx.loginTenantId;
  } else if (excelTenant) {
    // 平台管理员：填了租户就必须真实存在
    const tenant = await database.get('SELECT id, name FROM tenants WHERE id = ?', [excelTenant]);
    if (!tenant) {
      errors.push(`租户 ${excelTenant} 不存在`);
    } else {
      tenantId = String(tenant.id);
      tenantName = String(tenant.name);
    }
  }
  // 平台管理员未填写 → tenantId 保持 null（未分配，仅平台可见）

  // 补租户名（普通租户分支也要，用于预览展示）
  if (tenantId && !tenantName) {
    const t = await database.get('SELECT name FROM tenants WHERE id = ?', [tenantId]);
    tenantName = t ? String(t.name) : null;
  }

  // === 3. 站点（可空；有值必须存在且属于设备租户）===
  let siteId: number | null = null;
  let siteCode: string | null = null;
  let siteName: string | null = null;
  const rawSite = row.siteId.trim();
  if (rawSite) {
    const site = await lookupSite(rawSite);
    if (!site) {
      errors.push(`站点 ${rawSite} 不存在`);
    } else if ((site.tenant_id ?? null) !== tenantId) {
      // 站点与设备不属于同一租户：拒绝（不允许把设备绑到别的租户的站点）
      errors.push(
        `站点 ${site.code} 不属于租户 ${tenantId ?? '（未分配）'}`
      );
    } else {
      siteId = site.id;
      siteCode = site.code;
      siteName = site.name;
    }
  }

  // === 4. 长度限制 / 文本规范化 ===
  const fields: Record<string, string> = {
    name: row.name, deviceSn: row.deviceSn, manufacturer: row.manufacturer,
    moduleType: row.moduleType, imei: row.imei, iccid: row.iccid,
    terminalType: row.terminalType, protocolType: row.protocolType,
  };
  for (const [key, value] of Object.entries(fields)) {
    const max = MAX_LEN[key];
    if (max && value.length > max) {
      errors.push(`${TEMPLATE_COLUMNS.find((c) => c.key === key)?.header ?? key} 超过 ${max} 个字符`);
    }
  }

  // === 5. 长数字字段（IMEI / ICCID）必须按文本填写 ===
  // 单元格为数值格式时 Excel 会把它写成科学计数法，此时数值已经失真
  // （双精度只有 15~16 位有效数字，20 位 ICCID 必然丢精度）。
  // 这类行**拒绝导入**并给出可执行的修复指引，绝不把一个错的串号写进设备档案。
  for (const key of ['imei', 'iccid'] as const) {
    const value = row[key];
    if (value && SCIENTIFIC_PATTERN.test(value)) {
      const header = TEMPLATE_COLUMNS.find((c) => c.key === key)?.header ?? key;
      errors.push(
        `${header} 被 Excel 转换成了科学计数法（${value}），长数字已丢失精度。`
        + `请把该列单元格格式设为"文本"后重新填写，或使用平台模板（该列已预设文本格式）。`
      );
    }
  }

  // 协议类型：留空 = 平台默认 vendor（不发明新枚举，也不因留空报错）
  const protocolType = row.protocolType.trim() || DEFAULT_PROTOCOL_TYPE;

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      id: gwId,
      tenantId,
      tenantName,
      siteId,
      siteCode,
      siteName,
      name: row.name || null,
      deviceSn: row.deviceSn || null,
      manufacturer: row.manufacturer || null,
      moduleType: row.moduleType || null,
      imei: row.imei || null,
      iccid: row.iccid || null,
      terminalType: row.terminalType || null,
      protocolType,
    },
  };
}

/**
 * 预校验整个工作簿（**不写数据库**）
 */
export async function previewImport(
  buffer: Buffer,
  ctx: ValidateContext,
): Promise<ImportPreviewResult> {
  const { rows, ignoredColumns } = await parseWorkbook(buffer);

  const seenGwIds = new Map<string, number>();
  const previewRows: PreviewRow[] = [];
  const validRows: ParsedRow[] = [];

  for (const row of rows) {
    const result = await validateRow(row, ctx, seenGwIds);
    if (result.ok) {
      previewRows.push({ row: row.row, status: 'valid', data: result.value });
      validRows.push(row);
    } else {
      previewRows.push({ row: row.row, status: 'invalid', errors: result.errors });
    }
  }

  const valid = validRows.length;
  const invalid = previewRows.length - valid;

  return {
    total: previewRows.length,
    valid,
    invalid,
    scopeTenantId: ctx.loginTenantId,
    ignoredColumns,
    rows: previewRows,
    // 保守模式：只要存在无效行就**不发令牌**（confirm 必须整批确认，不支持"只导入有效行"）。
    // 没有令牌，前端就无法调 confirm；令牌里同时带上 invalid 计数，
    // confirm 再兜一道（防止有人自行构造令牌绕过前端）。
    token: valid > 0 && invalid === 0
      ? signImportToken(validRows, ctx.loginTenantId, Date.now(), invalid)
      : null,
  };
}

// ============================================================
// 预校验令牌（签名，防前端篡改）
// ============================================================

interface ImportTokenPayload {
  /** 版本 */
  v: 1;
  /** 过期时间（毫秒） */
  exp: number;
  /** 登录租户（签发时快照，仅供排查；confirm 时一律以**当前登录态**为准） */
  scopeTenantId: string | null;
  /**
   * 通过预校验的**原始行**（Excel 里填的原始值，不是解析后的写入值）
   *
   * 存原始值而不是写入值，是为了让 confirm 能用同一套 validateRow
   * 从头再校验一遍（租户/站点/唯一性全部重新对数据库核实）。
   * 令牌带 HMAC 签名，前端改不了其中任何一个字段。
   */
  rows: ParsedRow[];
  /** 预校验时**未通过**的行数（保守模式：>0 时 confirm 直接拒绝） */
  invalidRows: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(data: string): string {
  // 惰性取值：生产环境缺少 JWT_SECRET 时会在这里直接抛错，
  // 而不是用一把公开的默认密钥签出一个"看起来正常"的令牌。
  return b64url(crypto.createHmac('sha256', getJwtSecret()).update(data).digest());
}

/** 生成预校验令牌（便于测试注入时间） */
export function signImportToken(
  rows: ParsedRow[],
  scopeTenantId: string | null = null,
  now: number = Date.now(),
  invalidRows: number = 0,
): string {
  const payload: ImportTokenPayload = {
    v: 1, exp: now + IMPORT_TOKEN_TTL_MS, scopeTenantId, rows, invalidRows,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${sign(body)}`;
}

/**
 * 校验并解出预校验令牌
 * @throws ImportError 签名不符 / 过期 / 结构损坏
 */
export function verifyImportToken(token: unknown): ImportTokenPayload {
  if (typeof token !== 'string' || !token.includes('.')) {
    throw new ImportError('导入令牌无效，请重新上传 Excel 进行预校验');
  }
  const [body, mac] = token.split('.');
  const expected = sign(body);
  // 定长比较，避免时序侧信道
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ImportError('导入令牌校验失败（内容可能已被修改），请重新上传 Excel');
  }
  let payload: ImportTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    throw new ImportError('导入令牌内容损坏，请重新上传 Excel');
  }
  if (payload?.v !== 1 || !Array.isArray(payload.rows)) {
    throw new ImportError('导入令牌版本不支持，请重新上传 Excel');
  }
  if (!Number.isFinite(payload.exp) || payload.exp < Date.now()) {
    throw new ImportError('预校验结果已过期（超过 30 分钟），请重新上传 Excel');
  }
  return payload;
}

// ============================================================
// 确认导入（事务写入）
// ============================================================

/**
 * 确认导入：对令牌内的设备**逐行重新校验**后在**单个事务**内写入
 *
 * 为什么还要重新校验：令牌只能证明"数据没被前端改过"，
 * 但预校验之后数据库可能已经变了（租户被删、站点被删、网关ID 被别人建了）。
 * 因此最终权限与唯一性一律以**当前数据库 + 当前登录态**为准。
 *
 * @throws ImportError 令牌无效 / 任一行不再合法（**不写任何数据**）
 */
export async function confirmImport(
  token: unknown,
  ctx: ValidateContext,
): Promise<ImportConfirmResult> {
  const payload = verifyImportToken(token);

  // 保守模式（本轮确定的业务口径）：Excel 中存在任何无效行时**不做部分导入**，
  // 必须整批修正后重新上传。前端不会给出"确认导入"入口，这里再兜一道，
  // 防止绕过前端直接调接口造成"悄悄只导入了一部分"。
  if (Number(payload.invalidRows) > 0) {
    throw new ImportError(
      `本次预校验存在 ${payload.invalidRows} 行错误，不能整批确认。` +
      `请修改 Excel 后重新上传（本轮不支持只导入有效行）。`
    );
  }

  // 用**当前登录租户**做校验（登录态才是权威，令牌里快照的租户仅作排查参考）：
  // 平台管理员传 null → 按行校验租户存在性；租户账号 → 强制本租户。
  const effectiveCtx: ValidateContext = { loginTenantId: ctx.loginTenantId };

  const seenGwIds = new Map<string, number>();
  const accepted: ResolvedDevice[] = [];
  const errors: string[] = [];

  for (const parsed of payload.rows) {
    const rowNo = Number(parsed?.row) || 0;
    const result = await validateRow(parsed, effectiveCtx, seenGwIds);
    if (result.ok) accepted.push(result.value);
    else errors.push(`第 ${rowNo} 行：${result.errors!.join('；')}`);
  }

  if (errors.length > 0) {
    throw new ImportError(
      `以下数据在确认时已不再满足导入条件，本次未导入任何设备：\n${errors.slice(0, 20).join('\n')}`
      + (errors.length > 20 ? `\n… 另有 ${errors.length - 20} 条` : '')
    );
  }
  if (accepted.length === 0) {
    throw new ImportError('没有可导入的设备');
  }

  // === 单事务写入：全部成功才 COMMIT，任一行失败整体 ROLLBACK ===
  const importedIds: string[] = [];
  await database.run('BEGIN TRANSACTION');
  try {
    for (const d of accepted) {
      // 复用既有创建逻辑（含 MQTT 遗留凭据生成、默认离线/未激活状态），
      // 再补导入独有的字段 —— 不另写一套设备创建逻辑。
      await DeviceService.createDevice(
        d.id, '', d.name ?? undefined, d.imei ?? undefined, d.iccid ?? undefined,
        d.manufacturer ?? undefined, d.terminalType ?? undefined, undefined, undefined,
        d.tenantId,
      );

      await database.run(
        `UPDATE devices
            SET site_id = ?, device_sn = ?, moduleType = ?, protocol_type = ?
          WHERE id = ?`,
        [d.siteId, d.deviceSn, d.moduleType, d.protocolType, d.id]
      );
      importedIds.push(d.id);
    }
    await database.run('COMMIT');
  } catch (err: any) {
    await database.run('ROLLBACK').catch(() => undefined);
    console.error('[设备导入] 写入失败，已回滚全部行:', err);
    throw new ImportError(
      `导入失败，本次未写入任何设备（已回滚）：${err?.message || err}`
    );
  }

  console.log(
    `[设备导入] 成功导入 ${importedIds.length} 台设备` +
    (ctx.loginTenantId ? `（租户 ${ctx.loginTenantId}）` : '（平台管理员）')
  );
  return { imported: importedIds.length, deviceIds: importedIds };
}

// ============================================================
// 模板生成
// ============================================================

/**
 * 生成 Excel 模板（两个 Sheet：设备导入 + 填写说明）
 *
 * 关键：数据列的 numFmt 设为文本 '@'，这样用户在 IMEI/ICCID/网关ID 列
 * 直接输入或粘贴长数字时不会被 Excel 转成科学计数法。
 * 模板**不放示例数据行**，避免用户忘记删除而被当成真实设备导入。
 */
export async function buildTemplateWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FSU设备监控平台';
  wb.created = new Date(0);   // 固定时间，保证模板内容可复现

  // ---------- Sheet 1: 设备导入 ----------
  const ws = wb.addWorksheet(TEMPLATE_SHEET);
  ws.columns = TEMPLATE_COLUMNS.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.key === 'gwId' || c.key === 'imei' || c.key === 'iccid' ? 26 : 18,
    style: { numFmt: '@' },   // 文本格式：长数字不被转科学计数法
  }));

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height = 22;
  headerRow.eachCell((cell, colNumber) => {
    const col = TEMPLATE_COLUMNS[colNumber - 1];
    if (!col) return;
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: col.required ? 'FFFFF1F0' : 'FFF5F5F5' },   // 必填列淡红底
    };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } } };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: TEMPLATE_COLUMNS.length } };

  // ---------- Sheet 2: 填写说明 ----------
  const guide = wb.addWorksheet(GUIDE_SHEET);
  guide.columns = [
    { header: '字段', key: 'field', width: 14 },
    { header: '是否必填', key: 'required', width: 12 },
    { header: '说明', key: 'desc', width: 90, style: { numFmt: '@' } },
    { header: '示例', key: 'example', width: 34, style: { numFmt: '@' } },
  ];
  const guideHeader = guide.getRow(1);
  guideHeader.font = { bold: true };
  guideHeader.height = 20;
  guideHeader.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
  });

  for (const col of TEMPLATE_COLUMNS) {
    const row = guide.addRow({
      field: col.header,
      required: col.required ? '必填' : '非必填',
      desc: col.guide,
      example: col.example,
    });
    row.alignment = { vertical: 'top', wrapText: true };
  }

  // 通用说明
  const notes: [string, string, string][] = [
    ['通用', '—', '本模板只导入**设备基础档案**，不导入任何实时数据/历史数据/告警。'],
    ['通用', '—', '表头请勿修改、删除或调整顺序；多余的列会被忽略（并在预览中提示）。'],
    ['通用', '—', '空行会被自动跳过；所有字段首尾空格会被去除。'],
    ['通用', '—', '一个设备最多属于一个站点；站点ID 留空表示设备暂不绑定站点。'],
    ['通用', '—', '租户账号登录时不需要填写「租户ID」，服务端一律使用当前登录租户；'
      + '填写其他租户会被拒绝（不允许越权导入）。'],
    ['通用', '—', '「网关ID」填写厂家网关 MAC 即可，冒号可带可不带（平台统一去冒号转小写）。'],
    ['通用', '—', '为什么 IMEI/ICCID 必须按文本：二者都是十几到二十位的纯数字，'
      + 'Excel 默认按数值处理，超过 15 位会丢失精度并在显示时变成 1.23E+14。'
      + '本模板的对应列已预设为文本格式（单元格格式 = 文本），直接填写即可；'
      + '若从别处粘贴，请使用「选择性粘贴 → 文本」。'],
    ['通用', '—', `不允许导入系统维护字段：${FORBIDDEN_FIELDS.join('；')}。`],
    ['通用', '—', '导入流程：上传 → 预校验预览 → 确认导入。确认后在一个事务内写入，'
      + '任一行失败则全部回滚（不会出现部分成功）。'],
  ];
  for (const [field, required, desc] of notes) {
    const row = guide.addRow({ field, required, desc, example: '' });
    row.alignment = { vertical: 'top', wrapText: true };
  }
  guide.views = [{ state: 'frozen', ySplit: 1 }];

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
