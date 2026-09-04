# Matriz de validação VoiceLock

O modelo só pode ser promovido quando `release-report.json` passar por
`scripts/promote-voicelock-model.js`.

## Automatizado

Abra:

```text
https://SEU_HOST/audio/voicelock/diagnostics.html
```

O diagnóstico mede inicialização, enrollment, média/p50/p95 por frame, RTF,
backend e carregamento do pós-filtro Hush. Ele usa senoides sintéticas e nunca
acessa o microfone.

Android WebView pode ser iniciado localmente com:

```powershell
flutter run -d ID_DO_APARELHO `
  --dart-define=DSPEAK_APP_URL=http://127.0.0.1:3004/audio/voicelock/diagnostics.html
```

Em debug, faça `adb reverse tcp:3004 tcp:3004`.

## Gates obrigatórios

- p95 de inferência menor ou igual a 5 ms;
- RTF médio menor ou igual a 0,25;
- latência adicional p95 menor ou igual a 60 ms;
- SI-SDRi maior ou igual a 10 dB;
- STOI da voz-alvo maior ou igual a 0,90;
- nenhuma troca indevida do locutor;
- pós-filtro Hush inicializado;
- Windows AMD, Intel e NVIDIA;
- Chrome, Edge e Firefox;
- Android físico de entrada e intermediário.

Emulador não aprova os dois Androids físicos: ele serve apenas para validar
WebView, assets e comportamento de fallback.
