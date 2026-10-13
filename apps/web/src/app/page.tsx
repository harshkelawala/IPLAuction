'use client';

import type { Difficulty, PoolPreset, Speed } from '@ipl/protocol';
import type { TeamId } from '@ipl/rules';
import { TEAMS } from '@ipl/rules';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { TeamBadge } from '@/components/TeamBadge';
import { getSocket, saveRoomToken } from '@/lib/socket';
import styles from './page.module.css';

const POOLS: { id: PoolPreset; name: string; detail: string }[] = [
  { id: 'quick', name: 'Quick', detail: 'Top 150 players, squads of 11 to 14' },
  { id: 'standard', name: 'Standard', detail: 'Top 250 players, squads of 18 to 25' },
  { id: 'full', name: 'Full', detail: 'All 272 players, squads of 18 to 25' },
];

const SPEEDS: { id: Speed; name: string; detail: string }[] = [
  { id: 'normal', name: 'Normal', detail: '10 seconds to answer a bid' },
  { id: 'fast', name: 'Fast', detail: '5 seconds to answer a bid' },
];

const LEVELS: { id: Difficulty; name: string; detail: string }[] = [
  { id: 'easy', name: 'Easy', detail: 'Rivals bid loosely and ignore squad balance' },
  { id: 'normal', name: 'Normal', detail: 'Rivals bid for what their squads need' },
  { id: 'hard', name: 'Hard', detail: 'Rivals plan tightly and rarely overpay' },
];

function Choice<T extends string>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: { id: T; name: string; detail: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className={styles.choice}>
      <legend>{legend}</legend>
      <div className={styles.choiceRow}>
        {options.map((o) => (
          <label key={o.id} className={styles.option} data-checked={value === o.id}>
            <input type="radio" name={legend} value={o.id} checked={value === o.id} onChange={() => onChange(o.id)} />
            <span className={styles.optionName}>{o.name}</span>
            <span className={styles.optionDetail}>{o.detail}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default function Home() {
  const router = useRouter();
  const [team, setTeam] = useState<TeamId | null>(null);
  const [pool, setPool] = useState<PoolPreset>('quick');
  const [speed, setSpeed] = useState<Speed>('normal');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (!team) return;
    setStarting(true);
    setError(null);
    try {
      const res = await getSocket().timeout(8_000).emitWithAck('solo:create', { teamId: team, pool, speed, difficulty });
      if (!res.ok) throw new Error(res.error);
      saveRoomToken(res.data.roomId, res.data.token);
      router.push(`/auction/${res.data.roomId}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(
        message.includes('timed out') || message.includes('operation has timed out')
          ? 'The game server is not responding. Start it with "npm run server" and try again.'
          : message,
      );
      setStarting(false);
    }
  }

  const chosen = team ? TEAMS.find((t) => t.id === team) : null;

  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <h1>Run an IPL franchise at the auction table</h1>
        <p>
          Pick a team, then bid live for the IPL 2026 player pool. Nine AI franchises bid against you, each with its own
          budget, needs and temperament.
        </p>
      </header>

      <section aria-labelledby="pick-team" className={styles.section}>
        <h2 id="pick-team" className={styles.sectionTitle}>
          Choose your franchise
        </h2>
        <div className={styles.teams} role="radiogroup" aria-labelledby="pick-team">
          {TEAMS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={team === t.id}
              className={styles.paddle}
              style={{ '--team': t.colors[0], '--team-2': t.colors[1] } as React.CSSProperties}
              onClick={() => setTeam(t.id)}
            >
              <TeamBadge id={t.id} size={44} title="" />
              <span className={styles.paddleName}>{t.name}</span>
              <span className={styles.paddleCity}>{t.city}</span>
            </button>
          ))}
        </div>
      </section>

      <section aria-label="Auction settings" className={`${styles.section} ${styles.settings}`}>
        <Choice legend="Player pool" options={POOLS} value={pool} onChange={setPool} />
        <Choice legend="Bid timer" options={SPEEDS} value={speed} onChange={setSpeed} />
        <Choice legend="AI rivals" options={LEVELS} value={difficulty} onChange={setDifficulty} />
      </section>

      <div className={styles.startBar}>
        <p className={styles.startNote} aria-live="polite">
          {chosen
            ? `You'll bid for ${chosen.name} with a ₹125 crore purse.`
            : 'Choose a franchise to start.'}
        </p>
        <button type="button" className={styles.start} disabled={!team || starting} onClick={start}>
          {starting ? 'Setting up the auction…' : 'Start the auction'}
        </button>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
      </div>

      <footer className={styles.footer}>
        Fan-made game, not affiliated with the BCCI, the IPL or any franchise. Team crests are original designs.
      </footer>
    </main>
  );
}
