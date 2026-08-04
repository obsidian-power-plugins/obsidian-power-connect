/* Power Connect core: every decision the sync engine makes, as pure functions
 * with no Obsidian and no network in sight, so tests.ts can hold the whole
 * sync matrix. IO lives in main.ts and dropbox.ts; anything that can be
 * subtly wrong lives here, where it is testable. */

/** Build stamp shown in settings and logged on load. Must match
 *  manifest.json's version; tests enforce it. */
export const PCON_BUILD = "1.15.20";

/* ---------------- settings ---------------- */

export interface PconSettings {
	/** Which storage provider this vault syncs through. */
	provider: "dropbox" | "onedrive" | "gdrive";
	appKey: string;
	refreshToken: string;
	accessToken: string;
	accessExpiry: number;
	accountEmail: string;
	/** OneDrive: the Azure app (client) id. Public, shared like appKey. */
	odClientId: string;
	odRefresh: string;
	odAccess: string;
	odExpiry: number;
	odAccount: string;
	/** Google: OAuth desktop-app client id and secret; Google documents the
	 *  installed-app secret as not confidential, and sharing it is what lets
	 *  other devices sign in to the same app. */
	gClientId: string;
	gClientSecret: string;
	gRefresh: string;
	gAccess: string;
	gExpiry: number;
	gAccount: string;
	/** Folder under the Dropbox app folder holding this vault. Empty = vault name. */
	remoteFolder: string;
	/** One gitignore-style pattern per line. */
	excludes: string;
	/** Sync the .obsidian folder too (minus the always-excluded files). */
	syncConfig: boolean;
	/** With syncConfig on, also sync plugins' data.json files. They routinely
	 *  hold API keys, so the engine moves them only under an encryption
	 *  envelope (full e2e or the marker's secrets protection); without one
	 *  they are held back regardless of this flag. */
	syncPluginData: boolean;
	/** Top-level folders whose files upload encrypted while the rest of the
	 *  vault stays plain. Meaningful only when full e2e is off; whole-folder
	 *  encryption covers everything already. Shares the one protection
	 *  passphrase with plugin-settings protection. Stored lowercased. */
	protectedFolders: string[];
	syncOnStart: boolean;
	/** Sync shortly after Obsidian returns to the foreground. The trigger
	 *  that matters most on phones, where nothing runs in the background. */
	syncOnResume: boolean;
	/** Desktop: hold a Dropbox longpoll open so remote changes land within
	 *  seconds instead of waiting for the next interval. */
	liveSync: boolean;
	/** Minutes between automatic syncs. 0 = off. */
	autoMinutes: number;
	/** Seconds of quiet after an edit before a sync runs. 0 = off. */
	watchSeconds: number;
	conflictPolicy: "both" | "local" | "remote" | "ask";
	/** Combine concurrent edits to the same text file when they touch
	 *  different lines, using the base revision as the common ancestor.
	 *  Colliding edits still keep both copies. */
	autoMerge: boolean;
	/** Skip files larger than this many MB, in both directions. 0 = no limit. */
	maxFileMB: number;
	/** Pause and ask when one sync wants to delete more than this share of the
	 *  vault (and more than 10 files). A wiped Dropbox folder or a bad scan
	 *  must never silently empty the other side. */
	deleteGuardPct: number;
	e2eEnabled: boolean;
	e2ePassphrase: string;
	notices: "all" | "changes" | "errors";
	concurrency: number;
	verboseLog: boolean;
	/** Shares this vault receives. Kept in settings, not in per-device
	 *  storage, so a share reaches the user's phone through whatever syncs
	 *  their vault instead of asking them to paste the invite code again on
	 *  every device. The share key rides along; see SHARING.md. */
	subscriptions: Subscription[];
	/** Shares this vault publishes. Synced for the same reason: publishing
	 *  from the laptop and the phone must mean the same share. */
	shares: OwnedShare[];
	/** Mark shared items in the file list. Off is for people who want a quiet
	 *  sidebar; nothing about sharing depends on it. */
	shareMarks: boolean;
}

/** One person a share has been offered to, and where they stand. */
export interface ShareMember {
	memberId: string;
	/** The name they chose when they requested access. */
	name: string;
	/** Their public key, from the request code. */
	publicKey: string;
	state: "pending" | "approved" | "denied" | "revoked";
	requestedAt: number;
	decidedAt: number;
	/** Who the invite was addressed to, if it was sent by email. Roster
	 *  bookkeeping only: nothing is verified against it. */
	email: string;
}

/** A share this vault publishes to other people. */
export interface OwnedShare {
	id: string;
	name: string;
	/** Random content key, base64. Encrypts the files and the index; never
	 *  travels in an invite. Each approved member gets it sealed to their own
	 *  public key in the keyring. Revoking anyone rotates it. */
	key: string;
	/** Everyone who has asked to join, approved or not. */
	members: ShareMember[];
	/** Stable link to the keyring: the sealed per-member copies of the
	 *  content key. Published in the clear, since every entry is sealed. */
	keyringUrl: string;
	/** The share's home folder in this vault: everything under it is shared,
	 *  and it is where a recipient's home folder mirrors. Empty means the
	 *  share is only the files in `attached`. */
	homePath: string;
	/** Individual files from elsewhere in the vault, shared alongside the
	 *  home folder. Sharing three notes out of twenty is a first-class case,
	 *  not an edge case. */
	attached: string[];
	/** Folder in the provider account holding this share's blobs and index.
	 *  A sibling of the vault folder, never inside it: the sync engine lists
	 *  only its own root, so a sibling is invisible to it. */
	remoteFolder: string;
	/** Stable link to the encrypted index, minted once. Overwriting the file
	 *  keeps the link valid, so every invite ever issued stays good. */
	manifestUrl: string;
	createdAt: number;
	publishedAt: number;
	/** When the index and keyring links stop working, or 0 for never. Enforced
	 *  by the provider, not by this plugin: after it passes, nobody can reach
	 *  the index or obtain the key even if this vault never opens again. */
	expiresAt: number;
	/** Addresses an invite was emailed to. A request code carries a name, not
	 *  an address, so these cannot be matched automatically; they are here so
	 *  the roster can show who was asked and has not answered. */
	invitesSent: { email: string; sentAt: number }[];
}

/** A share this vault receives. Lives here rather than in share.ts because
 *  PconSettings holds it and core must not depend on the share module. */
export interface Subscription {
	id: string;
	name: string;
	owner: string;
	manifestUrl: string;
	/** Where the sealed per-member keys are published. */
	keyringUrl: string;
	/** This vault's identity for this share. The private half is what opens
	 *  the keyring entry the owner sealed; it syncs with settings so the
	 *  share works on every device of theirs without asking again. */
	memberId: string;
	privateJwk: string;
	publicKey: string;
	/** The name this vault gave when asking to join, so the request code can
	 *  be shown again while approval is still pending. */
	memberName: string;
	/** The content key, once an owner has approved this member. Empty while a
	 *  request is still pending, which is a normal state and not a fault. */
	key: string;
	/** Vault folder the share lands in, e.g. "Shared/Dana". */
	localPath: string;
	addedAt: number;
	paused: boolean;
}

export const DEFAULT_SETTINGS: PconSettings = {
	provider: "dropbox",
	appKey: "",
	refreshToken: "",
	accessToken: "",
	accessExpiry: 0,
	accountEmail: "",
	odClientId: "",
	odRefresh: "",
	odAccess: "",
	odExpiry: 0,
	odAccount: "",
	gClientId: "",
	gClientSecret: "",
	gRefresh: "",
	gAccess: "",
	gExpiry: 0,
	gAccount: "",
	remoteFolder: "",
	excludes: "",
	syncConfig: true,
	syncPluginData: true,
	protectedFolders: [],
	syncOnStart: true,
	syncOnResume: true,
	liveSync: true,
	autoMinutes: 5,
	watchSeconds: 30,
	conflictPolicy: "both",
	autoMerge: true,
	maxFileMB: 0,
	deleteGuardPct: 20,
	e2eEnabled: false,
	e2ePassphrase: "",
	notices: "changes",
	concurrency: 8,
	verboseLog: false,
	subscriptions: [],
	shares: [],
	shareMarks: true,
};

/** Merge our in-memory settings over what is on disk, letting disk win for
 *  every key we did not change since `baseline`. data.json can be synced
 *  between devices; a stale device writing the whole object back would undo
 *  another device's work (or log it out). Same helper as the rest of the
 *  Power family. */
export function mergeForSave<T extends object>(ours: T, baseline: T, disk: Partial<T> | null): T {
	const out = { ...ours };
	if (!disk) return out;
	for (const k of Object.keys(ours) as (keyof T)[]) {
		if (!(k in disk)) continue; // disk has never heard of this key; ours stands
		const o = ours[k];
		const b = baseline[k];
		const d = disk[k];
		if (isRecord(o) && isRecord(b) && isRecord(d)) {
			out[k] = mergeEntries(o, b, d) as T[keyof T];
			continue;
		}
		const changedByUs = JSON.stringify(o) !== JSON.stringify(b);
		if (!changedByUs) out[k] = d as T[keyof T];
	}
	return out;
}

/** A per-item map, as opposed to a value that means something whole. Arrays are
 *  values here: a list's order and membership are the thing itself. */
function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The same three-way rule, entry by entry.
 *
 * A key holding one value per item is a whole vault's worth of settings behind
 * a single name, and merging it whole meant changing ONE of them published all
 * of them. Every item another device configured since this one last read was
 * erased by a device that had never seen it.
 *
 * Start from the disk, so anything another device set survives; drop only what
 * we deliberately removed (present in the baseline, gone from ours); then lay
 * our own changed entries over the top.
 *
 * Secrets are unaffected: stripSecrets deletes those keys from `disk` entirely,
 * so they fail the `k in disk` test above and never reach this. Nothing here
 * can resurrect a token that was stripped on the way in.
 */
function mergeEntries(
	ours: Record<string, unknown>,
	baseline: Record<string, unknown>,
	disk: Record<string, unknown>
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(disk)) {
		const removedByUs = k in baseline && !(k in ours);
		if (!removedByUs) out[k] = disk[k];
	}
	for (const k of Object.keys(ours)) {
		const changedByUs = JSON.stringify(ours[k]) !== JSON.stringify(baseline[k]);
		if (changedByUs || !(k in disk)) out[k] = ours[k];
	}
	return out;
}

/* ---------------- paths ---------------- */

/** Vault-relative display path: forward slashes, NFC, no leading or trailing
 *  slash. macOS hands out NFD, Dropbox stores NFC; without one normal form
 *  the same note looks like two files. */
export function normRel(p: string): string {
	let s = (p || "").replace(/\\/g, "/").normalize("NFC").replace(/\/+/g, "/");
	if (s.startsWith("/")) s = s.slice(1);
	if (s.endsWith("/")) s = s.slice(0, -1);
	return s;
}

/** Map key for a path: normalized and lowercased, because Dropbox, Windows,
 *  macOS, and iOS are all case-insensitive. Display case is preserved in the
 *  entries themselves. */
export function normKey(p: string): string {
	return normRel(p).toLowerCase();
}

export function pathBase(rel: string): string {
	const i = rel.lastIndexOf("/");
	return i < 0 ? rel : rel.slice(i + 1);
}

export function pathParent(rel: string): string {
	const i = rel.lastIndexOf("/");
	return i < 0 ? "" : rel.slice(0, i);
}

/** The remote folder is a single path segment under the app folder. */
export function sanitizeRemoteFolder(name: string): string {
	return (
		normRel(name)
			.replace(/\//g, " ")
			.replace(/[\\:*?"<>|]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 100)
			.trim() || "Vault"
	);
}

/* ---------------- device setup code ---------------- */

/** One paste instead of a form: the first computer hands new devices
 *  everything shareable (app key, folder name, whether the folder is
 *  encrypted). Sign-in and the passphrase stay per-device by design. */
export interface SetupCode {
	provider: "dropbox" | "onedrive" | "gdrive";
	clientId: string;
	clientSecret: string;
	folder: string;
	e2e: boolean;
}

export function makeSetupCode(o: { provider: string; clientId: string; clientSecret?: string; folder: string; e2e: boolean }): string {
	const json = JSON.stringify({
		k: o.clientId,
		f: o.folder,
		e: o.e2e ? 1 : 0,
		...(o.provider !== "dropbox" ? { p: o.provider } : {}),
		...(o.clientSecret ? { s: o.clientSecret } : {}),
	});
	const b = btoa(String.fromCharCode(...new TextEncoder().encode(json)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return `PCON-SETUP:1:${b}`;
}

/** Looks like a setup code, whether or not it parses: mobile keyboards
 *  lowercase the prefix and swap hyphens for dashes, and a near-miss must
 *  never be mistaken for an app key. */
export function looksLikeSetupCode(text: string): boolean {
	return /^pcon[-–—]setup:/i.test(text.trim());
}

export function parseSetupCode(text: string): SetupCode | null {
	const m = text
		.trim()
		.replace(/[–—]/g, "-")
		.match(/^pcon-setup:1:([A-Za-z0-9_-]+)$/i);
	if (!m) return null;
	try {
		const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const p = JSON.parse(new TextDecoder().decode(bytes)) as { k?: unknown; f?: unknown; e?: unknown; p?: unknown; s?: unknown };
		if (typeof p.k !== "string" || !p.k) return null;
		const provider = p.p === "onedrive" || p.p === "gdrive" ? p.p : "dropbox";
		return { provider, clientId: p.k, clientSecret: typeof p.s === "string" ? p.s : "", folder: typeof p.f === "string" ? p.f : "", e2e: !!p.e };
	} catch {
		return null;
	}
}

/** Why this client id cannot belong to this provider, or null if it looks
 *  right. A stray paste (a folder name, half a path, a URL) otherwise travels
 *  all the way to the provider, which answers with its own error page about an
 *  invalid client id and no hint about where the value came from. Shape checks
 *  only, and deliberately loose: a real id that a future format change makes
 *  unfamiliar must still get through. */
export function clientIdProblem(provider: "dropbox" | "onedrive" | "gdrive", raw: string): string | null {
	const id = raw.trim();
	if (!id) return "Paste the client id first.";
	if (looksLikeSetupCode(id) || id.includes(":"))
		return "That looks like a setup code, not an id. Clear the field and paste the code again; a code fills in the id by itself.";
	if (provider === "onedrive")
		return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
			? null
			: "That does not look like an Azure client id (a GUID, like 5f1b2c34-9d8e-4a7f-b061-2c3d4e5f6a7b). Copy the Application (client) ID from the app's Overview page in the Entra portal.";
	if (provider === "gdrive")
		return /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(id)
			? null
			: "That does not look like a Google client id (it ends with .apps.googleusercontent.com). Copy the client ID from the OAuth client you created under Credentials.";
	return /^[A-Za-z0-9]{10,}$/.test(id)
		? null
		: "That does not look like a Dropbox app key (15 characters, letters and numbers, nothing else). Copy the App key from your app's Settings tab in the Dropbox App Console, or paste a setup code from a device that is already connected.";
}

/** OS junk that should never sync in either direction. */
export function junkFile(rel: string): boolean {
	const b = pathBase(rel).toLowerCase();
	return b === ".ds_store" || b === "desktop.ini" || b === "thumbs.db" || b === "icon\r";
}

/** Why a remote path cannot be written on Windows, or null if it is fine.
 *  The fleet includes Windows machines, so a Mac-made name that Windows
 *  rejects is skipped with a log line instead of crashing the sync. */
export function windowsUnsafe(rel: string): string | null {
	for (const seg of rel.split("/")) {
		const ctrl = [...seg].find((c) => c.charCodeAt(0) <= 0x1f);
		if (ctrl) return "name contains a control character";
		const bad = seg.match(/[<>:"|?*]/);
		if (bad) return `name contains "${bad[0]}"`;
		if (/[. ]$/.test(seg)) return "name ends with a dot or space";
		const stem = (seg.split(".")[0] || "").toUpperCase();
		if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) return `"${stem}" is reserved on Windows`;
	}
	return null;
}

/* ---------------- ignore patterns ---------------- */

export interface IgnoreRule {
	neg: boolean;
	re: RegExp;
}

function segRe(seg: string): string {
	return seg
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]");
}

/** Compile gitignore-style lines. Supported: blank lines and # comments,
 *  `!` negation, trailing `/` for directories, leading `/` to anchor at the
 *  vault root, `*`, `?`, and `**`. A pattern without a slash matches at any
 *  depth, like gitignore. Matching is case-insensitive because every
 *  filesystem in play is. */
export function compileIgnore(lines: string[]): IgnoreRule[] {
	const out: IgnoreRule[] = [];
	for (const raw of lines) {
		let p = raw.trim();
		if (!p || p.startsWith("#")) continue;
		let neg = false;
		if (p.startsWith("!")) {
			neg = true;
			p = p.slice(1).trim();
		}
		let dirOnly = false;
		if (p.endsWith("/")) {
			dirOnly = true;
			p = p.slice(0, -1);
		}
		let anchored = false;
		if (p.startsWith("/")) {
			anchored = true;
			p = p.slice(1);
		}
		if (p.includes("/")) anchored = true;
		if (!p) continue;
		const segs = p.split("/").filter((s) => s.length);
		let body = "";
		for (let i = 0; i < segs.length; i++) {
			const last = i === segs.length - 1;
			if (segs[i] === "**") {
				body += last ? ".*" : "(?:.*/)?";
				continue;
			}
			body += segRe(segs[i]) + (last ? "" : "/");
		}
		const head = anchored ? "^" : "(?:^|/)";
		const tail = dirOnly ? "/" : "(?:$|/)";
		try {
			out.push({ neg, re: new RegExp(head + body + tail, "i") });
		} catch {
			/* an unparseable pattern is skipped, never fatal */
		}
	}
	return out;
}

/** Last matching rule wins, like gitignore. */
export function isIgnored(rel: string, rules: IgnoreRule[]): boolean {
	let ignored = false;
	for (const r of rules) if (r.re.test(rel)) ignored = !r.neg;
	return ignored;
}

/** Patterns applied before the user's own, regardless of settings. The sync
 *  journal is per-device state (devices would fight over it), and workspace
 *  layout is per-device by design. Tokens and the passphrase live in
 *  per-device storage, never in files, so the rest of our own plugin folder
 *  syncs like any other plugin's; that is how a Power Connect update on one
 *  device reaches the others. */
export function forcedExcludes(configDir: string, pluginId: string): string[] {
	return [`/${configDir}/plugins/${pluginId}/state.json`, `/${configDir}/workspace.json`, `/${configDir}/workspace-mobile.json`, "/.trash/", ".git/"];
}

/** The selection rules for a sync run, compiled once. The user's patterns
 *  come first (shared, then this device's own) and the forced ones last:
 *  the last matching rule wins, so no `!` pattern can ever re-include the
 *  token folder. */
export function buildIgnore(s: PconSettings, configDir: string, pluginId: string, deviceLines: string[] = []): IgnoreRule[] {
	const lines = [...s.excludes.split(/\r?\n/), ...deviceLines];
	if (!s.syncConfig) lines.push(`/${configDir}/`);
	else {
		// inside a plugin folder, only the plugin itself travels: code,
		// manifest, styles, settings. Search indexes, caches, and other
		// derived state are per-device, rewritten constantly, and every
		// rewrite races the other devices' into a conflict copy.
		lines.push(`/${configDir}/plugins/*/*`);
		for (const keep of ["main.js", "manifest.json", "styles.css", "data.json"]) lines.push(`!/${configDir}/plugins/*/${keep}`);
		if (!s.syncPluginData) {
			lines.push(`/${configDir}/plugins/*/data.json`);
			// ours is exempt from the gate: it holds no credentials by design
			// and carries the shared settings devices agree on
			lines.push(`!/${configDir}/plugins/${pluginId}/data.json`);
		}
	}
	lines.push(...forcedExcludes(configDir, pluginId));
	return compileIgnore(lines);
}

/** Whether a file's size passes the size cap. Applied to both sides, so a
 *  big file neither uploads from here nor downloads to here, without ever
 *  deleting anything that already synced. */
export function withinSizeLimit(sizeBytes: number, maxFileMB: number): boolean {
	return maxFileMB <= 0 || sizeBytes <= maxFileMB * 1024 * 1024;
}

/** Dot-paths outside the config folder are invisible to Obsidian's file
 *  index, so the local scanner can never see them. A side the engine can
 *  download but never scan reads as a local delete one run later and would
 *  erase the remote copy; such paths must be invisible to the whole engine,
 *  on every side, symmetrically. */
export function hiddenBlocked(rel: string, configDir: string): boolean {
	const low = rel.toLowerCase();
	const cfg = configDir.toLowerCase();
	if (low === cfg || low.startsWith(cfg + "/")) return false;
	return rel.split("/").some((s) => s.startsWith("."));
}

/* ---------------- content hash (Dropbox algorithm) ---------------- */

const HASH_BLOCK = 4 * 1024 * 1024;

export function hexOf(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += b.toString(16).padStart(2, "0");
	return s;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

/** Dropbox's content_hash: SHA-256 of each 4 MB block, concatenated, hashed
 *  again. Matching what the server stores lets change detection and
 *  same-content shortcuts work without downloading anything. */
export async function contentHash(data: ArrayBuffer): Promise<string> {
	const digests: Uint8Array[] = [];
	for (let off = 0; off < data.byteLength; off += HASH_BLOCK) {
		const d = await crypto.subtle.digest("SHA-256", data.slice(off, Math.min(off + HASH_BLOCK, data.byteLength)));
		digests.push(new Uint8Array(d));
	}
	const final = await crypto.subtle.digest("SHA-256", concatBytes(digests) as BufferSource);
	return hexOf(new Uint8Array(final));
}

/* ---------------- misc pure helpers ---------------- */

export function b64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randB64url(n = 32): string {
	return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return b64url(new Uint8Array(d));
}

/** Dropbox-API-Arg travels in an HTTP header, which is ASCII only; every
 *  non-ASCII character must ride as a \uXXXX escape or uploads of notes with
 *  accented names fail. */
export function asciiJsonHeader(o: unknown): string {
	return JSON.stringify(o).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** Dropbox client_modified: ISO seconds, no milliseconds. */
export function msToIsoSec(ms: number): string {
	return new Date(Math.round(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function isoToMs(s: string): number {
	const t = Date.parse(s);
	return Number.isFinite(t) ? t : 0;
}

export function backoffMs(attempt: number, baseMs = 500, capMs = 30_000): number {
	return Math.min(baseMs * 2 ** Math.max(0, attempt), capMs);
}

export function parseRetryAfter(v: string | undefined): number {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? Math.min(n, 120) * 1000 : 0;
}

export function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = n;
	let u = -1;
	do {
		v /= 1024;
		u++;
	} while (v >= 1024 && u < units.length - 1);
	return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

export function fmtClock(ms: number): string {
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The conflict copy's name. Deterministic on purpose: it is built from the
 *  losing side's own timestamp and content hash, so two devices resolving the
 *  same conflict independently produce the same file and converge instead of
 *  spawning conflict copies of conflict copies. UTC, for the same reason. */
export function conflictName(rel: string, loserMtimeMs: number, loserHash: string): string {
	const d = new Date(loserMtimeMs);
	const p = (n: number) => String(n).padStart(2, "0");
	const stamp = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
	const tag = (loserHash || "x").slice(0, 6);
	const base = pathBase(rel);
	const dir = pathParent(rel);
	const dot = base.lastIndexOf(".");
	const stem = dot > 0 ? base.slice(0, dot) : base;
	const ext = dot > 0 ? base.slice(dot) : "";
	return `${dir ? dir + "/" : ""}${stem} (sync conflict ${stamp} ${tag})${ext}`;
}

/* ---------------- the sync planner ---------------- */

/** A file as the local scan saw it. `hash` is always the plaintext content
 *  hash; the engine fills it from the journal when mtime and size are
 *  untouched, and hashes the bytes otherwise. */
export interface LocalEntry {
	path: string;
	mtime: number;
	size: number;
	hash: string;
}

/** A file as Dropbox reports it. `hash` is the hash of the stored bytes,
 *  which is the ciphertext when end-to-end encryption is on. */
export interface RemoteEntry {
	path: string;
	rev: string;
	size: number;
	hash: string;
	mtime: number;
}

/** The last state both sides agreed on: the anchor that turns "the two sides
 *  differ" into "who moved". */
export interface BaseEntry {
	rev: string;
	hash: string;
	lhash: string;
	mtime: number;
	size: number;
}

export interface MoveHint {
	from: string;
	to: string;
}

export type Action =
	| { t: "upload"; key: string; path: string; baseRev: string | null; why: string }
	| { t: "download"; key: string; path: string; why: string }
	| { t: "adopt"; key: string; path: string }
	| { t: "conflict"; key: string; path: string }
	| { t: "moveRemote"; fromKey: string; toKey: string; fromPath: string; toPath: string }
	| { t: "deleteLocal"; key: string; path: string }
	| { t: "deleteRemote"; key: string; path: string }
	| { t: "dropBase"; key: string };

export interface Plan {
	actions: Action[];
	uploads: number;
	downloads: number;
	adopts: number;
	conflicts: number;
	moves: number;
	deletesLocal: number;
	deletesRemote: number;
	/** The delete guard tripped: the executor must confirm with the user or
	 *  skip every delete this run. */
	holdDeletes: boolean;
}

export interface PlanInput {
	local: Map<string, LocalEntry>;
	remote: Map<string, RemoteEntry>;
	base: Map<string, BaseEntry>;
	moves?: MoveHint[];
	/** With encryption on, a local plaintext hash and a remote ciphertext hash
	 *  are never comparable; equal-content shortcuts happen in the executor
	 *  after decrypting instead. */
	e2e?: boolean;
	deleteGuardPct?: number;
	/** The encryption zone a path stores under (see protectionZone). When
	 *  given, a move whose endpoints sit in different zones cannot take the
	 *  cheap remote-rename shortcut: the stored bytes differ between plain and
	 *  encrypted, so it must fall through to a real upload and delete. Absent
	 *  means no selective protection and every move may shortcut. */
	zoneOf?: (rel: string) => string;
}

/** Decide what one sync run should do. Pure: three maps in, actions out.
 *
 *  The base map is the pivot. A side that differs from base changed; a side
 *  that matches base did not. Both changed is a conflict. Missing from one
 *  side but present in base is a delete on that side, unless the other side
 *  changed since base, in which case the edit outranks the delete and the
 *  file is restored. No timestamps are compared across machines, ever:
 *  local changes are detected by content hash, remote changes by rev. */
export function planSync(input: PlanInput): Plan {
	const { local, remote, base } = input;
	const e2e = !!input.e2e;
	const guardPct = input.deleteGuardPct ?? 20;

	const adopts: Action[] = [];
	const moves: Action[] = [];
	const downloads: Action[] = [];
	const uploads: Action[] = [];
	const conflicts: Action[] = [];
	const delRemote: Action[] = [];
	const delLocal: Action[] = [];
	const dropBase: Action[] = [];

	// A clean local rename becomes one cheap remote move instead of an upload
	// and a delete. Clean means: gone at the source, present with unchanged
	// content at the target, remote untouched since base. Anything murkier
	// falls through to the decision table, which is always correct, only
	// less frugal.
	const consumed = new Set<string>();
	for (const h of input.moves ?? []) {
		const fromKey = normKey(h.from);
		const toKey = normKey(h.to);
		if (fromKey === toKey || consumed.has(fromKey) || consumed.has(toKey)) continue;
		const b = base.get(fromKey);
		const r = remote.get(fromKey);
		const l = local.get(toKey);
		if (!b || !r || !l) continue;
		if (local.has(fromKey) || base.has(toKey) || remote.has(toKey)) continue;
		if (r.rev !== b.rev) continue;
		if (l.hash !== b.lhash) continue;
		// a rename that crosses an encryption boundary changes the stored bytes,
		// so the cheap Dropbox move would leave the wrong envelope; let it fall
		// through to a real upload-and-delete instead
		if (input.zoneOf && input.zoneOf(h.from) !== input.zoneOf(h.to)) continue;
		moves.push({ t: "moveRemote", fromKey, toKey, fromPath: r.path, toPath: l.path });
		consumed.add(fromKey);
		consumed.add(toKey);
	}

	const keys = new Set<string>([...local.keys(), ...remote.keys(), ...base.keys()]);
	for (const k of keys) {
		if (consumed.has(k)) continue;
		const l = local.get(k);
		const r = remote.get(k);
		const b = base.get(k);

		if (!b) {
			if (l && r) {
				if (!e2e && l.hash === r.hash) adopts.push({ t: "adopt", key: k, path: l.path });
				else conflicts.push({ t: "conflict", key: k, path: l.path });
			} else if (l) uploads.push({ t: "upload", key: k, path: l.path, baseRev: null, why: "new here" });
			else if (r) downloads.push({ t: "download", key: k, path: r.path, why: "new on Dropbox" });
			continue;
		}

		const lchg = l ? l.hash !== b.lhash : false;
		const rchg = r ? r.rev !== b.rev : false;

		if (l && r) {
			if (!lchg && !rchg) continue;
			if (lchg && !rchg) uploads.push({ t: "upload", key: k, path: l.path, baseRev: b.rev, why: "edited here" });
			else if (!lchg && rchg) {
				// same stored bytes under a new rev is a metadata echo, not a change
				if (r.hash === b.hash) adopts.push({ t: "adopt", key: k, path: l.path });
				else downloads.push({ t: "download", key: k, path: r.path, why: "changed on Dropbox" });
			} else {
				if (!e2e && l.hash === r.hash) adopts.push({ t: "adopt", key: k, path: l.path });
				else conflicts.push({ t: "conflict", key: k, path: l.path });
			}
		} else if (l && !r) {
			if (lchg) uploads.push({ t: "upload", key: k, path: l.path, baseRev: null, why: "edited here, deleted on Dropbox" });
			else delLocal.push({ t: "deleteLocal", key: k, path: l.path });
		} else if (!l && r) {
			// a rev bump with identical stored bytes is a metadata echo, not an
			// edit; it must not outrank the local delete and resurrect the file
			if (rchg && r.hash !== b.hash) downloads.push({ t: "download", key: k, path: r.path, why: "changed on Dropbox, deleted here" });
			else delRemote.push({ t: "deleteRemote", key: k, path: r.path });
		} else {
			dropBase.push({ t: "dropBase", key: k });
		}
	}

	const byPath = (a: Action, b: Action) => keyOf(a).localeCompare(keyOf(b));
	const keyOf = (a: Action) => ("path" in a ? a.path : "toPath" in a ? a.toPath : a.key);
	for (const arr of [adopts, moves, downloads, uploads, conflicts, delRemote, delLocal, dropBase]) arr.sort(byPath);

	const tracked = Math.max(base.size, 1);
	const deletes = delLocal.length + delRemote.length;
	const holdDeletes = deletes > 10 && deletes / tracked > guardPct / 100;

	return {
		actions: [...adopts, ...moves, ...downloads, ...uploads, ...conflicts, ...delRemote, ...delLocal, ...dropBase],
		uploads: uploads.length,
		downloads: downloads.length,
		adopts: adopts.length,
		conflicts: conflicts.length,
		moves: moves.length,
		deletesLocal: delLocal.length,
		deletesRemote: delRemote.length,
		holdDeletes,
	};
}

/** The same plan with every delete removed: what an unattended sync runs
 *  when the delete guard trips, so transfers still flow while the deletions
 *  wait for a human. */
export function stripDeletes(p: Plan): Plan {
	return {
		...p,
		actions: p.actions.filter((a) => a.t !== "deleteLocal" && a.t !== "deleteRemote"),
		deletesLocal: 0,
		deletesRemote: 0,
		holdDeletes: false,
	};
}

/** One line for notices and the log: "3 up, 1 down, 1 conflict". */
export function planSummary(p: Plan): string {
	const parts: string[] = [];
	if (p.uploads) parts.push(`${p.uploads} up`);
	if (p.downloads) parts.push(`${p.downloads} down`);
	if (p.moves) parts.push(`${p.moves} moved`);
	if (p.conflicts) parts.push(`${p.conflicts} conflict${p.conflicts === 1 ? "" : "s"}`);
	if (p.deletesLocal) parts.push(`${p.deletesLocal} deleted here`);
	if (p.deletesRemote) parts.push(`${p.deletesRemote} deleted on Dropbox`);
	return parts.length ? parts.join(", ") : "everything in sync";
}

/** Which side of a conflict wins the original filename under the "keep both"
 *  policy. Newer modification time wins; a tie falls back to comparing
 *  hashes, so every device picks the same winner. */
export function conflictWinner(localMtime: number, localHash: string, remoteMtime: number, remoteHash: string): "local" | "remote" {
	if (localMtime !== remoteMtime) return localMtime > remoteMtime ? "local" : "remote";
	return localHash >= remoteHash ? "local" : "remote";
}

/* ---------------- transport types and errors ----------------
 * These describe what any remote store must speak. They live here, not in
 * dropbox.ts, so the engine and the simulation can use them without pulling
 * Obsidian's requestUrl into a node test bundle. */

export class DropboxError extends Error {
	constructor(
		message: string,
		readonly status = 0,
		readonly tag = ""
	) {
		super(message);
	}
}

export const isNotFound = (e: unknown): boolean => e instanceof DropboxError && e.tag.includes("not_found");
export const isConflict = (e: unknown): boolean => e instanceof DropboxError && e.tag.includes("conflict");
export const isCursorReset = (e: unknown): boolean => e instanceof DropboxError && e.tag.includes("reset");
export const isAuthDead = (e: unknown): boolean =>
	e instanceof DropboxError && (e.tag.includes("invalid_grant") || e.tag.includes("invalid_access_token") || e.tag.includes("expired_access_token"));
export const isShortRead = (e: unknown): boolean => e instanceof DropboxError && e.tag === "short_read";

/** A download that ends early still arrives as HTTP 200 with a short body,
 *  so status alone cannot tell a whole file from a stump, and every layer
 *  above would take the stump for the file. Each provider publishes the true
 *  size on the very same response, which makes this check free and makes
 *  skipping it the difference between a retry and silent data loss. Zero is
 *  "the provider did not say", not "the file is empty": an empty file is
 *  0 === 0 and passes either way. */
export function assertWholeDownload(what: string, got: number, expected: number): void {
	if (expected > 0 && got !== expected)
		throw new DropboxError(`Could not download ${what}: received ${got} bytes of ${expected}. The connection ended early; the next sync will retry it.`, 0, "short_read");
}

/**
 * The upload equivalent, and the more dangerous direction.
 *
 * A short DOWNLOAD can be re-fetched: the whole file is still on the remote.
 * A short UPLOAD replaces the only complete copy with a stump, every other
 * device then downloads that stump faithfully (its size matches the metadata,
 * so no download check can object), and the device that still held the real
 * file sees a conflict and files its good copy away under a conflict name.
 * Field evidence 2026-07-29: recordings on Dropbox at exactly 8.000 and
 * 52.000 MiB, disk and remote agreeing on the short size, the journal
 * recording it as a clean sync.
 *
 * So a commit is believed only if the metadata that comes back describes the
 * bytes that went out. A mismatch is a failed transfer.
 */
export function assertWholeUpload(what: string, sent: number, stored: number): void {
	if (stored !== sent)
		throw new DropboxError(
			`Upload of ${what} did not land whole: sent ${sent} bytes, the server stored ${stored}. Nothing was recorded as synced; the next sync will send it again.`,
			0,
			"short_write"
		);
}

export const isShortWrite = (e: unknown): boolean => e instanceof DropboxError && e.tag === "short_write";

export interface RemoteFileMeta {
	pathDisplay: string;
	rev: string;
	size: number;
	contentHash: string;
	clientModified: string;
}

export type ListEntry = { tag: "file"; meta: RemoteFileMeta } | { tag: "deleted"; pathDisplay: string } | { tag: "folder"; pathDisplay: string };

/** One staged upload session awaiting its batch commit. */
export interface BatchCommit {
	sessionId: string;
	size: number;
	path: string;
	mode: "add" | "overwrite" | { update: string };
	clientModified: string;
}

export type BatchResult = { ok: true; meta: RemoteFileMeta } | { ok: false; error: string };

/* ---------------- run plumbing shared by engine, plugin, and sim ---------------- */

export const MARKER_NAME = ".powerconnect.json";

/** A sync that cannot proceed until the user acts (missing passphrase,
 *  mismatched encryption). Not a network failure: no retry backoff. */
export class SyncBlocked extends Error {}

export interface Marker {
	format?: number;
	e2e?: boolean;
	salt?: string;
	check?: string;
	/** Selective protection: plugin settings files (plugins/X/data.json)
	 *  upload encrypted with a passphrase while the rest of the folder stays
	 *  plain. Meaningful only when e2e is false; full encryption covers
	 *  everything already. The salt and check are the ONE protection envelope,
	 *  shared by plugin-settings and protected-folder encryption alike. */
	secrets?: { salt: string; check: string };
	/** Top-level folders (lowercased keys) whose contents upload encrypted
	 *  under the `secrets` envelope while the rest of the folder stays plain.
	 *  Carried in the marker so every device agrees on the protected set
	 *  before its first sync. */
	protectedFolders?: string[];
}

/** The protected top-level folders a marker declares, normalized. */
export function markerProtectedFolders(m: Marker): string[] {
	return (m.protectedFolders ?? []).map(normKey).filter(Boolean);
}

/** Which encryption zone a path belongs to under selective protection:
 *  "plugin" for a plugin-settings file (always, except our own, these hold
 *  API keys and must never sync in the clear), the folder key for a file
 *  inside a user-protected folder, or "" for the plain remainder.
 *
 *  This is THE protection decision, in one pure place so the engine, the move
 *  guard, and the tests all agree. The zone label matters for moves: a file
 *  crossing between two different non-empty zones, or between a zone and plain,
 *  changes its stored bytes and so cannot take the cheap rename shortcut.
 *
 *  Plugin protection is structural and unconditional; only the folder list is
 *  marker-driven, because it is the user's choice which folders to protect. */
export function protectionZone(rel: string, configDir: string, pluginFolderName: string, protectedFolders: readonly string[]): string {
	const k = normKey(rel);
	if (isPluginDataPath(k, configDir) && !k.startsWith(normKey(configDir) + "/plugins/" + normKey(pluginFolderName) + "/")) return "plugin";
	for (const f of protectedFolders) {
		const folder = normKey(f);
		if (folder && (k === folder || k.startsWith(folder + "/"))) return "folder:" + folder;
	}
	return "";
}

export type ConflictChoice = "both" | "local" | "remote";

export interface RunStats {
	up: number;
	down: number;
	adopts: number;
	moves: number;
	conflicts: number;
	merged: number;
	delLocal: number;
	delRemote: number;
	skipped: number;
	errors: string[];
}

export const freshStats = (): RunStats => ({ up: 0, down: 0, adopts: 0, moves: 0, conflicts: 0, merged: 0, delLocal: 0, delRemote: 0, skipped: 0, errors: [] });

/* ---------------- three-way merge ---------------- */

interface Hunk {
	bs: number; // base range start (inclusive)
	be: number; // base range end (exclusive)
	lines: string[]; // replacement lines from the changed side
}

/** Replacement hunks turning `a` into `b`, found by patience alignment:
 *  trim the common prefix and suffix, anchor on lines unique to both sides
 *  (longest increasing subsequence keeps anchors in order), recurse between
 *  anchors, and whatever will not anchor becomes one replacement hunk.
 *  Coarser than a minimal diff, which only makes the merge more cautious. */
function hunksBetween(a: string[], b: string[]): Hunk[] {
	const out: Hunk[] = [];
	const walk = (as: number, ae: number, bs: number, be: number) => {
		while (as < ae && bs < be && a[as] === b[bs]) {
			as++;
			bs++;
		}
		while (ae > as && be > bs && a[ae - 1] === b[be - 1]) {
			ae--;
			be--;
		}
		if (as === ae && bs === be) return;
		if (as === ae || bs === be) {
			out.push({ bs: as, be: ae, lines: b.slice(bs, be) });
			return;
		}
		const counts = new Map<string, { a: number; b: number; ai: number; bi: number }>();
		for (let i = as; i < ae; i++) {
			const c = counts.get(a[i]) ?? { a: 0, b: 0, ai: -1, bi: -1 };
			c.a++;
			c.ai = i;
			counts.set(a[i], c);
		}
		for (let i = bs; i < be; i++) {
			const c = counts.get(b[i]) ?? { a: 0, b: 0, ai: -1, bi: -1 };
			c.b++;
			c.bi = i;
			counts.set(b[i], c);
		}
		const anchors: { ai: number; bi: number }[] = [];
		for (const c of counts.values()) if (c.a === 1 && c.b === 1) anchors.push({ ai: c.ai, bi: c.bi });
		anchors.sort((x, y) => x.ai - y.ai);
		// longest increasing subsequence over bi keeps only anchors that
		// appear in the same order on both sides
		const tails: number[] = [];
		const tailAt: number[] = [];
		const prev: number[] = new Array<number>(anchors.length).fill(-1);
		for (let i = 0; i < anchors.length; i++) {
			const v = anchors[i].bi;
			let lo = 0;
			let hi = tails.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (tails[mid] < v) lo = mid + 1;
				else hi = mid;
			}
			tails[lo] = v;
			tailAt[lo] = i;
			prev[i] = lo > 0 ? tailAt[lo - 1] : -1;
		}
		if (!tails.length) {
			out.push({ bs: as, be: ae, lines: b.slice(bs, be) });
			return;
		}
		const chain: { ai: number; bi: number }[] = [];
		for (let i = tailAt[tails.length - 1]; i >= 0; i = prev[i]) chain.push(anchors[i]);
		chain.reverse();
		let ca = as;
		let cb = bs;
		for (const { ai, bi } of chain) {
			walk(ca, ai, cb, bi);
			ca = ai + 1;
			cb = bi + 1;
		}
		walk(ca, ae, cb, be);
	};
	walk(0, a.length, 0, b.length);
	return out;
}

function sameLines(x: string[], y: string[]): boolean {
	if (x.length !== y.length) return false;
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
}

/** Line-level three-way merge. Edits that touch different base lines both
 *  land; identical edits land once; pure insertions at the same spot land
 *  in caller-chosen order (localFirst), which the caller derives from edit
 *  times so every device produces the identical result; edits that collide
 *  on the same base lines return null and the caller keeps both copies. */
export function mergeThree(base: string, local: string, remote: string, localFirst: boolean): string | null {
	// trailing-newline drift turns an append into a same-line replacement
	// (base "...c\n" against "...c\nX" reads as replacing the empty last
	// line), which the field found where the sims did not: editors keep or
	// drop the final newline unpredictably. Normalize the shape before
	// diffing and restore it after, keyed to the edited sides.
	const chop = (t: string) => (t.endsWith("\n") ? t.slice(0, -1) : t);
	const tailNl = local.endsWith("\n") || remote.endsWith("\n");
	base = chop(base);
	local = chop(local);
	remote = chop(remote);
	const done = (t: string | null) => (t == null ? null : tailNl ? `${t}\n` : t);
	// an empty ancestor has no lines to collide on: both sides appended
	if (base === "") {
		if (local === remote) return done(local);
		if (!local) return done(remote);
		if (!remote) return done(local);
		return done(localFirst ? `${local}\n${remote}` : `${remote}\n${local}`);
	}
	const b = base.split("\n");
	const hl = hunksBetween(b, local.split("\n"));
	const hr = hunksBetween(b, remote.split("\n"));
	const out: string[] = [];
	let cursor = 0;
	let i = 0;
	let j = 0;
	const emitBaseTo = (n: number) => {
		for (; cursor < n; cursor++) out.push(b[cursor]);
	};
	while (i < hl.length || j < hr.length) {
		const L = i < hl.length ? hl[i] : null;
		const R = j < hr.length ? hr[j] : null;
		if (L && R && L.bs === R.bs && L.be === R.be && sameLines(L.lines, R.lines)) {
			emitBaseTo(L.bs);
			out.push(...L.lines);
			cursor = L.be;
			i++;
			j++;
			continue;
		}
		// pure insertions at the same point merge in caller-chosen order
		if (L && R && L.bs === L.be && R.bs === R.be && L.bs === R.bs) {
			emitBaseTo(L.bs);
			if (localFirst) out.push(...L.lines, ...R.lines);
			else out.push(...R.lines, ...L.lines);
			i++;
			j++;
			continue;
		}
		// disjoint (including adjacent) hunks apply in base order
		const pick = !L ? R : !R ? L : L.be <= R.bs ? L : R.be <= L.bs ? R : null;
		if (pick) {
			emitBaseTo(pick.bs);
			out.push(...pick.lines);
			cursor = pick.be;
			if (pick === L) i++;
			else j++;
			continue;
		}
		return null;
	}
	emitBaseTo(b.length);
	return done(out.join("\n"));
}

/** Guard for the merge path: only sensible for real text of sane size. */
export function mergeableText(bytes: ArrayBuffer, maxBytes = 1_500_000): string | null {
	if (bytes.byteLength > maxBytes) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

/** Is this a plugin's settings file (<configDir>/plugins/<id>/data.json)?
 *  These get the structural merge below instead of the line merge above,
 *  and get it whether or not text auto-merge is switched on. */
export function isPluginDataPath(rel: string, configDir: string): boolean {
	const prefix = normKey(configDir) + "/plugins/";
	const k = normKey(rel);
	if (!k.startsWith(prefix)) return false;
	const rest = k.slice(prefix.length).split("/");
	return rest.length === 2 && rest[1] === "data.json";
}

/** A plugin's build artifacts. Unlike data.json these are DERIVED: half of
 *  one build spliced into another is not a compromise, it is a bundle that
 *  never existed and still loads. They are never merged, and a conflict
 *  between them is settled by version rather than by clock. */
const PLUGIN_CODE_FILES = new Set(["main.js", "styles.css", "manifest.json"]);

export function isPluginCodePath(rel: string, configDir: string): boolean {
	const prefix = normKey(configDir) + "/plugins/";
	const k = normKey(rel);
	if (!k.startsWith(prefix)) return false;
	const rest = k.slice(prefix.length).split("/");
	return rest.length === 2 && PLUGIN_CODE_FILES.has(rest[1]);
}

/** The `<configDir>/plugins/<id>` folder a file belongs to, in the path's own
 *  case (it is used to build sibling paths), or null when the file is not one
 *  level inside a plugin folder. */
export function pluginDirOf(rel: string, configDir: string): string | null {
	if (!isPluginCodePath(rel, configDir) && !isPluginDataPath(rel, configDir)) return null;
	const r = normRel(rel);
	return r.slice(0, r.lastIndexOf("/"));
}

/** Where a file belongs in the transfer order, lowest first. A device joining
 *  an existing vault should end up with a working Obsidian early rather than
 *  after every note has landed, so plugin code goes first, then the settings
 *  that code reads, then the rest of the config folder, then notes.
 *
 *  community-plugins.json (the list of what is enabled) falls in the config
 *  tier deliberately, AFTER the code it names: arriving first, it would have
 *  Obsidian try to load plugins whose main.js is not on disk yet.
 *
 *  Ordering only. Which files sync is entirely the ignore rules' business, and
 *  no tier can add or remove a file from a plan. */
export function transferTier(rel: string, configDir: string): number {
	if (isPluginCodePath(rel, configDir)) return 0;
	if (isPluginDataPath(rel, configDir)) return 1;
	const cfg = normKey(configDir);
	const k = normKey(rel);
	if (k === cfg || k.startsWith(cfg + "/")) return 2;
	return 3;
}

/** The path a transfer action acts on, for ordering purposes. */
function actionPath(a: Action): string {
	return a.t === "moveRemote" ? a.toPath : a.t === "dropBase" ? "" : a.path;
}

/** Split transfer actions into tiers to be run in order. Sorting alone would
 *  only decide what STARTS first; the engine runs one tier to completion
 *  before the next, so an interrupted first sync leaves whole plugins on disk
 *  instead of a scattering of half of everything. Empty tiers are dropped, and
 *  the original order inside a tier is preserved. */
export function tierTransfers(actions: Action[], configDir: string): Action[][] {
	const tiers = new Map<number, Action[]>();
	for (const a of actions) {
		const t = transferTier(actionPath(a), configDir);
		const bucket = tiers.get(t);
		if (bucket) bucket.push(a);
		else tiers.set(t, [a]);
	}
	return [...tiers.keys()].sort((x, y) => x - y).map((k) => tiers.get(k)!);
}

/** The `version` of a manifest.json, or null if it is missing or unusable.
 *  Anything unparseable returns null so the caller falls back to its normal
 *  resolution rather than guessing. */
export function manifestVersion(text: string): string | null {
	try {
		const v: unknown = JSON.parse(text);
		if (!v || typeof v !== "object") return null;
		const ver = (v as { version?: unknown }).version;
		return typeof ver === "string" && ver.trim() ? ver.trim() : null;
	} catch {
		return null;
	}
}

/** Compare two plugin versions: 1 if a is newer, -1 if b is newer, 0 if they
 *  are equal OR either one cannot be read as a plain dotted number. Zero
 *  means "no opinion", and every caller must then fall back to its usual
 *  rule: a wrong guess here would install the wrong code fleet-wide.
 *
 *  Deliberately not full semver. These are our own manifests, which carry
 *  plain x.y.z; a prerelease suffix or anything else exotic reads as no
 *  opinion instead of inviting a subtle ordering bug. */
export function compareVersions(a: string | null, b: string | null): number {
	const parse = (s: string | null): number[] | null => {
		if (!s) return null;
		const parts = s.replace(/^v/i, "").split(".");
		if (!parts.length || parts.length > 4) return null;
		const nums: number[] = [];
		for (const p of parts) {
			if (!/^\d+$/.test(p)) return null;
			nums.push(Number(p));
		}
		return nums;
	};
	const x = parse(a);
	const y = parse(b);
	if (!x || !y) return 0;
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d) return d > 0 ? 1 : -1;
	}
	return 0;
}

/** Three-way merge for a plugin's data.json: per top-level key, the side
 *  that changed it since base keeps it; a key changed on both sides goes to
 *  the winner the caller names; a key deleted on the changed side stays
 *  deleted. Returns null when any side is not a plain JSON object, so
 *  anything surprising falls back to keep-both.
 *
 *  This exists because settings files lose the mtime contest in the worst
 *  way: a device switched on after weeks writes some trivial touch (recent
 *  files, a pane width) seconds into its boot, and that fresh mtime would
 *  hand its stale settings the original name fleet-wide. Key-level merging
 *  lets the stale device keep its touch AND everyone else's changes. */
export function mergePluginData(baseText: string, localText: string, remoteText: string, preferRemote: boolean): string | null {
	const parse = (t: string): Record<string, unknown> | null => {
		try {
			const v: unknown = JSON.parse(t);
			return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	};
	const b = parse(baseText);
	const l = parse(localText);
	const r = parse(remoteText);
	if (!b || !l || !r) return null;
	return JSON.stringify(mergeObjects(b, l, r, preferRemote), null, "	");
}

/** A plain object, as opposed to a value that means something whole. Arrays are
 *  values here: a list's order and membership ARE the thing being stored. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The three-way rule, applied at every level of the object rather than only at
 * the top.
 *
 * Depth is the whole point. A plugin routinely keeps ONE key holding one entry
 * per folder: Power Explorer's `orders` is a single key whose value maps a
 * folder path to its manual arrangement, hundreds of them. Comparing that key
 * whole means one drag anywhere marks it changed, so two devices that each
 * dragged in a DIFFERENT folder both count as having changed it, and the
 * tiebreak hands the winner's entire map over the loser's. Every folder the
 * loser had ever arranged reverts at once, and a folder whose entry disappears
 * falls back to the app's own sort. From the outside that is "my pages
 * reordered themselves again", on whichever device lost the race.
 *
 * Recursing makes the unit of contention the entry a person actually touched.
 * Two devices arranging the SAME folder still settle last-writer-wins, but that
 * is one folder losing a race instead of a vault losing its arrangement.
 *
 * Keys come out sorted so the merge is canonical: device A merging (local=A,
 * remote=B) and device B merging (local=B, remote=A) produce byte-identical
 * files. Without that the two results differ by key order alone, each device
 * sees the other's as a change, and the pair re-merges each other forever.
 */
function mergeObjects(b: Record<string, unknown>, l: Record<string, unknown>, r: Record<string, unknown>, preferRemote: boolean): Record<string, unknown> {
	// a missing key must compare different from EVERY present value, and
	// JSON.stringify(undefined) is undefined, so absence gets its own token
	const enc = (o: Record<string, unknown>, k: string) => (k in o ? JSON.stringify(o[k]) : "\u0000absent");
	const keys = [...new Set([...Object.keys(l), ...Object.keys(r), ...Object.keys(b)])].sort();
	const out: Record<string, unknown> = {};
	for (const k of keys) {
		const lchg = enc(l, k) !== enc(b, k);
		const rchg = enc(r, k) !== enc(b, k);
		if (lchg && rchg && isPlainObject(l[k]) && isPlainObject(r[k])) {
			// both sides edited a map: merge it entry by entry instead of
			// picking a winner. A base that never held this key (or held
			// something that is not a map) starts from empty, so two devices
			// that each introduced it keep both halves.
			out[k] = mergeObjects(isPlainObject(b[k]) ? b[k] : {}, l[k], r[k], preferRemote);
			continue;
		}
		const pick = lchg && rchg ? (preferRemote ? r : l) : lchg ? l : r;
		if (k in pick) out[k] = pick[k];
	}
	return out;
}

export function statsSummary(s: RunStats): string {
	const parts: string[] = [];
	if (s.up) parts.push(`${s.up} up`);
	if (s.down) parts.push(`${s.down} down`);
	if (s.moves) parts.push(`${s.moves} moved`);
	if (s.merged) parts.push(`${s.merged} merged`);
	if (s.conflicts) parts.push(`${s.conflicts} conflict${s.conflicts === 1 ? "" : "s"} kept`);
	if (s.delLocal) parts.push(`${s.delLocal} deleted here`);
	if (s.delRemote) parts.push(`${s.delRemote} deleted on Dropbox`);
	if (s.adopts) parts.push(`${s.adopts} matched`);
	if (s.skipped) parts.push(`${s.skipped} skipped`);
	if (s.errors.length) parts.push(`${s.errors.length} failed`);
	return parts.length ? parts.join(", ") : "everything in sync";
}

export function msg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
	const q = [...items];
	const workers = Array.from({ length: Math.max(1, Math.min(n, q.length)) }, async () => {
		for (;;) {
			const it = q.shift();
			if (it === undefined) return;
			await fn(it);
		}
	});
	await Promise.all(workers);
}
