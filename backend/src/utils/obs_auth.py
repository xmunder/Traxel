from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import secrets
from threading import Lock

from src.config import get_settings


@dataclass(slots=True, frozen=True)
class Session:
    expires_at: datetime
    created_at: datetime


class SessionStore:
    """Bounded process-local store for opaque sessions; not horizontally scalable.

    Multi-process deployments must replace this with a shared session backend.
    When full, creation evicts the soonest-expiring session; creation time and
    token are deterministic tie-breakers. This is intentional single-process
    behavior, not a distributed session policy.
    """

    def __init__(self, max_sessions: int | None = None) -> None:
        self._sessions: dict[str, Session] = {}
        self._lock = Lock()
        self._max_sessions = max_sessions

    def create(self, ttl_seconds: int) -> str:
        token = secrets.token_urlsafe(32)
        now = datetime.now(timezone.utc)
        with self._lock:
            for existing_token, session in tuple(self._sessions.items()):
                if session.expires_at <= now:
                    del self._sessions[existing_token]
            max_sessions = self._max_sessions
            if max_sessions is None:
                max_sessions = get_settings().obs_session_max_sessions
            if len(self._sessions) >= max_sessions:
                evicted_token = min(
                    self._sessions,
                    key=lambda existing_token: (
                        self._sessions[existing_token].expires_at,
                        self._sessions[existing_token].created_at,
                        existing_token,
                    ),
                )
                del self._sessions[evicted_token]
            self._sessions[token] = Session(
                expires_at=now + timedelta(seconds=ttl_seconds),
                created_at=now,
            )
        return token

    def valid(self, token: str | None) -> bool:
        if not token:
            return False
        now = datetime.now(timezone.utc)
        with self._lock:
            session = self._sessions.get(token)
            if session is None:
                return False
            if session.expires_at <= now:
                del self._sessions[token]
                return False
            return True

    def invalidate(self, token: str | None) -> None:
        if token:
            with self._lock:
                self._sessions.pop(token, None)


session_store = SessionStore()
