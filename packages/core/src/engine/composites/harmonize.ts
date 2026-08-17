import type { Client } from '@libsql/client';
import type { ChangeOperation, CompositeResult, DeferredSuggestion } from '../ir';
import type { BlastRadiusTarget } from '../blast-radius';
import type { ReplacePlanResult } from '../actions/replace';
import { planReplace } from '../actions/replace';

export interface HarmonizeOutlierReplace {
  from: BlastRadiusTarget;
  to: BlastRadiusTarget;
  scope: 'input' | 'output' | 'both';
}

export interface HarmonizeRecipeTypeChange {
  recipeId: string;
  fromType: string;
  toType: string;
}

export interface HarmonizeRequest {
  outlierReplaces: HarmonizeOutlierReplace[];
  recipeTypeChanges?: HarmonizeRecipeTypeChange[];
  confirmedOperationIds?: string[];
}

export interface HarmonizeBlast {
  replace: ReplacePlanResult[];
}

function recipeTypeSuggestion(change: HarmonizeRecipeTypeChange): DeferredSuggestion {
  return {
    kind: 'change_recipe_type',
    target: {
      recipeId: change.recipeId,
      fromType: change.fromType,
      toType: change.toType,
    },
    reason: '配方类型变更属于 M5/输出层能力，本阶段只记录建议，不执行。',
    references: [change],
  };
}

export async function planHarmonize(
  db: Client,
  req: HarmonizeRequest
): Promise<CompositeResult> {
  const operations: ChangeOperation[] = [];
  const replacePlans: ReplacePlanResult[] = [];

  for (const replace of req.outlierReplaces) {
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
    deferredSuggestions: (req.recipeTypeChanges ?? []).map(recipeTypeSuggestion),
    blast: {
      replace: replacePlans,
    } satisfies HarmonizeBlast,
  };
}
