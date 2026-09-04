"""Perdas para preservação temporal, perceptual e de separação."""

from __future__ import annotations

from collections.abc import Sequence

import torch
from torch import Tensor, nn
from torch.nn import functional as F


def _length_mask(lengths: Tensor, maximum: int, dtype: torch.dtype) -> Tensor:
    positions = torch.arange(maximum, device=lengths.device).unsqueeze(0)
    return (positions < lengths.unsqueeze(1)).to(dtype=dtype)


def si_sdr(
    estimate: Tensor,
    target: Tensor,
    lengths: Tensor,
    eps: float = 1e-8,
) -> Tensor:
    """SI-SDR por item, ignorando padding do batch."""
    if estimate.shape != target.shape or estimate.ndim != 2:
        raise ValueError("estimate e target devem ter o mesmo shape [batch, samples]")
    mask = _length_mask(lengths, estimate.shape[1], estimate.dtype)
    denominator = lengths.to(estimate.dtype).clamp_min(1).unsqueeze(1)
    estimate = (estimate - (estimate * mask).sum(1, keepdim=True) / denominator) * mask
    target = (target - (target * mask).sum(1, keepdim=True) / denominator) * mask
    scale = (estimate * target).sum(1, keepdim=True)
    scale = scale / target.square().sum(1, keepdim=True).clamp_min(eps)
    projection = scale * target
    noise = (estimate - projection) * mask
    ratio = projection.square().sum(1).clamp_min(eps)
    ratio = ratio / noise.square().sum(1).clamp_min(eps)
    return 10.0 * torch.log10(ratio.clamp_min(eps))


def masked_l1(estimate: Tensor, target: Tensor, lengths: Tensor) -> Tensor:
    mask = _length_mask(lengths, estimate.shape[1], estimate.dtype)
    total = ((estimate - target).abs() * mask).sum()
    return total / mask.sum().clamp_min(1.0)


def speaker_embedding_loss(
    enrollment_embedding: Tensor,
    target_embedding: Tensor,
    speaker_ids: Sequence[str],
    *,
    negative_margin: float = 0.2,
) -> Tensor:
    """Aproxima a mesma voz e afasta locutores diferentes no próprio batch."""
    enrollment_embedding = F.normalize(enrollment_embedding.float(), dim=1)
    target_embedding = F.normalize(target_embedding.float(), dim=1)
    positive = 1.0 - (enrollment_embedding * target_embedding).sum(dim=1)
    similarity = enrollment_embedding @ enrollment_embedding.transpose(0, 1)
    negative_terms = []
    for row, row_id in enumerate(speaker_ids):
        for column, column_id in enumerate(speaker_ids):
            if row != column and row_id != column_id:
                negative_terms.append(F.relu(similarity[row, column] - negative_margin))
    negative = (
        torch.stack(negative_terms).mean()
        if negative_terms
        else positive.new_zeros(())
    )
    return positive.mean() + negative


class MultiResolutionSTFTLoss(nn.Module):
    def __init__(
        self,
        fft_sizes: Sequence[int] = (256, 512, 1024),
        hop_sizes: Sequence[int] = (64, 128, 256),
        window_sizes: Sequence[int] = (256, 512, 1024),
        eps: float = 1e-7,
    ) -> None:
        super().__init__()
        if not (len(fft_sizes) == len(hop_sizes) == len(window_sizes)):
            raise ValueError("fft_sizes, hop_sizes e window_sizes devem ter mesmo tamanho")
        self.resolutions = tuple(
            zip(fft_sizes, hop_sizes, window_sizes, strict=True)
        )
        self.eps = eps

    def _single_resolution(
        self,
        estimate: Tensor,
        target: Tensor,
        n_fft: int,
        hop_length: int,
        win_length: int,
    ) -> Tensor:
        minimum = max(n_fft, win_length)
        if estimate.numel() < minimum:
            padding = minimum - estimate.numel()
            estimate = F.pad(estimate, (0, padding))
            target = F.pad(target, (0, padding))
        window = torch.hann_window(
            win_length, device=estimate.device, dtype=estimate.dtype
        )
        estimate_spectrum = torch.stft(
            estimate,
            n_fft=n_fft,
            hop_length=hop_length,
            win_length=win_length,
            window=window,
            center=False,
            return_complex=True,
        ).abs()
        target_spectrum = torch.stft(
            target,
            n_fft=n_fft,
            hop_length=hop_length,
            win_length=win_length,
            window=window,
            center=False,
            return_complex=True,
        ).abs()
        convergence = torch.linalg.vector_norm(estimate_spectrum - target_spectrum)
        convergence = convergence / torch.linalg.vector_norm(
            target_spectrum
        ).clamp_min(self.eps)
        log_magnitude = F.l1_loss(
            torch.log(estimate_spectrum.clamp_min(self.eps)),
            torch.log(target_spectrum.clamp_min(self.eps)),
        )
        return convergence + log_magnitude

    def forward(self, estimate: Tensor, target: Tensor, lengths: Tensor) -> Tensor:
        estimate = estimate.float()
        target = target.float()
        losses: list[Tensor] = []
        for row, length_tensor in enumerate(lengths):
            length = int(length_tensor.item())
            for n_fft, hop_length, win_length in self.resolutions:
                losses.append(
                    self._single_resolution(
                        estimate[row, :length],
                        target[row, :length],
                        n_fft,
                        hop_length,
                        win_length,
                    )
                )
        if not losses:
            return estimate.new_zeros(())
        return torch.stack(losses).mean()


class VoiceLockLoss(nn.Module):
    def __init__(
        self,
        *,
        si_sdr_weight: float = 1.0,
        l1_weight: float = 0.5,
        spectral_weight: float = 0.5,
        fft_sizes: Sequence[int] = (256, 512, 1024),
        hop_sizes: Sequence[int] = (64, 128, 256),
        window_sizes: Sequence[int] = (256, 512, 1024),
    ) -> None:
        super().__init__()
        self.si_sdr_weight = si_sdr_weight
        self.l1_weight = l1_weight
        self.spectral_weight = spectral_weight
        self.spectral = MultiResolutionSTFTLoss(
            fft_sizes=fft_sizes,
            hop_sizes=hop_sizes,
            window_sizes=window_sizes,
        )

    def forward(
        self,
        estimate: Tensor,
        target: Tensor,
        lengths: Tensor,
    ) -> dict[str, Tensor]:
        estimate_float = estimate.float()
        target_float = target.float()
        si_sdr_value = si_sdr(estimate_float, target_float, lengths).mean()
        l1_value = masked_l1(estimate_float, target_float, lengths)
        spectral_value = self.spectral(estimate_float, target_float, lengths)
        total = (
            -self.si_sdr_weight * si_sdr_value
            + self.l1_weight * l1_value
            + self.spectral_weight * spectral_value
        )
        return {
            "total": total,
            "si_sdr_db": si_sdr_value.detach(),
            "l1": l1_value.detach(),
            "spectral": spectral_value.detach(),
        }
