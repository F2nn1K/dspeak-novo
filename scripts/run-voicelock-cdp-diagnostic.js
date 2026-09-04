#!/usr/bin/env node
// Executa a página de diagnóstico dentro de um WebView/Chrome exposto via CDP.
const port = Number(process.argv[2] || 9222);
const backend = process.argv[3] || 'auto';
const navigateUrl = process.argv[4] || null;

async function main() {
  const pages = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
  const page = pages.find((item) => /VoiceLock/.test(item.title)) || pages[0];
  if (!page) throw new Error('página CDP não encontrada');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    }
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const commandId = ++id;
    pending.set(commandId, { resolve, reject });
    socket.send(JSON.stringify({ id: commandId, method, params }));
  });

  await command('Runtime.enable');
  if (navigateUrl) {
    await command('Page.navigate', { url: navigateUrl });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await command('Runtime.evaluate', {
    expression: `document.querySelector('#backend').value=${JSON.stringify(backend)};
      document.querySelector('#run').click()`
  });
  const deadline = Date.now() + 120000;
  let text = '';
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const result = await command('Runtime.evaluate', {
      expression: `JSON.stringify({
        running: document.querySelector('#run').disabled,
        verdict: document.querySelector('#verdict').textContent,
        output: document.querySelector('#output').textContent
      })`,
      returnByValue: true
    });
    text = result.result.value;
    const state = JSON.parse(text);
    if (!state.running) {
      socket.close();
      console.log(text);
      if (!/APROVADO/.test(state.verdict)) process.exitCode = 1;
      return;
    }
  }
  socket.close();
  throw new Error('diagnóstico excedeu 120 segundos');
}

main().catch((error) => {
  console.error('[VoiceLock CDP]', error.message);
  process.exitCode = 1;
});
