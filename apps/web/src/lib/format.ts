import type { PublicPlayer } from '@ipl/protocol';
import type { Role } from '@ipl/rules';

export const ROLE_LABEL: Record<Role, string> = {
  BAT: 'Batter',
  BOWL: 'Bowler',
  AR: 'All-rounder',
  WK: 'Wicketkeeper',
};

export const ROLE_PLURAL: Record<Role, string> = {
  BAT: 'Batters',
  WK: 'Wicketkeepers',
  AR: 'All-rounders',
  BOWL: 'Bowlers',
};

const STYLE: Record<string, string> = {
  RF: 'Right-arm fast',
  RFM: 'Right-arm fast-medium',
  RM: 'Right-arm medium',
  LF: 'Left-arm fast',
  LFM: 'Left-arm fast-medium',
  LM: 'Left-arm medium',
  OB: 'Off-spin',
  LB: 'Leg-spin',
  SLA: 'Left-arm orthodox spin',
  LWS: 'Left-arm wrist spin',
  UNO: 'Unorthodox spin',
};

/** "Right-hand bat · Off-spin" style line, written in words. */
export function styleLine(p: PublicPlayer): string {
  const bat = p.battingHand === 'L' ? 'Left-handed batter' : 'Right-handed batter';
  if (!p.bowlingStyle) return bat;
  const bowl = STYLE[p.bowlingStyle] ?? p.bowlingStyle;
  return p.role === 'BOWL' ? `${bowl} bowler, bats ${p.battingHand === 'L' ? 'left' : 'right'}-handed` : `${bat}, bowls ${bowl.toLowerCase()}`;
}

export function initials(name: string): string {
  const parts = name.replace(/\./g, ' ').split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase();
}
