import type { Server as HttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Player } from '@ipl/data';
import type { ClientToServer, ServerToClient, SoloSettings } from '@ipl/protocol';
import { TEAM_IDS } from '@ipl/rules';
import { Server } from 'socket.io';
import { Room } from './room';

export interface GameServerOptions {
  /** Allowed browser origin(s) for CORS, e.g. http://localhost:3000. */
  corsOrigin?: string | string[];
  timeScale?: number;
  players?: Player[];
  /** Rooms idle this long are removed (ms). */
  idleTtlMs?: number;
}

interface SocketData {
  roomId?: string;
}

export function loadPlayers(): Player[] {
  const file = join(import.meta.dirname, '..', '..', '..', 'packages', 'data', 'generated', 'players-2026.json');
  return JSON.parse(readFileSync(file, 'utf8')) as Player[];
}

const DIFFICULTIES = ['easy', 'normal', 'hard'];
const SPEEDS = ['normal', 'fast'];
const POOLS = ['quick', 'standard', 'full'];

function validSettings(s: SoloSettings): string | null {
  if (!s || typeof s !== 'object') return 'Missing settings';
  if (!TEAM_IDS.includes(s.teamId)) return 'Pick one of the 10 teams';
  if (!DIFFICULTIES.includes(s.difficulty)) return 'Unknown difficulty';
  if (!SPEEDS.includes(s.speed)) return 'Unknown speed';
  if (!POOLS.includes(s.pool)) return 'Unknown player pool';
  return null;
}

export function createGameServer(http: HttpServer, opts: GameServerOptions = {}) {
  const players = opts.players ?? loadPlayers();
  const rooms = new Map<string, Room>();
  const io = new Server<ClientToServer, ServerToClient, Record<string, never>, SocketData>(http, {
    cors: { origin: opts.corsOrigin ?? 'http://localhost:3000' },
  });

  const idleTtl = opts.idleTtlMs ?? 30 * 60_000;
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, room] of rooms) {
      if (now - room.lastActivity > idleTtl) {
        room.dispose();
        rooms.delete(id);
      }
    }
  }, 60_000);
  sweeper.unref();

  io.on('connection', (socket) => {
    socket.on('solo:create', (settings, ack) => {
      const problem = validSettings(settings);
      if (problem) return ack({ ok: false, error: problem });
      const room: Room = new Room({
        settings,
        players,
        timeScale: opts.timeScale,
        emit: (event, ...args) => io.to(room.id).emit(event, ...args),
      });
      rooms.set(room.id, room);
      room.start();
      ack({ ok: true, data: { roomId: room.id, token: room.token } });
    });

    socket.on('room:join', ({ roomId, token }, ack) => {
      const room = rooms.get(roomId);
      if (!room) return ack({ ok: false, error: 'This auction has ended or expired. Start a new one.' });
      if (room.token !== token) return ack({ ok: false, error: 'This auction belongs to another player.' });
      socket.data.roomId = roomId;
      void socket.join(roomId);
      room.lastActivity = Date.now();
      ack({ ok: true, data: room.welcome() });
      socket.emit('room:state', room.snapshot());
    });

    const roomOf = () => (socket.data.roomId ? rooms.get(socket.data.roomId) : undefined);

    socket.on('bid:place', ({ amount }, ack) => {
      const room = roomOf();
      if (!room) return ack({ ok: false, error: 'Join an auction first' });
      ack({ ok: true, data: room.bid(room.human, amount) });
    });

    socket.on('lot:skip', (ack) => {
      const room = roomOf();
      if (!room) return ack({ ok: false, error: 'Join an auction first' });
      const res = room.skip();
      ack(res.ok ? { ok: true, data: null } : { ok: false, error: res.message });
    });

    socket.on('room:pause', (ack) => {
      const room = roomOf();
      if (!room) return ack({ ok: false, error: 'Join an auction first' });
      room.pause();
      ack({ ok: true, data: null });
    });

    socket.on('room:resume', (ack) => {
      const room = roomOf();
      if (!room) return ack({ ok: false, error: 'Join an auction first' });
      room.resume();
      ack({ ok: true, data: null });
    });

    socket.on('disconnect', async () => {
      const room = roomOf();
      if (!room || room.isDone) return;
      // Solo: nobody is left at the table, so hold the auction until they come back.
      const others = await io.in(room.id).fetchSockets();
      if (others.length === 0) room.pause();
    });
  });

  return {
    io,
    rooms,
    close: () => {
      clearInterval(sweeper);
      for (const r of rooms.values()) r.dispose();
      io.close();
    },
  };
}
