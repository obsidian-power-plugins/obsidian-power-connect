/* Optional end-to-end encryption: AES-256-GCM per file, key derived from the
 * passphrase with PBKDF2. The vault-wide salt lives in the remote marker
 * file, so every device derives the same key from the same passphrase; each
 * file carries its own random IV. Everything here runs on WebCrypto, which
 * exists on desktop, iOS, and Android alike (and in node 20 for the tests).
 *
 * File format: "PCE1" magic, 12-byte IV, ciphertext with the GCM tag.
 * GCM authenticates, so a wrong passphrase or a flipped bit fails loudly
 * instead of writing garbage over a note. */

const MAGIC = [0x50, 0x43, 0x45, 0x31]; // "PCE1"
const IV_LEN = 12;
export const E2E_ITERATIONS = 300_000;
const CHECK_TEXT = "power-connect-passphrase-check";

/** Thrown when bytes decrypt with the wrong key or arrive tampered. */
export class WrongKeyError extends Error {
	constructor() {
		super("The encryption passphrase does not match this file.");
	}
}

/** Thrown when encryption is on but the stored file is not encrypted. */
export class NotEncryptedError extends Error {
	constructor() {
		super("The file on Dropbox is not encrypted, but encryption is on.");
	}
}

export function bytesToB64(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

export function b64ToBytes(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export function makeSalt(): string {
	return bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
}

export async function deriveKey(passphrase: string, saltB64: string): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "PBKDF2", salt: b64ToBytes(saltB64) as BufferSource, iterations: E2E_ITERATIONS, hash: "SHA-256" },
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"]
	);
}

export function looksEncrypted(data: ArrayBuffer): boolean {
	if (data.byteLength < MAGIC.length + IV_LEN + 16) return false;
	const head = new Uint8Array(data, 0, MAGIC.length);
	return MAGIC.every((b, i) => head[i] === b);
}

export async function encryptBytes(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
	const out = new Uint8Array(MAGIC.length + IV_LEN + ct.length);
	out.set(MAGIC, 0);
	out.set(iv, MAGIC.length);
	out.set(ct, MAGIC.length + IV_LEN);
	return out.buffer;
}

export async function decryptBytes(key: CryptoKey, data: ArrayBuffer): Promise<ArrayBuffer> {
	if (!looksEncrypted(data)) throw new NotEncryptedError();
	const iv = new Uint8Array(data, MAGIC.length, IV_LEN);
	const ct = new Uint8Array(data, MAGIC.length + IV_LEN);
	try {
		return await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
	} catch {
		throw new WrongKeyError();
	}
}

/** A small value the marker file stores so a second device can verify its
 *  passphrase before touching anything. */
export async function makeCheck(key: CryptoKey): Promise<string> {
	return bytesToB64(new Uint8Array(await encryptBytes(key, new TextEncoder().encode(CHECK_TEXT).buffer)));
}

export async function verifyCheck(key: CryptoKey, check: string): Promise<boolean> {
	try {
		const plain = await decryptBytes(key, b64ToBytes(check).buffer as ArrayBuffer);
		return new TextDecoder().decode(plain) === CHECK_TEXT;
	} catch {
		return false;
	}
}
