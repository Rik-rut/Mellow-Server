'use strict';
/*
 * server/db.js — SQLite persistence layer (node:sqlite, built-in on Node 22.5+).
 *
 * Replaces the legacy JSON-file store with a single SQLite database
 * (data/mellow.db) using WAL mode for crash safety. Exposes:
 *
 *   - open(dir)       open/create the database, ensure schema
 *   - importLegacy()  one-time transactional migration from data/*.json →
 *                     mellow.db, then rename originals to *.legacy.json
 *   - load*()         hydrate the exact object shapes the server handlers
 *                     have always used (fresh read on every call)
 *   - save*()         granular, transactional writers
 *
 * All calls are synchronous, matching the previous sync-fs write model.
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DB_FILE = 'mellow.db';
const SCHEMA_VERSION = 1;

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  profilePic TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'online',
  customStatus TEXT NOT NULL DEFAULT '',
  aboutMe TEXT NOT NULL DEFAULT '',
  isDeleted INTEGER NOT NULL DEFAULT 0,
  originalUsername TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  ownerId TEXT NOT NULL DEFAULT '',
  createdAt INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS server_members (
  serverId TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  userId TEXT NOT NULL,
  PRIMARY KEY (serverId, userId)
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  serverId TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'text',
  serverId TEXT,
  categoryId TEXT,
  createdAt INTEGER NOT NULL DEFAULT 0,
  ord INTEGER NOT NULL DEFAULT 0,
  isPrivate INTEGER NOT NULL DEFAULT 0,
  lastMessageAt INTEGER NOT NULL DEFAULT 0,
  reactions TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS channel_members (
  channelId TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  userId TEXT NOT NULL,
  PRIMARY KEY (channelId, userId)
);

CREATE TABLE IF NOT EXISTS channel_allowed (
  channelId TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  userId TEXT NOT NULL,
  PRIMARY KEY (channelId, userId)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channelId TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  userId TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL DEFAULT '[]',
  timestamp INTEGER NOT NULL DEFAULT 0,
  profilePic TEXT NOT NULL DEFAULT '',
  reactions TEXT NOT NULL DEFAULT '{}',
  editedAt INTEGER,
  replyTo TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channelId, timestamp);

CREATE TABLE IF NOT EXISTS pins (
  channelId TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  messageId TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  pinnedBy TEXT NOT NULL DEFAULT '',
  pinnedAt INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channelId, messageId)
);

CREATE TABLE IF NOT EXISTS read_state (
  userId TEXT NOT NULL,
  channelId TEXT NOT NULL,
  lastRead INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (userId, channelId)
);

CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  expiresAt INTEGER NOT NULL DEFAULT 0
);
`;

function isOpen() {
  return !!db;
}

function getRawDb() {
  return db;
}

function open(dataDir) {
  if (db) return db;
  if (!dataDir) throw new Error('db.open: dataDir required');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, DB_FILE);

  const fresh = !fs.existsSync(file);
  db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');

  // Switching journal mode needs a brief exclusive lock; if another process
  // (or test runner) holds the database, retry a few times before giving up.
  const currentMode = db.prepare('PRAGMA journal_mode').get().journal_mode;
  if (currentMode !== 'wal') {
    let switched = false;
    for (let i = 0; i < 20 && !switched; i++) {
      try {
        db.exec('PRAGMA journal_mode = WAL');
        switched = true;
      } catch (_) {
        if (i < 19) {
          try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } catch (_) {}
        }
      }
    }
    if (!switched) console.warn('[db] could not enable WAL journal mode');
  }
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  let integrity = 'ok';
  try {
    const row = db.prepare('PRAGMA integrity_check').get();
    integrity = row && row.integrity_check;
  } catch (e) {
    integrity = 'error: ' + e.message;
  }
  if (integrity !== 'ok') {
    console.warn('[db] integrity_check: ' + integrity);
  } else if (!fresh) {
    console.log('[db] mellow.db integrity check passed');
  }
  return db;
}

function close() {
  if (db) {
    try { db.close(); } catch (_) {}
    db = null;
  }
}

function inTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

function jsonParse(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

/* ── Legacy JSON migration ─────────────────────────────────────────────── */

function legacyFiles(dataDir) {
  return {
    users: path.join(dataDir, 'users.json'),
    servers: path.join(dataDir, 'servers.json'),
    channels: path.join(dataDir, 'channels.json'),
    readState: path.join(dataDir, 'readState.json'),
    tokens: path.join(dataDir, 'tokens.json')
  };
}

function hasLegacy(dataDir) {
  const files = legacyFiles(dataDir);
  return Object.values(files).some(f => fs.existsSync(f));
}

function legacyReadArray(file, fallback) {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (err) {
    console.warn(`[db] Legacy file ${path.basename(file)} failed to parse:`, err.message);
    return undefined; // exists but unreadable
  }
}

/*
 * Import legacy JSON files into the database in a single transaction.
 * Each file is handled independently: unreadable files are left in place,
 * imported files are renamed to *.legacy.json after a successful commit.
 * Returns { files: { users, servers, channels, readState, tokens } } where
 * each value is true when that file was imported, false when absent.
 */
function importLegacy(dataDir) {
  const files = legacyFiles(dataDir);
  const result = { files: { users: false, servers: false, channels: false, readState: false, tokens: false } };
  if (!db || !hasLegacy(dataDir)) return result;

  // Idempotency guard: if the database already holds data (e.g. a previous
  // process migrated it), skip the import so a second process cannot
  // double-insert and hit UNIQUE constraints.
  const alreadyImported = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  if (alreadyImported) return result;

  const users = legacyReadArray(files.users, []);
  const servers = legacyReadArray(files.servers, []);
  const channels = legacyReadArray(files.channels, []);
  const tokens = legacyReadArray(files.tokens, []);
  let readState = null;
  if (fs.existsSync(files.readState)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(files.readState, 'utf8'));
      if (parsed && typeof parsed === 'object') readState = parsed;
    } catch (err) {
      console.warn('[db] Legacy readState.json failed to parse:', err.message);
    }
  }

  const stamp = Date.now();
  inTransaction(() => {
    const insUser = db.prepare(`INSERT INTO users (id, username, password, role, profilePic, status, customStatus, aboutMe, isDeleted, originalUsername)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const seenUsernames = new Set();
    users.forEach(u => {
      if (!u || typeof u.id !== 'string') return;
      if (seenUsernames.has(u.username)) return;
      seenUsernames.add(u.username);
      insUser.run(
        u.id,
        String(u.username || u.id),
        typeof u.password === 'string' ? u.password : '',
        typeof u.role === 'string' ? u.role : 'user',
        typeof u.profilePic === 'string' ? u.profilePic : '',
        typeof u.status === 'string' ? u.status : 'online',
        typeof u.customStatus === 'string' ? u.customStatus : '',
        typeof u.aboutMe === 'string' ? u.aboutMe : '',
        !!u.isDeleted ? 1 : 0,
        typeof u.originalUsername === 'string' ? u.originalUsername : ''
      );
    });

    const insServer = db.prepare(`INSERT INTO servers (id, name, icon, ownerId, createdAt) VALUES (?, ?, ?, ?, ?)`);
    const insMember = db.prepare('INSERT OR IGNORE INTO server_members (serverId, userId) VALUES (?, ?)');
    const insCategory = db.prepare('INSERT INTO categories (id, serverId, name, ord) VALUES (?, ?, ?, ?)');
    servers.forEach(s => {
      if (!s || typeof s.id !== 'string') return;
      insServer.run(
        s.id,
        String(s.name || ''),
        typeof s.icon === 'string' ? s.icon : '',
        typeof s.ownerId === 'string' ? s.ownerId : '',
        typeof s.createdAt === 'number' ? s.createdAt : stamp
      );
      (Array.isArray(s.members) ? s.members : []).forEach(mid => {
        if (typeof mid === 'string') insMember.run(s.id, mid);
      });
      (Array.isArray(s.categories) ? s.categories : []).forEach(c => {
        if (!c || typeof c.id !== 'string') return;
        insCategory.run(c.id, s.id, String(c.name || ''), typeof c.order === 'number' ? c.order : 0);
      });
    });

    const insChannel = db.prepare(`INSERT INTO channels (id, name, type, serverId, categoryId, createdAt, ord, isPrivate, lastMessageAt, reactions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insChanMember = db.prepare('INSERT OR IGNORE INTO channel_members (channelId, userId) VALUES (?, ?)');
    const insChanAllowed = db.prepare('INSERT OR IGNORE INTO channel_allowed (channelId, userId) VALUES (?, ?)');
    const insMessage = db.prepare(`INSERT INTO messages (id, channelId, userId, username, text, files, timestamp, profilePic, reactions, editedAt, replyTo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insPin = db.prepare('INSERT OR IGNORE INTO pins (channelId, messageId, text, pinnedBy, pinnedAt) VALUES (?, ?, ?, ?, ?)');

    let sequence = 0;
    channels.forEach(ch => {
      if (!ch || typeof ch.id !== 'string') return;
      const isDm = ch.type === 'dm';
      insChannel.run(
        ch.id,
        isDm ? '' : String(ch.name || ''),
        String(ch.type || 'text'),
        isDm ? null : (typeof ch.serverId === 'string' ? ch.serverId : (ch.serverId || 'default-server')),
        isDm ? null : (typeof ch.categoryId === 'string' ? ch.categoryId : undefined),
        typeof ch.createdAt === 'number' ? ch.createdAt : stamp,
        typeof ch.order === 'number' ? ch.order : sequence,
        !!ch.isPrivate ? 1 : 0,
        typeof ch.lastMessageAt === 'number' ? ch.lastMessageAt : 0,
        JSON.stringify(ch.reactions && typeof ch.reactions === 'object' ? ch.reactions : {})
      );
      sequence += 1;
      (Array.isArray(ch.members) ? ch.members : []).forEach(mid => {
        if (typeof mid === 'string') insChanMember.run(ch.id, mid);
      });
      (Array.isArray(ch.allowedMembers) ? ch.allowedMembers : []).forEach(mid => {
        if (typeof mid === 'string') insChanAllowed.run(ch.id, mid);
      });
      (Array.isArray(ch.messages) ? ch.messages : []).forEach(m => {
        if (!m || typeof m.id !== 'string') return;
        insMessage.run(
          m.id,
          ch.id,
          typeof m.userId === 'string' ? m.userId : '',
          String(m.username || ''),
          typeof m.text === 'string' ? m.text : '',
          JSON.stringify(Array.isArray(m.files) ? m.files : (m.file ? [m.file] : [])),
          typeof m.timestamp === 'number' ? m.timestamp : 0,
          typeof m.profilePic === 'string' ? m.profilePic : '',
          JSON.stringify(m.reactions && typeof m.reactions === 'object' ? m.reactions : {}),
          typeof m.editedAt === 'number' ? m.editedAt : null,
          m.replyTo && typeof m.replyTo === 'object' ? JSON.stringify(m.replyTo) : null
        );
      });
      (Array.isArray(ch.pinned) ? ch.pinned : []).forEach(p => {
        if (!p || typeof p.messageId !== 'string') return;
        insPin.run(ch.id, p.messageId, String(p.text || ''), String(p.pinnedBy || ''), typeof p.pinnedAt === 'number' ? p.pinnedAt : 0);
      });
    });

    if (readState) {
      const insRead = db.prepare('INSERT OR REPLACE INTO read_state (userId, channelId, lastRead) VALUES (?, ?, ?)');
      Object.keys(readState).forEach(uid => {
        const perChannel = readState[uid];
        if (!perChannel || typeof perChannel !== 'object') return;
        Object.keys(perChannel).forEach(cid => {
          if (typeof perChannel[cid] === 'number') insRead.run(uid, cid, perChannel[cid]);
        });
      });
    }

    const insToken = db.prepare('INSERT OR IGNORE INTO tokens (token, userId, expiresAt) VALUES (?, ?, ?)');
    tokens.forEach(([t, v]) => {
      if (!t || !v || typeof v !== 'object') return;
      if (typeof v.userId === 'string' && typeof v.expiresAt === 'number') {
        insToken.run(t, v.userId, v.expiresAt);
      } else if (typeof v.id === 'string') {
        insToken.run(t, v.id, Date.now() + 30 * 24 * 60 * 60 * 1000);
      }
    });
  });

  const renames = { users, servers, channels, readState: readState !== null ? readState : null, tokens };
  if (users !== null) { try { fs.renameSync(files.users, files.users + '.legacy.json'); result.files.users = true; } catch (_) {} }
  if (servers !== null) { try { fs.renameSync(files.servers, files.servers + '.legacy.json'); result.files.servers = true; } catch (_) {} }
  if (channels !== null) { try { fs.renameSync(files.channels, files.channels + '.legacy.json'); result.files.channels = true; } catch (_) {} }
  if (readState !== null) { try { fs.renameSync(files.readState, files.readState + '.legacy.json'); result.files.readState = true; } catch (_) {} }
  if (tokens !== null) { try { fs.renameSync(files.tokens, files.tokens + '.legacy.json'); result.files.tokens = true; } catch (_) {} }

  const imported = Object.values(result.files).some(v => v);
  if (imported) console.log('[db] Migrated legacy JSON data into mellow.db (.legacy.json backups kept)');

  return result;
}

/* ── Loaders (fresh read, same shapes the old JSON store produced) ────── */

function loadUsers() {
  if (!db) return [];
  const rows = db.prepare('SELECT * FROM users').all();
  return rows.map(r => ({
    id: r.id,
    username: r.username,
    password: r.password,
    role: r.role,
    profilePic: r.profilePic,
    status: r.status || 'online',
    customStatus: r.customStatus || '',
    aboutMe: r.aboutMe || '',
    isDeleted: !!r.isDeleted,
    originalUsername: r.originalUsername || ''
  }));
}

function loadServers() {
  if (!db) return [];
  const serverRows = db.prepare('SELECT * FROM servers').all();
  const memberRows = db.prepare('SELECT serverId, userId FROM server_members').all();
  const categoryRows = db.prepare('SELECT * FROM categories ORDER BY ord ASC').all();
  const membersByServer = new Map();
  memberRows.forEach(r => {
    if (!membersByServer.has(r.serverId)) membersByServer.set(r.serverId, []);
    membersByServer.get(r.serverId).push(r.userId);
  });
  const categoriesByServer = new Map();
  categoryRows.forEach(r => {
    if (!categoriesByServer.has(r.serverId)) categoriesByServer.set(r.serverId, []);
    categoriesByServer.get(r.serverId).push({ id: r.id, name: r.name, order: r.ord });
  });
  return serverRows.map(r => ({
    id: r.id,
    name: r.name,
    icon: r.icon,
    ownerId: r.ownerId,
    members: membersByServer.get(r.id) || [],
    categories: categoriesByServer.get(r.id) || [],
    createdAt: r.createdAt
  }));
}

function loadChannels() {
  if (!db) return [];
  const channelRows = db.prepare('SELECT * FROM channels ORDER BY CASE WHEN type = \'dm\' THEN 1 ELSE 0 END ASC, ord ASC, rowid ASC').all();
  const memberRows = db.prepare('SELECT channelId, userId FROM channel_members').all();
  const allowedRows = db.prepare('SELECT channelId, userId FROM channel_allowed').all();
  const messageRows = db.prepare('SELECT * FROM messages ORDER BY timestamp ASC, id ASC').all();
  const pinRows = db.prepare('SELECT * FROM pins').all();

  const membersByChannel = new Map();
  memberRows.forEach(r => {
    if (!membersByChannel.has(r.channelId)) membersByChannel.set(r.channelId, []);
    membersByChannel.get(r.channelId).push(r.userId);
  });
  const allowedByChannel = new Map();
  allowedRows.forEach(r => {
    if (!allowedByChannel.has(r.channelId)) allowedByChannel.set(r.channelId, []);
    allowedByChannel.get(r.channelId).push(r.userId);
  });
  const messagesByChannel = new Map();
  messageRows.forEach(r => {
    if (!messagesByChannel.has(r.channelId)) messagesByChannel.set(r.channelId, []);
    const msg = {
      id: r.id,
      userId: r.userId,
      username: r.username,
      text: r.text,
      files: jsonParse(r.files, []),
      timestamp: r.timestamp,
      profilePic: r.profilePic,
      reactions: jsonParse(r.reactions, {})
    };
    if (typeof r.editedAt === 'number') msg.editedAt = r.editedAt;
    const replyTo = jsonParse(r.replyTo, null);
    if (replyTo) msg.replyTo = replyTo;
    messagesByChannel.get(r.channelId).push(msg);
  });
  const pinsByChannel = new Map();
  pinRows.forEach(r => {
    if (!pinsByChannel.has(r.channelId)) pinsByChannel.set(r.channelId, []);
    pinsByChannel.get(r.channelId).push({ messageId: r.messageId, text: r.text, pinnedBy: r.pinnedBy, pinnedAt: r.pinnedAt });
  });

  return channelRows.map(r => {
    const isDm = r.type === 'dm';
    const ch = {
      id: r.id,
      type: r.type,
      createdAt: r.createdAt,
      messages: messagesByChannel.get(r.id) || [],
      pinned: pinsByChannel.get(r.id) || [],
      order: r.ord
    };
    if (typeof r.lastMessageAt === 'number' && r.lastMessageAt > 0) ch.lastMessageAt = r.lastMessageAt;
    ch.reactions = jsonParse(r.reactions, {});
    if (isDm) {
      ch.members = membersByChannel.get(r.id) || [];
    } else {
      ch.name = r.name;
      ch.serverId = r.serverId || 'default-server';
      ch.categoryId = r.categoryId;
      ch.isPrivate = !!r.isPrivate;
      ch.allowedMembers = allowedByChannel.get(r.id) || [];
    }
    return ch;
  });
}

function loadReadState() {
  if (!db) return {};
  const rows = db.prepare('SELECT userId, channelId, lastRead FROM read_state').all();
  const state = {};
  rows.forEach(r => {
    if (!state[r.userId]) state[r.userId] = {};
    state[r.userId][r.channelId] = r.lastRead;
  });
  return state;
}

/*
 * Returns raw [token, session] entries (same shape as the old tokens.json),
 * or [] when nothing is persisted. Old-format entries (full user object)
 * are returned too; the caller decides how to interpret them.
 */
function loadTokenEntries() {
  if (!db) return [];
  const rows = db.prepare('SELECT token, userId, expiresAt FROM tokens').all();
  return rows.map(r => [r.token, { userId: r.userId, expiresAt: r.expiresAt }]);
}

/* ── Writers (granular, transactional) ─────────────────────────────────── */

function saveUsers(users) {
  if (!db) return;
  inTransaction(() => {
    db.prepare('DELETE FROM users').run();
    const ins = db.prepare(`INSERT INTO users (id, username, password, role, profilePic, status, customStatus, aboutMe, isDeleted, originalUsername)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    users.forEach(u => {
      ins.run(
        u.id,
        String(u.username || u.id),
        typeof u.password === 'string' ? u.password : '',
        typeof u.role === 'string' ? u.role : 'user',
        typeof u.profilePic === 'string' ? u.profilePic : '',
        typeof u.status === 'string' ? u.status : 'online',
        typeof u.customStatus === 'string' ? u.customStatus : '',
        typeof u.aboutMe === 'string' ? u.aboutMe : '',
        !!u.isDeleted ? 1 : 0,
        typeof u.originalUsername === 'string' ? u.originalUsername : ''
      );
    });
  });
}

function saveServers(servers) {
  if (!db) return;
  inTransaction(() => {
    const keep = new Set(servers.map(s => s.id));
    const existing = db.prepare('SELECT id FROM servers').all();
    const delServer = db.prepare('DELETE FROM servers WHERE id = ?');
    existing.forEach(r => {
      if (!keep.has(r.id)) delServer.run(r.id);
    });

    const upsert = db.prepare(`INSERT INTO servers (id, name, icon, ownerId, createdAt) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon, ownerId = excluded.ownerId, createdAt = excluded.createdAt`);
    const delMember = db.prepare('DELETE FROM server_members WHERE serverId = ?');
    const insMember = db.prepare('INSERT OR IGNORE INTO server_members (serverId, userId) VALUES (?, ?)');
    const delCategory = db.prepare('DELETE FROM categories WHERE serverId = ?');
    const insCategory = db.prepare('INSERT INTO categories (id, serverId, name, ord) VALUES (?, ?, ?, ?)');

    servers.forEach(s => {
      upsert.run(s.id, String(s.name || ''), typeof s.icon === 'string' ? s.icon : '', typeof s.ownerId === 'string' ? s.ownerId : '', typeof s.createdAt === 'number' ? s.createdAt : 0);
      delMember.run(s.id);
      (Array.isArray(s.members) ? s.members : []).forEach(mid => {
        if (typeof mid === 'string') insMember.run(s.id, mid);
      });
      delCategory.run(s.id);
      (Array.isArray(s.categories) ? s.categories : []).forEach(c => {
        if (!c || typeof c.id !== 'string') return;
        insCategory.run(c.id, s.id, String(c.name || ''), typeof c.order === 'number' ? c.order : 0);
      });
    });
  });
}

function saveChannels(channels) {
  if (!db) return;
  inTransaction(() => {
    const keep = new Set(channels.map(c => c.id));
    const existing = db.prepare('SELECT id FROM channels').all();
    const delChannel = db.prepare('DELETE FROM channels WHERE id = ?');
    existing.forEach(r => {
      if (!keep.has(r.id)) delChannel.run(r.id); // cascades members/allowed/messages/pins
    });

    const upsert = db.prepare(`INSERT INTO channels (id, name, type, serverId, categoryId, createdAt, ord, isPrivate, lastMessageAt, reactions)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type, serverId = excluded.serverId,
        categoryId = excluded.categoryId, createdAt = excluded.createdAt, ord = excluded.ord,
        isPrivate = excluded.isPrivate, lastMessageAt = excluded.lastMessageAt, reactions = excluded.reactions`);
    const delMember = db.prepare('DELETE FROM channel_members WHERE channelId = ?');
    const insMember = db.prepare('INSERT OR IGNORE INTO channel_members (channelId, userId) VALUES (?, ?)');
    const delAllowed = db.prepare('DELETE FROM channel_allowed WHERE channelId = ?');
    const insAllowed = db.prepare('INSERT OR IGNORE INTO channel_allowed (channelId, userId) VALUES (?, ?)');

    channels.forEach((ch, i) => {
      const isDm = ch.type === 'dm';
      const lastMessageAt = typeof ch.lastMessageAt === 'number' ? ch.lastMessageAt : 0;
      const reactions = ch.reactions && typeof ch.reactions === 'object' ? JSON.stringify(ch.reactions) : '{}';
      upsert.run(
        ch.id,
        isDm ? '' : String(ch.name || ''),
        String(ch.type || 'text'),
        isDm ? null : (typeof ch.serverId === 'string' ? ch.serverId : 'default-server'),
        isDm ? null : (typeof ch.categoryId === 'string' ? ch.categoryId : undefined),
        typeof ch.createdAt === 'number' ? ch.createdAt : 0,
        typeof ch.order === 'number' ? ch.order : i,
        !!ch.isPrivate ? 1 : 0,
        lastMessageAt,
        reactions
      );
      delMember.run(ch.id);
      (Array.isArray(ch.members) ? ch.members : []).forEach(mid => {
        if (typeof mid === 'string') insMember.run(ch.id, mid);
      });
      delAllowed.run(ch.id);
      (Array.isArray(ch.allowedMembers) ? ch.allowedMembers : []).forEach(mid => {
        if (typeof mid === 'string') insAllowed.run(ch.id, mid);
      });
    });
  });
}

function appendMessage(channel, message) {
  if (!db) return;
  inTransaction(() => {
    db.prepare(`INSERT INTO messages (id, channelId, userId, username, text, files, timestamp, profilePic, reactions, editedAt, replyTo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      message.id,
      channel.id,
      typeof message.userId === 'string' ? message.userId : '',
      String(message.username || ''),
      typeof message.text === 'string' ? message.text : '',
      JSON.stringify(Array.isArray(message.files) ? message.files : []),
      typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
      typeof message.profilePic === 'string' ? message.profilePic : '',
      JSON.stringify(message.reactions && typeof message.reactions === 'object' ? message.reactions : {}),
      typeof message.editedAt === 'number' ? message.editedAt : null,
      message.replyTo && typeof message.replyTo === 'object' ? JSON.stringify(message.replyTo) : null
    );
    const lastMessageAt = typeof channel.lastMessageAt === 'number' ? channel.lastMessageAt : message.timestamp;
    db.prepare('UPDATE channels SET lastMessageAt = ? WHERE id = ?').run(lastMessageAt, channel.id);
  });
}

function editMessage(channelId, messageId, text, editedAt) {
  if (!db) return;
  db.prepare('UPDATE messages SET text = ?, editedAt = ? WHERE id = ? AND channelId = ?').run(text, editedAt, messageId, channelId);
}

function deleteMessage(channelId, messageId) {
  if (!db) return;
  inTransaction(() => {
    db.prepare('DELETE FROM messages WHERE id = ? AND channelId = ?').run(messageId, channelId);
    db.prepare('DELETE FROM pins WHERE messageId = ? AND channelId = ?').run(messageId, channelId);
  });
}

function setMessageReactions(channelId, messageId, reactions) {
  if (!db) return;
  db.prepare('UPDATE messages SET reactions = ? WHERE id = ? AND channelId = ?').run(
    JSON.stringify(reactions && typeof reactions === 'object' ? reactions : {}),
    messageId,
    channelId
  );
}

function pinMessage(channelId, pin) {
  if (!db) return;
  db.prepare('INSERT OR IGNORE INTO pins (channelId, messageId, text, pinnedBy, pinnedAt) VALUES (?, ?, ?, ?, ?)').run(
    channelId,
    pin.messageId,
    typeof pin.text === 'string' ? pin.text : '',
    typeof pin.pinnedBy === 'string' ? pin.pinnedBy : '',
    typeof pin.pinnedAt === 'number' ? pin.pinnedAt : 0
  );
}

function unpinMessage(channelId, messageId) {
  if (!db) return;
  db.prepare('DELETE FROM pins WHERE channelId = ? AND messageId = ?').run(channelId, messageId);
}

/*
 * Replace every message of one channel (used only by the legacy-channel
 * normalization pass, e.g. profilePic/reactions backfill).
 */
function replaceChannelMessages(channelId, messages) {
  if (!db) return;
  inTransaction(() => {
    db.prepare('DELETE FROM messages WHERE channelId = ?').run(channelId);
    const ins = db.prepare(`INSERT INTO messages (id, channelId, userId, username, text, files, timestamp, profilePic, reactions, editedAt, replyTo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    messages.forEach(m => {
      if (!m || typeof m.id !== 'string') return;
      ins.run(
        m.id,
        channelId,
        typeof m.userId === 'string' ? m.userId : '',
        String(m.username || ''),
        typeof m.text === 'string' ? m.text : '',
        JSON.stringify(Array.isArray(m.files) ? m.files : (m.file ? [m.file] : [])),
        typeof m.timestamp === 'number' ? m.timestamp : 0,
        typeof m.profilePic === 'string' ? m.profilePic : '',
        JSON.stringify(m.reactions && typeof m.reactions === 'object' ? m.reactions : {}),
        typeof m.editedAt === 'number' ? m.editedAt : null,
        m.replyTo && typeof m.replyTo === 'object' ? JSON.stringify(m.replyTo) : null
      );
    });
  });
}

function saveReadState(state) {
  if (!db) return;
  inTransaction(() => {
    db.prepare('DELETE FROM read_state').run();
    const ins = db.prepare('INSERT INTO read_state (userId, channelId, lastRead) VALUES (?, ?, ?)');
    Object.keys(state || {}).forEach(uid => {
      const perChannel = state[uid];
      if (!perChannel || typeof perChannel !== 'object') return;
      Object.keys(perChannel).forEach(cid => {
        if (typeof perChannel[cid] === 'number') ins.run(uid, cid, perChannel[cid]);
      });
    });
  });
}

/*
 * entries: array of [token, { userId, expiresAt }] pairs (as the old
 * tokens.json store produced).
 */
function saveTokens(entries) {
  if (!db) return;
  inTransaction(() => {
    db.prepare('DELETE FROM tokens').run();
    const ins = db.prepare('INSERT INTO tokens (token, userId, expiresAt) VALUES (?, ?, ?)');
    entries.forEach(([t, v]) => {
      if (!t || !v) return;
      const userId = typeof v.userId === 'string' ? v.userId : (typeof v.id === 'string' ? v.id : null);
      const expiresAt = typeof v.expiresAt === 'number' ? v.expiresAt : Date.now() + 30 * 24 * 60 * 60 * 1000;
      if (userId) ins.run(t, userId, expiresAt);
    });
  });
}

module.exports = {
  DB_FILE,
  isOpen,
  getRawDb,
  open,
  close,
  hasLegacy,
  importLegacy,
  loadUsers,
  loadServers,
  loadChannels,
  loadReadState,
  loadTokenEntries,
  saveUsers,
  saveServers,
  saveChannels,
  appendMessage,
  editMessage,
  deleteMessage,
  setMessageReactions,
  pinMessage,
  unpinMessage,
  replaceChannelMessages,
  saveReadState,
  saveTokens
};