import type { NextConfig } from 'next';

const config: NextConfig = {
  // Shared workspace packages ship TypeScript source.
  transpilePackages: ['@ipl/rules', '@ipl/protocol'],
  reactStrictMode: true,
};

export default config;
