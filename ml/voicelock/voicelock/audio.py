"""I/O e utilitários de áudio estritos para mono/16 kHz."""

from __future__ import annotations

import hashlib
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import torch
from torch import Tensor


@dataclass(frozen=True)
class AudioMetadata:
    sample_rate: int
    channels: int
    num_samples: int

    @property
    def duration_seconds(self) -> float:
        return self.num_samples / self.sample_rate


def _optional_soundfile() -> Any | None:
    try:
        import soundfile  # type: ignore
    except ImportError:
        return None
    return soundfile


def probe_audio(path: str | Path) -> AudioMetadata:
    """Lê somente o cabeçalho; WAV funciona sem dependências opcionais."""
    audio_path = Path(path)
    soundfile = _optional_soundfile()
    if soundfile is not None:
        info = soundfile.info(str(audio_path))
        return AudioMetadata(
            sample_rate=int(info.samplerate),
            channels=int(info.channels),
            num_samples=int(info.frames),
        )

    if audio_path.suffix.lower() != ".wav":
        raise RuntimeError(
            f"{audio_path}: instale soundfile para formatos diferentes de WAV"
        )
    with wave.open(str(audio_path), "rb") as wav_file:
        return AudioMetadata(
            sample_rate=wav_file.getframerate(),
            channels=wav_file.getnchannels(),
            num_samples=wav_file.getnframes(),
        )


def _decode_pcm(raw: bytes, sample_width: int) -> np.ndarray:
    if sample_width == 1:
        return (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    if sample_width == 2:
        return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if sample_width == 3:
        packed = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        values = packed[:, 0] | (packed[:, 1] << 8) | (packed[:, 2] << 16)
        values = np.where(values & 0x800000, values - 0x1000000, values)
        return values.astype(np.float32) / 8388608.0
    if sample_width == 4:
        return np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    raise ValueError(f"largura PCM não suportada: {sample_width} bytes")


def load_audio(path: str | Path, sample_rate: int = 16_000) -> Tensor:
    """Carrega áudio mono, rejeitando canais ou sample rate incompatíveis."""
    audio_path = Path(path)
    soundfile = _optional_soundfile()
    if soundfile is not None:
        samples, actual_rate = soundfile.read(
            str(audio_path), dtype="float32", always_2d=True
        )
        if samples.shape[1] != 1:
            raise ValueError(
                f"{audio_path}: esperado mono, encontrados {samples.shape[1]} canais"
            )
        waveform = torch.from_numpy(np.ascontiguousarray(samples[:, 0]))
    else:
        if audio_path.suffix.lower() != ".wav":
            raise RuntimeError(
                f"{audio_path}: instale soundfile para formatos diferentes de WAV"
            )
        with wave.open(str(audio_path), "rb") as wav_file:
            channels = wav_file.getnchannels()
            actual_rate = wav_file.getframerate()
            if channels != 1:
                raise ValueError(
                    f"{audio_path}: esperado mono, encontrados {channels} canais"
                )
            waveform = torch.from_numpy(
                _decode_pcm(
                    wav_file.readframes(wav_file.getnframes()),
                    wav_file.getsampwidth(),
                ).copy()
            )

    if int(actual_rate) != sample_rate:
        raise ValueError(
            f"{audio_path}: esperado {sample_rate} Hz, encontrado {actual_rate} Hz"
        )
    if waveform.numel() == 0:
        raise ValueError(f"{audio_path}: arquivo de áudio vazio")
    if not torch.isfinite(waveform).all():
        raise ValueError(f"{audio_path}: áudio contém NaN ou infinito")
    return waveform.to(dtype=torch.float32).clamp_(-1.0, 1.0)


def write_wav(path: str | Path, waveform: Tensor, sample_rate: int = 16_000) -> None:
    """Grava PCM16 mono sem depender de torchaudio."""
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    samples = waveform.detach().cpu().float().flatten().clamp(-1.0, 1.0)
    pcm = (samples.numpy() * 32767.0).round().astype("<i2")
    with wave.open(str(output_path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm.tobytes())


def crop_or_repeat(
    waveform: Tensor,
    num_samples: int,
    generator: torch.Generator,
    *,
    random_crop: bool = True,
) -> Tensor:
    """Obtém exatamente ``num_samples``, repetindo clipes curtos."""
    if num_samples <= 0:
        raise ValueError("num_samples deve ser positivo")
    waveform = waveform.flatten()
    if waveform.numel() == 0:
        raise ValueError("não é possível recortar áudio vazio")
    if waveform.numel() < num_samples:
        repeats = (num_samples + waveform.numel() - 1) // waveform.numel()
        waveform = waveform.repeat(repeats)
    max_start = waveform.numel() - num_samples
    if random_crop and max_start > 0:
        start = int(torch.randint(max_start + 1, (1,), generator=generator).item())
    else:
        start = 0
    return waveform[start : start + num_samples].clone()


def rms(waveform: Tensor, eps: float = 1e-8) -> Tensor:
    return waveform.square().mean().clamp_min(eps).sqrt()


def sha256_file(path: str | Path, block_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while block := handle.read(block_size):
            digest.update(block)
    return digest.hexdigest()
