import type { Player, PoolPreset } from '@ipl/data';
import { selectPool } from '@ipl/data';
import type { AuctionSettings } from '@ipl/rules';
import { POOL_RULES } from '@ipl/rules';

/**
 * Pick the players and squad rules for a pool preset.
 * The reserve rule plans to fill empty slots at the cheapest base price,
 * so that price must be the cheapest one actually in this pool.
 */
export function poolSetup(
  players: Player[],
  preset: PoolPreset,
  base: AuctionSettings,
): { pool: Player[]; settings: AuctionSettings } {
  const pool = selectPool(players, preset);
  const cheapest = Math.min(...pool.map((p) => p.basePrice));
  return {
    pool,
    settings: { ...base, ...POOL_RULES[preset], minBasePrice: Math.max(base.minBasePrice, cheapest) },
  };
}
