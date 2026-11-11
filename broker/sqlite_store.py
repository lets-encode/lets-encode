"""Base for the broker's SQLite stores: one file in WAL mode, a connection
opened per operation and closed after it.
"""

from __future__ import annotations

import sqlite3
import time
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Callable, Iterator


class SqliteStore:
    # Set on each connection when not None, e.g. sqlite3.Row.
    row_factory: Callable | None = None

    def __init__(self, db_path: str):
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        # WAL mode stays with the file. Setting it on a new file needs a lock
        # that a worker opening the file at the same moment can hold, and the
        # busy timeout does not wait for it, so the change is tried again.
        for attempt in range(50):
            try:
                with closing(sqlite3.connect(db_path)) as conn:
                    conn.execute("PRAGMA journal_mode=WAL")
                break
            except sqlite3.OperationalError:
                if attempt == 49:
                    raise
                time.sleep(0.1)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path)
        if self.row_factory is not None:
            conn.row_factory = self.row_factory
        conn.execute("PRAGMA busy_timeout=5000")
        try:
            with conn:  # one transaction per operation
                yield conn
        finally:
            conn.close()
