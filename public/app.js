/* 剧本修订标记迁移 —— 前端（无框架，直接操作 DOM） */
'use strict';

let state = null;
// 标记创建选择：{ sceneId, start, end }（行 position）
let sel = { sceneId: null, start: null, end: null };
// 待核定位选择：{ itemId, sceneId, start, end }
let picking = null;
let exportPreview = null;

const REASON_TEXT = { duplicate: '重复匹配', cross_scene: '跨场移动', deleted_or_modified: '删改' };
const STATUS_TEXT = { auto: '自动迁移', pending: '待核', resolved: '已定位', discarded: '已废弃' };

// ---------- 工具 ----------

async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function toast(msg, isErr) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = isErr ? 'err' : '';
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3600);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function markerColor(id) {
  const hues = [205, 150, 25, 265, 330, 95, 175, 0];
  return `hsl(${hues[id % hues.length]}, 65%, 42%)`;
}

async function mutate(promise) {
  try {
    state = await promise;
    picking = null;
    render();
  } catch (e) {
    toast(e.message, true);
    if (e.status === 409) {
      state = await req('GET', '/api/state');
      picking = null;
      render();
    }
  }
}

// ---------- 渲染 ----------

function render() {
  const app = document.getElementById('app');
  const hdr = document.getElementById('hdr-info');
  if (!state.script && !state.migration) {
    hdr.textContent = '尚未录入剧本';
    app.innerHTML = viewCreate();
  } else if (state.migration) {
    hdr.textContent = `迁移进行中 · 数据版本 v${state.migration.version}`;
    app.innerHTML = viewMigration(state.migration);
  } else {
    hdr.textContent = `当前确认版：第 ${state.script.version_no} 版`;
    app.innerHTML = viewScript(state.script);
  }
}

function viewCreate() {
  return `
    <div class="card">
      <h2>第一步：录入初始剧本</h2>
      <p class="muted">逐场录入：填写场名与台词（每行一句），点击「追加场景」；可反复追加。也可以直接在下方文本框粘贴整稿。</p>
      <div class="row">
        <input type="text" id="b-scene" class="grow" placeholder="场名，如：第一场 茶馆">
      </div>
      <div class="row" style="margin-top:8px">
        <textarea id="b-lines" style="min-height:90px" placeholder="台词行，每行一句"></textarea>
      </div>
      <div class="row" style="margin-top:8px">
        <button class="ghost" data-action="append-scene">追加场景 ↓</button>
      </div>
      <h3>剧本文本（<code># 场名</code> 起场，其余非空行为台词）</h3>
      <textarea id="script-text" placeholder="# 第一场 茶馆&#10;王利发：您慢坐。&#10;常四爷：喝茶。&#10;# 第二场 街头&#10;……"></textarea>
      <div class="row" style="margin-top:10px">
        <button data-action="create-script">提交并确认为基准版</button>
        <span class="muted">空稿、重复场名、无台词场景将被拒绝</span>
      </div>
    </div>`;
}

function sceneHtml(scene, markers, opts) {
  // opts: { selectable, pickable, pickedFn(line)->bool, selectedFn(line)->bool, marksForLine? }
  const marks = markers || [];
  const linesHtml = scene.lines.map((ln) => {
    const classes = ['line'];
    if (opts.selectable) classes.push('selectable');
    if (opts.pickable) classes.push('pickable');
    if (opts.selectedFn && opts.selectedFn(ln)) classes.push('selected');
    if (opts.pickedFn && opts.pickedFn(ln)) classes.push('picked');
    const badges = marks
      .filter((m) => ln.position >= m.start_pos && ln.position <= m.end_pos)
      .map((m) => `<span class="badge" style="background:${markerColor(m.id)}" title="${esc(m.note)}">标记</span>`)
      .join('');
    const data = (opts.selectable || opts.pickable)
      ? `data-action="line-click" data-scene="${scene.id}" data-pos="${ln.position}"` : '';
    return `<div class="${classes.join(' ')}" ${data}>
      <span class="no">${ln.position}</span><span class="txt">${esc(ln.text)}${badges}</span>
    </div>`;
  }).join('');
  const markList = marks.length ? `<div class="marker-list">${marks.map((m) => `
    <div class="marker-item">
      <span class="rng" style="color:${markerColor(m.id)}">[${m.start_pos === m.end_pos ? `第${m.start_pos}行` : `第${m.start_pos}-${m.end_pos}行`}]</span>
      <span class="grow">${esc(m.note)}</span>
      ${opts.deletable ? `<button class="small ghost" data-action="del-marker" data-id="${m.id}">删除</button>` : ''}
    </div>`).join('')}</div>` : '';
  return `<div class="scene">
    <div class="scene-head"><span>${esc(scene.name)}</span><span class="muted">${scene.lines.length} 行</span></div>
    ${linesHtml}${markList}
  </div>`;
}

function viewScript(script) {
  const selInfo = sel.sceneId
    ? (() => {
        const sc = script.scenes.find((s) => s.id === sel.sceneId);
        return sc ? `已选「${esc(sc.name)}」第 ${sel.start}-${sel.end} 行` : '';
      })()
    : '点击同一场内的台词行选择连续区间（先点起点，再点终点）';

  const scenesHtml = script.scenes.map((sc) => sceneHtml(
    sc,
    script.markers.filter((m) => m.scene_id === sc.id),
    {
      selectable: true,
      deletable: true,
      selectedFn: (ln) => sel.sceneId === sc.id && ln.position >= sel.start && ln.position <= sel.end,
    },
  )).join('');

  const discards = (script.discards || []);
  const discardsHtml = discards.length ? `
    <div class="card">
      <h3>废弃记录（上次迁移中被废弃的标记）</h3>
      <ul class="discard-list">${discards.map((d) => `
        <li>[${esc(d.base_scene_name)} ${d.base_start === d.base_end ? `第${d.base_start}行` : `第${d.base_start}-${d.base_end}行`}]
        ${esc(d.note)}${d.reason ? `（原因：${REASON_TEXT[d.reason] || d.reason}）` : ''}</li>`).join('')}
      </ul>
    </div>` : '';

  const historyHtml = state.history.map((h) =>
    `<span>第${h.version_no}版 · ${{ confirmed: '确认版', superseded: '历史版', draft: '草稿' }[h.status]}</span>`).join('');

  return `
    <div class="card">
      <h2>当前剧本（第 ${script.version_no} 版 · 已确认）</h2>
      <div class="row">
        <button data-action="toggle-export">预览 / 导出新稿</button>
        <a href="/api/scripts/${script.id}/export?download=1" download><button class="ghost">下载纯文本</button></a>
        <span class="history">${historyHtml}</span>
      </div>
      ${exportPreview ? `<pre class="export">${esc(exportPreview)}</pre>` : ''}
    </div>

    <div class="card">
      <h2>添加提示标记</h2>
      <div class="row">
        <span class="muted">${selInfo}</span>
        <input type="text" id="marker-note" class="grow" placeholder="标记说明（必填），如：灯光渐暗 / 音效起">
        <button data-action="add-marker" ${sel.sceneId ? '' : 'disabled'}>添加标记</button>
      </div>
    </div>

    ${script.scenes.length ? scenesHtml : '<p class="muted">（空）</p>'}

    <div class="card">
      <h2>导入修订稿</h2>
      <p class="muted">以当前确认版（第 ${script.version_no} 版）为基准生成对照；同场内文本连续且唯一匹配的标记自动迁移，删改 / 跨场移动 / 重复匹配一律列为待核。</p>
      <textarea id="revision-text" placeholder="# 第一场 茶馆&#10;……（修订后的整稿）"></textarea>
      <div class="row" style="margin-top:10px">
        <button data-action="import-revision">导入并生成对照</button>
      </div>
    </div>
    ${discardsHtml}`;
}

function viewMigration(mig) {
  const counts = { auto: 0, pending: 0, resolved: 0, discarded: 0 };
  mig.items.forEach((it) => { counts[it.status] += 1; });
  const canConfirm = counts.pending === 0;

  const itemsHtml = mig.items.length ? mig.items.map((it) => {
    const range = it.base_start === it.base_end ? `第${it.base_start}行` : `第${it.base_start}-${it.base_end}行`;
    let target = '';
    if (it.status === 'auto' || it.status === 'resolved') {
      const r = it.new_start === it.new_end ? `第${it.new_start}行` : `第${it.new_start}-${it.new_end}行`;
      target = `<div class="target">→ 新稿「${esc(it.new_scene_name)}」${r}</div>`;
    } else if (it.status === 'pending') {
      target = `<div class="target">⚠ ${REASON_TEXT[it.reason] || it.reason}：需人工选择新稿连续行，或废弃。系统不做猜测。</div>`;
    } else {
      target = `<div class="target muted">已废弃，不会进入新稿</div>`;
    }
    const pickingThis = picking && picking.itemId === it.id;
    return `<div class="item">
      <div class="head">
        <span class="tag ${it.status}">${STATUS_TEXT[it.status]}</span>
        <span class="note">${esc(it.note)}</span>
        <span class="muted">基准「${esc(it.base_scene_name)}」${range}</span>
        <span class="grow"></span>
        <button class="small ghost" data-action="pick" data-id="${it.id}">${pickingThis ? '取消定位' : (it.status === 'pending' ? '选择新位置' : '重新定位')}</button>
        ${it.status !== 'discarded' ? `<button class="small danger" data-action="discard" data-id="${it.id}">废弃</button>` : ''}
      </div>
      <div class="covered">${it.covered.map(esc).join('\n')}</div>
      ${target}
    </div>`;
  }).join('') : '<p class="muted">基准版没有标记，可直接确认。</p>';

  const baseScenes = mig.base.scenes.map((sc) => sceneHtml(
    sc, mig.base.markers.filter((m) => m.scene_id === sc.id), {},
  )).join('');

  const draftScenes = mig.draft.scenes.map((sc) => sceneHtml(
    sc,
    mig.items
      .filter((it) => (it.status === 'auto' || it.status === 'resolved') && it.new_scene_id === sc.id)
      .map((it) => ({ id: it.id, scene_id: sc.id, start_pos: it.new_start, end_pos: it.new_end, note: it.note })),
    {
      pickable: !!picking,
      pickedFn: (ln) => picking && picking.sceneId === sc.id && ln.position >= picking.start && ln.position <= picking.end,
    },
  )).join('');

  const pickbar = picking ? (() => {
    const sc = mig.draft.scenes.find((s) => s.id === picking.sceneId);
    const info = sc ? `已选「${esc(sc.name)}」第 ${picking.start}-${picking.end} 行` : '请在右侧新稿中点击起点行，再点击终点行（须同一场内连续）';
    return `<div class="pickbar">
      <span class="grow">正在为标记定位：${info}</span>
      <button data-action="confirm-pick" ${picking.sceneId ? '' : 'disabled'}>确认定位</button>
      <button data-action="cancel-pick">取消</button>
    </div>`;
  })() : '';

  return `
    <div class="toolbar">
      <span class="stat auto"><b>${counts.auto}</b> 自动迁移</span>
      <span class="stat pending"><b>${counts.pending}</b> 待核</span>
      <span class="stat"><b>${counts.resolved}</b> 已定位</span>
      <span class="stat"><b>${counts.discarded}</b> 已废弃</span>
      <span class="grow"></span>
      <button data-action="confirm-migration" ${canConfirm ? '' : 'disabled'}>确认新稿（第 ${mig.draft.version_no} 版）</button>
      <button class="danger" data-action="abandon-migration">放弃本次迁移</button>
    </div>
    ${canConfirm
      ? '<div class="notice">所有标记均已处理，可以确认。确认后新稿成为基准版；确认带版本校验，过期页面提交会被拒绝。</div>'
      : `<div class="warn-box">还有 ${counts.pending} 条待核标记：请逐条在新稿中选择连续行重新定位，或废弃。未处理完不得确认或导出新稿。</div>`}
    <h2>每条标记的去向</h2>
    ${itemsHtml}
    <div class="compare">
      <div><h3>基准版（第 ${mig.base.version_no} 版 · 已确认）</h3>${baseScenes}</div>
      <div><h3>新稿（第 ${mig.draft.version_no} 版 · 草稿）</h3>${draftScenes}${pickbar}</div>
    </div>`;
}

// ---------- 事件 ----------

async function refresh() {
  state = await req('GET', '/api/state');
  render();
}

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  try {
    if (action === 'append-scene') {
      const name = document.getElementById('b-scene').value.trim();
      const lines = document.getElementById('b-lines').value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!name) return toast('请填写场名', true);
      if (!lines.length) return toast('请填写台词行', true);
      const ta = document.getElementById('script-text');
      ta.value = `${ta.value.replace(/\s+$/, '')}${ta.value.trim() ? '\n' : ''}# ${name}\n${lines.join('\n')}\n`;
      document.getElementById('b-scene').value = '';
      document.getElementById('b-lines').value = '';
      toast(`已追加场景「${name}」`);
    }

    if (action === 'create-script') {
      const text = document.getElementById('script-text').value;
      await mutate(req('POST', '/api/scripts', { text }));
      toast('初始剧本已确认为基准版');
    }

    if (action === 'line-click') {
      const sceneId = Number(el.dataset.scene);
      const pos = Number(el.dataset.pos);
      if (state.migration && picking) {
        // 待核定位：同一场内选连续区间
        if (picking.sceneId !== sceneId) picking = { ...picking, sceneId, start: pos, end: pos };
        else picking = { ...picking, start: Math.min(picking.start, pos), end: Math.max(picking.end, pos) };
        render();
      } else if (!state.migration) {
        if (sel.sceneId !== sceneId) sel = { sceneId, start: pos, end: pos };
        else sel = { sceneId, start: Math.min(sel.start, pos), end: Math.max(sel.end, pos) };
        render();
      }
    }

    if (action === 'add-marker') {
      const note = document.getElementById('marker-note').value.trim();
      if (!sel.sceneId) return toast('请先选择连续行', true);
      await mutate(req('POST', `/api/scripts/${state.script.id}/markers`, {
        scene_id: sel.sceneId, start: sel.start, end: sel.end, note,
      }));
      sel = { sceneId: null, start: null, end: null };
      render();
      toast('标记已添加');
    }

    if (action === 'del-marker') {
      await mutate(req('DELETE', `/api/markers/${el.dataset.id}`));
      toast('标记已删除');
    }

    if (action === 'import-revision') {
      const text = document.getElementById('revision-text').value;
      await mutate(req('POST', '/api/migrations', { text }));
      if (state.migration) toast('已生成对照，请处理待核标记');
    }

    if (action === 'pick') {
      const id = Number(el.dataset.id);
      picking = picking && picking.itemId === id ? null : { itemId: id, sceneId: null, start: null, end: null };
      render();
    }

    if (action === 'cancel-pick') { picking = null; render(); }

    if (action === 'confirm-pick') {
      if (!picking || !picking.sceneId) return;
      const mig = state.migration;
      await mutate(req('POST', `/api/migrations/${mig.id}/items/${picking.itemId}/resolve`, {
        scene_id: picking.sceneId, start: picking.start, end: picking.end,
      }));
      toast('已定位');
    }

    if (action === 'discard') {
      if (!confirm('确定废弃该标记？废弃后不会进入新稿，并记入废弃记录。')) return;
      const mig = state.migration;
      await mutate(req('POST', `/api/migrations/${mig.id}/items/${el.dataset.id}/discard`));
      toast('已废弃');
    }

    if (action === 'confirm-migration') {
      const mig = state.migration;
      await mutate(req('POST', `/api/migrations/${mig.id}/confirm`, { version: mig.version }));
      if (!state.migration) toast(`第 ${state.script.version_no} 版已确认为新基准版`);
    }

    if (action === 'abandon-migration') {
      if (!confirm('确定放弃本次迁移？草稿与对照将被删除，原确认版保留。')) return;
      await mutate(req('POST', `/api/migrations/${state.migration.id}/abandon`));
      toast('已放弃本次迁移');
    }

    if (action === 'toggle-export') {
      if (exportPreview) { exportPreview = null; render(); return; }
      const res = await fetch(`/api/scripts/${state.script.id}/export`);
      exportPreview = await res.text();
      render();
    }
  } catch (e) {
    toast(e.message, true);
  }
});

refresh().catch((e) => {
  document.getElementById('app').textContent = `加载失败：${e.message}`;
});
