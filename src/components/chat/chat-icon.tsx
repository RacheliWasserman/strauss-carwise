import type { CSSProperties } from 'react';

const paths = {
  plus: 'M12 5v14M5 12h14',
  arrow: 'M12 19V5m-6 6 6-6 6 6',
  chevron: 'm14 7-5 5 5 5',
  chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1 1V11.5a9 9 0 0 1 18 0ZM8 10h8m-8 4h5',
  car: 'm5 10 2-5h10l2 5M3 10h18v8H3zm3 8v2m12-2v2M6 14h2m8 0h2',
  compare: 'M4 4h6v16H4zm10 0h6v16h-6M6 8h2m8 4h2M6 12h2m8 4h2',
  wallet: 'M20 7H5a2 2 0 0 1 0-4h13v4M3 5v14a2 2 0 0 0 2 2h15V7m-5 5h6v5h-6z',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zm-4 9 3 3 5-6',
  spark: 'm12 2 2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
  retry: 'M20 7v5h-5M4 17v-5h5m-4.5-3a8 8 0 0 1 13-4L20 8M4 16l2.5 3A8 8 0 0 0 19.5 15',
  copy: 'M9 9h12v12H9zM5 15H3V3h12v2',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9v-2a7 7 0 0 1 14 0v2',
  clock: 'M12 8v5l3 2m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  down: 'M12 5v14m-6-6 6 6 6-6',
  route: 'M6 20h9a5 5 0 0 0 0-10H9a4 4 0 0 1 0-8h9M6 17v6M18 0v5',
  document: 'M14 3H6v18h12V7zm0 0v4h4M9 12h6m-6 4h6',
  upload: 'M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4',
  // Catalog (Lucide-style strokes, same 24px grid).
  zap: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
  leaf: 'M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10ZM2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12',
  plug: 'M12 22v-5M9 8V2m6 6V2m3 6v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z',
  fuel: 'M3 22h12M4 9h10m0 13V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18m10-9h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0V9.8a2 2 0 0 0-.6-1.4L18 5',
  layers: 'm12 2 10 5-10 5L2 7zm-10 10 10 5 10-5M2 17l10 5 10-5',
  factory: 'M2 20h20M4 20V10l6 4v-4l6 4V4h4v16M8 17h2m4 0h2',
  search: 'm21 21-4.3-4.3M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14',
  image: 'M3 3h18v18H3zm5.5 7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M21 15l-5-5L5 21',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m7-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8m13 10v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20m0-6v-4m0-4h.01',
  forward: 'M19 12H5m7 7-7-7 7-7',
  calculator: 'M5 2h14v20H5zm3 4h8M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h4',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0',
  reset: 'M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5'
};
export type ChatIconName = keyof typeof paths;
export function ChatIcon({ name, className = '', style }: { name: ChatIconName; className?: string; style?: CSSProperties }) {
  return <svg className={className} style={style} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
export function CarWiseMark({ small = false }: { small?: boolean }) {
  return <span className={`cw-mark ${small ? 'cw-mark-small' : ''}`} aria-hidden="true"><svg viewBox="0 0 40 40" fill="none"><path d="m9 13 6 15 5-10 5 10 6-15" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" /><circle cx="31" cy="10" r="3" fill="currentColor" /></svg></span>;
}
