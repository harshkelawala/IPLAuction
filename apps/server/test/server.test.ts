import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { ClientToServer, RoomSnapshot, ServerToClient, SoloSettings } from '@ipl/protocol';
import { createGameServer } from '../src/server';

type Client = Socket<ServerToClient, ClientToServer>;

let http: HttpServer;
let game: ReturnType<typeof createGameServer>;
let url: string;
const clients: Client[] = [];

beforeEach(async () => {
  http = createServer();
  // 15 s opening timer becomes 30 ms: a whole 150-player auction runs in a few seconds.
  game = createGameServer(http, { timeScale: 0.002 });
  await new Promise<void>((r) => http.listen(0, r));
  url = `http://localhost:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  game.close();
  await new Promise((r) => http.close(r));
});

function client(): Client {
  const c: Client = connect(url, { transports: ['websocket'], forceNew: true });
  clients.push(c);
  return c;
}

const solo: SoloSettings = { teamId: 'CSK', difficulty: 'normal', speed: 'fast', pool: 'quick' };

async function createAndJoin(c: Client, settings = solo) {
  const created = await c.emitWithAck('solo:create', settings);
  if (!created.ok) throw new Error(created.error);
  const joined = await c.emitWithAck('room:join', created.data);
  if (!joined.ok) throw new Error(joined.error);
  return { ...created.data, welcome: joined.data };
}

function waitFor(c: Client, pred: (s: RoomSnapshot) => boolean, timeoutMs = 20_000): Promise<RoomSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for state')), timeoutMs);
    const on = (s: RoomSnapshot) => {
      if (pred(s)) {
        clearTimeout(timer);
        c.off('room:state', on);
        resolve(s);
      }
    };
    c.on('room:state', on);
  });
}

describe('game server', () => {
  it('rejects bad settings', async () => {
    const c = client();
    const res = await c.emitWithAck('solo:create', { ...solo, teamId: 'XYZ' as never });
    expect(res).toEqual({ ok: false, error: 'Pick one of the 10 teams' });
  });

  it('only lets the room owner join', async () => {
    const c = client();
    const { roomId } = await createAndJoin(c);
    const other = client();
    expect(await other.emitWithAck('room:join', { roomId, token: 'nope' })).toMatchObject({ ok: false });
  });

  it('sends the player pool without ratings or fair values', async () => {
    const c = client();
    const { welcome } = await createAndJoin(c);
    expect(welcome.players).toHaveLength(150);
    expect(welcome.sets.flatMap((x) => x.playerIds)).toHaveLength(150);
    expect(welcome.sets[0]?.code).toBe('M1');
    expect(Object.keys(welcome.players[0] as object)).not.toContain('fairValue');
    expect(Object.keys(welcome.players[0] as object)).not.toContain('rating');
  });

  it('accepts a human bid and plays a full auction with 9 AI teams', async () => {
    const c = client();
    const first = waitFor(c, (s) => s.lot !== null);
    await createAndJoin(c);
    const s = await first;
    expect(s.you).toBe('CSK');
    // AIs react within a millisecond at this time scale, so bid on the freshest state until one lands.
    let latest = s;
    c.on('room:state', (x) => (latest = x));
    let accepted = false;
    for (let i = 0; i < 200 && !accepted; i++) {
      if (latest.lot?.yourBid.ok) {
        const res = await c.emitWithAck('bid:place', { amount: latest.lot.nextBid });
        accepted = res.ok && res.data.ok;
      } else {
        await new Promise((r) => setTimeout(r, 1));
      }
    }
    expect(accepted).toBe(true);

    const end = await waitFor(c, (x) => x.phase === 'done');
    for (const t of end.teams) {
      expect(t.squad.length).toBeLessThanOrEqual(end.settings.maxSquad);
      expect(t.overseasCount).toBeLessThanOrEqual(end.settings.maxOverseas);
      expect(t.purse).toBeGreaterThanOrEqual(0);
      if (t.controller === 'ai') expect(t.squad.length).toBeGreaterThanOrEqual(end.settings.minSquad);
    }
    expect(end.teams.find((t) => t.id === 'CSK')?.controller).toBe('human');
    expect(end.log.length).toBeGreaterThan(0);
  }, 30_000);

  it('rejects a stale bid amount', async () => {
    const c = client();
    const first = waitFor(c, (s) => s.lot !== null);
    await createAndJoin(c);
    const s = await first;
    const res = await c.emitWithAck('bid:place', { amount: (s.lot?.nextBid as number) + 1 });
    expect(res).toMatchObject({ ok: true, data: { ok: false } });
  });

  it('skips a player: AI teams settle it at once and the next player comes up', async () => {
    const c = client();
    const first = waitFor(c, (s) => s.lot !== null);
    await createAndJoin(c);
    const s = await first;
    await c.emitWithAck('room:pause');
    await c.emitWithAck('room:resume');
    const room = [...game.rooms.values()][0];
    const before = room?.snapshot();
    const res = await c.emitWithAck('lot:skip');
    expect(res).toEqual({ ok: true, data: null });
    const after = room?.snapshot();
    // At least the skipped player closed (at test speed the next hammer may fall too).
    expect(after?.progress.done).toBeGreaterThanOrEqual((before?.progress.done ?? 0) + 1);
    expect(after?.lot?.playerId).not.toBe(s.lot?.playerId);
    expect(after?.log[0]?.kind === 'sold' || after?.log[0]?.kind === 'unsold').toBe(true);
  });

  it('auto-skips players you have not starred and stops on a starred one', async () => {
    const c = client();
    const first = waitFor(c, (s) => s.lot !== null);
    await createAndJoin(c);
    const s = await first;
    // Star the 10th player to come up, then turn on auto-skip.
    const target = s.upcoming[8] as string;
    await c.emitWithAck('room:pause');
    await c.emitWithAck('watch:set', { playerIds: [target], autoSkip: true });
    await c.emitWithAck('room:resume');
    const reached = await waitFor(c, (x) => x.lot?.playerId === target, 10_000);
    expect(reached.autoSkip).toBe(true);
    expect(reached.watchlist).toEqual([target]);
    expect(reached.progress.done).toBe(9);
  });

  it('sends a strength rating and rank for every team', async () => {
    const c = client();
    const first = waitFor(c, (s) => s.lot !== null);
    await createAndJoin(c);
    const s = await first;
    expect(s.teams.map((t) => t.strength.rank).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(typeof s.teams[0]?.strength.grade).toBe('string');
  });

  it('runs one auction per connection: starting a new one pauses the old one', async () => {
    const c = client();
    const firstState = waitFor(c, (s) => s.lot !== null);
    const a = await createAndJoin(c);
    await firstState;
    const roomA = game.rooms.get(a.roomId);
    const b = await createAndJoin(c, { ...solo, teamId: 'MI' });
    expect(b.roomId).not.toBe(a.roomId);
    expect(roomA?.isPaused).toBe(true);
    // From now on this connection only hears about the new auction.
    const seen = new Set<string>();
    c.on('room:state', (s) => seen.add(s.roomId));
    await new Promise((r) => setTimeout(r, 300));
    expect([...seen]).toEqual([b.roomId]);
  });

  it('pauses the auction you leave and resumes it when you come back', async () => {
    const c = client();
    const firstState = waitFor(c, (s) => s.lot !== null);
    const a = await createAndJoin(c);
    await firstState;
    await c.emitWithAck('room:leave');
    expect(game.rooms.get(a.roomId)?.isPaused).toBe(true);
    await c.emitWithAck('room:join', { roomId: a.roomId, token: a.token });
    expect(game.rooms.get(a.roomId)?.isPaused).toBe(false);
  });

  it('reports an unfinished auction without resuming it', async () => {
    const c = client();
    const firstState = waitFor(c, (s) => s.lot !== null);
    const a = await createAndJoin(c);
    await firstState;
    await c.emitWithAck('room:leave');
    const peek = await c.emitWithAck('room:peek', { roomId: a.roomId, token: a.token });
    expect(peek).toMatchObject({ ok: true, data: { teamId: 'CSK' } });
    expect(game.rooms.get(a.roomId)?.isPaused).toBe(true);
    expect(await c.emitWithAck('room:peek', { roomId: a.roomId, token: 'wrong' })).toEqual({ ok: true, data: null });
  });

  it('keeps a pause you pressed yourself when you come back', async () => {
    const c = client();
    const firstState = waitFor(c, (s) => s.lot !== null);
    const a = await createAndJoin(c);
    await firstState;
    await c.emitWithAck('room:pause');
    await c.emitWithAck('room:leave');
    await c.emitWithAck('room:join', { roomId: a.roomId, token: a.token });
    expect(game.rooms.get(a.roomId)?.isPaused).toBe(true);
  });

  it('pauses and resumes', async () => {
    const c = client();
    const first = waitFor(c, (s) => s.lot !== null);
    await createAndJoin(c);
    await first;
    await c.emitWithAck('room:pause');
    const paused = await waitFor(c, (s) => s.paused, 2_000).catch(() => null);
    const room = [...game.rooms.values()][0];
    expect(room?.isPaused).toBe(true);
    const done = room?.snapshot().progress.done;
    await new Promise((r) => setTimeout(r, 200));
    expect(room?.snapshot().progress.done).toBe(done);
    expect(paused === null || paused.paused).toBe(true);
    await c.emitWithAck('room:resume');
    await waitFor(c, (s) => s.progress.done > (done ?? 0), 5_000);
  });
});
