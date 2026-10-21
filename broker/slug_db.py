"""SQLite data layer. One table, opened per-operation — boring on purpose.

Connections are short-lived (open, do one thing, close). At this service's
scale that is far cheaper than managing a pool, and it sidesteps every
threading question. WAL mode keeps readers from blocking the odd write.
"""

from __future__ import annotations

import sqlite3
import time
from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS slugs (
    name            TEXT PRIMARY KEY,
    forge           TEXT,                -- which forge repo_id belongs to (e.g. 'github'); NULL while pending
    repo_id         INTEGER,             -- forge-native numeric repo id; NULL while pending
    status          TEXT NOT NULL CHECK (status IN ('pending', 'active', 'tombstoned')),
    claim_token     TEXT,                -- set only while pending; the right to activate the name
    expires_at      TEXT,                -- set only while pending; after it the claim occupies nothing
    created_at      TEXT NOT NULL,
    notes           TEXT,                -- free text, e.g. tombstone reason
    owner_login     TEXT                 -- while pending: the login whose claim it is
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def in_minutes_iso(minutes: int) -> str:
    """A timestamp `minutes` from now, in the same format as now_iso() — the two
    are compared lexicographically, which holds while the format is identical.
    """
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat(
        timespec="seconds"
    )


class SlugExists(Exception):
    """The name is already occupied (any status)."""


class RepoTaken(Exception):
    """The repository is already the campaign of another active name."""


class Store:
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
            # Workers start at the same time: the check and the change are
            # one write transaction, so a second worker finds the column.
            conn.execute("BEGIN IMMEDIATE")
            columns = {
                row["name"] for row in conn.execute("PRAGMA table_info(slugs)")
            }
            if "owner_login" not in columns:
                conn.execute("ALTER TABLE slugs ADD COLUMN owner_login TEXT")

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
        try:
            with conn:  # one transaction per operation
                yield conn
        finally:
            conn.close()

    @staticmethod
    def _now() -> str:
        return now_iso()

    def get(self, name: str) -> sqlite3.Row | None:
        with self._connect() as conn:
            return conn.execute(
                "SELECT * FROM slugs WHERE name = ?", (name,)
            ).fetchone()

    def drop_expired_claim(self, name: str) -> bool:
        """Remove the name's claim if it has run out, so the write that follows
        sees a free name. Call before anything that needs to occupy a name."""
        with self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM slugs WHERE name = ? AND status = 'pending'"
                " AND expires_at < ?",
                (name, self._now()),
            )
            return cur.rowcount > 0

    def create_pending(
        self, name: str, claim_token: str, expires_at: str, owner_login: str
    ) -> None:
        """Hold a name for `owner_login` presenting `claim_token`, until
        `expires_at`. Raises SlugExists if the name is occupied — the PRIMARY
        KEY is the arbiter, so two simultaneous claims cannot both succeed."""
        try:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO slugs (name, status, claim_token, expires_at,"
                    " created_at, owner_login) VALUES (?, 'pending', ?, ?, ?, ?)",
                    (name, claim_token, expires_at, self._now(), owner_login),
                )
        except sqlite3.IntegrityError:
            raise SlugExists(name) from None

    def pending_count(self, owner_login: str) -> int:
        """The claims `owner_login` holds that have not run out."""
        with self._connect() as conn:
            return conn.execute(
                "SELECT COUNT(*) FROM slugs WHERE status = 'pending'"
                " AND owner_login = ? AND expires_at >= ?",
                (owner_login, self._now()),
            ).fetchone()[0]

    def active_name_of(self, forge: str, repo_id: int) -> str | None:
        """The active name a repository is the campaign of, or None."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT name FROM slugs WHERE status = 'active'"
                " AND forge = ? AND repo_id = ?",
                (forge, repo_id),
            ).fetchone()
            return row["name"] if row else None

    # A repository is the campaign of at most one active name.
    _REPO_FREE = (
        "NOT EXISTS (SELECT 1 FROM slugs WHERE status = 'active'"
        " AND forge = ? AND repo_id = ?)"
    )

    def activate(
        self,
        name: str,
        forge: str,
        repo_id: int,
        claim_token: str | None,
        owner_login: str,
    ) -> bool:
        """Turn this name's claim into the live campaign it was held for. Returns
        False if the name has no claim of `owner_login` matching `claim_token`,
        which includes a claim that ran out and was taken over by someone else,
        or if the repository is already another name's campaign. A claim made
        before claims recorded their login matches any login."""
        if not claim_token:
            return False
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE slugs SET status = 'active', forge = ?, repo_id = ?,"
                " claim_token = NULL, expires_at = NULL, owner_login = NULL"
                " WHERE name = ? AND status = 'pending' AND claim_token = ?"
                " AND (owner_login = ? OR owner_login IS NULL)"
                " AND " + self._REPO_FREE,
                (
                    forge,
                    repo_id,
                    name,
                    claim_token,
                    owner_login,
                    forge,
                    repo_id,
                ),
            )
            return cur.rowcount > 0

    def release(self, name: str, claim_token: str, owner_login: str) -> bool:
        """Give up a claim, freeing the name. Returns False if the name is not
        held under this token by `owner_login`."""
        with self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM slugs WHERE name = ? AND status = 'pending'"
                " AND claim_token = ? AND (owner_login = ? OR owner_login IS NULL)",
                (name, claim_token, owner_login),
            )
            return cur.rowcount > 0

    def create_active(self, name: str, forge: str, repo_id: int) -> None:
        """Register a campaign slug against its (forge, repo_id) — the forge
        qualifies the id so a GitHub id never collides with a GitLab one. Raises
        SlugExists when the name is occupied and RepoTaken when the repository
        is another name's campaign, including races: the PRIMARY KEY and the
        insert's own condition are the arbiters, not a prior SELECT."""
        try:
            with self._connect() as conn:
                cur = conn.execute(
                    "INSERT INTO slugs (name, forge, repo_id, status, created_at)"
                    " SELECT ?, ?, ?, 'active', ? WHERE " + self._REPO_FREE,
                    (name, forge, repo_id, self._now(), forge, repo_id),
                )
        except sqlite3.IntegrityError:
            raise SlugExists(name) from None
        if cur.rowcount == 0:
            raise RepoTaken(name)

    def delete(self, name: str) -> bool:
        """Remove a name's row, whatever its status, so the name is free.
        Returns False if no such name exists."""
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM slugs WHERE name = ?", (name,))
            return cur.rowcount > 0

    def tombstone(self, name: str, notes: str | None) -> bool:
        """Mark a slug tombstoned, keeping the row so the name stays occupied.
        Returns False if no such slug exists."""
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE slugs SET status = 'tombstoned',"
                " notes = COALESCE(?, notes) WHERE name = ?",
                (notes, name),
            )
            return cur.rowcount > 0

    def list_all(self) -> list[sqlite3.Row]:
        with self._connect() as conn:
            return conn.execute(
                "SELECT * FROM slugs ORDER BY created_at"
            ).fetchall()
