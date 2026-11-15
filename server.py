#!/usr/bin/env python3
"""InBudget round server.

Serves the static site in dist/ and a small JSON API for rounds a group can
share. Rounds and per-traveler choices use SQLite locally or Postgres on Vercel.
"""

import json
import math
import os
import re
import secrets
import sqlite3
import time
from contextlib import closing
from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist")
DATA = os.path.join(ROOT, "data")
DB_PATH = os.environ.get("INBUDGET_DB") or os.path.join(DATA, "inbudget.sqlite3")
MAX_BODY = 64 * 1024
ID_RE = re.compile(r"^[A-Za-z0-9_-]{12,40}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
URL_RE = re.compile(r"^https?://", re.I)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
STAYING_SEARCH_URL = "https://api.stayingapi.com/v1/search"
STAYING_JOBS_URL = "https://api.stayingapi.com/v1/jobs"
PHOTON_URL = os.environ.get("INBUDGET_PHOTON_URL", "https://photon.komoot.io").rstrip("/")
LODGING_TAGS = ("hotel", "motel", "guest_house", "chalet", "apartment", "hostel")
SANDBOX_CENTER = (43.735, 15.895)
SAVED_STAYING_BACKUP = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY,
    host_key TEXT NOT NULL,
    title TEXT NOT NULL,
    start TEXT NOT NULL,
    "end" TEXT NOT NULL,
    payers INTEGER NOT NULL,
    destination TEXT,
    radius INTEGER,
    previous_round_id TEXT REFERENCES rounds(id) ON DELETE SET NULL,
    superseded_at BIGINT,
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
    choices TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    name TEXT,
    PRIMARY KEY (round_id, traveler)
);
CREATE INDEX IF NOT EXISTS rounds_created ON rounds(created_at);
CREATE TABLE IF NOT EXISTS search_budget (
    name TEXT PRIMARY KEY,
    minute BIGINT NOT NULL,
    count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS round_events (
    day TEXT NOT NULL,
    event TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY(day, event)
);
"""
ROUND_COLUMNS = (
    ("destination", "TEXT"), ("radius", "INTEGER"),
    ("previous_round_id", "TEXT REFERENCES rounds(id) ON DELETE SET NULL"),
    ("superseded_at", "BIGINT"),
)
SUCCESSOR_INDEX = "CREATE UNIQUE INDEX IF NOT EXISTS rounds_one_successor ON rounds(previous_round_id)"
CLIENT_EVENTS = {"quote_added", "invite_copied"}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def connect():
    database_url = os.environ.get("DATABASE_URL")
    if database_url:
        return PostgresConnection(database_url)
    if os.environ.get("VERCEL") == "1":
        raise ApiError(503, "The shared database is unavailable.")
    os.makedirs(os.path.dirname(DB_PATH) or DATA, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("PRAGMA foreign_keys = ON")
    return db


def init():
    with closing(connect()) as db:
        if isinstance(db, PostgresConnection):
            with db:
                db.execute("SELECT pg_advisory_xact_lock(782016385103)")
                for statement in SCHEMA.split(";"):
                    if statement.strip():
                        db.execute(statement)
                for name, field_type in ROUND_COLUMNS:
                    db.execute(f"ALTER TABLE rounds ADD COLUMN IF NOT EXISTS {name} {field_type}")
                db.execute(SUCCESSOR_INDEX)
            return
        db.executescript(SCHEMA)
        db.execute("PRAGMA secure_delete = ON")
        with db:
            db.execute("BEGIN IMMEDIATE")
            round_columns = {row[1] for row in db.execute("PRAGMA table_info(rounds)")}
            for name, field_type in ROUND_COLUMNS:
                if name not in round_columns:
                    db.execute(f"ALTER TABLE rounds ADD COLUMN {name} {field_type}")
            db.execute(SUCCESSOR_INDEX)
            columns = {row[1] for row in db.execute("PRAGMA table_info(responses)")}
            if "name" not in columns:
                db.execute("ALTER TABLE responses ADD COLUMN name TEXT")
            if "limit_cents" in columns:
                db.execute("ALTER TABLE responses DROP COLUMN limit_cents")


class PostgresConnection:
    def __init__(self, url):
        from psycopg import Error, connect as postgres_connect
        from psycopg.rows import dict_row

        try:
            self.connection = postgres_connect(url, row_factory=dict_row, connect_timeout=5)
        except Error as error:
            raise ApiError(503, "The shared database is unavailable.") from error

    def execute(self, statement, params=()):
        from psycopg import OperationalError, errors
        try:
            return self.connection.execute(statement.replace("?", "%s"), params)
        except (OperationalError, errors.UndefinedTable, errors.UndefinedColumn) as error:
            raise ApiError(503, "The shared database is unavailable.") from error

    def executemany(self, statement, rows):
        with self.connection.cursor() as cursor:
            cursor.executemany(statement.replace("?", "%s"), rows)

    def close(self):
        self.connection.close()

    def __enter__(self):
        return self

    def __exit__(self, error_type, *_):
        if error_type:
            self.connection.rollback()
        else:
            self.connection.commit()


def lock_round(db, round_id):
    sql = "SELECT payers, host_key, superseded_at FROM rounds WHERE id = ?"
    if isinstance(db, PostgresConnection):
        sql += " FOR UPDATE"
    else:
        db.execute("BEGIN IMMEDIATE")
    return db.execute(sql, (round_id,)).fetchone()


def record_event(db, event):
    db.execute(
        "INSERT INTO round_events (day, event, count) VALUES (?, ?, 1) "
        "ON CONFLICT(day, event) DO UPDATE SET count = round_events.count + 1",
        (date.today().isoformat(), event),
    )


def require_active_round(row):
    if row["superseded_at"] is not None:
        raise ApiError(409, "This round has been superseded. Open the updated round to respond.")


def claim_search_budget(db):
    minute = int(time.time()) // 60
    with db:
        slot = db.execute(
            """INSERT INTO search_budget (name, minute, count) VALUES ('lodging', ?, 1)
               ON CONFLICT(name) DO UPDATE SET
                 minute = excluded.minute,
                 count = CASE WHEN search_budget.minute = excluded.minute THEN search_budget.count + 1 ELSE 1 END
               WHERE search_budget.minute <> excluded.minute OR search_budget.count < 60
               RETURNING count""",
            (minute,),
        ).fetchone()
    if slot is None:
        raise ApiError(429, "Stay search is busy. Try again in a minute or add a quote manually.")


def share_ceiling(total, payers):
    return total // payers + (1 if total % payers else 0)


def clean_choices(payload, shares):
    if "choices" not in payload:
        # Older clients submit the full limit. Convert it without storing it.
        limit = payload.get("limit")
        if type(limit) is not int or not 0 <= limit <= 99_999_900:
            raise ApiError(400, "Send one fit decision per quote.")
        return [share <= limit for share in shares]

    choices = payload["choices"]
    if not isinstance(choices, list) or len(choices) != len(shares) or any(type(choice) is not bool for choice in choices):
        raise ApiError(400, "Send one boolean fit decision per quote.")
    highest_fit = max((share for share, fits in zip(shares, choices) if fits), default=0)
    if choices != [share <= highest_fit for share in shares]:
        raise ApiError(400, "Fit decisions must match a single budget limit.")
    return choices


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


def read_saved_staying_backup():
    appdata = os.environ.get("LOCALAPPDATA")
    if os.name != "nt" or not appdata:
        return None
    import ctypes
    from ctypes import wintypes

    class DataBlob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.c_void_p)]

    path = os.path.join(appdata, "InBudget", "stayingapi-backup.dpapi")
    try:
        with open(path, encoding="ascii") as file:
            encrypted = bytes.fromhex(file.read())
    except (OSError, ValueError):
        return None
    buffer = ctypes.create_string_buffer(encrypted)
    source = DataBlob(len(encrypted), ctypes.cast(buffer, ctypes.c_void_p))
    plain = DataBlob()
    if not ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(plain)):
        return None
    try:
        return ctypes.string_at(plain.data, plain.size).decode("utf-16-le").strip()
    finally:
        ctypes.memset(plain.data, 0, plain.size)
        ctypes.windll.kernel32.LocalFree(ctypes.c_void_p(plain.data))


def staying_keys():
    primary = os.environ.get("STAYINGAPI_KEY", "").strip()
    backup = os.environ.get("STAYINGAPI_BACKUP_KEY", SAVED_STAYING_BACKUP or "").strip()
    keys = [key for key in dict.fromkeys((primary, backup)) if key.startswith(("stay_test_", "stay_live_"))]
    return [key for key in keys if key.startswith(keys[0][:10])] if keys else []


def stay_search_mode(keys):
    if keys and keys[0].startswith("stay_live_"):
        return "live"
    if keys and os.environ.get("INBUDGET_STAY_SANDBOX") == "1":
        return "sandbox"
    return "map"


def photon_features(path, params):
    request = Request(
        f"{PHOTON_URL}/{path}?{urlencode(params, doseq=True)}",
        headers={"Accept": "application/json", "User-Agent": "InBudget/1.0"},
    )
    try:
        with urlopen(request, timeout=10) as response:
            envelope = json.load(response)
        features = envelope.get("features")
        if not isinstance(features, list):
            raise ValueError("Missing map features")
        return features
    except (URLError, TimeoutError, ValueError, AttributeError) as error:
        raise ApiError(502, "Map search is unavailable right now. Try again or add quotes manually.") from error


def feature_coordinates(feature):
    geometry = feature.get("geometry") if isinstance(feature, dict) else None
    point = geometry.get("coordinates") if isinstance(geometry, dict) else None
    if isinstance(point, list) and len(point) == 2 and all(type(value) in (int, float) for value in point):
        lng, lat = point
        if -90 <= lat <= 90 and -180 <= lng <= 180:
            return lat, lng
    return None


def search_locations(payload):
    if not isinstance(payload, dict):
        raise ApiError(400, "Send a JSON object.")
    location = clean_text(payload.get("location"), "Destination", 120)
    features = photon_features("api/", {"q": location, "layer": ("city", "locality"), "limit": 5})
    locations = []
    for match in features:
        point = feature_coordinates(match)
        if not point:
            continue
        properties = match.get("properties")
        if not isinstance(properties, dict) or not isinstance(properties.get("name"), str) or not properties["name"].strip():
            continue
        label = ", ".join(dict.fromkeys(properties[key] for key in ("name", "state", "country") if properties.get(key)))
        candidate = {"label": label[:160], "center": f"{point[0]}, {point[1]}"}
        if candidate not in locations:
            locations.append(candidate)
    return {"locations": locations[:5]}


def resolve_search_center(location, override):
    if override:
        if not isinstance(override, str) or len(override) > 80:
            raise ApiError(400, "Enter the center as latitude, longitude.")
        try:
            lat, lng = map(float, override.split(","))
        except ValueError as error:
            raise ApiError(400, "Enter the center as latitude, longitude.") from error
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise ApiError(400, "Enter valid latitude and longitude values.")
        return (lat, lng), location
    features = photon_features("api/", {"q": location, "layer": ("city", "locality"), "limit": 1})
    match = features[0] if features else {}
    center = feature_coordinates(match)
    if not center:
        raise ApiError(404, "Destination not found. Add a state or country, or enter coordinates.")
    properties = match.get("properties", {})
    place = ", ".join(dict.fromkeys(properties[key] for key in ("name", "state", "country") if properties.get(key)))
    return center, place or location


def mapped_stays(center, radius):
    lat, lng = center
    features = photon_features("reverse", {
        "lat": lat, "lon": lng, "radius": radius * 1.609344, "limit": 15,
        "osm_tag": [f"tourism:{tag}" for tag in LODGING_TAGS],
    })
    stays = {}
    for feature in features:
        point = feature_coordinates(feature)
        if not point:
            continue
        properties = feature.get("properties", {})
        name, kind, osm_id = (properties.get(key) for key in ("name", "osm_type", "osm_id"))
        link_types = {"N": "node", "W": "way", "R": "relation"}
        if not isinstance(name, str) or not name.strip() or kind not in link_types or type(osm_id) is not int:
            continue
        if properties.get("osm_key") != "tourism" or properties.get("osm_value") not in LODGING_TAGS:
            continue
        distance = stay_distance({"lat": point[0], "lng": point[1]}, center)
        if distance is None or distance > radius:
            continue
        url = f"https://www.openstreetmap.org/{link_types[kind]}/{osm_id}"
        stays[url] = {"name": name.strip()[:70], "url": url, "total": None, "distanceMiles": round(distance, 1)}
    return sorted(stays.values(), key=lambda stay: (stay["distanceMiles"], stay["name"]))


def stay_distance(location, center):
    if not isinstance(location, dict):
        return None
    lat, lng = location.get("lat"), location.get("lng")
    if type(lat) not in (int, float, Decimal) or type(lng) not in (int, float, Decimal):
        return None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None
    origin_lat, origin_lng = map(math.radians, center)
    lat, lng = math.radians(lat), math.radians(lng)
    chord = math.sin((lat - origin_lat) / 2) ** 2
    chord += math.cos(origin_lat) * math.cos(lat) * math.sin((lng - origin_lng) / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(min(1, chord)))


def staying_request(url, key):
    request = Request(url, headers={"Authorization": f"Bearer {key}", "Accept": "application/json"})
    with urlopen(request, timeout=12) as response:
        retry = response.headers.get("Retry-After", "") if hasattr(response, "headers") else ""
        return json.load(response, parse_float=Decimal), max(2, int(retry)) if retry.isdecimal() else 2


def staying_search(url, keys):
    for index, key in enumerate(keys):
        try:
            envelope, retry = staying_request(url, key)
            break
        except HTTPError as error:
            if error.code not in (401, 403, 429) or index == len(keys) - 1:
                raise
    data = envelope.get("data") if isinstance(envelope, dict) else None
    if isinstance(data, list):
        return data
    job = data.get("jobId") if isinstance(data, dict) else None
    if not isinstance(job, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", job):
        raise ApiError(502, "StayingAPI did not return listings.")
    deadline = time.monotonic() + 300
    while time.monotonic() + retry < deadline:
        time.sleep(retry)
        envelope, retry = staying_request(f"{STAYING_JOBS_URL}/{job}", key)
        data = envelope.get("data") if isinstance(envelope, dict) else None
        status = data.get("status") if isinstance(data, dict) else None
        if status == "completed" and isinstance(data.get("result"), list):
            return data["result"]
        if status not in ("pending", "running"):
            raise ApiError(502, "StayingAPI could not complete the search.")
    raise ApiError(504, "The stay search timed out. You can retry or add quotes manually.")


def search_stays(payload):
    keys = staying_keys()
    mode = stay_search_mode(keys)
    sandbox = mode == "sandbox"
    if not isinstance(payload, dict):
        raise ApiError(400, "Send a JSON object.")
    location = clean_text(payload.get("location"), "Destination", 160)
    radius = payload.get("radius")
    if type(radius) is not int or not 1 <= radius <= 100:
        raise ApiError(400, "Choose a radius from 1 to 100 miles.")
    if mode == "map":
        center, place = resolve_search_center(location, payload.get("center"))
        return {"stays": mapped_stays(center, radius), "place": place}
    start = clean_date(payload.get("start"), "Check-in")
    end = clean_date(payload.get("end"), "Check-out")
    if start < date.today().isoformat() or end <= start:
        raise ApiError(400, "Choose a future stay with check-out after check-in.")
    adults = payload.get("adults")
    if type(adults) is not int or not 3 <= adults <= 8:
        raise ApiError(400, "Enter 3 to 8 paying travelers.")
    center, place = (SANDBOX_CENTER, "Šibenik") if sandbox else resolve_search_center(location, payload.get("center"))
    query = urlencode({
        "location": location, "checkIn": start, "checkOut": end, "adults": adults,
        "platforms": "airbnb,vrbo,booking", "currency": "USD", "limit": 5,
    })
    try:
        properties = staying_search(f"{STAYING_SEARCH_URL}?{query}", keys)
    except HTTPError as error:
        if error.code in (401, 403):
            raise ApiError(502, "StayingAPI rejected the configured key.") from error
        if error.code == 429:
            raise ApiError(503, "StayingAPI is busy. Try again in a moment.") from error
        raise ApiError(502, "StayingAPI could not complete the search.") from error
    except (URLError, TimeoutError, ValueError) as error:
        raise ApiError(502, "StayingAPI could not complete the search.") from error

    stays = []
    for item in properties:
        if not isinstance(item, dict):
            continue
        distance = stay_distance(item.get("location"), center)
        if distance is None or distance > radius:
            continue
        capacity = item.get("maxOccupancy")
        if type(capacity) is int and capacity < adults:
            continue
        price = item.get("price")
        amount = price.get("totalPrice") if isinstance(price, dict) else None
        total = None
        if type(amount) in (int, Decimal) and 0 < amount <= 999_999 and (sandbox or price.get("currency") == "USD"):
            total = int((Decimal(amount) * 100).to_integral_value(rounding=ROUND_HALF_UP)) or None
        if sandbox and total is None:
            continue
        name, link = item.get("name"), item.get("url")
        if not isinstance(name, str) or not name.strip() or not isinstance(link, str) or not URL_RE.match(link) or len(link) > 500:
            continue
        stays.append({
            "name": name.strip()[:61] + " (sample)" if sandbox else name.strip()[:70],
            "url": link, "total": total,
            "distanceMiles": round(distance, 1),
        })
    return {"stays": sorted(stays, key=lambda stay: (stay["total"] is None, stay["total"], stay["distanceMiles"])), "place": place}


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
    destination = payload.get("destination")
    if destination is not None:
        destination = clean_text(destination, "Destination", 160)
    radius = payload.get("radius")
    if radius is not None and (not destination or type(radius) is not int or not 1 <= radius <= 100):
        raise ApiError(400, "A destination radius must be from 1 to 100 miles.")
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
    return {"title": title, "start": start, "end": end, "payers": payers, "quotes": cleaned,
            "destination": destination, "radius": radius}


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
        "SELECT choices, name FROM responses WHERE round_id = ?", (round_id,)
    ).fetchall()
    count = len(responses)
    results = None
    if count == row["payers"]:
        choices = [json.loads(response["choices"]) for response in responses]
        results = [all(choice[index] for choice in choices) for index in range(len(quotes))]
    successor = db.execute("SELECT id FROM rounds WHERE previous_round_id = ?", (round_id,)).fetchone() if row["superseded_at"] is not None else None
    return {
        "id": row["id"],
        "title": row["title"],
        "start": row["start"],
        "end": row["end"],
        "payers": row["payers"],
        **({"destination": row["destination"], "radius": row["radius"]} if row["destination"] else {}),
        "quotes": [dict(quote) for quote in quotes],
        "responseCount": count,
        "names": sorted((response["name"] for response in responses if response["name"] is not None), key=str.casefold),
        "results": results,
        **({"previousRoundId": row["previous_round_id"]} if row["previous_round_id"] else {}),
        **({"superseded": True, "successorRoundId": successor["id"] if successor else None}
           if row["superseded_at"] is not None else {}),
    }


def insert_round(db, data, previous_round_id=None):
    round_id = secrets.token_urlsafe(12)
    host_key = secrets.token_urlsafe(24)
    db.execute(
        'INSERT INTO rounds (id, host_key, title, start, "end", payers, created_at, destination, radius, previous_round_id) '
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (round_id, host_key, data["title"], data["start"], data["end"], data["payers"],
         int(time.time()), data["destination"], data["radius"], previous_round_id),
    )
    db.executemany(
        "INSERT INTO quotes (round_id, position, name, total, url, checked) VALUES (?, ?, ?, ?, ?, ?)",
        [
            (round_id, index, quote["name"], quote["total"], quote["url"], quote["checked"])
            for index, quote in enumerate(data["quotes"])
        ],
    )
    return round_id, host_key


def create_round(db, payload):
    data = clean_round(payload)
    with db:
        round_id, host_key = insert_round(db, data)
    return 201, {"id": round_id, "hostKey": host_key, "round": round_payload(db, round_id)}


def create_follow_up(db, parent_id, payload, host_key):
    with db:
        row = lock_round(db, parent_id)
        if row is None:
            raise ApiError(404, "That round does not exist.")
        if not host_key or not secrets.compare_digest(row["host_key"], host_key):
            raise ApiError(403, "Only the host can create a follow-up.")
        successor = db.execute(
            "SELECT id, host_key FROM rounds WHERE previous_round_id = ?", (parent_id,),
        ).fetchone()
        if successor:
            return 200, {"id": successor["id"], "hostKey": successor["host_key"], "round": round_payload(db, successor["id"])}
        require_active_round(row)
        data = clean_round(payload)
        if any(not quote["checked"] for quote in data["quotes"]):
            raise ApiError(400, "Verify every all-in quote before creating the updated round.")
        round_id, new_key = insert_round(db, data, parent_id)
        db.execute("UPDATE rounds SET superseded_at = ? WHERE id = ?", (int(time.time()), parent_id))
        record_event(db, "follow_up_created")
    return 201, {"id": round_id, "hostKey": new_key, "round": round_payload(db, round_id)}


def add_response(db, round_id, payload):
    if not ID_RE.fullmatch(round_id):
        raise ApiError(404, "That round does not exist.")
    if not isinstance(payload, dict):
        raise ApiError(400, "Send a JSON object.")
    traveler = payload.get("traveler")
    if not isinstance(traveler, str) or not TOKEN_RE.fullmatch(traveler):
        raise ApiError(400, "traveler must be an anonymous token.")
    name = clean_name(payload.get("name"))
    with db:
        row = lock_round(db, round_id)
        if row is None:
            raise ApiError(404, "That round does not exist.")
        require_active_round(row)
        payers = row["payers"]
        quotes = db.execute(
            "SELECT total FROM quotes WHERE round_id = ? ORDER BY position", (round_id,)
        ).fetchall()
        choices = clean_choices(payload, [share_ceiling(quote["total"], payers) for quote in quotes])
        existing = db.execute(
            "SELECT 1 FROM responses WHERE round_id = ? AND traveler = ?", (round_id, traveler)
        ).fetchone()
        count = db.execute(
            "SELECT COUNT(*) AS response_count FROM responses WHERE round_id = ?", (round_id,)
        ).fetchone()["response_count"]
        if existing is None and count >= payers:
            raise ApiError(409, "This round already has all of its responses.")
        db.execute(
            "INSERT INTO responses (round_id, traveler, choices, created_at, name) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(round_id, traveler) DO UPDATE SET "
            "choices = excluded.choices, "
            "created_at = excluded.created_at, name = excluded.name",
            (round_id, traveler, json.dumps(choices), int(time.time()), name),
        )
        if existing is None:
            if count == 0:
                record_event(db, "first_answer")
            if count + 1 == payers:
                record_event(db, "verdict_reached")
    return 200, {"round": round_payload(db, round_id)}


def reset_responses(db, round_id, host_key):
    if not isinstance(round_id, str) or not ID_RE.fullmatch(round_id):
        raise ApiError(404, "That round does not exist.")
    with db:
        row = lock_round(db, round_id)
        if row is None:
            raise ApiError(404, "That round does not exist.")
        if not host_key or not secrets.compare_digest(row["host_key"], host_key):
            raise ApiError(403, "Only the host can reset this round.")
        require_active_round(row)
        db.execute("DELETE FROM responses WHERE round_id = ?", (round_id,))
    return 200, {"round": round_payload(db, round_id)}


def delete_round(db, round_id, host_key):
    if not isinstance(round_id, str) or not ID_RE.fullmatch(round_id):
        raise ApiError(404, "That round does not exist.")
    with db:
        row = lock_round(db, round_id)
        if row is None:
            raise ApiError(404, "That round does not exist.")
        if not host_key or not secrets.compare_digest(row["host_key"], host_key):
            raise ApiError(403, "Only the host can delete this round.")
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
                    db.execute("SELECT destination FROM rounds LIMIT 0")
            except (sqlite3.Error, ApiError):
                return self.send_json(503, {"ok": False})
            return self.send_json(200, {"ok": True, "staySearch": stay_search_mode(staying_keys())})
        match = re.fullmatch(r"/api/rounds/([A-Za-z0-9_-]+)", route)
        if match:
            try:
                with closing(connect()) as db:
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
        if route in ("/api/stays/search", "/api/stays/locations"):
            try:
                operation = search_locations if route.endswith("/locations") else search_stays
                data = self.read_json()
                if os.environ.get("VERCEL") == "1":
                    with closing(connect()) as db:
                        claim_search_budget(db)
                result = operation(data)
                if route.endswith("/search"):
                    with closing(connect()) as db, db:
                        record_event(db, "search_completed")
                return self.send_json(200, result)
            except ApiError as error:
                return self.error_json(error)
        try:
            with closing(connect()) as db:
                if route == "/api/rounds":
                    return self.send_json(*create_round(db, self.read_json()))
                match = re.fullmatch(r"/api/rounds/([A-Za-z0-9_-]+)/responses", route)
                if match:
                    return self.send_json(*add_response(db, match.group(1), self.read_json()))
                match = re.fullmatch(r"/api/rounds/([A-Za-z0-9_-]{12,40})/follow-ups", route)
                if match:
                    return self.send_json(*create_follow_up(db, match.group(1), self.read_json(), self.headers.get("x-host-key")))
                if route == "/api/events":
                    data = self.read_json()
                    event = data.get("event") if isinstance(data, dict) else None
                    if not isinstance(event, str) or event not in CLIENT_EVENTS:
                        raise ApiError(400, "Unknown event.")
                    with db:
                        record_event(db, event)
                    return self.send_json(200, {"ok": True})
                raise ApiError(404, "Not found.")
        except ApiError as error:
            return self.error_json(error)

    def do_DELETE(self):
        route = self.route()
        if not route.startswith("/api/"):
            return self.send_error(405)
        responses_match = re.fullmatch(r"/api/rounds/([A-Za-z0-9_-]+)/responses", route)
        round_match = re.fullmatch(r"/api/rounds/([A-Za-z0-9_-]+)", route)
        try:
            with closing(connect()) as db:
                if responses_match:
                    return self.send_json(*reset_responses(db, responses_match.group(1), self.headers.get("x-host-key")))
                if round_match:
                    return self.send_json(*delete_round(db, round_match.group(1), self.headers.get("x-host-key")))
                raise ApiError(404, "Not found.")
        except ApiError as error:
            return self.error_json(error)


def main():
    global SAVED_STAYING_BACKUP
    SAVED_STAYING_BACKUP = read_saved_staying_backup()
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
