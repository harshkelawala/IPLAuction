'use client';

import type { PublicPlayer, RoomSnapshot, TeamView } from '@ipl/protocol';
import type { Role, TeamId } from '@ipl/rules';
import { formatLakh, squadTargets, teamById } from '@ipl/rules';
import { useEffect, useState } from 'react';
import { ROLE_LABEL, ROLE_PLURAL, initials, styleLine } from '@/lib/format';
import { useNow, type useRoom } from '@/lib/useRoom';
import { TeamBadge } from './TeamBadge';
import styles from './auction.module.css';

type Room = ReturnType<typeof useRoom>;

const ROLES: Role[] = ['BAT', 'WK', 'AR', 'BOWL'];

export function AuctionScreen({ room }: { room: Room }) {
  const snap = room.snapshot as RoomSnapshot;
  const lot = snap.lot;
  const player = lot ? room.players.get(lot.playerId) : undefined;
  const you = snap.teams.find((t) => t.isYou) as TeamView;
  const now = useNow(!!lot && !snap.paused);
  const msLeft = lot ? (snap.paused ? (snap.pausedRemainingMs ?? 0) : Math.max(0, lot.endsAt - (now + room.clockOffset))) : 0;
  const [bidError, setBidError] = useState<string | null>(null);

  useEffect(() => setBidError(null), [lot?.playerId, lot?.bidCount]);

  useEffect(() => {
    if (!room.flash) return;
    const t = setTimeout(room.clearFlash, 1_800);
    return () => clearTimeout(t);
  }, [room.flash, room.clearFlash]);

  async function placeBid() {
    if (!lot || !lot.yourBid.ok || snap.paused) return;
    const res = await room.bid(lot.nextBid);
    if (!res.ok) setBidError(res.message);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'b' && !(e.target instanceof HTMLInputElement)) void placeBid();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const done = snap.progress.done;
  const lotLabel = snap.phase === 'accelerated' ? 'Accelerated round' : `Player ${Math.min(done + 1, snap.progress.total)} of ${snap.progress.total}`;

  return (
    <div className={styles.screen}>
      <header className={styles.topbar}>
        <a href="/" className={styles.brand}>
          IPL Auction
        </a>
        <p className={styles.where}>
          <span>{lotLabel}</span>
          {lot && <span className={styles.setName}>{lot.setLabel}</span>}
        </p>
        <div className={styles.topActions}>
          {!room.connected && <span className={styles.offline}>Reconnecting…</span>}
          <button type="button" className={styles.ghostButton} onClick={snap.paused ? room.resume : room.pause}>
            {snap.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </header>

      <div className={styles.layout}>
        <TeamsRail teams={snap.teams} leader={lot?.leader ?? null} maxSquad={snap.settings.maxSquad} />

        <main className={styles.stage}>
          {player && lot ? (
            <>
              <PlayerCard player={player} />
              <BidPanel
                snap={snap}
                msLeft={msLeft}
                windowMs={room.windowMs}
                onBid={placeBid}
                bidError={bidError}
              >
                {room.flash && <FlashBanner flash={room.flash} players={room.players} you={snap.you} />}
              </BidPanel>
            </>
          ) : (
            <div className={styles.between}>Next player coming up…</div>
          )}

          {snap.paused && (
            <div className={styles.pausedOverlay} role="dialog" aria-labelledby="paused-title">
              <h2 id="paused-title">Auction paused</h2>
              <p>The clock is stopped with {Math.ceil(msLeft / 1000)} seconds left on this player.</p>
              <button type="button" className={styles.bigButton} onClick={room.resume}>
                Resume the auction
              </button>
            </div>
          )}

          <Feed snap={snap} players={room.players} />
        </main>

        <YourSquad team={you} snap={snap} players={room.players} />
      </div>
    </div>
  );
}

function PlayerCard({ player }: { player: PublicPlayer }) {
  const last = teamById(player.lastTeam);
  return (
    <article className={styles.lotCard} aria-live="polite" aria-label={`Now up: ${player.name}`}>
      <div className={styles.monogram} style={{ '--team': last.colors[0] } as React.CSSProperties} aria-hidden>
        {initials(player.name)}
      </div>
      <div className={styles.lotText}>
        <h1 className={styles.lotName}>{player.name}</h1>
        <p className={styles.lotRole}>
          {ROLE_LABEL[player.role]}, {player.country}
          {player.isOverseas && <span className={styles.tag}>Overseas</span>}
          {!player.isCapped && <span className={styles.tag}>Uncapped</span>}
        </p>
        <p className={styles.lotStyle}>{styleLine(player)}</p>
        <p className={styles.lotHistory}>
          Played for {last.name} in 2026. Base price <strong className="num">{formatLakh(player.basePrice)}</strong>
        </p>
      </div>
    </article>
  );
}

function Countdown({ msLeft, windowMs, children }: { msLeft: number; windowMs: number; children: React.ReactNode }) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, msLeft / windowMs));
  const urgent = msLeft < 3_000;
  return (
    <div className={styles.countdown} data-urgent={urgent}>
      <svg viewBox="0 0 100 100" aria-hidden>
        <circle cx="50" cy="50" r={r} className={styles.ringTrack} />
        <circle
          cx="50"
          cy="50"
          r={r}
          className={styles.ring}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <div className={styles.countdownInner}>{children}</div>
      <span className={`${styles.seconds} num`} aria-label={`${Math.ceil(msLeft / 1000)} seconds left`}>
        {Math.ceil(msLeft / 1000)}s
      </span>
    </div>
  );
}

function BidPanel({
  snap,
  msLeft,
  windowMs,
  onBid,
  bidError,
  children,
}: {
  snap: RoomSnapshot;
  msLeft: number;
  windowMs: number;
  onBid: () => void;
  bidError: string | null;
  children?: React.ReactNode;
}) {
  const lot = snap.lot;
  if (!lot) return null;
  const leading = lot.leader !== null && lot.leader === snap.you;
  const leader = lot.leader ? teamById(lot.leader) : null;
  const status = !leader ? 'No bids yet' : leading ? 'You are leading' : `${leader.name} leads`;
  const canBid = lot.yourBid.ok && !snap.paused;
  const reason = leading ? null : !lot.yourBid.ok ? lot.yourBid.message : null;

  return (
    <section className={styles.bidPanel} aria-label="Bidding">
      {children}
      <Countdown msLeft={msLeft} windowMs={windowMs}>
        {lot.leader ? <TeamBadge id={lot.leader} size={58} /> : <span className={styles.noPaddle}>No paddle up</span>}
      </Countdown>

      <div className={styles.bidNumbers}>
        <p className={styles.bidStatus} data-leading={leading}>
          {status}
        </p>
        <p className={`${styles.currentBid} num`}>{lot.currentBid !== null ? formatLakh(lot.currentBid) : formatLakh(lot.nextBid)}</p>
        <p className={styles.bidSub}>{lot.currentBid !== null ? `${lot.bidCount} bids` : 'Opening price'}</p>
      </div>

      <div className={styles.bidAction}>
        <button type="button" className={styles.bidButton} onClick={onBid} disabled={!canBid} aria-keyshortcuts="b">
          <span>Bid</span>
          <span className="num">{formatLakh(lot.nextBid)}</span>
        </button>
        <p className={styles.bidHint} aria-live="polite">
          {bidError ?? reason ?? (leading ? 'Wait for a rival to raise you.' : 'Press B to bid.')}
        </p>
      </div>
    </section>
  );
}

function FlashBanner({
  flash,
  players,
  you,
}: {
  flash: NonNullable<ReturnType<typeof useRoom>['flash']>;
  players: Map<string, PublicPlayer>;
  you: TeamId | null;
}) {
  if (flash.kind === 'unsold') {
    return (
      <div key={flash.key} className={styles.flash} data-kind="unsold" role="status">
        <span className={styles.flashWord}>Unsold</span>
        <span>{players.get(flash.playerId)?.name}</span>
      </div>
    );
  }
  const team = teamById(flash.event.teamId);
  const mine = flash.event.teamId === you;
  return (
    <div key={flash.key} className={styles.flash} data-kind={mine ? 'mine' : 'sold'} role="status">
      <span className={styles.flashWord}>Sold</span>
      <span>
        {players.get(flash.event.playerId)?.name} to {mine ? 'you' : team.name} for{' '}
        <strong className="num">{formatLakh(flash.event.price)}</strong>
      </span>
    </div>
  );
}

function TeamsRail({ teams, leader, maxSquad }: { teams: TeamView[]; leader: TeamId | null; maxSquad: number }) {
  return (
    <aside className={styles.rail} aria-label="All franchises">
      <h2 className={styles.railTitle}>Franchises</h2>
      <ol className={styles.teamList}>
        {teams.map((t) => (
          <li key={t.id} className={styles.teamRow} data-leading={t.id === leader} data-you={t.isYou}>
            <TeamBadge id={t.id} size={26} />
            <span className={styles.teamName}>
              {t.id}
              {t.isYou && <span className={styles.youTag}>You</span>}
            </span>
            <span className={`${styles.teamPurse} num`}>{formatLakh(t.purse)}</span>
            <span className={styles.teamCounts}>
              {t.squad.length}/{maxSquad} players, {t.overseasCount} overseas
            </span>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function YourSquad({ team, snap, players }: { team: TeamView; snap: RoomSnapshot; players: Map<string, PublicPlayer> }) {
  const targets = squadTargets(snap.settings.maxSquad);
  const byRole = new Map<Role, { p: PublicPlayer; price: number }[]>(ROLES.map((r) => [r, []]));
  for (const s of team.squad) {
    const p = players.get(s.playerId);
    if (p) byRole.get(p.role)?.push({ p, price: s.price });
  }
  const short = snap.settings.minSquad - team.squad.length;
  const hints: string[] = [];
  if (short > 0) hints.push(`Sign ${short} more to reach the minimum of ${snap.settings.minSquad}.`);
  if ((byRole.get('WK')?.length ?? 0) === 0) hints.push('No wicketkeeper yet.');
  for (const r of ['BOWL', 'BAT', 'AR'] as Role[]) {
    const have = byRole.get(r)?.length ?? 0;
    if (have < targets[r] && team.squad.length >= 3) hints.push(`${ROLE_PLURAL[r]}: ${have} of about ${targets[r]}.`);
  }

  return (
    <aside className={styles.squad} aria-label="Your squad">
      <div className={styles.squadHead}>
        <TeamBadge id={team.id} size={36} />
        <div>
          <h2>{teamById(team.id).name}</h2>
          <p className={styles.squadMeta}>
            {team.squad.length} of {snap.settings.maxSquad} players, {team.overseasCount} of {snap.settings.maxOverseas} overseas
          </p>
        </div>
      </div>
      <p className={styles.purseLeft}>
        <span className="num">{formatLakh(team.purse)}</span> left to spend
      </p>
      {hints.length > 0 && (
        <ul className={styles.hints}>
          {hints.slice(0, 3).map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
      {team.squad.length === 0 ? (
        <p className={styles.empty}>Your squad is empty. Bid on a player to sign them.</p>
      ) : (
        ROLES.map((r) => {
          const list = byRole.get(r) ?? [];
          if (list.length === 0) return null;
          return (
            <div key={r} className={styles.roleGroup}>
              <h3>{ROLE_PLURAL[r]}</h3>
              <ul>
                {list.map(({ p, price }) => (
                  <li key={p.id}>
                    <span>
                      {p.name}
                      {p.isOverseas && <span className={styles.ovMark} title="Overseas"> (OS)</span>}
                    </span>
                    <span className="num">{formatLakh(price)}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
    </aside>
  );
}

function Feed({ snap, players }: { snap: RoomSnapshot; players: Map<string, PublicPlayer> }) {
  const entries = snap.log.slice(0, 8);
  if (entries.length === 0) return null;
  return (
    <section className={styles.feed} aria-label="Recent results">
      <h2 className={styles.railTitle}>Recent results</h2>
      <ul>
        {entries.map((e) => {
          if (e.kind === 'phase') {
            return (
              <li key={e.id} className={styles.feedPhase}>
                {e.phase === 'accelerated' ? 'Accelerated round: unsold players come back once.' : 'Auction complete.'}
              </li>
            );
          }
          const name = players.get(e.playerId)?.name ?? e.playerId;
          if (e.kind === 'unsold') {
            return (
              <li key={e.id}>
                <span>{name}</span>
                <span className={styles.feedUnsold}>Unsold</span>
              </li>
            );
          }
          return (
            <li key={e.id} data-you={e.teamId === snap.you}>
              <span>{name}</span>
              <span className={styles.feedTeam}>
                <TeamBadge id={e.teamId} size={18} />
                <span className="num">{formatLakh(e.price)}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
