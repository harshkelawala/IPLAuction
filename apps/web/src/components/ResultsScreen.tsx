'use client';

import type { PublicPlayer, RoomSnapshot, TeamView } from '@ipl/protocol';
import type { Role } from '@ipl/rules';
import { formatLakh, teamById } from '@ipl/rules';
import Link from 'next/link';
import { ROLE_PLURAL } from '@/lib/format';
import { TeamBadge } from './TeamBadge';
import styles from './results.module.css';

const ROLES: Role[] = ['BAT', 'WK', 'AR', 'BOWL'];

function SquadList({ team, players }: { team: TeamView; players: Map<string, PublicPlayer> }) {
  return (
    <div className={styles.roles}>
      {ROLES.map((r) => {
        const list = team.squad
          .map((s) => ({ s, p: players.get(s.playerId) }))
          .filter((x): x is { s: (typeof team.squad)[number]; p: PublicPlayer } => x.p?.role === r)
          .sort((a, b) => b.s.price - a.s.price);
        if (list.length === 0) return null;
        return (
          <div key={r}>
            <h4>{ROLE_PLURAL[r]}</h4>
            <ul>
              {list.map(({ s, p }) => (
                <li key={p.id}>
                  <span>
                    {p.name}
                    {p.isOverseas && <span className={styles.os}> (OS)</span>}
                  </span>
                  <span className="num">{formatLakh(s.price)}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export function ResultsScreen({ snapshot, players }: { snapshot: RoomSnapshot; players: Map<string, PublicPlayer> }) {
  const { settings } = snapshot;
  const you = snapshot.teams.find((t) => t.isYou) as TeamView;
  const spent = (t: TeamView) => settings.purse - t.purse;
  const sales = snapshot.teams
    .flatMap((t) => t.squad.map((s) => ({ team: t.id, ...s })))
    .sort((a, b) => b.price - a.price);
  const yourShort = settings.minSquad - you.squad.length;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>The hammer has fallen</h1>
        <p>
          {sales.length} players sold. {snapshot.unsold.length} went unsold.
        </p>
        <Link href="/" className={styles.again}>
          Play another auction
        </Link>
      </header>

      <section className={styles.yours} aria-labelledby="your-squad">
        <div className={styles.yoursHead}>
          <TeamBadge id={you.id} size={56} />
          <div>
            <h2 id="your-squad">Your {teamById(you.id).name}</h2>
            <p>
              {you.squad.length} players, {you.overseasCount} overseas. Spent{' '}
              <strong className="num">{formatLakh(spent(you))}</strong>, <span className="num">{formatLakh(you.purse)}</span> left.
            </p>
            {yourShort > 0 && (
              <p className={styles.warning}>
                {yourShort} short of the {settings.minSquad}-player minimum. In a real auction you'd fill these slots with
                replacements.
              </p>
            )}
          </div>
        </div>
        {you.squad.length > 0 ? (
          <SquadList team={you} players={players} />
        ) : (
          <p>You didn't sign anyone this time.</p>
        )}
      </section>

      <section aria-labelledby="top-buys" className={styles.section}>
        <h2 id="top-buys">Biggest buys</h2>
        <ol className={styles.topBuys}>
          {sales.slice(0, 10).map((s) => (
            <li key={s.playerId} data-you={s.team === you.id}>
              <TeamBadge id={s.team} size={24} />
              <span>{players.get(s.playerId)?.name}</span>
              <span className="num">{formatLakh(s.price)}</span>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="all-teams" className={styles.section}>
        <h2 id="all-teams">Every squad</h2>
        <div className={styles.grid}>
          {snapshot.teams.map((t) => {
            const top = [...t.squad].sort((a, b) => b.price - a.price)[0];
            return (
              <details key={t.id} className={styles.teamCard}>
                <summary>
                  <TeamBadge id={t.id} size={34} />
                  <span className={styles.cardName}>
                    {teamById(t.id).name}
                    {t.isYou && <span className={styles.youTag}>You</span>}
                  </span>
                  <span className={styles.cardMeta}>
                    {t.squad.length} players, spent <span className="num">{formatLakh(spent(t))}</span>
                    {top && (
                      <>
                        . Top buy {players.get(top.playerId)?.name} at <span className="num">{formatLakh(top.price)}</span>
                      </>
                    )}
                  </span>
                </summary>
                <SquadList team={t} players={players} />
              </details>
            );
          })}
        </div>
      </section>
    </main>
  );
}
