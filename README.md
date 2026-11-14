# InBudget — A Stay for Everyone

Find the stay everyone in a group can say yes to—without anyone revealing their private dollar limit.

## Highlights

- **Privacy-First Group Consensus:** Each traveler enters or slides their maximum lodging budget privately. Only unanimous per-stay fit and the shared comfort band are revealed—never individual dollar limits.
- **Exact 1¢ Split Math:** Splits all-in totals across 3–8 paying travelers in integer cents, explicitly surfacing any extra `1¢` ceiling share.
- **Interactive Three.js PBR 3D Stage:** Continuous 360° auto-orbiting architectural lodge dioramas (CC0 1.0 Meshopt + KTX2 PBR `.glb` models, golden-hour PMREM reflections, custom GLSL fireflies & verdict halos, two-stage progressive streaming, and direct 3D island picking).
- **Synchronized Views:** Intro showcase (`#opening`), 3D stage, plaque bar, Shortlist Price Spectrum (`#price-track`), comparison cards (`#quotes`), and chat-ready `Copy summary` stay in lockstep across desktop and mobile (`320px+`).
- **Static + Server Modes:** Works out of the box on static hosting (`dist/` with local browser storage) and upgrades automatically to multi-device invite links when run with `python server.py` (SQLite).

## Run & Test

```bash
# Run domain unit tests (also used by CI build before publishing dist/)
npm test

# Start the optional Python + SQLite shared-round server on http://127.0.0.1:8000
python server.py

# Run server API & concurrency tests
python -m unittest test_server
```
