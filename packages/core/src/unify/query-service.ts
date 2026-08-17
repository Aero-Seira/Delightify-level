import type { Client } from '@libsql/client';
import * as path from 'path';
import { createProjectDbClient } from '../database';

type DbRow = Record<string, unknown>;

export interface UnifyQueryParams {
  query: string;
  lang?: string;
  limit?: number;
}

export interface ProjectCapabilities {
  browse: boolean;
  mvp0Unify: boolean;
  reason?: string;
}

export type UnifyMatchReason = 'display_name' | 'item_id_path' | 'tag';

export interface UnifyCandidateMatch {
  reason: UnifyMatchReason;
  value: string;
}

export interface UnifyItemFacts {
  itemId: string;
  modid: string;
  displayName?: string;
  translationKey?: string;
  tags: string[];
  isBlock: boolean;
  maxStack: number;
  maxDamage: number;
  isDamageable: boolean;
  isFireResistant: boolean;
  rarity?: string;
  enchantValue?: number;
  foodNutrition?: number;
  foodSaturation?: number;
  foodAlwaysEat?: boolean;
  defaultComponentsJson?: string;
}

export type UnifyReferenceKind = 'direct_input' | 'tag_input' | 'output' | 'raw_unparsed';

export interface UnifyRecipeReference {
  kind: UnifyReferenceKind;
  recipeId: string;
  typeId: string;
  modid: string;
  unparsed: boolean;
  slot?: number;
  role?: string;
  ref?: string;
  tagId?: string;
  count?: number;
  componentsJson?: string;
}

export interface UnifyCandidateReferences {
  directInputs: UnifyRecipeReference[];
  tagInputs: UnifyRecipeReference[];
  outputs: UnifyRecipeReference[];
  unparsedRaw: UnifyRecipeReference[];
}

export type UnifyRiskSeverity = 'info' | 'low' | 'medium' | 'high';

export interface UnifyRiskSignal {
  code: string;
  severity: UnifyRiskSeverity;
  message: string;
  data?: Record<string, unknown>;
}

export interface UnifyCandidate {
  item: UnifyItemFacts;
  matchedBy: UnifyCandidateMatch[];
  references: UnifyCandidateReferences;
  riskSignals: UnifyRiskSignal[];
  riskLevel: UnifyRiskSeverity;
}

export interface UnifyQueryResult {
  query: string;
  normalizedQuery: string;
  lang: string;
  sourceKind: 'exporter_v1';
  capabilities: ProjectCapabilities;
  candidates: UnifyCandidate[];
  generatedAt: string;
}

interface DataSourceStatus {
  sourceKind: string;
  capabilities: ProjectCapabilities;
}

interface CandidateDraft {
  item: UnifyItemFacts;
  matchedBy: UnifyCandidateMatch[];
}

export class UnifyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnifyUnavailableError';
  }
}

function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s_\-:：/\\[\](){}]+/g, '');
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const text = String(value);
  return text.length > 0 ? text : undefined;
}

function numberOrDefault(value: unknown, defaultValue: number): number {
  if (value === null || value === undefined || value === '') {
    return defaultValue;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : defaultValue;
}

function booleanFromDb(value: unknown): boolean {
  return String(value) === '1' || String(value).toLowerCase() === 'true';
}

function parseCapabilities(value: unknown): ProjectCapabilities {
  if (typeof value !== 'string') {
    return {
      browse: true,
      mvp0Unify: false,
      reason: 'missing_capabilities',
    };
  }

  try {
    const parsed = JSON.parse(value) as {
      browse?: unknown;
      mvp0Unify?: unknown;
      mvp0_unify?: unknown;
      reason?: unknown;
    };

    return {
      browse: Boolean(parsed.browse),
      mvp0Unify: Boolean(parsed.mvp0Unify ?? parsed.mvp0_unify),
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    };
  } catch {
    return {
      browse: true,
      mvp0Unify: false,
      reason: 'invalid_capabilities_json',
    };
  }
}

function itemPath(itemId: string): string {
  const separatorIndex = itemId.indexOf(':');
  return separatorIndex >= 0 ? itemId.slice(separatorIndex + 1) : itemId;
}

function itemFromRow(row: DbRow): UnifyItemFacts {
  return {
    itemId: String(row.item_id),
    modid: String(row.modid),
    displayName: optionalString(row.display_name),
    translationKey: optionalString(row.translation_key),
    tags: [],
    isBlock: booleanFromDb(row.is_block),
    maxStack: numberOrDefault(row.max_stack, 64),
    maxDamage: numberOrDefault(row.max_damage, 0),
    isDamageable: booleanFromDb(row.is_damageable),
    isFireResistant: booleanFromDb(row.is_fire_resistant),
    rarity: optionalString(row.rarity),
    enchantValue: optionalString(row.enchant_value) ? numberOrDefault(row.enchant_value, 0) : undefined,
    foodNutrition: optionalString(row.food_nutrition) ? numberOrDefault(row.food_nutrition, 0) : undefined,
    foodSaturation: optionalString(row.food_saturation) ? numberOrDefault(row.food_saturation, 0) : undefined,
    foodAlwaysEat: optionalString(row.food_always_eat) ? booleanFromDb(row.food_always_eat) : undefined,
    defaultComponentsJson: optionalString(row.default_components_json),
  };
}

function addMatch(candidate: CandidateDraft, match: UnifyCandidateMatch): void {
  const exists = candidate.matchedBy.some(
    existing => existing.reason === match.reason && existing.value === match.value
  );
  if (!exists) {
    candidate.matchedBy.push(match);
  }
}

function mergeCandidate(
  candidates: Map<string, CandidateDraft>,
  row: DbRow,
  match: UnifyCandidateMatch
): void {
  const itemId = String(row.item_id);
  const existing = candidates.get(itemId);
  if (existing) {
    addMatch(existing, match);
    return;
  }

  candidates.set(itemId, {
    item: itemFromRow(row),
    matchedBy: [match],
  });
}

function severityRank(severity: UnifyRiskSeverity): number {
  switch (severity) {
    case 'high':
      return 4;
    case 'medium':
      return 3;
    case 'low':
      return 2;
    case 'info':
    default:
      return 1;
  }
}

function maxRiskLevel(signals: UnifyRiskSignal[]): UnifyRiskSeverity {
  if (signals.length === 0) {
    return 'low';
  }
  return signals.reduce<UnifyRiskSeverity>((max, signal) => (
    severityRank(signal.severity) > severityRank(max) ? signal.severity : max
  ), 'info');
}

function toLocaleTag(lang: string): string {
  return lang.replace('_', '-');
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

async function getDataSourceStatus(client: Client): Promise<DataSourceStatus> {
  const result = await client.execute(`
    SELECT source_kind, capabilities_json
    FROM data_imports
    WHERE is_success = 1
    ORDER BY imported_at DESC
    LIMIT 1
  `);

  const row = result.rows[0] as DbRow | undefined;
  if (!row) {
    throw new UnifyUnavailableError('当前项目尚未导入可用于 unify 的数据。请先导入 Exporter v1 数据。');
  }

  const sourceKind = String(row.source_kind || '');
  const capabilities = parseCapabilities(row.capabilities_json);
  if (sourceKind !== 'exporter_v1' || !capabilities.mvp0Unify) {
    const reason = capabilities.reason || 'current_data_source_is_browse_only';
    throw new UnifyUnavailableError(`当前项目数据不支持 MVP-0 unify：${reason}`);
  }

  return { sourceKind, capabilities };
}

async function readBaseItemRows(client: Client, lang: string): Promise<DbRow[]> {
  const result = await client.execute({
    sql: `
      SELECT
        i.*,
        t.value AS display_name
      FROM items i
      LEFT JOIN translations t
        ON t.key = i.translation_key AND t.lang = ?
      ORDER BY i.item_id
    `,
    args: [lang],
  });
  return result.rows as DbRow[];
}

async function addTagCandidates(
  client: Client,
  candidates: Map<string, CandidateDraft>,
  query: string,
  lang: string
): Promise<void> {
  const tagQuery = query.startsWith('#') ? query.slice(1) : query;
  if (!tagQuery.includes(':') && !tagQuery.includes('/')) {
    return;
  }

  const result = await client.execute({
    sql: `
      SELECT
        i.*,
        t.value AS display_name,
        it.tag_id AS matched_tag_id
      FROM item_tags it
      JOIN items i ON i.item_id = it.item_id
      LEFT JOIN translations t
        ON t.key = i.translation_key AND t.lang = ?
      WHERE it.tag_id = ? OR it.tag_id LIKE ?
      ORDER BY i.item_id
    `,
    args: [lang, tagQuery, `%${tagQuery}%`],
  });

  for (const row of result.rows as DbRow[]) {
    mergeCandidate(candidates, row, {
      reason: 'tag',
      value: String(row.matched_tag_id),
    });
  }
}

async function attachTags(client: Client, candidates: CandidateDraft[]): Promise<void> {
  if (candidates.length === 0) {
    return;
  }

  const itemIds = candidates.map(candidate => candidate.item.itemId);
  const result = await client.execute({
    sql: `
      SELECT item_id, tag_id
      FROM item_tags
      WHERE item_id IN (${placeholders(itemIds.length)})
      ORDER BY tag_id
    `,
    args: itemIds,
  });

  const tagsByItem = new Map<string, string[]>();
  for (const row of result.rows as DbRow[]) {
    const itemId = String(row.item_id);
    const tagId = String(row.tag_id);
    const tags = tagsByItem.get(itemId) ?? [];
    tags.push(tagId);
    tagsByItem.set(itemId, tags);
  }

  for (const candidate of candidates) {
    candidate.item.tags = tagsByItem.get(candidate.item.itemId) ?? [];
  }
}

function referenceFromRow(row: DbRow, kind: UnifyRecipeReference['kind']): UnifyRecipeReference {
  return {
    kind,
    recipeId: String(row.recipe_id),
    typeId: String(row.type_id),
    modid: String(row.modid),
    unparsed: booleanFromDb(row.unparsed),
    slot: row.slot === undefined ? undefined : numberOrDefault(row.slot, 0),
    role: optionalString(row.role),
    ref: optionalString(row.ref),
    tagId: optionalString(row.tag_id),
    count: row.count === undefined ? undefined : numberOrDefault(row.count, 1),
    componentsJson: optionalString(row.components_json),
  };
}

async function getReferencesForItem(client: Client, item: UnifyItemFacts): Promise<UnifyCandidateReferences> {
  const [directInputsResult, outputsResult] = await Promise.all([
    client.execute({
      sql: `
        SELECT r.*, ri.slot, ri.role, ri.ref, ri.count
        FROM recipe_inputs ri
        JOIN recipes r ON r.recipe_id = ri.recipe_id
        WHERE ri.kind = 'item' AND ri.ref = ?
        ORDER BY r.recipe_id, ri.slot
      `,
      args: [item.itemId],
    }),
    client.execute({
      sql: `
        SELECT r.*, ro.slot, ro.item_id AS ref, ro.count, ro.components_json
        FROM recipe_outputs ro
        JOIN recipes r ON r.recipe_id = ro.recipe_id
        WHERE ro.item_id = ?
        ORDER BY r.recipe_id, ro.slot
      `,
      args: [item.itemId],
    }),
  ]);

  let tagInputs: UnifyRecipeReference[] = [];
  if (item.tags.length > 0) {
    const tagInputsResult = await client.execute({
      sql: `
        SELECT r.*, ri.slot, ri.role, ri.ref, ri.ref AS tag_id, ri.count
        FROM recipe_inputs ri
        JOIN recipes r ON r.recipe_id = ri.recipe_id
        WHERE ri.kind = 'tag' AND ri.ref IN (${placeholders(item.tags.length)})
        ORDER BY r.recipe_id, ri.slot
      `,
      args: item.tags,
    });
    tagInputs = (tagInputsResult.rows as DbRow[]).map(row => referenceFromRow(row, 'tag_input'));
  }

  const rawArgs = [item.itemId, ...item.tags].map(value => `%${value}%`);
  let unparsedRaw: UnifyRecipeReference[] = [];
  if (rawArgs.length > 0) {
    const rawConditions = rawArgs.map(() => 'raw_json LIKE ?').join(' OR ');
    const rawResult = await client.execute({
      sql: `
        SELECT recipe_id, type_id, modid, hash, raw_json, unparsed
        FROM recipes
        WHERE unparsed = 1 AND (${rawConditions})
        ORDER BY recipe_id
      `,
      args: rawArgs,
    });
    unparsedRaw = (rawResult.rows as DbRow[]).map(row => referenceFromRow(row, 'raw_unparsed'));
  }

  return {
    directInputs: (directInputsResult.rows as DbRow[]).map(row => referenceFromRow(row, 'direct_input')),
    tagInputs,
    outputs: (outputsResult.rows as DbRow[]).map(row => referenceFromRow(row, 'output')),
    unparsedRaw,
  };
}

function foodSignature(item: UnifyItemFacts): string {
  return [
    item.foodNutrition ?? 'null',
    item.foodSaturation ?? 'null',
    item.foodAlwaysEat ?? 'null',
  ].join('|');
}

function addGroupRiskSignals(
  candidates: Array<{ item: UnifyItemFacts; references: UnifyCandidateReferences; riskSignals: UnifyRiskSignal[] }>
): void {
  const componentSignatures = new Set(candidates.map(candidate => candidate.item.defaultComponentsJson ?? ''));
  const durabilitySignatures = new Set(candidates.map(candidate => `${candidate.item.maxDamage}|${candidate.item.isDamageable}`));
  const foodSignatures = new Set(candidates.map(candidate => foodSignature(candidate.item)));

  for (const candidate of candidates) {
    if (componentSignatures.size > 1) {
      candidate.riskSignals.push({
        code: 'different_default_components',
        severity: 'medium',
        message: '候选物品的默认组件不同，自动统一前需要人工确认。',
      });
    }

    if (durabilitySignatures.size > 1) {
      candidate.riskSignals.push({
        code: 'different_durability',
        severity: 'medium',
        message: '候选物品的耐久或可损耗属性不同。',
      });
    }

    if (foodSignatures.size > 1) {
      candidate.riskSignals.push({
        code: 'different_food_properties',
        severity: 'medium',
        message: '候选物品的食物属性不同。',
      });
    }
  }
}

function buildRiskSignals(
  item: UnifyItemFacts,
  references: UnifyCandidateReferences
): UnifyRiskSignal[] {
  const signals: UnifyRiskSignal[] = [];

  if (item.isBlock) {
    signals.push({
      code: 'is_block_item',
      severity: 'medium',
      message: '候选是方块物品，涉及隐藏或移除时必须人工确认。',
    });
  }

  if (references.outputs.length > 0) {
    signals.push({
      code: 'has_recipe_outputs',
      severity: 'medium',
      message: '候选作为配方输出出现，替换输出会影响产物流向。',
      data: { count: references.outputs.length },
    });
  }

  if (references.tagInputs.length > 10) {
    signals.push({
      code: 'many_tag_input_references',
      severity: 'medium',
      message: '候选通过 tag 被大量配方间接引用。',
      data: { count: references.tagInputs.length },
    });
  } else if (references.tagInputs.length > 0) {
    signals.push({
      code: 'tag_input_references',
      severity: 'info',
      message: '候选通过 tag 被配方间接引用。',
      data: { count: references.tagInputs.length },
    });
  }

  if (references.unparsedRaw.length > 0) {
    signals.push({
      code: 'related_unparsed_recipes',
      severity: 'high',
      message: '存在相关未结构化配方，不能自动 rewrite，只能进入风险说明。',
      data: { count: references.unparsedRaw.length },
    });
  }

  return signals;
}

export async function queryUnifyCandidates(
  projectPath: string,
  params: UnifyQueryParams
): Promise<UnifyQueryResult> {
  const query = params.query.trim();
  if (!query) {
    throw new Error('查询内容不能为空');
  }

  const lang = params.lang || 'zh_cn';
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const normalizedQuery = normalizeText(query);
  const db = createProjectDbClient(path.join(projectPath, '.delightify', 'project.db'));

  const status = await getDataSourceStatus(db);
  const candidates = new Map<string, CandidateDraft>();
  const baseRows = await readBaseItemRows(db, lang);

  for (const row of baseRows) {
    const itemIdValue = String(row.item_id);
    const displayName = optionalString(row.display_name);
    if (displayName && normalizeText(displayName) === normalizedQuery) {
      mergeCandidate(candidates, row, {
        reason: 'display_name',
        value: displayName,
      });
    }

    if (normalizeText(itemPath(itemIdValue)) === normalizedQuery || itemIdValue.includes(query)) {
      mergeCandidate(candidates, row, {
        reason: 'item_id_path',
        value: itemPath(itemIdValue),
      });
    }
  }

  await addTagCandidates(db, candidates, query, lang);

  const drafts = Array.from(candidates.values()).slice(0, limit);
  await attachTags(db, drafts);

  const enriched = await Promise.all(drafts.map(async draft => {
    const references = await getReferencesForItem(db, draft.item);
    const riskSignals = buildRiskSignals(draft.item, references);
    return {
      item: draft.item,
      matchedBy: draft.matchedBy,
      references,
      riskSignals,
    };
  }));

  addGroupRiskSignals(enriched);

  const resultCandidates: UnifyCandidate[] = enriched.map(candidate => ({
    ...candidate,
    riskLevel: maxRiskLevel(candidate.riskSignals),
  }));

  resultCandidates.sort((a, b) => {
    const nameA = a.item.displayName || a.item.itemId;
    const nameB = b.item.displayName || b.item.itemId;
    try {
      return nameA.localeCompare(nameB, toLocaleTag(lang));
    } catch {
      return nameA.localeCompare(nameB);
    }
  });

  return {
    query,
    normalizedQuery,
    lang,
    sourceKind: 'exporter_v1',
    capabilities: status.capabilities,
    candidates: resultCandidates,
    generatedAt: new Date().toISOString(),
  };
}
