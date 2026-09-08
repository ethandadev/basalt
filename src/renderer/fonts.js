// Finds the fonts installed on this machine so the font picker can offer real
// choices instead of a hard-coded list.

const IS_MAC = navigator.userAgent.includes('Mac OS X');
const IS_WIN = navigator.userAgent.includes('Windows');

// Used when the Local Font Access API is unavailable — these ship with the
// platform or are common developer installs, and anything missing simply falls
// back to the next entry in the stack.
const COMMON = [
  'JetBrains Mono', 'Fira Code', 'IBM Plex Mono', 'Source Code Pro',
  'Cascadia Code', 'Hack', 'Inconsolata', 'Roboto Mono',
];

const FALLBACK = IS_MAC
  ? ['SF Mono', 'Menlo', 'Monaco', 'Courier New', 'Andale Mono', 'PT Mono', ...COMMON, 'Ubuntu Mono']
  : IS_WIN
    ? ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'Lucida Console', 'Courier New', ...COMMON]
    : ['DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono', 'Ubuntu Mono', 'FreeMono',
      'Nimbus Mono PS', 'Courier New', ...COMMON];

// The face every stack ends with before the generic keyword: present by default
// on the platform, so a missing custom font still lands somewhere sensible.
const LAST_RESORT = IS_MAC ? 'Menlo' : IS_WIN ? 'Consolas' : 'DejaVu Sans Mono';

let cache = null;

function measurer() {
  const canvas = document.createElement('canvas');
  return canvas.getContext('2d');
}

// A font is monospaced when every glyph is the same width, so a narrow letter
// and a wide one measure the same.
function isMonospace(context, family) {
  const quoted = `"${family.replace(/"/g, '')}"`;
  context.font = `48px ${quoted}, serif`;
  const narrow = context.measureText('i'.repeat(8)).width;
  const wide = context.measureText('W'.repeat(8)).width;
  return narrow > 0 && Math.abs(narrow - wide) < 0.5;
}

/**
 * @returns {Promise<{monospace: string[], all: string[], source: string}>}
 */
export async function listFonts() {
  if (cache) return cache;

  let families = [];
  let source = 'fallback';

  try {
    if (typeof window.queryLocalFonts === 'function') {
      const fonts = await window.queryLocalFonts();
      families = [...new Set(fonts.map((font) => font.family))];
      source = 'system';
    }
  } catch (_) {
    // Permission refused or the API is missing; the fallback list still works.
  }

  if (!families.length) families = FALLBACK.slice();

  const context = measurer();
  const monospace = families.filter((family) => isMonospace(context, family));

  const sort = (list) => list.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  cache = {
    monospace: sort(monospace.length ? monospace : families),
    all: sort(families),
    source,
  };
  return cache;
}

// The stack Basalt stores: the chosen face, then dependable fallbacks.
export function toStack(family) {
  const first = family.split(',')[0].trim().replace(/^["']|["']$/g, '');
  if (!first) return `${LAST_RESORT}, monospace`;
  const generic = ['monospace', 'serif', 'sans-serif'].includes(first.toLowerCase());
  return generic ? first : `${first}, ${LAST_RESORT}, monospace`;
}

// The face a stored stack refers to, for showing the current value in the UI.
export function primaryFamily(stack) {
  return (stack || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
}
