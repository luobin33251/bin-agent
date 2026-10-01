// 统一图标集：全部内联 SVG，不引外部图标库，保持自包含
import type { ReactNode } from 'react';

export function Icon({
  children,
  size = 15,
  strokeWidth = 1.8,
  filled = false,
}: {
  children: ReactNode;
  size?: number;
  strokeWidth?: number;
  filled?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const GLYPHS = {
  sparkle: <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />,
  search: (
    <g>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </g>
  ),
  write: <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />,
  run: <path d="M4 17l6-5-6-5M12 19h8" />,
  layers: (
    <g>
      <path d="M12 2 2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5M2 12l10 5 10-5" />
    </g>
  ),
  doc: (
    <g>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </g>
  ),
  check: <path d="M20 6L9 17l-5-5" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  arrowUp: <path d="M12 19V5M5 12l7-7 7 7" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  lock: (
    <g>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 1 1 8 0v3" />
    </g>
  ),
  eye: (
    <g>
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </g>
  ),
  eyeOff: (
    <g>
      <path d="M9.9 5.7A9.6 9.6 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-2.4 3.2M6.3 7.9A17 17 0 0 0 2 12s3.6 6.5 10 6.5c1.4 0 2.6-.3 3.7-.8" />
      <path d="M3 3l18 18" />
    </g>
  ),
  copy: (
    <g>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </g>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  trash: (
    <g>
      <path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15" />
    </g>
  ),
} as const;

export type GlyphName = keyof typeof GLYPHS;

/** 根据工具名猜一个合适的图标，避免在工具侧额外声明 */
export function glyphForTool(name: string): GlyphName {
  if (/search|list|query|find|get/.test(name)) return 'search';
  if (/save|write|upsert|create|update|set/.test(name)) return 'write';
  if (/scan|read|parse|load/.test(name)) return 'doc';
  if (/run|exec|shell/.test(name)) return 'run';
  return 'sparkle';
}