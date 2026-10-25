const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const net = require('node:net');
const { AsyncLocalStorage } = require('node:async_hooks');

const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const required = [
  'DB_API_KEY',
  'DB_DEVICE_SECURITY_KEY',
  'DB_APP_NAME',
  'INITIAL_ADMIN_EMAIL',
  'INITIAL_ADMIN_PASSWORD',
];
const DB_QUERY_URL = 'https://db.mhservice.co.in/API/1/Support_Tracker/query';
const SESSION_COOKIE = 'support_tracker_session';
const DEVICE_COOKIE = 'support_tracker_device';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const DEVICE_TTL_SECONDS = 365 * 24 * 60 * 60;
let stateTableReady;
const requestContext = new AsyncLocalStorage();

function configError() {
  const missing = required.filter((name) => !process.env[name]);
  if (process.env.INITIAL_ADMIN_PASSWORD && process.env.INITIAL_ADMIN_PASSWORD.length < 12) {
    missing.push('INITIAL_ADMIN_PASSWORD (must be at least 12 characters)');
  }
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
  return cookieValue(req, SESSION_COOKIE);
}

function cookieValue(req, name) {
  const cookieHeader = req.headers.cookie || '';
  const cookie = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!cookie) return null;
  try { return decodeURIComponent(cookie.slice(name.length + 1)); } catch { return null; }
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function setSessionCookie(req, res, token, maxAge) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = forwardedProto === 'https' || Boolean(req.socket.encrypted);
  appendSetCookie(res, `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

function appendSetCookie(res, value) {
  const current = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', current ? [...(Array.isArray(current) ? current : [current]), value] : value);
}

function clientDeviceType(req) {
  const reported = String(req.headers['x-client-device-type'] || '').toLowerCase();
  if (['desktop', 'mobile', 'tablet', 'other'].includes(reported)) return reported;
  const agent = String(req.headers['user-agent'] || '');
  if (/ipad|tablet/i.test(agent)) return 'tablet';
  if (/mobile|iphone|android/i.test(agent)) return 'mobile';
  return agent ? 'desktop' : 'other';
}

function requestOrigin(req, deviceId) {
  const peerIp = req.socket.remoteAddress || '';
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').slice(0, 500);
  const useForwardedIp = String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';
  const forwardedCandidate = forwardedFor.split(',')[0].trim();
  const clientIp = useForwardedIp && net.isIP(forwardedCandidate) ? forwardedCandidate : peerIp;
  return {
    eventId: crypto.randomUUID(),
    method: String(req.method || '').slice(0, 16),
    path: new URL(req.url, 'http://localhost').pathname.slice(0, 500),
    clientIp: clientIp.slice(0, 100),
    peerIp: peerIp.slice(0, 100),
    forwardedFor,
    deviceId,
    deviceType: clientDeviceType(req),
    platform: String(req.headers['x-client-platform'] || '').slice(0, 200),
    timezone: String(req.headers['x-client-timezone'] || '').slice(0, 100),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 1000),
    sessionHash: sessionToken(req) ? hashSessionToken(sessionToken(req)) : null,
  };
}

function databaseDeviceMetadata(req) {
  const peerIp = req.socket.remoteAddress || '';
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').slice(0, 500);
  const forwardedCandidate = forwardedFor.split(',')[0].trim();
  const clientIp = String(process.env.TRUST_PROXY || '').toLowerCase() === 'true' && net.isIP(forwardedCandidate)
    ? forwardedCandidate
    : peerIp;
  const platform = String(req.headers['x-client-platform'] || '').trim().slice(0, 200);
  const timezone = String(req.headers['x-client-timezone'] || '').trim().slice(0, 100);
  return {
    clientIp: clientIp.replace(/^::ffff:/, '').slice(0, 100) || 'unknown',
    deviceName: platform ? `${platform} device` : 'Unknown device',
    location: timezone || 'unknown',
    deviceType: clientDeviceType(req),
  };
}

async function recordRequestAudit(origin, statusCode) {
  await databaseQuery(
    'INSERT INTO support_tracker_request_audit (event_id, method, path, status_code, client_ip, peer_ip, forwarded_for, device_id, device_type, platform, timezone, user_agent, session_hash, actor_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, (SELECT user_id FROM support_tracker_sessions WHERE token_hash = $13 AND expires_at > NOW()))',
    [origin.eventId, origin.method, origin.path, statusCode, origin.clientIp, origin.peerIp, origin.forwardedFor, origin.deviceId, origin.deviceType, origin.platform, origin.timezone, origin.userAgent, origin.sessionHash],
  );
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, projectIds: Array.isArray(user.projectIds) ? user.projectIds : [] };
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

  const device = requestContext.getStore() || { clientIp: 'unknown', deviceName: 'Unknown device', location: 'unknown', deviceType: 'other' };
  const upstream = await fetch(DB_QUERY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Key: process.env.DB_API_KEY,
      IP: device.clientIp,
      DeviceName: device.deviceName,
      Location: device.location,
      DeviceType: device.deviceType,
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

// Initialization-free, idempotent upserts used by both migration and normal state saves.
async function writeRelationalState(state) {
  for (const project of (Array.isArray(state.projects) ? state.projects : [])) {
    await databaseQuery('INSERT INTO support_tracker_projects (project_id, name, project_type, start_date, end_date) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (project_id) DO UPDATE SET name = EXCLUDED.name, project_type = EXCLUDED.project_type, start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date', [project.id, project.name, project.type, project.startDate, project.endDate]);
  }
  for (const user of (Array.isArray(state.users) ? state.users : [])) {
    await databaseQuery('INSERT INTO support_tracker_users (user_id, name, email, role, password_hash) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash', [user.id, user.name, user.email, user.role, user.passwordHash]);
    for (const projectId of (user.projectIds || [])) await databaseQuery('INSERT INTO support_tracker_user_projects (user_id, project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, projectId]);
  }
  for (const record of (Array.isArray(state.records) ? state.records : [])) {
    await databaseQuery('INSERT INTO support_tracker_records (record_id, tracker_no, department, subject, request_type, developer, status, owner, expected_prod_date, prod_deploy_date, business_approval_date, release_pr, created_date, updated_at, sfdc_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) ON CONFLICT (record_id) DO UPDATE SET tracker_no = EXCLUDED.tracker_no, department = EXCLUDED.department, subject = EXCLUDED.subject, request_type = EXCLUDED.request_type, developer = EXCLUDED.developer, status = EXCLUDED.status, owner = EXCLUDED.owner, expected_prod_date = EXCLUDED.expected_prod_date, prod_deploy_date = EXCLUDED.prod_deploy_date, business_approval_date = EXCLUDED.business_approval_date, release_pr = EXCLUDED.release_pr, created_date = EXCLUDED.created_date, updated_at = EXCLUDED.updated_at, sfdc_status = EXCLUDED.sfdc_status', [record.id, record.trackerNo, record.department, record.subject, record.requestType, record.developer, record.status, record.owner || null, record.expectedProdDate || null, record.prodDeployDate || null, record.businessApprovalDate || null, record.releasePR || null, record.createdDate || null, record.updatedAt || null, record.sfdcStatus || null]);
  }
}

async function ensureStateTable() {
  if (!stateTableReady) {
    stateTableReady = (async () => {
      await databaseQuery(
        'CREATE TABLE IF NOT EXISTS support_tracker_app_state (state_id INTEGER PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
        [],
      );
      await databaseQuery('CREATE TABLE IF NOT EXISTS support_tracker_users (user_id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL, password_hash TEXT NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE)', []);
      await databaseQuery('CREATE TABLE IF NOT EXISTS support_tracker_projects (project_id TEXT PRIMARY KEY, name TEXT NOT NULL, project_type TEXT NOT NULL, start_date DATE NOT NULL, end_date DATE NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE, CHECK (end_date >= start_date))', []);
      await databaseQuery('CREATE TABLE IF NOT EXISTS support_tracker_user_projects (user_id TEXT NOT NULL REFERENCES support_tracker_users(user_id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES support_tracker_projects(project_id) ON DELETE CASCADE, PRIMARY KEY (user_id, project_id))', []);
      await databaseQuery('CREATE TABLE IF NOT EXISTS support_tracker_records (record_id TEXT PRIMARY KEY, tracker_no TEXT NOT NULL UNIQUE, department TEXT NOT NULL, subject TEXT NOT NULL, request_type TEXT NOT NULL, developer TEXT NOT NULL, status TEXT NOT NULL, owner TEXT, expected_prod_date DATE, prod_deploy_date DATE, business_approval_date DATE, release_pr TEXT, created_date DATE, updated_at DATE, sfdc_status TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE)', []);
      await databaseQuery('CREATE TABLE IF NOT EXISTS support_tracker_app_metadata (metadata_key TEXT PRIMARY KEY, metadata_value TEXT NOT NULL)', []);
      await databaseQuery('ALTER TABLE support_tracker_users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE', []);
      await databaseQuery('ALTER TABLE support_tracker_projects ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE', []);
      await databaseQuery('ALTER TABLE support_tracker_records ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE', []);
      await databaseQuery(
        'CREATE TABLE IF NOT EXISTS support_tracker_sessions (token_hash CHAR(64) PRIMARY KEY, user_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
        [],
      );
      await databaseQuery(
        'CREATE TABLE IF NOT EXISTS support_tracker_request_audit (event_id UUID PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), method TEXT NOT NULL, path TEXT NOT NULL, status_code INTEGER NOT NULL, client_ip TEXT NOT NULL, peer_ip TEXT NOT NULL, forwarded_for TEXT NOT NULL, device_id TEXT NOT NULL, device_type TEXT NOT NULL, platform TEXT NOT NULL, timezone TEXT NOT NULL, user_agent TEXT NOT NULL, session_hash CHAR(64), actor_user_id TEXT)',
        [],
      );

      const initialAdmin = {
        id: `usr-admin-${crypto.randomUUID()}`,
        name: 'Administrator',
        email: process.env.INITIAL_ADMIN_EMAIL.trim().toLowerCase(),
        passwordHash: await hashPassword(process.env.INITIAL_ADMIN_PASSWORD),
        role: 'admin',
        projectIds: [],
      };
      const existingResult = await databaseQuery(
        'SELECT payload FROM support_tracker_app_state WHERE state_id = $1',
        [1],
      );
      const existingRow = resultRows(existingResult)[0];
      let legacyState = existingRow?.payload ?? existingRow?.PAYLOAD ?? null;
      if (typeof legacyState === 'string') legacyState = JSON.parse(legacyState);
      const migrationRow = resultRows(await databaseQuery('SELECT metadata_value FROM support_tracker_app_metadata WHERE metadata_key = $1', ['legacy_state_migrated']))[0];
      if (legacyState && !migrationRow) {
        legacyState.users = Array.isArray(legacyState.users) ? legacyState.users.map((user) => ({ ...user, projectIds: Array.isArray(user.projectIds) ? user.projectIds : [] })) : [];
        legacyState.projects = Array.isArray(legacyState.projects) ? legacyState.projects : [];
        legacyState.records = Array.isArray(legacyState.records) ? legacyState.records.map((record) => ({ ...record, id: record.id || `rec-${crypto.randomUUID()}` })) : [];
        await writeRelationalState(legacyState);
        await databaseQuery('INSERT INTO support_tracker_app_metadata (metadata_key, metadata_value) VALUES ($1, $2) ON CONFLICT (metadata_key) DO UPDATE SET metadata_value = EXCLUDED.metadata_value', ['needs_migration', String(Boolean(legacyState.needsMigration))]);
      }
      const configuredAdmin = resultRows(await databaseQuery('SELECT user_id FROM support_tracker_users WHERE LOWER(email) = $1', [initialAdmin.email]))[0];
      if (!configuredAdmin) {
        await databaseQuery('INSERT INTO support_tracker_users (user_id, name, email, role, password_hash) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (email) DO NOTHING', [initialAdmin.id, initialAdmin.name, initialAdmin.email, initialAdmin.role, initialAdmin.passwordHash]);
        await databaseQuery('INSERT INTO support_tracker_app_metadata (metadata_key, metadata_value) VALUES ($1, $2) ON CONFLICT (metadata_key) DO NOTHING', ['needs_migration', 'true']);
      }
      await databaseQuery('INSERT INTO support_tracker_app_metadata (metadata_key, metadata_value) VALUES ($1, $2) ON CONFLICT (metadata_key) DO NOTHING', ['legacy_state_migrated', 'true']);
    })().catch((error) => {
      stateTableReady = null;
      throw error;
    });
  }
  await stateTableReady;
}

async function readAppState() {
  await ensureStateTable();
  const [usersResult, projectsResult, assignmentResult, recordsResult, migrationResult] = await Promise.all([
    databaseQuery('SELECT user_id, name, email, role, password_hash FROM support_tracker_users WHERE is_active = TRUE ORDER BY name', []),
    databaseQuery('SELECT project_id, name, project_type, start_date, end_date FROM support_tracker_projects WHERE is_active = TRUE ORDER BY name', []),
    databaseQuery('SELECT up.user_id, up.project_id FROM support_tracker_user_projects up JOIN support_tracker_users u ON u.user_id = up.user_id AND u.is_active = TRUE JOIN support_tracker_projects p ON p.project_id = up.project_id AND p.is_active = TRUE', []),
    databaseQuery('SELECT record_id, tracker_no, department, subject, request_type, developer, status, owner, expected_prod_date, prod_deploy_date, business_approval_date, release_pr, created_date, updated_at, sfdc_status FROM support_tracker_records WHERE is_active = TRUE ORDER BY created_date DESC NULLS LAST', []),
    databaseQuery('SELECT metadata_value FROM support_tracker_app_metadata WHERE metadata_key = $1', ['needs_migration']),
  ]);
  const value = (row, key) => row[key] ?? row[key.toUpperCase()];
  const date = (raw) => raw ? String(raw).slice(0, 10) : '';
  const assignments = new Map();
  for (const row of resultRows(assignmentResult)) {
    const userId = value(row, 'user_id');
    if (!assignments.has(userId)) assignments.set(userId, []);
    assignments.get(userId).push(value(row, 'project_id'));
  }
  const users = resultRows(usersResult).map((row) => ({ id: value(row, 'user_id'), name: value(row, 'name'), email: value(row, 'email'), role: value(row, 'role'), passwordHash: value(row, 'password_hash'), projectIds: assignments.get(value(row, 'user_id')) || [] }));
  const projects = resultRows(projectsResult).map((row) => ({ id: value(row, 'project_id'), name: value(row, 'name'), type: value(row, 'project_type'), startDate: date(value(row, 'start_date')), endDate: date(value(row, 'end_date')) }));
  const records = resultRows(recordsResult).map((row) => ({
    id: value(row, 'record_id'), trackerNo: value(row, 'tracker_no'), department: value(row, 'department'), subject: value(row, 'subject'),
    requestType: value(row, 'request_type'), developer: value(row, 'developer'), status: value(row, 'status'), owner: value(row, 'owner') || '',
    expectedProdDate: date(value(row, 'expected_prod_date')), prodDeployDate: date(value(row, 'prod_deploy_date')),
    businessApprovalDate: date(value(row, 'business_approval_date')), releasePR: value(row, 'release_pr') || '',
    createdDate: date(value(row, 'created_date')), updatedAt: date(value(row, 'updated_at')), sfdcStatus: value(row, 'sfdc_status') || '',
  }));
  const migration = resultRows(migrationResult)[0];
  return { users, records, projects, needsMigration: String(value(migration || {}, 'metadata_value')) === 'true' };
}

async function writeAppState(state) {
  await ensureStateTable();
  await writeRelationalState(state);
  await databaseQuery('INSERT INTO support_tracker_app_metadata (metadata_key, metadata_value) VALUES ($1, $2) ON CONFLICT (metadata_key) DO UPDATE SET metadata_value = EXCLUDED.metadata_value', ['needs_migration', String(Boolean(state.needsMigration))]);
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
    const projectIds = normalizeProjectIds(candidate.projectIds === undefined && existing ? existing.projectIds : candidate.projectIds, currentState.projects || []);
    normalized.push({ id, name, email, role, projectIds, passwordHash });
  }

  return normalized;
}

function normalizeProjectIds(value, projects) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw Object.assign(new Error('Project assignments must be a list'), { statusCode: 400 });
  const available = new Set(projects.map((project) => project.id));
  const ids = [...new Set(value.map((id) => String(id)))];
  if (ids.some((id) => !available.has(id))) throw Object.assign(new Error('One or more assigned projects do not exist'), { statusCode: 400 });
  return ids;
}

function normalizeProjects(value) {
  if (!Array.isArray(value)) throw Object.assign(new Error('Projects must be a list'), { statusCode: 400 });
  const seenNames = new Set();
  const projects = value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') throw Object.assign(new Error('Invalid project'), { statusCode: 400 });
    const id = String(candidate.id || '').trim();
    const name = String(candidate.name || '').trim();
    const type = String(candidate.type || '').trim();
    const startDate = String(candidate.startDate || '').trim();
    const endDate = String(candidate.endDate || '').trim();
    const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (!id || !name || name.length > 120 || !type || type.length > 80 || !validDate(startDate) || !validDate(endDate)) {
      throw Object.assign(new Error('Projects require a name, type, start date, and end date'), { statusCode: 400 });
    }
    const nameKey = name.toLocaleLowerCase();
    if (seenNames.has(nameKey)) throw Object.assign(new Error('Project names must be unique'), { statusCode: 400 });
    if (startDate > endDate) throw Object.assign(new Error('Project end date must be on or after the start date'), { statusCode: 400 });
    seenNames.add(nameKey);
    return { id, name, type, startDate, endDate };
  });
  return projects;
}

const server = http.createServer((req, res) => requestContext.run(databaseDeviceMetadata(req), async () => {
  const requestPath = new URL(req.url, 'http://localhost').pathname;
  const isAppApiRequest = requestPath.startsWith('/api/') && requestPath !== '/api/health';
  let deviceId = cookieValue(req, DEVICE_COOKIE);
  if (isAppApiRequest) {
    if (!deviceId || !/^[a-f0-9-]{36}$/i.test(deviceId)) {
      deviceId = crypto.randomUUID();
      const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
      const secure = forwardedProto === 'https' || Boolean(req.socket.encrypted);
      appendSetCookie(res, `${DEVICE_COOKIE}=${deviceId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DEVICE_TTL_SECONDS}${secure ? '; Secure' : ''}`);
    }
    const origin = requestOrigin(req, deviceId);
    res.once('finish', () => {
      recordRequestAudit(origin, res.statusCode).catch((error) => {
        console.error(`Request audit write failed for ${origin.eventId}: ${error.message}`);
      });
    });
  }

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
      const projectIds = normalizeProjectIds(body.projectIds, state.projects || []);
      const savedUser = { id: `usr-${crypto.randomUUID()}`, name, email, role, projectIds, passwordHash: await hashPassword(password) };
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
      const projectIds = normalizeProjectIds(body.projectIds, state.projects || []);
      for (const oldProjectId of (target.projectIds || [])) {
        if (!projectIds.includes(oldProjectId)) await databaseQuery('DELETE FROM support_tracker_user_projects WHERE user_id = $1 AND project_id = $2', [target.id, oldProjectId]);
      }
      target.name = name;
      target.email = email;
      target.role = role;
      target.projectIds = projectIds;
      if (password) target.passwordHash = await hashPassword(password);
      await writeAppState(state);
      return sendJson(res, 200, { success: true, user: publicUser(target) });
    } catch (error) {
      return sendJson(res, error.statusCode || 502, { success: false, error: error.message || 'Could not update password' });
    }
  }

  if (req.url === '/api/users' && req.method === 'DELETE') {
    try {
      const user = await authenticatedUser(req);
      if (!user) return sendJson(res, 401, { success: false, error: 'Sign in required' });
      if (user.role !== 'admin') return sendJson(res, 403, { success: false, error: 'Administrator access required' });
      const body = await readJsonBody(req, 16 * 1024);
      if (!body.id || body.id === user.id) return sendJson(res, 400, { success: false, error: 'A different user ID is required' });
      await databaseQuery('UPDATE support_tracker_users SET is_active = FALSE WHERE user_id = $1', [body.id]);
      return sendJson(res, 200, { success: true });
    } catch (error) {
      return sendJson(res, error.statusCode || 502, { success: false, error: error.message || 'Could not remove user' });
    }
  }

  if (req.url === '/api/projects' && req.method === 'DELETE') {
    try {
      const user = await authenticatedUser(req);
      if (!user) return sendJson(res, 401, { success: false, error: 'Sign in required' });
      if (user.role !== 'admin') return sendJson(res, 403, { success: false, error: 'Administrator access required' });
      const body = await readJsonBody(req, 16 * 1024);
      if (!body.id) return sendJson(res, 400, { success: false, error: 'Project ID is required' });
      await databaseQuery('UPDATE support_tracker_projects SET is_active = FALSE WHERE project_id = $1', [body.id]);
      return sendJson(res, 200, { success: true });
    } catch (error) {
      return sendJson(res, error.statusCode || 502, { success: false, error: error.message || 'Could not remove project' });
    }
  }

  if (req.url === '/api/records' && req.method === 'DELETE') {
    try {
      const user = await authenticatedUser(req);
      if (!user) return sendJson(res, 401, { success: false, error: 'Sign in required' });
      if (user.role !== 'admin') return sendJson(res, 403, { success: false, error: 'Administrator access required' });
      const body = await readJsonBody(req, 16 * 1024);
      if (!body.id) return sendJson(res, 400, { success: false, error: 'Record ID is required' });
      await databaseQuery('UPDATE support_tracker_records SET is_active = FALSE WHERE record_id = $1', [body.id]);
      return sendJson(res, 200, { success: true });
    } catch (error) {
      return sendJson(res, error.statusCode || 502, { success: false, error: error.message || 'Could not remove record' });
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
            projects: Array.isArray(state.projects) ? state.projects : [],
            needsMigration: user.role === 'admin' && Boolean(state.needsMigration),
          },
        });
      }

      const state = await readJsonBody(req);
      if (!state || !Array.isArray(state.records)) return sendJson(res, 400, { success: false, error: 'State must contain a records array' });
      if (user.role !== 'admin' && user.role !== 'developer') return sendJson(res, 403, { success: false, error: 'Your account cannot update tracker data' });

      const currentState = await readAppState();
      const projects = user.role === 'admin'
        ? normalizeProjects(state.projects === undefined ? currentState.projects || [] : state.projects)
        : currentState.projects || [];
      const users = user.role === 'admin'
        ? await normalizeAdminUsers(state.users, { ...currentState, projects })
        : currentState.users;
      if (user.role === 'admin' && !users.some((candidate) => candidate.id === user.id)) {
        return sendJson(res, 400, { success: false, error: 'An administrator cannot remove their own account' });
      }
      if (user.role === 'admin' && !users.some((candidate) => candidate.role === 'admin')) {
        return sendJson(res, 400, { success: false, error: 'At least one administrator account must remain' });
      }

      const nextState = { users, records: state.records, projects, needsMigration: false };
      await writeAppState(nextState);
      return sendJson(res, 200, { success: true, users: user.role === 'admin' ? users.map(publicUser) : [], records: nextState.records, projects: nextState.projects });
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
}));

server.listen(PORT, '0.0.0.0', () => console.log(`Support Tracker listening on ${PORT}`));
