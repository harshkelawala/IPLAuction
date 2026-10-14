'use client';

import type { BidEvent, PublicPlayer, RoomSnapshot, SetView, SoldEvent } from '@ipl/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSocket, loadRoomToken } from './socket';

export type Flash =
  | { kind: 'sold'; key: number; event: SoldEvent }
  | { kind: 'unsold'; key: number; playerId: string };

export interface RoomState {
  status: 'connecting' | 'ready' | 'error';
  error: string | null;
  snapshot: RoomSnapshot | null;
  players: Map<string, PublicPlayer>;
  sets: SetView[];
  /** serverNow − Date.now() when the last snapshot arrived. */
  clockOffset: number;
  /** How long the current countdown started at (ms), for the timer ring. */
  windowMs: number;
  lastBid: BidEvent | null;
  flash: Flash | null;
  connected: boolean;
}

export function useRoom(roomId: string) {
  const [state, setState] = useState<RoomState>({
    status: 'connecting',
    error: null,
    snapshot: null,
    players: new Map(),
    sets: [],
    clockOffset: 0,
    windowMs: 1,
    lastBid: null,
    flash: null,
    connected: false,
  });
  const lotKey = useRef('');
  const flashKey = useRef(0);

  useEffect(() => {
    const socket = getSocket();
    const token = loadRoomToken(roomId);
    if (!token) {
      setState((s) => ({ ...s, status: 'error', error: 'This auction was started in another browser. Start a new one.' }));
      return;
    }

    const join = async () => {
      const res = await socket.emitWithAck('room:join', { roomId, token });
      if (!res.ok) {
        setState((s) => ({ ...s, status: 'error', error: res.error }));
        return;
      }
      setState((s) => ({ ...s, players: new Map(res.data.players.map((p) => [p.id, p])), sets: res.data.sets }));
    };

    const onState = (snap: RoomSnapshot) => {
      if (snap.roomId !== roomId) return; // another auction's update: not for this screen
      setState((s) => {
        const lot = snap.lot;
        const key = lot ? `${lot.playerId}:${lot.bidCount}` : '';
        let windowMs = s.windowMs;
        if (lot && key !== lotKey.current) {
          lotKey.current = key;
          windowMs = Math.max(1, lot.endsAt - snap.serverNow);
        }
        return { ...s, status: 'ready', snapshot: snap, clockOffset: snap.serverNow - Date.now(), windowMs };
      });
    };
    const onBid = (e: BidEvent) => {
      if (e.roomId === roomId) setState((s) => ({ ...s, lastBid: e }));
    };
    const onSold = (e: SoldEvent) => {
      if (e.roomId === roomId)
        setState((s) => ({ ...s, flash: { kind: 'sold', key: ++flashKey.current, event: e } }));
    };
    const onUnsold = (e: { roomId: string; playerId: string }) => {
      if (e.roomId === roomId)
        setState((s) => ({ ...s, flash: { kind: 'unsold', key: ++flashKey.current, playerId: e.playerId } }));
    };
    const onConnect = () => {
      setState((s) => ({ ...s, connected: true }));
      void join();
    };
    const onDisconnect = () => setState((s) => ({ ...s, connected: false }));

    socket.on('room:state', onState);
    socket.on('auction:bid', onBid);
    socket.on('auction:sold', onSold);
    socket.on('auction:unsold', onUnsold);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    if (socket.connected) onConnect();

    return () => {
      socket.off('room:state', onState);
      socket.off('auction:bid', onBid);
      socket.off('auction:sold', onSold);
      socket.off('auction:unsold', onUnsold);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      // Leaving this screen (Back, the logo, a new auction) pauses this auction.
      void socket.emitWithAck('room:leave');
    };
  }, [roomId]);

  const bid = useCallback(async (amount: number) => {
    const res = await getSocket().emitWithAck('bid:place', { amount });
    if (!res.ok) return { ok: false as const, message: res.error };
    return res.data.ok ? { ok: true as const } : { ok: false as const, message: res.data.message };
  }, []);

  const skip = useCallback(async () => {
    const res = await getSocket().emitWithAck('lot:skip');
    return res.ok ? { ok: true as const } : { ok: false as const, message: res.error };
  }, []);

  const setWatch = useCallback(
    (playerIds: string[], autoSkip: boolean) => void getSocket().emitWithAck('watch:set', { playerIds, autoSkip }),
    [],
  );

  const pause = useCallback(() => void getSocket().emitWithAck('room:pause'), []);
  const resume = useCallback(() => void getSocket().emitWithAck('room:resume'), []);
  const clearFlash = useCallback(() => setState((s) => ({ ...s, flash: null })), []);

  return { ...state, bid, skip, setWatch, pause, resume, clearFlash };
}

/** Re-render every animation frame while `active`; returns Date.now(). */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const loop = () => {
      setNow(Date.now());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return now;
}
