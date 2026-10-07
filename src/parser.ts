/** 剧本文本解析与校验。文本格式：`# 场名` 起场，其余非空行为台词行。 */

export interface ParsedScene {
  name: string;
  lines: string[];
}

export class ScriptError extends Error {}

export function parseScriptText(text: string): ParsedScene[] {
  const scenes: ParsedScene[] = [];
  let current: ParsedScene | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^#\s*(.+)$/);
    if (m) {
      current = { name: m[1].trim(), lines: [] };
      scenes.push(current);
    } else {
      if (!current) {
        throw new ScriptError(`台词行必须出现在场名（# 开头）之后：「${line}」`);
      }
      current.lines.push(line);
    }
  }
  validateScenes(scenes);
  return scenes;
}

/** 空稿、重复场名、空场名、无台词场景一律拒绝 */
export function validateScenes(scenes: ParsedScene[]): void {
  if (scenes.length === 0) throw new ScriptError('剧本为空：至少需要一个场景');
  const seen = new Set<string>();
  for (const s of scenes) {
    if (!s.name) throw new ScriptError('场名不能为空');
    if (seen.has(s.name)) throw new ScriptError(`场名重复：「${s.name}」`);
    seen.add(s.name);
    if (s.lines.length === 0) throw new ScriptError(`场景「${s.name}」没有任何台词行`);
  }
}
