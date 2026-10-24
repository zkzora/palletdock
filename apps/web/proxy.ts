import { NextResponse, type NextRequest } from 'next/server';
import { forwardHeaders } from './lib/proxy-headers';

/** Runs before the /backend rewrite to the API: forwards the visitor's address for per-visitor rate limits. */
export function proxy(request: NextRequest) {
  return NextResponse.next({ request: { headers: forwardHeaders(request.headers, process.env.PALLETDOCK_PROXY_SECRET) } });
}

export const config = {
  matcher: '/backend/:path*',
};
