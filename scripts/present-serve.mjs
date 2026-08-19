#!/usr/bin/env node
/**
 * 呈现层 + 浏览层：同进程、不同路由。只绑 127.0.0.1。
 *
 *   node scripts/present-serve.mjs [<projectPath>] [--port 7450] [--scope <name>]
 *   <projectPath> 可省略：读 DL_PROJECT，或从 cwd 上溯 .delightify-level/
 *
 * /          审 scope
 * /b         图鉴（人用过滤，不是 agent 检索管线）
 *
 * stdout 一行 JSON { ok, data: { url, port, scope } }，之后只写 stderr。
 */
import { createClient } from '@libsql/client';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  browseItemDetail,
  browseItemFacets,
  browseItems,
  browseRecipeDetail,
  browseRecipeFacets,
  browseRecipes,
  listMods,
  listRecipeTypes,
  listTags,
  loadItemIconPng,
  loadRecipeBackgroundPng,
} from '../packages/core/dist/browse/index.js';
import { lookupId, resolveProject } from '../packages/core/dist/lookup/index.js';
import {
  addToScope,
  createScope,
  dropFromScope,
  listScopes,
  loadItemIconBase64,
  recomputeScope,
  reviewScope,
  showScope,
} from '../packages/core/dist/scope/index.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'present', 'static');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
};
const ICON_CACHE = 'public, max-age=31536000, immutable';

function okLine(data) {
  process.stdout.write(JSON.stringify({ ok: true, data }) + '\n');
}

function fail(error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }) + '\n');
  process.exit(1);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`选项 --${key} 缺值`);
      flags[key] = value;
      i++;
    } else {
      positional.push(argv[i]);
    }
  }
  return { flags, positional };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function sendPng(req, res, bytes, etag) {
  const tag = `"${etag}"`;
  if (req.headers['if-none-match'] === tag) {
    res.writeHead(304, { etag: tag, 'cache-control': ICON_CACHE });
    res.end();
    return;
  }
  const body = Buffer.from(bytes);
  res.writeHead(200, {
    'content-type': 'image/png',
    'cache-control': ICON_CACHE,
    etag: tag,
    'content-length': body.length,
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function queryOf(url) {
  const get = key => url.searchParams.get(key) || undefined;
  return {
    search: get('q'),
    searchField: get('field'),
    modid: get('mod'),
    tagId: get('tag'),
    typeId: get('type'),
    lang: get('lang'),
    page: get('page'),
    pageSize: get('page-size'),
    limit: get('limit'),
    id: get('id'),
  };
}

function serveStatic(reqPath, res) {
  if (reqPath === '/' || reqPath.startsWith('/s/')) {
    sendFile(res, path.join(STATIC_DIR, 'index.html'));
    return;
  }
  if (reqPath === '/b' || reqPath.startsWith('/b/')) {
    sendFile(res, path.join(STATIC_DIR, 'browse.html'));
    return;
  }
  const relative = reqPath.replace(/^\//, '');
  const resolved = path.normalize(path.join(STATIC_DIR, relative));
  if (!resolved.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  sendFile(res, resolved);
}

async function handleIcon(db, req, res, url) {
  const pngMatch = url.pathname.match(/^\/icon\/(.+)\.png$/);
  const itemId = pngMatch ? decodeURIComponent(pngMatch[1]) : url.searchParams.get('id');
  if (!itemId) {
    res.writeHead(400);
    res.end('missing id');
    return;
  }
  const icon = await loadItemIconPng(db, itemId);
  if (!icon) {
    res.writeHead(404);
    res.end('no icon');
    return;
  }
  sendPng(req, res, icon.bytes, icon.etag);
}

async function handleRecipeBg(db, req, res, url) {
  const match = url.pathname.match(/^\/recipe-bg\/(.+)\.png$/);
  const typeId = match ? decodeURIComponent(match[1]) : url.searchParams.get('type');
  if (!typeId) {
    res.writeHead(400);
    res.end('missing type');
    return;
  }
  const bg = await loadRecipeBackgroundPng(db, typeId);
  if (!bg) {
    res.writeHead(404);
    res.end('no background');
    return;
  }
  sendPng(req, res, bg.bytes, bg.sha1 || 'none');
}

async function handleBrowseApi(db, req, res, url) {
  const pathname = url.pathname;
  const q = queryOf(url);

  if (pathname === '/api/browse/items') {
    sendJson(res, 200, { ok: true, data: await browseItems(db, q) });
    return;
  }
  if (pathname === '/api/browse/items/facets') {
    sendJson(res, 200, { ok: true, data: await browseItemFacets(db, q) });
    return;
  }
  if (pathname === '/api/browse/item') {
    if (!q.id) {
      sendJson(res, 400, { ok: false, error: '缺少 id' });
      return;
    }
    const data = await browseItemDetail(db, q.id, { lang: q.lang });
    if (data.item) {
      sendJson(res, 200, { ok: true, data });
      return;
    }
    const lookup = await lookupId(db, q.id, { kinds: ['item'] });
    sendJson(res, 404, {
      ok: false,
      error: `物品不存在：${q.id}`,
      data,
      did_you_mean: lookup.suggestions,
      truncated: lookup.truncated,
    });
    return;
  }
  if (pathname === '/api/browse/recipes') {
    sendJson(res, 200, { ok: true, data: await browseRecipes(db, q) });
    return;
  }
  if (pathname === '/api/browse/recipes/facets') {
    sendJson(res, 200, { ok: true, data: await browseRecipeFacets(db, q) });
    return;
  }
  if (pathname === '/api/browse/recipe') {
    if (!q.id) {
      sendJson(res, 400, { ok: false, error: '缺少 id' });
      return;
    }
    const data = await browseRecipeDetail(db, q.id, { lang: q.lang });
    if (data.recipe) {
      sendJson(res, 200, { ok: true, data });
      return;
    }
    const lookup = await lookupId(db, q.id, { kinds: ['recipe'] });
    sendJson(res, 404, {
      ok: false,
      error: `配方不存在：${q.id}`,
      data,
      did_you_mean: lookup.suggestions,
      truncated: lookup.truncated,
    });
    return;
  }
  if (pathname === '/api/browse/mods') {
    sendJson(res, 200, { ok: true, data: await listMods(db, { limit: q.limit }) });
    return;
  }
  if (pathname === '/api/browse/tags') {
    sendJson(res, 200, { ok: true, data: await listTags(db, { search: q.search, limit: q.limit }) });
    return;
  }
  if (pathname === '/api/browse/recipe-types') {
    sendJson(res, 200, { ok: true, data: await listRecipeTypes(db, { search: q.search, limit: q.limit }) });
    return;
  }

  sendJson(res, 404, { ok: false, error: `未知接口：GET ${pathname}` });
}

async function handleApi(db, req, res, url) {
  const pathname = url.pathname;
  const method = req.method || 'GET';

  try {
    if (method === 'GET' && pathname.startsWith('/api/browse/')) {
      await handleBrowseApi(db, req, res, url);
      return;
    }

    if (method === 'GET' && pathname === '/api/scopes') {
      sendJson(res, 200, { ok: true, data: await listScopes(db) });
      return;
    }

    const show = pathname.match(/^\/api\/scopes\/([^/]+)$/);
    if (method === 'GET' && show) {
      const limit = url.searchParams.get('members-limit');
      sendJson(res, 200, {
        ok: true,
        data: await showScope(db, decodeURIComponent(show[1]), {
          membersLimit: limit ? Number(limit) : 500,
        }),
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/scopes') {
      const body = await readBody(req);
      sendJson(res, 200, {
        ok: true,
        data: await createScope(db, {
          id: body.id,
          seeds: Array.isArray(body.seeds) ? body.seeds : [],
          policy: body.policy,
        }),
      });
      return;
    }

    const action = pathname.match(/^\/api\/scopes\/([^/]+)\/(add|drop|recompute|review)$/);
    if (method === 'POST' && action) {
      const id = decodeURIComponent(action[1]);
      const verb = action[2];
      if (verb === 'add') {
        const body = await readBody(req);
        sendJson(res, 200, { ok: true, data: await addToScope(db, id, body.nodeId) });
        return;
      }
      if (verb === 'drop') {
        const body = await readBody(req);
        sendJson(res, 200, { ok: true, data: await dropFromScope(db, id, body.nodeId) });
        return;
      }
      if (verb === 'recompute') {
        sendJson(res, 200, { ok: true, data: await recomputeScope(db, id) });
        return;
      }
      sendJson(res, 200, { ok: true, data: await reviewScope(db, id) });
      return;
    }

    if (method === 'GET' && pathname === '/api/icon') {
      const itemId = url.searchParams.get('id');
      if (!itemId) {
        sendJson(res, 400, { ok: false, error: '缺少 id' });
        return;
      }
      const base64 = await loadItemIconBase64(db, itemId);
      if (!base64) {
        sendJson(res, 404, { ok: false, error: 'no icon' });
        return;
      }
      sendJson(res, 200, { ok: true, data: { base64, mimeType: 'image/png' } });
      return;
    }

    sendJson(res, 404, { ok: false, error: `未知接口：${method} ${pathname}` });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  let project;
  try {
    project = resolveProject({
      explicit: positional[0],
      cwd: process.cwd(),
      env: process.env,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : error);
  }
  if (!fs.existsSync(path.join(STATIC_DIR, 'index.html'))) {
    fail(`缺少静态页：${STATIC_DIR}`);
  }

  const port = flags.port ? Number(flags.port) : 7450;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`非法端口：${flags.port}`);

  const db = createClient({ url: `file:${project.dbPath}` });
  if (project.source !== 'explicit') {
    process.stderr.write(`project ${project.projectPath}（${project.source === 'env' ? 'DL_PROJECT' : 'cwd'}）\n`);
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) {
      void handleApi(db, req, res, url);
      return;
    }
    if (url.pathname === '/icon' || url.pathname.startsWith('/icon/')) {
      void handleIcon(db, req, res, url).catch(error => {
        res.writeHead(500);
        res.end(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    if (url.pathname === '/recipe-bg' || url.pathname.startsWith('/recipe-bg/')) {
      void handleRecipeBg(db, req, res, url).catch(error => {
        res.writeHead(500);
        res.end(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    serveStatic(url.pathname, res);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const scope = flags.scope || null;
  const url = scope ? `http://127.0.0.1:${port}/s/${encodeURIComponent(scope)}` : `http://127.0.0.1:${port}/`;
  okLine({ url, port, scope, browse: `http://127.0.0.1:${port}/b` });
  process.stderr.write(`present 审核页：${url}\n`);
  process.stderr.write(`present 图鉴：http://127.0.0.1:${port}/b\n`);

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(error => fail(error instanceof Error ? error.message : error));
