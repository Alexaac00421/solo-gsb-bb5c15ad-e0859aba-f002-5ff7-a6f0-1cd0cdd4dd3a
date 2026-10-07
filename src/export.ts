// 导出带已确认标记的纯文本新稿，并附废弃记录
import type { MarkDTO, VersionDTO } from './types.js';

const SCENE_PREFIX = '【';
const SCENE_SUFFIX = '】';

function renderMark(m: MarkDTO): string {
  const range =
    m.startLine === m.endLine ? `第${m.startLine}行` : `第${m.startLine}-${m.endLine}行`;
  const loc = `${SCENE_PREFIX}${m.sceneName ?? '?'}${SCENE_SUFFIX}${range}`;
  const note = m.note ? `｜说明：${m.note}` : '';
  const from = m.fromMigration ? '（自上一版迁移）' : '';
  return `[提示·${m.label}] ${loc}${note}${from}`;
}

export function renderPlainText(version: VersionDTO, scriptTitle: string): string {
  const lines: string[] = [];
  lines.push(`剧本：${scriptTitle}`);
  lines.push(`版本：v${version.versionNo}（已确认 ${version.confirmedAt ?? ''}）`);
  lines.push('');

  for (const sc of version.scenes) {
    lines.push(`${SCENE_PREFIX}${sc.name}${SCENE_SUFFIX}`);

    // 落在该场各行上的有效标记
    const marks = version.marks.filter(
      (m) => m.status === 'active' && m.sceneId === sc.id,
    );
    const byStart = new Map<number, MarkDTO[]>();
    for (const m of marks) {
      const list = byStart.get(m.startLine!) ?? [];
      list.push(m);
      byStart.set(m.startLine!, list);
    }

    sc.lines.forEach((l) => {
      lines.push(l.text);
      for (const m of byStart.get(l.ord) ?? []) {
        lines.push(`    ➤ ${renderMark(m)}`);
      }
    });
    lines.push('');
  }

  const discarded = version.marks.filter((m) => m.status === 'discarded');
  lines.push('—— 废弃标记记录 ——');
  if (discarded.length === 0) {
    lines.push('（无）');
  } else {
    for (const m of discarded) {
      const range =
        m.sourceStartLine === m.sourceEndLine
          ? `第${m.sourceStartLine}行`
          : `第${m.sourceStartLine}-${m.sourceEndLine}行`;
      const note = m.note ? `｜说明：${m.note}` : '';
      lines.push(`✗ [${m.label}] 原位置：${SCENE_PREFIX}${m.sourceSceneName ?? '?'}${SCENE_SUFFIX}${range}${note}`);
      for (const t of m.sourceTexts) {
        lines.push(`    原文：${t}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

/** 导入文本解析：【场名】或“第X场”作为场头；空行作为场间分隔不计入行序列 */
export function parseImportedText(text: string): Array<{ name: string; lines: string[] }> {
  const scenes: Array<{ name: string; lines: string[] }> = [];
  let current: { name: string; lines: string[] } | null = null;
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = rawLine.trim();
    const m1 = /^【(.+?)】\s*$/.exec(trimmed);
    const m2 = /^第[0-9零一二三四五六七八九十百千]+场[\s:：]*(.*)$/.exec(trimmed);
    if (m1 || m2) {
      const name = (m1 ? m1[1] : m2![1]).trim();
      current = { name: name || (m2 ? trimmed : ''), lines: [] };
      scenes.push(current);
      continue;
    }
    if (current) current.lines.push(rawLine);
  }
  // 去除每场首尾空行，重复校验交由 parseScenes 统一处理
  for (const sc of scenes) {
    while (sc.lines.length && sc.lines[0].trim() === '') sc.lines.shift();
    while (sc.lines.length && sc.lines[sc.lines.length - 1].trim() === '') sc.lines.pop();
  }
  return scenes.filter((s) => s.name !== '');
}
