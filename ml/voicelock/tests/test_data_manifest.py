from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import torch

from voicelock.audio import write_wav
from voicelock.data import TargetSpeakerMixDataset, collate_mixtures
from voicelock.manifest import (
    ManifestError,
    build_manifest,
    validate_manifest_file,
    validate_record,
)


class DataAndManifestSmokeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        speech_root = self.root / "speech"
        noise_root = self.root / "noise"
        time = torch.arange(1_600, dtype=torch.float32) / 16_000
        for index, frequency in enumerate((180.0, 260.0), 1):
            speaker = speech_root / f"speaker_{index:03d}"
            speaker.mkdir(parents=True)
            waveform = 0.2 * torch.sin(2 * torch.pi * frequency * time)
            write_wav(speaker / "utterance.wav", waveform)
        noise_root.mkdir(parents=True)
        generator = torch.Generator().manual_seed(9)
        write_wav(noise_root / "room.wav", torch.randn(1_600, generator=generator) * 0.02)

        self.speech_manifest = self.root / "manifests" / "train.jsonl"
        self.noise_manifest = self.root / "manifests" / "noise.jsonl"
        common = {
            "dataset_name": "synthetic-test-only",
            "source_url": "https://example.invalid/synthetic",
            "license_id": "LicenseRef-Test",
            "license_name": "Synthetic test fixture",
            "license_url": "https://example.invalid/license",
            "license_attribution": "Generated during unit test; no person recorded",
        }
        build_manifest(
            root=speech_root,
            output=self.speech_manifest,
            kind="speech",
            split="train",
            **common,
        )
        build_manifest(
            root=noise_root,
            output=self.noise_manifest,
            kind="noise",
            split="all",
            **common,
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_manifest_and_hash_validation(self) -> None:
        summary = validate_manifest_file(
            self.speech_manifest, check_audio=True, verify_hashes=True
        )
        self.assertEqual(summary["records"], 2)
        self.assertEqual(summary["speech_speakers"], 2)

    def test_license_metadata_is_mandatory(self) -> None:
        first_record = json.loads(
            self.speech_manifest.read_text(encoding="utf-8").splitlines()[0]
        )
        del first_record["license"]["url"]
        with self.assertRaises(ManifestError):
            validate_record(first_record, 1)

    def test_on_the_fly_mixture_and_collation(self) -> None:
        dataset = TargetSpeakerMixDataset(
            self.speech_manifest,
            noise_manifest=self.noise_manifest,
            split="train",
            segment_seconds_min=0.02,
            segment_seconds_max=0.04,
            samples_per_epoch=8,
            noise_probability=1.0,
            reverb_probability=1.0,
            seed=22,
        )
        examples = [dataset[index] for index in range(8)]
        lengths = {example["length"] for example in examples}
        self.assertTrue(lengths.issubset({320, 480, 640}))
        self.assertTrue(all(example["enrollment"].numel() == 64_000 for example in examples))
        self.assertTrue(all(example["used_noise"] for example in examples))
        self.assertTrue(all(example["used_reverb"] for example in examples))
        batch = collate_mixtures(examples[:2])
        self.assertEqual(batch["mixture"].shape[0], 2)
        self.assertEqual(batch["target"].shape, batch["mixture"].shape)
        self.assertEqual(tuple(batch["enrollment"].shape), (2, 64_000))


if __name__ == "__main__":
    unittest.main()
