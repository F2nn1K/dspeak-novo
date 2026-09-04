"""Modelos próprios e compactos para Target Speaker Extraction."""

from __future__ import annotations

from collections.abc import Sequence

import torch
from torch import Tensor, nn
from torch.nn import functional as F


class EnrollmentBlock(nn.Module):
    def __init__(self, in_channels: int, out_channels: int, stride: int) -> None:
        super().__init__()
        self.conv = nn.Conv1d(
            in_channels,
            out_channels,
            kernel_size=9,
            stride=stride,
            padding=4,
            bias=False,
        )
        groups = min(8, out_channels)
        while out_channels % groups:
            groups -= 1
        self.norm = nn.GroupNorm(groups, out_channels)
        self.activation = nn.SiLU()

    def forward(self, inputs: Tensor) -> Tensor:
        return self.activation(self.norm(self.conv(inputs)))


class EnrollmentEncoder(nn.Module):
    """Codifica uma referência mono de 4 s em um vetor L2-normalizado de 128D."""

    def __init__(
        self,
        embedding_dim: int = 128,
        channels: Sequence[int] = (32, 64, 96, 128),
        strides: Sequence[int] = (4, 4, 2, 2),
        sample_rate: int = 16_000,
        enrollment_seconds: float = 4.0,
    ) -> None:
        super().__init__()
        if len(channels) != len(strides) or not channels:
            raise ValueError("channels e strides devem ter o mesmo tamanho não vazio")
        self.embedding_dim = embedding_dim
        self.enrollment_samples = int(round(sample_rate * enrollment_seconds))

        blocks: list[nn.Module] = []
        in_channels = 1
        for out_channels, stride in zip(channels, strides, strict=True):
            blocks.append(EnrollmentBlock(in_channels, out_channels, stride))
            in_channels = out_channels
        self.features = nn.Sequential(*blocks)
        self.projection = nn.Sequential(
            nn.Linear(in_channels * 2, embedding_dim),
            nn.LayerNorm(embedding_dim),
        )

    def forward(self, enrollment: Tensor) -> Tensor:
        if enrollment.ndim != 2:
            raise ValueError(
                f"enrollment deve ter shape [batch, samples], recebido {enrollment.shape}"
            )
        features = self.features(enrollment.unsqueeze(1))
        mean = features.mean(dim=-1)
        std = features.var(dim=-1, unbiased=False).clamp_min(1e-8).sqrt()
        embedding = self.projection(torch.cat((mean, std), dim=1))
        return F.normalize(embedding, p=2.0, dim=1, eps=1e-8)


class CausalExtractor(nn.Module):
    """Extrator causal por blocos com estado recorrente explicitamente exposto.

    O codec usa ``kernel_size == stride``. Portanto, não existe janela
    convolucional atravessando a fronteira entre frames, e carregar apenas o
    estado da GRU é suficiente para equivalência entre execução integral e
    streaming em frames alinhados.
    """

    def __init__(
        self,
        embedding_dim: int = 128,
        latent_channels: int = 48,
        hidden_size: int = 64,
        num_layers: int = 2,
        codec_stride: int = 16,
        frame_samples: int = 160,
    ) -> None:
        super().__init__()
        if frame_samples % codec_stride:
            raise ValueError("frame_samples deve ser múltiplo de codec_stride")
        if num_layers < 1:
            raise ValueError("num_layers deve ser >= 1")
        self.embedding_dim = embedding_dim
        self.latent_channels = latent_channels
        self.hidden_size = hidden_size
        self.num_layers = num_layers
        self.codec_stride = codec_stride
        self.frame_samples = frame_samples

        self.encoder = nn.Conv1d(
            1,
            latent_channels,
            kernel_size=codec_stride,
            stride=codec_stride,
            bias=False,
        )
        self.encoder_norm = nn.LayerNorm(latent_channels)
        self.film = nn.Linear(embedding_dim, latent_channels * 2)
        self.gru = nn.GRU(
            input_size=latent_channels,
            hidden_size=hidden_size,
            num_layers=num_layers,
            batch_first=False,
            bidirectional=False,
        )
        self.decoder_projection = nn.Linear(hidden_size, latent_channels)
        self.decoder_norm = nn.LayerNorm(latent_channels)
        self.decoder = nn.ConvTranspose1d(
            latent_channels,
            1,
            kernel_size=codec_stride,
            stride=codec_stride,
            bias=False,
        )
        self.activation = nn.SiLU()
        self._initialize()

    def _initialize(self) -> None:
        nn.init.xavier_uniform_(self.encoder.weight)
        nn.init.xavier_uniform_(self.decoder.weight)
        nn.init.zeros_(self.film.bias)
        with torch.no_grad():
            self.film.weight.mul_(0.1)

    def initial_state(
        self,
        batch_size: int,
        *,
        device: torch.device | str | None = None,
        dtype: torch.dtype | None = None,
    ) -> Tensor:
        reference = self.encoder.weight
        return torch.zeros(
            self.num_layers,
            batch_size,
            self.hidden_size,
            device=device if device is not None else reference.device,
            dtype=dtype if dtype is not None else reference.dtype,
        )

    def forward(
        self,
        audio: Tensor,
        embedding: Tensor,
        state: Tensor | None = None,
    ) -> tuple[Tensor, Tensor]:
        tracing = torch.jit.is_tracing() or torch.onnx.is_in_onnx_export()
        if not tracing:
            if audio.ndim != 2:
                raise ValueError(
                    f"audio deve ter shape [batch, samples], recebido {audio.shape}"
                )
            if embedding.ndim != 2 or embedding.shape[1] != self.embedding_dim:
                raise ValueError(
                    "embedding deve ter shape "
                    f"[batch, {self.embedding_dim}], recebido {embedding.shape}"
                )
            if audio.shape[0] != embedding.shape[0]:
                raise ValueError("batch de audio e embedding deve ser igual")
        original_samples = audio.shape[-1]
        if not tracing and original_samples < 1:
            raise ValueError("audio não pode ser vazio")
        padding = (-original_samples) % self.codec_stride
        audio = F.pad(audio, (0, padding))

        encoded = self.encoder(audio.unsqueeze(1)).transpose(1, 2)
        encoded = self.encoder_norm(encoded)
        gamma, beta = self.film(embedding).chunk(2, dim=1)
        encoded = encoded * (1.0 + torch.tanh(gamma).unsqueeze(1))
        encoded = encoded + beta.unsqueeze(1)

        sequence = encoded.transpose(0, 1)
        if state is None:
            state = self.initial_state(
                audio.shape[0], device=audio.device, dtype=audio.dtype
            )
        expected_state = (self.num_layers, audio.shape[0], self.hidden_size)
        if not tracing and tuple(state.shape) != expected_state:
            raise ValueError(
                f"state deve ter shape {expected_state}, recebido {tuple(state.shape)}"
            )
        recurrent, state_out = self.gru(sequence, state.contiguous())
        decoded = self.decoder_projection(recurrent.transpose(0, 1))
        decoded = self.activation(self.decoder_norm(decoded)).transpose(1, 2)
        audio_out = self.decoder(decoded).squeeze(1)
        audio_out = torch.tanh(audio_out[..., :original_samples])
        return audio_out, state_out


def count_parameters(module: nn.Module) -> int:
    return sum(parameter.numel() for parameter in module.parameters())
