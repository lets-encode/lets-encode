"""SQLite data layer for the relays in app.py: what each login has used per
UTC day, and which login created each Musibot page and started each execution
on it. Connections are opened per operation, as in slug_db.py.
"""

from __future__ import annotations

import sqlite3
import time
from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS relay_use (
    login       TEXT NOT NULL,
    day         TEXT NOT NULL,          -- UTC date, YYYY-MM-DD
    kind        TEXT NOT NULL,          -- what is counted, e.g. iiif_bytes
    amount      INTEGER NOT NULL,
    PRIMARY KEY (login, day, kind)
);
CREATE TABLE IF NOT EXISTS omr_pages (
    page_id     TEXT PRIMARY KEY,
    login       TEXT NOT NULL,          -- the login that created the page
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS omr_executions (
    page_id     TEXT NOT NULL,
    execution_id INTEGER NOT NULL,
    PRIMARY KEY (page_id, execution_id)
);
"""

# Musibot pages live minutes; a page's record is dropped this long after it
# was created.
PAGE_RECORD_LIFETIME = timedelta(days=1)


def today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def seconds_to_next_day() -> int:
    """Seconds until the next UTC midnight, when the day's counts start over."""
    now = datetime.now(timezone.utc)
    midnight = datetime.combine(
        now.date() + timedelta(days=1), datetime.min.time(), timezone.utc
    )
    return max(1, int((midnight - now).total_seconds()))


class RelayStore:
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
        with self._connect() as conn:
            conn.executescript(SCHEMA)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path)
        conn.execute("PRAGMA busy_timeout=5000")
        try:
            with conn:  # one transaction per operation
                yield conn
        finally:
            conn.close()

    def used(self, login: str, kind: str) -> int:
        """What `login` has used of `kind` today."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT amount FROM relay_use WHERE login = ? AND day = ?"
                " AND kind = ?",
                (login, today(), kind),
            ).fetchone()
            return row[0] if row else 0

    def add(self, login: str, kind: str, amount: int) -> None:
        """Count `amount` of `kind` against `login` for today."""
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO relay_use (login, day, kind, amount)"
                " VALUES (?, ?, ?, ?) ON CONFLICT (login, day, kind)"
                " DO UPDATE SET amount = amount + excluded.amount",
                (login, today(), kind, amount),
            )

    def add_page(self, page_id: str, login: str) -> None:
        """Record `login` as the creator of a new page, replacing any record
        of an earlier page with the same id, and drop the records that have
        outlived PAGE_RECORD_LIFETIME."""
        now = datetime.now(timezone.utc)
        cutoff = (now - PAGE_RECORD_LIFETIME).isoformat(timespec="seconds")
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM omr_pages WHERE created_at < ?", (cutoff,)
            )
            conn.execute(
                "DELETE FROM omr_executions WHERE page_id = ? OR page_id NOT IN"
                " (SELECT page_id FROM omr_pages)",
                (page_id,),
            )
            conn.execute(
                "INSERT OR REPLACE INTO omr_pages (page_id, login, created_at)"
                " VALUES (?, ?, ?)",
                (page_id, login, now.isoformat(timespec="seconds")),
            )

    def page_creator(self, page_id: str) -> str | None:
        """The login that created the page, or None for a page not recorded."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT login FROM omr_pages WHERE page_id = ?", (page_id,)
            ).fetchone()
            return row[0] if row else None

    def add_execution(self, page_id: str, execution_id: int) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO omr_executions (page_id, execution_id)"
                " VALUES (?, ?)",
                (page_id, execution_id),
            )

    def has_execution(self, page_id: str, execution_id: int) -> bool:
        """Whether the execution was started on the page through the relay."""
        with self._connect() as conn:
            return (
                conn.execute(
                    "SELECT 1 FROM omr_executions WHERE page_id = ?"
                    " AND execution_id = ?",
                    (page_id, execution_id),
                ).fetchone()
                is not None
            )
