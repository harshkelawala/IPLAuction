'use client';

import type { PublicPlayer, RoomSnapshot, TeamView } from '@ipl/protocol';
import type { Role } from '@ipl/rules';
import { formatLakh, teamById } from '@ipl/rules';
import Link from 'next/link';
import { useEffect } from 'react';
import { clearLastRoom } from '@/lib/socket';
import { ROLE_PLURAL } from '@/lib/format';
import { TeamBadge } from './TeamBadge';
import styles from './results.module.css';

const ROLES: Role[] = ['BAT', 'WK', 'AR', 'BOWL'];

const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

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
  // A finished auction has nothing to continue.
  useEffect(() => clearLastRoom(snapshot.roomId), [snapshot.roomId]);
  const spent = (t: TeamView) => settings.purse - t.purse;
  const sales = snapshot.teams
    .flatMap((t) => t.squad.map((s) => ({ team: t.id, ...s })))
    .sort((a, b) => b.price - a.price);
  const yourShort = settings.minSquad - you.squad.length;
  const ranked = [...snapshot.teams].sort((a, b) => a.strength.rank - b.strength.rank);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>{you.strength.rank === 1 ? 'You built the strongest squad' : `You finished ${ordinal(you.strength.rank)} of 10`}</h1>
        <p>
          {teamById(you.id).name}: {you.strength.grade}, strength {you.strength.overall.toFixed(1)}. {sales.length} players sold,{' '}
          {snapshot.unsold.length} unsold.
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
        {you.squad.length > 0 && (
          <p className={styles.xiLine}>
            <strong>Attack:</strong> {you.strength.pace} pace, {you.strength.spin} spin.{' '}
            {[...you.strength.notes, ...you.strength.issues].join('. ')}
            {you.strength.notes.length + you.strength.issues.length > 0 ? '.' : ''}
          </p>
        )}
        {you.strength.xi.length > 0 && (
          <p className={styles.xiLine}>
            <strong>Best XI:</strong> {you.strength.xi.map((id) => players.get(id)?.name).join(', ')}
          </p>
        )}
        {you.squad.length > 0 ? (
          <SquadList team={you} players={players} />
        ) : (
          <p>You didn't sign anyone this time.</p>
        )}
      </section>

      <section aria-labelledby="ranking" className={styles.section}>
        <h2 id="ranking">Final ranking</h2>
        <p className={styles.note}>
          Strength of each team's best legal XI (at most 4 overseas). Batting and bowling count 47.5% each, with the top
          order and strike bowlers weighted most, and the bench 5%. Balance adds or takes points: 2 pace and a spinner are
          needed, a 3-pace, 2-spin attack and a left-hander in the top six earn a bonus. Value is strength above a
          replacement-level side per ₹10 cr spent.
        </p>
        <div className={styles.tableWrap}>
          <table className={styles.ranking}>
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Team</th>
                <th scope="col">Grade</th>
                <th scope="col" className={styles.numCol}>Strength</th>
                <th scope="col" className={styles.numCol}>Batting</th>
                <th scope="col" className={styles.numCol}>Bowling</th>
                <th scope="col" className={styles.numCol}>Balance</th>
                <th scope="col">Attack</th>
                <th scope="col" className={styles.numCol}>Value</th>
                <th scope="col" className={styles.numCol}>Spent</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((t) => (
                <tr key={t.id} data-you={t.isYou}>
                  <td className="num">{t.strength.rank}</td>
                  <td>
                    <span className={styles.teamCell}>
                      <TeamBadge id={t.id} size={22} />
                      {teamById(t.id).name}
                      {t.isYou && <span className={styles.youTag}>You</span>}
                    </span>
                    {t.strength.issues.length > 0 && <span className={styles.issue}>{t.strength.issues.join('. ')}</span>}
                    {t.strength.notes.length > 0 && <span className={styles.good}>{t.strength.notes.join('. ')}</span>}
                  </td>
                  <td>
                    <span className={styles.grade}>{t.strength.grade}</span>
                  </td>
                  <td className={`num ${styles.numCol}`}>{t.strength.overall.toFixed(1)}</td>
                  <td className={`num ${styles.numCol}`}>{t.strength.batting.toFixed(0)}</td>
                  <td className={`num ${styles.numCol}`}>{t.strength.bowling.toFixed(0)}</td>
                  <td className={`num ${styles.numCol}`}>
                    {t.strength.balance > 0 ? '+' : ''}
                    {t.strength.balance.toFixed(1)}
                  </td>
                  <td className={styles.attackCell}>
                    {t.strength.pace} pace, {t.strength.spin} spin
                  </td>
                  <td className={`num ${styles.numCol}`}>{t.strength.value === null ? '–' : t.strength.value.toFixed(1)}</td>
                  <td className={`num ${styles.numCol}`}>{formatLakh(spent(t))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
                    #{t.strength.rank}, {t.strength.grade}. {t.squad.length} players, spent{' '}
                    <span className="num">{formatLakh(spent(t))}</span>
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
