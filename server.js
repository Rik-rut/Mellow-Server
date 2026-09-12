const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');

const app = express();

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 6767;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB = require('./server/db.js');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const CERTS_DIR = path.join(DATA_DIR, 'certs');

function ensureCert() {
  const KEY_FILE = path.join(CERTS_DIR, 'key.pem');
  const CERT_FILE = path.join(CERTS_DIR, 'cert.pem');

  if (!fs.existsSync(CERTS_DIR)) fs.mkdirSync(CERTS_DIR, { recursive: true });

  if (fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE)) {
    try {
      const existingCert = fs.readFileSync(CERT_FILE, 'utf8');
      const x509 = new crypto.X509Certificate(existingCert);
      if (x509.subjectAltName && x509.subjectAltName.includes('localhost')) {
        return { key: fs.readFileSync(KEY_FILE, 'utf8'), cert: existingCert };
      }
    } catch (_) {}
  }

  const selfsigned = require('selfsigned');
  const os = require('os');
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    { type: 7, ip: '::1' }
  ];
  if (process.env.HOST_IP) {
    altNames.push({ type: 7, ip: process.env.HOST_IP });
  }
  if (process.env.DOMAIN) {
    altNames.push({ type: 2, value: process.env.DOMAIN });
  }
  try {
    const ifaces = os.networkInterfaces();
    for (const name in ifaces) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          altNames.push({ type: 7, ip: iface.address });
        }
      }
    }
  } catch (_) {}

  const pems = selfsigned.generate(
    [{ name: 'commonName', value: 'localhost' }],
    {
      days: 365,
      keySize: 2048,
      extensions: [{ name: 'subjectAltName', altNames }]
    }
  );

  fs.writeFileSync(KEY_FILE, pems.private, { mode: 0o600 });
  fs.writeFileSync(CERT_FILE, pems.cert);

  return { key: pems.private, cert: pems.cert };
}

const httpsOptions = ensureCert();
let server;
let useHttps = false;
if (httpsOptions) {
  server = https.createServer(httpsOptions, app);
  useHttps = true;
} else {
  server = http.createServer(app);
}
const wss = new WebSocket.Server({ server });
wss.on('error', (err) => {
  console.warn('WSS server error:', err.message);
});

const tokens = new Map();
const onlineUsers = new Map();
const voiceParticipants = new Map();
const screenSharers = new Map();
const ReadState = require('./server/read-state.js');
let readState = ReadState.loadReadState();

function getDefaultAvatar(identifier) {
  let hash = 0;
  const str = String(identifier || '');
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const num = (Math.abs(hash) % 10) + 1;
  return `/img/avatars/avatar-${num}.svg`;
}

function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!DB.isOpen()) DB.open(DATA_DIR);

  // One-time migration from legacy JSON files (transactional, keeps .legacy.json backups)
  const migration = DB.importLegacy(DATA_DIR);
  const migratedUsers = migration.files.users;
  const migratedChannels = migration.files.channels;
  readState = ReadState.loadReadState();

  // Users: reset a legacy store that has accounts but no owner; backfill avatars
  let users = DB.loadUsers();
  if (users.length > 0 && !users.some(u => u.role === 'owner')) {
    console.log('Legacy users without owner found. Resetting.');
    DB.saveUsers([]);
    users = [];
  }
  let usersChanged = false;
  users.forEach(u => {
    if (!u.profilePic) {
      u.profilePic = getDefaultAvatar(u.username || u.id);
      usersChanged = true;
    }
  });
  if (usersChanged) DB.saveUsers(users);

  // Servers: create the default server when none exist
  let servers = DB.loadServers();
  if (servers.length === 0) {
    const defaultServers = [
      {
        id: 'default-server',
        name: 'Mellow',
        icon: '/mellow.svg',
        ownerId: '',
        members: [],
        categories: [
          { id: 'cat-text', name: 'Text Channels', order: 0 },
          { id: 'cat-voice', name: 'Voice Channels', order: 1 }
        ],
        createdAt: Date.now()
      }
    ];
    users = DB.loadUsers();
    const owner = users.find(u => u.role === 'owner');
    if (owner) defaultServers[0].ownerId = owner.id;
    defaultServers[0].members = users.map(u => u.id);
    DB.saveServers(defaultServers);
    servers = DB.loadServers();
  }

  // Channels: create the default #general channel when none exist
  let channels = DB.loadChannels();
  if (channels.length === 0) {
    const defaultChannels = [
      { id: crypto.randomUUID(), name: 'general', type: 'text', serverId: 'default-server', categoryId: 'cat-text', createdAt: Date.now(), messages: [], pinned: [], order: 0 }
    ];
    DB.saveChannels(defaultChannels);
    channels = DB.loadChannels();
  }

  // Normalize channels from a legacy migration (same rules the old store applied)
  if (migratedChannels) {
    let allUsers = [];
    try {
      allUsers = DB.loadUsers();
    } catch (_) { }
    let needsRewrite = false;
    const channelsWithMessageChanges = new Set();
    channels.forEach((ch, i) => {
      if (ch.type !== 'dm' && !ch.serverId) { ch.serverId = 'default-server'; needsRewrite = true; }
      if (ch.type !== 'dm' && !ch.categoryId) { ch.categoryId = ch.type === 'voice' ? 'cat-voice' : 'cat-text'; needsRewrite = true; }
      if (ch.order === undefined) { ch.order = i; needsRewrite = true; }
      if (!ch.reactions) { ch.reactions = {}; needsRewrite = true; }
      if (ch.messages) {
        ch.messages.forEach(m => {
          if (!m.reactions) { m.reactions = {}; channelsWithMessageChanges.add(ch.id); }
          if (!m.files && m.file) { m.files = [m.file]; channelsWithMessageChanges.add(ch.id); }
          if ((!m.profilePic || m.profilePic.startsWith('/img/avatars/')) && m.userId) {
            const u = allUsers.find(x => x.id === m.userId);
            if (u && u.profilePic && u.profilePic !== m.profilePic) {
              m.profilePic = u.profilePic;
              channelsWithMessageChanges.add(ch.id);
            }
          }
        });
      }
    });
    if (needsRewrite) DB.saveChannels(channels);
    channelsWithMessageChanges.forEach(chId => {
      const ch = channels.find(c => c.id === chId);
      if (ch) DB.replaceChannelMessages(chId, ch.messages);
    });
  }
  loadTokens();
}

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Session store: token -> { userId, expiresAt } (never stores password material)
function loadTokens() {
  const list = DB.loadTokenEntries();
  if (list.length === 0) return;
  const now = Date.now();
  const valid = [];
  list.forEach(([t, v]) => {
    if (!t || !v || typeof v !== 'object') return;
    if (v.userId) {
      if (typeof v.expiresAt === 'number' && v.expiresAt > now) {
        tokens.set(t, { userId: v.userId, expiresAt: v.expiresAt });
        valid.push(t);
      }
    } else if (v.id) {
      // Legacy format persisted full user objects (incl. password hash).
      // Migrate to userId-only with a fresh TTL.
      tokens.set(t, { userId: v.id, expiresAt: now + TOKEN_TTL_MS });
      valid.push(t);
    }
  });
  if (list.length > 0) saveTokens();
}

function saveTokens() {
  try {
    DB.saveTokens(Array.from(tokens.entries()));
  } catch (e) {
    console.warn('Failed to save tokens:', e.message);
  }
}

function createSession(token, userId) {
  tokens.set(token, { userId, expiresAt: Date.now() + TOKEN_TTL_MS });
  saveTokens();
}

function extractToken(headerValue) {
  let token = headerValue;
  if (token && typeof token === 'string' && token.startsWith('Bearer ')) {
    token = token.slice(7).trim();
  }
  return token || null;
}

function getSessionUser(token) {
  const session = tokens.get(token);
  if (!session) return null;
  if (typeof session.expiresAt === 'number' && session.expiresAt < Date.now()) {
    tokens.delete(token);
    saveTokens();
    return null;
  }
  let users = [];
  try {
    users = DB.loadUsers();
  } catch (_) {
    return null;
  }
  const user = users.find(u => u.id === session.userId);
  if (!user || user.isDeleted) return null;
  return user;
}

function touchSession(token) {
  const session = tokens.get(token);
  if (!session || typeof session.expiresAt !== 'number') return;
  // Slide the expiry only once less than half the TTL remains (avoid disk churn)
  if (session.expiresAt - Date.now() < TOKEN_TTL_MS / 2) {
    session.expiresAt = Date.now() + TOKEN_TTL_MS;
    saveTokens();
  }
}

function revokeUserTokens(userId, exceptToken = null) {
  let changed = false;
  for (const [t, session] of tokens.entries()) {
    if (session && session.userId === userId && t !== exceptToken) {
      tokens.delete(t);
      changed = true;
    }
  }
  if (changed) saveTokens();
  return changed;
}

function isAdmin(role) {
  return role === 'admin' || role === 'owner';
}

function canAccessChannel(userId, channel, serversList, usersList) {
  if (!channel || !userId) return false;
  if (channel.type === 'dm') {
    return Array.isArray(channel.members) && channel.members.includes(userId);
  }
  let servers = serversList;
  if (!servers || !Array.isArray(servers) || servers.length === 0) {
    try {
      servers = DB.loadServers();
    } catch (_) {}
  }
  // Fail closed: non-DM channels require a resolvable server membership.
  if (!Array.isArray(servers) || servers.length === 0) return false;
  const serverId = channel.serverId || 'default-server';
  const server = servers.find(s => s.id === serverId);
  if (!server) return false;
  if (Array.isArray(server.members) && !server.members.includes(userId)) return false;

  if (channel.isPrivate) {
    let users = usersList;
    if (!users || !Array.isArray(users)) {
      try {
        users = DB.loadUsers();
      } catch (_) {}
    }
    const user = users && users.find(u => u.id === userId);
    if (user && isAdmin(user.role)) return true;
    if (server && server.ownerId === userId) return true;
    return Array.isArray(channel.allowedMembers) && channel.allowedMembers.includes(userId);
  }

  return true;
}

const PBKDF2_ITERATIONS = 210000;
const LEGACY_PBKDF2_ITERATIONS = 1000;
const MIN_PASSWORD_LENGTH = 8;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, 'sha512').toString('hex');
  return `v2:${salt}:${hash}`;
}

function passwordNeedsUpgrade(stored) {
  return typeof stored === 'string' && !stored.startsWith('v2:');
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  let salt, hash, iterations;
  if (stored.startsWith('v2:')) {
    const parts = stored.split(':');
    if (parts.length !== 3) return false;
    [, salt, hash] = parts;
    iterations = PBKDF2_ITERATIONS;
  } else {
    const parts = stored.split(':');
    if (parts.length !== 2) return false;
    [salt, hash] = parts;
    iterations = LEGACY_PBKDF2_ITERATIONS;
  }
  let verify;
  try {
    verify = crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512').toString('hex');
  } catch (_) {
    return false;
  }
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(verify, 'hex');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function auth(req, res, next) {
  const token = extractToken(req.headers.authorization);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const user = getSessionUser(token);
  if (!user) {
    tokens.delete(token);
    saveTokens();
    return res.status(401).json({ error: 'Unauthorized' });
  }
  touchSession(token);
  req.user = user;
  req.token = token;
  next();
}

// Types safe to render inline in the browser; everything else forces download
const INLINE_SAFE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tiff', 'ico', 'svg',
  'mp4', 'webm', 'mov', 'm4v', 'mkv',
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus', 'pdf'
]);

function safeUploadExt(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase().replace(/^\./, '');
  if (!/^[a-z0-9]+$/.test(ext)) return null;
  return ext;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = safeUploadExt(file.originalname);
    if (!ext) {
      const err = new Error('Unsupported file type');
      err.code = 'unsupported_file_type';
      return cb(err);
    }
    cb(null, `${crypto.randomUUID()}.${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (useHttps) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    // 'wasm-unsafe-eval' allows compiling WebAssembly (RNNoise and DeepFilterNet3
    // noise-suppression engines) without reopening arbitrary JS eval.
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self'",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-src 'self' https://www.instagram.com https://www.youtube.com https://www.youtube-nocookie.com https://www.tiktok.com https://www.facebook.com",
    "frame-ancestors 'self'",
    "form-action 'self'"
  ].join('; '));
  next();
});

app.use(express.json());
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon.svg'), {
    headers: { 'Content-Type': 'image/svg+xml' }
  });
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR, {
  index: false,
  dotfiles: 'ignore',
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (INLINE_SAFE_EXT.has(ext)) {
      res.setHeader('Content-Disposition', 'inline');
      if (ext === 'svg') {
        res.setHeader('Content-Type', 'image/svg+xml');
      }
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment');
    }
  }
}));

/* ── Brute-force guard (in-memory sliding window) ────────────────────── */
const attemptLog = new Map(); // key -> { count, resetAt }

function tooManyAttempts(key, max, windowMs) {
  const now = Date.now();
  const entry = attemptLog.get(key);
  if (!entry || entry.resetAt <= now) {
    attemptLog.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}

function clearAttempts(key) {
  attemptLog.delete(key);
}

setInterval(() => {
  const now = Date.now();
  attemptLog.forEach((entry, key) => {
    if (entry.resetAt <= now) attemptLog.delete(key);
  });
}, 60 * 1000).unref();

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

/* ── Registration approval: dashboard Approve button (primary) or ────── */
/*    console confirmation code (bootstrap/recovery — needed for the ────── */
/*    first owner, when no admin exists yet). Codes never reach browsers. ── */
const PENDING_REG_TTL_MS = 10 * 60 * 1000;
const APPROVED_LOGIN_WINDOW_MS = 2 * 60 * 1000; // registrant's poller auto-logins within this window
const pendingRegistrations = new Map(); // username -> { username, passwordHash, code, requestedAt, expiresAt, attempts }
const approvedRegistrations = new Map(); // username -> { expiresAt } (tells the polling registrant they may log in)

setInterval(() => {
  const now = Date.now();
  pendingRegistrations.forEach((p, key) => {
    if (p.expiresAt <= now) pendingRegistrations.delete(key);
  });
  approvedRegistrations.forEach((a, key) => {
    if (a.expiresAt <= now) approvedRegistrations.delete(key);
  });
}, 60 * 1000).unref();

function hasActiveUsers() {
  try {
    if (!DB.isOpen()) return true; // fail closed: unopened store counts as "users exist"
    return DB.loadUsers().some(u => !u.isDeleted);
  } catch (_) {
    return true; // fail closed: treat unreadable store as "users exist"
  }
}

function pendingRequestSummaries() {
  const now = Date.now();
  const requests = [];
  pendingRegistrations.forEach(p => {
    if (p.expiresAt > now) {
      requests.push({ username: p.username, requestedAt: p.requestedAt, expiresAt: p.expiresAt });
    }
  });
  requests.sort((a, b) => a.requestedAt - b.requestedAt);
  return requests;
}

// Send the (code-free) pending list to every admin's socket so the
// dashboard updates live. The code itself is never serialized here.
function broadcastPendingList() {
  const payload = JSON.stringify({ type: 'admin:pending:list', requests: pendingRequestSummaries() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.isAuthenticated && isAdmin(client.userRole)) {
      client.send(payload);
    }
  });
}

function broadcastUserRegistered(user) {
  const registeredPayload = JSON.stringify({
    type: 'user:registered',
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      profilePic: user.profilePic,
      status: 'offline',
      customStatus: '',
      aboutMe: '',
      isDeleted: false
    }
  });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
      client.send(registeredPayload);
    }
  });
}

// Creates the account from an approved pending entry. Returns the user, or
// null if the username was claimed in the meantime.
function createApprovedAccount(pending) {
  const users = DB.loadUsers();
  if (users.find(u => u.username === pending.username)) return null;
  const role = hasActiveUsers() ? 'user' : 'owner';
  const defaultNum = Math.floor(Math.random() * 10) + 1;
  const profilePic = `/img/avatars/avatar-${defaultNum}.svg`;
  const user = { id: crypto.randomUUID(), username: pending.username, password: pending.passwordHash, role, profilePic };
  users.push(user);
  DB.saveUsers(users);
  broadcastUserRegistered(user);
  return user;
}

// Step 1: validate input and create a pending registration. The account is NOT
// created until an admin approves it (dashboard) or the registrant submits the
// confirmation code printed to the server console.
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  const ip = clientIp(req);
  if (tooManyAttempts(`register:${ip}`, 10, 60 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many registration attempts. Try again later.' });
  }
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (typeof username !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Invalid input' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: 'Username must be 2-20 characters' });
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
    return res.status(400).json({ error: 'Username may only contain letters, numbers, underscores, periods, and hyphens' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });

  const users = DB.loadUsers();
  if (users.find(u => u.username === username)) return res.status(400).json({ error: 'Username already taken' });

  // Hash now so the pending entry never holds the plaintext password
  const code = String(crypto.randomInt(100000, 1000000));
  pendingRegistrations.set(username, {
    username,
    passwordHash: hashPassword(password),
    code,
    requestedAt: Date.now(),
    expiresAt: Date.now() + PENDING_REG_TTL_MS,
    attempts: 0
  });

  console.log('');
  console.log(`  [Mellow] "${username}" wants to register.`);
  console.log('           Approve them in Admin Dashboard → Registration requests,');
  console.log(`           or give them this code to enter here: ${code} (expires in 10 minutes).`);
  console.log('');
  broadcastPendingList();

  res.json({ pending: true, username });
});

// Registrant-side polling: reports only pending/approved/none. Never includes
// secrets; 'none' is intentionally ambiguous (expired, denied, or unknown).
app.get('/api/register/status', (req, res) => {
  const username = String(req.query.username || '');
  const ip = clientIp(req);
  if (tooManyAttempts(`regstatus:${ip}`, 60, 60 * 1000)) {
    return res.status(429).json({ error: 'Too many status checks. Try again later.' });
  }
  const now = Date.now();
  const pending = pendingRegistrations.get(username);
  if (pending && pending.expiresAt > now) return res.json({ status: 'pending' });
  if (pending) pendingRegistrations.delete(username);
  const approved = approvedRegistrations.get(username);
  if (approved && approved.expiresAt > now) return res.json({ status: 'approved' });
  if (approved) approvedRegistrations.delete(username);
  res.json({ status: 'none' });
});

// Recovery path: complete a registration with the console-printed code.
app.post('/api/register/confirm', (req, res) => {
  const { username, code } = req.body;
  if (!username || !code) return res.status(400).json({ error: 'Username and confirmation code required' });
  const ip = clientIp(req);
  if (tooManyAttempts(`confirm:${ip}`, 15, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many confirmation attempts. Try again later.' });
  }

  const pending = pendingRegistrations.get(username);
  if (!pending || pending.expiresAt <= Date.now()) {
    if (pending) pendingRegistrations.delete(username);
    return res.status(400).json({ expired: true, error: 'Registration request expired or not found. Please register again.' });
  }
  if (String(code) !== pending.code) {
    pending.attempts += 1;
    if (pending.attempts >= 5) {
      pendingRegistrations.delete(username);
      console.log(`  [Mellow] Registration request for "${username}" discarded after 5 wrong codes.`);
      broadcastPendingList();
      return res.status(400).json({ expired: true, error: 'Too many wrong codes. Please register again.' });
    }
    return res.status(403).json({ error: 'Incorrect confirmation code' });
  }
  pendingRegistrations.delete(username);

  const user = createApprovedAccount(pending);
  if (!user) {
    return res.status(400).json({ error: 'Username already taken' });
  }
  clearAttempts(`register:${ip}`);
  clearAttempts(`confirm:${ip}`);
  broadcastPendingList();

  if (user.role === 'owner') {
    console.log(`  [Mellow] "${username}" registered as the OWNER (first account on this server).`);
  }

  const token = crypto.randomUUID();
  createSession(token, user.id);
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, profilePic: user.profilePic, status: user.status || 'online', customStatus: user.customStatus || '', aboutMe: user.aboutMe || '' } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const ip = clientIp(req);
  if (tooManyAttempts(`login:${ip}:${username}`, 5, 15 * 60 * 1000) || tooManyAttempts(`login-ip:${ip}`, 25, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'Too many failed login attempts. Try again later.' });
  }

  const users = DB.loadUsers();
  const user = users.find(u => u.username === username);
  const valid = user && !user.isDeleted && verifyPassword(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  clearAttempts(`login:${ip}:${username}`);

  // Transparently upgrade legacy low-cost password hashes on successful login
  if (passwordNeedsUpgrade(user.password)) {
    user.password = hashPassword(password);
    DB.saveUsers(users);
  }

  const token = crypto.randomUUID();
  createSession(token, user.id);
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, profilePic: user.profilePic, status: user.status || 'online', customStatus: user.customStatus || '', aboutMe: user.aboutMe || '', isDeleted: !!user.isDeleted } });
});

app.post('/api/logout', auth, (req, res) => {
  if (req.token && tokens.has(req.token)) {
    tokens.delete(req.token);
    saveTokens();
  }
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const users = DB.loadUsers();
  const user = users.find(u => u.id === req.user.id);
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json({ user: { id: user.id, username: user.username, role: user.role, profilePic: user.profilePic, status: user.status || 'online', customStatus: user.customStatus || '', aboutMe: user.aboutMe || '', isDeleted: !!user.isDeleted } });
});

app.get('/api/users', auth, (req, res) => {
  if (!isAdmin(req.user.role)) return res.status(403).json({ error: 'Admin only' });
  const users = DB.loadUsers();
  res.json({ users: users.map(u => ({ id: u.id, username: u.username, role: u.role, profilePic: u.profilePic, status: u.status || 'online', customStatus: u.customStatus || '', aboutMe: u.aboutMe || '', isDeleted: !!u.isDeleted, originalUsername: u.originalUsername || '' })) });
});

function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large (max 50 MB)' });
      }
      return res.status(400).json({ error: 'File type not allowed' });
    }
    next();
  });
}

app.post('/api/upload', auth, uploadSingle, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `/uploads/${req.file.filename}`;
  res.json({ url, name: req.file.originalname, size: req.file.size, type: req.file.mimetype });
});

app.post('/api/upload/profile', auth, uploadSingle, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `/uploads/${req.file.filename}`;

  const users = DB.loadUsers();
  const idx = users.findIndex(u => u.id === req.user.id);
  if (idx !== -1) {
    users[idx].profilePic = url;
    DB.saveUsers(users);

    wss.clients.forEach(client => {
      if (client.userId === req.user.id) {
        client.userProfilePic = url;
        if (onlineUsers.has(client)) {
          onlineUsers.set(client, users[idx]);
        }
      }
    });

    voiceParticipants.forEach(participants => {
      participants.forEach(p => {
        if (p.userId === req.user.id) {
          p.profilePic = url;
        }
      });
    });

    const updatedUser = { id: users[idx].id, username: users[idx].username, role: users[idx].role, profilePic: users[idx].profilePic };
    broadcast({ type: 'user:updated', user: updatedUser });
    broadcastOnlineUsers();
  }

  res.json({ url, name: req.file.originalname, size: req.file.size, type: req.file.mimetype });
});

app.post('/api/settings', auth, (req, res) => {
  const { aboutMe, customStatus } = req.body;
  const users = DB.loadUsers();
  const idx = users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });

  if (typeof aboutMe === 'string') {
    users[idx].aboutMe = aboutMe.slice(0, 300).trim();
  }
  if (typeof customStatus === 'string') {
    users[idx].customStatus = customStatus.slice(0, 80).trim();
  }
  DB.saveUsers(users);

  const updatedUser = {
    id: users[idx].id,
    username: users[idx].username,
    role: users[idx].role,
    profilePic: users[idx].profilePic,
    status: users[idx].status || 'online',
    customStatus: users[idx].customStatus || '',
    aboutMe: users[idx].aboutMe || ''
  };
  broadcast({ type: 'user:updated', user: updatedUser });
  broadcastOnlineUsers();
  res.json({ ok: true, user: updatedUser });
});

/* ── Search Endpoint ─────────────────────────────────────────────────── */
app.get('/api/search', auth, (req, res) => {
  const query = (req.query.q || '').trim().toLowerCase();
  const channelId = req.query.channelId;
  const fromUser = (req.query.from || '').trim().toLowerCase();
  const hasFilter = (req.query.has || '').trim().toLowerCase();
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

  if (!query && !fromUser && !hasFilter) {
    return res.json({ results: [], total: 0 });
  }

  const channels = DB.loadChannels();
  const allUsers = DB.loadUsers();
  const servers = DB.loadServers();
  const results = [];

  for (const channel of channels) {
    if (!canAccessChannel(req.user.id, channel, servers, allUsers)) continue;
    if (channelId && channel.id !== channelId) continue;

    let chDisplayName = channel.name || 'channel';
    if (channel.type === 'dm') {
      const otherId = channel.members ? channel.members.find(m => m !== req.user.id) : null;
      const otherUser = otherId ? allUsers.find(u => u.id === otherId) : null;
      chDisplayName = otherUser ? `@${otherUser.username}` : '@Direct Message';
    } else {
      chDisplayName = `#${channel.name}`;
    }

    const msgs = channel.messages || [];
    for (const msg of msgs) {
      if (fromUser && (!msg.username || !msg.username.toLowerCase().includes(fromUser))) {
        continue;
      }
      if (hasFilter) {
        if (hasFilter === 'file' && (!msg.files || msg.files.length === 0)) continue;
        if (hasFilter === 'image' && (!msg.files || !msg.files.some(f => f.type && f.type.startsWith('image/')))) continue;
        if (hasFilter === 'url' && (!msg.text || !/https?:\/\//i.test(msg.text))) continue;
      }
      if (query) {
        const textMatch = msg.text && msg.text.toLowerCase().includes(query);
        const fileMatch = msg.files && msg.files.some(f => f.name && f.name.toLowerCase().includes(query));
        if (!textMatch && !fileMatch) continue;
      }

      results.push({
        id: msg.id,
        channelId: channel.id,
        channelName: chDisplayName,
        channelType: channel.type || 'text',
        userId: msg.userId,
        username: msg.username,
        profilePic: msg.profilePic,
        text: msg.text,
        files: msg.files,
        timestamp: msg.timestamp,
        replyTo: msg.replyTo
      });
    }
  }

  results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  res.json({ results: results.slice(0, limit), total: results.length });
});

/* ── Channel Pinned Messages Endpoint ────────────────────────────────── */
app.get('/api/channels/:channelId/pins', auth, (req, res) => {
  const { channelId } = req.params;
  const channels = DB.loadChannels();
  const channel = channels.find(c => c.id === channelId);
  const servers = DB.loadServers();
  const users = DB.loadUsers();
  if (!channel || !canAccessChannel(req.user.id, channel, servers, users)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const pinnedItems = channel.pinned || [];
  const messages = channel.messages || [];
  const enriched = [];

  for (const pin of pinnedItems) {
    const msg = messages.find(m => m.id === pin.messageId);
    if (msg) {
      enriched.push({
        id: msg.id,
        channelId: channel.id,
        userId: msg.userId,
        username: msg.username,
        profilePic: msg.profilePic,
        text: msg.text,
        files: msg.files,
        timestamp: msg.timestamp,
        pinnedBy: pin.pinnedBy,
        pinnedAt: pin.pinnedAt
      });
    }
  }

  res.json({ pins: enriched });
});

/* ── Embed Rich Preview & Video Proxy Endpoints (e.g. for Instagram) ─── */
const previewCache = new Map();
const igVideoUrlCache = new Map();

function isEmbedAllowedHost(host) {
  host = String(host || '').toLowerCase();
  return host === 'instagram.com' || host.endsWith('.instagram.com')
    || host === 'cdninstagram.com' || host.endsWith('.cdninstagram.com')
    || host === 'fbcdn.net' || host.endsWith('.fbcdn.net');
}

// SSRF guard: validate host before AND after redirects so 302 chains cannot
// bounce the request to internal/LAN addresses.
async function safeEmbedFetch(url, opts = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw new Error('Invalid URL');
  }
  if (parsed.protocol !== 'https:' || !isEmbedAllowedHost(parsed.hostname)) {
    throw new Error('Host not allowed');
  }
  const res = await fetch(url, opts);
  let finalHost = '';
  try {
    finalHost = new URL(res.url).hostname;
  } catch (_) {}
  if (!isEmbedAllowedHost(finalHost)) {
    try { if (res.body && res.body.cancel) res.body.cancel(); } catch (_) {}
    throw new Error('Redirect to disallowed host');
  }
  return res;
}

async function getInstagramVideoUrl(targetUrl, bypassCache = false) {
  if (!bypassCache && igVideoUrlCache.has(targetUrl)) {
    return igVideoUrlCache.get(targetUrl);
  }

  let embedUrl = targetUrl;
  try {
    const parsed = new URL(targetUrl);
    const m = parsed.pathname.match(/\/(reel|reels|p|tv)\/([a-zA-Z0-9_-]+)/i);
    if (m) {
      embedUrl = `https://www.instagram.com/${m[1] === 'reels' ? 'reel' : m[1]}/${m[2]}/embed/`;
    } else {
      embedUrl = targetUrl.replace(/\/+$/, '') + '/embed/';
    }
  } catch (_) {
    return null;
  }

  try {
    const res = await safeEmbedFetch(embedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return null;
    const html = await res.text();
    const idx = html.indexOf('.mp4');
    if (idx !== -1) {
      const start = html.lastIndexOf('http', idx);
      const end = html.indexOf('"', idx);
      if (start !== -1 && end > idx) {
        let rawUrl = html.slice(start, end);
        let cleanUrl = rawUrl.replace(/\\+/g, '').replace(/u0026/g, '&');
        if (cleanUrl.startsWith('http')) {
          // Only ever accept a video URL on Instagram/Meta CDN hosts
          let videoHost = '';
          try {
            videoHost = new URL(cleanUrl).hostname;
          } catch (_) {}
          if (!isEmbedAllowedHost(videoHost)) return null;
          if (igVideoUrlCache.size > 500) {
            const firstKey = igVideoUrlCache.keys().next().value;
            igVideoUrlCache.delete(firstKey);
          }
          igVideoUrlCache.set(targetUrl, cleanUrl);
          return cleanUrl;
        }
      }
    }
  } catch (e) {
    console.warn('Failed to extract Instagram video URL:', e.message);
  }
  return null;
}

app.get('/api/embed/preview', async (req, res) => {
  const targetUrl = (req.query.url || '').trim();
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return res.status(400).json({ error: 'Valid url query param required' });
  }
  if (tooManyAttempts(`embed:${clientIp(req)}`, 120, 60 * 1000)) {
    return res.status(429).json({ error: 'Too many preview requests. Try again later.' });
  }

  // Security: restrict to supported domains to prevent open proxy abuse
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'https:' || !isEmbedAllowedHost(parsed.hostname)) {
      return res.status(400).json({ error: 'Domain not supported for metadata preview' });
    }
  } catch (_) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (previewCache.has(targetUrl)) {
    return res.json(previewCache.get(targetUrl));
  }

  try {
    const pageRes = await safeEmbedFetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
      },
      signal: AbortSignal.timeout(4000)
    });

    if (!pageRes.ok) {
      return res.status(502).json({ error: 'Failed to fetch external metadata' });
    }

    const html = await pageRes.text();
    const getMeta = (prop) => {
      const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
      return m ? m[1] : null;
    };

    let image = getMeta('og:image') || getMeta('twitter:image') || '';
    if (image) image = image.replace(/&amp;/g, '&');
    try {
      const imgParsed = new URL(image);
      if (imgParsed.protocol !== 'https:' || !isEmbedAllowedHost(imgParsed.hostname)) image = '';
    } catch (_) {
      image = '';
    }

    const decodeEntities = (s) => (s || '')
      .replace(/&quot;/g, '"')
      .replace(/&#064;/g, '@')
      .replace(/&#x2022;/g, '•')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');

    let title = decodeEntities(getMeta('og:title') || getMeta('twitter:title') || '');
    let description = decodeEntities(getMeta('og:description') || getMeta('description') || '');

    let author = '';
    const authorMatch = description.match(/- ([a-zA-Z0-9._]+) on /) || title.match(/\(@([a-zA-Z0-9._]+)\)/);
    if (authorMatch) {
      author = '@' + authorMatch[1];
    } else {
      author = 'Instagram';
    }

    // Check if video is available for inline playback
    let video = null;
    let hasVideo = false;
    try {
      const vidUrl = await getInstagramVideoUrl(targetUrl);
      if (vidUrl) {
        video = '/api/embed/video?url=' + encodeURIComponent(targetUrl);
        hasVideo = true;
      }
    } catch (_) {}

    const result = {
      image,
      title,
      description,
      author,
      url: targetUrl,
      video,
      hasVideo
    };

    if (previewCache.size > 500) {
      const firstKey = previewCache.keys().next().value;
      previewCache.delete(firstKey);
    }
    previewCache.set(targetUrl, result);

    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Unable to fetch preview' });
  }
});

app.get('/api/embed/video', async (req, res) => {
  const targetUrl = (req.query.url || '').trim();
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return res.status(400).json({ error: 'Valid url query param required' });
  }
  if (tooManyAttempts(`embed:${clientIp(req)}`, 120, 60 * 1000)) {
    return res.status(429).json({ error: 'Too many proxy requests. Try again later.' });
  }

  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'https:' || !isEmbedAllowedHost(parsed.hostname)) {
      return res.status(400).json({ error: 'Domain not supported for video proxy' });
    }
  } catch (_) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    let videoUrl = await getInstagramVideoUrl(targetUrl);
    if (!videoUrl) {
      return res.status(404).json({ error: 'Video not found or unable to extract' });
    }

    async function fetchStream(url) {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.instagram.com/'
      };
      if (req.headers.range) {
        headers['Range'] = req.headers.range;
      }
      return safeEmbedFetch(url, { headers, signal: AbortSignal.timeout(10000) });
    }

    let upstreamRes = await fetchStream(videoUrl);

    // If CDN token expired (403/410), retry once by extracting fresh URL
    if (upstreamRes.status === 403 || upstreamRes.status === 410) {
      igVideoUrlCache.delete(targetUrl);
      videoUrl = await getInstagramVideoUrl(targetUrl, true);
      if (videoUrl) {
        upstreamRes = await fetchStream(videoUrl);
      }
    }

    res.status(upstreamRes.status);
    let safeType = upstreamRes.headers.get('content-type') || 'video/mp4';
    if (!/^video\//i.test(safeType)) safeType = 'video/mp4';
    res.setHeader('Content-Type', safeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    ['content-length', 'content-range'].forEach(h => {
      const val = upstreamRes.headers.get(h);
      if (val) res.setHeader(h, val);
    });
    res.setHeader('Accept-Ranges', 'bytes');

    if (upstreamRes.body) {
      Readable.fromWeb(upstreamRes.body)
        .on('error', () => { if (!res.writableEnded) res.end(); })
        .pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Unable to proxy video' });
    }
  }
});

function broadcast(data, exclude = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.isAuthenticated && client !== exclude) client.send(msg);
  });
}

function broadcastToRoom(channelId, data, exclude = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.voiceChannelId === channelId && client !== exclude) {
      client.send(msg);
    }
  });
}

function broadcastOnlineUsers() {
  wss.clients.forEach(client => {
    if (client.readyState !== WebSocket.OPEN || !client.isAuthenticated) return;
    const users = [];
    const seenIds = new Set();
    onlineUsers.forEach((user, ws) => {
      if (ws.readyState === WebSocket.OPEN && !seenIds.has(user.id)) {
        const isSelf = client.userId && user.id === client.userId;
        const currentStatus = user.status || 'online';
        // Invisible users appear offline to all other users
        if (currentStatus === 'invisible' && !isSelf) {
          return;
        }
        seenIds.add(user.id);
        users.push({
          id: user.id,
          username: user.username,
          role: user.role,
          profilePic: user.profilePic,
          status: currentStatus,
          customStatus: user.customStatus || '',
          aboutMe: user.aboutMe || ''
        });
      }
    });
    client.send(JSON.stringify({ type: 'users:online', users }));
  });
}

function broadcastUserChannels(userId) {
  const channels = DB.loadChannels();
  let servers = [];
  try {
    servers = DB.loadServers();
  } catch (_) {}
  const allUsers = DB.loadUsers();
  const userServers = servers.filter(s => Array.isArray(s.members) && s.members.includes(userId));
  const visibleChannels = channels.filter(c => canAccessChannel(userId, c, servers, allUsers));

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.isAuthenticated && client.userId === userId) {
      const unreadCounts = ReadState.computeUnreadCounts(visibleChannels, readState, userId);
      client.send(JSON.stringify({
        type: 'channels',
        servers: userServers,
        channels: visibleChannels.map(c => {
          if (c.type === 'dm') {
            const otherId = (c.members || []).find(m => m !== userId);
            const otherUser = allUsers.find(u => u.id === otherId);
            const lastMsg = (c.messages && c.messages.length > 0) ? c.messages[c.messages.length - 1] : null;
            return {
              id: c.id, type: 'dm', members: c.members, createdAt: c.createdAt, pinned: c.pinned || [], order: c.order || 0,
              lastMessageAt: (lastMsg && lastMsg.timestamp) ? lastMsg.timestamp : (c.lastMessageAt || c.createdAt || 0),
              dmUser: otherUser ? { id: otherUser.id, username: otherUser.username, profilePic: otherUser.profilePic } : { id: otherId, username: 'Unknown', profilePic: '' }
            };
          }
          return {
            id: c.id,
            name: c.name,
            type: c.type || 'text',
            serverId: c.serverId || 'default-server',
            categoryId: c.categoryId || (c.type === 'voice' ? 'cat-voice' : 'cat-text'),
            isPrivate: !!c.isPrivate,
            allowedMembers: c.allowedMembers || [],
            createdAt: c.createdAt,
            pinned: c.pinned || [],
            order: c.order || 0
          };
        }),
        allUsers: allUsers.map(u => ({ id: u.id, username: u.username, role: u.role, profilePic: u.profilePic, status: u.status || 'online', customStatus: u.customStatus || '', aboutMe: u.aboutMe || '', isDeleted: !!u.isDeleted, originalUsername: u.originalUsername || '' })),
        readState: readState[userId] || {},
        unreadCounts
      }));
    }
  });
}

function broadcastVoiceEvent(channelId, payload) {
  const channels = DB.loadChannels();
  const channel = channels.find(c => c.id === channelId);
  if (channel && channel.type === 'dm') {
    const memberSet = new Set(channel.members || []);
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && client.isAuthenticated && memberSet.has(client.userId)) {
        client.send(JSON.stringify(payload));
      }
    });
  } else {
    broadcast(payload);
  }
}

function broadcastVoiceParticipants(channelId) {
  const participants = voiceParticipants.get(channelId);
  const list = [];
  if (participants) {
    participants.forEach(p => {
      list.push({ userId: p.userId, username: p.username, profilePic: p.profilePic, muted: !!p.muted, cameraOn: !!p.cameraOn });
    });
  }
  broadcastVoiceEvent(channelId, { type: 'voice:participants', channelId, participants: list });
}

function removeFromVoice(ws) {
  voiceParticipants.forEach((participants, channelId) => {
    if (participants.has(ws)) {
      participants.delete(ws);
      if (participants.size === 0) {
        voiceParticipants.delete(channelId);
      }
      broadcastVoiceParticipants(channelId);
      broadcastVoiceEvent(channelId, { type: 'voice:user:left', channelId, userId: ws.userId });
    }
  });
}

wss.on('connection', (ws) => {
  ws.isAuthenticated = false;

  ws.on('error', (err) => {
    console.warn('WS client error:', err.message);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'auth': {
          const token = extractToken(msg.token);
          ws.authFailures = (ws.authFailures || 0) + 1;
          if (ws.authFailures > 10) {
            ws.close();
            return;
          }
          const user = token ? getSessionUser(token) : null;
          if (!user) {
            if (token) {
              tokens.delete(token);
              saveTokens();
            }
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
            return;
          }
          ws.authFailures = 0;
          touchSession(token);
          ws.token = token;
          const allUsers = DB.loadUsers();
          ws.isAuthenticated = true;
          ws.userId = user.id;
          ws.username = user.username;
          ws.userRole = user.role;
          ws.userProfilePic = user.profilePic || getDefaultAvatar(user.username || user.id);
          onlineUsers.set(ws, user);

          const channels = DB.loadChannels();
          let servers = [];
          try {
            servers = DB.loadServers();
          } catch (_) {}
          const userServers = servers.filter(s => Array.isArray(s.members) && s.members.includes(user.id));
          const visibleChannels = channels.filter(c => canAccessChannel(user.id, c, servers, allUsers));
          const unreadCounts = ReadState.computeUnreadCounts(visibleChannels, readState, user.id);
          ws.send(JSON.stringify({
            type: 'channels',
            servers: userServers,
            channels: visibleChannels.map(c => {
              if (c.type === 'dm') {
                const otherId = c.members.find(m => m !== user.id);
                const otherUser = allUsers.find(u => u.id === otherId);
                return {
                  id: c.id, type: 'dm', members: c.members, createdAt: c.createdAt, pinned: c.pinned || [], order: c.order || 0,
                  dmUser: otherUser ? { id: otherUser.id, username: otherUser.username, profilePic: otherUser.profilePic } : { id: otherId, username: 'Unknown', profilePic: '' }
                };
              }
              return {
                id: c.id,
                name: c.name,
                type: c.type || 'text',
                serverId: c.serverId || 'default-server',
                categoryId: c.categoryId || (c.type === 'voice' ? 'cat-voice' : 'cat-text'),
                isPrivate: !!c.isPrivate,
                allowedMembers: c.allowedMembers || [],
                createdAt: c.createdAt,
                pinned: c.pinned || [],
                order: c.order || 0
              };
            }),
            allUsers: allUsers.map(u => ({ id: u.id, username: u.username, role: u.role, profilePic: u.profilePic, status: u.status || 'online', customStatus: u.customStatus || '', aboutMe: u.aboutMe || '', isDeleted: !!u.isDeleted, originalUsername: u.originalUsername || '' })),
            readState: readState[user.id] || {},
            unreadCounts
          }));

          if (visibleChannels.length > 0) {
            const firstNonDM = visibleChannels.find(c => c.type !== 'dm');
            if (firstNonDM) {
              ws.channelId = firstNonDM.id;
              ws.send(JSON.stringify({ type: 'messages', channelId: firstNonDM.id, messages: firstNonDM.messages }));
            }
          }

          const allParticipants = {};
          voiceParticipants.forEach((participants, chId) => {
            const list = [];
            participants.forEach(p => {
              list.push({ userId: p.userId, username: p.username, profilePic: p.profilePic, muted: !!p.muted, cameraOn: !!p.cameraOn });
            });
            allParticipants[chId] = list;
          });
          const allSharers = {};
          screenSharers.forEach((chId, userId) => {
            if (!allSharers[chId]) allSharers[chId] = [];
            allSharers[chId].push(userId);
          });
          ws.send(JSON.stringify({ type: 'voice:all-participants', channels: allParticipants, screenSharers: allSharers }));

          broadcastOnlineUsers();
          break;
        }

        case 'channel:join': {
          if (!ws.isAuthenticated) {
            ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
            return;
          }
          const channels = DB.loadChannels();
          const channel = channels.find(c => c.id === msg.channelId);
          const servers = DB.loadServers();
          const users = DB.loadUsers();
          if (!channel || !canAccessChannel(ws.userId, channel, servers, users)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Channel not found or access denied' }));
            return;
          }
          ws.channelId = msg.channelId;
          if (ws.userId) {
            ReadState.markRead(readState, ws.userId, channel.id, Date.now());
            ReadState.saveReadState(readState);
          }
          ws.send(JSON.stringify({ type: 'messages', channelId: channel.id, messages: channel.messages }));
          break;
        }

        case 'channel:read': {
          if (!ws.userId || !msg.channelId) return;
          const channels = DB.loadChannels();
          const channel = channels.find(c => c.id === msg.channelId);
          const servers = DB.loadServers();
          const users = DB.loadUsers();
          if (!channel || !canAccessChannel(ws.userId, channel, servers, users)) return;
          ReadState.markRead(readState, ws.userId, msg.channelId, Date.now());
          ReadState.saveReadState(readState);
          break;
        }

        case 'message:send': {
          if (!ws.isAuthenticated) {
            ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
            return;
          }
          if (!ws.channelId) {
            ws.send(JSON.stringify({ type: 'error', message: 'No channel selected' }));
            return;
          }
          const channels = DB.loadChannels();
          const channel = channels.find(c => c.id === ws.channelId);
          const servers = DB.loadServers();
          const userList = DB.loadUsers();
          if (!channel || !canAccessChannel(ws.userId, channel, servers, userList)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Channel not found or access denied' }));
            return;
          }

          const rawFiles = msg.files || (msg.file ? [msg.file] : []);
          const files = Array.isArray(rawFiles)
            ? rawFiles.slice(0, 8).map(f => ({
                url: String(f.url || ''),
                name: String(f.name || '').slice(0, 255),
                size: Number(f.size) || 0,
                type: String(f.type || '').slice(0, 100)
              })).filter(f => /^\/uploads\/[0-9a-f-]+\.\w+$/.test(f.url))
            : [];

          let replyTo = null;
          if (msg.replyToId) {
            const orig = channel.messages.find(m => m.id === msg.replyToId);
            if (orig) {
              replyTo = {
                id: orig.id,
                userId: orig.userId,
                username: orig.username,
                text: (orig.text || (orig.files && orig.files.length ? `[${orig.files.length} file(s)]` : '')).slice(0, 120)
              };
            }
          }

          const message = {
            id: crypto.randomUUID(),
            userId: ws.userId,
            username: ws.username,
            text: typeof msg.text === 'string' ? msg.text.slice(0, 4000) : '',
            files,
            timestamp: Date.now(),
            profilePic: ws.userProfilePic || '',
            reactions: {},
            replyTo: replyTo || undefined
          };
          channel.lastMessageAt = message.timestamp;
          DB.appendMessage(channel, message);

          const broadcastMsg = JSON.stringify({ type: 'message:new', channelId: channel.id, message });
          const activityMsg = JSON.stringify({
            type: 'channel:activity',
            channelId: channel.id,
            channelType: channel.type || 'text',
            timestamp: message.timestamp,
            senderId: ws.userId
          });

          const users = channel.type === 'dm' ? DB.loadUsers() : null;

          wss.clients.forEach(client => {
            if (client.readyState !== WebSocket.OPEN || !client.isAuthenticated) return;
            if (!canAccessChannel(client.userId, channel, servers, userList)) return;

            if (channel.type === 'dm') {
              const otherId = channel.members.find(m => m !== client.userId);
              const otherUser = users ? users.find(u => u.id === otherId) : null;
              client.send(JSON.stringify({
                type: 'channel:sync',
                channel: {
                  id: channel.id, type: 'dm', members: channel.members,
                  createdAt: channel.createdAt, pinned: channel.pinned || [], order: channel.order || 0,
                  lastMessageAt: message.timestamp,
                  dmUser: otherUser ? { id: otherUser.id, username: otherUser.username, profilePic: otherUser.profilePic } : { id: otherId, username: 'Unknown', profilePic: '' }
                }
              }));
            }

            const isViewing = client.channelId === channel.id;
            const isInVoiceRoom = channel.type === 'voice' && client.voiceChannelId === channel.id;
            if (isViewing || isInVoiceRoom) {
              client.send(broadcastMsg);
            } else {
              client.send(activityMsg);
            }
          });

          if (channel.type === 'dm') {
            const otherId = Array.isArray(channel.members) ? channel.members.find(m => m !== ws.userId) : null;
            if (otherId) {
              wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN && client.isAuthenticated && client.userId === otherId) {
                  client.send(JSON.stringify({
                    type: 'message:mention',
                    channelId: channel.id,
                    message,
                    mentionType: 'dm'
                  }));
                }
              });
            }
          }

          if (msg.mentions && msg.mentions.length > 0) {
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && client.isAuthenticated && client.userId !== ws.userId) {
                if (!canAccessChannel(client.userId, channel, servers, userList)) return;
                const isMentioned = msg.mentions.includes('everyone') || msg.mentions.includes(client.userId);
                if (isMentioned) {
                  client.send(JSON.stringify({
                    type: 'message:mention',
                    channelId: channel.id,
                    message,
                    mentionType: msg.mentions.includes('everyone') ? 'everyone' : 'user'
                  }));
                }
              }
            });
          }
          break;
        }

        case 'message:edit': {
          if (!ws.isAuthenticated || !msg.channelId || !msg.messageId) return;
          const channels = DB.loadChannels();
          const channel = channels.find(c => c.id === msg.channelId);
          const servers = DB.loadServers();
          const users = DB.loadUsers();
          if (!channel || !canAccessChannel(ws.userId, channel, servers, users)) return;

          const message = channel.messages.find(m => m.id === msg.messageId);
          if (!message) return;
          if (message.userId !== ws.userId && !isAdmin(ws.userRole)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Permission denied' }));
            return;
          }

          const newText = typeof msg.text === 'string' ? msg.text.trim().slice(0, 4000) : '';
          if (!newText && (!message.files || message.files.length === 0)) return;

          message.text = newText;
          message.editedAt = Date.now();
          DB.editMessage(channel.id, message.id, message.text, message.editedAt);

          const editMsg = JSON.stringify({
            type: 'message:edited',
            channelId: channel.id,
            messageId: message.id,
            text: message.text,
            editedAt: message.editedAt
          });

          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.isAuthenticated && canAccessChannel(client.userId, channel, servers, users)) {
              client.send(editMsg);
            }
          });
          break;
        }

        case 'message:delete': {
          if (!ws.isAuthenticated || !msg.channelId || !msg.messageId) return;
          const channels = DB.loadChannels();
          const channel = channels.find(c => c.id === msg.channelId);
          const servers = DB.loadServers();
          const users = DB.loadUsers();
          if (!channel || !canAccessChannel(ws.userId, channel, servers, users)) return;

          const idx = channel.messages.findIndex(m => m.id === msg.messageId);
          if (idx === -1) return;
          const targetMsg = channel.messages[idx];
          if (targetMsg.userId !== ws.userId && !isAdmin(ws.userRole)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Permission denied' }));
            return;
          }

          DB.deleteMessage(channel.id, msg.messageId);

          const delMsg = JSON.stringify({ type: 'message:deleted', channelId: channel.id, messageId: msg.messageId });
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.isAuthenticated && canAccessChannel(client.userId, channel, servers, users)) {
              client.send(delMsg);
            }
          });
          break;
        }

        case 'channel:create': {
          if (!ws.isAuthenticated) return;
          const serverId = msg.serverId || 'default-server';
          let servers = [];
          try { servers = DB.loadServers(); } catch (_) {}
          const server = servers.find(s => s.id === serverId);
          const isServerOwner = server && server.ownerId === ws.userId;
          if (!isAdmin(ws.userRole) && !isServerOwner) return;
          if (!msg.name || msg.name.trim().length === 0) return;

          const channels = DB.loadChannels();
          if (channels.find(c => c.name === msg.name.trim())) {
            ws.send(JSON.stringify({ type: 'error', message: 'Channel already exists' }));
            return;
          }

          const isPrivate = !!msg.isPrivate;
          const allowedMembers = Array.isArray(msg.allowedMembers) ? msg.allowedMembers : [];

          const newChannel = {
            id: crypto.randomUUID(),
            name: msg.name.trim(),
            type: msg.channelType || 'text',
            serverId,
            categoryId: msg.categoryId || (msg.channelType === 'voice' ? 'cat-voice' : 'cat-text'),
            isPrivate,
            allowedMembers,
            createdAt: Date.now(),
            messages: [],
            pinned: [],
            order: channels.length
          };
          channels.push(newChannel);
          DB.saveChannels(channels);

          const allUsers = DB.loadUsers();
          const channelCreatedMsg = JSON.stringify({
            type: 'channel:created',
            channel: {
              id: newChannel.id,
              name: newChannel.name,
              type: newChannel.type,
              serverId: newChannel.serverId,
              categoryId: newChannel.categoryId,
              createdAt: newChannel.createdAt,
              isPrivate: newChannel.isPrivate,
              allowedMembers: newChannel.allowedMembers,
              pinned: []
            }
          });
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
              if (canAccessChannel(client.userId, newChannel, servers, allUsers)) {
                client.send(channelCreatedMsg);
              }
            }
          });
          break;
        }

        case 'channel:delete': {
          if (!ws.isAuthenticated || !isAdmin(ws.userRole)) return;
          const channels = DB.loadChannels();
          const idx = channels.findIndex(c => c.id === msg.channelId);
          if (idx === -1) return;
          if (channels.length <= 1) {
            ws.send(JSON.stringify({ type: 'error', message: 'Cannot delete the last channel' }));
            return;
          }

          const deletedChannel = channels[idx];
          channels.splice(idx, 1);
          DB.saveChannels(channels);

          if (deletedChannel.type === 'voice') {
            const participants = voiceParticipants.get(deletedChannel.id);
            if (participants) {
              participants.forEach(p => {
                if (p.ws.readyState === WebSocket.OPEN) {
                  p.ws.send(JSON.stringify({ type: 'voice:channel:closed', channelId: deletedChannel.id }));
                }
              });
              voiceParticipants.delete(deletedChannel.id);
            }
          }

          broadcast({ type: 'channel:deleted', channelId: msg.channelId });
          break;
        }

        case 'channel:rename': {
          if (!ws.isAuthenticated || !isAdmin(ws.userRole)) return;
          if (!msg.channelId || !msg.name || msg.name.trim().length === 0) return;
          const channels = DB.loadChannels();
          const channel = channels.find(c => c.id === msg.channelId);
          if (!channel) return;
          channel.name = msg.name.trim();
          DB.saveChannels(channels);
          broadcast({ type: 'channel:renamed', channelId: channel.id, name: channel.name });
          break;
        }

        case 'channel:permissions:update': {
          if (!ws.isAuthenticated) return;
          const { channelId } = msg;
          if (!channelId) return;

          const channels = DB.loadChannels();
          const channel = channels.find(c => c.id === channelId);
          if (!channel || channel.type === 'dm') return;

          let servers = [];
          try { servers = DB.loadServers(); } catch (_) {}
          const serverId = channel.serverId || 'default-server';
          const server = servers.find(s => s.id === serverId);
          const isServerOwner = server && server.ownerId === ws.userId;
          if (!isAdmin(ws.userRole) && !isServerOwner) {
            ws.send(JSON.stringify({ type: 'error', message: 'Admin or server owner required' }));
            return;
          }

          if (typeof msg.isPrivate === 'boolean') {
            channel.isPrivate = msg.isPrivate;
          }
          if (Array.isArray(msg.allowedMembers)) {
            channel.allowedMembers = msg.allowedMembers;
          } else if (channel.isPrivate && !Array.isArray(channel.allowedMembers)) {
            channel.allowedMembers = [];
          }
          if (typeof msg.name === 'string' && msg.name.trim().length > 0) {
            channel.name = msg.name.trim();
          }

          DB.saveChannels(channels);

          let users = [];
          try { users = DB.loadUsers(); } catch (_) {}

          if (channel.type === 'voice') {
            const participants = voiceParticipants.get(channel.id);
            if (participants) {
              const toRemove = [];
              participants.forEach((p, pWs) => {
                if (!canAccessChannel(p.userId, channel, servers, users)) {
                  toRemove.push({ ws: pWs, userId: p.userId });
                }
              });
              for (const p of toRemove) {
                if (screenSharers.has(p.userId)) {
                  screenSharers.delete(p.userId);
                  broadcast({ type: 'voice:screen:stopped', channelId: channel.id, userId: p.userId });
                }
                if (p.ws.readyState === WebSocket.OPEN) {
                  p.ws.send(JSON.stringify({ type: 'voice:channel:closed', channelId: channel.id }));
                }
                removeFromVoice(p.ws);
                p.ws.voiceChannelId = null;
              }
            }
          }

          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
              const canAccess = canAccessChannel(client.userId, channel, servers, users);
              client.send(JSON.stringify({
                type: 'channel:permissions:updated',
                channelId: channel.id,
                canAccess,
                channel: canAccess ? {
                  id: channel.id,
                  name: channel.name,
                  type: channel.type,
                  serverId: channel.serverId,
                  categoryId: channel.categoryId,
                  isPrivate: channel.isPrivate,
                  allowedMembers: channel.allowedMembers,
                  pinned: channel.pinned || []
                } : null
              }));
            }
          });
          break;
        }

        case 'dm:create': {
          if (!ws.isAuthenticated) return;
          const { targetUserId } = msg;
          if (!targetUserId || targetUserId === ws.userId) return;

          const users = DB.loadUsers();
          const targetUser = users.find(u => u.id === targetUserId);
          const creator = users.find(u => u.id === ws.userId);
          if (!targetUser || !creator) return;

          const channels = DB.loadChannels();
          let dmChannel = channels.find(c =>
            c.type === 'dm' &&
            c.members &&
            c.members.includes(ws.userId) &&
            c.members.includes(targetUserId)
          );

          if (dmChannel) {
            const lastMsg = (dmChannel.messages && dmChannel.messages.length > 0) ? dmChannel.messages[dmChannel.messages.length - 1] : null;
            ws.send(JSON.stringify({
              type: 'channel:created',
              channel: {
                id: dmChannel.id, type: 'dm', members: dmChannel.members,
                createdAt: dmChannel.createdAt, pinned: dmChannel.pinned || [],
                lastMessageAt: (lastMsg && lastMsg.timestamp) ? lastMsg.timestamp : (dmChannel.lastMessageAt || dmChannel.createdAt || 0),
                dmUser: { id: targetUser.id, username: targetUser.username, profilePic: targetUser.profilePic }
              },
              isCreator: true
            }));
            return;
          }

          dmChannel = {
            id: crypto.randomUUID(),
            type: 'dm',
            members: [ws.userId, targetUserId],
            createdAt: Date.now(),
            lastMessageAt: Date.now(),
            messages: [],
            pinned: []
          };
          channels.push(dmChannel);
          DB.saveChannels(channels);

          ws.send(JSON.stringify({
            type: 'channel:created',
            channel: {
              id: dmChannel.id, type: 'dm', members: dmChannel.members,
              createdAt: dmChannel.createdAt, pinned: dmChannel.pinned || [],
              lastMessageAt: dmChannel.lastMessageAt,
              dmUser: { id: targetUser.id, username: targetUser.username, profilePic: targetUser.profilePic }
            },
            isCreator: true
          }));

          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.userId === targetUserId) {
              client.send(JSON.stringify({
                type: 'channel:created',
                channel: {
                  id: dmChannel.id, type: 'dm', members: dmChannel.members,
                  createdAt: dmChannel.createdAt, pinned: dmChannel.pinned || [],
                  lastMessageAt: dmChannel.lastMessageAt,
                  dmUser: { id: creator.id, username: creator.username, profilePic: creator.profilePic }
                },
                isCreator: false
              }));
            }
          });
          break;
        }

        case 'dm:delete': {
          if (!ws.isAuthenticated || ws.userRole !== 'owner') {
            ws.send(JSON.stringify({ type: 'error', message: 'Only owners can delete DM conversations' }));
            return;
          }
          const { channelId } = msg;
          if (!channelId) return;

          const channels = DB.loadChannels();
          const idx = channels.findIndex(c => c.id === channelId && c.type === 'dm');
          if (idx === -1) return;

          const deletedDm = channels.splice(idx, 1)[0];
          DB.saveChannels(channels);

          // Clean up any channel-specific message files or pins if stored separately
          const channelMsgFile = path.join(DATA_DIR, 'messages', `${channelId}.json`);
          if (fs.existsSync(channelMsgFile)) {
            try { fs.unlinkSync(channelMsgFile); } catch (_) {}
          }

          if (readState) {
            let changed = false;
            Object.keys(readState).forEach(uid => {
              if (readState[uid] && readState[uid][channelId]) {
                delete readState[uid][channelId];
                changed = true;
              }
            });
            if (changed) {
              ReadState.saveReadState(readState);
            }
          }

          const targetMemberIds = new Set(deletedDm.members || []);
          if (ws.userId) targetMemberIds.add(ws.userId);
          targetMemberIds.forEach(memberId => {
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && client.userId === memberId) {
                client.send(JSON.stringify({ type: 'channel:deleted', channelId }));
              }
            });
          });
          break;
        }

        case 'server:create': {
          if (!ws.isAuthenticated || ws.userRole !== 'owner') {
            ws.send(JSON.stringify({ type: 'error', message: 'Only server owners can create new servers' }));
            return;
          }
          const name = (msg.name || '').trim().slice(0, 32);
          if (!name) {
            ws.send(JSON.stringify({ type: 'error', message: 'Server name required' }));
            return;
          }
          let servers = [];
          try {
            servers = DB.loadServers();
          } catch (_) {}
          const textCatId = crypto.randomUUID();
          const voiceCatId = crypto.randomUUID();
          const newServer = {
            id: crypto.randomUUID(),
            name,
            icon: msg.icon || '',
            ownerId: ws.userId,
            members: [ws.userId],
            categories: [
              { id: textCatId, name: 'Text Channels', order: 0 },
              { id: voiceCatId, name: 'Voice Channels', order: 1 }
            ],
            createdAt: Date.now()
          };
          servers.push(newServer);
          DB.saveServers(servers);

          const channels = DB.loadChannels();
          const defaultGeneral = {
            id: crypto.randomUUID(),
            name: 'general',
            type: 'text',
            serverId: newServer.id,
            categoryId: textCatId,
            createdAt: Date.now(),
            messages: [],
            pinned: [],
            order: 0,
            reactions: {}
          };
          channels.push(defaultGeneral);
          DB.saveChannels(channels);

          broadcastUserChannels(ws.userId);
          ws.send(JSON.stringify({ type: 'server:created', server: newServer }));
          break;
        }

        case 'server:member:add': {
          if (!ws.isAuthenticated) return;
          const { serverId, userId } = msg;
          let servers = [];
          try {
            servers = DB.loadServers();
          } catch (_) {}
          const server = servers.find(s => s.id === serverId);
          if (!server) return;
          const isServerOwner = server.ownerId === ws.userId;
          if (!isAdmin(ws.userRole) && !isServerOwner) {
            ws.send(JSON.stringify({ type: 'error', message: 'Admin or server owner required' }));
            return;
          }
          if (!server.members) server.members = [];
          if (!server.members.includes(userId)) {
            server.members.push(userId);
            DB.saveServers(servers);
            broadcastUserChannels(userId);
            const srvUpdatePayload = JSON.stringify({ type: 'server:updated', server });
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
                client.send(srvUpdatePayload);
              }
            });
          }
          break;
        }

        case 'server:member:remove': {
          if (!ws.isAuthenticated) return;
          const { serverId, userId } = msg;
          let servers = [];
          try {
            servers = DB.loadServers();
          } catch (_) {}
          const server = servers.find(s => s.id === serverId);
          if (!server) return;
          if (server.ownerId === userId) return;
          const isServerOwner = server.ownerId === ws.userId;
          if (!isAdmin(ws.userRole) && !isServerOwner && ws.userId !== userId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Admin or server owner required' }));
            return;
          }
          server.members = (server.members || []).filter(m => m !== userId);
          DB.saveServers(servers);
          broadcastUserChannels(userId);
          const srvUpdatePayload = JSON.stringify({ type: 'server:updated', server });
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
              client.send(srvUpdatePayload);
            }
          });
          break;
        }

        case 'server:update': {
          if (!ws.isAuthenticated) return;
          const { serverId, name, icon } = msg;
          if (!serverId) return;
          let servers = [];
          try {
            servers = DB.loadServers();
          } catch (_) {}
          const server = servers.find(s => s.id === serverId);
          if (!server) return;
          const isServerOwner = server.ownerId === ws.userId;
          if (!isAdmin(ws.userRole) && !isServerOwner) {
            ws.send(JSON.stringify({ type: 'error', message: 'Admin or server owner required' }));
            return;
          }
          if (name !== undefined) {
            const trimmed = (name || '').trim().slice(0, 32);
            if (trimmed) server.name = trimmed;
          }
          if (icon !== undefined) {
            server.icon = (icon || '').trim();
          }
          DB.saveServers(servers);
          (server.members || []).forEach(memberId => {
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && client.userId === memberId) {
                client.send(JSON.stringify({ type: 'server:updated', server }));
              }
            });
          });
          break;
        }

        case 'server:delete': {
          if (!ws.isAuthenticated) return;
          const { serverId } = msg;
          if (!serverId || serverId === 'default-server') {
            ws.send(JSON.stringify({ type: 'error', message: 'Default server cannot be deleted' }));
            return;
          }
          let servers = [];
          try {
            servers = DB.loadServers();
          } catch (_) {}
          const server = servers.find(s => s.id === serverId);
          if (!server) return;
          const isServerOwner = server.ownerId === ws.userId;
          if (!isAdmin(ws.userRole) && !isServerOwner) {
            ws.send(JSON.stringify({ type: 'error', message: 'Admin or server owner required' }));
            return;
          }
          const remainingServers = servers.filter(s => s.id !== serverId);
          DB.saveServers(remainingServers);

          const channels = DB.loadChannels();
          const remainingChannels = channels.filter(c => c.serverId !== serverId);
          DB.saveChannels(remainingChannels);

          (server.members || []).forEach(memberId => {
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && client.userId === memberId) {
                client.send(JSON.stringify({ type: 'server:deleted', serverId }));
                broadcastUserChannels(client.userId);
              }
            });
          });
          break;
        }

        case 'category:create': {
          if (!ws.isAuthenticated) return;
          const { serverId, name } = msg;
          let servers = [];
          try {
            servers = DB.loadServers();
          } catch (_) {}
          const server = servers.find(s => s.id === serverId);
          if (!server) return;
          const isServerOwner = server.ownerId === ws.userId;
          if (!isAdmin(ws.userRole) && !isServerOwner) {
            ws.send(JSON.stringify({ type: 'error', message: 'Admin or server owner required' }));
            return;
          }
          const catName = (name || '').trim().slice(0, 32);
          if (!catName) return;
          if (!server.categories) server.categories = [];
          const newCategory = {
            id: crypto.randomUUID(),
            name: catName,
            order: server.categories.length
          };
          server.categories.push(newCategory);
          DB.saveServers(servers);
          server.members.forEach(memberId => {
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && client.userId === memberId) {
                client.send(JSON.stringify({ type: 'category:created', serverId, category: newCategory }));
              }
            });
          });
          break;
        }

        case 'category:reorder': {
          if (!ws.isAuthenticated) return;
          const { serverId, categories } = msg;
          let servers = [];
          try {
            servers = DB.loadServers();
          } catch (_) {}
          const server = servers.find(s => s.id === serverId);
          if (!server || !Array.isArray(categories)) return;
          const isServerOwner = server.ownerId === ws.userId;
          if (!isAdmin(ws.userRole) && !isServerOwner) return;
          categories.forEach(item => {
            const cat = (server.categories || []).find(c => c.id === item.id);
            if (cat && typeof item.order === 'number') cat.order = item.order;
          });
          server.categories.sort((a, b) => (a.order || 0) - (b.order || 0));
          DB.saveServers(servers);
          server.members.forEach(memberId => {
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && client.userId === memberId) {
                client.send(JSON.stringify({ type: 'server:updated', server }));
              }
            });
          });
          break;
        }

        case 'channel:reorder': {
          if (!ws.isAuthenticated || !isAdmin(ws.userRole)) return;
          const { channelId, categoryId, order, channelIds } = msg;
          const channels = DB.loadChannels();
          if (channelId) {
            const ch = channels.find(c => c.id === channelId);
            if (!ch) return;
            if (categoryId !== undefined) ch.categoryId = categoryId;
            if (typeof order === 'number') ch.order = order;
            DB.saveChannels(channels);
            broadcast({ type: 'channel:reordered', channelId, categoryId: ch.categoryId, order: ch.order });
            break;
          }
          if (Array.isArray(channelIds) && channelIds.length > 0) {
            const nonDM = channels.filter(c => c.type !== 'dm');
            if (channelIds.length === nonDM.length && channelIds.every(id => nonDM.some(c => c.id === id))) {
              const reordered = [];
              channelIds.forEach((id, i) => {
                const ch = channels.find(c => c.id === id);
                if (ch) { ch.order = i; reordered.push(ch); }
              });
              const dms = channels.filter(c => c.type === 'dm');
              const allChannels = [...reordered, ...dms];
              DB.saveChannels(allChannels);
              wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
                  broadcastUserChannels(client.userId);
                }
              });
            }
          }
          break;
        }

        case 'user:update': {
          if (!ws.isAuthenticated) return;
          const users = DB.loadUsers();
          const targetId = msg.targetUserId || ws.userId;
          const isAdminAction = targetId !== ws.userId;

          if (isAdminAction && !isAdmin(ws.userRole)) return;

          const idx = users.findIndex(u => u.id === targetId);
          if (idx === -1) return;

          if (isAdminAction && (users[idx].role === 'owner' || (users[idx].role === 'admin' && ws.userRole !== 'owner'))) {
            ws.send(JSON.stringify({ type: 'error', message: 'Permission denied: cannot modify other administrators or owners' }));
            return;
          }

          if (msg.username !== undefined) {
            if (typeof msg.username !== 'string' || msg.username.length < 2 || msg.username.length > 20) {
              ws.send(JSON.stringify({ type: 'error', message: 'Username must be 2-20 characters' }));
              return;
            }
            if (!/^[a-zA-Z0-9_.-]+$/.test(msg.username)) {
              ws.send(JSON.stringify({ type: 'error', message: 'Username may only contain letters, numbers, underscores, periods, and hyphens' }));
              return;
            }
            if (users.find(u => u.username === msg.username && u.id !== targetId)) {
              ws.send(JSON.stringify({ type: 'error', message: 'Username already taken' }));
              return;
            }
            users[idx].username = msg.username;
            if (targetId === ws.userId) ws.username = msg.username;
          }

          if (msg.password !== undefined && !isAdminAction) {
            if (typeof msg.password !== 'string' || msg.password.length < MIN_PASSWORD_LENGTH) {
              ws.send(JSON.stringify({ type: 'error', message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }));
              return;
            }
            if (!verifyPassword(msg.currentPassword, users[idx].password)) {
              ws.send(JSON.stringify({ type: 'error', message: 'Current password is incorrect' }));
              return;
            }
            users[idx].password = hashPassword(msg.password);
            // Changing the password revokes every other session for this user
            revokeUserTokens(targetId, ws.token || null);
          }

          if (msg.aboutMe !== undefined && !isAdminAction) {
            users[idx].aboutMe = typeof msg.aboutMe === 'string' ? msg.aboutMe.slice(0, 300).trim() : '';
          }

          DB.saveUsers(users);

          wss.clients.forEach(client => {
            if (client.userId === targetId) {
              client.username = users[idx].username;
              client.userProfilePic = users[idx].profilePic;
              if (onlineUsers.has(client)) {
                onlineUsers.set(client, users[idx]);
              }
            }
          });

          voiceParticipants.forEach(participants => {
            participants.forEach(p => {
              if (p.userId === targetId) {
                p.username = users[idx].username;
                p.profilePic = users[idx].profilePic;
              }
            });
          });

          const updatedUser = {
            id: users[idx].id,
            username: users[idx].username,
            role: users[idx].role,
            profilePic: users[idx].profilePic,
            status: users[idx].status || 'online',
            customStatus: users[idx].customStatus || '',
            aboutMe: users[idx].aboutMe || ''
          };
          ws.send(JSON.stringify({ type: 'user:update:ok', user: updatedUser }));
          broadcast({ type: 'user:updated', user: updatedUser });
          broadcastOnlineUsers();
          break;
        }

        case 'user:setrole': {
          if (!ws.isAuthenticated || ws.userRole !== 'owner') return;
          const { targetUserId, role } = msg;
          if (role !== 'admin' && role !== 'user') return;
          const users = DB.loadUsers();
          const idx = users.findIndex(u => u.id === targetUserId);
          if (idx === -1 || users[idx].role === 'owner') return;
          users[idx].role = role;
          DB.saveUsers(users);

          wss.clients.forEach(client => {
            if (client.userId === targetUserId) {
              client.userRole = users[idx].role;
              if (onlineUsers.has(client)) {
                onlineUsers.set(client, users[idx]);
              }
            }
          });

          const updatedUser = {
            id: users[idx].id,
            username: users[idx].username,
            role: users[idx].role,
            profilePic: users[idx].profilePic,
            status: users[idx].status || 'online',
            customStatus: users[idx].customStatus || '',
            aboutMe: users[idx].aboutMe || ''
          };
          broadcast({ type: 'user:updated', user: updatedUser });
          broadcastOnlineUsers();
          break;
        }

        case 'admin:registration:list': {
          if (!ws.isAuthenticated || !isAdmin(ws.userRole)) return;
          ws.send(JSON.stringify({ type: 'admin:pending:list', requests: pendingRequestSummaries() }));
          break;
        }

        case 'admin:registration:approve': {
          if (!ws.isAuthenticated || !isAdmin(ws.userRole)) return;
          const req0 = String(msg.username || '');
          const pending = pendingRegistrations.get(req0);
          if (!pending || pending.expiresAt <= Date.now()) {
            if (pending) pendingRegistrations.delete(req0);
            broadcastPendingList();
            ws.send(JSON.stringify({ type: 'error', message: 'That registration request is no longer available.' }));
            return;
          }
          pendingRegistrations.delete(req0);
          const created = createApprovedAccount(pending);
          if (!created) {
            ws.send(JSON.stringify({ type: 'error', message: 'Username already taken.' }));
            return;
          }
          // Short-lived marker so the registrant's poll can auto-login
          approvedRegistrations.set(req0, { expiresAt: Date.now() + APPROVED_LOGIN_WINDOW_MS });
          console.log(`  [Mellow] Approved registration for "${req0}" as ${created.role} (by ${ws.username}).`);
          broadcastPendingList();
          break;
        }

        case 'admin:registration:deny': {
          if (!ws.isAuthenticated || !isAdmin(ws.userRole)) return;
          const reqName = String(msg.username || '');
          if (pendingRegistrations.delete(reqName)) {
            console.log(`  [Mellow] Denied registration request for "${reqName}" (by ${ws.username}).`);
          }
          broadcastPendingList();
          break;
        }

        case 'user:status:update': {
          if (!ws.isAuthenticated) return;
          const { status, customStatus } = msg;
          const validStatuses = ['online', 'idle', 'dnd', 'invisible'];
          const newStatus = validStatuses.includes(status) ? status : undefined;
          const cleanCustom = typeof customStatus === 'string' ? customStatus.slice(0, 80).trim() : (customStatus === null ? '' : undefined);

          const users = DB.loadUsers();
          const idx = users.findIndex(u => u.id === ws.userId);
          if (idx !== -1) {
            if (newStatus !== undefined) users[idx].status = newStatus;
            if (cleanCustom !== undefined) users[idx].customStatus = cleanCustom;
            DB.saveUsers(users);

            wss.clients.forEach(client => {
              if (client.userId === ws.userId && onlineUsers.has(client)) {
                onlineUsers.set(client, users[idx]);
              }
            });

            ws.send(JSON.stringify({
              type: 'user:status:updated',
              status: users[idx].status || 'online',
              customStatus: users[idx].customStatus || ''
            }));

            broadcastOnlineUsers();
          }
          break;
        }

        case 'user:kick': {
          if (!ws.isAuthenticated || !isAdmin(ws.userRole)) return;
          const users = DB.loadUsers();
          const idx = users.findIndex(u => u.id === msg.userId);
          if (idx === -1 || users[idx].role === 'owner' || (users[idx].role === 'admin' && ws.userRole !== 'owner')) return;

          const targetUser = users[idx];
          const origName = targetUser.originalUsername || targetUser.username.replace(/^deleted-user\((.*)\)$/, '$1');
          targetUser.isDeleted = true;
          targetUser.originalUsername = origName;
          targetUser.username = `deleted-user(${origName})`;
          targetUser.password = '';
          targetUser.status = 'offline';
          targetUser.customStatus = '';
          DB.saveUsers(users);

          // Clear auth tokens
          revokeUserTokens(msg.userId);

          wss.clients.forEach(client => {
            if (client.userId === msg.userId) {
              client.send(JSON.stringify({ type: 'kicked' }));
              onlineUsers.delete(client);
              client.close();
            }
          });
          broadcast({ type: 'user:kicked', userId: msg.userId, user: { id: targetUser.id, username: targetUser.username, isDeleted: true } });
          broadcastOnlineUsers();
          break;
        }

        case 'voice:join': {
          if (!ws.isAuthenticated) return;
          const { channelId } = msg;
          if (!channelId) return;

          // Validate that the channel exists and is a voice or DM channel
          const channels = DB.loadChannels();
          const channel = channels.find(c => c.id === channelId);
          if (!channel) {
            ws.send(JSON.stringify({ type: 'error', message: 'Channel not found' }));
            return;
          }
          if (channel.type !== 'voice' && channel.type !== 'dm') {
            ws.send(JSON.stringify({ type: 'error', message: 'Not a voice channel' }));
            return;
          }
          if (channel.type === 'dm' && (!channel.members || !channel.members.includes(ws.userId))) {
            ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
            return;
          }
          const servers = DB.loadServers();
          const users = DB.loadUsers();
          if (!canAccessChannel(ws.userId, channel, servers, users)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
            return;
          }

          removeFromVoice(ws);

          let participants = voiceParticipants.get(channelId);
          if (!participants) {
            participants = new Map();
            voiceParticipants.set(channelId, participants);
          }
          participants.set(ws, { ws, userId: ws.userId, username: ws.username, profilePic: ws.userProfilePic, muted: false, cameraOn: false });

          ws.voiceChannelId = channelId;

          broadcastVoiceParticipants(channelId);
          broadcastVoiceEvent(channelId, { type: 'voice:user:joined', channelId, user: { userId: ws.userId, username: ws.username, profilePic: ws.userProfilePic, muted: false, cameraOn: false } });
          break;
        }

        case 'voice:mute': {
          if (!ws.isAuthenticated || !ws.voiceChannelId) return;
          if (typeof msg.muted !== 'boolean') return;
          const room = voiceParticipants.get(ws.voiceChannelId);
          const p = room && room.get(ws);
          if (!p) return;
          p.muted = msg.muted;
          broadcastToRoom(ws.voiceChannelId, { type: 'voice:mute', channelId: ws.voiceChannelId, userId: ws.userId, muted: msg.muted }, ws);
          break;
        }

        case 'voice:camera': {
          if (!ws.isAuthenticated || !ws.voiceChannelId) return;
          if (typeof msg.cameraOn !== 'boolean') return;
          const room = voiceParticipants.get(ws.voiceChannelId);
          const p = room && room.get(ws);
          if (!p) return;
          p.cameraOn = msg.cameraOn;
          broadcastToRoom(ws.voiceChannelId, { type: 'voice:camera', channelId: ws.voiceChannelId, userId: ws.userId, cameraOn: msg.cameraOn }, ws);
          break;
        }

        case 'voice:leave': {
          if (!ws.isAuthenticated) return;
          const leaveChannelId = ws.voiceChannelId || msg.channelId;
          if (leaveChannelId) {
            if (screenSharers.has(ws.userId)) {
              screenSharers.delete(ws.userId);
              broadcast({ type: 'voice:screen:stopped', channelId: leaveChannelId, userId: ws.userId });
            }
            removeFromVoice(ws);
            ws.voiceChannelId = null;
          }
          break;
        }

        case 'voice:screen:start': {
          if (!ws.isAuthenticated || !ws.voiceChannelId) return;
          screenSharers.set(ws.userId, ws.voiceChannelId);
          const startParticipants = voiceParticipants.get(ws.voiceChannelId);
          if (startParticipants) {
            startParticipants.forEach(p => {
              if (p.ws.readyState === WebSocket.OPEN && p.userId !== ws.userId) {
                p.ws.send(JSON.stringify({ type: 'voice:screen:started', channelId: ws.voiceChannelId, userId: ws.userId, username: ws.username }));
              }
            });
          }
          break;
        }

        case 'voice:screen:stop': {
          if (!ws.isAuthenticated || !ws.voiceChannelId) return;
          screenSharers.delete(ws.userId);
          const stopParticipants = voiceParticipants.get(ws.voiceChannelId);
          if (stopParticipants) {
            stopParticipants.forEach(p => {
              if (p.ws.readyState === WebSocket.OPEN && p.userId !== ws.userId) {
                p.ws.send(JSON.stringify({ type: 'voice:screen:stopped', channelId: ws.voiceChannelId, userId: ws.userId }));
              }
            });
          }
          break;
        }

        case 'voice:offer': {
          if (!ws.isAuthenticated) return;
          const { channelId, sdp, targetUserId } = msg;
          
          // Validate that the user is in this voice channel
          if (ws.voiceChannelId !== channelId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Not in this voice channel' }));
            return;
          }
          
          const participants = voiceParticipants.get(channelId);
          if (!participants) return;
          
          // Validate target user exists in the channel
          let targetFound = false;
          participants.forEach((p) => {
            if (p.userId === targetUserId) targetFound = true;
          });
          if (!targetFound) {
            ws.send(JSON.stringify({ type: 'error', message: 'Target user not in channel' }));
            return;
          }
          
          participants.forEach((p) => {
            if (p.userId === targetUserId && p.ws.readyState === WebSocket.OPEN) {
              p.ws.send(JSON.stringify({ type: 'voice:offer', sdp, userId: ws.userId }));
            }
          });
          break;
        }

        case 'voice:answer': {
          if (!ws.isAuthenticated) return;
          const { channelId, sdp, targetUserId } = msg;
          
          // Validate that the user is in this voice channel
          if (ws.voiceChannelId !== channelId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Not in this voice channel' }));
            return;
          }
          
          const participants = voiceParticipants.get(channelId);
          if (!participants) return;
          
          participants.forEach((p) => {
            if (p.userId === targetUserId && p.ws.readyState === WebSocket.OPEN) {
              p.ws.send(JSON.stringify({ type: 'voice:answer', sdp, userId: ws.userId }));
            }
          });
          break;
        }

        case 'voice:ice-candidate': {
          if (!ws.isAuthenticated) return;
          const { channelId, candidate, targetUserId } = msg;
          
          // Validate that the user is in this voice channel
          if (ws.voiceChannelId !== channelId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Not in this voice channel' }));
            return;
          }
          
          const participants = voiceParticipants.get(channelId);
          if (!participants) return;
          
          participants.forEach((p) => {
            if (p.userId === targetUserId && p.ws.readyState === WebSocket.OPEN) {
              p.ws.send(JSON.stringify({ type: 'voice:ice-candidate', candidate, userId: ws.userId }));
            }
          });
          break;
        }

        case 'voice:speaking': {
          if (!ws.isAuthenticated) return;
          const { channelId, speaking } = msg;
          
          // Validate that the user is in this voice channel
          if (ws.voiceChannelId !== channelId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Not in this voice channel' }));
            return;
          }
          
          // Validate speaking is a boolean
          if (typeof speaking !== 'boolean') {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid speaking value' }));
            return;
          }
          
          broadcastToRoom(channelId, { type: 'voice:speaking', channelId, userId: ws.userId, speaking });
          break;
        }

        case 'typing:start': {
          if (!ws.isAuthenticated || !ws.channelId) return;
          const channels = DB.loadChannels();
          const channel = channels.find(c => c.id === ws.channelId);
          const servers = DB.loadServers();
          const users = DB.loadUsers();
          if (!channel || !canAccessChannel(ws.userId, channel, servers, users)) return;
          const typingMsg = JSON.stringify({ type: 'typing:start', channelId: ws.channelId, userId: ws.userId, username: ws.username });
          wss.clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN && client.isAuthenticated && canAccessChannel(client.userId, channel, servers, users)) {
              client.send(typingMsg);
            }
          });
          break;
        }

        case 'typing:stop': {
          if (!ws.isAuthenticated || !ws.channelId) return;
          const channels = DB.loadChannels();
          const channel = channels.find(c => c.id === ws.channelId);
          const servers = DB.loadServers();
          const users = DB.loadUsers();
          if (!channel || !canAccessChannel(ws.userId, channel, servers, users)) return;
          const typingMsg = JSON.stringify({ type: 'typing:stop', channelId: ws.channelId, userId: ws.userId });
          wss.clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN && client.isAuthenticated && canAccessChannel(client.userId, channel, servers, users)) {
              client.send(typingMsg);
            }
          });
          break;
        }

        case 'message:pin': {
          if (!ws.isAuthenticated) return;
          const { channelId, messageId } = msg;
          const channels = DB.loadChannels();
          const channel = channels.find(c => c.id === channelId);
          const servers = DB.loadServers();
          const users = DB.loadUsers();
          if (!channel || !canAccessChannel(ws.userId, channel, servers, users)) return;
          if (!isAdmin(ws.userRole) && channel.type !== 'dm') return;

          const message = channel.messages.find(m => m.id === messageId);
          if (!message) return;
          if (!channel.pinned) channel.pinned = [];
          if (channel.pinned.find(p => p.messageId === messageId)) return;
          const preview = (message.text || (message.files && message.files.length ? message.files[0].name : '')).substring(0, 80);
          const pinRecord = { messageId, text: preview, pinnedBy: ws.username, pinnedAt: Date.now() };
          channel.pinned.push(pinRecord);
          DB.pinMessage(channel.id, pinRecord);

          const pinMsg = JSON.stringify({ type: 'message:pin', channelId, messageId, text: preview, pinnedBy: ws.username, pinnedAt: Date.now() });
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.isAuthenticated && canAccessChannel(client.userId, channel, servers, users)) {
              client.send(pinMsg);
            }
          });
          break;
        }

        case 'message:unpin': {
          if (!ws.isAuthenticated) return;
          const { channelId, messageId } = msg;
          const channels = DB.loadChannels();
          const channel = channels.find(c => c.id === channelId);
          const servers = DB.loadServers();
          const users = DB.loadUsers();
          if (!channel || !canAccessChannel(ws.userId, channel, servers, users)) return;
          if (!isAdmin(ws.userRole) && channel.type !== 'dm') return;
          if (!channel.pinned) return;

          const idx = channel.pinned.findIndex(p => p.messageId === messageId);
          if (idx === -1) return;
          channel.pinned.splice(idx, 1);
          DB.unpinMessage(channel.id, messageId);

          const unpinMsg = JSON.stringify({ type: 'message:unpin', channelId, messageId });
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.isAuthenticated && canAccessChannel(client.userId, channel, servers, users)) {
              client.send(unpinMsg);
            }
          });
          break;
        }

        case 'dm:call:start': {
          if (!ws.isAuthenticated) return;
          const { channelId } = msg;
          if (!channelId) return;
          const channels = DB.loadChannels();
          const channel = channels.find(c => c.id === channelId);
          if (!channel || channel.type !== 'dm' || !channel.members || !channel.members.includes(ws.userId)) {
            ws.send(JSON.stringify({ type: 'dm:call:failed', channelId, reason: 'Invalid DM channel' }));
            return;
          }
          const targetUserId = channel.members.find(m => m !== ws.userId);
          if (!targetUserId) {
            ws.send(JSON.stringify({ type: 'dm:call:failed', channelId, reason: 'No recipient in DM' }));
            return;
          }

          let recipientFound = false;
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.isAuthenticated && client.userId === targetUserId) {
              recipientFound = true;
              client.send(JSON.stringify({
                type: 'dm:call:incoming',
                channelId,
                caller: {
                  id: ws.userId,
                  username: ws.username,
                  profilePic: ws.userProfilePic || ''
                }
              }));
            }
          });

          if (!recipientFound) {
            ws.send(JSON.stringify({ type: 'dm:call:failed', channelId, reason: 'User is offline' }));
          } else {
            ws.send(JSON.stringify({ type: 'dm:call:ringing', channelId, targetUserId }));
          }
          break;
        }

        case 'dm:call:accept': {
          if (!ws.isAuthenticated) return;
          const { channelId } = msg;
          if (!channelId) return;
          const channels = DB.loadChannels();
          const channel = channels.find(c => c.id === channelId);
          if (!channel || channel.type !== 'dm' || !channel.members || !channel.members.includes(ws.userId)) return;

          const targetUserId = channel.members.find(m => m !== ws.userId);
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.isAuthenticated && client.userId === targetUserId) {
              client.send(JSON.stringify({
                type: 'dm:call:accepted',
                channelId,
                accepterId: ws.userId
              }));
            }
          });
          break;
        }

        case 'dm:call:decline': {
          if (!ws.isAuthenticated) return;
          const { channelId } = msg;
          if (!channelId) return;
          const channels = DB.loadChannels();
          const channel = channels.find(c => c.id === channelId);
          if (!channel || channel.type !== 'dm' || !channel.members || !channel.members.includes(ws.userId)) return;

          const targetUserId = channel.members.find(m => m !== ws.userId);
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.isAuthenticated && client.userId === targetUserId) {
              client.send(JSON.stringify({
                type: 'dm:call:declined',
                channelId,
                declinerId: ws.userId
              }));
            }
          });
          break;
        }

        case 'dm:call:cancel': {
          if (!ws.isAuthenticated) return;
          const { channelId } = msg;
          if (!channelId) return;
          const channels = DB.loadChannels();
          const channel = channels.find(c => c.id === channelId);
          if (!channel || channel.type !== 'dm' || !channel.members || !channel.members.includes(ws.userId)) return;

          const targetUserId = channel.members.find(m => m !== ws.userId);
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.isAuthenticated && client.userId === targetUserId) {
              client.send(JSON.stringify({
                type: 'dm:call:cancelled',
                channelId,
                callerId: ws.userId
              }));
            }
          });
          break;
        }

        case 'message:react': {
          if (!ws.isAuthenticated) return;
          const { channelId, messageId, emoji } = msg;
          if (!channelId || !messageId || !emoji) return;
          const channels = DB.loadChannels();
          const channel = channels.find(c => c.id === channelId);
          const servers = DB.loadServers();
          const users = DB.loadUsers();
          if (!channel || !canAccessChannel(ws.userId, channel, servers, users)) return;

          const message = channel.messages.find(m => m.id === messageId);
          if (!message) return;
          if (!message.reactions) message.reactions = {};
          if (!message.reactions[emoji]) message.reactions[emoji] = [];
          const userIdx = message.reactions[emoji].indexOf(ws.userId);
          if (userIdx !== -1) {
            message.reactions[emoji].splice(userIdx, 1);
            if (message.reactions[emoji].length === 0) delete message.reactions[emoji];
          } else {
            message.reactions[emoji].push(ws.userId);
          }
          DB.setMessageReactions(channel.id, messageId, message.reactions);

          const reactMsg = JSON.stringify({ type: 'message:reacted', channelId, messageId, reactions: message.reactions });
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.isAuthenticated && canAccessChannel(client.userId, channel, servers, users)) {
              client.send(reactMsg);
            }
          });
          break;
        }
      }
    } catch (e) {
      console.error('WS error:', e);
    }
  });

  ws.on('close', () => {
    if (screenSharers.has(ws.userId)) {
      const chId = screenSharers.get(ws.userId);
      screenSharers.delete(ws.userId);
      const parts = voiceParticipants.get(chId);
      if (parts) {
        parts.forEach(p => {
          if (p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify({ type: 'voice:screen:stopped', channelId: chId, userId: ws.userId }));
          }
        });
      }
    }
    onlineUsers.delete(ws);
    removeFromVoice(ws);
    broadcastOnlineUsers();
  });
});

if (require.main === module) {
  init();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`mellow-server running on https://0.0.0.0:${PORT}`);
  });
  const Discovery = require('./server/discovery.js');
  try {
    Discovery.start({ port: PORT + 1, servicePort: PORT, https: useHttps });
    console.log(`LAN discovery answering UDP broadcasts on :${PORT + 1}`);
  } catch (e) {
    console.warn('Discovery disabled:', e.message);
  }
}

module.exports = {
  getDefaultAvatar,
  init,
  server,
  app,
  isAdmin,
  canAccessChannel,
  hashPassword,
  verifyPassword,
  passwordNeedsUpgrade,
  extractToken,
  safeUploadExt,
  isEmbedAllowedHost
};