from __future__ import annotations

import unittest

import torch

from voicelock.losses import (
    VoiceLockLoss,
    masked_l1,
    si_sdr,
    speaker_embedding_loss,
)


class LossSmokeTests(unittest.TestCase):
    def test_si_sdr_and_padding_mask(self) -> None:
        torch.manual_seed(3)
        target = torch.randn(2, 640)
        estimate = target.clone()
        estimate[0, 320:] = 100.0
        lengths = torch.tensor([320, 640])
        scores = si_sdr(estimate, target, lengths)
        self.assertTrue(torch.all(scores > 70.0))
        self.assertAlmostEqual(float(masked_l1(estimate, target, lengths)), 0.0, places=6)

    def test_composite_loss_is_finite_and_differentiable(self) -> None:
        torch.manual_seed(4)
        target = torch.randn(2, 640) * 0.1
        estimate = (target + torch.randn_like(target) * 0.01).requires_grad_(True)
        lengths = torch.tensor([480, 640])
        criterion = VoiceLockLoss(
            fft_sizes=(64, 128),
            hop_sizes=(16, 32),
            window_sizes=(64, 128),
        )
        losses = criterion(estimate, target, lengths)
        self.assertTrue(torch.isfinite(losses["total"]))
        losses["total"].backward()
        self.assertIsNotNone(estimate.grad)
        self.assertTrue(torch.isfinite(estimate.grad).all())

    def test_speaker_loss_recompensa_mesma_identidade(self) -> None:
        enroll = torch.tensor([[1.0, 0.0], [0.0, 1.0]], requires_grad=True)
        matching = torch.tensor([[1.0, 0.0], [0.0, 1.0]])
        swapped = torch.tensor([[0.0, 1.0], [1.0, 0.0]])
        good = speaker_embedding_loss(enroll, matching, ["a", "b"])
        bad = speaker_embedding_loss(enroll, swapped, ["a", "b"])
        self.assertLess(float(good), float(bad))
        good.backward()
        self.assertIsNotNone(enroll.grad)


if __name__ == "__main__":
    unittest.main()
