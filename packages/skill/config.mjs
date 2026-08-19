/**
 * skill 生成的配置。**内容不在这里**——内容的单一来源是 docs/using.md。
 *
 * 这里只放三类东西：
 *   1. 各 harness 的封装格式（frontmatter 等），
 *   2. 从仓库文档到已安装 skill 的路径改写，
 *   3. 触发词（activation copy）——它不属于 using.md，因为 using.md 是给
 *      「已经决定要用本工具的 agent」看的，而 description 要负责让 agent
 *      在没想到本工具时也能想起来。
 *
 * 见 docs/design.md §7：绝不手维护多份指令文档。
 */

/** 随 skill 一起打包的参考资料，按需加载而不是全塞进 SKILL.md */
export const REFERENCE_DOCS = [
  { source: 'docs/cli.md', target: 'reference/cli.md', title: 'CLI 参数表' },
  { source: 'docs/world.md', target: 'reference/world.md', title: '数据从哪来' },
  { source: 'docs/contract.md', target: 'reference/contract.md', title: '快照表结构' },
];

/**
 * 仓库内的相对链接 → 已安装 skill 里的相对路径。
 * 漏改一条就是安装后点不开的死链。
 */
export const LINK_REWRITES = [
  [/\[`world\.md`\]\(\.\/world\.md\)/g, '[`reference/world.md`](reference/world.md)'],
  [/\[`contract\.md`\]\(\.\/contract\.md\)/g, '[`reference/contract.md`](reference/contract.md)'],
  [/\[`cli\.md`\]\(\.\/cli\.md\)/g, '[`reference/cli.md`](reference/cli.md)'],
];

/** 只对本仓开发者有意义、装到别人机器上纯噪音的段落 */
export const DROP_BLOCKS = [
  /^> 要改本仓库的代码.*$/m,
];

export const SKILL_NAME = 'delightify-level';

/**
 * 触发词。写给「还没想到要用本工具」的 agent 看，所以要铺开作者会说的词，
 * 而不是复述工具能力。
 */
export const DESCRIPTION =
  'Query a Minecraft modpack\'s runtime final state — items, recipes, tags, loot, ' +
  'and the relationships between them — from a local snapshot of the loaded game. ' +
  'Use whenever working on a modpack instance: finding what items/recipes/tags exist, ' +
  'what a change would affect (blast radius / closure), how something is obtained, ' +
  'which cross-mod items are the same concept, or before writing KubeJS scripts. ' +
  'Registry ids must come from query results, never from memory. ' +
  'Triggers: 整合包, modpack, mod, 物品, 配方, recipe, tag, KubeJS, 战利品, loot, ' +
  'CurseForge/Modrinth pack, "这个改了会影响谁", "包里有哪些".';

export const HARNESSES = {
  claude: {
    label: 'Claude Code / claude.ai skill',
    /** 目录式：SKILL.md + reference/ */
    layout: 'directory',
    entry: 'SKILL.md',
    defaultInstall: '~/.claude/skills/delightify-level',
    wrap(body, ctx) {
      const fm = [
        '---',
        `name: ${SKILL_NAME}`,
        `description: ${JSON.stringify(DESCRIPTION)}`,
        `version: ${ctx.version}`,
        '---',
        '',
      ].join('\n');
      return fm + body;
    },
  },
  agents: {
    label: 'AGENTS.md（Codex 等读单文件的 harness）',
    layout: 'single-file',
    entry: 'AGENTS.md',
    defaultInstall: null,
    wrap(body, ctx) {
      return `# Delightify-level（整合包世界查询）\n\n> 本文由 \`skill-gen\` 从 ${ctx.sourceRepo} 的 docs/using.md 生成，v${ctx.version}。不要手改，改源文档后重新生成。\n\n${body}`;
    },
  },
};
