import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { JsonRpcClient, RpcResponseError, RpcTransportError } from '../src/json-rpc.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function rpcServer(handler: (body: any) => unknown | Promise<unknown>): Promise<string> {
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    const result = await handler(body);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(result));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server failed to bind');
  return `http://127.0.0.1:${address.port}`;
}

describe('JsonRpcClient', () => {
  it('sends a JSON-RPC envelope and returns the exact result', async () => {
    const url = await rpcServer((body) => {
      expect(body).toMatchObject({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [] });
      return { jsonrpc: '2.0', id: body.id, result: '0x20000000000001' };
    });
    await expect(new JsonRpcClient(url).call('eth_blockNumber')).resolves.toBe('0x20000000000001');
  });

  it('preserves JSON-RPC error code and data', async () => {
    const url = await rpcServer((body) => ({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found', data: { method: body.method } } }));
    const error = await new JsonRpcClient(url).call('debug_traceTransaction').catch((value) => value);
    expect(error).toBeInstanceOf(RpcResponseError);
    expect(error).toMatchObject({ code: -32601, data: { method: 'debug_traceTransaction' } });
  });

  it('aborts requests at the configured deadline', async () => {
    const url = await rpcServer(async (body) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { jsonrpc: '2.0', id: body.id, result: true };
    });
    const error = await new JsonRpcClient(url, { timeoutMs: 10 }).call('slow').catch((value) => value);
    expect(error).toBeInstanceOf(RpcTransportError);
    expect(error).toMatchObject({ kind: 'timeout', method: 'slow' });
  });
});
