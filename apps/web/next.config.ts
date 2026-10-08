import type { NextConfig } from 'next';

const apiUrl = process.env.PALLETDOCK_API_URL ?? 'http://127.0.0.1:4101';

const config: NextConfig = {
  // Separate build output lets an isolated E2E dev server run beside the normal one.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
  async rewrites() {
    return [{ source: '/backend/:path*', destination: `${apiUrl}/:path*` }];
  },
};

export default config;
