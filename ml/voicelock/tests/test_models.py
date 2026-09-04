from __future__ import annotations

import unittest

import torch

from voicelock.models import CausalExtractor, EnrollmentEncoder
from voicelock.runtime import extract_streaming


class ModelSmokeTests(unittest.TestCase):
    def setUp(self) -> None:
        torch.manual_seed(7)
        self.extractor = CausalExtractor(
            embedding_dim=128,
            latent_channels=16,
            hidden_size=24,
            num_layers=1,
            codec_stride=16,
            frame_samples=160,
        ).eval()
        self.embedding = torch.nn.functional.normalize(torch.randn(1, 128), dim=1)

    def test_enrollment_is_128d_and_normalized(self) -> None:
        encoder = EnrollmentEncoder(
            embedding_dim=128,
            channels=(8, 12),
            strides=(8, 8),
            sample_rate=16_000,
            enrollment_seconds=4.0,
        ).eval()
        with torch.inference_mode():
            embedding = encoder(torch.randn(2, 64_000))
        self.assertEqual(tuple(embedding.shape), (2, 128))
        torch.testing.assert_close(
            embedding.norm(dim=1), torch.ones(2), atol=1e-5, rtol=1e-5
        )

    def test_dynamic_length_and_explicit_state(self) -> None:
        audio = torch.randn(2, 777)
        embedding = self.embedding.repeat(2, 1)
        state = self.extractor.initial_state(2)
        with torch.inference_mode():
            output, state_out = self.extractor(audio, embedding, state)
        self.assertEqual(tuple(output.shape), (2, 777))
        self.assertEqual(tuple(state_out.shape), (1, 2, 24))

    def test_streaming_matches_full_aligned_audio(self) -> None:
        audio = torch.randn(1, 480)
        with torch.inference_mode():
            full, full_state = self.extractor(audio, self.embedding)
            streamed, streamed_state = extract_streaming(
                self.extractor, audio, self.embedding
            )
        torch.testing.assert_close(streamed, full, atol=1e-6, rtol=1e-5)
        torch.testing.assert_close(streamed_state, full_state, atol=1e-6, rtol=1e-5)

    def test_future_frame_does_not_change_first_frame(self) -> None:
        prefix = torch.randn(1, 160)
        first = torch.cat((prefix, torch.zeros(1, 160)), dim=1)
        second = torch.cat((prefix, torch.randn(1, 160)), dim=1)
        with torch.inference_mode():
            first_output, _ = self.extractor(first, self.embedding)
            second_output, _ = self.extractor(second, self.embedding)
        torch.testing.assert_close(
            first_output[:, :160], second_output[:, :160], atol=1e-6, rtol=1e-5
        )


if __name__ == "__main__":
    unittest.main()
