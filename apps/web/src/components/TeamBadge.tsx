import type { TeamId } from '@ipl/rules';
import { teamById } from '@ipl/rules';

/** Relative luminance, to pick readable text on a team colour. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (ch[0] as number) + 0.7152 * (ch[1] as number) + 0.0722 * (ch[2] as number);
}

/**
 * An original crest for a franchise: a shield in its colours with its short code.
 * Not an official logo.
 */
export function TeamBadge({ id, size = 40, title }: { id: TeamId; size?: number; title?: string }) {
  const team = teamById(id);
  const [primary, secondary] = team.colors;
  const text = luminance(primary) > 0.45 ? '#0f2a4a' : '#ffffff';
  const fontSize = id.length > 3 ? 13 : 16;
  return (
    <svg width={size} height={size * 1.15} viewBox="0 0 40 46" role="img" aria-label={title ?? team.name}>
      <path d="M20 1 L38 7 V22 C38 34 30 41 20 45 C10 41 2 34 2 22 V7 Z" fill={primary} stroke={secondary} strokeWidth="2" />
      <path d="M2 30 C10 27 30 27 38 30 L37 33 C29 30 11 30 3 33 Z" fill={secondary} />
      <text
        x="20"
        y="23"
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="Barlow Condensed, Arial Narrow, sans-serif"
        fontWeight="700"
        fontSize={fontSize}
        fill={text}
      >
        {id}
      </text>
    </svg>
  );
}
