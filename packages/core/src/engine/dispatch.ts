import * as path from 'path';
import type {
  ActionRequestAction,
  ChangeOperation,
  DeferredSuggestion,
  EngineActionRequest,
  EngineBlastSummary,
  EngineDryRunResult,
  EngineRiskSummary,
  EngineScaleClassification,
} from '@delightify/shared';
import { createProjectDbClient } from '../database/client';
import {
  computeBlastRadius,
  type BlastRadius,
  type BlastRadiusTarget,
  type BlastRecipeReference,
  type BlastRiskClassification,
} from './blast-radius';
import { planHide, type HidePlanRequest } from './actions/hide';
import { planRemoveRecipe, type RemoveRecipePlanRequest } from './actions/remove';
import { planRename, type RenamePlanItem, type RenamePlanRequest } from './actions/rename';
import { planReplace, type ReplacePlanRequest } from './actions/replace';
import { planRetag, type RetagPlanRequest } from './actions/retag';
import { planScale, type ScaleClassification, type ScalePlanRequest } from './actions/scale';
import {
  planConstrainInputs,
  type ConstrainInputsBridgeSuggestion,
  type ConstrainInputsRequest,
} from './composites/constrain-inputs';
import {
  planDifferentiate,
  type DifferentiateChainReplace,
  type DifferentiateGroupItem,
  type DifferentiateRequest,
} from './composites/differentiate';
import {
  planHarmonize,
  type HarmonizeOutlierReplace,
  type HarmonizeRecipeTypeChange,
  type HarmonizeRequest,
} from './composites/harmonize';

type UnknownRecord = Record<string, unknown>;

interface NormalizablePlanResult {
  operations: ChangeOperation[];
  deferredSuggestions?: DeferredSuggestion[];
  classifications?: ScaleClassification[];
}

const RISK_SEVERITY_RANK: Record<EngineRiskSummary['severity'], number> = {
  info: 1,
  low: 2,
  medium: 3,
  high: 4,
};

function projectDbPath(projectPath: string): string {
  return path.join(projectPath, '.delightify', 'project.db');
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new Error(`${field} 必须是对象。`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} 必须是非空字符串。`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requireString(value, field);
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} 必须是字符串数组。`);
  }
  return value.map((entry, index) => requireString(entry, `${field}[${index}]`));
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requireStringArray(value, field);
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} 必须是有限数字。`);
  }
  return value;
}

function requireTarget(value: unknown, field: string): BlastRadiusTarget {
  const record = requireRecord(value, field);
  const kind = requireString(record.kind, `${field}.kind`);
  if (kind !== 'item' && kind !== 'tag') {
    throw new Error(`${field}.kind 必须是 item 或 tag。`);
  }
  return {
    kind,
    ref: requireString(record.ref, `${field}.ref`),
  };
}

function requireScope(value: unknown, field: string): ReplacePlanRequest['scope'] {
  const scope = requireString(value, field);
  if (scope !== 'input' && scope !== 'output' && scope !== 'both') {
    throw new Error(`${field} 必须是 input、output 或 both。`);
  }
  return scope;
}

function appendConfirmedOperationIds<T extends object>(
  target: T,
  params: UnknownRecord
): T {
  const confirmedOperationIds = optionalStringArray(
    params.confirmedOperationIds,
    'params.confirmedOperationIds'
  );
  if (confirmedOperationIds) {
    (target as T & { confirmedOperationIds?: string[] }).confirmedOperationIds = confirmedOperationIds;
  }
  return target;
}

function normalizeRetagParams(params: UnknownRecord): RetagPlanRequest {
  const op = requireString(params.op, 'params.op');
  if (op !== 'add' && op !== 'remove') {
    throw new Error('params.op 必须是 add 或 remove。');
  }

  return appendConfirmedOperationIds({
    items: requireStringArray(params.items, 'params.items'),
    tag: requireString(params.tag, 'params.tag'),
    op,
  }, params);
}

function normalizeRemoveParams(params: UnknownRecord): RemoveRecipePlanRequest {
  return appendConfirmedOperationIds({
    recipeIds: requireStringArray(params.recipeIds, 'params.recipeIds'),
  }, params);
}

function normalizeFilter(value: unknown): ReplacePlanRequest['filter'] {
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = requireRecord(value, 'params.filter');
  const filter: NonNullable<ReplacePlanRequest['filter']> = {};
  const typeId = optionalString(record.typeId, 'params.filter.typeId');
  const modid = optionalString(record.modid, 'params.filter.modid');
  if (typeId) {
    filter.typeId = typeId;
  }
  if (modid) {
    filter.modid = modid;
  }
  return filter;
}

function normalizeReplaceParams(params: UnknownRecord): ReplacePlanRequest {
  const request: ReplacePlanRequest = appendConfirmedOperationIds({
    from: requireTarget(params.from, 'params.from'),
    to: requireTarget(params.to, 'params.to'),
    scope: requireScope(params.scope, 'params.scope'),
  }, params);
  const filter = normalizeFilter(params.filter);
  if (filter) {
    request.filter = filter;
  }
  return request;
}

function normalizeRenameItem(value: unknown, field: string): RenamePlanItem {
  const record = requireRecord(value, field);
  return {
    item: requireString(record.item, `${field}.item`),
    locale: requireString(record.locale, `${field}.locale`),
    newName: requireString(record.newName, `${field}.newName`),
  };
}

function normalizeRenameParams(params: UnknownRecord): RenamePlanRequest {
  if (!Array.isArray(params.items)) {
    throw new Error('params.items 必须是 rename 项数组。');
  }
  return {
    items: params.items.map((item, index) => normalizeRenameItem(item, `params.items[${index}]`)),
  };
}

function normalizeClamp(value: unknown): ScalePlanRequest['clamp'] {
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = requireRecord(value, 'params.clamp');
  const clamp: NonNullable<ScalePlanRequest['clamp']> = {};
  const min = optionalNumber(record.min, 'params.clamp.min');
  const max = optionalNumber(record.max, 'params.clamp.max');
  if (min !== undefined) {
    clamp.min = min;
  }
  if (max !== undefined) {
    clamp.max = max;
  }
  return clamp;
}

function normalizeRound(value: unknown): ScalePlanRequest['round'] {
  if (value === undefined || value === null) {
    return undefined;
  }
  const round = requireString(value, 'params.round');
  if (round !== 'floor' && round !== 'round' && round !== 'ceil') {
    throw new Error('params.round 必须是 floor、round 或 ceil。');
  }
  return round;
}

function normalizeScaleParams(params: UnknownRecord): ScalePlanRequest {
  const request: ScalePlanRequest = appendConfirmedOperationIds({
    recipeIds: requireStringArray(params.recipeIds, 'params.recipeIds'),
    field: requireString(params.field, 'params.field'),
  }, params);
  const factor = optionalNumber(params.factor, 'params.factor');
  const delta = optionalNumber(params.delta, 'params.delta');
  const clamp = normalizeClamp(params.clamp);
  const round = normalizeRound(params.round);

  if (factor !== undefined) {
    request.factor = factor;
  }
  if (delta !== undefined) {
    request.delta = delta;
  }
  if (clamp) {
    request.clamp = clamp;
  }
  if (round) {
    request.round = round;
  }

  return request;
}

function normalizeHideParams(params: UnknownRecord): HidePlanRequest {
  return appendConfirmedOperationIds({
    items: requireStringArray(params.items, 'params.items'),
  }, params);
}

function normalizeBridgeSuggestion(value: unknown, field: string): ConstrainInputsBridgeSuggestion {
  const record = requireRecord(value, field);
  return {
    from: requireString(record.from, `${field}.from`),
    to: requireString(record.to, `${field}.to`),
  };
}

function normalizeConstrainInputsParams(params: UnknownRecord): ConstrainInputsRequest {
  const request: ConstrainInputsRequest = appendConfirmedOperationIds({
    slotTag: requireString(params.slotTag, 'params.slotTag'),
  }, params);
  const allow = optionalStringArray(params.allow, 'params.allow');
  const deny = optionalStringArray(params.deny, 'params.deny');
  if (allow) {
    request.allow = allow;
  }
  if (deny) {
    request.deny = deny;
  }
  if (params.bridgeSuggestions !== undefined && params.bridgeSuggestions !== null) {
    if (!Array.isArray(params.bridgeSuggestions)) {
      throw new Error('params.bridgeSuggestions 必须是数组。');
    }
    request.bridgeSuggestions = params.bridgeSuggestions.map((suggestion, index) => (
      normalizeBridgeSuggestion(suggestion, `params.bridgeSuggestions[${index}]`)
    ));
  }
  return request;
}

function normalizeVariantNames(value: unknown, field: string): DifferentiateGroupItem['variantName'] {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} 必须是数组。`);
  }
  return value.map((entry, index) => {
    const record = requireRecord(entry, `${field}[${index}]`);
    return {
      locale: requireString(record.locale, `${field}[${index}].locale`),
      newName: requireString(record.newName, `${field}[${index}].newName`),
    };
  });
}

function normalizeDifferentiateGroupItem(value: unknown, field: string): DifferentiateGroupItem {
  const record = requireRecord(value, field);
  const item: DifferentiateGroupItem = {
    item: requireString(record.item, `${field}.item`),
  };
  const subTag = optionalString(record.subTag, `${field}.subTag`);
  const variantName = normalizeVariantNames(record.variantName, `${field}.variantName`);
  if (subTag) {
    item.subTag = subTag;
  }
  if (variantName) {
    item.variantName = variantName;
  }
  return item;
}

function normalizeChainReplace(value: unknown, field: string): DifferentiateChainReplace {
  const record = requireRecord(value, field);
  return {
    from: requireTarget(record.from, `${field}.from`),
    to: requireTarget(record.to, `${field}.to`),
    scope: requireScope(record.scope, `${field}.scope`),
  };
}

function normalizeDifferentiateParams(params: UnknownRecord): DifferentiateRequest {
  if (!Array.isArray(params.group)) {
    throw new Error('params.group 必须是数组。');
  }
  const request: DifferentiateRequest = appendConfirmedOperationIds({
    group: params.group.map((entry, index) => (
      normalizeDifferentiateGroupItem(entry, `params.group[${index}]`)
    )),
  }, params);

  if (params.chainReplaces !== undefined && params.chainReplaces !== null) {
    if (!Array.isArray(params.chainReplaces)) {
      throw new Error('params.chainReplaces 必须是数组。');
    }
    request.chainReplaces = params.chainReplaces.map((entry, index) => (
      normalizeChainReplace(entry, `params.chainReplaces[${index}]`)
    ));
  }
  return request;
}

function normalizeOutlierReplace(value: unknown, field: string): HarmonizeOutlierReplace {
  const record = requireRecord(value, field);
  return {
    from: requireTarget(record.from, `${field}.from`),
    to: requireTarget(record.to, `${field}.to`),
    scope: requireScope(record.scope, `${field}.scope`),
  };
}

function normalizeRecipeTypeChange(value: unknown, field: string): HarmonizeRecipeTypeChange {
  const record = requireRecord(value, field);
  return {
    recipeId: requireString(record.recipeId, `${field}.recipeId`),
    fromType: requireString(record.fromType, `${field}.fromType`),
    toType: requireString(record.toType, `${field}.toType`),
  };
}

function normalizeHarmonizeParams(params: UnknownRecord): HarmonizeRequest {
  if (!Array.isArray(params.outlierReplaces)) {
    throw new Error('params.outlierReplaces 必须是数组。');
  }
  const request: HarmonizeRequest = appendConfirmedOperationIds({
    outlierReplaces: params.outlierReplaces.map((entry, index) => (
      normalizeOutlierReplace(entry, `params.outlierReplaces[${index}]`)
    )),
  }, params);

  if (params.recipeTypeChanges !== undefined && params.recipeTypeChanges !== null) {
    if (!Array.isArray(params.recipeTypeChanges)) {
      throw new Error('params.recipeTypeChanges 必须是数组。');
    }
    request.recipeTypeChanges = params.recipeTypeChanges.map((entry, index) => (
      normalizeRecipeTypeChange(entry, `params.recipeTypeChanges[${index}]`)
    ));
  }
  return request;
}

function summarizeReference(reference: BlastRecipeReference): {
  recipeId: string;
  typeId: string;
  modid: string;
  slot?: number;
} {
  return {
    recipeId: reference.recipeId,
    typeId: reference.typeId,
    modid: reference.modid,
    slot: reference.slot,
  };
}

export function summarizeBlastRadius(blast: BlastRadius): EngineBlastSummary {
  return {
    target: blast.target,
    inputRefs: blast.recipeRefsAsInput.map(summarizeReference),
    outputRefs: blast.recipeRefsAsOutput.map(summarizeReference),
    tagConnected: blast.tagConnectedRecipes.map(reference => ({
      recipeId: reference.recipeId,
      typeId: reference.typeId,
      modid: reference.modid,
    })),
    relatedUnparsed: blast.relatedUnparsed.map(reference => ({
      recipeId: reference.recipeId,
      typeId: reference.typeId,
      modid: reference.modid,
    })),
    isBlock: blast.isBlock,
    crossMod: blast.crossMod,
    counts: {
      inputRefs: blast.recipeRefsAsInput.length,
      outputRefs: blast.recipeRefsAsOutput.length,
      tagConnected: blast.tagConnectedRecipes.length,
      relatedUnparsed: blast.relatedUnparsed.length,
    },
  };
}

function summarizeRisk(risk: BlastRiskClassification): EngineRiskSummary {
  return {
    severity: risk.severity,
    mustDefer: risk.mustDefer,
    reasons: [...risk.reasons],
  };
}

function isBlastRadius(value: unknown): value is BlastRadius {
  if (!isRecord(value) || !isRecord(value.target)) {
    return false;
  }
  return (
    (value.target.kind === 'item' || value.target.kind === 'tag') &&
    typeof value.target.ref === 'string' &&
    Array.isArray(value.recipeRefsAsInput) &&
    Array.isArray(value.recipeRefsAsOutput) &&
    Array.isArray(value.tagConnectedRecipes) &&
    Array.isArray(value.relatedUnparsed) &&
    typeof value.isBlock === 'boolean' &&
    typeof value.crossMod === 'boolean'
  );
}

function collectBlastRadii(value: unknown, seen = new WeakSet<object>()): BlastRadius[] {
  if (isBlastRadius(value)) {
    return [value];
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap(entry => collectBlastRadii(entry, seen));
  }

  const record = value as UnknownRecord;
  if (record.blast !== undefined) {
    return collectBlastRadii(record.blast, seen);
  }

  return Object.values(record).flatMap(entry => collectBlastRadii(entry, seen));
}

function isRiskClassification(value: unknown): value is BlastRiskClassification {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.severity === 'info' ||
      value.severity === 'low' ||
      value.severity === 'medium' ||
      value.severity === 'high') &&
    typeof value.mustDefer === 'boolean' &&
    Array.isArray(value.reasons) &&
    value.reasons.every(reason => typeof reason === 'string')
  );
}

function collectRiskSummaries(value: unknown, seen = new WeakSet<object>()): EngineRiskSummary[] {
  if (isRiskClassification(value)) {
    return [summarizeRisk(value)];
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap(entry => collectRiskSummaries(entry, seen));
  }

  const record = value as UnknownRecord;
  const direct = isRiskClassification(record.risk) ? [summarizeRisk(record.risk)] : [];
  const nested = Object.entries(record)
    .filter(([key]) => key !== 'risk' && key !== 'operations')
    .flatMap(([, entry]) => collectRiskSummaries(entry, seen));
  return [...direct, ...nested];
}

function mergeRiskSummaries(risks: EngineRiskSummary[]): EngineRiskSummary {
  if (risks.length === 0) {
    return {
      severity: 'info',
      mustDefer: false,
      reasons: [],
    };
  }

  const severity = risks.reduce<EngineRiskSummary['severity']>((highest, risk) => (
    RISK_SEVERITY_RANK[risk.severity] > RISK_SEVERITY_RANK[highest]
      ? risk.severity
      : highest
  ), 'info');
  const reasons = Array.from(new Set(risks.flatMap(risk => risk.reasons)));

  return {
    severity,
    mustDefer: risks.some(risk => risk.mustDefer),
    reasons,
  };
}

function normalizeScaleClassifications(
  classifications: ScaleClassification[] | undefined
): EngineScaleClassification[] | undefined {
  if (!classifications) {
    return undefined;
  }
  return classifications.map(classification => ({
    operationId: classification.operationId,
    recipeId: classification.recipeId,
    field: classification.field,
    decision: classification.decision,
    baseline: classification.baseline,
    computed: classification.computed,
    reason: classification.reason,
  }));
}

function normalizePlanResult(
  action: ActionRequestAction,
  result: NormalizablePlanResult
): EngineDryRunResult {
  const dryRunResult: EngineDryRunResult = {
    action,
    operations: result.operations,
    changeSetPreview: result.operations.filter(operation => operation.includedInChangeSet),
    deferredSuggestions: result.deferredSuggestions ?? [],
    risk: mergeRiskSummaries(collectRiskSummaries(result)),
    blast: collectBlastRadii(result).map(summarizeBlastRadius),
  };

  if (action === 'scale') {
    dryRunResult.scaleClassifications = normalizeScaleClassifications(result.classifications) ?? [];
  }

  return dryRunResult;
}

export async function planEngineAction(
  projectPath: string,
  req: EngineActionRequest
): Promise<EngineDryRunResult> {
  const params = requireRecord(req.params, 'params');
  const db = createProjectDbClient(projectDbPath(projectPath));

  switch (req.action) {
    case 'retag':
      return normalizePlanResult(req.action, await planRetag(db, normalizeRetagParams(params)));
    case 'remove':
      return normalizePlanResult(req.action, await planRemoveRecipe(db, normalizeRemoveParams(params)));
    case 'replace':
      return normalizePlanResult(req.action, await planReplace(db, normalizeReplaceParams(params)));
    case 'rename':
      return normalizePlanResult(req.action, await planRename(db, normalizeRenameParams(params)));
    case 'scale':
      return normalizePlanResult(req.action, await planScale(db, normalizeScaleParams(params)));
    case 'hide':
      return normalizePlanResult(req.action, await planHide(db, normalizeHideParams(params)));
    case 'constrain_inputs':
      return normalizePlanResult(
        req.action,
        await planConstrainInputs(db, normalizeConstrainInputsParams(params))
      );
    case 'differentiate':
      return normalizePlanResult(req.action, await planDifferentiate(db, normalizeDifferentiateParams(params)));
    case 'harmonize':
      return normalizePlanResult(req.action, await planHarmonize(db, normalizeHarmonizeParams(params)));
    default:
      throw new Error(`未知或未接入的 engine action: ${String(req.action)}`);
  }
}

export async function planEngineBlast(
  projectPath: string,
  target: BlastRadiusTarget
): Promise<EngineBlastSummary> {
  const db = createProjectDbClient(projectDbPath(projectPath));
  const blast = await computeBlastRadius(db, target);
  return summarizeBlastRadius(blast);
}
