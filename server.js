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
const aic = require('./aic');
const voiceLock = require('./voicelock-server');

const app = express();
const server = http.createServer(app);
// pingTimeout mais alto do que o padrão: dá mais tempo pro cliente responder antes de
// ser considerado desconectado — ajuda bastante em celular (tela travada/app em
// segundo plano, que o navegador desacelera bastante) e Wi-Fi instável.
const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000
});

// express.static ignora diretórios iniciados por ponto por padrão; App Links exige
// exatamente este caminho público.
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.type('application/json').sendFile(
    path.join(__dirname, 'public', '.well-known', 'assetlinks.json'),
    { dotfiles: 'allow' }
  );
});

// index: false — sem isso, o express.static entregava o index.html direto na
// raiz e as rotas abaixo (landing page x app) nunca rodavam.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// A raiz agora é o SITE de apresentação (baixar o app, conhecer o DSpeak).
// Exceção: o app desktop (Electron) aponta pra raiz desde sempre — detecta pelo
// user-agent e manda direto pro app, pra ninguém precisar baixar um .exe novo.
app.get('/', (req, res) => {
  if (/Electron/i.test(req.headers['user-agent'] || '')) return res.redirect('/app');
  res.sendFile(path.join(__dirname, 'public', 'site.html'));
});

// O aplicativo de verdade (a tela de login já faz parte dele).
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Reunião instantânea (estilo Meet): o link /m/abc-defg-hij abre o próprio app
// em modo convidado — a pessoa só digita um nome, sem conta e sem servidor.
app.get('/m/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Landing: "Iniciar reunião instantânea" cria a sala e manda direto pro /m/xxx
// (POST pra crawler/prefetch não gerar sala sem querer).
app.post('/meet/new', (req, res) => {
  const result = tryCreateMeeting(requestIp(req), '');
  if (!result.ok) return res.redirect('/app');
  res.redirect('/m/' + result.meeting.id);
});

// Atalho amigável: /login e /download levam pros lugares certos.
app.get('/login', (req, res) => res.redirect('/app'));
app.get('/download', (req, res) => res.redirect('/download/windows'));

// Entrega o instalador do Windows mais recente que estiver na pasta downloads/
// (fica fora do git — sobe direto pra VPS via scp quando sair versão nova).
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(__dirname, 'downloads');

// Atualização automática do app desktop (electron-updater): o app instalado
// consulta /updates/latest.yml pra saber se saiu versão nova e baixa o .exe
// daqui mesmo — a mesma pasta do botão de download do site.
app.use('/updates', express.static(DOWNLOADS_DIR));
app.get('/download/windows', (req, res) => {
  try {
    const newest = fs.readdirSync(DOWNLOADS_DIR)
      .filter(f => f.toLowerCase().endsWith('.exe'))
      .map(f => ({ f, m: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    if (!newest) throw new Error('sem instalador');
    res.download(path.join(DOWNLOADS_DIR, newest.f), 'DSpeak-Setup.exe');
  } catch (e) {
    res.status(404).send('Instalador ainda não disponível — tenta de novo daqui a pouco.');
  }
});

// Mesmo esquema pro Android: entrega o .apk mais recente da pasta downloads/.
app.get('/download/android', (req, res) => {
  try {
    const newest = fs.readdirSync(DOWNLOADS_DIR)
      .filter(f => f.toLowerCase().endsWith('.apk'))
      .map(f => ({ f, m: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    if (!newest) throw new Error('sem apk');
    res.download(path.join(DOWNLOADS_DIR, newest.f), 'DSpeak.apk');
  } catch (e) {
    res.status(404).send('App Android ainda não disponível — tenta de novo daqui a pouco.');
  }
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

aic.mount(app);
voiceLock.mount(app);

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

// ---------- Reuniões instantâneas (estilo Meet) ----------
// Qualquer pessoa cria um link /m/abc-defg-hij e manda pra quem quiser: quem
// abre só digita um NOME (sem conta, sem servidor) e cai na sala com voz, tela,
// câmera e chat. A sala vive 40 minutos e fecha sozinha — pra continuar, é só
// gerar outro link. Tudo em memória: reunião é descartável por natureza.
const meetings = {}; // meetingId -> { id, createdAt, expiresAt, warned, hostName }
const MEETING_TTL_MS = 40 * 60 * 1000;
const MEETING_MAX_PEOPLE = 25;
const meetingCreationByIp = {}; // ip -> [timestamps] (anti-abuso)

function generateMeetingId() {
  // Formato do Meet (abc-defg-hij): fácil de ler em voz alta e de digitar.
  const letters = () => Array.from(crypto.randomBytes(8))
    .map(b => 'abcdefghijkmnpqrstuvwxyz'[b % 24]).join('');
  const raw = letters();
  return `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7, 8)}${letters().slice(0, 2)}`;
}

function requestIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// Rate limit + criação da sala. Usado pelo socket (tela de login) e pelo
// POST /meet/new (botão da landing). Mesma regra: no máximo 5 por IP a cada 10 min.
function tryCreateMeeting(ip, hostName) {
  const now = Date.now();
  const key = String(ip || '').trim() || 'unknown';
  meetingCreationByIp[key] = (meetingCreationByIp[key] || []).filter(t => now - t < 10 * 60 * 1000);
  if (meetingCreationByIp[key].length >= 5) {
    return { error: 'rate-limited', message: 'Calma! Você criou reuniões demais — espera uns minutos.' };
  }
  meetingCreationByIp[key].push(now);

  let id;
  do { id = generateMeetingId(); } while (meetings[id]);
  meetings[id] = {
    id,
    createdAt: now,
    expiresAt: now + MEETING_TTL_MS,
    warned: false,
    hostName: String(hostName || '').trim().slice(0, 30)
  };
  console.log(`[Reunião] ${id} criada (${meetings[id].hostName || 'sem nome'}).`);
  return { ok: true, meeting: meetings[id] };
}

function meetingChannelId(id) { return 'meeting:' + id; }
function isMeetingChannelId(channelId) { return String(channelId || '').startsWith('meeting:'); }
function meetingIdOfChannel(channelId) { return String(channelId || '').slice('meeting:'.length); }

// Reunião viva (existe e não expirou) daquele canal — ou null.
function meetingOfChannel(channelId) {
  if (!isMeetingChannelId(channelId)) return null;
  const m = meetings[meetingIdOfChannel(channelId)];
  return (m && m.expiresAt > Date.now()) ? m : null;
}

// Esse socket pode agir dentro desse canal de reunião? (entrou por join-meeting)
function socketInMeeting(socket, channelId) {
  return !!socket.meetingId && meetingChannelId(socket.meetingId) === channelId && !!meetingOfChannel(channelId);
}

function closeMeeting(id, reason) {
  const m = meetings[id];
  if (!m) return;
  delete meetings[id];
  const chId = meetingChannelId(id);
  io.to(chId).emit('meeting-closed', { meetingId: id, reason: reason || 'expired' });
  // Derruba a sala de voz e libera o router SFU / música / chat da reunião.
  (voiceUsers[chId] || []).forEach(u => {
    const s = io.sockets.sockets.get(u.socketId);
    if (s) {
      s.leave(chId);
      if (s.currentVoiceChannel === chId) s.currentVoiceChannel = null;
      sfu.cleanupSocket(s.id);
    }
  });
  delete voiceUsers[chId];
  io.emit('update-voice-users', voiceUsers);
  delete activeRoomStreams[chId];
  delete messages[chId];
  saveMessages();
  destroyMusicIfRoomEmpty(chId);
  sfu.closeRouterIfUnused(chId);
  console.log(`[Reunião] ${id} encerrada (${reason || 'tempo esgotado'}).`);
}

// Varredor: avisa aos 5 minutos do fim e fecha quando o tempo acaba.
setInterval(() => {
  const now = Date.now();
  Object.values(meetings).forEach(m => {
    const remaining = m.expiresAt - now;
    if (remaining <= 5 * 60 * 1000 && remaining > 0 && !m.warned) {
      m.warned = true;
      io.to(meetingChannelId(m.id)).emit('meeting-ending-soon', { minutes: 5 });
    }
    if (remaining <= 0) closeMeeting(m.id, 'expired');
  });
}, 30 * 1000);

// ---------- Status visível (Disponível / Ausente / Ocupado) ----------
// Guardado por nome (minúsculas) enquanto o servidor está de pé — não precisa
// persistir em disco: cada cliente relembra o próprio status do localStorage e
// reenvia ao conectar.
const userStatuses = {}; // usernameKey -> 'online' | 'idle' | 'dnd'
const VALID_STATUSES = ['online', 'idle', 'dnd'];

function broadcastStatuses() {
  io.emit('user-statuses', userStatuses);
}

// Status personalizado ("jogando CS", "estudando"...) — texto curto ao lado do
// status colorido. Igual o status: vive em memória, o cliente reenvia ao logar.
const userCustomStatus = {}; // usernameKey -> texto
function broadcastCustomStatuses() {
  io.emit('user-custom-statuses', userCustomStatus);
}

// Push fica opcional até existirem credenciais Firebase. Mesmo desativado,
// tokens e preferências já podem ser registrados sem quebrar clientes antigos.
const PUSH_ENABLED = process.env.FIREBASE_PUSH_ENABLED === '1';
const PUSH_FILE = path.join(DATA_DIR, 'push.json');
let pushState = { devices: {}, preferences: {} };
let firebaseMessaging = null;
if (PUSH_ENABLED) {
  try {
    const firebaseAdmin = require('firebase-admin');
    if (!firebaseAdmin.apps.length) {
      firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.applicationDefault()
      });
    }
    firebaseMessaging = firebaseAdmin.messaging();
    console.log('[DSpeak] Firebase Cloud Messaging ativo.');
  } catch (e) {
    console.error('[DSpeak] Firebase Push não iniciou:', e.message);
  }
}
try {
  if (fs.existsSync(PUSH_FILE)) pushState = JSON.parse(fs.readFileSync(PUSH_FILE, 'utf8'));
} catch (e) {
  console.error('[DSpeak] Não foi possível ler push.json:', e.message);
}
function savePushState() {
  if (!persistenceReady) return;
  if (db.enabled) db.saveKvDebounced('push', pushState);
  else saveJsonDebounced(PUSH_FILE, () => pushState);
}
registerFlushable(PUSH_FILE, () => pushState);

async function sendPushToUser(username, preference, title, body, data = {}) {
  if (!firebaseMessaging) return;
  const usernameKey = keyOf(username);
  const preferences = pushState.preferences[usernameKey] || {};
  if (preferences[preference] === false) return;
  const devices = Array.isArray(pushState.devices[usernameKey])
    ? pushState.devices[usernameKey] : [];
  const tokens = [...new Set(devices.map(d => d && d.token).filter(Boolean))].slice(0, 500);
  if (!tokens.length) return;
  try {
    const response = await firebaseMessaging.sendEachForMulticast({
      tokens,
      notification: { title: String(title).slice(0, 120), body: String(body).slice(0, 500) },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: {
        priority: 'high',
        notification: { channelId: 'dspeak_messages', sound: 'default' }
      }
    });
    const invalid = new Set();
    response.responses.forEach((item, index) => {
      const code = item.error && item.error.code;
      if (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token') invalid.add(tokens[index]);
    });
    if (invalid.size) {
      pushState.devices[usernameKey] = devices.filter(d => !invalid.has(d.token));
      savePushState();
    }
  } catch (e) {
    console.error(`[DSpeak] Falha ao enviar push para ${usernameKey}:`, e.message);
  }
}

// ---------- Ouvir junto (YouTube / Spotify oficiais) ----------
// Estado por sala de voz. O áudio NÃO é baixado nem retransmitido pelo servidor —
// só a fila/play/pause/posição. Cada cliente toca no player oficial (iframe).
const roomMusic = {};
const MUSIC_MAX_QUEUE = 40;

// Playlists salvas por usuário (persistem entre sessões e servidores).
const PLAYLISTS_FILE = path.join(DATA_DIR, 'playlists.json');
let userPlaylists = {}; // usernameKey -> [{ name, items: [{type, sourceId, title, author, thumbnail}] }]
try {
  if (fs.existsSync(PLAYLISTS_FILE)) userPlaylists = JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8'));
} catch (e) { console.error('[DSpeak] Falha ao ler playlists.json:', e.message); }
const MAX_PLAYLISTS_PER_USER = 20;
function savePlaylists() { saveJsonDebounced(PLAYLISTS_FILE, () => userPlaylists); }
registerFlushable(PLAYLISTS_FILE, () => userPlaylists);
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

// O servidor 'dspeak' padrão usa o sistema de Owner global (roles.json), não um dono
// próprio. Desde a mudança "estilo Discord", ele NÃO aceita mais todo mundo
// automaticamente: quem já tinha conta foi migrado pra lista de membros uma única vez
// (ver boot()), e conta nova só entra por convite, como qualquer outro servidor.
const DEFAULT_SERVER = {
  id: 'dspeak',
  name: 'DSPEAK SERVER',
  ownerUsername: null, // null = usa o Owner global (roles.json), não um dono próprio
  passwordHash: null,
  inviteCode: null, // gerado no boot se ainda não existir
  members: [],
  roleDefinitions: [],
  memberRoleIds: {},
  membersMigrated: false // vira true depois da migração única das contas antigas
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

// Igual ao Discord agora: NINGUÉM é membro automático de servidor nenhum — nem
// do DSPEAK SERVER padrão. Quem já tinha conta antes dessa mudança foi migrado
// pra lista de membros dele no boot (ver boot()); cadastro novo começa sem
// servidor nenhum e só entra com convite (ou criando o próprio).
function isMemberOfServer(srv, username) {
  if (!srv) return false;
  const key = keyOf(username);
  return srv.ownerUsername === key || (srv.members || []).includes(key);
}

const SERVER_PERMISSION_KEYS = [
  'manageChannels', 'moderateMembers', 'manageInvites',
  'manageMessages', 'manageRoles', 'serverMute'
];
const MODERATOR_PERMISSIONS = Object.fromEntries(SERVER_PERMISSION_KEYS.map(k => [k, true]));

function ensureServerRoleModel(srv) {
  if (!srv) return;
  if (!Array.isArray(srv.roleDefinitions)) srv.roleDefinitions = [];
  if (!srv.memberRoleIds || typeof srv.memberRoleIds !== 'object' || Array.isArray(srv.memberRoleIds)) {
    srv.memberRoleIds = {};
  }
  // Migração compatível: moderadores antigos recebem um cargo interno equivalente.
  let legacy = srv.roleDefinitions.find(r => r && r.id === 'legacy-moderator');
  if (!legacy) {
    legacy = {
      id: 'legacy-moderator', name: 'Moderador', color: '#00ffcc',
      position: 100, permissions: { ...MODERATOR_PERMISSIONS }, managed: true
    };
    srv.roleDefinitions.push(legacy);
  }
  for (const memberKey of (srv.moderators || [])) {
    const current = Array.isArray(srv.memberRoleIds[memberKey]) ? srv.memberRoleIds[memberKey] : [];
    if (!current.includes(legacy.id)) srv.memberRoleIds[memberKey] = [...current, legacy.id];
  }
}

function permissionsForMember(srv, username) {
  ensureServerRoleModel(srv);
  const key = keyOf(username);
  const ids = (srv.memberRoleIds && Array.isArray(srv.memberRoleIds[key])) ? srv.memberRoleIds[key] : [];
  const out = {};
  for (const id of ids) {
    const def = srv.roleDefinitions.find(r => r && r.id === id);
    if (!def) continue;
    for (const perm of SERVER_PERMISSION_KEYS) {
      if (def.permissions && def.permissions[perm]) out[perm] = true;
    }
  }
  return out;
}

function hasServerPermission(socket, srv, permission) {
  if (isOwnerOfServer(socket, srv)) return true;
  return !!permissionsForMember(srv, socket && socket.username)[permission];
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
  if (srv && (isOwnerOfServer(socket, srv) || hasServerPermission(socket, srv, 'manageMessages'))) return true;
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

// Canal marcado como "só pra moderadores" fica invisível (e inacessível) pra quem
// não gerencia aquele servidor — igual canal privado de staff no Discord.
function canSeeChannel(socket, ch, srv) {
  if (!ch) return false;
  if (!ch.modsOnly) return true;
  const server = srv || dspeakServers.find(s => s.id === ch.serverId);
  return isOwnerOfServer(socket, server) ||
    hasServerPermission(socket, server, 'manageChannels') ||
    hasServerPermission(socket, server, 'manageMessages');
}

function visibleChannelsFor(socket, srv) {
  return channels
    .filter(c => c.serverId === srv.id && canSeeChannel(socket, c, srv))
    .map(sanitizeChannelForClient);
}

function sendMyServers(socket) {
  const username = socket.username;
  const mine = dspeakServers
    .filter(srv => isMemberOfServer(srv, username))
    .map(srv => {
      ensureServerRoleModel(srv);
      return ({
      id: srv.id,
      name: srv.name,
      iconUrl: srv.iconUrl || null,
      hasPassword: !!srv.passwordHash,
      isOwner: isOwnerOfServer(socket, srv),
      isModerator: isModeratorOfServer(socket, srv),
      moderators: srv.moderators || [],
      roleDefinitions: srv.roleDefinitions || [],
      memberRoleIds: srv.memberRoleIds || {},
      myPermissions: permissionsForMember(srv, socket.username),
      inviteCode: (isOwnerOfServer(socket, srv) || hasServerPermission(socket, srv, 'manageInvites'))
        ? srv.inviteCode : undefined,
      channels: visibleChannelsFor(socket, srv)
      });
    });
  socket.emit('my-servers', mine);
}

function generateServerId(name) {
  const base = String(name || 'servidor').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'servidor';
  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}

function activeInviteByCode(code) {
  const now = Date.now();
  for (const srv of dspeakServers) {
    const invite = (srv.invites || []).find(i => i.code === code && !i.revoked &&
      (!i.expiresAt || i.expiresAt > now) && (!i.maxUses || Number(i.uses || 0) < i.maxUses));
    if (invite) return { srv, invite };
    // Convite permanente legado continua válido.
    if (srv.inviteCode === code) return { srv, invite: null };
  }
  return null;
}

function publicInvite(invite) {
  return {
    code: invite.code,
    channelId: invite.channelId || null,
    createdBy: invite.createdBy,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt || 0,
    maxUses: invite.maxUses || 0,
    uses: invite.uses || 0,
    revoked: !!invite.revoked
  };
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

// ---------- Amigos ----------
// friends: cada lado guarda o outro (sempre simétrico). requests: pedidos
// pendentes, indexados por quem RECEBEU (pra mostrar "fulano quer ser seu amigo").
const FRIENDS_FILE = path.join(DATA_DIR, 'friends.json');
let friendsData = { friends: {}, requests: {} };
try {
  if (fs.existsSync(FRIENDS_FILE)) friendsData = { friends: {}, requests: {}, ...JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8')) };
} catch (e) { console.error('[DSpeak] Falha ao ler friends.json:', e.message); }

function saveFriends() {
  saveJsonDebounced(FRIENDS_FILE, () => friendsData);
}
registerFlushable(FRIENDS_FILE, () => friendsData);

function areFriends(a, b) {
  return (friendsData.friends[a] || []).includes(b);
}

function addFriendship(a, b) {
  friendsData.friends[a] = friendsData.friends[a] || [];
  friendsData.friends[b] = friendsData.friends[b] || [];
  if (!friendsData.friends[a].includes(b)) friendsData.friends[a].push(b);
  if (!friendsData.friends[b].includes(a)) friendsData.friends[b].push(a);
  friendsData.requests[a] = (friendsData.requests[a] || []).filter(k => k !== b);
  friendsData.requests[b] = (friendsData.requests[b] || []).filter(k => k !== a);
  saveFriends();
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

// Monta a lista de amigos de alguém já com presença (online/offline), status e
// status personalizado — pronta pra desenhar no modal de Amigos do cliente.
function friendsPayloadFor(key) {
  const list = (friendsData.friends[key] || []).map(fk => ({
    name: (accounts[fk] && accounts[fk].username) || fk,
    avatarUrl: (accounts[fk] && accounts[fk].avatarUrl) || null,
    online: findSocketsByUsername(fk).length > 0,
    status: userStatuses[fk] || 'online',
    customStatus: userCustomStatus[fk] || ''
  }));
  const requests = (friendsData.requests[key] || []).map(fk => (accounts[fk] && accounts[fk].username) || fk);
  return { friends: list, requests };
}

function pushFriendsTo(key) {
  findSocketsByUsername(key).forEach(s => s.emit('friends-data', friendsPayloadFor(key)));
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
  socket.emit('user-custom-statuses', userCustomStatus);
  if (socket.usernameKey) socket.emit('friends-data', friendsPayloadFor(socket.usernameKey));
}

const chatRateByUser = new Map();
const slowModeLastSend = new Map();

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

  // ---------- Reuniões instantâneas ----------
  // Criar não exige conta (dá pra criar direto da tela de login) — só um rate
  // limit por IP pra ninguém virar gerador infinito de salas.
  socket.on('create-meeting', (data, cb) => {
    if (typeof cb !== 'function') return;
    const ip = String(socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '').split(',')[0].trim();
    const result = tryCreateMeeting(ip, (data && data.name) || '');
    if (!result.ok) return cb({ error: result.error, message: result.message });
    cb({ ok: true, meetingId: result.meeting.id, expiresAt: result.meeting.expiresAt });
  });

  // Entrar numa reunião: se já tem sessão logada usa o nome da conta; senão vira
  // CONVIDADO — só o nome, sem conta, sem servidor, sem DM/amigos.
  socket.on('join-meeting', (data, cb) => {
    if (typeof cb !== 'function') return;
    const id = String((data && data.meetingId) || '').trim().toLowerCase();
    const m = meetings[id];
    if (!m || m.expiresAt <= Date.now()) return cb({ error: 'not-found' });

    const chId = meetingChannelId(id);
    if ((voiceUsers[chId] || []).length >= MEETING_MAX_PEOPLE) {
      return cb({ error: 'full', message: `Essa reunião está cheia (máximo ${MEETING_MAX_PEOPLE} pessoas).` });
    }

    let name = socket.username;
    if (!name) {
      name = String((data && data.name) || '').trim().slice(0, 30);
      if (name.length < 2) return cb({ error: 'no-name', message: 'Digite um nome pra entrar.' });
      // Nome repetido dentro da reunião ganha um sufixo — "Leo (2)".
      const inRoom = (voiceUsers[chId] || []).map(u => String(u.name || '').trim().toLowerCase());
      let finalName = name, n = 2;
      while (inRoom.includes(finalName.toLowerCase())) finalName = `${name} (${n++})`;
      name = finalName;
      socket.username = name;
      socket.usernameKey = 'guest:' + socket.id; // nunca colide com contas reais
      socket.isGuest = true;
      socket.role = 'guest';
    }
    socket.meetingId = id;
    cb({ ok: true, meetingId: id, channelId: chId, name, expiresAt: m.expiresAt, isGuest: !!socket.isGuest });
  });

  // Encerrar a reunião pra todo mundo (botão "Encerrar"). Reunião rápida entre
  // conhecidos: qualquer participante pode encerrar — sem burocracia de "dono".
  socket.on('end-meeting', () => {
    if (!socket.meetingId || !meetings[socket.meetingId]) return;
    console.log(`[Reunião] ${socket.meetingId} encerrada manualmente por ${socket.username || socket.id}.`);
    closeMeeting(socket.meetingId, 'ended');
  });

  // Status escolhido no seletor do rodapé — replica pra todo mundo na hora.
  socket.on('set-status', (data) => {
    if (socket.isGuest) return;
    if (!socket.usernameKey) return;
    const status = data && data.status;
    if (!VALID_STATUSES.includes(status)) return;
    userStatuses[socket.usernameKey] = status;
    broadcastStatuses();
  });

  // Status personalizado (texto livre curto). Texto vazio = limpar.
  socket.on('set-custom-status', (data) => {
    if (!socket.usernameKey || socket.isGuest) return;
    const text = String(data && data.text || '').trim().slice(0, 60);
    if (text) userCustomStatus[socket.usernameKey] = text;
    else delete userCustomStatus[socket.usernameKey];
    broadcastCustomStatuses();
  });

  socket.on('register-push-token', (data, cb) => {
    const done = typeof cb === 'function' ? cb : () => {};
    if (!socket.usernameKey || socket.isGuest) return done({ ok: false });
    const token = String(data && data.token || '').trim().slice(0, 4096);
    if (!token) return done({ ok: false, error: 'Token inválido.' });
    const list = Array.isArray(pushState.devices[socket.usernameKey])
      ? pushState.devices[socket.usernameKey] : [];
    const withoutSame = list.filter(d => d.token !== token);
    withoutSame.push({
      token, platform: String(data.platform || 'android').slice(0, 20),
      updatedAt: Date.now()
    });
    pushState.devices[socket.usernameKey] = withoutSame.slice(-5);
    savePushState();
    done({ ok: true, enabled: PUSH_ENABLED });
  });

  socket.on('revoke-push-token', (data, cb) => {
    const done = typeof cb === 'function' ? cb : () => {};
    if (!socket.usernameKey) return done({ ok: false });
    const token = String(data && data.token || '');
    pushState.devices[socket.usernameKey] =
      (pushState.devices[socket.usernameKey] || []).filter(d => d.token !== token);
    savePushState();
    done({ ok: true });
  });

  socket.on('get-notification-preferences', (cb) => {
    const done = typeof cb === 'function' ? cb : () => {};
    if (!socket.usernameKey) return done({ ok: false });
    done({
      ok: true,
      pushEnabled: PUSH_ENABLED,
      preferences: {
        dm: true, mention: true, friendship: true, invite: true, raisedHand: true,
        ...(pushState.preferences[socket.usernameKey] || {})
      }
    });
  });

  socket.on('set-notification-preferences', (data, cb) => {
    const done = typeof cb === 'function' ? cb : () => {};
    if (!socket.usernameKey || socket.isGuest) return done({ ok: false });
    const input = data && data.preferences && typeof data.preferences === 'object'
      ? data.preferences : {};
    pushState.preferences[socket.usernameKey] = Object.fromEntries(
      ['dm', 'mention', 'friendship', 'invite', 'raisedHand'].map(k => [k, input[k] !== false])
    );
    savePushState();
    done({ ok: true, pushEnabled: PUSH_ENABLED });
  });

  // ---------- Amigos ----------
  socket.on('get-friends', () => {
    if (!socket.usernameKey || socket.isGuest) return;
    socket.emit('friends-data', friendsPayloadFor(socket.usernameKey));
  });

  socket.on('friend-request', (data) => {
    if (!socket.usernameKey || socket.isGuest) return;
    const targetKey = keyOf(String(data && data.to || ''));
    if (!targetKey || targetKey === socket.usernameKey) return;
    if (!accounts[targetKey]) {
      socket.emit('action-denied', { message: 'Não existe ninguém com esse nome no DSpeak.' });
      return;
    }
    if (areFriends(socket.usernameKey, targetKey)) {
      socket.emit('action-denied', { message: 'Vocês já são amigos!' });
      return;
    }
    // Se a outra pessoa já tinha me pedido, vira amizade direto (match).
    if ((friendsData.requests[socket.usernameKey] || []).includes(targetKey)) {
      addFriendship(socket.usernameKey, targetKey);
      pushFriendsTo(socket.usernameKey);
      pushFriendsTo(targetKey);
      socket.emit('action-done', { message: `Vocês agora são amigos!` });
      return;
    }
    friendsData.requests[targetKey] = friendsData.requests[targetKey] || [];
    if (!friendsData.requests[targetKey].includes(socket.usernameKey)) {
      friendsData.requests[targetKey].push(socket.usernameKey);
      saveFriends();
    }
    socket.emit('action-done', { message: 'Pedido de amizade enviado!' });
    findSocketsByUsername(targetKey).forEach(s => {
      s.emit('friend-request-received', { from: socket.username });
      s.emit('friends-data', friendsPayloadFor(targetKey));
    });
    sendPushToUser(
      targetKey, 'friendship', 'Pedido de amizade',
      `${socket.username} quer ser seu amigo no DSpeak`,
      { url: 'https://dspeak.com.br/app', type: 'friendship' }
    );
  });

  socket.on('friend-respond', (data) => {
    if (!socket.usernameKey || socket.isGuest) return;
    const fromKey = keyOf(String(data && data.from || ''));
    if (!fromKey || !(friendsData.requests[socket.usernameKey] || []).includes(fromKey)) return;
    if (data && data.accept) {
      addFriendship(socket.usernameKey, fromKey);
      findSocketsByUsername(fromKey).forEach(s =>
        s.emit('action-done', { message: `${socket.username} aceitou seu pedido de amizade!` }));
      pushFriendsTo(fromKey);
    } else {
      friendsData.requests[socket.usernameKey] =
        (friendsData.requests[socket.usernameKey] || []).filter(k => k !== fromKey);
      saveFriends();
    }
    pushFriendsTo(socket.usernameKey);
  });

  socket.on('friend-remove', (data) => {
    if (!socket.usernameKey || socket.isGuest) return;
    const targetKey = keyOf(String(data && data.name || ''));
    if (!targetKey) return;
    friendsData.friends[socket.usernameKey] =
      (friendsData.friends[socket.usernameKey] || []).filter(k => k !== targetKey);
    friendsData.friends[targetKey] =
      (friendsData.friends[targetKey] || []).filter(k => k !== socket.usernameKey);
    saveFriends();
    pushFriendsTo(socket.usernameKey);
    pushFriendsTo(targetKey);
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
    if (!socket.username || socket.isGuest) return;
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
    // Canal de reunião instantânea: entra quem passou pelo join-meeting.
    if (isMeetingChannelId(roomId)) {
      if (socketInMeeting(socket, roomId)) socket.join(roomId);
      return;
    }
    // Só entra na "sala" do socket.io (por onde as mensagens ao vivo circulam)
    // quem é membro do servidor daquele canal — e pode VER o canal (só-mods fica de fora).
    const srv = serverOfChannel(roomId);
    if (!isMemberOfServer(srv, socket.username)) return;
    if (!canSeeChannel(socket, channels.find(c => c.id === roomId), srv)) return;
    socket.join(roomId);
  });

  // Avisa todo mundo quando alguém muta/desmuta ou ensurdece/desensurdece, pra
  // aparecer o iconezinho certo no avatar dessa pessoa pros outros também.
  socket.on('update-voice-status', (data) => {
    const muted = !!(data && data.muted) || !!socket.currentServerMuted;
    const deafened = !!(data && data.deafened);
    socket.currentMuted = muted;
    socket.currentDeafened = deafened;
    Object.keys(voiceUsers).forEach(channelId => {
      voiceUsers[channelId] = voiceUsers[channelId].map(u =>
        u.socketId === socket.id ? { ...u, muted, deafened, serverMuted: !!socket.currentServerMuted } : u
      );
    });
    io.emit('update-voice-users', voiceUsers);
  });

  socket.on('raise-hand', (data) => {
    const raisedHand = !!(data && data.raised);
    const wasRaised = !!socket.currentRaisedHand;
    socket.currentRaisedHand = raisedHand;
    Object.keys(voiceUsers).forEach(channelId => {
      voiceUsers[channelId] = voiceUsers[channelId].map(u =>
        u.socketId === socket.id ? { ...u, raisedHand } : u
      );
    });
    io.emit('update-voice-users', voiceUsers);
    if (raisedHand && !wasRaised) {
      const channelId = Object.keys(voiceUsers).find(id =>
        (voiceUsers[id] || []).some(u => u.socketId === socket.id));
      const srv = channelId && serverOfChannel(channelId);
      if (srv) {
        const staffKeys = new Set(srv.moderators || []);
        if (srv.ownerUsername) staffKeys.add(srv.ownerUsername);
        Object.keys(srv.memberRoleIds || {}).forEach(usernameKey => {
          if (permissionsForMember(srv, usernameKey).moderateMembers) staffKeys.add(usernameKey);
        });
        if (srv.id === 'dspeak') {
          Object.entries(roles).forEach(([usernameKey, role]) => {
            if (role === 'owner') staffKeys.add(usernameKey);
          });
        }
        staffKeys.delete(socket.usernameKey);
        staffKeys.forEach(targetKey => {
          sendPushToUser(
            targetKey, 'raisedHand', 'Mão levantada',
            `${socket.username} quer falar`,
            { url: 'https://dspeak.com.br/app', type: 'raised-hand', channelId }
          );
        });
      }
    }
  });

  socket.on('server-mute-user', (data) => {
    const target = io.sockets.sockets.get(data && data.targetSocketId);
    if (!target) return;
    const channelId = Object.keys(voiceUsers).find(id =>
      (voiceUsers[id] || []).some(u => u.socketId === target.id));
    const srv = channelId && serverOfChannel(channelId);
    if (!srv || (!isOwnerOfServer(socket, srv) && !hasServerPermission(socket, srv, 'serverMute'))) return;
    if (isOwnerOfServer(target, srv)) return;
    target.currentServerMuted = !!data.muted;
    if (target.currentServerMuted) target.currentMuted = true;
    voiceUsers[channelId] = voiceUsers[channelId].map(u =>
      u.socketId === target.id
        ? { ...u, muted: target.currentServerMuted || !!target.currentMuted, serverMuted: target.currentServerMuted }
        : u
    );
    target.emit('force-server-muted', { muted: target.currentServerMuted });
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
    const pollInput = data.poll && typeof data.poll === 'object' ? data.poll : null;
    if (!messageText.trim() && !data.attachment && !pollInput) return;

    // Antispam geral: no máximo 8 mensagens em 10 segundos por conta.
    const now = Date.now();
    const recent = (chatRateByUser.get(socket.usernameKey) || []).filter(t => now - t < 10000);
    if (recent.length >= 8) {
      socket.emit('action-denied', { message: 'Você está enviando rápido demais. Aguarde alguns segundos.' });
      return;
    }
    recent.push(now);
    chatRateByUser.set(socket.usernameKey, recent);

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

    // Chat de reunião instantânea: sem servidor e sem cargos — escreve quem
    // está na reunião, enquanto ela existir.
    if (isMeetingChannelId(data.room)) {
      if (!socketInMeeting(socket, data.room)) return;
    } else {
      // A mensagem só entra num canal que existe e de um servidor do qual essa
      // pessoa é membro — nada de escrever em sala alheia.
      const channel = channels.find(c => c.id === data.room);
      if (!channel) return;
      const srv = dspeakServers.find(s => s.id === channel.serverId);
      if (!isMemberOfServer(srv, socket.username)) return;
      const slowSeconds = Math.max(0, Number(channel.slowModeSeconds) || 0);
      if (slowSeconds && !isOwnerOfServer(socket, srv) &&
          !hasServerPermission(socket, srv, 'manageMessages')) {
        const slowKey = `${socket.usernameKey}:${channel.id}`;
        const last = slowModeLastSend.get(slowKey) || 0;
        const remaining = slowSeconds * 1000 - (now - last);
        if (remaining > 0) {
          socket.emit('action-denied', { message: `Modo lento: aguarde ${Math.ceil(remaining / 1000)}s.` });
          return;
        }
        slowModeLastSend.set(slowKey, now);
      }
      // Canal só-de-mods: membro comum nem deveria estar aqui. Canal somente-leitura
      // (tipo mural de avisos): todo mundo lê, mas só dono/moderador escreve.
      if (!canSeeChannel(socket, channel, srv)) return;
      if (channel.readOnly && !isOwnerOfServer(socket, srv) &&
          !hasServerPermission(socket, srv, 'manageMessages')) {
        socket.emit('action-denied', { message: 'Esse canal é somente leitura — só a staff do servidor pode postar aqui.' });
        return;
      }
    }

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
      replyToId: data.replyToId && findMessageById(data.room, data.replyToId) ? data.replyToId : null,
      reactions: {},
      timestamp: Date.now()
    };
    if (pollInput) {
      const question = String(pollInput.question || '').trim().slice(0, 180);
      const options = (Array.isArray(pollInput.options) ? pollInput.options : [])
        .map(v => String(v || '').trim().slice(0, 80)).filter(Boolean).slice(0, 8);
      if (!question || options.length < 2) return;
      entry.poll = { question, options: options.map((text, index) => ({ id: String(index + 1), text, votes: [] })) };
    }
    if (!messages[data.room]) messages[data.room] = [];
    messages[data.room].push(entry);
    pruneChannelMessages(data.room);
    saveMessages();
    io.to(data.room).emit('chat-message', entry);
    const mentionKeys = new Set();
    for (const match of messageText.matchAll(/@([\p{L}\p{N}_.-]{1,40})/gu)) {
      const mentionedKey = keyOf(match[1]);
      if (mentionedKey && mentionedKey !== socket.usernameKey && accounts[mentionedKey]) {
        mentionKeys.add(mentionedKey);
      }
    }
    mentionKeys.forEach(targetKey => {
      sendPushToUser(
        targetKey, 'mention', `${socket.username} mencionou você`,
        messageText.trim().slice(0, 180),
        { url: `https://dspeak.com.br/app?channel=${encodeURIComponent(data.room)}`, type: 'mention' }
      );
    });
  });

  socket.on('vote-poll', (data) => {
    if (!socket.username || !data) return;
    const entry = findMessageById(data.room, data.messageId);
    if (!entry || !entry.poll || !Array.isArray(entry.poll.options)) return;
    const chosen = entry.poll.options.find(o => o.id === String(data.optionId));
    if (!chosen) return;
    for (const option of entry.poll.options) {
      option.votes = (option.votes || []).filter(k => k !== socket.usernameKey);
    }
    chosen.votes.push(socket.usernameKey);
    saveMessages();
    io.to(data.room).emit('poll-updated', {
      room: data.room, messageId: entry.id, poll: entry.poll
    });
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
    const messageSrv = serverOfChannel(data.room);
    const isMod = socket.role === 'owner' || socket.role === 'moderator'
      || (messageSrv && (isOwnerOfServer(socket, messageSrv) ||
        hasServerPermission(socket, messageSrv, 'manageMessages')));
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

  // ---------- Fixar mensagens (só staff do servidor do canal) ----------
  socket.on('pin-message', (data) => {
    if (!socket.username || !data) return;
    const ch = channels.find(c => c.id === data.room);
    const srv = ch && dspeakServers.find(s => s.id === ch.serverId);
    const isGlobalMod = socket.role === 'owner' || socket.role === 'moderator';
    if (!srv || (!isOwnerOfServer(socket, srv) &&
        !hasServerPermission(socket, srv, 'manageMessages') && !isGlobalMod)) return;
    const entry = findMessageById(data.room, data.messageId);
    if (!entry) return;
    entry.pinned = !!data.pinned;
    saveMessages();
    io.to(data.room).emit('message-pinned', { room: data.room, messageId: entry.id, pinned: entry.pinned });
  });

  // ---------- Busca no histórico do canal ----------
  // Procura por texto ou autor nas mensagens guardadas (últimos 7 dias) e devolve
  // até 50 resultados, do mais recente pro mais antigo. Respeita as mesmas regras
  // de visibilidade do histórico normal.
  socket.on('search-messages', (data) => {
    if (!socket.username || !data) return;
    const room = String(data.room || '');
    const ch = channels.find(c => c.id === room);
    const srv = ch && dspeakServers.find(s => s.id === ch.serverId);
    if (!srv || !isMemberOfServer(srv, socket.username) || !canSeeChannel(socket, ch, srv)) return;
    const q = String(data.query || '').trim().toLowerCase();
    if (q.length < 2) { socket.emit('search-results', { room, query: data.query, results: [] }); return; }
    const results = (messages[room] || [])
      .filter(m => (m.message || '').toLowerCase().includes(q) || keyOf(m.user || '').includes(q))
      .slice(-50)
      .reverse();
    socket.emit('search-results', { room, query: data.query, results });
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
    // Chat da reunião: quem está nela pode puxar o histórico (curto) da própria sala.
    if (isMeetingChannelId(channelId)) {
      if (!socketInMeeting(socket, channelId)) return;
      socket.emit('channel-history', { room: channelId, messages: messages[channelId] || [] });
      return;
    }
    // Histórico só pra membro do servidor dono do canal — sem isso, qualquer
    // conta nova conseguiria puxar as conversas do 'geral' sem ter convite.
    const srv = serverOfChannel(channelId);
    if (!isMemberOfServer(srv, socket.username)) return;
    const chDef = channels.find(c => c.id === channelId);
    if (!canSeeChannel(socket, chDef, srv)) return;
    pruneChannelMessages(channelId);
    socket.emit('channel-history', { room: channelId, messages: messages[channelId] || [] });
  });

  // ---------- Mensagens privadas (DM) ----------
  socket.on('send-dm', (data) => {
    if (!socket.username || socket.isGuest) return;
    const toUsername = String(data && data.toUsername || '').trim();
    const message = String(data && data.message || '').trim().slice(0, 2000);
    if (!toUsername || (!message && !(data && data.attachment) && !(data && data.callInvite))) return;
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

    // Convite de call: vira um botão "Entrar na sala" na DM do destinatário.
    // Só aceita se o canal existir mesmo e o remetente for membro do servidor dele.
    if (data && data.callInvite && data.callInvite.channelId) {
      const ch = channels.find(c => c.id === data.callInvite.channelId);
      const chSrv = ch && dspeakServers.find(s => s.id === ch.serverId);
      if (ch && ch.type === 'voice' && chSrv && isMemberOfServer(chSrv, socket.username)) {
        entry.callInvite = { channelId: ch.id, channelName: ch.name, serverId: chSrv.id, serverName: chSrv.name };
      }
    }
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
    const isCallInvite = !!entry.callInvite;
    sendPushToUser(
      toUsername,
      isCallInvite ? 'invite' : 'dm',
      isCallInvite ? `${socket.username} convidou você para uma chamada` : `Mensagem de ${socket.username}`,
      isCallInvite ? `Entrar em ${entry.callInvite.channelName}` : (message || 'Enviou um anexo'),
      {
        url: 'https://dspeak.com.br/app',
        type: isCallInvite ? 'call-invite' : 'dm',
        from: socket.username
      }
    );
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
    for (const [, s] of io.sockets.sockets) {
      if (!s.username || !isMemberOfServer(srv, s.username)) continue;
      // Cada pessoa recebe SÓ os canais que pode ver (canais só-de-mods ficam de
      // fora pra membro comum) e sem o hash de senha (que antes vazava aqui).
      s.emit('channels-sync', { serverId, channels: visibleChannelsFor(s, srv) });
    }
  }

  // ---------- Criar / renomear / excluir canais (dono OU Moderador daquele servidor) ----------
  socket.on('create-channel', (data) => {
    const serverId = data && data.serverId;
    const srv = dspeakServers.find(s => s.id === serverId);
    if (!srv || (!isOwnerOfServer(socket, srv) && !hasServerPermission(socket, srv, 'manageChannels'))) return;
    const name = String(data && data.name || '').trim();
    const type = data && data.type;
    if (!name || (type !== 'text' && type !== 'voice')) return;

    // Prefixado com o serverId — garante que o id do canal é único mesmo entre
    // servidores diferentes (dois servidores podem ter um canal chamado "geral").
    const id = `${serverId}__${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}`;
    const channel = { id, name, type, serverId };
    // Permissões por canal: "só mods veem" (qualquer tipo) e "somente leitura —
    // só mods escrevem" (faz sentido só em canal de texto).
    channel.modsOnly = !!(data && data.modsOnly);
    if (type === 'text') {
      channel.readOnly = !!(data && data.readOnly);
      channel.slowModeSeconds = Math.max(0, Math.min(21600,
        Math.floor(Number(data && data.slowModeSeconds) || 0)));
    }
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
    if (!isOwnerOfServer(socket, srv) && !hasServerPermission(socket, srv, 'manageChannels')) return;

    const newName = String(data && data.newName || '').trim();
    if (newName && !ch.locked) ch.name = newName; // canais travados (ex: "geral") não podem ser renomeados

    // Permissões por canal (podem ser ligadas/desligadas depois de criado).
    if (data && Object.prototype.hasOwnProperty.call(data, 'modsOnly')) {
      ch.modsOnly = !!data.modsOnly;
    }
    if (ch.type === 'text' && data && Object.prototype.hasOwnProperty.call(data, 'readOnly')) {
      ch.readOnly = !!data.readOnly;
    }
    if (ch.type === 'text' && data && Object.prototype.hasOwnProperty.call(data, 'slowModeSeconds')) {
      ch.slowModeSeconds = Math.max(0, Math.min(21600, Math.floor(Number(data.slowModeSeconds) || 0)));
    }

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
    if (!isOwnerOfServer(socket, srv) && !hasServerPermission(socket, srv, 'manageChannels')) return;
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
    if (!socket.username || socket.isGuest) return;
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
      moderators: [],
      roleDefinitions: [],
      memberRoleIds: {}
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

  // ---------- Convites avançados: múltiplos, revogáveis, com validade/usos/canal ----------
  socket.on('create-server-invite', (data, cb) => {
    const done = typeof cb === 'function' ? cb : () => {};
    const srv = dspeakServers.find(s => s.id === (data && data.serverId));
    if (!srv || (!isOwnerOfServer(socket, srv) && !hasServerPermission(socket, srv, 'manageInvites'))) {
      return done({ ok: false, error: 'Você não pode criar convites.' });
    }
    const channelId = String(data && data.channelId || '');
    if (channelId) {
      const ch = channels.find(c => c.id === channelId && c.serverId === srv.id && c.type === 'voice');
      if (!ch) return done({ ok: false, error: 'Canal de voz inválido.' });
    }
    const durationMinutes = Math.max(0, Math.min(43200, Number(data && data.durationMinutes) || 0));
    const maxUses = Math.max(0, Math.min(10000, Math.floor(Number(data && data.maxUses) || 0)));
    const invite = {
      code: crypto.randomBytes(8).toString('hex'),
      channelId: channelId || null,
      createdBy: socket.usernameKey,
      createdAt: Date.now(),
      expiresAt: durationMinutes ? Date.now() + durationMinutes * 60000 : 0,
      maxUses, uses: 0, revoked: false
    };
    srv.invites = Array.isArray(srv.invites) ? srv.invites : [];
    srv.invites.push(invite);
    saveServers();
    done({ ok: true, invite: publicInvite(invite) });
  });

  socket.on('list-server-invites', (serverId, cb) => {
    const done = typeof cb === 'function' ? cb : () => {};
    const srv = dspeakServers.find(s => s.id === serverId);
    if (!srv || (!isOwnerOfServer(socket, srv) && !hasServerPermission(socket, srv, 'manageInvites'))) {
      return done({ ok: false, error: 'Você não pode ver os convites.' });
    }
    done({ ok: true, invites: (srv.invites || []).map(publicInvite) });
  });

  socket.on('revoke-server-invite', (data, cb) => {
    const done = typeof cb === 'function' ? cb : () => {};
    const srv = dspeakServers.find(s => s.id === (data && data.serverId));
    if (!srv || (!isOwnerOfServer(socket, srv) && !hasServerPermission(socket, srv, 'manageInvites'))) {
      return done({ ok: false, error: 'Você não pode revogar convites.' });
    }
    const invite = (srv.invites || []).find(i => i.code === data.code);
    if (!invite) return done({ ok: false, error: 'Convite não encontrado.' });
    invite.revoked = true;
    saveServers();
    done({ ok: true });
  });

  // ---------- Entrar num servidor existente via link/código de convite ----------
  socket.on('join-server-by-invite', (data) => {
    if (!socket.username || socket.isGuest) return;
    const inviteCode = String(data && data.inviteCode || '').trim();
    const password = data && data.password ? String(data.password) : '';
    const found = activeInviteByCode(inviteCode);
    const srv = found && found.srv;
    const invite = found && found.invite;
    if (!srv) { socket.emit('server-join-failed', { message: 'Link de convite inválido, expirado ou sem usos disponíveis.' }); return; }

    // Banido não volta nem com convite — só se a staff desbanir.
    if ((srv.banned || []).includes(socket.usernameKey)) {
      socket.emit('server-join-failed', { message: 'Você foi banido desse servidor e não pode entrar de novo.' });
      return;
    }

    if (isMemberOfServer(srv, socket.username)) {
      // Já é membro — só reenvia a lista e manda pra lá mesmo assim (cobre o caso de
      // clicar num link de convite de um servidor que a pessoa já está).
      sendMyServers(socket);
      socket.emit('server-joined', { serverId: srv.id, channelId: invite && invite.channelId });
      return;
    }

    if (srv.passwordHash && !verifyServerPassword(password, srv.passwordHash)) {
      socket.emit('server-join-failed', { message: 'Senha incorreta.' });
      return;
    }

    srv.members = srv.members || [];
    if (!srv.members.includes(socket.usernameKey)) srv.members.push(socket.usernameKey);
    if (invite) invite.uses = Number(invite.uses || 0) + 1;
    saveServers();

    sendMyServers(socket);
    // Avisa o cliente pra TROCAR pra esse servidor agora — sem isso, a pessoa
    // continuava vendo o servidor em que já estava (ex: o padrão), mesmo já sendo
    // membro do novo, porque 'my-servers' sozinho só atualiza a LISTA, não diz pra
    // navegar pra lugar nenhum.
    socket.emit('server-joined', { serverId: srv.id, channelId: invite && invite.channelId });
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
    ensureServerRoleModel(srv);
    const already = srv.moderators.includes(targetKey);
    if (data.makeModerator && !already) {
      srv.moderators.push(targetKey);
      const ids = Array.isArray(srv.memberRoleIds[targetKey]) ? srv.memberRoleIds[targetKey] : [];
      if (!ids.includes('legacy-moderator')) srv.memberRoleIds[targetKey] = [...ids, 'legacy-moderator'];
    }
    else if (!data.makeModerator && already) {
      srv.moderators = srv.moderators.filter(k => k !== targetKey);
      srv.memberRoleIds[targetKey] = (srv.memberRoleIds[targetKey] || []).filter(id => id !== 'legacy-moderator');
    }
    else return; // nada mudou

    saveServers();
    // Reenvia a lista de servidores pra todos os membros — o alvo ganha/perde os
    // botões na hora, e o resto vê a lista de mods atualizada.
    for (const [, s] of io.sockets.sockets) {
      if (s.username && isMemberOfServer(srv, s.username)) sendMyServers(s);
    }
  });

  // ---------- Cargos personalizados por servidor ----------
  socket.on('create-server-role', (data, cb) => {
    const done = typeof cb === 'function' ? cb : () => {};
    const srv = dspeakServers.find(s => s.id === (data && data.serverId));
    if (!srv || !isOwnerOfServer(socket, srv)) return done({ ok: false, error: 'Só o dono cria cargos.' });
    ensureServerRoleModel(srv);
    const name = String(data && data.name || '').trim().slice(0, 32);
    if (!name) return done({ ok: false, error: 'Informe o nome do cargo.' });
    if (srv.roleDefinitions.filter(r => !r.managed).length >= 30) {
      return done({ ok: false, error: 'Limite de 30 cargos personalizados.' });
    }
    const color = /^#[0-9a-f]{6}$/i.test(String(data.color || '')) ? String(data.color) : '#8fd3ff';
    const requested = data && data.permissions && typeof data.permissions === 'object' ? data.permissions : {};
    const permissions = Object.fromEntries(SERVER_PERMISSION_KEYS.map(k => [k, !!requested[k]]));
    const role = {
      id: `role-${crypto.randomBytes(6).toString('hex')}`,
      name, color, position: Number.isFinite(Number(data.position)) ? Number(data.position) : 10,
      permissions
    };
    srv.roleDefinitions.push(role);
    saveServers();
    for (const [, s] of io.sockets.sockets) if (s.username && isMemberOfServer(srv, s.username)) sendMyServers(s);
    done({ ok: true, role });
  });

  socket.on('delete-server-role', (data, cb) => {
    const done = typeof cb === 'function' ? cb : () => {};
    const srv = dspeakServers.find(s => s.id === (data && data.serverId));
    if (!srv || !isOwnerOfServer(socket, srv)) return done({ ok: false, error: 'Só o dono apaga cargos.' });
    ensureServerRoleModel(srv);
    const role = srv.roleDefinitions.find(r => r.id === data.roleId);
    if (!role || role.managed) return done({ ok: false, error: 'Esse cargo não pode ser apagado.' });
    srv.roleDefinitions = srv.roleDefinitions.filter(r => r.id !== role.id);
    for (const key of Object.keys(srv.memberRoleIds)) {
      srv.memberRoleIds[key] = (srv.memberRoleIds[key] || []).filter(id => id !== role.id);
    }
    saveServers();
    for (const [, s] of io.sockets.sockets) if (s.username && isMemberOfServer(srv, s.username)) sendMyServers(s);
    done({ ok: true });
  });

  socket.on('update-server-role', (data, cb) => {
    const done = typeof cb === 'function' ? cb : () => {};
    const srv = dspeakServers.find(s => s.id === (data && data.serverId));
    if (!srv || !isOwnerOfServer(socket, srv)) return done({ ok: false, error: 'Só o dono edita cargos.' });
    ensureServerRoleModel(srv);
    const role = srv.roleDefinitions.find(r => r.id === data.roleId);
    if (!role || role.managed) return done({ ok: false, error: 'Esse cargo não pode ser editado.' });
    const name = String(data.name || '').trim().slice(0, 32);
    if (!name) return done({ ok: false, error: 'Nome inválido.' });
    role.name = name;
    if (/^#[0-9a-f]{6}$/i.test(String(data.color || ''))) role.color = String(data.color);
    role.position = Number.isFinite(Number(data.position)) ? Number(data.position) : role.position;
    const requested = data.permissions && typeof data.permissions === 'object' ? data.permissions : {};
    role.permissions = Object.fromEntries(SERVER_PERMISSION_KEYS.map(k => [k, !!requested[k]]));
    saveServers();
    for (const [, s] of io.sockets.sockets) if (s.username && isMemberOfServer(srv, s.username)) sendMyServers(s);
    done({ ok: true, role });
  });

  socket.on('set-member-server-roles', (data, cb) => {
    const done = typeof cb === 'function' ? cb : () => {};
    const srv = dspeakServers.find(s => s.id === (data && data.serverId));
    if (!srv || !hasServerPermission(socket, srv, 'manageRoles')) {
      return done({ ok: false, error: 'Você não pode gerenciar cargos.' });
    }
    ensureServerRoleModel(srv);
    const targetKey = keyOf(data && data.targetUsername);
    if (!targetKey || !isMemberOfServer(srv, targetKey) || srv.ownerUsername === targetKey) {
      return done({ ok: false, error: 'Membro inválido.' });
    }
    const allowed = new Set(srv.roleDefinitions.filter(r => !r.managed).map(r => r.id));
    srv.memberRoleIds[targetKey] = [...new Set(Array.isArray(data.roleIds) ? data.roleIds : [])]
      .filter(id => allowed.has(id));
    // Preserva o cargo de moderador legado enquanto a lista antiga disser que é mod.
    if ((srv.moderators || []).includes(targetKey)) srv.memberRoleIds[targetKey].push('legacy-moderator');
    saveServers();
    for (const [, s] of io.sockets.sockets) if (s.username && isMemberOfServer(srv, s.username)) sendMyServers(s);
    done({ ok: true });
  });

  // ---------- Expulsar / banir alguém DO SERVIDOR (não só da sala de voz) ----------
  // Dono e Moderadores do servidor podem expulsar/banir membros; Moderador não
  // mexe em outro Moderador nem no dono — isso é papel do dono. Banido entra numa
  // lista persistida e não consegue voltar nem pelo link de convite.
  function canModerateTarget(socket, srv, targetKey) {
    if (!isOwnerOfServer(socket, srv) && !hasServerPermission(socket, srv, 'moderateMembers')) return false;
    if (targetKey === socket.usernameKey) return false;           // ninguém se expulsa
    if (srv.ownerUsername === targetKey) return false;            // dono é intocável
    const targetIsMod = (srv.moderators || []).includes(targetKey);
    if (targetIsMod && !isOwnerOfServer(socket, srv)) return false; // mod não mexe em mod
    // No servidor padrão (dono global), Owner global também é intocável por mods.
    const targetSockets = findSocketsByUsername(targetKey);
    if (targetSockets.some(s => s.role === 'owner') && !isOwnerOfServer(socket, srv)) return false;
    return true;
  }

  function removeUserFromServer(srv, targetKey, { ban }) {
    srv.members = (srv.members || []).filter(k => k !== targetKey);
    srv.moderators = (srv.moderators || []).filter(k => k !== targetKey);
    if (ban) {
      srv.banned = srv.banned || [];
      if (!srv.banned.includes(targetKey)) srv.banned.push(targetKey);
    }
    saveServers();

    // Se a pessoa estiver online: tira das salas de voz DESSE servidor, atualiza a
    // lista de servidores dela (o servidor some da barra) e avisa com um toast.
    findSocketsByUsername(targetKey).forEach(ts => {
      let kicked = false;
      Object.keys(voiceUsers).forEach(chId => {
        const chSrv = serverOfChannel(chId);
        if (chSrv && chSrv.id === srv.id && voiceUsers[chId].some(u => u.socketId === ts.id)) {
          voiceUsers[chId] = voiceUsers[chId].filter(u => u.socketId !== ts.id);
          kicked = true;
        }
      });
      if (kicked) {
        ts.emit('kicked-from-voice');
        io.emit('update-voice-users', voiceUsers);
      }
      sendMyServers(ts);
      ts.emit('removed-from-server', { serverName: srv.name, banned: !!ban });
    });
  }

  socket.on('kick-from-server', (data) => {
    if (!socket.username || !data) return;
    const srv = dspeakServers.find(s => s.id === data.serverId);
    if (!srv) return;
    const targetKey = keyOf(String(data.targetUsername || ''));
    if (!targetKey || !isMemberOfServer(srv, targetKey)) return;
    if (!canModerateTarget(socket, srv, targetKey)) return;
    removeUserFromServer(srv, targetKey, { ban: !!data.ban });
    socket.emit('action-done', {
      message: data.ban
        ? `${data.targetUsername} foi banido do servidor.`
        : `${data.targetUsername} foi expulso do servidor (pode voltar com um convite).`
    });
  });

  // Lista de banidos (só quem gerencia o servidor vê) + desbanir.
  socket.on('get-server-bans', (serverId) => {
    const srv = dspeakServers.find(s => s.id === serverId);
    if (!srv || (!isOwnerOfServer(socket, srv) && !hasServerPermission(socket, srv, 'moderateMembers'))) return;
    socket.emit('server-bans', { serverId, banned: srv.banned || [] });
  });

  socket.on('unban-from-server', (data) => {
    if (!data) return;
    const srv = dspeakServers.find(s => s.id === data.serverId);
    if (!srv || (!isOwnerOfServer(socket, srv) && !hasServerPermission(socket, srv, 'moderateMembers'))) return;
    const targetKey = keyOf(String(data.targetUsername || ''));
    if (!targetKey) return;
    srv.banned = (srv.banned || []).filter(k => k !== targetKey);
    saveServers();
    socket.emit('server-bans', { serverId: srv.id, banned: srv.banned });
    socket.emit('action-done', { message: `${data.targetUsername} foi desbanido — já pode entrar de novo com convite.` });
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
    if (!isGlobalMod && !isOwnerOfServer(socket, srvOfRoom) &&
        !hasServerPermission(socket, srvOfRoom, 'moderateMembers')) return;
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
      const targetSrv = serverOfChannel(targetChannelId);
      if (!isOwnerOfServer(socket, targetSrv) &&
          !hasServerPermission(socket, targetSrv, 'moderateMembers')) return;
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

    // Sala de voz de reunião instantânea: entra quem passou pelo join-meeting —
    // sem servidor, sem senha, sem cargo.
    if (isMeetingChannelId(channelId)) {
      if (!socketInMeeting(socket, channelId)) {
        socket.emit('meeting-closed', { meetingId: meetingIdOfChannel(channelId), reason: 'expired' });
        return;
      }
    } else {
      // Voz também é só pra membro do servidor daquele canal (e canal só-de-mods
      // não aceita membro comum nem por id direto).
      const srvOfCh = serverOfChannel(channelId);
      if (!isMemberOfServer(srvOfCh, socket.username || username)) return;
      if (!canSeeChannel(socket, channels.find(c => c.id === channelId), srvOfCh)) return;
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
      muted: !!socket.currentMuted || !!socket.currentServerMuted,
      deafened: !!socket.currentDeafened,
      serverMuted: !!socket.currentServerMuted,
      raisedHand: !!socket.currentRaisedHand,
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

    // Câmeras já ligadas na sala: quem entra agora abre os tiles na hora.
    const camerasOn = (voiceUsers[channelId] || [])
      .map(u => u.socketId)
      .filter(sid => sid !== socket.id && sfu.producersOf(sid, 'camera').length > 0);
    if (camerasOn.length) socket.emit('sync-active-cameras', camerasOn);

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
    // Fecha SÓ os producers da tela — a voz (mic via SFU) continua de pé.
    sfu.closeProducersBySource(socket.id, 'screen');
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

  // Busca por nome no YouTube (sem precisar de chave de API): lê o JSON embutido
  // na página de resultados e devolve os primeiros vídeos. Se o YouTube mudar o
  // formato, só a busca para — colar link direto continua funcionando.
  socket.on('music-search', async (data) => {
    if (!socket.username) return;
    const query = String(data && data.query || '').trim().slice(0, 100);
    if (query.length < 2) return;
    const now = Date.now();
    socket.musicSearchTimes = (socket.musicSearchTimes || []).filter(t => now - t < 10000);
    if (socket.musicSearchTimes.length >= 5) return;
    socket.musicSearchTimes.push(now);

    try {
      const res = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(query), {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8'
        },
        signal: AbortSignal.timeout(6000)
      });
      const html = await res.text();
      const m = html.match(/var ytInitialData\s*=\s*(\{[\s\S]+?\});\s*<\/script>/);
      const results = [];
      if (m) {
        const parsedData = JSON.parse(m[1]);
        const sections = parsedData && parsedData.contents
          && parsedData.contents.twoColumnSearchResultsRenderer
          && parsedData.contents.twoColumnSearchResultsRenderer.primaryContents
          && parsedData.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer
          && parsedData.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents || [];
        outer:
        for (const sec of sections) {
          const items = (sec.itemSectionRenderer && sec.itemSectionRenderer.contents) || [];
          for (const it of items) {
            const v = it.videoRenderer;
            if (!v || !v.videoId) continue;
            results.push({
              videoId: v.videoId,
              title: String((v.title && v.title.runs && v.title.runs[0] && v.title.runs[0].text) || '').slice(0, 200),
              author: String((v.ownerText && v.ownerText.runs && v.ownerText.runs[0] && v.ownerText.runs[0].text) || '').slice(0, 120),
              duration: (v.lengthText && v.lengthText.simpleText) || '',
              thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`
            });
            if (results.length >= 8) break outer;
          }
        }
      }
      socket.emit('music-search-results', { query, results });
    } catch (e) {
      socket.emit('music-search-results', { query, results: [] });
    }
  });

  // ---------- Playlists salvas (por usuário) ----------
  socket.on('get-playlists', () => {
    if (!socket.usernameKey) return;
    const mine = userPlaylists[socket.usernameKey] || [];
    socket.emit('playlists-data', mine.map(p => ({ name: p.name, count: p.items.length })));
  });

  // Salva a fila atual da sala como uma playlist com nome.
  socket.on('playlist-save', (data) => {
    if (!socket.usernameKey || socket.isGuest) return;
    const name = String(data && data.name || '').trim().slice(0, 40);
    if (!name) return;
    const channelId = currentMusicChannelOf(socket);
    const session = channelId && roomMusic[channelId];
    if (!session || !session.queue.length) {
      socket.emit('music-error', 'A fila está vazia — não tem o que salvar.');
      return;
    }
    userPlaylists[socket.usernameKey] = userPlaylists[socket.usernameKey] || [];
    const mine = userPlaylists[socket.usernameKey];
    const items = session.queue.map(it => ({
      type: it.type, sourceId: it.sourceId, title: it.title, author: it.author, thumbnail: it.thumbnail
    }));
    const existing = mine.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) existing.items = items; // mesmo nome = sobrescreve
    else {
      if (mine.length >= MAX_PLAYLISTS_PER_USER) {
        socket.emit('music-error', `Você já tem ${MAX_PLAYLISTS_PER_USER} playlists — apaga alguma antes.`);
        return;
      }
      mine.push({ name, items });
    }
    savePlaylists();
    socket.emit('playlists-data', mine.map(p => ({ name: p.name, count: p.items.length })));
    socket.emit('action-done', { message: `Playlist "${name}" salva com ${items.length} itens!` });
  });

  // Joga a playlist inteira na fila da sala atual.
  socket.on('playlist-load', (data) => {
    if (!socket.usernameKey) return;
    const name = String(data && data.name || '').trim();
    const pl = (userPlaylists[socket.usernameKey] || []).find(p => p.name.toLowerCase() === name.toLowerCase());
    if (!pl) return;
    const channelId = currentMusicChannelOf(socket);
    if (!channelId) {
      socket.emit('music-error', 'Entra numa sala de voz pra carregar a playlist.');
      return;
    }
    const session = ensureMusicSession(channelId);
    let added = 0;
    for (const it of pl.items) {
      if (session.queue.length >= MUSIC_MAX_QUEUE) break;
      session.queue.push({
        id: crypto.randomBytes(8).toString('hex'),
        type: it.type, sourceId: it.sourceId, title: it.title,
        author: it.author, thumbnail: it.thumbnail,
        addedBy: String(socket.username || 'Alguém').slice(0, 40)
      });
      added++;
    }
    if (added && !session.currentId) {
      session.currentId = session.queue[0].id;
      session.positionSec = 0;
      session.playing = true;
      session.updatedAt = Date.now();
    }
    emitMusicState(channelId);
    socket.emit('action-done', { message: `${added} música(s) da playlist "${pl.name}" entraram na fila.` });
  });

  socket.on('playlist-delete', (data) => {
    if (!socket.usernameKey) return;
    const name = String(data && data.name || '').trim();
    const mine = userPlaylists[socket.usernameKey] || [];
    userPlaylists[socket.usernameKey] = mine.filter(p => p.name.toLowerCase() !== name.toLowerCase());
    savePlaylists();
    socket.emit('playlists-data', userPlaylists[socket.usernameKey].map(p => ({ name: p.name, count: p.items.length })));
  });

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
    if (!isMine && !(srv && (isOwnerOfServer(socket, srv) ||
        hasServerPermission(socket, srv, 'manageMessages')))) return denyMusicControl(socket);
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
      const savedPush = await db.getKv('push');
      if (savedPush && typeof savedPush === 'object') pushState = savedPush;
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
    dspeakServers.forEach(ensureServerRoleModel);

    pruneAllMessages();
    pruneAllDms();

    // Migração única "estilo Discord": todo mundo que JÁ tinha conta antes dessa
    // mudança vira membro de verdade do DSPEAK SERVER (pra ninguém perder acesso).
    // Contas criadas DEPOIS não entram aqui — começam sem servidor nenhum e só
    // entram por convite ou criando o próprio.
    const defaultSrv = dspeakServers.find(s => s.id === 'dspeak');
    if (defaultSrv) {
      if (!defaultSrv.membersMigrated) {
        const existing = new Set(defaultSrv.members || []);
        Object.keys(accounts).forEach(k => existing.add(k));
        defaultSrv.members = Array.from(existing);
        defaultSrv.membersMigrated = true;
        console.log(`[DSpeak] Migração: ${defaultSrv.members.length} conta(s) existente(s) viraram membros do DSPEAK SERVER.`);
      }
      // O servidor padrão agora também precisa de convite pra receber gente nova.
      if (!defaultSrv.inviteCode) defaultSrv.inviteCode = crypto.randomBytes(6).toString('hex');
    }

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
    savePushState();
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
