from __future__ import annotations

import argparse
import tempfile
import unittest
from pathlib import Path

import torch

from evaluate import evaluate
from train import train
from voicelock.audio import write_wav
from voicelock.config import clone_config, load_config, save_config
from voicelock.manifest import build_manifest


class TrainEvaluateSmokeTests(unittest.TestCase):
    def test_one_step_train_and_streaming_evaluation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            speech_root = root / "speech"
            time = torch.arange(800, dtype=torch.float32) / 16_000
            for index, frequency in enumerate((170.0, 310.0), 1):
                speaker = speech_root / f"speaker_{index}"
                speaker.mkdir(parents=True)
                write_wav(
                    speaker / "sample.wav",
                    0.1 * torch.sin(2 * torch.pi * frequency * time),
                )
            manifest = root / "train.jsonl"
            build_manifest(
                root=speech_root,
                output=manifest,
                kind="speech",
                split="train",
                dataset_name="synthetic-smoke",
                source_url="https://example.invalid/synthetic",
                license_id="LicenseRef-Test",
                license_name="Synthetic test fixture",
                license_url="https://example.invalid/license",
                license_attribution="Generated during test; no person recorded",
            )

            default_path = (
                Path(__file__).resolve().parents[1] / "configs" / "default.json"
            )
            config = clone_config(load_config(default_path))
            config["model"]["enrollment"]["channels"] = [4]
            config["model"]["enrollment"]["strides"] = [64]
            config["model"]["extractor"].update(
                {"latent_channels": 8, "hidden_size": 12, "num_layers": 1}
            )
            config["data"].update(
                {
                    "train_manifest": str(manifest),
                    "validation_manifest": None,
                    "noise_manifest": None,
                    "segment_seconds_min": 0.02,
                    "segment_seconds_max": 0.02,
                }
            )
            config["loss"]["spectral"] = {
                "fft_sizes": [64],
                "hop_sizes": [16],
                "window_sizes": [64],
            }
            output_dir = root / "artifacts"
            config["training"].update(
                {
                    "amp": False,
                    "batch_size": 1,
                    "epochs": 1,
                    "log_every_steps": 1,
                    "num_workers": 0,
                    "output_dir": str(output_dir),
                    "samples_per_epoch": 1,
                    "validation_samples": 1,
                }
            )
            config_path = root / "config.json"
            save_config(config, config_path)
            train(
                argparse.Namespace(
                    config=config_path,
                    output_dir=None,
                    resume=None,
                    device="cpu",
                )
            )
            checkpoint = output_dir / "best.pt"
            self.assertTrue(checkpoint.is_file())
            result = evaluate(
                argparse.Namespace(
                    checkpoint=checkpoint,
                    manifest=manifest,
                    noise_manifest=None,
                    split="train",
                    examples=1,
                    device="cpu",
                    output_json=root / "evaluation.json",
                )
            )
            self.assertEqual(result["examples"], 1)
            self.assertEqual(result["frame_samples"], 160)
            self.assertTrue((root / "evaluation.json").is_file())


if __name__ == "__main__":
    unittest.main()
