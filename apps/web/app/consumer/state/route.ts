import { consumerIsPublic, consumerState, loadConsumerConfig, ownerSession, sharedConsumerState, workspaceApiUrl } from '@/lib/consumer/server';

/**
 * State for the consumer demo page. Reads the public /v1 read API with a
 * server-side read key and returns derived data only. Private by default. A
 * deployment may explicitly expose this one demo with
 * PALLETDOCK_CONSUMER_PUBLIC=1; workspace and mutation routes remain private.
 */
export const dynamic = 'force-dynamic';

const noStore = { 'cache-control': 'no-store' };

export async function GET(request: Request) {
  if (!consumerIsPublic()) {
    const session = await ownerSession(request.headers.get('cookie'), workspaceApiUrl());
    if (session === 'unreachable') {
      return Response.json({ ok: false, config: null, error: { code: 'API_UNAVAILABLE', message: 'The PalletDock API is unreachable, so the session could not be checked.', status: null }, at: new Date().toISOString() }, { status: 503, headers: noStore });
    }
    if (session !== 'owner') {
      return Response.json({ ok: false, config: null, error: { code: 'UNAUTHORIZED', message: 'Sign in to the workspace to view the consumer demo.', status: 401 }, at: new Date().toISOString() }, { status: 401, headers: noStore });
    }
  }
  let config;
  try {
    config = await loadConsumerConfig();
  } catch (e) {
    return Response.json({ ok: false, config: null, error: { code: 'BAD_CONFIG', message: (e as Error).message, status: null }, at: new Date().toISOString() }, { status: 500, headers: noStore });
  }
  if (!config) {
    return Response.json(
      { ok: false, config: null, error: { code: 'NOT_CONFIGURED', message: 'No consumer read key is configured on the server. See docs/CONSUMER.md.', status: null }, at: new Date().toISOString() },
      { status: 503, headers: noStore },
    );
  }
  // Public viewers share one upstream read per few seconds so they cannot exhaust the API's per-IP rate limit.
  return Response.json(await (consumerIsPublic() ? sharedConsumerState(config) : consumerState(config)), { headers: noStore });
}
