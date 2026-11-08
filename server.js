'use strict';

// Dakshina shared-key server. The Gemini credential stays in the server environment,
// never in index.html or any response sent to a visitor.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const HOST = '0.0.0.0';
const API_KEY = process.env.GEMINI_API_KEY || '';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PRIMARY_MODEL = 'gemini-3.5-flash-lite';
const FALLBACK_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash'];
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const MAX_BODY_BYTES = 256 * 1024;
const MAX_HISTORY_MESSAGES = 36;
const MAX_MESSAGE_CHARS = 12000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 30;
const rateBuckets = new Map();

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[match[1]] = value;
  }
}
loadDotEnv();
const GEMINI_KEY = process.env.GEMINI_API_KEY || API_KEY;

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  res.end(body);
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim().slice(0, 100);
  }
  return req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  // Opportunistically discard old buckets to keep memory bounded.
  if (rateBuckets.size > 5000) {
    for (const [key, value] of rateBuckets) {
      if (now - value.startedAt >= RATE_WINDOW_MS) rateBuckets.delete(key);
    }
  }
  return bucket.count <= RATE_LIMIT;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function validateChatBody(body) {
  if (!body || !Array.isArray(body.contents) || body.contents.length < 1 || body.contents.length > MAX_HISTORY_MESSAGES) {
    throw Object.assign(new Error('Chat history is missing or too long. Start a new chat and try again.'), { status: 400 });
  }
  let totalChars = 0;
  const contents = body.contents.map(item => {
    if (!item || !['user', 'model'].includes(item.role) || !Array.isArray(item.parts) || item.parts.length < 1) {
      throw Object.assign(new Error('The chat history contains an invalid message.'), { status: 400 });
    }
    const textParts = item.parts.filter(part => part && typeof part.text === 'string').map(part => {
      if (part.text.length > MAX_MESSAGE_CHARS) throw Object.assign(new Error('A message is too long. Please shorten it.'), { status: 413 });
      totalChars += part.text.length;
      return { text: part.text };
    });
    if (!textParts.length) throw Object.assign(new Error('A message is empty or unsupported.'), { status: 400 });
    return { role: item.role, parts: textParts };
  });
  if (totalChars > 60000) throw Object.assign(new Error('This conversation is too long. Start a new chat and try again.'), { status: 413 });

  const systemParts = body.systemInstruction && Array.isArray(body.systemInstruction.parts)
    ? body.systemInstruction.parts.filter(part => part && typeof part.text === 'string').slice(0, 1).map(part => ({ text: part.text.slice(0, 7000) }))
    : [];
  const generationConfig = body.generationConfig && typeof body.generationConfig === 'object' ? body.generationConfig : {};
  return {
    systemInstruction: systemParts.length ? { parts: systemParts } : undefined,
    contents,
    generationConfig: {
      maxOutputTokens: Math.min(Math.max(Number(generationConfig.maxOutputTokens) || 420, 64), 700),
      temperature: Math.min(Math.max(Number(generationConfig.temperature) || 0.9, 0), 1.2)
    }
  };
}

async function callGemini(model, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8500);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleChat(req, res) {
  if (!GEMINI_KEY) return sendJson(res, 503, { message: 'Dakshina’s shared server is not configured yet. The owner must add GEMINI_API_KEY to the server environment.' });

  const ip = clientIp(req);
  if (!checkRateLimit(ip)) {
    return sendJson(res, 429, { message: 'Too many messages from this connection. Please wait a few minutes and try again.' }, { 'Retry-After': '600' });
  }

  let payload;
  try { payload = validateChatBody(await readJson(req)); }
  catch (error) { return sendJson(res, error.status || 400, { message: error.message || 'Invalid request.' }); }

  const models = [PRIMARY_MODEL, ...FALLBACK_MODELS];
  let lastIssue = '';
  for (let index = 0; index < models.length; index++) {
    const model = models[index];
    try {
      const result = await callGemini(model, payload);
      if (result.response.ok) {
        return sendJson(res, 200, { data: result.data, model, attemptsMade: index + 1 });
      }
      const message = result.data && result.data.error && result.data.error.message;
      if (RETRYABLE_STATUSES.has(result.response.status)) {
        lastIssue = `HTTP ${result.response.status}${message ? ': ' + message : ''}`;
        continue;
      }
      if (result.response.status === 404 && index < models.length - 1) {
        lastIssue = `Model ${model} unavailable for this project.`;
        continue;
      }
      const friendly = result.response.status === 401 || result.response.status === 403
        ? 'The server’s Gemini key is not authorized. The owner should check the key and its Gemini API access.'
        : result.response.status === 429
          ? 'The shared Gemini quota or rate limit has been reached. Please try again later.'
          : `Gemini rejected the request (${result.response.status}).`;
      return sendJson(res, result.response.status, { message: friendly });
    } catch (error) {
      lastIssue = error && error.name === 'AbortError' ? `Timed out on ${model}.` : 'Could not reach the Gemini API.';
      if (index === models.length - 1) break;
    }
  }
  return sendJson(res, 503, { message: 'Gemini is busy right now 😭 I tried Dakshina’s main and backup models. Please try again in a little while. ' + lastIssue });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { return sendJson(res, 400, { message: 'Invalid URL.' }); }
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.resolve(ROOT, '.' + pathname);
  if (!filePath.startsWith(ROOT + path.sep)) return sendJson(res, 403, { message: 'Forbidden.' });
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) return sendJson(res, 404, { message: 'Not found.' });
    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cache-Control': path.basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=3600'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') {
    return sendJson(res, 200, { ready: Boolean(GEMINI_KEY), sharedKeyMode: true });
  }
  if (req.method === 'POST' && req.url === '/api/chat') return void handleChat(req, res);
  if (req.url.startsWith('/api/')) return sendJson(res, 404, { message: 'API endpoint not found.' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { message: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
  return serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Dakshina AI is listening on http://${HOST}:${PORT}`);
  console.log(`Gemini shared key: ${GEMINI_KEY ? 'configured (value hidden)' : 'NOT configured'}`);
});
