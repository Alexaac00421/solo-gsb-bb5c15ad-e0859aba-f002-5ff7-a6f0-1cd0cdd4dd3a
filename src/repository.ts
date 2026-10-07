import { query, queryOne, withTransaction } from './db.js';
import type { Database } from 'sql.js';
import type {
  LineDTO,
  MarkDTO,
  MatchCandidate,
  PendingReason,
  SceneDTO,
  ScriptSummary,
  VersionDTO,
} from './types.js';
import type { ParsedScene } from './validation.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

interface VersionRow {
  id: number;
  script_id: number;
  version_no: number;
  status: 'draft' | 'confirmed';
  base_version_id: number | null;
  revision: number;
  confirmed_at: string | null;
}

export function getVersion(versionId: number): VersionRow {
  const v = queryOne<VersionRow>('SELECT * FROM versions WHERE id = ?', [versionId]);
  if (!v) throw new ApiError(404, '版本不存在');
  return v;
}

export function getScript(scriptId: number) {
  const s = queryOne<{ id: number; title: string; created_at: string }>(
    'SELECT id, title, created_at FROM scripts WHERE id = ?',
    [scriptId],
  );
  if (!s) throw new ApiError(404, '剧本不存在');
  return s;
}

export function listScripts(): ScriptSummary[] {
  const rows = query<{
    id: number;
    title: string;
    created_at: string;
    latest_confirmed: number | null;
    draft_id: number | null;
  }>(`
    SELECT s.id, s.title, s.created_at,
      (SELECT id FROM versions v
        WHERE v.script_id = s.id AND v.status = 'confirmed'
        ORDER BY v.version_no DESC LIMIT 1) AS latest_confirmed,
      (SELECT id FROM versions v
        WHERE v.script_id = s.id AND v.status = 'draft'
        ORDER BY v.version_no DESC LIMIT 1) AS draft_id
    FROM scripts s ORDER BY s.id DESC
  `);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    latestConfirmedVersionId: r.latest_confirmed,
    draftVersionId: r.draft_id,
  }));
}

/** 某版本每场行数（1-based 长度），按场 ord 排序 */
export function sceneLineCounts(versionId: number): Array<{ sceneId: number; ord: number; name: string; count: number }> {
  return query<{ sceneId: number; ord: number; name: string; count: number }>(
    `SELECT sc.id AS sceneId, sc.ord, sc.name, COUNT(l.id) AS count
       FROM scenes sc JOIN lines l ON l.scene_id = sc.id
      WHERE sc.version_id = ? GROUP BY sc.id ORDER BY sc.ord`,
    [versionId],
  );
}

interface MarkRow {
  id: number;
  version_id: number;
  scene_id: number | null;
  start_line: number | null;
  end_line: number | null;
  label: string;
  note: string | null;
  status: 'active' | 'pending' | 'discarded';
  pending_reason: PendingReason | null;
  candidates_json: string;
  source_mark_id: number | null;
  source_scene_name: string | null;
  source_start_line: number | null;
  source_end_line: number | null;
}

function sourceTextsFor(row: MarkRow): string[] {
  // 有来源标记 => 从基准版本取原文；否则标记自身就是起源，取本标记定位的行
  if (row.source_mark_id !== null && row.source_start_line !== null && row.source_end_line !== null) {
    const src = queryOne<{ version_id: number }>('SELECT version_id FROM marks WHERE id = ?', [
      row.source_mark_id,
    ]);
    if (!src) return [];
    return textsAt(src.version_id, row.source_scene_name, row.source_start_line, row.source_end_line);
  }
  if (row.scene_id !== null && row.start_line !== null && row.end_line !== null) {
    return textsInScene(row.scene_id, row.start_line, row.end_line);
  }
  return [];
}

function textsAt(versionId: number, sceneName: string | null, start: number, end: number): string[] {
  if (sceneName === null) return [];
  const sc = queryOne<{ id: number }>(
    'SELECT id FROM scenes WHERE version_id = ? AND name = ?',
    [versionId, sceneName],
  );
  if (!sc) return [];
  return textsInScene(sc.id, start, end);
}

function textsInScene(sceneId: number, start: number, end: number): string[] {
  const rows = query<{ text: string }>(
    'SELECT text FROM lines WHERE scene_id = ? AND ord BETWEEN ? AND ? ORDER BY ord',
    [sceneId, start, end],
  );
  return rows.map((r) => r.text);
}

export function buildVersionDTO(versionId: number): VersionDTO {
  const v = getVersion(versionId);
  const scenes: SceneDTO[] = [];
  const sceneRows = query<{ id: number; ord: number; name: string }>(
    'SELECT id, ord, name FROM scenes WHERE version_id = ? ORDER BY ord',
    [versionId],
  );
  for (const sc of sceneRows) {
    const lines = query<LineDTO>(
      'SELECT ord, text FROM lines WHERE scene_id = ? ORDER BY ord',
      [sc.id],
    );
    scenes.push({ id: sc.id, ord: sc.ord, name: sc.name, lines });
  }

  const markRows = query<MarkRow>('SELECT * FROM marks WHERE version_id = ? ORDER BY id', [
    versionId,
  ]);
  let pendingCount = 0;
  const marks: MarkDTO[] = markRows.map((m) => {
    let sceneName: string | null = null;
    if (m.scene_id !== null) {
      sceneName =
        queryOne<{ name: string }>('SELECT name FROM scenes WHERE id = ?', [m.scene_id])?.name ??
        null;
    }
    if (m.status === 'pending') pendingCount++;
    return {
      id: m.id,
      sceneId: m.scene_id,
      sceneName,
      startLine: m.start_line,
      endLine: m.end_line,
      label: m.label,
      note: m.note,
      status: m.status,
      pendingReason: m.pending_reason,
      candidates: JSON.parse(m.candidates_json) as MatchCandidate[],
      sourceSceneName: m.source_scene_name,
      sourceStartLine: m.source_start_line,
      sourceEndLine: m.source_end_line,
      sourceTexts: sourceTextsFor(m),
      fromMigration: m.source_mark_id !== null,
    };
  });

  return {
    id: v.id,
    scriptId: v.script_id,
    versionNo: v.version_no,
    status: v.status,
    baseVersionId: v.base_version_id,
    revision: v.revision,
    confirmedAt: v.confirmed_at,
    scenes,
    marks,
    pendingCount,
  };
}

/** 事务内：写入场与行，返回场景元数据 */
export function insertScenes(
  db: Database,
  versionId: number,
  scenes: ParsedScene[],
): Array<{ sceneId: number; ord: number; name: string; count: number }> {
  const out: Array<{ sceneId: number; ord: number; name: string; count: number }> = [];
  scenes.forEach((sc, idx) => {
    db.run('INSERT INTO scenes (version_id, ord, name) VALUES (?, ?, ?)', [
      versionId,
      idx + 1,
      sc.name,
    ]);
    const sceneId = queryOne<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
    sc.lines.forEach((text, j) => {
      db.run('INSERT INTO lines (scene_id, ord, text) VALUES (?, ?, ?)', [
        sceneId,
        j + 1,
        text,
      ]);
    });
    out.push({ sceneId, ord: idx + 1, name: sc.name, count: sc.lines.length });
  });
  return out;
}

/** 事务内：校验并递增版本 revision，返回当前版本行 */
export function checkAndBumpRevision(
  db: Database,
  versionId: number,
  expectedRevision: number | undefined,
): VersionRow {
  const v = queryOne<VersionRow>('SELECT * FROM versions WHERE id = ?', [versionId]);
  if (!v) throw new ApiError(404, '版本不存在');
  if (v.status === 'confirmed') {
    throw new ApiError(409, '该版本已确认，不能再修改', { revision: v.revision });
  }
  const expected = Number(expectedRevision);
  if (!Number.isInteger(expected) || expected !== v.revision) {
    throw new ApiError(409, `版本校验失败：页面数据已过期（当前修订号 ${v.revision}）`, {
      revision: v.revision,
    });
  }
  db.run('UPDATE versions SET revision = revision + 1 WHERE id = ?', [versionId]);
  return v;
}

/** 确认后的只读保护（用于解析/标记等写操作） */
export function assertDraft(versionId: number): VersionRow {
  const v = getVersion(versionId);
  if (v.status === 'confirmed') throw new ApiError(409, '该版本已确认，不能再修改');
  return v;
}

/** 事务辅助包装（供 routes 使用） */
export function tx<T>(fn: (db: Database) => T): Promise<T> {
  return withTransaction(fn);
}
