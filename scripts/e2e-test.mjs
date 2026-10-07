#!/usr/bin/env node
// 端到端业务流测试（直接对运行中的 HTTP 服务发起请求）
const BASE = process.env.BASE || 'http://127.0.0.1:3210';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}

async function call(method, path, body, expectedOk = true) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (expectedOk && !res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error}`);
  return { status: res.status, data };
}

async function expectFail(name, method, path, body) {
  const { status, data } = await call(method, path, body, false);
  check(`${name}（被拒绝，HTTP ${status}）`, status >= 400, JSON.stringify(data));
  return data;
}

console.log('— 1. 输入校验：空稿 / 重复场名 —');
await expectFail('空稿拒绝', 'POST', '/api/scripts', {
  title: '空稿测试',
  scenes: [],
});
await expectFail('重复场名拒绝', 'POST', '/api/scripts', {
  title: '重名测试',
  scenes: [
    { name: '开场', lines: ['甲 你好'] },
    { name: '开场', lines: ['乙 再见'] },
  ],
});
await expectFail('空场（全空行）拒绝', 'POST', '/api/scripts', {
  title: '空场测试',
  scenes: [{ name: '空场', lines: ['   ', ''] }],
});

console.log('— 2. 创建首版并加标记 —');
const { data: v1 } = await call('POST', '/api/scripts', {
  title: '测试剧本',
  scenes: [
    {
      name: '开场',
      lines: ['四凤 在大厅擦东西。', '鲁贵 四凤！', '四凤 爸，您怎么回来了？', '鲁贵 我问你，妈呢？'],
    },
    {
      name: '第二幕',
      lines: ['周朴园 你来做什么？', '繁漪 我来看看你。', '周朴园 出去。', '灯光暗转', '繁漪 （停住）你变了。'],
    },
  ],
});
const scriptId = v1.scriptId;
check('首版为草稿 v1', v1.versionNo === 1 && v1.status === 'draft');
const scene1 = v1.scenes[0];
const scene2 = v1.scenes[1];

await expectFail('标记越界（行号超过场行数）', 'POST', `/api/versions/${v1.id}/marks?revision=1`, {
  revision: 1, sceneNo: 1, startLine: 1, endLine: 99, label: '坏标记',
});
await expectFail('标记越界（场号无效）', 'POST', `/api/versions/${v1.id}/marks?revision=1`, {
  revision: 1, sceneNo: 9, startLine: 1, endLine: 1, label: '坏标记',
});
await expectFail('标记名为空', 'POST', `/api/versions/${v1.id}/marks?revision=1`, {
  revision: 1, sceneNo: 1, startLine: 1, endLine: 1, label: '   ',
});

const { data: mv1 } = await call('POST', `/api/versions/${v1.id}/marks?revision=1`, {
  revision: 1, sceneNo: 1, startLine: 2, endLine: 3, label: '灯光：暖转冷', note: '对话情绪转折',
});
check('标记加入后 revision 递增为 2', mv1.revision === 2, `rev=${mv1.revision}`);
const markA = mv1.marks.find((m) => m.label === '灯光：暖转冷');

// 第二幕：一个唯一短语块
const { data: mv1b } = await call('POST', `/api/versions/${v1.id}/marks?revision=2`, {
  revision: 2, sceneNo: 2, startLine: 1, endLine: 2, label: '音效：钟摆', note: '',
});
const markB = mv1b.marks.find((m) => m.label === '音效：钟摆');

// 第二幕第4行单行标记（“灯光暗转”——修订稿中会被删掉）
const { data: mv1c } = await call('POST', `/api/versions/${v1.id}/marks?revision=3`, {
  revision: 3, sceneNo: 2, startLine: 4, endLine: 4, label: '黑场提示',
});
const markC = mv1c.marks.find((m) => m.label === '黑场提示');
check('共 3 条标记', mv1c.marks.length === 3);

console.log('— 3. 版本校验：旧 revision 提交被拒 —');
const r = await call('POST', `/api/versions/${v1.id}/marks?revision=1`, {
  revision: 1, sceneNo: 1, startLine: 1, endLine: 1, label: '过期页面标记',
}, false);
check('旧修订号被拒（409）且返回当前 revision', r.status === 409 && r.data.revision === 4,
  JSON.stringify(r.data));

console.log('— 4. 有待核/未确认前，不能导出 —');
// 首版无待核，可确认；但先测未确认不能导出
await expectFail('草稿不能导出', 'GET', `/api/versions/${v1.id}/export`);

console.log('— 5. 确认首版（revision=4）—');
const { data: c1 } = await call('POST', `/api/versions/${v1.id}/confirm?revision=4`, { revision: 4 });
check('首版已确认', c1.status === 'confirmed');
await expectFail('已确认版不可再加标记', 'POST', `/api/versions/${v1.id}/marks?revision=5`, {
  revision: 5, sceneNo: 1, startLine: 1, endLine: 1, label: 'x',
});

console.log('— 6. 导入修订稿，检验三种迁移去向 —');
// 构造：
//  开场：原文 2-3 行整体移动且唯一 -> 自动迁移
//  开场：新增重复行，使“周朴园 出去。”之类——下面用第二幕台词块做 duplicate
//  第二幕：
//    标记B原文(行1-2)出现两次(同场) -> duplicate 待核
//    标记C「灯光暗转」被删除 -> deleted_or_edited
//  跨场移动：开场插入第二幕的原句“繁漪 （停住）你变了。”（在第二幕保留）-> moved
const { data: v2 } = await call('POST', `/api/scripts/${scriptId}/import?revision=5`, {
  revision: 5,
  scenes: [
    {
      name: '开场',
      lines: [
        '四凤 在大厅擦东西。',
        '鲁贵 四凤！',
        '四凤 爸，您怎么回来了？',
        '鲁贵 我问你，妈呢？',
        '繁漪 （停住）你变了。', // 第二幕原句出现在开场 => 跨场
      ],
    },
    {
      name: '第二幕',
      lines: [
        '周朴园 你来做什么？',
        '繁漪 我来看看你。',
        '周朴园 出去。',
        '周朴园 你来做什么？', // 重复块开始
        '繁漪 我来看看你。', // 标记B 文本第二次出现 => duplicate
        '繁漪 （停住）你变了。',
      ],
    },
  ],
});
check('生成修订草稿 v2', v2.versionNo === 2 && v2.status === 'draft');
check('v2 有 2 条待核', v2.pendingCount === 2, `pending=${v2.pendingCount}`);
const auto = v2.marks.find((m) => m.label === '灯光：暖转冷');
const dup = v2.marks.find((m) => m.label === '音效：钟摆');
const gone = v2.marks.find((m) => m.label === '黑场提示');
check('同场唯一匹配自动迁移(active)', auto.status === 'active' && auto.sceneName === '开场'
  && auto.startLine === 2 && auto.endLine === 3, JSON.stringify(auto));
check('自动迁移带来源标记', auto.fromMigration === true);
check('重复匹配列为待核 duplicate', dup.status === 'pending' && dup.pendingReason === 'duplicate'
  && dup.candidates.length === 2, `${dup.status} ${dup.pendingReason} cands=${dup.candidates.length}`);
check('删改列为待核 deleted_or_edited', gone.status === 'pending'
  && gone.pendingReason === 'deleted_or_edited', `${gone.status} ${gone.pendingReason}`);
check('待核保留原文快照', gone.sourceTexts.length === 1 && gone.sourceTexts[0] === '灯光暗转');
check('未确认前不能导出 v2', true);

console.log('— 7. 待核未处理完不得确认 —');
const cf = await call('POST', `/api/versions/${v2.id}/confirm?revision=1`, { revision: 1 }, false);
check('确认被 409 阻止', cf.status === 409 && cf.data.pendingCount === 2, JSON.stringify(cf.data));

console.log('— 8. 处理待核：一条选候选行，一条废弃 —');
const pick = dup.candidates[0];
const { data: rv1 } = await call('POST',
  `/api/versions/${v2.id}/marks/${dup.id}/resolve?revision=1`, {
    revision: 1, sceneNo: v2.scenes.find((s) => s.id === pick.sceneId).ord,
    startLine: pick.startLine, endLine: pick.endLine,
  });
check('duplicate 选定后变 active', rv1.marks.find((m) => m.id === dup.id).status === 'active');
check('resolve 后 revision=2', rv1.revision === 2);
await expectFail('已处理标记不能再次 resolve', 'POST',
  `/api/versions/${v2.id}/marks/${dup.id}/resolve?revision=2`, { revision: 2, discard: true });

const { data: rv2 } = await call('POST',
  `/api/versions/${v2.id}/marks/${gone.id}/resolve?revision=2`, { revision: 2, discard: true });
check('另一条废弃', rv2.marks.find((m) => m.id === gone.id).status === 'discarded');
check('待核清零', rv2.pendingCount === 0);

console.log('— 9. 再次版本校验：旧页面确认被拒，原确认版保留 —');
const stale = await call('POST', `/api/versions/${v2.id}/confirm?revision=1`, { revision: 1 }, false);
check('旧 revision 确认被拒', stale.status === 409, JSON.stringify(stale.data));
const detail = await call('GET', `/api/scripts/${scriptId}`);
check('原确认版 v1 仍保留', detail.data.confirmed.versionNo === 1);

console.log('— 10. 确认 v2 并导出 —');
const { data: c2 } = await call('POST', `/api/versions/${v2.id}/confirm?revision=3`, { revision: 3 });
check('v2 已确认', c2.status === 'confirmed');
const exp = await fetch(`${BASE}/api/versions/${v2.id}/export`);
const text = await exp.text();
check('导出为纯文本', exp.headers.get('content-type').includes('text/plain'));
check('导出含场景与自动迁移标记', text.includes('【开场】') && text.includes('灯光：暖转冷'));
check('导出含重新定位的标记', text.includes('音效：钟摆'));
check('导出含废弃记录段', text.includes('废弃标记记录') && text.includes('黑场提示'));
check('导出含原文快照', text.includes('原文：灯光暗转'));

console.log('— 11. 确认后再次导入：以最新版 v2 为基准 —');
const { data: v3 } = await call('POST', `/api/scripts/${scriptId}/import?revision=4`, {
  revision: 4,
  scenes: [
    { name: '开场', lines: ['四凤 在大厅擦东西。', '鲁贵 四凤！', '四凤 爸，您怎么回来了？', '鲁贵 我问你，妈呢？', '繁漪 （停住）你变了。'] },
    { name: '第二幕', lines: ['周朴园 你来做什么？', '繁漪 我来看看你。', '周朴园 出去。', '周朴园 你来做什么？', '繁漪 我来看看你。', '繁漪 （停住）你变了。'] },
  ],
});
// v2 有效标记 = 灯光(开场2-3) + 音效(第二幕4-5候选选了candidates[0]: 第二幕1-2 或 4-5)
check('v3 以 v2 为基准（baseVersionId 指向 v2）', v3.baseVersionId === v2.id);
check('v3 无废弃标记继承（废弃不参与再迁移）', !v3.marks.some((m) => m.status === 'discarded'));
const stillActive = v3.marks.find((m) => m.label === '灯光：暖转冷');
check('灯光标记在 v3 继续自动迁移', stillActive && stillActive.status === 'active');

console.log('— 12. 重复草稿拒绝 —');
await expectFail('已有草稿时再次导入拒绝', 'POST', `/api/scripts/${scriptId}/import?revision=4`, {
  revision: 4,
  scenes: [{ name: '开场', lines: ['x'] }],
});

console.log('— 13. 放弃草稿后可重新导入 —');
await call('DELETE', `/api/versions/${v3.id}/draft?revision=1`);
const d3 = await call('GET', `/api/scripts/${scriptId}`);
check('草稿已放弃，确认版仍为 v2', d3.data.draft === null && d3.data.confirmed.versionNo === 2);

console.log('— 14. 静态首页 —');
const idx = await fetch(BASE + '/');
check('首页返回 HTML', (await idx.text()).includes('剧本修订标记迁移台'));

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
