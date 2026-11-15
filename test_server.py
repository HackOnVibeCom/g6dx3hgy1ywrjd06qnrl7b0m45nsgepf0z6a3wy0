import io
import json
import os
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import date, timedelta
from http.server import ThreadingHTTPServer
from unittest.mock import patch

import server


class RoundApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        server.DB_PATH = os.path.join(cls.tmp.name, "test.sqlite3")
        server.init()
        server.Handler.log_message = lambda *args: None
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def call(self, path, method="GET", payload=None, headers=None):
        body = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(
            self.base + path,
            method=method,
            data=body,
            headers={"content-type": "application/json", **(headers or {})},
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=5) as response:
            return response.status, response.headers.get_content_type(), response.read()

    def round_payload(self):
        return {
            "title": "Test trip",
            "start": "2026-10-15",
            "end": "2026-10-18",
            "payers": 4,
            "quotes": [
                {"name": "Fern Hollow Cabin", "total": 44001, "url": "https://example.com/fern", "checked": "2026-10-01T12:00:00.000Z"},
                {"name": "Ridge House", "total": 56800, "url": "https://example.com/ridge", "checked": "2026-10-01T12:00:00.000Z"},
                {"name": "The Laurel Lodge", "total": 71600, "url": "https://example.com/laurel", "checked": "2026-10-01T12:00:00.000Z"},
            ],
        }

    def create(self, payload=None):
        status, created = self.call("/api/rounds", "POST", payload or self.round_payload())
        self.assertEqual(status, 201)
        return created

    def respond(self, round_id, traveler, limit):
        return self.call(
            f"/api/rounds/{round_id}/responses",
            "POST",
            {"traveler": traveler, "limit": limit},
        )

    def test_follow_up_is_atomic_and_preserves_the_previous_verdict(self):
        parent = self.create()
        path = f"/api/rounds/{parent['id']}"
        headers = {"x-host-key": parent["hostKey"]}
        payload = self.round_payload()
        payload["quotes"][0]["total"] += 2000
        self.assertEqual(self.call(path + "/follow-ups", "POST", payload)[0], 403)
        unchecked = self.round_payload()
        del unchecked["quotes"][0]["checked"]
        self.assertEqual(self.call(path + "/follow-ups", "POST", unchecked, headers)[0], 400)
        for index in range(payload["payers"]):
            self.assertEqual(self.respond(parent["id"], f"traveler_token_{index}", 25000)[0], 200)
        old = self.call(path)[1]
        barrier = threading.Barrier(2)

        def submit():
            barrier.wait(timeout=5)
            return self.call(path + "/follow-ups", "POST", payload, headers)

        with ThreadPoolExecutor(max_workers=2) as pool:
            requests = [pool.submit(submit) for _ in range(2)]
            replies = [request.result() for request in requests]
        self.assertEqual(sorted(status for status, _ in replies), [200, 201])
        child = replies[0][1]
        self.assertEqual(child, replies[1][1])
        self.assertNotEqual(child["hostKey"], parent["hostKey"])
        self.assertEqual(child["round"]["previousRoundId"], parent["id"])
        self.assertEqual(child["round"]["responseCount"], 0)
        self.assertIsNone(child["round"]["results"])
        child_path = f"/api/rounds/{child['id']}"
        self.assertNotIn("hostKey", self.call(child_path)[1])
        self.assertEqual(self.call(path)[1], {**old, "superseded": True, "successorRoundId": child["id"]})
        self.assertEqual(self.respond(parent["id"], "traveler_token_0", 1)[0], 409)
        self.assertEqual(self.call(path + "/responses", "DELETE", headers=headers)[0], 409)
        self.assertEqual(self.call(child_path, "DELETE", headers={"x-host-key": child["hostKey"]})[0], 200)
        self.assertIsNone(self.call(path)[1]["successorRoundId"])
        self.assertEqual(self.call(path + "/follow-ups", "POST", payload, headers)[0], 409)

    def test_client_events_store_only_daily_counts(self):
        with closing(server.connect()) as db:
            before = db.execute("SELECT COALESCE(SUM(count), 0) AS n FROM round_events WHERE event = ?",
                                ("quote_added",)).fetchone()["n"]
        self.assertEqual(self.call("/api/events", "POST", {"event": "first_answer"})[0], 400)
        for _ in range(2):
            self.assertEqual(self.call("/api/events", "POST", {"event": "quote_added", "title": "private"})[0], 200)
        with closing(server.connect()) as db:
            rows = db.execute("SELECT * FROM round_events WHERE event = ?", ("quote_added",)).fetchall()
        self.assertEqual(set(rows[0].keys()), {"day", "event", "count"})
        self.assertEqual(sum(row["count"] for row in rows), before + 2)

    def test_health_and_static_site(self):
        with patch.dict(os.environ, {"STAYINGAPI_KEY": "", "STAYINGAPI_BACKUP_KEY": ""}):
            self.assertEqual(self.call("/api/health"), (200, {"ok": True, "staySearch": "map"}))
        with urllib.request.urlopen(self.base + "/", timeout=5) as response:
            self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
            self.assertEqual(response.headers["Referrer-Policy"], "same-origin")
        status, content_type, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertEqual(content_type, "text/html")
        self.assertIn(b"InBudget", body)
        status, content_type, body = self.get("/studies/")
        self.assertEqual(status, 200)
        self.assertEqual(content_type, "text/html")
        self.assertIn(b"Interaction studies", body)

    def test_sandbox_stay_search_filters_distance_and_normalizes_sample_quotes(self):
        def listing(name, coords, capacity=4):
            return {
                "name": name,
                "url": "https://example.com/" + name,
                "location": {"lat": coords[0], "lng": coords[1]},
                "maxOccupancy": capacity,
                "price": {"currency": "EUR", "totalPrice": 300.025},
            }

        response = {"data": [
            listing("Cabin", server.SANDBOX_CENTER),
            listing("TooFar", (0, 0)),
            listing("TooSmall", server.SANDBOX_CENTER, capacity=2),
        ]}
        start = date.today() + timedelta(days=1)
        query = {"location": "Asheville, NC", "start": str(start), "end": str(start + timedelta(days=3)), "adults": 4, "radius": 5}
        with patch.dict(os.environ, {"STAYINGAPI_KEY": "stay_test_example", "INBUDGET_STAY_SANDBOX": "1"}), patch.object(
            server, "urlopen", return_value=io.BytesIO(json.dumps(response).encode())
        ) as upstream:
            status, data = self.call("/api/stays/search", "POST", query)
            self.assertEqual(status, 200)
            self.assertEqual(data["stays"], [
                {"name": "Cabin (sample)", "url": "https://example.com/Cabin", "total": 30003, "distanceMiles": 0.0},
            ])
            request = upstream.call_args.args[0]
            self.assertEqual(request.get_header("Authorization"), "Bearer stay_test_example")
            self.assertIn("location=Asheville%2C+NC", request.full_url)
            self.assertNotIn("stay_test_example", json.dumps(data))

    def test_sandbox_key_defaults_to_real_mapped_lodging_at_the_destination(self):
        def feature(lng, lat, **properties):
            return {"properties": properties, "geometry": {"coordinates": [lng, lat]}}

        destination = feature(-80.4139, 37.2296, name="Blacksburg", state="Virginia", country="United States")
        tags = {"osm_key": "tourism", "osm_type": "N", "osm_value": "hotel"}
        nearby = feature(-80.412, 37.229, name="Virginia Inn", osm_id=1, **tags)
        croatia = feature(15.895, 43.735, name="Fixture", osm_id=2, **tags)
        with patch.dict(os.environ, {"STAYINGAPI_KEY": "stay_test_example", "INBUDGET_STAY_SANDBOX": ""}), \
                patch.object(server, "photon_features", side_effect=[[destination], [nearby, croatia]]) as photon, \
                patch.object(server, "staying_search") as staying:
            self.assertEqual(self.call("/api/health"), (200, {"ok": True, "staySearch": "map"}))
            status, data = self.call("/api/stays/search", "POST", {"location": "Blacksburg, VA", "radius": 5})
            self.assertEqual(status, 200)
            self.assertEqual(data["place"], "Blacksburg, Virginia, United States")
            self.assertEqual([stay["name"] for stay in data["stays"]], ["Virginia Inn"])
            self.assertIsNone(data["stays"][0]["total"])
            self.assertEqual(photon.call_args.args[1]["lat"], 37.2296)
            staying.assert_not_called()

    def test_stay_search_retries_a_rejected_primary_with_the_backup(self):
        keys = ["stay_test_primary", "stay_test_backup"]
        rejected = urllib.error.HTTPError(server.STAYING_SEARCH_URL, 401, "", None, None)
        with patch.object(server, "staying_request", side_effect=[rejected, ({"data": []}, 2)]) as request:
            self.assertEqual(server.staying_search(server.STAYING_SEARCH_URL, keys), [])
            self.assertEqual([call.args[1] for call in request.call_args_list], keys)

    def test_live_stay_search_polls_and_filters_against_the_entered_center(self):
        start = date.today() + timedelta(days=1)
        query = {"location": "Asheville, NC", "center": "35.5951, -82.5515", "start": str(start),
                 "end": str(start + timedelta(days=3)), "adults": 4, "radius": 5}
        nearby = {"name": "Nearby", "url": "https://example.com/nearby",
                  "location": {"lat": 35.6, "lng": -82.55}, "price": {"totalPrice": 420, "currency": "USD"}}
        distant = {**nearby, "name": "Too far", "location": {"lat": 0, "lng": 0}}
        responses = [
            ({"data": {"jobId": "job_example"}}, 2),
            ({"data": {"status": "completed", "result": [nearby, distant]}}, 2),
        ]
        with patch.dict(os.environ, {"STAYINGAPI_KEY": "stay_live_example", "STAYINGAPI_BACKUP_KEY": "stay_test_example"}), \
                patch.object(server, "staying_request", side_effect=responses) as request, patch.object(server.time, "sleep"):
            self.assertEqual(self.call("/api/health"), (200, {"ok": True, "staySearch": "live"}))
            status, data = self.call("/api/stays/search", "POST", query)
            self.assertEqual(status, 200)
            self.assertEqual([stay["name"] for stay in data["stays"]], ["Nearby"])
            self.assertEqual(data["stays"][0]["total"], 42000)
            self.assertEqual(request.call_args.args, (server.STAYING_JOBS_URL + "/job_example", "stay_live_example"))

    def test_create_and_read_round(self):
        created = self.create()
        self.assertRegex(created["id"], r"^[A-Za-z0-9_-]{12,40}$")
        self.assertTrue(created["hostKey"])
        self.assertNotIn("hostKey", created["round"])
        self.assertNotIn("host_key", created["round"])
        status, fetched = self.call(f"/api/rounds/{created['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(fetched["title"], "Test trip")
        self.assertEqual(fetched["payers"], 4)
        self.assertEqual(fetched["responseCount"], 0)
        self.assertIsNone(fetched["results"])
        self.assertEqual([quote["name"] for quote in fetched["quotes"]], [
            "Fern Hollow Cabin", "Ridge House", "The Laurel Lodge",
        ])

    def test_destination_matches_and_round_metadata(self):
        def city(region, lng):
            return {"geometry": {"coordinates": [lng, 37.5]},
                    "properties": {"name": "Richmond", "state": region, "country": "United States"}}

        with patch.object(server, "photon_features", return_value=[city("Virginia", -77.4), city("Kentucky", -84.3)]):
            status, body = self.call("/api/stays/locations", "POST", {"location": "Richmond"})
        self.assertEqual(status, 200)
        self.assertEqual([match["label"] for match in body["locations"]], [
            "Richmond, Virginia, United States", "Richmond, Kentucky, United States",
        ])
        payload = {**self.round_payload(), "destination": body["locations"][0]["label"], "radius": 15}
        created = self.create(payload)
        _, round_data = self.call("/api/rounds/" + created["id"])
        self.assertEqual((round_data["destination"], round_data["radius"]), (payload["destination"], 15))
        self.assertEqual(self.call("/api/rounds", "POST", {**payload, "radius": True})[0], 400)
        self.assertNotIn("destination", self.create()["round"])

    def test_hosted_search_budget_is_shared_and_resets_each_minute(self):
        with closing(server.connect()) as db, db:
            db.execute("DELETE FROM search_budget")
        with closing(server.connect()) as db, patch.object(server.time, "time", return_value=600):
            for _ in range(60):
                server.claim_search_budget(db)
        with closing(server.connect()) as db, patch.object(server.time, "time", return_value=601):
            with self.assertRaises(server.ApiError) as rejected:
                server.claim_search_budget(db)
            self.assertEqual(rejected.exception.status, 429)
        with closing(server.connect()) as db, patch.object(server.time, "time", return_value=660):
            server.claim_search_budget(db)

    def test_validation_rejects_bad_rounds(self):
        cases = {
            "end before start": {"end": "2026-10-14"},
            "too few payers": {"payers": 2},
            "too many payers": {"payers": 9},
            "no title": {"title": "   "},
            "no quotes": {"quotes": []},
            "ftp listing": {"quotes": [{"name": "x", "total": 100, "url": "ftp://example.com"}]},
            "zero total": {"quotes": [{"name": "x", "total": 0, "url": "https://example.com"}]},
        }
        for label, change in cases.items():
            with self.subTest(label):
                payload = self.round_payload()
                payload.update(change)
                status, body = self.call("/api/rounds", "POST", payload)
                self.assertEqual(status, 400, body)

        request = urllib.request.Request(
            self.base + "/api/rounds",
            method="POST",
            data=b"{",
            headers={"content-type": "application/json"},
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(caught.exception.code, 400)

    def test_responses_complete_and_lock(self):
        created = self.create()
        round_id = created["id"]
        host_key = created["hostKey"]
        for index, limit in enumerate([12000, 14000, 15000]):
            status, body = self.respond(round_id, f"traveler-{index:04d}", limit)
            self.assertEqual(status, 200)
            self.assertEqual(body["round"]["responseCount"], index + 1)
            self.assertIsNone(body["round"]["results"])
            self.assertNotIn("limit", body["round"])

        status, body = self.respond(round_id, "traveler-0004", 12000)
        self.assertEqual(status, 200)
        self.assertEqual(body["round"]["responseCount"], 4)
        self.assertEqual(body["round"]["results"], [True, False, False])

        status, body = self.respond(round_id, "traveler-0005", 12000)
        self.assertEqual(status, 409)
        self.assertIn("already", body["error"])

        self.assertEqual(self.call(f"/api/rounds/{round_id}/responses", "DELETE")[0], 403)
        self.assertEqual(
            self.call(
                f"/api/rounds/{round_id}/responses",
                "DELETE",
                headers={"x-host-key": "not-the-host"},
            )[0],
            403,
        )
        status, body = self.call(
            f"/api/rounds/{round_id}/responses",
            "DELETE",
            headers={"x-host-key": host_key},
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["round"]["responseCount"], 0)
        self.assertIsNone(body["round"]["results"])

    def test_traveler_can_revise_an_answer(self):
        payload = self.round_payload()
        payload["payers"] = 3
        created = self.create(payload)
        round_id = created["id"]
        status, body = self.respond(round_id, "traveler-a", 12000)
        self.assertEqual(status, 200)
        self.assertEqual(body["round"]["responseCount"], 1)
        status, body = self.respond(round_id, "traveler-a", 15000)
        self.assertEqual(status, 200)
        self.assertEqual(body["round"]["responseCount"], 1)

        self.respond(round_id, "traveler-b", 20000)
        status, body = self.respond(round_id, "traveler-c", 24000)
        self.assertEqual(status, 200)
        self.assertEqual(body["round"]["responseCount"], 3)
        self.assertEqual(body["round"]["results"], [True, False, False])

    def test_traveler_can_revise_after_the_round_is_full(self):
        created = self.create()
        round_id = created["id"]
        self.respond(round_id, "traveler-a", 11000)
        self.respond(round_id, "traveler-b", 20000)
        self.respond(round_id, "traveler-c", 20000)
        status, body = self.respond(round_id, "traveler-d", 20000)
        self.assertEqual(status, 200)
        self.assertEqual(body["round"]["results"], [False, False, False])

        status, body = self.respond(round_id, "traveler-a", 14200)
        self.assertEqual(status, 200)
        self.assertEqual(body["round"]["responseCount"], 4)
        self.assertEqual(body["round"]["results"], [True, True, False])
        self.assertNotIn("limit", body["round"])

        status, body = self.respond(round_id, "traveler-e", 50000)
        self.assertEqual(status, 409)

    def test_names_are_public_and_amounts_stay_hidden(self):
        created = self.create()
        round_id = created["id"]
        self.assertEqual(created["round"]["names"], [])

        status, body = self.respond(round_id, "traveler-a", 12000)
        self.assertEqual(status, 200)
        self.assertEqual(body["round"]["names"], [])
        self.assertNotIn("limit", body["round"])
        self.assertNotIn("limit_cents", body["round"])

        status, body = self.call(
            f"/api/rounds/{round_id}/responses",
            "POST",
            {"traveler": "traveler-b", "limit": 20000, "name": "  Blair  "},
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["round"]["names"], ["Blair"])
        self.assertNotIn("choices", body["round"])

        status, body = self.call(
            f"/api/rounds/{round_id}/responses",
            "POST",
            {"traveler": "traveler-c", "limit": 20000, "name": "ada"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["round"]["names"], ["ada", "Blair"])

        status, body = self.call(
            f"/api/rounds/{round_id}/responses",
            "POST",
            {"traveler": "traveler-b", "limit": 20000, "name": "Blair M."},
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["round"]["responseCount"], 3)
        self.assertEqual(body["round"]["names"], ["ada", "Blair M."])
        self.assertNotIn("limit_cents", self.call(f"/api/rounds/{round_id}")[1])

        self.assertEqual(self.call(
            f"/api/rounds/{round_id}/responses",
            "POST",
            {"traveler": "traveler-d", "limit": 20000, "name": "x" * 41},
        )[0], 400)
        self.assertEqual(self.call(
            f"/api/rounds/{round_id}/responses",
            "POST",
            {"traveler": "traveler-d", "limit": 20000, "name": 12},
        )[0], 400)

    def test_migration_removes_stored_limits_and_preserves_responses(self):
        for has_name in (False, True):
            with self.subTest(has_name=has_name):
                path = os.path.join(self.tmp.name, f"old-{has_name}.sqlite3")
                schema = server.SCHEMA.replace(
                    "    choices TEXT", "    limit_cents INTEGER NOT NULL,\n    choices TEXT"
                )
                if not has_name:
                    schema = schema.replace("    name TEXT,\n", "")
                round_id = "old-round-id"
                with closing(sqlite3.connect(path)) as db, db:
                    db.execute("PRAGMA foreign_keys = ON")
                    db.executescript(schema)
                    db.execute(
                        'INSERT INTO rounds (id, host_key, title, start, "end", payers, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        (round_id, "host-key", "Old trip", "2026-10-15", "2026-10-18", 4, 123),
                    )
                    db.execute(
                        "INSERT INTO responses (round_id, traveler, limit_cents, choices, created_at) VALUES (?, ?, ?, ?, ?)",
                        (round_id, "traveler-a", 12000, "[true, false, false]", 123),
                    )
                    if has_name:
                        db.execute("UPDATE responses SET name = 'Blair'")
                previous = server.DB_PATH
                server.DB_PATH = path
                try:
                    server.init()
                    server.init()
                finally:
                    server.DB_PATH = previous
                with closing(sqlite3.connect(path)) as db:
                    columns = [row[1] for row in db.execute("PRAGMA table_info(responses)")]
                    self.assertNotIn("limit_cents", columns)
                    self.assertEqual(db.execute("SELECT * FROM responses").fetchone(), (
                        round_id, "traveler-a", "[true, false, false]", 123,
                        "Blair" if has_name else None,
                    ))
                    self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_choice_submissions_validate_and_publish_only_the_group_verdict(self):
        payload = self.round_payload()
        payload["payers"] = 3
        quotes = payload["quotes"]
        quotes[0]["total"], quotes[1]["total"], quotes[2]["total"] = 60000, 30001, 30002
        round_id = self.create(payload)["id"]
        path = f"/api/rounds/{round_id}/responses"
        for choices in ([True], [False, 1, True], [True, False, False], [False, True, False]):
            with self.subTest(choices=choices):
                self.assertEqual(self.call(path, "POST", {"traveler": "traveler-a", "choices": choices})[0], 400)
        for index in range(3):
            status, body = self.call(path, "POST", {
                "traveler": f"traveler-{index}", "choices": [False, True, True],
            })
            self.assertEqual(status, 200)
            self.assertEqual(body["round"]["responseCount"], index + 1)
            self.assertNotIn("choices", body["round"])
            self.assertEqual(body["round"]["results"], [False, True, True] if index == 2 else None)

    def test_response_validation(self):
        created = self.create()
        round_id = created["id"]
        self.assertEqual(self.respond(round_id, "short", 12000)[0], 400)
        self.assertEqual(self.respond(round_id, "traveler-a", -1)[0], 400)
        self.assertEqual(self.respond(round_id, "traveler-a", 1.5)[0], 400)
        self.assertEqual(self.respond(round_id, "traveler-a", 12000)[0], 200)
        self.assertNotIn("limit_cents", self.call(f"/api/rounds/{round_id}")[1])

    def test_host_can_delete_round(self):
        created = self.create()
        round_id = created["id"]
        host_key = created["hostKey"]
        self.respond(round_id, "traveler-a", 12000)

        self.assertEqual(self.call(f"/api/rounds/{round_id}", "DELETE")[0], 403)
        self.assertEqual(
            self.call(f"/api/rounds/{round_id}", "DELETE", headers={"x-host-key": "wrong"})[0],
            403,
        )
        status, body = self.call(
            f"/api/rounds/{round_id}",
            "DELETE",
            headers={"x-host-key": host_key},
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["deleted"])
        self.assertEqual(self.call(f"/api/rounds/{round_id}")[0], 404)
        self.assertEqual(self.respond(round_id, "traveler-b", 12000)[0], 404)
        self.assertEqual(self.call(f"/api/rounds/{round_id}", "DELETE", headers={"x-host-key": host_key})[0], 404)

        db = sqlite3.connect(server.DB_PATH)
        try:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM responses WHERE round_id = ?", (round_id,)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM quotes WHERE round_id = ?", (round_id,)).fetchone()[0], 0)
        finally:
            db.close()

    def test_concurrent_responses_do_not_overflow(self):
        payload = self.round_payload()
        payload["payers"] = 3
        created = self.create(payload)
        statuses = []

        def submit(index):
            statuses.append(self.respond(created["id"], f"concurrent-{index:04d}", 12000)[0])

        threads = [threading.Thread(target=submit, args=(index,)) for index in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(statuses.count(200), 3)
        self.assertEqual(statuses.count(409), 3)
        self.assertEqual(self.call(f"/api/rounds/{created['id']}")[1]["responseCount"], 3)

    def test_rejects_oversized_body(self):
        request = urllib.request.Request(
            self.base + "/api/rounds",
            method="POST",
            data=b"x" * (server.MAX_BODY + 1),
            headers={"content-type": "application/json"},
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(caught.exception.code, 413)

    def test_unknown_round(self):
        self.assertEqual(self.call("/api/rounds/doesnotexist123")[0], 404)
        self.assertEqual(self.respond("doesnotexist123", "traveler-a", 12000)[0], 404)
        self.assertEqual(self.call("/api/rounds/..%2f..%2fetc")[0], 404)
        self.assertEqual(self.call("/api/nothing-here")[0], 404)


if __name__ == "__main__":
    unittest.main()
