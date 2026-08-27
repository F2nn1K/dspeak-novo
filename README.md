# DSpeak

Chat de texto e voz em tempo real, estilo Discord: canais de texto, salas de voz
(WebRTC), transmissão de tela, mensagens privadas, múltiplos servidores com
convite/senha e cargos (Owner / Moderador / Membro).

## Rodando localmente

```bash
npm install
npm start
```

Abra `http://localhost:3000`.

## Variáveis de ambiente

| Variável | Obrigatória | Para quê |
|---|---|---|
| `PORT` | não (padrão 3000) | Porta do servidor. Hospedagens como o Render definem sozinhas. |
| `OWNER_CLAIM_CODE` | recomendada | Código secreto para virar Owner digitando `!owner CODIGO` no chat. **Sem ela, o comando fica desativado.** |
| `CLOUDFLARE_TURN_KEY_ID` | recomendada | Key ID da TURN Key (painel Cloudflare → Realtime → TURN Server). Necessária para voz funcionar entre redes restritivas. |
| `CLOUDFLARE_TURN_API_TOKEN` | recomendada | API Token gerado junto com a TURN Key. As duas precisam existir juntas. |
| `METERED_API_KEY` | não | Plano B de TURN via metered.ca (500 MB/mês no plano grátis). |
| `DATA_DIR` | não | Pasta para dados persistentes (mensagens, cargos, servidores). No Render, aponte para um Persistent Disk; sem isso os dados se perdem a cada deploy. |

## Deploy no Render (plano Free)

1. Crie um **Web Service** apontando para este repositório (branch `main`).
2. Build command: `npm install` — Start command: `npm start`.
3. Configure as variáveis de ambiente da tabela acima.
4. O plano Free hiberna após ~15 min sem tráfego (derruba todo mundo).
   Mitigação: crie um monitor gratuito no [UptimeRobot](https://uptimerobot.com)
   pingando a URL do serviço a cada 5 minutos.
5. O plano Free não tem disco persistente: mensagens/cargos se perdem a cada
   deploy. O servidor grava tudo ao desligar (SIGTERM), mas o disco é recriado
   no deploy seguinte — para persistência de verdade é preciso plano pago com
   Persistent Disk (e a variável `DATA_DIR`).

## Segurança

- Mensagens de chat/DM são escapadas no cliente antes de entrar no DOM (anti-XSS).
- Uploads de tipos executáveis pelo navegador (HTML/SVG/JS) são servidos como download forçado.
- O servidor valida remetente, sala e tamanho de cada mensagem; identidade vem do socket, não do payload.
- Nenhum segredo fica no código — tudo por variável de ambiente.
