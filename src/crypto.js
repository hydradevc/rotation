import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PREFIX = 'enc:v1:';
let masterKey = null;
let source = 'none';

export function initMasterKey(dataDir) {
  const env = process.env.HYDRA_MASTER_KEY;
  if (env) {
    const trimmed = env.trim();
    const buf = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
    if (buf.length !== 32) {
      throw new Error('HYDRA_MASTER_KEY must be 32 bytes (64 hex chars or 44 base64 chars)');
    }
    masterKey = buf;
    source = 'env';
    return 'env';
  }

  const file = path.join(dataDir, 'master.key');
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file);
    const text = raw.toString('utf8').trim();
    masterKey = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : raw;
    if (masterKey.length !== 32) throw new Error(`${file} is corrupt: expected 32 bytes`);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort on exotic filesystems */
    }
    source = 'file';
    return 'file';
  }

  masterKey = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, masterKey.toString('hex'), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  source = 'generated';
  return 'generated';
}

export function masterKeySource() {
  return source;
}

export function isSealed(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function seal(plain) {
  if (plain == null || plain === '') return plain;
  if (isSealed(plain)) return plain;
  if (!masterKey) throw new Error('master key is not initialised');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

export function open(sealed) {
  if (!isSealed(sealed)) return sealed;
  if (!masterKey) throw new Error('master key is not initialised');
  const parts = sealed.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('malformed sealed value');
  const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function openSafe(sealed) {
  try {
    return open(sealed);
  } catch {
    return null;
  }
}