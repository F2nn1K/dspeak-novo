from __future__ import annotations

import argparse
import importlib.util
import tempfile
import unittest
from pathlib import Path

from export_onnx import export_models
from voicelock.checkpoint import load_models, make_checkpoint, save_checkpoint
from voicelock.config import clone_config, load_config
from voicelock.factory import build_models

HAS_ONNX_STACK = (
    importlib.util.find_spec("onnx") is not None
    and importlib.util.find_spec("onnxruntime") is not None
)


class CheckpointAndExportSmokeTests(unittest.TestCase):
    def setUp(self) -> None:
        config_path = Path(__file__).resolve().parents[1] / "configs" / "default.json"
        self.config = clone_config(load_config(config_path))
        self.config["model"]["enrollment"]["channels"] = [8, 12]
        self.config["model"]["enrollment"]["strides"] = [8, 8]
        self.config["model"]["extractor"].update(
            {"latent_channels": 16, "hidden_size": 24, "num_layers": 1}
        )
        self.enrollment, self.extractor = build_models(self.config)
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.checkpoint = self.root / "model.pt"
        save_checkpoint(
            make_checkpoint(
                config=self.config,
                enrollment=self.enrollment,
                extractor=self.extractor,
                epoch=0,
                global_step=0,
                best_validation_loss=1.0,
            ),
            self.checkpoint,
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_checkpoint_round_trip(self) -> None:
        enrollment, extractor, payload = load_models(self.checkpoint)
        self.assertEqual(enrollment.embedding_dim, 128)
        self.assertEqual(extractor.frame_samples, 160)
        self.assertEqual(payload["format_version"], 1)

    @unittest.skipUnless(HAS_ONNX_STACK, "onnx e onnxruntime não instalados")
    def test_fixed_frame_onnx_export_and_parity(self) -> None:
        output_dir = self.root / "exports"
        metadata = export_models(
            argparse.Namespace(
                checkpoint=self.checkpoint,
                output_dir=output_dir,
                opset=18,
                skip_runtime_validation=False,
            )
        )
        self.assertTrue((output_dir / "encoder.onnx").is_file())
        self.assertTrue((output_dir / "extractor.onnx").is_file())
        self.assertEqual(metadata["extractor_inputs"]["audio"], [1, 160])
        self.assertEqual(metadata["extractor_outputs"]["audio_out"], [1, 160])
        self.assertIsNotNone(metadata["runtime_parity"])


if __name__ == "__main__":
    unittest.main()
