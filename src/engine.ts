/* The sync engine, free of Obsidian: everything between "a sync was
 * requested" and "the journal reflects what happened" lives here, talking to
 * the world only through VaultIO, RemoteIO, and EngineHost. main.ts wires
 * these to Obsidian and Dropbox; sim.ts wires them to in-memory fakes and
 * runs whole fleets of simulated devices through it. If you are changing
 * sync behavior, change it here, and the simulation will tell you what you
 * broke. */

import {
	BaseEntry,
	ConflictChoice,
	DropboxError,
	IgnoreRule,
	BatchCommit,
	BatchResult,
	ListEntry,
	LocalEntry,
	MARKER_NAME,
	Marker,
	MoveHint,
	Plan,
	PconSettings,
	RemoteEntry,
	RemoteFileMeta,
	RunStats,
	SyncBlocked,
	assertWholeUpload,
	buildIgnore,
	compareVersions,
	conflictName,
	conflictWinner,
	isPluginCodePath,
	isPluginDataPath,
	manifestVersion,
	markerProtectedFolders,
	protectionZone,
	mergePluginData,
	pluginDirOf,
	contentHash,
	fmtBytes,
	hiddenBlocked,
	isConflict,
	isCursorReset,
	isIgnored,
	isNotFound,
	isoToMs,
	junkFile,
	msToIsoSec,
	mergeThree,
	mergeableText,
	msg,
	normKey,
	normRel,
	pathBase,
	pathParent,
	planSync,
	pool,
	sanitizeRemoteFolder,
	tierTransfers,
	windowsUnsafe,
	withinSizeLimit,
} from "./core";
import { decryptBytes, deriveKey, encryptBytes, looksEncrypted, makeCheck, makeSalt, verifyCheck } from "./crypto";

export interface VaultStatLite {
	mtime: number;
	size: number;
}

/** The local side, as the engine needs it. main.ts implements this over the
 *  Obsidian vault and adapter (routing hidden paths, creating folders,
 *  suppressing its own events); the simulation implements it in memory. */
export interface VaultIO {
	/** Every indexed (non-hidden) file with its stat. Cheap: no disk walk. */
	listVisible(): { path: string; mtime: number; size: number }[];
	/** Walk the config folder, skipping the plugin's own folder subtree. */
	listConfig(configDir: string, skipDirKey: string): Promise<{ path: string; mtime: number; size: number }[]>;
	read(rel: string): Promise<ArrayBuffer>;
	write(rel: string, bytes: ArrayBuffer, mtimeMs: number): Promise<void>;
	stat(rel: string): Promise<VaultStatLite | null>;
	exists(rel: string): Promise<boolean>;
	/** Delete to a trash, never to oblivion. */
	trash(rel: string): Promise<void>;
}

/** The remote side. The Dropbox client satisfies this shape directly. */
export interface RemoteIO {
	ensureFolder(path: string): Promise<void>;
	listAll(root: string): Promise<{ entries: ListEntry[]; cursor: string }>;
	listContinue(cursor: string): Promise<{ entries: ListEntry[]; cursor: string }>;
	listProbe(root: string, limit?: number): Promise<ListEntry[]>;
	download(path: string): Promise<{ bytes: ArrayBuffer; meta: RemoteFileMeta }>;
	upload(path: string, bytes: ArrayBuffer, opts: { mode: "add" | "overwrite" | { update: string }; clientModified: string }): Promise<RemoteFileMeta>;
	move(from: string, to: string): Promise<RemoteFileMeta>;
	del(path: string, parentRev?: string): Promise<void>;
	/** Optional batch upload: stage bytes as a session (no per-commit write
	 *  lock), then commit hundreds in one call. When present, the engine
	 *  routes ordinary-sized uploads through it. */
	uploadStart?(bytes: ArrayBuffer): Promise<string>;
	uploadFinishBatch?(entries: BatchCommit[]): Promise<BatchResult[]>;
	/** Optional: the content of a specific past revision, for three-way
	 *  merges. Absent or failing just means conflicts keep both copies. */
	downloadRev?(rev: string, path?: string): Promise<ArrayBuffer>;
	/** Optional: the provider's content hash for local bytes. Absent means
	 *  Dropbox's block hash, which the fakes speak too. */
	hashOf?(bytes: ArrayBuffer): Promise<string>;
}

/** Everything else the engine needs to know about where it is running. */
export interface EngineHost {
	settings(): PconSettings;
	configDir(): string;
	pluginFolderName(): string;
	vaultName(): string;
	deviceExcludeLines(): string[];
	isWindows(): boolean;
	log(level: "info" | "warn" | "error" | "debug", text: string): void;
	/** Journal checkpoint; fire and forget. */
	saveState(): unknown;
	/** The engine mutated a settings field (marker adoption); persist it. */
	settingsChanged(): void;
	/** Present a conflict to the user; absent means resolve without asking. */
	askConflict?(path: string, lMtime: number, lSize: number, rMtime: number, rSize: number): Promise<{ choice: ConflictChoice; applyAll: boolean }>;
}

/** Everything a run's executors need, snapshotted at plan time so settings
 *  edits mid-run (the passphrase field, the folder name) cannot change the
 *  rules under files already in flight. */
export interface PrepResult {
	plan: Plan;
	local: Map<string, LocalEntry>;
	remote: Map<string, RemoteEntry>;
	root: string;
	key: CryptoKey | null;
	/** Key for protected plugin settings files when the folder itself is
	 *  plain; null when protection is off or this device lacks the
	 *  passphrase (those files are then held out of the plan entirely). */
	secretsKey: CryptoKey | null;
	policy: PconSettings["conflictPolicy"];
	/** This device has no sync history at all: it is joining a vault, not
	 *  continuing one. Its minutes-old files must not out-mtime the fleet's
	 *  in config conflicts; see doConflict. */
	joining: boolean;
}

export interface JournalShape {
	cursor?: string;
	rootKey?: string;
	remote?: Record<string, RemoteEntry>;
	base?: Record<string, BaseEntry>;
}

export class SyncEngine {
	cursor = "";
	/** Which Dropbox folder the journal describes. When the folder name
	 *  changes, the journal is about a different world and must be rebuilt. */
	rootKey = "";
	remoteMap = new Map<string, RemoteEntry>();
	baseMap = new Map<string, BaseEntry>();
	moveHints: MoveHint[] = [];
	e2eKey: CryptoKey | null = null;
	secretsKey: CryptoKey | null = null;
	/** The protected folders this run learned from the marker. Plugin-settings
	 *  protection is structural and needs no state; only the user's folder list
	 *  is marker-driven, and it stays empty until the marker is read. */
	private protectedFolders: string[] = [];
	/** Whether the folder's marker declared plugin settings protection at the
	 *  last look, whether or not this device holds the passphrase. Display
	 *  state for the settings tab. */
	protectionSeen = false;
	private heldBack = new Set<string>();
	markerChecked = false;
	runConflictChoice: ConflictChoice | null = null;
	/** Per-run memo of each plugin folder's version verdict, so one manifest
	 *  download settles every file a version bump conflicted. */
	private versionCache = new Map<string, number>();
	private runRoot = "";

	constructor(
		private host: EngineHost,
		private vault: VaultIO,
		private remote: RemoteIO
	) {}

	/* ---------------- journal ---------------- */

	loadJournal(s: JournalShape) {
		this.cursor = s.cursor ?? "";
		this.rootKey = s.rootKey ?? "";
		this.remoteMap = new Map(Object.entries(s.remote ?? {}));
		this.baseMap = new Map(Object.entries(s.base ?? {}));
	}

	journalObject(): Required<JournalShape> {
		return {
			cursor: this.cursor,
			rootKey: this.rootKey,
			remote: Object.fromEntries(this.remoteMap),
			base: Object.fromEntries(this.baseMap),
		};
	}

	/** What this device's journal agrees is synced: file count, the distinct
	 *  folders those files live in, and their total size. Sizes marked -1 by
	 *  a rescan poison are counted as files but not bytes. */
	syncedStats(): { files: number; folders: number; bytes: number } {
		const folders = new Set<string>();
		let bytes = 0;
		for (const [k, b] of this.baseMap) {
			for (let p = pathParent(k); p; p = pathParent(p)) folders.add(p);
			if (b.size > 0) bytes += b.size;
		}
		return { files: this.baseMap.size, folders: folders.size, bytes };
	}

	heldBackCount(): number {
		return this.heldBack.size;
	}

	resetJournal() {
		this.cursor = "";
		this.rootKey = "";
		this.remoteMap.clear();
		this.baseMap.clear();
		this.markerChecked = false;
	}

	/** Forget every stat shortcut and the remote cursor: the next sync
	 *  rehashes everything and relists Dropbox. Never destructive. */
	markRescan() {
		this.cursor = "";
		for (const [k, b] of this.baseMap) this.baseMap.set(k, { ...b, mtime: -1, size: -1 });
	}

	markerDirty() {
		this.markerChecked = false;
		this.e2eKey = null;
		this.secretsKey = null;
	}

	/** Plugin settings files carry API keys and only travel under an
	 *  encryption envelope. Our own plugin's file is exempt: it is
	 *  credential-free by design and a joining device reads it before it has
	 *  any passphrase.
	 *
	 *  Covers both protection scopes: plugin settings files and any file under
	 *  a protected top-level folder. The scope comes from the marker so every
	 *  device agrees; `protectionZone` is the one predicate all of it routes
	 *  through. */
	private protectedPath(rel: string): boolean {
		return this.protZone(rel) !== "";
	}

	/** The encryption zone a path stores under this run, per the marker's
	 *  declared protection scope. "" is the plain remainder. */
	private protZone(rel: string): string {
		return protectionZone(rel, this.host.configDir(), this.host.pluginFolderName(), this.protectedFolders);
	}

	/** Any plugin's settings file, our own included: these merge per key
	 *  rather than per line, and never sit out just because text auto-merge
	 *  is off. */
	private isPluginData(rel: string): boolean {
		return isPluginDataPath(rel, this.host.configDir());
	}

	/** A plugin's build artifacts (main.js, styles.css, manifest.json):
	 *  never merged, and settled by version instead of by clock. */
	private isPluginCode(rel: string): boolean {
		return isPluginCodePath(rel, this.host.configDir());
	}

	/**
	 * Which side carries the newer build of the plugin owning this file:
	 * 1 local, -1 remote, 0 no opinion (equal versions, or a manifest that is
	 * missing or unreadable on either side).
	 *
	 * The manifest speaks for the whole folder, so one download answers for a
	 * version bump that conflicted main.js, styles.css and manifest.json
	 * together; the verdict is cached for the run. Every failure path returns
	 * 0 rather than a guess: resolving a conflict the wrong way here installs
	 * the wrong code on every device, so "no opinion" must stay cheap to
	 * reach and the caller keeps its ordinary rule.
	 */
	private async pluginVersionCompare(rel: string, prep: PrepResult, localBytes: ArrayBuffer, remotePlain: ArrayBuffer): Promise<number> {
		const dir = pluginDirOf(rel, this.host.configDir());
		if (!dir) return 0;
		const cacheKey = normKey(dir);
		const cached = this.versionCache.get(cacheKey);
		if (cached !== undefined) return cached;
		let cmp = 0;
		try {
			// the conflicting file may BE the manifest, in which case both
			// sides are already in hand and no download is needed
			const isManifest = pathBase(rel).toLowerCase() === "manifest.json";
			const localText = isManifest ? mergeableText(localBytes) : await this.readLocalText(`${dir}/manifest.json`);
			const remoteText = isManifest ? mergeableText(remotePlain) : await this.readRemoteText(`${dir}/manifest.json`, prep);
			cmp = compareVersions(localText && manifestVersion(localText), remoteText && manifestVersion(remoteText));
		} catch {
			cmp = 0;
		}
		this.versionCache.set(cacheKey, cmp);
		return cmp;
	}

	private async readLocalText(rel: string): Promise<string | null> {
		try {
			if (!(await this.vault.exists(rel))) return null;
			return mergeableText(await this.vault.read(rel));
		} catch {
			return null;
		}
	}

	/** The remote copy of a file this run already listed, as text. Encrypted
	 *  bytes we hold no key for read as null, which is a no-opinion. */
	private async readRemoteText(rel: string, prep: PrepResult): Promise<string | null> {
		const e = prep.remote.get(normKey(rel));
		if (!e) return null;
		try {
			// half a file merges into a note that loses the other half's words,
			// so an unverified read is no opinion at all
			const got = await this.downloadVerified(this.rootedPath(e.path));
			if (!got) return null;
			const { bytes } = got;
			const dk = prep.key ?? (looksEncrypted(bytes) ? prep.secretsKey : null);
			if (dk) return mergeableText(await decryptBytes(dk, bytes));
			return looksEncrypted(bytes) ? null : mergeableText(bytes);
		} catch {
			return null;
		}
	}

	/** Anything under the vault's config folder: settings, themes, plugin
	 *  files. The joining-device conflict rule applies only here; notes are
	 *  the user's and keep the normal contest. */
	private configPath(rel: string): boolean {
		return normKey(rel).startsWith(normKey(this.host.configDir()) + "/");
	}

	/** True when a protected file has no envelope this run: folder plain and
	 *  no verified protection key on this device. */
	private protectedBlocked(rel: string): boolean {
		return !this.e2eKey && !this.secretsKey && this.protectedPath(rel);
	}

	private fileKey(rel: string, prep: { key: CryptoKey | null; secretsKey: CryptoKey | null }): CryptoKey | null {
		return prep.key ?? (this.protectedPath(rel) ? prep.secretsKey : null);
	}

	/** The narrowest possible upload, for a phone about to be frozen: no
	 *  listing, no scan, no planning. Each dirty file uploads against its
	 *  journal rev; a 409, a missing file, or anything unusual defers to the
	 *  next full sync. Returns the files that actually left. Skipped when the
	 *  marker has not been settled this session; a hurry is no excuse to
	 *  guess at encryption state. */
	async flushPaths(rels: string[]): Promise<string[]> {
		if (!this.markerChecked) return [];
		const keys = { key: this.e2eKey, secretsKey: this.secretsKey };
		const ig = this.buildIgnoreRules();
		const flushed: string[] = [];
		for (const rel of rels.slice(0, 5)) {
			try {
				const key = normKey(rel);
				if (junkFile(key) || isIgnored(key, ig) || this.protectedBlocked(rel)) continue;
				const b = this.baseMap.get(key);
				const st = await this.vault.stat(rel);
				if (!st) continue; // deletions wait for a full sync's guards
				const bytes = await this.vault.read(rel);
				const lhash = await this.hashOf(bytes);
				if (b && b.lhash === lhash) continue; // nothing actually changed
				const fk = this.fileKey(rel, keys);
				const stored = fk ? await encryptBytes(fk, bytes) : bytes;
				const meta = await this.remote.upload(this.rootedPath(rel), stored, {
					mode: b?.rev ? { update: b.rev } : "add",
					clientModified: msToIsoSec(st.mtime || Date.now()),
				});
				this.recordSynced(key, rel, meta, lhash, st.mtime, st.size);
				flushed.push(rel);
				this.host.log("info", `Flushed on leaving: ${rel}`);
			} catch {
				continue; // the next full sync reconciles anything unusual
			}
		}
		if (flushed.length) void this.host.saveState();
		return flushed;
	}

	/** Re-upload every local file under the given top-level folders in whatever
	 *  envelope their zone now calls for.
	 *
	 *  This is the migration when a user protects or unprotects an existing
	 *  folder: its files on Dropbox are in the old envelope, and an ordinary
	 *  sync would skip them because their plaintext content has not changed.
	 *  Forcing an overwrite with the correct key is the only thing that moves
	 *  them; the write records a fresh base so later syncs stay quiet.
	 *
	 *  Runs against a prep's local map so it sees exactly what the sync will,
	 *  and only after the marker is settled, so the key and the protected set
	 *  are current. A file this device cannot encrypt (no passphrase) is left
	 *  for a device that can, never uploaded in the clear. Returns the count
	 *  actually re-uploaded. */
	async migrateProtectedFolders(folderKeys: readonly string[], local: Map<string, LocalEntry>): Promise<number> {
		if (!this.markerChecked) return 0;
		const targets = folderKeys.map(normKey).filter(Boolean);
		if (!targets.length) return 0;
		const keys = { key: this.e2eKey, secretsKey: this.secretsKey };
		const inScope = (k: string) => targets.some((f) => k === f || k.startsWith(f + "/"));
		let n = 0;
		for (const [key, l] of local) {
			if (!inScope(key)) continue;
			if (this.protectedBlocked(l.path)) continue; // no key here: leave it for a device that has one
			try {
				const st = await this.vault.stat(l.path);
				if (!st) continue;
				const bytes = await this.vault.read(l.path);
				const lhash = await this.hashOf(bytes);
				const fk = this.fileKey(l.path, keys);
				const stored = fk ? await encryptBytes(fk, bytes) : bytes;
				const b = this.baseMap.get(key);
				const meta = await this.remote.upload(this.rootedPath(l.path), stored, {
					mode: b?.rev ? { update: b.rev } : "add",
					clientModified: msToIsoSec(st.mtime || Date.now()),
				});
				this.recordSynced(key, l.path, meta, lhash, st.mtime, st.size);
				n++;
			} catch (e) {
				// a 409 or a vanished file is reconciled by the ordinary sync that
				// follows; one stubborn file must not abort the whole migration
				this.host.log("warn", `Could not re-key ${l.path}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		if (n) void this.host.saveState();
		return n;
	}

	private hashOf(bytes: ArrayBuffer): Promise<string> {
		return this.remote.hashOf ? this.remote.hashOf(bytes) : contentHash(bytes);
	}

	pushMoveHint(from: string, to: string) {
		if (this.moveHints.length < 500) this.moveHints.push({ from: normRel(from), to: normRel(to) });
	}

	remoteRoot(): string {
		return "/" + sanitizeRemoteFolder(this.host.settings().remoteFolder || this.host.vaultName());
	}

	private rootedPath(rel: string): string {
		return `${this.runRoot || this.remoteRoot()}/${rel}`;
	}

	buildIgnoreRules(): IgnoreRule[] {
		return buildIgnore(this.host.settings(), this.host.configDir(), this.host.pluginFolderName(), this.host.deviceExcludeLines());
	}

	/* ---------------- remote side ---------------- */

	private applyEntries(entries: ListEntry[]) {
		const rootN = normRel(this.runRoot || this.remoteRoot());
		for (const en of entries) {
			const norm = normRel(en.tag === "file" ? en.meta.pathDisplay : en.pathDisplay);
			if (norm.toLowerCase() === rootN.toLowerCase()) {
				// the vault folder itself was deleted in Dropbox: one entry
				// covers the whole subtree, and skipping it would leave the
				// engine believing everything is still there
				if (en.tag === "deleted") {
					this.remoteMap.clear();
					this.host.log("warn", "The Dropbox folder itself was deleted; the delete guard will review what happens locally.");
				}
				continue;
			}
			if (en.tag === "folder") continue;
			if (!norm.toLowerCase().startsWith(rootN.toLowerCase() + "/")) continue;
			const rel = norm.slice(rootN.length + 1);
			const key = normKey(rel);
			if (key === MARKER_NAME) continue;
			if (en.tag === "deleted") {
				// a deleted folder arrives as one entry; everything under it is gone
				this.remoteMap.delete(key);
				const prefix = key + "/";
				for (const k of [...this.remoteMap.keys()]) if (k.startsWith(prefix)) this.remoteMap.delete(k);
			} else {
				this.remoteMap.set(key, {
					path: rel,
					rev: en.meta.rev,
					size: en.meta.size,
					hash: en.meta.contentHash,
					mtime: isoToMs(en.meta.clientModified),
				});
			}
		}
	}

	private async refreshRemote(): Promise<void> {
		const root = this.runRoot || this.remoteRoot();
		if (!this.cursor) {
			await this.remote.ensureFolder(root);
			const { entries, cursor } = await this.remote.listAll(root);
			this.remoteMap.clear();
			this.applyEntries(entries);
			this.cursor = cursor;
			return;
		}
		try {
			const { entries, cursor } = await this.remote.listContinue(this.cursor);
			this.applyEntries(entries);
			this.cursor = cursor;
		} catch (e) {
			if (isCursorReset(e)) {
				this.host.log("info", "Dropbox reset the change cursor; relisting the folder.");
				this.cursor = "";
				await this.refreshRemote();
				return;
			}
			throw e;
		}
	}

	/** Make the encryption settings and the remote folder agree before any
	 *  file moves, or refuse to sync. */
	private async adoptMarker(marker: Marker): Promise<void> {
		const s = this.host.settings();
		// full e2e encrypts everything, so the folder list is moot; otherwise the
		// marker names which folders are protected and every device reads it here
		this.protectedFolders = marker.e2e ? [] : markerProtectedFolders(marker);
		if (marker.e2e) {
			if (!s.e2ePassphrase) throw new SyncBlocked("This Dropbox folder is encrypted. Enter the passphrase in Power Connect settings.");
			const key = await deriveKey(s.e2ePassphrase, marker.salt ?? "");
			if (!(await verifyCheck(key, marker.check ?? ""))) throw new SyncBlocked("The encryption passphrase does not match this Dropbox folder.");
			this.e2eKey = key;
			if (!s.e2eEnabled) {
				s.e2eEnabled = true;
				this.host.settingsChanged();
			}
		} else {
			if (s.e2eEnabled)
				throw new SyncBlocked("Encryption is on, but this Dropbox folder holds an unencrypted copy. Turn encryption off, or use an empty folder name and enable it there.");
			this.e2eKey = null;
			this.secretsKey = null;
			this.protectionSeen = !!marker.secrets;
			if (marker.secrets) {
				const scope = this.protectedFolders.length ? "plugin settings and some folders" : "plugin settings files";
				if (!s.e2ePassphrase) {
					this.host.log("info", `This folder protects ${scope}; enter the passphrase in setup to sync them on this device.`);
				} else {
					const sk = await deriveKey(s.e2ePassphrase, marker.secrets.salt);
					if (await verifyCheck(sk, marker.secrets.check)) this.secretsKey = sk;
					else this.host.log("warn", `The passphrase does not match this folder's protection; ${scope} are held back.`);
				}
			}
		}
	}

	/** Read the remote marker, or establish one. A missing marker over a
	 *  non-empty folder is investigated, not assumed: one file is probed for
	 *  the encryption magic, because stamping an encrypted tree as plaintext
	 *  (or the reverse) is how mixed folders happen. Creation uses mode
	 *  "add", so two devices racing their first sync converge on one salt
	 *  instead of last-writer-wins wedging the loser's uploads. */
	private async ensureMarker(): Promise<void> {
		if (this.markerChecked) return;
		const s = this.host.settings();
		const root = this.runRoot || this.remoteRoot();
		const path = `${root}/${MARKER_NAME}`;
		for (let attempt = 0; attempt < 2; attempt++) {
			let marker: Marker | null = null;
			try {
				const { bytes } = await this.remote.download(path);
				marker = JSON.parse(new TextDecoder().decode(bytes)) as Marker;
			} catch (e) {
				if (!isNotFound(e)) throw e;
			}
			if (marker) {
				await this.adoptMarker(marker);
				this.markerChecked = true;
				return;
			}
			await this.remote.ensureFolder(root);
			const probe = (await this.remote.listProbe(root)).filter(
				(en): en is { tag: "file"; meta: RemoteFileMeta } => en.tag === "file" && !normRel(en.meta.pathDisplay).toLowerCase().endsWith("/" + MARKER_NAME)
			);
			let fresh: Marker;
			if (probe.length) {
				const { bytes } = await this.remote.download(probe[0].meta.pathDisplay);
				if (looksEncrypted(bytes))
					throw new SyncBlocked(
						"This Dropbox folder holds encrypted files but its .powerconnect.json marker is missing, and the marker holds the key salt. Restore .powerconnect.json from Dropbox's deleted files or version history."
					);
				if (s.e2eEnabled)
					throw new SyncBlocked("Encryption is on, but this Dropbox folder holds an unencrypted copy. Turn encryption off, or use an empty folder name and enable it there.");
				fresh = { format: 1, e2e: false };
				this.e2eKey = null;
			} else if (s.e2eEnabled) {
				if (!s.e2ePassphrase) throw new SyncBlocked("Encryption is on but no passphrase is set.");
				const salt = makeSalt();
				const key = await deriveKey(s.e2ePassphrase, salt);
				fresh = { format: 1, e2e: true, salt, check: await makeCheck(key) };
				this.e2eKey = key;
			} else {
				fresh = { format: 1, e2e: false };
				this.e2eKey = null;
			}
			const body = new TextEncoder().encode(JSON.stringify(fresh));
			try {
				await this.remote.upload(path, body.buffer, { mode: "add", clientModified: msToIsoSec(Date.now()) });
				this.markerChecked = true;
				return;
			} catch (e) {
				if (!isConflict(e)) throw e;
				// another device wrote the marker first; loop and adopt theirs
			}
		}
		throw new SyncBlocked("Could not settle the Dropbox folder marker; try again in a moment.");
	}

	/* ---------------- scanning ---------------- */

	private async scanLocal(ig: IgnoreRule[]): Promise<Map<string, LocalEntry>> {
		const s = this.host.settings();
		const cfg = this.host.configDir();
		const out = new Map<string, LocalEntry>();
		const put = (rawPath: string, mtime: number, size: number) => {
			const rel = normRel(rawPath);
			if (!rel || junkFile(rel) || isIgnored(rel, ig) || hiddenBlocked(rel, cfg)) return;
			if (this.protectedBlocked(rel)) {
				this.heldBack.add(normKey(rel));
				return;
			}
			if (!withinSizeLimit(size, s.maxFileMB)) {
				this.host.log("debug", `Over the size cap, not syncing: ${rel} (${fmtBytes(size)})`);
				return;
			}
			out.set(normKey(rel), { path: rel, mtime, size, hash: "" });
		};
		for (const f of this.vault.listVisible()) put(f.path, f.mtime, f.size);
		if (s.syncConfig) {
			// no subtree skip: the ignore rules decide what inside our own
			// folder syncs (the journal never does). Skipping the whole
			// folder here kept our data.json and code updates from ever
			// uploading, even though the rules admitted them.
			for (const f of await this.vault.listConfig(cfg, "")) put(f.path, f.mtime, f.size);
		}
		return out;
	}

	/** Fill plaintext hashes: journal fast path when mtime and size are
	 *  untouched, real hashing otherwise. Unreadable files are returned as
	 *  keys to hide from the whole run, so they never read as deletions. */
	private async fillHashes(local: Map<string, LocalEntry>, onProgress: (text: string) => void): Promise<Set<string>> {
		const need: [string, LocalEntry][] = [];
		for (const [k, e] of local) {
			const b = this.baseMap.get(k);
			if (b && b.mtime === e.mtime && b.size === e.size && b.lhash) e.hash = b.lhash;
			else need.push([k, e]);
		}
		const bad = new Set<string>();
		let done = 0;
		await pool(need, 4, async ([k, e]) => {
			try {
				e.hash = await this.hashOf(await this.vault.read(e.path));
				// unchanged content under a new stat (a rescan, a touch): heal
				// the journal so the fast path works again next run
				const b = this.baseMap.get(k);
				if (b && b.lhash === e.hash && (b.mtime !== e.mtime || b.size !== e.size)) this.baseMap.set(k, { ...b, mtime: e.mtime, size: e.size });
			} catch (err) {
				bad.add(k);
				this.host.log("warn", `Could not read ${e.path}: ${msg(err)}`);
			}
			done++;
			if (need.length > 20 && done % 20 === 0) onProgress(`indexing ${done}/${need.length}`);
		});
		for (const k of bad) local.delete(k);
		return bad;
	}

	/* ---------------- the sync run ---------------- */

	private takeMoveHints(): MoveHint[] {
		const hints = this.moveHints;
		this.moveHints = [];
		return hints;
	}

	async prepare(onProgress: (text: string) => void): Promise<PrepResult> {
		// freeze the run's world: root and (after the marker) the key. Typing
		// in settings mid-run must not redirect files already in flight.
		const s = this.host.settings();
		this.heldBack = new Set();
		this.versionCache.clear(); // versions can change between runs
		const root = this.remoteRoot();
		this.runRoot = root;
		const rk = normKey(root);
		if (this.rootKey && this.rootKey !== rk) {
			this.host.log("info", "The Dropbox folder name changed; forgetting the old journal and re-merging against the new folder.");
			this.cursor = "";
			this.remoteMap.clear();
			this.baseMap.clear();
		}
		this.rootKey = rk;
		await this.ensureMarker();
		onProgress("reading Dropbox changes");
		await this.refreshRemote();
		void this.host.saveState(); // the cursor moved; the entries it covered must survive a crash
		const ig = this.buildIgnoreRules();
		const cfg = this.host.configDir();
		onProgress("scanning vault");
		const local = await this.scanLocal(ig);
		for (const k of [...this.baseMap.keys()]) if (junkFile(k) || isIgnored(k, ig) || hiddenBlocked(k, cfg) || this.protectedBlocked(k)) this.baseMap.delete(k);
		const remoteView = new Map<string, RemoteEntry>();
		for (const [k, v] of this.remoteMap) {
			if (junkFile(k) || isIgnored(k, ig) || hiddenBlocked(k, cfg)) continue;
			if (this.protectedBlocked(k)) {
				this.heldBack.add(k);
				continue;
			}
			if (!withinSizeLimit(v.size, s.maxFileMB)) continue;
			remoteView.set(k, v);
		}
		if (this.heldBack.size) {
			this.host.log("info", `${this.heldBack.size} plugin settings file(s) held back: they sync only under encryption. Set a protection passphrase in setup.`);
		}
		const bad = await this.fillHashes(local, onProgress);
		for (const k of bad) remoteView.delete(k);
		const baseView = new Map<string, BaseEntry>();
		for (const [k, v] of this.baseMap) if (!bad.has(k)) baseView.set(k, v);
		const plan = planSync({
			local,
			remote: remoteView,
			base: baseView,
			moves: this.takeMoveHints(),
			e2e: s.e2eEnabled,
			deleteGuardPct: s.deleteGuardPct,
			// a move across an encryption boundary must not take the cheap rename;
			// plugin data.json is always a zone, so the guard is always on
			zoneOf: (rel) => this.protZone(rel),
		});
		return { plan, local, remote: remoteView, root, key: this.e2eKey, secretsKey: this.secretsKey, policy: s.conflictPolicy, joining: this.baseMap.size === 0 };
	}

	async execute(prep: PrepResult, plan: Plan, stats: RunStats, interactive: boolean, onProgress: (text: string) => void): Promise<void> {
		const transfers = plan.actions.filter((a) => a.t === "upload" || a.t === "download" || a.t === "adopt" || a.t === "moveRemote");
		const conflicts = plan.actions.filter((a) => a.t === "conflict");
		const deletes = plan.actions.filter((a) => a.t === "deleteLocal" || a.t === "deleteRemote");
		const drops = plan.actions.filter((a) => a.t === "dropBase");
		const total = transfers.length + conflicts.length + deletes.length;
		let done = 0;
		const tick = () => {
			done++;
			// most of a first merge is by-content matches that move nothing;
			// saying so keeps a big total from reading as a big transfer
			onProgress(stats.adopts >= 25 ? `${done}/${total}, ${stats.adopts} matched` : `${done}/${total}`);
			// the host coalesces these; the modulo only bounds how much a
			// crash can lose, and 200 keeps an adopt storm from asking for
			// hundreds of serializations in one burst
			if (done % 200 === 0) void this.host.saveState();
		};
		let blockedErr: SyncBlocked | null = null;
		const guard = async (a: { t: string; path?: string }, fn: () => Promise<void>) => {
			if (blockedErr) return; // the run is dead; stop starting work
			try {
				await fn();
			} catch (e) {
				if (e instanceof SyncBlocked) {
					// a blocked state (wrong passphrase, mixed encryption) is
					// about the whole folder, not this one file: halt the run
					if (!blockedErr) blockedErr = e;
					return;
				}
				if (isConflict(e)) {
					stats.skipped++;
					this.host.log("info", `${a.path ?? a.t} moved on Dropbox during the sync; the next sync will reconcile it.`);
				} else {
					stats.errors.push(`${a.path ?? a.t}: ${msg(e)}`);
					this.host.log("error", `${a.path ?? a.t}: ${msg(e)}`);
				}
			}
			tick();
		};
		const conc = Math.max(1, this.host.settings().concurrency);
		const batching = !!(this.remote.uploadStart && this.remote.uploadFinishBatch);
		// Plugin code, then plugin settings, then the rest of the config folder,
		// then notes: a joining device becomes a working Obsidian early instead
		// of at the end of a first sync that can run for a long time. Each tier
		// finishes before the next starts, so the plugins that land are whole.
		for (const tier of tierTransfers(batching ? transfers.filter((a) => a.t !== "upload") : transfers, this.host.configDir())) {
			if (blockedErr) break;
			await pool(tier, conc, async (a) => {
				if (a.t === "upload") await guard(a, () => this.doUpload(a.key, a.path, a.baseRev, prep, stats));
				else if (a.t === "download") await guard(a, () => this.doDownload(a.key, prep, stats));
				else if (a.t === "adopt") await guard(a, () => this.doAdopt(a.key, prep, stats));
				else if (a.t === "moveRemote") await guard({ t: a.t, path: a.toPath }, () => this.doMoveRemote(a.fromKey, a.toKey, a.fromPath, a.toPath, prep, stats));
			});
		}
		if (batching) {
			// Uploads go wide: each file's bytes are staged as an upload
			// session (sessions take no namespace write lock, so parallelism
			// actually parallelizes), then committed hundreds at a time in a
			// single finish_batch call. The journal records a file only when
			// its commit confirms, so a crash between staging and committing
			// costs a re-upload, never correctness.
			const BATCH_MAX = 500;
			const BIG = 100 * 1024 * 1024; // sessions cap ~150 MB per request; big files keep the chunked path
			interface Staged {
				key: string;
				rel: string;
				sessionId: string;
				size: number;
				mode: "add" | { update: string };
				clientModified: string;
				lhash: string;
				mtime: number;
				fsize: number;
			}
			let staged: Staged[] = [];
			const flush = async () => {
				const group = staged;
				staged = [];
				if (!group.length || blockedErr) return;
				let results: BatchResult[];
				try {
					results = await this.remote.uploadFinishBatch!(
						group.map((g): BatchCommit => ({ sessionId: g.sessionId, size: g.size, path: this.rootedPath(g.rel), mode: g.mode, clientModified: g.clientModified }))
					);
				} catch (e) {
					if (e instanceof SyncBlocked) {
						if (!blockedErr) blockedErr = e;
						return;
					}
					// a failed batch commit is a run-level failure: nothing in
					// this group landed and the journal was not touched, so the
					// run fails loudly and the next one re-stages. Absorbing it
					// as per-file errors could repeat forever with no progress.
					throw e;
				}
				for (let i = 0; i < group.length; i++) {
					const g = group[i];
					const r = results[i];
					if (r?.ok && r.meta.size !== g.size) {
						// The commit claimed success but stored fewer bytes than were
						// staged, so the remote now holds a stump of our own making.
						//
						// Declining to RECORD it is not enough. The stump is a real file
						// on the remote now: its size matches its own metadata, so no
						// download check can object, and the next run sees a remote file
						// with no base entry, calls it a conflict, and the stump can win
						// the contest outright. That is how a 60 MB recording became 8 MB
						// on every device on 2026-07-29.
						//
						// So repair it here, in the same run, while we still hold the
						// bytes and know the remote content is garbage we just wrote.
						// Overwrite rather than update-on-rev: the rev moved when the
						// short commit landed, and what is up there is ours to replace.
						this.host.log("warn", `${g.rel} landed short (${r.meta.size} of ${g.size} bytes); re-sending it now.`);
						try {
							const bytes = await this.vault.read(g.rel);
							const uk = this.fileKey(g.rel, prep);
							const stored = uk ? await encryptBytes(uk, bytes) : bytes;
							const again = await this.remote.upload(this.rootedPath(g.rel), stored, { mode: "overwrite", clientModified: g.clientModified });
							assertWholeUpload(g.rel, stored.byteLength, again.size);
							this.recordSynced(g.key, g.rel, again, g.lhash, g.mtime, g.fsize);
							stats.up++;
							this.host.log("info", `Uploaded: ${g.rel} (second attempt, after a short write)`);
						} catch (e) {
							// Still short, or the retry itself failed. Nothing is recorded,
							// so the stump on the remote has no journal entry vouching for
							// it; the next run will contest it with the local file, which is
							// intact. Loud, because a stump up there is a live hazard.
							stats.errors.push(`${g.rel}: stored ${r.meta.size} bytes of ${g.size} and the re-send failed (${msg(e)})`);
							this.host.log("error", `${g.rel} did not land whole and could not be re-sent. The complete file is still here; the copy on the remote is truncated.`);
						}
					} else if (r?.ok) {
						this.recordSynced(g.key, g.rel, r.meta, g.lhash, g.mtime, g.fsize);
						stats.up++;
						this.host.log("info", `Uploaded: ${g.rel}`);
					} else if (/conflict/i.test(r?.error ?? "")) {
						stats.skipped++;
						this.host.log("info", `${g.rel} moved on Dropbox during the sync; the next sync will reconcile it.`);
					} else {
						stats.errors.push(`${g.rel}: ${r ? r.error : "upload failed"}`);
						this.host.log("error", `${g.rel}: ${r ? r.error : "upload failed"}`);
					}
					tick();
				}
			};
			await pool(transfers.filter((a) => a.t === "upload"), conc, async (a) => {
				if (a.t !== "upload" || blockedErr) return;
				let full = false;
				try {
					const st = await this.statOf(a.path);
					const bytes = await this.vault.read(a.path);
					const lhash = await this.hashOf(bytes);
					const uk = this.fileKey(a.path, prep);
					const stored = uk ? await encryptBytes(uk, bytes) : bytes;
					const mode: "add" | { update: string } = a.baseRev ? { update: a.baseRev } : "add";
					const clientModified = msToIsoSec(st.mtime || Date.now());
					if (stored.byteLength > BIG) {
						const meta = await this.remote.upload(this.rootedPath(a.path), stored, { mode, clientModified });
						this.recordSynced(a.key, a.path, meta, lhash, st.mtime, st.size);
						stats.up++;
						this.host.log("info", `Uploaded: ${a.path}`);
						tick();
						return;
					}
					const sessionId = await this.remote.uploadStart!(stored);
					staged.push({ key: a.key, rel: a.path, sessionId, size: stored.byteLength, mode, clientModified, lhash, mtime: st.mtime, fsize: st.size });
					full = staged.length >= BATCH_MAX;
				} catch (e) {
					if (e instanceof SyncBlocked) {
						if (!blockedErr) blockedErr = e;
						return;
					}
					if (isConflict(e)) {
						stats.skipped++;
						this.host.log("info", `${a.path} moved on Dropbox during the sync; the next sync will reconcile it.`);
					} else {
						stats.errors.push(`${a.path}: ${msg(e)}`);
						this.host.log("error", `${a.path}: ${msg(e)}`);
					}
					tick();
				}
				if (full) await flush();
			});
			await flush();
		}
		for (const a of conflicts) {
			if (a.t !== "conflict") continue;
			await guard(a, () => this.doConflict(a.key, prep, stats, interactive));
		}
		for (const a of deletes) {
			if (a.t === "deleteLocal")
				await guard(a, async () => {
					await this.vault.trash(a.path);
					this.baseMap.delete(a.key);
					stats.delLocal++;
					this.host.log("info", `Deleted here (deleted on Dropbox): ${a.path}`);
				});
			else if (a.t === "deleteRemote")
				await guard(a, async () => {
					// the base rev is the precondition: a file another device
					// just replaced 409s instead of losing its new content
					const b = this.baseMap.get(a.key);
					await this.remote.del(this.rootedPath(a.path), b?.rev);
					this.baseMap.delete(a.key);
					this.remoteMap.delete(a.key);
					stats.delRemote++;
					this.host.log("info", `Deleted on Dropbox (deleted here): ${a.path}`);
				});
		}
		for (const a of drops) if (a.t === "dropBase") this.baseMap.delete(a.key);
		if (blockedErr) {
			// named as an Error on the way out: blockedErr is assigned inside a
			// closure, so the compiler will not carry the guard above across to
			// the throw on its own
			const err: Error = blockedErr;
			throw err;
		}
	}

	/* ---------------- executors ---------------- */

	private async statOf(rel: string): Promise<VaultStatLite> {
		const st = await this.vault.stat(rel);
		return { mtime: st?.mtime ?? 0, size: st?.size ?? 0 };
	}

	private recordSynced(key: string, rel: string, meta: RemoteFileMeta, lhash: string, mtime: number, size: number) {
		this.baseMap.set(key, { rev: meta.rev, hash: meta.contentHash, lhash, mtime, size });
		this.remoteMap.set(key, { path: rel, rev: meta.rev, size: meta.size, hash: meta.contentHash, mtime: isoToMs(meta.clientModified) });
	}

	private async doAdopt(key: string, prep: PrepResult, stats: RunStats) {
		const l = prep.local.get(key);
		const r = prep.remote.get(key);
		if (!l || !r) return;
		this.baseMap.set(key, { rev: r.rev, hash: r.hash, lhash: l.hash, mtime: l.mtime, size: l.size });
		stats.adopts++;
	}

	private async doUpload(key: string, rel: string, baseRev: string | null, prep: PrepResult, stats: RunStats) {
		// the user may have kept typing since the scan; ship what is there
		// now. Stat first, read second: an edit landing between the two makes
		// the recorded mtime disagree with disk, so the next scan rehashes
		// and catches it (recording a post-edit stat with pre-edit bytes
		// would hide the edit from every future fast path).
		const st = await this.statOf(rel);
		const bytes = await this.vault.read(rel);
		const lhash = await this.hashOf(bytes);
		const uk = this.fileKey(rel, prep);
		const stored = uk ? await encryptBytes(uk, bytes) : bytes;
		const meta = await this.remote.upload(this.rootedPath(rel), stored, {
			mode: baseRev ? { update: baseRev } : "add",
			clientModified: msToIsoSec(st.mtime || Date.now()),
		});
		assertWholeUpload(rel, stored.byteLength, meta.size);
		this.recordSynced(key, rel, meta, lhash, st.mtime, st.size);
		stats.up++;
		this.host.log("info", `Uploaded: ${rel}`);
	}

	/** Download, and hand back nothing at all unless the bytes that arrived
	 *  match the checksum published for them.
	 *
	 *  Every path that puts remote bytes into the vault goes through here.
	 *  Checking in each caller instead is how one of them came to skip it: a
	 *  conflict resolution downloaded unverified bytes, wrote them over the
	 *  file the user actually had, and recorded the remote's hash for them. A
	 *  short body is indistinguishable from success, the metadata still
	 *  describes the whole file, so the write looked clean, and every later
	 *  scan compared the truncated file against a hash that was never true of
	 *  it and saw nothing to repair. A vault here lost the tail of two
	 *  recordings that way, and kept them only because the conflict copy held
	 *  the complete bytes.
	 *
	 *  Refusing costs a retry on the next run. Accepting costs the file. */
	private async downloadVerified(path: string): Promise<{ bytes: ArrayBuffer; meta: RemoteFileMeta } | null> {
		const got = await this.remote.download(path);
		if (got.meta.contentHash && (await this.hashOf(got.bytes)) !== got.meta.contentHash) return null;
		return got;
	}

	private async doDownload(key: string, prep: PrepResult, stats: RunStats) {
		const r = prep.remote.get(key);
		if (!r) return;
		const l = prep.local.get(key);
		const target = l ? l.path : r.path;
		if (this.host.isWindows()) {
			const unsafe = windowsUnsafe(target);
			if (unsafe) {
				stats.skipped++;
				this.host.log("warn", `Skipped ${r.path}: ${unsafe}. Rename it on another device to sync it here.`);
				return;
			}
		}
		const got = await this.downloadVerified(this.rootedPath(r.path));
		if (!got) {
			stats.skipped++;
			this.host.log("warn", `${target} did not match its checksum after downloading; it was not written, and the next sync will retry it.`);
			return;
		}
		const { bytes, meta } = got;
		let plain = bytes;
		const dk = prep.key ?? (looksEncrypted(bytes) ? prep.secretsKey : null);
		if (dk) plain = await decryptBytes(dk, bytes);
		else if (looksEncrypted(bytes)) {
			if (this.protectedPath(r.path)) {
				stats.skipped++;
				this.host.log("info", `${r.path} is protected; enter the passphrase in setup to sync it here.`);
				return;
			}
			throw new SyncBlocked(`${r.path} on Dropbox is encrypted. Enter the passphrase in settings.`);
		}
		// never clobber what happened here while the sync ran: an edit, a
		// delete, or a file that just appeared all defer to the next run
		const st = await this.vault.stat(target);
		if (l ? !st || st.mtime !== l.mtime || st.size !== l.size : !!st) {
			stats.skipped++;
			this.host.log("info", `${target} changed here during the sync; the next sync will reconcile it.`);
			return;
		}
		await this.vault.write(target, plain, isoToMs(meta.clientModified) || r.mtime);
		const st2 = await this.statOf(target);
		const lhash = dk ? await this.hashOf(plain) : meta.contentHash;
		// if the stat does not describe what we wrote, poison the fast path
		// so the next scan rehashes instead of trusting it
		const statOk = st2.size === plain.byteLength;
		this.recordSynced(key, r.path, meta, lhash, statOk ? st2.mtime : -1, statOk ? st2.size : -1);
		stats.down++;
		this.host.log("info", `Downloaded: ${target}`);
	}

	private async doMoveRemote(fromKey: string, toKey: string, fromPath: string, toPath: string, prep: PrepResult, stats: RunStats) {
		const expected = this.baseMap.get(fromKey)?.hash ?? "";
		const meta = await this.remote.move(this.rootedPath(fromPath), this.rootedPath(toPath));
		const l = prep.local.get(toKey);
		this.baseMap.delete(fromKey);
		this.remoteMap.delete(fromKey);
		this.remoteMap.set(toKey, { path: toPath, rev: meta.rev, size: meta.size, hash: meta.contentHash, mtime: isoToMs(meta.clientModified) });
		// only bless the pair as in-sync if the moved bytes are the bytes the
		// plan reasoned about; a remote edit racing the move must surface as
		// a difference next run, not get recorded away
		if (l && meta.contentHash === expected) {
			this.baseMap.set(toKey, { rev: meta.rev, hash: meta.contentHash, lhash: l.hash, mtime: l.mtime, size: l.size });
		} else {
			this.host.log("info", `${toPath} changed on Dropbox during the move; the next sync will reconcile it.`);
		}
		stats.moves++;
		this.host.log("info", `Moved on Dropbox: ${fromPath} to ${toPath}`);
	}

	/** Combine concurrent edits using the base revision as the common
	 *  ancestor. True means the conflict is fully handled (merged, or
	 *  deliberately deferred to the next run); false falls through to the
	 *  conflict policies. The insertion order for same-point additions comes
	 *  from the edit times both sides can see, so every device that runs
	 *  this merge produces the identical file. */
	private async tryMerge(
		key: string,
		l: LocalEntry,
		r: RemoteEntry,
		localBytes: ArrayBuffer,
		remotePlain: ArrayBuffer,
		localHash: string,
		remoteHash: string,
		meta: RemoteFileMeta,
		prep: PrepResult,
		stats: RunStats,
		drifted: () => Promise<boolean>,
		skipDrifted: () => void
	): Promise<boolean> {
		// A settings file can merge with NO common ancestor at all, and should.
		//
		// Text needs a base: without one there is no way to tell an addition from
		// a deletion, so keep-both is the honest answer. A key-value file is
		// different. Merging against an empty base keeps the union of both sides'
		// keys and sends only the keys they genuinely disagree on to the winner,
		// which beats keep-both every time: two half-true settings files, one of
		// them named "(sync conflict ...)" and read by nothing.
		//
		// This is the state an empty journal leaves behind, and it is not rare:
		// a device whose base map was lost re-joins with no rev for any file, so
		// EVERY settings conflict in that pass took keep-both. That produced ~14
		// conflict copies in one run on 2026-07-29, five of them plugin settings.
		const pluginData = this.isPluginData(l.path);
		const b = this.baseMap.get(key);
		const noBase = !this.remote.downloadRev || !b?.rev;
		if (noBase && !pluginData) return false;
		let baseBytes = new ArrayBuffer(0);
		if (!noBase) {
			try {
				baseBytes = await this.remote.downloadRev!(b.rev, l.path);
			} catch {
				// revision expired or unreachable. Text keeps both; a settings file
				// still merges, against an empty base.
				if (!pluginData) return false;
				baseBytes = new ArrayBuffer(0);
			}
			try {
				const bk = prep.key ?? (looksEncrypted(baseBytes) ? prep.secretsKey : null);
				if (bk) baseBytes = await decryptBytes(bk, baseBytes);
			} catch {
				if (!pluginData) return false;
				baseBytes = new ArrayBuffer(0);
			}
		}
		const baseText = baseBytes.byteLength === 0 && pluginData ? "{}" : mergeableText(baseBytes);
		const localText = mergeableText(localBytes);
		const remoteText = mergeableText(remotePlain);
		if (baseText == null || localText == null || remoteText == null) return false;
		const lq = Math.round(l.mtime / 1000) * 1000;
		const localFirst = lq < r.mtime || (lq === r.mtime && localHash <= remoteHash);
		// data.json merges by key, text by line; a key both sides changed goes
		// to the side that would have won the whole file, so devices agree
		const merged = pluginData
			? mergePluginData(baseText, localText, remoteText, conflictWinner(lq, localHash, r.mtime, remoteHash) === "remote")
			: mergeThree(baseText, localText, remoteText, localFirst);
		if (merged == null) return false;
		const mergedBytes = new TextEncoder().encode(merged).buffer;
		const mergedHash = await this.hashOf(mergedBytes);
		const uk = this.fileKey(l.path, prep);
		const stored = uk ? await encryptBytes(uk, mergedBytes) : mergedBytes;
		const now = Date.now();
		let up: RemoteFileMeta;
		try {
			up = await this.remote.upload(this.rootedPath(l.path), stored, { mode: { update: meta.rev }, clientModified: msToIsoSec(now) });
			assertWholeUpload(l.path, stored.byteLength, up.size);
		} catch (e) {
			if (isConflict(e)) {
				// another device merged first; its result includes our remote
				// side and the next run folds our local edit into it
				stats.skipped++;
				this.host.log("info", `${l.path} moved on Dropbox during the merge; the next sync will reconcile it.`);
				return true;
			}
			throw e;
		}
		if (await drifted()) {
			// typed here while merging: leave the local file alone; the next
			// run sees this device's edit against the merged remote
			skipDrifted();
			return true;
		}
		await this.vault.write(l.path, mergedBytes, now);
		const st = await this.statOf(l.path);
		this.recordSynced(key, l.path, up, mergedHash, st.mtime, st.size);
		stats.merged++;
		this.host.log("info", `Merged concurrent edits: ${l.path}`);
		return true;
	}

	private async doConflict(key: string, prep: PrepResult, stats: RunStats, interactive: boolean) {
		const l = prep.local.get(key);
		const r = prep.remote.get(key);
		if (!l || !r) return;
		// a conflict resolution can overwrite the local file, so the bytes it
		// resolves against have to be the bytes Dropbox says they are
		const got = await this.downloadVerified(this.rootedPath(r.path));
		if (!got) {
			stats.skipped++;
			this.host.log("warn", `${r.path} did not match its checksum after downloading; the conflict was left alone, and the next sync will retry it.`);
			return;
		}
		const { bytes, meta } = got;
		let remotePlain = bytes;
		const dk = prep.key ?? (looksEncrypted(bytes) ? prep.secretsKey : null);
		if (dk) remotePlain = await decryptBytes(dk, bytes);
		else if (looksEncrypted(bytes)) {
			if (this.protectedPath(r.path)) {
				stats.skipped++;
				this.host.log("info", `${r.path} is protected; enter the passphrase in setup to sync it here.`);
				return;
			}
			throw new SyncBlocked(`${r.path} on Dropbox is encrypted. Enter the passphrase in settings.`);
		}
		const remoteHash = dk ? await this.hashOf(remotePlain) : meta.contentHash;

		// never resolve against a file that moved since the scan; the next
		// run will see the newest content and re-plan the conflict
		const drifted = async () => {
			const st = await this.vault.stat(l.path);
			return !st || st.mtime !== l.mtime || st.size !== l.size;
		};
		const skipDrifted = () => {
			stats.skipped++;
			this.host.log("info", `${l.path} changed here during the sync; the next sync will reconcile it.`);
		};
		if (await drifted()) {
			skipDrifted();
			return;
		}
		const localBytes = await this.vault.read(l.path);
		const localHash = await this.hashOf(localBytes);
		if (localHash === remoteHash) {
			const st = await this.statOf(l.path);
			this.recordSynced(key, r.path, meta, localHash, st.mtime, st.size);
			stats.adopts++;
			return;
		}
		// resolution uploads carry the rev this conflict was resolved
		// against, so an edit landing on Dropbox after our download 409s and
		// re-plans instead of being clobbered
		const upOriginal = async (plain: ArrayBuffer, lhash: string, mtime: number, size: number) => {
			const uk = this.fileKey(l.path, prep);
			const stored = uk ? await encryptBytes(uk, plain) : plain;
			const up = await this.remote.upload(this.rootedPath(l.path), stored, { mode: { update: meta.rev }, clientModified: msToIsoSec(mtime || Date.now()) });
			assertWholeUpload(l.path, stored.byteLength, up.size);
			this.recordSynced(key, l.path, up, lhash, mtime, size);
		};
		const takeRemote = async () => {
			await this.vault.write(l.path, remotePlain, isoToMs(meta.clientModified) || r.mtime);
			const st = await this.statOf(l.path);
			const lhash = dk ? await this.hashOf(remotePlain) : meta.contentHash;
			this.recordSynced(key, r.path, meta, lhash, st.mtime, st.size);
		};

		// A plugin's build artifacts are derived, not authored. Merging two
		// builds yields a bundle that never existed and still loads, and the
		// newest mtime belongs to whichever device installed LAST, which is
		// how an older build overwrites a newer one. So version decides, ahead
		// of merging, of the joining rule, and of any dialog: none of them
		// know which code is actually newer. The losing side is replaced
		// rather than kept beside the winner, because a half of a build is
		// rebuildable litter, not a copy worth saving.
		if (this.isPluginCode(l.path)) {
			const cmp = await this.pluginVersionCompare(l.path, prep, localBytes, remotePlain);
			if (cmp !== 0) {
				const where = pluginDirOf(l.path, this.host.configDir()) ?? l.path;
				const file = pathBase(l.path);
				if (cmp > 0) {
					const st = await this.statOf(l.path);
					await upOriginal(localBytes, localHash, st.mtime, st.size);
					stats.up++;
					this.host.log("info", `${where}: this device has the newer build, so it keeps ${file}.`);
				} else {
					await takeRemote();
					stats.down++;
					this.host.log("info", `${where}: the vault has the newer build, so ${file} was updated here.`);
				}
				return;
			}
		}

		// plugin settings always try the structural merge: keep-both is a poor
		// outcome for a data.json (two half-true settings files), so the text
		// auto-merge toggle does not gate it. Build artifacts never merge at
		// all: see above.
		if ((this.host.settings().autoMerge || this.isPluginData(l.path)) && !this.isPluginCode(l.path) && (prep.policy === "both" || prep.policy === "ask")) {
			if (await this.tryMerge(key, l, r, localBytes, remotePlain, localHash, remoteHash, meta, prep, stats, drifted, skipDrifted)) return;
		}

		// A TRUNCATION IS NOT AN EDIT.
		//
		// Reached only when a real three-way merge was impossible (no base
		// revision, or bytes that cannot be merged), which is exactly the state a
		// failed upload leaves behind: a stump on the remote that no journal entry
		// vouches for, carrying the same clientModified as the local file it came
		// from. Same mtime means the contest falls to a hash comparison, i.e. a
		// coin flip, and when the stump wins it takes the real name and files the
		// complete recording away as a conflict copy. That is what happened to a
		// 60 MB capture on 2026-07-29.
		//
		// If one side is a byte-prefix of the other, the shorter holds nothing the
		// longer lacks, so the longer is simply the whole file and there is no
		// second version worth keeping. Safe beyond media files for the same
		// reason: containment means no content is discarded. Deliberate deletions
		// are not caught by this, because those have a base revision and were
		// already settled by the merge above.
		const prefixOf = (short: ArrayBuffer, long: ArrayBuffer): boolean => {
			if (short.byteLength >= long.byteLength) return false;
			const a = new Uint8Array(short), b = new Uint8Array(long);
			for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
			return true;
		};
		if (prefixOf(remotePlain, localBytes)) {
			const st = await this.statOf(l.path);
			await upOriginal(localBytes, localHash, st.mtime, st.size);
			stats.up++;
			this.host.log("warn", `${l.path}: the copy on the remote was truncated (${r.size} of ${l.size} bytes) and has been replaced with the complete file from here.`);
			return;
		}
		if (prefixOf(localBytes, remotePlain)) {
			await takeRemote();
			stats.down++;
			this.host.log("warn", `${l.path}: the copy here was truncated (${l.size} of ${r.size} bytes) and has been replaced with the complete file from the remote.`);
			return;
		}
		let choice: ConflictChoice;
		if (prep.policy === "ask") {
			if (this.runConflictChoice) choice = this.runConflictChoice;
			else if (!interactive || !this.host.askConflict) choice = "both";
			else {
				const answer = await this.host.askConflict(l.path, l.mtime, l.size, r.mtime, r.size);
				choice = answer.choice;
				if (answer.applyAll) this.runConflictChoice = answer.choice;
				// the dialog can sit open for minutes; whatever was typed
				// meanwhile outranks the bytes read before it opened
				if (await drifted()) {
					skipDrifted();
					return;
				}
			}
		} else choice = prep.policy;

		if (choice === "local") {
			const st = await this.statOf(l.path);
			await upOriginal(localBytes, localHash, st.mtime, st.size);
			stats.up++;
			this.host.log("info", `Conflict on ${l.path}: kept this device's copy.`);
			return;
		}
		if (choice === "remote") {
			await takeRemote();
			stats.down++;
			this.host.log("info", `Conflict on ${l.path}: kept the Dropbox copy.`);
			return;
		}

		// keep both: the newer side keeps the name, the older lands beside it
		// under a deterministic conflict name, so every device converges on
		// the same two files without a second round of conflicts. The local
		// mtime quantizes to seconds first, matching the precision Dropbox
		// stores, so no two devices can round their way to opposite winners.
		const lq = Math.round(l.mtime / 1000) * 1000;
		// A joining device's config files were born minutes ago (a plugin
		// installed by hand writes its defaults at first launch), so "newer
		// wins" would hand factory defaults the fleet's filename. The vault
		// being joined is the truth for config; the local copy still survives
		// below as the conflict copy. Notes keep the normal contest.
		const seeded = prep.joining && this.configPath(l.path);
		const winner = seeded ? "remote" : conflictWinner(lq, localHash, r.mtime, remoteHash);
		if (seeded) this.host.log("info", `${l.path}: this device is new here, so the vault's copy keeps the name.`);
		const writeConflictCopy = async (plain: ArrayBuffer, hash: string, mtimeMs: number) => {
			const cpath = conflictName(l.path, mtimeMs, hash);
			const ckey = normKey(cpath);
			if (await this.vault.exists(cpath)) {
				// a crashed earlier run may have left it; bless it only if it
				// holds exactly the content this resolution would write
				const existing = await this.hashOf(await this.vault.read(cpath));
				if (existing !== hash) {
					this.host.log("warn", `${cpath} already exists with different content; leaving it alone (it will sync as its own file).`);
					return;
				}
			} else {
				await this.vault.write(cpath, plain, mtimeMs);
			}
			const cst = await this.statOf(cpath);
			const uk = this.fileKey(cpath, prep);
			const cstored = uk ? await encryptBytes(uk, plain) : plain;
			const cup = await this.remote.upload(this.rootedPath(cpath), cstored, { mode: "overwrite", clientModified: msToIsoSec(mtimeMs || Date.now()) });
			this.recordSynced(ckey, cpath, cup, hash, cst.mtime, cst.size);
		};
		if (winner === "local") {
			await writeConflictCopy(remotePlain, remoteHash, r.mtime);
			const st = await this.statOf(l.path);
			await upOriginal(localBytes, localHash, st.mtime, st.size);
		} else {
			await writeConflictCopy(localBytes, localHash, lq);
			await takeRemote();
		}
		stats.conflicts++;
		this.host.log("warn", `Conflict on ${l.path}: kept both copies.`);
	}
}

/** Sanity used by callers that need a typed error for simulated networks. */
export const simNetworkError = () => new DropboxError("Network unreachable.", 0, "network");
