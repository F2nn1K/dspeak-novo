#!/usr/bin/env python3
"""Baixa um baseline CC BY 4.0 e cria manifests reproduzíveis."""

from __future__ import annotations

import argparse
import hashlib
import tarfile
import urllib.request
from pathlib import Path

from voicelock.manifest import build_manifest


SPLITS = {
    "train-clean-100": {
        "sha256": "d4ddd1d5a6ab303066f14971d768ee43278a5f2a0aa43dc716b0e64ecbbbf6e2",
        "split": "train",
    },
    "train-clean-360": {
        "sha256": "146a56496217e96c14334a160df97fffedd6e0a04e66b9c5af0d40be3c792ecf",
        "split": "train",
    },
    "dev-clean": {
        "sha256": "76f87d090650617fca0cac8f88b9416e0ebf80350acb97b343a85fa903728ab3",
        "split": "validation",
    },
    "test-clean": {
        "sha256": "39fde525e59672dc6d1551919b1478f724438a95aa55f874b576be21967e6c23",
        "split": "test",
    },
}
BASE_URL = "https://www.openslr.org/resources/12"
LICENSE_URL = "https://www.openslr.org/12"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1 << 20):
            digest.update(block)
    return digest.hexdigest()


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    with urllib.request.urlopen(url) as response, partial.open("wb") as output:
        total = int(response.headers.get("Content-Length", 0))
        written = 0
        while block := response.read(1 << 20):
            output.write(block)
            written += len(block)
            if total:
                print(f"\r{destination.name}: {written * 100 / total:5.1f}%", end="")
    print()
    partial.replace(destination)


def safe_extract(archive: Path, destination: Path) -> None:
    root = destination.resolve()
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle.getmembers():
            if member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                raise RuntimeError(f"tipo de entrada não permitido no tar: {member.name}")
            target = (destination / member.name).resolve()
            if root not in target.parents and target != root:
                raise RuntimeError(f"entrada insegura no tar: {member.name}")
        bundle.extractall(destination)


def prepare_split(name: str, data_dir: Path, manifest_dir: Path) -> Path:
    info = SPLITS[name]
    archive = data_dir / "archives" / f"{name}.tar.gz"
    url = f"{BASE_URL}/{name}.tar.gz"
    if not archive.exists() or sha256(archive) != info["sha256"]:
        download(url, archive)
    actual = sha256(archive)
    if actual != info["sha256"]:
        raise RuntimeError(f"{name}: SHA-256 divergente ({actual})")

    extracted = data_dir / "LibriSpeech" / name
    if not extracted.exists():
        safe_extract(archive, data_dir)
    manifest_dir.mkdir(parents=True, exist_ok=True)
    output = manifest_dir / f"{name}.jsonl"
    summary = build_manifest(
        root=extracted,
        output=output,
        kind="speech",
        split=info["split"],
        dataset_name=f"LibriSpeech {name}",
        source_url=url,
        license_id="CC-BY-4.0",
        license_name="Creative Commons Attribution 4.0 International",
        license_url=LICENSE_URL,
        license_attribution="OpenSLR LibriSpeech corpus; Panayotov et al.",
    )
    print(name, summary)
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path("data/librispeech"))
    parser.add_argument("--manifest-dir", type=Path, default=Path("manifests"))
    parser.add_argument(
        "--splits",
        nargs="+",
        choices=tuple(SPLITS),
        default=["train-clean-100", "train-clean-360", "dev-clean", "test-clean"],
    )
    args = parser.parse_args()
    grouped: dict[str, list[Path]] = {}
    for split in args.splits:
        manifest = prepare_split(split, args.data_dir, args.manifest_dir)
        grouped.setdefault(SPLITS[split]["split"], []).append(manifest)
    for split, manifests in grouped.items():
        destination = args.manifest_dir / f"{split}.jsonl"
        with destination.open("w", encoding="utf-8", newline="\n") as output:
            for manifest in manifests:
                output.write(manifest.read_text(encoding="utf-8"))
        print(f"{split}: {len(manifests)} manifest(s) combinados em {destination}")


if __name__ == "__main__":
    main()
