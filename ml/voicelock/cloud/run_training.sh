#!/usr/bin/env bash
set -euo pipefail

CONFIG="${VOICELOCK_CONFIG:-configs/default.json}"
CHECKPOINT_DIR="${VOICELOCK_CHECKPOINT_DIR:-artifacts/checkpoints/default}"
EXPORT_DIR="${VOICELOCK_EXPORT_DIR:-artifacts/export}"
EVAL_FILE="${VOICELOCK_EVAL_FILE:-artifacts/evaluation.json}"

python - <<'PY'
import torch
if not torch.cuda.is_available():
    raise SystemExit("GPU CUDA não encontrada; o treino de nuvem foi interrompido.")
print("GPU:", torch.cuda.get_device_name(0))
PY

if [[ "${VOICELOCK_PREPARE_LIBRISPEECH:-0}" == "1" ]]; then
  python scripts/prepare_librispeech.py
fi

python scripts/validate_manifest.py manifests/train.jsonl --verify-hashes
python scripts/validate_manifest.py manifests/validation.jsonl --verify-hashes

python train.py --config "$CONFIG" --device cuda
python evaluate.py \
  --checkpoint "$CHECKPOINT_DIR/best.pt" \
  --manifest manifests/test.jsonl \
  --split test \
  --examples "${VOICELOCK_EVAL_EXAMPLES:-500}" \
  --device cuda \
  --output-json "$EVAL_FILE"

python export_onnx.py \
  --checkpoint "$CHECKPOINT_DIR/best.pt" \
  --output-dir "$EXPORT_DIR" \
  --runtime-frame-samples 320

python - "$EVAL_FILE" <<'PY'
import json
import sys
from pathlib import Path
report = json.loads(Path(sys.argv[1]).read_text())
if report["si_sdr_improvement_db"] < 10:
    raise SystemExit(
        f"Qualidade reprovada: SI-SDRi={report['si_sdr_improvement_db']:.2f} dB"
    )
if report.get("target_stoi") is None or report["target_stoi"] < 0.90:
    raise SystemExit(f"Qualidade reprovada: STOI={report.get('target_stoi')}")
print("Treino/export concluídos. A promoção ainda depende da matriz de aparelhos.")
PY
