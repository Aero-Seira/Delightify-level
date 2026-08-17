import type { Client } from '@libsql/client';
import type { ChangeOperation, CompositeResult, DeferredSuggestion } from '../ir';
import type { RetagPlanResult } from '../actions/retag';
import type { ReplacePlanResult } from '../actions/replace';
import { planRetag } from '../actions/retag';
import { planReplace } from '../actions/replace';

type DbRow = Record<string, unknown>;

export interface ConstrainInputsBridgeSuggestion {
  from: string;
  to: string;
}

export interface ConstrainInputsRequest {
  slotTag: string;
  allow?: string[];
  deny?: string[];
  bridgeSuggestions?: ConstrainInputsBridgeSuggestion[];
  confirmedOperationIds?: string[];
}

export interface ConstrainInputsBlast {
  replace: ReplacePlanResult[];
  retag: RetagPlanResult[];
}

function uniqueSorted(values: string[] | undefined): string[] {
  return Array.from(new Set(values ?? [])).sort();
}

async function readTagMembers(db: Client, tag: string): Promise<string[]> {
  const result = await db.execute({
    sql: `
      SELECT item_id
      FROM item_tags
      WHERE tag_id = ?
      ORDER BY item_id
    `,
    args: [tag],
  });

  return (result.rows as DbRow[]).map(row => String(row.item_id));
}

function bridgeSuggestion(
  slotTag: string,
  suggestion: ConstrainInputsBridgeSuggestion
): DeferredSuggestion {
  return {
    kind: 'add_bridge_recipe',
    target: {
      slotTag,
      from: suggestion.from,
      to: suggestion.to,
    },
    reason: '桥接配方属于 M5 新增内容，本阶段只记录建议，不执行。',
    references: [suggestion],
  };
}

export async function planConstrainInputs(
  db: Client,
  req: ConstrainInputsRequest
): Promise<CompositeResult> {
  const tagMembers = await readTagMembers(db, req.slotTag);
  const allow = uniqueSorted(req.allow);
  const deny = uniqueSorted(req.deny);
  const allowSet = new Set(allow);
  const denySet = new Set(deny);
  const operations: ChangeOperation[] = [];
  const replacePlans: ReplacePlanResult[] = [];
  const retagPlans: RetagPlanResult[] = [];

  if (allow.length === 1 && !denySet.has(allow[0])) {
    const replacePlan = await planReplace(db, {
      from: { kind: 'tag', ref: req.slotTag },
      to: { kind: 'item', ref: allow[0] },
      scope: 'input',
      confirmedOperationIds: req.confirmedOperationIds,
    });
    replacePlans.push(replacePlan);
    operations.push(...replacePlan.operations);
  }

  const removeItems = new Set<string>();
  if (req.allow) {
    for (const item of tagMembers) {
      if (!allowSet.has(item)) {
        removeItems.add(item);
      }
    }
  }
  for (const item of deny) {
    removeItems.add(item);
  }

  const addItems = req.allow
    ? allow.filter(item => !tagMembers.includes(item) && !denySet.has(item))
    : [];

  if (removeItems.size > 0) {
    const retagRemovePlan = await planRetag(db, {
      items: [...removeItems],
      tag: req.slotTag,
      op: 'remove',
      confirmedOperationIds: req.confirmedOperationIds,
    });
    retagPlans.push(retagRemovePlan);
    operations.push(...retagRemovePlan.operations);
  }

  if (addItems.length > 0) {
    const retagAddPlan = await planRetag(db, {
      items: addItems,
      tag: req.slotTag,
      op: 'add',
      confirmedOperationIds: req.confirmedOperationIds,
    });
    retagPlans.push(retagAddPlan);
    operations.push(...retagAddPlan.operations);
  }

  return {
    operations,
    deferredSuggestions: (req.bridgeSuggestions ?? []).map(suggestion => bridgeSuggestion(req.slotTag, suggestion)),
    blast: {
      replace: replacePlans,
      retag: retagPlans,
    } satisfies ConstrainInputsBlast,
  };
}
