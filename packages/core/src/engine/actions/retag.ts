import type { Client } from '@libsql/client';
import type { ChangeOperation } from '../ir';
import {
  classifyRisk,
  computeBlastRadius,
  type BlastRadius,
  type BlastRiskClassification,
} from '../blast-radius';

export interface RetagPlanRequest {
  items: string[];
  tag: string;
  op: 'add' | 'remove';
  confirmedOperationIds?: string[];
}

export interface RetagPlanResult {
  operations: ChangeOperation[];
  blast: BlastRadius;
  risk: BlastRiskClassification;
}

function retagOperationId(op: RetagPlanRequest['op'], tag: string, item: string): string {
  return `retag:${op}:${tag}:${item}`;
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

function operationReason(
  includedInChangeSet: boolean,
  requestedConfirm: boolean,
  risk: BlastRiskClassification,
  forcedReasons: string[]
): string | undefined {
  if (includedInChangeSet) {
    return undefined;
  }

  if (forcedReasons.length > 0) {
    const prefix = requestedConfirm ? '已请求确认，但存在强风险项：' : '存在强风险项：';
    return `${prefix}${forcedReasons.join('；')}`;
  }

  return risk.reasons.join('；') || 'tag 变更默认搁置，需显式确认后导出。';
}

export async function planRetag(db: Client, req: RetagPlanRequest): Promise<RetagPlanResult> {
  const blast = await computeBlastRadius(db, { kind: 'tag', ref: req.tag });
  const risk = classifyRisk(blast, { action: 'retag' });
  const confirmed = new Set(req.confirmedOperationIds ?? []);
  const forcedReasons = forceDeferredReasons(blast);
  const forceDeferred = forcedReasons.length > 0;
  const items = Array.from(new Set(req.items)).sort();

  const operations = items.map(item => {
    const operationId = retagOperationId(req.op, req.tag, item);
    const requestedConfirm = confirmed.has(operationId);
    const includedInChangeSet = requestedConfirm && !forceDeferred;

    return {
      operationId,
      decisionId: `retag:${req.op}:${req.tag}`,
      kind: `retag_${req.op}` as const,
      before: {
        tag: req.tag,
        item,
        op: req.op,
      },
      includedInChangeSet,
      reason: operationReason(includedInChangeSet, requestedConfirm, risk, forcedReasons),
    };
  });

  return { operations, blast, risk };
}
