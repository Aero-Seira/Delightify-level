#!/usr/bin/env node
/**
 * agent-query — 面向外部 agent 的整合包数据查询 CLI
 *
 * 查询 Delightify-level 项目库（<projectPath>/.delightify-level/project.db）中的
 * 游戏事实图谱与物品向量，stdout 输出 JSON：{ ok, data?, error? }，
 * 退出码非 0 即失败。IDE 无需启动。使用前需先 pnpm build。
 *
 * 用法：
 *   node scripts/agent-query.mjs <projectPath> graph stats
 *   node scripts/agent-query.mjs <projectPath> graph usages <itemId>
 *   node scripts/agent-query.mjs <projectPath> graph neighbors <nodeId> [--relation member_of|input_of|output_of|obtained_from] [--direction out|in|both] [--depth 1-3]
 *   node scripts/agent-query.mjs <projectPath> graph path <fromNodeId> <toNodeId> [--max-depth n]
 *   node scripts/agent-query.mjs <projectPath> graph rebuild
 *   node scripts/agent-query.mjs <projectPath> embed build
 *   node scripts/agent-query.mjs <projectPath> embed search <文本> [--top n]
 *   node scripts/agent-query.mjs <projectPath> embed similar <itemId> [--top n]
 *
 * embed 子命令经环境变量配置 provider（与 IDE LLM 服务同一套）：
 *   OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_EMBEDDING_MODEL（默认 text-embedding-3-small）
 *   OLLAMA_ENDPOINT / OLLAMA_EMBEDDING_MODEL（默认 nomic-embed-text，完全本地）
 *   LLM_ACTIVE_PROFILE=openai-api|ollama-local 指定激活模式
 * 注意：embed build/search 会把物品名称等文本发给激活的 provider。
 *
 * 文档：docs/agent.md
 */
import { createClient } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { rebuildGraph } from '../packages/core/dist/graph/build.js';
import { graphStats, itemUsages, graphNeighbors, graphPath } from '../packages/core/dist/graph/query.js';
import { buildEmbeddings, searchByText, searchSimilarItems } from '../packages/core/dist/embedding/index.js';
import { createLLMService } from '../packages/core/dist/llm/index.js';

const NODE_PREFIXES = ['item:', 'tag:', 'recipe:', 'loot:'];

function ok(data) {
  process.stdout.write(JSON.stringify({ ok: true, data }, null, 2) + '\n');
}

function fail(error, usage = false) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }, null, 2) + '\n');
  if (usage) {
    process.stderr.write('用法见 scripts/agent-query.mjs 头部注释或 docs/guides/agent-data-access.md\n');
  }
  process.exit(1);
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

async function main() {
  const [projectPath, domain, command, ...rest] = process.argv.slice(2);
  if (!projectPath || !domain || !command) fail('参数不足：<projectPath> <graph|embed> <command>', true);

  const dbPath = path.join(projectPath, '.delightify-level', 'project.db');
  if (!fs.existsSync(dbPath)) {
    fail(`项目库不存在：${dbPath}（请确认 projectPath 是 Delightify-level 项目根，且已导入过数据）`);
  }

  const { flags, positional } = parseFlags(rest);

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
        ok(await itemUsages(db, itemId));
      } else if (command === 'neighbors') {
        const nodeId = positional[0];
        if (!nodeId) fail('graph neighbors 需要 <nodeId>', true);
        ok(await graphNeighbors(db, normalizeNodeId(nodeId), {
          relation: flags.relation,
          direction: flags.direction,
          depth: flags.depth ? Number(flags.depth) : undefined,
        }));
      } else if (command === 'path') {
        const [fromId, toId] = positional;
        if (!fromId || !toId) fail('graph path 需要 <fromNodeId> <toNodeId>', true);
        ok(await graphPath(db, normalizeNodeId(fromId), normalizeNodeId(toId), flags['max-depth'] ? Number(flags['max-depth']) : 4));
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
        ok(await searchSimilarItems(db, itemId, flags.top ? Number(flags.top) : 10));
      } else {
        fail(`未知 embed 子命令：${command}`, true);
      }
    } else {
      fail(`未知域：${domain}（graph | embed）`, true);
    }
  } finally {
    db.close();
  }
}

main().catch(error => fail(error instanceof Error ? error.message : error));
