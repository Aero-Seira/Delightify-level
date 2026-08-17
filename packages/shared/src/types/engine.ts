/**
 * 通用动作引擎类型 - M2
 */

export type ChangeOperationKind =
  | 'replace_recipe_input_item'
  | 'replace_recipe_output_item'
  | 'remove_recipe'
  | 'retag_add'
  | 'retag_remove'
  | 'rename_lang'
  | 'scale_recipe_field'
  | 'hide_in_jei'
  | 'tag_input_reference'
  | 'raw_unparsed_reference';

export interface ChangeOperation {
  operationId: string;
  decisionId: string;
  kind: ChangeOperationKind;
  recipeId?: string;
  typeId?: string;
  modid?: string;
  slot?: number;
  before: Record<string, unknown>;
  after?: Record<string, unknown>;
  includedInChangeSet: boolean;
  reason?: string;
}

export type ChangeSet = ChangeOperation[];

export interface DeferredSuggestion {
  kind: 'change_recipe_type' | 'add_bridge_recipe' | 'naming_style' | 'add_item' | 'remove_item';
  target?: Record<string, unknown>;
  reason: string;
  references?: unknown[];
}

export interface CompositeResult {
  operations: ChangeOperation[];
  deferredSuggestions: DeferredSuggestion[];
  blast?: unknown;
}

export type DecisionStatus = 'target' | 'auto' | 'deferred';

export type ActionRequestAction =
  | 'replace'
  | 'retag'
  | 'remove'
  | 'rename'
  | 'scale'
  | 'hide'
  | 'unify'
  | 'differentiate'
  | 'harmonize'
  | 'constrain_inputs';

export interface ActionRequest {
  action: ActionRequestAction;
  params: Record<string, unknown>;
  scope?: Record<string, unknown>;
}

export interface EngineActionRequest {
  action: ActionRequestAction;
  params: Record<string, unknown>;
}

export interface EngineRiskSummary {
  severity: 'info' | 'low' | 'medium' | 'high';
  mustDefer: boolean;
  reasons: string[];
}

export interface EngineBlastSummary {
  target?: {
    kind: 'item' | 'tag';
    ref: string;
  };
  inputRefs: {
    recipeId: string;
    typeId: string;
    modid: string;
    slot?: number;
  }[];
  outputRefs: {
    recipeId: string;
    typeId: string;
    modid: string;
    slot?: number;
  }[];
  tagConnected: {
    recipeId: string;
    typeId: string;
    modid: string;
  }[];
  relatedUnparsed: {
    recipeId: string;
    typeId: string;
    modid: string;
  }[];
  isBlock: boolean;
  crossMod: boolean;
  counts: {
    inputRefs: number;
    outputRefs: number;
    tagConnected: number;
    relatedUnparsed: number;
  };
}

export interface EngineScaleClassification {
  operationId: string;
  recipeId: string;
  field: string;
  decision: string;
  baseline?: number;
  computed?: number;
  reason: string;
}

export interface EngineDryRunResult {
  action: ActionRequestAction;
  operations: ChangeOperation[];
  changeSetPreview: ChangeOperation[];
  deferredSuggestions: DeferredSuggestion[];
  scaleClassifications?: EngineScaleClassification[];
  risk: EngineRiskSummary;
  blast: EngineBlastSummary[];
}
