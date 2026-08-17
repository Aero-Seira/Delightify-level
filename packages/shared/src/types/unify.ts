/**
 * Unify query types - MVP-0
 */

import type { ProjectCapabilities } from './mod';

export interface UnifyQueryParams {
  query: string;
  lang?: string;
  limit?: number;
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
