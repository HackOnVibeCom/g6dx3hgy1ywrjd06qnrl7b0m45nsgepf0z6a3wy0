import json
import os
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

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

    def test_health_and_static_site(self):
        self.assertEqual(self.call("/api/health"), (200, {"ok": True}))
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

    def test_name_column_is_added_to_an_older_database(self):
        path = os.path.join(self.tmp.name, "old.sqlite3")
        db = sqlite3.connect(path)
        db.execute(
            "CREATE TABLE responses (round_id TEXT, traveler TEXT, limit_cents INTEGER, choices TEXT, created_at INTEGER)"
        )
        db.commit()
        db.close()
        previous = server.DB_PATH
        server.DB_PATH = path
        try:
            server.init()
        finally:
            server.DB_PATH = previous
        db = sqlite3.connect(path)
        try:
            columns = [row[1] for row in db.execute("PRAGMA table_info(responses)")]
        finally:
            db.close()
        self.assertIn("name", columns)

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
