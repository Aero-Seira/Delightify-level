const app = document.getElementById('app');
const STORAGE_KEY = 'dl-browse-selection';
const PLACEHOLDER_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6',
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
];

const state = {
  tab: 'items',
  q: '',
  field: 'all',
  mod: '',
  tag: '',
  type: '',
  page: 1,
  pageSize: 50,
  view: 'grid',
  lang: 'zh_cn',
  detailKind: null,
  detailId: null,
};

const selection = { items: new Map(), recipes: new Map(), tags: new Map() };
let searchTimer = 0;
let requestSeq = 0;
let lastList = { items: [], recipes: [] };
let lastFacets = { mods: [], tags: [], types: [] };
let lastTotal = 0;
let lastTruncated = null;
let lastDetail = null;
let lastError = '';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function stableColor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  return PLACEHOLDER_COLORS[Math.abs(hash) % PLACEHOLDER_COLORS.length];
}

function shortLabel(id, displayName) {
  if (id.startsWith('tag:')) {
    const name = id.slice(4).split(':').pop() || '?';
    return `#${name.slice(0, 3)}`;
  }
  const source = displayName || id;
  const name = source.includes(':') ? source.slice(source.indexOf(':') + 1) : source;
  return (name.replaceAll('_', '') || '?').slice(0, 3).toUpperCase();
}

function iconUrl(itemId) {
  return `/icon/${encodeURIComponent(itemId)}.png`;
}

function itemIcon(itemId, options = {}) {
  const size = options.size || 32;
  const hasIcon = options.hasIcon !== false && Boolean(itemId) && !String(itemId).startsWith('tag:');
  const title = options.title || itemId || '';
  if (!itemId) {
    return `<span class="item-ph" style="width:${size}px;height:${size}px" title="空"></span>`;
  }
  if (!hasIcon) {
    return `<span class="item-ph" title="${escapeHtml(title)}" style="width:${size}px;height:${size}px;background:${stableColor(itemId)}">${escapeHtml(shortLabel(itemId, options.displayName))}</span>`;
  }
  return `<img class="item-icon" data-id="${escapeHtml(itemId)}" src="${escapeHtml(iconUrl(itemId))}" width="${size}" height="${size}" alt="" title="${escapeHtml(title)}" loading="lazy">`;
}

function bindBrokenIcons(root) {
  root.querySelectorAll('img.item-icon').forEach(img => {
    img.addEventListener('error', () => {
      const id = img.dataset.id || '';
      const span = document.createElement('span');
      span.className = 'item-ph';
      span.title = id;
      span.style.width = `${img.width || 32}px`;
      span.style.height = `${img.height || 32}px`;
      span.style.background = stableColor(id);
      span.textContent = shortLabel(id);
      img.replaceWith(span);
    }, { once: true });
  });
}

async function api(path) {
  const response = await fetch(path);
  const body = await response.json();
  if (!body.ok) {
    const error = new Error(body.error || response.statusText);
    error.didYouMean = body.did_you_mean || [];
    throw error;
  }
  return body.data;
}

function loadSelection() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    for (const kind of ['items', 'recipes', 'tags']) {
      selection[kind] = new Map(parsed[kind] || []);
    }
  } catch {
    // 坏掉的选集丢掉即可
  }
}

function saveSelection() {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
    items: [...selection.items],
    recipes: [...selection.recipes],
    tags: [...selection.tags],
  }));
}

function selectionCount() {
  return selection.items.size + selection.recipes.size + selection.tags.size;
}

function nodeId(kind, id) {
  if (kind === 'items') return id.startsWith('item:') ? id : `item:${id}`;
  if (kind === 'recipes') return id.startsWith('recipe:') ? id : `recipe:${id}`;
  return id.startsWith('tag:') ? id : `tag:${id}`;
}

function selectedIds() {
  return [
    ...[...selection.items.keys()].map(id => nodeId('items', id)),
    ...[...selection.recipes.keys()].map(id => nodeId('recipes', id)),
    ...[...selection.tags.keys()].map(id => nodeId('tags', id)),
  ];
}

function parseLocation() {
  const url = new URL(location.href);
  const itemMatch = location.pathname.match(/^\/b\/i\/(.+)$/);
  const recipeMatch = location.pathname.match(/^\/b\/r\/(.+)$/);
  state.tab = url.searchParams.get('tab') === 'recipes' ? 'recipes' : 'items';
  state.q = url.searchParams.get('q') || '';
  state.field = url.searchParams.get('field') || 'all';
  state.mod = url.searchParams.get('mod') || '';
  state.tag = url.searchParams.get('tag') || '';
  state.type = url.searchParams.get('type') || '';
  state.page = Math.max(1, Number(url.searchParams.get('page') || 1) || 1);
  state.pageSize = Math.max(1, Number(url.searchParams.get('page-size') || 50) || 50);
  state.view = url.searchParams.get('view') === 'list' ? 'list' : 'grid';
  state.lang = url.searchParams.get('lang') || 'zh_cn';
  if (itemMatch) {
    state.detailKind = 'item';
    state.detailId = decodeURIComponent(itemMatch[1]);
    state.tab = 'items';
  } else if (recipeMatch) {
    state.detailKind = 'recipe';
    state.detailId = decodeURIComponent(recipeMatch[1]);
    state.tab = 'recipes';
  } else {
    state.detailKind = null;
    state.detailId = null;
  }
}

function writeLocation(replace) {
  const url = new URL(location.origin);
  if (state.detailKind === 'item' && state.detailId) {
    url.pathname = `/b/i/${encodeURIComponent(state.detailId)}`;
  } else if (state.detailKind === 'recipe' && state.detailId) {
    url.pathname = `/b/r/${encodeURIComponent(state.detailId)}`;
  } else {
    url.pathname = '/b';
  }
  const params = url.searchParams;
  if (state.tab === 'recipes' && !state.detailKind) params.set('tab', 'recipes');
  if (state.q) params.set('q', state.q);
  if (state.field !== 'all') params.set('field', state.field);
  if (state.mod) params.set('mod', state.mod);
  if (state.tag) params.set('tag', state.tag);
  if (state.type) params.set('type', state.type);
  if (state.page > 1) params.set('page', String(state.page));
  if (state.pageSize !== 50) params.set('page-size', String(state.pageSize));
  if (state.view !== 'grid') params.set('view', state.view);
  if (state.lang !== 'zh_cn') params.set('lang', state.lang);
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
}

function filterQuery() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.field !== 'all') params.set('field', state.field);
  if (state.mod) params.set('mod', state.mod);
  if (state.tab === 'items' && state.tag) params.set('tag', state.tag);
  if (state.tab === 'recipes' && state.type) params.set('type', state.type);
  params.set('page', String(state.page));
  params.set('page-size', String(state.pageSize));
  params.set('lang', state.lang);
  return params.toString();
}

async function loadList() {
  lastError = '';
  try {
    if (state.tab === 'items') {
      const [list, facets] = await Promise.all([
        api(`/api/browse/items?${filterQuery()}`),
        api(`/api/browse/items/facets?${filterQuery()}`),
      ]);
      lastList = { items: list.items, recipes: [] };
      lastFacets = { mods: facets.mods, tags: facets.tags, types: [] };
      lastTotal = list.total;
      lastTruncated = facets.truncated || list.truncated || null;
    } else {
      const [list, facets] = await Promise.all([
        api(`/api/browse/recipes?${filterQuery()}`),
        api(`/api/browse/recipes/facets?${filterQuery()}`),
      ]);
      lastList = { items: [], recipes: list.recipes };
      lastFacets = { mods: facets.mods, tags: [], types: facets.types };
      lastTotal = list.total;
      lastTruncated = facets.truncated || list.truncated || null;
    }
  } catch (error) {
    lastError = error.message;
    lastList = { items: [], recipes: [] };
    lastTotal = 0;
  }
}

async function loadDetail() {
  lastDetail = null;
  if (!state.detailKind || !state.detailId) return;
  try {
    lastDetail = state.detailKind === 'item'
      ? await api(`/api/browse/item?id=${encodeURIComponent(state.detailId)}&lang=${encodeURIComponent(state.lang)}`)
      : await api(`/api/browse/recipe?id=${encodeURIComponent(state.detailId)}&lang=${encodeURIComponent(state.lang)}`);
  } catch (error) {
    lastDetail = { error: error.message, didYouMean: error.didYouMean || [] };
  }
}

function toggleSelected(kind, id, label) {
  if (selection[kind].has(id)) selection[kind].delete(id);
  else selection[kind].set(id, label || id);
  saveSelection();
}

function isSelected(kind, id) {
  return selection[kind].has(id);
}

function pageCount() {
  return Math.max(1, Math.ceil(lastTotal / state.pageSize));
}

function fieldOptions() {
  if (state.tab === 'items') {
    return [
      ['all', '全部'],
      ['id', 'id'],
      ['name', '名称'],
      ['tag', 'tag'],
    ];
  }
  return [
    ['all', 'id / 输入 / 输出'],
    ['id', 'id'],
    ['input', '输入'],
    ['output', '输出'],
    ['json', 'raw JSON（慢）'],
  ];
}

function facetList(title, key, entries, selected) {
  if (!entries.length) return `<div class="empty">没有 ${escapeHtml(title)}</div>`;
  return entries.map(entry => {
    const active = selected === entry.value;
    return `<button class="facet${active ? ' on' : ''}" data-facet="${escapeHtml(key)}" data-value="${escapeHtml(entry.value)}">
      <span>${escapeHtml(entry.value)}</span>
      <span class="meta">${entry.count}</span>
    </button>`;
  }).join('');
}

function itemCard(item) {
  const checked = isSelected('items', item.itemId);
  const name = item.displayName || item.itemId;
  return `<article class="card ${checked ? 'picked' : ''}" data-open-item="${escapeHtml(item.itemId)}">
    <label class="check" data-stop>
      <input type="checkbox" data-pick="items" data-id="${escapeHtml(item.itemId)}" data-label="${escapeHtml(name)}" ${checked ? 'checked' : ''}>
    </label>
    ${itemIcon(item.itemId, { hasIcon: item.hasIcon, displayName: item.displayName, title: name })}
    <div class="card-body">
      <div class="card-name">${escapeHtml(name)}</div>
      <code class="card-id">${escapeHtml(item.itemId)}</code>
    </div>
  </article>`;
}

function recipeCard(recipe) {
  const checked = isSelected('recipes', recipe.recipeId);
  return `<article class="card ${checked ? 'picked' : ''}" data-open-recipe="${escapeHtml(recipe.recipeId)}">
    <label class="check" data-stop>
      <input type="checkbox" data-pick="recipes" data-id="${escapeHtml(recipe.recipeId)}" data-label="${escapeHtml(recipe.recipeId)}" ${checked ? 'checked' : ''}>
    </label>
    ${itemIcon(recipe.primaryOutput, { hasIcon: recipe.primaryHasIcon, title: recipe.primaryOutput || recipe.recipeId })}
    <div class="card-body">
      <div class="card-name">${escapeHtml(recipe.recipeId)}</div>
      <div class="meta">${escapeHtml(recipe.typeId)}${recipe.unparsed ? ' · 未结构化' : ''}</div>
    </div>
  </article>`;
}

function slotIcon(slot, size) {
  if (!slot || !slot.ref) return itemIcon('', { size });
  const id = slot.kind === 'tag' ? `tag:${slot.ref}` : slot.ref;
  const title = slot.displayName || id;
  return itemIcon(id, { size, hasIcon: slot.kind === 'item', displayName: slot.displayName, title });
}

function outputIcon(slot, size) {
  return itemIcon(slot.itemId, { size, hasIcon: true, displayName: slot.displayName, title: slot.displayName || slot.itemId });
}

function groupBySlot(slots) {
  const map = new Map();
  for (const slot of slots) {
    if (!map.has(slot.slot)) map.set(slot.slot, []);
    map.get(slot.slot).push(slot);
  }
  return map;
}

function renderViewCanvas(view, inputs, outputs) {
  const scale = Math.max(2, Math.min(4, Math.floor(360 / Math.max(view.width, 1))));
  const width = view.width * scale;
  const height = view.height * scale;
  const inputMap = groupBySlot(inputs);
  const outputMap = groupBySlot(outputs);
  const bg = view.hasBackground
    ? `<img class="canvas-bg" src="/recipe-bg/${encodeURIComponent(view.typeId)}.png" alt="" width="${width}" height="${height}">`
    : '';
  const slots = view.slots.map(slot => {
    const options = slot.role === 'output' ? (outputMap.get(slot.index) || []) : (inputMap.get(slot.index) || []);
    const first = options[0];
    const inner = slot.role === 'output' && first
      ? outputIcon(first, Math.max(14, Math.floor(slot.w * scale) - 2))
      : slotIcon(first, Math.max(14, Math.floor(slot.w * scale) - 2));
    const extra = options.length > 1 ? `<span class="slot-alt">+${options.length - 1}</span>` : '';
    const count = first && first.count > 1 ? `<span class="slot-count">${first.count}</span>` : '';
    const open = first && ((slot.role === 'output' && first.itemId) || (first.kind === 'item' && first.ref))
      ? `data-open-item="${escapeHtml(slot.role === 'output' ? first.itemId : first.ref)}"`
      : '';
    return `<div class="canvas-slot" ${open} title="${escapeHtml(first?.displayName || first?.ref || first?.itemId || slot.role)}" style="left:${slot.x * scale}px;top:${slot.y * scale}px;width:${slot.w * scale}px;height:${slot.h * scale}px">${inner}${count}${extra}</div>`;
  }).join('');
  return `<div class="canvas" style="width:${width}px;height:${height}px">${bg}${slots}</div>`;
}

function renderShapedGrid(width, height, inputs, outputs) {
  const map = groupBySlot(inputs);
  const cells = [];
  for (let row = 0; row < height; row++) {
    const cols = [];
    for (let col = 0; col < width; col++) {
      const options = map.get(row * width + col) || [];
      const first = options[0];
      const open = first && first.kind === 'item' && first.ref ? `data-open-item="${escapeHtml(first.ref)}"` : '';
      cols.push(`<div class="grid-cell ${first ? '' : 'empty'}" ${open} title="${escapeHtml(first?.displayName || first?.ref || '空')}">${slotIcon(first, 28)}${first && first.count > 1 ? `<span class="slot-count">${first.count}</span>` : ''}${options.length > 1 ? `<span class="slot-alt">+${options.length - 1}</span>` : ''}</div>`);
    }
    cells.push(`<div class="grid-row">${cols.join('')}</div>`);
  }
  const out = outputs[0];
  return `<div class="shaped">
    <div class="shaped-grid">${cells.join('')}</div>
    <div class="shaped-arrow">→</div>
    <div class="grid-cell out" ${out ? `data-open-item="${escapeHtml(out.itemId)}"` : ''}>${out ? outputIcon(out, 36) : ''}${out && out.count > 1 ? `<span class="slot-count">${out.count}</span>` : ''}</div>
  </div>`;
}

function renderSlotList(inputs, outputs) {
  const inputHtml = inputs.length === 0
    ? '<p class="empty">没有结构化输入</p>'
    : inputs.map(slot => `<div class="slot-row" ${slot.kind === 'item' && slot.ref ? `data-open-item="${escapeHtml(slot.ref)}"` : ''}>
        ${slotIcon(slot, 24)}
        <div>
          <code>${escapeHtml(slot.kind === 'tag' ? `tag:${slot.ref}` : (slot.ref || '∅'))}</code>
          <div class="meta">${escapeHtml(slot.displayName || slot.role)} · slot ${slot.slot}${slot.count > 1 ? ` ×${slot.count}` : ''}</div>
        </div>
      </div>`).join('');
  const outputHtml = outputs.length === 0
    ? '<p class="empty">没有结构化输出</p>'
    : outputs.map(slot => `<div class="slot-row" data-open-item="${escapeHtml(slot.itemId)}">
        ${outputIcon(slot, 24)}
        <div>
          <code>${escapeHtml(slot.itemId)}</code>
          <div class="meta">${escapeHtml(slot.displayName || '产物')}${slot.isPrimary ? ' · 主产物' : ''}${slot.count > 1 ? ` ×${slot.count}` : ''}</div>
        </div>
      </div>`).join('');
  return `<div class="slot-cols"><div><h3>输入</h3>${inputHtml}</div><div><h3>输出</h3>${outputHtml}</div></div>`;
}

function renderRecipeCanvas(detail) {
  if (!detail.recipe) return '';
  if (detail.layoutSource === 'recipe_view' && detail.view) {
    return renderViewCanvas(detail.view, detail.inputs, detail.outputs);
  }
  if (detail.layoutSource === 'shaped_grid') {
    return renderShapedGrid(detail.recipe.inputWidth, detail.recipe.inputHeight, detail.inputs, detail.outputs);
  }
  return renderSlotList(detail.inputs, detail.outputs);
}

function renderSuggestions(entries) {
  if (!entries || entries.length === 0) return '';
  return `<div class="suggest">
    <h3>你是不是要找</h3>
    ${entries.map(entry => {
      const kind = entry.id.startsWith('recipe:') ? 'recipe' : 'item';
      const raw = entry.id.replace(/^(item|recipe|tag):/, '');
      const attr = kind === 'recipe' ? 'data-open-recipe' : 'data-open-item';
      return `<button class="linkish" ${attr}="${escapeHtml(raw)}">${escapeHtml(entry.id)}</button>`;
    }).join('')}
  </div>`;
}

function renderItemDetail(detail) {
  if (detail.error) {
    return `<p class="error">${escapeHtml(detail.error)}</p>${renderSuggestions(detail.didYouMean)}`;
  }
  if (!detail.item) return '<p class="empty">物品不存在。</p>';
  const item = detail.item;
  const name = item.displayName || item.itemId;
  const picked = isSelected('items', item.itemId);
  const usages = detail.usages;
  const tags = detail.tags.map(tag => `
    <button class="chip" data-filter-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>
    <button class="chip ghost" data-pick="tags" data-id="${escapeHtml(tag)}" data-label="${escapeHtml(tag)}">${isSelected('tags', tag) ? '已选' : '+选集'}</button>
  `).join('');
  const loot = detail.lootSources.length === 0
    ? '<p class="empty">没有战利品来源（或这张派生表是空的）。</p>'
    : detail.lootSources.map(src => `<div class="row"><div><code>${escapeHtml(src.sourceId)}</code><div class="why">${escapeHtml(src.category)} · ${escapeHtml(src.lootTableId)}</div></div><span class="meta">${escapeHtml(src.sourceName || '')}</span></div>`).join('');
  const usageBlock = usages == null
    ? '<p class="empty">图还没构建。先在项目上跑 <code>graph rebuild</code>。</p>'
    : `<div class="usage">
        <h3>作为输入 · ${usages.inputOfRecipes.length}${usages.truncated?.inputOfRecipes ? ` / ${usages.truncated.inputOfRecipes.total}` : ''}</h3>
        ${usages.inputOfRecipes.length ? usages.inputOfRecipes.map(id => `<button class="linkish" data-open-recipe="${escapeHtml(id)}">${escapeHtml(id)}</button>`).join('') : '<p class="empty">无</p>'}
        <h3>作为输出 · ${usages.outputOfRecipes.length}${usages.truncated?.outputOfRecipes ? ` / ${usages.truncated.outputOfRecipes.total}` : ''}</h3>
        ${usages.outputOfRecipes.length ? usages.outputOfRecipes.map(id => `<button class="linkish" data-open-recipe="${escapeHtml(id)}">${escapeHtml(id)}</button>`).join('') : '<p class="empty">无</p>'}
      </div>`;
  return `
    <div class="detail-head">
      ${itemIcon(item.itemId, { size: 48, hasIcon: item.hasIcon, displayName: item.displayName, title: name })}
      <div>
        <h2>${escapeHtml(name)}</h2>
        <code>${escapeHtml(item.itemId)}</code>
        <div class="meta">${escapeHtml(item.modid)}${item.isBlock ? ' · block' : ''}</div>
      </div>
    </div>
    <div class="actions">
      <button data-pick="items" data-id="${escapeHtml(item.itemId)}" data-label="${escapeHtml(name)}">${picked ? '从选集去掉' : '加入选集'}</button>
    </div>
    <h3>Tags${detail.tagsTruncated ? ` · 截断 ${detail.tagsTruncated.returned}/${detail.tagsTruncated.total}` : ''}</h3>
    <div class="chips">${tags || '<span class="empty">无</span>'}</div>
    <h3>战利品来源${detail.lootTruncated ? ` · 截断 ${detail.lootTruncated.returned}/${detail.lootTruncated.total}` : ''}</h3>
    ${loot}
    ${usageBlock}
  `;
}

function renderRecipeDetail(detail) {
  if (detail.error) {
    return `<p class="error">${escapeHtml(detail.error)}</p>${renderSuggestions(detail.didYouMean)}`;
  }
  if (!detail.recipe) return '<p class="empty">配方不存在。</p>';
  const recipe = detail.recipe;
  const picked = isSelected('recipes', recipe.recipeId);
  return `
    <div class="detail-head">
      ${itemIcon(recipe.primaryOutput, { size: 48, hasIcon: recipe.primaryHasIcon, title: recipe.primaryOutput || recipe.recipeId })}
      <div>
        <h2>${escapeHtml(recipe.recipeId)}</h2>
        <div class="meta">${escapeHtml(recipe.typeId)} · ${escapeHtml(recipe.modid)}${recipe.unparsed ? ' · 未结构化' : ''}</div>
      </div>
    </div>
    <div class="actions">
      <button data-pick="recipes" data-id="${escapeHtml(recipe.recipeId)}" data-label="${escapeHtml(recipe.recipeId)}">${picked ? '从选集去掉' : '加入选集'}</button>
    </div>
    <p class="layout-note">${escapeHtml(detail.layoutNote)}</p>
    ${renderRecipeCanvas(detail)}
  `;
}

function renderSelectionBar() {
  const count = selectionCount();
  const chips = [
    ...[...selection.items.keys()].slice(0, 8).map(id => `<code>${escapeHtml(id)}</code>`),
    ...[...selection.recipes.keys()].slice(0, 4).map(id => `<code>${escapeHtml(id)}</code>`),
    ...[...selection.tags.keys()].slice(0, 4).map(id => `<code>tag:${escapeHtml(id)}</code>`),
  ];
  const more = count - chips.length;
  return `<footer class="tray">
    <div class="tray-main">
      <strong>选集 ${count}</strong>
      <span class="meta">未审核、不是 scope、没有 saturated。只出剪贴板 / 下载。</span>
      <div class="tray-ids">${chips.join(' ')}${more > 0 ? ` <span class="meta">+${more}</span>` : ''}</div>
    </div>
    <div class="tray-actions">
      <button data-export="ids" ${count ? '' : 'disabled'}>复制 ID</button>
      <button data-export="json" ${count ? '' : 'disabled'}>复制 JSON</button>
      <button data-export="txt" ${count ? '' : 'disabled'}>下载 .txt</button>
      <button data-export="scope" ${count ? '' : 'disabled'}>复制 scope create</button>
      <button data-clear ${count ? '' : 'disabled'}>清空</button>
    </div>
  </footer>`;
}

function renderShell() {
  const prevSearch = document.getElementById('search');
  const keepSearch = Boolean(prevSearch && document.activeElement === prevSearch);
  const liveQ = keepSearch ? prevSearch.value : state.q;
  const selStart = keepSearch ? prevSearch.selectionStart : null;
  const selEnd = keepSearch ? prevSearch.selectionEnd : null;
  const itemFields = fieldOptions();
  const pages = pageCount();
  const cards = state.tab === 'items'
    ? lastList.items.map(itemCard).join('')
    : lastList.recipes.map(recipeCard).join('');
  const drawer = state.detailKind
    ? `<aside class="drawer">
        <button class="drawer-close" data-close>关闭</button>
        ${lastDetail
          ? (state.detailKind === 'item' ? renderItemDetail(lastDetail) : renderRecipeDetail(lastDetail))
          : '<p class="empty">加载详情…</p>'}
      </aside>`
    : '';

  app.innerHTML = `
    <section class="browse-toolbar">
      <div class="tabs">
        <button data-tab="items" aria-selected="${state.tab === 'items'}">物品</button>
        <button data-tab="recipes" aria-selected="${state.tab === 'recipes'}">配方</button>
      </div>
      <input id="search" type="text" value="${escapeHtml(liveQ)}" placeholder="${state.tab === 'items' ? '搜 id / 名 / tag' : '搜配方 id / 输入 / 输出'}" />
      <select id="field">
        ${itemFields.map(([value, label]) => `<option value="${value}" ${state.field === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <select id="lang">
        <option value="zh_cn" ${state.lang === 'zh_cn' ? 'selected' : ''}>zh_cn</option>
        <option value="en_us" ${state.lang === 'en_us' ? 'selected' : ''}>en_us</option>
      </select>
      ${state.tab === 'items' ? `
        <div class="tabs">
          <button data-view="grid" aria-selected="${state.view === 'grid'}">网格</button>
          <button data-view="list" aria-selected="${state.view === 'list'}">列表</button>
        </div>` : ''}
    </section>
    <section class="browse-body">
      <aside class="facets">
        <h2>Mod</h2>
        ${facetList('mod', 'mod', lastFacets.mods, state.mod)}
        ${state.tab === 'items'
          ? `<h2>Tag</h2>${facetList('tag', 'tag', lastFacets.tags, state.tag)}`
          : `<h2>类型</h2>${facetList('type', 'type', lastFacets.types, state.type)}`}
        ${lastTruncated ? `<p class="meta">分面有截断，计数不是全集。</p>` : ''}
      </aside>
      <section class="browse-main">
        ${lastError ? `<p class="error">${escapeHtml(lastError)}</p>` : ''}
        <div class="browse-meta">
          <span>${lastTotal} 条 · 第 ${state.page}/${pages} 页</span>
          <label>每页
            <select id="page-size">
              ${[50, 100, 200].map(n => `<option value="${n}" ${state.pageSize === n ? 'selected' : ''}>${n}</option>`).join('')}
            </select>
          </label>
          <button data-page="prev" ${state.page <= 1 ? 'disabled' : ''}>上一页</button>
          <button data-page="next" ${state.page >= pages ? 'disabled' : ''}>下一页</button>
          <button data-pick-page>本页全选</button>
        </div>
        <div class="cards ${state.tab === 'items' && state.view === 'list' ? 'listish' : ''}">
          ${cards || '<p class="empty">没有匹配的结果。</p>'}
        </div>
      </section>
      ${drawer}
    </section>
    ${renderSelectionBar()}
  `;
  bindBrokenIcons(app);
  bindEvents();
  if (keepSearch) {
    const search = document.getElementById('search');
    search.focus();
    if (selStart != null && selEnd != null) search.setSelectionRange(selStart, selEnd);
  }
}

function setFilter(patch, resetPage = true) {
  Object.assign(state, patch);
  if (resetPage) state.page = 1;
  writeLocation(true);
  void refresh();
}

function openDetail(kind, id) {
  state.detailKind = kind;
  state.detailId = id;
  if (kind === 'item') state.tab = 'items';
  if (kind === 'recipe') state.tab = 'recipes';
  writeLocation(false);
  void refresh();
}

function closeDetail() {
  state.detailKind = null;
  state.detailId = null;
  writeLocation(true);
  void refresh();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function exportSelection(mode) {
  const ids = selectedIds();
  if (ids.length === 0) return;
  if (mode === 'ids') {
    void copyText(ids.join('\n'));
    return;
  }
  if (mode === 'json') {
    void copyText(JSON.stringify(ids, null, 2));
    return;
  }
  if (mode === 'txt') {
    downloadText('delightify-ids.txt', `${ids.join('\n')}\n`);
    return;
  }
  if (mode === 'scope') {
    void copyText(`node scripts/agent-query.mjs <p> scope create picked ${ids.join(' ')}`);
  }
}

function pickFromEvent(target) {
  const kind = target.getAttribute('data-pick');
  const id = target.getAttribute('data-id');
  if (!kind || !id) return;
  toggleSelected(kind, id, target.getAttribute('data-label') || id);
  renderShell();
}

function bindEvents() {
  const search = document.getElementById('search');
  search?.addEventListener('input', event => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      const nextField = state.field === 'all' || fieldOptions().some(([value]) => value === state.field)
        ? state.field
        : 'all';
      setFilter({ q: event.target.value, field: nextField });
    }, 220);
  });
  document.getElementById('field')?.addEventListener('change', event => {
    setFilter({ field: event.target.value });
  });
  document.getElementById('lang')?.addEventListener('change', event => {
    setFilter({ lang: event.target.value });
  });
  document.getElementById('page-size')?.addEventListener('change', event => {
    setFilter({ pageSize: Number(event.target.value) || 50 });
  });

  app.querySelectorAll('[data-tab]').forEach(button => {
    button.addEventListener('click', () => {
      const tab = button.getAttribute('data-tab');
      setFilter({
        tab,
        field: 'all',
        tag: tab === 'items' ? state.tag : '',
        type: tab === 'recipes' ? state.type : '',
        detailKind: null,
        detailId: null,
      });
    });
  });
  app.querySelectorAll('[data-view]').forEach(button => {
    button.addEventListener('click', () => setFilter({ view: button.getAttribute('data-view') }, false));
  });
  app.querySelectorAll('[data-facet]').forEach(button => {
    button.addEventListener('click', () => {
      const key = button.getAttribute('data-facet');
      const value = button.getAttribute('data-value') || '';
      const current = key === 'mod' ? state.mod : key === 'tag' ? state.tag : state.type;
      setFilter({ [key === 'type' ? 'type' : key]: current === value ? '' : value });
    });
  });
  app.querySelectorAll('[data-page]').forEach(button => {
    button.addEventListener('click', () => {
      const dir = button.getAttribute('data-page');
      const next = dir === 'next' ? state.page + 1 : state.page - 1;
      setFilter({ page: Math.min(pageCount(), Math.max(1, next)) }, false);
    });
  });
  app.querySelector('[data-pick-page]')?.addEventListener('click', () => {
    if (state.tab === 'items') {
      for (const item of lastList.items) selection.items.set(item.itemId, item.displayName || item.itemId);
    } else {
      for (const recipe of lastList.recipes) selection.recipes.set(recipe.recipeId, recipe.recipeId);
    }
    saveSelection();
    renderShell();
  });
  app.querySelectorAll('[data-pick]').forEach(node => {
    node.addEventListener('click', event => {
      event.stopPropagation();
      pickFromEvent(node.matches('[data-pick]') ? node : node.closest('[data-pick]'));
    });
  });
  app.querySelectorAll('[data-stop]').forEach(node => {
    node.addEventListener('click', event => event.stopPropagation());
  });
  app.querySelectorAll('[data-open-item]').forEach(node => {
    node.addEventListener('click', () => openDetail('item', node.getAttribute('data-open-item')));
  });
  app.querySelectorAll('[data-open-recipe]').forEach(node => {
    node.addEventListener('click', () => openDetail('recipe', node.getAttribute('data-open-recipe')));
  });
  app.querySelectorAll('[data-filter-tag]').forEach(node => {
    node.addEventListener('click', () => setFilter({ tab: 'items', tag: node.getAttribute('data-filter-tag'), detailKind: null, detailId: null }));
  });
  app.querySelector('[data-close]')?.addEventListener('click', () => closeDetail());
  app.querySelectorAll('[data-export]').forEach(button => {
    button.addEventListener('click', () => exportSelection(button.getAttribute('data-export')));
  });
  app.querySelector('[data-clear]')?.addEventListener('click', () => {
    selection.items.clear();
    selection.recipes.clear();
    selection.tags.clear();
    saveSelection();
    renderShell();
  });
}

async function refresh() {
  const seq = ++requestSeq;
  await Promise.all([loadList(), loadDetail()]);
  if (seq !== requestSeq) return;
  renderShell();
}

async function boot() {
  loadSelection();
  parseLocation();
  if (state.tab === 'recipes' && !['all', 'id', 'input', 'output', 'json'].includes(state.field)) {
    state.field = 'all';
  }
  if (state.tab === 'items' && !['all', 'id', 'name', 'tag'].includes(state.field)) {
    state.field = 'all';
  }
  try {
    await refresh();
  } catch (error) {
    app.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}

window.addEventListener('popstate', () => {
  parseLocation();
  void refresh();
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.detailKind) closeDetail();
});

void boot();
