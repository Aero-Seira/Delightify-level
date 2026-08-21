#!/usr/bin/env node
/**
 * diagnose recipes —— 一键采集「配方为什么是空的」所需的全部证据
 *
 *   dl diagnose [--project <path>] [--log <latest.log>] [--samples 5]
 *
 * 背景见 docs/plans/recipe-unparsed-triage.md。
 *
 * 要回答的问题是：结构化槽位是**导出时就没采到**，还是**导入时丢了**。
 * 所以同时查快照（export.sqlite）与项目库（project.db）并对比——两边一致
 * 说明是采集侧，两边不一致说明是 importer 的锅。
 *
 * stdout 一个 JSON，直接贴给协助排查的人即可。日志走 stderr。
 */
// 必须最先 import，见模块内注释
import './lib/stdout-guard.mjs';
import { createClient } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveProject, PROJECT_DB_MARKER } from '../packages/core/dist/lookup/index.js';
import { DATA_FILE_PATHS, detectModDataFile } from '../packages/core/dist/mod-data-importer/index.js';

const SAMPLE_JSON_CHARS = 240;

function ok(data) {
  process.stdout.write(JSON.stringify({ ok: true, data }, null, 2) + '\n');
}

function fail(error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }, null, 2) + '\n');
  process.exit(1);
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`选项 --${key} 缺值`);
    flags[key] = value;
    i++;
  }
  return flags;
}

async function one(db, sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows[0] ?? null;
}

async function all(db, sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows;
}

async function tableExists(db, name) {
  const row = await one(db, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]);
  return Boolean(row);
}

/** 环境：MC 版本 / loader / exporter 版本，决定了要不要怀疑 API 变更 */
async function readManifest(db) {
  if (!(await tableExists(db, 'manifest'))) return null;
  const rows = await all(db, 'SELECT key, value FROM manifest');
  const out = {};
  for (const row of rows) out[String(row.key)] = String(row.value);
  return out;
}

async function recipeStats(db, samples) {
  if (!(await tableExists(db, 'recipes'))) return { present: false };

  const totals = await one(
    db,
    `SELECT COUNT(*) AS total,
            SUM(unparsed) AS unparsed,
            SUM(CASE WHEN unparsed = 1 AND raw_json IS NULL THEN 1 ELSE 0 END) AS unparsed_no_json,
            SUM(CASE WHEN unparsed = 1 AND raw_json IS NOT NULL THEN 1 ELSE 0 END) AS unparsed_with_json
       FROM recipes`,
  );

  const hasInputs = await tableExists(db, 'recipe_inputs');
  const hasOutputs = await tableExists(db, 'recipe_outputs');

  // unparsed=0 却没有槽位 = 另一类问题，和 unparsed 不是一回事
  const empties = hasOutputs
    ? await one(
        db,
        `SELECT
           SUM(CASE WHEN o.n IS NULL AND r.unparsed = 0 THEN 1 ELSE 0 END) AS parsed_no_output,
           SUM(CASE WHEN o.n IS NULL AND r.unparsed = 1 THEN 1 ELSE 0 END) AS unparsed_no_output
         FROM recipes r
         LEFT JOIN (SELECT recipe_id, COUNT(*) AS n FROM recipe_outputs GROUP BY recipe_id) o
                ON o.recipe_id = r.recipe_id`,
      )
    : null;

  const emptyInputs = hasInputs
    ? await one(
        db,
        `SELECT
           SUM(CASE WHEN i.n IS NULL AND r.unparsed = 0 THEN 1 ELSE 0 END) AS parsed_no_input,
           SUM(CASE WHEN i.n IS NULL AND r.unparsed = 1 THEN 1 ELSE 0 END) AS unparsed_no_input
         FROM recipes r
         LEFT JOIN (SELECT recipe_id, COUNT(*) AS n FROM recipe_inputs GROUP BY recipe_id) i
                ON i.recipe_id = r.recipe_id`,
      )
    : null;

  // 分布是关键判据：集中在少数 mod 的自定义类型 = 序列化器问题；
  // 连 minecraft:crafting_shaped 都中招 = API 层面的问题
  const byType = await all(
    db,
    `SELECT type_id,
            COUNT(*) AS n,
            SUM(unparsed) AS unparsed
       FROM recipes GROUP BY type_id HAVING unparsed > 0
      ORDER BY unparsed DESC, type_id LIMIT 25`,
  );

  const vanillaHit = await one(
    db,
    `SELECT COUNT(*) AS n FROM recipes
      WHERE unparsed = 1 AND type_id LIKE 'minecraft:%'`,
  );

  const sampleRows = await all(
    db,
    `SELECT recipe_id, type_id, unparsed,
            raw_json IS NULL AS json_null,
            substr(COALESCE(raw_json, ''), 1, ?) AS json_head
       FROM recipes WHERE unparsed = 1 ORDER BY recipe_id LIMIT ?`,
    [SAMPLE_JSON_CHARS, samples],
  );

  const parsedEmptySamples = hasOutputs
    ? await all(
        db,
        `SELECT r.recipe_id, r.type_id, substr(COALESCE(r.raw_json, ''), 1, ?) AS json_head
           FROM recipes r
           LEFT JOIN (SELECT recipe_id, COUNT(*) AS n FROM recipe_outputs GROUP BY recipe_id) o
                  ON o.recipe_id = r.recipe_id
          WHERE o.n IS NULL AND r.unparsed = 0
          ORDER BY r.recipe_id LIMIT ?`,
        [SAMPLE_JSON_CHARS, samples],
      )
    : [];

  const num = (row, key) => (row && row[key] != null ? Number(row[key]) : null);

  return {
    present: true,
    total: num(totals, 'total'),
    unparsed: num(totals, 'unparsed'),
    unparsedRatio: num(totals, 'total')
      ? Number((num(totals, 'unparsed') / num(totals, 'total')).toFixed(4))
      : null,
    // raw_json 是不是 null 决定了是 encodeRecipe 挂了还是 getIngredients 挂了
    unparsedNoRawJson: num(totals, 'unparsed_no_json'),
    unparsedWithRawJson: num(totals, 'unparsed_with_json'),
    vanillaTypeUnparsed: num(vanillaHit, 'n'),
    parsedButNoOutput: num(empties, 'parsed_no_output'),
    unparsedNoOutput: num(empties, 'unparsed_no_output'),
    parsedButNoInput: num(emptyInputs, 'parsed_no_input'),
    unparsedNoInput: num(emptyInputs, 'unparsed_no_input'),
    inputRows: hasInputs ? num(await one(db, 'SELECT COUNT(*) AS n FROM recipe_inputs'), 'n') : null,
    outputRows: hasOutputs ? num(await one(db, 'SELECT COUNT(*) AS n FROM recipe_outputs'), 'n') : null,
    topUnparsedTypes: byType.map(row => ({
      typeId: String(row.type_id),
      total: Number(row.n),
      unparsed: Number(row.unparsed),
    })),
    unparsedSamples: sampleRows.map(row => ({
      recipeId: String(row.recipe_id),
      typeId: String(row.type_id),
      rawJsonNull: Boolean(row.json_null),
      rawJsonHead: String(row.json_head || ''),
    })),
    parsedEmptySamples: parsedEmptySamples.map(row => ({
      recipeId: String(row.recipe_id),
      typeId: String(row.type_id),
      rawJsonHead: String(row.json_head || ''),
    })),
  };
}

/** 图里的影响面：没有边的配方节点，正是 agent 眼中的「坏配方」 */
async function graphStats(db) {
  if (!(await tableExists(db, 'graph_nodes'))) return { present: false };
  const nodes = await one(db, "SELECT COUNT(*) AS n FROM graph_nodes WHERE node_type = 'recipe'");
  const isolated = await one(
    db,
    `SELECT COUNT(*) AS n FROM graph_nodes gn
      WHERE gn.node_type = 'recipe'
        AND NOT EXISTS (SELECT 1 FROM graph_edges e WHERE e.to_node_id = gn.node_id)
        AND NOT EXISTS (SELECT 1 FROM graph_edges e WHERE e.from_node_id = gn.node_id)`,
  );
  return {
    present: true,
    recipeNodes: Number(nodes?.n ?? 0),
    isolatedRecipeNodes: Number(isolated?.n ?? 0),
  };
}

/**
 * exporter 每次放弃都会打 WARN 并带异常类名，答案往往已经写在日志里。
 * 只统计不外传原文，避免把整份日志塞进上下文。
 */
function scanLog(logPath) {
  if (!logPath || !fs.existsSync(logPath)) return { found: false, path: logPath ?? null };
  const text = fs.readFileSync(logPath, 'utf8');
  const patterns = {
    ingredientsFailed: /Failed to read recipe ingredients for .*?\((\w+):/g,
    encodeFailed: /Failed to encode recipe .*?\((\w+):/g,
    materializeFailed: /Failed to materialize recipe .*?\((\w+):/g,
  };
  const out = { found: true, path: logPath, counts: {}, exceptions: {}, firstLines: [] };
  for (const [name, pattern] of Object.entries(patterns)) {
    const matches = [...text.matchAll(pattern)];
    out.counts[name] = matches.length;
    for (const match of matches) {
      const kind = match[1];
      out.exceptions[kind] = (out.exceptions[kind] ?? 0) + 1;
    }
  }
  for (const line of text.split('\n')) {
    if (/marking recipe unparsed|exporting unparsed row only/.test(line)) {
      out.firstLines.push(line.trim().slice(0, 300));
      if (out.firstLines.length >= 5) break;
    }
  }
  return out;
}

function guessLogPath(projectPath, explicit) {
  if (explicit) return path.resolve(explicit);
  for (const candidate of ['logs/latest.log', 'logs/debug.log']) {
    const full = path.join(projectPath, candidate);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * 两侧一致 = 采集侧丢的；不一致 = importer 丢的。
 * 这一条决定了接下来该改 Java 还是改 TypeScript。
 */
function compare(snapshot, project) {
  if (!snapshot?.present || !project?.present) return null;
  const same = (a, b) => (a == null && b == null ? true : a === b);
  return {
    recipeCountMatches: same(snapshot.total, project.total),
    unparsedCountMatches: same(snapshot.unparsed, project.unparsed),
    inputRowsMatch: same(snapshot.inputRows, project.inputRows),
    outputRowsMatch: same(snapshot.outputRows, project.outputRows),
    verdict:
      same(snapshot.total, project.total) &&
      same(snapshot.unparsed, project.unparsed) &&
      same(snapshot.inputRows, project.inputRows) &&
      same(snapshot.outputRows, project.outputRows)
        ? 'snapshot_equals_project：导入没丢东西，问题在采集侧（exporter）'
        : 'snapshot_differs_from_project：快照里有而项目库里没有，问题在 importer',
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const samples = Number(flags.samples) > 0 ? Math.min(Number(flags.samples), 20) : 5;

  const project = resolveProject({
    explicit: flags.project,
    cwd: process.cwd(),
    env: process.env,
    markers: [...DATA_FILE_PATHS, PROJECT_DB_MARKER],
    requireMarker: false,
  });

  const report = {
    projectPath: project.projectPath,
    generatedBy: 'scripts/diagnose-recipes.mjs',
    snapshot: null,
    project: null,
    comparison: null,
    graph: null,
    log: null,
  };

  const snapshotPath = flags.file
    ? path.resolve(project.projectPath, flags.file)
    : await detectModDataFile(project.projectPath);

  if (snapshotPath && fs.existsSync(snapshotPath)) {
    const db = createClient({ url: `file:${snapshotPath}` });
    try {
      report.snapshot = {
        path: snapshotPath,
        manifest: await readManifest(db),
        recipes: await recipeStats(db, samples),
      };
    } finally {
      db.close();
    }
  } else {
    process.stderr.write(`未找到快照（找过 ${DATA_FILE_PATHS.join('、')}），只诊断项目库\n`);
  }

  if (fs.existsSync(project.dbPath)) {
    const db = createClient({ url: `file:${project.dbPath}` });
    try {
      report.project = {
        path: project.dbPath,
        manifest: await readManifest(db),
        recipes: await recipeStats(db, samples),
      };
      report.graph = await graphStats(db);
    } finally {
      db.close();
    }
  } else {
    process.stderr.write(`项目库不存在：${project.dbPath}（先跑 dl import run）\n`);
  }

  report.comparison = compare(report.snapshot?.recipes, report.project?.recipes);
  report.log = scanLog(guessLogPath(project.projectPath, flags.log));

  ok(report);
}

main().catch(error => fail(error instanceof Error ? error.message : error));
