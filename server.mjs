import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const site = fileURLToPath(new URL('./dist/', import.meta.url));
const mime = new Map(Object.entries({
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml',
  webp: 'image/webp', woff2: 'font/woff2', pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
}));
const services = new Map(Object.entries({
  support: 'Сопровождение ИП и ООО', launch: 'Открытие онлайн-бизнеса',
  declarations: 'Декларации', payroll: 'Кадровый учёт', import: 'ВЭД и импорт',
  crisis: 'Антикризисное сопровождение', register: 'Регистрация ИП',
  consult: 'Консультация', audit: 'Налоговые проверки', closure: 'Ликвидация бизнеса',
  management: 'Управленческий учёт',
}));
const MAX_BODY = 8192;
const RATE_WINDOW = 15 * 60 * 1000;
const RATE_LIMIT = 5;
const MAX_RATE_KEYS = 10000;

function json(res, code, body, headers = {}) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function receiveJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY) chunks.push(chunk);
  }
  if (size > MAX_BODY) return { error: 413 };
  try {
    return { data: JSON.parse(Buffer.concat(chunks).toString()) };
  } catch {
    return { error: 400 };
  }
}

function normalizeLead(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.consent !== true) return null;
  if (typeof data.name !== 'string' || typeof data.phone !== 'string') return null;
  if (typeof data.service !== 'string' || typeof data.comment !== 'string') return null;
  if (data.website !== undefined && data.website !== '') return null;
  const { service } = data;
  if (service && !services.has(service)) return null;
  const name = data.name.trim();
  const phone = data.phone.trim();
  const digits = phone.replace(/\D/g, '');
  const comment = data.comment.trim();
  if (!/^[^\u0000-\u001F\u007F]{2,80}$/u.test(name) || comment.length > 1000) return null;
  if (phone.length > 32 || !/^\+?[\d ()-]+$/.test(phone) || !/^(?:[78])?\d{10}$/.test(digits)) return null;
  return { name, phone: '+7' + digits.slice(-10), service: services.get(service) ?? '', comment };
}

function createRateLimiter() {
  const attempts = new Map();
  return (key, now) => {
    for (const [address, entry] of attempts) {
      if (entry.until > now) break;
      attempts.delete(address);
    }
    const entry = attempts.get(key);
    if (!entry) {
      if (attempts.size >= MAX_RATE_KEYS) return false;
      attempts.set(key, { count: 1, until: now + RATE_WINDOW });
      return true;
    }
    if (entry.count >= RATE_LIMIT) return false;
    entry.count += 1;
    return true;
  };
}

async function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) {
    res.writeHead(400).end();
    return;
  }

  if (decoded === '/documents') {
    res.writeHead(308, { Location: '/documents/' }).end();
    return;
  }
  const allowed = decoded === '/' || decoded === '/documents/' || /^\/assets\/[a-z\d.-]+$/i.test(decoded);
  if (!allowed) {
    res.writeHead(404, { 'Content-Type': mime.get('txt') }).end('Страница не найдена');
    return;
  }
  const path = resolve(join(site, decoded.endsWith('/') ? decoded + 'index.html' : decoded));
  if (!path.startsWith(resolve(site) + sep)) {
    res.writeHead(404).end();
    return;
  }

  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) {
    res.writeHead(404).end();
    return;
  }
  const ext = path.split('.').at(-1);
  res.writeHead(200, {
    'Content-Type': mime.get(ext) ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': ext === 'html' ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(path);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

export function createSiteServer({ deliver, publicOrigin, trustProxy = false, logger = console } = {}) {
  const takeAttempt = createRateLimiter();

  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    try {
      const path = new URL(req.url, 'http://local').pathname;
      if (path === '/api/leads') {
        if (req.method !== 'POST') return json(res, 405, { ok: false }, { Allow: 'POST' });
        if (!deliver) return json(res, 503, { ok: false });
        const origin = publicOrigin ?? 'http://' + req.headers.host;
        if (req.headers.origin !== origin) return json(res, 403, { ok: false });
        if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] ?? '')) {
          return json(res, 415, { ok: false });
        }
        const forwarded = req.headers['x-forwarded-for'];
        const address = (trustProxy && typeof forwarded === 'string' && forwarded.split(',')[0].trim()) || req.socket.remoteAddress;
        if (!takeAttempt(address, Date.now())) {
          return json(res, 429, { ok: false }, { 'Retry-After': String(RATE_WINDOW / 1000) });
        }
        if (Number(req.headers['content-length']) > MAX_BODY) return json(res, 413, { ok: false });
        const { data, error } = await receiveJson(req);
        if (error) return json(res, error, { ok: false });
        const lead = normalizeLead(data);
        if (!lead) return json(res, 400, { ok: false });
        try {
          await deliver(lead);
        } catch {
          logger.error('Lead delivery failed');
          return json(res, 503, { ok: false });
        }
        return json(res, 200, { ok: true });
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
      }
      if (path === '/assets/config.js') {
        res.writeHead(200, { 'Content-Type': mime.get('js'), 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? '' : 'export const mode = ' + JSON.stringify(deliver ? 'live' : 'preview') + ';');
        return;
      }
      await serveStatic(req, res, path);
    } catch {
      if (res.headersSent || res.destroyed) res.destroy();
      else json(res, 500, { ok: false });
    }
  });
  return server;
}

export function buildSmtpDelivery(env) {
  const required = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
  if (required.some(key => !env[key])) throw new Error('Set ' + required.join(', ') + ' to enable SMTP.');
  const port = Number(env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SMTP_PORT.');
  const secure = env.SMTP_SECURE === undefined ? port === 465 : env.SMTP_SECURE === 'true';
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure,
    requireTLS: !secure,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 6_000,
    greetingTimeout: 6_000,
    socketTimeout: 12_000,
  });
  return async ({ name, phone, service, comment }) => {
    const result = await transport.sendMail({
      from: env.SMTP_FROM,
      to: env.SMTP_TO || 'nalogi.pravo26@gmail.com',
      subject: 'Новая заявка с сайта «Налоги и право»',
      text: ['Имя: ' + name, 'Телефон: ' + phone, 'Услуга: ' + (service || 'не указана'),
        'Комментарий: ' + (comment || 'нет'), 'Согласие на обработку данных: получено'].join('\n'),
    });
    if (!result.accepted?.length) throw new Error('SMTP recipient was not accepted.');
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const isLive = env.LEADS_MODE === 'live';
  if (isLive && (!env.PUBLIC_ORIGIN || new URL(env.PUBLIC_ORIGIN).origin !== env.PUBLIC_ORIGIN)) {
    throw new Error('Set PUBLIC_ORIGIN to the exact public origin, without a trailing slash.');
  }
  const server = createSiteServer({
    deliver: isLive ? buildSmtpDelivery(env) : undefined,
    publicOrigin: env.PUBLIC_ORIGIN,
    trustProxy: env.TRUST_PROXY === 'true',
  });
  const host = env.HOST || '127.0.0.1';
  const port = Number(env.PORT || 4173);
  server.listen(port, host, () => console.log('Local: http://' + host + ':' + server.address().port));
}

