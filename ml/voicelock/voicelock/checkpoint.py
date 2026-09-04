"""Formato de checkpoint próprio, versionado e sem dependência externa."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import torch

from .config import config_digest, validate_config
from .factory import build_models
from .models import CausalExtractor, EnrollmentEncoder

CHECKPOINT_FORMAT_VERSION = 1


def save_checkpoint(payload: dict[str, Any], path: str | Path) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    torch.save(payload, temporary)
    temporary.replace(output_path)


def make_checkpoint(
    *,
    config: dict[str, Any],
    enrollment: EnrollmentEncoder,
    extractor: CausalExtractor,
    epoch: int,
    global_step: int,
    best_validation_loss: float,
    optimizer: torch.optim.Optimizer | None = None,
    scheduler: Any | None = None,
    scaler: Any | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "format_version": CHECKPOINT_FORMAT_VERSION,
        "config": config,
        "config_sha256": config_digest(config),
        "epoch": int(epoch),
        "global_step": int(global_step),
        "best_validation_loss": float(best_validation_loss),
        "enrollment_state_dict": enrollment.state_dict(),
        "extractor_state_dict": extractor.state_dict(),
    }
    if optimizer is not None:
        payload["optimizer_state_dict"] = optimizer.state_dict()
    if scheduler is not None:
        payload["scheduler_state_dict"] = scheduler.state_dict()
    if scaler is not None:
        payload["scaler_state_dict"] = scaler.state_dict()
    return payload


def load_checkpoint(
    path: str | Path,
    *,
    map_location: torch.device | str = "cpu",
) -> dict[str, Any]:
    # Checkpoints pickle podem executar código. Carregue somente artefatos próprios.
    payload = torch.load(path, map_location=map_location, weights_only=False)
    if not isinstance(payload, dict):
        raise ValueError("checkpoint inválido: raiz não é um dicionário")
    if payload.get("format_version") != CHECKPOINT_FORMAT_VERSION:
        raise ValueError(
            "checkpoint incompatível: format_version="
            f"{payload.get('format_version')!r}"
        )
    for key in ("config", "enrollment_state_dict", "extractor_state_dict"):
        if key not in payload:
            raise ValueError(f"checkpoint inválido: campo ausente {key}")
    validate_config(payload["config"])
    if payload.get("config_sha256") != config_digest(payload["config"]):
        raise ValueError("checkpoint inválido: hash da configuração divergente")
    return payload


def load_models(
    path: str | Path,
    *,
    device: torch.device | str = "cpu",
) -> tuple[EnrollmentEncoder, CausalExtractor, dict[str, Any]]:
    payload = load_checkpoint(path, map_location=device)
    enrollment, extractor = build_models(payload["config"])
    enrollment.load_state_dict(payload["enrollment_state_dict"], strict=True)
    extractor.load_state_dict(payload["extractor_state_dict"], strict=True)
    enrollment.to(device)
    extractor.to(device)
    return enrollment, extractor, payload
