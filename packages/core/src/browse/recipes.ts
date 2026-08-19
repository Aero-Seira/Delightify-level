/**
 * 浏览层：配方查询与画布数据。
 *
 * 同 items.ts：人用的过滤，不是 agent 检索管线。
 */

import type { Client } from '@libsql/client';
import {
  buildRecipeFilter,
  clampLimit,
  DEFAULT_LANG,
  DEFAULT_LIST_LIMIT,
  FALLBACK_LANG,
  MAX_LIST_LIMIT,
  pagination,
  truncationOf,
  type RecipeFilterInput,
  type Truncation,
} from './filters';
import { itemsWithIcons } from './icons';
import { readFacetPage, type FacetEntry } from './items';
import { loadRecipeView, type RecipeViewLayout } from './views';

export interface BrowseRecipe {
  recipeId: string;
  typeId: string;
  modid: string;
  unparsed: boolean;
  inputWidth: number | null;
  inputHeight: number | null;
  /** 主产物，列表里直接画图标用 */
  primaryOutput: string | null;
  primaryOutputCount: number;
  primaryHasIcon: boolean;
}

export interface BrowseRecipesResult {
  recipes: BrowseRecipe[];
  total: number;
  page: number;
  pageSize: number;
  truncated?: Truncation;
}

export interface BrowseRecipesParams extends RecipeFilterInput {
  page?: number | string;
  pageSize?: number | string;
}

export async function browseRecipes(
  client: Client,
  params: BrowseRecipesParams,
): Promise<BrowseRecipesResult> {
  const { page, pageSize, offset } = pagination(params.page, params.pageSize);
  const filter = buildRecipeFilter(params, 'recipes');

  const countResult = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM recipes ${filter.where}`,
    args: filter.args,
  });
  const total = Number(countResult.rows[0]?.n ?? 0);

  const result = await client.execute({
    sql: `
      SELECT recipes.recipe_id, recipes.type_id, recipes.modid, recipes.unparsed,
             recipes.input_width, recipes.input_height,
             (SELECT item_id FROM recipe_outputs
               WHERE recipe_id = recipes.recipe_id
               ORDER BY is_primary DESC, slot LIMIT 1) AS primary_output,
             (SELECT count FROM recipe_outputs
               WHERE recipe_id = recipes.recipe_id
               ORDER BY is_primary DESC, slot LIMIT 1) AS primary_count
      FROM recipes
      ${filter.where}
      ORDER BY recipes.recipe_id
      LIMIT ? OFFSET ?
    `,
    args: [...filter.args, pageSize, offset],
  });

  const outputIds = result.rows
    .map(row => (row.primary_output == null ? null : String(row.primary_output)))
    .filter((id): id is string => Boolean(id));
  const icons = await itemsWithIcons(client, outputIds);
  const recipes = result.rows.map(row => {
    const primaryOutput = row.primary_output == null ? null : String(row.primary_output);
    return {
      recipeId: String(row.recipe_id),
      typeId: String(row.type_id),
      modid: String(row.modid),
      unparsed: Boolean(row.unparsed),
      inputWidth: row.input_width == null ? null : Number(row.input_width),
      inputHeight: row.input_height == null ? null : Number(row.input_height),
      primaryOutput,
      primaryOutputCount: row.primary_count == null ? 1 : Number(row.primary_count),
      primaryHasIcon: primaryOutput ? icons.has(primaryOutput) : false,
    };
  });

  return {
    recipes,
    total,
    page,
    pageSize,
    truncated: truncationOf(recipes.length, total, 'page_size'),
  };
}

export interface RecipeFacets {
  mods: FacetEntry[];
  types: FacetEntry[];
  truncated?: { mods?: Truncation; types?: Truncation };
}

export async function browseRecipeFacets(
  client: Client,
  params: RecipeFilterInput & { limit?: number | string },
): Promise<RecipeFacets> {
  const limit = clampLimit(params.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const modFilter = buildRecipeFilter(params, 'recipes', 'mod');
  const typeFilter = buildRecipeFilter(params, 'recipes', 'type');

  const [modResult, typeResult] = await Promise.all([
    client.execute({
      sql: `SELECT value, n, COUNT(*) OVER () AS total_groups FROM (
              SELECT recipes.modid AS value, COUNT(*) AS n FROM recipes ${modFilter.where}
              GROUP BY recipes.modid
            ) ORDER BY n DESC, value LIMIT ?`,
      args: [...modFilter.args, limit],
    }),
    client.execute({
      sql: `SELECT value, n, COUNT(*) OVER () AS total_groups FROM (
              SELECT recipes.type_id AS value, COUNT(*) AS n FROM recipes ${typeFilter.where}
              GROUP BY recipes.type_id
            ) ORDER BY n DESC, value LIMIT ?`,
      args: [...typeFilter.args, limit],
    }),
  ]);

  const mods = readFacetPage(modResult.rows as unknown as Record<string, unknown>[]);
  const types = readFacetPage(typeResult.rows as unknown as Record<string, unknown>[]);

  const truncated: { mods?: Truncation; types?: Truncation } = {};
  const modTruncation = truncationOf(mods.entries.length, mods.total, 'facet_limit');
  const typeTruncation = truncationOf(types.entries.length, types.total, 'facet_limit');
  if (modTruncation) truncated.mods = modTruncation;
  if (typeTruncation) truncated.types = typeTruncation;

  return {
    mods: mods.entries,
    types: types.entries,
    truncated: truncated.mods || truncated.types ? truncated : undefined,
  };
}

export interface RecipeSlot {
  slot: number;
  role: string;
  kind: string;
  ref: string | null;
  count: number;
  displayName: string | null;
}

export interface RecipeOutputSlot {
  slot: number;
  itemId: string;
  count: number;
  isPrimary: boolean;
  displayName: string | null;
  componentsJson: string | null;
}

/** 画布用哪套布局。design.md §3.1 的降级顺序 */
export type RecipeLayoutSource = 'recipe_view' | 'shaped_grid' | 'slot_list';

export interface BrowseRecipeDetail {
  recipe: (BrowseRecipe & { rawJson: string | null; group: string | null }) | null;
  inputs: RecipeSlot[];
  outputs: RecipeOutputSlot[];
  layoutSource: RecipeLayoutSource;
  /** layoutSource === 'recipe_view' 时非 null */
  view: RecipeViewLayout | null;
  /** 采集缺口的人话说明，页面直接显示 */
  layoutNote: string;
}

export async function browseRecipeDetail(
  client: Client,
  recipeId: string,
  options: { lang?: string } = {},
): Promise<BrowseRecipeDetail> {
  const bare = recipeId.startsWith('recipe:') ? recipeId.slice('recipe:'.length) : recipeId;
  const lang = options.lang || DEFAULT_LANG;

  const recipeResult = await client.execute({
    sql: `SELECT recipe_id, type_id, modid, unparsed, input_width, input_height, raw_json, "group"
          FROM recipes WHERE recipe_id = ?`,
    args: [bare],
  });
  const row = recipeResult.rows[0];
  if (!row) {
    return {
      recipe: null,
      inputs: [],
      outputs: [],
      layoutSource: 'slot_list',
      view: null,
      layoutNote: '配方不存在',
    };
  }

  const [inputResult, outputResult] = await Promise.all([
    client.execute({
      sql: `
        SELECT ri.slot, ri.role, ri.kind, ri.ref, ri.count,
               COALESCE(tl.value, te.value) AS display_name
        FROM recipe_inputs ri
        LEFT JOIN items i ON ri.kind = 'item' AND i.item_id = ri.ref
        LEFT JOIN translations tl ON tl.key = i.translation_key AND tl.lang = ?
        LEFT JOIN translations te ON te.key = i.translation_key AND te.lang = ?
        WHERE ri.recipe_id = ?
        ORDER BY ri.slot, ri.role, ri.kind
      `,
      args: [lang, FALLBACK_LANG, bare],
    }),
    client.execute({
      sql: `
        SELECT ro.slot, ro.item_id, ro.count, ro.components_json, ro.is_primary,
               COALESCE(tl.value, te.value) AS display_name
        FROM recipe_outputs ro
        LEFT JOIN items i ON i.item_id = ro.item_id
        LEFT JOIN translations tl ON tl.key = i.translation_key AND tl.lang = ?
        LEFT JOIN translations te ON te.key = i.translation_key AND te.lang = ?
        WHERE ro.recipe_id = ?
        ORDER BY ro.is_primary DESC, ro.slot
      `,
      args: [lang, FALLBACK_LANG, bare],
    }),
  ]);

  const inputs: RecipeSlot[] = inputResult.rows.map(r => ({
    slot: Number(r.slot),
    role: String(r.role),
    kind: String(r.kind),
    ref: r.ref == null ? null : String(r.ref),
    count: Number(r.count ?? 1),
    displayName: r.display_name == null ? null : String(r.display_name),
  }));

  const outputs: RecipeOutputSlot[] = outputResult.rows.map(r => ({
    slot: Number(r.slot),
    itemId: String(r.item_id),
    count: Number(r.count ?? 1),
    isPrimary: Boolean(r.is_primary),
    displayName: r.display_name == null ? null : String(r.display_name),
    componentsJson: r.components_json == null ? null : String(r.components_json),
  }));

  const typeId = String(row.type_id);
  const inputWidth = row.input_width == null ? null : Number(row.input_width);
  const inputHeight = row.input_height == null ? null : Number(row.input_height);

  const view = await loadRecipeView(client, typeId);
  const { layoutSource, layoutNote } = decideLayout(view !== null, inputWidth, inputHeight);
  const outputIds = outputs.map(entry => entry.itemId);
  const icons = await itemsWithIcons(client, outputIds);

  return {
    recipe: {
      recipeId: String(row.recipe_id),
      typeId,
      modid: String(row.modid),
      unparsed: Boolean(row.unparsed),
      inputWidth,
      inputHeight,
      primaryOutput: outputs[0]?.itemId ?? null,
      primaryOutputCount: outputs[0]?.count ?? 1,
      primaryHasIcon: outputs[0] ? icons.has(outputs[0].itemId) : false,
      rawJson: row.raw_json == null ? null : String(row.raw_json),
      group: row.group == null ? null : String(row.group),
    },
    inputs,
    outputs,
    layoutSource,
    view,
    layoutNote,
  };
}

/** 纯函数，便于将来接测试 */
export function decideLayout(
  hasView: boolean,
  inputWidth: number | null,
  inputHeight: number | null,
): { layoutSource: RecipeLayoutSource; layoutNote: string } {
  if (hasView) {
    return { layoutSource: 'recipe_view', layoutNote: '布局来自游戏内采集的 recipe_views' };
  }
  if (inputWidth && inputHeight && inputWidth > 0 && inputHeight > 0) {
    return {
      layoutSource: 'shaped_grid',
      layoutNote: `无采集布局，按有序合成 ${inputWidth}×${inputHeight} 摆位`,
    };
  }
  return { layoutSource: 'slot_list', layoutNote: '无采集布局，降级为结构化槽位列表' };
}

export interface RecipeTypeEntry {
  typeId: string;
  recipeCount: number;
  /** 该类型是否有采集到的画布 */
  hasView: boolean;
}

export async function listRecipeTypes(
  client: Client,
  options: { search?: string; limit?: number | string } = {},
): Promise<{ types: RecipeTypeEntry[]; truncated?: Truncation }> {
  const limit = clampLimit(options.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const search = options.search?.trim();
  const where = search ? 'WHERE type_id LIKE ?' : '';
  const args = search ? [`%${search}%`] : [];

  const totalResult = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM (SELECT type_id FROM recipes ${where} GROUP BY type_id)`,
    args,
  });
  const total = Number(totalResult.rows[0]?.n ?? 0);

  const result = await client.execute({
    sql: `SELECT type_id, COUNT(*) AS n FROM recipes ${where}
          GROUP BY type_id ORDER BY n DESC, type_id LIMIT ?`,
    args: [...args, limit],
  });

  const viewed = await loadViewedTypes(client);
  const types = result.rows.map(row => ({
    typeId: String(row.type_id),
    recipeCount: Number(row.n),
    hasView: viewed.has(String(row.type_id)),
  }));

  return { types, truncated: truncationOf(types.length, total, 'list_limit') };
}

async function loadViewedTypes(client: Client): Promise<Set<string>> {
  try {
    const result = await client.execute('SELECT type_id FROM recipe_views');
    return new Set(result.rows.map(row => String(row.type_id)));
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return new Set();
    throw error;
  }
}
