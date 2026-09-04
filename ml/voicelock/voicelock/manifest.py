"""Manifest JSONL versionado, portátil e com proveniência obrigatória."""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from .audio import probe_audio, sha256_file

SCHEMA_VERSION = 1
SUPPORTED_EXTENSIONS = {".wav", ".flac", ".ogg"}
LICENSE_FIELDS = ("id", "name", "url", "attribution")
DATASET_FIELDS = ("name", "source_url")


class ManifestError(ValueError):
    pass


def _nonempty_string(value: Any, field: str, line_number: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ManifestError(f"linha {line_number}: {field} deve ser texto não vazio")
    return value.strip()


def validate_record(record: Any, line_number: int) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise ManifestError(f"linha {line_number}: cada linha deve ser um objeto JSON")
    if record.get("schema_version") != SCHEMA_VERSION:
        raise ManifestError(
            f"linha {line_number}: schema_version deve ser {SCHEMA_VERSION}"
        )
    for field in ("audio_path", "speaker_id", "kind", "split", "sha256"):
        _nonempty_string(record.get(field), field, line_number)
    if record["kind"] not in {"speech", "noise"}:
        raise ManifestError(f"linha {line_number}: kind deve ser speech ou noise")
    if record["kind"] == "noise" and record["speaker_id"] != "__noise__":
        raise ManifestError(
            f"linha {line_number}: ruído deve usar speaker_id='__noise__'"
        )
    if record.get("sample_rate") != 16_000:
        raise ManifestError(f"linha {line_number}: sample_rate deve ser 16000")
    if record.get("channels") != 1:
        raise ManifestError(f"linha {line_number}: channels deve ser 1")
    if not isinstance(record.get("num_samples"), int) or record["num_samples"] <= 0:
        raise ManifestError(f"linha {line_number}: num_samples deve ser inteiro positivo")
    duration = record.get("duration_seconds")
    if not isinstance(duration, (int, float)) or duration <= 0:
        raise ManifestError(f"linha {line_number}: duration_seconds deve ser positivo")
    expected_duration = record["num_samples"] / record["sample_rate"]
    if abs(float(duration) - expected_duration) > 1.0 / record["sample_rate"]:
        raise ManifestError(
            f"linha {line_number}: duration_seconds diverge de num_samples"
        )
    digest = record["sha256"]
    if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        raise ManifestError(f"linha {line_number}: sha256 inválido")

    license_data = record.get("license")
    if not isinstance(license_data, dict):
        raise ManifestError(f"linha {line_number}: objeto license é obrigatório")
    for field in LICENSE_FIELDS:
        _nonempty_string(license_data.get(field), f"license.{field}", line_number)

    dataset_data = record.get("dataset")
    if not isinstance(dataset_data, dict):
        raise ManifestError(f"linha {line_number}: objeto dataset é obrigatório")
    for field in DATASET_FIELDS:
        _nonempty_string(dataset_data.get(field), f"dataset.{field}", line_number)
    return record


def resolve_audio_path(manifest_path: str | Path, audio_path: str) -> Path:
    path = Path(audio_path)
    if not path.is_absolute():
        path = Path(manifest_path).resolve().parent / path
    return path.resolve()


def load_manifest(
    manifest_path: str | Path,
    *,
    expected_kind: str | None = None,
) -> list[dict[str, Any]]:
    path = Path(manifest_path)
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, raw_line in enumerate(handle, 1):
            if not raw_line.strip():
                continue
            try:
                record = json.loads(raw_line)
            except json.JSONDecodeError as error:
                raise ManifestError(
                    f"linha {line_number}: JSON inválido: {error.msg}"
                ) from error
            validate_record(record, line_number)
            if expected_kind is not None and record["kind"] != expected_kind:
                raise ManifestError(
                    f"linha {line_number}: esperado kind={expected_kind}, "
                    f"encontrado {record['kind']}"
                )
            record = dict(record)
            record["_resolved_path"] = str(resolve_audio_path(path, record["audio_path"]))
            records.append(record)
    if not records:
        raise ManifestError(f"{path}: manifest vazio")
    return records


def validate_manifest_file(
    manifest_path: str | Path,
    *,
    check_audio: bool = True,
    verify_hashes: bool = False,
) -> dict[str, Any]:
    records = load_manifest(manifest_path)
    seen_paths: set[Path] = set()
    speakers: Counter[str] = Counter()
    kinds: Counter[str] = Counter()
    total_seconds = 0.0

    for index, record in enumerate(records, 1):
        audio_path = Path(record["_resolved_path"])
        if audio_path in seen_paths:
            raise ManifestError(f"linha {index}: audio_path duplicado: {audio_path}")
        seen_paths.add(audio_path)
        speakers[record["speaker_id"]] += 1
        kinds[record["kind"]] += 1
        total_seconds += float(record["duration_seconds"])
        if check_audio:
            if not audio_path.is_file():
                raise ManifestError(f"linha {index}: arquivo não encontrado: {audio_path}")
            metadata = probe_audio(audio_path)
            expected = (
                record["sample_rate"],
                record["channels"],
                record["num_samples"],
            )
            actual = (metadata.sample_rate, metadata.channels, metadata.num_samples)
            if actual != expected:
                raise ManifestError(
                    f"linha {index}: cabeçalho mudou; manifest={expected}, arquivo={actual}"
                )
            if verify_hashes and sha256_file(audio_path) != record["sha256"]:
                raise ManifestError(f"linha {index}: SHA-256 divergente: {audio_path}")

    speech_speakers = {
        speaker
        for speaker in speakers
        if speaker != "__noise__"
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "records": len(records),
        "speech_speakers": len(speech_speakers),
        "kinds": dict(sorted(kinds.items())),
        "hours": total_seconds / 3600.0,
    }


def _iter_audio_files(root: Path) -> Iterable[Path]:
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS
    )


def build_manifest(
    *,
    root: str | Path,
    output: str | Path,
    kind: str,
    split: str,
    dataset_name: str,
    source_url: str,
    license_id: str,
    license_name: str,
    license_url: str,
    license_attribution: str,
) -> dict[str, Any]:
    if kind not in {"speech", "noise"}:
        raise ValueError("kind deve ser speech ou noise")
    root_path = Path(root).resolve()
    output_path = Path(output).resolve()
    if not root_path.is_dir():
        raise FileNotFoundError(f"diretório não encontrado: {root_path}")

    files = list(_iter_audio_files(root_path))
    if not files:
        raise ManifestError(f"nenhum áudio suportado em {root_path}")
    records: list[dict[str, Any]] = []
    for audio_path in files:
        relative_to_root = audio_path.relative_to(root_path)
        if kind == "speech":
            if len(relative_to_root.parts) < 2:
                raise ManifestError(
                    "para speech, use root/<speaker_id>/**/<arquivo>; "
                    f"arquivo sem speaker_id: {audio_path}"
                )
            speaker_id = relative_to_root.parts[0]
        else:
            speaker_id = "__noise__"
        metadata = probe_audio(audio_path)
        if metadata.sample_rate != 16_000 or metadata.channels != 1:
            raise ManifestError(
                f"{audio_path}: esperado mono/16000 Hz, encontrado "
                f"{metadata.channels} canal(is)/{metadata.sample_rate} Hz"
            )
        portable_path = Path(
            os.path.relpath(audio_path, start=output_path.parent)
        ).as_posix()
        record = {
            "schema_version": SCHEMA_VERSION,
            "audio_path": portable_path,
            "speaker_id": speaker_id,
            "kind": kind,
            "split": split,
            "sample_rate": metadata.sample_rate,
            "channels": metadata.channels,
            "num_samples": metadata.num_samples,
            "duration_seconds": metadata.duration_seconds,
            "sha256": sha256_file(audio_path),
            "dataset": {"name": dataset_name, "source_url": source_url},
            "license": {
                "id": license_id,
                "name": license_name,
                "url": license_url,
                "attribution": license_attribution,
            },
        }
        validate_record(record, len(records) + 1)
        records.append(record)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_suffix(output_path.suffix + ".tmp")
    with temporary_path.open("w", encoding="utf-8", newline="\n") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    temporary_path.replace(output_path)
    return validate_manifest_file(output_path, check_audio=True, verify_hashes=False)


def _add_license_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--dataset-name", required=True)
    parser.add_argument("--source-url", required=True)
    parser.add_argument("--license-id", required=True)
    parser.add_argument("--license-name", required=True)
    parser.add_argument("--license-url", required=True)
    parser.add_argument("--license-attribution", required=True)


def build_cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Constrói manifest VoiceLock JSONL")
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--kind", choices=("speech", "noise"), required=True)
    parser.add_argument("--split", required=True)
    _add_license_arguments(parser)
    args = parser.parse_args(argv)
    summary = build_manifest(**vars(args))
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def validate_cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Valida manifest VoiceLock JSONL")
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--skip-audio", action="store_true")
    parser.add_argument("--verify-hashes", action="store_true")
    args = parser.parse_args(argv)
    summary = validate_manifest_file(
        args.manifest,
        check_audio=not args.skip_audio,
        verify_hashes=args.verify_hashes,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0
