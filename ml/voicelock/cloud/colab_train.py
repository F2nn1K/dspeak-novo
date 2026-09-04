#!/usr/bin/env python3
"""Orquestra o piloto gratuito no Google Colab com checkpoint no Drive."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run(*command: str) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=ROOT, check=True)


def main() -> None:
    try:
        from google.colab import drive
    except ImportError as error:
        raise SystemExit("Este script deve ser executado dentro do Google Colab.") from error

    drive.mount("/content/drive")
    run(
        sys.executable,
        "-m",
        "pip",
        "install",
        "-e",
        ".[export,evaluation]",
    )

    # Piloto gratuito: 100 h. O treino final pode acrescentar train-clean-360
    # depois que a arquitetura provar qualidade suficiente.
    run(
        sys.executable,
        "scripts/prepare_librispeech.py",
        "--splits",
        "train-clean-100",
        "dev-clean",
        "test-clean",
    )

    drive_root = Path("/content/drive/MyDrive/DSpeak-VoiceLock")
    checkpoint_dir = drive_root / "checkpoints" / "pilot-100h"
    export_dir = drive_root / "exports" / "pilot-100h"
    evaluation_file = drive_root / "evaluation-pilot-100h.json"
    checkpoint_dir.mkdir(parents=True, exist_ok=True)

    config = json.loads((ROOT / "configs/default.json").read_text(encoding="utf-8"))
    config["training"].update(
        {
            "epochs": int(os.environ.get("VOICELOCK_COLAB_EPOCHS", "30")),
            "batch_size": int(os.environ.get("VOICELOCK_COLAB_BATCH", "12")),
            "samples_per_epoch": int(
                os.environ.get("VOICELOCK_COLAB_SAMPLES_PER_EPOCH", "5000")
            ),
            "validation_samples": 256,
            "num_workers": 2,
            "output_dir": str(checkpoint_dir),
        }
    )
    pilot_config = Path("/content/voicelock-pilot-100h.json")
    pilot_config.write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    train_command = [
        sys.executable,
        "train.py",
        "--config",
        str(pilot_config),
        "--device",
        "cuda",
    ]
    last = checkpoint_dir / "last.pt"
    if last.exists():
        train_command.extend(["--resume", str(last)])
        print(f"Retomando checkpoint: {last}")
    run(*train_command)

    best = checkpoint_dir / "best.pt"
    run(
        sys.executable,
        "evaluate.py",
        "--checkpoint",
        str(best),
        "--manifest",
        "manifests/test.jsonl",
        "--split",
        "test",
        "--examples",
        "300",
        "--device",
        "cuda",
        "--output-json",
        str(evaluation_file),
    )
    run(
        sys.executable,
        "export_onnx.py",
        "--checkpoint",
        str(best),
        "--output-dir",
        str(export_dir),
        "--runtime-frame-samples",
        "320",
    )

    report = json.loads(evaluation_file.read_text(encoding="utf-8"))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"Checkpoints: {checkpoint_dir}")
    print(f"ONNX: {export_dir}")
    if report["si_sdr_improvement_db"] < 10 or (report.get("target_stoi") or 0) < 0.9:
        print("Piloto ainda não atingiu o gate. Não promover para produção.")
    else:
        print("Qualidade automática passou; ainda falta matriz auditiva/hardware.")


if __name__ == "__main__":
    main()
