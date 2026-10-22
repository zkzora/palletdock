export function listenOptions(env: Record<string, string | undefined> = process.env): { host: string; port: number } {
  const host = env.API_HOST ?? (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  const port = Number(env.API_PORT ?? env.PORT ?? 4100);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('API_PORT/PORT must be a valid TCP port.');
  return { host, port };
}
