const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const required = [
  'DB_API_KEY',
  'DB_DEVICE_SECURITY_KEY',
  'DB_DEVICE_NAME',
  'DB_LOCATION',
  'DB_DEVICE_TYPE',
  'DB_APP_NAME',
];

function configError() {
  return required.filter((name) => !process.env[name]);
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function clientIp(req) {
  // Only trust X-Forwarded-For when explicitly enabled and the container is
  // behind a proxy that overwrites that header.
  if (process.env.TRUST_PROXY === 'true') {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/query' && req.method === 'POST') {
    const missing = configError();
    if (missing.length) return sendJson(res, 503, { success: false, error: 'Database proxy is not configured', missing });

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) req.destroy();
    });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { success: false, error: 'Expected a JSON request body' }); }

      try {
        const upstream = await fetch('https://db.mhservice.co.in/API/1/Support_Tracker/query', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Key: process.env.DB_API_KEY,
            IP: clientIp(req),
            DeviceName: process.env.DB_DEVICE_NAME,
            Location: process.env.DB_LOCATION,
            DeviceType: process.env.DB_DEVICE_TYPE,
            AppName: process.env.DB_APP_NAME,
            'Device-Security-Key': process.env.DB_DEVICE_SECURITY_KEY,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        });
        const responseText = await upstream.text();
        res.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(responseText);
      } catch (error) {
        sendJson(res, 502, { success: false, error: 'Database service request failed' });
      }
    });
    return;
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
