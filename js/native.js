/**
 * ============================================================================
 * Native shell bridge — the only file under js/ that knows Capacitor exists
 * ============================================================================
 *
 * This project has no build step: `index.html` loads `js/app.js` as a module
 * and every import is a real, relative URL the browser fetches itself. A bare
 * npm specifier — importing the haptics plugin by package name — would 404 over
 * plain HTTP and take the whole app down with it. Capacitor's native runtime
 * injects `capacitor.js` ahead of our modules and registers every plugin on
 * `window.Capacitor.Plugins`, so the plugins are reached through that global
 * instead — no bundler, no import map, no CDN.
 *
 * Off-native there is no `window.Capacitor` at all: `isNative` is false and
 * both exports return immediately, so `python -m http.server` behaves exactly
 * as it did before this file existed.
 *
 * Two hard rules, both about not being the thing that breaks a round:
 *
 * 1. NEVER let a plugin failure escape. `haptic()` is called from
 *    `recordGenericRound()`, one statement away from the wallet. A missing
 *    plugin, a denied permission or a rejected promise must degrade to "no
 *    buzz" — never to a throw or an unhandled rejection inside a settling
 *    round.
 *
 * 2. NEVER touch round state on a lifecycle event. Per AGENTS.md §5 only
 *    *painting* may be skipped while the app is invisible; gating a game loop
 *    on background freezes a round and strands the player's stake. The resume
 *    handler therefore only unlocks audio — iOS suspends the AudioContext when
 *    the app backgrounds and it does not come back on its own.
 */

/* ------------------------------- Platform ------------------------------- */

/**
 * True when running inside the Capacitor native shell. Resolved once, at module
 * evaluation: the runtime installs the global before our modules execute, so
 * the answer cannot change later in the page's life.
 * @type {boolean}
 */
export const isNative = !!(globalThis.Capacitor?.isNativePlatform?.());

const SPLASH_FADE_MS   = 250;
const FIRST_PAINT_MS   = 1000;            // watchdog: a splash that never hides reads as a hang
const STATUS_BAR_COLOR = '#0f172a';       // app chrome; Android only, iOS throws on setBackgroundColor

/** Shared sink for swallowed rejections — one closure instead of one per call. */
const noop = () => {};

/** @returns {Record<string, any> | undefined} The plugin registry, if any. */
const plugins = () => globalThis.Capacitor?.Plugins;

/**
 * Feedback flavour → Haptics call. `impact` is a physical thump (Light for a
 * press, Heavy for a jackpot); `notification` plays the platform's own
 * success/failure pattern, which reads as far more result-shaped than a buzz.
 * @type {Record<string, { method: string, options: object }>}
 */
const HAPTIC_MAP = {
  tap:  { method: 'impact',       options: { style: 'Light' } },
  win:  { method: 'notification', options: { type: 'SUCCESS' } },
  loss: { method: 'notification', options: { type: 'ERROR' } },
  big:  { method: 'impact',       options: { style: 'Heavy' } },
};

/**
 * Minimum gap between two haptics, in ms.
 *
 * Plinko settles each ball independently and `MAX_BALLS` is 60, so a single auto
 * run can call `haptic('win'|'loss')` sixty times within a couple of seconds.
 * Un-throttled that is not feedback, it is one continuous buzz that outlasts the
 * round. 150ms is short enough that ordinary one-round-at-a-time play never
 * coalesces, and long enough that a multi-ball drop reads as a few taps.
 */
const HAPTIC_MIN_GAP_MS = 150;
let lastHapticAt = 0;

/* -------------------------------- Exports ------------------------------- */

/**
 * Fire a one-shot haptic. Silent no-op off-native, on an unknown kind, when the
 * plugin is unavailable, or when the previous pulse was under
 * `HAPTIC_MIN_GAP_MS` ago — see rule 1 in the header.
 * @param {'tap'|'win'|'loss'|'big'} kind Feedback flavour.
 * @returns {void} Deliberately not a promise: callers must never await this.
 */
export function haptic(kind) {
  if (!isNative) return;
  const spec = HAPTIC_MAP[kind];
  if (!spec) return;

  const now = Date.now();
  if (now - lastHapticAt < HAPTIC_MIN_GAP_MS) return;
  lastHapticAt = now;

  try {
    plugins()?.Haptics?.[spec.method]?.(spec.options)?.catch?.(noop);
  } catch {
    /* No vibrator, revoked permission, plugin never registered: none of those
       are worth a console line on every single round. */
  }
}

/**
 * Configure the native shell — status bar, splash, hardware back, audio resume.
 * Each step is isolated so one unavailable plugin cannot cost us the others.
 * Returns immediately in a browser and never rejects.
 * @returns {Promise<void>}
 */
export async function initNative() {
  if (!isNative) return;

  const platform = globalThis.Capacitor?.getPlatform?.() || 'native';
  document.documentElement.dataset.native = platform;

  /* Fonts are handled at BUILD time, not here — see scripts/build-www.mjs.

     Injecting `css/fonts.css` from JS was tried and rejected: `index.html`'s
     Google Fonts `<link rel="stylesheet">` is render-blocking, and a packaged
     WebView with no network (or behind a captive portal) stalls it for the whole
     DNS/connect timeout. Script execution also waits on pending stylesheets, so
     `initNative()` itself would not run in time to undo it — and because
     `launchAutoHide` is false and the splash hide is gated on `afterFirstPaint()`,
     that reintroduces the never-hiding splash through a second door. The link has
     to be gone before the document is parsed, which only the build can do. */


  /* Opaque dark chrome sitting above the WebView rather than behind it. Verified
     against the linked stylesheets: none of them apply `safe-area-inset-top` to
     the topbar, so a non-overlaying bar is the correct pairing — an overlaying
     one would leave the topbar under the status bar with nothing reserving space. */
  try {
    const statusBar = plugins()?.StatusBar;
    if (statusBar) {
      await statusBar.setStyle({ style: 'DARK' });
      if (platform === 'android') await statusBar.setBackgroundColor({ color: STATUS_BAR_COLOR });
      await statusBar.setOverlaysWebView({ overlay: false });
    }
  } catch (err) {
    console.warn('[native] status bar unavailable', err);
  }

  /* Hold the splash until a real frame has painted, else the player gets a
     flash of unpainted canvas between the splash and the lobby. */
  try {
    const splash = plugins()?.SplashScreen;
    if (splash) {
      await afterFirstPaint();
      await splash.hide({ fadeOutDuration: SPLASH_FADE_MS });
    }
  } catch (err) {
    console.warn('[native] splash screen unavailable', err);
  }

  try {
    plugins()?.App?.addListener('backButton', onBackButton)?.catch?.(noop);
  } catch (err) {
    console.warn('[native] back button unavailable', err);
  }

  try {
    plugins()?.App?.addListener('appStateChange', onAppStateChange)?.catch?.(noop);
  } catch (err) {
    console.warn('[native] lifecycle listener unavailable', err);
  }
}

/* ------------------------------- Listeners ------------------------------ */

/**
 * Hardware back: close the topmost modal, else leave a game for the lobby, else
 * quit. Routed through `window.plinko` rather than the DOM so the app keeps
 * ownership of what "close" and "leave" actually mean — `closeModal()` restores
 * focus and the page scroll lock, which a bare `hidden = true` would not.
 */
function onBackButton() {
  const api = globalThis.plinko;
  const modal = api?.openModals?.()?.pop();   // document order, so last == topmost
  if (modal) { api.closeModal?.(modal); return; }
  if (document.body.dataset.route === 'game') { api?.showLobby?.(); return; }
  plugins()?.App?.exitApp?.();
}

/**
 * Foregrounding only unlocks audio. Nothing here may touch a round: iOS
 * suspends the AudioContext on background, but a round in flight has to keep
 * advancing (AGENTS.md §5) or its stake is stranded.
 * @param {{ isActive?: boolean }} [event] Capacitor `appStateChange` payload.
 */
function onAppStateChange(event) {
  if (!event?.isActive) return;
  globalThis.plinko?.audio?.resume?.()?.catch?.(noop);
}

/**
 * Resolve after two animation frames, i.e. once the first real frame has
 * painted. The timer is a net, not a nicety: a WebView backgrounded during
 * launch never fires rAF, and this promise gates hiding the splash.
 * @returns {Promise<void>}
 */
function afterFirstPaint() {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FIRST_PAINT_MS);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  });
}
