# InBudget Design System — Alpine Twilight & Editorial Parchment

> Category: Editorial Product & Interactive 3D Decision Tool
> A calm, tactile group lodging shortlist pairing warm editorial parchment typography with an atmospheric golden-hour Three.js PBR diorama stage.

## 1. Visual Theme & Atmosphere

InBudget resolves an uncomfortable group travel conversation—finding the stay everyone can afford without exposing anyone's exact budget—through calm editorial restraint and tactile 3D spatial inspection.

- **Visual style:** Editorial warm-parchment typography paired with a high-contrast deep-forest 3D showcase (`Alpine Twilight`).
- **Color stance:** Warm light parchment outer shell (`#F6F2E8`) anchoring a rich obsidian-spruce 3D stage (`#0F1F19` → `#1E372C`) lit by golden-hour amber (`#F4C97E`) and luminous sage-lime verdicts (`#D8EA98`).
- **Design intent:** Every lodge reads as a tangible architectural miniature on a brushed-brass island plinth; every price and fit state remains instantaneously scannable down to 320px width.

## 2. Color

- **Primary:** `#174B38` — Deep Spruce, used for primary CTAs and confirmed fit emphasis.
- **Secondary:** `#EDE7D9` — Warm Linen, used for subtle section bands and secondary containers.
- **Stage Obsidian:** `#0E1D17` — Deep forest backdrop behind the WebGL `<canvas>` so PBR reflections, warm window spill, and fireflies pop cleanly.
- **Brass Accent:** `#C8A96E` — Brushed champagne-brass trim for diorama plinth rings and active highlights.
- **Success / Fits Everyone:** `#CBE285` (on dark stage) / `#174B38` (on parchment) — Immediate unanimous-fit signal.
- **Warning / Over Budget:** `#E2A58B` (on dark stage) / `#7A3B2E` (on parchment) — Calm, non-shaming over-limit signal.
- **Surface:** `#FFFDF7` — Warm card paper for comparison cards and dialogs.
- **Text:** `#1E2D24` — High-contrast forest ink (`12.8:1` on `#FFFDF7`).
- **Neutral:** `#D8D3C4` — Hairline warm stone border token.

## 3. Typography

- **Scale:** `10 / 12 / 14 / 17 / 24 / 36 / 56 / 96`
- **Families:** `display = Georgia, 'Times New Roman', serif`, `primary = Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif`, `mono = ui-monospace, 'Cascadia Mono', monospace`
- **Numerals:** `font-variant-numeric: tabular-nums` on all prices, shares, and response counters.
- **Hierarchy:** Tight-tracked editorial serif headlines (`-0.065em` to `-0.075em`), crisp uppercase micro-eyebrows (`0.14em` tracking), calm body copy (`1.5` line-height).

## 4. Spacing & Grid

- **Spacing scale:** `4 / 8 / 12 / 16 / 24 / 36 / 56` (`4pt/8pt` rhythm).
- **Container:** `min(1320px, calc(100% - 88px))` on desktop, `calc(100% - 26px)` on mobile (`<=560px`).
- **Hero split:** `minmax(300px, 0.76fr) minmax(0, 1.24fr)` so the interactive 3D diorama stage commands generous visual breathing room.

## 5. Layout & Composition

- **Unified Opening → Stage Handoff:** Full-bleed `#opening` modal introduces the three lodges in golden-hour 3D and lands via FLIP transition into `.stage` with identical plaque order (`Fern Hollow Cabin` · `Ridge House` · `The Laurel Lodge`).
- **Layered 3D Stage:** `<canvas id="lodge-canvas">` sits at `z-index: 1` inside `.scene`, framed by subtle orbital rings (`pointer-events: none`) and glassmorphic stage chrome (`z-index: 2`).

## 6. Components

- **Stage Card (`.stage`):** Obsidian-spruce container (`border-radius: 22px`), subtle inner brass/sage border, ambient elevation shadow, header telemetry bar (`ASHEVILLE SHORTLIST` + `3 / 4 RESPONDED`), 3D viewport with pulsing `Live 360° · 3D PBR` status pill, and 3-column interactive plaque bar.
- **Stay Plaques (`.plaque`):** Tactile glass-on-forest buttons showing stay name, Georgia serif per-person price, and verdict pill (`Fits everyone` / `Over a budget`). Active plaque illuminates with warm ivory/lime contrast and crisp focus ring.
- **Comparison Cards (`.quote`):** Pre-rendered for zero layout shift (`CLS < 0.01`), sorting qualifying stays first once all travelers respond.

## 7. Motion & Interaction

- **3D Choreography:** Scroll progress across `#story` dollies the camera from hero lodge inspection (`01 / INSPECT THE QUOTES`) into a panoramic three-island comparison (`02 / COMPARE THE OPTIONS`).
- **Continuous Auto-Rotation:** The active 3D lodge diorama auto-rotates continuously (`~0.42 rad/s` smooth 360° turntable) throughout both the cinematic `#opening` intro and the main stage, paired with gentle pointer parallax and an accessible `Step +60°` button.
- **Reduced Motion:** `prefers-reduced-motion: reduce` bypasses the opening fly-in, disables camera springs/particles, and hides `Replay opening`.
