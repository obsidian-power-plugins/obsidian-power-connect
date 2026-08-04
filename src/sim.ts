/* The simulation harness: the real SyncEngine running whole multi-device
 * fleets against an in-memory Dropbox and in-memory vaults, with crash
 * injection. No Obsidian, no network; tests.ts drives scenarios through it
 * and asserts convergence and the no-lost-words invariant.
 *
 * The fake Dropbox mirrors the semantics the engine depends on: revs, an
 * append-only delta log behind cursors, upload modes (add fails on existing,
 * update fails past the rev, overwrite always wins), delete preconditions,
 * first-created display-case preservation, and cursor invalidation. */

import {
	DropboxError,
	ListEntry,
	PconSettings,
	DEFAULT_SETTINGS,
	RemoteFileMeta,
	RunStats,
	contentHash,
	freshStats,
	normRel,
	stripDeletes,
} from "./core";
import { EngineHost, PrepResult, RemoteIO, SyncEngine, VaultIO } from "./engine";

/** Thrown by the fault injector to model the process dying mid-run. Once it
 *  fires, every further IO on that device also throws, so the run collapses
 *  quickly and the driver rebuilds the engine from its last saved journal. */
export class SimCrash extends Error {
	constructor() {
		super("simulated crash");
	}
}

const enc = new TextEncoder();
const dec = new TextDecoder();
export const bytesOf = (text: string): ArrayBuffer => enc.encode(text).buffer as ArrayBuffer;
export const textOf = (bytes: ArrayBuffer): string => dec.decode(bytes);

/** Deterministic PRNG so a failing fuzz round is reproducible from its seed. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/* ---------------- the fake Dropbox ---------------- */

interface SrvFile {
	display: string; // full path, first-created case preserved
	bytes: ArrayBuffer;
	rev: string;
	hash: string;
	clientModified: string;
}

export class FakeServer {
	files = new Map<string, SrvFile>(); // key: lowercased full path
	folders = new Set<string>();
	events: ListEntry[] = [];
	sessions = new Map<string, ArrayBuffer>(); // staged batch uploads
	history = new Map<string, ArrayBuffer>(); // rev id -> that revision's bytes
	private revCounter = 0;
	private epoch = 1;
	/** ops until a SimCrash fires; -1 = healthy. */
	private failIn = -1;
	private dead = false;
	/** path (lowercased) -> bytes to hand back on the next download, with the
	 *  metadata still describing the whole file. This is the real-world
	 *  failure a 200 cannot express: the stream ended early. */
	private shortReads = new Map<string, number>();
	/** path (lowercased) -> bytes the server actually KEEPS on the next upload
	 *  of that file, while the commit still reports success. The mirror image of
	 *  a short read, and the one that eats data: a short download can be
	 *  re-fetched, but a short upload replaces the only complete copy with a
	 *  stump that every other device then downloads faithfully. Seen in the
	 *  field 2026-07-29, recordings landing on Dropbox at exact MiB boundaries
	 *  (8.000, 52.000). */
	private shortWrites = new Map<string, { keep: number; times: number }>();
	ops = 0;

	failAfter(n: number) {
		this.failIn = n;
		this.dead = false;
	}

	/** Serve `bytes` of this file once, then behave normally again. */
	truncateNextRead(path: string, bytes: number) {
		this.shortReads.set(path.toLowerCase(), bytes);
	}

	/** Keep only `bytes` of this file on its next upload, once, while still
	 *  reporting the commit as a success. */
	truncateNextWrite(path: string, bytes: number) {
		this.truncateNextWrites(path, bytes, 1);
	}

	/** The same fault, `times` uploads in a row. More than one is what tells a
	 *  transient short write (the engine repairs it in the same run) from a
	 *  persistent one (it must refuse to record anything at all). */
	truncateNextWrites(path: string, bytes: number, times: number) {
		this.shortWrites.set(path.toLowerCase(), { keep: bytes, times });
	}

	heal() {
		this.failIn = -1;
		this.dead = false;
	}

	invalidateCursors() {
		this.epoch++;
	}

	private op() {
		this.ops++;
		if (this.dead) throw new SimCrash();
		if (this.failIn > 0 && --this.failIn === 0) {
			this.dead = true;
			throw new SimCrash();
		}
	}

	private meta(f: SrvFile): RemoteFileMeta {
		return { pathDisplay: f.display, rev: f.rev, size: f.bytes.byteLength, contentHash: f.hash, clientModified: f.clientModified };
	}

	private cursorOf(idx: number): string {
		return `${this.epoch}:${idx}`;
	}

	private pushFileEvent(f: SrvFile) {
		this.events.push({ tag: "file", meta: this.meta(f) });
	}

	/** Apply a pending short-write fault: what the server keeps, which may be
	 *  fewer bytes than the client sent. */
	keptBytes(path: string, bytes: ArrayBuffer): ArrayBuffer {
		const key = path.toLowerCase();
		const f = this.shortWrites.get(key);
		if (!f) return bytes;
		if (--f.times <= 0) this.shortWrites.delete(key);
		return bytes.slice(0, f.keep);
	}

	async putFile(path: string, bytes: ArrayBuffer, mode: "add" | "overwrite" | { update: string }, clientModified: string): Promise<RemoteFileMeta> {
		const key = path.toLowerCase();
		const existing = this.files.get(key);
		if (mode === "add" && existing) throw new DropboxError(`upload conflict on ${path}`, 409, "path/conflict/file");
		if (typeof mode === "object" && (!existing || existing.rev !== mode.update)) throw new DropboxError(`upload conflict on ${path}`, 409, "path/conflict/file");
		const f: SrvFile = {
			display: existing ? existing.display : path,
			bytes: bytes.slice(0),
			rev: `r${++this.revCounter}`,
			hash: await contentHash(bytes),
			clientModified,
		};
		this.files.set(key, f);
		this.history.set(f.rev, f.bytes.slice(0));
		this.pushFileEvent(f);
		return this.meta(f);
	}

	/** Delete a whole folder the way Dropbox reports it: one deleted entry. */
	deleteFolderCascade(path: string) {
		const key = path.toLowerCase();
		for (const [k] of [...this.files]) if (k.startsWith(key + "/")) this.files.delete(k);
		this.folders.delete(key);
		for (const k of [...this.folders]) if (k.startsWith(key + "/")) this.folders.delete(k);
		this.events.push({ tag: "deleted", pathDisplay: path });
	}

	remote(): RemoteIO {
		const srv = this;
		return {
			async ensureFolder(path: string) {
				srv.op();
				srv.folders.add(path.toLowerCase());
			},
			async listAll(root: string) {
				srv.op();
				const entries: ListEntry[] = [];
				for (const f of srv.files.values()) if (f.display.toLowerCase().startsWith(root.toLowerCase() + "/")) entries.push({ tag: "file", meta: srv.meta(f) });
				return { entries, cursor: srv.cursorOf(srv.events.length) };
			},
			async listContinue(cursor: string) {
				srv.op();
				const [ep, idx] = cursor.split(":").map(Number);
				if (ep !== srv.epoch) throw new DropboxError("cursor reset", 409, "reset");
				return { entries: srv.events.slice(idx), cursor: srv.cursorOf(srv.events.length) };
			},
			async listProbe(root: string, limit = 10) {
				srv.op();
				const entries: ListEntry[] = [];
				for (const f of srv.files.values()) {
					if (f.display.toLowerCase().startsWith(root.toLowerCase() + "/")) entries.push({ tag: "file", meta: srv.meta(f) });
					if (entries.length >= limit) break;
				}
				return entries;
			},
			async download(path: string) {
				srv.op();
				const key = path.toLowerCase();
				const f = srv.files.get(key);
				if (!f) throw new DropboxError(`not found: ${path}`, 409, "path/not_found");
				const short = srv.shortReads.get(key);
				if (short !== undefined) {
					// the metadata still describes the whole file: that is exactly
					// what makes a short body indistinguishable from success
					srv.shortReads.delete(key);
					return { bytes: f.bytes.slice(0, short), meta: srv.meta(f) };
				}
				return { bytes: f.bytes.slice(0), meta: srv.meta(f) };
			},
			async downloadRev(rev: string) {
				srv.op();
				const b = srv.history.get(rev);
				if (!b) throw new DropboxError(`not found: rev ${rev}`, 409, "path/not_found");
				return b.slice(0);
			},
			async upload(path, bytes, opts) {
				srv.op();
				return srv.putFile(path, srv.keptBytes(path, bytes), opts.mode, opts.clientModified);
			},
			async uploadStart(bytes: ArrayBuffer) {
				srv.op();
				const id = `sess-${srv.sessions.size}-${srv.ops}`;
				srv.sessions.set(id, bytes.slice(0));
				return id;
			},
			async uploadFinishBatch(entries) {
				srv.op();
				const out: ({ ok: true; meta: RemoteFileMeta } | { ok: false; error: string })[] = [];
				for (const e of entries) {
					const bytes = srv.sessions.get(e.sessionId);
					if (!bytes) {
						out.push({ ok: false, error: "unknown session" });
						continue;
					}
					srv.sessions.delete(e.sessionId);
					try {
						out.push({ ok: true, meta: await srv.putFile(e.path, srv.keptBytes(e.path, bytes), e.mode, e.clientModified) });
					} catch (err) {
						out.push({ ok: false, error: err instanceof Error ? err.message : String(err) });
					}
				}
				return out;
			},
			async move(from: string, to: string) {
				srv.op();
				const f = srv.files.get(from.toLowerCase());
				if (!f) throw new DropboxError(`not found: ${from}`, 409, "path/not_found");
				if (srv.files.get(to.toLowerCase())) throw new DropboxError(`move conflict on ${to}`, 409, "path/conflict/file");
				srv.files.delete(from.toLowerCase());
				const moved: SrvFile = { ...f, display: to, rev: `r${++srv.revCounter}` };
				srv.files.set(to.toLowerCase(), moved);
				srv.history.set(moved.rev, moved.bytes.slice(0));
				srv.events.push({ tag: "deleted", pathDisplay: f.display });
				srv.pushFileEvent(moved);
				return srv.meta(moved);
			},
			async del(path: string, parentRev?: string) {
				srv.op();
				const f = srv.files.get(path.toLowerCase());
				if (!f) return; // already gone is the goal state
				if (parentRev && f.rev !== parentRev) throw new DropboxError(`delete conflict on ${path}`, 409, "path/conflict/file");
				srv.files.delete(path.toLowerCase());
				srv.events.push({ tag: "deleted", pathDisplay: f.display });
			},
		};
	}
}

/* ---------------- the fake vault ---------------- */

interface VFile {
	path: string; // display case
	bytes: ArrayBuffer;
	mtime: number;
}

export class FakeVault {
	files = new Map<string, VFile>(); // key: lowercased path
	trashed: string[] = [];
	/** A deterministic second-granular clock, distinct per device so mtimes
	 *  differ across devices the way real machines' clocks do. */
	now: number;

	constructor(startMs = 1_800_000_000_000) {
		this.now = startMs;
	}

	tick(): number {
		this.now += 1000;
		return this.now;
	}

	/** A user action: write/overwrite a file at the current clock. */
	user(path: string, text: string): void {
		const rel = normRel(path);
		this.files.set(rel.toLowerCase(), { path: rel, bytes: bytesOf(text), mtime: this.tick() });
	}

	userDelete(path: string): void {
		this.files.delete(normRel(path).toLowerCase());
	}

	/** A user rename; returns the hint the plugin layer would have pushed. */
	userRename(from: string, to: string): { from: string; to: string } {
		const f = this.files.get(normRel(from).toLowerCase());
		if (f) {
			this.files.delete(normRel(from).toLowerCase());
			this.files.set(normRel(to).toLowerCase(), { ...f, path: normRel(to) });
		}
		return { from: normRel(from), to: normRel(to) };
	}

	text(path: string): string | null {
		const f = this.files.get(normRel(path).toLowerCase());
		return f ? textOf(f.bytes) : null;
	}

	io(): VaultIO {
		const v = this;
		return {
			listVisible() {
				return [...v.files.values()].filter((f) => !f.path.split("/").some((s) => s.startsWith("."))).map((f) => ({ path: f.path, mtime: f.mtime, size: f.bytes.byteLength }));
			},
			async listConfig(configDir: string, skipDirKey: string) {
				return [...v.files.values()]
					.filter((f) => f.path.toLowerCase().startsWith(configDir.toLowerCase() + "/"))
					.filter((f) => !f.path.toLowerCase().startsWith(skipDirKey + "/"))
					.map((f) => ({ path: f.path, mtime: f.mtime, size: f.bytes.byteLength }));
			},
			async read(rel: string) {
				const f = v.files.get(rel.toLowerCase());
				if (!f) throw new Error(`sim vault: no such file ${rel}`);
				return f.bytes.slice(0);
			},
			async write(rel: string, bytes: ArrayBuffer, mtimeMs: number) {
				const existing = v.files.get(rel.toLowerCase());
				v.files.set(rel.toLowerCase(), { path: existing ? existing.path : normRel(rel), bytes: bytes.slice(0), mtime: mtimeMs > 0 ? mtimeMs : v.tick() });
			},
			async stat(rel: string) {
				const f = v.files.get(rel.toLowerCase());
				return f ? { mtime: f.mtime, size: f.bytes.byteLength } : null;
			},
			async exists(rel: string) {
				return v.files.has(rel.toLowerCase());
			},
			async trash(rel: string) {
				const f = v.files.get(rel.toLowerCase());
				if (f) {
					v.trashed.push(f.path);
					v.files.delete(rel.toLowerCase());
				}
			},
		};
	}
}

/* ---------------- a simulated device ---------------- */

export interface SimRun {
	stats: RunStats;
	plan: PrepResult["plan"] | null;
	crashed: boolean;
	blocked: string | null;
	deferredDeletes: number;
}

export class SimDevice {
	vault: FakeVault;
	engine!: SyncEngine;
	settings: PconSettings;
	logs: string[] = [];
	/** How many journal checkpoints the engine has requested; the renderer
	 *  once died under an adopt storm's checkpoint flood, so tests bound it. */
	saves = 0;
	private journal: string | null = null;

	constructor(
		public name: string,
		private server: FakeServer,
		settings?: Partial<PconSettings>,
		clockStart?: number
	) {
		this.vault = new FakeVault(clockStart);
		this.settings = { ...DEFAULT_SETTINGS, appKey: "sim", refreshToken: "sim", remoteFolder: "SimVault", ...settings };
		this.makeEngine();
	}

	private host(): EngineHost {
		return {
			settings: () => this.settings,
			configDir: () => ".obsidian",
			pluginFolderName: () => "powerconnect",
			vaultName: () => "SimVault",
			deviceExcludeLines: () => [],
			isWindows: () => false,
			log: (level, text) => this.logs.push(`${level}: ${text}`),
			saveState: () => {
				this.saves++;
				this.journal = JSON.stringify(this.engine.journalObject());
			},
			settingsChanged: () => {},
		};
	}

	makeEngine() {
		this.engine = new SyncEngine(this.host(), this.vault.io(), this.server.remote());
		if (this.journal) this.engine.loadJournal(JSON.parse(this.journal));
	}

	/** Rebuild from the last persisted journal, as a process restart would. */
	reboot() {
		this.makeEngine();
	}

	/** Re-key existing files after the protected-folder set changes, the way the
	 *  plugin does: prepare (which adopts the new marker and lists files), then
	 *  migrate those folders, then a normal sync to converge everything else. */
	async migrateProtection(folderKeys: string[]): Promise<number> {
		const prep = await this.engine.prepare(() => {});
		const n = await this.engine.migrateProtectedFolders(folderKeys, prep.local);
		this.journal = JSON.stringify(this.engine.journalObject());
		return n;
	}

	rename(from: string, to: string) {
		const h = this.vault.userRename(from, to);
		this.engine.pushMoveHint(h.from, h.to);
	}

	/** One sync run, the way the plugin drives it: unattended runs strip
	 *  held deletions; a crash rebuilds the engine from the saved journal. */
	async sync(interactive = false): Promise<SimRun> {
		const stats = freshStats();
		this.engine.runConflictChoice = null;
		try {
			const prep = await this.engine.prepare(() => {});
			let plan = prep.plan;
			let deferredDeletes = 0;
			if (plan.holdDeletes && !interactive) {
				deferredDeletes = plan.deletesLocal + plan.deletesRemote;
				plan = stripDeletes(plan);
			}
			await this.engine.execute(prep, plan, stats, interactive, () => {});
			this.journal = JSON.stringify(this.engine.journalObject());
			return { stats, plan, crashed: false, blocked: null, deferredDeletes };
		} catch (e) {
			if (e instanceof SimCrash) {
				this.server.heal();
				this.reboot();
				return { stats, plan: null, crashed: true, blocked: null, deferredDeletes: 0 };
			}
			return { stats, plan: null, crashed: false, blocked: e instanceof Error ? e.message : String(e), deferredDeletes: 0 };
		}
	}
}

/* ---------------- convergence driving and invariants ---------------- */

const quiet = (r: SimRun): boolean =>
	!r.crashed &&
	!r.blocked &&
	r.deferredDeletes === 0 &&
	r.stats.up + r.stats.down + r.stats.adopts + r.stats.moves + r.stats.conflicts + r.stats.delLocal + r.stats.delRemote + r.stats.skipped + r.stats.errors.length === 0;

/** Sync every device round-robin until a full round changes nothing
 *  anywhere. Returns the number of rounds; -1 means it never settled. */
export async function converge(devices: SimDevice[], maxRounds = 10, interactive = false): Promise<number> {
	for (let round = 1; round <= maxRounds; round++) {
		let allQuiet = true;
		for (const d of devices) {
			const r = await d.sync(interactive);
			if (!quiet(r)) allQuiet = false;
		}
		if (allQuiet) return round;
	}
	return -1;
}

/** Every device holds the same visible files with the same bytes. Returns
 *  null when converged, else a human-readable difference. */
export function fleetDiff(devices: SimDevice[]): string | null {
	const snapshot = (d: SimDevice) => {
		const m = new Map<string, string>();
		for (const f of d.vault.files.values()) if (!f.path.split("/").some((s) => s.startsWith("."))) m.set(f.path.toLowerCase(), textOf(f.bytes));
		return m;
	};
	const first = snapshot(devices[0]);
	for (const d of devices.slice(1)) {
		const cur = snapshot(d);
		if (cur.size !== first.size) return `${devices[0].name} has ${first.size} files, ${d.name} has ${cur.size}`;
		for (const [k, v] of first) {
			if (!cur.has(k)) return `${d.name} is missing ${k}`;
			if (cur.get(k) !== v) return `${k} differs between ${devices[0].name} and ${d.name}`;
		}
	}
	return null;
}

/** The no-lost-words invariant: this content exists in SOME file on the
 *  device (the original path or a conflict copy). */
export function contentSurvives(device: SimDevice, text: string): boolean {
	for (const f of device.vault.files.values()) if (textOf(f.bytes) === text) return true;
	return false;
}
