"""Carregamento e validação da configuração reproduzível."""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from pathlib import Path
from typing import Any


class ConfigError(ValueError):
    pass


def load_config(path: str | Path) -> dict[str, Any]:
    config_path = Path(path)
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ConfigError(f"{config_path}: JSON inválido: {error}") from error
    validate_config(config)
    return config


def validate_config(config: Any) -> None:
    if not isinstance(config, dict):
        raise ConfigError("a configuração deve ser um objeto JSON")
    for section in ("audio", "model", "data", "loss", "training"):
        if not isinstance(config.get(section), dict):
            raise ConfigError(f"seção '{section}' é obrigatória")

    audio = config["audio"]
    if audio.get("sample_rate") != 16_000:
        raise ConfigError("audio.sample_rate deve ser 16000")
    if audio.get("channels") != 1:
        raise ConfigError("audio.channels deve ser 1")
    if audio.get("enrollment_seconds") != 4.0:
        raise ConfigError("audio.enrollment_seconds deve ser 4.0")
    frame_samples = audio.get("frame_samples")
    if frame_samples != 160:
        raise ConfigError("audio.frame_samples deve ser 160 (10 ms)")

    enrollment = config["model"].get("enrollment")
    extractor = config["model"].get("extractor")
    if not isinstance(enrollment, dict) or not isinstance(extractor, dict):
        raise ConfigError("model.enrollment e model.extractor são obrigatórios")
    embedding_dim = enrollment.get("embedding_dim")
    if embedding_dim != 128 or extractor.get("embedding_dim") != embedding_dim:
        raise ConfigError("embedding_dim deve ser 128 e igual nos dois modelos")
    if extractor.get("frame_samples") != frame_samples:
        raise ConfigError("model.extractor.frame_samples deve coincidir com audio")
    codec_stride = extractor.get("codec_stride")
    if (
        not isinstance(codec_stride, int)
        or codec_stride < 1
        or frame_samples % codec_stride
    ):
        raise ConfigError("codec_stride deve ser divisor inteiro de frame_samples")
    if extractor.get("num_layers", 0) < 1:
        raise ConfigError("model.extractor.num_layers deve ser >= 1")

    data = config["data"]
    if not data.get("train_manifest"):
        raise ConfigError("data.train_manifest é obrigatório")
    if data.get("segment_seconds_min", 0) <= 0:
        raise ConfigError("data.segment_seconds_min deve ser positivo")
    if data.get("segment_seconds_max", 0) < data["segment_seconds_min"]:
        raise ConfigError("intervalo de duração em data é inválido")
    for probability in (
        "noise_probability",
        "reverb_probability",
        "enrollment_reverb_probability",
    ):
        value = data.get(probability)
        if not isinstance(value, (int, float)) or not 0 <= value <= 1:
            raise ConfigError(f"data.{probability} deve estar entre 0 e 1")
    if data.get("reverb_max_delay_ms", 0) <= 0:
        raise ConfigError("data.reverb_max_delay_ms deve ser positivo")

    loss = config["loss"]
    if loss.get("speaker_weight", -1) < 0:
        raise ConfigError("loss.speaker_weight deve ser não negativo")
    margin = loss.get("speaker_negative_margin")
    if not isinstance(margin, (int, float)) or not -1 <= margin <= 1:
        raise ConfigError("loss.speaker_negative_margin deve estar entre -1 e 1")

    training = config["training"]
    for positive_integer in (
        "epochs",
        "batch_size",
        "samples_per_epoch",
        "validation_samples",
        "log_every_steps",
    ):
        if (
            not isinstance(training.get(positive_integer), int)
            or training[positive_integer] < 1
        ):
            raise ConfigError(f"training.{positive_integer} deve ser inteiro positivo")
    if not isinstance(training.get("num_workers"), int) or training["num_workers"] < 0:
        raise ConfigError("training.num_workers deve ser inteiro não negativo")
    if training.get("learning_rate", 0) <= 0:
        raise ConfigError("training.learning_rate deve ser positivo")
    if training.get("min_learning_rate", -1) < 0:
        raise ConfigError("training.min_learning_rate deve ser não negativo")
    if training.get("gradient_clip_norm", 0) <= 0:
        raise ConfigError("training.gradient_clip_norm deve ser positivo")


def clone_config(config: dict[str, Any]) -> dict[str, Any]:
    return deepcopy(config)


def config_digest(config: dict[str, Any]) -> str:
    canonical = json.dumps(config, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def save_config(config: dict[str, Any], path: str | Path) -> None:
    validate_config(config)
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(config, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(output_path)
