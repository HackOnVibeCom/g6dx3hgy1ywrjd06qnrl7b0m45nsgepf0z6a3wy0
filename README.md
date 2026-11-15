# InBudget — A Stay for Everyone

Find the stay everyone in a group can say yes to, without anyone revealing their private dollar limit.

A host shortlists up to three lodging quotes. Each traveler privately enters (or slides to) the most they'll pay. InBudget shows only which stays fit **everyone** and a shared comfort band. Nobody's individual limit is ever shown.

**Judge demo:** [Open InBudget](https://inbudget-omega.vercel.app/). Try the example or create a shared round, find nearby lodging, enter all-in quotes, and open an invite in another browser. No account or payment is required.

## Highlights

- **Privacy-first group consensus.** Each traveler’s limit stays in their browser. Shared responses send only fit decisions and an optional name. Results appear only after every payer has answered, and they show just a yes or no per stay plus a comfort band (the highest per-person share that fits everyone, and the lowest share that doesn't).
- **Exact 1¢ split math.** All-in totals are split across 3–8 paying travelers in integer cents. When a total doesn't divide evenly, the number of travelers at each share is shown, and fit is always checked against the higher share.
- **Interactive Three.js PBR stage.** Each lodge is an auto-rotating golden-hour diorama on its own island, built from CC0 Meshopt/KTX2 `.glb` models with PMREM reflections. It adds custom GLSL fireflies and verdict halos, loads in two progressive stages, and lets you click an island to pick that stay. A `Step +60°` button rotates the model by hand, and `Replay opening` replays the intro.
- **Scroll choreography.** Scrolling through `#story` moves the camera from inspecting one lodge (`01 / Inspect the quotes`) out to a three-island comparison (`02 / Compare the options`).
- **Synchronized views.** The opening showcase (`#opening`), 3D stage, plaque bar, price spectrum (`#price-track`), comparison cards (`#quotes`) and the chat-ready **Copy summary** button stay in sync on desktop and on mobile (from `320px`).
- **Accessible by default.** With `prefers-reduced-motion`, the fly-in, camera springs and particles are skipped. All prices use tabular numerals, and card layouts are pre-rendered so the page doesn't shift as it loads.
- **Static and server modes.** On static hosting, `dist/` works on its own and keeps rounds in `localStorage`. When the page finds `/api/health`, it switches to shared rounds with invite links (`?round=<id>`) backed by `python server.py` and SQLite.

## How a round works

1. **Host.** The host enters a trip title, check-in and check-out dates, the number of payers (3–8) and 1–3 quotes. Each quote needs a name, an all-in total and an `http(s)` listing link, plus an optional "price checked" time.
2. **Share.** In server mode, the host gets an invite link and a private host key, which stays in the host's browser.
3. **Respond.** Each traveler opens the link, can add a display name, sets a private limit and submits. A traveler can change their answer later.
4. **Verdict.** Once every payer has responded, the stays that fit everyone sort first and the comfort band appears. The host can reset responses or delete the round.

## Project layout

| Path | What it is |
| --- | --- |
| `dist/` | The deployable static site (no build step) |
| `dist/index.html`, `app.js` | Main app UI, round state, static/server mode switching |
| `dist/domain.mjs` | Pure split and verdict math (`cents`, `share`, `qualify`, `results`, `budgetBand`) |
| `dist/scene3d.mjs` | Three.js stage: models, lighting, fireflies, halos, picking |
| `dist/journey.mjs`, `journey.css` | Opening intro and scroll choreography |
| `dist/tokens.css`, `style.css`, `studio.css` | Design tokens and styles (see `DESIGN.md`) |
| `dist/studies/` | Interaction study page |
| `dist/assets/` | CC0 models, textures and sky; attribution is in `credits.json` |
| `dist/vendor/three/` | Vendored three.js r170 modules (no CDN at runtime) |
| `server.py` | Optional zero-dependency Python + SQLite round server |
| `scenes/shortlist-stage.three.js` | Stage scene reference |
| `tools/` | Asset pipeline scripts (see below) |
| `test_domain.mjs`, `test_server.py` | Domain and API tests |
| `DESIGN.md`, `design.pen` | "Alpine Twilight & Editorial Parchment" design system |
| `BENCHMARK.md` | Reference deconstruction behind the interaction design |

## Run & test

Requires Node 20+ for tests and Python 3 for the optional server. Local SQLite mode uses the Python standard library. Hosted Postgres mode uses `requirements.txt`.

```bash
# Domain unit tests (CI runs this as the build step before publishing dist/)
npm test

# Serve dist/ plus the shared-round API on http://127.0.0.1:8000
python server.py        # or: npm start

# Server API and concurrency tests
python -m unittest test_server
```

To try static mode only, serve `dist/` with any static file server, for example `python -m http.server -d dist`.

### Server configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8000` | Listen port (binds to `127.0.0.1`) |
| `INBUDGET_DB` | `data/inbudget.sqlite3` | SQLite database path |

## API

All bodies are JSON and capped at 64 KB. Errors return `{ "error": "..." }`.

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/health` | `{ "ok": true }` when the database is reachable |
| `POST` | `/api/stays/locations` | Return destination matches |
| `POST` | `/api/stays/search` | Discover mapped stays within a radius |
| `POST` | `/api/rounds` | Create a round and return `{ id, hostKey, round }` |
| `GET` | `/api/rounds/:id` | Round details, `responseCount`, traveler `names`, and `results` (`null` until everyone responds) |
| `POST` | `/api/rounds/:id/responses` | Add or update a response: `{ traveler, choices, name? }`. Older clients that send `limit` remain compatible. |
| `DELETE` | `/api/rounds/:id/responses` | Reset all responses (requires the `x-host-key` header) |
| `DELETE` | `/api/rounds/:id` | Delete the round (requires the `x-host-key` header) |

Static assets under `/vendor/` and `/assets/` are cached for one day. Every response sends `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`.

## Deployment

On every push to `main`, `.github/workflows/deploy.yml` runs `npm run build` (the domain tests) and publishes `dist/` as static Pages. The HackOnVibe platform manages that workflow and restores it if it's edited, so change the app code rather than the workflow. The deployed site runs in static mode. The [judge demo](https://inbudget-omega.vercel.app/) uses Vercel Python Functions and Neon Postgres for shared rounds.

**Find stays** uses Photon and OpenStreetMap to find mapped lodging around the destination when no live key is configured. Map results provide names and links. Check availability and enter the all-in price before saving. A live `STAYINGAPI_KEY` adds date-specific search. Both modes resolve the destination automatically, with an optional coordinate override. Set `INBUDGET_STAY_SANDBOX=1` with a sandbox key only when you want StayingAPI's fixed sample data.

Set `STAYINGAPI_BACKUP_KEY` to configure a fallback. On Windows the server can also read a DPAPI-encrypted backup at `%LOCALAPPDATA%\InBudget\stayingapi-backup.dpapi`. It tries a same-mode backup when the primary is rejected or rate-limited so a sandbox key never substitutes sample listings for a live search.

## Shared beta on Vercel

1. Import the repository as a Vercel project. The configuration publishes `dist/` and routes the shared API to a Python function.
2. Connect Neon Postgres through the Vercel Marketplace. Give Preview and Production separate Neon branches or databases, each with its own pooled `DATABASE_URL`. Keep StayingAPI keys unset for map-only discovery.
3. Open `/api/health` on each deployment. The function initializes the Postgres schema on first use and returns a service error if the database is unavailable. To initialize it explicitly, run `python -m pip install -r requirements.txt` and `python -c "from server import init; init()"` with the appropriate database URL loaded.
4. Hosted search has a shared budget of 60 requests per minute across both search endpoints. For per-IP protection, add a Vercel Firewall rule covering POST requests on `/api/stays/*` and `/api/dispatch` with a 60-second fixed window and 20 requests per IP. Monitor Photon usage during the low-volume beta. Set `INBUDGET_PHOTON_URL` if you switch to another compatible instance.
5. Verify the preview on two devices. Create a round and submit a response, redeploy the preview against the same database, and confirm the invite and response still work. Deploy production against the initialized production database after preview verification.

The local `python server.py` command continues to use SQLite when `DATABASE_URL` is unset. Local demo rounds and credentials stay on the local machine.

## Asset pipeline

The models and textures are already committed in `dist/assets/`. These scripts are only needed to regenerate them:

- `tools/fetch_assets.py` downloads the CC0 PBR models and sky from tevy.dev.
- `tools/fetch_textures.py` fetches the CC0 Poly Haven ground textures and converts them to WebP (needs Blender).
- `tools/find_models.py`, `fetch_models.py`, `optimize_models.py`, `inspect_models.py` and `contact_sheet.py` search for, fetch, decimate and review Sketchfab/Objaverse candidates (`optimize_models.py` needs Blender).
- `tools/vendor_three.py` re-vendors the three.js modules into `dist/vendor/three/`.

## Credits

All 3D models, textures and the sky panorama are **CC0 1.0**. Sources are listed in `dist/assets/credits.json`. three.js is MIT-licensed (`dist/vendor/three/LICENSE`).
