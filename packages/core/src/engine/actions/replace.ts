import type { Client } from '@libsql/client';
import type { ChangeOperation } from '../ir';
import {
  classifyRisk,
  computeBlastRadius,
  type BlastRadius,
  type BlastRecipeReference,
  type BlastRiskClassification,
  type BlastRiskSeverity,
  type BlastRadiusTarget,
} from '../blast-radius';

export interface ReplacePlanRequest {
  from: BlastRadiusTarget;
  to: BlastRadiusTarget;
  scope: 'input' | 'output' | 'both';
  filter?: {
    typeId?: string;
    modid?: string;
  };
  confirmedOperationIds?: string[];
}

export interface ReplacePlanResult {
  operations: ChangeOperation[];
  blast: BlastRadius;
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

function isLowRisk(risk: BlastRiskClassification): boolean {
  return severityRank(risk.severity) <= severityRank('low');
}

function matchesFilter(reference: BlastRecipeReference, filter: ReplacePlanRequest['filter']): boolean {
  if (!filter) {
    return true;
  }
  if (filter.typeId && reference.typeId !== filter.typeId) {
    return false;
  }
  if (filter.modid && reference.modid !== filter.modid) {
    return false;
  }
  return true;
}

function inputAutoReason(risk: BlastRiskClassification, blast: BlastRadius): string {
  const reasons = [...risk.reasons];

  if (blast.recipeRefsAsOutput.length > 0) {
    reasons.push('目标同时作为配方产物出现，不能自动替换输入。');
  }

  if (blast.relatedUnparsed.length > 0 && !reasons.some(reason => reason.includes('未结构化'))) {
    reasons.push('存在相关未结构化配方，不能自动替换输入。');
  }

  if (blast.isBlock && !reasons.some(reason => reason.includes('方块'))) {
    reasons.push('目标包含可放置方块，不能自动替换输入。');
  }

  if (blast.crossMod && !reasons.some(reason => reason.includes('跨多个 mod'))) {
    reasons.push('引用横跨多个 mod，不能自动替换输入。');
  }

  return reasons.join('；') || '输入替换未满足低风险自动判据。';
}

function canAutoInput(risk: BlastRiskClassification, blast: BlastRadius): boolean {
  return (
    isLowRisk(risk) &&
    blast.recipeRefsAsOutput.length === 0 &&
    blast.relatedUnparsed.length === 0 &&
    !blast.isBlock &&
    !blast.crossMod
  );
}

function forceDeferredReasons(blast: BlastRadius): string[] {
  const reasons: string[] = [];

  if (blast.crossMod) {
    reasons.push('引用横跨多个 mod，确认不能覆盖。');
  }

  if (blast.relatedUnparsed.length > 0) {
    reasons.push('存在相关未结构化配方，确认不能覆盖。');
  }

  if (blast.isBlock) {
    reasons.push('目标包含可放置方块，确认不能覆盖。');
  }

  return reasons;
}

function inputOperationReason(
  includedInChangeSet: boolean,
  requestedConfirm: boolean,
  risk: BlastRiskClassification,
  blast: BlastRadius,
  forcedReasons: string[]
): string | undefined {
  if (includedInChangeSet) {
    return undefined;
  }

  if (forcedReasons.length > 0) {
    const prefix = requestedConfirm ? '已请求确认，但存在强风险项：' : '存在强风险项：';
    return `${prefix}${forcedReasons.join('；')}`;
  }

  return inputAutoReason(risk, blast);
}

function replaceOperationId(
  scope: 'input' | 'output',
  from: BlastRadiusTarget,
  to: BlastRadiusTarget,
  reference: BlastRecipeReference
): string {
  return [
    'replace',
    scope,
    `${from.kind}:${from.ref}`,
    `${to.kind}:${to.ref}`,
    reference.recipeId,
    reference.slot ?? '',
    reference.role ?? '',
  ].join(':');
}

function inputOperation(
  from: BlastRadiusTarget,
  to: BlastRadiusTarget,
  reference: BlastRecipeReference,
  includedInChangeSet: boolean,
  reason: string | undefined
): ChangeOperation {
  return {
    operationId: replaceOperationId('input', from, to, reference),
    decisionId: `replace:input:${from.kind}:${from.ref}->${to.kind}:${to.ref}`,
    kind: 'replace_recipe_input_item',
    recipeId: reference.recipeId,
    typeId: reference.typeId,
    modid: reference.modid,
    slot: reference.slot,
    before: {
      kind: from.kind,
      ref: reference.ref ?? from.ref,
      count: reference.count ?? 1,
    },
    after: {
      kind: to.kind,
      ref: to.ref,
      count: reference.count ?? 1,
    },
    includedInChangeSet,
    reason,
  };
}

function outputOperation(
  from: BlastRadiusTarget,
  to: BlastRadiusTarget,
  reference: BlastRecipeReference,
  requestedConfirm: boolean
): ChangeOperation {
  const reason = requestedConfirm
    ? '已请求确认，但输出替换需要人工审阅，确认不能覆盖。'
    : '输出替换需要人工审阅，未验证 replaceOutput 语义';

  return {
    operationId: replaceOperationId('output', from, to, reference),
    decisionId: `replace:output:${from.kind}:${from.ref}->${to.kind}:${to.ref}`,
    kind: 'replace_recipe_output_item',
    recipeId: reference.recipeId,
    typeId: reference.typeId,
    modid: reference.modid,
    slot: reference.slot,
    before: {
      kind: from.kind,
      ref: reference.ref ?? from.ref,
      count: reference.count ?? 1,
      componentsJson: reference.componentsJson,
    },
    after: {
      kind: to.kind,
      ref: to.ref,
      count: reference.count ?? 1,
      componentsJson: reference.componentsJson,
    },
    includedInChangeSet: false,
    reason,
  };
}

export async function planReplace(db: Client, req: ReplacePlanRequest): Promise<ReplacePlanResult> {
  const blast = await computeBlastRadius(db, req.from);
  const risk = classifyRisk(blast, { action: 'replace' });
  const confirmed = new Set(req.confirmedOperationIds ?? []);
  const forcedReasons = forceDeferredReasons(blast);
  const forceDeferredInput = forcedReasons.length > 0;
  const operations: ChangeOperation[] = [];
  const includeInput = req.scope === 'input' || req.scope === 'both';
  const includeOutput = req.scope === 'output' || req.scope === 'both';
  const autoInput = canAutoInput(risk, blast);

  if (includeInput) {
    for (const reference of blast.recipeRefsAsInput.filter(reference => matchesFilter(reference, req.filter))) {
      const operationId = replaceOperationId('input', req.from, req.to, reference);
      const requestedConfirm = confirmed.has(operationId);
      const includedInChangeSet = autoInput || (requestedConfirm && !forceDeferredInput);
      const reason = inputOperationReason(
        includedInChangeSet,
        requestedConfirm,
        risk,
        blast,
        forcedReasons
      );

      operations.push(inputOperation(req.from, req.to, reference, includedInChangeSet, reason));
    }
  }

  if (includeOutput) {
    for (const reference of blast.recipeRefsAsOutput.filter(reference => matchesFilter(reference, req.filter))) {
      const operationId = replaceOperationId('output', req.from, req.to, reference);
      operations.push(outputOperation(req.from, req.to, reference, confirmed.has(operationId)));
    }
  }

  return { operations, blast, risk };
}
