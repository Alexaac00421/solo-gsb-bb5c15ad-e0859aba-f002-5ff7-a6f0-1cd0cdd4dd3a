import express, { NextFunction, Request, Response } from 'express';
import * as path from 'node:path';
import { Db } from './db';
import { parseScriptText, validateScenes, ParsedScene, ScriptError } from './parser';
import { locateMarker, SceneForMatch } from './migration';

// ---------- 行类型 ----------

interface ScriptRow { id: number; version_no: number; status: string; created_at: string; confirmed_at: string | null }
interface SceneRow { id: number; script_id: number; name: string; position: number }
interface LineRow { id: number; scene_id: number; position: number; text: string }
interface MarkerRow { id: number; script_id: number; scene_id: number; start_pos: number; end_pos: number; note: string; created_at: string }
interface MigrationRow { id: number; base_script_id: number; draft_script_id: number; status: string; version: number; created_at: string; confirmed_at: string | null }
interface ItemRow {
  id: number; migration_id: number; marker_id: number; note: string;
  base_scene_name: string; base_start: number; base_end: number;
  status: string; reason: string | null;
  new_scene_id: number | null; new_start: number | null; new_end: number | null;
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function createApp(db: Db) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---------- 读取辅助 ----------

  function loadScriptFull(id: number) {
    const s = db.get<ScriptRow>('SELECT * FROM scripts WHERE id = ?', [id]);
    if (!s) return null;
    const scenes = db.all<SceneRow>('SELECT * FROM scenes WHERE script_id = ? ORDER BY position', [id])
      .map((sc) => ({
        ...sc,
        lines: db.all<LineRow>('SELECT * FROM lines WHERE scene_id = ? ORDER BY position', [sc.id]),
      }));
    const markers = db.all<MarkerRow>('SELECT * FROM markers WHERE script_id = ? ORDER BY id', [id]);
    return { ...s, scenes, markers };
  }

  function sceneLineCount(sceneId: number): number {
    return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM lines WHERE scene_id = ?', [sceneId])!.n;
  }

  function currentConfirmed(): ScriptRow | undefined {
    return db.get<ScriptRow>("SELECT * FROM scripts WHERE status = 'confirmed' ORDER BY version_no DESC LIMIT 1");
  }

  function openMigration(): MigrationRow | undefined {
    return db.get<MigrationRow>("SELECT * FROM migrations WHERE status = 'open' ORDER BY id DESC LIMIT 1");
  }

  function coveredTexts(sceneId: number, start: number, end: number): string[] {
    return db.all<{ text: string }>(
      'SELECT text FROM lines WHERE scene_id = ? AND position BETWEEN ? AND ? ORDER BY position',
      [sceneId, start, end],
    ).map((r) => r.text);
  }

  function discardsFor(scriptId: number) {
    const mig = db.get<MigrationRow>(
      "SELECT * FROM migrations WHERE draft_script_id = ? AND status = 'confirmed'", [scriptId]);
    if (!mig) return [];
    return db.all<ItemRow>(
      "SELECT * FROM migration_items WHERE migration_id = ? AND status = 'discarded' ORDER BY id", [mig.id]);
  }

  function migrationDetail(m: MigrationRow) {
    const base = loadScriptFull(m.base_script_id)!;
    const draft = loadScriptFull(m.draft_script_id)!;
    const items = db.all<ItemRow>('SELECT * FROM migration_items WHERE migration_id = ? ORDER BY id', [m.id])
      .map((it) => {
        const baseScene = base.scenes.find((s) => s.name === it.base_scene_name);
        const covered = baseScene
          ? baseScene.lines.filter((l) => l.position >= it.base_start && l.position <= it.base_end).map((l) => l.text)
          : [];
        const newScene = it.new_scene_id != null ? draft.scenes.find((s) => s.id === it.new_scene_id) : undefined;
        return { ...it, new_scene_name: newScene ? newScene.name : null, covered };
      });
    return { ...m, base, draft, items };
  }

  function stateJson() {
    const cur = currentConfirmed();
    const script = cur ? loadScriptFull(cur.id) : null;
    if (script) (script as Record<string, unknown>).discards = discardsFor(script.id);
    const mig = openMigration();
    return {
      script,
      migration: mig ? migrationDetail(mig) : null,
      history: db.all<ScriptRow>('SELECT id, version_no, status, created_at, confirmed_at FROM scripts ORDER BY version_no DESC'),
    };
  }

  // ---------- 输入校验 ----------

  function scenesFromBody(body: unknown): ParsedScene[] {
    const b = body as Record<string, unknown> | null;
    if (b && typeof b.text === 'string') {
      try {
        return parseScriptText(b.text);
      } catch (e) {
        if (e instanceof ScriptError) throw new HttpError(400, e.message);
        throw e;
      }
    }
    if (b && Array.isArray(b.scenes)) {
      const scenes: ParsedScene[] = b.scenes.map((s: unknown) => {
        const sc = s as Record<string, unknown>;
        if (typeof sc?.name !== 'string') throw new HttpError(400, '每个场景都必须有场名（字符串）');
        const lines = Array.isArray(sc.lines)
          ? sc.lines.map((l: unknown) => String(l).trim()).filter((l: string) => l.length > 0)
          : [];
        return { name: sc.name.trim(), lines };
      });
      try {
        validateScenes(scenes);
      } catch (e) {
        if (e instanceof ScriptError) throw new HttpError(400, e.message);
        throw e;
      }
      return scenes;
    }
    throw new HttpError(400, '请求体须包含 text（剧本文本）或 scenes（结构化场景数组）');
  }

  function insertScript(versionNo: number, status: 'confirmed' | 'draft', scenes: ParsedScene[]): number {
    db.run(
      `INSERT INTO scripts (version_no, status, confirmed_at) VALUES (?, ?, ${status === 'confirmed' ? "datetime('now')" : 'NULL'})`,
      [versionNo, status],
    );
    const scriptId = db.lastId();
    scenes.forEach((sc, i) => {
      db.run('INSERT INTO scenes (script_id, name, position) VALUES (?, ?, ?)', [scriptId, sc.name, i + 1]);
      const sceneId = db.lastId();
      sc.lines.forEach((text, j) => {
        db.run('INSERT INTO lines (scene_id, position, text) VALUES (?, ?, ?)', [sceneId, j + 1, text]);
      });
    });
    return scriptId;
  }

  /** 越界定位校验：场景必须属于该剧本，1 <= start <= end <= 场景行数 */
  function checkRange(scriptId: number, sceneId: unknown, start: unknown, end: unknown): { sceneId: number; start: number; end: number } {
    if (!Number.isInteger(sceneId) || !Number.isInteger(start) || !Number.isInteger(end)) {
      throw new HttpError(400, '定位参数必须是整数（scene_id / start / end）');
    }
    const scene = db.get<SceneRow>('SELECT * FROM scenes WHERE id = ? AND script_id = ?', [sceneId, scriptId]);
    if (!scene) throw new HttpError(400, '场景不存在或不属于该剧本');
    const count = sceneLineCount(scene.id);
    const s = start as number, e = end as number;
    if (s < 1 || e < s || e > count) {
      throw new HttpError(400, `越界定位：场景「${scene.name}」共 ${count} 行，合法范围为 1-${count}，且起点不得大于终点`);
    }
    return { sceneId: scene.id, start: s, end: e };
  }

  // ---------- 路由 ----------

  app.get('/api/state', (_req: Request, res: Response) => {
    res.json(stateJson());
  });

  // 录入初始剧本（逐场录入或整稿粘贴，直接成为已确认基准版）
  app.post('/api/scripts', (req: Request, res: Response) => {
    if (currentConfirmed() || openMigration()) {
      throw new HttpError(409, '已存在剧本：请使用「导入修订稿」流程产生新版本');
    }
    const scenes = scenesFromBody(req.body);
    const id = db.tx(() => insertScript(1, 'confirmed', scenes));
    res.status(201).json({ ...stateJson(), created: id });
  });

  // 在当前确认版上添加标记（同场连续行）
  app.post('/api/scripts/:id/markers', (req: Request, res: Response) => {
    const scriptId = Number(req.params.id);
    const cur = currentConfirmed();
    if (!cur || cur.id !== scriptId) throw new HttpError(409, '只能对当前已确认版添加标记');
    if (openMigration()) throw new HttpError(409, '迁移进行中，基准版已锁定，不能增删标记');
    const { scene_id, start, end, note } = req.body ?? {};
    if (typeof note !== 'string' || !note.trim()) throw new HttpError(400, '标记说明不能为空');
    const loc = checkRange(scriptId, scene_id, start, end);
    db.run('INSERT INTO markers (script_id, scene_id, start_pos, end_pos, note) VALUES (?, ?, ?, ?, ?)',
      [scriptId, loc.sceneId, loc.start, loc.end, note.trim()]);
    res.status(201).json(stateJson());
  });

  app.delete('/api/markers/:id', (req: Request, res: Response) => {
    const cur = currentConfirmed();
    if (!cur) throw new HttpError(409, '当前没有已确认版');
    if (openMigration()) throw new HttpError(409, '迁移进行中，基准版已锁定，不能增删标记');
    const mk = db.get<MarkerRow>('SELECT * FROM markers WHERE id = ? AND script_id = ?', [Number(req.params.id), cur.id]);
    if (!mk) throw new HttpError(404, '标记不存在');
    db.run('DELETE FROM markers WHERE id = ?', [mk.id]);
    res.json(stateJson());
  });

  // 导入修订稿：以最近已确认版为基准生成对照与标记去向
  app.post('/api/migrations', (req: Request, res: Response) => {
    const base = currentConfirmed();
    if (!base) throw new HttpError(400, '尚无已确认剧本作为基准，请先录入初始剧本');
    if (openMigration()) throw new HttpError(409, '已有一次未完成的迁移，请先确认或放弃');
    const scenes = scenesFromBody(req.body);

    const migId = db.tx(() => {
      const draftId = insertScript(base.version_no + 1, 'draft', scenes);
      db.run('INSERT INTO migrations (base_script_id, draft_script_id) VALUES (?, ?)', [base.id, draftId]);
      const id = db.lastId();

      const newScenes: SceneForMatch[] = db.all<SceneRow>('SELECT * FROM scenes WHERE script_id = ? ORDER BY position', [draftId])
        .map((sc) => ({
          id: sc.id,
          name: sc.name,
          lines: db.all<LineRow>('SELECT * FROM lines WHERE scene_id = ? ORDER BY position', [sc.id]),
        }));
      const markers = db.all<MarkerRow>('SELECT * FROM markers WHERE script_id = ? ORDER BY id', [base.id]);
      for (const mk of markers) {
        const baseScene = db.get<SceneRow>('SELECT * FROM scenes WHERE id = ?', [mk.scene_id])!;
        const covered = coveredTexts(mk.scene_id, mk.start_pos, mk.end_pos);
        const loc = locateMarker(baseScene.name, covered, newScenes);
        if (loc.status === 'auto') {
          db.run(
            `INSERT INTO migration_items (migration_id, marker_id, note, base_scene_name, base_start, base_end, status, reason, new_scene_id, new_start, new_end)
             VALUES (?, ?, ?, ?, ?, ?, 'auto', NULL, ?, ?, ?)`,
            [id, mk.id, mk.note, baseScene.name, mk.start_pos, mk.end_pos, loc.sceneId, loc.start, loc.end],
          );
        } else {
          db.run(
            `INSERT INTO migration_items (migration_id, marker_id, note, base_scene_name, base_start, base_end, status, reason)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
            [id, mk.id, mk.note, baseScene.name, mk.start_pos, mk.end_pos, loc.reason],
          );
        }
      }
      return id;
    });
    res.status(201).json({ ...stateJson(), migration_id: migId });
  });

  function loadOpenItem(req: Request): { mig: MigrationRow; item: ItemRow } {
    const mig = db.get<MigrationRow>('SELECT * FROM migrations WHERE id = ?', [Number(req.params.id)]);
    if (!mig || mig.status !== 'open') throw new HttpError(409, '迁移不存在或已关闭');
    const item = db.get<ItemRow>('SELECT * FROM migration_items WHERE id = ? AND migration_id = ?',
      [Number(req.params.itemId), mig.id]);
    if (!item) throw new HttpError(404, '迁移条目不存在');
    return { mig, item };
  }

  // 待核标记：由用户在新稿中选择同场连续行重新定位
  app.post('/api/migrations/:id/items/:itemId/resolve', (req: Request, res: Response) => {
    const { mig } = loadOpenItem(req);
    const { scene_id, start, end } = req.body ?? {};
    const loc = checkRange(mig.draft_script_id, scene_id, start, end);
    db.tx(() => {
      db.run(
        `UPDATE migration_items SET status = 'resolved', reason = NULL, new_scene_id = ?, new_start = ?, new_end = ? WHERE id = ?`,
        [loc.sceneId, loc.start, loc.end, Number(req.params.itemId)],
      );
      db.run('UPDATE migrations SET version = version + 1 WHERE id = ?', [mig.id]);
    });
    res.json(stateJson());
  });

  // 待核标记：丢弃
  app.post('/api/migrations/:id/items/:itemId/discard', (req: Request, res: Response) => {
    const { mig } = loadOpenItem(req);
    db.tx(() => {
      db.run(
        `UPDATE migration_items SET status = 'discarded', new_scene_id = NULL, new_start = NULL, new_end = NULL WHERE id = ?`,
        [Number(req.params.itemId)],
      );
      db.run('UPDATE migrations SET version = version + 1 WHERE id = ?', [mig.id]);
    });
    res.json(stateJson());
  });

  // 确认迁移：版本校验（乐观锁），待核未清零不得确认；任何失败都回滚，原确认版保留
  app.post('/api/migrations/:id/confirm', (req: Request, res: Response) => {
    const mig = db.get<MigrationRow>('SELECT * FROM migrations WHERE id = ?', [Number(req.params.id)]);
    if (!mig || mig.status !== 'open') throw new HttpError(409, '迁移不存在或已关闭');
    const { version } = req.body ?? {};
    if (typeof version !== 'number' || version !== mig.version) {
      throw new HttpError(409, `版本校验失败：页面数据已过期（当前版本 ${mig.version}），请刷新后重试`);
    }
    const pending = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM migration_items WHERE migration_id = ? AND status = 'pending'", [mig.id])!.n;
    if (pending > 0) throw new HttpError(400, `仍有 ${pending} 条待核标记未处理，不得确认或导出`);

    db.tx(() => {
      // 条件更新即原子版本校验，并发下只有一个提交者能成功
      db.run(
        `UPDATE migrations SET status = 'confirmed', confirmed_at = datetime('now'), version = version + 1
         WHERE id = ? AND version = ? AND status = 'open'`,
        [mig.id, version],
      );
      if (db.changes() !== 1) throw new HttpError(409, '版本校验失败：数据已被他人更新，请刷新后重试');

      const items = db.all<ItemRow>(
        "SELECT * FROM migration_items WHERE migration_id = ? AND status IN ('auto','resolved')", [mig.id]);
      for (const it of items) {
        db.run('INSERT INTO markers (script_id, scene_id, start_pos, end_pos, note) VALUES (?, ?, ?, ?, ?)',
          [mig.draft_script_id, it.new_scene_id, it.new_start, it.new_end, it.note]);
      }
      db.run("UPDATE scripts SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ?", [mig.draft_script_id]);
      db.run("UPDATE scripts SET status = 'superseded' WHERE id = ?", [mig.base_script_id]);
    });
    res.json(stateJson());
  });

  // 放弃本次迁移：删除草稿与迁移记录，原确认版不变
  app.post('/api/migrations/:id/abandon', (req: Request, res: Response) => {
    const mig = db.get<MigrationRow>('SELECT * FROM migrations WHERE id = ?', [Number(req.params.id)]);
    if (!mig || mig.status !== 'open') throw new HttpError(409, '迁移不存在或已关闭');
    db.tx(() => {
      db.run('DELETE FROM migration_items WHERE migration_id = ?', [mig.id]);
      db.run('DELETE FROM migrations WHERE id = ?', [mig.id]);
      db.run('DELETE FROM scripts WHERE id = ?', [mig.draft_script_id]);
    });
    res.json(stateJson());
  });

  // 导出：带已确认标记的纯文本新稿 + 废弃记录
  app.get('/api/scripts/:id/export', (req: Request, res: Response) => {
    const s = loadScriptFull(Number(req.params.id));
    if (!s) throw new HttpError(404, '剧本不存在');
    if (s.status === 'draft') throw new HttpError(400, '草稿未确认，不得导出');
    const mig = openMigration();
    if (mig && mig.draft_script_id === s.id) throw new HttpError(400, '迁移未确认完成，不得导出新稿');

    const out: string[] = [];
    out.push(`剧本 第 ${s.version_no} 版（${s.status === 'confirmed' ? '当前确认版' : '历史版本'}）`);
    out.push(`确认时间：${s.confirmed_at ?? '-'}    导出时间：${new Date().toISOString()}`);
    out.push('');
    for (const sc of s.scenes) {
      out.push(`# ${sc.name}`);
      for (const ln of sc.lines) out.push(ln.text);
      const marks = s.markers.filter((mk) => mk.scene_id === sc.id);
      if (marks.length > 0) {
        out.push('  ── 本场标记 ──');
        for (const mk of marks) {
          const range = mk.start_pos === mk.end_pos ? `第${mk.start_pos}行` : `第${mk.start_pos}-${mk.end_pos}行`;
          out.push(`  [标记 ${range}] ${mk.note.replace(/\s*\n\s*/g, ' ')}`);
        }
      }
      out.push('');
    }
    const discards = discardsFor(s.id);
    if (discards.length > 0) {
      const reasonText: Record<string, string> = {
        duplicate: '重复匹配', cross_scene: '跨场移动', deleted_or_modified: '删改',
      };
      out.push('── 废弃记录（本次迁移中被废弃的标记）──');
      for (const d of discards) {
        const range = d.base_start === d.base_end ? `第${d.base_start}行` : `第${d.base_start}-${d.base_end}行`;
        const reason = d.reason ? `（原因：${reasonText[d.reason] ?? d.reason}）` : '';
        out.push(`- [${d.base_scene_name} ${range}] ${d.note.replace(/\s*\n\s*/g, ' ')}${reason}`);
      }
      out.push('');
    }
    const text = out.join('\n');
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="script-v${s.version_no}.txt"`);
    }
    res.type('text/plain; charset=utf-8').send(text);
  });

  app.get('/api/scripts/:id', (req: Request, res: Response) => {
    const s = loadScriptFull(Number(req.params.id));
    if (!s) throw new HttpError(404, '剧本不存在');
    res.json({ ...s, discards: discardsFor(s.id) });
  });

  // ---------- 错误处理 ----------

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: '接口不存在' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
    } else if (err instanceof ScriptError) {
      res.status(400).json({ error: err.message });
    } else {
      console.error(err);
      res.status(500).json({ error: '服务器内部错误' });
    }
  });

  return app;
}
