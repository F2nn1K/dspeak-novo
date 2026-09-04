"""Avalia SI-SDR, ganho sobre a mistura e fator de tempo real streaming."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from statistics import fmean
from typing import Any

import torch
from torch.utils.data import DataLoader
try:
    from pystoi import stoi
except ImportError:  # smoke mínimo pode rodar sem o extra [evaluation]
    stoi = None

from voicelock.checkpoint import load_models
from voicelock.data import TargetSpeakerMixDataset, collate_mixtures
from voicelock.losses import masked_l1, si_sdr
from voicelock.runtime import extract_streaming, resolve_device, seed_everything


def _synchronize(device: torch.device) -> None:
    if device.type == "cuda":
        torch.cuda.synchronize(device)


def evaluate(args: argparse.Namespace) -> dict[str, Any]:
    device = resolve_device(args.device)
    enrollment, extractor, payload = load_models(args.checkpoint, device=device)
    enrollment.eval()
    extractor.eval()
    config = payload["config"]
    seed_everything(config["training"]["seed"], deterministic=False)
    data_config = config["data"]
    speech_manifest = (
        str(args.manifest)
        if args.manifest is not None
        else data_config.get("validation_manifest") or data_config["train_manifest"]
    )
    noise_manifest = (
        str(args.noise_manifest)
        if args.noise_manifest is not None
        else data_config.get("noise_manifest")
    )
    dataset = TargetSpeakerMixDataset(
        speech_manifest,
        noise_manifest=noise_manifest,
        split=args.split,
        sample_rate=config["audio"]["sample_rate"],
        enrollment_seconds=config["audio"]["enrollment_seconds"],
        frame_samples=config["audio"]["frame_samples"],
        segment_seconds_min=data_config["segment_seconds_min"],
        segment_seconds_max=data_config["segment_seconds_max"],
        samples_per_epoch=args.examples,
        sir_db=tuple(data_config["sir_db"]),
        noise_snr_db=tuple(data_config["noise_snr_db"]),
        noise_probability=data_config["noise_probability"],
        reverb_probability=data_config["reverb_probability"],
        enrollment_reverb_probability=data_config["enrollment_reverb_probability"],
        reverb_max_delay_ms=data_config["reverb_max_delay_ms"],
        seed=config["training"]["seed"] + 200_000,
    )
    loader = DataLoader(
        dataset,
        batch_size=1,
        shuffle=False,
        num_workers=0,
        collate_fn=collate_mixtures,
    )

    input_scores: list[float] = []
    output_scores: list[float] = []
    l1_scores: list[float] = []
    stoi_scores: list[float] = []
    extraction_seconds = 0.0
    end_to_end_seconds = 0.0
    audio_seconds = 0.0
    with torch.inference_mode():
        for batch in loader:
            mixture = batch["mixture"].to(device)
            target = batch["target"].to(device)
            enrollment_audio = batch["enrollment"].to(device)
            lengths = batch["lengths"].to(device)
            _synchronize(device)
            end_to_end_start = time.perf_counter()
            embedding = enrollment(enrollment_audio)
            _synchronize(device)
            extraction_start = time.perf_counter()
            estimate, _ = extract_streaming(extractor, mixture, embedding)
            _synchronize(device)
            extraction_seconds += time.perf_counter() - extraction_start
            end_to_end_seconds += time.perf_counter() - end_to_end_start
            input_scores.append(float(si_sdr(mixture, target, lengths).item()))
            output_scores.append(float(si_sdr(estimate, target, lengths).item()))
            l1_scores.append(float(masked_l1(estimate, target, lengths).item()))
            valid = int(lengths.item())
            if stoi is not None and valid >= config["audio"]["sample_rate"] // 2:
                stoi_scores.append(
                    float(
                        stoi(
                            target[0, :valid].detach().cpu().numpy(),
                            estimate[0, :valid].detach().cpu().numpy(),
                            config["audio"]["sample_rate"],
                            extended=False,
                        )
                    )
                )
            audio_seconds += float(lengths.item()) / config["audio"]["sample_rate"]

    result = {
        "checkpoint": str(args.checkpoint),
        "device": str(device),
        "examples": len(output_scores),
        "audio_seconds": audio_seconds,
        "input_si_sdr_db": fmean(input_scores),
        "output_si_sdr_db": fmean(output_scores),
        "si_sdr_improvement_db": fmean(output_scores) - fmean(input_scores),
        "l1": fmean(l1_scores),
        "target_stoi": fmean(stoi_scores) if stoi_scores else None,
        "extractor_rtf": extraction_seconds / audio_seconds,
        "end_to_end_rtf": end_to_end_seconds / audio_seconds,
        "frame_samples": extractor.frame_samples,
        "sample_rate": config["audio"]["sample_rate"],
    }
    if args.output_json is not None:
        args.output_json.parent.mkdir(parents=True, exist_ok=True)
        args.output_json.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--noise-manifest", type=Path)
    parser.add_argument("--split")
    parser.add_argument("--examples", type=int, default=100)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--output-json", type=Path)
    args = parser.parse_args()
    if args.examples < 1:
        parser.error("--examples deve ser positivo")
    return args


if __name__ == "__main__":
    evaluate(parse_args())
