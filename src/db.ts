import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * SQLite 封装（基于 sql.js，即编译为 WASM 的官方 SQLite）。
 * 同步 API；每次写事务提交后把整库原子写回磁盘文件。
 */
export class Db {
  private inTx = false;

  private constructor(
    private readonly sql: Database,
    private readonly file: string,
  ) {}

  static async open(file: string): Promise<Db> {
    const SQL: SqlJsStatic = await initSqlJs({
      locateFile: (name: string) => path.join(path.dirname(require.resolve('sql.js')), name),
    });
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const sql = fs.existsSync(file)
      ? new SQL.Database(fs.readFileSync(file))
      : new SQL.Database();
    const db = new Db(sql, file);
    db.exec('PRAGMA foreign_keys = ON;');
    migrate(db);
    return db;
  }

  exec(sql: string): void {
    this.sql.exec(sql);
  }

  run(sql: string, params: unknown[] = []): void {
    this.sql.run(sql, params as never);
    if (!this.inTx) this.save();
  }

  get<T>(sql: string, params: unknown[] = []): T | undefined {
    return this.all<T>(sql, params)[0];
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.sql.prepare(sql);
    try {
      stmt.bind(params as never);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      return rows;
    } finally {
      stmt.free();
    }
  }

  lastId(): number {
    return this.get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
  }

  /** 上一条 run/exec 影响的行数（用于条件更新的乐观锁判定） */
  changes(): number {
    return this.sql.getRowsModified();
  }

  /** 写事务：BEGIN IMMEDIATE，出错回滚（原确认版等既有数据不受影响），提交后落盘 */
  tx<T>(fn: () => T): T {
    if (this.inTx) throw new Error('不支持嵌套事务');
    this.inTx = true;
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.sql.exec('COMMIT');
      this.inTx = false;
      this.save();
      return result;
    } catch (err) {
      this.sql.exec('ROLLBACK');
      this.inTx = false;
      throw err;
    }
  }

  private save(): void {
    const data = this.sql.export();
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(data));
    fs.renameSync(tmp, this.file);
  }
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scripts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      version_no   INTEGER NOT NULL UNIQUE,
      status       TEXT NOT NULL CHECK (status IN ('confirmed','superseded','draft')),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      confirmed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS scenes (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      script_id INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      position  INTEGER NOT NULL,
      UNIQUE (script_id, name)
    );
    CREATE TABLE IF NOT EXISTS lines (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      text     TEXT NOT NULL,
      UNIQUE (scene_id, position)
    );
    CREATE TABLE IF NOT EXISTS markers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      script_id  INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
      scene_id   INTEGER NOT NULL REFERENCES scenes(id),
      start_pos  INTEGER NOT NULL,
      end_pos    INTEGER NOT NULL,
      note       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (start_pos >= 1 AND end_pos >= start_pos)
    );
    CREATE TABLE IF NOT EXISTS migrations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      base_script_id  INTEGER NOT NULL REFERENCES scripts(id),
      draft_script_id INTEGER NOT NULL REFERENCES scripts(id),
      status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed')),
      version         INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      confirmed_at    TEXT
    );
    CREATE TABLE IF NOT EXISTS migration_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      migration_id    INTEGER NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
      marker_id       INTEGER NOT NULL,
      note            TEXT NOT NULL,
      base_scene_name TEXT NOT NULL,
      base_start      INTEGER NOT NULL,
      base_end        INTEGER NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('auto','pending','resolved','discarded')),
      reason          TEXT,
      new_scene_id    INTEGER,
      new_start       INTEGER,
      new_end         INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_lines_scene   ON lines(scene_id, position);
    CREATE INDEX IF NOT EXISTS idx_markers_script ON markers(script_id);
    CREATE INDEX IF NOT EXISTS idx_items_mig     ON migration_items(migration_id);
  `);
}
