"""Execução streaming e utilitários de reprodutibilidade."""

from __future__ import annotations

import random

import numpy as np
import torch
from torch import Tensor
from torch.nn import functional as F

from .models import CausalExtractor


def seed_everything(seed: int, deterministic: bool = False) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    if deterministic:
        torch.use_deterministic_algorithms(True)


def resolve_device(requested: str) -> torch.device:
    if requested == "auto":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    device = torch.device(requested)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA foi solicitada, mas não está disponível")
    return device


def extract_streaming(
    extractor: CausalExtractor,
    audio: Tensor,
    embedding: Tensor,
    *,
    state: Tensor | None = None,
) -> tuple[Tensor, Tensor]:
    """Processa frames de 160 amostras preservando o estado da GRU."""
    if audio.ndim != 2:
        raise ValueError("audio deve ter shape [batch, samples]")
    if state is None:
        state = extractor.initial_state(
            audio.shape[0], device=audio.device, dtype=audio.dtype
        )
    outputs: list[Tensor] = []
    frame_samples = extractor.frame_samples
    for start in range(0, audio.shape[1], frame_samples):
        frame = audio[:, start : start + frame_samples]
        valid_samples = frame.shape[1]
        if valid_samples < frame_samples:
            frame = F.pad(frame, (0, frame_samples - valid_samples))
        frame_output, state = extractor(frame, embedding, state)
        outputs.append(frame_output[:, :valid_samples])
    if not outputs:
        return audio.new_empty(audio.shape), state
    return torch.cat(outputs, dim=1), state
