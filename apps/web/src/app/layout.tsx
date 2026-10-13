import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'IPL Auction',
  description: 'Run an IPL franchise at the auction table against nine AI teams.',
};

export const viewport: Viewport = {
  themeColor: '#0f2a4a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
