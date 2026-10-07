import { query, queryOne, withTransaction } from './db.js';
import {
  ApiError,
  buildVersionDTO,
  checkAndBumpRevision,
  getScript,
  getVersion,
  insertScenes,
  sceneLineCounts,
  tx,
} from './repository.js';
import { parseMarkInput, parseResolveTarget, parseScenes, ValidationError } from './validation.js';
import { planMigrations, type NewSceneInput, type SourceMarkInput } from './migration.js';
import { renderPlainText } from './export.js';
import type { VersionDTO } from './types.js';

export { listScripts } from './repository.js';

/** 新建剧本 + 首版草稿（逐场录入） */
export async function createScript(input: {
  title?: unknown;
  scenes?: unknown;
}): Promise<VersionDTO> {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw new ValidationError('剧名不能为空');
  const scenes = parseScenes(input.scenes);

  return withTransaction((db) => {
    db.run('INSERT INTO scripts (title) VALUES (?)', [title]);
    const scriptId = queryOne<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
    db.run(
      "INSERT INTO versions (script_id, version_no, status, revision) VALUES (?, 1, 'draft', 1)",
      [scriptId],
    );
    const versionId = queryOne<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
    insertScenes(db, versionId, scenes);
    return buildVersionDTO(versionId);
  });
}

export function scriptDetail(scriptId: number): {
  id: number;
  title: string;
  createdAt: string;
  confirmed: VersionDTO | null;
  draft: VersionDTO | null;
} {
  const s = getScript(scriptId);
  const confirmed = queryOne<{ id: number }>(
    "SELECT id FROM versions WHERE script_id = ? AND status = 'confirmed' ORDER BY version_no DESC LIMIT 1",
    [scriptId],
  );
  const draft = queryOne<{ id: number }>(
    "SELECT id FROM versions WHERE script_id = ? AND status = 'draft' ORDER BY version_no DESC LIMIT 1",
    [scriptId],
  );
  return {
    id: s.id,
    title: s.title,
    createdAt: s.created_at,
    confirmed: confirmed ? buildVersionDTO(confirmed.id) : null,
    draft: draft ? buildVersionDTO(draft.id) : null,
  };
}

/** 草稿上加标记（连续行） */
export async function addMark(
  versionId: number,
  expectedRevision: number | undefined,
  body: unknown,
): Promise<VersionDTO> {
  return tx((db) => {
    checkAndBumpRevision(db, versionId, expectedRevision);
    const counts = sceneLineCounts(versionId);
    const input = parseMarkInput(
      body,
      counts.length,
      counts.map((c) => c.count),
    );
    const scene = counts[input.sceneIndex];
    db.run(
      'INSERT INTO marks (version_id, scene_id, start_line, end_line, label, note, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [versionId, scene.sceneId, input.startLine, input.endLine, input.label, input.note, 'active'],
    );
    return buildVersionDTO(versionId);
  });
}

/** 删除标记（仅允许删除未确认稿上由手工添加、非迁移来源的标记） */
export async function deleteMark(
  versionId: number,
  markId: number,
  expectedRevision: number | undefined,
): Promise<VersionDTO> {
  return tx((db) => {
    checkAndBumpRevision(db, versionId, expectedRevision);
    const mark = queryOne<{ id: number; source_mark_id: number | null }>(
      'SELECT id, source_mark_id FROM marks WHERE id = ? AND version_id = ?',
      [markId, versionId],
    );
    if (!mark) throw new ApiError(404, '标记不存在');
    if (mark.source_mark_id !== null) {
      throw new ApiError(400, '迁移产生的标记不能直接删除，请通过“废弃”处理');
    }
    db.run('DELETE FROM marks WHERE id = ?', [markId]);
    return buildVersionDTO(versionId);
  });
}

/** 以最近已确认版为基准导入修订稿，产出带迁移结果的新草稿 */
export async function importRevision(
  scriptId: number,
  expectedRevision: number | undefined,
  rawScenes: unknown,
): Promise<VersionDTO> {
  const scriptRow = getScript(scriptId);
  const newScenesInput = parseScenes(rawScenes);

  const base = queryOne<{ id: number; version_no: number }>(
    "SELECT id, version_no FROM versions WHERE script_id = ? AND status = 'confirmed' ORDER BY version_no DESC LIMIT 1",
    [scriptId],
  );
  if (!base) {
    throw new ApiError(409, `剧本「${scriptRow.title}」还没有已确认版，请先确认首版后再导入修订稿`);
  }

  return withTransaction((db) => {
    // 基准行的并发保护：以基准版 revision 校验旧页面
    const baseRow = getVersion(base.id);
    const expected = Number(expectedRevision);
    if (!Number.isInteger(expected) || expected !== baseRow.revision) {
      throw new ApiError(409, `版本校验失败：基准版已变化（当前修订号 ${baseRow.revision}）`, {
        revision: baseRow.revision,
      });
    }

    const existingDraft = queryOne<{ id: number }>(
      "SELECT id FROM versions WHERE script_id = ? AND status = 'draft'",
      [scriptId],
    );
    if (existingDraft) {
      throw new ApiError(409, '已有未确认的修订草稿，请先处理或放弃该草稿', {
        draftVersionId: existingDraft.id,
      });
    }

    db.run(
      "INSERT INTO versions (script_id, version_no, status, base_version_id, revision) VALUES (?, ?, 'draft', ?, 1)",
      [scriptId, base.version_no + 1, base.id],
    );
    const newVersionId = queryOne<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;

    const inserted = insertScenes(db, newVersionId, newScenesInput);
    const newScenes: NewSceneInput[] = inserted.map((s) => ({
      id: s.sceneId,
      ord: s.ord,
      name: s.name,
      lines: query<{ text: string }>('SELECT text FROM lines WHERE scene_id = ? ORDER BY ord', [
        s.sceneId,
      ]).map((r) => r.text),
    }));

    // 基准版有效标记
    const baseMarks = query<
      SourceMarkInput & { dbId: number; label: string; note: string | null }
    >(
      `SELECT m.id AS dbId, m.start_line AS "startLine", m.end_line AS "endLine",
              m.label, m.note, sc.name AS "sceneName"
         FROM marks m JOIN scenes sc ON sc.id = m.scene_id
        WHERE m.version_id = ? AND m.status = 'active'`,
      [base.id],
    );

    const sourceSceneLines = new Map<string, string[]>();
    for (const sc of query<{ id: number; name: string }>(
      'SELECT id, name FROM scenes WHERE version_id = ? ORDER BY ord',
      [base.id],
    )) {
      sourceSceneLines.set(
        sc.name,
        query<{ text: string }>('SELECT text FROM lines WHERE scene_id = ? ORDER BY ord', [
          sc.id,
        ]).map((r) => r.text),
      );
    }

    const plans = planMigrations(
      baseMarks.map((m) => ({
        id: m.dbId,
        sceneName: m.sceneName,
        startLine: m.startLine,
        endLine: m.endLine,
      })),
      sourceSceneLines,
      newScenes,
    );

    plans.forEach((plan, idx) => {
      const src = baseMarks[idx];
      if (plan.status === 'active') {
        db.run(
          `INSERT INTO marks (version_id, scene_id, start_line, end_line, label, note, status,
                              candidates_json, source_mark_id, source_scene_name, source_start_line, source_end_line)
           VALUES (?, ?, ?, ?, ?, ?, 'active', '[]', ?, ?, ?, ?)`,
          [
            newVersionId,
            plan.targetSceneId!,
            plan.targetStartLine!,
            plan.targetEndLine!,
            src.label,
            src.note,
            plan.markId,
            plan.sourceSceneName,
            plan.sourceStartLine,
            plan.sourceEndLine,
          ],
        );
      } else {
        db.run(
          `INSERT INTO marks (version_id, label, note, status, pending_reason, candidates_json,
                              source_mark_id, source_scene_name, source_start_line, source_end_line)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
          [
            newVersionId,
            src.label,
            src.note,
            plan.pendingReason!,
            JSON.stringify(plan.candidates),
            plan.markId,
            plan.sourceSceneName,
            plan.sourceStartLine,
            plan.sourceEndLine,
          ],
        );
      }
    });

    return buildVersionDTO(newVersionId);
  });
}

/** 待核标记：选择新稿连续行重新定位，或废弃 */
export async function resolveMark(
  versionId: number,
  markId: number,
  expectedRevision: number | undefined,
  body: unknown,
): Promise<VersionDTO> {
  return tx((db) => {
    checkAndBumpRevision(db, versionId, expectedRevision);
    const mark = queryOne<{
      id: number;
      status: string;
      pending_reason: string | null;
    }>('SELECT id, status, pending_reason FROM marks WHERE id = ? AND version_id = ?', [
      markId,
      versionId,
    ]);
    if (!mark) throw new ApiError(404, '标记不存在');
    if (mark.status !== 'pending') {
      throw new ApiError(400, '只有待核标记可以重新定位或废弃');
    }

    const counts = sceneLineCounts(versionId);
    const decision = parseResolveTarget(
      body,
      counts.length,
      counts.map((c) => c.count),
    );

    if (decision.discard) {
      db.run(
        "UPDATE marks SET status = 'discarded', scene_id = NULL, start_line = NULL, end_line = NULL, pending_reason = NULL, candidates_json = '[]' WHERE id = ?",
        [markId],
      );
    } else {
      const t = decision.target;
      const scene = counts[t.sceneIndex];
      db.run(
        `UPDATE marks SET status = 'active', scene_id = ?, start_line = ?, end_line = ?,
                          pending_reason = NULL, candidates_json = '[]' WHERE id = ?`,
        [scene.sceneId, t.startLine, t.endLine, markId],
      );
    }
    return buildVersionDTO(versionId);
  });
}

/** 放弃未确认草稿（整版作废，已确认版保持不动） */
export async function discardDraft(
  versionId: number,
  expectedRevision: number | undefined,
): Promise<{ scriptId: number }> {
  return tx((db) => {
    const v = checkAndBumpRevision(db, versionId, expectedRevision);
    db.run('DELETE FROM versions WHERE id = ?', [versionId]);
    return { scriptId: v.script_id };
  });
}

/** 确认版本：乐观锁 + 必须无待核；失败保留原确认版 */
export async function confirmVersion(
  versionId: number,
  expectedRevision: number | undefined,
): Promise<VersionDTO> {
  return tx((db) => {
    checkAndBumpRevision(db, versionId, expectedRevision);
    const pending = queryOne<{ c: number }>(
      "SELECT COUNT(*) AS c FROM marks WHERE version_id = ? AND status = 'pending'",
      [versionId],
    )!.c;
    if (pending > 0) {
      throw new ApiError(409, `还有 ${pending} 条待核标记未处理，不能确认`, {
        pendingCount: pending,
      });
    }
    db.run(
      "UPDATE versions SET status = 'confirmed', confirmed_at = datetime('now'), revision = revision WHERE id = ?",
      [versionId],
    );
    return buildVersionDTO(versionId);
  });
}

/** 导出已确认版纯文本 */
export function exportVersion(versionId: number): { filename: string; text: string } {
  const v = getVersion(versionId);
  if (v.status !== 'confirmed') throw new ApiError(409, '只有已确认版本才能导出');
  const script = getScript(v.script_id);
  const dto = buildVersionDTO(versionId);
  return {
    filename: `${script.title}_v${v.version_no}.txt`,
    text: renderPlainText(dto, script.title),
  };
}
