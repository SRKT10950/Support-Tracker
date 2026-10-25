const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const net = require('node:net');

const scrypt = promisify(crypto.scrypt);

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
  'INITIAL_ADMIN_EMAIL',
  'INITIAL_ADMIN_PASSWORD',
];
const DB_QUERY_URL = 'https://db.mhservice.co.in/API/1/Support_Tracker/query';
const SESSION_COOKIE = 'support_tracker_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
let stateTableReady;

function configError() {
  const missing = required.filter((name) => !process.env[name]);
  if (process.env.INITIAL_ADMIN_PASSWORD && process.env.INITIAL_ADMIN_PASSWORD.length < 12) {
    missing.push('INITIAL_ADMIN_PASSWORD (must be at least 12 characters)');
  }
  if (process.env.DB_CLIENT_IP && !net.isIP(process.env.DB_CLIENT_IP)) missing.push('DB_CLIENT_IP (must be the public egress IP address)');
  if (process.env.DB_LOCATION && /^set\s+db_location/i.test(process.env.DB_LOCATION.trim())) missing.push('DB_LOCATION (replace the placeholder with the deployment location)');
  if (process.env.INITIAL_ADMIN_EMAIL && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.INITIAL_ADMIN_EMAIL.trim())) missing.push('INITIAL_ADMIN_EMAIL (must be a valid email address)');
  return missing;
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  if (typeof storedHash !== 'string') return { valid: false };
  if (storedHash.startsWith('scrypt$')) {
    const [, salt, expectedHex] = storedHash.split('$');
    if (!salt || !/^[a-f0-9]{128}$/i.test(expectedHex || '')) return { valid: false };
    const actual = await scrypt(password, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return { valid: crypto.timingSafeEqual(actual, expected), legacy: false };
  }

  const legacyHash = storedHash.startsWith('legacy-sha256$')
    ? storedHash.slice('legacy-sha256$'.length)
    : storedHash;
  if (!/^[a-f0-9]{64}$/i.test(legacyHash)) return { valid: false };
  const actual = crypto.createHash('sha256').update(password).digest();
  const expected = Buffer.from(legacyHash, 'hex');
  return { valid: crypto.timingSafeEqual(actual, expected), legacy: true };
}

function sessionToken(req) {
  const cookieHeader = req.headers.cookie || '';
  const cookie = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) return null;
  try { return decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1)); } catch { return null; }
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function setSessionCookie(req, res, token, maxAge) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = forwardedProto === 'https' || Boolean(req.socket.encrypted);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
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
    stateTableReady = (async () => {
      await databaseQuery(
        'CREATE TABLE IF NOT EXISTS support_tracker_app_state (state_id INTEGER PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
        [],
      );
      await databaseQuery(
        'CREATE TABLE IF NOT EXISTS support_tracker_sessions (token_hash CHAR(64) PRIMARY KEY, user_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
        [],
      );

      const initialAdmin = {
        id: `usr-admin-${crypto.randomUUID()}`,
        name: 'Administrator',
        email: process.env.INITIAL_ADMIN_EMAIL.trim().toLowerCase(),
        passwordHash: await hashPassword(process.env.INITIAL_ADMIN_PASSWORD),
        role: 'admin',
      };
      const existingResult = await databaseQuery(
        'SELECT payload FROM support_tracker_app_state WHERE state_id = $1',
        [1],
      );
      const existingRow = resultRows(existingResult)[0];
      if (!existingRow) {
        await databaseQuery(
          'INSERT INTO support_tracker_app_state (state_id, payload) VALUES ($1, $2::jsonb) ON CONFLICT (state_id) DO NOTHING',
          [1, JSON.stringify({ users: [initialAdmin], records: [], needsMigration: true })],
        );
        return;
      }

      let currentState = existingRow.payload ?? existingRow.PAYLOAD;
      if (typeof currentState === 'string') currentState = JSON.parse(currentState);
      if (!currentState || typeof currentState !== 'object') currentState = { users: [], records: [] };
      if (!Array.isArray(currentState.users)) currentState.users = [];
      if (!Array.isArray(currentState.records)) currentState.records = [];
      let stateChanged = false;
      if (typeof currentState.needsMigration !== 'boolean') {
        currentState.needsMigration = currentState.users.length === 0 && currentState.records.length === 0;
        stateChanged = true;
      }
      const configuredAdminIndex = currentState.users.findIndex((user) => user.email?.toLowerCase() === initialAdmin.email);
      if (configuredAdminIndex === -1) {
        currentState.users.push(initialAdmin);
        stateChanged = true;
      } else if (!String(currentState.users[configuredAdminIndex].passwordHash || '').startsWith('scrypt$') || currentState.users[configuredAdminIndex].role !== 'admin') {
        currentState.users[configuredAdminIndex] = { ...currentState.users[configuredAdminIndex], passwordHash: initialAdmin.passwordHash, role: 'admin' };
        stateChanged = true;
      }
      if (stateChanged) {
        await databaseQuery(
          'UPDATE support_tracker_app_state SET payload = $1::jsonb, updated_at = NOW() WHERE state_id = $2',
          [JSON.stringify(currentState), 1],
        );
      }
    })().catch((error) => {
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

async function authenticatedUser(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const sessionResult = await databaseQuery(
    'SELECT user_id FROM support_tracker_sessions WHERE token_hash = $1 AND expires_at > NOW()',
    [hashSessionToken(token)],
  );
  const sessionRow = resultRows(sessionResult)[0];
  const userId = sessionRow?.user_id ?? sessionRow?.USER_ID;
  if (!userId) return null;
  const state = await readAppState();
  return state?.users?.find((user) => user.id === userId) || null;
}

async function createServerSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await databaseQuery(
    'INSERT INTO support_tracker_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + ($3 * INTERVAL \'1 second\'))',
    [hashSessionToken(token), userId, SESSION_TTL_SECONDS],
  );
  await databaseQuery('DELETE FROM support_tracker_sessions WHERE expires_at <= NOW()', []);
  return token;
}

async function revokeServerSession(req) {
  const token = sessionToken(req);
  if (!token) return;
  await databaseQuery('DELETE FROM support_tracker_sessions WHERE token_hash = $1', [hashSessionToken(token)]);
}

async function normalizeAdminUsers(incomingUsers, currentState) {
  if (!Array.isArray(incomingUsers)) throw Object.assign(new Error('State must contain a users array'), { statusCode: 400 });
  const normalized = [];
  const seenEmails = new Set();

  for (const candidate of incomingUsers) {
    if (!candidate || typeof candidate !== 'object') throw Object.assign(new Error('Invalid user record'), { statusCode: 400 });
    const id = String(candidate.id || '').trim();
    const name = String(candidate.name || '').trim();
    const email = String(candidate.email || '').trim().toLowerCase();
    const role = String(candidate.role || '');
    if (!id || !name || !email || !['admin', 'developer', 'viewer'].includes(role)) {
      throw Object.assign(new Error('User records require id, name, email, and a valid role'), { statusCode: 400 });
    }
    if (seenEmails.has(email)) throw Object.assign(new Error('Email addresses must be unique'), { statusCode: 400 });
    seenEmails.add(email);

    const existing = currentState.users.find((user) => user.id === id || user.email?.toLowerCase() === email);
    if (!existing && currentState.needsMigration) {
      const importedHash = String(candidate.passwordHash || '').replace(/^legacy-sha256\$/, '');
      const defaultHashes = ['admin123', 'dev123'].map((password) => crypto.createHash('sha256').update(password).digest('hex'));
      if (defaultHashes.includes(importedHash) || candidate.password === 'admin123' || candidate.password === 'dev123') continue;
    }
    let passwordHash = existing?.passwordHash;
    if (typeof candidate.password === 'string' && candidate.password.length) {
      if (candidate.password.length < 6) throw Object.assign(new Error('Passwords must be at least 6 characters'), { statusCode: 400 });
      passwordHash = await hashPassword(candidate.password);
    } else if (!passwordHash && currentState.needsMigration && typeof candidate.passwordHash === 'string') {
      const legacyHash = candidate.passwordHash.startsWith('legacy-sha256$')
        ? candidate.passwordHash.slice('legacy-sha256$'.length)
        : candidate.passwordHash;
      if (/^[a-f0-9]{64}$/i.test(legacyHash)) passwordHash = `legacy-sha256$${legacyHash}`;
      else if (typeof candidate.password === 'string' && candidate.password.length >= 6) passwordHash = await hashPassword(candidate.password);
    }
    if (!passwordHash) throw Object.assign(new Error(`A password is required for ${email}`), { statusCode: 400 });
    normalized.push({ id, name, email, role, passwordHash });
  }

  return normalized;
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

  if (req.url === '/api/login' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req, 16 * 1024);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!email || !password) return sendJson(res, 400, { success: false, error: 'Email and password are required' });
      const state = await readAppState();
      const user = state?.users?.find((candidate) => candidate.email?.toLowerCase() === email);
      const verification = user ? await verifyPassword(password, user.passwordHash) : { valid: false };
      if (!user || !verification.valid) return sendJson(res, 401, { success: false, error: 'Invalid email or password' });
      if (verification.legacy) {
        user.passwordHash = await hashPassword(password);
        await writeAppState(state);
      }
      const token = await createServerSession(user.id);
      setSessionCookie(req, res, token, SESSION_TTL_SECONDS);
      return sendJson(res, 200, { success: true, user: publicUser(user) });
    } catch (error) {
      return sendJson(res, error.statusCode || 502, { success: false, error: error.message || 'Login failed' });
    }
  }

  if (req.url === '/api/session' && req.method === 'GET') {
    try {
      const user = await authenticatedUser(req);
      if (!user) return sendJson(res, 401, { success: false, error: 'Session expired' });
      return sendJson(res, 200, { success: true, user: publicUser(user) });
    } catch {
      return sendJson(res, 503, { success: false, error: 'Could not verify session' });
    }
  }

  if (req.url === '/api/logout' && req.method === 'POST') {
    try {
      await revokeServerSession(req);
      setSessionCookie(req, res, '', 0);
      return sendJson(res, 200, { success: true });
    } catch (error) {
      return sendJson(res, error.statusCode || 502, { success: false, error: 'Could not end session' });
    }
  }

  if (req.url === '/api/users' && req.method === 'POST') {
    try {
      const user = await authenticatedUser(req);
      if (!user) return sendJson(res, 401, { success: false, error: 'Sign in required' });
      if (user.role !== 'admin') return sendJson(res, 403, { success: false, error: 'Administrator access required' });
      const body = await readJsonBody(req, 16 * 1024);
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const role = String(body.role || '');
      const password = String(body.password || '');
      if (!name || !email || !['admin', 'developer', 'viewer'].includes(role) || password.length < 6) {
        return sendJson(res, 400, { success: false, error: 'Name, email, role, and a password of at least 6 characters are required' });
      }
      const state = await readAppState();
      if (state.users.some((candidate) => candidate.email.toLowerCase() === email)) {
        return sendJson(res, 409, { success: false, error: 'A user with this email already exists' });
      }
      const savedUser = { id: `usr-${crypto.randomUUID()}`, name, email, role, passwordHash: await hashPassword(password) };
      state.users.push(savedUser);
      await writeAppState(state);
      return sendJson(res, 201, { success: true, user: publicUser(savedUser) });
    } catch (error) {
      return sendJson(res, error.statusCode || 502, { success: false, error: error.message || 'Could not create user' });
    }
  }

  if (req.url === '/api/users' && req.method === 'PUT') {
    try {
      const user = await authenticatedUser(req);
      if (!user) return sendJson(res, 401, { success: false, error: 'Sign in required' });
      if (user.role !== 'admin') return sendJson(res, 403, { success: false, error: 'Administrator access required' });
      const body = await readJsonBody(req, 16 * 1024);
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const role = String(body.role || '');
      const password = typeof body.password === 'string' ? body.password : '';
      if (!body.id || !name || !email || !['admin', 'developer', 'viewer'].includes(role)) {
        return sendJson(res, 400, { success: false, error: 'User ID, name, email, and a valid role are required' });
      }
      if (password && password.length < 6) return sendJson(res, 400, { success: false, error: 'Passwords must be at least 6 characters' });
      const state = await readAppState();
      const target = state.users.find((candidate) => candidate.id === body.id);
      if (!target) return sendJson(res, 404, { success: false, error: 'User not found' });
      if (state.users.some((candidate) => candidate.id !== target.id && candidate.email.toLowerCase() === email)) {
        return sendJson(res, 409, { success: false, error: 'A user with this email already exists' });
      }
      target.name = name;
      target.email = email;
      target.role = role;
      if (password) target.passwordHash = await hashPassword(password);
      await writeAppState(state);
      return sendJson(res, 200, { success: true, user: publicUser(target) });
    } catch (error) {
      return sendJson(res, error.statusCode || 502, { success: false, error: error.message || 'Could not update password' });
    }
  }

  if (req.url === '/api/state' && (req.method === 'GET' || req.method === 'PUT')) {
    try {
      const user = await authenticatedUser(req);
      if (!user) return sendJson(res, 401, { success: false, error: 'Sign in required' });
      if (req.method === 'GET') {
        const state = await readAppState();
        return sendJson(res, 200, {
          success: true,
          state: {
            users: user.role === 'admin' ? state.users.map(publicUser) : [],
            records: state.records,
            needsMigration: user.role === 'admin' && Boolean(state.needsMigration),
          },
        });
      }

      const state = await readJsonBody(req);
      if (!state || !Array.isArray(state.records)) return sendJson(res, 400, { success: false, error: 'State must contain a records array' });
      if (user.role !== 'admin' && user.role !== 'developer') return sendJson(res, 403, { success: false, error: 'Your account cannot update tracker data' });

      const currentState = await readAppState();
      const users = user.role === 'admin'
        ? await normalizeAdminUsers(state.users, currentState)
        : currentState.users;
      if (user.role === 'admin' && !users.some((candidate) => candidate.id === user.id)) {
        return sendJson(res, 400, { success: false, error: 'An administrator cannot remove their own account' });
      }
      if (user.role === 'admin' && !users.some((candidate) => candidate.role === 'admin')) {
        return sendJson(res, 400, { success: false, error: 'At least one administrator account must remain' });
      }

      const nextState = { users, records: state.records, needsMigration: false };
      await writeAppState(nextState);
      return sendJson(res, 200, { success: true, users: user.role === 'admin' ? users.map(publicUser) : [], records: nextState.records });
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
