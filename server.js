const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const required = [
  'DB_API_KEY',
  'DB_DEVICE_SECURITY_KEY',
  'DB_CLIENT_IP',
  'DB_DEVICE_NAME',
  'DB_LOCATION',
  'DB_DEVICE_TYPE',
  'DB_APP_NAME',
];
const DB_QUERY_URL = 'https://db.mhservice.co.in/API/1/Support_Tracker/query';
let stateTableReady;

function configError() {
  return required.filter((name) => !process.env[name]);
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Expected a JSON request body'), { statusCode: 400 });
  }
}

async function databaseQuery(query, params) {
  const missing = configError();
  if (missing.length) throw Object.assign(new Error(`Database proxy is not configured: ${missing.join(', ')}`), { statusCode: 503 });

  const upstream = await fetch(DB_QUERY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Key: process.env.DB_API_KEY,
      IP: process.env.DB_CLIENT_IP,
      DeviceName: process.env.DB_DEVICE_NAME,
      Location: process.env.DB_LOCATION,
      DeviceType: process.env.DB_DEVICE_TYPE,
      AppName: process.env.DB_APP_NAME,
      'Device-Security-Key': process.env.DB_DEVICE_SECURITY_KEY,
    },
    body: JSON.stringify({ query, params }),
    signal: AbortSignal.timeout(15000),
  });

  const responseText = await upstream.text();
  let result;
  try { result = JSON.parse(responseText); } catch { throw new Error(`Database service returned invalid JSON (HTTP ${upstream.status})`); }
  if (!upstream.ok || result.success === false) {
    throw Object.assign(new Error(result.error || `Database service returned HTTP ${upstream.status}`), { statusCode: upstream.status >= 400 ? 502 : 400 });
  }
  return result;
}

function resultRows(result) {
  const candidates = [result?.rows, result?.data, result?.result, result?.results, result?.records];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === 'object') {
      for (const nested of [candidate.rows, candidate.data, candidate.result, candidate.records]) {
        if (Array.isArray(nested)) return nested;
      }
    }
  }
  return [];
}

async function ensureStateTable() {
  if (!stateTableReady) {
    stateTableReady = databaseQuery(
      'CREATE TABLE IF NOT EXISTS support_tracker_app_state (state_id INTEGER PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
      [],
    ).catch((error) => {
      stateTableReady = null;
      throw error;
    });
  }
  await stateTableReady;
}

async function readAppState() {
  await ensureStateTable();
  const result = await databaseQuery(
    'SELECT payload FROM support_tracker_app_state WHERE state_id = $1',
    [1],
  );
  const row = resultRows(result)[0];
  if (!row) return null;
  const payload = row.payload ?? row.PAYLOAD;
  if (typeof payload === 'string') return JSON.parse(payload);
  return payload || null;
}

async function writeAppState(state) {
  await ensureStateTable();
  await databaseQuery(
    'INSERT INTO support_tracker_app_state (state_id, payload, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (state_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()',
    [1, JSON.stringify(state)],
  );
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/health' && req.method === 'GET') {
    try {
      await readAppState();
      return sendJson(res, 200, { success: true, database: 'connected' });
    } catch (error) {
      return sendJson(res, 503, { success: false, database: 'disconnected' });
    }
  }

  if (req.url === '/api/state' && (req.method === 'GET' || req.method === 'PUT')) {
    try {
      if (req.method === 'GET') {
        const state = await readAppState();
        return sendJson(res, 200, { success: true, state });
      }

      const state = await readJsonBody(req);
      if (!state || !Array.isArray(state.users) || !Array.isArray(state.records)) {
        return sendJson(res, 400, { success: false, error: 'State must contain users and records arrays' });
      }
      await writeAppState({ users: state.users, records: state.records });
      return sendJson(res, 200, { success: true });
    } catch (error) {
      return sendJson(res, error.statusCode || 502, { success: false, error: error.message || 'Database request failed' });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const filePath = path.resolve(ROOT, requested);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== path.join(ROOT, 'index.html')) return sendJson(res, 403, { error: 'Forbidden' });
  fs.readFile(filePath, (error, data) => {
    if (error) return sendJson(res, 404, { error: 'Not found' });
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Support Tracker listening on ${PORT}`));
