// src/identity/encryption.ts
import { createCipheriv, createDecipheriv, scryptSync, randomBytes } from 'crypto';
import { getEnv } from '../types';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const ENCODING = 'hex';

function getKey() {
  const secret = getEnv('ENCRYPTION_KEY', '');
  if (!secret) {
    throw new Error('ENCRYPTION_KEY is not set in the .env file.');
  }
  // Use scrypt to derive a key of a consistent length
  return scryptSync(secret, 'salt', 32);
}

export function encrypt(text: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString(ENCODING);
}

export function decrypt(encryptedText: string): string {
  const key = getKey();
  const data = Buffer.from(encryptedText, ENCODING);
  const iv = data.slice(0, IV_LENGTH);
  const tag = data.slice(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = data.slice(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted, 'utf8'), decipher.final()]);
  return decrypted.toString('utf8');
}
