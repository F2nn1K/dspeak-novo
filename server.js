const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

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
// Plano B opcional (metered.ca). Sem valor embutido no código: chave de API só
// entra por variável de ambiente — o repositório é público, qualquer segredo
// escrito aqui fica exposto pra todo mundo.
const METERED_API_KEY = process.env.METERED_API_KEY || '';

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

    // Plano B: metered.ca (só usado se a Cloudflare não estiver configurada, ou se
    // a chamada acima falhar por algum motivo). Sem chave configurada, devolve
    // vazio — o cliente já sabe seguir só com STUN.
    if (!METERED_API_KEY) { res.json([]); return; }
    const response = await fetch(`https://dspeak.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`);
    const iceServers = await response.json();
    res.json(iceServers);
  } catch (err) {
    console.error('[DSpeak] Não consegui buscar credenciais do TURN:', err);
    res.status(502).json([]); // o cliente já sabe seguir só com STUN se isso vier vazio
  }
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
if (!process.env.DATA_DIR) {
  console.log('[DSpeak] Nenhuma variável de ambiente DATA_DIR definida — salvando dados dentro da pasta do projeto (some a cada deploy no Render). Veja o comentário acima de "DATA_DIR" no código pra configurar um disco persistente.');
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
['channels.json', 'servers.json', 'roles.json', 'messages.json'].forEach(migrateOldDataFileIfNeeded);

// ---------- Gravação em disco assíncrona e agrupada (debounce) ----------
// Antes, CADA mensagem reescrevia o arquivo inteiro de forma síncrona
// (fs.writeFileSync), travando o servidor por um instante a cada gravação. Em
// horário de movimento, esses travamentos atrasavam os pings do Socket.IO e podiam
// derrubar clientes à toa (o servidor achava que a pessoa tinha caído). Agora as
// mudanças muito próximas umas das outras viram UMA escrita só, feita de forma
// assíncrona — o servidor nunca para de responder por causa de disco.
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
process.on('SIGTERM', () => { flushAllSavesSync(); process.exit(0); });
process.on('SIGINT', () => { flushAllSavesSync(); process.exit(0); });

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
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      // Nome aleatório no disco (evita colisão/sobrescrita), mas guardamos o nome
      // original pra mostrar/baixar com o nome de verdade depois.
      const randomName = crypto.randomBytes(16).toString('hex');
      const ext = path.extname(file.originalname);
      cb(null, randomName + ext);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_SIZE }
});

app.post('/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const isTooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(isTooBig ? 413 : 400).json({
        error: isTooBig ? 'Arquivo maior que 10MB.' : 'Não foi possível enviar o arquivo.'
      });
    }
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo recebido.' });

    res.json({
      url: `/uploads/${req.file.filename}`,
      filename: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype
    });
  });
});

const voiceUsers = {};
const activeRoomStreams = {};

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
  saveJsonDebounced(CHANNELS_FILE, () => channels);
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
  saveJsonDebounced(SERVERS_FILE, () => dspeakServers);
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
      inviteCode: isOwnerOfServer(socket, srv) ? srv.inviteCode : undefined, // só o dono vê/reusa o código
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
  saveJsonDebounced(ROLES_FILE, () => roles);
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
  saveJsonDebounced(MESSAGES_FILE, () => messages);
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
  saveJsonDebounced(DM_FILE, () => directMessages);
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

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);

  socket.on('register-user', (data) => {
    socket.username = data.username;
    socket.avatarUrl = data.avatarUrl;
    socket.usernameKey = keyOf(data.username);

    const role = resolveRole(data.username);
    socket.role = role;
    socket.emit('your-role', { role, username: data.username });

    // Só uma sessão ativa por vez pra cada pessoa (tipo WhatsApp Web) — se essa
    // pessoa já estava conectada em outro lugar (outra aba, outro dispositivo, o
    // app desktop E o site ao mesmo tempo), essa conexão ANTIGA é desconectada
    // agora, com um aviso — evita ficar "meio conectado" em dois lugares ao mesmo
    // tempo (duplicando na lista de voz, brigando por quem está "realmente" ali).
    findSocketsByUsername(data.username).forEach(otherSocket => {
      if (otherSocket.id !== socket.id) {
        otherSocket.emit('session-replaced');
        otherSocket.disconnect(true);
      }
    });

    // Manda pro cliente que acabou de entrar o retrato atual de quem já está
    // conectado nas salas de voz. Sem isso, ele só ficava sabendo quando alguém
    // MAIS entrava ou saía depois — por isso a lista ficava vazia até você mesmo
    // entrar numa sala (o que aí sim disparava uma atualização).
    socket.emit('update-voice-users', voiceUsers);

    // Manda só os servidores dos quais essa pessoa é membro, cada um já com seus
    // próprios canais — nunca a lista de canais de TODOS os servidores de todo mundo.
    sendMyServers(socket);
  });

  // Atualiza apelido/avatar em tempo real pra todo mundo, sem precisar de F5.
  // Sem isso, só o rodapé de quem mudou o perfil atualizava (feito localmente);
  // a lista de voz e os cards do palco ficavam com os dados antigos até reconectar.
  socket.on('change-profile', (data) => {
    const { newName, avatarUrl } = data;
    socket.username = newName;
    socket.avatarUrl = avatarUrl;

    Object.keys(voiceUsers).forEach(channelId => {
      voiceUsers[channelId] = voiceUsers[channelId].map(u =>
        u.socketId === socket.id ? { ...u, name: newName, avatarUrl } : u
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
      room: data.room,
      message: messageText,
      attachment: data.attachment,
      user: socket.username,
      avatarUrl: socket.avatarUrl,
      time: typeof data.time === 'string' ? data.time.slice(0, 20) : undefined,
      date: typeof data.date === 'string' ? data.date.slice(0, 20) : undefined,
      role: socket.role,
      timestamp: Date.now()
    };
    if (!messages[data.room]) messages[data.room] = [];
    messages[data.room].push(entry);
    pruneChannelMessages(data.room);
    saveMessages();
    io.to(data.room).emit('chat-message', entry);
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

  // ---------- Criar / renomear / excluir canais (só o dono DAQUELE servidor pode) ----------
  socket.on('create-channel', (data) => {
    const serverId = data && data.serverId;
    const srv = dspeakServers.find(s => s.id === serverId);
    if (!srv || !isOwnerOfServer(socket, srv)) return;
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
    if (!isOwnerOfServer(socket, srv)) return;

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
    if (!isOwnerOfServer(socket, srv)) return;
    if (channels.filter(c => c.serverId === ch.serverId).length <= 1) return;

    channels = channels.filter(c => c.id !== channelId);
    delete messages[channelId];
    saveChannels();
    saveMessages();
    broadcastChannelsSync(ch.serverId);
  });

  // ---------- Criar um servidor novo (só o Owner GLOBAL pode; o criador vira Owner
  // DELE também, mas quem pode criar continua restrito, pra não virar bagunça de
  // servidor toda hora) ----------
  socket.on('create-server', (data) => {
    if (!socket.username) return;
    if (socket.role !== 'owner') {
      socket.emit('server-create-failed', { message: 'Só o Owner pode criar servidores novos.' });
      return;
    }
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
      members: [socket.usernameKey]
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

  // Owner/Moderador "puxam" alguém pra sala de voz em que estão agora.
  socket.on('pull-user-to-room', (data) => {
    if (socket.role !== 'owner' && socket.role !== 'moderator') return;
    const targetSocketId = data && data.targetSocketId;
    const channelId = data && data.channelId;
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket) return;
    // Moderador não pode puxar um Owner — só o próprio Owner mexe em outro Owner.
    if (targetSocket.role === 'owner' && socket.role !== 'owner') return;
    targetSocket.emit('force-join-voice', { channelId });
  });

  // Item 4: expulsa alguém da sala de voz em que está agora (não é um banimento do
  // servidor inteiro — só sai da sala de voz, pode entrar de novo se quiser).
  socket.on('kick-user-from-voice', (data) => {
    if (socket.role !== 'owner' && socket.role !== 'moderator') return;
    const targetSocketId = data && data.targetSocketId;
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (!targetSocket) return;
    // Moderador não pode expulsar um Owner — só o próprio Owner mexe em outro Owner.
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
  });

  socket.on('leave-voice-room', (data) => {
    const channelId = data.channelId || socket.currentVoiceChannel;
    if (channelId && voiceUsers[channelId]) {
      voiceUsers[channelId] = voiceUsers[channelId].filter(u => u.socketId !== socket.id);
      socket.leave(channelId);
      io.emit('update-voice-users', voiceUsers);
    }
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

  socket.on('disconnect', () => {
    Object.keys(activeRoomStreams).forEach(channelId => {
      activeRoomStreams[channelId] = activeRoomStreams[channelId].filter(id => id !== socket.id);
      socket.to(channelId).emit('user-stopped-streaming', socket.id);
    });

    Object.keys(voiceUsers).forEach(channelId => {
      voiceUsers[channelId] = voiceUsers[channelId].filter(u => u.socketId !== socket.id);
    });
    io.emit('update-voice-users', voiceUsers);
  });
});

// Porta vem da hospedagem (Render/Railway/etc. definem PORT sozinhos); 3000 é só
// o padrão pra rodar local. Com a porta fixa em 3000, o deploy simplesmente não
// funcionava em serviços que exigem escutar na porta que ELES escolhem.
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor DSpeak rodando na porta ${PORT}`));
