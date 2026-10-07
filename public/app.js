'use strict';

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
let toastTimer = null;

function toast(msg, kind = '') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3500);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
  });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error || `请求失败 (${res.status})`);
      err.payload = data;
      err.status = res.status;
      throw err;
    }
    return data;
  }
  if (!res.ok) throw new Error(`请求失败 (${res.status})`);
  return res;
}

// 遇到 409 版本过期时，提示并刷新当前页面数据
async function withVersionGuard(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.status === 409) {
      toast(`版本校验失败：${err.message}，页面将刷新到最新结果`, 'error');
      setTimeout(() => route(), 900);
    } else {
      toast(err.message, 'error');
    }
    throw err;
  }
}

// ---------- 路由 ----------
function route() {
  const hash = location.hash || '#/';
  const m = /^#\/scripts\/(\d+)/.exec(hash);
  if (m) renderScript(Number(m[1])).catch((e) => toast(e.message, 'error'));
  else renderHome().catch((e) => toast(e.message, 'error'));
}
window.addEventListener('hashchange', route);

// ---------- 首页 ----------
async function renderHome() {
  const { scripts } = await api('/api/scripts');
  const items = scripts.length
    ? scripts.map((s) => {
        const tags = [];
        if (s.latestConfirmedVersionId) tags.push('<span class="badge confirmed">已有确认版</span>');
        if (s.draftVersionId) tags.push('<span class="badge draft">有草稿/待处理修订</span>');
        if (!tags.length) tags.push('<span class="badge draft">首版草稿</span>');
        return `<div class="script-item">
          <a class="title" href="#/scripts/${s.id}">${esc(s.title)}</a>
          <span class="kv">创建于 ${esc(s.createdAt)}</span>
          <span class="spacer"></span>${tags.join(' ')}
        </div>`;
      }).join('')
    : '<p class="muted">还没有剧本。舞监可在下方逐场录入第一部。</p>';

  app.innerHTML = `
    <div class="card">
      <h1>剧本列表</h1>
      ${items}
    </div>
    <div class="card">
      <h2>新建剧本（逐场录入首版）</h2>
      <p class="muted">在下方按场填写：场名一行、随后是该场台词行；空行分隔各场。也可用【场名】作为场头。</p>
      <label class="field">剧名
        <input type="text" id="f-title" placeholder="例如：雷雨" />
      </label>
      <label class="field">逐场文本
        <textarea id="f-text" rows="12" placeholder="【开场】&#10;四凤 在大厅。&#10;鲁贵 （咳嗽）四凤！&#10;&#10;【第二幕】&#10;周朴园 你来做什么？"></textarea>
      </label>
      <button id="f-create">创建并进入首版草稿</button>
    </div>`;

  document.getElementById('f-create').addEventListener('click', async () => {
    const title = document.getElementById('f-title').value.trim();
    const text = document.getElementById('f-text').value;
    try {
      const scenes = parseSceneText(text);
      const v = await withVersionGuard(() =>
        api('/api/scripts', { method: 'POST', body: JSON.stringify({ title, scenes }) }));
      location.hash = `#/scripts/${v.scriptId}`;
    } catch (e) {
      toast(e.message, 'error');
    }
  });
}

/** 解析录入文本：【场名】行或连续两个换行分界；要求显式场名 */
function parseSceneText(text) {
  const scenes = [];
  let cur = null;
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const rawLines = block.split('\n');
    const head = /^【\s*(.+?)\s*】\s*$/.exec(rawLines[0].trim());
    let name;
    let lines;
    if (head) {
      name = head[1].trim();
      lines = rawLines.slice(1);
    } else {
      // 无【】时要求首行以“场”字开头作为场名
      const m2 = /^(.{1,30}场)\s*$/.exec(rawLines[0].trim());
      if (!m2) {
        throw new Error(`无法识别场名，请用【场名】开头。问题段落：${rawLines[0].slice(0, 20)}`);
      }
      name = m2[1];
      lines = rawLines.slice(1);
    }
    scenes.push({ name, lines });
  }
  return scenes;
}

// ---------- 剧本详情 ----------
async function renderScript(id) {
  const data = await api(`/api/scripts/${id}`);
  const { confirmed, draft } = data;

  app.innerHTML = `
    <div class="card">
      <div class="row">
        <h1>${esc(data.title)}</h1>
        <span class="spacer"></span>
        <a class="btn secondary" href="#/">← 返回列表</a>
      </div>
      <div class="kv">
        最近确认版：${confirmed ? `v${confirmed.versionNo}` : '尚无（需先确认首版）'}
        ${draft ? `　·　当前草稿：v${draft.versionNo}（修订号 ${draft.revision}）` : ''}
      </div>
    </div>
    ${draft ? renderDraft(data, draft) : renderImportCard(data, confirmed)}
    ${confirmed ? renderConfirmed(confirmed) : ''}
  `;
  bindDraftEvents(id, data);
}

function renderImportCard(data, confirmed) {
  if (!confirmed) {
    return `<div class="card"><p class="muted">首版尚未确认。当前没有可编辑草稿（可能已被放弃）；请新建剧本重新录入。</p></div>`;
  }
  return `<div class="card">
    <h2>导入修订稿（基准：v${confirmed.versionNo}）</h2>
    <p class="muted">粘贴修订后的全稿文本，使用【场名】作为场头。系统将以最近已确认版为基准做标记迁移：<br>
      同场内文本连续且唯一匹配 → 自动迁移；删改、跨场移动或重复匹配 → 列入待核，不做猜测。</p>
    <textarea id="imp-text" rows="12" placeholder="【开场】&#10;……修订后的台词……"></textarea>
    <div class="row" style="margin-top:10px">
      <button id="imp-go">解析并导入修订稿</button>
      <span class="kv">基准版修订号：${confirmed.revision}（用于版本校验）</span>
    </div>
  </div>`;
}

// ---------- 草稿（首版草稿 or 修订草稿） ----------
function renderDraft(data, draft) {
  const isRevision = draft.baseVersionId !== null;
  const marksOn = marksByLine(draft);
  const pendingMarks = draft.marks.filter((m) => m.status === 'pending');
  const discardedMarks = draft.marks.filter((m) => m.status === 'discarded');

  return `
  <div class="card">
    <div class="row">
      <h2>草稿 v${draft.versionNo}</h2>
      <span class="badge draft">${isRevision ? '修订草稿' : '首版草稿'}</span>
      <span class="badge ${pendingMarks.length ? 'pending' : 'confirmed'}">
        待核 ${pendingMarks.length} 条</span>
      <span class="spacer"></span>
      <button class="ghost" id="d-abandon">放弃此草稿</button>
    </div>

    ${isRevision
      ? `<div class="kv" style="margin:6px 0 4px">基准版本 ID：${draft.baseVersionId}；
           自动迁移规则只在同场同名、连续且唯一命中时生效。下方对照可核对每条标记去向。</div>`
      : `<p class="muted" style="margin:6px 0">舞监可在连续行上附加提示标记与说明。确认首版后才能导入修订稿。</p>`}

    ${pendingMarks.length
      ? `<div class="pending-banner">⚠ 还有 <b>${pendingMarks.length}</b> 条待核标记未处理完，未处理前无法确认或导出新稿。</div>`
      : ''}

    <div id="scenes">${draft.scenes.map((sc) => renderScene(sc, marksOn)).join('')}</div>

    <h3>➕ 在连续行上添加提示标记</h3>
    ${renderAddMarkForm(draft)}

    ${isRevision && pendingMarks.length ? `<h3>🔎 待核标记（${pendingMarks.length}）</h3>` + pendingMarks.map((m) => renderPending(m, draft)).join('') : ''}
    ${isRevision && discardedMarks.length ? `<h3>🗑 已废弃记录（${discardedMarks.length}）</h3>` + discardedMarks.map(renderDiscarded).join('') : ''}

    <div class="row" style="margin-top:18px">
      <button id="d-confirm" ${pendingMarks.length ? 'disabled' : ''}>
        ${pendingMarks.length ? '存在待核，不可确认' : '确认此版本'}
      </button>
      <span class="kv">确认采用版本校验（修订号 ${draft.revision}）；旧页面提交不会覆盖较新结果，失败时保留原确认版。</span>
    </div>
  </div>`;
}

function marksByLine(version) {
  const map = new Map();
  for (const m of version.marks) {
    if (m.status !== 'active') continue;
    const key = `${m.sceneId}:${m.startLine}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(m);
  }
  return map;
}

function renderScene(sc, marksOn) {
  const lines = sc.lines.map((l) => {
    const chips = (marksOn.get(`${sc.id}:${l.ord}`) || [])
      .map((m) => `<span class="mark-chip ${m.fromMigration ? 'migrated' : ''}">
        ${m.fromMigration ? '🔁 ' : '🏷 '}<b>${esc(m.label)}</b>
        （第${m.startLine}${m.endLine > m.startLine ? '-' + m.endLine : ''}行）
        ${m.note ? `<span class="mark-note">｜${esc(m.note)}</span>` : ''}
      </span>`).join('');
    return `<div class="line-row"><span class="line-no">${l.ord}</span><span class="line-text">${esc(l.text)}</span></div>${chips}`;
  }).join('');
  return `<div class="scene-block">
    <div class="scene-head">【${esc(sc.name)}】<span class="kv">共 ${sc.lines.length} 行</span></div>
    ${lines}
  </div>`;
}

function renderAddMarkForm(draft) {
  const opts = draft.scenes.map((s) =>
    `<option value="${s.ord}">第${s.ord}场 · ${esc(s.name)}（${s.lines.length} 行）</option>`).join('');
  return `<div class="grid2">
    <label class="field">所在场<select id="m-scene">${opts}</select></label>
    <div class="row">
      <label class="field" style="flex:1">起始行<input type="text" id="m-start" placeholder="如 2" /></label>
      <label class="field" style="flex:1">结束行<input type="text" id="m-end" placeholder="如 4（单行则与起始相同）" /></label>
    </div>
    <label class="field">提示标记名<input type="text" id="m-label" placeholder="如：灯光提示 / 换景" /></label>
    <label class="field">说明<input type="text" id="m-note" placeholder="如：此处停顿三秒" /></label>
  </div>
  <button id="m-add">附加标记</button>`;
}

const REASON_TEXT = {
  deleted_or_edited: '同名场内未找到连续原文：可能已删除或台词被改动',
  duplicate: '同名场内存在多处相同连续文本，无法唯一判定归属',
  moved: '同名场内无匹配，但在其它场找到相同文本（疑似跨场移动）',
};

function renderPending(m, draft) {
  const src = (m.sourceTexts || []).map((t) => `<div class="src-text">${esc(t)}</div>`).join('');
  const cands = (m.candidates || []).map((c) => `
    <div class="cand-item">
      <span class="badge ${c.sameScene ? 'active' : 'migrated'}">${c.sameScene ? '同场候选' : '跨场候选'}</span>
      <span>【${esc(c.sceneName)}】第 ${c.startLine}–${c.endLine} 行</span>
      <span class="spacer"></span>
      <button class="secondary" data-act="pick" data-scene-ord="${sceneOrdOf(draft, c.sceneId)}"
        data-start="${c.startLine}" data-end="${c.endLine}">选这连续行</button>
    </div>`).join('');

  return `<div class="pending-card" data-mark-id="${m.id}">
    <div class="row">
      <span class="badge pending">待核</span>
      <b>🏷 ${esc(m.label)}</b>
      <span class="kv">${REASON_TEXT[m.pendingReason] || m.pendingReason}</span>
    </div>
    <div class="kv" style="margin:4px 0">原位置：【${esc(m.sourceSceneName)}】第 ${m.sourceStartLine}–${m.sourceEndLine} 行
      ${m.note ? `｜${esc(m.note)}` : ''}</div>
    ${src}
    ${cands ? `<div class="cand-list">${cands}</div>` : '<p class="muted">无候选位置。</p>'}
    <div class="row" style="margin-top:8px">
      <span class="kv">手动选择新稿连续行：</span>
      <select class="p-scene" style="width:auto">
        ${draft.scenes.map((s) => `<option value="${s.ord}">第${s.ord}场 · ${esc(s.name)}（${s.lines.length}行）</option>`).join('')}
      </select>
      <input class="p-start" type="text" placeholder="起" style="width:70px" />
      <input class="p-end" type="text" placeholder="止" style="width:70px" />
      <button class="secondary p-apply">定位到所选行</button>
      <span class="spacer"></span>
      <button class="danger p-discard">废弃此标记</button>
    </div>
  </div>`;
}

function sceneOrdOf(draft, sceneId) {
  const sc = draft.scenes.find((x) => x.id === sceneId);
  return sc ? sc.ord : '';
}

function renderDiscarded(m) {
  return `<div class="discarded-item">
    ✗ <b>${esc(m.label)}</b> 原位置【${esc(m.sourceSceneName)}】第 ${m.sourceStartLine}–${m.sourceEndLine} 行
    ${m.note ? `｜${esc(m.note)}` : ''}
  </div>`;
}

// ---------- 已确认版 ----------
function renderConfirmed(v) {
  const marksOn = marksByLine(v);
  const discarded = v.marks.filter((m) => m.status === 'discarded');
  return `<div class="card">
    <div class="row">
      <h2>最近已确认版 v${v.versionNo}</h2>
      <span class="badge confirmed">已确认 ${esc(v.confirmedAt || '')}</span>
      <span class="spacer"></span>
      <a class="btn" href="/api/versions/${v.id}/export">⬇ 导出带标记纯文本</a>
    </div>
    <div id="scenes">${v.scenes.map((sc) => renderScene(sc, marksOn)).join('')}</div>
    ${discarded.length ? `<h3>🗑 废弃记录（${discarded.length}）</h3>` + discarded.map(renderDiscarded).join('') : ''}
  </div>`;
}

// ---------- 事件绑定 ----------
function bindDraftEvents(scriptId, data) {
  const draft = data.draft;
  if (!draft) {
    const btn = document.getElementById('imp-go');
    if (btn) {
      btn.addEventListener('click', async () => {
        const text = document.getElementById('imp-text').value;
        try {
          const scenes = parseImportTextStrict(text);
          await withVersionGuard(() =>
            api(`/api/scripts/${scriptId}/import?revision=${data.confirmed.revision}`, {
              method: 'POST',
              body: JSON.stringify({ revision: data.confirmed.revision, scenes }),
            }));
          toast('修订稿已导入，请核对迁移结果与待核项', 'success');
          route();
        } catch (e) {
          if (e.status !== 409) toast(e.message, 'error');
        }
      });
    }
    return;
  }

  document.getElementById('m-add').addEventListener('click', async () => {
    const sceneNo = Number(document.getElementById('m-scene').value);
    const startLine = Number(document.getElementById('m-start').value);
    const endLine = Number(document.getElementById('m-end').value);
    const label = document.getElementById('m-label').value.trim();
    const note = document.getElementById('m-note').value;
    try {
      await withVersionGuard(() =>
        api(`/api/versions/${draft.id}/marks?revision=${draft.revision}`, {
          method: 'POST',
          body: JSON.stringify({ revision: draft.revision, sceneNo, startLine, endLine, label, note }),
        }));
      toast('标记已附加', 'success');
      route();
    } catch (e) { /* 409 已统一提示 */ }
  });

  document.getElementById('d-confirm').addEventListener('click', async () => {
    try {
      const v = await withVersionGuard(() =>
        api(`/api/versions/${draft.id}/confirm?revision=${draft.revision}`, {
          method: 'POST',
          body: JSON.stringify({ revision: draft.revision }),
        }));
      toast(`v${v.versionNo} 已确认，可以导出新稿`, 'success');
      route();
    } catch (e) { /* 待核/过期均有提示 */ }
  });

  document.getElementById('d-abandon').addEventListener('click', async () => {
    if (!confirm('放弃该草稿？已确认版不会受影响。')) return;
    try {
      await withVersionGuard(() =>
        api(`/api/versions/${draft.id}/draft?revision=${draft.revision}`, { method: 'DELETE' }));
      toast('草稿已放弃', 'success');
      route();
    } catch (e) { /* */ }
  });

  document.querySelectorAll('.pending-card').forEach((card) => {
    const markId = Number(card.dataset.markId);
    const submit = async (payload) => {
      await withVersionGuard(() =>
        api(`/api/versions/${draft.id}/marks/${markId}/resolve?revision=${draft.revision}`, {
          method: 'POST',
          body: JSON.stringify({ revision: draft.revision, ...payload }),
        }));
      toast('待核项已处理', 'success');
      route();
    };
    card.querySelectorAll('[data-act="pick"]').forEach((b) => {
      b.addEventListener('click', () =>
        submit({
          sceneNo: Number(b.dataset.sceneOrd),
          startLine: Number(b.dataset.start),
          endLine: Number(b.dataset.end),
        }).catch(() => {}));
    });
    card.querySelector('.p-apply').addEventListener('click', () => {
      const sceneNo = Number(card.querySelector('.p-scene').value);
      const startLine = Number(card.querySelector('.p-start').value);
      const endLine = Number(card.querySelector('.p-end').value);
      submit({ sceneNo, startLine, endLine }).catch(() => {});
    });
    card.querySelector('.p-discard').addEventListener('click', () => {
      if (!confirm('确认废弃此标记？废弃记录将保留并随导出展示。')) return;
      submit({ discard: true }).catch(() => {});
    });
  });
}

/** 导入文本严格解析：必须存在至少一个【场名】场头，空段拒绝 */
function parseImportTextStrict(text) {
  const scenes = [];
  const lines0 = text.replace(/\r\n?/g, '\n').split('\n');
  let cur = null;
  for (const raw of lines0) {
    const m = /^【\s*(.+?)\s*】\s*$/.exec(raw.trim());
    if (m) {
      cur = { name: m[1].trim(), lines: [] };
      scenes.push(cur);
      continue;
    }
    if (!cur) {
      if (raw.trim() !== '') throw new Error('修订稿必须以【场名】开头');
      continue;
    }
    cur.lines.push(raw);
  }
  for (const sc of scenes) {
    while (sc.lines.length && sc.lines[0].trim() === '') sc.lines.shift();
    while (sc.lines.length && sc.lines[sc.lines.length - 1].trim() === '') sc.lines.pop();
  }
  if (!scenes.length) throw new Error('未识别到任何【场名】场头');
  return scenes;
}

route();
