/**
 * Íconos propios de OpenAnimator: retícula de 24 px, trazo 1.75, extremos redondeados.
 * Uso: <Icon name="play" size={16} />
 */
import { CSSProperties, ReactElement } from 'react'

const P: Record<string, ReactElement> = {
  // navegación y acciones generales
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  'chevron-up': <path d="M6 15l6-6 6 6" />,
  'chevron-right': <path d="M9 6l6 6-6 6" />,
  'chevron-left': <path d="M15 6l-6 6 6 6" />,
  'arrow-left': <path d="M19 12H5M11 6l-6 6 6 6" />,
  'arrow-up': <path d="M12 19V5M6 11l6-6 6 6" />,
  'arrow-right': <path d="M5 12h14M13 6l6 6-6 6" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></>,
  more: <><circle cx="5.5" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="18.5" cy="12" r="1.2" fill="currentColor" stroke="none" /></>,
  'more-v': <><circle cx="12" cy="5.5" r="1.2" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="12" cy="18.5" r="1.2" fill="currentColor" stroke="none" /></>,
  folder: <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l2 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />,
  'folder-open': <path d="M3.5 17.5V7.5A1.5 1.5 0 0 1 5 6h4.2l2 2H18a1.5 1.5 0 0 1 1.5 1.5V11M3.5 17.5l2.3-5.6A1.5 1.5 0 0 1 7.2 11H20a1 1 0 0 1 .9 1.4l-2.3 5.7a1.5 1.5 0 0 1-1.4.9H5a1.5 1.5 0 0 1-1.5-1.5z" />,
  import: <><path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5" /><path d="M4 15.5v2A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5v-2" /></>,
  export: <><path d="M12 15V4M7.5 8.5L12 4l4.5 4.5" /><path d="M4 14.5v3A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5v-3" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 14.6a1.5 1.5 0 0 0 .3 1.7l.1.1a1.8 1.8 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-1.7-.3 1.5 1.5 0 0 0-.9 1.4v.2a1.8 1.8 0 1 1-3.6 0v-.1a1.5 1.5 0 0 0-1-1.4 1.5 1.5 0 0 0-1.7.3l-.1.1a1.8 1.8 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0 .3-1.7 1.5 1.5 0 0 0-1.4-.9h-.2a1.8 1.8 0 1 1 0-3.6h.1a1.5 1.5 0 0 0 1.4-1 1.5 1.5 0 0 0-.3-1.7l-.1-.1a1.8 1.8 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 .9-1.4v-.2a1.8 1.8 0 1 1 3.6 0v.1a1.5 1.5 0 0 0 .9 1.4 1.5 1.5 0 0 0 1.7-.3l.1-.1a1.8 1.8 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0-.3 1.7v.1a1.5 1.5 0 0 0 1.4.9h.2a1.8 1.8 0 1 1 0 3.6h-.1a1.5 1.5 0 0 0-1.4.9z" /></>,
  grid: <><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></>,
  list: <path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />,
  edit: <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17zM14 7l3 3" />,
  copy: <><rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" /><path d="M15.5 8.5V6A2 2 0 0 0 13.5 4H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" /></>,
  trash: <path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2" />,
  external: <path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />,
  refresh: <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.2h-4.2" />,
  home: <path d="M4 10.5L12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z" />,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.8h.01" /></>,
  alert: <path d="M12 4.5l8.5 15h-17zM12 10v4.5M12 17.2h.01" />,
  'check-circle': <><circle cx="12" cy="12" r="8.5" /><path d="M8.3 12.3l2.5 2.5 5-5.3" /></>,
  'x-circle': <><circle cx="12" cy="12" r="8.5" /><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" /></>,
  help: <><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.5a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.2-2.4 3.7M12 17.2h.01" /></>,
  keyboard: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M10.3 10h.01M13.7 10h.01M17 10h.01M7 13.8h.01M17 13.8h.01M9.5 13.8h5" /></>,
  palette: <><path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.1 0 1.6-.9 1.2-1.8-.5-1-.1-2.2 1.1-2.2h2.2a3.5 3.5 0 0 0 3.5-3.5c0-5.3-3.8-9.5-8-9.5z" /><circle cx="7.8" cy="11.5" r="1" fill="currentColor" stroke="none" /><circle cx="10.5" cy="7.8" r="1" fill="currentColor" stroke="none" /><circle cx="15" cy="8.3" r="1" fill="currentColor" stroke="none" /></>,
  sliders: <path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4" />,
  monitor: <><rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M8.5 20h7M12 16.5V20" /></>,
  cpu: <><rect x="6.5" y="6.5" width="11" height="11" rx="1.5" /><rect x="9.5" y="9.5" width="5" height="5" rx=".6" /><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3" /></>,
  gpu: <><rect x="3" y="7" width="18" height="10" rx="1.5" /><circle cx="9" cy="12" r="2.4" /><circle cx="15.5" cy="12" r="2.4" /><path d="M5 17v2.5M8 17v2.5" /></>,
  drive: <><rect x="3.5" y="13" width="17" height="6.5" rx="1.5" /><path d="M3.5 14.5L6 5.5a1.5 1.5 0 0 1 1.4-1h9.2a1.5 1.5 0 0 1 1.4 1l2.5 9M16.5 16.3h.01" /></>,
  zap: <path d="M13 3.5L5 13.5h6.5L10.5 20.5l8.5-10.5h-6.5z" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  history: <><path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5" /><path d="M4 4v4.5h4.5M12 8v4.2l2.8 1.8" /></>,
  bell: <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5a2.2 2.2 0 0 0 4 0" />,
  shield: <path d="M12 3.5l7 2.8v5.3c0 4.2-2.9 7.6-7 8.9-4.1-1.3-7-4.7-7-8.9V6.3z" />,
  gauge: <><path d="M4.2 17a8.5 8.5 0 1 1 15.6 0" /><path d="M12 13.5l3.8-4.3" /><circle cx="12" cy="14" r="1.3" /></>,
  layers: <path d="M12 4l8.5 4.5L12 13 3.5 8.5zM3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5" />,
  template: <><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M3.5 9h17M9.5 9v11" /></>,
  sparkles: <><path d="M10 3.5l1.6 4.4a2 2 0 0 0 1.2 1.2l4.4 1.6-4.4 1.6a2 2 0 0 0-1.2 1.2L10 17.9l-1.6-4.4a2 2 0 0 0-1.2-1.2L2.8 10.7l4.4-1.6a2 2 0 0 0 1.2-1.2z" /><path d="M18 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8zM18.5 3l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4L16.5 5l1.4-.6z" /></>,
  brain: <><path d="M9 4.5a3 3 0 0 0-3 3v.2A3 3 0 0 0 4 10.5a3 3 0 0 0 1 2.3 3 3 0 0 0 1.5 5.2A2.5 2.5 0 0 0 9 20.5a2.5 2.5 0 0 0 3-2.4V6.8a2.3 2.3 0 0 0-3-2.3z" /><path d="M15 4.5a3 3 0 0 1 3 3v.2a3 3 0 0 1 2 2.8 3 3 0 0 1-1 2.3 3 3 0 0 1-1.5 5.2A2.5 2.5 0 0 1 15 20.5a2.5 2.5 0 0 1-3-2.4V6.8a2.3 2.3 0 0 1 3-2.3z" /></>,
  bot: <><rect x="4.5" y="8" width="15" height="11" rx="3" /><path d="M12 4.5V8M9 13h.01M15 13h.01M2.5 13v2M21.5 13v2" /></>,
  send: <path d="M12 19V5.5M6.5 11L12 5.5l5.5 5.5" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
  paperclip: <path d="M20 11.5l-7.6 7.6a4.6 4.6 0 0 1-6.5-6.5L13.5 5a3 3 0 0 1 4.3 4.3l-7.6 7.6a1.5 1.5 0 0 1-2.2-2.2l7-7" />,
  terminal: <><rect x="3" y="4.5" width="18" height="15" rx="2" /><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5" /></>,
  message: <path d="M5 18.5V6.5A1.5 1.5 0 0 1 6.5 5h11A1.5 1.5 0 0 1 19 6.5v8a1.5 1.5 0 0 1-1.5 1.5H8.5z" />,
  note: <><path d="M5 18.5V6.5A1.5 1.5 0 0 1 6.5 5h11A1.5 1.5 0 0 1 19 6.5v8a1.5 1.5 0 0 1-1.5 1.5H8.5z" /><path d="M12 8v5M9.5 10.5h5" /></>,
  lightbulb: <path d="M9 18h6M10 21h4M12 3.5a6 6 0 0 0-3.5 10.9V16h7v-1.6A6 6 0 0 0 12 3.5z" />,
  wand: <><path d="M4 20L15 9M13 7l4 4" /><path d="M18 3l.6 1.4L20 5l-1.4.6L18 7l-.6-1.4L16 5l1.4-.6zM20 11l.4.9.9.4-.9.4-.4.9-.4-.9-.9-.4.9-.4zM9 3l.4.9.9.4-.9.4L9 5.6l-.4-.9-.9-.4.9-.4z" /></>,
  // medios
  film: <><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M7.5 4v16M16.5 4v16M3.5 8h4M3.5 12h4M3.5 16h4M16.5 8h4M16.5 12h4M16.5 16h4" /></>,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="9.5" r="1.8" /><path d="M20.5 15.5l-4.5-4.5-9 8.5" /></>,
  music: <><path d="M9 17.5V5.5l11-2v12" /><circle cx="6.5" cy="17.5" r="2.5" /><circle cx="17.5" cy="15.5" r="2.5" /></>,
  code: <path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5l-3 14" />,
  file: <><path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z" /><path d="M14 3.5V8h4.5" /></>,
  video: <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10.5l5-3v9l-5-3" /></>,
  mic: <><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" /></>,
  wave: <path d="M3 12h1.5M6.5 8v8M9.5 5v14M12.5 9v6M15.5 6.5v11M18.5 10v4M21 12h.01" />,
  // reproducción
  play: <path d="M8 5.5v13a.8.8 0 0 0 1.2.7l10.3-6.5a.8.8 0 0 0 0-1.4L9.2 4.8A.8.8 0 0 0 8 5.5z" fill="currentColor" />,
  pause: <><rect x="6.5" y="5" width="3.8" height="14" rx="1" fill="currentColor" /><rect x="13.7" y="5" width="3.8" height="14" rx="1" fill="currentColor" /></>,
  'skip-back': <><path d="M18 6v12l-8.5-6z" fill="currentColor" /><path d="M6 5.5v13" /></>,
  'skip-fwd': <><path d="M6 6v12l8.5-6z" fill="currentColor" /><path d="M18 5.5v13" /></>,
  'step-back': <path d="M14.5 6.5L9 12l5.5 5.5" />,
  'step-fwd': <path d="M9.5 6.5L15 12l-5.5 5.5" />,
  repeat: <path d="M17 3.5l3 3-3 3M20 6.5H8.5A4.5 4.5 0 0 0 4 11v.5M7 20.5l-3-3 3-3M4 17.5h11.5A4.5 4.5 0 0 0 20 13v-.5" />,
  volume: <><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></>,
  'volume-x': <><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" /><path d="M16 9.5l5 5M21 9.5l-5 5" /></>,
  headphones: <><path d="M4 16v-3.5a8 8 0 0 1 16 0V16" /><rect x="3.5" y="14" width="4" height="6" rx="1.5" /><rect x="16.5" y="14" width="4" height="6" rx="1.5" /></>,
  // edición
  scissors: <><circle cx="6.5" cy="6.5" r="2.7" /><circle cx="6.5" cy="17.5" r="2.7" /><path d="M8.6 8.3L20 18M8.6 15.7L20 6" /></>,
  undo: <path d="M9 14.5l-5-5 5-5M4 9.5h10a6 6 0 0 1 0 12h-3" />,
  redo: <path d="M15 14.5l5-5-5-5M20 9.5H10a6 6 0 0 0 0 12h3" />,
  magnet: <path d="M5 4.5h4.5v7a2.5 2.5 0 0 0 5 0v-7H19v7a7 7 0 0 1-14 0zM5 8.5h4.5M14.5 8.5H19" />,
  'zoom-in': <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2M11 8.5v5M8.5 11h5" /></>,
  'zoom-out': <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2M8.5 11h5" /></>,
  fit: <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>,
  'eye-off': <><path d="M10 5.8a9.5 9.5 0 0 1 2-.3c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.4 3.2M6.6 6.6A16 16 0 0 0 2.5 12s3.5 6.5 9.5 6.5a9 9 0 0 0 5.4-1.6" /><path d="M4 4l16 16M10 10a2.8 2.8 0 0 0 4 4" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
  unlock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 7.7-1.5" /></>,
  camera: <><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.5-2h5.4l1.5 2h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" /><circle cx="12" cy="12.8" r="3.3" /></>,
  scan: <><path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5" /><path d="M7.5 12h9" /></>,
  'safe-area': <><rect x="3.5" y="5" width="17" height="14" rx="1.5" /><rect x="6.5" y="7.8" width="11" height="8.4" rx=".5" strokeDasharray="2 2" /></>,
  thirds: <><rect x="3.5" y="5" width="17" height="14" rx="1.5" /><path d="M9.2 5v14M14.8 5v14M3.5 9.7h17M3.5 14.3h17" /></>,
  'split-v': <><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M14.5 4v16" /></>,
  sidebar: <><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M9.5 4v16" /></>,
  flag: <path d="M5.5 20.5V4.5M5.5 5h11l-2 4 2 4h-11" />,
  target: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r=".8" fill="currentColor" /></>,
  cursor: <path d="M5.5 4l13 6-5.6 1.9L11 17.5z" />,
  hash: <path d="M9.5 4l-2 16M16.5 4l-2 16M4.5 9h16M3.5 15h16" />,
  sort: <path d="M7 4.5v15M4 16.5l3 3 3-3M17 19.5v-15M14 7.5l3-3 3 3" />,
  star: <path d="M12 4l2.4 5 5.3.6-3.9 3.6 1 5.3L12 16l-4.8 2.5 1-5.3-3.9-3.6 5.3-.6z" />,
  logout: <path d="M14 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2.5M10 12h10.5M17.5 9l3 3-3 3" />,
  maximize: <path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" />,
  minimize: <path d="M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5" />,
  plug: <><path d="M9 3.5v4M15 3.5v4" /><path d="M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0z" /><path d="M12 16v4.5" /></>,
  key: <><circle cx="8" cy="15.5" r="3.8" /><path d="M10.8 12.8l8.2-8.3M16.2 7.3l2.3 2.3M14 9.5l1.8 1.8" /></>,
  link: <><path d="M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  youtube: <><rect x="2.8" y="5.5" width="18.4" height="13" rx="3.5" /><path d="M10.2 9.3v5.4l4.6-2.7z" fill="currentColor" /></>,
  upload: <path d="M12 15.5V4.5M7.5 9L12 4.5 16.5 9M4.5 15v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15" />,
  download: <path d="M12 4.5v11M7.5 11l4.5 4.5 4.5-4.5M4.5 15v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15" />,
  share: <><circle cx="17.5" cy="5.5" r="2.5" /><circle cx="6.5" cy="12" r="2.5" /><circle cx="17.5" cy="18.5" r="2.5" /><path d="M8.7 10.7l6.6-3.9M8.7 13.3l6.6 3.9" /></>,
  tablet: <><rect x="4" y="3" width="16" height="18" rx="2.5" /><path d="M10.5 17.5h3" /></>,
  sd: <><path d="M9 3.5h7.5A1.5 1.5 0 0 1 18 5v14.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19.5V6.5z" /><path d="M10 7v2.5M12.5 7v2.5M15 7v2.5" /></>,
  gallery: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="9.5" r="1.6" /><path d="M20.5 15.5l-4.8-4.8-9.7 8.8" /></>,
  hand: <path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11.5V5a1.5 1.5 0 0 1 3 0v6.5M14 11.5V6.5a1.5 1.5 0 0 1 3 0V14c0 4-2.6 6.5-6 6.5-2.4 0-3.8-1-5.2-3L3.9 14.6a1.5 1.5 0 0 1 2.4-1.8L8 15" />,
  globe: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5s1.2-6.2 3.6-8.5z" /></>,
  droplet: <path d="M12 3.8s6 6.3 6 10.4a6 6 0 0 1-12 0c0-4.1 6-10.4 6-10.4z" />,
  type: <path d="M5 7V5h14v2M12 5v14M9 19h6" />,
  shapes: <><circle cx="8" cy="8" r="4" /><rect x="12.5" y="12.5" width="8" height="8" rx="1" /><path d="M16.5 3.5l4 6.5h-8z" /></>,
  move: <path d="M4 12h9M10 8l4 4-4 4M17 6.5v11M20 6.5v11" />,
  bookmark: <path d="M6.5 4.5h11v15l-5.5-4-5.5 4z" />,
  save: <><path d="M5 4.5h11l3.5 3.5v11.5h-14.5z" /><path d="M8 4.5v5h7v-5M8 19.5v-5.5h8v5.5" /></>,
  'volume-2': <><path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z" /><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" /></>,
  story: <><path d="M5 4.5h10.5l3.5 3.5v11.5H5z" /><path d="M8.5 11h7M8.5 14.5h7M8.5 7.5h4" /></>,
  dot: <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />,
  leaf: <><path d="M5 19c0-8 5-13.5 14.5-14.5C19 14 13.5 19 5 19z" /><path d="M5 19l7.5-7.5" /></>,
  compress: <><path d="M9 4.5V9H4.5M15 4.5V9h4.5M9 19.5V15H4.5M15 19.5V15h4.5" /></>,
  popout: <><path d="M13.5 4.5h6v6M19.5 4.5l-8 8" /><path d="M17.5 13.5v5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1h5" /></>,
  popin: <><path d="M11 13v-6M11 13H5M11 13l-6.5-6.5" /><path d="M13.5 4.5h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-5" /></>,
  at: <><circle cx="12" cy="12" r="3.5" /><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8" /></>,
  trash2: <><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5" /></>,
}

export type IconName = keyof typeof P | string

export function Icon({ name, size = 16, stroke = 1.75, style, className }: { name: IconName; size?: number; stroke?: number; style?: CSSProperties; className?: string }) {
  return (
    <svg className={`ic ${className || ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true">
      {P[name] || P.dot}
    </svg>
  )
}

/** Marca de la app (el mismo diseño que el ícono del .exe). */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    // El ícono de la app (android/icon/icon.svg): pistas de voz, música y efectos que forman un "play",
    // con el cabezal de reproducción.
    <svg width={size} height={size} viewBox="18 18 72 72" aria-hidden="true" style={{ flex: 'none' }}>
      <defs>
        <linearGradient id="oa-logo-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#1A1726" /><stop offset="1" stopColor="#0B0A10" /></linearGradient>
        <radialGradient id="oa-logo-gl" cx=".85" cy=".85" r=".8"><stop offset="0" stopColor="#7C6BFF" stopOpacity=".35" /><stop offset="1" stopColor="#7C6BFF" stopOpacity="0" /></radialGradient>
      </defs>
      <rect x="18" y="18" width="72" height="72" rx="16" fill="url(#oa-logo-bg)" />
      <rect x="18" y="18" width="72" height="72" rx="16" fill="url(#oa-logo-gl)" />
      <rect x="31" y="36.5" width="30" height="9" rx="4.5" fill="#2DD4BF" />
      <rect x="31" y="49.5" width="46" height="9" rx="4.5" fill="#8C7CFF" />
      <rect x="31" y="62.5" width="30" height="9" rx="4.5" fill="#FF7A59" />
      <path d="M69 32V77" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      <path d="M64 28.5H74L69 34.5Z" fill="#fff" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  )
}
