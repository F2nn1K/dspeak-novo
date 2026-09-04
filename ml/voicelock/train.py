"""Treina EnrollmentEncoder + extrator causal exclusivamente do zero."""

from __future__ import annotations

import argparse
import json
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

import torch
from torch.utils.data import DataLoader

from voicelock.checkpoint import (
    load_checkpoint,
    make_checkpoint,
    save_checkpoint,
)
from voicelock.config import clone_config, config_digest, load_config, save_config
from voicelock.data import TargetSpeakerMixDataset, collate_mixtures
from voicelock.factory import build_loss, build_models
from voicelock.losses import speaker_embedding_loss
from voicelock.models import count_parameters
from voicelock.runtime import resolve_device, seed_everything


def _dataset(
    config: dict[str, Any],
    *,
    validation: bool,
) -> TargetSpeakerMixDataset | None:
    data = config["data"]
    training = config["training"]
    manifest_key = "validation_manifest" if validation else "train_manifest"
    manifest = data.get(manifest_key)
    if validation and not manifest:
        return None
    return TargetSpeakerMixDataset(
        manifest,
        noise_manifest=data.get("noise_manifest"),
        split=data.get("validation_split" if validation else "train_split"),
        sample_rate=config["audio"]["sample_rate"],
        enrollment_seconds=config["audio"]["enrollment_seconds"],
        frame_samples=config["audio"]["frame_samples"],
        segment_seconds_min=data["segment_seconds_min"],
        segment_seconds_max=data["segment_seconds_max"],
        samples_per_epoch=(
            training["validation_samples"]
            if validation
            else training["samples_per_epoch"]
        ),
        sir_db=tuple(data["sir_db"]),
        noise_snr_db=tuple(data["noise_snr_db"]),
        noise_probability=data["noise_probability"],
        reverb_probability=data["reverb_probability"],
        enrollment_reverb_probability=data["enrollment_reverb_probability"],
        reverb_max_delay_ms=data["reverb_max_delay_ms"],
        seed=training["seed"] + (100_000 if validation else 0),
    )


def _loader(
    dataset: TargetSpeakerMixDataset,
    config: dict[str, Any],
    *,
    validation: bool,
    device: torch.device,
) -> DataLoader[dict[str, Any]]:
    training = config["training"]
    return DataLoader(
        dataset,
        batch_size=training["batch_size"],
        shuffle=False,
        num_workers=training["num_workers"],
        pin_memory=device.type == "cuda",
        drop_last=False,
        collate_fn=collate_mixtures,
        persistent_workers=False,
    )


def _move_batch(
    batch: dict[str, Any],
    device: torch.device,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    return (
        batch["mixture"].to(device, non_blocking=True),
        batch["target"].to(device, non_blocking=True),
        batch["enrollment"].to(device, non_blocking=True),
        batch["lengths"].to(device, non_blocking=True),
    )


@torch.no_grad()
def _validate(
    enrollment: torch.nn.Module,
    extractor: torch.nn.Module,
    criterion: torch.nn.Module,
    loader: DataLoader[dict[str, Any]],
    device: torch.device,
    amp_enabled: bool,
    speaker_weight: float,
    speaker_negative_margin: float,
) -> dict[str, float]:
    enrollment.eval()
    extractor.eval()
    totals: defaultdict[str, float] = defaultdict(float)
    steps = 0
    for batch in loader:
        mixture, target, enrollment_audio, lengths = _move_batch(batch, device)
        with torch.autocast(
            device_type=device.type,
            dtype=torch.float16,
            enabled=amp_enabled,
        ):
            embedding = enrollment(enrollment_audio)
            target_embedding = enrollment(target)
            estimate, _ = extractor(mixture, embedding)
        losses = criterion(estimate, target, lengths)
        speaker_loss = speaker_embedding_loss(
            embedding,
            target_embedding,
            batch["speaker_id"],
            negative_margin=speaker_negative_margin,
        )
        losses["total"] = losses["total"] + speaker_weight * speaker_loss
        losses["speaker"] = speaker_loss.detach()
        for name, value in losses.items():
            totals[name] += float(value.detach().item())
        steps += 1
    return {name: value / max(steps, 1) for name, value in totals.items()}


def train(args: argparse.Namespace) -> None:
    config = clone_config(load_config(args.config))
    if args.output_dir is not None:
        config["training"]["output_dir"] = str(args.output_dir)
    device = resolve_device(args.device)
    training = config["training"]
    seed_everything(training["seed"], deterministic=training["deterministic"])
    output_dir = Path(config["training"]["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    save_config(config, output_dir / "config.resolved.json")

    train_dataset = _dataset(config, validation=False)
    assert train_dataset is not None
    validation_dataset = _dataset(config, validation=True)
    train_loader = _loader(train_dataset, config, validation=False, device=device)
    validation_loader = (
        _loader(validation_dataset, config, validation=True, device=device)
        if validation_dataset is not None
        else None
    )

    enrollment, extractor = build_models(config)
    enrollment.to(device)
    extractor.to(device)
    criterion = build_loss(config).to(device)
    speaker_weight = float(config["loss"].get("speaker_weight", 0.0))
    speaker_negative_margin = float(
        config["loss"].get("speaker_negative_margin", 0.2)
    )
    parameters = list(enrollment.parameters()) + list(extractor.parameters())
    optimizer = torch.optim.AdamW(
        parameters,
        lr=training["learning_rate"],
        weight_decay=training["weight_decay"],
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=training["epochs"], eta_min=training["min_learning_rate"]
    )
    amp_enabled = bool(training["amp"] and device.type == "cuda")
    scaler = torch.amp.GradScaler("cuda", enabled=amp_enabled)

    start_epoch = 0
    global_step = 0
    best_validation_loss = float("inf")
    if args.resume is not None:
        payload = load_checkpoint(args.resume, map_location=device)
        if config_digest(payload["config"]) != config_digest(config):
            raise ValueError(
                "a configuração do checkpoint difere da configuração solicitada"
            )
        enrollment.load_state_dict(payload["enrollment_state_dict"], strict=True)
        extractor.load_state_dict(payload["extractor_state_dict"], strict=True)
        optimizer.load_state_dict(payload["optimizer_state_dict"])
        scheduler.load_state_dict(payload["scheduler_state_dict"])
        if "scaler_state_dict" in payload:
            scaler.load_state_dict(payload["scaler_state_dict"])
        start_epoch = int(payload["epoch"]) + 1
        global_step = int(payload["global_step"])
        best_validation_loss = float(payload["best_validation_loss"])

    print(
        json.dumps(
            {
                "device": str(device),
                "amp": amp_enabled,
                "enrollment_parameters": count_parameters(enrollment),
                "extractor_parameters": count_parameters(extractor),
                "config_sha256": config_digest(config),
            },
            indent=2,
        )
    )
    metrics_path = output_dir / "metrics.jsonl"
    metrics_mode = "a" if args.resume is not None else "w"
    with metrics_path.open(metrics_mode, encoding="utf-8", buffering=1) as metrics_file:
        for epoch in range(start_epoch, training["epochs"]):
            epoch_started = time.perf_counter()
            train_dataset.set_epoch(epoch)
            enrollment.train()
            extractor.train()
            totals: defaultdict[str, float] = defaultdict(float)
            steps = 0
            for batch in train_loader:
                mixture, target, enrollment_audio, lengths = _move_batch(batch, device)
                optimizer.zero_grad(set_to_none=True)
                with torch.autocast(
                    device_type=device.type,
                    dtype=torch.float16,
                    enabled=amp_enabled,
                ):
                    embedding = enrollment(enrollment_audio)
                    target_embedding = enrollment(target)
                    estimate, _ = extractor(mixture, embedding)
                losses = criterion(estimate, target, lengths)
                speaker_loss = speaker_embedding_loss(
                    embedding,
                    target_embedding,
                    batch["speaker_id"],
                    negative_margin=speaker_negative_margin,
                )
                losses["total"] = losses["total"] + speaker_weight * speaker_loss
                losses["speaker"] = speaker_loss.detach()
                scaler.scale(losses["total"]).backward()
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(
                    parameters, training["gradient_clip_norm"]
                )
                scaler.step(optimizer)
                scaler.update()
                global_step += 1
                steps += 1
                for name, value in losses.items():
                    totals[name] += float(value.detach().item())
                if global_step % training["log_every_steps"] == 0:
                    print(
                        json.dumps(
                            {
                                "epoch": epoch,
                                "step": global_step,
                                "loss": float(losses["total"].detach().item()),
                                "si_sdr_db": float(losses["si_sdr_db"].item()),
                            }
                        )
                    )

            train_metrics = {
                name: value / max(steps, 1) for name, value in totals.items()
            }
            validation_metrics = (
                _validate(
                    enrollment,
                    extractor,
                    criterion,
                    validation_loader,
                    device,
                    amp_enabled,
                    speaker_weight,
                    speaker_negative_margin,
                )
                if validation_loader is not None
                else train_metrics
            )
            scheduler.step()
            validation_loss = validation_metrics["total"]
            is_best = validation_loss < best_validation_loss
            best_validation_loss = min(best_validation_loss, validation_loss)
            checkpoint = make_checkpoint(
                config=config,
                enrollment=enrollment,
                extractor=extractor,
                epoch=epoch,
                global_step=global_step,
                best_validation_loss=best_validation_loss,
                optimizer=optimizer,
                scheduler=scheduler,
                scaler=scaler,
            )
            save_checkpoint(checkpoint, output_dir / "last.pt")
            if is_best:
                save_checkpoint(checkpoint, output_dir / "best.pt")
            report = {
                "epoch": epoch,
                "global_step": global_step,
                "learning_rate": optimizer.param_groups[0]["lr"],
                "train": train_metrics,
                "validation": validation_metrics,
                "best_validation_loss": best_validation_loss,
                "seconds": time.perf_counter() - epoch_started,
            }
            metrics_file.write(json.dumps(report, ensure_ascii=False) + "\n")
            print(json.dumps(report, ensure_ascii=False, indent=2))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config", type=Path, default=Path("configs/default.json")
    )
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--resume", type=Path)
    parser.add_argument("--device", default="auto")
    return parser.parse_args()


if __name__ == "__main__":
    train(parse_args())
