# Anybench design system: "instrument"

Written 2026-11-07, after a design review of the TDM-99 landing page. It replaces the
product-artifact look: a blue-violet accent, Bricolage Grotesque with Source Serif 4, and
rounded card grids.

## Why we changed it

- **It looked like a template.** The blue-violet accent, a serif body under a grotesque display
  face, soft 16–24px cards and a pill on every label are the defaults of AI-generated pages.
- **Its typography was borrowed.** Weights & Biases (Weave) uses Source Serif 4 with Source Sans
  3, so our serif pairing made us sound like them.
- **It hid the product.** The run grid sat in a 380px card. The strongest benchmark sites put
  the real output above the fold instead.

## What the best benchmark sites do

Checked live on 2026-11-07 with Context.dev styleguide and scrape:

| Site | Look | What we took | What we avoided |
|---|---|---|---|
| Terminal-Bench (tbench.ai) | Monochrome, Google Sans Code everywhere | "64.8% ± 3.1%" with error whiskers inline, and Table / Pareto / Waffle views of the same data | Mono everywhere is too austere at landing length |
| SWE-bench | Tailwind blue `#2563eb`, mascot banner | A trajectory link on every row: show the work | A template look |
| Arena (arena.ai) | Warm paper, light serif | The **live agent sessions** panel ("Running bash…") | Pastel bars and consumer-ranking vibes |
| Artificial Analysis | Black and white, plum `#43003b`, Victor Serif | "Lower is better" on every chart, and a checkered fill for unverifiable results | A rainbow of brand colours |
| ARC Prize | Dark `#0e0c0c`, yellow `#ffd84d` | The chart is the hero: score vs cost, plus a VERIFIED stamp | Overlapping labels |
| Epoch AI | Mint `#70efd1` | An "Updated <date>" stamp, and search first | Pills, plus a cookie modal over the content |
| Braintrust | Indigo `#2c1fea` | Motion made from the product's own unit (trace ticks) | Indigo CTA plus a logo wall |
| HUD (hud.ai) | Peach `#ffc98c`, Geist | The install command as a second CTA, and big real counters | Dreamy 3D landscape art |
| Linear | `#08090a`, Inter 510 | The hero *is* the product at real density | n/a |
| Modal | Near-black, green `#7fee64` | One accent, used with discipline | n/a |

### Live-run UIs (patterns for `/runs/[id]`)

- GitHub Actions matrix jobs.
- Buildkite's annotation pinned to the top.
- Vercel deploy logs: auto-follow that pauses when you scroll up.
- Modal: counts by state.
- Temporal: status chips and a query box.

## Principles

1. **The product is the hero.** The landing hero shows a still of the run page (stages,
   counts, the trial grid), labelled "example" with made-up numbers. There is no simulated
   "live" demo on the site: the founder cut it on 2026-11-07. The real live page is
   `/runs/[id]`.
2. **Colour means state, never decoration.**
   - Orange = running / live.
   - Green = gate passed.
   - Red = gate failed.
   - Hatched grey = infrastructure failure.
   - Nothing else gets a colour.
3. **No number without a gate, visibly.** A result that fails its gate is hatched, struck
   through and stamped, never ranked. The live pages show counts only (passed, failed gate,
   running). Speed and quality numbers appear only in the report, after the gate and the
   statistics (plan.md 17.2).
4. **Mono for every number.** Use tabular figures, and right-align numbers in tables.
5. **Ruled, not carded.** Use 1px hairlines, 4–10px radii, no drop shadows, no glows and no
   decorative gradients.
6. **Motion comes from state changes.**
   - A cell flips from running to passed.
   - A pulse travels down the pipeline.
   - The trial field resolves behind the hero.
   - All of it is off under `prefers-reduced-motion`.
7. **Number everything, like a lab report.** Sections are `§ 01…`, pipeline steps are `01…05`.

## Tokens (app/globals.css)

| Token | Dark (default, `.instrument`) | Light (paper) | Use |
|---|---|---|---|
| `--bg` | `#0a0c09` | `#f3f1ea` | page |
| `--surface` / `--surface-2` | `#10130e` / `#161a13` | `#fbfaf6` / `#ebe8de` | panels |
| `--fg` / `--muted` / `--dim` | `#eceee4` / `#8b9282` / `#5e6557` | `#16170f` / `#5d6052` / `#8a8c7e` | text |
| `--line` / `--line-strong` | `#23281f` / `#353c2e` | `#dad5c8` / `#c2bcac` | rules |
| `--accent` | `#ff7a1a` (Naïve orange) | same fill | live / running, the one accent |
| `--accent-ink` | `#ff9447` | `#b84d00` | orange *text* (contrast-safe) |
| `--pass` | `#7bd88f` | `#1e7a43` | gate passed |
| `--fail` | `#ff6b5a` | `#c2321f` | gate failed |
| `--queued` / `--infra` | `#262b22` / `#4a5143` | `#e3dfd3` / `#b2ad9e` | queued cells, infra failures (hatched) |

- The landing page and `/runs/*` always render inside `.instrument`, which forces the dark
  tokens. They are screens, not documents.
- Docs and legal pages follow the system theme.

## Type

Revised the same day after founder feedback: the bold wide grotesque with glow read as "AI-agent
font". Type now matches our compute sponsor Naïve (usenaive.ai): an editorial serif at regular
weight, a clean sans and a mono, with **no glows anywhere** (`--glow` is `none`).

- **Display: Newsreader** at weight 400, tracking about −0.03em. Italic is used for emphasis,
  as in "*actually better.*".
- **Text: Geist.** Buttons are flat pills in Geist 500: light on dark, dark on light.
- **Data: Geist Mono.** All numbers, labels, the nav and logs.

## The mark

A 3×3 trial grid: seven cells passed, one failed its gate, one still running in orange. It is
the product in nine pixels (`components/site/Mark.tsx`).
