/**
 * Appearance control binding.
 *
 * The pre-paint script owns persistence and the root data attribute. This module
 * owns only the rendered controls and status copy, keeping the preference logic
 * reusable across the browser and Capacitor shells.
 */

const THEME_LABELS = Object.freeze({
  default: 'Default',
  oled: 'OLED Black',
});

/** @returns {ReturnType<typeof getThemeApi>|null} */
function getThemeApi() {
  const api = globalThis.NoursTheme;
  return api && typeof api.getTheme === 'function' && typeof api.setTheme === 'function'
    ? api
    : null;
}

function syncControls(root, theme) {
  if (!root) return;
  root.querySelectorAll('input[name="appearance-theme"]').forEach((input) => {
    input.checked = input.value === theme;
  });
  root.dataset.activeTheme = theme;
}

/**
 * Bind the canonical appearance selector.
 * @param {object} [options]
 * @param {(detail: {theme:string, previous:string, source:string, persisted:boolean|null}) => void} [options.onChange]
 * @returns {{ getTheme: () => string, setTheme: (theme:string) => object }|null}
 */
export function initThemeControls(options = {}) {
  const api = getThemeApi();
  const root = document.getElementById('appearance-theme');
  if (!api || !root) return null;

  const status = document.getElementById('appearance-theme-status');
  const inputs = Array.from(root.querySelectorAll('input[name="appearance-theme"]'));

  const announce = (message) => {
    if (!status) return;
    status.textContent = '';
    requestAnimationFrame(() => { status.textContent = message; });
  };

  const handleChange = (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'appearance-theme' || !input.checked) return;

    const result = api.setTheme(input.value, { source: 'selector', transition: true });
    syncControls(root, result.theme);
    const label = THEME_LABELS[result.theme] || result.theme;
    announce(result.persisted === false
      ? `${label} applied for this tab. Browser storage is unavailable, so the choice may not persist.`
      : `${label} theme applied.`);
  };

  root.addEventListener('change', handleChange);
  syncControls(root, api.getTheme());

  const handleThemeChange = (event) => {
    const detail = event.detail || {};
    const theme = api.isTheme?.(detail.theme) ? detail.theme : api.getTheme();
    syncControls(root, theme);
    options.onChange?.({
      theme,
      previous: detail.previous || theme,
      source: detail.source || 'runtime',
      persisted: detail.persisted ?? null,
    });
  };

  globalThis.addEventListener('nours:themechange', handleThemeChange);

  return {
    getTheme: () => api.getTheme(),
    setTheme: (theme) => api.setTheme(theme, { source: 'api', transition: true }),
  };
}
