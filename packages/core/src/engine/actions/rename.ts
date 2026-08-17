import type { Client } from '@libsql/client';
import type { ChangeOperation } from '../ir';
import {
  computeBlastRadius,
  type BlastRadius,
  type BlastRiskClassification,
} from '../blast-radius';

type DbRow = Record<string, unknown>;

export interface RenamePlanItem {
  item: string;
  locale: string;
  newName: string;
}

export interface RenamePlanRequest {
  items: RenamePlanItem[];
}

export interface RenamePlanResult {
  operations: ChangeOperation[];
  blast: BlastRadius[];
  risk: BlastRiskClassification;
}

interface ItemTranslationFact {
  item: string;
  locale: string;
  translationKey?: string;
  oldName?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function dedupeRenameItems(items: RenamePlanItem[]): RenamePlanItem[] {
  const itemByKey = new Map<string, RenamePlanItem>();

  for (const item of items) {
    const key = `${item.locale}:${item.item}`;
    const existing = itemByKey.get(key);
    if (existing && existing.newName !== item.newName) {
      throw new Error(`rename 请求对 ${key} 给出了冲突的新名称`);
    }
    itemByKey.set(key, item);
  }

  return [...itemByKey.values()].sort((left, right) => (
    `${left.locale}:${left.item}`.localeCompare(`${right.locale}:${right.item}`)
  ));
}

async function readItemTranslationFact(
  db: Client,
  item: string,
  locale: string
): Promise<ItemTranslationFact> {
  const result = await db.execute({
    sql: `
      SELECT i.translation_key, t.value AS old_name
      FROM items i
      LEFT JOIN translations t
        ON t.key = i.translation_key AND t.lang = ?
      WHERE i.item_id = ?
      LIMIT 1
    `,
    args: [locale, item],
  });
  const row = result.rows[0] as DbRow | undefined;
  if (!row) {
    throw new Error(`找不到物品: ${item}`);
  }

  return {
    item,
    locale,
    translationKey: optionalString(row.translation_key),
    oldName: optionalString(row.old_name),
  };
}

function hasReferences(blast: BlastRadius): boolean {
  return (
    blast.recipeRefsAsInput.length > 0 ||
    blast.recipeRefsAsOutput.length > 0 ||
    blast.tagConnectedRecipes.length > 0 ||
    blast.relatedUnparsed.length > 0
  );
}

function mergeRenameRisk(blasts: BlastRadius[]): BlastRiskClassification {
  const referenced = blasts.some(hasReferences);
  return {
    severity: referenced ? 'low' : 'info',
    mustDefer: false,
    reasons: referenced
      ? ['rename 仅修改 lang 显示名，不改变注册 id；引用清单仅供审阅。']
      : ['rename 仅修改 lang 显示名，不改变注册 id。'],
  };
}

function renameOperation(item: RenamePlanItem, fact: ItemTranslationFact): ChangeOperation {
  return {
    operationId: `rename_lang:${item.locale}:${item.item}`,
    decisionId: `rename:${item.locale}:${item.item}`,
    kind: 'rename_lang',
    before: {
      item: item.item,
      locale: item.locale,
      oldName: fact.oldName,
      langKey: fact.translationKey,
    },
    after: {
      item: item.item,
      locale: item.locale,
      newName: item.newName,
      langKey: fact.translationKey,
    },
    includedInChangeSet: true,
  };
}

export async function planRename(db: Client, req: RenamePlanRequest): Promise<RenamePlanResult> {
  const items = dedupeRenameItems(req.items);
  const [facts, blast] = await Promise.all([
    Promise.all(items.map(item => readItemTranslationFact(db, item.item, item.locale))),
    Promise.all(items.map(item => computeBlastRadius(db, { kind: 'item', ref: item.item }))),
  ]);
  const factByKey = new Map(facts.map(fact => [`${fact.locale}:${fact.item}`, fact]));
  const operations = items.map(item => {
    const fact = factByKey.get(`${item.locale}:${item.item}`);
    if (!fact) {
      throw new Error(`找不到 rename 翻译事实: ${item.locale}:${item.item}`);
    }
    return renameOperation(item, fact);
  });

  return {
    operations,
    blast,
    risk: mergeRenameRisk(blast),
  };
}
