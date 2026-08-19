/**
 * 浏览层：配方画布的采集数据。
 *
 * `recipe_views` 现在还没有数据——exporter 的 RecipeViewSource 是 TODO（见 docs/design.md §3.1）。
 * 这里先把读取端写好：形状对不上就返回 null 让调用方降级，绝不因为采集缺口报错。
 * 期待的 layout_json 形状写在 docs/plans/browse-layer.md §4，采集端落地时对齐它。
 */

import type { Client } from '@libsql/client';

export type RecipeSlotRole = 'input' | 'output' | 'catalyst';

export interface RecipeViewSlot {
  role: RecipeSlotRole;
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RecipeViewLayout {
  typeId: string;
  width: number;
  height: number;
  slots: RecipeViewSlot[];
  /** 底板 PNG 是否存在，页面据此决定要不要请求 /recipe-bg */
  hasBackground: boolean;
  version: number | null;
}

const DEFAULT_SLOT_SIZE = 18;
const MAX_SLOTS = 256;

function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function readRole(value: unknown): RecipeSlotRole | null {
  return value === 'input' || value === 'output' || value === 'catalyst' ? value : null;
}

/** 容错解析：任何一处不符就整体作废，宁可降级也不画错位置 */
export function parseRecipeViewLayout(typeId: string, raw: string, version: number | null, hasBackground: boolean): RecipeViewLayout | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const width = finiteNumber(record.width);
  const height = finiteNumber(record.height);
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  if (!Array.isArray(record.slots) || record.slots.length === 0) return null;

  const slots: RecipeViewSlot[] = [];
  for (const entry of record.slots.slice(0, MAX_SLOTS)) {
    if (typeof entry !== 'object' || entry === null) return null;
    const slot = entry as Record<string, unknown>;
    const role = readRole(slot.role);
    const index = finiteNumber(slot.index);
    const x = finiteNumber(slot.x);
    const y = finiteNumber(slot.y);
    if (role === null || index === null || x === null || y === null) return null;
    slots.push({
      role,
      index: Math.floor(index),
      x,
      y,
      w: finiteNumber(slot.w) ?? DEFAULT_SLOT_SIZE,
      h: finiteNumber(slot.h) ?? DEFAULT_SLOT_SIZE,
    });
  }

  return { typeId, width, height, slots, hasBackground, version };
}

export async function loadRecipeView(client: Client, typeId: string): Promise<RecipeViewLayout | null> {
  let row: Record<string, unknown> | undefined;
  try {
    const result = await client.execute({
      sql: 'SELECT layout_json, version FROM recipe_views WHERE type_id = ?',
      args: [typeId],
    });
    row = result.rows[0] as unknown as Record<string, unknown> | undefined;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  if (!row || row.layout_json == null) return null;

  const hasBackground = await hasRecipeBackground(client, typeId);
  const version = row.version == null ? null : Number(row.version);
  return parseRecipeViewLayout(typeId, String(row.layout_json), version, hasBackground);
}

export async function hasRecipeBackground(client: Client, typeId: string): Promise<boolean> {
  try {
    const result = await client.execute({
      sql: 'SELECT 1 AS ok FROM recipe_view_backgrounds WHERE type_id = ?',
      args: [typeId],
    });
    return result.rows.length > 0;
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

/** 底板 PNG 字节；没有采集则 null */
export async function loadRecipeBackgroundPng(
  client: Client,
  typeId: string,
): Promise<{ bytes: Uint8Array; sha1: string } | null> {
  try {
    const result = await client.execute({
      sql: 'SELECT png, sha1 FROM recipe_view_backgrounds WHERE type_id = ?',
      args: [typeId],
    });
    const row = result.rows[0];
    if (!row || row.png == null) return null;
    const png = row.png;
    const bytes =
      png instanceof Uint8Array
        ? png
        : typeof png === 'string'
          ? Uint8Array.from(Buffer.from(png, 'base64'))
          : null;
    if (!bytes) return null;
    return { bytes, sha1: String(row.sha1 ?? '') };
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}
