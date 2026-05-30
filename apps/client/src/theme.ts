/**
 * Central dark palette. Components reference these tokens from their inline
 * styles so the whole app shares one consistent dark theme. Global element
 * defaults (body, inputs, scrollbars) live in index.css.
 */
export const theme = {
  bg: '#1a1a1d', // app background
  bgElevated: '#242428', // cards, sidebar, modal
  bgInput: '#2a2a30',
  bgHover: '#2e2e34',
  bgActive: '#332f55', // accent-tinted selection
  border: '#34343a',
  borderStrong: '#44444c',
  text: '#e6e6e8',
  textMuted: '#9a9aa2',
  textFaint: '#6f6f78',
  accent: '#6366f1', // indigo
  accentHover: '#7c7ff3',
  dangerBg: '#3a1f22',
  dangerText: '#f0a8a8',
} as const;

export const fontStack = 'Inter, system-ui, sans-serif';
