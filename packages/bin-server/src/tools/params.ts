// 模型传来的参数是 unknown，统一在这里收窄，避免每个工具里散落类型判断

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

export function asOptionalString(value: unknown): string | undefined {
  const text = asString(value);
  return text || undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** 模型有时把布尔值写成字符串，这里统一收窄 */
export function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.trim().toLowerCase());
  return false;
}

/** 取对象数组，过滤掉非对象项 */
export function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  );
}

/** 解析日期：接受毫秒时间戳或 ISO 字符串 */
export function parseDate(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value.trim());
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

/** 把任意值转成适合放进卡片的展示字符串 */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}