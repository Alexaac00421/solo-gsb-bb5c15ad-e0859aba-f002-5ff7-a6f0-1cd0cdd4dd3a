import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { existsSync } from 'node:fs';
import * as service from './service.js';
import { buildVersionDTO } from './repository.js';
import { ValidationError } from './validation.js';
import { ApiError } from './repository.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 开发态静态文件在 public/（src 同级），编译态 dist/server.js 时回退到上级 public/
const PUBLIC_DIRS = [join(__dirname, '..', 'public'), join(__dirname, 'public')];

const PORT = Number(process.env.PORT || 3000);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new ApiError(413, '请求体过大（上限 5MB）');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    throw new ValidationError('请求体不是合法 JSON');
  }
}

function revisionOf(url: URL, body: unknown): number | undefined {
  const q = url.searchParams.get('revision');
  if (q !== null) return Number(q);
  if (body && typeof body === 'object') {
    const r = (body as Record<string, unknown>).revision;
    if (typeof r === 'number') return r;
    if (typeof r === 'string') return Number(r);
  }
  return undefined;
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: unknown,
  params: Record<string, string>,
) => Promise<void>;

const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];
function route(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/:([A-Za-z]+)/g, (_, k: string) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '$',
  );
  routes.push({ method, pattern, keys, handler });
}

// ---------- 路由 ----------

route('GET', '/api/health', async (_req, res, _url, _body, _params) => {
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/scripts', async (_req, res, _url, _body, _params) => {
  sendJson(res, 200, { scripts: service.listScripts() });
});

route('POST', '/api/scripts', async (_req, res, _url, body, _params) => {
  const b = body as { title?: unknown; scenes?: unknown };
  sendJson(res, 201, await service.createScript(b));
});

route('GET', '/api/scripts/:id', async (_req, res, _url, _body, params) => {
  sendJson(res, 200, service.scriptDetail(Number(params.id)));
});

route('POST', '/api/scripts/:id/import', async (_req, res, url, body, params) => {
  const b = body as { scenes?: unknown };
  sendJson(
    res,
    201,
    await service.importRevision(Number(params.id), revisionOf(url, body), b.scenes),
  );
});

route('GET', '/api/versions/:id', async (_req, res, _url, _body, params) => {
  sendJson(res, 200, buildVersionDTO(Number(params.id)));
});

route('POST', '/api/versions/:id/marks', async (_req, res, url, body, params) => {
  sendJson(res, 201, await service.addMark(Number(params.id), revisionOf(url, body), body));
});

route('POST', '/api/versions/:id/marks/:markId/resolve', async (_req, res, url, body, params) => {
  sendJson(
    res,
    200,
    await service.resolveMark(
      Number(params.id),
      Number(params.markId),
      revisionOf(url, body),
      body,
    ),
  );
});

route('DELETE', '/api/versions/:id/marks/:markId', async (_req, res, url, _body, params) => {
  sendJson(
    res,
    200,
    await service.deleteMark(Number(params.id), Number(params.markId), revisionOf(url, null)),
  );
});

route('POST', '/api/versions/:id/confirm', async (_req, res, url, body, params) => {
  sendJson(res, 200, await service.confirmVersion(Number(params.id), revisionOf(url, body)));
});

route('DELETE', '/api/versions/:id/draft', async (_req, res, url, _body, params) => {
  sendJson(res, 200, await service.discardDraft(Number(params.id), revisionOf(url, null)));
});

route('GET', '/api/versions/:id/export', async (_req, res, _url, _body, params) => {
  const { filename, text } = service.exportVersion(Number(params.id));
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  res.end(text);
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const safe = normalize(rel);
  if (safe.startsWith('..') || safe.includes('..')) {
    sendJson(res, 400, { error: '非法路径' });
    return;
  }
  for (const dir of PUBLIC_DIRS) {
    const file = join(dir, safe);
    if (file.startsWith(dir) && existsSync(file)) {
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream',
      });
      res.end(data);
      return;
    }
  }
  // SPA 回退到首页
  for (const dir of PUBLIC_DIRS) {
    const index = join(dir, 'index.html');
    if (existsSync(index)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(await readFile(index));
      return;
    }
  }
  sendJson(res, 404, { error: '静态资源缺失' });
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  try {
    const apiMatch = routes.find(
      (r) => r.method === req.method && r.pattern.test(url.pathname),
    );
    if (url.pathname.startsWith('/api/')) {
      if (!apiMatch) {
        sendJson(res, 404, { error: '接口不存在' });
        return;
      }
      const m = url.pathname.match(apiMatch.pattern)!;
      const params: Record<string, string> = {};
      apiMatch.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      const body =
        req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'
          ? await readJson(req)
          : null;
      await apiMatch.handler(req, res, url, body, params);
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (err) {
    if (err instanceof ApiError) {
      sendJson(res, err.status, { error: err.message, ...(err.extra ?? {}) });
    } else if (err instanceof ValidationError) {
      sendJson(res, 400, { error: err.message });
    } else {
      console.error(err);
      sendJson(res, 500, { error: '服务器内部错误' });
    }
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { initDb } = await import('./db.js');
  await initDb();
  server.listen(PORT, () => {
    console.log(`剧本修订标记迁移应用已启动：http://localhost:${PORT}`);
  });
}
