// SQLite 持久化层（sql.js：官方 SQLite 编译为 WebAssembly，数据库文件为标准 SQLite 格式）
// 所有写操作在同一事件循环内串行执行，写后原子落盘（先写临时文件再 rename）。
import initSqlJs, { type Database, type SqlJsStatic, type QueryExecResult } from 'sql.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { accessSync, constants, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

function defaultDbPath(): string {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  // 容器内挂载点 /data 存在且可写则用之；否则（本地 npm run dev）落到项目 ./data/
  try {
    if (existsSync('/data')) {
      accessSync('/data', constants.W_OK);
      return '/data/app.db';
    }
  } catch {
    /* /data 不可写，落到项目目录 */
  }
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  return join(projectRoot, 'data', 'app.db');
}

export const DB_PATH = defaultDbPath();

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;
let writing = false;

// 进程内串行写锁：保证 sql.js 状态与落盘文件一致
const queue: Array<() => void> = [];
function acquire(): Promise<void> {
  if (!writing) {
    writing = true;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}
function release(): void {
  const next = queue.shift();
  if (next) next();
  else writing = false;
}

/** 在串行写锁内执行事务，成功后原子落盘；抛错则回滚（export 之前不触碰文件） */
export async function withTransaction<T>(fn: (database: Database) => T): Promise<T> {
  await acquire();
  if (!db) throw new Error('数据库未初始化');
  try {
    db.run('SAVEPOINT app_tx');
    let result: T;
    try {
      result = fn(db);
    } catch (err) {
      db.run('ROLLBACK TO SAVEPOINT app_tx');
      db.run('RELEASE SAVEPOINT app_tx');
      throw err;
    }
    db.run('RELEASE SAVEPOINT app_tx');
    flush(db);
    return result;
  } finally {
    release();
  }
}

function flush(database: Database): void {
  const data = database.export();
  const tmp = `${DB_PATH}.tmp`;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  writeFileSync(tmp, Buffer.from(data));
  renameSync(tmp, DB_PATH);
}

/** 只读查询（sql.js 读不需要锁，单线程事件循环中安全） */
export function query<T = unknown>(sql: string, params: unknown[] = []): T[] {
  if (!db) throw new Error('数据库未初始化');
  let stmt;
  try {
    stmt = db.prepare(sql);
    stmt.bind(params as never);
    const rows: T[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as unknown as T);
    return rows;
  } finally {
    stmt?.free();
  }
}

/** 取单行 */
export function queryOne<T = unknown>(sql: string, params: unknown[] = []): T | undefined {
  return query<T>(sql, params)[0];
}

/** 只读执行原始 SQL（多结果集，一般用于测试/PRAGMA） */
export function execRaw(sql: string): QueryExecResult[] {
  if (!db) throw new Error('数据库未初始化');
  return db.exec(sql);
}

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','confirmed')),
  base_version_id INTEGER REFERENCES versions(id),
  revision INTEGER NOT NULL DEFAULT 1,
  confirmed_at TEXT,
  UNIQUE (script_id, version_no)
);

CREATE TABLE IF NOT EXISTS scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (version_id, ord)
);

CREATE TABLE IF NOT EXISTS lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  UNIQUE (scene_id, ord)
);

-- 提示标记。定位到连续行：scene_id + 起始/结束行号（1-based，含端点，同一场内）。
-- pending/discarded 时 scene_id/起止行为 NULL，原文快照保留在 source_* 字段中用于展示与导出。
CREATE TABLE IF NOT EXISTS marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  scene_id INTEGER REFERENCES scenes(id) ON DELETE RESTRICT,
  start_line INTEGER,
  end_line INTEGER,
  label TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','pending','discarded')),
  pending_reason TEXT CHECK (pending_reason IN ('deleted_or_edited','duplicate','moved')),
  candidates_json TEXT NOT NULL DEFAULT '[]',
  source_mark_id INTEGER REFERENCES marks(id),
  source_scene_name TEXT,
  source_start_line INTEGER,
  source_end_line INTEGER
);

CREATE INDEX IF NOT EXISTS idx_versions_script ON versions(script_id);
CREATE INDEX IF NOT EXISTS idx_scenes_version ON scenes(version_id);
CREATE INDEX IF NOT EXISTS idx_lines_scene ON lines(scene_id);
CREATE INDEX IF NOT EXISTS idx_marks_version ON marks(version_id);
CREATE INDEX IF NOT EXISTS idx_marks_scene ON marks(scene_id);
`;

export async function initDb(): Promise<void> {
  SQL = await initSqlJs({
    // 开发(tsx, src/)与生产(node, dist/)均从 node_modules 定位 wasm
    // require.resolve('sql.js') 解析到 .../sql.js/dist/sql-wasm.js，wasm 与其同目录
    locateFile: (file: string) => join(dirname(require.resolve('sql.js')), file),
  });
  mkdirSync(dirname(DB_PATH), { recursive: true });
  if (existsSync(DB_PATH)) {
    const { readFileSync } = await import('node:fs');
    db = new SQL.Database(readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run(SCHEMA);
  flush(db);
}
