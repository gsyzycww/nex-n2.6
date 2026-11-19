import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const API_ORIGIN = (process.env.MOSS_API_ORIGIN || 'https://api.mosi.cn').replace(/\/+$/, '');
const SERVER_API_KEY = process.env.MOSS_API_KEY || '';
const MAX_BODY_BYTES = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/api/config') {
      return sendJson(res, 200, { hasServerKey: Boolean(SERVER_API_KEY) });
    }
    if (pathname === '/api/chat') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: { message: '只支持 POST 请求' } });
      return await handleChat(req, res);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, pathname);
    sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
  } catch (err) {
    console.error('[moss-chat]', err);
    if (!res.headersSent) sendJson(res, 500, { error: { message: '服务内部错误：' + err.message } });
    else res.end();
  }
});

async function handleChat(req, res) {
  let body;
  try {
    const raw = await readBody(req, MAX_BODY_BYTES);
    body = JSON.parse(raw || '{}');
  } catch (err) {
    const status = err.status || 400;
    return sendJson(res, status, { error: { message: err.message || '请求体不是合法 JSON' } });
  }

  const clientKey = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const apiKey = SERVER_API_KEY || clientKey;
  if (!apiKey) {
    return sendJson(res, 401, {
      error: { message: '缺少 API Key：请在页面「设置」里填写，或启动服务时设置 MOSS_API_KEY 环境变量。' },
    });
  }
  if (typeof body.model !== 'string' || !body.model.trim()) {
    return sendJson(res, 400, { error: { message: '缺少 model 字段，例如 "nex-n2.6"。' } });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendJson(res, 400, { error: { message: 'messages 必须是非空数组。' } });
  }

  const stream = body.stream !== false;
  const payload = {
    model: body.model.trim(),
    messages: body.messages,
    max_tokens: clampInt(body.max_tokens, 8192, 1, 131072),
    stream,
  };
  if (stream) payload.stream_options = { include_usage: true };
  if (body.thinking === true || body.thinking?.type === 'enabled') payload.thinking = { type: 'enabled' };

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let upstream;
  try {
    upstream = await fetch(`${API_ORIGIN}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    return sendJson(res, 502, { error: { message: '无法连接 MOSS API：' + err.message } });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return sendJson(res, upstream.status, { error: { message: extractError(text, upstream.status) } });
  }

  if (!stream) {
    const data = await upstream.text();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(data);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  try {
    for await (const chunk of upstream.body) {
      if (res.writableEnded) break;
      res.write(chunk);
    }
    res.end();
  } catch {
    res.end();
  }
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: { message: '非法路径' } });
  }
  if (rel === '/') rel = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: { message: 'Forbidden' } });
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('请求体过大');
        err.status = 413;
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function extractError(text, status) {
  let message = `MOSS API 返回 HTTP ${status}`;
  try {
    const data = JSON.parse(text);
    message = data?.error?.message || data?.message || message;
  } catch {
    if (text && text.trim()) message += '：' + text.trim().slice(0, 300);
  }
  return message;
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sendJson(res, status, data) {
  if (res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

server.listen(PORT, () => {
  console.log(`Nex Chat 已启动: http://localhost:${PORT}`);
  console.log(`MOSS API 地址: ${API_ORIGIN}`);
  console.log(SERVER_API_KEY ? 'API Key: 使用服务端环境变量 MOSS_API_KEY' : 'API Key: 在页面「设置」中填写');
});
