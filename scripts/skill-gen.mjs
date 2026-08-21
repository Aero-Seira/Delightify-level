#!/usr/bin/env node
/**
 * skill-gen —— 从 docs/using.md 生成可直接装进 agent 的 skill
 *
 * design.md §7：指令文档单一来源 + generator。SKILL.md / AGENTS.md 都从
 * docs/using.md 生成，**绝不手维护多份**——漂移的文档比没有文档更糟。
 *
 * 用法：
 *   node scripts/skill-gen.mjs [--target claude|agents] [--out <dir>]
 *                              [--command <前缀>] [--install] [--check]
 *
 *   --target   默认 claude（目录式 SKILL.md + reference/）
 *   --out      产物目录，默认 build/skill/<target>
 *   --command  调用前缀，默认解析成本仓的绝对路径。
 *              将来有了 dl bin 就传 --command dl
 *   --install  直接装到该 harness 的默认位置（claude：~/.claude/skills/）
 *   --check    只校验产物是否与当前文档一致，不写盘。CI 用，退出码非 0 即漂移
 *
 * stdout 一行 JSON：{ ok, data: { target, out, files, bytes } }，日志走 stderr。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DESCRIPTION,
  DROP_BLOCKS,
  HARNESSES,
  LINK_REWRITES,
  REFERENCE_DOCS,
  SINGLE_FILE_REWRITES,
  SKILL_NAME,
} from '../packages/skill/config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'docs/using.md';
/** SKILL.md 激活后常驻上下文，给它一个明确的预算 */
const MAX_ENTRY_BYTES = 24 * 1024;

function ok(data) {
  process.stdout.write(JSON.stringify({ ok: true, data }, null, 2) + '\n');
}

function fail(error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }, null, 2) + '\n');
  process.exit(1);
}

function log(message) {
  process.stderr.write(message + '\n');
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) fail(`多余的位置参数：${argv[i]}`);
    const key = argv[i].slice(2);
    if (key === 'install' || key === 'check') {
      flags[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`选项 --${key} 缺值`);
    flags[key] = value;
    i++;
  }
  return flags;
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function repoVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  return pkg.version || '0.0.0';
}

/**
 * 把仓库文档改写成「装到别处也成立」的文本。
 *
 * 最要紧的是命令前缀：源文档写的是 `node scripts/agent-query.mjs`，那是站在
 * 仓库根目录才成立的写法。skill 装到 ~/.claude/skills/ 之后 cwd 是作者的整合包
 * 实例，必须换成能在任意 cwd 下执行的形式。
 */
function rewrite(text, command, layout) {
  let out = text;

  for (const pattern of DROP_BLOCKS) {
    out = out.replace(pattern, '');
  }

  out = out
    .replace(/node scripts\/agent-query\.mjs/g, command.query)
    .replace(/node scripts\/present-serve\.mjs/g, command.serve);

  for (const [pattern, replacement] of LINK_REWRITES) {
    out = out.replace(pattern, replacement);
  }
  if (layout === 'single-file') {
    for (const [pattern, replacement] of SINGLE_FILE_REWRITES) {
      out = out.replace(pattern, replacement);
    }
  }

  // 「先 pnpm build」是本仓开发者的步骤，装好的 skill 不该再提
  out = out.replace(/（先 `pnpm build`）/g, '');
  out = out.replace(/^查询前在本仓根执行过 `pnpm build`。\n\n/m, '');

  return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function buildBody(command, layout) {
  const source = fs.readFileSync(path.join(REPO, SOURCE), 'utf8');
  // 去掉源文档的 H1，wrap 会各自加自己的标题
  const withoutTitle = source.replace(/^#\s+.*\n/, '');
  return rewrite(withoutTitle, command, layout);
}

function resolveCommand(raw) {
  if (raw) {
    return { query: `${raw}`, serve: `${raw} serve` };
  }
  // 还没发到 npm，dl 不在 PATH 上，只能钉死本仓的绝对路径。
  // 发布后传 --command dl 重新生成即可，skill 正文不用动。
  const local = path.join(REPO, 'bin', 'dl');
  return { query: local, serve: `${local} serve` };
}

function collectFiles(target, command, version) {
  const harness = HARNESSES[target];
  const ctx = { version, sourceRepo: REPO, command };
  const body = buildBody(command, harness.layout);
  const files = new Map();

  files.set(harness.entry, harness.wrap(body, ctx));

  if (harness.layout === 'directory') {
    for (const doc of REFERENCE_DOCS) {
      const text = fs.readFileSync(path.join(REPO, doc.source), 'utf8');
      files.set(doc.target, rewrite(text, command, harness.layout));
    }
    files.set(
      'reference/README.md',
      `# 参考资料\n\n由 \`skill-gen\` 从 ${REPO} 生成，v${version}。不要手改。\n\n` +
        REFERENCE_DOCS.map(d => `- [\`${path.basename(d.target)}\`](${path.basename(d.target)}) — ${d.title}`).join('\n') +
        '\n',
    );
  }

  return files;
}

/**
 * 产物可用性断言。
 *
 * CI 里 build/ 是 gitignore 的，全新检出没有产物可比，字节比对无从谈起——
 * 也没必要：产物不入库，就不存在「committed 产物过期」这种漂移。真正要守的是
 * **生成出来的东西装进 agent 后能不能用**，所以断言的是改写有没有做干净。
 * 这些每一条都对应一种装完才会发现的静默故障。
 */
function assertUsable(target, files) {
  const harness = HARNESSES[target];
  const entry = files.get(harness.entry);
  const problems = [];

  if (!entry) return [`没有生成入口文件 ${harness.entry}`];

  if (target === 'claude') {
    const fm = entry.match(/^---\n([\s\S]*?)\n---\n/);
    if (!fm) problems.push('SKILL.md 缺 frontmatter，harness 不会识别成 skill');
    else {
      const front = fm[1];
      if (!new RegExp(`^name:\\s*${SKILL_NAME}\\s*$`, 'm').test(front)) {
        problems.push(`frontmatter 的 name 不是 ${SKILL_NAME}`);
      }
      // description 决定 agent 想不想得起来用它，空的等于没装
      const desc = front.match(/^description:\s*(.+)$/m);
      if (!desc) problems.push('frontmatter 缺 description');
      else if (desc[1].replace(/^"|"$/g, '').trim().length < 40) {
        problems.push('description 过短，起不到触发作用');
      }
    }
  }

  for (const [rel, content] of files) {
    // 死链判定不靠「长得像坏链接」的模式匹配，而是把相对链接解析出来，
    // 看目标在不在打包清单里。这样 reference/cli.md 回指 ../SKILL.md 这种
    // 合法的跨级链接不会被误伤，而任何指向未打包文件的链接都跑不掉。
    for (const match of content.matchAll(/\]\(([^)\s]+\.md)\)/g)) {
      const href = match[1];
      if (/^[a-z]+:\/\//i.test(href)) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), href));
      if (!files.has(resolved)) {
        problems.push(`${rel} 链接到未打包的 ${href}（解析为 ${resolved}）`);
      }
    }
    if (/node scripts\//.test(content)) problems.push(`${rel} 残留 node scripts/ 调用，装到别处跑不通`);
    if (/pnpm build/.test(content)) problems.push(`${rel} 残留 pnpm build，那是本仓开发者的步骤`);
    if (/AGENT\.md/.test(content)) problems.push(`${rel} 残留指向本仓 AGENT.md 的引用`);
  }

  // SKILL.md 激活后常驻上下文，超了要么拆 reference 要么精简
  const entryBytes = Buffer.byteLength(entry);
  if (entryBytes > MAX_ENTRY_BYTES) {
    problems.push(`${harness.entry} ${entryBytes} 字节，超过 ${MAX_ENTRY_BYTES} 的上下文预算`);
  }

  return problems;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const target = flags.target || 'claude';
  const harness = HARNESSES[target];
  if (!harness) fail(`未知 target：${target}（${Object.keys(HARNESSES).join(' | ')}）`);

  const version = repoVersion();
  const command = resolveCommand(flags.command);
  const files = collectFiles(target, command, version);

  let outDir;
  if (flags.install) {
    if (!harness.defaultInstall) fail(`target ${target} 没有默认安装位置，请用 --out`);
    outDir = expandHome(harness.defaultInstall);
  } else {
    outDir = path.resolve(REPO, flags.out || path.join('build', 'skill', target));
  }

  if (flags.check) {
    const problems = assertUsable(target, files);

    // 产物目录存在才比对（例如校验已安装的那份是不是过期了）。
    // 目录压根不存在 = 没装过，没有可过期的东西，不算失败。
    const installed = fs.existsSync(outDir);
    if (installed) {
      for (const [rel, content] of files) {
        const full = path.join(outDir, rel);
        if (!fs.existsSync(full)) problems.push(`${rel} 缺失（产物不完整）`);
        else if (fs.readFileSync(full, 'utf8') !== content) {
          problems.push(`${rel} 与 ${SOURCE} 不一致，重新跑 skill-gen`);
        }
      }
    }

    if (problems.length > 0) fail(problems.join('；'));
    ok({ target, out: outDir, checked: files.size, comparedOnDisk: installed, problems: 0 });
    return;
  }

  let bytes = 0;
  for (const [rel, content] of files) {
    const full = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    bytes += Buffer.byteLength(content);
    log(`写出 ${path.relative(process.cwd(), full)}`);
  }

  ok({
    target,
    name: SKILL_NAME,
    out: outDir,
    entry: harness.entry,
    files: [...files.keys()],
    bytes,
    command: command.query,
    installed: Boolean(flags.install),
  });
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : error);
}
