# Treino fora da máquina do usuário

O treino final deve rodar em uma GPU de nuvem com pelo menos 24 GB de VRAM e
armazenamento persistente suficiente para o LibriSpeech extraído.

## Piloto gratuito no Google Colab

Crie um notebook vazio, selecione uma GPU T4 e execute:

```python
!git clone --branch voicelock-own-multiplatform \
  https://github.com/F2nn1K/dspeak-novo.git
%cd dspeak-novo/ml/voicelock
!python cloud/colab_train.py
```

O script monta o Google Drive, baixa apenas as 100 horas do piloto, treina,
avalia 300 misturas e exporta ONNX em `Meu Drive/DSpeak-VoiceLock`. Se o Colab
desconectar, execute as células novamente: `last.pt` é encontrado e retomado.
Nenhum áudio pessoal é usado.

## Fluxo genérico (RunPod, Lambda, AWS, GCP ou equivalente)

1. Crie uma máquina Linux com GPU NVIDIA e Docker/NVIDIA Container Toolkit.
2. Clone o repositório.
3. Entre em `dspeak-novo/ml/voicelock`.
4. Execute:

```bash
docker build -t dspeak-voicelock .
mkdir -p data manifests artifacts
docker run --rm --gpus all \
  -e VOICELOCK_PREPARE_LIBRISPEECH=1 \
  -v "$PWD/data:/workspace/voicelock/data" \
  -v "$PWD/manifests:/workspace/voicelock/manifests" \
  -v "$PWD/artifacts:/workspace/voicelock/artifacts" \
  dspeak-voicelock
```

O primeiro ciclo baixa e verifica 460 horas de fala limpa. Para retomar sem
baixar novamente, use `VOICELOCK_PREPARE_LIBRISPEECH=0` e preserve os volumes.

## Segurança

- Nunca envie `key.txt`, WAVs pessoais ou credenciais para a imagem.
- Dados e checkpoints ficam em volumes, não nas camadas Docker.
- Não marque `manifest.json` como `productionReady`; somente o script de
  promoção faz isso depois da matriz técnica, auditiva e jurídica.
- Desligue e remova o disco da GPU de nuvem quando o treino terminar.
