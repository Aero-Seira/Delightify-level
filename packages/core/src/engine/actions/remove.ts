import type { Client } from '@libsql/client';
import type { ChangeOperation } from '../ir';
import {
  classifyRisk,
  computeBlastRadius,
  type BlastRadius,
  type BlastRecipeReference,
  type BlastRiskClassification,
  type BlastRiskSeverity,
} from '../blast-radius';

type DbRow = Record<string, unknown>;

interface RecipeFact {
  recipeId: string;
  typeId: string;
  modid: string;
}

export interface RemoveRecipePlanRequest {
  recipeIds: string[];
  confirmedOperationIds?: string[];
}

export interface RemoveRecipeOutputDownstream {
  itemId: string;
  blast: BlastRadius;
  inputReferences: BlastRecipeReference[];
  relatedUnparsed: BlastRecipeReference[];
}

export interface RemoveRecipeDownstream {
  recipeId: string;
  outputs: RemoveRecipeOutputDownstream[];
}

export interface RemoveRecipePlanResult {
  operations: ChangeOperation[];
  downstream: RemoveRecipeDownstream[];
  risk: BlastRiskClassification;
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

function booleanFromDb(value: unknown): boolean {
  return String(value) === '1' || String(value).toLowerCase() === 'true';
}

function numberOrDefault(value: unknown, defaultValue: number): number {
  if (value === null || value === undefined || value === '') {
    return defaultValue;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : defaultValue;
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const text = String(value);
  return text.length > 0 ? text : undefined;
}

function referenceFromRow(row: DbRow, kind: BlastRecipeReference['kind']): BlastRecipeReference {
  return {
    kind,
    recipeId: String(row.recipe_id),
    typeId: String(row.type_id),
    modid: String(row.modid),
    unparsed: booleanFromDb(row.unparsed),
    slot: row.slot === undefined || row.slot === null ? undefined : numberOrDefault(row.slot, 0),
    role: optionalString(row.role),
    ref: optionalString(row.ref),
    tagId: optionalString(row.tag_id),
    count: row.count === undefined || row.count === null ? undefined : numberOrDefault(row.count, 1),
    componentsJson: optionalString(row.components_json),
  };
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function dedupeReferences(references: BlastRecipeReference[]): BlastRecipeReference[] {
  const seen = new Set<string>();
  const deduped: BlastRecipeReference[] = [];

  for (const reference of references) {
    const key = [
      reference.kind,
      reference.recipeId,
      reference.slot ?? '',
      reference.role ?? '',
      reference.ref ?? '',
      reference.tagId ?? '',
    ].join('|');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(reference);
  }

  return deduped;
}

async function readRecipeFact(db: Client, recipeId: string): Promise<RecipeFact> {
  const result = await db.execute({
    sql: `
      SELECT recipe_id, type_id, modid
      FROM recipes
      WHERE recipe_id = ?
      LIMIT 1
    `,
    args: [recipeId],
  });
  const row = result.rows[0] as DbRow | undefined;
  if (!row) {
    throw new Error(`找不到配方: ${recipeId}`);
  }

  return {
    recipeId: String(row.recipe_id),
    typeId: String(row.type_id),
    modid: String(row.modid),
  };
}

async function readRecipeOutputItems(db: Client, recipeId: string): Promise<string[]> {
  const result = await db.execute({
    sql: `
      SELECT item_id
      FROM recipe_outputs
      WHERE recipe_id = ?
      ORDER BY slot, item_id
    `,
    args: [recipeId],
  });

  return dedupeStrings((result.rows as DbRow[]).map(row => String(row.item_id)));
}

async function readUnparsedReferencesForOutput(db: Client, itemId: string, sourceRecipeId: string): Promise<BlastRecipeReference[]> {
  const result = await db.execute({
    sql: `
      SELECT recipe_id, type_id, modid, unparsed
      FROM recipes
      WHERE recipe_id <> ? AND unparsed = 1 AND raw_json LIKE ?
      ORDER BY recipe_id
    `,
    args: [sourceRecipeId, `%${itemId}%`],
  });

  return dedupeReferences((result.rows as DbRow[]).map(row => referenceFromRow(row, 'raw_unparsed')));
}

function downstreamHasStrongRisk(downstream: RemoveRecipeDownstream): boolean {
  return downstream.outputs.some(output => (
    output.inputReferences.length > 0 || output.relatedUnparsed.length > 0
  ));
}

function mergeRisk(downstream: RemoveRecipeDownstream[]): BlastRiskClassification {
  const reasons = new Set<string>();
  const severities: BlastRiskSeverity[] = [];

  reasons.add('删除配方默认搁置，需要人工确认。');

  for (const entry of downstream) {
    for (const output of entry.outputs) {
      const outputRisk = classifyRisk(output.blast, { action: 'remove' });
      severities.push(outputRisk.severity);
      for (const reason of outputRisk.reasons) {
        reasons.add(reason);
      }
      if (output.inputReferences.length > 0) {
        reasons.add('被删除配方的产物仍被其它配方作为输入引用。');
      }
      if (output.relatedUnparsed.length > 0) {
        reasons.add('被删除配方的产物关联未结构化配方。');
      }
    }
  }

  return {
    severity: highestSeverity(severities.length > 0 ? severities : ['medium']),
    mustDefer: true,
    reasons: Array.from(reasons),
  };
}

function operationReason(
  includedInChangeSet: boolean,
  requestedConfirm: boolean,
  risk: BlastRiskClassification,
  downstream: RemoveRecipeDownstream
): string | undefined {
  if (includedInChangeSet) {
    return undefined;
  }

  if (downstreamHasStrongRisk(downstream)) {
    const prefix = requestedConfirm ? '已请求确认，但存在强风险项：' : '存在强风险项：';
    const reasons: string[] = [];
    if (downstream.outputs.some(output => output.inputReferences.length > 0)) {
      reasons.push('产物被其它配方作为输入引用，确认不能覆盖');
    }
    if (downstream.outputs.some(output => output.relatedUnparsed.length > 0)) {
      reasons.push('产物关联未结构化配方，确认不能覆盖');
    }
    return `${prefix}${reasons.join('；')}`;
  }

  return risk.reasons.join('；') || '删除配方默认搁置，需显式确认后导出。';
}

export async function planRemoveRecipe(
  db: Client,
  req: RemoveRecipePlanRequest
): Promise<RemoveRecipePlanResult> {
  const recipeIds = dedupeStrings(req.recipeIds);
  const confirmed = new Set(req.confirmedOperationIds ?? []);
  const facts = await Promise.all(recipeIds.map(recipeId => readRecipeFact(db, recipeId)));
  const downstream: RemoveRecipeDownstream[] = [];

  for (const recipeId of recipeIds) {
    const outputItems = await readRecipeOutputItems(db, recipeId);
    const outputs: RemoveRecipeOutputDownstream[] = [];

    for (const itemId of outputItems) {
      const [blast, relatedUnparsed] = await Promise.all([
        computeBlastRadius(db, { kind: 'item', ref: itemId }),
        readUnparsedReferencesForOutput(db, itemId, recipeId),
      ]);
      outputs.push({
        itemId,
        blast,
        inputReferences: dedupeReferences([
          ...blast.recipeRefsAsInput,
          ...blast.tagConnectedRecipes,
        ].filter(reference => reference.recipeId !== recipeId)),
        relatedUnparsed,
      });
    }

    downstream.push({ recipeId, outputs });
  }

  const risk = mergeRisk(downstream);
  const downstreamByRecipeId = new Map(downstream.map(entry => [entry.recipeId, entry]));
  const operations = facts.map(fact => {
    const operationId = `remove_recipe:${fact.recipeId}`;
    const requestedConfirm = confirmed.has(operationId);
    const recipeDownstream = downstreamByRecipeId.get(fact.recipeId) ?? {
      recipeId: fact.recipeId,
      outputs: [],
    };
    const forceDeferred = downstreamHasStrongRisk(recipeDownstream);
    const includedInChangeSet = requestedConfirm && !forceDeferred;

    return {
      operationId,
      decisionId: `remove_recipe:${fact.recipeId}`,
      kind: 'remove_recipe' as const,
      recipeId: fact.recipeId,
      typeId: fact.typeId,
      modid: fact.modid,
      before: {
        recipeId: fact.recipeId,
      },
      includedInChangeSet,
      reason: operationReason(includedInChangeSet, requestedConfirm, risk, recipeDownstream),
    };
  });

  return { operations, downstream, risk };
}
