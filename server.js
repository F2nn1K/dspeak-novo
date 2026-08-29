const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const db = require('./db');
const mail = require('./mail');
const sfu = require('./sfu');

const app = express();
const server = http.createServer(app);
// pingTimeout mais alto do que o padrão: dá mais tempo pro cliente responder antes de
// ser considerado desconectado — ajuda bastante em celular (tela travada/app em
// segundo plano, que o navegador desacelera bastante) e Wi-Fi instável.
const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Credenciais do servidor TURN (proxy) ----------
// Trocamos do metered.ca pra Cloudflare Realtime — 1000 GB (1TB) grátis por mês, MUITO
// mais generoso que os 500MB do metered.ca (que já estourou uma vez). A chave de
// verdade (TURN_KEY_API_TOKEN) NUNCA vai pro navegador de ninguém — fica só aqui, no
// servidor. Configura essas duas variáveis de ambiente no painel do Render:
//   CLOUDFLARE_TURN_KEY_ID       (o "Key ID" que aparece ao criar uma TURN key no
//                                 painel da Cloudflare, em Realtime/Calls)
//   CLOUDFLARE_TURN_API_TOKEN    (o "API Token"/"Bearer token" gerado junto)
const CLOUDFLARE_TURN_KEY_ID = process.env.CLOUDFLARE_TURN_KEY_ID || '';
const CLOUDFLARE_TURN_API_TOKEN = process.env.CLOUDFLARE_TURN_API_TOKEN || '';
// Opção metered.ca / Open Relay (20 GB/mês grátis, SEM cartão de crédito).
// Ao criar a conta em metered.ca você escolhe um "app name" — ele vira o domínio
// (ex: app chamado "meudspeak" → domínio "meudspeak.metered.live"). Configure:
//   METERED_DOMAIN   = meudspeak.metered.live
//   METERED_API_KEY  = a API key do painel
// Nada embutido no código: chaves só por variável de ambiente.
const METERED_API_KEY = process.env.METERED_API_KEY || '';
const METERED_DOMAIN = process.env.METERED_DOMAIN || '';
// Opção genérica: qualquer servidor TURN com credencial fixa (ex: um coturn seu,
// ou o freeturn.net pra testes). Configure:
//   TURN_URLS       = turn:servidor.com:3478,turns:servidor.com:5349 (separadas por vírgula)
//   TURN_USERNAME   = usuario
//   TURN_CREDENTIAL = senha
const TURN_URLS = (process.env.TURN_URLS || '').split(',').map(u => u.trim()).filter(Boolean);
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';

app.get('/turn-credentials', async (req, res) => {
  try {
    if (CLOUDFLARE_TURN_KEY_ID && CLOUDFLARE_TURN_API_TOKEN) {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${CLOUDFLARE_TURN_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          // 24h de validade pra credencial — de sobra pra qualquer chamada de voz,
          // e o cliente busca uma credencial nova a cada vez que entra numa sala
          // mesmo, então não precisa durar mais que isso.
          body: JSON.stringify({ ttl: 86400 })
        }
      );
      const data = await response.json();
      if (data && Array.isArray(data.iceServers)) {
        res.json(data.iceServers);
        return;
      }
      console.error('[DSpeak] Resposta inesperada da Cloudflare TURN:', data);
    }

    // Opção metered.ca / Open Relay (só usada se a Cloudflare não estiver
    // configurada, ou se a chamada acima falhar por algum motivo).
    if (METERED_API_KEY && METERED_DOMAIN) {
      const response = await fetch(`https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`);
      const iceServers = await response.json();
      if (Array.isArray(iceServers)) {
        res.json(iceServers);
        return;
      }
      console.error('[DSpeak] Resposta inesperada da metered.ca:', iceServers);
    }

    // Opção genérica: TURN com credencial fixa vinda das variáveis de ambiente.
    if (TURN_URLS.length && TURN_USERNAME && TURN_CREDENTIAL) {
      res.json([{ urls: TURN_URLS, username: TURN_USERNAME, credential: TURN_CREDENTIAL }]);
      return;
    }

    // Nada configurado: devolve vazio — o cliente já sabe seguir só com STUN.
    res.json([]);
  } catch (err) {
    console.error('[DSpeak] Não consegui buscar credenciais do TURN:', err);
    res.status(502).json([]); // o cliente já sabe seguir só com STUN se isso vier vazio
  }
});

// ---------- Deploy sem derrubar todo mundo ----------
// Dois tipos de atualização:
//   1. Só tela (HTML/CSS/JS do cliente): `git pull` e pronto — o Node nem
//      reinicia, ninguém cai. O cliente consulta /client-version de tempos em
//      tempos e mostra um botão "Atualizar" quando o arquivo mudar no disco.
//   2. Servidor (este arquivo): o script de deploy chama /admin/announce-restart
//      ANTES do pm2 restart — todo mundo recebe o aviso, a fila de música é
//      salva no banco, e ao voltar (2-4s) cada cliente re-entra sozinho na
//      mesma sala de voz (rejoinVoiceIfNeeded já faz isso após o auth-ok).
const ADMIN_KEY = process.env.ADMIN_KEY || '';

app.get('/client-version', (req, res) => {
  fs.stat(path.join(__dirname, 'public', 'index.html'), (err, st) => {
    res.json({ v: err ? '0' : String(Math.floor(st.mtimeMs)) });
  });
});

app.post('/admin/announce-restart', async (req, res) => {
  if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  io.emit('server-update-notice', { seconds: 5 });
  try { await persistMusicNow(); } catch (e) {}
  console.log('[DSpeak] Aviso de atualização enviado a todos os clientes — reinicie em ~5s.');
  res.json({ ok: true });
});

// ---------- Pasta de dados persistentes ----------
// IMPORTANTE: no Render (e na maioria dos serviços de hospedagem "sem estado"), a
// pasta do projeto é recriada do ZERO a cada novo deploy — qualquer arquivo que não
// veio do seu código (como os .json abaixo, com salas/mensagens/cargos/servidores)
// simplesmente some junto. Pra esses dados sobreviverem a uma atualização, eles
// precisam morar num "Disco Persistente" (Persistent Disk) do Render, que fica FORA
// do ciclo de deploy.
//
// Como configurar (uma vez só):
//   1. No painel do Render, no seu serviço, vai em "Disks" → "Add Disk".
//   2. Escolhe um ponto de montagem, ex: /var/data (o Render cria a pasta sozinho).
//   3. Nas variáveis de ambiente do serviço, define DATA_DIR = /var/data
//   4. Faz um novo deploy — a partir daí, os dados ficam nesse disco e sobrevivem a
//      qualquer atualização de código futura.
// Se DATA_DIR não estiver definida (ex: rodando local no seu PC pra testar), os
// dados continuam salvos dentro da própria pasta do projeto, como sempre foi.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!process.env.DATA_DIR && !process.env.DATABASE_URL) {
  console.log('[DSpeak] Sem DATABASE_URL e sem DATA_DIR — salvando dados em JSON na pasta do projeto (some a cada deploy no Render). Configure DATABASE_URL no Render apontando pro Supabase.');
} else if (process.env.DATABASE_URL) {
  console.log('[DSpeak] DATABASE_URL definida — salas, chat, cargos e contas vão pro Postgres.');
} else {
  console.log(`[DSpeak] Salvando dados persistentes em: ${DATA_DIR}`);
}

// Migração de uma vez só: se você ACABOU de configurar o disco persistente agora, ele
// começa vazio — isso copia pra lá qualquer arquivo de dado que ainda esteja na pasta
// antiga do projeto (de antes dessa mudança), pra não perder nada na primeira vez.
// Depois da primeira vez, o disco novo já tem os arquivos, então isso não faz mais nada.
function migrateOldDataFileIfNeeded(filename) {
  if (DATA_DIR === __dirname) return; // sem disco persistente configurado — nada a migrar
  const newPath = path.join(DATA_DIR, filename);
  const oldPath = path.join(__dirname, filename);
  if (!fs.existsSync(newPath) && fs.existsSync(oldPath)) {
    try {
      fs.copyFileSync(oldPath, newPath);
      console.log(`[DSpeak] Migrado ${filename} da pasta antiga do projeto pro disco persistente.`);
    } catch (e) {
      console.error(`[DSpeak] Não consegui migrar ${filename} pro disco persistente:`, e);
    }
  }
}
['channels.json', 'servers.json', 'roles.json', 'messages.json', 'dm-messages.json', 'users.json'].forEach(migrateOldDataFileIfNeeded);

// ---------- Gravação em disco assíncrona e agrupada (debounce) ----------
// Antes, CADA mensagem reescrevia o arquivo inteiro de forma síncrona
// (fs.writeFileSync), travando o servidor por um instante a cada gravação. Em
// horário de movimento, esses travamentos atrasavam os pings do Socket.IO e podiam
// derrubar clientes à toa (o servidor achava que a pessoa tinha caído). Agora as
// mudanças muito próximas umas das outras viram UMA escrita só, feita de forma
// assíncrona — o servidor nunca para de responder por causa de disco.
let persistenceReady = false; // só grava depois do boot (Postgres ou JSON)

const pendingSaves = new Map(); // caminho do arquivo -> timer agendado
function saveJsonDebounced(filePath, getData, delayMs = 500) {
  if (pendingSaves.has(filePath)) return; // já tem uma gravação agendada pra esse arquivo
  pendingSaves.set(filePath, setTimeout(() => {
    pendingSaves.delete(filePath);
    fs.writeFile(filePath, JSON.stringify(getData(), null, 2), (e) => {
      if (e) console.error(`[DSpeak] Não foi possível salvar ${path.basename(filePath)}`, e);
    });
  }, delayMs));
}

// Na hora de desligar (deploy novo, restart da hospedagem), grava na hora tudo que
// ainda estava agendado — sem isso, as últimas mensagens antes do restart se perdiam.
const flushableSaves = []; // [{ filePath, getData }]
function registerFlushable(filePath, getData) {
  flushableSaves.push({ filePath, getData });
}
function flushAllSavesSync() {
  pendingSaves.forEach(timer => clearTimeout(timer));
  pendingSaves.clear();
  flushableSaves.forEach(({ filePath, getData }) => {
    try { fs.writeFileSync(filePath, JSON.stringify(getData(), null, 2)); } catch (e) {
      console.error(`[DSpeak] Não consegui gravar ${path.basename(filePath)} ao desligar:`, e);
    }
  });
}
async function shutdown() {
  try { await persistMusicNow(); } catch (e) {}
  try { await db.flushAll(); } catch (e) {}
  if (!db.enabled) flushAllSavesSync();
  process.exit(0);
}
process.on('SIGTERM', () => { shutdown(); });
process.on('SIGINT', () => { shutdown(); });

// ---------- Upload de arquivos no chat (até 10MB, tipo o "clipzinho" do Discord) ----------
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// Arquivos enviados NUNCA são servidos como página executável: tipos que o
// navegador executaria (HTML/SVG/JS...) são forçados a virar download. Sem isso,
// alguém podia "hospedar" uma página maliciosa dentro do chat via upload (XSS
// armazenado servido pela nossa própria origem).
const FORCE_DOWNLOAD_EXTS = new Set(['.html', '.htm', '.xhtml', '.svg', '.xml', '.js', '.mjs']);
app.use('/uploads', express.static(UPLOADS_DIR, {
  setHeaders: (res, filePath) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (FORCE_DOWNLOAD_EXTS.has(path.extname(filePath).toLowerCase())) {
      res.setHeader('Content-Disposition', 'attachment');
      res.setHeader('Content-Type', 'application/octet-stream');
    }
  }
}));

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_SIZE }
});

function safeUploadId(originalName) {
  const ext = path.extname(String(originalName || '')).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
  return crypto.randomBytes(16).toString('hex') + ext;
}

function sendUploadedFile(res, filename, mimetype, data) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (FORCE_DOWNLOAD_EXTS.has(ext)) {
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Content-Type', 'application/octet-stream');
  } else {
    res.setHeader('Content-Type', mimetype || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename || 'arquivo')}"`);
  }
  res.end(data);
}

app.post('/upload', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const isTooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(isTooBig ? 413 : 400).json({
        error: isTooBig ? 'Arquivo maior que 10MB.' : 'Não foi possível enviar o arquivo.'
      });
    }
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo recebido.' });

    const id = safeUploadId(req.file.originalname);
    try {
      if (db.enabled) {
        await db.saveChatFile({
          id,
          filename: req.file.originalname,
          mimetype: req.file.mimetype,
          data: req.file.buffer
        });
        return res.json({
          url: `/files/${id}`,
          filename: req.file.originalname,
          size: req.file.size,
          mimetype: req.file.mimetype
        });
      }
      fs.writeFileSync(path.join(UPLOADS_DIR, id), req.file.buffer);
      res.json({
        url: `/uploads/${id}`,
        filename: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype
      });
    } catch (e) {
      console.error('[DSpeak] Falha ao gravar upload:', e);
      res.status(500).json({ error: 'Não foi possível enviar o arquivo.' });
    }
  });
});

app.get('/files/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[a-f0-9]{32}(\.[a-z0-9]{1,10})?$/i.test(id)) return res.status(404).end();
  try {
    const row = await db.getChatFile(id);
    if (!row) return res.status(404).end();
    sendUploadedFile(res, row.filename, row.mimetype, row.data);
  } catch (e) {
    console.error('[DSpeak] Falha ao ler arquivo:', e);
    res.status(500).end();
  }
});

const voiceUsers = {};
const activeRoomStreams = {};

// ---------- Status visível (Disponível / Ausente / Ocupado) ----------
// Guardado por nome (minúsculas) enquanto o servidor está de pé — não precisa
// persistir em disco: cada cliente relembra o próprio status do localStorage e
// reenvia ao conectar.
const userStatuses = {}; // usernameKey -> 'online' | 'idle' | 'dnd'
const VALID_STATUSES = ['online', 'idle', 'dnd'];

function broadcastStatuses() {
  io.emit('user-statuses', userStatuses);
}

// ---------- Ouvir junto (YouTube / Spotify oficiais) ----------
// Estado por sala de voz. O áudio NÃO é baixado nem retransmitido pelo servidor —
// só a fila/play/pause/posição. Cada cliente toca no player oficial (iframe).
const roomMusic = {};
const MUSIC_MAX_QUEUE = 40;
const MUSIC_MAX_URL = 500;

// A fila de música sobrevive a restart do servidor (deploy): é salva no banco
// (ou em music.json) na hora do aviso de atualização e no desligamento, e
// restaurada no boot — quem estava ouvindo volta praticamente do mesmo ponto.
const MUSIC_FILE = path.join(DATA_DIR, 'music.json');
async function persistMusicNow() {
  try {
    Object.values(roomMusic).forEach(freezeMusicPosition);
    if (db.enabled) await db.setKvNow('music', roomMusic);
    else fs.writeFileSync(MUSIC_FILE, JSON.stringify(roomMusic));
  } catch (e) {
    console.error('[DSpeak] Não consegui salvar a fila de música:', e.message);
  }
}
function restoreMusicFromSnapshot(saved) {
  if (!saved || typeof saved !== 'object') return;
  Object.entries(saved).forEach(([chId, sess]) => {
    if (sess && Array.isArray(sess.queue) && sess.queue.length) {
      roomMusic[chId] = { ...sess, updatedAt: Date.now() };
    }
  });
}

function parseMusicLink(raw) {
  let s = String(raw || '').trim();
  if (!s || s.length > MUSIC_MAX_URL) return null;

  const uriTrack = /^spotify:track:([0-9A-Za-z]{22})$/.exec(s);
  if (uriTrack) return { type: 'spotify', sourceId: uriTrack[1] };

  if (!/^https?:\/\//i.test(s) && !s.includes(' ')) s = 'https://' + s;

  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\./, '').toLowerCase();

  if (host === 'youtu.be' || host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    let id = null;
    if (host === 'youtu.be') id = (u.pathname.split('/').filter(Boolean)[0] || '');
    else if (u.pathname === '/watch' || u.pathname.startsWith('/watch')) id = u.searchParams.get('v') || '';
    else {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'embed' || parts[0] === 'shorts' || parts[0] === 'live') id = parts[1] || '';
    }
    id = String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 11);
    if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return { type: 'youtube', sourceId: id };
    return null;
  }

  if (host === 'open.spotify.com' || host === 'play.spotify.com') {
    const parts = u.pathname.split('/').filter(Boolean);
    const trackIdx = parts.indexOf('track');
    if (trackIdx >= 0 && parts[trackIdx + 1]) {
      const id = String(parts[trackIdx + 1]).split('?')[0];
      if (/^[0-9A-Za-z]{22}$/.test(id)) return { type: 'spotify', sourceId: id };
    }
    return null;
  }

  return null;
}

async function lookupMusicMeta(parsed) {
  if (parsed.type === 'youtube') {
    const page = `https://www.youtube.com/watch?v=${parsed.sourceId}`;
    const fallback = {
      title: 'YouTube',
      author: '',
      thumbnail: `https://i.ytimg.com/vi/${parsed.sourceId}/hqdefault.jpg`
    };
    try {
      const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(page)}&format=json`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return fallback;
      const data = await res.json();
      return {
        title: String(data.title || 'YouTube').slice(0, 200),
        author: String(data.author_name || '').slice(0, 120),
        thumbnail: fallback.thumbnail
      };
    } catch (e) {
      return fallback;
    }
  }

  const page = `https://open.spotify.com/track/${parsed.sourceId}`;
  const fallback = { title: 'Spotify', author: '', thumbnail: '' };
  try {
    const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(page)}`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return fallback;
    const data = await res.json();
    return {
      title: String(data.title || 'Spotify').slice(0, 200),
      author: String(data.author_name || '').slice(0, 120),
      thumbnail: String(data.thumbnail_url || '').slice(0, 500)
    };
  } catch (e) {
    return fallback;
  }
}

function computeMusicPosition(session) {
  if (!session || !session.currentId) return 0;
  if (!session.playing) return session.positionSec;
  return Math.max(0, session.positionSec + (Date.now() - session.updatedAt) / 1000);
}

function freezeMusicPosition(session) {
  session.positionSec = computeMusicPosition(session);
  session.updatedAt = Date.now();
}

function publicMusicState(session) {
  if (!session) {
    return { queue: [], currentId: null, playing: false, positionSec: 0, serverNow: Date.now() };
  }
  return {
    queue: session.queue,
    currentId: session.currentId,
    playing: session.playing,
    positionSec: computeMusicPosition(session),
    serverNow: Date.now()
  };
}

function emitMusicState(channelId) {
  io.to(channelId).emit('music-state', publicMusicState(roomMusic[channelId]));
}

function ensureMusicSession(channelId) {
  if (!roomMusic[channelId]) {
    roomMusic[channelId] = {
      queue: [],
      currentId: null,
      playing: false,
      positionSec: 0,
      updatedAt: Date.now()
    };
  }
  return roomMusic[channelId];
}

function destroyMusicIfRoomEmpty(channelId) {
  if (!channelId) return;
  if ((voiceUsers[channelId] || []).length === 0 && roomMusic[channelId]) {
    delete roomMusic[channelId];
  }
}

function currentMusicChannelOf(socket) {
  const channelId = socket.currentVoiceChannel;
  if (!channelId || channelId === WAITING_VOICE_ROOM) return null;
  const inRoom = (voiceUsers[channelId] || []).some(u => u.socketId === socket.id);
  return inRoom ? channelId : null;
}

function musicAdvance(session, direction) {
  if (!session.queue.length) {
    session.currentId = null;
    session.playing = false;
    session.positionSec = 0;
    session.updatedAt = Date.now();
    return;
  }
  const idx = session.queue.findIndex(i => i.id === session.currentId);
  let next = idx + direction;
  if (next < 0) next = 0;
  if (next >= session.queue.length) {
    session.playing = false;
    session.positionSec = 0;
    session.updatedAt = Date.now();
    return;
  }
  session.currentId = session.queue[next].id;
  session.positionSec = 0;
  session.playing = true;
  session.updatedAt = Date.now();
}

// ---------- Canais persistidos no servidor (compartilhados por todo mundo) ----------
// Antes, os canais só existiam localmente no navegador de cada pessoa: cada um via uma
// lista diferente e tudo sumia ao dar F5. Agora o servidor é a fonte da verdade: guarda
// em disco e manda a mesma lista pra todo mundo, sempre atualizada.
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
const WAITING_VOICE_ROOM = 'waiting-room';
const WAITING_TEXT_ROOM = 'waiting-room-text';
const DEFAULT_CHANNELS = [
  { id: 'geral', name: 'geral', type: 'text', undeletable: true, locked: true, serverId: 'dspeak' },
  { id: WAITING_TEXT_ROOM, name: 'sala-de-espera', type: 'text', serverId: 'dspeak' },
  { id: WAITING_VOICE_ROOM, name: 'Sala de Espera', type: 'voice', serverId: 'dspeak' },
  { id: 'lobby', name: 'Lobby', type: 'voice', undeletable: true, serverId: 'dspeak' }
];

let channels = DEFAULT_CHANNELS;
try {
  if (fs.existsSync(CHANNELS_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
    if (Array.isArray(loaded) && loaded.length > 0) channels = loaded;
  }
} catch (e) {
  console.error('Não foi possível ler channels.json, usando os padrões.', e);
}

// Se o servidor já tinha um channels.json de antes (sem a Sala de Espera), acrescenta
// os canais fixos que estiverem faltando, sem mexer no resto que já existia.
DEFAULT_CHANNELS.forEach(defCh => {
  if (!channels.some(c => c.id === defCh.id)) channels.push({ ...defCh });
});

// Migração: canais salvos ANTES do recurso de múltiplos servidores não têm
// serverId — como antes só existia um servidor mesmo (o padrão), todo canal
// "órfão" pertence a ele.
let channelsMigrated = false;
channels.forEach(ch => {
  if (!ch.serverId) { ch.serverId = 'dspeak'; channelsMigrated = true; }
});

// O cargo Guest foi removido, então a Sala de Espera não trava mais ninguém — deixa
// de ser um canal travado (Owner pode renomear ou excluir se não quiser mais usá-la).
[WAITING_TEXT_ROOM, WAITING_VOICE_ROOM].forEach(id => {
  const ch = channels.find(c => c.id === id);
  if (ch) { delete ch.locked; delete ch.undeletable; }
});

// Corrige a ordem em servidores que já tinham channels.json salvo de antes: a Sala de
// Espera (voz) sempre deve aparecer ACIMA do Lobby na lista.
(function reorderWaitingRoomBeforeLobby() {
  const waitIdx = channels.findIndex(c => c.id === WAITING_VOICE_ROOM);
  const lobbyIdx = channels.findIndex(c => c.id === 'lobby');
  if (waitIdx !== -1 && lobbyIdx !== -1 && waitIdx > lobbyIdx) {
    const [waitingRoomChannel] = channels.splice(waitIdx, 1);
    const newLobbyIdx = channels.findIndex(c => c.id === 'lobby');
    channels.splice(newLobbyIdx, 0, waitingRoomChannel);
  }
})();

function saveChannels() {
  if (!persistenceReady) return;
  if (db.enabled) db.saveKvDebounced('channels', channels);
  else saveJsonDebounced(CHANNELS_FILE, () => channels);
}
registerFlushable(CHANNELS_FILE, () => channels);
saveChannels();

// ---------- Múltiplos servidores (tipo Discord) ----------
// Quem cria um servidor novo vira Owner DELE (separado do Owner global único que já
// existia, que continua mandando só no servidor 'dspeak' padrão — pra não bagunçar
// quem já usava esse sistema). Cada servidor pode ter senha (opcional, escolhida por
// quem cria) e sempre tem um código de convite único pra gerar o link.
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');

// O servidor 'dspeak' padrão sempre existiu implicitamente — todo mundo é membro dele
// automaticamente (comportamento de sempre, sem convite/senha), e ele usa o sistema de
// Owner global já existente (roles.json), não um dono próprio.
const DEFAULT_SERVER = {
  id: 'dspeak',
  name: 'DSPEAK SERVER',
  ownerUsername: null, // null = usa o Owner global (roles.json), não um dono próprio
  passwordHash: null,
  inviteCode: null, // servidor padrão não precisa de convite — todo mundo já é membro
  members: [] // vazio = todo mundo é considerado membro automaticamente (ver isMemberOfServer)
};

let dspeakServers = [DEFAULT_SERVER];
try {
  if (fs.existsSync(SERVERS_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8'));
    if (Array.isArray(loaded) && loaded.length > 0) dspeakServers = loaded;
  }
} catch (e) {
  console.error('Não foi possível ler servers.json, usando os padrões.', e);
}
// Garante que o servidor padrão sempre existe, mesmo em arquivos salvos de versões
// anteriores a esse recurso.
if (!dspeakServers.some(s => s.id === 'dspeak')) dspeakServers.unshift(DEFAULT_SERVER);

function saveServers() {
  if (!persistenceReady) return;
  if (db.enabled) db.saveKvDebounced('servers', dspeakServers);
  else saveJsonDebounced(SERVERS_FILE, () => dspeakServers);
}
registerFlushable(SERVERS_FILE, () => dspeakServers);
saveServers();

// Senha guardada como "salt:hash" (scrypt) — nunca em texto puro.
function hashServerPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyServerPassword(plain, stored) {
  if (!stored) return true; // sem senha configurada
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(plain || ''), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
  } catch (e) {
    return false;
  }
}

function isMemberOfServer(srv, username) {
  if (!srv) return false;
  if (srv.id === 'dspeak') return true; // servidor padrão: todo mundo é membro
  const key = keyOf(username);
  return srv.ownerUsername === key || (srv.members || []).includes(key);
}

// Dono de um servidor específico: o servidor padrão usa o Owner GLOBAL (sistema já
// existente, roles.json); servidores criados por usuários usam o ownerUsername
// próprio deles.
function isOwnerOfServer(socket, srv) {
  if (!srv) return false;
  if (srv.id === 'dspeak') return socket.role === 'owner';
  return srv.ownerUsername === keyOf(socket.username);
}

// Moderador DE UM servidor específico: promovido pelo dono daquele servidor, vale
// só lá dentro (diferente do 'moderator' global antigo, que valia em tudo).
function isModeratorOfServer(socket, srv) {
  if (!srv || !socket.username) return false;
  return (srv.moderators || []).includes(keyOf(socket.username));
}

// Quem pode montar o servidor (criar/renomear/excluir salas, moderar voz e chat):
// o dono dele ou um Moderador promovido por ele.
function canManageServer(socket, srv) {
  return isOwnerOfServer(socket, srv) || isModeratorOfServer(socket, srv);
}

// Acha o servidor a que um canal pertence (pra checar permissão por servidor).
function serverOfChannel(channelId) {
  const ch = channels.find(c => c.id === channelId);
  if (!ch) return null;
  return dspeakServers.find(s => s.id === ch.serverId) || null;
}

// Quem pode mexer no player da sala (play/pause/pular/seek/fila): dono ou
// moderador do servidor, ou quem colocou a música que está tocando AGORA.
// Qualquer um continua podendo ADICIONAR na fila — só não atropela os outros.
function canControlMusic(socket, channelId) {
  const srv = serverOfChannel(channelId);
  if (srv && canManageServer(socket, srv)) return true;
  const session = roomMusic[channelId];
  const current = session && session.queue.find(i => i.id === session.currentId);
  return !!(current && current.addedBy && socket.username &&
    String(current.addedBy).toLowerCase() === String(socket.username).toLowerCase());
}

function denyMusicControl(socket) {
  socket.emit('music-error', 'Só quem colocou a música atual, o dono ou um moderador do servidor pode controlar o player.');
}

// Manda pro socket a lista dos servidores dos quais ele é membro (nunca inclui o
// hash da senha — só se TEM senha ou não).
// Nunca manda o hash da senha de uma sala de voz pro cliente — só se ELA TEM senha
// ou não (hasPassword). O hash em si fica só aqui no servidor.
function sanitizeChannelForClient(ch) {
  if (!ch.passwordHash) return ch;
  const { passwordHash, ...rest } = ch;
  return { ...rest, hasPassword: true };
}

function sendMyServers(socket) {
  const username = socket.username;
  const mine = dspeakServers
    .filter(srv => isMemberOfServer(srv, username))
    .map(srv => ({
      id: srv.id,
      name: srv.name,
      iconUrl: srv.iconUrl || null,
      hasPassword: !!srv.passwordHash,
      isOwner: isOwnerOfServer(socket, srv),
      isModerator: isModeratorOfServer(socket, srv),
      moderators: srv.moderators || [],
      inviteCode: canManageServer(socket, srv) ? srv.inviteCode : undefined, // dono e mods veem o código de convite
      channels: channels.filter(c => c.serverId === srv.id).map(sanitizeChannelForClient)
    }));
  socket.emit('my-servers', mine);
}

function generateServerId(name) {
  const base = String(name || 'servidor').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'servidor';
  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}

// ---------- Cargos (Owner / Moderador / Membro / Guest) ----------
// Guest é travado na Sala de Espera até um Moderador ou Owner dar um cargo a ele.
// Pra virar Owner, a pessoa digita "!owner SEU_CODIGO" em qualquer chat — sem precisar
// ser o primeiro a se cadastrar (isso causava confusão em testes: uma conta de teste
// qualquer virava Owner sem querer).
const ROLES_FILE = path.join(DATA_DIR, 'roles.json');

// O código de Owner SÓ existe por variável de ambiente — nada embutido no código,
// porque o repositório é público e qualquer valor escrito aqui viraria "senha
// pública" (quem soubesse viraria Owner na hora digitando !owner CODIGO no chat).
// Sem a variável definida, o comando !owner fica simplesmente desligado.
const OWNER_CLAIM_CODE = process.env.OWNER_CLAIM_CODE || '';
if (!OWNER_CLAIM_CODE) {
  console.log('[DSpeak] Variável de ambiente OWNER_CLAIM_CODE não definida — o comando !owner está DESATIVADO. Defina-a no painel da hospedagem pra poder reivindicar o cargo de Owner.');
}

let roles = {}; // chave: username em minúsculas -> 'owner' | 'moderator' | 'member' | 'guest'
try {
  if (fs.existsSync(ROLES_FILE)) {
    roles = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
  }
} catch (e) {
  console.error('Não foi possível ler roles.json, começando do zero.', e);
  roles = {};
}

// O cargo Guest foi removido — quem já estava como Guest vira Membro automaticamente.
let migratedGuests = false;
Object.keys(roles).forEach(key => {
  if (roles[key] === 'guest') {
    roles[key] = 'member';
    migratedGuests = true;
  }
});

function saveRoles() {
  if (!persistenceReady) return;
  if (db.enabled) db.saveKvDebounced('roles', roles);
  else saveJsonDebounced(ROLES_FILE, () => roles);
}
registerFlushable(ROLES_FILE, () => roles);

if (migratedGuests) saveRoles();

function keyOf(username) {
  return String(username || '').trim().toLowerCase();
}

// Retorna o cargo de um usuário, criando-o como 'member' (padrão pra gente nova) na
// primeira vez que aparece — não existe mais o cargo Guest.
function resolveRole(username) {
  const key = keyOf(username);
  if (!key) return 'member';
  if (roles[key]) return roles[key];
  roles[key] = 'member';
  saveRoles();
  return 'member';
}

function findSocketsByUsername(username) {
  const key = keyOf(username);
  const found = [];
  for (const [, s] of io.sockets.sockets) {
    if (s.usernameKey === key) found.push(s);
  }
  return found;
}

// Atualiza o campo "role" de um usuário em todas as listas de voz que ele estiver.
function syncRoleIntoVoiceLists(usernameKey, newRole) {
  Object.keys(voiceUsers).forEach(channelId => {
    voiceUsers[channelId] = voiceUsers[channelId].map(u =>
      keyOf(u.name) === usernameKey ? { ...u, role: newRole } : u
    );
  });
}

// ---------- Histórico de chat persistido, com expiração de 7 dias ----------
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

let messages = {}; // channelId -> [{ room, message, user, avatarUrl, time, date, timestamp }]
try {
  if (fs.existsSync(MESSAGES_FILE)) {
    messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
  }
} catch (e) {
  console.error('Não foi possível ler messages.json, começando do zero.', e);
  messages = {};
}

function saveMessages() {
  if (!persistenceReady) return;
  if (db.enabled) db.saveKvDebounced('messages', messages);
  else saveJsonDebounced(MESSAGES_FILE, () => messages);
}
registerFlushable(MESSAGES_FILE, () => messages);

function pruneChannelMessages(channelId) {
  if (!messages[channelId]) return;
  const cutoff = Date.now() - MESSAGE_RETENTION_MS;
  messages[channelId] = messages[channelId].filter(m => m.timestamp >= cutoff);
}

function pruneAllMessages() {
  Object.keys(messages).forEach(pruneChannelMessages);
  saveMessages();
}

pruneAllMessages(); // limpa mensagens vencidas assim que o servidor sobe
setInterval(pruneAllMessages, 60 * 60 * 1000); // e a cada hora, mesmo sem mensagens novas

// ---------- Mensagens privadas (DM) ----------
// Guardadas separadas do chat de canal, com retenção mais longa (30 dias — uma
// conversa privada costuma valer mais a pena manter do que o papo geral de uma sala).
const DM_FILE = path.join(DATA_DIR, 'dm-messages.json');
const DM_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

let directMessages = {}; // "usuarioA|usuarioB" (ordem alfabética) -> [{ from, message, time, date, timestamp, ... }]
try {
  if (fs.existsSync(DM_FILE)) {
    directMessages = JSON.parse(fs.readFileSync(DM_FILE, 'utf8'));
  }
} catch (e) {
  console.error('Não foi possível ler dm-messages.json, começando do zero.', e);
  directMessages = {};
}

function saveDirectMessages() {
  if (!persistenceReady) return;
  if (db.enabled) db.saveKvDebounced('dms', directMessages);
  else saveJsonDebounced(DM_FILE, () => directMessages);
}
registerFlushable(DM_FILE, () => directMessages);

// Chave estável pra essa dupla de pessoas, não importa quem mandou a última
// mensagem — sempre a mesma "gaveta" de conversa entre elas duas.
function dmPairKey(userA, userB) {
  const a = keyOf(userA), b = keyOf(userB);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function pruneDmPair(pairKey) {
  if (!directMessages[pairKey]) return;
  const cutoff = Date.now() - DM_RETENTION_MS;
  directMessages[pairKey] = directMessages[pairKey].filter(m => m.timestamp >= cutoff);
}

function pruneAllDms() {
  Object.keys(directMessages).forEach(pruneDmPair);
  saveDirectMessages();
}
pruneAllDms();
setInterval(pruneAllDms, 60 * 60 * 1000);

// ---------- Contas (apelido + senha) ----------
const USERS_FILE = path.join(DATA_DIR, 'users.json');
let accounts = {}; // usernameKey -> { username, passwordHash, avatarUrl, sessionToken, createdAt }

function saveAccounts() {
  if (!persistenceReady) return;
  if (db.enabled) return; // cada conta é gravada no upsert
  saveJsonDebounced(USERS_FILE, () => accounts);
}
registerFlushable(USERS_FILE, () => accounts);

function newSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

function isValidUsername(name) {
  const s = String(name || '').trim();
  if (s.length < 2 || s.length > 24) return false;
  return /^[\p{L}\p{N} _.\-]+$/u.test(s);
}

function isValidPassword(pw) {
  return typeof pw === 'string' && pw.length >= 6 && pw.length <= 72;
}

function persistAccount(key, acc) {
  accounts[key] = acc;
  if (db.enabled) {
    return db.upsertUser({
      usernameKey: key,
      username: acc.username,
      passwordHash: acc.passwordHash,
      recoveryHash: acc.recoveryHash || null,
      avatarUrl: acc.avatarUrl || null,
      sessionToken: acc.sessionToken || null,
      createdAt: acc.createdAt || Date.now(),
      email: acc.email || null,
      passwordResetHash: acc.passwordResetHash || null,
      passwordResetExpires: acc.passwordResetExpires || null
    }).catch((e) => console.error('[DSpeak] Não consegui gravar a conta no Postgres:', e.message));
  }
  saveAccounts();
  return Promise.resolve();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  const s = normalizeEmail(email);
  if (s.length < 5 || s.length > 120) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function findAccountKeyByEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  return Object.keys(accounts).find((k) => accounts[k] && accounts[k].email === e) || null;
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function publicAppUrl() {
  const raw = process.env.APP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://dspeak-novo.onrender.com';
  return String(raw).replace(/\/$/, '');
}

function authPayload(acc) {
  return {
    username: acc.username,
    avatarUrl: acc.avatarUrl || '',
    token: acc.sessionToken,
    email: acc.email || ''
  };
}

const lastResetRequestAt = new Map();

function attachUserSession(socket, username, avatarUrl) {
  socket.username = username;
  socket.avatarUrl = avatarUrl || '';
  socket.usernameKey = keyOf(username);

  const role = resolveRole(username);
  socket.role = role;
  socket.emit('your-role', { role, username });

  findSocketsByUsername(username).forEach(otherSocket => {
    if (otherSocket.id !== socket.id) {
      otherSocket.emit('session-replaced');
      otherSocket.disconnect(true);
    }
  });

  socket.emit('update-voice-users', voiceUsers);
  sendMyServers(socket);
  socket.emit('user-statuses', userStatuses);
}

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);

  // SFU: avisa o cliente se a transmissão de tela via servidor está disponível
  // (se não estiver, ele usa o modo mesh antigo sozinho) e registra os eventos
  // de sinalização (sfu-caps, sfu-create-transport, sfu-produce, sfu-consume...).
  socket.emit('sfu-available', sfu.isReady());
  sfu.attachSocketHandlers(io, socket, {
    currentChannelOf: (s) => {
      const chId = s.currentVoiceChannel;
      if (!chId || chId === WAITING_VOICE_ROOM) return null;
      return chId;
    }
  });

  socket.on('register-user', async (data) => {
    try {
      const username = String((data && data.username) || '').trim();
      if (!isValidUsername(username)) {
        socket.emit('auth-failed', { message: 'Apelido inválido (2 a 24 letras, números, espaço, ponto ou hífen).' });
        return;
      }
      const key = keyOf(username);
      const mode = data && data.mode;
      const password = data && data.password;
      const token = data && data.token;
      let acc = accounts[key];
      const incomingAvatar = typeof (data && data.avatarUrl) === 'string' ? data.avatarUrl : '';

      // Reconexão automática: o app guarda um token depois do login.
      if (token && acc && acc.sessionToken && token === acc.sessionToken) {
        if (incomingAvatar) acc.avatarUrl = incomingAvatar;
        await persistAccount(key, acc);
        attachUserSession(socket, acc.username, acc.avatarUrl);
        socket.emit('auth-ok', authPayload(acc));
        return;
      }

      if (mode === 'register') {
        if (!isValidPassword(password)) {
          socket.emit('auth-failed', { message: 'A senha precisa ter pelo menos 6 caracteres.' });
          return;
        }
        const email = normalizeEmail(data && data.email);
        if (!isValidEmail(email)) {
          socket.emit('auth-failed', { message: 'Digite um e-mail válido. É nele que a gente manda o link se você esquecer a senha.' });
          return;
        }
        if (acc) {
          socket.emit('auth-failed', { message: 'Esse apelido já tem conta. Entra com a senha.' });
          return;
        }
        const emailOwner = findAccountKeyByEmail(email);
        if (emailOwner) {
          socket.emit('auth-failed', { message: 'Esse e-mail já está em outra conta. Entra com o apelido dela, ou usa outro e-mail.' });
          return;
        }
        acc = {
          username,
          passwordHash: hashServerPassword(password),
          recoveryHash: '',
          avatarUrl: incomingAvatar,
          sessionToken: newSessionToken(),
          createdAt: Date.now(),
          email,
          passwordResetHash: '',
          passwordResetExpires: 0
        };
        await persistAccount(key, acc);
        attachUserSession(socket, username, acc.avatarUrl);
        socket.emit('auth-ok', authPayload(acc));
        return;
      }

      if (mode === 'login' || (typeof password === 'string' && password.length > 0)) {
        if (!acc) {
          socket.emit('auth-failed', { message: 'Não achei uma conta com esse apelido. Cria uma em "Criar conta".' });
          return;
        }
        if (!acc.passwordHash || !verifyServerPassword(password, acc.passwordHash)) {
          socket.emit('auth-failed', { message: 'Senha incorreta.' });
          return;
        }
        acc.sessionToken = newSessionToken();
        if (incomingAvatar) acc.avatarUrl = incomingAvatar;
        await persistAccount(key, acc);
        attachUserSession(socket, acc.username, acc.avatarUrl);
        socket.emit('auth-ok', authPayload(acc));
        return;
      }

      socket.emit('auth-required', { message: 'Entra com seu apelido e senha.' });
    } catch (e) {
      console.error('[DSpeak] Falha no login/cadastro:', e);
      socket.emit('auth-failed', { message: 'Não deu pra entrar agora. Tenta de novo.' });
    }
  });

  // Status escolhido no seletor do rodapé — replica pra todo mundo na hora.
  socket.on('set-status', (data) => {
    if (!socket.usernameKey) return;
    const status = data && data.status;
    if (!VALID_STATUSES.includes(status)) return;
    userStatuses[socket.usernameKey] = status;
    broadcastStatuses();
  });

  socket.on('change-password', async (data) => {
    try {
      if (!socket.usernameKey) {
        socket.emit('password-changed', { ok: false, message: 'Entra na conta primeiro.' });
        return;
      }
      const acc = accounts[socket.usernameKey];
      if (!acc) {
        socket.emit('password-changed', { ok: false, message: 'Conta não encontrada.' });
        return;
      }
      const currentPassword = data && data.currentPassword;
      const newPassword = data && data.newPassword;
      if (!acc.passwordHash || !verifyServerPassword(currentPassword, acc.passwordHash)) {
        socket.emit('password-changed', { ok: false, message: 'Senha atual incorreta.' });
        return;
      }
      if (!isValidPassword(newPassword)) {
        socket.emit('password-changed', { ok: false, message: 'A nova senha precisa ter pelo menos 6 caracteres.' });
        return;
      }
      acc.passwordHash = hashServerPassword(newPassword);
      acc.sessionToken = newSessionToken();
      acc.passwordResetHash = '';
      acc.passwordResetExpires = 0;
      await persistAccount(socket.usernameKey, acc);
      socket.emit('password-changed', { ok: true, token: acc.sessionToken, message: 'Senha atualizada.' });
    } catch (e) {
      console.error('[DSpeak] Falha ao trocar senha:', e);
      socket.emit('password-changed', { ok: false, message: 'Não deu pra trocar a senha agora.' });
    }
  });

  socket.on('set-account-email', async (data) => {
    try {
      if (!socket.usernameKey) {
        socket.emit('email-updated', { ok: false, message: 'Entra na conta primeiro.' });
        return;
      }
      const acc = accounts[socket.usernameKey];
      if (!acc) {
        socket.emit('email-updated', { ok: false, message: 'Conta não encontrada.' });
        return;
      }
      if (!acc.passwordHash || !verifyServerPassword(data && data.password, acc.passwordHash)) {
        socket.emit('email-updated', { ok: false, message: 'Senha atual incorreta.' });
        return;
      }
      const email = normalizeEmail(data && data.email);
      if (!isValidEmail(email)) {
        socket.emit('email-updated', { ok: false, message: 'Digite um e-mail válido.' });
        return;
      }
      const emailOwner = findAccountKeyByEmail(email);
      if (emailOwner && emailOwner !== socket.usernameKey) {
        socket.emit('email-updated', { ok: false, message: 'Esse e-mail já está em outra conta.' });
        return;
      }
      acc.email = email;
      await persistAccount(socket.usernameKey, acc);
      socket.emit('email-updated', { ok: true, email, message: 'E-mail salvo. Se você esquecer a senha, o link vai pra esse endereço.' });
    } catch (e) {
      console.error('[DSpeak] Falha ao salvar e-mail:', e);
      socket.emit('email-updated', { ok: false, message: 'Não deu pra salvar o e-mail agora.' });
    }
  });

  socket.on('request-password-reset', async (data) => {
    const genericOk = 'Se esse e-mail tiver conta, enviamos o link. Confere a caixa de entrada e o spam.';
    try {
      if (!mail.isConfigured()) {
        socket.emit('password-reset-sent', {
          ok: false,
          message: 'O servidor ainda não envia e-mail. Falta configurar SMTP ou Resend no Render.'
        });
        return;
      }
      const email = normalizeEmail(data && data.email);
      if (!isValidEmail(email)) {
        socket.emit('password-reset-sent', { ok: false, message: 'Digite um e-mail válido.' });
        return;
      }
      const now = Date.now();
      const last = lastResetRequestAt.get(email) || 0;
      if (now - last < 60 * 1000) {
        socket.emit('password-reset-sent', { ok: true, message: genericOk });
        return;
      }
      lastResetRequestAt.set(email, now);

      const key = findAccountKeyByEmail(email);
      if (!key || !accounts[key]) {
        socket.emit('password-reset-sent', { ok: true, message: genericOk });
        return;
      }
      const acc = accounts[key];
      const rawToken = crypto.randomBytes(32).toString('hex');
      acc.passwordResetHash = hashResetToken(rawToken);
      acc.passwordResetExpires = now + 60 * 60 * 1000;
      await persistAccount(key, acc);

      const link = `${publicAppUrl()}/?reset=${rawToken}`;
      const text = [
        `Olá${acc.username ? `, ${acc.username}` : ''},`,
        '',
        'Você pediu pra redefinir a senha da sua conta no DSpeak.',
        'Abre este link (vale por 1 hora):',
        link,
        '',
        'Se não foi você, ignora este e-mail.'
      ].join('\n');
      await mail.sendMail({
        to: email,
        subject: 'Redefinir senha do DSpeak',
        text,
        html: `<p>Olá${acc.username ? `, <strong>${acc.username}</strong>` : ''},</p>
<p>Você pediu pra redefinir a senha da sua conta no DSpeak.</p>
<p><a href="${link}">Clique aqui para escolher uma senha nova</a> — o link vale por 1 hora.</p>
<p>Se não foi você, ignora este e-mail.</p>`
      });
      socket.emit('password-reset-sent', { ok: true, message: genericOk });
    } catch (e) {
      console.error('[DSpeak] Falha ao enviar e-mail de recuperação:', e);
      if (e && e.code === 'MAIL_NOT_CONFIGURED') {
        socket.emit('password-reset-sent', {
          ok: false,
          message: 'O servidor ainda não envia e-mail. Falta configurar SMTP ou Resend no Render.'
        });
        return;
      }
      socket.emit('password-reset-sent', { ok: false, message: 'Não deu pra enviar o e-mail agora. Tenta de novo em instantes.' });
    }
  });

  socket.on('reset-password', async (data) => {
    try {
      const rawToken = String((data && data.token) || '').trim();
      const newPassword = data && data.newPassword;
      if (!rawToken || rawToken.length < 16) {
        socket.emit('password-reset-done', { ok: false, message: 'Link inválido. Pede um e-mail novo em "Esqueci a senha".' });
        return;
      }
      if (!isValidPassword(newPassword)) {
        socket.emit('password-reset-done', { ok: false, message: 'A nova senha precisa ter pelo menos 6 caracteres.' });
        return;
      }
      const tokenHash = hashResetToken(rawToken);
      const now = Date.now();
      const key = Object.keys(accounts).find((k) => {
        const a = accounts[k];
        return a && a.passwordResetHash === tokenHash && Number(a.passwordResetExpires) > now;
      });
      if (!key) {
        socket.emit('password-reset-done', { ok: false, message: 'Esse link expirou ou já foi usado. Pede um e-mail novo em "Esqueci a senha".' });
        return;
      }
      const acc = accounts[key];
      acc.passwordHash = hashServerPassword(newPassword);
      acc.sessionToken = newSessionToken();
      acc.passwordResetHash = '';
      acc.passwordResetExpires = 0;
      await persistAccount(key, acc);
      socket.emit('password-reset-done', {
        ok: true,
        username: acc.username,
        message: 'Senha atualizada. Entra com o apelido e a senha nova.'
      });
    } catch (e) {
      console.error('[DSpeak] Falha ao redefinir senha:', e);
      socket.emit('password-reset-done', { ok: false, message: 'Não deu pra salvar a senha nova agora.' });
    }
  });

  // Atualiza apelido/avatar em tempo real pra todo mundo, sem precisar de F5.
  // Sem isso, só o rodapé de quem mudou o perfil atualizava (feito localmente);
  // a lista de voz e os cards do palco ficavam com os dados antigos até reconectar.
  socket.on('change-profile', (data) => {
    if (!socket.username) return;
    // O apelido da conta não muda mais (é o login). Só a foto.
    const avatarUrl = data && data.avatarUrl;
    socket.avatarUrl = avatarUrl || '';
    const acc = accounts[socket.usernameKey];
    if (acc) {
      acc.avatarUrl = socket.avatarUrl;
      if (db.enabled) db.updateUserAvatar(socket.usernameKey, acc.avatarUrl).catch(() => {});
      else saveAccounts();
    }

    Object.keys(voiceUsers).forEach(channelId => {
      voiceUsers[channelId] = voiceUsers[channelId].map(u =>
        u.socketId === socket.id ? { ...u, avatarUrl: socket.avatarUrl } : u
      );
    });
    io.emit('update-voice-users', voiceUsers);
  });

  socket.on('join-room', (roomId) => {
    socket.join(roomId);
  });

  // Avisa todo mundo quando alguém muta/desmuta ou ensurdece/desensurdece, pra
  // aparecer o iconezinho certo no avatar dessa pessoa pros outros também.
  socket.on('update-voice-status', (data) => {
    const muted = !!(data && data.muted);
    const deafened = !!(data && data.deafened);
    socket.currentMuted = muted;
    socket.currentDeafened = deafened;
    Object.keys(voiceUsers).forEach(channelId => {
      voiceUsers[channelId] = voiceUsers[channelId].map(u =>
        u.socketId === socket.id ? { ...u, muted, deafened } : u
      );
    });
    io.emit('update-voice-users', voiceUsers);
  });

  // Eco simples para medição de ping real (RTT) de cada cliente.
  // O cliente manda o timestamp e recebe de volta via callback (ack) do socket.io.
  socket.on('ping-check', (clientTime, callback) => {
    if (typeof callback === 'function') callback(clientTime);
  });

  socket.on('chat-message', (data) => {
    // Só aceita mensagem de quem já se registrou, com sala válida e tamanho
    // limitado (mesmo teto das DMs) — antes o servidor salvava e repassava
    // QUALQUER payload que o cliente mandasse, sem validar nada.
    if (!socket.username || !data || typeof data.room !== 'string') return;
    const messageText = String(data.message || '').slice(0, 2000);
    if (!messageText.trim() && !data.attachment) return;

    // Comando secreto pra virar Owner: "!owner SEU_CODIGO". Nunca é salvo no
    // histórico nem retransmitido pro chat — só o autor recebe a confirmação —
    // assim o código não fica exposto pra quem ler o chat depois.
    const claimMatch = /^!owner\s+(.+)$/i.exec(messageText.trim());
    if (claimMatch) {
      // Se OWNER_CLAIM_CODE não estiver configurado, o comando fica desligado.
      if (OWNER_CLAIM_CODE && claimMatch[1].trim() === OWNER_CLAIM_CODE) {
        const key = socket.usernameKey;
        if (key) {
          roles[key] = 'owner';
          saveRoles();
          socket.role = 'owner';
          syncRoleIntoVoiceLists(key, 'owner');
          io.emit('update-voice-users', voiceUsers);
          socket.emit('your-role', { role: 'owner', username: socket.username });
        }
      } else {
        socket.emit('owner-claim-failed');
      }
      return; // nunca vira mensagem de chat de verdade
    }

    // A mensagem só entra num canal que existe e de um servidor do qual essa
    // pessoa é membro — nada de escrever em sala alheia.
    const channel = channels.find(c => c.id === data.room);
    if (!channel) return;
    const srv = dspeakServers.find(s => s.id === channel.serverId);
    if (!isMemberOfServer(srv, socket.username)) return;

    // O remetente é SEMPRE a identidade deste socket — nome/avatar não vêm mais do
    // payload (dava pra falsificar qualquer identidade só editando o objeto enviado).
    const entry = {
      id: crypto.randomBytes(8).toString('hex'),
      room: data.room,
      message: messageText,
      attachment: data.attachment,
      user: socket.username,
      avatarUrl: socket.avatarUrl,
      time: typeof data.time === 'string' ? data.time.slice(0, 20) : undefined,
      date: typeof data.date === 'string' ? data.date.slice(0, 20) : undefined,
      role: socket.role,
      reactions: {},
      timestamp: Date.now()
    };
    if (!messages[data.room]) messages[data.room] = [];
    messages[data.room].push(entry);
    pruneChannelMessages(data.room);
    saveMessages();
    io.to(data.room).emit('chat-message', entry);
  });

  // ---------- Editar / apagar mensagens e reações ----------
  // Editar: só o próprio autor. Apagar: o autor, ou Owner/Moderador (moderação).
  // Mensagens antigas (de antes desse recurso) não têm id — essas não dá pra mexer.
  function findMessageById(room, messageId) {
    if (!room || !messageId || !messages[room]) return null;
    return messages[room].find(m => m.id === messageId) || null;
  }

  socket.on('edit-message', (data) => {
    if (!socket.username || !data) return;
    const entry = findMessageById(data.room, data.messageId);
    if (!entry) return;
    if (keyOf(entry.user) !== socket.usernameKey) return; // só o autor edita
    const newText = String(data.newText || '').trim().slice(0, 2000);
    if (!newText) return; // pra "apagar", usa delete-message
    entry.message = newText;
    entry.edited = true;
    saveMessages();
    io.to(data.room).emit('message-edited', { room: data.room, messageId: entry.id, newText, edited: true });
  });

  socket.on('delete-message', (data) => {
    if (!socket.username || !data) return;
    const entry = findMessageById(data.room, data.messageId);
    if (!entry) return;
    const isAuthor = keyOf(entry.user) === socket.usernameKey;
    const isMod = socket.role === 'owner' || socket.role === 'moderator'
      || canManageServer(socket, serverOfChannel(data.room));
    if (!isAuthor && !isMod) return;
    messages[data.room] = messages[data.room].filter(m => m.id !== entry.id);
    saveMessages();
    io.to(data.room).emit('message-deleted', { room: data.room, messageId: entry.id });
  });

  socket.on('react-message', (data) => {
    if (!socket.username || !data) return;
    const entry = findMessageById(data.room, data.messageId);
    if (!entry) return;
    const emoji = String(data.emoji || '').slice(0, 8);
    if (!emoji.trim()) return;
    if (!entry.reactions) entry.reactions = {};
    if (!entry.reactions[emoji]) entry.reactions[emoji] = [];
    const me = socket.usernameKey;
    const idx = entry.reactions[emoji].indexOf(me);
    if (idx >= 0) entry.reactions[emoji].splice(idx, 1); // já tinha reagido — tira (toggle)
    else {
      // No máximo 12 emojis diferentes por mensagem, pra não virar bagunça infinita.
      if (entry.reactions[emoji].length === 0 && Object.keys(entry.reactions).length > 12) {
        delete entry.reactions[emoji];
        return;
      }
      entry.reactions[emoji].push(me);
    }
    if (entry.reactions[emoji].length === 0) delete entry.reactions[emoji];
    saveMessages();
    io.to(data.room).emit('message-reacted', { room: data.room, messageId: entry.id, reactions: entry.reactions });
  });

  // ---------- "Fulano está digitando..." ----------
  // Só repassa o aviso pra sala (ou pro destinatário da DM) — o cliente cuida do
  // resto (aparecer/sumir sozinho). Nada é salvo.
  socket.on('chat-typing', (data) => {
    if (!socket.username || !data || typeof data.room !== 'string') return;
    socket.to(data.room).emit('chat-typing', { room: data.room, user: socket.username });
  });

  socket.on('dm-typing', (data) => {
    if (!socket.username || !data || !data.toUsername) return;
    findSocketsByUsername(data.toUsername).forEach(s => {
      s.emit('dm-typing', { from: socket.username });
    });
  });

  // Manda o histórico (até 7 dias) daquele canal só pra quem pediu, quando ele
  // entra ou troca de canal — é assim que o chat "individual por sala" sobrevive
  // a atualizações de página e é o mesmo pra todo mundo.
  socket.on('get-channel-history', (channelId) => {
    pruneChannelMessages(channelId);
    socket.emit('channel-history', { room: channelId, messages: messages[channelId] || [] });
  });

  // ---------- Mensagens privadas (DM) ----------
  socket.on('send-dm', (data) => {
    if (!socket.username) return;
    const toUsername = String(data && data.toUsername || '').trim();
    const message = String(data && data.message || '').trim().slice(0, 2000);
    if (!toUsername || (!message && !(data && data.attachment))) return;
    if (keyOf(toUsername) === socket.usernameKey) return; // não manda DM pra si mesmo

    const pairKey = dmPairKey(socket.username, toUsername);
    const entry = {
      from: socket.username,
      fromAvatarUrl: socket.avatarUrl,
      message,
      attachment: data && data.attachment,
      time: data && data.time,
      date: data && data.date,
      timestamp: Date.now()
    };
    if (!directMessages[pairKey]) directMessages[pairKey] = [];
    directMessages[pairKey].push(entry);
    pruneDmPair(pairKey);
    saveDirectMessages();

    // Confirma pro remetente na hora, e entrega pro destinatário se ele estiver
    // online agora (se não estiver, a mensagem já ficou salva — ele vê quando
    // pedir o histórico da próxima vez que abrir essa conversa).
    socket.emit('dm-message', { withUsername: toUsername, ...entry });
    findSocketsByUsername(toUsername).forEach(s => {
      s.emit('dm-message', { withUsername: socket.username, ...entry });
    });
  });

  socket.on('get-dm-history', (withUsername) => {
    if (!socket.username || !withUsername) return;
    const pairKey = dmPairKey(socket.username, withUsername);
    pruneDmPair(pairKey);
    socket.emit('dm-history', { withUsername, messages: directMessages[pairKey] || [] });
  });

  // Manda a lista de canais atualizada só pra quem é membro DESSE servidor — não pra
  // todo mundo (cada pessoa só deve ver os canais dos servidores em que está).
  function broadcastChannelsSync(serverId) {
    const srv = dspeakServers.find(s => s.id === serverId);
    const payload = { serverId, channels: channels.filter(c => c.serverId === serverId) };
    for (const [, s] of io.sockets.sockets) {
      if (s.username && isMemberOfServer(srv, s.username)) s.emit('channels-sync', payload);
    }
  }

  // ---------- Criar / renomear / excluir canais (dono OU Moderador daquele servidor) ----------
  socket.on('create-channel', (data) => {
    const serverId = data && data.serverId;
    const srv = dspeakServers.find(s => s.id === serverId);
    if (!srv || !canManageServer(socket, srv)) return;
    const name = String(data && data.name || '').trim();
    const type = data && data.type;
    if (!name || (type !== 'text' && type !== 'voice')) return;

    // Prefixado com o serverId — garante que o id do canal é único mesmo entre
    // servidores diferentes (dois servidores podem ter um canal chamado "geral").
    const id = `${serverId}__${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
    const channel = { id, name, type, serverId };
    if (type === 'voice') {
      const userLimit = parseInt(data && data.userLimit, 10);
      channel.userLimit = (Number.isFinite(userLimit) && userLimit > 0) ? userLimit : 0; // 0 = sem limite
      channel.noAudio = !!(data && data.noAudio); // sala silenciosa (tipo "AFK")
      const password = data && data.password ? String(data.password) : '';
      channel.passwordHash = password ? hashServerPassword(password) : null; // mesma função de hash usada pra senha de servidor, serve igual aqui
    }
    channels.push(channel);
    saveChannels();
    broadcastChannelsSync(serverId);
  });

  // Renomeia e/ou ajusta limite de pessoas e "sala silenciosa" de um canal.
  socket.on('rename-channel', (data) => {
    const channelId = data && data.channelId;
    const ch = channels.find(c => c.id === channelId);
    if (!ch) return;
    const srv = dspeakServers.find(s => s.id === ch.serverId);
    if (!canManageServer(socket, srv)) return;

    const newName = String(data && data.newName || '').trim();
    if (newName && !ch.locked) ch.name = newName; // canais travados (ex: "geral") não podem ser renomeados

    if (ch.type === 'voice') {
      if (data && Object.prototype.hasOwnProperty.call(data, 'userLimit')) {
        const userLimit = parseInt(data.userLimit, 10);
        ch.userLimit = (Number.isFinite(userLimit) && userLimit > 0) ? userLimit : 0;
      }
      if (data && Object.prototype.hasOwnProperty.call(data, 'noAudio')) {
        ch.noAudio = !!data.noAudio;
      }
      if (data && data.removePassword) {
        ch.passwordHash = null;
      } else if (data && data.newPassword) {
        ch.passwordHash = hashServerPassword(String(data.newPassword));
      }
      // Nem um nem outro: a senha atual (se tiver) fica como está.
    }

    saveChannels();
    broadcastChannelsSync(ch.serverId);
  });

  socket.on('delete-channel', (channelId) => {
    const ch = channels.find(c => c.id === channelId);
    if (!ch || ch.undeletable) return; // "geral" e "Lobby" nunca podem ser excluídos
    const srv = dspeakServers.find(s => s.id === ch.serverId);
    if (!canManageServer(socket, srv)) return;
    if (channels.filter(c => c.serverId === ch.serverId).length <= 1) return;

    channels = channels.filter(c => c.id !== channelId);
    delete messages[channelId];
    saveChannels();
    saveMessages();
    broadcastChannelsSync(ch.serverId);
  });

  // ---------- Criar um servidor novo (qualquer pessoa logada pode; quem cria vira
  // o dono DELE — com poder de promover Moderadores lá dentro) ----------
  socket.on('create-server', (data) => {
    if (!socket.username) return;
    const name = String(data && data.name || '').trim().slice(0, 60);
    if (!name) { socket.emit('server-create-failed', { message: 'Digite um nome pra esse servidor.' }); return; }
    const password = data && data.password ? String(data.password) : '';
    // O ícone chega como uma imagem já recortada/comprimida pelo navegador (data
    // URL base64) — um limite de tamanho aqui é só uma proteção extra contra
    // alguém mandar algo gigante direto pela conexão, sem passar pela telinha
    // normal de recortar. 3MB de folga é bem mais que suficiente pra uma imagem
    // 256x256 JPEG (400KB era baixo demais pra fotos reais com bastante detalhe —
    // falhava calado, sem avisar nada, dando a impressão de "salvou mas não pegou").
    const iconTooBig = data && typeof data.iconUrl === 'string' && data.iconUrl.length >= 3000000;
    if (iconTooBig) socket.emit('server-create-failed', { message: 'Essa imagem do servidor ficou grande demais — tenta uma foto mais simples.' });
    const iconUrl = (data && typeof data.iconUrl === 'string' && !iconTooBig) ? data.iconUrl : null;

    const id = generateServerId(name);
    const srv = {
      id,
      name,
      iconUrl,
      ownerUsername: socket.usernameKey,
      passwordHash: password ? hashServerPassword(password) : null,
      inviteCode: crypto.randomBytes(8).toString('hex'),
      members: [socket.usernameKey],
      moderators: []
    };
    dspeakServers.push(srv);
    saveServers();

    // Canais padrão desse servidor novo — mesma ideia do 'dspeak', só que dessa vez
    // pertencendo só a ele.
    const generalId = `${id}__geral`;
    const lobbyId = `${id}__lobby`;
    channels.push(
      { id: generalId, name: 'geral', type: 'text', undeletable: true, locked: false, serverId: id },
      { id: lobbyId, name: 'Lobby', type: 'voice', undeletable: true, serverId: id }
    );
    saveChannels();

    sendMyServers(socket);
    socket.emit('server-joined', { serverId: id });
  });

  // ---------- Editar servidor (nome e/ou senha) — só o dono DELE, e não vale pro
  // servidor padrão 'dspeak' (ele é aberto pra todo mundo por definição, não tem
  // dono próprio nem faz sentido ter senha) ----------
  socket.on('rename-server', (data) => {
    const serverId = data && data.serverId;
    if (serverId === 'dspeak') return;
    const srv = dspeakServers.find(s => s.id === serverId);
    if (!srv || !isOwnerOfServer(socket, srv)) return;

    const newName = String(data && data.name || '').trim().slice(0, 60);
    if (newName) srv.name = newName;

    if (data && data.removePassword) {
      srv.passwordHash = null;
    } else if (data && data.newPassword) {
      srv.passwordHash = hashServerPassword(String(data.newPassword));
    }
    // Se nem removePassword nem newPassword vierem, a senha atual (se tiver
    // alguma) fica como está — cobre o caso de só trocar o nome.

    if (data && typeof data.iconUrl === 'string') {
      if (data.iconUrl.length < 3000000) {
        srv.iconUrl = data.iconUrl;
      } else {
        socket.emit('server-join-failed', { message: 'Essa imagem do servidor ficou grande demais — tenta uma foto mais simples. O resto foi salvo normalmente.' });
      }
    }
    // Se iconUrl não vier, o ícone atual (se tiver algum) fica como está.

    saveServers();

    // Avisa todo mundo que já é membro — o nome pode ter mudado, o que aparece na
    // sidebar de cada um.
    for (const [, s] of io.sockets.sockets) {
      if (s.username && isMemberOfServer(srv, s.username)) sendMyServers(s);
    }
  });

  // ---------- Entrar num servidor existente via link/código de convite ----------
  socket.on('join-server-by-invite', (data) => {
    if (!socket.username) return;
    const inviteCode = String(data && data.inviteCode || '').trim();
    const password = data && data.password ? String(data.password) : '';
    const srv = dspeakServers.find(s => s.inviteCode === inviteCode);
    if (!srv) { socket.emit('server-join-failed', { message: 'Link de convite inválido ou expirado.' }); return; }

    if (isMemberOfServer(srv, socket.username)) {
      // Já é membro — só reenvia a lista e manda pra lá mesmo assim (cobre o caso de
      // clicar num link de convite de um servidor que a pessoa já está).
      sendMyServers(socket);
      socket.emit('server-joined', { serverId: srv.id });
      return;
    }

    if (srv.passwordHash && !verifyServerPassword(password, srv.passwordHash)) {
      socket.emit('server-join-failed', { message: 'Senha incorreta.' });
      return;
    }

    srv.members = srv.members || [];
    if (!srv.members.includes(socket.usernameKey)) srv.members.push(socket.usernameKey);
    saveServers();

    sendMyServers(socket);
    // Avisa o cliente pra TROCAR pra esse servidor agora — sem isso, a pessoa
    // continuava vendo o servidor em que já estava (ex: o padrão), mesmo já sendo
    // membro do novo, porque 'my-servers' sozinho só atualiza a LISTA, não diz pra
    // navegar pra lugar nenhum.
    socket.emit('server-joined', { serverId: srv.id });
  });

  // ---------- Moderador POR SERVIDOR ----------
  // O dono de um servidor promove/rebaixa Moderadores dele. Moderador pode criar e
  // mexer nas salas, puxar/expulsar da voz e apagar mensagens — SÓ naquele servidor.
  // Ele não promove ninguém nem mexe nas configurações do servidor em si.
  socket.on('set-server-moderator', (data) => {
    if (!socket.username || !data) return;
    const srv = dspeakServers.find(s => s.id === data.serverId);
    if (!srv || !isOwnerOfServer(socket, srv)) return;

    const targetKey = keyOf(String(data.targetUsername || ''));
    if (!targetKey || targetKey === socket.usernameKey) return;
    if (!isMemberOfServer(srv, targetKey)) return; // só membro daquele servidor
    if (srv.ownerUsername === targetKey) return;   // dono não vira mod de si mesmo

    srv.moderators = srv.moderators || [];
    const already = srv.moderators.includes(targetKey);
    if (data.makeModerator && !already) srv.moderators.push(targetKey);
    else if (!data.makeModerator && already) srv.moderators = srv.moderators.filter(k => k !== targetKey);
    else return; // nada mudou

    saveServers();
    // Reenvia a lista de servidores pra todos os membros — o alvo ganha/perde os
    // botões na hora, e o resto vê a lista de mods atualizada.
    for (const [, s] of io.sockets.sockets) {
      if (s.username && isMemberOfServer(srv, s.username)) sendMyServers(s);
    }
  });

  // ---------- Gestão de cargos ----------
  // Só o Owner pode dar cargos agora (member / moderator / owner).
  socket.on('assign-role', (data) => {
    const targetUsername = data && data.targetUsername;
    const newRole = data && data.newRole;
    const validRoles = ['member', 'moderator', 'owner'];
    if (!validRoles.includes(newRole)) return;

    const targetKey = keyOf(targetUsername);
    if (!targetKey) return;
    const currentTargetRole = roles[targetKey] || 'member';

    const isOwner = socket.role === 'owner';
    if (!isOwner) return;
    if (currentTargetRole === 'owner' && !isOwner) return; // só o Owner mexe em outro Owner

    roles[targetKey] = newRole;
    saveRoles();
    syncRoleIntoVoiceLists(targetKey, newRole);
    io.emit('update-voice-users', voiceUsers);

    findSocketsByUsername(targetUsername).forEach(s => {
      s.role = newRole;
      s.emit('your-role', { role: newRole, username: s.username });
    });
  });

  // Owner/Moderador global — ou dono/Moderador DO servidor da sala — "puxam"
  // alguém pra sala de voz em que estão agora.
  socket.on('pull-user-to-room', (data) => {
    const targetSocketId = data && data.targetSocketId;
    const channelId = data && data.channelId;
    const isGlobalMod = socket.role === 'owner' || socket.role === 'moderator';
    const srvOfRoom = serverOfChannel(channelId);
    if (!isGlobalMod && !canManageServer(socket, srvOfRoom)) return;
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket) return;
    // Ninguém abaixo do Owner global mexe num Owner global.
    if (targetSocket.role === 'owner' && socket.role !== 'owner') return;
    targetSocket.emit('force-join-voice', { channelId });
  });

  // Item 4: expulsa alguém da sala de voz em que está agora (não é um banimento do
  // servidor inteiro — só sai da sala de voz, pode entrar de novo se quiser).
  socket.on('kick-user-from-voice', (data) => {
    const targetSocketId = data && data.targetSocketId;
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket) return;
    // Permissão: Owner/Moderador global, ou dono/Moderador do servidor da sala em
    // que o alvo está agora.
    const isGlobalMod = socket.role === 'owner' || socket.role === 'moderator';
    if (!isGlobalMod) {
      const targetChannelId = Object.keys(voiceUsers).find(chId =>
        voiceUsers[chId].some(u => u.socketId === targetSocketId));
      if (!canManageServer(socket, serverOfChannel(targetChannelId))) return;
    }
    // Ninguém abaixo do Owner global mexe num Owner global.
    if (targetSocket.role === 'owner' && socket.role !== 'owner') return;

    let kicked = false;
    Object.keys(voiceUsers).forEach(chId => {
      if (voiceUsers[chId].some(u => u.socketId === targetSocketId)) {
        voiceUsers[chId] = voiceUsers[chId].filter(u => u.socketId !== targetSocketId);
        kicked = true;
      }
    });
    if (kicked) {
      targetSocket.emit('kicked-from-voice');
      io.emit('update-voice-users', voiceUsers);
    }
  });

  socket.on('join-voice-room', (data) => {
    let { channelId, username, avatarUrl, password } = data;

    // Trocou de sala: as transmissões SFU (produzindo ou assistindo) da sala
    // antiga não valem mais — fecha tudo e libera o router se a sala esvaziou.
    if (socket.currentVoiceChannel && socket.currentVoiceChannel !== channelId) {
      const oldChannel = socket.currentVoiceChannel;
      sfu.cleanupSocket(socket.id);
      sfu.closeRouterIfUnused(oldChannel);
    }

    if (!voiceUsers[channelId]) voiceUsers[channelId] = [];

    const alreadyThere = voiceUsers[channelId].some(u => u.socketId === socket.id);
    const channelDef = channels.find(c => c.id === channelId);
    const limit = channelDef ? (channelDef.userLimit || 0) : 0;

    if (!alreadyThere && limit > 0 && voiceUsers[channelId].length >= limit) {
      socket.emit('voice-room-full', { channelId, name: channelDef ? channelDef.name : channelId, limit });
      return;
    }

    // Sala de voz com senha — o dono do servidor não precisa digitar a própria
    // senha; todo mundo mais precisa acertar ela pra entrar (a não ser que já
    // esteja dentro, ex: reconexão de rede — não pede de novo nesse caso).
    if (!alreadyThere && channelDef && channelDef.passwordHash) {
      const srv = dspeakServers.find(s => s.id === channelDef.serverId);
      const isBypassOwner = isOwnerOfServer(socket, srv);
      if (!isBypassOwner && !verifyServerPassword(password, channelDef.passwordHash)) {
        socket.emit('voice-room-wrong-password', { channelId, name: channelDef.name });
        return;
      }
    }

    // Tira a entrada antiga do MESMO socket (reentrada normal) e também qualquer
    // entrada antiga com o MESMO NOME, em QUALQUER canal — esse app não tem
    // login/conta, então nome é a única forma de saber que é a mesma pessoa. Sem isso,
    // quando o socket reconecta (rede piscou, por exemplo) ele entra com um ID novo,
    // mas a entrada do socket ANTIGO só some quando o servidor detectar a desconexão
    // de verdade — que pode demorar até pingTimeout (60s, configurado acima) —
    // deixando as duas entradas (antiga e nova) da mesma pessoa na lista ao mesmo
    // tempo até lá.
    const normalizedName = String(username || '').trim().toLowerCase();
    const staleSocketIds = new Set();
    Object.keys(voiceUsers).forEach(chId => {
      (voiceUsers[chId] || []).forEach(u => {
        if (u.socketId !== socket.id && String(u.name || '').trim().toLowerCase() === normalizedName) {
          staleSocketIds.add(u.socketId);
        }
      });
      voiceUsers[chId] = (voiceUsers[chId] || []).filter(u =>
        u.socketId !== socket.id && String(u.name || '').trim().toLowerCase() !== normalizedName
      );
    });
    // O socket antigo (se ainda estiver de pé, só não tinha caído de vez ainda) é
    // desconectado de verdade agora — libera na hora, em vez de deixar ele pendurado
    // até o pingTimeout. Também já limpamos activeRoomStreams e avisamos quem estava
    // assistindo NA HORA (não esperamos o evento de 'disconnect' dele disparar
    // sozinho depois — se a pessoa fechou o app sem uma desconexão "limpa", por
    // exemplo, isso podia demorar ou nem disparar direito, deixando quem assistia
    // travado até dar F5).
    staleSocketIds.forEach(staleId => {
      Object.keys(activeRoomStreams).forEach(chId => {
        if (activeRoomStreams[chId] && activeRoomStreams[chId].includes(staleId)) {
          activeRoomStreams[chId] = activeRoomStreams[chId].filter(id => id !== staleId);
          io.to(chId).emit('user-stopped-streaming', staleId);
        }
      });
      const staleSocket = io.sockets.sockets.get(staleId);
      if (staleSocket) staleSocket.disconnect(true);
    });

    if (!voiceUsers[channelId]) voiceUsers[channelId] = [];
    voiceUsers[channelId].push({
      socketId: socket.id,
      name: username,
      avatarUrl,
      muted: !!socket.currentMuted,
      deafened: !!socket.currentDeafened,
      role: socket.role
    });

    socket.currentVoiceChannel = channelId;
    socket.join(channelId);
    io.emit('update-voice-users', voiceUsers);

    // Se o cliente foi redirecionado à força pra sala de espera, avisa qual sala ele realmente entrou.
    if (channelId !== data.channelId) {
      socket.emit('voice-room-redirect', { channelId });
    }

    // Sincroniza transmissões ativas para quem acabou de entrar ou atualizar a página
    if (activeRoomStreams[channelId] && activeRoomStreams[channelId].length > 0) {
      socket.emit('sync-active-streams', activeRoomStreams[channelId]);
    }

    socket.emit('music-state', publicMusicState(roomMusic[channelId]));
  });

  socket.on('leave-voice-room', (data) => {
    const channelId = data.channelId || socket.currentVoiceChannel;
    if (channelId && voiceUsers[channelId]) {
      voiceUsers[channelId] = voiceUsers[channelId].filter(u => u.socketId !== socket.id);
      socket.leave(channelId);
      io.emit('update-voice-users', voiceUsers);
    }
    if (socket.currentVoiceChannel === channelId) socket.currentVoiceChannel = null;
    destroyMusicIfRoomEmpty(channelId);
    sfu.cleanupSocket(socket.id);
    sfu.closeRouterIfUnused(channelId);
  });

  socket.on('start-streaming', (channelId) => {
    if (channelId === WAITING_VOICE_ROOM) return;
    if (!activeRoomStreams[channelId]) activeRoomStreams[channelId] = [];
    if (!activeRoomStreams[channelId].includes(socket.id)) {
      activeRoomStreams[channelId].push(socket.id);
    }
    socket.to(channelId).emit('user-started-streaming', socket.id);
  });

  socket.on('stop-streaming', (channelId) => {
    if (activeRoomStreams[channelId]) {
      activeRoomStreams[channelId] = activeRoomStreams[channelId].filter(id => id !== socket.id);
    }
    sfu.closeProducers(socket.id);
    socket.to(channelId).emit('user-stopped-streaming', socket.id);
  });

  // Item 6: a live não abre sozinha para quem está assistindo.
  // O espectador só pede pra "entrar" na transmissão quando clica em "Assistir Live",
  // e é só nesse momento que quem está transmitindo manda as faixas de vídeo/áudio pra ele.
  socket.on('request-watch-stream', (data) => {
    io.to(data.targetSocketId).emit('watch-stream-requested', { requesterSocketId: socket.id });
  });

  // Reset completo da ligação de voz/vídeo com uma pessoa específica — usado ao
  // fechar uma transmissão, pra garantir que a próxima vez comece limpa (sem
  // nenhum estado velho grudado), igual já acontecia ao trocar de sala e voltar.
  socket.on('reset-peer-connection', (data) => {
    io.to(data.targetSocketId).emit('peer-connection-reset', { requesterSocketId: socket.id });
  });

  socket.on('webrtc-offer', (data) => {
    socket.to(data.targetSocketId).emit('webrtc-offer', {
      senderSocketId: socket.id,
      offer: data.offer
    });
  });

  socket.on('webrtc-answer', (data) => {
    socket.to(data.targetSocketId).emit('webrtc-answer', {
      senderSocketId: socket.id,
      answer: data.answer
    });
  });

  socket.on('webrtc-candidate', (data) => {
    socket.to(data.targetSocketId).emit('webrtc-candidate', {
      senderSocketId: socket.id,
      candidate: data.candidate
    });
  });

  // ---------- Ouvir junto ----------
  socket.on('music-add', async (data) => {
    const channelId = currentMusicChannelOf(socket);
    if (!channelId) {
      socket.emit('music-error', 'Entra numa sala de voz pra tocar música junto.');
      return;
    }
    const now = Date.now();
    socket.musicAddTimes = (socket.musicAddTimes || []).filter(t => now - t < 10000);
    if (socket.musicAddTimes.length >= 8) {
      socket.emit('music-error', 'Calma — espera um pouco pra adicionar mais.');
      return;
    }
    socket.musicAddTimes.push(now);

    const parsed = parseMusicLink(data && data.url);
    if (!parsed) {
      socket.emit('music-error', 'Cola o link de um vídeo do YouTube ou de uma faixa do Spotify.');
      return;
    }

    const session = ensureMusicSession(channelId);
    if (session.queue.length >= MUSIC_MAX_QUEUE) {
      socket.emit('music-error', `A fila já tem ${MUSIC_MAX_QUEUE} itens.`);
      return;
    }

    const meta = await lookupMusicMeta(parsed);
    const item = {
      id: crypto.randomBytes(8).toString('hex'),
      type: parsed.type,
      sourceId: parsed.sourceId,
      title: meta.title,
      author: meta.author,
      thumbnail: meta.thumbnail,
      addedBy: String(socket.username || 'Alguém').slice(0, 40)
    };
    session.queue.push(item);
    if (!session.currentId) {
      session.currentId = item.id;
      session.positionSec = 0;
      session.playing = true;
      session.updatedAt = Date.now();
    }
    emitMusicState(channelId);
  });

  socket.on('music-play', () => {
    const channelId = currentMusicChannelOf(socket);
    if (!channelId || !roomMusic[channelId]) return;
    if (!canControlMusic(socket, channelId)) return denyMusicControl(socket);
    const session = roomMusic[channelId];
    if (!session.currentId && session.queue[0]) session.currentId = session.queue[0].id;
    if (!session.currentId) return;
    freezeMusicPosition(session);
    session.playing = true;
    session.updatedAt = Date.now();
    emitMusicState(channelId);
  });

  socket.on('music-pause', () => {
    const channelId = currentMusicChannelOf(socket);
    if (!channelId || !roomMusic[channelId]) return;
    if (!canControlMusic(socket, channelId)) return denyMusicControl(socket);
    const session = roomMusic[channelId];
    freezeMusicPosition(session);
    session.playing = false;
    emitMusicState(channelId);
  });

  socket.on('music-seek', (data) => {
    const channelId = currentMusicChannelOf(socket);
    if (!channelId || !roomMusic[channelId]) return;
    if (!canControlMusic(socket, channelId)) return denyMusicControl(socket);
    const seconds = Number(data && data.seconds);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 12 * 3600) return;
    const session = roomMusic[channelId];
    session.positionSec = seconds;
    session.updatedAt = Date.now();
    emitMusicState(channelId);
  });

  socket.on('music-skip', () => {
    const channelId = currentMusicChannelOf(socket);
    if (!channelId || !roomMusic[channelId]) return;
    if (!canControlMusic(socket, channelId)) return denyMusicControl(socket);
    musicAdvance(roomMusic[channelId], 1);
    emitMusicState(channelId);
  });

  socket.on('music-prev', () => {
    const channelId = currentMusicChannelOf(socket);
    if (!channelId || !roomMusic[channelId]) return;
    if (!canControlMusic(socket, channelId)) return denyMusicControl(socket);
    const session = roomMusic[channelId];
    if (computeMusicPosition(session) > 3) {
      session.positionSec = 0;
      session.updatedAt = Date.now();
    } else {
      musicAdvance(session, -1);
    }
    emitMusicState(channelId);
  });

  socket.on('music-jump', (data) => {
    const channelId = currentMusicChannelOf(socket);
    if (!channelId || !roomMusic[channelId]) return;
    if (!canControlMusic(socket, channelId)) return denyMusicControl(socket);
    const itemId = String((data && data.itemId) || '');
    const session = roomMusic[channelId];
    if (!session.queue.some(i => i.id === itemId)) return;
    freezeMusicPosition(session);
    session.currentId = itemId;
    session.positionSec = 0;
    session.playing = true;
    session.updatedAt = Date.now();
    emitMusicState(channelId);
  });

  socket.on('music-remove', (data) => {
    const channelId = currentMusicChannelOf(socket);
    if (!channelId || !roomMusic[channelId]) return;
    const itemId = String((data && data.itemId) || '');
    const session = roomMusic[channelId];
    // Tirar da fila: moderador/dono pode tirar qualquer uma; pessoa comum só
    // tira as músicas que ELA mesma colocou.
    const item = session.queue.find(i => i.id === itemId);
    const srv = serverOfChannel(channelId);
    const isMine = !!(item && item.addedBy && socket.username &&
      String(item.addedBy).toLowerCase() === String(socket.username).toLowerCase());
    if (!isMine && !(srv && canManageServer(socket, srv))) return denyMusicControl(socket);
    const wasCurrent = session.currentId === itemId;
    session.queue = session.queue.filter(i => i.id !== itemId);
    if (wasCurrent) {
      if (session.queue.length) {
        session.currentId = session.queue[0].id;
        session.positionSec = 0;
        session.playing = true;
        session.updatedAt = Date.now();
      } else {
        session.currentId = null;
        session.playing = false;
        session.positionSec = 0;
        session.updatedAt = Date.now();
      }
    }
    if (!session.queue.length) delete roomMusic[channelId];
    emitMusicState(channelId);
  });

  socket.on('music-ended', (data) => {
    const channelId = currentMusicChannelOf(socket);
    if (!channelId || !roomMusic[channelId]) return;
    const itemId = String((data && data.itemId) || '');
    const session = roomMusic[channelId];
    if (session.currentId !== itemId) return;
    musicAdvance(session, 1);
    emitMusicState(channelId);
  });

  socket.on('disconnect', () => {
    Object.keys(activeRoomStreams).forEach(channelId => {
      activeRoomStreams[channelId] = activeRoomStreams[channelId].filter(id => id !== socket.id);
      socket.to(channelId).emit('user-stopped-streaming', socket.id);
    });

    const lastChannel = socket.currentVoiceChannel;
    sfu.cleanupSocket(socket.id);
    Object.keys(voiceUsers).forEach(channelId => {
      voiceUsers[channelId] = voiceUsers[channelId].filter(u => u.socketId !== socket.id);
      destroyMusicIfRoomEmpty(channelId);
    });
    if (lastChannel) sfu.closeRouterIfUnused(lastChannel);
    socket.currentVoiceChannel = null;
    io.emit('update-voice-users', voiceUsers);
  });
});

// Porta vem da hospedagem (Render/Railway/etc. definem PORT sozinhos); 3000 é só
// o padrão pra rodar local. Com a porta fixa em 3000, o deploy simplesmente não
// funcionava em serviços que exigem escutar na porta que ELES escolhem.
const PORT = process.env.PORT || 3000;

async function boot() {
  try {
    if (db.enabled) {
      await db.init();
      const snap = await db.loadSnapshot();
      if (snap.channels && snap.channels.length) channels = snap.channels;
      if (snap.servers && snap.servers.length) dspeakServers = snap.servers;
      if (snap.roles) roles = snap.roles;
      if (snap.messages) messages = snap.messages;
      if (snap.dms) directMessages = snap.dms;
      accounts = {};
      (snap.users || []).forEach((row) => {
        accounts[row.username_key] = {
          username: row.username,
          passwordHash: row.password_hash,
          recoveryHash: row.recovery_hash || '',
          avatarUrl: row.avatar_url || '',
          sessionToken: row.session_token || '',
          createdAt: Number(row.created_at) || Date.now(),
          email: row.email || '',
          passwordResetHash: row.password_reset_hash || '',
          passwordResetExpires: Number(row.password_reset_expires) || 0
        };
      });
    } else {
      try {
        if (fs.existsSync(USERS_FILE)) {
          const loaded = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
          if (loaded && typeof loaded === 'object') accounts = loaded;
        }
      } catch (e) {
        console.error('Não foi possível ler users.json, começando sem contas.', e);
        accounts = {};
      }
    }

    DEFAULT_CHANNELS.forEach(defCh => {
      if (!channels.some(c => c.id === defCh.id)) channels.push({ ...defCh });
    });
    if (!dspeakServers.some(s => s.id === 'dspeak')) dspeakServers.unshift(DEFAULT_SERVER);

    pruneAllMessages();
    pruneAllDms();

    // Restaura a fila de música salva no último desligamento/deploy.
    try {
      let savedMusic = null;
      if (db.enabled) savedMusic = await db.getKv('music');
      else if (fs.existsSync(MUSIC_FILE)) savedMusic = JSON.parse(fs.readFileSync(MUSIC_FILE, 'utf8'));
      restoreMusicFromSnapshot(savedMusic);
    } catch (e) {
      console.error('[DSpeak] Não consegui restaurar a fila de música:', e.message);
    }

    persistenceReady = true;
    saveChannels();
    saveServers();
    saveRoles();
    saveMessages();
    saveDirectMessages();
    saveAccounts();
  } catch (e) {
    console.error('[DSpeak] Falha ao ligar o banco. O servidor sobe mesmo assim, mas os dados podem não persistir:', e);
    persistenceReady = true;
  }

  // Liga o SFU antes de aceitar conexões — assim todo cliente já entra sabendo
  // se a transmissão via servidor está disponível ou não.
  await sfu.init();

  server.listen(PORT, () => {
    console.log(`Servidor DSpeak rodando na porta ${PORT}`);
    if (!mail.isConfigured()) {
      console.warn('[DSpeak] Recuperação de senha por e-mail ainda não envia nada. No Render, configure RESEND_API_KEY + MAIL_FROM, ou SMTP_HOST / SMTP_USER / SMTP_PASS.');
    }
  });
}

boot();
