import {
  queryUnifyCandidates,
  type UnifyCandidate,
  type UnifyQueryParams,
  type UnifyRecipeReference,
  type UnifyRiskSeverity,
  type UnifyRiskSignal,
} from './query-service';

export interface UnifyDryRunParams extends UnifyQueryParams {
  targetItemId?: string;
}

export type UnifyDecisionStatus = 'target' | 'auto' | 'deferred';
export type UnifyActionType = 'keep_target' | 'replace_item_references' | 'defer_review';
export type UnifyDiffOperationKind =
  | 'replace_recipe_input_item'
  | 'replace_recipe_output_item'
  | 'tag_input_reference'
  | 'raw_unparsed_reference';

export interface UnifyDiffOperation {
  operationId: string;
  decisionId: string;
  kind: UnifyDiffOperationKind;
  recipeId: string;
  typeId: string;
  modid: string;
  slot?: number;
  before: Record<string, unknown>;
  after?: Record<string, unknown>;
  includedInChangeSet: boolean;
  reason?: string;
}

export interface UnifyAction {
  type: UnifyActionType;
  sourceItemId?: string;
  targetItemId: string;
  operationIds: string[];
}

export interface UnifyDecision {
  decisionId: string;
  status: UnifyDecisionStatus;
  sourceItemId: string;
  targetItemId: string;
  action: UnifyAction;
  confidence: number;
  evidence: string[];
  riskSignals: UnifyRiskSignal[];
  riskLevel: UnifyRiskSeverity;
  reason: string;
  diffOperationIds: string[];
}

export interface UnifyDryRunResult {
  query: string;
  normalizedQuery: string;
  lang: string;
  targetItemId: string;
  targetReason: string;
  decisions: UnifyDecision[];
  diff: UnifyDiffOperation[];
  changeSet: UnifyDiffOperation[];
  autoDecisionCount: number;
  deferredDecisionCount: number;
  generatedAt: string;
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

function itemPath(itemId: string): string {
  const separatorIndex = itemId.indexOf(':');
  return separatorIndex >= 0 ? itemId.slice(separatorIndex + 1) : itemId;
}

function referenceWeight(candidate: UnifyCandidate): number {
  return (
    candidate.references.directInputs.length +
    candidate.references.tagInputs.length +
    candidate.references.outputs.length * 2
  );
}

function chooseTarget(candidates: UnifyCandidate[], requestedTargetItemId?: string): { target: UnifyCandidate; reason: string } {
  if (candidates.length === 0) {
    throw new Error('没有可用于 dry-run 的候选物品');
  }

  if (requestedTargetItemId) {
    const target = candidates.find(candidate => candidate.item.itemId === requestedTargetItemId);
    if (!target) {
      throw new Error(`指定的目标物品不在候选集中: ${requestedTargetItemId}`);
    }
    return { target, reason: 'user_selected' };
  }

  const sorted = [...candidates].sort((a, b) => {
    const riskDiff = severityRank(a.riskLevel) - severityRank(b.riskLevel);
    if (riskDiff !== 0) return riskDiff;

    const weightDiff = referenceWeight(b) - referenceWeight(a);
    if (weightDiff !== 0) return weightDiff;

    const minecraftDiff = Number(b.item.modid === 'minecraft') - Number(a.item.modid === 'minecraft');
    if (minecraftDiff !== 0) return minecraftDiff;

    return a.item.itemId.localeCompare(b.item.itemId);
  });

  return {
    target: sorted[0],
    reason: 'lowest_risk_then_most_referenced',
  };
}

function overlapTags(source: UnifyCandidate, target: UnifyCandidate): string[] {
  const targetTags = new Set(target.item.tags);
  return source.item.tags.filter(tag => targetTags.has(tag));
}

function buildEvidence(source: UnifyCandidate, target: UnifyCandidate): string[] {
  const evidence: string[] = [];

  for (const match of source.matchedBy) {
    evidence.push(`matched_by:${match.reason}:${match.value}`);
  }

  if (itemPath(source.item.itemId) === itemPath(target.item.itemId)) {
    evidence.push(`same_item_path:${itemPath(source.item.itemId)}`);
  }

  const sharedTags = overlapTags(source, target);
  if (sharedTags.length > 0) {
    evidence.push(`shared_tags:${sharedTags.slice(0, 8).join(',')}`);
  }

  evidence.push(`direct_inputs:${source.references.directInputs.length}`);
  evidence.push(`tag_inputs:${source.references.tagInputs.length}`);
  evidence.push(`outputs:${source.references.outputs.length}`);
  evidence.push(`unparsed_related:${source.references.unparsedRaw.length}`);

  return evidence;
}

function computeConfidence(source: UnifyCandidate, target: UnifyCandidate): number {
  let confidence = 0.5;

  if (source.matchedBy.some(match => match.reason === 'display_name')) {
    confidence += 0.2;
  }
  if (itemPath(source.item.itemId) === itemPath(target.item.itemId)) {
    confidence += 0.15;
  }
  if (overlapTags(source, target).length > 0) {
    confidence += 0.1;
  }
  if (severityRank(source.riskLevel) >= severityRank('medium')) {
    confidence -= 0.2;
  }
  if (source.references.unparsedRaw.length > 0) {
    confidence -= 0.2;
  }

  return Math.max(0.05, Math.min(0.98, Number(confidence.toFixed(2))));
}

function shouldAutoApply(candidate: UnifyCandidate): boolean {
  if (severityRank(candidate.riskLevel) >= severityRank('medium')) {
    return false;
  }
  if (candidate.references.outputs.length > 0) {
    return false;
  }
  if (candidate.references.unparsedRaw.length > 0) {
    return false;
  }
  if (candidate.item.isBlock) {
    return false;
  }
  return candidate.references.directInputs.length > 0;
}

function decisionReason(status: UnifyDecisionStatus, candidate: UnifyCandidate): string {
  if (status === 'target') {
    return '保留目标物品，不生成替换操作。';
  }

  if (status === 'auto') {
    return '低风险候选，仅包含可结构化替换的直接 item 输入引用。';
  }

  const highRisk = candidate.riskSignals.find(signal => signal.severity === 'high');
  if (highRisk) {
    return highRisk.message;
  }

  const mediumRisk = candidate.riskSignals.find(signal => signal.severity === 'medium');
  if (mediumRisk) {
    return mediumRisk.message;
  }

  if (candidate.references.directInputs.length === 0) {
    return '没有可自动替换的直接 item 输入引用。';
  }

  return '需要人工确认后才能进入 change set。';
}

function operationId(decisionId: string, index: number): string {
  return `${decisionId}:op_${index + 1}`;
}

function directInputOperation(
  decisionId: string,
  index: number,
  reference: UnifyRecipeReference,
  sourceItemId: string,
  targetItemId: string,
  includedInChangeSet: boolean
): UnifyDiffOperation {
  return {
    operationId: operationId(decisionId, index),
    decisionId,
    kind: 'replace_recipe_input_item',
    recipeId: reference.recipeId,
    typeId: reference.typeId,
    modid: reference.modid,
    slot: reference.slot,
    before: {
      kind: 'item',
      ref: sourceItemId,
      count: reference.count ?? 1,
    },
    after: {
      kind: 'item',
      ref: targetItemId,
      count: reference.count ?? 1,
    },
    includedInChangeSet,
  };
}

function outputOperation(
  decisionId: string,
  index: number,
  reference: UnifyRecipeReference,
  sourceItemId: string,
  targetItemId: string,
  includedInChangeSet: boolean
): UnifyDiffOperation {
  return {
    operationId: operationId(decisionId, index),
    decisionId,
    kind: 'replace_recipe_output_item',
    recipeId: reference.recipeId,
    typeId: reference.typeId,
    modid: reference.modid,
    slot: reference.slot,
    before: {
      itemId: sourceItemId,
      count: reference.count ?? 1,
      componentsJson: reference.componentsJson,
    },
    after: {
      itemId: targetItemId,
      count: reference.count ?? 1,
      componentsJson: reference.componentsJson,
    },
    includedInChangeSet,
    reason: includedInChangeSet ? undefined : '输出替换需要人工审阅。',
  };
}

function tagInputOperation(
  decisionId: string,
  index: number,
  reference: UnifyRecipeReference
): UnifyDiffOperation {
  return {
    operationId: operationId(decisionId, index),
    decisionId,
    kind: 'tag_input_reference',
    recipeId: reference.recipeId,
    typeId: reference.typeId,
    modid: reference.modid,
    slot: reference.slot,
    before: {
      kind: 'tag',
      ref: reference.tagId || reference.ref,
      count: reference.count ?? 1,
    },
    includedInChangeSet: false,
    reason: 'tag 输入引用不在 dry-run 自动替换范围内。',
  };
}

function rawUnparsedOperation(
  decisionId: string,
  index: number,
  reference: UnifyRecipeReference
): UnifyDiffOperation {
  return {
    operationId: operationId(decisionId, index),
    decisionId,
    kind: 'raw_unparsed_reference',
    recipeId: reference.recipeId,
    typeId: reference.typeId,
    modid: reference.modid,
    before: {
      unparsed: true,
    },
    includedInChangeSet: false,
    reason: '未结构化配方不能自动 rewrite。',
  };
}

function buildDiffOperations(
  decisionId: string,
  candidate: UnifyCandidate,
  targetItemId: string,
  includeDirectInputs: boolean
): UnifyDiffOperation[] {
  const operations: UnifyDiffOperation[] = [];

  for (const reference of candidate.references.directInputs) {
    operations.push(directInputOperation(
      decisionId,
      operations.length,
      reference,
      candidate.item.itemId,
      targetItemId,
      includeDirectInputs
    ));
  }

  for (const reference of candidate.references.outputs) {
    operations.push(outputOperation(
      decisionId,
      operations.length,
      reference,
      candidate.item.itemId,
      targetItemId,
      false
    ));
  }

  for (const reference of candidate.references.tagInputs) {
    operations.push(tagInputOperation(decisionId, operations.length, reference));
  }

  for (const reference of candidate.references.unparsedRaw) {
    operations.push(rawUnparsedOperation(decisionId, operations.length, reference));
  }

  return operations;
}

export async function dryRunUnify(
  projectPath: string,
  params: UnifyDryRunParams
): Promise<UnifyDryRunResult> {
  const queryResult = await queryUnifyCandidates(projectPath, params);
  const { target, reason: targetReason } = chooseTarget(queryResult.candidates, params.targetItemId);
  const decisions: UnifyDecision[] = [];
  const diff: UnifyDiffOperation[] = [];

  for (const candidate of queryResult.candidates) {
    const decisionId = `unify:${candidate.item.itemId}->${target.item.itemId}`;

    if (candidate.item.itemId === target.item.itemId) {
      decisions.push({
        decisionId,
        status: 'target',
        sourceItemId: candidate.item.itemId,
        targetItemId: target.item.itemId,
        action: {
          type: 'keep_target',
          targetItemId: target.item.itemId,
          operationIds: [],
        },
        confidence: 1,
        evidence: buildEvidence(candidate, target),
        riskSignals: candidate.riskSignals,
        riskLevel: candidate.riskLevel,
        reason: decisionReason('target', candidate),
        diffOperationIds: [],
      });
      continue;
    }

    const status: UnifyDecisionStatus = shouldAutoApply(candidate) ? 'auto' : 'deferred';
    const operations = buildDiffOperations(
      decisionId,
      candidate,
      target.item.itemId,
      status === 'auto'
    );
    diff.push(...operations);

    decisions.push({
      decisionId,
      status,
      sourceItemId: candidate.item.itemId,
      targetItemId: target.item.itemId,
      action: {
        type: status === 'auto' ? 'replace_item_references' : 'defer_review',
        sourceItemId: candidate.item.itemId,
        targetItemId: target.item.itemId,
        operationIds: operations.filter(operation => operation.includedInChangeSet).map(operation => operation.operationId),
      },
      confidence: computeConfidence(candidate, target),
      evidence: buildEvidence(candidate, target),
      riskSignals: candidate.riskSignals,
      riskLevel: candidate.riskLevel,
      reason: decisionReason(status, candidate),
      diffOperationIds: operations.map(operation => operation.operationId),
    });
  }

  const changeSet = diff.filter(operation => operation.includedInChangeSet);

  return {
    query: queryResult.query,
    normalizedQuery: queryResult.normalizedQuery,
    lang: queryResult.lang,
    targetItemId: target.item.itemId,
    targetReason,
    decisions,
    diff,
    changeSet,
    autoDecisionCount: decisions.filter(decision => decision.status === 'auto').length,
    deferredDecisionCount: decisions.filter(decision => decision.status === 'deferred').length,
    generatedAt: new Date().toISOString(),
  };
}
