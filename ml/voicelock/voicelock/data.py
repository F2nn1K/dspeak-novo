"""Dataset de misturas sintéticas on-the-fly agrupado por locutor."""

from __future__ import annotations

import math
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from typing import Any

import torch
from torch import Tensor
from torch.utils.data import Dataset

from .audio import crop_or_repeat, load_audio, rms
from .manifest import ManifestError, load_manifest


@lru_cache(maxsize=64)
def _cached_audio(path: str, sample_rate: int) -> Tensor:
    return load_audio(Path(path), sample_rate=sample_rate)


def _uniform(
    generator: torch.Generator,
    lower: float,
    upper: float,
) -> float:
    if lower == upper:
        return lower
    return lower + (upper - lower) * float(torch.rand((), generator=generator).item())


def _synthetic_room(
    signal: Tensor,
    generator: torch.Generator,
    sample_rate: int,
    max_delay_ms: float,
) -> Tensor:
    """Reverberação causal leve com reflexões geradas, sem dataset externo."""
    result = signal.clone()
    tap_count = int(torch.randint(3, 8, (1,), generator=generator).item())
    max_delay = max(2, int(sample_rate * max_delay_ms / 1000.0))
    total_gain = 1.0
    for tap in range(tap_count):
        delay = int(torch.randint(1, max_delay, (1,), generator=generator).item())
        decay = 0.38 * math.exp(-2.2 * (tap + 1) / tap_count)
        gain = decay * _uniform(generator, 0.45, 1.0)
        if float(torch.rand((), generator=generator)) < 0.25:
            gain *= -1
        result[delay:] += signal[:-delay] * gain
        total_gain += abs(gain)
    return result / math.sqrt(total_gain)


class TargetSpeakerMixDataset(Dataset[dict[str, Any]]):
    """Cria alvo + outro locutor + ruído sem materializar misturas em disco."""

    def __init__(
        self,
        speech_manifest: str | Path,
        *,
        noise_manifest: str | Path | None = None,
        split: str | None = None,
        sample_rate: int = 16_000,
        enrollment_seconds: float = 4.0,
        frame_samples: int = 160,
        segment_seconds_min: float = 1.0,
        segment_seconds_max: float = 3.0,
        samples_per_epoch: int = 10_000,
        sir_db: tuple[float, float] = (-5.0, 5.0),
        noise_snr_db: tuple[float, float] = (10.0, 30.0),
        noise_probability: float = 0.8,
        reverb_probability: float = 0.7,
        enrollment_reverb_probability: float = 0.25,
        reverb_max_delay_ms: float = 120.0,
        seed: int = 1337,
    ) -> None:
        super().__init__()
        if sample_rate != 16_000:
            raise ValueError("VoiceLock suporta somente sample_rate=16000")
        if samples_per_epoch < 1:
            raise ValueError("samples_per_epoch deve ser positivo")
        if not 0.0 <= noise_probability <= 1.0:
            raise ValueError("noise_probability deve estar entre 0 e 1")
        if not 0.0 <= reverb_probability <= 1.0:
            raise ValueError("reverb_probability deve estar entre 0 e 1")
        if not 0.0 <= enrollment_reverb_probability <= 1.0:
            raise ValueError("enrollment_reverb_probability deve estar entre 0 e 1")
        if segment_seconds_min <= 0 or segment_seconds_max < segment_seconds_min:
            raise ValueError("intervalo de duração do segmento inválido")
        self.sample_rate = sample_rate
        self.enrollment_samples = int(round(enrollment_seconds * sample_rate))
        self.frame_samples = frame_samples
        self.samples_per_epoch = samples_per_epoch
        self.sir_db = sir_db
        self.noise_snr_db = noise_snr_db
        self.noise_probability = noise_probability
        self.reverb_probability = reverb_probability
        self.enrollment_reverb_probability = enrollment_reverb_probability
        self.reverb_max_delay_ms = reverb_max_delay_ms
        self.seed = seed
        self.epoch = 0

        minimum = int(math.ceil(segment_seconds_min * sample_rate / frame_samples))
        maximum = int(math.floor(segment_seconds_max * sample_rate / frame_samples))
        if maximum < minimum:
            maximum = minimum
        self.minimum_frames = minimum
        self.maximum_frames = maximum

        speech_records = load_manifest(speech_manifest, expected_kind="speech")
        if split is not None:
            speech_records = [
                record for record in speech_records if record["split"] == split
            ]
        self.by_speaker: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for record in speech_records:
            self.by_speaker[record["speaker_id"]].append(record)
        self.speakers = sorted(self.by_speaker)
        if len(self.speakers) < 2:
            raise ManifestError(
                "o dataset de mistura exige pelo menos dois speaker_id distintos"
            )

        self.noise_records: list[dict[str, Any]] = []
        if noise_manifest is not None:
            self.noise_records = load_manifest(noise_manifest, expected_kind="noise")
            if split is not None:
                matching = [
                    record
                    for record in self.noise_records
                    if record["split"] in {split, "all"}
                ]
                if matching:
                    self.noise_records = matching

    def __len__(self) -> int:
        return self.samples_per_epoch

    def set_epoch(self, epoch: int) -> None:
        self.epoch = int(epoch)

    def _generator(self, index: int) -> torch.Generator:
        generator = torch.Generator()
        generator.manual_seed(
            (self.seed + self.epoch * 1_000_003 + int(index) * 9_176) % (2**63 - 1)
        )
        return generator

    @staticmethod
    def _choose(items: list[Any], generator: torch.Generator) -> Any:
        index = int(torch.randint(len(items), (1,), generator=generator).item())
        return items[index]

    def _load(self, record: dict[str, Any]) -> Tensor:
        return _cached_audio(record["_resolved_path"], self.sample_rate)

    def __getitem__(self, index: int) -> dict[str, Any]:
        generator = self._generator(index)
        target_speaker = self._choose(self.speakers, generator)
        interferer_speakers = [
            speaker for speaker in self.speakers if speaker != target_speaker
        ]
        interferer_speaker = self._choose(interferer_speakers, generator)

        target_records = self.by_speaker[target_speaker]
        target_record = self._choose(target_records, generator)
        enrollment_candidates = [
            record
            for record in target_records
            if record["_resolved_path"] != target_record["_resolved_path"]
        ]
        enrollment_record = self._choose(
            enrollment_candidates or target_records, generator
        )
        interferer_record = self._choose(
            self.by_speaker[interferer_speaker], generator
        )

        frame_count = int(
            torch.randint(
                self.minimum_frames,
                self.maximum_frames + 1,
                (1,),
                generator=generator,
            ).item()
        )
        num_samples = frame_count * self.frame_samples
        target = crop_or_repeat(
            self._load(target_record), num_samples, generator, random_crop=True
        )
        interferer = crop_or_repeat(
            self._load(interferer_record), num_samples, generator, random_crop=True
        )
        enrollment = crop_or_repeat(
            self._load(enrollment_record),
            self.enrollment_samples,
            generator,
            random_crop=True,
        )

        target_for_mix = target
        used_reverb = False
        if float(torch.rand((), generator=generator)) < self.reverb_probability:
            target_for_mix = _synthetic_room(
                target, generator, self.sample_rate, self.reverb_max_delay_ms
            )
            used_reverb = True
        if float(torch.rand((), generator=generator)) < self.reverb_probability:
            interferer = _synthetic_room(
                interferer, generator, self.sample_rate, self.reverb_max_delay_ms
            )
            used_reverb = True
        if (
            float(torch.rand((), generator=generator))
            < self.enrollment_reverb_probability
        ):
            enrollment = _synthetic_room(
                enrollment, generator, self.sample_rate, self.reverb_max_delay_ms
            )

        target_gain_db = _uniform(generator, -6.0, 3.0)
        target = target * (10.0 ** (target_gain_db / 20.0))
        target_for_mix = target_for_mix * (10.0 ** (target_gain_db / 20.0))
        sir_db = _uniform(generator, *self.sir_db)
        interferer_scale = rms(target_for_mix) / rms(interferer) * (
            10.0 ** (-sir_db / 20.0)
        )
        interferer = interferer * interferer_scale
        mixture = target_for_mix + interferer

        used_noise = False
        noise_snr_db: float | None = None
        if self.noise_records and float(torch.rand((), generator=generator)) < self.noise_probability:
            noise_record = self._choose(self.noise_records, generator)
            noise = crop_or_repeat(
                self._load(noise_record), num_samples, generator, random_crop=True
            )
            noise_snr_db = _uniform(generator, *self.noise_snr_db)
            noise_scale = rms(mixture) / rms(noise) * (
                10.0 ** (-noise_snr_db / 20.0)
            )
            mixture = mixture + noise * noise_scale
            used_noise = True

        peak = torch.stack((mixture.abs().max(), target.abs().max())).max()
        normalization = torch.clamp(0.95 / peak.clamp_min(1e-8), max=1.0)
        mixture = (mixture * normalization).float()
        target = (target * normalization).float()
        enrollment = enrollment.float()
        return {
            "mixture": mixture,
            "target": target,
            "enrollment": enrollment,
            "length": num_samples,
            "speaker_id": target_speaker,
            "sir_db": sir_db,
            "noise_snr_db": noise_snr_db,
            "used_noise": used_noise,
            "used_reverb": used_reverb,
        }


def collate_mixtures(examples: list[dict[str, Any]]) -> dict[str, Any]:
    if not examples:
        raise ValueError("batch vazio")
    lengths = torch.tensor([item["length"] for item in examples], dtype=torch.long)
    maximum = int(lengths.max().item())
    mixture = torch.zeros(len(examples), maximum, dtype=torch.float32)
    target = torch.zeros_like(mixture)
    for row, item in enumerate(examples):
        length = item["length"]
        mixture[row, :length] = item["mixture"]
        target[row, :length] = item["target"]
    return {
        "mixture": mixture,
        "target": target,
        "enrollment": torch.stack([item["enrollment"] for item in examples]),
        "lengths": lengths,
        "speaker_id": [item["speaker_id"] for item in examples],
    }
