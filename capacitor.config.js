/**
 * Capacitor configuration for Nour's Casino.
 *
 * ─── WHY NAMED EXPORTS AND NOT `export default` ──────────────────────────────
 * Every Capacitor doc shows `export default { … }`. That shape is SILENTLY
 * BROKEN in this project. Do not "fix" it back.
 *
 * `@capacitor/cli@8.4.2` loads a `.js` config with, verbatim
 * (node_modules/@capacitor/cli/dist/config.js, `loadExtConfigJS`):
 *
 *     extConfig: await require(extConfigFilePath),
 *
 * There is no `.default` unwrap — the `.ts` loader three functions above does
 * have one (`extConfigObject.default ? … : extConfigObject`), the `.js` loader
 * does not. Because `package.json` is `"type": "module"`, that `require()`
 * returns the ES module namespace, so `export default {…}` arrives as
 * `{ __esModule: true, default: {…} }` and every key below is invisible to the
 * CLI. It does not warn. It does not fail. `appId` and `appName` resolve to
 * empty strings and the app quietly builds on Capacitor's defaults — including
 * a DIFFERENT localStorage origin, which is the exact catastrophe the warning
 * further down describes.
 *
 * Top-level named exports land directly on that namespace, which is precisely
 * the flat object the CLI wants. `npm run check` asserts this file still
 * resolves the way the CLI reads it, so converting it to `export default` fails
 * the gate instead of silently wiping the config.
 *
 * A `.js` config (rather than `.json`) is worth this quirk for one reason: JSON
 * cannot carry the warning below, and the warning is the most important thing
 * in this file. A `.ts` config would unwrap `export default` correctly but
 * requires adding TypeScript as a devDependency to a project that has no build
 * step — not a trade worth making for comment support.
 */

export const appId = 'com.nourscasino.app';
export const appName = "Nour's Casino";
export const webDir = 'www';

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │  DO NOT CHANGE ANY OF THE THREE KEYS BELOW AFTER LAUNCH.                  │
 * └───────────────────────────────────────────────────────────────────────────┘
 * `androidScheme`, `iosScheme` and `hostname` are what Capacitor assembles the
 * WebView's origin from — `https://localhost` on Android, `capacitor://localhost`
 * on iOS. The entire wallet lives behind that origin: balance, bet, nonce, round
 * history, lifetime stats, provably-fair seed pairs and every saved player
 * profile, stored in `localStorage` under `plinko.session.v1` and
 * `plinko.accounts.v1`. `localStorage` is partitioned BY ORIGIN.
 *
 * Editing any one of these values — even an innocent-looking hostname tweak —
 * moves the origin. The old store is not migrated, not merged and not reported.
 * The app boots to a pristine 1000-credit balance, no profiles and fresh seeds,
 * with no error, no console trace and no way back. Every existing player is
 * silently wiped.
 *
 * They are pinned explicitly here, rather than left to Capacitor's defaults,
 * precisely so the origin is frozen in this repo instead of floating with
 * whatever a future Capacitor release decides its defaults should be. These
 * three values ARE the current defaults, so pinning them changes nothing today
 * and guarantees everything tomorrow.
 */
export const server = {
  androidScheme: 'https',
  iosScheme: 'capacitor',
  hostname: 'localhost',
};

export const android = {
  // The app is entirely local; there is no http:// content to mix in, so refuse it.
  allowMixedContent: false,
  backgroundColor: '#070b12',
};

export const ios = {
  // styles.css owns safe-area padding via env(safe-area-inset-*) — bet bar, toasts,
  // modals and the lobby gutters all inset themselves. Letting the WebView inset as
  // well would double every one of them on notched devices.
  contentInset: 'never',
  backgroundColor: '#070b12',
};

export const plugins = {
  SplashScreen: {
    launchShowDuration: 900,
    // js/native.js hides the splash after the first real paint, so the player
    // never sees an empty stage between splash teardown and canvas ready.
    launchAutoHide: false,
    backgroundColor: '#070b12',
    androidScaleType: 'CENTER_CROP',
    showSpinner: false,
  },
  StatusBar: {
    style: 'DARK',
    backgroundColor: '#0f172a',
  },
};
