/**
 * Pre-paint appearance bootstrap.
 *
 * This classic, parser-blocking script runs before the stylesheets. It applies
 * the persisted appearance to <html> before the first visible paint, then
 * exposes the small runtime API used by js/theme.js. It intentionally owns no
 * component markup and has no dependency on the application module graph.
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'nours.theme.v1';
  const DEFAULT_THEME = 'default';
  const THEMES = Object.freeze(['default', 'oled']);
  const THEME_COLORS = Object.freeze({
    default: '#0f172a',
    oled: '#000000',
  });
  const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

  let currentTheme = DEFAULT_THEME;
  let transitionTimer = 0;

  const isTheme = (value) => THEMES.includes(value);
  const normalizeTheme = (value) => (isTheme(value) ? value : DEFAULT_THEME);

  function storage() {
    try {
      return globalThis.localStorage || null;
    } catch {
      return null;
    }
  }

  function readStoredTheme() {
    const store = storage();
    if (!store) return DEFAULT_THEME;
    try {
      const stored = store.getItem(STORAGE_KEY);
      if (stored == null) return DEFAULT_THEME;
      if (isTheme(stored)) return stored;
      // Stale or future values must never strand the interface in an unknown
      // theme. Removing the bad value also prevents the same fallback on every
      // subsequent navigation and reload.
      store.removeItem(STORAGE_KEY);
      return DEFAULT_THEME;
    } catch {
      return DEFAULT_THEME;
    }
  }

  function writeStoredTheme(theme) {
    const store = storage();
    if (!store) return false;
    try {
      store.setItem(STORAGE_KEY, theme);
      return true;
    } catch {
      return false;
    }
  }

  function prefersReducedMotion() {
    try {
      return globalThis.matchMedia?.(REDUCED_MOTION)?.matches === true;
    } catch {
      return false;
    }
  }

  function updateThemeColor(theme) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLORS[theme]);
  }

  function startThemeTransition() {
    const root = document.documentElement;
    if (prefersReducedMotion()) return;
    clearTimeout(transitionTimer);
    root.classList.add('theme-switching');
    transitionTimer = globalThis.setTimeout(() => {
      root.classList.remove('theme-switching');
      transitionTimer = 0;
    }, 220);
  }

  function applyTheme(theme, options = {}) {
    const next = normalizeTheme(theme);
    const previous = currentTheme;
    const changed = previous !== next;

    if (changed && options.transition !== false) startThemeTransition();

    currentTheme = next;
    const root = document.documentElement;
    root.dataset.theme = next;
    root.style.colorScheme = 'dark';
    updateThemeColor(next);

    if (changed || options.announce === true) {
      globalThis.dispatchEvent(new CustomEvent('nours:themechange', {
        detail: {
          theme: next,
          previous,
          source: options.source || 'runtime',
          persisted: options.persisted ?? null,
        },
      }));
    }

    return next;
  }

  currentTheme = readStoredTheme();
  const root = document.documentElement;
  root.dataset.theme = currentTheme;
  root.style.colorScheme = 'dark';
  // The external stylesheet is render-blocking, but priming the root canvas
  // still protects slow disks/WebViews from ever exposing the browser default.
  // The inline value is removed after the first styled frame so print rules and
  // normal theme tokens retain full control afterward.
  root.style.backgroundColor = THEME_COLORS[currentTheme];
  updateThemeColor(currentTheme);

  // Mark initialization complete only after the parser has had a paint
  // opportunity. CSS transitions are scoped to .theme-switching, so this is
  // metadata for QA and future controls rather than a first-load animation.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      root.style.removeProperty('background-color');
      root.dataset.themeReady = 'true';
    });
  });

  const api = Object.freeze({
    storageKey: STORAGE_KEY,
    themes: THEMES,
    themeColors: THEME_COLORS,

    getTheme() {
      return currentTheme;
    },

    setTheme(theme, options = {}) {
      const next = normalizeTheme(theme);
      const shouldPersist = options.persist !== false;
      const persisted = shouldPersist ? writeStoredTheme(next) : null;
      applyTheme(next, {
        transition: options.transition !== false,
        source: options.source || 'user',
        persisted,
        announce: options.announce === true,
      });
      return { theme: next, persisted };
    },

    applyTheme(theme, options = {}) {
      return applyTheme(theme, {
        transition: options.transition !== false,
        source: options.source || 'runtime',
        persisted: options.persisted ?? null,
        announce: options.announce === true,
      });
    },

    isTheme,
  });

  Object.defineProperty(globalThis, 'NoursTheme', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: api,
  });

  globalThis.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    const next = normalizeTheme(event.newValue);
    applyTheme(next, {
      transition: true,
      source: 'storage',
      persisted: true,
    });
  });
})();
