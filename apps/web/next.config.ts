import type { NextConfig } from 'next';

const apiUrl = process.env.PALLETDOCK_API_URL ?? 'http://127.0.0.1:4101';

const config: NextConfig = {
  async rewrites() {
    return [{ source: '/backend/:path*', destination: `${apiUrl}/:path*` }];
  },
};

export default config;
