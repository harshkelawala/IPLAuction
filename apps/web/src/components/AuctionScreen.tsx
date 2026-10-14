'use client';

import type { PublicPlayer, RoomSnapshot, SetView, TeamView } from '@ipl/protocol';
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
  const [viewing, setViewing] = useState<TeamId>(you.id);
  const [allSquads, setAllSquads] = useState(false);
  const watch = new Set(snap.watchlist);
  const toggleStar = (id: string) => {
    const next = new Set(watch);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    room.setWatch([...next], snap.autoSkip);
  };
  const setAutoSkip = (on: boolean) => room.setWatch([...watch], on);
  const shown = snap.teams.find((t) => t.id === viewing) ?? you;

  useEffect(() => setBidError(null), [lot?.playerId, lot?.bidCount]);

  useEffect(() => {
    if (!room.flash) return;
    const t = setTimeout(room.clearFlash, 1_300);
    return () => clearTimeout(t);
  }, [room.flash, room.clearFlash]);

  async function placeBid() {
    if (!lot || !lot.yourBid.ok || snap.paused) return;
    const res = await room.bid(lot.nextBid);
    if (!res.ok) setBidError(res.message);
  }

  async function skipPlayer() {
    if (!lot || snap.paused || lot.leader === snap.you) return;
    const res = await room.skip();
    if (!res.ok) setBidError(res.message);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'b') void placeBid();
      if (k === 's') void skipPlayer();
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
          <button type="button" className={styles.ghostButton} onClick={() => setAllSquads(true)}>
            All squads
          </button>
          <button type="button" className={styles.ghostButton} onClick={snap.paused ? room.resume : room.pause}>
            {snap.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </header>

      <div className={styles.layout}>
        <TeamsRail
          teams={snap.teams}
          leader={lot?.leader ?? null}
          maxSquad={snap.settings.maxSquad}
          viewing={viewing}
          onSelect={(id) => {
            setViewing(id);
            if (window.matchMedia('(max-width: 760px)').matches) {
              document.getElementById('squad-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }}
        />

        <main className={styles.stage}>
          {player && lot ? (
            <>
              <PlayerCard player={player} starred={watch.has(player.id)} onStar={() => toggleStar(player.id)} />
              <BidPanel
                snap={snap}
                msLeft={msLeft}
                windowMs={room.windowMs}
                onBid={placeBid}
                onSkip={skipPlayer}
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

          {room.sets.length > 0 && (
            <PlayersPanel
              snap={snap}
              sets={room.sets}
              players={room.players}
              watch={watch}
              onStar={toggleStar}
              onAutoSkip={setAutoSkip}
            />
          )}

          <Feed snap={snap} players={room.players} />
        </main>

        <SquadPanel team={shown} snap={snap} players={room.players} onShowYours={() => setViewing(you.id)} />
      </div>

      {allSquads && <AllSquads snap={snap} players={room.players} onClose={() => setAllSquads(false)} />}
    </div>
  );
}

function StarButton({ on, onClick, name }: { on: boolean; onClick: () => void; name: string }) {
  return (
    <button
      type="button"
      className={styles.star}
      aria-pressed={on}
      aria-label={on ? `Remove ${name} from your watchlist` : `Add ${name} to your watchlist`}
      title={on ? 'On your watchlist' : 'Add to watchlist'}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
        <path
          d="M12 2.8l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3L2.9 9.5l6.3-.9z"
          fill={on ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

function PlayerCard({ player, starred, onStar }: { player: PublicPlayer; starred: boolean; onStar: () => void }) {
  const last = teamById(player.lastTeam);
  return (
    <article className={styles.lotCard} aria-live="polite" aria-label={`Now up: ${player.name}`}>
      <div className={styles.cardStar}>
        <StarButton on={starred} onClick={onStar} name={player.name} />
      </div>
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
  onSkip,
  bidError,
  children,
}: {
  snap: RoomSnapshot;
  msLeft: number;
  windowMs: number;
  onBid: () => void;
  onSkip: () => void;
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
        <button
          type="button"
          className={styles.skipButton}
          onClick={onSkip}
          disabled={leading || snap.paused}
          aria-keyshortcuts="s"
        >
          Skip player
        </button>
        <p className={styles.bidHint} aria-live="polite">
          {bidError ?? reason ?? (leading ? 'Wait for a rival to raise you.' : 'B to bid, S to skip this player.')}
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

function TeamsRail({
  teams,
  leader,
  maxSquad,
  viewing,
  onSelect,
}: {
  teams: TeamView[];
  leader: TeamId | null;
  maxSquad: number;
  viewing: TeamId;
  onSelect: (id: TeamId) => void;
}) {
  return (
    <aside className={styles.rail} aria-label="All franchises">
      <h2 className={styles.railTitle}>Franchises</h2>
      <p className={styles.railHint}>Select a team to see its squad.</p>
      <ol className={styles.teamList}>
        {teams.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className={styles.teamRow}
              data-leading={t.id === leader}
              data-you={t.isYou}
              aria-pressed={t.id === viewing}
              onClick={() => onSelect(t.id)}
            >
            <TeamBadge id={t.id} size={26} />
            <span className={styles.teamName}>
              {t.id}
              {t.isYou && <span className={styles.youTag}>You</span>}
            </span>
            <span className={`${styles.teamPurse} num`}>{formatLakh(t.purse)}</span>
            <span className={styles.teamCounts}>
              {t.squad.length}/{maxSquad} players, {t.overseasCount} overseas
              {t.squad.length > 0 && (
                <>
                  {' · '}
                  <span className={styles.rankTag}>
                    #{t.strength.rank}
                    {t.strength.xi.length === 11 ? ` ${t.strength.grade}` : ''}
                  </span>
                </>
              )}
            </span>
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function SquadPanel({
  team,
  snap,
  players,
  onShowYours,
}: {
  team: TeamView;
  snap: RoomSnapshot;
  players: Map<string, PublicPlayer>;
  onShowYours: () => void;
}) {
  const targets = squadTargets(snap.settings.maxSquad);
  const byRole = new Map<Role, { p: PublicPlayer; price: number }[]>(ROLES.map((r) => [r, []]));
  for (const s of team.squad) {
    const p = players.get(s.playerId);
    if (p) byRole.get(p.role)?.push({ p, price: s.price });
  }
  const short = snap.settings.minSquad - team.squad.length;
  const hints: string[] = [];
  if (!team.isYou) {
    // Hints are advice for your own squad only.
  } else if (team.squad.length - team.overseasCount < snap.settings.minIndians && team.squad.length > 0) {
    const need = snap.settings.minIndians - (team.squad.length - team.overseasCount);
    hints.push(`Sign ${need} more Indian player${need === 1 ? '' : 's'}: an XI can have only 4 overseas.`);
  }
  if (team.isYou && short > 0) hints.push(`Sign ${short} more to reach the minimum of ${snap.settings.minSquad}.`);
  if (team.isYou && (byRole.get('WK')?.length ?? 0) === 0) hints.push('No wicketkeeper yet.');
  for (const r of team.isYou ? (['BOWL', 'BAT', 'AR'] as Role[]) : []) {
    const have = byRole.get(r)?.length ?? 0;
    if (have < targets[r] && team.squad.length >= 3) hints.push(`${ROLE_PLURAL[r]}: ${have} of about ${targets[r]}.`);
  }

  return (
    <aside className={styles.squad} aria-label={team.isYou ? 'Your squad' : `${teamById(team.id).name} squad`} id="squad-panel">
      {!team.isYou && (
        <button type="button" className={styles.backButton} onClick={onShowYours}>
          Show your squad
        </button>
      )}
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
      {team.squad.length > 0 && <StrengthBlock team={team} players={players} />}
      {hints.length > 0 && (
        <ul className={styles.hints}>
          {hints.slice(0, 3).map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
      {team.squad.length === 0 ? (
        <p className={styles.empty}>
          {team.isYou ? 'Your squad is empty. Bid on a player to sign them.' : 'No players signed yet.'}
        </p>
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
                {e.phase === 'accelerated' ? 'Accelerated round: unsold players come back once at the lowest base price.' : 'Auction complete.'}
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

type PlayerStatus =
  | { kind: 'up' }
  | { kind: 'sold'; teamId: TeamId; price: number }
  | { kind: 'unsold' }
  | { kind: 'next' }
  | { kind: 'later' };

type RoleFilter = 'all' | 'starred' | Role;

const FILTERS: { id: RoleFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'starred', label: 'Starred' },
  { id: 'BAT', label: 'Batters' },
  { id: 'WK', label: 'Keepers' },
  { id: 'AR', label: 'All-rounders' },
  { id: 'BOWL', label: 'Bowlers' },
];

function PlayersPanel({
  snap,
  sets,
  players,
  watch,
  onStar,
  onAutoSkip,
}: {
  snap: RoomSnapshot;
  sets: SetView[];
  players: Map<string, PublicPlayer>;
  watch: Set<string>;
  onStar: (id: string) => void;
  onAutoSkip: (on: boolean) => void;
}) {
  const [tab, setTab] = useState<'set' | 'upcoming'>('set');
  const [filter, setFilter] = useState<RoleFilter>('all');
  const lot = snap.lot;

  const sold = new Map<string, { teamId: TeamId; price: number }>();
  for (const t of snap.teams) for (const s of t.squad) sold.set(s.playerId, { teamId: t.id, price: s.price });
  const unsold = new Set(snap.unsold);
  const upcomingSet = new Set(snap.upcoming);
  const nextId = snap.upcoming[0];
  const setOf = new Map<string, SetView>();
  for (const set of sets) for (const id of set.playerIds) setOf.set(id, set);

  const status = (id: string): PlayerStatus => {
    if (lot?.playerId === id) return { kind: 'up' };
    const s = sold.get(id);
    if (s) return { kind: 'sold', ...s };
    if (id === nextId) return { kind: 'next' };
    if (upcomingSet.has(id)) return { kind: 'later' };
    if (unsold.has(id)) return { kind: 'unsold' };
    return { kind: 'later' };
  };

  const accelerated = lot?.setCode === 'ACC';
  const currentSet = accelerated ? null : sets.find((s) => s.code === lot?.setCode);
  const setIds = accelerated && lot ? [lot.playerId, ...snap.upcoming] : (currentSet?.playerIds ?? []);
  const setTitle = accelerated ? 'Accelerated round' : (currentSet?.label ?? 'Current set');

  const passes = (id: string) => {
    const p = players.get(id);
    if (!p) return false;
    if (filter === 'all') return true;
    if (filter === 'starred') return watch.has(id);
    return p.role === filter;
  };
  const upcoming = snap.upcoming.filter(passes);
  const groups: { label: string; ids: string[] }[] = [];
  for (const id of upcoming) {
    const label = accelerated ? 'Accelerated round' : (setOf.get(id)?.label ?? '');
    const last = groups.at(-1);
    if (last && last.label === label) last.ids.push(id);
    else groups.push({ label, ids: [id] });
  }
  const starredAhead = snap.upcoming.filter((id) => watch.has(id)).length;
  const nextStar = snap.upcoming.findIndex((id) => watch.has(id));

  const row = (id: string) => (
    <PlayerRow
      key={id}
      player={players.get(id)}
      status={status(id)}
      you={snap.you}
      starred={watch.has(id)}
      onStar={() => onStar(id)}
    />
  );

  return (
    <section className={styles.players} aria-label="Players in the auction">
      <div className={styles.watchBar}>
        <label className={styles.switch}>
          <input type="checkbox" checked={snap.autoSkip} onChange={(e) => onAutoSkip(e.target.checked)} />
          <span className={styles.switchTrack} aria-hidden />
          <span>Auto-skip players I haven't starred</span>
        </label>
        <span className={styles.watchNote}>
          {snap.autoSkip
            ? starredAhead === 0
              ? 'No starred players ahead: everyone will be skipped. Star some below.'
              : `${starredAhead} starred ahead${nextStar >= 0 ? `, next in ${nextStar + 1}` : ''}`
            : 'Star players to build a watchlist.'}
        </span>
      </div>

      <div className={styles.tabs} role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'set'} onClick={() => setTab('set')}>
          This set
        </button>
        <button type="button" role="tab" aria-selected={tab === 'upcoming'} onClick={() => setTab('upcoming')}>
          Coming up <span className={styles.count}>{snap.upcoming.length}</span>
        </button>
      </div>

      {tab === 'set' ? (
        <div role="tabpanel">
          <h3 className={styles.panelTitle}>{setTitle}</h3>
          <ul className={styles.playerList}>{setIds.map(row)}</ul>
        </div>
      ) : (
        <div role="tabpanel">
          <div className={styles.filters} role="group" aria-label="Filter players">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
          <div className={styles.scrollList}>
            {groups.length === 0 ? (
              <p className={styles.empty}>
                {filter === 'starred' ? 'No starred players ahead. Tap a star to add one.' : 'No players here.'}
              </p>
            ) : (
              groups.map((g, i) => (
                <div key={`${g.label}-${i}`}>
                  <h3 className={styles.panelTitle}>{g.label}</h3>
                  <ul className={styles.playerList}>{g.ids.map(row)}</ul>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function PlayerRow({
  player,
  status,
  you,
  starred,
  onStar,
}: {
  player?: PublicPlayer;
  status: PlayerStatus;
  you: TeamId | null;
  starred: boolean;
  onStar: () => void;
}) {
  if (!player) return null;
  const canStar = status.kind === 'up' || status.kind === 'next' || status.kind === 'later';
  return (
    <li className={styles.playerRow} data-status={status.kind} data-starred={starred}>
      {canStar ? <StarButton on={starred} onClick={onStar} name={player.name} /> : <span className={styles.starSpacer} />}
      <span className={styles.playerName}>
        {player.name}
        <span className={styles.playerMeta}>
          {ROLE_LABEL[player.role]}
          {player.isOverseas ? ', overseas' : ''}
          {!player.isCapped ? ', uncapped' : ''}
        </span>
      </span>
      <span className={styles.playerState}>
        {status.kind === 'up' && <span className={styles.upNow}>Up now</span>}
        {status.kind === 'next' && <span>Next, base {formatLakh(player.basePrice)}</span>}
        {status.kind === 'later' && <span>Base {formatLakh(player.basePrice)}</span>}
        {status.kind === 'unsold' && <span className={styles.unsoldTag}>Unsold</span>}
        {status.kind === 'sold' && (
          <span className={styles.soldTo} data-you={status.teamId === you}>
            <TeamBadge id={status.teamId} size={16} />
            <span className="num">{formatLakh(status.price)}</span>
          </span>
        )}
      </span>
    </li>
  );
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

function StrengthBlock({ team, players }: { team: TeamView; players: Map<string, PublicPlayer> }) {
  const [showXI, setShowXI] = useState(false);
  const s = team.strength;
  return (
    <div className={styles.strength}>
      <div className={styles.strengthTop}>
        {s.xi.length === 11 && <span className={styles.gradeChip}>{s.grade}</span>}
        <span>
          <strong className="num">{s.overall.toFixed(1)}</strong> strength, {ordinal(s.rank)} of 10
          {s.xi.length < 11 && <span className={styles.gradeLater}> (grade once you can field an XI)</span>}
        </span>
      </div>
      <dl className={styles.strengthBars}>
        <div>
          <dt>Batting</dt>
          <dd>
            <span className={styles.bar} style={{ '--v': `${s.batting}%` } as React.CSSProperties} />
            <span className="num">{s.batting.toFixed(0)}</span>
          </dd>
        </div>
        <div>
          <dt>Bowling</dt>
          <dd>
            <span className={styles.bar} style={{ '--v': `${s.bowling}%` } as React.CSSProperties} />
            <span className="num">{s.bowling.toFixed(0)}</span>
          </dd>
        </div>
      </dl>
      <p className={styles.attack}>
        Attack: {s.pace} pace, {s.spin} spin
        {s.value !== null && (
          <>
            {' · '}Value <span className="num">{s.value.toFixed(1)}</span> per ₹10 cr
          </>
        )}
      </p>
      {s.notes.length > 0 && <p className={styles.notes}>{s.notes.join('. ')}.</p>}
      {s.issues.length > 0 && <p className={styles.issues}>{s.issues.join('. ')}.</p>}
      <button type="button" className={styles.linkish} onClick={() => setShowXI((v) => !v)} aria-expanded={showXI}>
        {showXI ? 'Hide best XI' : 'Show best XI'}
      </button>
      {showXI && (
        <ol className={styles.xiList}>
          {s.xi.map((id) => {
            const p = players.get(id);
            return (
              <li key={id}>
                {p?.name}
                {p?.isOverseas && <span className={styles.ovMark}> (OS)</span>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function AllSquads({
  snap,
  players,
  onClose,
}: {
  snap: RoomSnapshot;
  players: Map<string, PublicPlayer>;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const teams = [...snap.teams].sort((a, b) => a.strength.rank - b.strength.rank);
  return (
    <div className={styles.allOverlay} role="dialog" aria-modal="true" aria-labelledby="all-squads-title">
      <div className={styles.allHead}>
        <h2 id="all-squads-title">All squads</h2>
        <p>Live, strongest first. The auction keeps running while this is open.</p>
        <button type="button" className={styles.ghostButton} onClick={onClose} autoFocus>
          Close
        </button>
      </div>
      <div className={styles.allGrid}>
        {teams.map((t) => {
          const byRole = new Map<Role, { p: PublicPlayer; price: number }[]>(ROLES.map((r) => [r, []]));
          for (const s of t.squad) {
            const p = players.get(s.playerId);
            if (p) byRole.get(p.role)?.push({ p, price: s.price });
          }
          return (
            <section key={t.id} className={styles.allCard} data-you={t.isYou}>
              <header>
                <TeamBadge id={t.id} size={30} />
                <div>
                  <h3>
                    {teamById(t.id).name}
                    {t.isYou && <span className={styles.youTag}>You</span>}
                  </h3>
                  <p>
                    {t.squad.length} of {snap.settings.maxSquad}, {t.overseasCount} OS,{' '}
                    <span className="num">{formatLakh(t.purse)}</span> left
                  </p>
                </div>
                {t.squad.length > 0 && (
                  <span className={styles.allRank}>
                    #{t.strength.rank}
                    {t.strength.xi.length === 11 && <span className={styles.gradeChip}>{t.strength.grade}</span>}
                  </span>
                )}
              </header>
              {t.squad.length === 0 ? (
                <p className={styles.empty}>No players yet.</p>
              ) : (
                ROLES.map((r) => {
                  const list = (byRole.get(r) ?? []).sort((a, b) => b.price - a.price);
                  if (list.length === 0) return null;
                  return (
                    <div key={r} className={styles.roleGroup}>
                      <h4>{ROLE_PLURAL[r]}</h4>
                      <ul>
                        {list.map(({ p, price }) => (
                          <li key={p.id}>
                            <span>
                              {p.name}
                              {p.isOverseas && <span className={styles.ovMark}> (OS)</span>}
                            </span>
                            <span className="num">{formatLakh(price)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
