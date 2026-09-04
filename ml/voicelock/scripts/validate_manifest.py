"""CLI fina para validar schema, áudio, licença e hashes do manifest."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from voicelock.manifest import validate_cli  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(validate_cli())
