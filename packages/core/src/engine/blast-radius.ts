import type { Client } from '@libsql/client';

type DbRow = Record<string, unknown>;

export type BlastRadiusTarget = {
  kind: 'item' | 'tag';
  ref: string;
};

export type BlastRecipeReferenceKind = 'direct_input' | 'tag_input' | 'output' | 'raw_unparsed';

export interface BlastRecipeReference {
  kind: BlastRecipeReferenceKind;
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

export interface BlastRadius {
  target: BlastRadiusTarget;
  recipeRefsAsInput: BlastRecipeReference[];
  recipeRefsAsOutput: BlastRecipeReference[];
  tagConnectedRecipes: BlastRecipeReference[];
  isBlock: boolean;
  crossMod: boolean;
  relatedUnparsed: BlastRecipeReference[];
}

export type BlastRiskSeverity = 'info' | 'low' | 'medium' | 'high';

export interface BlastRiskClassification {
  severity: BlastRiskSeverity;
  mustDefer: boolean;
  reasons: string[];
}

export interface ClassifyRiskOptions {
  action?: 'remove' | 'retag' | 'replace' | 'rename' | 'scale' | 'hide';
}

interface ItemFact {
  itemId: string;
  modid: string;
  isBlock: boolean;
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

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function modidFromRef(ref: string): string {
  const separatorIndex = ref.indexOf(':');
  return separatorIndex > 0 ? ref.slice(0, separatorIndex) : '';
}

function itemFactFromRow(row: DbRow): ItemFact {
  return {
    itemId: String(row.item_id),
    modid: String(row.modid),
    isBlock: booleanFromDb(row.is_block),
  };
}

function referenceFromRow(row: DbRow, kind: BlastRecipeReferenceKind): BlastRecipeReference {
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

function referenceKey(reference: BlastRecipeReference): string {
  return [
    reference.kind,
    reference.recipeId,
    reference.slot ?? '',
    reference.role ?? '',
    reference.ref ?? '',
    reference.tagId ?? '',
  ].join('|');
}

function dedupeReferences(references: BlastRecipeReference[]): BlastRecipeReference[] {
  const seen = new Set<string>();
  const deduped: BlastRecipeReference[] = [];

  for (const reference of references) {
    const key = referenceKey(reference);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(reference);
  }

  return deduped;
}

async function readItemFact(db: Client, itemId: string): Promise<ItemFact | null> {
  const result = await db.execute({
    sql: `
      SELECT item_id, modid, is_block
      FROM items
      WHERE item_id = ?
      LIMIT 1
    `,
    args: [itemId],
  });

  const row = result.rows[0] as DbRow | undefined;
  return row ? itemFactFromRow(row) : null;
}

async function readItemTags(db: Client, itemId: string): Promise<string[]> {
  const result = await db.execute({
    sql: `
      SELECT tag_id
      FROM item_tags
      WHERE item_id = ?
      ORDER BY tag_id
    `,
    args: [itemId],
  });

  return (result.rows as DbRow[]).map(row => String(row.tag_id));
}

async function readTagMembers(db: Client, tagId: string): Promise<ItemFact[]> {
  const result = await db.execute({
    sql: `
      SELECT i.item_id, i.modid, i.is_block
      FROM item_tags it
      JOIN items i ON i.item_id = it.item_id
      WHERE it.tag_id = ?
      ORDER BY i.item_id
    `,
    args: [tagId],
  });

  return (result.rows as DbRow[]).map(itemFactFromRow);
}

async function readDirectInputReferences(db: Client, itemIds: string[]): Promise<BlastRecipeReference[]> {
  if (itemIds.length === 0) {
    return [];
  }

  const result = await db.execute({
    sql: `
      SELECT r.recipe_id, r.type_id, r.modid, r.unparsed, ri.slot, ri.role, ri.ref, ri.count
      FROM recipe_inputs ri
      JOIN recipes r ON r.recipe_id = ri.recipe_id
      WHERE ri.kind = 'item' AND ri.ref IN (${placeholders(itemIds.length)})
      ORDER BY r.recipe_id, ri.slot
    `,
    args: itemIds,
  });

  return (result.rows as DbRow[]).map(row => referenceFromRow(row, 'direct_input'));
}

async function readOutputReferences(db: Client, itemIds: string[]): Promise<BlastRecipeReference[]> {
  if (itemIds.length === 0) {
    return [];
  }

  const result = await db.execute({
    sql: `
      SELECT r.recipe_id, r.type_id, r.modid, r.unparsed, ro.slot, ro.item_id AS ref, ro.count, ro.components_json
      FROM recipe_outputs ro
      JOIN recipes r ON r.recipe_id = ro.recipe_id
      WHERE ro.item_id IN (${placeholders(itemIds.length)})
      ORDER BY r.recipe_id, ro.slot
    `,
    args: itemIds,
  });

  return (result.rows as DbRow[]).map(row => referenceFromRow(row, 'output'));
}

async function readTagInputReferences(db: Client, tagIds: string[]): Promise<BlastRecipeReference[]> {
  if (tagIds.length === 0) {
    return [];
  }

  const result = await db.execute({
    sql: `
      SELECT r.recipe_id, r.type_id, r.modid, r.unparsed, ri.slot, ri.role, ri.ref, ri.ref AS tag_id, ri.count
      FROM recipe_inputs ri
      JOIN recipes r ON r.recipe_id = ri.recipe_id
      WHERE ri.kind = 'tag' AND ri.ref IN (${placeholders(tagIds.length)})
      ORDER BY r.recipe_id, ri.slot
    `,
    args: tagIds,
  });

  return (result.rows as DbRow[]).map(row => referenceFromRow(row, 'tag_input'));
}

async function readRelatedUnparsed(db: Client, refs: string[]): Promise<BlastRecipeReference[]> {
  const uniqueRefs = Array.from(new Set(refs.filter(ref => ref.length > 0)));
  if (uniqueRefs.length === 0) {
    return [];
  }

  const result = await db.execute({
    sql: `
      SELECT recipe_id, type_id, modid, unparsed
      FROM recipes
      WHERE unparsed = 1 AND (${uniqueRefs.map(() => 'raw_json LIKE ?').join(' OR ')})
      ORDER BY recipe_id
    `,
    args: uniqueRefs.map(ref => `%${ref}%`),
  });

  return dedupeReferences((result.rows as DbRow[]).map(row => referenceFromRow(row, 'raw_unparsed')));
}

function computeCrossMod(targetModids: string[], references: BlastRecipeReference[]): boolean {
  const modids = new Set<string>();

  for (const modid of targetModids) {
    if (modid.length > 0) {
      modids.add(modid);
    }
  }

  for (const reference of references) {
    if (reference.modid.length > 0) {
      modids.add(reference.modid);
    }
  }

  return modids.size > 1;
}

export async function computeBlastRadius(db: Client, target: BlastRadiusTarget): Promise<BlastRadius> {
  if (target.kind === 'item') {
    const [item, itemTags, recipeRefsAsInput, recipeRefsAsOutput] = await Promise.all([
      readItemFact(db, target.ref),
      readItemTags(db, target.ref),
      readDirectInputReferences(db, [target.ref]),
      readOutputReferences(db, [target.ref]),
    ]);
    const [tagConnectedRecipes, relatedUnparsed] = await Promise.all([
      readTagInputReferences(db, itemTags),
      readRelatedUnparsed(db, [target.ref, ...itemTags]),
    ]);
    const allReferences = [
      ...recipeRefsAsInput,
      ...recipeRefsAsOutput,
      ...tagConnectedRecipes,
      ...relatedUnparsed,
    ];

    return {
      target,
      recipeRefsAsInput,
      recipeRefsAsOutput,
      tagConnectedRecipes,
      isBlock: item?.isBlock ?? false,
      crossMod: computeCrossMod([item?.modid ?? modidFromRef(target.ref)], allReferences),
      relatedUnparsed,
    };
  }

  const tagMembers = await readTagMembers(db, target.ref);
  const memberItemIds = tagMembers.map(member => member.itemId);
  const [tagInputReferences, memberInputReferences, memberOutputReferences, relatedUnparsed] = await Promise.all([
    readTagInputReferences(db, [target.ref]),
    readDirectInputReferences(db, memberItemIds),
    readOutputReferences(db, memberItemIds),
    readRelatedUnparsed(db, [target.ref, ...memberItemIds]),
  ]);
  const tagConnectedRecipes = dedupeReferences([
    ...tagInputReferences,
    ...memberInputReferences,
    ...memberOutputReferences,
  ]);
  const allReferences = [
    ...tagConnectedRecipes,
    ...relatedUnparsed,
  ];

  return {
    target,
    recipeRefsAsInput: tagInputReferences,
    recipeRefsAsOutput: memberOutputReferences,
    tagConnectedRecipes,
    isBlock: tagMembers.some(member => member.isBlock),
    crossMod: computeCrossMod(tagMembers.map(member => member.modid), allReferences),
    relatedUnparsed,
  };
}

export function classifyRisk(
  blast: BlastRadius,
  options: ClassifyRiskOptions = {}
): BlastRiskClassification {
  const reasons: string[] = [];

  if (options.action === 'remove') {
    reasons.push('删除目标会影响已有引用，必须人工确认。');
  }

  if (options.action === 'retag' || blast.target.kind === 'tag') {
    reasons.push('tag 变更会影响所有引用该 tag 的配方。');
  }

  if (blast.crossMod) {
    reasons.push('引用横跨多个 mod，必须人工确认影响范围。');
  }

  if (blast.isBlock) {
    reasons.push('目标包含可放置方块，按世界已放置风险保守搁置。');
  }

  if (blast.relatedUnparsed.length > 0) {
    reasons.push('存在相关未结构化配方，不能静默改写。');
  }

  let severity: BlastRiskSeverity = 'info';
  if (blast.relatedUnparsed.length > 0 || blast.isBlock || options.action === 'remove') {
    severity = 'high';
  } else if (blast.crossMod || options.action === 'retag' || blast.target.kind === 'tag') {
    severity = 'medium';
  } else if (
    blast.recipeRefsAsInput.length > 0 ||
    blast.recipeRefsAsOutput.length > 0 ||
    blast.tagConnectedRecipes.length > 0
  ) {
    severity = 'low';
  }

  return {
    severity,
    mustDefer: reasons.length > 0,
    reasons,
  };
}
