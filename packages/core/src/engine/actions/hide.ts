import type { Client } from '@libsql/client';
import type { ChangeOperation } from '../ir';
import {
  computeBlastRadius,
  type BlastRadius,
  type BlastRiskClassification,
} from '../blast-radius';

export interface HidePlanRequest {
  items: string[];
  /** 显式确认的 operation id；hide 低风险，确认后进入 changeSet。 */
  confirmedOperationIds?: string[];
}

export interface HidePlanResult {
  operations: ChangeOperation[];
  blast: BlastRadius[];
  risk: BlastRiskClassification;
}

const HIDE_DEFERRED_REASON = 'hide_in_jei 需要人工确认后才会写入 kubejs/client_scripts。';

function dedupeItems(items: string[]): string[] {
  return Array.from(new Set(items)).sort();
}

function hasReferences(blast: BlastRadius): boolean {
  return (
    blast.recipeRefsAsInput.length > 0 ||
    blast.recipeRefsAsOutput.length > 0 ||
    blast.tagConnectedRecipes.length > 0 ||
    blast.relatedUnparsed.length > 0
  );
}

function mergeHideRisk(blasts: BlastRadius[]): BlastRiskClassification {
  const referenced = blasts.some(hasReferences);

  return {
    severity: referenced ? 'low' : 'info',
    mustDefer: false,
    reasons: referenced
      ? ['hide 仅影响 JEI 显示；引用清单用于审阅，确认后发射。']
      : ['hide 仅影响 JEI 显示；确认后发射。'],
  };
}

function hideOperation(item: string, confirmed: boolean): ChangeOperation {
  return {
    operationId: `hide_in_jei:${item}`,
    decisionId: 'hide_in_jei',
    kind: 'hide_in_jei',
    before: {
      item,
    },
    includedInChangeSet: confirmed,
    reason: confirmed ? undefined : HIDE_DEFERRED_REASON,
  };
}

export async function planHide(db: Client, req: HidePlanRequest): Promise<HidePlanResult> {
  const items = dedupeItems(req.items);
  const confirmed = new Set(req.confirmedOperationIds ?? []);
  const blast = await Promise.all(items.map(item => computeBlastRadius(db, {
    kind: 'item',
    ref: item,
  })));

  return {
    operations: items.map(item => hideOperation(item, confirmed.has(`hide_in_jei:${item}`))),
    blast,
    risk: mergeHideRisk(blast),
  };
}
