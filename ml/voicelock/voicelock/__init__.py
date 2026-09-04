"""VoiceLock: target-speaker extraction causal treinado do zero."""

from .models import CausalExtractor, EnrollmentEncoder

__all__ = ["CausalExtractor", "EnrollmentEncoder"]
__version__ = "0.1.0"
