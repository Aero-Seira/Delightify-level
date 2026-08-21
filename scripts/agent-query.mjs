#!/usr/bin/env node
/**
 * agent-query — 面向外部 agent 的整合包数据查询 CLI
 *
 * 查询 Delightify-level 项目库（<projectPath>/.delightify-level/project.db）中的
 * 游戏事实图谱与物品向量，stdout 输出 JSON：{ ok, data?, error? }，
 * 退出码非 0 即失败。使用前需 pnpm build。
 *
 * import 域把 exporter 的快照摄入项目库，是其余所有域的前置。
 *
 * 用法（<projectPath> 可省略：读 DL_PROJECT，或从 cwd 上溯 .delightify-level/）：
 *   node scripts/agent-query.mjs [<projectPath>] import detect [--file <快照路径>]
 *   node scripts/agent-query.mjs [<projectPath>] import run [--file <快照路径>]
 *   node scripts/agent-query.mjs [<projectPath>] graph stats
 *   node scripts/agent-query.mjs --project <projectPath> graph stats
 *   node scripts/agent-query.mjs graph usages <itemId> [--limit n]
 *   node scripts/agent-query.mjs graph closure <seed> [<seed>...] [--policy recipe-impact|obtainability|same-concept] [--max-iterations n] [--max-nodes n] [--max-fanout n] [--near-misses n] [--detail ids|full]
 *   node scripts/agent-query.mjs graph neighbors <nodeId> [--relation member_of|input_of|output_of|obtained_from] [--direction out|in|both] [--depth 1-3]
 *   node scripts/agent-query.mjs graph path <fromNodeId> <toNodeId> [--max-depth n]
 *   node scripts/agent-query.mjs graph rebuild
 *   node scripts/agent-query.mjs embed build
 *   node scripts/agent-query.mjs embed search <文本> [--top n]
 *   node scripts/agent-query.mjs embed similar <itemId> [--top n]
 *   node scripts/agent-query.mjs scope create <name> <seed> [<seed>...] [--policy recipe-impact|obtainability|same-concept]
 *   node scripts/agent-query.mjs scope list
 *   node scripts/agent-query.mjs scope show <name> [--members-limit n]
 *   node scripts/agent-query.mjs scope add <name> <nodeId>
 *   node scripts/agent-query.mjs scope drop <name> <nodeId>
 *   node scripts/agent-query.mjs scope recompute <name>
 *   node scripts/agent-query.mjs scope review <name>
 *
 * embed 子命令经环境变量配置 provider：
 *   OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_EMBEDDING_MODEL（默认 text-embedding-3-small）
 *   OLLAMA_ENDPOINT / OLLAMA_EMBEDDING_MODEL（默认 nomic-embed-text，完全本地）
 *   LLM_ACTIVE_PROFILE=openai-api|ollama-local 指定激活模式
 * 注意：embed build/search 会把物品名称等文本发给激活的 provider。
 *
 * 文档：docs/using.md（工作方式）、docs/cli.md（参数表）
 */
// 必须最先 import：它改道 console，晚于任何会打日志的调用就来不及了（不变量 4.3）
import './lib/stdout-guard.mjs';
import { createClient } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { rebuildGraph } from '../packages/core/dist/graph/build.js';
import { graphStats, itemUsages, graphNeighbors, graphPath } from '../packages/core/dist/graph/query.js';
import { closureFrom } from '../packages/core/dist/graph/closure.js';
import { buildEmbeddings, searchByText, searchSimilarItems } from '../packages/core/dist/embedding/index.js';
import { createLLMService } from '../packages/core/dist/llm/index.js';
import {
  addToScope,
  createScope,
  dropFromScope,
  listScopes,
  recomputeScope,
  reviewScope,
  showScope,
} from '../packages/core/dist/scope/index.js';
import {
  IdNotFoundError,
  PROJECT_DB_MARKER,
  requireId,
  resolveProject,
} from '../packages/core/dist/lookup/index.js';
import {
  DATA_FILE_PATHS,
  detectModDataFile,
  importModData,
  validateModDataFile,
} from '../packages/core/dist/mod-data-importer/index.js';

const NODE_PREFIXES = ['item:', 'tag:', 'recipe:', 'loot:'];
const DOMAINS = new Set(['graph', 'embed', 'scope', 'import']);


function ok(data) {
  process.stdout.write(JSON.stringify({ ok: true, data }, null, 2) + '\n');
}

function fail(error, usage = false, extra = {}) {
  const body = { ok: false, error: String(error), ...extra };
  process.stdout.write(JSON.stringify(body, null, 2) + '\n');
  if (usage) {
    process.stderr.write('用法见 scripts/agent-query.mjs 头部注释或 AGENT.md\n');
  }
  process.exit(1);
}

function failCaught(error, usage = false) {
  if (error instanceof IdNotFoundError || error?.name === 'IdNotFoundError') {
    fail(error.message, usage, {
      did_you_mean: error.didYouMean ?? [],
      truncated: error.truncated,
    });
  }
  if (error?.name === 'ProjectNotFoundError') {
    fail(error.message, true);
  }
  fail(error instanceof Error ? error.message : error, usage);
}

/** 解析 --key value 形式的选项 */
function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`选项 --${key} 缺值`, true);
      flags[key] = value;
      i++;
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, positional };
}

/** neighbors/path 的节点 id 允许省略 item: 前缀 */
function normalizeNodeId(id) {
  return NODE_PREFIXES.some(p => id.startsWith(p)) ? id : `item:${id}`;
}

/** 数值选项：未给出为 undefined（交给 core 用默认值），给了就必须是数字 */
function numberFlag(flags, key) {
  if (flags[key] === undefined) return undefined;
  const value = Number(flags[key]);
  if (!Number.isFinite(value)) fail(`选项 --${key} 需要数字，收到 ${flags[key]}`, true);
  return value;
}

function splitInvocation(positional, flags) {
  const flagged = flags.project ?? flags.p;
  if (positional[0] && DOMAINS.has(positional[0])) {
    return { explicit: flagged, domain: positional[0], command: positional[1], cmdArgs: positional.slice(2) };
  }
  if (positional[1] && DOMAINS.has(positional[1])) {
    return {
      explicit: flagged ?? positional[0],
      domain: positional[1],
      command: positional[2],
      cmdArgs: positional.slice(3),
    };
  }
  fail('参数不足：[projectPath] <graph|embed|scope|import> <command>（或设 DL_PROJECT / 在项目目录下执行）', true);
}

/**
 * import 域：把快照摄入 project.db。
 *
 * 与其它域不同，run 之前项目库可能还不存在，所以自管连接；importModData 内部
 * 已经 deriveGraph + writeGraph，不需要再 graph rebuild。
 */
async function runImport(project, command, flags) {
  if (command === 'detect') {
    const dataFilePath = flags.file
      ? path.resolve(project.projectPath, flags.file)
      : await detectModDataFile(project.projectPath);
    if (!dataFilePath) {
      fail(
        `未找到快照。在 ${project.projectPath} 下找过：${DATA_FILE_PATHS.join('、')}。` +
        '请确认已装 exporter 并在游戏里跑过 /dl_export dump。',
      );
    }
    const validation = await validateModDataFile(dataFilePath);
    ok({
      projectPath: project.projectPath,
      dataFilePath,
      dbPath: project.dbPath,
      imported: fs.existsSync(project.dbPath),
      valid: validation.valid,
      error: validation.error ?? null,
      sourceKind: validation.sourceKind ?? null,
      schemaVersion: validation.schemaVersion ?? null,
      capabilities: validation.capabilities ?? null,
      exportedAt: validation.exportedAt ?? null,
      minecraftVersion: validation.minecraftVersion ?? null,
      modlistHash: validation.modlistHash ?? null,
      counts: {
        mod: validation.modCount ?? null,
        item: validation.itemCount ?? null,
        recipe: validation.recipeCount ?? null,
        tag: validation.tagCount ?? null,
      },
    });
    return;
  }

  if (command !== 'run') {
    fail(`未知 import 子命令：${command}（detect | run）`, true);
  }

  // 进度只走 stderr（不变量 4.3）。大包导入是分钟级，没有进度会以为卡死。
  let lastPhase = '';
  const result = await importModData({
    projectPath: project.projectPath,
    dataFilePath: flags.file ? path.resolve(project.projectPath, flags.file) : undefined,
    onProgress: progress => {
      if (progress.phase === lastPhase && progress.phase === 'importing') return;
      lastPhase = progress.phase;
      process.stderr.write(`[${progress.percent}%] ${progress.message}\n`);
    },
  });

  // importModData 不抛异常，失败是返回值
  if (!result.success) {
    fail(result.error || '导入失败');
  }

  ok({
    projectPath: project.projectPath,
    dbPath: project.dbPath,
    importId: result.importId ?? null,
    sourceKind: result.sourceKind ?? null,
    capabilities: result.capabilities ?? null,
    stats: result.stats ?? null,
  });
}

async function main() {
  const parsed = parseFlags(process.argv.slice(2));
  const { explicit, domain, command, cmdArgs } = splitInvocation(parsed.positional, parsed.flags);
  if (!domain || !command) fail('参数不足：[projectPath] <graph|embed|scope|import> <command>', true);

  let project;
  try {
    // import 时项目库还没建出来，按快照认实例根
    project = domain === 'import'
      ? resolveProject({
          explicit,
          cwd: process.cwd(),
          env: process.env,
          markers: [...DATA_FILE_PATHS, PROJECT_DB_MARKER],
          requireMarker: false,
        })
      : resolveProject({ explicit, cwd: process.cwd(), env: process.env });
  } catch (error) {
    failCaught(error, true);
  }
  const dbPath = project.dbPath;
  if (project.source !== 'explicit') {
    process.stderr.write(`project ${project.projectPath}（${project.source === 'env' ? 'DL_PROJECT' : 'cwd'}）\n`);
  }

  const flags = parsed.flags;
  const positional = cmdArgs;

  // import 自管连接：run 之前项目库可能还不存在
  if (domain === 'import') {
    await runImport(project, command, flags);
    return;
  }

  // graph rebuild 自管连接
  if (domain === 'graph' && command === 'rebuild') {
    const result = await rebuildGraph(dbPath);
    ok(result);
    return;
  }

  const db = createClient({ url: `file:${dbPath}` });
  try {
    if (domain === 'graph') {
      if (command === 'stats') {
        ok(await graphStats(db));
      } else if (command === 'usages') {
        const itemId = positional[0];
        if (!itemId) fail('graph usages 需要 <itemId>', true);
        const canonical = await requireId(db, itemId, { kinds: ['item'], label: '物品' });
        ok(await itemUsages(db, canonical, { limit: numberFlag(flags, 'limit') }));
      } else if (command === 'closure') {
        if (positional.length === 0) fail('graph closure 需要至少一个 <seed>', true);
        if (flags.detail !== undefined && flags.detail !== 'ids' && flags.detail !== 'full') {
          fail('选项 --detail 只能是 ids 或 full', true);
        }
        ok(await closureFrom(db, positional, {
          policy: flags.policy,
          maxIterations: numberFlag(flags, 'max-iterations'),
          maxNodes: numberFlag(flags, 'max-nodes'),
          maxFanout: numberFlag(flags, 'max-fanout'),
          nearMissLimit: numberFlag(flags, 'near-misses'),
          includeNodeDetails: flags.detail === 'full',
        }));
      } else if (command === 'neighbors') {
        const nodeId = positional[0];
        if (!nodeId) fail('graph neighbors 需要 <nodeId>', true);
        const canonical = await requireId(db, normalizeNodeId(nodeId), { kinds: ['node'], label: '节点' });
        ok(await graphNeighbors(db, canonical, {
          relation: flags.relation,
          direction: flags.direction,
          depth: flags.depth ? Number(flags.depth) : undefined,
        }));
      } else if (command === 'path') {
        const [fromId, toId] = positional;
        if (!fromId || !toId) fail('graph path 需要 <fromNodeId> <toNodeId>', true);
        const from = await requireId(db, normalizeNodeId(fromId), { kinds: ['node'], label: '起点' });
        const to = await requireId(db, normalizeNodeId(toId), { kinds: ['node'], label: '终点' });
        ok(await graphPath(db, from, to, flags['max-depth'] ? Number(flags['max-depth']) : 4));
      } else {
        fail(`未知 graph 子命令：${command}`, true);
      }
    } else if (domain === 'embed') {
      const llm = createLLMService();
      const embed = (texts) => llm.embed(texts);
      if (command === 'build') {
        ok(await buildEmbeddings(db, embed));
      } else if (command === 'search') {
        const text = positional[0];
        if (!text) fail('embed search 需要 <文本>', true);
        ok(await searchByText(db, embed, text, flags.top ? Number(flags.top) : 10));
      } else if (command === 'similar') {
        const itemId = positional[0];
        if (!itemId) fail('embed similar 需要 <itemId>', true);
        const canonical = await requireId(db, itemId, { kinds: ['item'], label: '物品' });
        ok(await searchSimilarItems(db, canonical, flags.top ? Number(flags.top) : 10));
      } else {
        fail(`未知 embed 子命令：${command}`, true);
      }
    } else if (domain === 'scope') {
      if (command === 'create') {
        const name = positional[0];
        const seeds = positional.slice(1);
        if (!name || seeds.length === 0) fail('scope create 需要 <name> <seed> [<seed>...]', true);
        ok(await createScope(db, {
          id: name,
          seeds,
          policy: flags.policy,
          maxIterations: numberFlag(flags, 'max-iterations'),
          maxNodes: numberFlag(flags, 'max-nodes'),
          maxFanout: numberFlag(flags, 'max-fanout'),
          nearMissLimit: numberFlag(flags, 'near-misses'),
        }));
      } else if (command === 'list') {
        ok(await listScopes(db));
      } else if (command === 'show') {
        const name = positional[0];
        if (!name) fail('scope show 需要 <name>', true);
        ok(await showScope(db, name, { membersLimit: numberFlag(flags, 'members-limit') }));
      } else if (command === 'add') {
        const [name, nodeId] = positional;
        if (!name || !nodeId) fail('scope add 需要 <name> <nodeId>', true);
        const canonical = await requireId(db, normalizeNodeId(nodeId), { kinds: ['node'], label: '节点' });
        ok(await addToScope(db, name, canonical));
      } else if (command === 'drop') {
        const [name, nodeId] = positional;
        if (!name || !nodeId) fail('scope drop 需要 <name> <nodeId>', true);
        ok(await dropFromScope(db, name, nodeId));
      } else if (command === 'recompute') {
        const name = positional[0];
        if (!name) fail('scope recompute 需要 <name>', true);
        ok(await recomputeScope(db, name, {
          maxIterations: numberFlag(flags, 'max-iterations'),
          maxNodes: numberFlag(flags, 'max-nodes'),
          maxFanout: numberFlag(flags, 'max-fanout'),
          nearMissLimit: numberFlag(flags, 'near-misses'),
        }));
      } else if (command === 'review') {
        const name = positional[0];
        if (!name) fail('scope review 需要 <name>', true);
        ok(await reviewScope(db, name));
      } else {
        fail(`未知 scope 子命令：${command}`, true);
      }
    } else {
      fail(`未知域：${domain}（graph | embed | scope | import）`, true);
    }
  } finally {
    db.close();
  }
}

main().catch(error => failCaught(error));
