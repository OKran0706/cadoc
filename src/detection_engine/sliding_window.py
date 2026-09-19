# canary-system/src/detection_engine/sliding_window.py
# Derived from: detection-engine/SKILL.md — Sliding Window Engine
"""
Thread-safe sliding window counter for behavioral (Tier 2) detection rules.
"""

from collections import defaultdict, deque
from datetime import datetime, timedelta
import threading


class SlidingWindowCounter:
    """Thread-safe sliding window counter per (host, actor) pair."""

    def __init__(self, window_seconds: int, threshold: int):
        self.window = timedelta(seconds=window_seconds)
        self.threshold = threshold
        self._events = defaultdict(deque)  # key → deque of timestamps
        self._lock = threading.Lock()

    def add(self, key: str) -> bool:
        """Add an event and return True if threshold exceeded."""
        now = datetime.utcnow()
        with self._lock:
            q = self._events[key]
            q.append(now)
            # Evict events outside the window
            while q and (now - q[0]) > self.window:
                q.popleft()
            return len(q) >= self.threshold

    def count(self, key: str) -> int:
        """Get current count for a key within the window."""
        now = datetime.utcnow()
        with self._lock:
            q = self._events[key]
            while q and (now - q[0]) > self.window:
                q.popleft()
            return len(q)

    def reset(self, key: str):
        """Reset counter for a key."""
        with self._lock:
            self._events.pop(key, None)

    def cleanup(self):
        """Remove expired entries to prevent memory growth."""
        now = datetime.utcnow()
        with self._lock:
            expired_keys = []
            for key, q in self._events.items():
                while q and (now - q[0]) > self.window:
                    q.popleft()
                if not q:
                    expired_keys.append(key)
            for key in expired_keys:
                del self._events[key]
