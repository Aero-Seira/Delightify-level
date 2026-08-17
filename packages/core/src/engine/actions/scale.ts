import type { Client } from '@libsql/client';
import type { ChangeOperation } from '../ir';
import {
  classifyRisk,
  computeBlastRadius,
  type BlastRadius,
  type BlastRiskClassification,
  type BlastRiskSeverity,
} from '../blast-radius';

type DbRow = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;

export type ScaleRecipeField = 'input_count' | 'output_count' | 'time' | 'energy' | string;
export type ScaleRoundMode = 'floor' | 'round' | 'ceil';
export type ScaleClassificationDecision =
  | 'emission_pending'
  | 'conservation_skip'
  | 'type_defer'
  | 'no_baseline';

export interface ScalePlanRequest {
  recipeIds: string[];
  field: ScaleRecipeField;
  factor?: number;
  delta?: number;
  clamp?: {
    min?: number;
    max?: number;
  };
  round?: ScaleRoundMode;
  /** 显式确认的 operation id；只有 emission_pending 项可被翻转为进 changeSet。 */
  confirmedOperationIds?: string[];
}

export interface ScaleClassification {
  operationId: string;
  recipeId: string;
  field: string;
  decision: ScaleClassificationDecision;
  baseline?: number;
  computed?: number;
  reason: string;
}

export interface ScalePlanResult {
  operations: ChangeOperation[];
  classifications: ScaleClassification[];
  blast: BlastRadius[];
  risk: BlastRiskClassification;
}

interface RecipeFact {
  recipeId: string;
  typeId: string;
  modid: string;
  rawJson?: string;
}

interface CountBaseline {
  slot: number;
  value: number;
}

interface RecipeInputFact {
  slot: number;
  kind: string;
  ref: string;
  count: number;
}

interface RecipeOutputFact {
  slot: number;
  itemId: string;
  count: number;
  isPrimary: boolean;
}

const SMELTING_TYPE_IDS = new Set([
  'minecraft:smelting',
  'minecraft:blasting',
  'minecraft:smoking',
  'minecraft:campfire_cooking',
]);

const CRAFTING_TYPE_IDS = new Set([
  'minecraft:crafting_shaped',
  'minecraft:crafting_shapeless',
]);

const COUNT_EMITTABLE_TYPE_IDS = new Set([
  ...SMELTING_TYPE_IDS,
  ...CRAFTING_TYPE_IDS,
]);

const RAW_TIME_KEYS = ['cookingtime', 'cooking_time', 'cookingTime'];

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function numberOrDefault(value: unknown, defaultValue: number): number {
  if (value === null || value === undefined || value === '') {
    return defaultValue;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : defaultValue;
}

function optionalString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function severityRank(severity: BlastRiskSeverity): number {
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

function highestSeverity(severities: BlastRiskSeverity[]): BlastRiskSeverity {
  return severities.reduce<BlastRiskSeverity>((highest, severity) => (
    severityRank(severity) > severityRank(highest) ? severity : highest
  ), 'info');
}

function scaleOperationId(field: string, recipeId: string, slot?: number): string {
  return ['scale', field, recipeId, slot ?? 'recipe'].join(':');
}

function validateScaleRequest(req: ScalePlanRequest): void {
  const hasFactor = req.factor !== undefined;
  const hasDelta = req.delta !== undefined;
  if (hasFactor === hasDelta) {
    throw new Error('scale 请求必须且只能提供 factor 或 delta。');
  }
  if (hasFactor && !Number.isFinite(req.factor)) {
    throw new Error('scale factor 必须是有限数字。');
  }
  if (hasDelta && !Number.isFinite(req.delta)) {
    throw new Error('scale delta 必须是有限数字。');
  }
  if (req.round && !['floor', 'round', 'ceil'].includes(req.round)) {
    throw new Error(`未知 scale round 模式: ${req.round}`);
  }
  if (req.clamp?.min !== undefined && !Number.isFinite(req.clamp.min)) {
    throw new Error('scale clamp.min 必须是有限数字。');
  }
  if (req.clamp?.max !== undefined && !Number.isFinite(req.clamp.max)) {
    throw new Error('scale clamp.max 必须是有限数字。');
  }
  if (
    req.clamp?.min !== undefined &&
    req.clamp?.max !== undefined &&
    req.clamp.min > req.clamp.max
  ) {
    throw new Error('scale clamp.min 不能大于 clamp.max。');
  }
}

function roundValue(value: number, mode: ScaleRoundMode): number {
  switch (mode) {
    case 'floor':
      return Math.floor(value);
    case 'ceil':
      return Math.ceil(value);
    case 'round':
    default:
      return Math.round(value);
  }
}

function computeScaledValue(baseline: number, req: ScalePlanRequest): number {
  const raw = req.factor !== undefined
    ? baseline * req.factor
    : baseline + (req.delta ?? 0);
  const rounded = roundValue(raw, req.round ?? 'round');
  const minClamped = req.clamp?.min === undefined ? rounded : Math.max(req.clamp.min, rounded);
  return req.clamp?.max === undefined ? minClamped : Math.min(req.clamp.max, minClamped);
}

function parseRawJson(raw?: string): JsonRecord | null {
  if (!raw || raw.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as JsonRecord
      : null;
  } catch {
    return null;
  }
}

function rawNumber(raw: JsonRecord, keys: string[]): { key: string; value: number } | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return { key, value };
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return { key, value: parsed };
      }
    }
  }
  return null;
}

function setRawField(raw: JsonRecord, key: string, value: number): JsonRecord {
  return { ...raw, [key]: value };
}

function resultItemId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as JsonRecord;
    const id = record.id ?? record.item;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  }
  return undefined;
}

function buildOutputCountRecipeJson(
  fact: RecipeFact,
  outputs: RecipeOutputFact[],
  computed: number
): { json?: JsonRecord; reason?: string } {
  if (!COUNT_EMITTABLE_TYPE_IDS.has(fact.typeId)) {
    return { reason: `配方类型 ${fact.typeId} 不在 scale 发射白名单。` };
  }
  const raw = parseRawJson(fact.rawJson);
  if (raw === null) {
    return { reason: '缺少可重建配方的 raw_json。' };
  }
  const primaryOutputs = outputs.filter(output => output.isPrimary);
  const effectiveOutputs = primaryOutputs.length > 0 ? primaryOutputs : outputs;
  if (effectiveOutputs.length !== 1) {
    return { reason: '多输出配方的自定义重建暂不支持，保持 defer。' };
  }

  const output = effectiveOutputs[0];
  const existingResult = raw.result;
  const existingItem = resultItemId(existingResult) ?? output.itemId;
  let result: unknown;
  if (typeof existingResult === 'string') {
    result = computed === 1 ? existingResult : { id: existingResult, count: computed };
  } else if (
    typeof existingResult === 'object' &&
    existingResult !== null &&
    !Array.isArray(existingResult)
  ) {
    result = {
      ...(existingResult as JsonRecord),
      id: existingItem,
      count: computed,
    };
  } else {
    result = { id: existingItem, count: computed };
  }

  return { json: { ...raw, result } };
}

function buildTimeRecipeJson(
  fact: RecipeFact,
  baseline: number,
  computed: number
): { json?: JsonRecord; reason?: string } {
  if (!SMELTING_TYPE_IDS.has(fact.typeId)) {
    return { reason: `配方类型 ${fact.typeId} 不支持 time 字段重建。` };
  }
  const raw = parseRawJson(fact.rawJson);
  if (raw === null) {
    return { reason: '缺少可重建配方的 raw_json。' };
  }
  const baselineField = rawNumber(raw, RAW_TIME_KEYS);
  if (baselineField === null) {
    return { reason: 'raw_json 中没有 cookingtime/cooking_time/cookingTime 字段。' };
  }
  if (baselineField.value !== baseline) {
    return { reason: `raw_json 时间基线 ${baselineField.value} 与请求基线 ${baseline} 不一致，拒绝重建。` };
  }
  return { json: setRawField(raw, baselineField.key, computed) };
}

function scaleOperation(params: {
  operationId: string;
  recipeId: string;
  fact?: RecipeFact;
  field: string;
  slot?: number;
  baseline?: number;
  computed?: number;
  recipeJson?: JsonRecord;
  emittable: boolean;
  reason: string;
  confirmed?: boolean;
}): ChangeOperation {
  const before: Record<string, unknown> = {
    field: params.field,
    recipeId: params.recipeId,
  };
  if (params.slot !== undefined) {
    before.slot = params.slot;
  }
  if (params.baseline !== undefined) {
    before.value = params.baseline;
  }

  let after: Record<string, unknown> | undefined;
  if (params.computed !== undefined) {
    after = {
      field: params.field,
      value: params.computed,
    };
    if (params.recipeJson !== undefined) {
      after.recipeJson = params.recipeJson;
    }
  }

  return {
    operationId: params.operationId,
    decisionId: `scale:${params.field}:${params.recipeId}`,
    kind: 'scale_recipe_field',
    recipeId: params.recipeId,
    typeId: params.fact?.typeId,
    modid: params.fact?.modid,
    slot: params.slot,
    before,
    after,
    includedInChangeSet: params.emittable && params.confirmed === true,
    reason: params.reason,
  };
}

function mergeRisk(
  blasts: BlastRadius[],
  classifications: ScaleClassification[]
): BlastRiskClassification {
  const reasons = new Set<string>();
  const severities: BlastRiskSeverity[] = [];

  for (const blast of blasts) {
    const risk = classifyRisk(blast, { action: 'scale' });
    severities.push(risk.severity);
    for (const reason of risk.reasons) {
      reasons.add(reason);
    }
  }

  const emissionPending = classifications.some(item => item.decision === 'emission_pending');
  if (emissionPending) {
    reasons.add('scale 输出层已支持：确认后以 remove + custom 重建发射；未确认项仅分析。');
  } else {
    reasons.add('本批 scale 项均未进入发射白名单，保持仅分析。');
  }

  return {
    severity: highestSeverity(severities),
    mustDefer: false,
    reasons: Array.from(reasons),
  };
}

async function readRecipeFacts(db: Client, recipeIds: string[]): Promise<Map<string, RecipeFact>> {
  const facts = new Map<string, RecipeFact>();

  for (const recipeId of recipeIds) {
    const result = await db.execute({
      sql: [
        'SELECT recipe_id, type_id, modid, raw_json',
        'FROM recipes WHERE recipe_id = ? LIMIT 1',
      ].join(' '),
      args: [recipeId],
    });
    const row = result.rows[0] as DbRow | undefined;
    if (!row) {
      continue;
    }
    facts.set(recipeId, {
      recipeId: String(row.recipe_id),
      typeId: String(row.type_id),
      modid: String(row.modid),
      rawJson: row.raw_json === null || row.raw_json === undefined
        ? undefined
        : String(row.raw_json),
    });
  }

  return facts;
}

async function readInputFacts(db: Client, recipeId: string): Promise<RecipeInputFact[]> {
  const result = await db.execute({
    sql: [
      'SELECT slot, kind, ref, count FROM recipe_inputs',
      'WHERE recipe_id = ? ORDER BY slot',
    ].join(' '),
    args: [recipeId],
  });

  return (result.rows as DbRow[]).map(row => ({
    slot: numberOrDefault(row.slot, 0),
    kind: optionalString(row.kind),
    ref: optionalString(row.ref),
    count: numberOrDefault(row.count, 1),
  }));
}

async function readOutputFacts(db: Client, recipeId: string): Promise<RecipeOutputFact[]> {
  const result = await db.execute({
    sql: [
      'SELECT slot, item_id, count, is_primary FROM recipe_outputs',
      'WHERE recipe_id = ? ORDER BY slot',
    ].join(' '),
    args: [recipeId],
  });

  return (result.rows as DbRow[]).map(row => ({
    slot: numberOrDefault(row.slot, 0),
    itemId: String(row.item_id),
    count: numberOrDefault(row.count, 1),
    isPrimary: row.is_primary === undefined || row.is_primary === null
      ? true
      : String(row.is_primary) === '1' || String(row.is_primary) === 'true',
  }));
}

async function readOutputItems(db: Client, recipeIds: string[]): Promise<string[]> {
  const outputItems = new Set<string>();

  for (const recipeId of recipeIds) {
    const outputs = await readOutputFacts(db, recipeId);
    for (const output of outputs) {
      outputItems.add(output.itemId);
    }
  }

  return [...outputItems].sort();
}

function isConservationRecipe(inputs: RecipeInputFact[], outputs: RecipeOutputFact[]): boolean {
  return (
    inputs.length === 1 &&
    outputs.length === 1 &&
    inputs[0].kind === 'item' &&
    inputs[0].ref === outputs[0].itemId &&
    inputs[0].count === outputs[0].count
  );
}

function countBaselinesForField(
  field: string,
  inputs: RecipeInputFact[],
  outputs: RecipeOutputFact[]
): CountBaseline[] {
  if (field === 'input_count') {
    return inputs.map(input => ({
      slot: input.slot,
      value: input.count,
    }));
  }

  if (field === 'output_count') {
    return outputs.map(output => ({
      slot: output.slot,
      value: output.count,
    }));
  }

  return [];
}

export async function planScale(db: Client, req: ScalePlanRequest): Promise<ScalePlanResult> {
  validateScaleRequest(req);

  const recipeIds = dedupeStrings(req.recipeIds);
  const confirmed = new Set(req.confirmedOperationIds ?? []);
  const facts = await readRecipeFacts(db, recipeIds);
  const operations: ChangeOperation[] = [];
  const classifications: ScaleClassification[] = [];

  for (const recipeId of recipeIds) {
    const fact = facts.get(recipeId);
    const operationIdForRecipe = scaleOperationId(req.field, recipeId);

    if (!fact) {
      const reason = '找不到配方，无法读取结构化基线。';
      const operation = scaleOperation({
        operationId: operationIdForRecipe,
        recipeId,
        field: req.field,
        reason,
        emittable: false,
      });
      operations.push(operation);
      classifications.push({
        operationId: operation.operationId,
        recipeId,
        field: req.field,
        decision: 'no_baseline',
        reason,
      });
      continue;
    }

    if (req.field === 'input_count') {
      const reason = 'input_count 的自定义配方重建（pattern/key count 关联）尚未进入发射白名单。';
      const operation = scaleOperation({
        operationId: operationIdForRecipe,
        recipeId,
        fact,
        field: req.field,
        reason,
        emittable: false,
      });
      operations.push(operation);
      classifications.push({
        operationId: operation.operationId,
        recipeId,
        field: req.field,
        decision: 'type_defer',
        reason,
      });
      continue;
    }

    if (req.field === 'energy') {
      const reason = 'energy 字段缺少可核实的 vanilla 基线，保持 defer。';
      const operation = scaleOperation({
        operationId: operationIdForRecipe,
        recipeId,
        fact,
        field: req.field,
        reason,
        emittable: false,
      });
      operations.push(operation);
      classifications.push({
        operationId: operation.operationId,
        recipeId,
        field: req.field,
        decision: 'type_defer',
        reason,
      });
      continue;
    }

    if (req.field === 'time') {
      const raw = parseRawJson(fact.rawJson);
      const baselineField = raw === null ? null : rawNumber(raw, RAW_TIME_KEYS);
      if (baselineField === null) {
        const reason = raw === null
          ? '缺少 raw_json，无法读取 time 基线。'
          : 'raw_json 中没有可核实的 time 字段。';
        const operation = scaleOperation({
          operationId: operationIdForRecipe,
          recipeId,
          fact,
          field: req.field,
          reason,
          emittable: false,
        });
        operations.push(operation);
        classifications.push({
          operationId: operation.operationId,
          recipeId,
          field: req.field,
          decision: 'no_baseline',
          reason,
        });
        continue;
      }

      if (!SMELTING_TYPE_IDS.has(fact.typeId)) {
        const computed = computeScaledValue(baselineField.value, req);
        const reason = `配方类型 ${fact.typeId} 不在 time 发射白名单。`;
        const operation = scaleOperation({
          operationId: operationIdForRecipe,
          recipeId,
          fact,
          field: req.field,
          baseline: baselineField.value,
          computed,
          reason,
          emittable: false,
        });
        operations.push(operation);
        classifications.push({
          operationId: operation.operationId,
          recipeId,
          field: req.field,
          decision: 'type_defer',
          baseline: baselineField.value,
          computed,
          reason,
        });
        continue;
      }

      const computed = computeScaledValue(baselineField.value, req);
      const rebuilt = buildTimeRecipeJson(fact, baselineField.value, computed);
      if (rebuilt.json === undefined) {
        const reason = rebuilt.reason ?? 'time 配方重建失败。';
        const operation = scaleOperation({
          operationId: operationIdForRecipe,
          recipeId,
          fact,
          field: req.field,
          baseline: baselineField.value,
          computed,
          reason,
          emittable: false,
        });
        operations.push(operation);
        classifications.push({
          operationId: operation.operationId,
          recipeId,
          field: req.field,
          decision: 'type_defer',
          baseline: baselineField.value,
          computed,
          reason,
        });
        continue;
      }

      const reason = 'time 支持确认后以 remove + custom 重建发射。';
      const operation = scaleOperation({
        operationId: operationIdForRecipe,
        recipeId,
        fact,
        field: req.field,
        baseline: baselineField.value,
        computed,
        recipeJson: rebuilt.json,
        reason,
        emittable: true,
        confirmed: confirmed.has(operationIdForRecipe),
      });
      operations.push(operation);
      classifications.push({
        operationId: operation.operationId,
        recipeId,
        field: req.field,
        decision: 'emission_pending',
        baseline: baselineField.value,
        computed,
        reason,
      });
      continue;
    }

    if (req.field !== 'output_count') {
      const reason = `scale 字段 ${req.field} 暂不支持。`;
      const operation = scaleOperation({
        operationId: operationIdForRecipe,
        recipeId,
        fact,
        field: req.field,
        reason,
        emittable: false,
      });
      operations.push(operation);
      classifications.push({
        operationId: operation.operationId,
        recipeId,
        field: req.field,
        decision: 'type_defer',
        reason,
      });
      continue;
    }

    const [inputs, outputs] = await Promise.all([
      readInputFacts(db, recipeId),
      readOutputFacts(db, recipeId),
    ]);
    const baselines = countBaselinesForField(req.field, inputs, outputs);

    if (baselines.length === 0) {
      const reason = '该字段没有结构化基线行，无法计算 before/after。';
      const operation = scaleOperation({
        operationId: operationIdForRecipe,
        recipeId,
        fact,
        field: req.field,
        reason,
        emittable: false,
      });
      operations.push(operation);
      classifications.push({
        operationId: operation.operationId,
        recipeId,
        field: req.field,
        decision: 'no_baseline',
        reason,
      });
      continue;
    }

    const conservation = isConservationRecipe(inputs, outputs);
    for (const baseline of baselines) {
      const operationId = scaleOperationId(req.field, recipeId, baseline.slot);
      const computed = conservation ? baseline.value : computeScaledValue(baseline.value, req);
      if (conservation) {
        const reason = '守恒型 1:1 转化，scale 按规格跳过。';
        const operation = scaleOperation({
          operationId,
          recipeId,
          fact,
          field: req.field,
          slot: baseline.slot,
          baseline: baseline.value,
          computed,
          reason,
          emittable: false,
        });
        operations.push(operation);
        classifications.push({
          operationId,
          recipeId,
          field: req.field,
          decision: 'conservation_skip',
          baseline: baseline.value,
          computed,
          reason,
        });
        continue;
      }

      const rebuilt = buildOutputCountRecipeJson(fact, outputs, computed);
      if (rebuilt.json === undefined) {
        const reason = rebuilt.reason ?? '输出数量配方重建失败。';
        const operation = scaleOperation({
          operationId,
          recipeId,
          fact,
          field: req.field,
          slot: baseline.slot,
          baseline: baseline.value,
          computed,
          reason,
          emittable: false,
        });
        operations.push(operation);
        classifications.push({
          operationId,
          recipeId,
          field: req.field,
          decision: 'type_defer',
          baseline: baseline.value,
          computed,
          reason,
        });
        continue;
      }

      const reason = 'output_count 支持确认后以 remove + custom 重建发射。';
      const operation = scaleOperation({
        operationId,
        recipeId,
        fact,
        field: req.field,
        slot: baseline.slot,
        baseline: baseline.value,
        computed,
        recipeJson: rebuilt.json,
        reason,
        emittable: true,
        confirmed: confirmed.has(operationId),
      });
      operations.push(operation);
      classifications.push({
        operationId,
        recipeId,
        field: req.field,
        decision: 'emission_pending',
        baseline: baseline.value,
        computed,
        reason,
      });
    }
  }

  const outputItems = await readOutputItems(db, recipeIds);
  const blast = await Promise.all(outputItems.map(item => computeBlastRadius(db, {
    kind: 'item',
    ref: item,
  })));

  return {
    operations,
    classifications,
    blast,
    risk: mergeRisk(blast, classifications),
  };
}
