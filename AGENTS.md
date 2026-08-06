# Nour's Casino — Project Handoff

A standalone, dependency-free, provably-fair casino suite modelled on Gamdom's Originals
(`gamdom.com/plinko`, `/crash`, `/twist`, `/limbo`, …). Pure ES modules + Canvas 2D.
**No build step, no framework, no CDN-hosted JS/CSS, no runtime dependency.** Open `index.html`
over HTTP and it runs. (`package.json` carries two build-time toolchains and ships nothing to
the browser: `wrangler` for the Cloudflare deploy (§13), and Capacitor for the native Android
and iOS app — see `MOBILE.md`.)
It opens on a **lobby** (§4a) — the eleven games are entered from there or by hash route.

---

## 1. Run it

```bash
# Double-click start.bat on Windows, or run from terminal:
python -m http.server 8080
# → http://localhost:8080/index.html
```

Syntax gate (the only "test suite" this project has):

```bash
npm run check   # tools/check-syntax.mjs — cross-platform, also runs as predeploy
# or, with no Node tooling installed:
for f in js/*.js js/games/*.js js/math/*.js js/render/*.js; do node --check "$f" || echo "FAIL $f"; done
```

> `node --check` catches parse errors only. It will **not** catch a duplicate `const` in
> different branches, an orphaned method body, or a `ReferenceError` waiting in dead code.
> See §10 for how that bit us.

---

## 2. Layout

```
index.html           1373 lines   All markup: topbar, lobby screen + 11 inline SVG card scenes, sidebar control panes, stage views, modals, cheat panel, account + customize modals, SVG sprite
styles.css           1236 lines   Base theme, layout grid, components, responsive shell ← read §14
css/gamdom.css        935 lines   Colour tokens, live-bets skin, chrome polish, brand mark, cheat panel, player profiles (loaded AFTER styles.css)
css/lobby.css        1430 lines   Lobby design system: route visibility, hero, grid, card art keyframes (loaded LAST)
start.bat              23 lines   Windows batch launcher (opens browser + starts python http.server 8080)
cookies.txt                       Session cookies used only to view the reference site; app never reads it (gitignored — local only)
js/app.js            3099 lines   Controller. Owns state, wallet, history, stats, auto-mode, routing, cheat panel, profiles, customization, all wiring
js/accounts.js        791 lines   Named player profiles in localStorage + export/import codes ← read §7
js/cheats.js          403 lines   Cheat mode outcome peek for all 11 games ← read §6
js/physics.js        1604 lines   Plinko board: peg pyramid, ball sim, bucket VFX
js/audio.js           570 lines   Shared asset-backed HTMLAudio pool, cue aliases, mute/volume persistence
assets/gamdom/         77 files   Bundled Gamdom game cues (76 MP3, 1 WAV; 4,742,478 bytes)
js/render/theme.js    636 lines   SHARED canvas theme: palette, paintStage, peg/chip/tile/card/... ← read §5
js/math/multipliers.js 163 lines  Plinko payout tables (rows 8-16 × low/medium/high) + binomial/RTP math
js/math/provably-fair.js 318      HMAC-SHA256 outcome derivation, seed pair, verifier, SHA-256 fallback

js/games/crash.js    1146 lines   Exponential curve + orb head
js/games/twist.js    1413         3-ring celestial orbital game (Planet cyan / Moon purple / Sun gold)
js/games/limbo.js    1486         Target-multiplier roll (DOM-rendered + canvas rail)
js/games/roulette.js 1150         15-slot horizontal strip spinner
js/games/dice.js     1385         Slider roll over/under (backs BOTH `dice` and `pocket-dice` tabs)
js/games/hilo.js     1776         Higher/lower card guessing, progressive multiplier
js/games/keno.js     1327         40-tile grid, 10 picks, match payout table
js/games/mines.js    1498         5×5 grid, 1–20 mines via preset select (module clamps 1–24)
js/games/blackjack.js 1720        Classic 21 vs dealer, hit/stand/double

wrangler.jsonc         22 lines   Cloudflare assets-only Worker (no `main`) ← read §13
.assetsignore          31 lines   ALLOW-LIST of publishable files. Read BEFORE adding a root file ← §13
_headers               29 lines   Edge security + cache headers, parsed by Cloudflare, never served
package.json           38 lines   Build-time toolchains only (wrangler + Capacitor); nothing reaches the browser
tools/check-syntax.mjs 42 lines   Cross-platform `node --check` gate (`npm run check`, also `predeploy`)

--- native app (Capacitor). Full guide: MOBILE.md. None of this loads in a browser ---
capacitor.config.js    96 lines   appId/appName/webDir + the PINNED WebView origin. Named exports, NOT `export default`
js/native.js          223 lines   The ONLY file allowed to touch Capacitor. No-ops in a browser
css/fonts.css          67 lines   @font-face for the vendored variable fonts; linked into www/ by the build, not by index.html
fonts/                4 files     Inter + Roboto Mono, variable woff2, latin + latin-ext (~185 KB)
scripts/build-www.mjs 176 lines   Produces www/: copies the site, strips the Google Fonts CDN, vendors the faces
scripts/check.mjs     135 lines   `npm run check:cap` — syntax gate + asserts capacitor.config.js resolves as the CLI reads it
resources/            5 files     App icon + splash sources (SVG) and their 1024/2732 PNG renders
android/ ios/         generated   Real Gradle and Xcode projects; committed. Each carries its own .gitignore
www/                  generated   Capacitor's webDir. Gitignored. NEVER hand-edit — `npm run build` wipes it
.github/workflows/    2 files     CI: Android APK on ubuntu, iOS simulator build on macOS
```

`index.html` loads exactly one script: `<script type="module" src="js/app.js">`. Everything
else is reached through imports.

---

## 3. Architecture

### Ownership boundaries (respect these)

| Concern | Owner | Never touched by |
|---|---|---|
| Balance, bet, nonce, stats, history | `js/app.js` (`state`) | game modules |
| Wallet debit / credit | `js/app.js` handlers only | game modules |
| Canvas rendering, per-game animation | the game module | `app.js` |
| Seeds, HMAC, outcome derivation | `js/math/provably-fair.js` | everyone else re-uses it |
| Sound | `js/audio.js` singleton, injected as `{ audio }` | game modules never construct one |

**Game modules never touch money.** They compute an outcome and hand it back; `app.js`
debits before the round and credits on settle. This is why the balance invariant holds.

### The controller contract

Every game module follows the same shape:

```js
export class SomeGame {
  constructor(elementOrSelectorOrOptions, { audio, betAmount, onX } = {}) {}
  setBet(amount) {}
  async play/spin/deal/startRound(serverSeed, clientSeed, nonce) {}   // returns outcome
  cashout() {}          // only for mid-round games (crash, twist, hilo, mines)
  reset() {}
  resize() {}
  getState() {}
}
```

`app.js` instantiates all eleven in `init()` inside individual `try/catch` blocks — one
game failing to construct must never take the page down.

### State

```js
const state = {
  balance: 1000, bet: 10, rows: 16, risk: 'medium',
  mode: 'manual'|'auto', autoCount: 25, autoSpeed: 7,
  activeGame: 'plinko',
  clientSeed, serverSeed, serverHash, prevServerSeed, nonce,
  history: [],   // last 10 rounds
  stats: { bets, wagered, returned, wins, losses, bestWin, bestMult },
  buckets: {},   // "rows:risk" -> Plinko hit counts
};
```

Persisted to `localStorage['plinko.session.v1']`, debounced 250 ms. Constants live at the
top of `app.js`: `START_BALANCE 1000`, `MIN_BET 0.1`, `MAX_BALLS 60`, `HISTORY_LEN 10`,
`SETTLE_MS 15000` (watchdog — a lost ball can never eat a stake).

### Round lifecycle

```
primaryAction()  →  play<Game>()  →  debit bet, ++nonce
                                  →  await game.play(serverSeed, clientSeed, nonce)
                                  →  credit payout
                                  →  recordGenericRound(mult, bet, payout, game?, crashMult?)
                                       ├─ push history, update stats
                                       ├─ renderHistory() / renderStats()
                                       ├─ updateLiveBetsTable()
                                       └─ save()
```

Plinko is the exception: it debits into a `pending` Map keyed by ball id and settles in the
physics `onBallLanded` callback, with `SETTLE_MS` as the watchdog.

### Provably fair

`generateOutcome(serverSeed, clientSeed, nonce, rows)` → HMAC-SHA256(serverSeed,
`${clientSeed}:${nonce}`) → hex → floats → path/target. Every game derives from the same
primitive so one verifier covers all of them. Web Crypto when available, bundled SHA-256
fallback otherwise (`usesWebCrypto` reports which). Server seed rotates on demand; the
previous seed is revealed for verification.

---

## 4. UI wiring

- **`selectGame(g)`** (in `init()`) is the ONE switch that swaps games: toggles
  `#view-<game>` (stage) and `#pane-ctrl-<game>` (sidebar controls), retitles `#btn-drop`
  and `#current-game-title`, calls that game's `resize()`, reseeds the live-bets table.
  Both `.game-tab[data-game=…]` clicks and lobby cards reach a game through it — never
  duplicate its body, or the next game added will drift between the two entry points.
- **Hotkeys** (`app.js` ~1795): `Space` primary action, `A` half bet, `S` double bet,
  `D` max bet, `M` mute, `Esc` close modal. Everything except `M`/`Esc` is gated on
  `document.body.dataset.route === 'game'`, so a focused lobby card can never place a bet.
- **Auto mode**: `autoTick()` is a per-game switch. Games with a mid-round decision
  (crash/twist/hilo/mines/blackjack) return `'busy'` so the loop waits instead of
  double-betting. Auto stops on `'blocked'` (insufficient balance). `showLobby()` stops it.
- **Debug handle**: `window.plinko` exposes `{ state, pending, physics, <all 11 games>,
  audio, auto, selectGame, enterGame, showLobby, applyLobbyFilter, …handlers }`.
  Browser automation drives the app through this.

## 4a. Lobby & routing

`index.html` now ships two top-level screens and `document.body.dataset.route` picks one:

|`data-route`|Visible|Hidden|
|---|---|---|
|`lobby`|`#lobby`|`main.layout`, `.game-nav`, `#btn-home`|
|`game`|`main.layout`, `.game-nav`, `#btn-home`|`#lobby`|

All of that switching is **CSS only** (`css/lobby.css`, attribute selectors, no `!important`).

- **The lobby is not a game.** It is never a `.game-stage-view` and `state.activeGame` is
  never set to a non-game value — `primaryAction()` / `autoTick()` read that field and would
  fall through to Plinko.
- **Routes**: `#/` = lobby, `#/<gameKey>` = that game. `applyRoute()` runs on load and on
  `hashchange`; `enterGame(g)` / `showLobby()` write the hash. There is deliberately **no
  re-entrancy flag** — `hashchange` is async, so a flag set and cleared in the same tick is
  always stale. `applyRoute()` compares the requested route against the live one and
  early-returns instead, which is also what makes browser Back/Forward work.
- **Navigating never calls `reset()` or `destroy()`.** Per §5, tearing down a game with a
  stake in flight strands the money. Leaving for the lobby only hides the layout; the round
  keeps advancing (rAF state is never gated on visibility) and settles into the balance.
- **Re-entry resizes twice.** While the lobby is up, `main.layout` is `display:none`, so
  every canvas has zero layout size. `enterGame()` calls `resize()` inside a
  `requestAnimationFrame` after the route flip — drop it and stages paint at the wrong
  size on first entry.
- **Card art is inline SVG, not `<use href>`.** External CSS cannot reach into the shadow
  tree a `<use>` builds, and every card scene is CSS-animated. Each scene carries a fixed
  set of `.ca-*` hooks (`.ca-peg`, `.ca-curve`, `.ca-ring--a`, …) that `css/lobby.css`
  animates; gradient/clip ids are prefixed per game because duplicate ids break rendering.
- **Filtering** is `applyLobbyFilter()`: `.lobby-filter.is-active` tag ∩ `#lobby-search`
  query, toggling `.is-hidden` on cards and `.is-visible` on `#lobby-empty`.
- `refreshLobbyStats()` is called from `renderStats()`, so the hero stats are current the
  moment a player returns. `jitterLiveCounts()` early-returns off the lobby route.

### History chips

`historyChip(entry)` branches on `entry.game`:

- `'crash'` → `x1.61` prefix format, red `<2.00` / green `≥2.00` (`multToneCrash`, `fmtMultX`) —
  matches Gamdom's crash reel.
- everything else → `110×` suffix format with the 5-band heat map (`multTone`, `fmtMult`).

For a crash bust, `mult` is `0` (payout math) but `crashMult` carries the real crash point
so the chip can show `x1.47` in red rather than `x0`. **Don't collapse these two formatters
into one** — Plinko's bucket ticks and distribution heat map depend on the suffix form and
the 5-band palette.

---

## 5. Shared canvas theme (`js/render/theme.js`) — read before touching any stage

Every stage renders through one module so the eleven games read as a single product.
Before writing bespoke canvas code, check whether a primitive already exists.

```js
import * as T from '../render/theme.js';   // from js/games/*.js
import * as T from './render/theme.js';    // from js/physics.js

T.PALETTE / T.HEAT / T.heatColor(mult, maxMult)
T.roundRect(ctx, x, y, w, h, r)      // traces path only — you fill/stroke
T.alpha(hex, a)
T.createStarfield(count, seed) -> { draw(ctx, w, h) }
T.paintStage(ctx, w, h, { stars, glow, glowX, glowY, glowStrength, vignette })
T.glowOrb(ctx, x, y, r, color, { halo, core })
T.peg(ctx, x, y, r, flash, flashColor)
T.chip(ctx, x, y, w, h, { color, label, radius, lift, font })
T.tile(ctx, x, y, w, h, { state, accent, radius })   // idle|hover|selected|revealed|bad
T.card(ctx, x, y, w, h, { rank, suit, faceUp, glow, glowColor })
T.heroText(ctx, text, x, y, { size, color, align, baseline, blur, family, weight })
T.caption(ctx, text, x, y, { size, color, align, baseline, weight })
T.panel(ctx, x, y, w, h, { radius, accent })
```

Rules:

- All coordinates are **CSS pixels**; callers own DPR (`ctx.scale(dpr, dpr)` once on resize).
- `chip` and `tile` take a **top-left** origin, not a centre.
- Every helper is `save()`/`restore()` balanced, so no call leaks `shadowBlur`/`fillStyle`.
- `createStarfield` **once per instance** in the constructor. Building it per frame is the
  single easiest way to tank frame rate here.
- Palette: mint `#00ff86` primary/win, red `#ef4444` loss, gold `#fbbf24` jackpot tier,
  base `#070b12` to `#0d1420`. A per-game accent glow gives each stage its identity.
- All art is **procedural** — no image, sprite, or font files anywhere in this project.

### Render-loop contract (every game obeys this)

```js
tick() {
  this._raf = requestAnimationFrame(() => this.tick());   // re-arm FIRST, unconditionally
  this.advanceState(dt);                                   // NEVER gated — see below
  if (document.hidden || !this.canvas.offsetParent) return; // skip PAINT only
  if (this._reducedMotion) { this.drawStatic(); return; }
  this.draw();
}
```

- **Re-arm before gating.** `if (hidden) return;` without re-arming ends the rAF chain
  permanently — the stage looks perfect on first paint and is dead after one tab round-trip.
- **Only rendering may be skipped.** Anything advancing a live round (multiplier progression,
  reveal timers, settlement, cashout deadlines) runs every tick regardless of visibility.
  Gating state freezes a round behind a hidden tab and strands the player's stake.
- `!canvas.offsetParent` is the check doing real work — inactive `#view-*` panes are
  `display:none`, and browsers already throttle rAF in hidden tabs.
- Reduced motion is invisible to CSS on canvas. Read
  `matchMedia('(prefers-reduced-motion: reduce)')` in the constructor **and** subscribe to
  its `change` event.
- Exactly one rAF handle per instance; cancel in `stop()`/`destroy()`/`reset()`; guard
  double-start.

### Any promise a stake awaits MUST be settleable

`js/app.js` debits before the round and credits in the `await` continuation. A promise that
is neither resolved nor rejected therefore **eats the player's money silently** — no error,
no console trace, just a balance that never comes back.

This shipped as a real bug: `roulette.reset()` cancelled the spin's `animId` but left the
promise pending, so any reset mid-spin stranded the stake. Two guarantees are now required of
every round promise:

1. **An abort path.** Cancellation settles it. Roulette holds
   `this._pendingSpin = {resolve, reject}` and `_abortSpin(reason)` rejects it from `reset()`;
   `app.js` refunds in its `catch`.
2. **Throw safety.** A throw inside a rAF callback never rejects the enclosing promise, so
   the animate body is wrapped in `try/catch` that calls `reject(err)`.

A timer-based net also satisfies this — `limbo.animateTicker` uses an idempotent
`setTimeout(land, duration + 400)` so a throttled background tab cannot strand a stake.
Audited: roulette was the only game resolving a round promise from a cancellable rAF loop.

---


## 6. Cheat mode (`js/cheats.js`) — read before adding a peek

Every outcome in this suite is HMAC-SHA256 over `(serverSeed, clientSeed, nonce)`, computed
client-side. Nothing is hidden on a server, so the next round is derivable *before* the bet.
Cheat mode simply runs that derivation early and renders it into a HUD.

Toggle: `#btn-cheat` in the topbar, the `C` hotkey, or `window.plinko.setCheat(true)`.
`state.cheat` persists with the session. Visibility is CSS-only, off
`body[data-cheat="on"][data-route="game"]` — the panel can never show on the lobby.

### The two rules that keep a peek honest

**1. Never re-derive an outcome.** Always call the game's own exported calculator, or read
the resolved value off the live instance. A second copy of a float→result mapping drifts from
the real one, and a cheat that confidently prints the *wrong* answer is worse than no cheat.
Building this surfaced three of these:

- `twist.js` derived its bust threshold and ring pick inline inside `spin()`. Extracted to
  `calculateTwistOutcome()` + `selectSegmentFor()`; `spin()` now calls both. One definition.
- `blackjack.js`'s exported `calculateBlackjackOutcome` dealt `P1,P2,D1,D2` while the shipped
  `deal()` dealt `P1,D1,P2,D2` — same seed, different hands. The calculator was aligned to the
  class. It had zero callers, so nothing observable was wrong, but it is a verifier: silently
  disagreeing with the game defeats its only purpose.
- Mines and blackjack mid-round peeks read `minePositions` / `deck` off the instance rather
  than reshuffling. There is no second derivation to drift.

**2. Mind the nonce.** A round runs with `++state.nonce`, so an *upcoming* round resolves at
`nonce + 1` — that is what `peekCheat` computes as `nextNonce`. A round already in flight
resolves at the nonce the instance captured; read it from the instance (`hilo.nonce`,
`hilo.cardStep + 1`), never recompute. Off by one and every prediction is quietly wrong while
still looking plausible.

`js/cheats.js` is PURE: it never increments a nonce, rotates a seed, mutates an instance, or
touches the wallet. Verified by peeking all 11 games 22× and diffing balance/nonce/seeds.

### Panel model

`peekCheat(game, ctx)` returns `{ live, rows[], cards[], cardLabels[], grid, note }`.
`live: true` = a round in progress (a fact, badge reads `LIVE ROUND`); `live: false` = the
next round (a prediction, `NEXT ROUND`). Never blur the two — a player must know whether they
are looking at the hand they hold or the hand they are about to be dealt.

`peekSignature(game, ctx)` is a cheap change-detector. The 400 ms refresh tick exists because
mid-round state (mines reveals, blackjack hits, hilo steps) changes with no app-level event to
hook; the signature makes an idle tick a string compare instead of eleven HMACs. Measured 0
repaints across 8 idle ticks.

### The panel is click-through — keep it that way

`.cheat-panel` is `pointer-events: none`, with `.cheat-panel__close` the sole opt-in. The
layout is 1560px wide, so no 244px gutter exists until roughly 2650px of viewport; below that
the HUD overlaps the stage, and every board under it is a canvas the player clicks directly
(mines tiles, keno numbers, the in-canvas Cash Out). Without this a dead zone appears that
looks exactly like a broken game.

Consequence: the panel cannot scroll, so it MUST never clip. The tallest model is mines
(5×5 grid + four rows ≈ 393 px). Two media queries shrink the grid so it fits — one for short
viewports (`max-height: 560px`) and one for the narrow dock (`max-width: 1080px`, whose 52vh
cap is tighter still). Add a taller model and you must re-check both, because a half-rendered
row reads as a wrong prediction.

---

## 7. Player profiles & customization — read before touching the money path

Two features share one rule: **the wallet may only move through the settle path.**

### Profiles (`js/accounts.js`)

Named save slots in `localStorage['plinko.accounts.v1']`, independent of the legacy
`plinko.session.v1` key. The module is pure data — **no DOM, no rendering**; `app.js` owns
every pixel. Each profile stores its own full session snapshot (balance, seeds, nonce,
history, stats, buckets, house edge, bet limits).

- `snapshot()` / `applySnapshot()` in `app.js` are the ONE definition of a persisted session.
  `save()`, the `beforeunload` flush and the per-profile store all go through them. When
  these drifted apart, a reload inside the 250 ms debounce window silently dropped fields.
- `bootProfiles()` runs immediately after `load()`, so a first-run migration adopts the
  session the player was already mid-way through. A profile that has never played gets
  `snapshotDefaults()` — **not `{}`**, because that carries `cheat` through as a device
  preference instead of forcing the toggle off on every boot.
- **PINs are a shared-computer courtesy, not security.** SHA-256, no salt, verified in the
  browser. The UI says so; don't let copy drift into implying otherwise.
- Export codes are `NOURSCASINO01.` + base64url JSON, single-line so they survive a paste
  into any chat box. `parseExport()` must return a *specific* human error (damaged /
  wrong-app / truncated), never a bare throw.
- Overwrite-import can replace the ACTIVE profile's stored session while `state` still holds
  the old one; the next `save()` would write the stale copy straight back. The import handler
  therefore re-hydrates via `applySnapshot()` + `renderAll()`.

### `switchUser()` is on the settle path — order matters

```
refuse if roundLive()  →  stopAuto  →  settleAllPending  →  clearBalls
                       →  bank OUTGOING snapshot  →  setActive  →  applySnapshot(incoming)
```

Two bugs this ordering exists to prevent, both of which shipped once:

1. **Banking before settling ate the stake.** `settle()` refunds into `state`; a snapshot
   taken first froze the debit, and `applySnapshot(incoming)` then discarded the credit.
2. **A non-Plinko stake cannot be torn down at all.** Plinko's is in the `pending` Map and is
   settleable; every other game holds its stake inside an awaited promise with no abort path,
   so the continuation would credit whichever wallet is loaded *later* — player A loses the
   stake, player B banks the payout. So `roundLive()` refuses the switch outright.

`roundLive()` covers both shapes: `liveRounds` (a counter incremented by `trackRound()`
around every awaited `play<Game>()` round, released in a `finally` so a rejection cannot
wedge it) plus the mid-round flags (`twistInRound`, `hiloInRound`, `minesInRound`, crash
`running`, roulette `spinning`, blackjack `playing`/`dealer_turn`). **A new game must wrap its
await in `trackRound()`**, or its stake becomes invisible to the guard.

Every caller must respect the refusal — `switchUser()` returns a boolean, and reporting
"Switched to X" after a refusal is a lie the player acts on. Deleting the ACTIVE profile
checks `roundLive()` *before* removing it, or `activeId` would point at a profile that no
longer exists. Deleting the LAST profile resets `state` to defaults, because otherwise the
unload flush writes the deleted wallet to the legacy key and the next boot's migration
resurrects it as "Player 1" — undoing a delete the UI called permanent.

### Customization (`#modal-custom`)

Four knobs: exact balance, house edge (negative allowed), bet limits, max-win cap.

- `payoutScale()` derives from the edge (`(1 - BASELINE_EDGE) / (1 - houseEdge)`) and is
  exactly `1.0` at the 1% default, so existing behaviour is byte-identical until touched.
- **`effectivePayout()` is the single credit helper.** Every win in all 11 games routes
  through it. Refunds and deposits deliberately do NOT — scaling a refund at a negative edge
  would mint money out of a cancelled round.
- Balance edits accumulate into `stats.adjusted`, so the audit invariant survives them:
  `balance === START_BALANCE + adjusted − wagered + returned`. Use this form, not the older
  three-term one, in any money assertion.

---

## 8. Crash renderer (`js/games/crash.js`) — read before editing

Reworked to match a live `gamdom.com/crash` capture. Draw order in `draw()`:

```
drawBackground()      gradient → starfield (90, twinkling) → comets (sparse, dim) → green nebula
drawGrid(coords)      horizontal gridlines, y labels on the RIGHT, x-axis baseline only
drawCurve(coords)     area fill + glowing gradient stroke
drawParticles()       exhaust
drawOrbHead(x, y)     halo → glow ring → white-hot core   (NOT a rocket sprite)
drawCashoutMarkers()  red avatar chips + "x2.95 / $59.00" labels
drawExplosionParticles()
drawMultiplierText()  top-left "x1.84", 64px 900-weight, mint glow
```

### `projectY()` is the single source of truth

```js
projectY(mult, maxY, padding, chartH) {
  const linear = Math.min(1, (mult - 1) / (maxY - 1));
  return this.height - padding.bottom - Math.pow(linear, 1.45) * chartH;
}
```

The `1.45` exponent gives Gamdom's shallow-then-steep arc. **`getRocketCoords`, `drawCurve`,
`drawGrid`, and `drawCashoutMarkers` all call it.** When this projection was duplicated inline
the orb, the curve, the gridlines and the markers each drifted apart. Never re-derive it.

### `getRocketCoords(t, mult)` self-scales — a trap

It computes `maxX = max(12, t*1.15)` and `maxY = max(2.5, mult*1.25)` **from its own
arguments**. Calling it for a historical point (e.g. a cashout marker at t=6/x2.0) resolves
that point against *its own* viewport, not the current frame's — the marker lands in the
wrong place and drifts as the round grows. Always pass the frame's `coords` object down and
map with `coords.maxX` / `coords.maxY`.

### Other crash details

- States: `idle` | `running` | `cashed_out` | `crashed`. Each has its own readout text; `idle`
  shows `x1.00` + "READY · Place bet and start round" — `renderIdle()` goes through `draw()`,
  so any new state needs a branch in `drawMultiplierText()` or the tab paints wrong on load.
- `cashedOutMult` (not `currentMult`) is the locked-in value after cashout.
- Cashout markers use **independent synthetic stakes** (`5 + rand*120`), not the player's bet —
  they represent other players and would otherwise read `$0.00` when no bet is placed.
- Crash point: `max(1.00, 99 / float)` where `float ∈ [0,100)` from the HMAC — ~99 % RTP.
- Multiplier curve: `multAt(t) = 1.06 ^ (t * 4)`.

---

## 9. Visual reference — the shared look

Deltas found by screenshotting `gamdom.com/crash` next to the local build, and closed:

| Element | Gamdom | Implemented |
|---|---|---|
| Curve head | luminous white-core orb, heavy bloom | `drawOrbHead()` |
| Curve shape | shallow → steep arc | `pow(linear, 1.45)` |
| Y-axis labels | right side, dim, no y-spine | `drawGrid()` |
| Cashout markers | avatar chip + `x2.95` / `$59.00` on the line | `drawCashoutMarkers()` |
| Background | layered atmospheric haze, faint stars | `drawBackground()` |
| History pills | `x1.39`, red `<2×` / green `≥2×` | `multToneCrash` + `fmtMultX` |
| Multiplier readout | top-left, ~64px, weight 900, mint glow | `drawMultiplierText()` |

Palette (`css/gamdom.css`): mint `#00ff86`, secondary green `#10b981`, dark `#131a22`,
surface `#0f151b`, dim text `#45515c`, red `#ef4444`, gold `#fbbf24`.
Fonts: Inter (UI) + Roboto Mono (numerals) via Google Fonts.

**If asked to improve visuals: screenshot the live Gamdom page first and list concrete
deltas.** A comparison table with zero deltas is not a comparison — that mistake got the
work rejected twice here.

---

## 10. Hard-won gotchas

1. **Duplicated blocks are silent killers.** A bad edit left two `const bgGrad` in one scope
   plus an orphaned method body in `crash.js`. `node --check` passed; the module still threw
   at import and `window.plinko` was `undefined`, taking the whole app down. When a page goes
   blank, check the browser console before trusting the syntax loop.
2. **Verify the fix, not the file.** Run `node --check <file>` bare and read stderr, then
   reload and assert `window.plinko` exists.
3. **`xd://browser` needs single-line JSON.** Multi-line `code` strings fail to parse. Inside
   `code`, `document` is not in scope — use `await tab.evaluate(() => …)`. `tab.evaluate`
   caps around 30 s, so batch long test loops into chunks of ≤12 rounds.
4. **Don't cache canvas coordinates across frames** when the viewport rescales (§8).
5. **Shared helpers are shared.** `fmtMult` / `multTone` feed Plinko's distribution chart and
   win popup. Add a game-specific variant instead of editing them.
6. **Seeded DOM vs JS-rendered DOM.** The live-bets `<tbody>` rows in `index.html` are only
   visible pre-JS; `seedLiveBetsTable()` overwrites them on load and on every tab switch.
   Keep both in the same format or you'll ship a mixed-format table.
7. **A pending promise is a money bug.** Cancelling an animation without settling the promise
   a stake awaits silently eats the balance — no error anywhere. See §5.
8. **Headless Chromium defaults to `prefers-reduced-motion: reduce`.** Screenshots capture
   the static path unless you call
   `page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}])`.
   A stage that looks frozen in a capture may be perfectly fine in a real browser.
9. **One shared browser tab.** Parallel agents screenshotting at once capture each other's
   stage. Click your tab, act, and screenshot inside a single `run` cell.
10. **`cookies.txt` is reference material.** It was supplied to view the live site for design
    comparison. The app is fully offline, ships only procedurally drawn art, and never sends
    a request anywhere.
11. **A cheat that lies is worse than no cheat.** Any peek MUST call the game's own exported
    calculator or read the live instance — never a second copy of the derivation, and never
    the wrong nonce. See §6.
12. **`tab.evaluate` really does cap near 30 s.** An 11-game sweep with realistic waits blows
    straight through it and returns `Runtime.callFunctionOn timed out`. Drive the loop from
    the `run` cell and call `tab.evaluate` once per game.
13. **`getBoundingClientRect` ignores ancestor clipping.** An overflow hunt built on it will
    finger elements that are actually clipped by an `overflow:hidden` parent (`.lobby__orb--b`
    inside `.lobby__bg`). Confirm against `scrollWidth` before believing it.
14. **Synthetic `page.mouse.click` does not drive the canvas stages.** Clicks at correct tile
    coordinates leave mines untouched whether or not anything overlays it. Use the module API
    (`mines.revealTile(i)`) to exercise a board, and `document.elementFromPoint` to prove what
    would receive a real click.
15. **Bank AFTER you settle, never before.** `switchUser()` originally snapshotted the
    outgoing profile and *then* called `settleAllPending()`, so the refund landed in `state`
    and was thrown away by the incoming profile's snapshot. The wallet quietly lost the
    stake with no error. Any code that both persists a session and settles a round has this
    ordering trap. See §7.
16. **A Plinko-only money test passes while every other game leaks.** Plinko's stake lives
    in a settleable `pending` Map; the other ten sit inside an awaited promise with no abort
    path. Exercise a money-safety case with a non-Plinko game (roulette's ~4 s spin is the
    convenient one) or the interesting half goes untested.
17. **`Accounts.createUser(name, pin)` is positional and async.** Passing an options object
    yields `{ ok: false, error: 'Enter a profile name.' }`, and forgetting the `await`
    returns a Promise whose `.id` is `undefined` — which then looks exactly like a product
    bug in the switch path. Both cost a debugging detour here.

---

## 11. Verification actually performed

- `node --check` across all 17 JS modules — clean.
- App boots with `window.plinko` exposing 33 keys and zero page errors.
- **Full-suite auto sweep**: 44 rounds across all 11 games driven through `window.plinko`.
  Balance invariant exact: `$900.81 === 1000 − 440 + 340.81`.
- **Slow-game re-run** with an 11 s window (roulette's spin is ~4 s, so a 3.2 s window
  under-samples it): roulette 2 / crash 5 / twist 12 rounds, invariant exact at `$1100.40`.
- **rAF re-arm across a tab round-trip**: twist 168 renders → hidden while keno ran 156 →
  169 on return. Confirms the visibility gate re-arms rather than killing the chain.
- **Stranded-stake regression**: `playRoulette()` interrupted mid-spin by `roulette.reset()`
  now refunds — balance returns to `$1000.00`, `_pendingSpin` cleared, `spinning === false`.
- Screenshots reviewed for all 11 stages plus crash `running` / `cashed_out` / `crashed`.

Cheat mode (this pass):

- **Prediction correctness, all 11 games.** Peeked from the rendered panel, then drove the
  real round and compared against the recorded outcome — never against a second call to the
  same calculator, which would pass even with a wrong nonce. Plinko bucket multiplier vs
  credited `history[0].mult`; crash `2.36×` vs `crash.crashPoint`; twist SAFE + `moon`
  segment 11 vs `lastOutcome`; limbo `1.95×` vs `lastOutcome.result` (at nonce 4, confirming
  the `nonce + 1` offset); roulette slot 1 RED; pocket-dice `76.53`; dice `2.14`; all ten keno
  numbers; mines `[15,18,19]` vs `minePositions`; hilo opening `A♥` and mid-round next `5♦`
  (its `LOWER` call won, mult 1.0725); blackjack all four cards `9♣ Q♠ / 10♦ K♣` pre-deal,
  then live hole `K♣` and `19 + 4♦ = BUST`.
- **Purity**: 22 peeks across all 11 games left balance, nonce, both seeds and bet count
  byte-identical.
- **Signature gate**: 0 repaints across 8 idle ticks on plinko and crash; exactly 1 on a bet
  change.
- **Route + persistence**: hidden on `#/`, `flex` on a game route; `C` toggles and is ignored
  while an input is focused; reload restored `cheat: true` and repainted immediately.
- **Click-through**: `elementFromPoint` at the panel centre returns `CANVAS.mines-canvas`,
  and the close button still hit-tests to itself.
- **No clipping** at 1440×900, 1280×620, 1280×470, 1280×420, 1024×700, 820×700, 520×760,
  420×760 — mines (the tallest model) fits in every one.
- **Balance invariant with cheat on**: 85 auto rounds across all 11 games,
  `$954.45 === 1000 − 850 + 804.45`, zero page errors.

The ~5 px horizontal document overflow this section previously recorded as unattributed is
**resolved** — see the responsive pass below. It was the `.layout { align-items: start }`
leak into the ≤1080px column flex box (§14), not `.lobby__orb--b`.

Responsive pass (this pass) — see §14 for the design:

- Syntax gate clean across all 17 modules; braces balanced in all three CSS files; zero
  duplicate ids in `index.html`.
- **11 games × 11 viewports** (320×568, 360×740, 390×844, 430×932, 768×1024, 820×1180,
  844×390, 1024×768, 1280×800, 1440×900, 1920×1080): every canvas inside its host and
  inside `#board-stage`, zero document overflow, the fixed action bar on screen and clear
  of the stage in every stacked case, zero page errors.
- **Header token accuracy**: measured header height vs `--topbar-h` is within 1px (the
  border) at every breakpoint — 67/66 desktop, 77/76 tablet, 113/112 phone.
- **Lobby overflow**: 0 at 320/360/375/390/430. The only elements extending past the
  viewport are inside the two deliberate swipe strips (hero stats, filter chips), which is
  what makes the clipped last chip read as "more".
- **rAF re-arm across a pane round-trip**, all ten looping modules: handle advances, pane
  switched away and back, handle advances again. Crash was driven mid-round for the state
  half: the multiplier went 1.234 → 2.211 **while its pane was hidden**, and the chain kept
  advancing on return — state is never gated, only paint.
- **Money invariant**: eight instant/auto-settling games driven one at a time, residual
  exactly `0` each; twist / hilo / mines each run twice with a real mid-round cashout,
  residual exactly `0` each; `pending` 0 and no round left open afterwards.
- **Cheat panel** (the click-through HUD that must never clip, §6): mines — the tallest
  model — renders unclipped at 320×568, 360×740, 390×844, 430×932, 768×1024, 820×1180,
  844×390, 932×430, 1024×768, 1280×620, 1280×470 and 1440×900, never overlaps the fixed
  action bar, and is fully on screen at all of them.
- **Reduced motion**: 51 running animations under `no-preference`, **0** under `reduce`.
- **No in-canvas cashout exists.** Verified by grep: only keno, mines and physics register
  pointer listeners, none of them call `this.cashout()`, and every cashout still routes
  through a DOM button into the app handler — so no stage can settle a round without the
  wallet being credited.

Phone-first pass (this pass) — the stage went from 43% to ~75% of a 390x844 viewport:

- Syntax gate clean; braces balanced in all three CSS files.
- **Stage share**: 62% at 320x568, 71% at 360x740, **75% at 390x844**, 77% at 430x932,
  73% at 600x800, 65% at 1024x768, 70% at 1440x900. Was 43% on a phone.
- **11 games x 9 viewports**: every canvas inside its host and inside `#board-stage`, zero
  document overflow, the fixed action bar clear of the stage everywhere, zero page errors.
- **Header token** within 1px of measured at every breakpoint, 320px through 1920px,
  including the 521-720px band that a previous split had left unmeasured.
- **Tools sheet**: opens, fully on screen, all seven buttons hit-test to themselves at
  85x85 / 85x54, scrim taps close it, Escape closes it, selecting a tool closes it before
  its modal opens.
- **rAF**: chains re-arm across a pane round-trip in all eight continuously-looping modules;
  plinko and crash are idle-stopped by design and were driven to confirm they start and
  advance. Crash ran 1.262 -> 2.220 and auto-cashed **while its pane was hidden**.
- **Money residual exactly 0** for plinko, limbo, keno, dice, pocket-dice, roulette, crash,
  twist, hilo and mines, each driven individually with real mid-round cashouts.

Action-dock follow-up (same pass, after the first phone build shipped):

- **All 11 games x 13 viewports** (320x568 through 1920x1080, both orientations): zero
  overflow, canvas inside stage, bet bar on screen, and where a dock exists it is fully on
  screen with the stage ending above it. Every docked button is >=44px and hit-tests to
  itself.
- **Primary label**, all 11 games: correct per game, and no longer clobbered by a bet change
  (previously "Start Mines" reverted to "Drop Ball" on any bet edit).
- **Crash cash-out through the bar**: idle "Place Bet" -> running "Cash Out / Bank it" in
  stop styling -> tap banks the round (balance 1010.00 -> 1043.75) -> label restores.
- **Money residual exactly 0** again for all ten driven games, this time cashing out through
  the real docked buttons rather than the `window.plinko` handlers.

### Pre-existing defect found here, NOT introduced and NOT yet fixed

`#btn-bj-hit`, `#btn-bj-stand` and `#btn-bj-double` each have **two** `addEventListener`
registrations in `js/app.js` — one block around line 2248 and a stale duplicate around
line 2393. The duplicate is dead-wrong code, not a second opinion:

- it branches on `res.status`, a field `blackjack.js` does not produce (it returns
  `res.state` / `res.result`), so most of its bodies never fire;
- `stand`'s guard is a bare `if (res)`, which is always truthy, so **every stand records a
  second round** — `bets` and `wagered` are double-counted for blackjack;
- `double` debits `state.bet` unconditionally at the top before any guard, so **clicking
  Double takes the stake twice**.

Measured identically on this working tree and on `HEAD` via a `git worktree` served side by
side: four stand-completed rounds report `bets +8`, `wagered +80` for four real 10-unit
stakes, and the invariant over-reports `wagered` by exactly the duplicate's contribution.
The wallet is not drained by the stand path (the second record credits 0), but the Double
path is a real double-debit. Fix is to delete the stale block; left in place because it is
outside the scope of the pass that found it.

Two harness notes worth keeping:

1. **rAF does not fire in a backgrounded automation tab.** `document.hidden` reported
   `false` while 0 frames ran in 1.5 s, which made roulette and crash look permanently
   stuck mid-round with a stranded stake. `page.bringToFront()` fixes it. Any timing-based
   verification here is meaningless without it, and it looks exactly like a money bug.
2. `localStorage.clear()` followed by a navigation does **not** give a clean session — the
   `beforeunload` flush writes the live state straight back. Measure invariants as deltas
   across a run instead of against an absolute `START_BALANCE`.

Lobby work (earlier pass):

- `node --check` across all 15 JS modules clean; brace-balance check on all three CSS files.
- Boots on `#/` with `window.plinko` exposing 37 keys, 11 cards rendered, zero page errors.
- **Route round-trip**: lobby → crash card → `#/crash` (`activeGame`, title, `#btn-drop`
  label all correct, canvas resized to 1167 CSS px) → `#btn-home` → lobby; browser Back
  restored `#/roulette`, Forward returned to the lobby.
- **Balance invariant across five routed games** (plinko/limbo/keno/dice/roulette, one round
  each, each entered by `enterGame()`): `$995.00 === 1000 − 50 + 45`, every canvas correctly
  sized on entry. Lobby hero then read `$995.00 / 5 bets / 2×`.
- **Hotkey gate**: `Space` and `S` on the lobby changed neither balance nor bet.
- **Filters**: `cards` → hilo + blackjack; search `mine` → mines; `zzz` → 0 cards and
  `#lobby-empty` shown; clear → all 11 back.
- **Motion**: 75 running animations under `prefers-reduced-motion: no-preference`,
  **0** under `reduce` — the whole lobby collapses to a static state.
- **Responsive**: 1440 / 500 / 420 px. Fixed a pre-existing topbar overflow at ≤520 px
  (`.topbar__inner` now wraps, and `--topbar-h` grows to 104px in the same block so every
  sticky offset derived from it follows). No horizontal scroll at 420 px.

Profiles, customization and the new brand mark (this pass):

- `node --check` across all 17 JS modules clean; braces balanced in all three CSS files;
  zero duplicate ids in `index.html`. Boots on `#/` with `window.plinko` at 51 keys and
  zero page errors.
- **Profiles**: legacy session migrated to "Player 1" on first boot; create (including a
  unicode name, `Zoë 🎲`) and duplicate-name rejection; switch + reload restored
  `$4252.42`; a never-played profile correctly opened at `$1000` instead of inheriting the
  previous player's wallet.
- **PIN gate**: switching to a locked profile showed the unlock prompt and did NOT switch;
  a wrong PIN left the wallet on the original profile; the right PIN switched.
- **Export / import**: single-line `NOURSCASINO01.` code round-tripped; truncated, flipped
  and non-app strings each returned their own specific message with no throw; a whole-store
  bundle round-tripped all three profiles. Overwrite-import onto the ACTIVE profile
  re-hydrated memory — store held a stale `$999`, import restored `$4242.42`, and it
  survived a subsequent bet and a reload.
- **Delete**: deleting the active profile fell back to the survivor, with chip and wallet
  both reading the survivor's stored `$4252.42`. Deleting the LAST profile reset to defaults
  and, after a reload, did NOT resurrect the deleted `$7777` wallet.
- **Switch is money-safe** (the bug this section exists for): mid-roulette-spin the switch
  was refused and the wallet stayed on A; with two Plinko balls in flight it was refused
  again; after settlement the switch succeeded, A's banked session matched its on-screen
  `$1035.00`, B opened at a clean `$1000`, and returning to A still read `$1035.00`.
  A switch to an unknown id is refused rather than half-applied.
- **Customization**: modal prefills from state; a live edit previews RTP 107.5% / ×1.0859
  with the player-favourable warning and commits nothing; apply committed all five knobs;
  bet clamped to the new 5–50 bounds; `effectivePayout(10000)` capped at `$120`. A refund at
  a −50% edge returned exactly the stake (no minting) and deposits stayed unscaled.
- **Full 11-game auto sweep, post-guard**: 73 bets, extended invariant exact at
  `$953.95 === 1000 + 0 − 730 + 683.95`, `roundLive()` clear and `pending` 0 afterwards
  (so the `trackRound` counter releases on every path), zero page errors.
- **Brand**: single `#i-logo` and `#logoGrad`, mark renders exactly 22×22, inline SVG
  favicon with no external request.

Not covered: automated regression tests (none exist), cross-browser checks, mobile layout
beyond the CSS breakpoints, per-game RTP convergence over large samples, and sustained
frame-rate profiling under load.

---

## 12. Adding a twelfth game

1. `js/games/<name>.js` — export a class following §3's contract, plus a pure
   `calculate<Name>Outcome(serverSeed, clientSeed, nonce)` that goes through
   `hmacSha256Hex`. The class MUST call that exported function rather than deriving inline,
   or the cheat peek and the real round will drift apart (§6).
2. `index.html` — add the `.game-tab[data-game="<name>"]` button, a
   `#view-<name>` stage view, a `#pane-ctrl-<name>` sidebar pane, and a
   `.game-card[data-game="<name>"]` in `#lobby-grid` with its own inline SVG scene
   (`data-tags`, `data-name`, `--accent`, unique gradient ids — see §4a).
3. `js/app.js` — import it, add a top-level `let`, instantiate in `init()` inside its own
   `try/catch`, add `play<Name>()`, wire it into `primaryAction()` and `autoTick()`
   (return `'busy'` if it has a mid-round decision), add the key to the `GAMES` array and
   the `gameLabel()`/instance lookups, and add it to the `window.plinko` export.
   Two money-path obligations (§7), both silent if missed:
   **wrap the round's await in `trackRound()`** so `roundLive()` can see the stake, and
   **credit through `effectivePayout()`** so the house-edge scale and max-win cap apply.
   If it has a mid-round decision, add its open-round flag to `roundLive()` too.
4. `js/cheats.js` — add a `PEEKS['<name>']` entry returning the panel model, plus any
   control values it needs to `cheatCtx()` in `app.js` and to `peekSignature()`. Use
   `c.nextNonce` for an upcoming round and the live instance for one in flight. If the model
   is taller than mines, re-check the two clipping media queries (§6).
5. Style in `styles.css`; use the `css/gamdom.css` tokens for anything Gamdom-flavoured,
   and add the card's `.ca-*` keyframes to `css/lobby.css`.
6. Verify: syntax loop, then drive it through `window.plinko` in the browser and confirm
   `balance === START_BALANCE + adjusted − wagered + returned` still holds. For the peek,
   compare against the round's recorded outcome, never against a second call to the same
   calculator. Also start a round and confirm a profile switch is refused mid-stake.

---

## 13. Deployment (GitHub Pages + Cloudflare Workers)

Two independent, simultaneously-live surfaces. Neither knows about the other.

|Surface|Serves|Config|Headers|
|---|---|---|---|
|GitHub Pages|the whole repo root from `main`|`.nojekyll`|**none** — Pages has no `_headers` support|
|Cloudflare Workers|the `.assetsignore` subset|`wrangler.jsonc`|`_headers`, applied at the edge|

```bash
npm install && npm run login && npm run deploy
# → https://nours-casino.<subdomain>.workers.dev
```

`wrangler.jsonc` has **no `main`**: this is an assets-only Worker, so no Worker code exists
and none runs. `not_found_handling` is `"none"` on purpose — routing is hash-based, so the
origin only ever sees `/`, and an honest 404 makes both a broken import and an unpublished
file observable instead of masked behind an SPA fallback.

### `.assetsignore` is an allow-list, and that is the point

The assets directory is the repo root (so Pages and Cloudflare serve the same tree), and
**wrangler does not read `.gitignore`** — it uploads everything it walks. `.assetsignore`
therefore ignores `/*` and re-admits only `index.html`, `styles.css`, `css/`, `js/`, `assets/`.

A deny-list fails silently: drop a `secrets.txt` in the root and it ships. An allow-list fails
loudly: forget to re-admit a folder and the site 404s in your face. `cookies.txt` — a live
session cookie jar — sits in this repo root, which is exactly why this file is written the way
it is. **Read `.assetsignore` before adding a root-level file.**

Verified by curl against `wrangler dev`: `index.html`, `styles.css`, `css/*`, `js/**` all 200;
`cookies.txt`, `package.json`, `wrangler.jsonc`, `.assetsignore`, `_headers`, `AGENTS.md`,
`README.md`, `.gitignore`, `start.bat`, `.nojekyll`, `tools/*`, `node_modules/**` and `.git/**`
all 404.

### Two traps worth knowing

1. **`wrangler deploy --dry-run` prints "Read N files from the assets directory" BEFORE applying
   `.assetsignore`.** It reported 2041 files (i.e. all of `node_modules` and `.git`) with an
   allow-list that in fact publishes 20-odd. The number is not a manifest. Verify what is
   actually served with `wrangler dev` + curl, never by reading that line.
2. **`wrangler dev` reload-loops when the assets directory is the repo root.** It watches that
   directory and writes its own state into `.wrangler/` inside it, so it detects its own writes
   and reloads several times a second, forever. `npm run dev` passes
   `--persist-to ../.nours-casino-wrangler-state` to park the state outside the tree. For normal
   frontend work use `npm run serve`; `wrangler dev` is only needed to exercise `_headers`, the
   CSP, or 404 behaviour.

### `_headers`

Excluded from the allow-list so it is parsed but never downloadable (wrangler still reads it
from the assets directory — confirmed: "Parsed 4 valid header rules" with the file ignored, and
the rules present on every response). The CSP is `script-src 'self'` with no loosening, because
there is not one inline `<script>` or `on*=` handler in `index.html`. Its two allowances are
load-bearing and must survive any future edit:

- `style-src 'unsafe-inline'` — 29 inline `style="--accent:…"` attributes on the lobby cards.
- `img-src data:` — the favicon is an inline `data:image/svg+xml` URI.

Adding a game means adding a lobby card with an inline `--accent` style; that is already
covered. Adding an inline `<script>`, a `fetch()` to another origin, or an `<img src="https://…">`
is not — update the CSP in the same commit, and re-verify with a browser console open, because
a CSP violation is silent in the network tab and fatal to the stage.

---

## 14. Responsive system — read before touching any breakpoint

Three regimes, and every one of them is driven by a real measurement, never a guess.

|Width|Layout|Header|Bet action|Tab strip|Tools|
|---|---|---|---|---|---|
|`> 1080px`|two-column grid, sticky sidebar|sticky, 66px|in the sidebar|visible, scrolls when it doesn't fit|a row in the header|
|`<= 1080px`|**single column, stage FIRST**|sticky, 76px|**fixed bottom bar**|hidden — the lobby is the switcher|a row in the header|
|`<= 720px`|same|sticky **one row, 64px**|fixed bottom bar|hidden|**bottom sheet behind `#btn-more`**|
|`<= 520px`|same|same 64px row, wordmark + Deposit label dropped|fixed bottom bar|hidden|bottom sheet|

Plus two orthogonal blocks: `@media (pointer: coarse)` for 44px targets, and
`@media (max-width: 1080px) and (max-height: 540px) and (orientation: landscape)` for
rotated phones.

### The phone budget: the game gets ~75% of the screen

Measured at 390x844: stage **630px, 75% of the viewport** (it was 366px / 43%). What paid
for it, in order of how much each returned:

1. **Dropping `aspect-ratio` from `.board-stage`.** This was the binding constraint, not the
   dvh cap: a 366px-wide column pinned the height to 366 and the `58dvh` (~489px) ceiling
   never applied. The height is now solved from the viewport:
   `calc(100svh - var(--topbar-h) - 150px)`.
2. **`svh`, not `dvh`.** `dvh` changes continuously while the URL bar collapses, and every
   game's `resize()` reallocates its canvas backing store and recomputes its cached layout
   on each frame of that animation — mid-round. `svh` is the smallest stable viewport, so
   the stage is sized once and never re-lays-out. Same reasoning as the modal sheet's `88svh`.
3. **The seven tools became a bottom sheet** (`#btn-more`), taking the header from two rows
   (112px) to one (64px).
4. **The recent-results rail is hidden** — 64px directly above the board, and its empty state
   advertised a keyboard ("hit Space to play"). The same history lives in the stats modal.

### The tools sheet

`.topbar__actions` is re-presented as a fixed bottom sheet below 720px. The seven buttons are
**not duplicated** — same markup, same handlers, only presentation changes. Three traps, all
of which bit during implementation:

- **`.topbar` is `position: sticky; z-index: 60`, which is a stacking context.** A fixed
  descendant can never rise above 60 globally however large its own z-index, so the sheet
  painted *under* the Drop bar (80) and the cheat panel (70) — both of which sit exactly
  where it opens. `body.tools-open .topbar { z-index: 90 }` lifts the whole context. 90 and
  not more: modals are 100 and every tool in the sheet opens one.
- **The scrim must be a body-level element**, not a `.topbar` child, for the same reason.
- **Close-on-select is delegated to the nav**, not attached per button. Four of the tools
  open a modal, and a sheet left open would paint over the dialog it just launched.

### `--topbar-h` is a MEASUREMENT, not a preference

`.controls` sticky top, the lobby toolbar and the landscape stage height are all
`calc(... var(--topbar-h) ...)`. The token is set per breakpoint to the header's real
rendered height (66 / 76 / 64, each verified to within the 1px border). **Change anything
in the header and re-measure it in the browser** — a token that drifts from reality
misaligns every sticky offset in the app silently, which is the regression §10 exists for.
That is also why the tools cluster scrolls rather than wraps above 720px: a wrap grows the
header invisibly, an overflow does not. Note the token and everything that makes the header
one row live in the SAME block: splitting them once left 521-720px rendering a one-row
header while every offset still assumed the two-row 76px token.

### The bug class that produced almost every overflow found here

**A flex item cannot shrink below its automatic minimum size.** Five separate horizontal
overflows in this pass were the same bug wearing different hats:

- `.layout { align-items: start }` (written for the grid) became `flex-start` in the
  ≤1080px column flex box, so children sized to **max-content** instead of stretching —
  twist, keno and mines pushed a 463px canvas out of a 390px viewport. Fixed with
  `align-items: stretch` + `min-width: 0` on the children.
- `.game-nav` had `overflow-x: auto` but no `min-width: 0`, so eleven tabs (1007px) shoved
  the document 601px sideways at 1440px instead of scrolling.
- `.lobby-toolbar` kept `flex-wrap: wrap` when it flipped to a column: in a WRAPPING
  container each line's cross size comes from its own items, so `align-items: stretch`
  stretched the search field to its 391px max-content, not the 336px container.
- `.lobby-search .input` — an `<input>` has a default `size`, so its min-content is ~380px
  and no parent can stretch it smaller. Needs `min-width: 0`.
- `.cheat-grid` used `margin-inline: auto` to centre: an auto cross-axis margin overrides
  `stretch`, the item falls back to content width, and `1fr` tracks with no intrinsic cell
  size collapsed a 5×5 board to **1px cells**. Use `align-self: center` + an explicit width.

If something overflows, the answer is almost always `min-width: 0`, `align-self` instead of
an auto margin, or `nowrap`. Verify with a walk over every element comparing
`getBoundingClientRect().right` against `documentElement.clientWidth` — but §10.13 still
applies: check `scrollWidth` before believing it, because an element clipped by an
`overflow:hidden` ancestor (or living inside a deliberate swipe strip) is a false positive.

### The fixed bottom action bar

`#btn-drop` goes `position: fixed` for the whole stacked regime, not just phones — the
moment the layout stacks, the bet button sits below the stage (measured y=1308 on a
1024×768 tablet). Two traps:

1. **`.panel` sets `backdrop-filter`**, and a non-`none` backdrop-filter makes an element a
   containing block for fixed descendants. Leave it on and the button pins to the bottom of
   the controls panel instead of the screen — it looks almost right and fails exactly where
   you cannot see it. `.controls { backdrop-filter: none }` is in the same block for that
   reason (and is the cheapest perf win on a phone GPU).
2. **Everything anchored to the bottom must clear it**: toasts, the cheat panel dock
   (css/gamdom.css) and the in-round action dock below. Add a new bottom-anchored element
   and it must join that list.

### The in-round action dock — the bet bar alone was not enough

A fixed bet bar gets you *into* a round. It does nothing for the decision the round is then
waiting on: Hit / Stand / Double, Higher / Lower / Same and every Cash Out live in
`.game-ctrl-pane`, inside `.controls`, **below** a 630px stage. On a phone that meant
scrolling the whole board away to answer the game — the complaint that produced this section.

`.pane-actions` is the subset of a control pane a player needs DURING a round. Below 1080px
it is `position: fixed` directly above the bet bar. Settings (mines count, target multiplier,
rows/risk, auto-cashout) deliberately stay in the panel — they are set once, not per decision.

- **No DOM moves and no duplicate markup.** The same buttons keep the same handlers; only
  their box changes. Inactive panes are `display: none`, so only one dock can ever render —
  that is what makes a bare `.pane-actions` selector safe.
- **Row where there is width, column on a portrait phone.** Three chips plus a Cash Out do
  not fit a 366px line at 44px targets; above 720px they do, and a one-row dock costs the
  board 55px less.
- **The stage must end above the DOCK, not above the bar.** Two `:has()` tiers subtract the
  dock's real height (one-row games, then hilo's two-row dock). Without it the board ran
  under the buttons — measured at both 390×844 and 1024×768.
- `:has()` is the mechanism, and its failure mode is graceful: without it the dock overlays
  the top of the board footer, which is a stats strip.

**Crash has no dock and needs none — the bet bar IS its cash-out.** `playCrash()` cashes out
when the round is running, so the label has to follow the state: `renderDropButton()` now
resolves the label through one `primaryLabel()` helper and is re-run when a crash round
starts (AFTER the `await` — `startRound()` awaits the HMAC before it calls
`setState('running')`, so a synchronous render reads the old state) and from `onCashout` /
`onCrash` when it ends. That helper also fixed a standing bug: `renderDropButton()` used to
hardcode `'Drop Ball'` in manual mode and clobbered whatever label `selectGame()` had just
written, so changing the bet on the mines tab relabelled the button "Drop Ball".

### Per-game canvas contract

Every module's `resize()` now obeys four rules. A twelfth game must too:

1. **Never floor the canvas above its host.** `Math.max(320, rect.width)` on a 296px host
   pushes the canvas out of the viewport. Clamp down, never up.
2. **A 0×0 host is a no-op return, never a fallback size.** A hidden pane measures 0; the
   old `rect.width ? rect.width : 900` sized the canvas to 900 and then fed that back as the
   host's max-content width. Keep the previous size — the ResizeObserver and `enterGame()`'s
   rAF resize fire again once the pane is visible.
3. **ResizeObserver on the host**, disconnected on teardown, alongside the window listener.
4. **Clear hover on `pointerup` / `pointercancel`.** Touch never fires `pointerleave`, so a
   tapped tile stays visually hovered forever. Skip `pointerType === 'mouse'` so a desktop
   click doesn't drop the highlight.

Every drawing constant is derived from the live canvas size, computed in `resize()` and
cached — never per frame.

**Scale off the BOX, not off `min(w, h)`.** The phone stage is now ~366×630, aspect **0.57**.
A scalar keyed on the short axis reads a 630px-tall stage as if it were the 366px square it
replaced, and captions itself at the small-stage floor. The pattern that works, used by
every module here, is a geometric blend — `sqrt((w/refW) * (h/refH))`, leashed so a landscape
sliver cannot inflate it — for TYPE, with the short axis still driving radial geometry.

**Spend the surplus, do not centre it.** A layout that solves off `min(w, h)` and centres
leaves ~260px of dead air on a phone. Each module now allocates leftover height explicitly,
in a stated priority order, so nothing floats in a void.

**A horizontal-core game must not stretch to fill height.** Crash's curve, roulette's strip
and limbo's rail read left-to-right; filling a 0.57 box with them makes them worse, not
bigger. Those three cap their primary element's aspect and spend the surplus on HUD that had
nowhere to live — and because the DOM results rail is hidden below 720px, crash and roulette
now draw their own recent-results strip, which is the only place a phone player sees history.

Targets are 296×354 through 1200×760, plus the ~800×200 landscape sliver, which is why
several stages (mines, hilo, twist, keno, roulette) pick between a stacked and a
side-by-side arrangement rather than trusting a single layout.

**In-canvas tap targets are ≥48px** where the canvas is tappable at all — which is only
plinko (bucket bands), keno and mines (tiles). Everything else routes through DOM controls
owned by `app.js`, and a canvas-side shortcut would bypass the credit path (hilo's is the
worked example: a canvas `hilo.cashout()` flips `inGame` first, sending `app.js` down its
`inGame === false` branch and recording a ZERO payout).

`#<game>-stage` mount points are given `width/height: 100%` in styles.css. Without it
`#hilo-stage` and `#blackjack-stage` measured **0×0** (a flex item collapsing against a
100%-sized canvas child), which silently disabled their ResizeObserver — a 0×0 box never
reports a size change.

### Touch specifics

- `.game-stage-view canvas { touch-action: manipulation }` — kills the 300ms tap delay and
  double-tap zoom on every board. Deliberately not `none`: the stage is most of a phone
  screen and `none` would make it unscrollable. No stage uses a canvas drag gesture (dice's
  slider is a sidebar input, confirmed) — add one and that stage needs `none`.
- `body { overscroll-behavior-y: contain }` so a pull-down mid-round cannot reload the page.
- Modals become bottom sheets at ≤520px (`place-items: end stretch`, `sheetIn` keyframes,
  `88svh` — svh not dvh, so the sheet does not resize as the URL bar collapses).
- `env(safe-area-inset-*)` on the topbar, the action bar, the toasts and the lobby gutters.
