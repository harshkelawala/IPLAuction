'use client';

import type { ClientToServer, ServerToClient } from '@ipl/protocol';
import { io, type Socket } from 'socket.io-client';

export type GameSocket = Socket<ServerToClient, ClientToServer>;

let socket: GameSocket | null = null;

export const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:4000';

/** Developer override: localStorage['ipl-auction:server'] = 'http://localhost:4001'. */
function serverUrl(): string {
  try {
    return localStorage.getItem('ipl-auction:server') ?? SERVER_URL;
  } catch {
    return SERVER_URL;
  }
}

/** One connection per tab, shared by every screen. */
export function getSocket(): GameSocket {
  if (!socket) socket = io(serverUrl(), { transports: ['websocket'], autoConnect: true });
  return socket;
}

const key = (roomId: string) => `ipl-auction:room:${roomId}`;

export function saveRoomToken(roomId: string, token: string): void {
  try {
    localStorage.setItem(key(roomId), token);
  } catch {
    // Private mode: the auction still works until the tab closes.
  }
}

export function loadRoomToken(roomId: string): string | null {
  try {
    return localStorage.getItem(key(roomId));
  } catch {
    return null;
  }
}

/** The auction you were last playing, so the home screen can offer to continue it. */
export interface LastRoom {
  roomId: string;
  teamId: string;
  startedAt: number;
}

const LAST = 'ipl-auction:last-room';

export function saveLastRoom(room: LastRoom): void {
  try {
    localStorage.setItem(LAST, JSON.stringify(room));
  } catch {
    // Private mode: nothing to continue later.
  }
}

export function loadLastRoom(): LastRoom | null {
  try {
    const raw = localStorage.getItem(LAST);
    return raw ? (JSON.parse(raw) as LastRoom) : null;
  } catch {
    return null;
  }
}

export function clearLastRoom(roomId?: string): void {
  try {
    if (!roomId || loadLastRoom()?.roomId === roomId) localStorage.removeItem(LAST);
  } catch {
    // ignore
  }
}
