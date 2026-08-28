const { Pool } = require('pg');

// Persistência no Postgres (Supabase) quando DATABASE_URL está definida.
// Sem ela, o server.js continua nos arquivos JSON — útil pra testar no PC.
const DATABASE_URL = process.env.DATABASE_URL || '';
const enabled = !!DATABASE_URL;

let pool = null;
const pending = new Map(); // key -> timeout
const latest = new Map(); // key -> value a gravar

function getPool() {
  if (!enabled) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 8,
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 20000
    });
    pool.on('error', (err) => {
      console.error('[DSpeak] Erro na conexão com o Postgres:', err.message);
    });
  }
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function init() {
  if (!enabled) return;
  await query(`
    CREATE TABLE IF NOT EXISTS app_kv (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      username_key TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_url TEXT,
      session_token TEXT,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS users_session_token ON users (session_token);
  `);
  console.log('[DSpeak] Postgres (Supabase) conectado — dados de salas, chat e contas ficam no banco.');
}

async function getKv(key) {
  const r = await query('SELECT value FROM app_kv WHERE key = $1', [key]);
  return r.rows[0] ? r.rows[0].value : null;
}

async function setKvNow(key, value) {
  await query(
    `INSERT INTO app_kv (key, value, updated_at)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(value), Date.now()]
  );
}

function saveKvDebounced(key, value, delayMs = 400) {
  if (!enabled) return;
  latest.set(key, value);
  if (pending.has(key)) return;
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    const v = latest.get(key);
    setKvNow(key, v).catch((e) => {
      console.error(`[DSpeak] Não consegui gravar ${key} no Postgres:`, e.message);
    });
  }, delayMs));
}

async function flushAll() {
  if (!enabled) return;
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  const jobs = [];
  for (const [key, value] of latest.entries()) {
    jobs.push(setKvNow(key, value).catch((e) => {
      console.error(`[DSpeak] Não consegui gravar ${key} ao desligar:`, e.message);
    }));
  }
  await Promise.all(jobs);
}

async function loadSnapshot() {
  if (!enabled) {
    return { channels: null, servers: null, roles: null, messages: null, dms: null, users: [] };
  }
  const [channels, servers, roles, messages, dms, usersRes] = await Promise.all([
    getKv('channels'),
    getKv('servers'),
    getKv('roles'),
    getKv('messages'),
    getKv('dms'),
    query('SELECT username_key, username, password_hash, avatar_url, session_token, created_at FROM users')
  ]);
  return {
    channels: Array.isArray(channels) ? channels : null,
    servers: Array.isArray(servers) ? servers : null,
    roles: roles && typeof roles === 'object' && !Array.isArray(roles) ? roles : null,
    messages: messages && typeof messages === 'object' && !Array.isArray(messages) ? messages : null,
    dms: dms && typeof dms === 'object' && !Array.isArray(dms) ? dms : null,
    users: usersRes.rows || []
  };
}

async function upsertUser(user) {
  if (!enabled) return;
  await query(
    `INSERT INTO users (username_key, username, password_hash, avatar_url, session_token, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (username_key) DO UPDATE SET
       username = EXCLUDED.username,
       password_hash = EXCLUDED.password_hash,
       avatar_url = EXCLUDED.avatar_url,
       session_token = EXCLUDED.session_token`,
    [
      user.usernameKey,
      user.username,
      user.passwordHash,
      user.avatarUrl || null,
      user.sessionToken || null,
      user.createdAt || Date.now()
    ]
  );
}

async function updateUserAvatar(usernameKey, avatarUrl) {
  if (!enabled) return;
  await query('UPDATE users SET avatar_url = $2 WHERE username_key = $1', [usernameKey, avatarUrl || null]);
}

async function updateUserToken(usernameKey, sessionToken) {
  if (!enabled) return;
  await query('UPDATE users SET session_token = $2 WHERE username_key = $1', [usernameKey, sessionToken]);
}

module.exports = {
  enabled,
  init,
  loadSnapshot,
  saveKvDebounced,
  flushAll,
  upsertUser,
  updateUserAvatar,
  updateUserToken
};
