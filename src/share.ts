/* Receiving a share: the subscriber half of Power Connect sharing.
 *
 * A subscriber holds no provider account and signs into nothing. The owner
 * publishes an encrypted manifest at a stable URL and a keyring beside it
 * holding the content key sealed to each approved member. A subscriber
 * fetches both over plain HTTPS, opens its own keyring entry with a private
 * key that never leaves its devices, and reads the share. Until an owner
 * approves it there is no entry, so an invite alone opens nothing.
 * See SHARING.md for the whole transport and why it needs no server.
 *
 * Deliberately free of Obsidian and of the network: the caller injects both
 * (main.ts over the vault, tests over fakes), so every rule here is testable
 * in node. */

import { OwnedShare, Subscription, conflictName, contentHash, normKey, normRel, windowsUnsafe, junkFile, b64url } from "./core";
import { bytesToB64, b64ToBytes, decryptBytes, encryptBytes, looksEncrypted } from "./crypto";

export type { OwnedShare, Subscription };

/** Where shares live in the provider account: a sibling of the vault folder,
 *  never inside it. The sync engine lists only its own root, so nothing here
 *  can be mistaken for vault content or picked up by a sync. */
export const SHARE_ROOT = "Power Connect Shares";

/* ---------------- model ---------------- */

/** One file in a share, as the manifest describes it. `hash` is over the
 *  plaintext, so a subscriber can tell "unchanged" from "changed" without
 *  downloading, and `url` is already rewritten to a host that answers
 *  unauthenticated cross-origin requests (see directUrl). */
export interface ShareEntry {
	path: string;
	url: string;
	hash: string;
	size: number;
	mtime: number;
}

export interface ShareManifest {
	v: 1;
	id: string;
	name: string;
	/** Display label for the owner. Cosmetic: nothing is trusted from it. */
	owner: string;
	updated: number;
	files: ShareEntry[];
}

/** What the last pull wrote, per share-relative path. The anchor that turns
 *  "the file differs" into "who changed it": without it a subscriber cannot
 *  tell the owner's edit from the reader's own. */
export interface ShareState {
	entries: Record<string, { hash: string; mtime: number; size: number }>;
	lastPullMs: number;
	/** When this share is next worth checking, and how many checks in a row
	 *  have found nothing. A vault holding hundreds of shares cannot fetch
	 *  every one of them on every interval, so quiet shares back off. */
	nextCheckMs: number;
	quiet: number;
}

export function emptyShareState(): ShareState {
	return { entries: {}, lastPullMs: 0, nextCheckMs: 0, quiet: 0 };
}

/** How long before a share is worth checking again. Doubles for each check
 *  that found nothing, so an idle share settles to a couple of checks an hour
 *  while an active one stays at the base interval. */
export function nextCheckDelay(baseMs: number, quiet: number): number {
	const cap = 2 * 60 * 60 * 1000;
	return Math.min(baseMs * Math.pow(2, Math.max(0, quiet)), cap);
}

/** Signatures for many shares in one pass over the vault's file list.
 *
 *  The naive version asks "is this file in this share" for every pair, which
 *  at 200 shares over a 30,000-file vault is six million questions on every
 *  interval. Instead, index the shares by home folder and by attached path,
 *  then let each file look up its own ancestors: cost stops depending on how
 *  many shares exist. */
export function shareSignatures(
	shares: { id: string; homePath: string; attached: string[] }[],
	files: { path: string; mtime: number }[]
): Map<string, { latest: number; count: number }> {
	const byHome = new Map<string, string[]>();
	const byPath = new Map<string, string[]>();
	const out = new Map<string, { latest: number; count: number }>();
	for (const sh of shares) {
		out.set(sh.id, { latest: 0, count: 0 });
		const home = normRel(sh.homePath);
		if (home) byHome.set(normKey(home), [...(byHome.get(normKey(home)) ?? []), sh.id]);
		for (const a of sh.attached) {
			const k = normKey(a);
			byPath.set(k, [...(byPath.get(k) ?? []), sh.id]);
		}
	}
	if (!byHome.size && !byPath.size) return out;

	for (const f of files) {
		const rel = normRel(f.path);
		const key = normKey(rel);
		const hit = new Set<string>();
		for (const id of byPath.get(key) ?? []) hit.add(id);
		if (byHome.size) {
			// walk the ancestors, not the shares: a path has a handful of
			// parents no matter how many shares the vault publishes
			let cut = key.lastIndexOf("/");
			while (cut > 0) {
				for (const id of byHome.get(key.slice(0, cut)) ?? []) hit.add(id);
				cut = key.lastIndexOf("/", cut - 1);
			}
		}
		for (const id of hit) {
			const sig = out.get(id);
			if (!sig) continue;
			sig.count++;
			if (f.mtime > sig.latest) sig.latest = f.mtime;
		}
	}
	return out;
}

/* ---------------- keys ---------------- */

/** The content key: random, not derived from a passphrase, and never present
 *  in an invite. It reaches a member only sealed to a public key their owner
 *  approved, which is what makes approval mean something. Rotating it is how
 *  a revocation actually bites. */
export function makeShareKey(): string {
	return bytesToB64(crypto.getRandomValues(new Uint8Array(32)));
}

export async function importShareKey(keyB64: string): Promise<CryptoKey> {
	const raw = b64ToBytes(keyB64);
	if (raw.length !== 32) throw new Error("A share key must be 32 bytes.");
	return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/* ---------------- link rewriting ---------------- */

/** Providers hand back a URL for the share *page*, not the bytes, and that
 *  host does not answer cross-origin requests: measured 2026-07-25,
 *  www.dropbox.com and 1drv.ms send no Access-Control-Allow-Origin and serve
 *  text/html, while dl.dropboxusercontent.com sends `*` and the raw file.
 *  Mobile reads through the webview's own fetch (see dropbox.ts), so a
 *  manifest built from the returned URL works on desktop and fails on every
 *  phone. Rewrite once, at publish time, and store only this form. */
export function directUrl(url: string): string {
	let u = (url || "").trim();
	if (!u) return "";
	u = u.replace(/^https?:\/\/(www\.)?dropbox\.com\//i, "https://dl.dropboxusercontent.com/");
	u = u.replace(/[?&]dl=0\b/i, (m) => (m[0] === "?" ? "?dl=1" : "&dl=1"));
	if (!/[?&]dl=1\b/i.test(u) && /dropboxusercontent\.com/i.test(u)) u += (u.includes("?") ? "&" : "?") + "dl=1";
	return u;
}

/** Whether a URL is one a subscriber may fetch. A manifest is remote data and
 *  gets to name URLs; it does not get to point the plugin at file:// or at a
 *  host that never serves shares. */
export function fetchableUrl(url: string): boolean {
	if (!/^https:\/\//i.test(url)) return false;
	const host = url.slice(8).split(/[/?#]/)[0].toLowerCase();
	return host === "dl.dropboxusercontent.com" || host === "api.onedrive.com" || host === "www.googleapis.com";
}

/* ---------------- membership: keys, requests, approval ---------------- */

/** One member's identity. The private half never leaves their devices; the
 *  public half travels in the request code they send back. P-256 because
 *  WebCrypto has it everywhere Obsidian runs, including both phones. */
export interface MemberKeys {
	memberId: string;
	publicKey: string;
	privateJwk: string;
}

export async function generateMemberKeys(): Promise<MemberKeys> {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"]);
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
	return { memberId: b64url(crypto.getRandomValues(new Uint8Array(9))), publicKey: bytesToB64(raw), privateJwk: JSON.stringify(jwk) };
}

async function importMemberPublic(b64: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", b64ToBytes(b64) as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
}

async function importMemberPrivate(jwk: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("jwk", JSON.parse(jwk) as JsonWebKey, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey", "deriveBits"]);
}

/** One member's copy of the content key, sealed so only their private key
 *  opens it. The ephemeral public key is per-entry, so re-wrapping after a
 *  rotation never reuses a derived secret. */
export interface KeyringEntry {
	memberId: string;
	ephemeral: string;
	sealed: string;
}

export interface Keyring {
	v: 1;
	id: string;
	entries: KeyringEntry[];
}

/** The keyring is published in the clear: every entry is individually sealed,
 *  so there is nothing in it to hide. That is what lets a recipient fetch it
 *  before they hold any key at all, which is the whole point of moving the
 *  key out of the invite. */
async function sharedSecret(priv: CryptoKey, pub: CryptoKey): Promise<CryptoKey> {
	return crypto.subtle.deriveKey({ name: "ECDH", public: pub }, priv, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function wrapKeyFor(memberPublicKey: string, memberId: string, contentKeyB64: string): Promise<KeyringEntry> {
	const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
	const secret = await sharedSecret(eph.privateKey, await importMemberPublic(memberPublicKey));
	const sealed = await encryptBytes(secret, b64ToBytes(contentKeyB64).buffer as ArrayBuffer);
	return {
		memberId,
		ephemeral: bytesToB64(new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey))),
		sealed: bytesToB64(new Uint8Array(sealed)),
	};
}

/** Thrown when a share exists and is reachable but this device has not been
 *  let in. Its own error because it is not a failure: it is the normal state
 *  between sending a request and the owner approving it. */
export class ShareNotApproved extends Error {}

export async function unwrapContentKey(privateJwk: string, entry: KeyringEntry): Promise<string> {
	const secret = await sharedSecret(await importMemberPrivate(privateJwk), await importMemberPublic(entry.ephemeral));
	const raw = await decryptBytes(secret, b64ToBytes(entry.sealed).buffer as ArrayBuffer);
	return bytesToB64(new Uint8Array(raw));
}

/* ---------------- request code ---------------- */

export interface JoinRequest {
	shareId: string;
	memberId: string;
	name: string;
	publicKey: string;
}

/** What a recipient sends back. Carries no secret: it is a public key and a
 *  name, and it is useless to anyone but the owner of the share it names. */
export function makeJoinCode(r: JoinRequest): string {
	const json = JSON.stringify({ s: r.shareId, m: r.memberId, n: r.name, k: r.publicKey });
	return `PCON-JOIN:1:${b64url(new TextEncoder().encode(json))}`;
}

export function looksLikeJoinCode(text: string): boolean {
	return /^pcon[-–—]join:/i.test(text.trim());
}

export function parseJoinCode(text: string): JoinRequest | null {
	const m = text
		.trim()
		.replace(/[–—]/g, "-")
		.match(/^pcon-join:1:([A-Za-z0-9_-]+)$/i);
	if (!m) return null;
	try {
		const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
		const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))) as Record<string, unknown>;
		const shareId = typeof p.s === "string" ? p.s : "";
		const memberId = typeof p.m === "string" ? p.m : "";
		const publicKey = typeof p.k === "string" ? p.k : "";
		if (!shareId || !memberId || !publicKey) return null;
		// a public key that will not import is a damaged code, not a member
		if (b64ToBytes(publicKey).length !== 65) return null;
		return { shareId, memberId, publicKey, name: typeof p.n === "string" && p.n ? p.n : "Someone" };
	} catch {
		return null;
	}
}

/* ---------------- invite code ---------------- */

/** One paste, like the device setup code (core.ts), and the same shape so the
 *  two are recognizable as siblings.
 *
 *  Version 2 carries no key. A stolen invite is worth nothing on its own: its
 *  holder can fetch ciphertext and never be able to open it, because opening
 *  a share requires the owner to have wrapped the content key to a public key
 *  they approved. Version 1 put the key in the code, which meant anyone who
 *  got hold of it could read the share. */
export interface ShareCode {
	id: string;
	name: string;
	owner: string;
	manifestUrl: string;
	keyringUrl: string;
}

export function makeShareCode(o: ShareCode): string {
	const json = JSON.stringify({ i: o.id, n: o.name, o: o.owner, m: o.manifestUrl, r: o.keyringUrl });
	return `PCON-SHARE:2:${b64url(new TextEncoder().encode(json))}`;
}

/** Looks like a share code, whether or not it parses: mobile keyboards
 *  lowercase the prefix and swap hyphens for dashes, and a near-miss must
 *  produce "that code is damaged", not "that is not a code". */
export function looksLikeShareCode(text: string): boolean {
	return /^pcon[-–—]share:/i.test(text.trim());
}

/** Thrown for a version 1 invite: readable, but from the design where the
 *  key traveled in the code. Says so plainly rather than failing as if the
 *  code were damaged. */
export class ShareCodeOutdated extends Error {}

export function parseShareCode(text: string): ShareCode | null {
	const t = text.trim().replace(/[–—]/g, "-");
	if (/^pcon-share:1:/i.test(t)) throw new ShareCodeOutdated("That invite was made by an older version of Power Connect. Ask for a new one.");
	const m = t.match(/^pcon-share:2:([A-Za-z0-9_-]+)$/i);
	if (!m) return null;
	try {
		const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const p = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
		const id = typeof p.i === "string" ? p.i : "";
		const url = typeof p.m === "string" ? p.m : "";
		const ring = typeof p.r === "string" ? p.r : "";
		if (!id || !fetchableUrl(url) || !fetchableUrl(ring)) return null;
		return {
			id,
			manifestUrl: url,
			keyringUrl: ring,
			name: typeof p.n === "string" ? p.n : "Shared notes",
			owner: typeof p.o === "string" ? p.o : "",
		};
	} catch {
		return null;
	}
}

/* ---------------- manifest ---------------- */

export async function encodeManifest(key: CryptoKey, m: ShareManifest): Promise<ArrayBuffer> {
	return encryptBytes(key, new TextEncoder().encode(JSON.stringify(m)).buffer);
}

/** Thrown when the bytes at the manifest URL are not a manifest this key can
 *  open: a revoked share, a rotated key, or a link that now points at an
 *  error page. All three want the same message, not a stack trace. */
export class ShareUnreadable extends Error {}

export async function decodeManifest(key: CryptoKey, bytes: ArrayBuffer): Promise<ShareManifest> {
	if (!looksEncrypted(bytes)) throw new ShareUnreadable("That share did not return readable content. The link may have been revoked.");
	let plain: ArrayBuffer;
	try {
		plain = await decryptBytes(key, bytes);
	} catch {
		throw new ShareUnreadable("This share's key no longer opens it. The owner may have revoked access or rotated the key.");
	}
	let m: ShareManifest;
	try {
		m = JSON.parse(new TextDecoder().decode(plain)) as ShareManifest;
	} catch {
		throw new ShareUnreadable("That share's index could not be read.");
	}
	if (!m || m.v !== 1 || !Array.isArray(m.files)) throw new ShareUnreadable("That share was published by a newer version of Power Connect.");
	return m;
}

/* ---------------- planning ---------------- */

export type ShareAction =
	| { t: "add"; path: string; entry: ShareEntry }
	| { t: "update"; path: string; entry: ShareEntry }
	| { t: "conflict"; path: string; entry: ShareEntry }
	| { t: "keepLocal"; path: string }
	| { t: "release"; path: string }
	| { t: "unsafe"; path: string; why: string };

export interface SharePlan {
	actions: ShareAction[];
	adds: number;
	updates: number;
	conflicts: number;
	releases: number;
}

/** Decide what one pull should do. Pure, given the manifest, the hashes of
 *  what is on disk now, and the hashes of what the last pull wrote.
 *
 *  The rule that matters most is the quiet one: when the local file already
 *  matches the manifest, do nothing at all: no write, no touched mtime.
 *  Subscribers' vaults are usually synced by something else (Obsidian Sync,
 *  OneDrive), and every device of theirs runs this. Rewriting identical bytes
 *  with a fresh timestamp would hand their own sync an endless stream of
 *  changes to replicate. Skipping makes concurrent subscribers converge
 *  instead of fighting. */
/** Is this path the vault's configuration folder, or inside it?
 *
 *  The folder is only called `.obsidian` by default; a vault can be opened
 *  with any name, so the caller passes `Vault#configDir` and the literal here
 *  is a fallback for the pure callers (the tests) that have no vault. */
export function inConfigFolder(path: string, configDir = ".obsidian"): boolean {
	return path === configDir || path.startsWith(`${configDir}/`);
}

export function planSharePull(manifest: ShareManifest, local: Map<string, string | null>, state: ShareState, maxBytes = 0, configDir?: string): SharePlan {
	const actions: ShareAction[] = [];
	const seen = new Set<string>();

	for (const entry of manifest.files) {
		const path = normRel(entry.path);
		if (!path || path.startsWith("../") || path.includes("/../")) continue;
		seen.add(path);

		// a share is vault content; it never carries configuration or code
		if (inConfigFolder(path, configDir) || junkFile(path)) continue;
		if (!fetchableUrl(entry.url)) {
			actions.push({ t: "unsafe", path, why: "its link does not point at a known file host" });
			continue;
		}
		const bad = windowsUnsafe(path);
		if (bad) {
			actions.push({ t: "unsafe", path, why: bad });
			continue;
		}
		if (maxBytes > 0 && entry.size > maxBytes) {
			actions.push({ t: "unsafe", path, why: "it is larger than this vault's size limit" });
			continue;
		}

		const here = local.get(path) ?? null;
		const last = state.entries[path];

		if (here == null) {
			// gone locally after we wrote it once: the reader deleted it, and
			// re-adding it every pull would be nagging, not syncing
			if (last && last.hash === entry.hash) continue;
			actions.push({ t: "add", path, entry });
			continue;
		}
		if (here === entry.hash) continue; // already current: the quiet path
		if (!last) {
			// a file of theirs already sits where the share wants to land
			actions.push({ t: "conflict", path, entry });
			continue;
		}
		if (here === last.hash) {
			actions.push({ t: "update", path, entry });
			continue;
		}
		// the reader edited it. Read-only means the owner's copy is what
		// arrives, never that the reader's work is disposable.
		if (entry.hash === last.hash) actions.push({ t: "keepLocal", path });
		else actions.push({ t: "conflict", path, entry });
	}

	for (const path of Object.keys(state.entries)) {
		// dropped from the share: stop tracking it, leave the file. Narrowing a
		// selection must never delete from someone else's vault.
		if (!seen.has(path)) actions.push({ t: "release", path });
	}

	return {
		actions,
		adds: actions.filter((a) => a.t === "add").length,
		updates: actions.filter((a) => a.t === "update").length,
		conflicts: actions.filter((a) => a.t === "conflict").length,
		releases: actions.filter((a) => a.t === "release").length,
	};
}

/* ---------------- execution ---------------- */

/** The vault and the network, as a pull needs them. */
export interface ShareIO {
	/** Unauthenticated GET. Desktop and mobile differ; main.ts decides how. */
	fetchBytes(url: string): Promise<ArrayBuffer>;
	read(rel: string): Promise<ArrayBuffer>;
	write(rel: string, bytes: ArrayBuffer, mtimeMs: number): Promise<void>;
	exists(rel: string): Promise<boolean>;
	log(level: "info" | "warn" | "error" | "debug", text: string): void;
}

export interface PullResult {
	plan: SharePlan;
	written: number;
	conflicts: string[];
	failed: { path: string; why: string }[];
}

/** Hash every file the share names that exists locally, so the planner can
 *  tell current from changed without downloading anything. */
async function localHashes(io: ShareIO, root: string, manifest: ShareManifest, state: ShareState): Promise<Map<string, string | null>> {
	const out = new Map<string, string | null>();
	const paths = new Set<string>([...manifest.files.map((f) => normRel(f.path)), ...Object.keys(state.entries)]);
	for (const rel of paths) {
		if (!rel) continue;
		const full = root ? `${root}/${rel}` : rel;
		if (!(await io.exists(full))) {
			out.set(rel, null);
			continue;
		}
		try {
			out.set(rel, await contentHash(await io.read(full)));
		} catch {
			out.set(rel, null);
		}
	}
	return out;
}

/** Fetch a share and apply it. Returns what happened; the caller decides
 *  what to say about it. Never throws for one bad file: a share with a dead
 *  link in it should still deliver everything else. */
export async function pullShare(io: ShareIO, sub: Subscription, state: ShareState, contentKeyB64: string, maxBytes = 0, configDir?: string): Promise<PullResult> {
	const key = await importShareKey(contentKeyB64);
	const raw = await io.fetchBytes(sub.manifestUrl);
	const manifest = await decodeManifest(key, raw);
	const root = normRel(sub.localPath);

	const local = await localHashes(io, root, manifest, state);
	const plan = planSharePull(manifest, local, state, maxBytes, configDir);

	const result: PullResult = { plan, written: 0, conflicts: [], failed: [] };

	for (const a of plan.actions) {
		const full = root ? `${root}/${a.path}` : a.path;
		try {
			if (a.t === "release") {
				delete state.entries[a.path];
				io.log("info", `No longer shared, left in place: ${full}`);
				continue;
			}
			if (a.t === "keepLocal") {
				io.log("debug", `Kept your edit to ${full}; the shared copy has not changed.`);
				continue;
			}
			if (a.t === "unsafe") {
				result.failed.push({ path: a.path, why: a.why });
				io.log("warn", `Skipped ${a.path}: ${a.why}.`);
				continue;
			}

			const bytes = await decryptBytes(key, await io.fetchBytes(a.entry.url));
			const got = await contentHash(bytes);
			if (got !== a.entry.hash) {
				// the manifest is the authority on what a share contains; bytes
				// that do not match it are not the file it promised
				result.failed.push({ path: a.path, why: "the downloaded file did not match the share's index" });
				io.log("warn", `Skipped ${a.path}: content did not match the share's index.`);
				continue;
			}

			if (a.t === "conflict") {
				const mine = await io.read(full);
				const copy = conflictName(full, Date.now(), await contentHash(mine));
				await io.write(copy, mine, Date.now());
				result.conflicts.push(copy);
				io.log("warn", `${full} changed on both sides; your version is kept as ${copy}.`);
			}

			await io.write(full, bytes, a.entry.mtime);
			state.entries[a.path] = { hash: a.entry.hash, mtime: a.entry.mtime, size: a.entry.size };
			result.written++;
		} catch (e) {
			const why = e instanceof Error ? e.message : String(e);
			result.failed.push({ path: a.path, why });
			io.log("warn", `Could not update ${full}: ${why}`);
		}
	}

	state.lastPullMs = Date.now();
	return result;
}

/* ---------------- publishing ---------------- */

/** One vault file that a share carries: where it lives here, and where it
 *  lands there. */
export interface ShareFile {
	/** Path in this vault. */
	local: string;
	/** Path inside the share, which is what the recipient sees. */
	share: string;
	hash: string;
	size: number;
	mtime: number;
}

export interface ResolveResult {
	files: ShareFile[];
	/** Paths that cannot be shared, with the reason, for the UI to show. */
	skipped: { local: string; why: string }[];
}

/** Work out exactly which vault files a share carries, and what each one is
 *  called inside it.
 *
 *  Files under the home folder keep their path relative to it. Attached files
 *  from elsewhere keep their full vault path, so links among them survive and
 *  a folder of meeting notes still looks like a folder of meeting notes on
 *  the other side. Where those two rules would collide, the home folder wins
 *  and the attachment is reported rather than silently dropped. */
export function resolveShareFiles(
	share: { homePath: string; attached: string[] },
	all: { path: string; size: number; mtime: number }[],
	hashes: Map<string, string>,
	maxBytes = 0,
	configDir?: string
): ResolveResult {
	const home = normRel(share.homePath);
	const files: ShareFile[] = [];
	const skipped: { local: string; why: string }[] = [];
	const taken = new Map<string, string>();

	const consider = (local: string, sharePath: string, size: number, mtime: number) => {
		if (inConfigFolder(local, configDir)) {
			skipped.push({ local, why: "a share never carries plugin settings or code" });
			return;
		}
		if (junkFile(local)) return;
		const bad = windowsUnsafe(sharePath);
		if (bad) {
			skipped.push({ local, why: `Windows cannot write that name (${bad})` });
			return;
		}
		if (maxBytes > 0 && size > maxBytes) {
			skipped.push({ local, why: `it is larger than this vault's size limit` });
			return;
		}
		const key = normKey(sharePath);
		const already = taken.get(key);
		if (already) {
			if (already !== local) skipped.push({ local, why: `another file already arrives as "${sharePath}"` });
			return;
		}
		const hash = hashes.get(local);
		if (hash == null) {
			skipped.push({ local, why: "it could not be read" });
			return;
		}
		taken.set(key, local);
		files.push({ local, share: sharePath, hash, size, mtime });
	};

	const byPath = new Map(all.map((f) => [normRel(f.path), f]));
	if (home) {
		const prefix = home + "/";
		for (const f of all) {
			const rel = normRel(f.path);
			if (!rel.startsWith(prefix)) continue;
			consider(rel, rel.slice(prefix.length), f.size, f.mtime);
		}
	}
	for (const a of share.attached) {
		const rel = normRel(a);
		if (!rel) continue;
		if (home && rel.startsWith(home + "/")) continue; // already carried by the home folder
		const f = byPath.get(rel);
		if (!f) {
			skipped.push({ local: rel, why: "it is no longer in this vault" });
			continue;
		}
		consider(rel, rel, f.size, f.mtime);
	}
	return { files, skipped };
}

export interface PublishPlan {
	/** Content that has no blob yet: upload once, link once. */
	uploads: ShareFile[];
	/** Blobs no file references any more: revoke the link, delete the blob. */
	orphans: { hash: string; url: string }[];
	/** The index this publish will write, minus the URLs still to be minted. */
	files: ShareFile[];
	unchanged: number;
}

/** Blobs are named by the hash of their plaintext, which buys three things
 *  at once: identical files upload once, a note that is merely moved or
 *  renamed keeps its blob and its link (no re-upload, no new URL for the
 *  recipient), and no note title ever appears in a path. */
export function blobPath(remoteFolder: string, hash: string): string {
	return `/${SHARE_ROOT}/${remoteFolder}/files/${hash}`;
}

export function manifestPath(remoteFolder: string): string {
	return `/${SHARE_ROOT}/${remoteFolder}/index.pcs`;
}

export function keyringPath(remoteFolder: string): string {
	return `/${SHARE_ROOT}/${remoteFolder}/keyring.json`;
}

/** Build the keyring for everyone currently approved. Called on every
 *  approval, denial, and revocation, and after a key rotation. */
export async function buildKeyring(share: OwnedShare): Promise<Keyring> {
	const entries: KeyringEntry[] = [];
	for (const m of share.members) {
		if (m.state !== "approved") continue;
		entries.push(await wrapKeyFor(m.publicKey, m.memberId, share.key));
	}
	return { v: 1, id: share.id, entries };
}

/** A subscriber's content key, or a clear statement of why they have none.
 *  Fetched every pull rather than cached: it is a small file, and reading it
 *  fresh is what makes a rotation after a revocation take effect promptly
 *  instead of whenever a cache happens to expire. */
export async function resolveMemberKey(io: { fetchBytes(url: string): Promise<ArrayBuffer> }, sub: Subscription): Promise<string> {
	let ring: Keyring;
	try {
		const raw = await io.fetchBytes(sub.keyringUrl);
		ring = JSON.parse(new TextDecoder().decode(raw)) as Keyring;
	} catch {
		throw new ShareUnreadable("That share could not be reached. The owner may have stopped sharing it.");
	}
	const entry = (ring.entries ?? []).find((e) => e.memberId === sub.memberId);
	if (!entry) {
		throw new ShareNotApproved(
			sub.key
				? "Access to this share has been withdrawn by its owner. The notes already here stay in your vault."
				: "Waiting for the owner to approve your request. Send them your request code if you have not already."
		);
	}
	try {
		return await unwrapContentKey(sub.privateJwk, entry);
	} catch {
		throw new ShareUnreadable("This share's key could not be opened on this device.");
	}
}

/** Decide what one publish must move. Pure: given what the share should hold
 *  and what the last published index says it holds. */
export function planSharePublish(files: ShareFile[], prev: ShareManifest | null): PublishPlan {
	const known = new Map<string, string>();
	for (const e of prev?.files ?? []) if (e.hash && e.url) known.set(e.hash, e.url);

	const wanted = new Set(files.map((f) => f.hash));
	const uploads: ShareFile[] = [];
	const seen = new Set<string>();
	let unchanged = 0;
	for (const f of files) {
		if (known.has(f.hash)) unchanged++;
		else if (!seen.has(f.hash)) uploads.push(f);
		seen.add(f.hash);
	}

	const orphans: { hash: string; url: string }[] = [];
	for (const [hash, url] of known) if (!wanted.has(hash)) orphans.push({ hash, url });

	return { uploads, orphans, files, unchanged };
}

/** The provider, as publishing needs it. main.ts implements this over the
 *  Dropbox client; tests implement it in memory. */
export interface PublishIO {
	read(local: string): Promise<ArrayBuffer>;
	upload(remotePath: string, bytes: ArrayBuffer): Promise<void>;
	/** Create the file's public link, or return the one it already has.
	 *  Must return a direct-download URL (see directUrl). */
	link(remotePath: string): Promise<string>;
	remove(remotePath: string): Promise<void>;
	unlink(url: string): Promise<void>;
	log(level: "info" | "warn" | "error" | "debug", text: string): void;
}

export interface PublishResult {
	manifest: ShareManifest;
	/** The index's stable link. Minted on the first publish and unchanged
	 *  afterwards, so every invite ever issued keeps working. */
	manifestUrl: string;
	/** The keyring's stable link, on the same terms. */
	keyringUrl: string;
	uploaded: number;
	reused: number;
	removed: number;
	failed: { local: string; why: string }[];
}

/** Publish a share: upload what is new, mint links for it, write the index,
 *  and clean up what nothing references any more.
 *
 *  Order matters. The index is written last, so a publish that dies halfway
 *  leaves the previous index intact and every recipient still reading a
 *  coherent share. Orphans are swept after that, for the same reason: a blob
 *  deleted before the index stops naming it is a broken share for anyone who
 *  pulls in between. */
export async function publishShare(io: PublishIO, share: OwnedShare, files: ShareFile[], prev: ShareManifest | null): Promise<PublishResult> {
	const key = await importShareKey(share.key);
	const plan = planSharePublish(files, prev);
	const urls = new Map<string, string>();
	for (const e of prev?.files ?? []) if (e.hash && e.url) urls.set(e.hash, e.url);

	const failed: { local: string; why: string }[] = [];
	let uploaded = 0;

	for (const f of plan.uploads) {
		try {
			const bytes = await io.read(f.local);
			const path = blobPath(share.remoteFolder, f.hash);
			await io.upload(path, await encryptBytes(key, bytes));
			urls.set(f.hash, await io.link(path));
			uploaded++;
		} catch (e) {
			failed.push({ local: f.local, why: e instanceof Error ? e.message : String(e) });
			io.log("warn", `Could not publish ${f.local}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	const entries: ShareEntry[] = [];
	for (const f of plan.files) {
		const url = urls.get(f.hash);
		if (!url) continue; // its upload failed; leave it out rather than name a file nobody can fetch
		entries.push({ path: f.share, url, hash: f.hash, size: f.size, mtime: f.mtime });
	}

	const manifest: ShareManifest = {
		v: 1,
		id: share.id,
		name: share.name,
		owner: "",
		updated: Date.now(),
		files: entries,
	};
	const index = manifestPath(share.remoteFolder);
	await io.upload(index, await encodeManifest(key, manifest));
	// minted once, on the first publish: the file is overwritten in place
	// afterwards, so the link outlives every republish and no invite goes stale
	const manifestUrl = share.manifestUrl || (await io.link(index));
	const keyringUrl = await publishKeyring(io, share);

	let removed = 0;
	for (const o of plan.orphans) {
		try {
			await io.unlink(o.url);
			await io.remove(blobPath(share.remoteFolder, o.hash));
			removed++;
		} catch {
			// a blob that outlives its share costs a little storage and
			// nothing else; the next publish tries again
		}
	}

	return { manifest, manifestUrl, keyringUrl, uploaded, reused: plan.unchanged, removed, failed };
}

/** Write the keyring and return its stable link. Approving, denying, and
 *  revoking all come through here: a membership change costs one small
 *  upload, never a republish of the content. */
export async function publishKeyring(io: PublishIO, share: OwnedShare): Promise<string> {
	const path = keyringPath(share.remoteFolder);
	const body = new TextEncoder().encode(JSON.stringify(await buildKeyring(share))).buffer;
	await io.upload(path, body);
	return share.keyringUrl || (await io.link(path));
}

/** The invite for a share, ready to send. Carries the key, so it must travel
 *  out of band and never through the share itself. */
export function inviteFor(share: OwnedShare, owner: string): string {
	return makeShareCode({ id: share.id, name: share.name, owner, manifestUrl: share.manifestUrl, keyringUrl: share.keyringUrl });
}

export function publishSummary(r: PublishResult): string {
	const bits: string[] = [];
	if (r.uploaded) bits.push(`${r.uploaded} file(s) published`);
	if (r.reused) bits.push(`${r.reused} unchanged`);
	if (r.removed) bits.push(`${r.removed} withdrawn`);
	if (r.failed.length) bits.push(`${r.failed.length} could not be read`);
	return bits.length ? bits.join(", ") : "nothing to publish";
}

/** One line for the status bar and the log, in the plugin's voice. */
export function pullSummary(r: PullResult): string {
	const bits: string[] = [];
	if (r.written) bits.push(`${r.written} file(s) updated`);
	if (r.conflicts.length) bits.push(`${r.conflicts.length} conflict copy(ies)`);
	if (r.plan.releases) bits.push(`${r.plan.releases} no longer shared`);
	if (r.failed.length) bits.push(`${r.failed.length} skipped`);
	return bits.length ? bits.join(", ") : "already up to date";
}
