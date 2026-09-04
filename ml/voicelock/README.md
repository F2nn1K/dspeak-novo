# DSpeak VoiceLock causal

Pipeline autocontido de **Target Speaker Extraction (TSE)** para Python 3.11 e
PyTorch. Ele treina pesos próprios a partir de áudio com licença documentada;
não baixa checkpoints, não contém datasets e não inclui gravações pessoais.

## Contrato

- áudio mono, `16.000 Hz`;
- enrollment de `4 s` (`64.000` amostras) para embedding L2-normalizado `128D`;
- treino com segmentos de comprimento variável;
- inferência causal em frames de `160` amostras (`10 ms`);
- estado explícito da GRU: `[num_layers, 1, hidden_size]`;
- `encoder.onnx`: `enrollment -> embedding`;
- `extractor.onnx`: `audio, embedding, state -> audio_out, state_out`.

O extrator usa Conv1d com blocos não sobrepostos, FiLM condicionado pela voz,
GRU unidirecional e ConvTranspose1d. Como `kernel_size == stride`, não há
contexto convolucional escondido entre frames; o único contexto persistente é o
`state` retornado pelo modelo. O sistema é causal no limite operacional de
10 ms, sem amostras de frames futuros.

## Instalação

Execute os comandos a partir de `ml/voicelock`.

```powershell
py -3.11 -m venv .venv
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\python -m pip install -e ".[export]"
```

Para CUDA, instale primeiro a distribuição do PyTorch compatível com o driver e
depois use o último comando. Não há dependência de `torchaudio`.

## Dados e licenças

Organize fala por locutor; o primeiro diretório abaixo da raiz vira
`speaker_id`:

```text
data/train/
  speaker_001/
    utterance_01.wav
  speaker_002/
    utterance_01.wav
```

Cada split usado para misturas precisa de ao menos dois locutores. Construa um
manifest fornecendo todos os campos de proveniência e licença:

```powershell
.venv\Scripts\python scripts/build_manifest.py `
  --root data/train `
  --output manifests/train.jsonl `
  --kind speech `
  --split train `
  --dataset-name "Meu corpus autorizado" `
  --source-url "https://origem.example/dataset" `
  --license-id "SPDX-ou-identificador-interno" `
  --license-name "Nome completo da licença" `
  --license-url "https://origem.example/licenca" `
  --license-attribution "Titular e atribuição exigida"
```

Faça o mesmo para validação com `--split validation`. Para ruído, use
`--kind noise`; o builder atribui `speaker_id="__noise__"`. Os argumentos de
dataset e licença são obrigatórios e são gravados em **cada linha**. O builder
também registra SHA-256, sample rate, canais e duração.

Para iniciar o treino na nuvem com o baseline LibriSpeech limpo de 460 horas
(CC BY 4.0):

```bash
python scripts/prepare_librispeech.py
```

O script verifica os hashes publicados, recusa entradas inseguras no arquivo
compactado e cria `manifests/train.jsonl`, `validation.jsonl` e `test.jsonl`.
Ruídos e reflexões sintéticas são gerados durante o treino; nenhum dataset sem
licença declarada é baixado automaticamente.

Valide arquivos e hashes:

```powershell
.venv\Scripts\python scripts/validate_manifest.py manifests/train.jsonl `
  --verify-hashes
```

Ter um URL ou nome de licença no manifest não garante, por si só, autorização
para uso. Confirme direitos de treinamento, redistribuição dos pesos e uso
comercial para cada fonte.

## Treino do zero

Edite `configs/default.json` para apontar aos manifests. A mistura é gerada
on-the-fly com um locutor-alvo, outro `speaker_id` como interferente, SIR
aleatório, ruído opcional com SNR aleatório e reflexões causais sintéticas.
As reflexões são geradas matematicamente, portanto não exigem um corpus de RIR
de licença separada.

```powershell
.venv\Scripts\python train.py --config configs/default.json --device auto
```

São otimizadas conjuntamente as perdas `-SI-SDR + L1 + multi-resolution STFT`
e uma perda contrastiva de identidade: aproxima referência/voz-alvo e afasta
locutores diferentes presentes no mesmo batch.
O diretório configurado recebe:

- `config.resolved.json`;
- `metrics.jsonl`;
- `last.pt`;
- `best.pt`.

Para retomar exatamente a mesma configuração:

```powershell
.venv\Scripts\python train.py --config configs/default.json `
  --resume artifacts/checkpoints/default/last.pt
```

Carregue somente checkpoints produzidos por este projeto: checkpoints PyTorch
não confiáveis podem executar código durante a desserialização.

## Avaliação streaming

```powershell
.venv\Scripts\python evaluate.py `
  --checkpoint artifacts/checkpoints/default/best.pt `
  --manifest manifests/validation.jsonl `
  --split validation `
  --examples 100 `
  --output-json artifacts/evaluation.json
```

O relatório contém SI-SDR da mistura/saída, melhoria, STOI da voz-alvo, L1 e
RTF do extrator e do caminho completo.

## Exportação ONNX

```powershell
.venv\Scripts\python export_onnx.py `
  --checkpoint artifacts/checkpoints/default/best.pt `
  --output-dir exports
```

A exportação usa batch `1`, enrollment fixo em `64.000` amostras e, por padrão,
agrupa dois frames de treino em um bloco ONNX de `320` amostras (20 ms) para
reduzir overhead no Android. Use `--runtime-frame-samples 160` para diagnosticar
o modo estrito de 10 ms. Ela valida os grafos e compara numericamente PyTorch
com ONNX Runtime.
`exports/metadata.json` registra shapes, hashes e erro máximo de paridade.

Na primeira chamada, forneça estado zerado. Reutilize `state_out` como `state`
no frame seguinte. Um novo enrollment ou uma nova sessão exige zerar o estado.

## Smoke tests sem downloads

```powershell
.venv\Scripts\python -m unittest discover -s tests -v
```

Os testes criam áudio sintético somente em diretório temporário. Nenhum teste
acessa rede, baixa modelo ou usa dado pessoal.

## GPU cloud com Docker

Construa com esta pasta como contexto:

```bash
docker build -t dspeak-voicelock .
docker run --rm --gpus all \
  -e VOICELOCK_PREPARE_LIBRISPEECH=1 \
  -v "$PWD/data:/workspace/voicelock/data" \
  -v "$PWD/manifests:/workspace/voicelock/manifests" \
  -v "$PWD/artifacts:/workspace/voicelock/artifacts" \
  dspeak-voicelock
```

Se o container for baixar o LibriSpeech, monte `data` e `manifests` com escrita.
Em execuções posteriores, mantenha-os somente leitura. O comando
`cloud/run_training.sh` exige CUDA, valida manifests/hashes, treina, avalia 500
misturas não vistas, exporta ONNX e bloqueia resultados abaixo de 10 dB SI-SDRi.

O container não incorpora dados, manifests, checkpoints ou ONNX por causa do
`.dockerignore`. Verifique se a imagem CUDA escolhida é compatível com o driver
da máquina cloud.

## Limites antes de produção

Este repositório fornece arquitetura e pipeline, não qualidade pré-treinada.
Faça treinamento, teste auditivo, avaliação por locutor não visto, medição no
hardware final e revisão jurídica dos dados/pesos antes de integrar ao WebRTC.
