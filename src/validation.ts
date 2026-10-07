// 输入校验：空稿、重复场名、越界定位一律拒绝
export interface ParsedScene {
  name: string;
  lines: string[];
}

/** 校验并规整场/行输入 */
export function parseScenes(input: unknown): ParsedScene[] {
  if (!Array.isArray(input)) {
    throw new ValidationError('场列表必须是数组');
  }
  if (input.length === 0) {
    throw new ValidationError('空稿：至少需要一场');
  }
  const scenes: ParsedScene[] = [];
  const names = new Set<string>();
  for (const [i, raw] of input.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      throw new ValidationError(`第 ${i + 1} 场格式不正确`);
    }
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name) {
      throw new ValidationError(`第 ${i + 1} 场缺少场名`);
    }
    if (names.has(name)) {
      throw new ValidationError(`重复场名：「${name}」`);
    }
    names.add(name);
    if (!Array.isArray(r.lines) || r.lines.length === 0) {
      throw new ValidationError(`场「${name}」至少需要一行`);
    }
    const lines: string[] = [];
    for (const [j, line] of r.lines.entries()) {
      if (typeof line !== 'string') {
        throw new ValidationError(`场「${name}」第 ${j + 1} 行不是文本`);
      }
      lines.push(line.replace(/\r\n?/g, '\n'));
    }
    // 全为空行的场视为空场，拒绝
    if (lines.every((l) => l.trim() === '')) {
      throw new ValidationError(`场「${name}」内容为空`);
    }
    scenes.push({ name, lines });
  }
  return scenes;
}

export interface ParsedMark {
  sceneIndex: number;
  startLine: number;
  endLine: number;
  label: string;
  note: string | null;
}

/** 校验标记入参（sceneIndex/startLine/endLine 为 1-based 入参，对应已解析场列表） */
export function parseMarkInput(body: unknown, sceneCount: number, sceneLineCounts: number[]): ParsedMark {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('请求体格式不正确');
  }
  const b = body as Record<string, unknown>;
  const sceneNo = Number(b.sceneNo);
  const startLine = Number(b.startLine);
  const endLine = Number(b.endLine);
  const label = typeof b.label === 'string' ? b.label.trim() : '';
  if (!label) throw new ValidationError('标记名不能为空');
  if (!Number.isInteger(sceneNo) || sceneNo < 1 || sceneNo > sceneCount) {
    throw new ValidationError('标记定位越界：场号无效');
  }
  const maxLine = sceneLineCounts[sceneNo - 1];
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > maxLine
  ) {
    throw new ValidationError(
      `标记定位越界：行号需在 1–${maxLine} 之间，且起始行不晚于结束行`,
    );
  }
  const note =
    typeof b.note === 'string' && b.note.trim() !== '' ? b.note.replace(/\r\n?/g, '\n') : null;
  return { sceneIndex: sceneNo - 1, startLine, endLine, label, note };
}

/** 校验“待核标记重新定位”入参（沿用原标记名，只需提供连续行位置） */
export function parseResolveTarget(body: unknown, sceneCount: number, sceneLineCounts: number[]) {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('请求体格式不正确');
  }
  const b = body as Record<string, unknown>;
  const discard = b.discard === true;
  if (discard) return { discard: true as const };
  const sceneNo = Number(b.sceneNo);
  const startLine = Number(b.startLine);
  const endLine = Number(b.endLine);
  if (!Number.isInteger(sceneNo) || sceneNo < 1 || sceneNo > sceneCount) {
    throw new ValidationError('标记定位越界：场号无效');
  }
  const maxLine = sceneLineCounts[sceneNo - 1];
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > maxLine
  ) {
    throw new ValidationError(
      `标记定位越界：行号需在 1–${maxLine} 之间，且起始行不晚于结束行`,
    );
  }
  return {
    discard: false as const,
    target: { sceneIndex: sceneNo - 1, startLine, endLine },
  };
}

export class ValidationError extends Error {}
