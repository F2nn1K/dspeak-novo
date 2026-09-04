"""Fábricas únicas para manter treino, avaliação e exportação compatíveis."""

from __future__ import annotations

from typing import Any

from .losses import VoiceLockLoss
from .models import CausalExtractor, EnrollmentEncoder


def build_models(
    config: dict[str, Any],
) -> tuple[EnrollmentEncoder, CausalExtractor]:
    audio = config["audio"]
    enrollment_options = dict(config["model"]["enrollment"])
    enrollment_options["sample_rate"] = audio["sample_rate"]
    enrollment_options["enrollment_seconds"] = audio["enrollment_seconds"]
    enrollment = EnrollmentEncoder(**enrollment_options)
    extractor = CausalExtractor(**config["model"]["extractor"])
    return enrollment, extractor


def build_loss(config: dict[str, Any]) -> VoiceLockLoss:
    options = dict(config["loss"])
    spectral = options.pop("spectral")
    options.pop("speaker_weight", None)
    options.pop("speaker_negative_margin", None)
    return VoiceLockLoss(
        **options,
        fft_sizes=spectral["fft_sizes"],
        hop_sizes=spectral["hop_sizes"],
        window_sizes=spectral["window_sizes"],
    )
