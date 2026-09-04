"""CLI fina para construir um manifest com licença obrigatória."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from voicelock.manifest import build_cli  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(build_cli())
