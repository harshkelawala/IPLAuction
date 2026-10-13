import type { TeamId } from './types.js';

export interface TeamInfo {
  id: TeamId;
  name: string;
  city: string;
  /** Primary and secondary brand colours, used for original badges (no official logos). */
  colors: [string, string];
}

export const TEAMS: readonly TeamInfo[] = [
  { id: 'CSK', name: 'Chennai Super Kings', city: 'Chennai', colors: ['#F9CD05', '#0F3F8C'] },
  { id: 'MI', name: 'Mumbai Indians', city: 'Mumbai', colors: ['#004BA0', '#D1AB3E'] },
  { id: 'RCB', name: 'Royal Challengers Bengaluru', city: 'Bengaluru', colors: ['#D11D2A', '#1C1C1C'] },
  { id: 'KKR', name: 'Kolkata Knight Riders', city: 'Kolkata', colors: ['#3A225D', '#B3A123'] },
  { id: 'SRH', name: 'Sunrisers Hyderabad', city: 'Hyderabad', colors: ['#F26522', '#1C1C1C'] },
  { id: 'RR', name: 'Rajasthan Royals', city: 'Jaipur', colors: ['#EA1A85', '#254AA5'] },
  { id: 'DC', name: 'Delhi Capitals', city: 'Delhi', colors: ['#17449B', '#EF1B23'] },
  { id: 'PBKS', name: 'Punjab Kings', city: 'Mullanpur', colors: ['#DD1F2D', '#A7A9AC'] },
  { id: 'LSG', name: 'Lucknow Super Giants', city: 'Lucknow', colors: ['#0057E2', '#F28B00'] },
  { id: 'GT', name: 'Gujarat Titans', city: 'Ahmedabad', colors: ['#1B2133', '#DBBE6E'] },
];

export const TEAM_IDS: readonly TeamId[] = TEAMS.map((t) => t.id);

export function teamById(id: TeamId): TeamInfo {
  const team = TEAMS.find((t) => t.id === id);
  if (!team) throw new Error(`Unknown team ${id}`);
  return team;
}
