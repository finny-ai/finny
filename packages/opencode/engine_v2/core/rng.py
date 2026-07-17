"""Seeded RNG. Seed echoed in results.json for reproducibility."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Optional

import numpy as np


def derive_seed(config: Any, start: str, end: str, interval: str) -> int:
    payload = json.dumps(
        {"cfg": config, "start": start, "end": end, "interval": interval},
        sort_keys=True,
        default=str,
    ).encode()
    h = hashlib.blake2b(payload, digest_size=8).digest()
    return int.from_bytes(h, "big", signed=False) & 0x7FFFFFFF


def make_rng(seed: Optional[int]) -> np.random.Generator:
    return np.random.default_rng(0 if seed is None else int(seed))
