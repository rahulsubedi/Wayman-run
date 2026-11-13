// Hand-drawn inline SVG icons (static, trusted strings). All use a 32x32 viewBox.
// Colours are baked in (palette: gold, teal, orange, cream, navy) unless the icon is a glyph
// that should follow `currentColor`.

const svg = (body: string, cls = ''): string =>
  `<svg class="wr-ico ${cls}" viewBox="0 0 32 32" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICONS = {
  coin: svg(
    `<circle cx="16" cy="16" r="13" fill="#ffd23f" stroke="#b86a00" stroke-width="2.4"/>` +
      `<circle cx="16" cy="16" r="9" fill="none" stroke="#ffb300" stroke-width="2"/>` +
      `<path d="M12.2 12.5l2.1 7.4 1.7-5 1.7 5 2.1-7.4" fill="none" stroke="#b86a00" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="M8.5 11a8.6 8.6 0 0 1 5-4.3" fill="none" stroke="#fff6c9" stroke-width="2.2" stroke-linecap="round"/>`,
    'wr-ico-coin',
  ),
  magnet: svg(
    `<path d="M7.5 5v11a8.5 8.5 0 0 0 17 0V5" fill="none" stroke="#17305a" stroke-width="9" stroke-linecap="butt"/>` +
      `<path d="M7.5 5v11a8.5 8.5 0 0 0 17 0V5" fill="none" stroke="#ff4d4d" stroke-width="5.4" stroke-linecap="butt"/>` +
      `<path d="M7.5 4.5v6M24.5 4.5v6" stroke="#eef3fa" stroke-width="5.4"/>` +
      `<path d="M5 4.5h5M22 4.5h5" stroke="#17305a" stroke-width="1.6"/>` +
      `<path d="M7.5 15v1.5a8.5 8.5 0 0 0 4 7.2" fill="none" stroke="#ff9a8f" stroke-width="1.6" stroke-linecap="round"/>`,
    'wr-ico-magnet',
  ),
  shield: svg(
    `<path d="M16 2.8 27 6.8v8.4c0 6.6-4.4 10.9-11 14-6.6-3.1-11-7.4-11-14V6.8z" fill="#17c3b2" stroke="#0b4a58" stroke-width="2.4" stroke-linejoin="round"/>` +
      `<path d="M16 6.2 23.6 9v6.2c0 4.8-3 8-7.6 10.4V6.2z" fill="#0fa89b"/>` +
      `<path d="M9.6 10.5 16 8.2" fill="none" stroke="#a9fff2" stroke-width="2" stroke-linecap="round"/>` +
      `<path d="m16 11.2 1.7 3.4 3.7.5-2.7 2.6.7 3.7-3.4-1.8-3.4 1.8.7-3.7-2.7-2.6 3.7-.5z" fill="#fff3d6"/>`,
    'wr-ico-shield',
  ),
  rocket: svg(
    `<path d="M13 22.5 9.6 26.6l3.2-.5.8 3 2.4-4.4z" fill="#ffb300" stroke="#b84e00" stroke-width="1.4" stroke-linejoin="round"/>` +
      `<path d="M19 22.5l3.4 4.1-3.2-.5-.8 3-2.4-4.4z" fill="#ffb300" stroke="#b84e00" stroke-width="1.4" stroke-linejoin="round"/>` +
      `<path d="M16 2c4.8 4 6.4 9.6 5.6 17.4H10.4C9.6 11.6 11.2 6 16 2z" fill="#fff3d6" stroke="#17305a" stroke-width="2.2" stroke-linejoin="round"/>` +
      `<path d="M10.4 14.5 6.6 21l4 1.2zM21.6 14.5 25.4 21l-4 1.2z" fill="#ff8a1f" stroke="#17305a" stroke-width="2" stroke-linejoin="round"/>` +
      `<path d="M10.8 19.4h10.4v2.6H10.8z" fill="#ff8a1f" stroke="#17305a" stroke-width="1.6" stroke-linejoin="round"/>` +
      `<circle cx="16" cy="11.6" r="3" fill="#17c3b2" stroke="#17305a" stroke-width="1.8"/>`,
    'wr-ico-rocket',
  ),
  x2: svg(
    `<circle cx="16" cy="16" r="13" fill="#ff8a1f" stroke="#a63f00" stroke-width="2.4"/>` +
      `<path d="M7.6 11 14 20.2M14 11 7.6 20.2" stroke="#fff3d6" stroke-width="3.4" stroke-linecap="round"/>` +
      `<path d="M17.2 14.4c0-3 2-4.2 4.1-4.2s4.1 1.2 4.1 3.6c0 3.8-8 4.6-8 9h8.2" fill="none" stroke="#fff3d6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" transform="translate(-0.4 1.4) scale(0.94)"/>`,
    'wr-ico-x2',
  ),
  star: svg(
    `<path d="m16 2.8 3.9 8.1 8.9 1.2-6.5 6.2 1.7 8.8L16 22.7l-8 4.4 1.7-8.8-6.5-6.2 8.9-1.2z" fill="#ffd23f" stroke="#b86a00" stroke-width="2.2" stroke-linejoin="round"/>` +
      `<path d="m12.2 11.2 3.8-5" fill="none" stroke="#fff6c9" stroke-width="2" stroke-linecap="round"/>`,
    'wr-ico-star',
  ),
  pause: svg(`<rect x="7.5" y="6" width="6" height="20" rx="2.2" fill="currentColor"/><rect x="18.5" y="6" width="6" height="20" rx="2.2" fill="currentColor"/>`),
  play: svg(`<path d="M10 5.6v20.8a1.6 1.6 0 0 0 2.4 1.4l17-10.4a1.6 1.6 0 0 0 0-2.8L12.4 4.2A1.6 1.6 0 0 0 10 5.6z" fill="currentColor" transform="translate(-3 0)"/>`),
  soundOn: svg(
    `<path d="M4 12h5.2L16 6v20l-6.8-6H4z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>` +
      `<path d="M20 11.5a6.2 6.2 0 0 1 0 9M23.4 8a11 11 0 0 1 0 16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>`,
  ),
  soundOff: svg(
    `<path d="M3 12h5.2L15 6v20l-6.8-6H3z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>` +
      `<path d="M20 12l8 8M28 12l-8 8" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/>`,
  ),
  home: svg(
    `<path d="M16 4.5 3.5 15.2h3.6V27h6.1v-7.2h5.6V27h6.1V15.2h3.6z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>`,
  ),
  restart: svg(
    `<path d="M26 16a10 10 0 1 1-3.2-7.3" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/>` +
      `<path d="M25.6 3.6v7.6h-7.6z" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`,
  ),
  arrow: svg(`<path d="M16 4 28 17h-7.4v11H11.4V17H4z" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`),
  parcel: svg(
    `<path d="M3.5 10.5 16 5l12.5 5.5v13L16 29 3.5 23.5z" fill="#ffb15c" stroke="#17305a" stroke-width="2.2" stroke-linejoin="round"/>` +
      `<path d="M3.5 10.5 16 16l12.5-5.5M16 16v13" fill="none" stroke="#17305a" stroke-width="2.2" stroke-linejoin="round"/>` +
      `<path d="M9.8 7.8 22.2 13.4v4.2L9.8 12z" fill="#17c3b2" stroke="#17305a" stroke-width="1.8" stroke-linejoin="round"/>`,
    'wr-ico-parcel',
  ),
} as const;

export type IconName = keyof typeof ICONS;
