// ---------- SFU (Selective Forwarding Unit) para transmissão de tela ----------
// O problema que isso resolve: no modelo antigo (mesh), quem transmite a tela
// CODIFICA UM VÍDEO SEPARADO PARA CADA ESPECTADOR — com 4 pessoas assistindo, o
// PC do streamer fazia 4 encodes de 1080p ao mesmo tempo (por isso a CPU
// explodia). Com o SFU, o streamer manda UM único vídeo pro servidor, e o
// SERVIDOR replica esse mesmo vídeo pra cada espectador. A CPU de quem
// transmite passa a ser a mesma com 1 ou com 20 espectadores.
//
// A VOZ continua no modelo mesh de sempre (áudio Opus é leve — não vale a
// complexidade). Só a TELA passa pelo SFU.
//
// Se o mediasoup não estiver instalado (ex: rodando local no Windows pra
// testar) ou falhar ao iniciar, o servidor avisa os clientes e todo mundo
// simplesmente volta pro modelo mesh antigo — nada quebra.

let mediasoup = null;
try {
  mediasoup = require('mediasoup');
} catch (e) {
  console.log('[SFU] mediasoup não instalado — transmissões seguem no modo mesh (cada espectador custa um encode pro streamer).');
}

const SFU_ENABLED = process.env.SFU_ENABLED !== '0';
// Portas UDP/TCP que o mediasoup usa pro tráfego de mídia — precisam estar
// abertas no firewall da VPS (ufw allow 40000:40099/udp e /tcp).
const RTC_MIN_PORT = Number(process.env.SFU_MIN_PORT || 40000);
const RTC_MAX_PORT = Number(process.env.SFU_MAX_PORT || 40099);

// IP público da VPS — o navegador dos clientes precisa saber PRA ONDE mandar a
// mídia (o servidor escuta em 0.0.0.0, mas anuncia esse IP). Vem do .env; se
// faltar, tenta descobrir sozinho perguntando a um serviço externo.
let announcedIp = process.env.SFU_ANNOUNCED_IP || '';

const MEDIA_CODECS = [
  // Áudio da tela/processo (música, jogo, filme) — estéreo de verdade.
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  // VP8 é o codec com suporte mais universal entre navegadores pra WebRTC.
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
  {
    kind: 'video', mimeType: 'video/H264', clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 }
  }
];

let worker = null;
let ready = false;

// Um router por sala de voz (criado quando a primeira transmissão da sala
// começa, fechado quando a sala esvazia). Cada router é isolado: streams de
// uma sala nunca vazam pra outra.
const routers = new Map(); // channelId -> Router

// Estado por socket conectado ao SFU.
// sfuState: { channelId, sendTransport, recvTransport, producers: Map<producerId, Producer>, consumers: Map<consumerId, Consumer> }
const socketState = new Map(); // socketId -> sfuState

async function detectPublicIp() {
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(4000) });
    const ip = (await res.text()).trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
  } catch (e) {}
  return '';
}

async function init() {
  if (!mediasoup || !SFU_ENABLED) return false;
  try {
    if (!announcedIp) {
      announcedIp = await detectPublicIp();
      if (!announcedIp) {
        console.error('[SFU] Sem SFU_ANNOUNCED_IP no .env e não consegui detectar o IP público — SFU desligado, seguindo no mesh.');
        return false;
      }
      console.log(`[SFU] IP público detectado automaticamente: ${announcedIp} (pra fixar, defina SFU_ANNOUNCED_IP no .env)`);
    }
    worker = await mediasoup.createWorker({ rtcMinPort: RTC_MIN_PORT, rtcMaxPort: RTC_MAX_PORT });
    worker.on('died', () => {
      // O worker é um processo separado — se ele morrer, melhor derrubar o Node
      // inteiro e deixar o PM2 subir tudo limpo de novo do que ficar num estado
      // meio-vivo em que toda transmissão nova falha silenciosamente.
      console.error('[SFU] Worker do mediasoup morreu — reiniciando o servidor pra recuperar.');
      setTimeout(() => process.exit(1), 1000);
    });
    ready = true;
    console.log(`[SFU] mediasoup pronto (portas ${RTC_MIN_PORT}-${RTC_MAX_PORT}, IP anunciado ${announcedIp}) — transmissões de tela agora custam UM encode só pro streamer.`);
    return true;
  } catch (e) {
    console.error('[SFU] Falha ao iniciar o mediasoup — seguindo no modo mesh:', e.message);
    return false;
  }
}

function isReady() { return ready; }

async function getRouter(channelId) {
  if (!ready) return null;
  let router = routers.get(channelId);
  if (!router || router.closed) {
    router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    routers.set(channelId, router);
  }
  return router;
}

function getState(socketId) {
  let st = socketState.get(socketId);
  if (!st) {
    st = { channelId: null, sendTransport: null, recvTransport: null, producers: new Map(), consumers: new Map() };
    socketState.set(socketId, st);
  }
  return st;
}

async function createTransport(router) {
  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    // Começa otimista: transmissão de tela quer banda desde o primeiro segundo.
    initialAvailableOutgoingBitrate: 8_000_000
  });
  return transport;
}

function transportParams(t) {
  return {
    id: t.id,
    iceParameters: t.iceParameters,
    iceCandidates: t.iceCandidates,
    dtlsParameters: t.dtlsParameters
  };
}

// Produtores ativos de um socket (o que ele está transmitindo pra sala).
// source: 'screen' (tela + áudio de sistema), 'mic' (voz) ou 'camera'.
// Producers antigos sem appData.source contam como 'screen' (compatibilidade).
function sourceOf(p) {
  return (p.appData && p.appData.source) || 'screen';
}

function producersOf(socketId, source) {
  const st = socketState.get(socketId);
  if (!st) return [];
  const all = Array.from(st.producers.values()).filter(p => !p.closed);
  return source ? all.filter(p => sourceOf(p) === source) : all;
}

// Fecha TUDO que o socket está produzindo (desconectou da voz), mantendo o que
// ele consome dos outros.
function closeProducers(socketId) {
  const st = socketState.get(socketId);
  if (!st) return;
  st.producers.forEach(p => { try { p.close(); } catch (e) {} });
  st.producers.clear();
  if (st.sendTransport) { try { st.sendTransport.close(); } catch (e) {} st.sendTransport = null; }
}

// Fecha só os producers de uma origem (ex: parou a TELA mas a VOZ continua).
// O sendTransport fica de pé enquanto sobrar qualquer producer.
function closeProducersBySource(socketId, source) {
  const st = socketState.get(socketId);
  if (!st) return;
  st.producers.forEach((p, id) => {
    if (sourceOf(p) === source) {
      try { p.close(); } catch (e) {}
      st.producers.delete(id);
    }
  });
  if (st.producers.size === 0 && st.sendTransport) {
    try { st.sendTransport.close(); } catch (e) {}
    st.sendTransport = null;
  }
}

// Fecha os consumers que esse socket tem DA transmissão de outro socket
// (clicou em "fechar" na live de alguém, ou o streamer parou). Com source,
// fecha só aquela origem (ex: parou de assistir a TELA mas segue ouvindo o mic).
function closeConsumersOfProducer(socketId, producerSocketId, source) {
  const st = socketState.get(socketId);
  if (!st) return;
  st.consumers.forEach((c, id) => {
    if (c.appData && c.appData.producerSocketId === producerSocketId
        && (!source || c.appData.source === source)) {
      try { c.close(); } catch (e) {}
      st.consumers.delete(id);
    }
  });
}

// Limpeza total de um socket (desconectou / saiu da sala).
function cleanupSocket(socketId) {
  const st = socketState.get(socketId);
  if (!st) return;
  st.producers.forEach(p => { try { p.close(); } catch (e) {} });
  st.consumers.forEach(c => { try { c.close(); } catch (e) {} });
  if (st.sendTransport) { try { st.sendTransport.close(); } catch (e) {} }
  if (st.recvTransport) { try { st.recvTransport.close(); } catch (e) {} }
  socketState.delete(socketId);
}

// Fecha o router de uma sala que esvaziou (libera memória e portas).
function closeRouterIfUnused(channelId) {
  const stillUsing = Array.from(socketState.values()).some(st => st.channelId === channelId);
  if (!stillUsing) {
    const router = routers.get(channelId);
    if (router) { try { router.close(); } catch (e) {} routers.delete(channelId); }
  }
}

// ---------- Registro dos eventos de sinalização no socket ----------
// Todos usam callback (ack) do socket.io: o cliente manda o pedido e recebe a
// resposta na mesma chamada, sem eventos soltos pra casar depois.
function attachSocketHandlers(io, socket, helpers) {
  const { currentChannelOf } = helpers;

  socket.on('sfu-caps', async (data, cb) => {
    if (typeof cb !== 'function') return;
    try {
      if (!ready) return cb({ error: 'sfu-off' });
      const channelId = currentChannelOf(socket);
      if (!channelId) return cb({ error: 'not-in-voice' });
      const router = await getRouter(channelId);
      const st = getState(socket.id);
      st.channelId = channelId;
      cb({ rtpCapabilities: router.rtpCapabilities });
    } catch (e) {
      console.error('[SFU] sfu-caps:', e.message);
      cb({ error: 'internal' });
    }
  });

  socket.on('sfu-create-transport', async (data, cb) => {
    if (typeof cb !== 'function') return;
    try {
      if (!ready) return cb({ error: 'sfu-off' });
      const channelId = currentChannelOf(socket);
      if (!channelId) return cb({ error: 'not-in-voice' });
      const router = await getRouter(channelId);
      const st = getState(socket.id);
      st.channelId = channelId;
      const transport = await createTransport(router);
      if (data && data.direction === 'send') {
        if (st.sendTransport) { try { st.sendTransport.close(); } catch (e) {} }
        st.sendTransport = transport;
      } else {
        if (st.recvTransport) { try { st.recvTransport.close(); } catch (e) {} }
        st.recvTransport = transport;
      }
      cb({ params: transportParams(transport) });
    } catch (e) {
      console.error('[SFU] sfu-create-transport:', e.message);
      cb({ error: 'internal' });
    }
  });

  socket.on('sfu-connect-transport', async (data, cb) => {
    if (typeof cb !== 'function') return;
    try {
      const st = socketState.get(socket.id);
      const transport = st && [st.sendTransport, st.recvTransport].find(t => t && t.id === data.transportId);
      if (!transport) return cb({ error: 'no-transport' });
      await transport.connect({ dtlsParameters: data.dtlsParameters });
      cb({ ok: true });
    } catch (e) {
      console.error('[SFU] sfu-connect-transport:', e.message);
      cb({ error: 'internal' });
    }
  });

  socket.on('sfu-produce', async (data, cb) => {
    if (typeof cb !== 'function') return;
    try {
      const st = socketState.get(socket.id);
      if (!st || !st.sendTransport || st.sendTransport.id !== data.transportId) return cb({ error: 'no-transport' });
      const producer = await st.sendTransport.produce({
        kind: data.kind,
        rtpParameters: data.rtpParameters,
        appData: { socketId: socket.id, ...(data.appData || {}) }
      });
      st.producers.set(producer.id, producer);
      producer.on('transportclose', () => st.producers.delete(producer.id));
      cb({ id: producer.id });
    } catch (e) {
      console.error('[SFU] sfu-produce:', e.message);
      cb({ error: 'internal' });
    }
  });

  // O streamer trocou a qualidade do vídeo no meio da live: fecha só o producer
  // antigo daquele tipo — o cliente produz um novo em seguida e avisa a sala.
  socket.on('sfu-close-producer', (data) => {
    const st = socketState.get(socket.id);
    if (!st || !data || !data.producerId) return;
    const p = st.producers.get(data.producerId);
    if (p) { try { p.close(); } catch (e) {} st.producers.delete(data.producerId); }
  });

  // Avisa a sala que tem producer novo (troca de qualidade da tela, mic
  // publicado ao entrar na sala, câmera ligada...) — cada um decide se consome.
  socket.on('sfu-new-producer', (data) => {
    const st = socketState.get(socket.id);
    if (!st || !st.channelId) return;
    socket.to(st.channelId).emit('sfu-producer-updated', {
      producerSocketId: socket.id,
      source: (data && data.source) || 'screen'
    });
  });

  socket.on('sfu-consume', async (data, cb) => {
    if (typeof cb !== 'function') return;
    try {
      if (!ready) return cb({ error: 'sfu-off' });
      const channelId = currentChannelOf(socket);
      if (!channelId) return cb({ error: 'not-in-voice' });
      const producerSocketId = String(data.producerSocketId || '');
      // source: 'screen' (padrão, compatível com clientes antigos), 'mic' ou 'camera'.
      const wantedSource = String(data.source || 'screen');
      const producers = producersOf(producerSocketId, wantedSource);
      // Streamer não publicou no SFU (cliente antigo, ou o SFU falhou pra ele):
      // o espectador cai no modo mesh antigo sozinho ao receber esse erro.
      if (!producers.length) return cb({ error: 'no-producers' });

      const router = await getRouter(channelId);
      const st = getState(socket.id);
      st.channelId = channelId;
      if (!st.recvTransport) return cb({ error: 'no-transport' });

      // Se já consumia essa origem (ex: re-consumo após troca de qualidade),
      // fecha os consumers antigos primeiro pra não duplicar áudio — só os da
      // MESMA origem (re-consumir a tela não pode derrubar o mic da pessoa).
      closeConsumersOfProducer(socket.id, producerSocketId, wantedSource);

      const results = [];
      for (const producer of producers) {
        if (!router.canConsume({ producerId: producer.id, rtpCapabilities: data.rtpCapabilities })) continue;
        const consumer = await st.recvTransport.consume({
          producerId: producer.id,
          rtpCapabilities: data.rtpCapabilities,
          // Nasce pausado: o cliente confirma que montou tudo e aí despausa —
          // evita perder os primeiros keyframes à toa.
          paused: true,
          appData: { producerSocketId, source: wantedSource }
        });
        st.consumers.set(consumer.id, consumer);
        consumer.on('transportclose', () => st.consumers.delete(consumer.id));
        consumer.on('producerclose', () => {
          st.consumers.delete(consumer.id);
          socket.emit('sfu-producer-closed', { producerSocketId, consumerId: consumer.id, source: wantedSource });
        });
        results.push({
          consumerId: consumer.id,
          producerId: producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters
        });
      }
      if (!results.length) return cb({ error: 'cannot-consume' });
      cb({ consumers: results });
    } catch (e) {
      console.error('[SFU] sfu-consume:', e.message);
      cb({ error: 'internal' });
    }
  });

  socket.on('sfu-resume-consumer', async (data, cb) => {
    try {
      const st = socketState.get(socket.id);
      const consumer = st && st.consumers.get(data.consumerId);
      if (consumer) await consumer.resume();
      if (typeof cb === 'function') cb({ ok: true });
    } catch (e) {
      if (typeof cb === 'function') cb({ error: 'internal' });
    }
  });

  // Espectador fechou a live de alguém do lado dele.
  socket.on('sfu-stop-consuming', (data) => {
    if (!data || !data.producerSocketId) return;
    closeConsumersOfProducer(socket.id, String(data.producerSocketId), data.source ? String(data.source) : null);
  });

  // Encerrou uma origem específica (tela/câmera) — sem source, fecha tudo.
  socket.on('sfu-close-producers', (data) => {
    if (data && data.source) closeProducersBySource(socket.id, String(data.source));
    else closeProducers(socket.id);
  });
}

module.exports = {
  init,
  isReady,
  attachSocketHandlers,
  closeProducers,
  closeProducersBySource,
  cleanupSocket,
  closeRouterIfUnused,
  producersOf
};
