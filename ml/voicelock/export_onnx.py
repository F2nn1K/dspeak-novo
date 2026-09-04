"""Exporta encoder.onnx e extractor.onnx com contrato streaming fixo."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import torch

from voicelock.checkpoint import load_models
from voicelock.config import config_digest
from voicelock.models import CausalExtractor, EnrollmentEncoder, count_parameters


class WebGpuExtractor(torch.nn.Module):
    """Exporta a GRU treinada como primitivas suportadas pelo ORT WebGPU."""

    def __init__(self, extractor: CausalExtractor) -> None:
        super().__init__()
        self.extractor = extractor

    def _gru_layer(
        self,
        inputs: torch.Tensor,
        hidden: torch.Tensor,
        layer: int,
    ) -> torch.Tensor:
        gru = self.extractor.gru
        input_gates = torch.nn.functional.linear(
            inputs,
            getattr(gru, f"weight_ih_l{layer}"),
            getattr(gru, f"bias_ih_l{layer}"),
        )
        hidden_gates = torch.nn.functional.linear(
            hidden,
            getattr(gru, f"weight_hh_l{layer}"),
            getattr(gru, f"bias_hh_l{layer}"),
        )
        input_reset, input_update, input_new = input_gates.chunk(3, dim=1)
        hidden_reset, hidden_update, hidden_new = hidden_gates.chunk(3, dim=1)
        reset = torch.sigmoid(input_reset + hidden_reset)
        update = torch.sigmoid(input_update + hidden_update)
        candidate = torch.tanh(input_new + reset * hidden_new)
        return candidate + update * (hidden - candidate)

    def forward(
        self,
        audio: torch.Tensor,
        embedding: torch.Tensor,
        state: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        model = self.extractor
        encoded = model.encoder(audio.unsqueeze(1)).transpose(1, 2)
        encoded = model.encoder_norm(encoded)
        gamma, beta = model.film(embedding).chunk(2, dim=1)
        encoded = encoded * (1.0 + torch.tanh(gamma).unsqueeze(1))
        encoded = encoded + beta.unsqueeze(1)

        hidden = [state[layer] for layer in range(model.num_layers)]
        recurrent_frames = []
        # O ONNX de runtime tem bloco fixo (10 ou 20 ms); o loop é desenrolado
        # na exportação e não aparece como operador GRU/Loop no navegador.
        for frame in range(encoded.shape[1]):
            layer_input = encoded[:, frame, :]
            next_hidden = []
            for layer in range(model.num_layers):
                layer_output = self._gru_layer(layer_input, hidden[layer], layer)
                next_hidden.append(layer_output)
                layer_input = layer_output
            hidden = next_hidden
            recurrent_frames.append(layer_input)

        recurrent = torch.stack(recurrent_frames, dim=1)
        decoded = model.decoder_projection(recurrent)
        decoded = model.activation(model.decoder_norm(decoded)).transpose(1, 2)
        audio_out = model.decoder(decoded).squeeze(1)
        audio_out = torch.tanh(audio_out[..., : audio.shape[-1]])
        return audio_out, torch.stack(hidden, dim=0)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1 << 20):
            digest.update(block)
    return digest.hexdigest()


def _export(
    model: torch.nn.Module,
    inputs: tuple[torch.Tensor, ...],
    path: Path,
    *,
    input_names: list[str],
    output_names: list[str],
    opset: int,
) -> None:
    torch.onnx.export(
        model,
        inputs,
        str(path),
        export_params=True,
        opset_version=opset,
        do_constant_folding=True,
        input_names=input_names,
        output_names=output_names,
        dynamo=False,
    )


def _validate_graph(
    path: Path,
    expected_inputs: list[str],
    expected_outputs: list[str],
) -> None:
    try:
        import onnx
    except ImportError as error:
        raise RuntimeError("instale a dependência 'onnx' para validar a exportação") from error
    graph = onnx.load(str(path))
    onnx.checker.check_model(graph)
    initializer_names = {initializer.name for initializer in graph.graph.initializer}
    inputs = [
        value.name for value in graph.graph.input if value.name not in initializer_names
    ]
    outputs = [value.name for value in graph.graph.output]
    if inputs != expected_inputs:
        raise RuntimeError(f"{path.name}: inputs {inputs}, esperado {expected_inputs}")
    if outputs != expected_outputs:
        raise RuntimeError(f"{path.name}: outputs {outputs}, esperado {expected_outputs}")


def _validate_runtime(
    encoder_path: Path,
    extractor_path: Path,
    enrollment_model: EnrollmentEncoder,
    extractor_model: CausalExtractor,
    enrollment_audio: torch.Tensor,
    audio: torch.Tensor,
    embedding: torch.Tensor,
    state: torch.Tensor,
) -> dict[str, float]:
    try:
        import onnxruntime as ort
    except ImportError as error:
        raise RuntimeError(
            "instale a dependência 'onnxruntime' para validar numericamente"
        ) from error
    encoder_session = ort.InferenceSession(
        str(encoder_path), providers=["CPUExecutionProvider"]
    )
    extractor_session = ort.InferenceSession(
        str(extractor_path), providers=["CPUExecutionProvider"]
    )
    with torch.inference_mode():
        torch_embedding = enrollment_model(enrollment_audio).cpu().numpy()
        torch_audio, torch_state = extractor_model(audio, embedding, state)
    ort_embedding = encoder_session.run(
        ["embedding"], {"enrollment": enrollment_audio.numpy()}
    )[0]
    ort_audio, ort_state = extractor_session.run(
        ["audio_out", "state_out"],
        {
            "audio": audio.numpy(),
            "embedding": embedding.numpy(),
            "state": state.numpy(),
        },
    )
    errors = {
        "encoder_max_abs_error": float(np.max(np.abs(torch_embedding - ort_embedding))),
        "extractor_audio_max_abs_error": float(
            np.max(np.abs(torch_audio.numpy() - ort_audio))
        ),
        "extractor_state_max_abs_error": float(
            np.max(np.abs(torch_state.numpy() - ort_state))
        ),
    }
    if max(errors.values()) > 2e-4:
        raise RuntimeError(f"paridade ONNX fora da tolerância: {errors}")
    return errors


def export_models(args: argparse.Namespace) -> dict[str, Any]:
    enrollment, extractor, payload = load_models(args.checkpoint, device="cpu")
    enrollment.eval()
    extractor.eval()
    config = payload["config"]
    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    encoder_path = output_dir / "encoder.onnx"
    extractor_path = output_dir / "extractor.onnx"
    runtime_frame_samples = int(
        getattr(args, "runtime_frame_samples", extractor.frame_samples)
    )
    if runtime_frame_samples not in (160, 320):
        raise ValueError("runtime_frame_samples deve ser 160 ou 320")

    torch.manual_seed(0)
    enrollment_audio = torch.randn(
        1, enrollment.enrollment_samples, dtype=torch.float32
    ) * 0.05
    audio = torch.randn(1, runtime_frame_samples, dtype=torch.float32) * 0.05
    embedding = torch.randn(1, extractor.embedding_dim, dtype=torch.float32)
    embedding = torch.nn.functional.normalize(embedding, dim=1)
    state = extractor.initial_state(1, device="cpu", dtype=torch.float32)

    _export(
        enrollment,
        (enrollment_audio,),
        encoder_path,
        input_names=["enrollment"],
        output_names=["embedding"],
        opset=args.opset,
    )
    use_webgpu_primitives = bool(getattr(args, "webgpu_primitives", False))
    exported_extractor = (
        WebGpuExtractor(extractor).eval() if use_webgpu_primitives else extractor
    )
    _export(
        exported_extractor,
        (audio, embedding, state),
        extractor_path,
        input_names=["audio", "embedding", "state"],
        output_names=["audio_out", "state_out"],
        opset=args.opset,
    )
    _validate_graph(encoder_path, ["enrollment"], ["embedding"])
    _validate_graph(
        extractor_path,
        ["audio", "embedding", "state"],
        ["audio_out", "state_out"],
    )
    parity: dict[str, float] | None = None
    if not args.skip_runtime_validation:
        parity = _validate_runtime(
            encoder_path,
            extractor_path,
            enrollment,
            extractor,
            enrollment_audio,
            audio,
            embedding,
            state,
        )
    metadata = {
        "format_version": 1,
        "opset": args.opset,
        "webgpu_primitives": use_webgpu_primitives,
        "sample_rate": config["audio"]["sample_rate"],
        "enrollment_samples": enrollment.enrollment_samples,
        "frame_samples": runtime_frame_samples,
        "frame_milliseconds": runtime_frame_samples
        * 1000
        / config["audio"]["sample_rate"],
        "embedding_dim": extractor.embedding_dim,
        "state_shape": [extractor.num_layers, 1, extractor.hidden_size],
        "encoder_inputs": {"enrollment": [1, enrollment.enrollment_samples]},
        "encoder_outputs": {"embedding": [1, extractor.embedding_dim]},
        "extractor_inputs": {
            "audio": [1, runtime_frame_samples],
            "embedding": [1, extractor.embedding_dim],
            "state": [extractor.num_layers, 1, extractor.hidden_size],
        },
        "extractor_outputs": {
            "audio_out": [1, runtime_frame_samples],
            "state_out": [extractor.num_layers, 1, extractor.hidden_size],
        },
        "parameters": {
            "encoder": count_parameters(enrollment),
            "extractor": count_parameters(extractor),
        },
        "config_sha256": config_digest(config),
        "files": {
            "encoder.onnx": _sha256(encoder_path),
            "extractor.onnx": _sha256(extractor_path),
        },
        "runtime_parity": parity,
    }
    (output_dir / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    manifest = {
        "schemaVersion": 1,
        "modelVersion": f"dev-{metadata['config_sha256'][:12]}",
        "productionReady": False,
        "runtime": {
            "inputSampleRate": 48_000,
            "modelSampleRate": metadata["sample_rate"],
            "frameSamples": metadata["frame_samples"],
            "enrollmentSeconds": 4,
            "embeddingSize": metadata["embedding_dim"],
            "stateShape": metadata["state_shape"],
            "preferredBackend": "wasm",
        },
        "models": {
            "encoder": {
                "url": "./encoder.onnx",
                "sha256": metadata["files"]["encoder.onnx"],
                "inputs": {
                    "audio": {
                        "name": "enrollment",
                        "shape": metadata["encoder_inputs"]["enrollment"],
                    }
                },
                "outputs": {"embedding": "embedding"},
            },
            "extractor": {
                "url": "./extractor.onnx",
                "sha256": metadata["files"]["extractor.onnx"],
                "inputs": {
                    "audio": {
                        "name": "audio",
                        "shape": metadata["extractor_inputs"]["audio"],
                    },
                    "embedding": {
                        "name": "embedding",
                        "shape": metadata["extractor_inputs"]["embedding"],
                    },
                    "state": {
                        "name": "state",
                        "shape": metadata["extractor_inputs"]["state"],
                    },
                },
                "outputs": {"audio": "audio_out", "state": "state_out"},
            },
        },
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(metadata, ensure_ascii=False, indent=2))
    return metadata


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=Path("exports"))
    parser.add_argument("--opset", type=int, default=18)
    parser.add_argument(
        "--runtime-frame-samples",
        type=int,
        choices=(160, 320),
        default=320,
        help="Agrupamento de inferência: 320 reduz overhead em celulares (20 ms).",
    )
    parser.add_argument("--skip-runtime-validation", action="store_true")
    parser.add_argument(
        "--webgpu-primitives",
        action="store_true",
        help="Desenrola a GRU em primitivas; use somente para avaliar WebGPU.",
    )
    args = parser.parse_args()
    if args.opset < 17:
        parser.error("--opset deve ser >= 17")
    return args


if __name__ == "__main__":
    export_models(parse_args())
