/* 端到端测试：启动真实服务器，走完整业务流程 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PORT = 3210;
const BASE = `http://localhost:${PORT}`;
const DB = path.join('test', `e2e-${Date.now()}.db`);

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra !== undefined ? ` —— ${JSON.stringify(extra)}` : ''}`); }
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/state`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务器启动超时');
}

const srv = spawn('node', ['dist/server.js'], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: DB },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', (d) => process.stderr.write(d));

try {
  await waitUp();
  console.log('● 初始状态与输入校验');
  {
    const { data } = await api('GET', '/api/state');
    check('初始无剧本', data.script === null && data.migration === null);
  }
  {
    const r = await api('POST', '/api/scripts', { text: '   \n \n ' });
    check('空稿被拒绝', r.status === 400, r.data);
  }
  {
    const r = await api('POST', '/api/scripts', { text: '# 甲场\n台词一\n# 甲场\n台词二\n' });
    check('重复场名被拒绝', r.status === 400 && /重复/.test(r.data.error), r.data);
  }
  {
    const r = await api('POST', '/api/scripts', { text: '# 空场\n# 乙场\n台词\n' });
    check('无台词场景被拒绝', r.status === 400, r.data);
  }
  {
    const r = await api('POST', '/api/scripts', { text: '没有场名的台词\n' });
    check('缺场名被拒绝', r.status === 400, r.data);
  }

  console.log('● 录入基准版并添加标记');
  const baseText = [
    '# 甲场', '风乍起。', '吹皱一池春水。', '闲引鸳鸯香径里。',
    '# 乙场', '手挼红杏蕊。', '斗鸭阑干独倚。',
  ].join('\n');
  let script;
  {
    const r = await api('POST', '/api/scripts', { text: baseText });
    check('创建基准版成功', r.status === 201 && r.data.script.version_no === 1, r.data);
    script = r.data.script;
  }
  const [sceneA, sceneB] = script.scenes;
  {
    const r = await api('POST', `/api/scripts/${script.id}/markers`, { scene_id: sceneA.id, start: 0, end: 1, note: 'x' });
    check('越界定位（start<1）被拒绝', r.status === 400, r.data);
  }
  {
    const r = await api('POST', `/api/scripts/${script.id}/markers`, { scene_id: sceneA.id, start: 1, end: 99, note: 'x' });
    check('越界定位（end 超行数）被拒绝', r.status === 400, r.data);
  }
  {
    const r = await api('POST', `/api/scripts/${script.id}/markers`, { scene_id: sceneA.id, start: 3, end: 2, note: 'x' });
    check('起点大于终点被拒绝', r.status === 400, r.data);
  }
  {
    const r = await api('POST', `/api/scripts/${script.id}/markers`, { scene_id: 99999, start: 1, end: 1, note: 'x' });
    check('场景不属于剧本被拒绝', r.status === 400, r.data);
  }
  {
    const r = await api('POST', `/api/scripts/${script.id}/markers`, { scene_id: sceneA.id, start: 1, end: 1, note: '  ' });
    check('空说明被拒绝', r.status === 400, r.data);
  }
  // 四条标记：自动 / 删改 / 重复 / 跨场
  await api('POST', `/api/scripts/${script.id}/markers`, { scene_id: sceneA.id, start: 1, end: 2, note: '开场灯光' });
  await api('POST', `/api/scripts/${script.id}/markers`, { scene_id: sceneA.id, start: 3, end: 3, note: '音效起' });
  await api('POST', `/api/scripts/${script.id}/markers`, { scene_id: sceneB.id, start: 1, end: 1, note: '道具红杏' });
  await api('POST', `/api/scripts/${script.id}/markers`, { scene_id: sceneB.id, start: 2, end: 2, note: '走位提示' });
  {
    const { data } = await api('GET', '/api/state');
    check('四条标记已建立', data.script.markers.length === 4, data.script.markers);
  }

  console.log('● 导入修订稿，生成分流');
  const newText = [
    '# 甲场', '风乍起。', '吹皱一池春水。', '（幕启）闲引鸳鸯香径里。',
    '# 乙场', '碧玉搔头斜坠。', '手挼红杏蕊。', '手挼红杏蕊。',
    '# 丙场', '斗鸭阑干独倚。',
  ].join('\n');
  let mig;
  {
    const r = await api('POST', '/api/migrations', { text: newText });
    check('迁移创建成功', r.status === 201, r.data);
    mig = r.data.migration;
    const byNote = Object.fromEntries(mig.items.map((it) => [it.note, it]));
    check('唯一连续匹配 → 自动迁移', byNote['开场灯光'].status === 'auto'
      && byNote['开场灯光'].new_scene_name === '甲场'
      && byNote['开场灯光'].new_start === 1 && byNote['开场灯光'].new_end === 2, byNote['开场灯光']);
    check('删改 → 待核', byNote['音效起'].status === 'pending' && byNote['音效起'].reason === 'deleted_or_modified', byNote['音效起']);
    check('重复匹配 → 待核', byNote['道具红杏'].status === 'pending' && byNote['道具红杏'].reason === 'duplicate', byNote['道具红杏']);
    check('跨场移动 → 待核', byNote['走位提示'].status === 'pending' && byNote['走位提示'].reason === 'cross_scene', byNote['走位提示']);
  }
  {
    const r = await api('POST', '/api/migrations', { text: newText });
    check('重复导入被拒绝（已有未完成迁移）', r.status === 409, r.data);
  }
  {
    const r = await api('POST', `/api/scripts/${script.id}/markers`, { scene_id: sceneA.id, start: 1, end: 1, note: '锁定测试' });
    check('迁移中基准版锁定，不能加标记', r.status === 409, r.data);
  }
  {
    const r = await api('POST', `/api/migrations/${mig.id}/confirm`, { version: mig.version });
    check('待核未清零不得确认', r.status === 400, r.data);
  }
  {
    const r = await fetch(`${BASE}/api/scripts/${mig.draft.id}/export`);
    check('未确认不得导出新稿', r.status === 400, r.status);
  }

  console.log('● 处理待核标记');
  const byNote = Object.fromEntries(mig.items.map((it) => [it.note, it]));
  const draftScenes = mig.draft.scenes;
  const dSceneA = draftScenes.find((s) => s.name === '甲场');
  const dSceneB = draftScenes.find((s) => s.name === '乙场');
  {
    const r = await api('POST', `/api/migrations/${mig.id}/items/${byNote['音效起'].id}/resolve`,
      { scene_id: dSceneA.id, start: 3, end: 3 });
    check('人工定位成功', r.status === 200 && r.data.migration.items.find((i) => i.note === '音效起').status === 'resolved', r.data);
    mig = r.data.migration;
  }
  {
    const r = await api('POST', `/api/migrations/${mig.id}/items/${byNote['道具红杏'].id}/resolve`,
      { scene_id: dSceneB.id, start: 3, end: 3 });
    check('重复匹配人工择行', r.status === 200, r.data);
    mig = r.data.migration;
  }
  {
    const r = await api('POST', `/api/migrations/${mig.id}/items/${byNote['道具红杏'].id}/resolve`,
      { scene_id: dSceneB.id, start: 2, end: 9 });
    check('人工定位越界被拒绝', r.status === 400, r.data);
  }
  {
    const r = await api('POST', `/api/migrations/${mig.id}/items/${byNote['走位提示'].id}/discard`, {});
    check('废弃成功', r.status === 200, r.data);
    mig = r.data.migration;
  }

  console.log('● 版本校验与确认');
  {
    const r = await api('POST', `/api/migrations/${mig.id}/confirm`, { version: 1 });
    check('旧版本确认被拒绝（409）', r.status === 409, r.data);
  }
  {
    const r = await api('POST', `/api/migrations/${mig.id}/confirm`, { version: mig.version });
    check('正确版本确认成功', r.status === 200 && r.data.script.version_no === 2, r.data);
    check('新稿携带 3 条标记（1 自动 + 2 人工）', r.data.script.markers.length === 3, r.data.script.markers);
    check('废弃记录随新稿返回', (r.data.script.discards || []).length === 1
      && r.data.script.discards[0].note === '走位提示', r.data.script.discards);
  }
  {
    const r = await api('POST', `/api/migrations/${mig.id}/confirm`, { version: mig.version });
    check('重复确认被拒绝', r.status === 409, r.data);
  }
  {
    const { data } = await api('GET', '/api/state');
    check('原确认版已成为历史版', data.history.find((h) => h.version_no === 1).status === 'superseded', data.history);
  }

  console.log('● 导出');
  {
    const res = await fetch(`${BASE}/api/scripts/2/export`);
    const text = await res.text();
    check('导出为纯文本且含标记', res.status === 200 && text.includes('[标记 第1-2行] 开场灯光'), text);
    check('导出含人工定位标记', text.includes('音效起') && text.includes('道具红杏'), text);
    check('导出含废弃记录', text.includes('废弃记录') && text.includes('走位提示') && text.includes('跨场移动'), text);
    check('导出新稿内容', text.includes('# 丙场') && text.includes('斗鸭阑干独倚。'), text);
  }

  console.log('● 第二轮迁移与放弃');
  {
    const r = await api('POST', '/api/migrations', { text: '# 甲场\n风乍起。\n吹皱一池春水。\n' });
    check('可再次导入修订稿', r.status === 201, r.data);
    const mig2 = r.data.migration;
    const r2 = await api('POST', `/api/migrations/${mig2.id}/abandon`, {});
    check('放弃迁移成功，确认版不变', r2.status === 200 && r2.data.script.version_no === 2 && r2.data.migration === null, r2.data);
  }
} finally {
  srv.kill();
  for (const f of [DB, DB + '.tmp']) { try { fs.rmSync(f, { force: true }); } catch {} }
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
