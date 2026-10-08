export interface RpcCaller {
  call<T>(method: string, params?: readonly unknown[]): Promise<T>;
}

export type RpcTransportFailure = 'timeout' | 'network' | 'http' | 'invalid_response' | 'response_too_large';

export class RpcTransportError extends Error {
  constructor(
    message: string,
    public readonly kind: RpcTransportFailure,
    public readonly method: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'RpcTransportError';
  }
}

export class RpcResponseError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly data: unknown,
    public readonly method: string,
  ) {
    super(message);
    this.name = 'RpcResponseError';
  }
}

export interface JsonRpcClientOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

/** A bounded JSON-RPC 2.0 HTTP client used by the server-side EVM adapter. */
export class JsonRpcClient implements RpcCaller {
  private requestId = 0;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(
    public readonly url: string,
    options: JsonRpcClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 20 * 1024 * 1024;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = options.headers ?? {};
  }

  async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    const id = ++this.requestId;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...this.headers },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new RpcTransportError(`RPC ${method} timed out after ${this.timeoutMs} ms`, 'timeout', method);
      throw new RpcTransportError(`RPC ${method} failed: ${(error as Error).message}`, 'network', method);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new RpcTransportError(`RPC ${method} returned HTTP ${response.status}`, 'http', method, response.status);
    }
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > this.maxResponseBytes) {
      throw new RpcTransportError(`RPC ${method} response exceeds ${this.maxResponseBytes} bytes`, 'response_too_large', method);
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > this.maxResponseBytes) {
      throw new RpcTransportError(`RPC ${method} response exceeds ${this.maxResponseBytes} bytes`, 'response_too_large', method);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RpcTransportError(`RPC ${method} returned invalid JSON`, 'invalid_response', method);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new RpcTransportError(`RPC ${method} returned an invalid JSON-RPC envelope`, 'invalid_response', method);
    }
    const envelope = body as { jsonrpc?: unknown; id?: unknown; result?: T; error?: { code?: unknown; message?: unknown; data?: unknown } };
    if (envelope.jsonrpc !== '2.0' || envelope.id !== id) {
      throw new RpcTransportError(`RPC ${method} returned a mismatched JSON-RPC envelope`, 'invalid_response', method);
    }
    if (envelope.error) {
      const code = typeof envelope.error.code === 'number' ? envelope.error.code : -32000;
      const message = typeof envelope.error.message === 'string' ? envelope.error.message : 'Unknown JSON-RPC error';
      throw new RpcResponseError(message, code, envelope.error.data, method);
    }
    if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) {
      throw new RpcTransportError(`RPC ${method} response has no result`, 'invalid_response', method);
    }
    return envelope.result as T;
  }
}
