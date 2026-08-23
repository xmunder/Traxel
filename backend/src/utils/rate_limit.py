from __future__ import annotations

from collections import OrderedDict
from threading import Lock
from time import monotonic


class RateLimiter:
    """Bounded process-local fixed-window limiter for sensitive endpoints."""

    def __init__(self, max_keys: int = 10_000) -> None:
        self._requests: OrderedDict[tuple[str, str], list[float]] = OrderedDict()
        self._max_keys = max_keys
        self._lock = Lock()

    def allow(self, key: str, bucket: str, limit: int, window_seconds: float) -> bool:
        now = monotonic()
        cutoff = now - window_seconds
        request_key = (bucket, key)
        with self._lock:
            timestamps = self._requests.get(request_key)
            if timestamps is None:
                while len(self._requests) >= self._max_keys:
                    self._requests.popitem(last=False)
                timestamps = []
                self._requests[request_key] = timestamps
            else:
                self._requests.move_to_end(request_key)
            timestamps[:] = [timestamp for timestamp in timestamps if timestamp > cutoff]
            if not timestamps:
                del self._requests[request_key]
                timestamps = []
                self._requests[request_key] = timestamps
            if len(timestamps) >= limit:
                return False
            timestamps.append(now)
            return True
