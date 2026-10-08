import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHash, createHmac } from 'node:crypto';

const PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scrypt(pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => _scrypt(pw, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

/** scrypt password hash: scrypt$N$r$p$salt$hash (base64url). */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error('Password must be at least 12 characters.');
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const got = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(v: string | Buffer): string {
  return createHash('sha256').update(v).digest('hex');
}

export function hmacHex(key: string, v: string): string {
  return createHmac('sha256', key).update(v).digest('hex');
}

export function safeEqualStr(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
