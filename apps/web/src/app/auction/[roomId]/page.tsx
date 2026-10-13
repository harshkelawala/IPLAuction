'use client';

import Link from 'next/link';
import { use } from 'react';
import { AuctionScreen } from '@/components/AuctionScreen';
import { ResultsScreen } from '@/components/ResultsScreen';
import { useRoom } from '@/lib/useRoom';
import styles from '@/components/auction.module.css';

export default function AuctionPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = use(params);
  const room = useRoom(roomId);

  if (room.status === 'error') {
    return (
      <main className={styles.message}>
        <h1>Can't open this auction</h1>
        <p>{room.error}</p>
        <Link href="/" className={styles.linkButton}>
          Start a new auction
        </Link>
      </main>
    );
  }

  if (!room.snapshot || room.players.size === 0) {
    return (
      <main className={styles.message}>
        <h1>Taking your seat at the table…</h1>
        {!room.connected && <p>Connecting to the game server.</p>}
      </main>
    );
  }

  if (room.snapshot.phase === 'done') {
    return <ResultsScreen snapshot={room.snapshot} players={room.players} />;
  }

  return <AuctionScreen room={room} />;
}
