"""Exercise the deployed map search and shared-round flow with disposable data."""

import argparse
import json
import os
import secrets
from datetime import date, datetime, timedelta, timezone
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPCookieProcessor, HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def client(origin):
    cookies = CookieJar()
    opener = build_opener(NoRedirect(), HTTPCookieProcessor(cookies))
    token = os.environ.get("VERCEL_OIDC_TOKEN")
    share_url = os.environ.get("INBUDGET_PREVIEW_SHARE_URL")
    if share_url:
        destination = urlsplit(share_url)
        require(destination.scheme == "https" and destination.netloc == urlsplit(origin).netloc,
                "The preview share URL must match the HTTPS deployment origin")
        try:
            with opener.open(share_url, timeout=20):
                pass
        except HTTPError as error:
            with error:
                require(error.code in (301, 302, 303, 307, 308), "Could not authenticate to Preview")
    if token:
        require(origin.startswith("https://"), "Use HTTPS with a Vercel token")

    def call(path, *, method="GET", data=None, key=None, expected=200):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["x-vercel-trusted-oidc-idp-token"] = token
        if key:
            headers["x-host-key"] = key
        request = Request(origin + "/api" + path, method=method, headers=headers,
                          data=json.dumps(data).encode() if data is not None else None)
        try:
            response = opener.open(request, timeout=35)
        except HTTPError as error:
            response = error
        with response:
            require(response.status == expected, f"{method} {path} returned HTTP {response.status}; expected {expected}")
            return json.load(response)

    return call


def verify_round(call, state):
    parent, child = state["parent"], state["child"]
    public = call("/rounds/" + parent["id"])
    require("hostKey" not in public and not any(item in public for item in ("limit", "responses")),
            "The invite exposed private round data")
    require(public["responseCount"] == 3 and public["results"] and public["superseded"] and
            public["successorRoundId"] == child["id"], "Previous round or verdict missing")
    successor = call("/rounds/" + child["id"])
    require(successor["previousRoundId"] == parent["id"] and successor["responseCount"] == 0,
            "Follow-up link or response count is incorrect")


def cleanup(call, state):
    for name in ("child", "parent"):
        if name in state:
            item = state[name]
            call("/rounds/" + item["id"], method="DELETE", key=item["hostKey"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin", help="Deployment origin such as https://inbudget-omega.vercel.app")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--checkpoint", type=Path, help="Keep disposable rounds and write their cleanup keys to this local file")
    group.add_argument("--resume", type=Path, help="Verify the same rounds after redeployment and delete them")
    args = parser.parse_args()
    call = client(args.origin.rstrip("/"))
    health = call("/health")
    require(health.get("ok") is True, "Shared service is unhealthy")
    if args.resume:
        state = json.loads(args.resume.read_text(encoding="utf-8"))
        verify_round(call, state)
        cleanup(call, state)
        args.resume.unlink()
        print("Rounds and verdict survived redeployment. Disposable rounds deleted.")
        return

    location = call("/stays/locations", method="POST", data={"location": "Blacksburg, Virginia"})
    match = next((item for item in location["locations"] if "Virginia" in item["label"]), None)
    require(match is not None, "Destination did not resolve to Virginia")
    start = date.today() + timedelta(days=30)
    end = start + timedelta(days=3)
    search = {"location": match["label"], "center": match["center"],
              "radius": 15, "start": str(start), "end": str(end), "adults": 3}
    stays = call("/stays/search", method="POST", data=search)["stays"]
    require(stays and all(stay["distanceMiles"] <= 15 for stay in stays), "Missing or out-of-range stays")
    draft = {"title": "Disposable deployed smoke check", "start": str(start), "end": str(end), "payers": 3,
             "destination": match["label"], "radius": 15,
             "quotes": [{"name": stays[0]["name"], "url": stays[0]["url"], "total": 30000,
                         "checked": datetime.now(timezone.utc).isoformat()}]}
    state = {}
    retained = False
    try:
        parent = state["parent"] = call("/rounds", method="POST", data=draft, expected=201)
        path = "/rounds/" + parent["id"]
        invite = call(path)
        require(invite["responseCount"] == 0 and invite["destination"] == match["label"], "Invite missing trip data")
        for _ in range(3):
            call(path + "/responses", method="POST", data={"traveler": secrets.token_hex(16), "choices": [True]})
        draft["quotes"][0]["total"] = 33000
        state["child"] = call(path + "/follow-ups", method="POST", data=draft, key=parent["hostKey"], expected=201)
        verify_round(call, state)
        if args.checkpoint:
            fd = os.open(args.checkpoint, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                json.dump({name: {key: item[key] for key in ("id", "hostKey")} for name, item in state.items()}, file)
            retained = True
        print("Health, Blacksburg search, public invite, private responses, verdict and linked follow-up passed.")
    finally:
        if not retained:
            cleanup(call, state)


if __name__ == "__main__":
    main()
