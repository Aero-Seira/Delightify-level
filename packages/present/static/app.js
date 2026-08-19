const app = document.getElementById('app');

function scopeFromPath() {
  const match = location.pathname.match(/^\/s\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error || response.statusText);
  return body.data;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function badgeSaturated(saturated) {
  return saturated
    ? '<span class="badge ok">saturated</span>'
    : '<span class="badge bad">未饱和</span>';
}

function badgeStatus(status) {
  return status === 'reviewed'
    ? '<span class="badge reviewed">已审</span>'
    : '<span class="badge draft">draft</span>';
}

function typeOf(id) {
  if (id.startsWith('tag:')) return 'tag';
  if (id.startsWith('recipe:')) return 'recipe';
  if (id.startsWith('loot:')) return 'loot_source';
  return 'item';
}

function nodeIcon(id) {
  if (!id.startsWith('item:')) return '';
  const bare = id.slice('item:'.length);
  return `<img class="item-icon" data-id="${escapeHtml(bare)}" src="/icon/${encodeURIComponent(bare)}.png" width="18" height="18" alt="" loading="lazy">`;
}

function bindBrokenIcons(root) {
  root.querySelectorAll('img.item-icon').forEach(img => {
    img.addEventListener('error', () => img.remove(), { once: true });
  });
}

function modOf(id) {
  const rest = id.replace(/^(item|tag|recipe|loot):/, '');
  const colon = rest.indexOf(':');
  return colon > 0 ? rest.slice(0, colon) : '_';
}

async function renderList() {
  const scopes = await api('/api/scopes');
  const rows = scopes.length === 0
    ? '<p class="empty">还没有 scope。用下面的表单从种子创建，或先跑 CLI <code>scope create</code>。</p>'
    : `<ul class="list">${scopes.map(scope => `
        <li>
          <a href="/s/${encodeURIComponent(scope.id)}"><strong>${escapeHtml(scope.id)}</strong></a>
          ${badgeStatus(scope.status)}
          ${scope.saturated ? badgeSaturated(true) : badgeSaturated(false)}
          <div class="meta">${escapeHtml(scope.policy)} · ${scope.memberCount} 个成员
            · item ${scope.counts.item} / tag ${scope.counts.tag} / recipe ${scope.counts.recipe}
            · ${escapeHtml(scope.updatedAt)}</div>
        </li>`).join('')}</ul>`;

  app.innerHTML = `
    <div class="banner"><h1>scopes</h1></div>
    <form class="form" id="create-form">
      <input name="scopeId" type="text" placeholder="名字，如 pasta" required />
      <input name="seeds" type="text" placeholder="种子，空格分隔" required />
      <select name="policy">
        <option value="recipe-impact">recipe-impact</option>
        <option value="obtainability">obtainability</option>
        <option value="same-concept">same-concept</option>
      </select>
      <button class="primary" type="submit">创建并计算闭包</button>
    </form>
    <div id="error" class="error"></div>
    ${rows}
  `;

  document.getElementById('create-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    const id = form.scopeId.value.trim();
    const seeds = form.seeds.value.trim().split(/\s+/).filter(Boolean);
    const error = document.getElementById('error');
    error.textContent = '';
    try {
      await api('/api/scopes', {
        method: 'POST',
        body: JSON.stringify({ id, seeds, policy: form.policy.value }),
      });
      location.href = `/s/${encodeURIComponent(id)}`;
    } catch (err) {
      error.textContent = err.message;
    }
  });
}

function memberGroups(members, typeFilter) {
  const groups = new Map();
  for (const id of members) {
    const type = typeOf(id);
    if (typeFilter !== 'all' && type !== typeFilter) continue;
    const mod = type === 'item' ? modOf(id) : '';
    const key = `${type}:${mod}`;
    if (!groups.has(key)) groups.set(key, { type, mod, ids: [] });
    groups.get(key).ids.push(id);
  }
  return [...groups.values()];
}

async function renderScope(id) {
  const scope = await api(`/api/scopes/${encodeURIComponent(id)}`);
  const typeFilter = new URLSearchParams(location.search).get('type') || 'all';
  const groups = memberGroups(scope.members, typeFilter);

  app.innerHTML = `
    <div class="banner">
      <h1>${escapeHtml(scope.id)}</h1>
      ${badgeSaturated(scope.saturated)}
      ${badgeStatus(scope.status)}
      <span class="meta">${escapeHtml(scope.policy)} · ${scope.iterations} 轮
        · item ${scope.counts.item} / tag ${scope.counts.tag} / recipe ${scope.counts.recipe} / loot ${scope.counts.loot_source}
        ${scope.truncated ? ` · 成员截断 ${scope.truncated.returned}/${scope.truncated.total}` : ''}
        ${scope.closureTruncated ? ` · 闭包截断 ${escapeHtml(scope.closureTruncated.by)}` : ''}
      </span>
    </div>
    <div class="meta">种子：${scope.seeds.map(escapeHtml).join(', ') || '（无）'}</div>
    <div class="actions">
      <button data-act="recompute">重算闭包</button>
      <button data-act="review" class="primary">标记已审</button>
      <button data-act="copy">复制成员 ID</button>
      <form id="add-form" class="form" style="margin:0">
        <input name="nodeId" type="text" placeholder="补一个 node id" />
        <button type="submit">add</button>
      </form>
    </div>
    <div id="error" class="error"></div>
    <div class="grid">
      <div>
        <section class="panel warn">
          <h2>Frontier · 停在哪</h2>
          ${scope.frontier.length === 0
            ? '<p class="empty">没有被守卫拦下的节点。</p>'
            : scope.frontier.map(entry => `
              <div class="row">
                <div>
                  <code>${escapeHtml(entry.nodeId)}</code>
                  <div class="why">${escapeHtml(entry.reason)}${entry.via ? ` · ${escapeHtml(entry.via)}` : ''}</div>
                </div>
                <span class="meta">${entry.wouldAdd || ''}</span>
              </div>`).join('')}
        </section>
        <section class="panel miss" style="margin-top:12px">
          <h2>Near misses · 差一点</h2>
          ${scope.nearMisses.length === 0
            ? '<p class="empty">没有 near misses。</p>'
            : scope.nearMisses.map(entry => `
              <div class="row">
                <div>
                  <code>${escapeHtml(entry.nodeId)}</code>
                  <div class="why">${escapeHtml(entry.why)}</div>
                </div>
                <button data-add="${escapeHtml(entry.nodeId)}">纳入</button>
              </div>`).join('')}
        </section>
      </div>
      <section class="panel">
        <h2>Members</h2>
        <div class="tabs">
          ${['all', 'item', 'tag', 'recipe', 'loot_source'].map(type => `
            <button data-type="${type}" aria-selected="${typeFilter === type}">${type}</button>
          `).join('')}
        </div>
        ${groups.length === 0
          ? '<p class="empty">这一类没有成员（或被截断在默认页之外）。</p>'
          : groups.map(group => `
            <details class="group" ${group.ids.length <= 24 ? 'open' : ''}>
              <summary>${escapeHtml(group.type)}${group.mod ? ` / ${escapeHtml(group.mod)}` : ''} · ${group.ids.length}</summary>
              ${group.ids.map(nodeId => `
                <div class="member">
                  <button data-drop="${escapeHtml(nodeId)}">去掉</button>
                  ${nodeIcon(nodeId)}
                  <code>${escapeHtml(nodeId)}</code>
                </div>`).join('')}
            </details>`).join('')}
      </section>
    </div>
  `;

  const error = document.getElementById('error');
  const fail = err => { error.textContent = err.message; };

  app.querySelector('[data-act="recompute"]').addEventListener('click', async () => {
    try {
      await api(`/api/scopes/${encodeURIComponent(id)}/recompute`, { method: 'POST', body: '{}' });
      await renderScope(id);
    } catch (err) { fail(err); }
  });
  app.querySelector('[data-act="review"]').addEventListener('click', async () => {
    try {
      await api(`/api/scopes/${encodeURIComponent(id)}/review`, { method: 'POST', body: '{}' });
      await renderScope(id);
    } catch (err) { fail(err); }
  });
  app.querySelector('[data-act="copy"]').addEventListener('click', async () => {
    const full = await api(`/api/scopes/${encodeURIComponent(id)}?members-limit=100000`);
    const text = JSON.stringify(full.members, null, 2);
    await navigator.clipboard.writeText(text);
  });
  document.getElementById('add-form').addEventListener('submit', async event => {
    event.preventDefault();
    const nodeId = event.target.nodeId.value.trim();
    if (!nodeId) return;
    try {
      await api(`/api/scopes/${encodeURIComponent(id)}/add`, {
        method: 'POST',
        body: JSON.stringify({ nodeId }),
      });
      await renderScope(id);
    } catch (err) { fail(err); }
  });
  app.querySelectorAll('[data-add]').forEach(button => {
    button.addEventListener('click', async () => {
      try {
        await api(`/api/scopes/${encodeURIComponent(id)}/add`, {
          method: 'POST',
          body: JSON.stringify({ nodeId: button.getAttribute('data-add') }),
        });
        await renderScope(id);
      } catch (err) { fail(err); }
    });
  });
  app.querySelectorAll('[data-drop]').forEach(button => {
    button.addEventListener('click', async () => {
      try {
        await api(`/api/scopes/${encodeURIComponent(id)}/drop`, {
          method: 'POST',
          body: JSON.stringify({ nodeId: button.getAttribute('data-drop') }),
        });
        await renderScope(id);
      } catch (err) { fail(err); }
    });
  });
  app.querySelectorAll('[data-type]').forEach(button => {
    button.addEventListener('click', () => {
      const type = button.getAttribute('data-type');
      const next = new URL(location.href);
      if (type === 'all') next.searchParams.delete('type');
      else next.searchParams.set('type', type);
      history.replaceState(null, '', next);
      void renderScope(id);
    });
  });
  bindBrokenIcons(app);
}

async function boot() {
  try {
    const id = scopeFromPath();
    if (id) await renderScope(id);
    else await renderList();
  } catch (error) {
    app.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}

void boot();
