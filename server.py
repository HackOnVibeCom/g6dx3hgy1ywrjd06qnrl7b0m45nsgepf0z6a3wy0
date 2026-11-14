#!/usr/bin/env python3
"""InBudget round server.

Serves the static site in dist/ and a small JSON API for rounds a group can
share. Rounds and anonymous per-traveler answers are stored in SQLite.
"""

import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import closing
from datetime import date, datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist")
DATA = os.path.join(ROOT, "data")
DB_PATH = os.environ.get("INBUDGET_DB") or os.path.join(DATA, "inbudget.sqlite3")
MAX_BODY = 64 * 1024
ID_RE = re.compile(r"^[A-Za-z0-9_-]{12,40}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
URL_RE = re.compile(r"^https?://", re.I)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY,
    host_key TEXT NOT NULL,
    title TEXT NOT NULL,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    payers INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
    round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    total INTEGER NOT NULL,
    url TEXT NOT NULL,
    checked TEXT,
    PRIMARY KEY (round_id, position)
);
CREATE TABLE IF NOT EXISTS responses (
    round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    traveler TEXT NOT NULL,
    limit_cents INTEGER NOT NULL,
    choices TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    name TEXT,
    PRIMARY KEY (round_id, traveler)
);
CREATE INDEX IF NOT EXISTS rounds_created ON rounds(created_at);
"""


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def connect():
    os.makedirs(os.path.dirname(DB_PATH) or DATA, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("PRAGMA foreign_keys = ON")
    return db


def init():
    with closing(connect()) as db:
        db.executescript(SCHEMA)
        columns = {row[1] for row in db.execute("PRAGMA table_info(responses)")}
        if "name" not in columns:
            db.execute("ALTER TABLE responses ADD COLUMN name TEXT")


def share_ceiling(total, payers):
    return total // payers + (1 if total % payers else 0)


def clean_name(value):
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ApiError(400, "name must be text.")
    value = " ".join(value.split())
    if not value:
        return None
    if len(value) > 40:
        raise ApiError(400, "name must be 40 characters or fewer.")
    return value


def clean_text(value, field, limit):
    if not isinstance(value, str):
        raise ApiError(400, f"{field} is required.")
    value = value.strip()
    if not value or len(value) > limit:
        raise ApiError(400, f"{field} must be between 1 and {limit} characters.")
    return value


def clean_date(value, field):
    if not isinstance(value, str) or not DATE_RE.fullmatch(value):
        raise ApiError(400, f"{field} must be a YYYY-MM-DD date.")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise ApiError(400, f"{field} must be a real date.")
    return value


def clean_checked(value):
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ApiError(400, "checked must be an ISO timestamp.")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ApiError(400, "checked must be an ISO timestamp.")
    return value


def clean_round(payload):
    if not isinstance(payload, dict):
        raise ApiError(400, "Send a JSON object.")
    title = clean_text(payload.get("title"), "title", 80)
    start = clean_date(payload.get("start"), "start")
    end = clean_date(payload.get("end"), "end")
    if end <= start:
        raise ApiError(400, "Check-out must be after check-in.")
    payers = payload.get("payers")
    if isinstance(payers, bool) or not isinstance(payers, int) or not 3 <= payers <= 8:
        raise ApiError(400, "payers must be a whole number from 3 to 8.")
    quotes = payload.get("quotes")
    if not isinstance(quotes, list) or not 1 <= len(quotes) <= 3:
        raise ApiError(400, "Add between one and three quotes.")
    cleaned = []
    for index, quote in enumerate(quotes, 1):
        if not isinstance(quote, dict):
            raise ApiError(400, f"Quote {index} is invalid.")
        name = clean_text(quote.get("name"), f"Quote {index} name", 70)
        total = quote.get("total")
        if isinstance(total, bool) or not isinstance(total, int) or not 1 <= total <= 99_999_900:
            raise ApiError(400, f"Quote {index} total must be a positive amount.")
        url = quote.get("url")
        if not isinstance(url, str) or not URL_RE.match(url) or len(url) > 500:
            raise ApiError(400, f"Quote {index} needs an http or https listing link.")
        cleaned.append({
            "name": name,
            "total": total,
            "url": url,
            "checked": clean_checked(quote.get("checked")),
        })
    return {"title": title, "start": start, "end": end, "payers": payers, "quotes": cleaned}


def round_payload(db, round_id):
    if not isinstance(round_id, str) or not ID_RE.fullmatch(round_id):
        raise ApiError(404, "That round does not exist.")
    row = db.execute("SELECT * FROM rounds WHERE id = ?", (round_id,)).fetchone()
    if row is None:
        raise ApiError(404, "That round does not exist.")
    quotes = db.execute(
        "SELECT name, total, url, checked FROM quotes WHERE round_id = ? ORDER BY position",
        (round_id,),
    ).fetchall()
    responses = db.execute(
        "SELECT choices FROM responses WHERE round_id = ?", (round_id,)
    ).fetchall()
    names = db.execute(
        "SELECT name FROM responses WHERE round_id = ? AND name IS NOT NULL ORDER BY name COLLATE NOCASE",
        (round_id,),
    ).fetchall()
    count = len(responses)
    results = None
    if count == row["payers"]:
        choices = [json.loads(response["choices"]) for response in responses]
        results = [all(choice[index] for choice in choices) for index in range(len(quotes))]
    return {
        "id": row["id"],
        "title": row["title"],
        "start": row["start"],
        "end": row["end"],
        "payers": row["payers"],
        "quotes": [dict(quote) for quote in quotes],
        "responseCount": count,
        "names": [name["name"] for name in names],
        "results": results,
    }


def create_round(db, payload):
    data = clean_round(payload)
    round_id = secrets.token_urlsafe(12)
    host_key = secrets.token_urlsafe(24)
    with db:
        db.execute(
            "INSERT INTO rounds (id, host_key, title, start, end, payers, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (round_id, host_key, data["title"], data["start"], data["end"], data["payers"], int(time.time())),
        )
        db.executemany(
            "INSERT INTO quotes (round_id, position, name, total, url, checked) VALUES (?, ?, ?, ?, ?, ?)",
            [
                (round_id, index, quote["name"], quote["total"], quote["url"], quote["checked"])
                for index, quote in enumerate(data["quotes"])
            ],
        )
    return 201, {"id": round_id, "hostKey": host_key, "round": round_payload(db, round_id)}


def add_response(db, round_id, payload):
    round_payload(db, round_id)
    if not isinstance(payload, dict):
        raise ApiError(400, "Send a JSON object.")
    traveler = payload.get("traveler")
    if not isinstance(traveler, str) or not TOKEN_RE.fullmatch(traveler):
        raise ApiError(400, "traveler must be an anonymous token.")
    limit = payload.get("limit")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 0 <= limit <= 99_999_900:
        raise ApiError(400, "limit must be a dollar amount in cents.")
    name = clean_name(payload.get("name"))
    db.execute("BEGIN IMMEDIATE")
    try:
        row = db.execute("SELECT payers FROM rounds WHERE id = ?", (round_id,)).fetchone()
        payers = row["payers"]
        quotes = db.execute(
            "SELECT total FROM quotes WHERE round_id = ? ORDER BY position", (round_id,)
        ).fetchall()
        choices = [share_ceiling(quote["total"], payers) <= limit for quote in quotes]
        existing = db.execute(
            "SELECT 1 FROM responses WHERE round_id = ? AND traveler = ?", (round_id, traveler)
        ).fetchone()
        count = db.execute(
            "SELECT COUNT(*) FROM responses WHERE round_id = ?", (round_id,)
        ).fetchone()[0]
        if existing is None and count >= payers:
            raise ApiError(409, "This round already has all of its responses.")
        db.execute(
            "INSERT INTO responses (round_id, traveler, limit_cents, choices, created_at, name) "
            "VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(round_id, traveler) DO UPDATE SET "
            "limit_cents = excluded.limit_cents, choices = excluded.choices, "
            "created_at = excluded.created_at, name = excluded.name",
            (round_id, traveler, limit, json.dumps(choices), int(time.time()), name),
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return 200, {"round": round_payload(db, round_id)}


def reset_responses(db, round_id, host_key):
    if not isinstance(round_id, str) or not ID_RE.fullmatch(round_id):
        raise ApiError(404, "That round does not exist.")
    row = db.execute("SELECT host_key FROM rounds WHERE id = ?", (round_id,)).fetchone()
    if row is None:
        raise ApiError(404, "That round does not exist.")
    if not host_key or not secrets.compare_digest(row["host_key"], host_key):
        raise ApiError(403, "Only the host can reset this round.")
    with db:
        db.execute("DELETE FROM responses WHERE round_id = ?", (round_id,))
    return 200, {"round": round_payload(db, round_id)}


def delete_round(db, round_id, host_key):
    if not isinstance(round_id, str) or not ID_RE.fullmatch(round_id):
        raise ApiError(404, "That round does not exist.")
    row = db.execute("SELECT host_key FROM rounds WHERE id = ?", (round_id,)).fetchone()
    if row is None:
        raise ApiError(404, "That round does not exist.")
    if not host_key or not secrets.compare_digest(row["host_key"], host_key):
        raise ApiError(403, "Only the host can delete this round.")
    with db:
        db.execute("DELETE FROM rounds WHERE id = ?", (round_id,))
    return 200, {"deleted": True, "id": round_id}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIST, **kwargs)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        path = urlparse(self.path).path
        if path.startswith(("/vendor/", "/assets/")):
            self.send_header("Cache-Control", "public, max-age=86400")
        super().end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def error_json(self, error):
        self.send_json(error.status, {"error": error.message})

    def read_json(self):
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            raise ApiError(400, "Invalid request length.")
        if length > MAX_BODY:
            raise ApiError(413, "That request is too large.")
        if length <= 0:
            raise ApiError(400, "Send a JSON object.")
        try:
            return json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ApiError(400, "Send valid JSON.")

    def route(self):
        return urlparse(self.path).path.rstrip("/") or "/"

    def do_GET(self):
        route = self.route()
        if route == "/api/health":
            try:
                with closing(connect()) as db:
                    db.execute("SELECT 1").fetchone()
            except sqlite3.Error:
                return self.send_json(503, {"ok": False})
            return self.send_json(200, {"ok": True})
        match = re.fullmatch(r"/api/rounds/([A-Za-z0-9_-]+)", route)
        if match:
            with closing(connect()) as db:
                try:
                    return self.send_json(200, round_payload(db, match.group(1)))
                except ApiError as error:
                    return self.error_json(error)
        if route.startswith("/api/"):
            return self.send_json(404, {"error": "Not found."})
        return super().do_GET()

    def do_POST(self):
        route = self.route()
        if not route.startswith("/api/"):
            return self.send_error(405)
        with closing(connect()) as db:
            try:
                if route == "/api/rounds":
                    return self.send_json(*create_round(db, self.read_json()))
                match = re.fullmatch(r"/api/rounds/([A-Za-z0-9_-]+)/responses", route)
                if match:
                    return self.send_json(*add_response(db, match.group(1), self.read_json()))
                raise ApiError(404, "Not found.")
            except ApiError as error:
                return self.error_json(error)

    def do_DELETE(self):
        route = self.route()
        if not route.startswith("/api/"):
            return self.send_error(405)
        responses_match = re.fullmatch(r"/api/rounds/([A-Za-z0-9_-]+)/responses", route)
        round_match = re.fullmatch(r"/api/rounds/([A-Za-z0-9_-]+)", route)
        with closing(connect()) as db:
            try:
                if responses_match:
                    return self.send_json(*reset_responses(db, responses_match.group(1), self.headers.get("x-host-key")))
                if round_match:
                    return self.send_json(*delete_round(db, round_match.group(1), self.headers.get("x-host-key")))
                raise ApiError(404, "Not found.")
            except ApiError as error:
                return self.error_json(error)


def main():
    init()
    port = int(os.environ.get("PORT") or "8000")
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"InBudget running at http://127.0.0.1:{server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
