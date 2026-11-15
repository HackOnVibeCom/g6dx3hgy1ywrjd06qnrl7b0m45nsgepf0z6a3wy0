import threading
from urllib.parse import parse_qs, urlsplit

from server import ApiError, Handler, init


_schema_ready = False
_schema_lock = threading.Lock()


class handler(Handler):
    def ensure_schema(self):
        global _schema_ready
        with _schema_lock:
            if not _schema_ready:
                init()
                _schema_ready = True

    def dispatch(self, operation):
        try:
            self.ensure_schema()
        except ApiError as error:
            return self.error_json(error)
        return operation()

    def do_GET(self):
        return self.dispatch(super().do_GET)

    def do_POST(self):
        return self.dispatch(super().do_POST)

    def do_DELETE(self):
        return self.dispatch(super().do_DELETE)

    def route(self):
        url = urlsplit(self.path)
        rewritten_path = parse_qs(url.query).get("inbudget_path", [])
        if url.path.rstrip("/") == "/api/dispatch":
            return "/api/" + (rewritten_path[0].strip("/") if rewritten_path else "unknown")
        return url.path.rstrip("/") or "/api/unknown"
