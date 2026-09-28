/** 内联 SVG 图标：全部 currentColor、零 emoji（AGENTS.md 铁律），stroke 风格与原 public/index.html 一致 */
import type { ReactNode } from 'react';

type IconProps = { size?: number; className?: string };

function Svg({ size = 16, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

export const IconSpark = (p: IconProps) => (
  <Svg {...p}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></Svg>
);
export const IconPlus = (p: IconProps) => (
  <Svg {...p}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></Svg>
);
export const IconClose = (p: IconProps) => (
  <Svg {...p}><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></Svg>
);
export const IconCheck = (p: IconProps) => (
  <Svg {...p}><polyline points="4.5 12.5 9.5 17.5 19.5 6.5" /></Svg>
);
export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}><polyline points="6 9 12 15 18 9" /></Svg>
);
export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}><polyline points="9 6 15 12 9 18" /></Svg>
);
export const IconGear = (p: IconProps) => (
  <Svg {...p}>
    <line x1="4" y1="6" x2="20" y2="6" /><circle cx="9" cy="6" r="2.2" fill="currentColor" stroke="none" />
    <line x1="4" y1="12" x2="20" y2="12" /><circle cx="15" cy="12" r="2.2" fill="currentColor" stroke="none" />
    <line x1="4" y1="18" x2="20" y2="18" /><circle cx="7" cy="18" r="2.2" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconBulb = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 18h5M10.5 21h3M12 3a6 6 0 0 1 3.6 10.8c-.8.5-1.1 1.2-1.1 2.2h-5c0-1-.3-1.7-1.1-2.2A6 6 0 0 1 12 3z" />
  </Svg>
);
export const IconPerson = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="8" r="3.8" /><path d="M4.5 20.5c0-3.8 3.4-6 7.5-6s7.5 2.2 7.5 6" /></Svg>
);
export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h3.1l1.9 2.2h8A2.5 2.5 0 0 1 21 10.7v6.8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" />
  </Svg>
);
export const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3.5h7.2L18.5 8.8V20a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4.5 20V5A1.5 1.5 0 0 1 6 3.5z" />
    <path d="M13 3.5V9h5.5" />
  </Svg>
);
export const IconPencil = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20l.9-3.8L15.6 5.5a2.1 2.1 0 0 1 3 3L7.9 19.2z" />
    <line x1="14.5" y1="6.5" x2="17.5" y2="9.5" />
  </Svg>
);
export const IconFilePlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3.5h7.2L18.5 8.8V12" />
    <path d="M13 3.5V9h5.5" />
    <path d="M4.5 20V5A1.5 1.5 0 0 1 6 3.5" />
    <line x1="12" y1="15" x2="12" y2="21" /><line x1="9" y1="18" x2="15" y2="18" />
  </Svg>
);
export const IconTerminal = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.2" />
    <polyline points="7 9.5 9.8 12 7 14.5" />
    <line x1="12.5" y1="15" x2="17" y2="15" />
  </Svg>
);
export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.6 2.4 3.9 5.3 3.9 8.5s-1.3 6.1-3.9 8.5c-2.6-2.4-3.9-5.3-3.9-8.5S9.4 5.9 12 3.5z" />
  </Svg>
);
export const IconWrench = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.5 6.5a4 4 0 0 0-5.6 4.9L4 16.3V20h3.7l4.9-4.9a4 4 0 0 0 4.9-5.6l-2.7 2.7-2.4-.6-.6-2.4z" />
  </Svg>
);
export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5l7 2.6v5.2c0 4.4-2.9 7.6-7 9.2-4.1-1.6-7-4.8-7-9.2V6.1z" />
    <polyline points="9 11.8 11.2 14 15.2 9.6" />
  </Svg>
);
export const IconSend = (p: IconProps) => (
  <Svg {...p}><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></Svg>
);
export const IconStop = (p: IconProps) => (
  <Svg {...p}><rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor" stroke="none" /></Svg>
);
export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="4 7 20 7" />
    <path d="M9 7V5.2A1.2 1.2 0 0 1 10.2 4h3.6A1.2 1.2 0 0 1 15 5.2V7" />
    <path d="M6 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h7.4a1.5 1.5 0 0 0 1.5-1.4L18 7" />
  </Svg>
);
export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 1 1-2.4-5.7" />
    <polyline points="20 4 20 9 15 9" />
  </Svg>
);
export const IconSearch = (p: IconProps) => (
  <Svg {...p}><circle cx="11" cy="11" r="6.5" /><line x1="16" y1="16" x2="20.5" y2="20.5" /></Svg>
);
export const IconList = (p: IconProps) => (
  <Svg {...p}>
    <polyline points="8.5 7.5 10.5 9.5 14.5 5" />
    <polyline points="8.5 14.5 10.5 16.5 14.5 12" />
    <line x1="17" y1="7" x2="21" y2="7" />
    <line x1="17" y1="14" x2="21" y2="14" />
  </Svg>
);

export const IconTag = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0l-7-7A2 2 0 013 12.2V5a2 2 0 012-2h7.2a2 2 0 011.4.6l7 7a2 2 0 010 2.8z" />
    <circle cx="8" cy="8" r="1.3" />
  </Svg>
);
export const IconKey = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="M10.8 12.2L19.5 3.5M16.5 6.5l2.6 2.6M14 9l2.2 2.2" />
  </Svg>
);
export const IconClock = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="8.5" /><polyline points="12 7.5 12 12 15.5 14" /></Svg>
);
export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5l9.2 16.5H2.8z" />
    <line x1="12" y1="10" x2="12" y2="14" /><circle cx="12" cy="17" r=".5" fill="currentColor" />
  </Svg>
);
export const IconInfo = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16.5" /><line x1="12" y1="7.8" x2="12" y2="8" /></Svg>
);
export const IconWarn = (p: IconProps) => (
  <Svg {...p}><path d="M12 4.2 21 19.5H3z" /><line x1="12" y1="10" x2="12" y2="14.5" /><line x1="12" y1="17.2" x2="12" y2="17.4" /></Svg>
);
export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
  </Svg>
);
/** 等待中的三点动画（CSS 驱动，见 app.css） */
export const Dots = ({ label }: { label: string }) => (
  <span className="dots" aria-label={label} role="status">
    <i /><i /><i />
  </span>
);
