// RapidAid 2.0 Server - Zero Dependencies Full-Stack Emergency Platform
// Native Node.js HTTP, SSE, Scrypt Auth, Atomic JSON DB, Media Uploads & AI Pipelines
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- Optional .env file parser (zero-dep) ----
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  try {
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[k]) process.env[k] = v;
      }
    }
  } catch (err) {
    console.warn('[ENV] Warning loading .env:', err.message);
  }
}

// ---- Configuration ----
const PORT = process.env.PORT || 3000;
const ESC = (+process.env.ESCALATE_SECONDS || 45) * 1000;
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DBF = path.join(DIR, 'db.json');
const PUB = path.join(__dirname, 'public') + path.sep;
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const AUDIO_DIR = path.join(UPLOADS_DIR, 'audio');
const PHOTOS_DIR = path.join(UPLOADS_DIR, 'photos');

// Ensure directories exist
fs.mkdirSync(DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

// AI Config
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const DEMO_MODE = process.env.DEMO_MODE === 'true' || (!OPENAI_API_KEY && !GEMINI_API_KEY);

// ---- Database & Persistence ----
let db = {
  users: [],
  facilities: [],
  alerts: [],
  secret: crypto.randomBytes(32).toString('hex')
};

try {
  if (fs.existsSync(DBF)) {
    db = JSON.parse(fs.readFileSync(DBF, 'utf8'));
  }
} catch (err) {
  console.warn('[DB] Initializing new database state');
}

// Atomic Serialized File Updates
let writeQueue = Promise.resolve();
let saveDebounceTimer = null;

const persistDbAtomic = () => {
  writeQueue = writeQueue.then(async () => {
    try {
      const tmpFile = path.join(DIR, `db.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`);
      fs.writeFileSync(tmpFile, JSON.stringify(db, null, 2), 'utf8');
      fs.renameSync(tmpFile, DBF);
    } catch (err) {
      console.error('[DB] Atomic write failed:', err);
    }
  });
  return writeQueue;
};

const save = () => {
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(persistDbAtomic, 100);
};

// ---- Helpers & Security ----
const id = () => crypto.randomBytes(8).toString('hex');
const E = (s, m) => Object.assign(new Error(m), { s });
const num = v => typeof v === 'number' && isFinite(v);
const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

const hash = (p, s = crypto.randomBytes(16).toString('hex')) =>
  s + ':' + crypto.scryptSync(String(p), s, 32).toString('hex');

const sign = u => {
  const b = Buffer.from(JSON.stringify({ id: u.id, exp: Date.now() + 7 * 864e5 })).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', db.secret).update(b).digest('base64url');
};

const verify = t => {
  try {
    const [b, s] = t.split('.');
    if (!eq(s, crypto.createHmac('sha256', db.secret).update(b).digest('base64url'))) return;
    const p = JSON.parse(Buffer.from(b, 'base64url'));
    if (p.exp > Date.now()) return db.users.find(u => u.id === p.id);
  } catch {}
};

// Haversine formula (km)
const dist = (a, b, c, d) => {
  const r = Math.PI / 180;
  const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
};

const fac = i => db.facilities.find(f => f.id === i);
const pub = u => ({
  id: u.id,
  name: u.name,
  phone: u.phone,
  role: u.role,
  contacts: u.contacts || [],
  medical: u.medical || '',
  facility: fac(u.facilityId)
});

const ACTIVE = ['sent', 'accepted', 'on_the_way', 'arrived'];

// ---- Real-time (Server-Sent Events) ----
const clients = new Set();
const push = (f, d) => {
  for (const c of clients) {
    if (f(c)) {
      try {
        c.res.write('data: ' + JSON.stringify(d) + '\n\n');
      } catch (err) {
        clients.delete(c);
      }
    }
  }
};

const ping = a => push(c => c.uid === a.userId || (c.fid && (c.fid === a.facilityId || (a.notified || []).includes(c.fid))), {
  t: 'update',
  id: a.id,
  status: a.status
});

// 25s keepalive ping
setInterval(() => {
  for (const c of clients) {
    try {
      c.res.write(': ping\n\n');
    } catch {
      clients.delete(c);
    }
  }
}, 25000);

// ---- Alert Business Logic ----
const near = (lat, lng, ex = []) =>
  db.facilities
    .filter(f => f.available && !ex.includes(f.id))
    .map(f => ({ f, d: dist(lat, lng, f.lat, f.lng) }))
    .filter(x => x.d <= 100)
    .sort((a, b) => a.d - b.d)
    .map(x => x.f);

const notify = (a, f) => {
  if (!a.notified.includes(f.id)) a.notified.push(f.id);
  a.lastNotify = Date.now();
  push(c => c.fid === f.id, { t: 'new_alert', id: a.id });
};

const view = (a, fid) => {
  const f = fac(a.facilityId);
  const o = {
    id: a.id,
    type: a.type,
    note: a.note || '',
    status: a.status,
    lat: a.lat,
    lng: a.lng,
    created: a.created,
    updatedAt: a.updatedAt || a.created,
    notifiedCount: (a.notified || []).length,
    facility: f && {
      id: f.id,
      name: f.name,
      type: f.type,
      phone: f.phone,
      lat: f.lat,
      lng: f.lng,
      address: f.address || '',
      verified: !!f.verified
    },
    hasAudio: !!a.audioFile,
    hasPhoto: !!a.photoFile,
    transcript: a.transcript || null,
    confirmedSummary: a.confirmedSummary || null,
    triageAssessment: a.triageAssessment || null,
    updates: a.updates || []
  };

  if (fid) {
    o.userName = a.userName;
    o.userPhone = a.userPhone;
    if (a.facilityId === fid) o.medical = a.medical;
  } else {
    o.contacts = a.contacts;
  }
  return o;
};

// Automatic escalation loop
setInterval(() => {
  for (const a of db.alerts) {
    if (a.status === 'sent' && Date.now() - a.lastNotify >= ESC) {
      const n = near(a.lat, a.lng, a.notified)[0];
      if (n) {
        notify(a, n);
      } else {
        a.status = 'unanswered';
      }
      if (!a.updates) a.updates = [];
      a.updates.push({ status: a.status, timestamp: Date.now(), note: 'Escalation timeout reached' });
      ping(a);
      save();
    }
  }
}, 1000);

// ---- Request Parsing (JSON & Multipart) ----
function parseMultipart(buffer, boundary) {
  const parts = [];
  const boundaryBuffer = Buffer.from('--' + boundary);
  let start = 0;

  while (start < buffer.length) {
    const idx = buffer.indexOf(boundaryBuffer, start);
    if (idx === -1) break;
    const nextIdx = buffer.indexOf(boundaryBuffer, idx + boundaryBuffer.length);
    if (nextIdx === -1) break;

    const partBuffer = buffer.slice(idx + boundaryBuffer.length + 2, nextIdx - 2);
    start = nextIdx;

    const headerEnd = partBuffer.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) continue;

    const headerStr = partBuffer.slice(0, headerEnd).toString('latin1');
    const body = partBuffer.slice(headerEnd + 4);

    const dispMatch = headerStr.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]+)")?/i);
    const typeMatch = headerStr.match(/content-type:\s*([^\r\n;]+)/i);

    if (dispMatch) {
      parts.push({
        name: dispMatch[1],
        filename: dispMatch[2] || null,
        contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
        data: body
      });
    }
  }
  return parts;
}

const parseBody = req => new Promise((ok, no) => {
  const chunks = [];
  let totalLength = 0;
  const maxBytes = 25 * 1024 * 1024; // 25 MB max

  req.on('data', chunk => {
    totalLength += chunk.length;
    if (totalLength > maxBytes) {
      req.destroy();
      no(E(413, 'Payload too large (max 25MB)'));
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const ct = (req.headers['content-type'] || '').toLowerCase();

    if (ct.includes('multipart/form-data')) {
      const match = req.headers['content-type'].match(/boundary=([^;]+)/i);
      if (!match) return no(E(400, 'Missing boundary in multipart form data'));
      const boundary = match[1].trim().replace(/^["']|["']$/g, '');
      const parts = parseMultipart(raw, boundary);
      const fields = {};
      const files = {};
      for (const p of parts) {
        if (p.filename) {
          files[p.name] = p;
        } else {
          fields[p.name] = p.data.toString('utf8');
        }
      }
      return ok({ json: fields, files, raw });
    }

    if (ct.includes('application/json')) {
      try {
        const text = raw.toString('utf8');
        return ok({ json: text ? JSON.parse(text) : {}, files: {}, raw });
      } catch (err) {
        return no(E(400, 'Bad JSON'));
      }
    }

    // Binary / other payload
    return ok({ json: {}, files: {}, raw, contentType: ct });
  });

  req.on('error', err => no(E(500, err.message)));
});

// ---- Route System ----
const routes = [];
const R = (m, p, f) => routes.push([m, new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), f]);

const A = c => c.u || (() => { throw E(401, 'Please log in'); })();
const role = (c, r) => {
  const u = A(c);
  if (u.role !== r) throw E(403, 'Not allowed');
  return u;
};
const myAlert = (c, i) => {
  const a = db.alerts.find(x => x.id === i);
  if (!a) throw E(404, 'Alert not found');
  return a;
};

// ---- Auth Routes ----
R('POST', '/api/register', c => {
  const { name, phone, password, facility } = c.b;
  const ph = String(phone || '').replace(/[\s-]/g, '');
  if (!name || String(name).trim().length === 0 || String(name).length > 60) throw E(400, 'Name required');
  if (!/^\+?\d{7,15}$/.test(ph)) throw E(400, 'Enter a valid phone number');
  if (String(password || '').length < 6) throw E(400, 'Password must be at least 6 characters');
  if (db.users.some(u => u.phone === ph)) throw E(409, 'Phone already registered');

  const u = {
    id: id(),
    name: String(name).trim(),
    phone: ph,
    pw: hash(password),
    role: c.b.role === 'responder' ? 'responder' : 'user',
    contacts: [],
    medical: ''
  };

  if (u.role === 'responder') {
    const f = facility || {};
    if (!f.name || !num(f.lat) || !num(f.lng) || Math.abs(f.lat) > 90 || Math.abs(f.lng) > 180) {
      throw E(400, 'Facility name and a valid location are required');
    }
    const x = {
      id: id(),
      name: String(f.name).slice(0, 80),
      type: ['hospital', 'clinic', 'ambulance'].includes(f.type) ? f.type : 'hospital',
      phone: String(f.phone || ph).slice(0, 20),
      address: String(f.address || 'Emergency Response Center').slice(0, 150),
      lat: f.lat,
      lng: f.lng,
      available: true,
      verified: true
    };
    db.facilities.push(x);
    u.facilityId = x.id;
  }

  db.users.push(u);
  save();
  return { token: sign(u), user: pub(u) };
});

R('POST', '/api/login', c => {
  const ph = String(c.b.phone || '').replace(/[\s-]/g, '');
  const u = db.users.find(x => x.phone === ph);
  if (!u || !eq(u.pw, hash(c.b.password, u.pw.split(':')[0]))) {
    throw E(401, 'Wrong phone or password');
  }
  return { token: sign(u), user: pub(u) };
});

R('GET', '/api/me', c => pub(A(c)));

R('PUT', '/api/me', c => {
  const u = role(c, 'user');
  u.contacts = (Array.isArray(c.b.contacts) ? c.b.contacts : [])
    .slice(0, 5)
    .map(x => ({ name: String(x.name || '').slice(0, 40), phone: String(x.phone || '').slice(0, 20) }))
    .filter(x => x.phone);
  u.medical = String(c.b.medical || '').slice(0, 500);
  save();
  return pub(u);
});

// Responder Availability
R('PATCH', '/api/facility', c => {
  const u = role(c, 'responder');
  const f = fac(u.facilityId);
  if (f) f.available = !!c.b.available;
  save();
  return pub(u);
});

// Facilities List & Nearby
R('GET', '/api/facilities', c => {
  return db.facilities.map(f => ({
    id: f.id,
    name: f.name,
    type: f.type,
    phone: f.phone,
    address: f.address || '',
    lat: f.lat,
    lng: f.lng,
    available: f.available,
    verified: !!f.verified
  }));
});

R('GET', '/api/facilities/nearby', c => {
  const lat = +c.q.lat;
  const lng = +c.q.lng;
  const r = +c.q.radius || 25;
  if (!num(lat) || !num(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw E(400, 'lat and lng required and must be valid coordinates');
  }
  return db.facilities
    .filter(f => !c.q.type || f.type === c.q.type)
    .map(f => ({
      ...f,
      distance: dist(lat, lng, f.lat, f.lng)
    }))
    .filter(f => f.distance <= r)
    .sort((a, b) => a.distance - b.distance);
});

// System Config Info
R('GET', '/api/config', () => ({
  demoMode: DEMO_MODE,
  hasOpenAI: !!OPENAI_API_KEY,
  hasGemini: !!GEMINI_API_KEY,
  emergencyFallbackNumber: '112',
  ambulanceNumber: '108'
}));

// ---- Emergency / Alert Endpoints ----
R('POST', '/api/alerts', c => {
  const u = role(c, 'user');
  const { lat, lng } = c.b;
  if (!num(lat) || !num(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw E(400, 'Valid location required');
  }

  // Prevent duplicate active alert
  const ex = db.alerts.find(a => a.userId === u.id && ACTIVE.includes(a.status));
  if (ex) return view(ex);

  // Rate limiting (max 3 alerts in 10 minutes)
  if (db.alerts.filter(a => a.userId === u.id && Date.now() - a.created < 6e5).length >= 3) {
    throw E(429, 'Too many alerts. Please call 112 directly.');
  }

  const a = {
    id: id(),
    userId: u.id,
    userName: u.name,
    userPhone: u.phone,
    contacts: u.contacts || [],
    medical: u.medical || '',
    type: String(c.b.type || 'Other').slice(0, 40),
    note: String(c.b.note || '').slice(0, 300),
    lat,
    lng,
    status: 'sent',
    notified: [],
    declined: [],
    facilityId: null,
    responderId: null,
    audioFile: null,
    audioType: null,
    photoFile: null,
    transcript: null,
    confirmedSummary: null,
    created: Date.now(),
    updatedAt: Date.now(),
    updates: [
      { status: 'sent', timestamp: Date.now(), updatedBy: u.name, note: 'Emergency SOS created' }
    ]
  };

  near(lat, lng, []).slice(0, 3).forEach(f => notify(a, f));
  if (!a.notified.length) a.status = 'unanswered';
  a.lastNotify = Date.now();
  db.alerts.push(a);
  save();

  console.log(`[SOS] ${u.name} (${u.phone}) ${a.type} at ${lat},${lng} -> ${a.notified.length} facilities`);
  return view(a);
});

R('GET', '/api/alerts/active', c => {
  const u = role(c, 'user');
  const a = db.alerts.filter(x => x.userId === u.id && (ACTIVE.includes(x.status) || x.status === 'unanswered') && Date.now() - x.created < 36e5).pop();
  return a ? view(a) : null;
});

R('GET', '/api/alerts/history', c => {
  const u = A(c);
  if (u.role === 'responder') {
    const f = u.facilityId;
    return db.alerts
      .filter(a => a.facilityId === f || (a.notified && a.notified.includes(f)))
      .sort((a, b) => b.created - a.created)
      .map(a => view(a, f));
  } else {
    return db.alerts
      .filter(a => a.userId === u.id)
      .sort((a, b) => b.created - a.created)
      .map(a => view(a));
  }
});

R('GET', '/api/alerts/:id', c => {
  const u = A(c);
  const a = myAlert(c, c.p.id);
  const f = u.role === 'responder' ? u.facilityId : null;
  if (u.role === 'user' && a.userId !== u.id) throw E(403, 'Forbidden');
  return view(a, f);
});

R('POST', '/api/alerts/:id/location', c => {
  const u = role(c, 'user');
  const a = myAlert(c, c.p.id);
  const { lat, lng } = c.b;
  if (a.userId !== u.id || !ACTIVE.includes(a.status)) throw E(409, 'Alert not active');
  if (!num(lat) || !num(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw E(400, 'Valid location required');
  }
  a.lat = lat;
  a.lng = lng;
  a.updatedAt = Date.now();
  ping(a);
  save();
  return { ok: true };
});

R('POST', '/api/alerts/:id/cancel', c => {
  const u = role(c, 'user');
  const a = myAlert(c, c.p.id);
  if (a.userId !== u.id || !(ACTIVE.includes(a.status) || a.status === 'unanswered')) {
    throw E(409, 'Cannot cancel');
  }
  a.status = 'cancelled';
  a.updatedAt = Date.now();
  if (!a.updates) a.updates = [];
  a.updates.push({ status: 'cancelled', timestamp: Date.now(), updatedBy: u.name, note: 'User cancelled alert' });
  ping(a);
  save();
  return view(a);
});

// Responder Alerts List
R('GET', '/api/responder/alerts', c => {
  const f = role(c, 'responder').facilityId;
  return db.alerts
    .filter(a => (a.status === 'sent' && (a.notified || []).includes(f) && !(a.declined || []).includes(f)) || (a.facilityId === f && ACTIVE.includes(a.status)))
    .sort((a, b) => b.created - a.created)
    .map(a => view(a, f));
});

// First-Accept-Wins Concurrency Protection
let acceptLock = Promise.resolve();
R('POST', '/api/alerts/:id/accept', async c => {
  const u = role(c, 'responder');
  const f = u.facilityId;

  return new Promise((resolve, reject) => {
    acceptLock = acceptLock.then(() => {
      try {
        const a = myAlert(c, c.p.id);
        if (a.status !== 'sent' || !a.notified.includes(f)) {
          throw E(409, 'Already taken by another facility or cancelled');
        }
        a.status = 'accepted';
        a.facilityId = f;
        a.responderId = u.id;
        a.updatedAt = Date.now();
        if (!a.updates) a.updates = [];
        a.updates.push({ status: 'accepted', timestamp: Date.now(), updatedBy: u.name, note: `Accepted by ${fac(f)?.name || 'facility'}` });
        ping(a);
        save();
        resolve(view(a, f));
      } catch (err) {
        reject(err);
      }
    });
  });
});

R('POST', '/api/alerts/:id/reject', c => {
  const f = role(c, 'responder').facilityId;
  const a = myAlert(c, c.p.id);
  if (a.status !== 'sent' || !a.notified.includes(f)) throw E(409, 'Cannot decline');
  if (!a.declined) a.declined = [];
  if (!a.declined.includes(f)) a.declined.push(f);

  if (a.notified.every(i => a.declined.includes(i))) {
    const n = near(a.lat, a.lng, a.notified)[0];
    if (n) {
      notify(a, n);
    } else {
      a.status = 'unanswered';
    }
  }
  a.updatedAt = Date.now();
  ping(a);
  save();
  return { ok: true };
});

// Forward-Only Status Transitions
R('POST', '/api/alerts/:id/status', c => {
  const u = role(c, 'responder');
  const f = u.facilityId;
  const a = myAlert(c, c.p.id);
  const s = c.b.status;
  const order = ['accepted', 'on_the_way', 'arrived', 'closed'];

  if (a.facilityId !== f || !ACTIVE.includes(a.status)) {
    throw E(409, 'Not your active alert');
  }
  if (!order.includes(s) || order.indexOf(s) <= order.indexOf(a.status)) {
    throw E(400, 'Invalid status change');
  }

  a.status = s;
  a.updatedAt = Date.now();
  if (!a.updates) a.updates = [];
  a.updates.push({ status: s, timestamp: Date.now(), updatedBy: u.name, note: `Status updated to ${s}` });
  ping(a);
  save();
  return view(a, f);
});

// Real-Time Server-Sent Events (SSE)
R('GET', '/api/stream', c => {
  const u = A(c);
  c.res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  c.res.write(': ok\n\n');

  const cl = { res: c.res, uid: u.id, fid: u.facilityId };
  clients.add(cl);
  c.req.on('close', () => clients.delete(cl));
});

// ---- File Uploads: Audio & Photo ----
const ALLOWED_AUDIO_TYPES = ['audio/webm', 'audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/ogg', 'audio/m4a', 'audio/mp4'];
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];

R('POST', '/api/alerts/:id/audio', async c => {
  const u = role(c, 'user');
  const a = myAlert(c, c.p.id);
  if (a.userId !== u.id) throw E(403, 'Not your emergency alert');

  let audioBuffer = null;
  let contentType = 'audio/webm';

  if (c.files && c.files.audio) {
    audioBuffer = c.files.audio.data;
    contentType = c.files.audio.contentType || contentType;
  } else if (c.raw && c.raw.length > 0) {
    audioBuffer = c.raw;
    contentType = c.req.headers['content-type'] || contentType;
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    throw E(400, 'No audio data provided');
  }

  // Validate MIME type
  const baseType = contentType.split(';')[0].trim().toLowerCase();
  if (!ALLOWED_AUDIO_TYPES.includes(baseType) && !baseType.startsWith('audio/')) {
    throw E(400, 'Invalid audio format. Allowed formats: webm, wav, mp3, ogg, m4a');
  }

  // Validate size (max 15MB)
  if (audioBuffer.length > 15 * 1024 * 1024) {
    throw E(413, 'Audio file exceeds 15MB limit');
  }

  const ext = baseType.includes('wav') ? '.wav' : baseType.includes('ogg') ? '.ogg' : baseType.includes('mp3') ? '.mp3' : '.webm';
  const fileName = `audio_${a.id}_${Date.now()}${ext}`;
  const filePath = path.join(AUDIO_DIR, fileName);

  fs.writeFileSync(filePath, audioBuffer);
  a.audioFile = fileName;
  a.audioType = baseType;
  a.updatedAt = Date.now();
  ping(a);
  save();

  return { ok: true, fileName, audioUrl: `/api/alerts/${a.id}/audio` };
});

R('GET', '/api/alerts/:id/audio', (c) => {
  const u = A(c);
  const a = myAlert(c, c.p.id);

  // Security: Only patient or notified/assigned responder can access
  const hasAccess = a.userId === u.id || (u.role === 'responder' && ((a.notified && a.notified.includes(u.facilityId)) || a.facilityId === u.facilityId));
  if (!hasAccess) throw E(403, 'Forbidden');

  if (!a.audioFile) throw E(404, 'No audio recording found for this emergency');
  const filePath = path.join(AUDIO_DIR, a.audioFile);
  if (!fs.existsSync(filePath)) throw E(404, 'Audio file not found on disk');

  const stat = fs.statSync(filePath);
  c.res.writeHead(200, {
    'Content-Type': a.audioType || 'audio/webm',
    'Content-Length': stat.size,
    'Cache-Control': 'private, no-cache'
  });
  fs.createReadStream(filePath).pipe(c.res);
});

R('POST', '/api/alerts/:id/photo', async c => {
  const u = role(c, 'user');
  const a = myAlert(c, c.p.id);
  if (a.userId !== u.id) throw E(403, 'Not your emergency alert');

  let imageBuffer = null;
  let contentType = 'image/jpeg';

  if (c.files && c.files.photo) {
    imageBuffer = c.files.photo.data;
    contentType = c.files.photo.contentType || contentType;
  } else if (c.raw && c.raw.length > 0) {
    imageBuffer = c.raw;
    contentType = c.req.headers['content-type'] || contentType;
  }

  if (!imageBuffer || imageBuffer.length === 0) {
    throw E(400, 'No photo provided');
  }

  const baseType = contentType.split(';')[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.includes(baseType)) {
    throw E(400, 'Invalid image format. Allowed formats: jpeg, png, webp');
  }

  if (imageBuffer.length > 10 * 1024 * 1024) {
    throw E(413, 'Photo exceeds 10MB limit');
  }

  const ext = baseType.includes('png') ? '.png' : baseType.includes('webp') ? '.webp' : '.jpg';
  const fileName = `photo_${a.id}_${Date.now()}${ext}`;
  const filePath = path.join(PHOTOS_DIR, fileName);

  fs.writeFileSync(filePath, imageBuffer);
  a.photoFile = fileName;
  a.photoType = baseType;
  a.updatedAt = Date.now();
  ping(a);
  save();

  return { ok: true, fileName, photoUrl: `/api/alerts/${a.id}/photo` };
});

R('GET', '/api/alerts/:id/photo', (c) => {
  const u = A(c);
  const a = myAlert(c, c.p.id);

  const hasAccess = a.userId === u.id || (u.role === 'responder' && ((a.notified && a.notified.includes(u.facilityId)) || a.facilityId === u.facilityId));
  if (!hasAccess) throw E(403, 'Forbidden');

  if (!a.photoFile) throw E(404, 'No photo found for this emergency');
  const filePath = path.join(PHOTOS_DIR, a.photoFile);
  if (!fs.existsSync(filePath)) throw E(404, 'Photo file not found on disk');

  const stat = fs.statSync(filePath);
  c.res.writeHead(200, {
    'Content-Type': a.photoType || 'image/jpeg',
    'Content-Length': stat.size,
    'Cache-Control': 'private, no-cache'
  });
  fs.createReadStream(filePath).pipe(c.res);
});

// ---- AI Voice Assistant: Speech-to-Text & Gemini Summarization ----

// OpenAI Audio Transcriptions API with Demo Fallback
async function transcribeAudio(audioFilePath, emergencyType = '') {
  if (DEMO_MODE || !OPENAI_API_KEY) {
    console.log('[AI:STT] Demo mode active or missing OpenAI API key: generating realistic demo transcript');
    const demoPhrases = {
      'Road Accident': 'Emergency! There was a severe bike crash at the main road cross junction. The rider is thrown on the tarmac, bleeding from his leg and arm. He is conscious but in severe pain. Please send an ambulance with trauma kit immediately!',
      'Injury': 'Help needed right away! A person has fallen from the staircase and cannot move their leg. Severe bleeding from forehead. Conscious but dizzy.',
      'Breathing Difficulty': 'Patient is experiencing acute shortness of breath and wheezing. Unable to speak in full sentences. History of asthma. Requires oxygen support urgently.',
      'Medical Emergency': 'Elderly patient having severe chest discomfort, numbness in left arm and cold sweats. Urgent medical evaluation needed!',
      'Other': 'Emergency assistance required. Patient is unresponsive on the ground. Bystanders initiating first aid. Send ambulance urgently.'
    };
    return demoPhrases[emergencyType] || demoPhrases['Other'];
  }

  // Live call to OpenAI Audio Transcriptions API
  const audioBuffer = fs.readFileSync(audioFilePath);
  const ext = path.extname(audioFilePath) || '.webm';
  const boundary = '----OpenAIBoundary' + crypto.randomBytes(8).toString('hex');

  const preFile = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-transcribe\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice${ext}"\r\nContent-Type: audio/webm\r\n\r\n`
  );
  const postFile = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([preFile, audioBuffer, postFile]);

  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // If gpt-transcribe model is unavailable on this key tier, fallback to whisper-1
      if (data?.error?.code === 'model_not_found') {
        console.warn('[AI:STT] gpt-transcribe model not found, retrying with whisper-1');
        const retryPre = Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice${ext}"\r\nContent-Type: audio/webm\r\n\r\n`
        );
        const retryBody = Buffer.concat([retryPre, audioBuffer, postFile]);
        const retryRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`
          },
          body: retryBody
        });
        const retryData = await retryRes.json();
        if (retryRes.ok && retryData.text) return retryData.text;
      }
      throw new Error(data?.error?.message || `OpenAI STT failed with status ${res.status}`);
    }
    return data.text || '';
  } catch (err) {
    console.error('[AI:STT] Live transcription error:', err.message);
    throw err;
  }
}

// Google Gemini API Summarization with Demo Fallback
async function summarizeEmergency(transcript, emergencyType = '') {
  if (DEMO_MODE || !GEMINI_API_KEY) {
    console.log('[AI:Gemini] Demo mode active or missing Gemini API key: generating structured demo summary');
    return {
      emergencyType: emergencyType || 'Road Accident',
      reportedInjuryOrSymptoms: 'Actively bleeding from leg/arm, severe localized pain, alert and conscious.',
      patientStatement: transcript.slice(0, 150) + (transcript.length > 150 ? '...' : ''),
      additionalDetails: 'Incident occurred near road junction. Bystanders present at scene.',
      missingInformation: 'Patient vitals (pulse, BP) and internal bleeding status unconfirmed.',
      responderSummary: `Patient involved in acute ${emergencyType.toLowerCase() || 'emergency'}. Conscious with visible bleeding and pain. Requires immediate ambulance response and trauma triage.`
    };
  }

  const prompt = `
You are an emergency response communication assistant for the RapidAid medical platform.
Analyze the following patient/bystander spoken transcript and produce a strictly structured JSON summary.

CRITICAL SAFETY RULES:
1. Do NOT diagnose medical conditions (e.g., do not say "fractured femur" unless specifically stated).
2. Do NOT invent symptoms not mentioned in the transcript.
3. Do NOT estimate injury severity without clear evidence.
4. Do NOT infer or guess the user's geographic location from words.
5. Preserve uncertainty where information is vague.
6. If the transcript is unclear, state "Spoken audio unclear".
7. Return ONLY valid raw JSON with NO markdown code fences and NO surrounding commentary.

JSON OUTPUT SCHEMA:
{
  "emergencyType": "${emergencyType || 'Emergency'}",
  "reportedInjuryOrSymptoms": "<symptoms/injuries reported by speaker>",
  "patientStatement": "<concise direct quote or gist of what speaker said>",
  "additionalDetails": "<contextual hazards, bystanders, environment>",
  "missingInformation": "<key vitals or facts missing for triage>",
  "responderSummary": "<1-2 sentence actionable summary for the responding hospital/ambulance>"
}

Transcript to analyze:
"${transcript}"
`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1
        }
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error?.message || `Gemini API failed with status ${res.status}`);
    }

    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    // Clean potential markdown quotes
    const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      emergencyType: parsed.emergencyType || emergencyType || 'Emergency',
      reportedInjuryOrSymptoms: parsed.reportedInjuryOrSymptoms || 'Not specified',
      patientStatement: parsed.patientStatement || transcript.slice(0, 100),
      additionalDetails: parsed.additionalDetails || 'None reported',
      missingInformation: parsed.missingInformation || 'Vitals unknown',
      responderSummary: parsed.responderSummary || 'Urgent responder evaluation required.'
    };
  } catch (err) {
    console.error('[AI:Gemini] Summarization error:', err.message);
    throw err;
  }
}

// Transcribe Voice Recording Endpoint
R('POST', '/api/alerts/:id/transcribe', async c => {
  const u = role(c, 'user');
  const a = myAlert(c, c.p.id);
  if (a.userId !== u.id) throw E(403, 'Not your emergency alert');

  if (!a.audioFile) {
    throw E(400, 'Please record and upload audio before transcribing');
  }

  const audioPath = path.join(AUDIO_DIR, a.audioFile);
  if (!fs.existsSync(audioPath)) {
    throw E(404, 'Audio file missing from server storage');
  }

  try {
    const transcript = await transcribeAudio(audioPath, a.type);
    a.transcript = transcript;
    a.updatedAt = Date.now();
    save();
    return { ok: true, transcript };
  } catch (err) {
    console.error('[API] Transcribe failed:', err.message);
    // Graceful fallback so emergency workflow is never blocked
    if (DEMO_MODE || !OPENAI_API_KEY) {
      a.transcript = `[Demo Transcript] Patient reported urgent assistance required for ${a.type}. Spoken audio received.`;
      save();
      return { ok: true, transcript: a.transcript, warning: 'Generated via demo mode' };
    }
    throw E(502, 'Speech-to-text service error: ' + err.message);
  }
});

// Summarize Transcript via Gemini Endpoint
R('POST', '/api/alerts/:id/summarize', async c => {
  const u = role(c, 'user');
  const a = myAlert(c, c.p.id);
  if (a.userId !== u.id) throw E(403, 'Not your emergency alert');

  const transcript = (c.b && typeof c.b.transcript === 'string') ? c.b.transcript : a.transcript;
  if (!transcript || String(transcript).trim().length === 0) {
    throw E(400, 'Transcript is required to generate a summary');
  }

  try {
    const summary = await summarizeEmergency(transcript, a.type);
    return { ok: true, summary };
  } catch (err) {
    console.error('[API] Summarize failed:', err.message);
    if (DEMO_MODE || !GEMINI_API_KEY) {
      const fallback = {
        emergencyType: a.type || 'Emergency',
        reportedInjuryOrSymptoms: 'Symptoms reported in voice recording.',
        patientStatement: transcript.slice(0, 100),
        additionalDetails: 'Reported via RapidAid Voice Assistant',
        missingInformation: 'Medical history and vitals require on-scene triage',
        responderSummary: `Assistance needed for ${a.type}. Review voice transcript.`
      };
      return { ok: true, summary: fallback, warning: 'Generated via demo mode' };
    }
    throw E(502, 'AI summarization error: ' + err.message);
  }
});

// Confirm AI Summary Endpoint (Delivered to Responders)
R('POST', '/api/alerts/:id/summary', c => {
  const u = role(c, 'user');
  const a = myAlert(c, c.p.id);
  if (a.userId !== u.id) throw E(403, 'Not your emergency alert');

  const { confirmedSummary, transcript } = c.b;
  if (!confirmedSummary || typeof confirmedSummary !== 'object') {
    throw E(400, 'Valid confirmed summary object required');
  }

  a.confirmedSummary = {
    emergencyType: String(confirmedSummary.emergencyType || a.type).slice(0, 50),
    reportedInjuryOrSymptoms: String(confirmedSummary.reportedInjuryOrSymptoms || '').slice(0, 300),
    patientStatement: String(confirmedSummary.patientStatement || '').slice(0, 300),
    additionalDetails: String(confirmedSummary.additionalDetails || '').slice(0, 300),
    missingInformation: String(confirmedSummary.missingInformation || '').slice(0, 300),
    responderSummary: String(confirmedSummary.responderSummary || '').slice(0, 400),
    confirmedAt: Date.now()
  };

  if (transcript) a.transcript = String(transcript).slice(0, 1000);
  a.updatedAt = Date.now();

  if (!a.updates) a.updates = [];
  a.updates.push({
    status: a.status,
    timestamp: Date.now(),
    updatedBy: u.name,
    note: 'Voice message transcript and AI summary confirmed by patient'
  });

  ping(a);
  push(cl => (cl.fid && ((a.notified || []).includes(cl.fid) || a.facilityId === cl.fid)), {
    t: 'summary_ready',
    id: a.id
  });
  save();

  return { ok: true, confirmedSummary: a.confirmedSummary };
});

// 4-Question AI Emergency Triage Assessment Endpoint
R('POST', '/api/alerts/:id/triage', async c => {
  const u = role(c, 'user');
  const a = myAlert(c, c.p.id);
  if (a.userId !== u.id) throw E(403, 'Not your emergency alert');

  const { q1_consciousness, q2_bleeding, q3_cardiac, q4_scene } = c.b;

  // Compute Clinical Triage Category
  let triageCode = 'CODE GREEN - STABLE';
  let priority = 3;
  let color = 'green';
  let primaryRisk = 'Mild to moderate trauma/distress without acute life compromise';
  let bystanderGuidance = 'Keep patient calm, monitor breathing, keep warm, avoid giving oral fluids.';
  let ambulanceEquipment = 'Standard trauma kit, vital sign monitor, stretcher';

  const isCritical =
    String(q1_consciousness || '').toLowerCase().includes('unconscious') ||
    String(q1_consciousness || '').toLowerCase().includes('not breathing') ||
    String(q2_bleeding || '').toLowerCase().includes('arterial') ||
    String(q2_bleeding || '').toLowerCase().includes('heavy') ||
    String(q3_cardiac || '').toLowerCase().includes('chest pain') ||
    String(q3_cardiac || '').toLowerCase().includes('stroke');

  const isUrgent =
    String(q2_bleeding || '').toLowerCase().includes('fracture') ||
    String(q2_bleeding || '').toLowerCase().includes('controlled') ||
    String(q3_cardiac || '').toLowerCase().includes('shortness of breath') ||
    String(q4_scene || '').toLowerCase().includes('multiple');

  if (isCritical) {
    triageCode = 'CODE RED - CRITICAL (Immediate Life Threat)';
    priority = 1;
    color = 'red';
    primaryRisk = 'Acute Airway/Breathing Compromise or Hemorrhagic Shock';
    bystanderGuidance = 'If not breathing, begin chest compressions (100-120/min). If bleeding heavily, apply firm direct pressure with clean cloth immediately.';
    ambulanceEquipment = 'Advanced Life Support (ALS), Defibrillator, Airway Intubation Kit, Hemostatic Gauze, Cervical Collar';
  } else if (isUrgent) {
    triageCode = 'CODE YELLOW - URGENT (Potential Life Threat)';
    priority = 2;
    color = 'yellow';
    primaryRisk = 'Severe Musculoskeletal Injury or Acute Respiratory Distress';
    bystanderGuidance = 'Immobilize injured limb. Keep patient seated upright if breathing is labored. Do not move patient if neck/back injury suspected.';
    ambulanceEquipment = 'Oxygen Administration Kit, Limb Splints, Cervical Immobilization, Analgesia Prep';
  }

  // If live Gemini is enabled, enhance with AI clinical synthesis
  if (!DEMO_MODE && GEMINI_API_KEY) {
    try {
      const triagePrompt = `
You are an Emergency Medical Dispatcher & Triage Nurse.
Analyze these 4 urgent on-scene answers and produce a concise clinical triage assessment:
1. Consciousness & Airway: "${q1_consciousness || 'Unspecified'}"
2. Bleeding & Trauma: "${q2_bleeding || 'Unspecified'}"
3. Cardiac / Stroke Symptoms: "${q3_cardiac || 'Unspecified'}"
4. Scene Environment & Casualties: "${q4_scene || 'Unspecified'}"

Return ONLY valid JSON matching this schema:
{
  "triageCode": "${triageCode}",
  "primaryRisk": "<concise risk summary, max 12 words>",
  "bystanderGuidance": "<immediate 1-2 life-saving steps for caller>",
  "ambulanceEquipment": "<vital gear for responding paramedics>"
}
`;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: triagePrompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const parsed = JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim());
        if (parsed.primaryRisk) primaryRisk = parsed.primaryRisk;
        if (parsed.bystanderGuidance) bystanderGuidance = parsed.bystanderGuidance;
        if (parsed.ambulanceEquipment) ambulanceEquipment = parsed.ambulanceEquipment;
      }
    } catch (err) {
      console.warn('[AI:Triage] Gemini triage enhancement fallback:', err.message);
    }
  }

  a.triageAssessment = {
    triageCode,
    priority,
    color,
    answers: {
      consciousness: q1_consciousness || 'Normal / Conscious',
      bleeding: q2_bleeding || 'None visible',
      cardiac: q3_cardiac || 'None reported',
      scene: q4_scene || 'Single patient, scene secure'
    },
    primaryRisk,
    bystanderGuidance,
    ambulanceEquipment,
    timestamp: Date.now()
  };

  a.updatedAt = Date.now();
  if (!a.updates) a.updates = [];
  a.updates.push({
    status: a.status,
    timestamp: Date.now(),
    updatedBy: u.name,
    note: `Clinical Triage Complete: ${triageCode}`
  });

  ping(a);
  push(cl => (cl.fid && ((a.notified || []).includes(cl.fid) || a.facilityId === cl.fid)), {
    t: 'triage_ready',
    id: a.id
  });
  save();

  return { ok: true, triageAssessment: a.triageAssessment };
});

// ---- Static File Server ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webm': 'audio/webm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Handle CORS for local dev/testing
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // API Route Dispatcher
  if (url.pathname.startsWith('/api/')) {
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    try {
      const tok = (req.headers.authorization || '').slice(7) || url.searchParams.get('token') || '';
      const parsedBody = req.method === 'GET' ? { json: {}, files: {}, raw: Buffer.alloc(0) } : await parseBody(req);

      const c = {
        u: verify(tok),
        q: Object.fromEntries(url.searchParams),
        b: parsedBody.json,
        files: parsedBody.files,
        raw: parsedBody.raw,
        req,
        res
      };

      for (const [method, regex, handler] of routes) {
        if (req.method === method) {
          const match = regex.exec(url.pathname);
          if (match) {
            c.p = match.groups || {};
            const result = await handler(c);
            if (!res.headersSent) {
              send(200, result === undefined ? null : result);
            }
            return;
          }
        }
      }

      throw E(404, 'API endpoint not found');
    } catch (err) {
      if (!res.headersSent) {
        const code = err.s || 500;
        send(code, { error: err.s ? err.message : 'Internal Server Error' });
      }
      if (!err.s) console.error('[SERVER ERROR]', err);
    }
    return;
  }

  // Static File Serving
  let reqPath = decodeURIComponent(url.pathname);
  if (reqPath === '/' || reqPath === '') reqPath = 'index.html';
  if (reqPath === '/responder') reqPath = 'responder.html';

  const fullPath = path.normalize(path.join(PUB, reqPath));

  // Security: Prevent Directory Traversal outside public folder
  if (!fullPath.startsWith(PUB) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }

  const ext = path.extname(fullPath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(fullPath).pipe(res);
});

// Start Server when invoked directly
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`🚑 RapidAid 2.0 running on http://localhost:${PORT}`);
    console.log(`📡 Mode: ${DEMO_MODE ? 'Demo Mode (Offline-Safe)' : 'Production AI Connected'}`);
  });
}

module.exports = { server, db, save, persistDbAtomic };
