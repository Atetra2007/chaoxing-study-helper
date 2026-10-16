import { sha256 } from '@noble/hashes/sha2.js';

export const createContentHash = () => sha256.create();
export const digestHex = hash => Array.from(hash.digest(), b => b.toString(16).padStart(2, '0')).join('');
