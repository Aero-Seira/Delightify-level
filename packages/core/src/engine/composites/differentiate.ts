import type { Client } from '@libsql/client';
import type { ChangeOperation, CompositeResult, DeferredSuggestion } from '../ir';
import type { BlastRadiusTarget } from '../blast-radius';
import type { RenamePlanItem, RenamePlanResult } from '../actions/rename';
import type { ReplacePlanResult } from '../actions/replace';
import type { RetagPlanResult } from '../actions/retag';
import { planRename } from '../actions/rename';
import { planReplace } from '../actions/replace';
import { planRetag } from '../actions/retag';

export interface DifferentiateGroupItem {
  item: string;
  subTag?: string;
  variantName?: { locale: string; newName: string }[];
}

export interface DifferentiateChainReplace {
  from: BlastRadiusTarget;
  to: BlastRadiusTarget;
  scope: 'input' | 'output' | 'both';
}

export interface DifferentiateRequest {
  group: DifferentiateGroupItem[];
  chainReplaces?: DifferentiateChainReplace[];
  confirmedOperationIds?: string[];
}

export interface DifferentiateBlast {
  rename?: RenamePlanResult;
  retag: RetagPlanResult[];
  replace: ReplacePlanResult[];
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function collectRenameItems(group: DifferentiateGroupItem[]): RenamePlanItem[] {
  const items: RenamePlanItem[] = [];

  for (const entry of group) {
    for (const variantName of entry.variantName ?? []) {
      items.push({
        item: entry.item,
        locale: variantName.locale,
        newName: variantName.newName,
      });
    }
  }

  return items;
}

function collectSubTagItems(group: DifferentiateGroupItem[]): Map<string, string[]> {
  const itemsByTag = new Map<string, string[]>();

  for (const entry of group) {
    if (!entry.subTag) {
      continue;
    }
    const items = itemsByTag.get(entry.subTag) ?? [];
    items.push(entry.item);
    itemsByTag.set(entry.subTag, items);
  }

  return itemsByTag;
}

function namingStyleSuggestion(group: DifferentiateGroupItem[], renameItems: RenamePlanItem[]): DeferredSuggestion | null {
  if (renameItems.length === 0) {
    return null;
  }

  return {
    kind: 'naming_style',
    target: {
      items: uniqueSorted(group.map(entry => entry.item)),
      locales: uniqueSorted(renameItems.map(item => item.locale)),
    },
    reason: '变体命名风格属于作者判断，本阶段给出默认 rename，并保留人工审阅建议。',
    references: renameItems,
  };
}

export async function planDifferentiate(
  db: Client,
  req: DifferentiateRequest
): Promise<CompositeResult> {
  const operations: ChangeOperation[] = [];
  const retagPlans: RetagPlanResult[] = [];
  const replacePlans: ReplacePlanResult[] = [];
  const renameItems = collectRenameItems(req.group);
  let renamePlan: RenamePlanResult | undefined;

  if (renameItems.length > 0) {
    renamePlan = await planRename(db, { items: renameItems });
    operations.push(...renamePlan.operations);
  }

  const itemsByTag = collectSubTagItems(req.group);
  for (const tag of uniqueSorted([...itemsByTag.keys()])) {
    const retagPlan = await planRetag(db, {
      items: uniqueSorted(itemsByTag.get(tag) ?? []),
      tag,
      op: 'add',
      confirmedOperationIds: req.confirmedOperationIds,
    });
    retagPlans.push(retagPlan);
    operations.push(...retagPlan.operations);
  }

  for (const replace of req.chainReplaces ?? []) {
    const replacePlan = await planReplace(db, {
      from: replace.from,
      to: replace.to,
      scope: replace.scope,
      confirmedOperationIds: req.confirmedOperationIds,
    });
    replacePlans.push(replacePlan);
    operations.push(...replacePlan.operations);
  }

  return {
    operations,
    deferredSuggestions: [
      namingStyleSuggestion(req.group, renameItems),
    ].filter((suggestion): suggestion is DeferredSuggestion => suggestion !== null),
    blast: {
      rename: renamePlan,
      retag: retagPlans,
      replace: replacePlans,
    } satisfies DifferentiateBlast,
  };
}
