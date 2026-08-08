import { AbstractInputSuggest, App, ButtonComponent, ItemView, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, type SettingDefinitionItem, type SettingDefinitionPage, type SettingDefinitionRender, SliderComponent, TFile, TFolder, WorkspaceLeaf, requestUrl, setIcon } from "obsidian";
import {
	Action,
	BaseEntry,
	ConflictChoice,
	DEFAULT_SETTINGS,
	DropboxError,
	IgnoreRule,
	MARKER_NAME,
	Marker,
	PCON_BUILD,
	PconSettings,
	Plan,
	RemoteEntry,
	RibbonItem,
	SyncBlocked,
	BatchCommit,
	backoffMs,
	buildIgnore,
	clientIdProblem,
	contentHash,
	fmtBytes,
	fmtClock,
	freshStats,
	isAuthDead,
	isIgnored,
	isNotFound,
	junkFile,
	mergeForSave,
	msToIsoSec,
	msg,
	normKey,
	looksLikeSetupCode,
	makeSetupCode,
	normRel,
	parseSetupCode,
	pathBase,
	pathParent,
	pkceChallenge,
	randB64url,
	ribbonEqual,
	sanitizeRemoteFolder,
	statsSummary,
	stripDeletes,
	weaveRibbon,
	windowsUnsafe,
	ShareMember,
	Subscription,
} from "./core";
/** How many received shares one automatic pass will fetch. Bounds the
 *  request burst for a vault subscribed to hundreds of them. */
const SHARE_PULLS_PER_TICK = 8;

import {
	OwnedShare,
	PublishIO,
	ResolveResult,
	ShareCode,
	ShareCodeOutdated,
	ShareIO,
	ShareManifest,
	ShareNotApproved,
	ShareState,
	ShareUnreadable,
	SHARE_ROOT,
	decodeManifest,
	directUrl,
	emptyShareState,
	fetchableUrl,
	generateMemberKeys,
	importShareKey,
	inviteFor,
	looksLikeJoinCode,
	looksLikeShareCode,
	makeJoinCode,
	makeShareKey,
	nextCheckDelay,
	parseJoinCode,
	parseShareCode,
	publishKeyring,
	publishShare,
	resolveMemberKey,
	publishSummary,
	pullShare,
	pullSummary,
	resolveShareFiles,
	shareSignatures,
} from "./share";
import { decryptBytes, deriveKey, looksEncrypted, makeCheck, makeSalt, verifyCheck } from "./crypto";
import { Dropbox, authUrl, exchangeCode, longpollChanges } from "./dropbox";
import { RemoteIO, SyncEngine, VaultIO } from "./engine";
import { OneDrive, onedriveDeviceCode, onedrivePollToken } from "./onedrive";
import { GDrive, gdriveSignIn } from "./gdrive";

function sleep(ms: number): Promise<void> {
	return new Promise((r) => window.setTimeout(r, ms));
}

/** Paint a button as destructive.
 *
 *  `setDestructive` arrived in 1.13 and this plugin's floor is 1.8.7, where
 *  calling it would throw, so the old `setWarning` has to stay reachable. The
 *  cast is the runtime check: the inline type carries no deprecation, which is
 *  also what keeps the fallback from being reported as one. */
function markDestructive(b: ButtonComponent): ButtonComponent {
	const btn = b as unknown as { setDestructive?: () => void; setWarning: () => void };
	if (btn.setDestructive) btn.setDestructive();
	else btn.setWarning();
	return b;
}

/** Keep a slider's value visible while it is dragged.
 *
 *  1.13 shows it inline and retired `setDynamicTooltip`, but on 1.8.7 the call
 *  is the only thing that shows the number at all, so it is reached through a
 *  cast rather than named: absent on new builds, harmless on old ones. */
function showSliderValue(sl: SliderComponent): SliderComponent {
	(sl as unknown as { setDynamicTooltip?: () => void }).setDynamicTooltip?.();
	return sl;
}

interface LogEntry {
	ts: number;
	level: "info" | "warn" | "error" | "debug";
	msg: string;
}

/** Extension groups behind the per-device file-type toggles. */
const TYPE_GROUPS: { name: string; exts: string[] }[] = [
	{ name: "Sync images", exts: ["bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "heic"] },
	{ name: "Sync audio", exts: ["mp3", "wav", "m4a", "3gp", "flac", "ogg", "oga", "opus"] },
	{ name: "Sync videos", exts: ["mp4", "webm", "ogv", "mov", "mkv", "avi"] },
	{ name: "Sync PDFs", exts: ["pdf"] },
];

/** Type-ahead over the vault's folders for the exclude picker. */
/** The slice of Obsidian's MenuItem that submenus expose. Typed here because
 *  setSubmenu is not in the published API types yet. */
interface MenuItemLike {
	setTitle(t: string): MenuItemLike;
	onClick(cb: () => void): MenuItemLike;
}

/**
 * The slice of Obsidian's left ribbon this plugin reads and writes.
 *
 * None of it is in the published API. The ribbon's contents are workspace
 * state, and the only supported way to change them is the user right-clicking
 * the ribbon, so a plugin that carries the ribbon between devices has to go
 * through the same object Obsidian's own settings page does. Everything here
 * is therefore optional and feature-detected at the call: on a build that has
 * moved any of it, ribbon syncing quietly does nothing and the rest of the
 * plugin neither knows nor cares.
 *
 * `load` sets each item's hidden flag from the map and then sorts the items
 * into the map's key order, which is why the order of a plain object matters
 * here and why RibbonItem is a list. `onChange(true)` re-renders and asks the
 * workspace to save, which is what puts the result in workspace.json.
 */
interface LeftRibbonLike {
	serialize?: () => { hiddenItems?: Record<string, boolean> } | null;
	load?: (data: { hiddenItems: Record<string, boolean> }) => void;
	onChange?: (save: boolean) => void;
}

class FolderSuggest extends AbstractInputSuggest<TFolder> {
	/** When true, keep the picked folder's path in the field instead of clearing
	 *  it; the exclude-a-folder flow clears, the protect-a-folder flow keeps. */
	fillOnPick = false;

	constructor(
		app: App,
		private input: HTMLInputElement,
		private onPick: (folder: TFolder) => void
	) {
		super(app, input);
	}

	getSuggestions(q: string): TFolder[] {
		const lq = q.toLowerCase();
		return this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && f.path !== "/")
			.filter((f) => f.path.toLowerCase().includes(lq))
			.slice(0, 50);
	}

	renderSuggestion(f: TFolder, el: HTMLElement) {
		el.setText(f.path);
	}

	selectSuggestion(f: TFolder) {
		// set the field first, THEN hand off: the base class does not touch the
		// value, so whichever we choose here is what the user sees
		this.input.value = this.fillOnPick ? f.path : "";
		this.onPick(f);
		this.close();
	}
}

/** Settings that must never leave this device via data.json. */
const SECRET_KEYS = ["refreshToken", "accessToken", "accessExpiry", "accountEmail", "e2ePassphrase", "odRefresh", "odAccess", "odExpiry", "odAccount", "gRefresh", "gAccess", "gExpiry", "gAccount"] as const;

export default class PowerConnectPlugin extends Plugin {
	settings: PconSettings = DEFAULT_SETTINGS;
	refreshSettingsTab: (() => void) | null = null;

	/* settings persistence (the data.json may itself be synced between
	 * devices by other means; only our changed keys may overwrite it) */
	private saveTimer: number | null = null;
	private saving = false;
	private baseline: PconSettings = DEFAULT_SETTINGS;
	/** data.json's size and mtime as we last saw them, so the desktop poll can
	 *  tell a file someone else wrote from one nobody touched, without reading
	 *  it; see watchDataFile(). */
	private dataStamp: string | null = null;
	/** The ribbon as this device last agreed it, so a later difference is the
	 *  user having changed it here. Null until the first apply has run, which
	 *  is what keeps the watcher from pushing a ribbon we have not yet had the
	 *  chance to take another device's version of. */
	private ribbonSnapshot: RibbonItem[] | null = null;

	/* journal file bookkeeping; the maps themselves live in the engine */
	lastSyncMs = 0;
	/** Exclude patterns that apply only on this device. Kept in Obsidian's
	 *  per-device localStorage, which nothing syncs. */
	deviceExcludes = "";
	/** This device's identity, from localStorage. The journal file is
	 *  stamped with its writer: if another sync system (Obsidian Sync,
	 *  iCloud) carries a journal here from a different machine, it is
	 *  recognized and discarded instead of trusted. */
	private deviceId = "";
	private stateWrite: Promise<void> = Promise.resolve();

	/* run orchestration */
	running = false;
	paused = false;
	private pendingRun = false;
	private failStreak = 0;
	private nextAutoOkMs = 0;
	private echo = new Map<string, number>();
	private igCache: IgnoreRule[] = [];
	private watchTimer: number | null = null;
	private autoTimer: number | null = null;
	private deleteHoldNoticed = false;
	private blockedNoticed = false;
	private lastResumeKick = 0;
	/** Longpoll generation: bumping it retires any loop still awaiting. */
	private lpGen = 0;
	private lpTimer: number | null = null;

	/* shares received from other people. The per-share journals live in
	 * state.json beside the sync journal: they describe what this device
	 * wrote, so they are device state, not settings. */
	shareStates: Record<string, ShareState> = {};
	/** Per-share "what did the vault look like when we last published" marks.
	 *  Device state, not settings: it describes work this device did. */
	sharePublishSig: Record<string, { latest: number; count: number }> = {};
	private pullingShares = false;
	private publishing = false;
	/** Set by the Shares view while it is open, so share changes redraw it. */
	sharesChanged: (() => void) | null = null;
	/** Shares whose withdraw guard has been shown once and is armed to go
	 *  ahead on a second, deliberate press of Publish. */
	private holdConfirmed = new Set<string>();
	lastSharePullMs = 0;

	/* ui */
	private statusEl: HTMLElement | null = null;
	logRing: LogEntry[] = [];
	logChanged: (() => void) | null = null;

	dropbox: Dropbox = new Dropbox({
		appKey: () => this.settings.appKey.trim(),
		refreshToken: () => this.settings.refreshToken,
		access: () => ({ token: this.settings.accessToken, expiry: this.settings.accessExpiry }),
		saveAccess: (token, expiry) => {
			this.settings.accessToken = token;
			this.settings.accessExpiry = expiry;
			this.queueSave();
		},
		log: (m) => this.log("debug", m),
	});

	onedrive: OneDrive = new OneDrive({
		clientId: () => this.settings.odClientId.trim(),
		refreshToken: () => this.settings.odRefresh,
		access: () => ({ token: this.settings.odAccess, expiry: this.settings.odExpiry }),
		saveTokens: (refresh, access, expiry) => {
			this.settings.odRefresh = refresh;
			this.settings.odAccess = access;
			this.settings.odExpiry = expiry;
			this.queueSave();
		},
		log: (m) => this.log("debug", m),
	});

	gdrive: GDrive = new GDrive({
		clientId: () => this.settings.gClientId.trim(),
		clientSecret: () => this.settings.gClientSecret.trim(),
		refreshToken: () => this.settings.gRefresh,
		access: () => ({ token: this.settings.gAccess, expiry: this.settings.gExpiry }),
		saveTokens: (refresh, access, expiry) => {
			this.settings.gRefresh = refresh;
			this.settings.gAccess = access;
			this.settings.gExpiry = expiry;
			this.queueSave();
		},
		log: (m) => this.log("debug", m),
	});

	/** The active provider. Everything above the RemoteIO seam is
	 *  provider-agnostic; this getter is the one switch. */
	get remote(): Dropbox | OneDrive | GDrive {
		return this.settings.provider === "onedrive" ? this.onedrive : this.settings.provider === "gdrive" ? this.gdrive : this.dropbox;
	}

	/** Per-provider display email for the Connection row. */
	accountLabel(): string {
		const s = this.settings;
		return s.provider === "onedrive" ? s.odAccount : s.provider === "gdrive" ? s.gAccount : s.accountEmail;
	}

	/** Sign this device out of the active provider. */
	clearProviderAuth() {
		const s = this.settings;
		if (s.provider === "onedrive") {
			s.odRefresh = "";
			s.odAccess = "";
			s.odExpiry = 0;
			s.odAccount = "";
		} else if (s.provider === "gdrive") {
			s.gRefresh = "";
			s.gAccess = "";
			s.gExpiry = 0;
			s.gAccount = "";
		} else {
			s.refreshToken = "";
			s.accessToken = "";
			s.accessExpiry = 0;
			s.accountEmail = "";
		}
		this.queueSave();
	}

	/** The engine, wired to Obsidian on one side and the active provider on
	 *  the other; the forwarder keeps the engine honest about which optional
	 *  capabilities the current provider actually has. The same class runs
	 *  against in-memory fakes in the simulation suite. */
	engine: SyncEngine = new SyncEngine(
		{
			settings: () => this.settings,
			configDir: () => this.app.vault.configDir,
			pluginFolderName: () => this.pluginDirName(),
			vaultName: () => this.app.vault.getName(),
			deviceExcludeLines: () => this.deviceExcludes.split(/\r?\n/),
			isWindows: () => Platform.isWin,
			log: (level, text) => this.log(level, text),
			saveState: () => this.saveState(),
			settingsChanged: () => this.queueSave(),
			askConflict: (path, lMtime, lSize, rMtime, rSize) => new ConflictModal(this.app, path, lMtime, lSize, rMtime, rSize).ask(),
		},
		new ObsidianVaultIO(this),
		((plugin: PowerConnectPlugin): RemoteIO => ({
			ensureFolder: (p) => plugin.remote.ensureFolder(p),
			listAll: (r) => plugin.remote.listAll(r),
			listContinue: (c) => plugin.remote.listContinue(c),
			listProbe: (r, l) => plugin.remote.listProbe(r, l),
			download: (p) => plugin.remote.download(p),
			upload: (p, b, o) => plugin.remote.upload(p, b, o),
			move: (f, t) => plugin.remote.move(f, t),
			del: (p, r) => plugin.remote.del(p, r),
			get uploadStart() {
				const t = plugin.remote as RemoteIO;
				return t.uploadStart ? (b: ArrayBuffer) => t.uploadStart!(b) : undefined;
			},
			get uploadFinishBatch() {
				const t = plugin.remote as RemoteIO;
				return t.uploadFinishBatch ? (e: BatchCommit[]) => t.uploadFinishBatch!(e) : undefined;
			},
			get downloadRev() {
				const t = plugin.remote as RemoteIO;
				return t.downloadRev ? (rev: string, path?: string) => t.downloadRev!(rev, path) : undefined;
			},
			get hashOf() {
				const t = plugin.remote as RemoteIO;
				return t.hashOf ? (b: ArrayBuffer) => t.hashOf!(b) : undefined;
			},
		}))(this)
	);

	async onload() {
		const file = (await this.loadData()) as Partial<PconSettings> | null;
		const onDisk = Object.assign({}, DEFAULT_SETTINGS, file);
		// a change made in the last moment before a reload, which the app tore
		// the renderer down too fast for the write to finish; see takePending()
		const pending = this.takePending(this.stripSecrets(file));
		this.adoptSettings(pending ?? onDisk);
		const f = file;
		const fileHasSecrets = !!f && SECRET_KEYS.some((k) => f[k] != null && f[k] !== "" && f[k] !== 0);
		// upgrade path: secrets found in data.json move into localStorage once,
		// then the file is rewritten without them
		if (fileHasSecrets && this.app.loadLocalStorage("pcon-secrets") == null) this.stashSecrets();
		this.overlaySecrets(this.settings);
		// baseline is the DISK state, not what we just adopted, so a replayed
		// change reads as ours and actually reaches the file this time
		this.overlaySecrets(onDisk);
		this.baseline = structuredClone(onDisk);
		if (fileHasSecrets || pending) this.queueSave();
		await this.loadState();
		this.igCache = buildIgnore(this.settings, this.app.vault.configDir, this.pluginDirName(), this.deviceExcludes.split(/\r?\n/));
		this.log("debug", `Power Connect ${this.manifest.version} (build ${PCON_BUILD})`);

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("pcon-status");
		this.statusEl.onClickEvent(() => {
			if (this.subscriberOnly) void this.pullShares("status bar", true);
			else if (!this.remote.connected) new SetupWizard(this.app, this).open();
			else void this.syncNow("status bar", true);
		});
		this.refreshIdleStatus();

		this.addRibbonIcon("refresh-cw", "Power Connect: sync now", () => void this.syncNow("ribbon", true));

		this.addCommand({ id: "sync-now", icon: "refresh-cw", name: "Sync now", callback: () => void this.syncNow("command", true) });
		this.addCommand({ id: "preview", icon: "eye", name: "Preview sync (dry run)", callback: () => void this.previewSync() });
		this.addCommand({ id: "connect", icon: "settings", name: "Set up syncing", callback: () => new SetupWizard(this.app, this).open() });
		this.addCommand({ id: "show-log", icon: "file-text", name: "Show sync log", callback: () => new LogModal(this.app, this).open() });
		this.registerView(VIEW_TYPE_SHARES, (leaf) => new SharesView(leaf, this));
		this.addRibbonIcon("share-2", "Power Connect: shares", () => void this.openSharesView());
		this.addCommand({ id: "open-shares", icon: "share-2", name: "Open shares", callback: () => void this.openSharesView() });
		this.addCommand({ id: "receive-share", icon: "download", name: "Receive a share (paste an invite code)", callback: () => new ReceiveShareModal(this.app, this).open() });
		this.addCommand({ id: "pull-shares", icon: "refresh-cw", name: "Update shares now", callback: () => void this.pullShares("command", true) });
		// phones have no status bar; this command is the glanceable substitute
		this.addCommand({
			id: "status", icon: "activity",
			name: "Show sync status",
			callback: () => {
				const stats = this.engine.syncedStats();
				const parts = [
					this.running ? "A sync is running now." : this.lastSyncMs ? `Last synced ${new Date(this.lastSyncMs).toLocaleString()}.` : "No sync has completed on this device yet.",
					`${stats.files.toLocaleString()} file(s) synced.`,
				];
				const held = this.engine.heldBackCount();
				if (held) parts.push(`${held} plugin settings file(s) held back until the passphrase is entered in setup.`);
				if (this.paused) parts.push("Sync is paused on this device.");
				else if (!this.running && Date.now() < this.nextAutoOkMs)
					parts.push(`Automatic sync is waiting ${Math.ceil((this.nextAutoOkMs - Date.now()) / 1000)}s after a failure; a manual sync runs right away.`);
				new Notice(`Power Connect: ${parts.join(" ")}`, 12000);
			},
		});
		this.addCommand({
			id: "pause", icon: "pause",
			name: "Pause or resume automatic sync",
			callback: () => {
				this.setPaused(!this.paused);
				new Notice(this.paused ? "Power Connect: sync paused on this device." : "Power Connect: sync resumed.");
			},
		});
		this.addCommand({
			id: "rescan", icon: "refresh-ccw",
			name: "Full rescan and sync",
			callback: () => {
				this.engine.markRescan();
				void this.syncNow("rescan", true);
			},
		});

		// sharing starts where the notes are, not in a settings tab
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!this.canPublish) return;
				const isFolder = file instanceof TFolder;
				if (!isFolder && !(file instanceof TFile)) return;
				const path = normRel(file.path);
				if (path.startsWith(this.app.vault.configDir)) return;

				menu.addItem((i) =>
					i
						.setTitle(isFolder ? "Share this folder with someone" : "Share this note with someone")
						.setIcon("share-2")
						.onClick(() => new CreateShareModal(this.app, this, isFolder ? { homePath: path, attached: [] } : { homePath: "", attached: [path] }).open())
				);

				// adding to a share that already exists is the common case
				// once someone shares more than once
				const targets = this.settings.shares.filter((s) => !(s.homePath && path.startsWith(s.homePath + "/")) && s.homePath !== path);
				if (!isFolder && targets.length) {
					menu.addItem((i) => {
						i.setTitle("Add this note to a share").setIcon("plus");
						const sub = (i as unknown as { setSubmenu(): { addItem(cb: (x: MenuItemLike) => void): void } }).setSubmenu();
						for (const share of targets) {
							sub.addItem((x) =>
								x.setTitle(share.name).onClick(() => {
									if (!share.attached.includes(path)) share.attached.push(path);
									void this.persistSettings().then(() => this.publishShareNow(share.id, true));
								})
							);
						}
					});
				}
			})
		);

		this.registerEvent(this.app.vault.on("create", (f) => this.onLocalTouch(f.path)));
		this.registerEvent(this.app.vault.on("modify", (f) => this.onLocalTouch(f.path)));
		this.registerEvent(this.app.vault.on("delete", (f) => this.onLocalTouch(f.path)));
		this.registerEvent(
			this.app.vault.on("rename", (f, oldPath) => {
				if (this.suppressed(f.path) || this.suppressed(oldPath)) return;
				if (f instanceof TFile) this.engine.pushMoveHint(oldPath, f.path);
				else if (f instanceof TFolder) {
					const newPrefix = normRel(f.path) + "/";
					for (const child of this.app.vault.getFiles()) {
						const rel = normRel(child.path);
						if (rel.startsWith(newPrefix)) this.engine.pushMoveHint(normRel(oldPath) + "/" + rel.slice(newPrefix.length), rel);
					}
				}
				this.onLocalTouch(oldPath);
				this.onLocalTouch(f.path);
			})
		);

		// coming back to Obsidian is the moment fresh notes matter most, and
		// on iOS it is the only moment anything can run at all
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible") this.maybeResumeSync();
			// leaving the app freezes the webview within moments on iOS; a
			// full sync (listing, scanning) cannot finish in that window, but
			// a bare upload of the files just touched can. Anything unusual
			// defers to the full sync at the next open.
			else if (Platform.isMobileApp && this.dirty.size && this.remote.connected && !this.paused && !this.running && this.lastSyncMs) {
				if (this.watchTimer != null) {
					window.clearTimeout(this.watchTimer);
					this.watchTimer = null;
				}
				void this.engine.flushPaths([...this.dirty]).then((flushed) => {
					for (const rel of flushed) this.dirty.delete(rel);
				});
			}
		});
		this.registerDomEvent(window, "focus", () => this.maybeResumeSync());
		// connectivity returning is as good a moment as the app returning:
		// without this, a failure while offline backs off future syncs even
		// though the network is back
		this.registerDomEvent(window, "online", () => this.maybeResumeSync());
		this.registerDomEvent(window, "pagehide", () => {
			if (Platform.isMobileApp && this.dirty.size && this.remote.connected && !this.paused && !this.running && this.lastSyncMs) {
				void this.engine.flushPaths([...this.dirty]).then((flushed) => {
					for (const rel of flushed) this.dirty.delete(rel);
				});
			}
		});

		this.addSettingTab(new PconSettingTab(this.app, this));
		this.watchDataFile();
		this.watchRibbon();
		this.scheduleAuto();
		this.app.workspace.onLayoutReady(() => {
			// every plugin has registered its ribbon icons by now, so this is the
			// first moment the ribbon can be read as the whole thing it is
			this.applyRibbon();
			// first run (or a new device that received settings without its own
			// sign-in): open the guided setup once; the status bar and settings
			// keep an entry point after it is dismissed
			// a vault that only receives shares has finished its setup; the
			// wizard would be nagging it to solve a problem it does not have
			if (!this.remote.connected && !this.hasShares && this.app.loadLocalStorage("pcon-setup-dismissed") !== "1") {
				new SetupWizard(this.app, this).open();
			}
			if (this.settings.syncOnStart && this.remote.connected) {
				window.setTimeout(() => void this.syncNow("startup", false), 4000);
			}
			if (this.settings.syncOnStart && this.hasShares) {
				// after the vault sync, so a share landing in a synced folder
				// does not race the run that is already scanning it
				window.setTimeout(() => void this.pullShares("startup", false), this.remote.connected ? 20_000 : 5000);
			}
			this.startLongpoll();
			this.refreshShareMarks();
		});
	}

	onunload() {
		this.lpGen++;
		if (this.lpTimer != null) window.clearTimeout(this.lpTimer);
		if (this.saveTimer != null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
			this.stashPending();
			void this.persistSettings();
		}
		if (this.watchTimer != null) window.clearTimeout(this.watchTimer);
		if (this.autoTimer != null) window.clearInterval(this.autoTimer);
	}

	/** A debounced nudge when Obsidian comes back into view: skip when a
	 *  sync just ran or a kick is already pending, then catch up. */
	private maybeResumeSync() {
		if (!this.settings.syncOnResume || !this.remote.connected || this.paused || this.running) return;
		const now = Date.now();
		if (now - this.lastResumeKick < 15_000 || now - this.lastSyncMs < 20_000) return;
		this.lastResumeKick = now;
		// a fresh foreground is a fresh network context: forget any backoff
		// the last session earned, and on phones give the radio a moment
		// before the first request instead of racing it into a failure that
		// re-arms the backoff
		this.failStreak = 0;
		this.nextAutoOkMs = 0;
		window.setTimeout(() => void this.syncNow("resume", false), Platform.isMobileApp ? 2500 : 800);
	}

	/* ---------------- live sync (desktop longpoll) ---------------- */

	/** (Re)start the watch, debounced: settings fire per keystroke, and each
	 *  restart must retire the old loop rather than pile a new one on top.
	 *  A retired loop exits at its next generation check; only the newest
	 *  generation ever acts. */
	startLongpoll() {
		if (!Platform.isDesktopApp) return;
		if (this.settings.provider !== "dropbox") return; // longpoll is a Dropbox capability; other providers ride the schedule
		if (this.lpTimer != null) window.clearTimeout(this.lpTimer);
		this.lpTimer = window.setTimeout(() => {
			this.lpTimer = null;
			const gen = ++this.lpGen;
			if (!this.settings.liveSync || !this.remote.connected) return;
			void this.longpollLoop(gen);
		}, 1000);
	}

	/** Hold Dropbox's notify endpoint open; when the folder changes, sync.
	 *  The cursor is the delta cursor the engine already keeps, so a wake-up
	 *  costs one continue call plus whatever actually changed. */
	private async longpollLoop(gen: number) {
		while (gen === this.lpGen && this.settings.liveSync && this.remote.connected && !this.paused) {
			if (!this.engine.cursor || this.running) {
				await sleep(5000);
				continue;
			}
			let res: { changes: boolean; backoff?: number };
			try {
				res = await longpollChanges(this.engine.cursor, 60);
			} catch {
				// offline or a reset cursor: the next real sync sorts the
				// cursor out; just do not hammer the endpoint
				await sleep(30_000);
				continue;
			}
			if (gen !== this.lpGen) break;
			if (res.backoff) await sleep(res.backoff * 1000);
			if (res.changes) {
				this.log("debug", "Dropbox reported changes; live sync run.");
				await this.syncNow("live", false);
			}
		}
	}

	/* ---------------- settings persistence ---------------- */

	queueSave() {
		this.stashSecrets();
		if (this.saveTimer != null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.persistSettings();
		}, 400);
	}

	/* Dropbox tokens, the account email, and the passphrase are per-device:
	 * they live in Obsidian's per-vault localStorage, never in data.json.
	 * data.json travels between devices (Obsidian Sync and friends), and a
	 * traveling copy must neither leak credentials nor overwrite this
	 * device's sign-in with another device's stale state. */

	private stashSecrets() {
		const out: Record<string, unknown> = {};
		const s = this.settings as unknown as Record<string, unknown>;
		for (const k of SECRET_KEYS) out[k] = s[k];
		this.app.saveLocalStorage("pcon-secrets", JSON.stringify(out));
	}

	private overlaySecrets(target: PconSettings) {
		const raw = this.app.loadLocalStorage("pcon-secrets") as string | null;
		if (!raw) return;
		try {
			const sec = JSON.parse(raw) as Record<string, unknown>;
			const t = target as unknown as Record<string, unknown>;
			for (const k of SECRET_KEYS) if (k in sec) t[k] = sec[k];
		} catch {
			/* unreadable stash; the connect flow can recreate it */
		}
	}

	private redactForFile(s: PconSettings): PconSettings {
		const out = structuredClone(s) as unknown as Record<string, unknown>;
		for (const k of SECRET_KEYS) out[k] = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k];
		return out as unknown as PconSettings;
	}

	private stripSecrets(disk: Partial<PconSettings> | null): Partial<PconSettings> | null {
		if (!disk) return null;
		const d = { ...disk } as Record<string, unknown>;
		for (const k of SECRET_KEYS) delete d[k];
		return d;
	}

	/** The one write path for settings; `saving` plus `saveTimer` cover the
	 *  whole change-to-disk span so the data.json watcher can tell our own
	 *  write from an external one. */
	/**
	 * Take on new settings CONTENTS without swapping the object.
	 *
	 * The settings tab and the setup wizard capture this object once (`const s
	 * = plugin.settings`, then `s.key = v`), so replacing it strands every one
	 * of those writes on an orphan and the setting silently stops sticking.
	 * Every assignment to this.settings goes through here for that reason. The
	 * field starts life as DEFAULT_SETTINGS itself, which must never be
	 * mutated.
	 */
	private adoptSettings(next: PconSettings) {
		if (this.settings && this.settings !== DEFAULT_SETTINGS) Object.assign(this.settings, next);
		else this.settings = { ...next };
	}

	async persistSettings() {
		this.saving = true;
		try {
			const disk = this.stripSecrets((await this.loadData()) as Partial<PconSettings> | null);
			this.adoptSettings(mergeForSave(this.settings, this.baseline, disk));
			await this.saveData(this.redactForFile(this.settings));
			this.baseline = structuredClone(this.settings);
		} finally {
			this.saving = false;
		}
	}

	/**
	 * Unload-time flush: an app reload (Ctrl+R) tears the renderer down before a
	 * pending async write can finish, so the last chance to save must not await.
	 *
	 * Nothing that writes a file is synchronous here, so the settings go where
	 * this device's secrets already go: localStorage, which does answer
	 * immediately. The async save is still started, and usually lands (a plugin
	 * being disabled is not a renderer going away); this is the copy that
	 * survives when it does not, and the next load replays it. Both halves are
	 * redacted, so the secrets stay in the one stash that owns them and a
	 * redacted key can never read as a change against its own baseline.
	 */
	private stashPending() {
		try {
			const pending = { settings: this.redactForFile(this.settings), baseline: this.redactForFile(this.baseline) };
			this.app.saveLocalStorage("pcon-pending", JSON.stringify(pending));
		} catch {
			/* nothing to be done at unload; the async save is already in flight */
		}
	}

	/**
	 * The other half: the stash, merged over whatever the file says now, and
	 * cleared either way so a replay happens once.
	 *
	 * It is merged rather than applied. data.json may have moved on since the
	 * reload (another device syncing its own change in), and only the keys this
	 * device actually changed have any claim on it: the same rule persistSettings
	 * follows, with the stashed baseline standing in for the live one.
	 */
	private takePending(disk: Partial<PconSettings> | null): PconSettings | null {
		const raw = this.app.loadLocalStorage("pcon-pending") as string | null;
		if (!raw) return null;
		this.app.saveLocalStorage("pcon-pending", null);
		try {
			const p = JSON.parse(raw) as { settings?: PconSettings; baseline?: PconSettings };
			if (!p.settings || !p.baseline) return null;
			const ours = Object.assign({}, DEFAULT_SETTINGS, p.settings);
			const was = Object.assign({}, DEFAULT_SETTINGS, p.baseline);
			if (JSON.stringify(ours) === JSON.stringify(was)) return null; // nothing was actually in flight
			return mergeForSave(ours, was, disk);
		} catch {
			return null; // unreadable stash: the file is still the truth
		}
	}

	private busySaving(): boolean {
		return this.saveTimer != null || this.saving;
	}

	async onExternalSettingsChange() {
		await this.adoptExternalData();
	}

	private dataPath(): string {
		return `${this.app.vault.configDir}/plugins/${this.manifest.id}/data.json`;
	}

	/**
	 * Desktop: notice that someone else rewrote data.json, so external edits are
	 * adopted while you are looking rather than at the next restart.
	 *
	 * onExternalSettingsChange covers Obsidian's own Sync. A folder sync landing
	 * another device's settings (including this plugin's own) is a plainer event
	 * than that, and can arrive unannounced, so the file's own size and mtime are
	 * the signal. Asking the vault adapter for them keeps this inside the vault:
	 * it stats one known file under the config folder, never reaches for a path
	 * of its own, and reads nothing until the stamp actually moves. Our own saves
	 * move it too, and cost one wasted read that adoptExternalData recognizes as
	 * its own echo and drops.
	 */
	private watchDataFile() {
		if (!Platform.isDesktopApp) return;
		this.registerInterval(window.setInterval(() => void this.checkDataFile(), 5000));
		// coming back to the window is when another device's change is most
		// likely to be sitting there waiting, so look straight away
		this.registerDomEvent(window, "focus", () => void this.checkDataFile());
	}

	/* ---------------- ribbon ---------------- */

	/** Whether the ribbon is ours to carry at all. It rides in this plugin's own
	 *  data.json, which syncs whatever the config setting says, so the gate is
	 *  explicit: a vault that holds its Obsidian settings back means the ribbon
	 *  too. */
	private ribbonSyncOn(): boolean {
		return this.settings.syncConfig && this.settings.syncRibbon;
	}

	/** Desktop and mobile each keep their own. Obsidian splits them already,
	 *  between workspace.json and workspace-mobile.json, and for the same
	 *  reason: a phone's ribbon is not a laptop's with fewer icons. */
	private ribbonKey(): "ribbon" | "ribbonMobile" {
		return Platform.isMobile ? "ribbonMobile" : "ribbon";
	}

	private leftRibbon(): LeftRibbonLike | null {
		return (this.app.workspace as unknown as { leftRibbon?: LeftRibbonLike }).leftRibbon ?? null;
	}

	/** The ribbon Obsidian is showing right now, or null on a build that keeps
	 *  it somewhere this cannot see. */
	private readRibbon(): RibbonItem[] | null {
		const r = this.leftRibbon();
		if (typeof r?.serialize !== "function") return null;
		let map: Record<string, boolean> | null | undefined;
		try {
			map = r.serialize()?.hiddenItems;
		} catch {
			return null;
		}
		if (!map || typeof map !== "object") return null;
		return Object.keys(map).map((id) => ({ id, hidden: !!map[id] }));
	}

	/** Put a ribbon on screen and into workspace.json. False when this build
	 *  will not take it, which is the signal to leave the whole feature alone. */
	private writeRibbon(items: RibbonItem[]): boolean {
		const r = this.leftRibbon();
		if (typeof r?.load !== "function") return false;
		const hiddenItems: Record<string, boolean> = {};
		for (const item of items) hiddenItems[item.id] = item.hidden;
		try {
			r.load({ hiddenItems });
			// load() renders but does not save; this is what reaches the file
			r.onChange?.(true);
		} catch {
			return false;
		}
		return true;
	}

	/**
	 * Take the shared ribbon onto this device, or set it from here the first time.
	 *
	 * Runs once the layout is ready, because every plugin has registered its
	 * icons by then and a ribbon read before that is missing half of itself, and
	 * again whenever another device's settings land. Idempotent: when the two
	 * sides already agree it writes nothing, which is what lets the watcher below
	 * treat any difference as the user's own doing.
	 *
	 * Icons this device does not have (a plugin installed only on the other one)
	 * stay in the shared copy but are dropped from what is handed to Obsidian, so
	 * a device missing a plugin does not rewrite its workspace on every pass.
	 */
	applyRibbon() {
		if (!this.ribbonSyncOn() || !this.app.workspace.layoutReady) return;
		const local = this.readRibbon();
		if (!local) return;
		const shared = this.settings[this.ribbonKey()];
		if (!shared.length) {
			// nothing has ever been shared: this device's ribbon is the first word
			this.settings[this.ribbonKey()] = local;
			this.ribbonSnapshot = local;
			this.queueSave();
			return;
		}
		const here = new Set(local.map((i) => i.id));
		const target = weaveRibbon(shared, local).filter((i) => here.has(i.id));
		if (ribbonEqual(target, local)) {
			this.ribbonSnapshot = local;
			return;
		}
		if (!this.writeRibbon(target)) return; // snapshot stays null; the watcher stays off
		this.ribbonSnapshot = target;
		this.log("info", "Ribbon updated from another device.");
	}

	/**
	 * Notice the ribbon being changed on this device, and share it.
	 *
	 * Obsidian fires no event for it. Hiding an icon or dragging one calls the
	 * ribbon's own onChange, which re-renders and asks the workspace to save, and
	 * nothing along that path is observable from a plugin. So the ribbon is
	 * compared against the last one this device agreed on, on the same cheap poll
	 * the data.json watcher already runs: it is a couple of dozen ids and two
	 * string compares each.
	 */
	private captureRibbon() {
		if (!this.ribbonSyncOn() || !this.ribbonSnapshot) return;
		const local = this.readRibbon();
		if (!local || ribbonEqual(local, this.ribbonSnapshot)) return;
		this.ribbonSnapshot = local;
		// icons only the other devices have keep their place rather than being
		// dropped from the shared copy by a device that never had them
		this.settings[this.ribbonKey()] = weaveRibbon(local, this.settings[this.ribbonKey()]);
		this.queueSave();
		this.log("debug", "Ribbon changed on this device; sharing it.");
	}

	private watchRibbon() {
		this.registerInterval(window.setInterval(() => this.captureRibbon(), 5000));
	}

	private async checkDataFile() {
		if (this.busySaving()) return; // our own write is on its way; let it land
		try {
			const st = await this.app.vault.adapter.stat(this.dataPath());
			if (!st) return;
			const stamp = `${st.mtime}:${st.size}`;
			const first = this.dataStamp === null;
			if (stamp === this.dataStamp) return;
			this.dataStamp = stamp;
			if (!first) await this.adoptExternalData();
		} catch {
			/* unreadable this moment (a sync mid-swap); the next tick tries again */
		}
	}

	private async adoptExternalData() {
		if (this.busySaving()) return;
		const before = JSON.stringify(this.settings);
		const raw = (await this.loadData()) as Partial<PconSettings> | null;
		if (!raw) return;
		if (this.busySaving() || JSON.stringify(this.settings) !== before) return;
		const next = Object.assign({}, DEFAULT_SETTINGS, raw);
		this.overlaySecrets(next);
		if (JSON.stringify(next) === JSON.stringify(this.settings)) return;
		this.adoptSettings(next);
		this.baseline = structuredClone(next);
		this.applySettings();
		this.refreshSettingsTab?.();
		this.log("info", "Settings reloaded: data.json changed outside this app (synced from another device, most likely).");
	}

	/** Re-derive everything that hangs off settings. Cheap on purpose. */
	applySettings() {
		this.igCache = buildIgnore(this.settings, this.app.vault.configDir, this.pluginDirName(), this.deviceExcludes.split(/\r?\n/));
		this.engine.markerDirty();
		this.blockedNoticed = false;
		this.scheduleAuto();
		this.startLongpoll();
		this.refreshIdleStatus();
		// settings that just arrived from another device may carry its ribbon
		this.applyRibbon();
	}

	/* ---------------- journal ---------------- */

	private stateFile(): string {
		return `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/state.json`;
	}

	private ensureDeviceId() {
		const stored = this.app.loadLocalStorage("pcon-device-id") as string | null;
		if (stored && typeof stored === "string") this.deviceId = stored;
		else {
			this.deviceId = randB64url(9);
			this.app.saveLocalStorage("pcon-device-id", this.deviceId);
		}
	}

	private async loadState() {
		this.ensureDeviceId();
		this.deviceExcludes = (this.app.loadLocalStorage("pcon-device-excludes") as string | null) ?? "";
		this.paused = (this.app.loadLocalStorage("pcon-paused") as string | null) === "1";
		try {
			// the tmp file is the fallback: a crash between the atomic write's
			// remove and rename leaves only it behind, still fully valid
			let raw: string | null = null;
			for (const f of [this.stateFile(), this.stateFile() + ".tmp"]) {
				try {
					const text = await this.app.vault.adapter.read(f);
					JSON.parse(text);
					raw = text;
					break;
				} catch {
					/* missing or truncated; try the next */
				}
			}
			if (raw == null) throw new Error("no readable journal");
			const s = JSON.parse(raw) as {
				cursor?: string;
				lastSyncMs?: number;
				rootKey?: string;
				writerId?: string;
				deviceExcludes?: string;
				remote?: Record<string, RemoteEntry>;
				base?: Record<string, BaseEntry>;
				shares?: Record<string, ShareState>;
				publishSig?: Record<string, { latest: number; count: number }>;
			};
			if (s.writerId && s.writerId !== this.deviceId) {
				// another device's journal, carried here by some other sync
				// system. Its stats describe that machine's files, not ours:
				// start fresh and let content hashes re-pair everything.
				this.log("info", "The sync journal on disk came from another device; starting this device's journal fresh. Files re-pair by content on the next sync.");
				this.lastSyncMs = 0;
				this.engine.loadJournal({});
				// share journals describe what THIS device wrote; another
				// device's is no guide to what is on this disk. Starting empty
				// costs one hashing pass and nothing else.
				this.shareStates = {};
				this.sharePublishSig = {};
				return;
			}
			this.lastSyncMs = s.lastSyncMs ?? 0;
			this.engine.loadJournal(s);
			this.shareStates = s.shares && typeof s.shares === "object" ? s.shares : {};
			this.sharePublishSig = s.publishSig && typeof s.publishSig === "object" ? s.publishSig : {};
			// pre-1.1.1 journals kept the device excludes in this file; carry
			// them into localStorage once
			if (!this.deviceExcludes && typeof s.deviceExcludes === "string" && s.deviceExcludes) {
				this.deviceExcludes = s.deviceExcludes;
				this.app.saveLocalStorage("pcon-device-excludes", this.deviceExcludes);
			}
		} catch {
			this.lastSyncMs = 0;
			this.engine.loadJournal({});
			this.shareStates = {};
			this.sharePublishSig = {};
		}
	}

	/** Journal writes are coalesced and atomic. Coalesced: a checkpoint
	 *  request while one is already queued rides along instead of queueing
	 *  another, and serialization happens when the write runs, with the
	 *  latest maps. An adopt storm (a new device pairing 19k files in
	 *  seconds) once requested hundreds of eager multi-megabyte stringifies
	 *  and took the renderer down with it. Atomic: write a tmp file, then
	 *  swap it in, so a crash mid-write can never leave a truncated journal. */
	private statePending = false;

	saveState(): Promise<void> {
		if (this.statePending) return this.stateWrite;
		this.statePending = true;
		this.stateWrite = this.stateWrite
			.then(async () => {
				this.statePending = false; // requests from here on queue the next write
				const body = JSON.stringify({
					version: 1,
					writerId: this.deviceId,
					lastSyncMs: this.lastSyncMs,
					shares: this.shareStates,
					publishSig: this.sharePublishSig,
					...this.engine.journalObject(),
				});
				const file = this.stateFile();
				const tmp = file + ".tmp";
				const ad = this.app.vault.adapter;
				await ad.write(tmp, body);
				try {
					if (await ad.exists(file)) await ad.remove(file);
					await ad.rename(tmp, file);
				} catch {
					// a rename raced something; the next checkpoint rewrites,
					// and loadState falls back to the tmp file if needed
				}
			})
			.catch((e) => {
				this.statePending = false;
				this.log("warn", `Could not save sync state: ${msg(e)}`);
			});
		return this.stateWrite;
	}

	saveDeviceExcludes(text: string) {
		this.deviceExcludes = text;
		this.app.saveLocalStorage("pcon-device-excludes", text);
		this.applySettings();
	}

	/** Forget everything we know about both sides. The next sync re-merges:
	 *  identical files pair up by content, differing ones become conflicts.
	 *  Nothing is deleted by a re-merge. */
	async resetState() {
		this.engine.resetJournal();
		this.lastSyncMs = 0;
		await this.saveState();
		this.log("info", "Sync state reset; the next sync will re-merge both sides.");
	}

	/* ---------------- log + status ---------------- */

	log(level: LogEntry["level"], text: string) {
		if (level === "debug" && !this.settings.verboseLog) return;
		this.logRing.push({ ts: Date.now(), level, msg: text });
		if (this.logRing.length > 500) this.logRing.splice(0, this.logRing.length - 500);
		// The ring above is the log people actually read (Settings > View log).
		// Everything is in the plugin's own log either way; the console copy is
		// for a bug report, so it follows the same switch rather than being on for
		// everyone all the time.
		if (this.settings.verboseLog) console.warn(`[Power Connect] ${text}`);
		this.logChanged?.();
	}

	private setStatus(kind: "off" | "idle" | "sync" | "ok" | "warn" | "error", text: string, tooltip?: string) {
		if (!this.statusEl) return;
		this.statusEl.setText(text);
		this.statusEl.setAttr("aria-label", tooltip ?? text);
		this.statusEl.setAttr("data-pcon", kind);
	}

	refreshIdleStatus() {
		if (this.subscriberOnly)
			this.setStatus(
				this.lastSharePullMs ? "ok" : "idle",
				`⇄ ${this.lastSharePullMs ? fmtClock(this.lastSharePullMs) : "shares"}`,
				"Power Connect: click to check the shares you receive"
			);
		else if (!this.remote.connected) this.setStatus("off", "⇄ set up", "Power Connect: connect Dropbox in settings");
		else if (this.paused) this.setStatus("idle", "⇄ paused", "Power Connect: automatic sync paused");
		else if (this.lastSyncMs) this.setStatus("ok", `⇄ ${fmtClock(this.lastSyncMs)}`, "Power Connect: last synced, click to sync now");
		else this.setStatus("idle", "⇄ ready", "Power Connect: click to run the first sync");
	}

	private notify(text: string, level: "all" | "changes" | "errors", timeout = 6000) {
		const rank = { errors: 0, changes: 1, all: 2 } as const;
		if (rank[level] <= rank[this.settings.notices]) new Notice(text, timeout);
	}

	/* ---------------- local file IO ---------------- */

	suppress(rel: string) {
		this.echo.set(normKey(rel), Date.now() + 4000);
	}

	private suppressed(rel: string): boolean {
		const until = this.echo.get(normKey(rel));
		if (!until) return false;
		if (Date.now() > until) {
			this.echo.delete(normKey(rel));
			return false;
		}
		return true;
	}

	/** Files touched since the last completed sync, for the backgrounding
	 *  fast flush. */
	dirty = new Set<string>();

	private onLocalTouch(path: string) {
		const rel = normRel(path);
		if (this.suppressed(rel) || !this.remote.connected || this.paused) return;
		if (junkFile(rel) || isIgnored(rel, this.igCache)) return;
		this.dirty.add(rel);
		if (this.settings.watchSeconds <= 0) return;
		if (this.watchTimer != null) window.clearTimeout(this.watchTimer);
		// the shared setting is tuned for desktop typing sessions; a phone
		// visit is a quick note and a swipe away, so settle much sooner there
		const settle = Platform.isMobileApp ? Math.min(this.settings.watchSeconds, 3) : this.settings.watchSeconds;
		this.watchTimer = window.setTimeout(() => {
			this.watchTimer = null;
			void this.syncNow("edits", false);
		}, settle * 1000);
	}

	remoteRoot(): string {
		return this.engine.remoteRoot();
	}

	/** The folder Obsidian actually loaded us from. Forced excludes and the
	 *  scan skip must key off this, not the manifest id: a manual install
	 *  under a differently named folder would otherwise sync the tokens. */
	private pluginDirName(): string {
		return this.manifest.dir?.split("/").pop() || this.manifest.id;
	}

	/* ---------------- shares received from other people ---------------- */

	get hasShares(): boolean {
		return this.settings.subscriptions.length > 0;
	}

	/** Receiving shares without syncing a vault of one's own. The whole point
	 *  of read-only sharing is that the recipient sets nothing up, so every
	 *  "you have not finished setup" prompt has to know about this state and
	 *  keep quiet. */
	get subscriberOnly(): boolean {
		return !this.remote.connected && this.hasShares;
	}

	/** An unauthenticated GET of shared bytes. Same split as the Dropbox
	 *  client (see dropbox.ts): requestUrl on desktop, the webview's own
	 *  fetch on mobile. The content host answers cross-origin requests with
	 *  `Access-Control-Allow-Origin: *`, which is exactly why the manifest
	 *  stores that host and never the share page URL. */
	private async fetchShared(url: string): Promise<ArrayBuffer> {
		if (!fetchableUrl(url)) throw new Error("that link does not point at a known file host");
		if (!Platform.isMobileApp) {
			const r = await requestUrl({ url, method: "GET", throw: false });
			if (r.status !== 200) throw new Error(`the link returned HTTP ${r.status}`);
			return r.arrayBuffer;
		}
		const r = await window.fetch(url, { method: "GET" });
		if (!r.ok) throw new Error(`the link returned HTTP ${r.status}`);
		return r.arrayBuffer();
	}

	private shareIO(): ShareIO {
		const vault = new ObsidianVaultIO(this);
		return {
			fetchBytes: (url) => this.fetchShared(url),
			read: (rel) => vault.read(rel),
			write: (rel, bytes, mtime) => vault.write(rel, bytes, mtime),
			exists: (rel) => vault.exists(rel),
			log: (level, text) => this.log(level, text),
		};
	}

	/** Fetch every share this vault subscribes to. Independent of the vault
	 *  sync: a subscriber may have no provider at all, and a failure here
	 *  must never touch the sync failure streak or its backoff. */
	async pullShares(reason: string, interactive: boolean): Promise<void> {
		if (this.pullingShares) return;
		const active = this.settings.subscriptions.filter((s) => !s.paused);
		if (!active.length) {
			if (interactive) new Notice("Power Connect: this vault is not receiving any shares.");
			return;
		}
		// a vault receiving hundreds of shares must not fetch a keyring and an
		// index for every one of them on every interval. Automatic runs take
		// the ones that are due, oldest first, and no more than a handful at a
		// time; asking by hand still checks everything.
		const now = Date.now();
		const subs = interactive
			? active
			: active
					.filter((s) => (this.shareStates[s.id]?.nextCheckMs ?? 0) <= now)
					.sort((a, b) => (this.shareStates[a.id]?.nextCheckMs ?? 0) - (this.shareStates[b.id]?.nextCheckMs ?? 0))
					.slice(0, SHARE_PULLS_PER_TICK);
		if (!subs.length) return;
		this.pullingShares = true;
		const io = this.shareIO();
		try {
			for (const sub of subs) {
				const state = (this.shareStates[sub.id] ??= emptyShareState());
				try {
					// the keyring decides whether this device may read at all;
					// a pending request and a withdrawn one both land here
					const contentKey = await resolveMemberKey(io, sub);
					if (contentKey !== sub.key) {
						sub.key = contentKey;
						await this.persistSettings();
					}
					const r = await pullShare(io, sub, state, contentKey, Math.max(0, this.settings.maxFileMB) * 1024 * 1024, this.app.vault.configDir);
					state.quiet = r.written || r.conflicts.length ? 0 : Math.min(state.quiet + 1, 5);
					state.nextCheckMs = Date.now() + nextCheckDelay(Math.max(this.settings.autoMinutes, 1) * 60_000, state.quiet);
					const summary = pullSummary(r);
					this.log(r.written || r.failed.length ? "info" : "debug", `Share "${sub.name}" (${reason}): ${summary}.`);
					if (r.written || interactive) this.notify(`Power Connect: share "${sub.name}" ${summary}.`, "changes");
				} catch (e) {
					// waiting for approval is a normal state, not a fault, and
					// a revoked share is the expected end of a share's life
					if (e instanceof ShareNotApproved) {
						state.quiet = Math.min(state.quiet + 1, 3);
						state.nextCheckMs = Date.now() + nextCheckDelay(Math.max(this.settings.autoMinutes, 1) * 60_000, state.quiet);
						this.log(sub.key ? "info" : "debug", `Share "${sub.name}": ${e.message}`);
						if (sub.key) {
							sub.key = "";
							await this.persistSettings();
						}
						if (interactive) new Notice(`Power Connect: ${e.message}`, 9000);
						continue;
					}
					const text = e instanceof ShareUnreadable ? e.message : msg(e);
					state.quiet = Math.min(state.quiet + 1, 5);
					state.nextCheckMs = Date.now() + nextCheckDelay(Math.max(this.settings.autoMinutes, 1) * 60_000, state.quiet);
					this.log("warn", `Share "${sub.name}" could not be updated: ${text}`);
					if (interactive) new Notice(`Power Connect: ${text}`, 9000);
				}
			}
			this.lastSharePullMs = Date.now();
			await this.saveState();
		} finally {
			this.pullingShares = false;
		}
		this.refreshSettingsTab?.();
	}

	/** A received share is delivered by the share pull on every device this
	 *  person owns, because the subscription itself travels in settings. It
	 *  must not ALSO ride their own vault sync, or two writers land on the
	 *  same files and manufacture conflicts out of nothing. */
	private excludeShareFolder(localPath: string) {
		const line = `${normRel(localPath)}/`;
		if (!line || line === "/") return;
		const lines = this.settings.excludes.split(/\r?\n/);
		if (lines.some((l) => l.trim() === line)) return;
		this.settings.excludes = this.settings.excludes ? `${this.settings.excludes}\n${line}` : line;
		this.applySettings();
		this.log("info", `Excluded "${line}" from your own sync: this folder is kept up to date by the share instead.`);
	}

	/** The mirror: once a share is no longer received, its notes are ordinary
	 *  files of theirs, and ordinary files belong in their own sync. */
	private unexcludeShareFolder(localPath: string) {
		const line = `${normRel(localPath)}/`;
		const lines = this.settings.excludes.split(/\r?\n/);
		if (!lines.some((l) => l.trim() === line)) return;
		this.settings.excludes = lines.filter((l) => l.trim() !== line).join("\n");
		this.applySettings();
		this.log("info", `Removed "${line}" from the exclude list; those notes are yours now and sync normally.`);
	}

	async openSharesView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SHARES)[0];
		if (existing) {
			await this.app.workspace.revealLeaf(existing);
			return;
		}
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.setViewState({ type: VIEW_TYPE_SHARES, active: true });
	}

	/* ---------------- shares this vault publishes ---------------- */

	/** Publishing needs link minting, which today only the Dropbox client
	 *  implements (see SHARING.md section 10: OneDrive is viable but blocked
	 *  by tenant policy on many accounts, Google Drive barely at all).
	 *  Receiving works on every provider and on none. */
	get canPublish(): boolean {
		return this.settings.provider === "dropbox" && this.remote.connected;
	}

	private publishIO(): PublishIO {
		const vault = new ObsidianVaultIO(this);
		const dbx = this.dropbox;
		return {
			read: (rel) => vault.read(rel),
			upload: async (path, bytes) => {
				await dbx.upload(path, bytes, { mode: "overwrite", clientModified: msToIsoSec(Date.now()) });
			},
			link: async (path) => directUrl(await dbx.createOrGetLink(path)),
			remove: (path) => dbx.del(path),
			unlink: (url) => dbx.revokeLink(url),
			log: (level, text) => this.log(level, text),
		};
	}

	/** Has anything moved since the last publish? Answered from Obsidian's
	 *  in-memory file list alone: no reads, no hashing, cheap enough to ask on
	 *  every interval. Counting as well as timestamping is what catches a
	 *  deletion, which changes no mtime anywhere.
	 *
	 *  Batched across shares on purpose (see shareSignatures): asking per
	 *  share meant one walk of the whole vault each, which a vault with
	 *  hundreds of shares cannot afford. */
	private shareSignature(share: OwnedShare): { latest: number; count: number } {
		return this.allShareSignatures([share]).get(share.id) ?? { latest: 0, count: 0 };
	}

	private allShareSignatures(shares: OwnedShare[]): Map<string, { latest: number; count: number }> {
		return shareSignatures(shares, this.app.vault.getFiles().map((f) => ({ path: f.path, mtime: f.stat.mtime })));
	}

	/** Hash everything a share carries. Shares are small by nature (a folder,
	 *  a handful of notes), so this reads them outright rather than keeping a
	 *  second index in step with the vault. */
	async shareFiles(share: { homePath: string; attached: string[] }): Promise<ResolveResult> {
		const vault = new ObsidianVaultIO(this);
		const all = this.app.vault.getFiles().map((f) => ({ path: normRel(f.path), size: f.stat.size, mtime: f.stat.mtime }));
		const home = normRel(share.homePath);
		const wanted = new Set<string>();
		for (const f of all) {
			if (home && f.path.startsWith(home + "/")) wanted.add(f.path);
		}
		for (const a of share.attached) wanted.add(normRel(a));
		const hashes = new Map<string, string>();
		for (const p of wanted) {
			try {
				hashes.set(p, await contentHash(await vault.read(p)));
			} catch {
				/* resolveShareFiles reports it as unreadable */
			}
		}
		return resolveShareFiles(share, all, hashes, Math.max(0, this.settings.maxFileMB) * 1024 * 1024, this.app.vault.configDir);
	}

	/** Publish a share: upload what changed, refresh the index, and leave the
	 *  invite link untouched so codes already sent keep working. */
	async publishShareNow(id: string, interactive: boolean, force = false, precomputed?: { latest: number; count: number }): Promise<void> {
		const share = this.settings.shares.find((s) => s.id === id);
		if (!share) return;
		if (!this.canPublish) {
			if (interactive) new Notice("Power Connect: publishing a share needs a Dropbox connection on this device.", 8000);
			return;
		}
		if (this.publishing) return;
		const sig = precomputed ?? this.shareSignature(share);
		const seen = this.sharePublishSig[share.id];
		// an automatic pass costs a read and a hash of every shared file, so
		// it only runs when the vault says something actually moved
		if (!interactive && share.publishedAt && seen && seen.latest === sig.latest && seen.count === sig.count) return;
		this.publishing = true;
		try {
			const { files, skipped } = await this.shareFiles(share);
			for (const s of skipped) this.log("warn", `Not shared: ${s.local} (${s.why}).`);

			// the published index is the authority on what is already up
			// there, so publishing from a second device needs no local state
			let prev: ShareManifest | null = null;
			// a forced publish re-encrypts everything: after a key rotation the
			// old ciphertext is exactly what must not survive
			if (share.manifestUrl && !force) {
				try {
					prev = await decodeManifest(await importShareKey(share.key), await this.fetchShared(share.manifestUrl));
				} catch {
					this.log("info", `Could not read the current index for "${share.name}"; republishing it in full.`);
				}
			}

			// the same instinct as the vault's delete guard: a share that
			// suddenly resolves to almost nothing usually means a folder was
			// moved or emptied, not that the owner meant to withdraw it all
			const before = prev?.files.length ?? 0;
			const dropped = before - files.length;
			if (!force && before > 10 && dropped > 0 && dropped / before > Math.max(1, this.settings.deleteGuardPct) / 100) {
				const text = `Publishing "${share.name}" would withdraw ${dropped} of ${before} file(s). That usually means the folder was moved or emptied rather than that you meant to unshare them.`;
				if (!interactive) {
					this.log("warn", `${text} Held until you publish it by hand.`);
					return;
				}
				if (!this.holdConfirmed.has(share.id)) {
					// one deliberate second press, rather than a dialog: the
					// same shape as the vault's delete guard
					this.holdConfirmed.add(share.id);
					this.log("warn", `${text} Held for review.`);
					new Notice(`Power Connect: ${text} Nothing was published. Press Publish again to go ahead.`, 15000);
					return;
				}
			}
			this.holdConfirmed.delete(share.id);

			const r = await publishShare(this.publishIO(), share, files, prev);
			share.manifestUrl = r.manifestUrl;
			share.keyringUrl = r.keyringUrl;
			share.publishedAt = Date.now();
			this.sharePublishSig[share.id] = sig;
			await this.persistSettings();
			await this.saveState();
			const summary = publishSummary(r);
			this.log("info", `Share "${share.name}": ${summary}.`);
			if (interactive || r.uploaded || r.removed) this.notify(`Power Connect: share "${share.name}" ${summary}.`, "changes");
			if (r.failed.length && interactive) new Notice(`Power Connect: ${r.failed.length} file(s) in "${share.name}" could not be published. See the sync log.`, 9000);
			this.refreshSettingsTab?.();
		} catch (e) {
			const text = msg(e);
			this.log("error", `Could not publish "${share.name}": ${text}`);
			if (interactive) {
				const hint = /missing_scope|sharing\.write/i.test(text)
					? "Power Connect: this device's Dropbox sign-in does not include permission to create share links. In the Dropbox App Console add sharing.write and press Submit, then run Set up Power Connect and choose Sign in again. (A sign-in keeps the permissions it was granted, so adding one in the console does not reach this device on its own.)"
					: `Power Connect: ${text}`;
				new Notice(hint, 12000);
			}
		} finally {
			this.publishing = false;
		}
	}

	/** Start sharing. The share is created and published in one step: a share
	 *  that exists but has never been published has nothing to invite anyone
	 *  to, and would only be a way to hand out a broken code. */
	async createShare(opts: { name: string; homePath: string; attached: string[] }): Promise<OwnedShare | null> {
		const share: OwnedShare = {
			id: randB64url(9),
			name: opts.name.trim() || "Shared notes",
			key: makeShareKey(),
			members: [],
			keyringUrl: "",
			homePath: normRel(opts.homePath),
			attached: opts.attached.map((a) => normRel(a)),
			remoteFolder: randB64url(12),
			manifestUrl: "",
			createdAt: Date.now(),
			publishedAt: 0,
			expiresAt: 0,
			invitesSent: [],
		};
		this.settings.shares.push(share);
		await this.persistSettings();
		await this.publishShareNow(share.id, true);
		return this.settings.shares.find((s) => s.id === share.id) ?? null;
	}

	/** Record a request code. The member lands pending: nothing is readable
	 *  until the owner says so, which is the entire point of the handshake. */
	async addJoinRequest(text: string): Promise<{ share: OwnedShare; member: ShareMember } | null> {
		const req = parseJoinCode(text);
		if (!req) return null;
		const share = this.settings.shares.find((sh) => sh.id === req.shareId);
		if (!share) return null;
		const existing = share.members.find((m) => m.memberId === req.memberId);
		if (existing) {
			// a resent request from someone already known: refresh the key and
			// the name, but never quietly re-approve a member who was denied
			existing.publicKey = req.publicKey;
			existing.name = req.name;
			if (existing.state === "revoked" || existing.state === "denied") existing.state = "pending";
			existing.requestedAt = Date.now();
		} else {
			share.members.push({ memberId: req.memberId, name: req.name, publicKey: req.publicKey, state: "pending", requestedAt: Date.now(), decidedAt: 0, email: "" });
		}
		await this.persistSettings();
		const member = share.members.find((m) => m.memberId === req.memberId) as ShareMember;
		this.log("info", `"${member.name}" asked to join the share "${share.name}".`);
		return { share, member };
	}

	/** Approve, deny, or revoke. Approving and denying cost one small keyring
	 *  upload. Revoking rotates the content key and republishes the share,
	 *  because leaving the old key in circulation would make the revocation
	 *  cosmetic for anyone who kept a copy of it. */
	async setMemberState(shareId: string, memberId: string, state: ShareMember["state"]): Promise<void> {
		const share = this.settings.shares.find((sh) => sh.id === shareId);
		const member = share?.members.find((m) => m.memberId === memberId);
		if (!share || !member) return;
		if (!this.canPublish) {
			new Notice("Power Connect: managing a share needs a Dropbox connection on this device.", 8000);
			return;
		}
		const was = member.state;
		member.state = state;
		member.decidedAt = Date.now();
		await this.persistSettings();

		try {
			if (state === "revoked" && was === "approved") {
				share.key = makeShareKey();
				await this.persistSettings();
				await this.publishShareNow(share.id, false, true);
				this.log("info", `Revoked "${member.name}" from "${share.name}" and rotated the share's key.`);
				new Notice(`Power Connect: ${member.name} can no longer read "${share.name}". Anything they already downloaded stays with them.`, 9000);
			} else {
				share.keyringUrl = await publishKeyring(this.publishIO(), share);
				await this.persistSettings();
				this.log("info", `"${member.name}" is now ${state} for the share "${share.name}".`);
				if (state === "approved") new Notice(`Power Connect: ${member.name} can now read "${share.name}".`);
			}
		} catch (e) {
			member.state = was;
			await this.persistSettings();
			this.log("error", `Could not update membership for "${share.name}": ${msg(e)}`);
			new Notice(`Power Connect: ${msg(e)}`, 9000);
		}
		this.refreshSettingsTab?.();
	}

	/** What a share's notes point at that the share does not carry.
	 *
	 *  Sharing three notes out of twenty is the case this whole design exists
	 *  for, and it is exactly the case that produces broken embeds on the
	 *  other side. Embeds and links are separated because they want different
	 *  answers: a missing image is nearly always a mistake worth fixing by
	 *  including it, while a link to a note you deliberately kept back is
	 *  often intentional. */
	async shareLinkAudit(share: { homePath: string; attached: string[] }): Promise<{ embeds: string[]; links: string[] }> {
		const { files } = await this.shareFiles(share);
		const inShare = new Set(files.map((f) => normKey(f.local)));
		const embeds = new Set<string>();
		const links = new Set<string>();
		for (const f of files) {
			const file = this.app.vault.getAbstractFileByPath(f.local);
			if (!(file instanceof TFile) || file.extension !== "md") continue;
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			const check = (refs: { link: string }[] | undefined, into: Set<string>) => {
				for (const r of refs ?? []) {
					const dest = this.app.metadataCache.getFirstLinkpathDest(r.link.split("#")[0].split("|")[0], f.local);
					if (!dest) continue; // already broken in this vault; not ours to report
					const rel = normRel(dest.path);
					if (!inShare.has(normKey(rel))) into.add(rel);
				}
			};
			check(cache.embeds, embeds);
			check(cache.links, links);
		}
		return { embeds: [...embeds].sort(), links: [...links].sort() };
	}

	/* ---------------- marking shared items in the file list ---------------- */

	private markSheet: CSSStyleSheet | null = null;

	/** Mark shared items by injecting one stylesheet keyed on the explorer's
	 *  own data-path attributes. Same technique as Power Explorer: no
	 *  MutationObserver, no reliance on the unofficial fileItems API, and it
	 *  survives every re-render the explorer does on its own.
	 *
	 *  The selectors name the user's own share paths, so styles.css cannot
	 *  express them. A constructable stylesheet carries them with no element in
	 *  the document. Where it is unavailable (Safari below 16.4, so older iOS)
	 *  the marks are skipped: they are a cue, and a missing cue beats a broken
	 *  file list.
	 *
	 *  Only the home folder and individually attached notes are marked. Marking
	 *  every descendant of a shared folder turns the sidebar into a barcode. */
	refreshShareMarks() {
		if (!this.markSheet) {
			if (typeof CSSStyleSheet === "undefined" || !("replaceSync" in CSSStyleSheet.prototype)) return;
			this.markSheet = new CSSStyleSheet();
			document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.markSheet];
			this.register(() => {
				document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== this.markSheet);
			});
		}
		if (!this.settings.shareMarks) {
			this.markSheet.replaceSync("");
			return;
		}

		const esc = (p: string) => p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const groups: Record<string, string[]> = { out: [], in: [], wait: [], lost: [] };
		for (const s of this.settings.shares) {
			if (s.homePath) groups.out.push(s.homePath);
			for (const a of s.attached) groups.out.push(a);
		}
		for (const sub of this.settings.subscriptions) {
			if (!sub.localPath) continue;
			groups[sub.paused ? "lost" : sub.key ? "in" : "wait"].push(sub.localPath);
		}

		let css = "";
		for (const [kind, paths] of Object.entries(groups)) {
			if (!paths.length) continue;
			const sel = [...new Set(paths)]
				.map((p) => `.nav-folder-title[data-path="${esc(p)}"],.nav-file-title[data-path="${esc(p)}"]`)
				.join(",");
			css += `${sel}{box-shadow:inset 3px 0 0 0 var(--pcon-mark-${kind});}\n`;
			const content = [...new Set(paths)]
				.map((p) => `.nav-folder-title[data-path="${esc(p)}"] .nav-folder-title-content::after,.nav-file-title[data-path="${esc(p)}"] .nav-file-title-content::after`)
				.join(",");
			css += `${content}{content:" ${kind === "out" ? "↗" : kind === "in" ? "↙" : kind === "wait" ? "⋯" : "⊘"}";opacity:.7;font-size:.85em;}\n`;
		}
		this.markSheet.replaceSync(css);
	}

	/** Set or clear a share's expiry. Applied to the index and keyring links,
	 *  which is enough: without the index nobody can find the files, and
	 *  without the keyring nobody can obtain the key. Dropbox enforces the
	 *  date, so it holds whether or not this vault ever opens again. */
	async setShareExpiry(id: string, at: number): Promise<void> {
		const share = this.settings.shares.find((s) => s.id === id);
		if (!share || !this.canPublish) return;
		const iso = at ? new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
		try {
			for (const url of [share.manifestUrl, share.keyringUrl].filter(Boolean)) await this.dropbox.setLinkExpiry(url, iso);
			share.expiresAt = at;
			await this.persistSettings();
			this.log("info", at ? `Share "${share.name}" stops working after ${new Date(at).toLocaleString()}.` : `Share "${share.name}" no longer expires.`);
			this.sharesChanged?.();
		} catch (e) {
			this.log("error", `Could not change the expiry for "${share.name}": ${msg(e)}`);
			new Notice(`Power Connect: ${msg(e)}`, 9000);
		}
	}

	/** Publish every share, sharing one walk of the vault between them. */
	async publishAll(): Promise<void> {
		if (!this.canPublish || !this.settings.shares.length) return;
		const sigs = this.allShareSignatures(this.settings.shares);
		for (const sh of this.settings.shares) await this.publishShareNow(sh.id, false, false, sigs.get(sh.id));
		new Notice("Power Connect: shares are up to date.");
	}

	/** Stop sharing entirely: withdraw every link and delete the published
	 *  copies. What recipients already pulled is theirs and stays with them;
	 *  this ends future access, which is the only thing it can honestly
	 *  promise. */
	async deleteShare(id: string): Promise<void> {
		const share = this.settings.shares.find((s) => s.id === id);
		if (!share) return;
		if (this.canPublish) {
			try {
				const io = this.publishIO();
				if (share.manifestUrl) await io.unlink(share.manifestUrl);
				let prev: ShareManifest | null = null;
				try {
					prev = await decodeManifest(await importShareKey(share.key), await this.fetchShared(share.manifestUrl));
				} catch {
					/* already gone, or unreadable; the folder delete still runs */
				}
				for (const e of prev?.files ?? []) await io.unlink(e.url).catch(() => undefined);
				await this.dropbox.del(`/${SHARE_ROOT}/${share.remoteFolder}`);
			} catch (e) {
				this.log("warn", `Could not fully clean up "${share.name}" in Dropbox: ${msg(e)}. Its links are withdrawn; remove the folder by hand if it remains.`);
			}
		}
		this.settings.shares = this.settings.shares.filter((s) => s.id !== id);
		delete this.sharePublishSig[id];
		await this.persistSettings();
		await this.saveState();
		this.log("info", `Stopped sharing "${share.name}". Anyone who already received it keeps what they downloaded.`);
		this.refreshShareMarks();
		this.refreshSettingsTab?.();
		this.sharesChanged?.();
		this.refreshShareMarks();
	}

	/** Accept an invite. Re-accepting a share already held updates its link
	 *  and key in place, which is what a key rotation after a revoke looks
	 *  like from the receiving end. */
	async addSubscription(sub: Subscription): Promise<void> {
		const existing = this.settings.subscriptions.findIndex((s) => s.id === sub.id);
		if (existing >= 0) {
			const keep = this.settings.subscriptions[existing];
			this.settings.subscriptions[existing] = { ...sub, localPath: keep.localPath, addedAt: keep.addedAt, paused: keep.paused };
			this.log("info", `Share "${sub.name}" updated from a new invite code.`);
		} else {
			this.settings.subscriptions.push(sub);
			this.log("info", `Now receiving the share "${sub.name}" into ${sub.localPath}.`);
		}
		this.excludeShareFolder(sub.localPath);
		await this.persistSettings();
		await this.pullShares("new share", true);
		this.refreshShareMarks();
	}

	/** Stop receiving a share. The notes stay: they are ordinary files in
	 *  this vault now, and deleting someone's copy because they unsubscribed
	 *  would be the wrong reading of "stop". */
	async removeSubscription(id: string): Promise<void> {
		const sub = this.settings.subscriptions.find((s) => s.id === id);
		this.settings.subscriptions = this.settings.subscriptions.filter((s) => s.id !== id);
		delete this.shareStates[id];
		if (sub) this.unexcludeShareFolder(sub.localPath);
		await this.persistSettings();
		await this.saveState();
		if (sub) this.log("info", `Stopped receiving "${sub.name}". Its notes stay in ${sub.localPath}.`);
		this.refreshShareMarks();
	}

	async previewSync(): Promise<void> {
		if (!this.remote.connected) {
			new Notice("Power Connect: connect Dropbox in settings first.");
			return;
		}
		if (this.running) {
			new Notice("Power Connect: a sync is already running.");
			return;
		}
		this.running = true;
		this.setStatus("sync", "⇄ preview", "Power Connect: computing the sync plan");
		// a preview must not eat the rename hints the next real sync needs
		const hints = this.engine.moveHints.slice();
		try {
			const prep = await this.engine.prepare((t) => this.setStatus("sync", `⇄ ${t}`));
			this.engine.moveHints = hints.concat(this.engine.moveHints);
			new PlanModal(this.app, this, prep.plan).open();
		} catch (e) {
			this.log("error", `Preview failed: ${msg(e)}`);
			new Notice(`Power Connect: ${msg(e)}`, 8000);
		} finally {
			this.running = false;
			this.refreshIdleStatus();
		}
	}

	async syncNow(reason: string, interactive: boolean): Promise<void> {
		if (!this.remote.connected) {
			if (interactive) new Notice("Power Connect: connect Dropbox in settings first.");
			return;
		}
		if (this.running) {
			this.pendingRun = true;
			return;
		}
		if (!interactive && this.paused) return;
		// the first sync on a device is always user-started: an automatic
		// trigger (return-to-app, schedule, edit-settle, live) firing while
		// setup is mid-decision would upload before encryption is chosen
		if (!interactive && !this.lastSyncMs) return;
		if (!interactive && Date.now() < this.nextAutoOkMs) return;
		this.running = true;
		this.engine.runConflictChoice = null;
		const stats = freshStats();
		this.log("debug", `Sync started (${reason}).`);
		this.setStatus("sync", "⇄ starting");
		try {
			const prep = await this.engine.prepare((t) => this.setStatus("sync", `⇄ ${t}`));
			// a first-ever merge of two non-empty sides is a decision, not a
			// background chore: it only runs from a sync the user starts
			if (!interactive && this.engine.baseMap.size === 0 && prep.local.size > 0 && prep.remote.size > 0) {
				if (!this.blockedNoticed) {
					this.blockedNoticed = true;
					new Notice(
						`Power Connect: the first sync would merge ${prep.local.size} local files with ${prep.remote.size} already on Dropbox. Run "Preview sync" or "Sync now" to proceed.`,
						0
					);
				}
				this.log("info", "First merge deferred to a manual sync.");
				this.refreshIdleStatus();
				return;
			}
			let plan = prep.plan;
			if (plan.holdDeletes) {
				if (interactive) {
					const choice = await new DeleteHoldModal(this.app, plan).ask();
					if (choice === "cancel") {
						this.log("info", "Sync canceled at the delete review.");
						return;
					}
					if (choice === "skip") plan = stripDeletes(plan);
				} else {
					const held = plan.deletesLocal + plan.deletesRemote;
					plan = stripDeletes(plan);
					if (!this.deleteHoldNoticed) {
						this.deleteHoldNoticed = true;
						new Notice(`Power Connect held back ${held} deletions as a safety measure. Run "Preview sync" to review and apply them.`, 0);
					}
					this.log("warn", `Held back ${held} deletions (over the safety threshold). Preview sync to apply them.`);
				}
			}
			// thousands of near-instant actions (an adopt storm) must not mean
			// thousands of DOM updates; 10 a second reads as live anyway
			let lastPaint = 0;
			await this.engine.execute(prep, plan, stats, interactive, (t) => {
				const now = Date.now();
				if (now - lastPaint < 100) return;
				lastPaint = now;
				this.setStatus("sync", `⇄ ${t}`);
			});
			this.lastSyncMs = Date.now();
			this.failStreak = 0;
			this.dirty.clear();
			this.nextAutoOkMs = 0;
			await this.saveState();
			void this.checkSelfUpdate();
			const summary = statsSummary(stats);
			this.log("info", `Sync done: ${summary}`);
			if (stats.errors.length) {
				this.setStatus("warn", `⇄ ${fmtClock(this.lastSyncMs)} ⚠`, `Power Connect: ${stats.errors.length} file(s) failed; see the sync log`);
				this.notify(`Power Connect: ${summary}. See the sync log.`, "errors", 8000);
			} else {
				this.refreshIdleStatus();
				const changed = stats.up + stats.down + stats.moves + stats.conflicts + stats.delLocal + stats.delRemote > 0;
				if (interactive) new Notice(`Power Connect: ${summary}.`);
				else this.notify(`Power Connect: ${summary}.`, changed ? "changes" : "all");
			}
		} catch (e) {
			const m = msg(e);
			this.log("error", `Sync failed: ${m}`);
			if (e instanceof SyncBlocked) {
				this.setStatus("error", "⇄ action needed", `Power Connect: ${m}`);
				if (interactive || !this.blockedNoticed) {
					this.blockedNoticed = true;
					new Notice(`Power Connect: ${m}`, 10000);
				}
			} else if (isAuthDead(e)) {
				// a revoked or expired grant never heals by retrying
				this.setStatus("error", "⇄ reconnect", "Power Connect: the Dropbox connection expired. Reconnect in settings.");
				if (interactive || !this.blockedNoticed) {
					this.blockedNoticed = true;
					new Notice("Power Connect: the Dropbox connection expired. Reconnect in settings.", 10000);
				}
			} else {
				this.failStreak++;
				this.nextAutoOkMs = Date.now() + backoffMs(this.failStreak, 60_000, 15 * 60_000);
				this.setStatus("error", "⇄ offline", `Power Connect: ${m}. Will retry automatically.`);
				if (interactive) new Notice(`Power Connect: ${m}`, 8000);
			}
			await this.saveState();
		} finally {
			this.running = false;
			if (this.pendingRun) {
				this.pendingRun = false;
				window.setTimeout(() => void this.syncNow("queued", false), 1500);
			}
		}
	}

	/* ---------------- timers ---------------- */

	scheduleAuto() {
		if (this.autoTimer != null) window.clearInterval(this.autoTimer);
		this.autoTimer = null;
		if (this.settings.autoMinutes > 0) {
			this.autoTimer = window.setInterval(
				() => {
					if (this.paused) return;
					// shares ride the same interval, and run even when this
					// vault syncs nothing of its own
					if (!this.running && this.remote.connected) void this.syncNow("interval", false);
					if (this.hasShares) void this.pullShares("interval", false);
					if (this.canPublish && this.settings.shares.length) {
						const sigs = this.allShareSignatures(this.settings.shares);
						for (const sh of this.settings.shares) void this.publishShareNow(sh.id, false, false, sigs.get(sh.id));
					}
				},
				this.settings.autoMinutes * 60_000
			);
			this.registerInterval(this.autoTimer);
		}
	}

	/** Factory reset for this device: settings back to defaults, journal
	 *  forgotten, every piece of per-device storage cleared. Notes and the
	 *  Dropbox side are untouched. The one honest meaning of "start over". */
	async forgetThisDevice(): Promise<void> {
		if (this.saveTimer != null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		this.adoptSettings(structuredClone(DEFAULT_SETTINGS));
		this.baseline = structuredClone(DEFAULT_SETTINGS);
		await this.saveData(this.settings);
		this.engine.resetJournal();
		this.lastSyncMs = 0;
		await this.saveState();
		for (const k of ["pcon-secrets", "pcon-device-excludes", "pcon-paused", "pcon-setup-dismissed", "pcon-device-id"]) {
			this.app.saveLocalStorage(k, null);
		}
		this.deviceExcludes = "";
		this.paused = false;
		this.applySettings();
		this.refreshIdleStatus();
		this.refreshSettingsTab?.();
		this.log("info", "This device's Power Connect state was erased; notes and Dropbox were not touched.");
	}

	private updateNoticed = "";

	/** The fleet updates this plugin through sync itself, but running code
	 *  only changes at app launch, and phones especially never relaunch on
	 *  their own. Compare the manifest that just landed on disk with the
	 *  build actually running and say when a restart is owed. */
	private async checkSelfUpdate(): Promise<void> {
		try {
			const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
			const raw = await this.app.vault.adapter.read(`${dir}/manifest.json`);
			const onDisk = String((JSON.parse(raw) as { version?: string }).version ?? "");
			if (onDisk && onDisk !== this.manifest.version && onDisk !== this.updateNoticed) {
				this.updateNoticed = onDisk;
				this.log("info", `Power Connect ${onDisk} arrived by sync; running ${this.manifest.version} until Obsidian restarts.`);
				new Notice(`Power Connect ${onDisk} synced in. Restart Obsidian to load it (on a phone: close the app fully and reopen).`, 10000);
			}
		} catch {
			/* no manifest to compare; nothing to say */
		}
	}

	/** The master switch. Per-device and persisted outside data.json: turning
	 *  sync off on a laptop must not turn it off on the phone. */
	setPaused(v: boolean) {
		if (this.paused === v) return;
		this.paused = v;
		this.app.saveLocalStorage("pcon-paused", v ? "1" : null);
		if (!v) this.startLongpoll();
		this.refreshIdleStatus();
		this.refreshSettingsTab?.();
		this.log("info", v ? "Sync paused on this device." : "Sync resumed on this device.");
	}

	/** What is already in a Dropbox folder, for the setup wizard: empty, an
	 *  unencrypted copy, or an encrypted copy (with its marker). */
	async probeFolder(folder: string): Promise<{ state: "empty" | "plain" | "encrypted"; files: number; marker: Marker | null }> {
		// same path convention as the engine: leading slash, sanitized name
		const root = "/" + sanitizeRemoteFolder(folder || this.app.vault.getName());
		await this.remote.ensureFolder(root);
		const { entries } = await this.remote.listAll(root);
		const files = entries.filter((e) => e.tag === "file");
		const hasMarker = files.some((e) => normKey(normRel(e.meta.pathDisplay)).split("/").pop() === MARKER_NAME);
		let marker: Marker | null = null;
		if (hasMarker) {
			try {
				const { bytes } = await this.remote.download(`${root}/${MARKER_NAME}`);
				marker = JSON.parse(new TextDecoder().decode(bytes)) as Marker;
			} catch {
				marker = null;
			}
		}
		const real = files.length - (hasMarker ? 1 : 0);
		return { state: marker?.e2e ? "encrypted" : real ? "plain" : "empty", files: real, marker };
	}

	/** A fresh device joining an existing copy adopts the vault's shared
	 *  settings (config sync, excludes, conflict policy) from the remote
	 *  data.json before the first sync. Without this, that first sync runs
	 *  on defaults and skips the very config folder that carries them. */
	async adoptRemoteSettings(root: string, key: CryptoKey | null): Promise<boolean> {
		try {
			const { bytes } = await this.remote.download(`${root}/${this.app.vault.configDir}/plugins/${this.manifest.id}/data.json`);
			const plain = key && looksEncrypted(bytes) ? await decryptBytes(key, bytes) : bytes;
			const raw = this.stripSecrets(JSON.parse(new TextDecoder().decode(plain)) as Partial<PconSettings>);
			if (!raw) return false;
			this.adoptSettings(Object.assign({}, this.settings, raw));
			this.queueSave();
			this.applySettings();
			this.log("info", "Adopted this vault's shared settings from the Dropbox copy.");
			return true;
		} catch {
			return false; // nothing up there yet; local settings stand
		}
	}

	/** Turn selective protection of plugin settings files on or off for the
	 *  current folder. Unlike full encryption this needs no empty folder:
	 *  protected files re-upload encrypted the next time they change, and
	 *  downloads tell plain from ciphertext by looking at the bytes. */
	async setSecretsProtection(on: boolean): Promise<string | null> {
		if (!this.remote.connected) return "Connect Dropbox first.";
		if (this.running) return "A sync is running; try again in a moment.";
		if (on && !this.settings.e2ePassphrase) return "Set a passphrase first.";
		const root = this.remoteRoot();
		await this.remote.ensureFolder(root);
		let marker: Marker = { format: 1, e2e: false };
		try {
			const { bytes } = await this.remote.download(`${root}/${MARKER_NAME}`);
			marker = JSON.parse(new TextDecoder().decode(bytes)) as Marker;
		} catch (e) {
			if (!isNotFound(e)) throw e;
		}
		if (marker.e2e) return on ? null : "This folder is fully encrypted; plugin settings files are already covered.";
		// plugin protection and folder protection share the one envelope; toggling
		// plugins off must not drop the envelope while folders still need it
		if (on) {
			await this.ensureSecretsEnvelope(marker);
		} else if (!(marker.protectedFolders?.length)) {
			delete marker.secrets;
		}
		const body = new TextEncoder().encode(JSON.stringify(marker));
		await this.remote.upload(`${root}/${MARKER_NAME}`, body.buffer, { mode: "overwrite", clientModified: msToIsoSec(Date.now()) });
		this.engine.markerDirty();
		this.engine.protectionSeen = on || !!marker.protectedFolders?.length;
		this.refreshSettingsTab?.();
		this.log("info", on ? "Plugin settings files now upload encrypted with the passphrase." : "Plugin settings protection removed for this folder.");
		return null;
	}

	/** Give a marker a protection envelope if it lacks one, reusing the existing
	 *  salt so any files already encrypted under it stay decryptable. The one
	 *  envelope is shared by plugin-settings and protected-folder encryption. */
	private async ensureSecretsEnvelope(marker: Marker): Promise<void> {
		if (marker.secrets) return;
		const salt = makeSalt();
		const key = await deriveKey(this.settings.e2ePassphrase, salt);
		marker.secrets = { salt, check: await makeCheck(key) };
	}

	/** Turn protection on or off for a top-level folder, and migrate the files
	 *  already on the server into the new envelope.
	 *
	 *  The order matters: write the marker first so a device reading it mid-run
	 *  agrees on the protected set, then re-key the existing files, then a normal
	 *  sync converges everything else. Reuses the shared secrets envelope, so a
	 *  folder and the plugin-settings files ride one passphrase. */
	async setFolderProtection(folder: string, on: boolean): Promise<string | null> {
		if (!this.remote.connected) return "Connect Dropbox first.";
		if (this.running) return "A sync is running; try again in a moment.";
		if (on && !this.settings.e2ePassphrase) return "Set a passphrase first.";
		const key = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
		if (!key) return "Pick a folder.";
		if (key.includes("/")) return "Only top-level folders can be protected.";

		const root = this.remoteRoot();
		await this.remote.ensureFolder(root);
		let marker: Marker = { format: 1, e2e: false };
		try {
			const { bytes } = await this.remote.download(`${root}/${MARKER_NAME}`);
			marker = JSON.parse(new TextDecoder().decode(bytes)) as Marker;
		} catch (e) {
			if (!isNotFound(e)) throw e;
		}
		if (marker.e2e) return "This folder is fully encrypted already; everything in it is protected.";

		const lower = key.toLowerCase();
		const have = (marker.protectedFolders ?? []).map((f) => f.toLowerCase());
		if (on) {
			await this.ensureSecretsEnvelope(marker);
			if (!have.includes(lower)) marker.protectedFolders = [...(marker.protectedFolders ?? []), key];
		} else {
			marker.protectedFolders = (marker.protectedFolders ?? []).filter((f) => f.toLowerCase() !== lower);
			// the envelope stays if plugin protection or another folder still needs it
			if (!marker.protectedFolders.length && this.engine.protectionSeen === false) delete marker.secrets;
		}
		if (!(this.settings.protectedFolders ?? []).map((f) => f.toLowerCase()).includes(lower) && on)
			this.settings.protectedFolders = [...(this.settings.protectedFolders ?? []), key];
		else if (!on) this.settings.protectedFolders = (this.settings.protectedFolders ?? []).filter((f) => f.toLowerCase() !== lower);
		this.queueSave();

		const body = new TextEncoder().encode(JSON.stringify(marker));
		await this.remote.upload(`${root}/${MARKER_NAME}`, body.buffer, { mode: "overwrite", clientModified: msToIsoSec(Date.now()) });
		this.engine.markerDirty();
		this.engine.protectionSeen = !!marker.secrets;

		// re-key the files already on the server, then converge the rest
		try {
			const prep = await this.engine.prepare(() => {});
			const n = await this.engine.migrateProtectedFolders([key], prep.local);
			this.log("info", on ? `Protected "${key}" and re-encrypted ${n} file(s).` : `Unprotected "${key}" and restored ${n} file(s) to plaintext.`);
		} catch (e) {
			this.log("warn", `Protection set for "${key}", but the re-key pass did not finish: ${e instanceof Error ? e.message : String(e)}. The next sync will retry.`);
		}
		this.refreshSettingsTab?.();
		return null;
	}

	/* ---------------- encryption setup ---------------- */

	/** Turning encryption on or off is only offered against an empty Dropbox
	 *  folder: mixing plaintext and ciphertext in one tree is how sync tools
	 *  eat vaults. The guided path is: pick the state before the first sync,
	 *  or point at a fresh folder name and let it re-upload. */
	async setEncryption(on: boolean): Promise<string | null> {
		if (!this.remote.connected) return "Connect Dropbox first.";
		if (this.running) return "A sync is running; try again in a moment.";
		if (on && !this.settings.e2ePassphrase) return "Set a passphrase first.";
		const root = this.remoteRoot();
		await this.remote.ensureFolder(root);
		const { entries } = await this.remote.listAll(root);
		const files = entries.filter((e) => e.tag === "file" && normKey(normRel(e.meta.pathDisplay)).split("/").pop() !== MARKER_NAME);
		if (files.length) {
			return on
				? "This Dropbox folder already holds an unencrypted copy. Use a new folder name in settings (or clear the folder in Dropbox), then enable encryption there."
				: "This Dropbox folder holds an encrypted copy. Use a new folder name in settings (or clear the folder in Dropbox), then sync unencrypted there.";
		}
		let marker: Marker;
		if (on) {
			const salt = makeSalt();
			const key = await deriveKey(this.settings.e2ePassphrase, salt);
			marker = { format: 1, e2e: true, salt, check: await makeCheck(key) };
		} else {
			marker = { format: 1, e2e: false };
		}
		const body = new TextEncoder().encode(JSON.stringify(marker));
		await this.remote.upload(`${root}/${MARKER_NAME}`, body.buffer, { mode: "overwrite", clientModified: msToIsoSec(Date.now()) });
		this.settings.e2eEnabled = on;
		this.queueSave();
		this.engine.markerDirty(); // the next run re-reads the marker and derives the key
		this.log("info", on ? "End-to-end encryption enabled for this Dropbox folder." : "Encryption disabled for this Dropbox folder.");
		return null;
	}
}

/** The engine's local side over Obsidian's vault and adapter: visible files
 *  go through the Vault API (index and events stay correct on mobile, where
 *  no fs watcher exists), hidden config paths through the adapter, and every
 *  write or delete registers with the plugin's echo suppression first. */
class ObsidianVaultIO implements VaultIO {
	constructor(private plugin: PowerConnectPlugin) {}

	private get app() {
		return this.plugin.app;
	}

	listVisible(): { path: string; mtime: number; size: number }[] {
		return this.app.vault.getFiles().map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size }));
	}

	async listConfig(configDir: string, skipDirKey: string): Promise<{ path: string; mtime: number; size: number }[]> {
		const ad = this.app.vault.adapter;
		const out: { path: string; mtime: number; size: number }[] = [];
		const stack = [configDir];
		while (stack.length) {
			const dir = stack.pop() as string;
			let ls: { files: string[]; folders: string[] };
			try {
				ls = await ad.list(dir);
			} catch {
				continue;
			}
			for (const d of ls.folders) {
				if (normKey(d) === skipDirKey) continue;
				stack.push(d);
			}
			for (const p of ls.files) {
				const st = await ad.stat(p);
				if (st && st.type === "file") out.push({ path: p, mtime: st.mtime, size: st.size });
			}
		}
		return out;
	}

	async read(rel: string): Promise<ArrayBuffer> {
		const f = this.app.vault.getAbstractFileByPath(rel);
		if (f instanceof TFile) return this.app.vault.readBinary(f);
		return this.app.vault.adapter.readBinary(rel);
	}

	private isHiddenPath(rel: string): boolean {
		return rel.split("/").some((s) => s.startsWith("."));
	}

	async write(rel: string, bytes: ArrayBuffer, mtimeMs: number): Promise<void> {
		this.plugin.suppress(rel);
		const opts = mtimeMs > 0 ? { mtime: mtimeMs } : undefined;
		const existing = this.app.vault.getAbstractFileByPath(rel);
		if (existing instanceof TFile) {
			await this.app.vault.modifyBinary(existing, bytes, opts);
			return;
		}
		if (this.isHiddenPath(rel)) {
			const parts = pathParent(rel).split("/").filter(Boolean);
			let cur = "";
			for (const p of parts) {
				cur = cur ? `${cur}/${p}` : p;
				if (!(await this.app.vault.adapter.exists(cur))) {
					try {
						await this.app.vault.adapter.mkdir(cur);
					} catch {
						/* raced into existence */
					}
				}
			}
			await this.app.vault.adapter.writeBinary(rel, bytes, opts);
			return;
		}
		const parts = pathParent(rel).split("/").filter(Boolean);
		let cur = "";
		for (const p of parts) {
			cur = cur ? `${cur}/${p}` : p;
			if (!this.app.vault.getAbstractFileByPath(cur)) {
				try {
					await this.app.vault.createFolder(cur);
				} catch {
					/* raced into existence */
				}
			}
		}
		await this.app.vault.createBinary(rel, bytes, opts);
	}

	async stat(rel: string): Promise<{ mtime: number; size: number } | null> {
		const st = await this.app.vault.adapter.stat(rel);
		return st && st.type === "file" ? { mtime: st.mtime, size: st.size } : null;
	}

	exists(rel: string): Promise<boolean> {
		return this.app.vault.adapter.exists(rel);
	}

	/** Local deletes always go to a trash, never straight to oblivion:
	 *  system trash first, the vault's .trash folder as the fallback. */
	async trash(rel: string): Promise<void> {
		this.plugin.suppress(rel);
		const f = this.app.vault.getAbstractFileByPath(rel);
		if (f) {
			// trashFile honors the vault's own "Deleted files" preference, which
			// the system-trash-then-local fallback here was only approximating
			await this.app.fileManager.trashFile(f);
			return;
		}
		const ad = this.app.vault.adapter;
		try {
			const ok = await ad.trashSystem(rel);
			if (!ok) await ad.trashLocal(rel);
		} catch {
			try {
				await ad.trashLocal(rel);
			} catch {
				/* nothing to trash */
			}
		}
	}
}

/* ---------------- modals ---------------- */

/** Guided setup. One flow owns the decisions that used to be scattered and
 *  order-sensitive: sign in, folder, and encryption-before-first-sync. It
 *  also recognizes a device that received settings from vault-config sync
 *  but has no sign-in of its own, and asks only for what that device needs. */
const WIZ_STEPS = ["welcome", "connect", "folder", "privacy", "done"] as const;
type WizStep = (typeof WIZ_STEPS)[number];

class SetupWizard extends Modal {
	private step: WizStep = "welcome";
	private joining: boolean;
	private initialFolder: string;
	private folderVal: string;
	private verifier = "";
	private codeVal = "";
	private probe: { state: "empty" | "plain" | "encrypted"; files: number; marker: Marker | null } | null = null;
	private privacy: "off" | "secrets" | "on" | null = null;
	private protectionActive = false;
	private wizClosed = false;
	private pass = "";
	private pass2 = "";

	constructor(
		app: App,
		private plugin: PowerConnectPlugin,
		/** Open straight at a step. Re-authorizing is the case that needs it:
		 *  a connected device otherwise lands on the folder step and never
		 *  passes the sign-in screen at all. */
		private startStep: WizStep | null = null
	) {
		super(app);
		this.joining = !!(plugin.settings.appKey || plugin.settings.odClientId || plugin.settings.gClientId || plugin.settings.remoteFolder) && !plugin.remote.connected;
		this.initialFolder = plugin.settings.remoteFolder;
		this.folderVal = plugin.settings.remoteFolder;
	}

	onOpen() {
		if (this.startStep) this.step = this.startStep;
		else if (this.plugin.remote.connected) this.step = "folder";
		this.render();
	}

	onClose() {
		this.app.saveLocalStorage("pcon-setup-dismissed", "1");
		this.wizClosed = true;
		this.contentEl.empty();
	}

	private go(step: WizStep) {
		this.step = step;
		this.render();
	}

	/** Phone keyboards cover the lower half of the modal; a focused field
	 *  scrolls itself into the visible half once the keyboard settles. */
	private keyboardSafe(t: { inputEl: HTMLInputElement }) {
		t.inputEl.addEventListener("focus", () => window.setTimeout(() => t.inputEl.scrollIntoView({ block: "center", behavior: "smooth" }), 250));
	}

	private rootPath(): string {
		return "/" + sanitizeRemoteFolder(this.folderVal || this.app.vault.getName());
	}

	/** Privacy changes write the folder marker, which a running sync owns.
	 *  Rather than bouncing the user, wait the run out and apply right
	 *  after; the footer button stays disabled meanwhile. */
	private async waitForIdle(): Promise<boolean> {
		if (!this.plugin.running) return true;
		new Notice("Power Connect: waiting for the current sync to finish; this applies right after.", 8000);
		const t0 = Date.now();
		while (this.plugin.running && Date.now() - t0 < 30 * 60_000) await sleep(1000);
		return !this.plugin.running;
	}

	private startOverFlow() {
		new ConfirmModal(
			this.app,
			"Start over on this device?",
			"This device's Power Connect settings, sign-in, and sync journal are erased so setup starts from nothing. Your notes and everything in Dropbox stay untouched.",
			"Erase and start over",
			() =>
				void this.plugin.forgetThisDevice().then(() => {
					this.joining = false;
					this.folderVal = "";
					this.initialFolder = "";
					this.step = "welcome";
					this.render();
				})
		).open();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("pcon-modal");
		this.titleEl.setText("Set up Power Connect");
		const dots = contentEl.createDiv({ cls: "pcon-wiz-dots" });
		const at = WIZ_STEPS.indexOf(this.step);
		WIZ_STEPS.forEach((s, i) => dots.createSpan({ cls: "pcon-wiz-dot" + (i === at ? " is-active" : i < at ? " is-done" : "") }));
		if (this.step === "welcome") this.stepWelcome();
		else if (this.step === "connect") this.stepConnect();
		else if (this.step === "folder") this.stepFolder();
		else if (this.step === "privacy") this.stepPrivacy();
		else this.stepDone();
	}

	private footer(opts: { back?: WizStep; alt?: { label: string; onClick: () => void }; nextLabel?: string; onNext?: () => void | Promise<void> }) {
		const f = this.contentEl.createDiv({ cls: "pcon-wiz-footer" });
		const bar = new Setting(f);
		if (opts.back) bar.addButton((b) => b.setButtonText("Back").onClick(() => this.go(opts.back as WizStep)));
		if (opts.alt) bar.addButton((b) => b.setButtonText(opts.alt!.label).onClick(opts.alt!.onClick));
		if (opts.nextLabel && opts.onNext) {
			bar.addButton((b) =>
				b
					.setButtonText(opts.nextLabel as string)
					.setCta()
					.onClick(async () => {
						b.setDisabled(true);
						try {
							await opts.onNext?.();
						} catch (e) {
							new Notice(`Power Connect: ${msg(e)}`, 8000);
						} finally {
							b.setDisabled(false);
						}
					})
			);
		}
	}

	private stepWelcome() {
		const c = this.contentEl;
		if (this.joining) {
			c.createEl("p", {
				text: `This vault already has Power Connect settings${this.plugin.settings.remoteFolder ? ` (Dropbox folder "${this.plugin.settings.remoteFolder}")` : ""}, from an earlier setup here or from another device. Sign in to use them as they are${this.plugin.settings.e2eEnabled ? " (the encryption passphrase is also entered per device)" : ""}, or start over and choose everything again.`,
				cls: "pcon-muted",
			});
		} else {
			c.createEl("p", {
				text: "Power Connect syncs this vault with a folder in your own cloud storage account. Nothing passes through any other server, and nothing here needs a subscription.",
				cls: "pcon-muted",
			});
			new Setting(c)
				.setName("Storage provider")
				.setDesc("A vault syncs through one provider. Google Drive sign-in needs a desktop for now.")
				.addDropdown((d) => {
					d.addOption("dropbox", "Dropbox").addOption("onedrive", "OneDrive").addOption("gdrive", "Google Drive (beta)");
					d.setValue(this.plugin.settings.provider).onChange((v) => {
						this.plugin.settings.provider = v as "dropbox" | "onedrive" | "gdrive";
						this.plugin.queueSave();
						this.render();
					});
				});
		}
		const basePath = ((this.app.vault.adapter as unknown as { basePath?: string }).basePath ?? "").toLowerCase();
		const cloudFolder = ["dropbox", "onedrive", "icloud", "google drive"].find((n) => basePath.includes(n));
		const obsSync = !!(this.app as unknown as { internalPlugins?: { plugins?: Record<string, { enabled?: boolean }> } }).internalPlugins?.plugins?.sync?.enabled;
		if (obsSync || cloudFolder) {
			const w = c.createDiv({ cls: "pcon-warnbox" });
			if (obsSync)
				w.createEl("p", {
					text: "Obsidian Sync is on for this vault. That is fine during a move: run both, get every device onto Power Connect, then turn Obsidian Sync off (Settings, Sync). Two systems syncing the same files long-term invites duplicate conflict copies.",
				});
			if (cloudFolder)
				w.createEl("p", {
					text: `This vault lives inside a ${cloudFolder}-synced folder on disk. Folder-level sync plus Power Connect means two systems moving the same files; keep only one, or point Power Connect at a vault outside that folder.`,
				});
		}
		this.footer({
			// a connected device still needs a way back to sign-in: a token
			// carries the permissions it was minted with, so adding a
			// permission in the provider's console changes nothing here until
			// this device authorizes again
			alt: this.joining
				? !this.plugin.remote.connected
					? { label: "Start over", onClick: () => this.startOverFlow() }
					: undefined
				: this.plugin.remote.connected
					? { label: "Sign in again", onClick: () => this.go("connect") }
					: undefined,
			nextLabel: this.plugin.remote.connected ? "Continue" : this.joining ? "Sign in on this device" : "Get started",
			onNext: () => this.go(this.plugin.remote.connected ? "folder" : "connect"),
		});
	}

	/** A client id field shared by every provider branch: accepts a setup
	 *  code (which also picks the provider) or a plain id for the provider
	 *  currently chosen. */
	private applyIdInput = (v: string): void => {
		const s = this.plugin.settings;
		const code = parseSetupCode(v);
		if (code) {
			s.provider = code.provider;
			if (code.provider === "onedrive") s.odClientId = code.clientId;
			else if (code.provider === "gdrive") {
				s.gClientId = code.clientId;
				if (code.clientSecret) s.gClientSecret = code.clientSecret;
			} else s.appKey = code.clientId;
			if (code.folder) this.folderVal = code.folder;
			this.plugin.queueSave();
			new Notice("Power Connect: setup code accepted; the provider, key, and folder are filled in.");
			this.render();
			return;
		}
		if (looksLikeSetupCode(v)) {
			new Notice("Power Connect: that looks like a setup code, but it could not be read. Copy the whole code and paste it again.", 8000);
			return;
		}
		if (s.provider === "onedrive") s.odClientId = v.trim();
		else if (s.provider === "gdrive") s.gClientId = v.trim();
		else s.appKey = v.trim();
		this.plugin.queueSave();
	};

	private idField(c: HTMLElement, name: string, value: string) {
		new Setting(c)
			.setName(name)
			.addText((t) => {
				t.setPlaceholder("client id, or a setup code from another device")
					.setValue(value)
					.onChange(this.applyIdInput);
				t.inputEl.addClass("pcon-wide-input");
				this.keyboardSafe(t);
			})
			.addExtraButton((b) =>
				b
					.setIcon("clipboard-paste")
					.setTooltip("Paste")
					.onClick(async () => {
						try {
							const txt = (await navigator.clipboard.readText()).trim();
							if (txt) this.applyIdInput(txt);
						} catch {
							new Notice("Power Connect: paste is not available here; tap the field and paste instead.");
						}
					})
			);
	}

	private stepConnectOneDrive() {
		const c = this.contentEl;
		const s = this.plugin.settings;
		if (!s.odClientId) {
			c.createEl("p", {
				text: "One-time: register an app of your own in the Microsoft Entra portal, paste its client id here, then sign in. The app can only ever see its own folder in OneDrive.",
				cls: "pcon-muted",
			});
			const steps = c.createEl("ol", { cls: "pcon-steps" });
			const li1 = steps.createEl("li");
			li1.appendText("Open App registrations and choose New registration; name it anything (for example Power Connect). ");
			const open = li1.createEl("a", { text: "Open the Entra portal", href: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" });
			open.setAttr("target", "_blank");
			steps.createEl("li", { text: "Supported account types: pick the option that includes personal Microsoft accounts, then press Register." });
			steps.createEl("li", { text: "Open the app's Authentication page, set Allow public client flows to Yes, and save." });
			steps.createEl("li", { text: "Copy the Application (client) ID from the Overview page and paste it below." });
			steps.createEl("li", { text: "Press Start Microsoft sign-in below and follow the code it shows." });
		} else {
			c.createEl("p", { text: "A client id is already saved. Sign in on this device with the short code below.", cls: "pcon-muted" });
		}
		this.idField(c, "Client id", s.odClientId);
		const signWrap = c.createDiv();
		new Setting(c)
			.setName("Sign in")
			.setDesc("Shows a short code; enter it at Microsoft's device sign-in page in any browser, on any device.")
			.addButton((b) =>
				b
					.setButtonText("Start Microsoft sign-in")
					.setCta()
					.onClick(async () => {
						const id = s.odClientId.trim();
						if (!id) {
							new Notice("Paste your Azure client id first.");
							return;
						}
						const bad = clientIdProblem("onedrive", id);
						if (bad) {
							new Notice(`Power Connect: ${bad}`, 10000);
							return;
						}
						b.setDisabled(true);
						try {
							const dc = await onedriveDeviceCode(id);
							signWrap.empty();
							signWrap.createEl("p", { text: `Enter this code: ${dc.user_code}`, cls: "pcon-od-code" });
							const p = signWrap.createEl("p", { cls: "pcon-muted" });
							p.appendText("At ");
							const a = p.createEl("a", { text: dc.verification_uri, href: dc.verification_uri });
							a.setAttr("target", "_blank");
							p.appendText(", on this device or any other. Waiting for the sign-in...");
							const tok = await onedrivePollToken(id, dc, () => this.wizClosed);
							s.odRefresh = tok.refresh;
							s.odAccess = tok.access;
							s.odExpiry = tok.expiry;
							this.plugin.queueSave();
							const who = await this.plugin.onedrive.account();
							s.odAccount = who.email;
							this.plugin.queueSave();
							this.plugin.applySettings();
							this.plugin.refreshSettingsTab?.();
							this.plugin.log("info", `Connected to OneDrive as ${who.email}.`);
							this.go("folder");
						} catch (e) {
							new Notice(`Power Connect: ${msg(e)}`, 8000);
							b.setDisabled(false);
						}
					})
			);
		this.footer({ back: "welcome", alt: this.joining ? { label: "Start over instead", onClick: () => this.startOverFlow() } : undefined });
	}

	private stepConnectGDrive() {
		const c = this.contentEl;
		const s = this.plugin.settings;
		if (Platform.isMobileApp) {
			c.createDiv({ cls: "pcon-warnbox", text: "Google Drive sign-in needs a desktop for now. Connect this vault on a desktop first; each device signs in for itself, so phones can join once a desktop sign-in flow has proven the folder." });
			this.footer({ back: "welcome" });
			return;
		}
		if (!s.gClientId) {
			c.createEl("p", {
				text: "One-time: create an OAuth desktop client in Google Cloud, paste its id and secret here, then sign in. With the drive.file scope the app can only ever see the folder it creates.",
				cls: "pcon-muted",
			});
			const steps = c.createEl("ol", { cls: "pcon-steps" });
			const li1 = steps.createEl("li");
			li1.appendText("Create (or pick) a project and enable the Google Drive API. ");
			const open = li1.createEl("a", { text: "Open the Google Cloud console", href: "https://console.cloud.google.com/apis/library/drive.googleapis.com" });
			open.setAttr("target", "_blank");
			steps.createEl("li", { text: "Configure the OAuth consent screen (External is fine) and add yourself as a test user." });
			steps.createEl("li", { text: "Under Credentials, create an OAuth client ID of type Desktop app." });
			steps.createEl("li", { text: "Copy the client ID and client secret below, then press Sign in with Google." });
		} else {
			c.createEl("p", { text: "A client id is already saved. Sign in on this desktop; the browser comes back here by itself.", cls: "pcon-muted" });
		}
		this.idField(c, "Client id", s.gClientId);
		new Setting(c).setName("Client secret").addText((t) => {
			t.setPlaceholder("for installed apps this is shared, not secret")
				.setValue(s.gClientSecret)
				.onChange((v) => {
					s.gClientSecret = v.trim();
					this.plugin.queueSave();
				});
			t.inputEl.addClass("pcon-wide-input");
			this.keyboardSafe(t);
		});
		new Setting(c)
			.setName("Sign in")
			.setDesc("Opens Google in your browser; approving there finishes here on its own.")
			.addButton((b) =>
				b
					.setButtonText("Sign in with Google")
					.setCta()
					.onClick(async () => {
						if (!s.gClientId.trim() || !s.gClientSecret.trim()) {
							new Notice("Paste the Google client id and secret first.");
							return;
						}
						const bad = clientIdProblem("gdrive", s.gClientId);
						if (bad) {
							new Notice(`Power Connect: ${bad}`, 10000);
							return;
						}
						b.setDisabled(true);
						try {
							const tok = await gdriveSignIn(s.gClientId.trim(), s.gClientSecret.trim(), (url) => window.open(url, "_blank"));
							s.gRefresh = tok.refresh;
							s.gAccess = tok.access;
							s.gExpiry = tok.expiry;
							this.plugin.queueSave();
							const who = await this.plugin.gdrive.account();
							s.gAccount = who.email;
							this.plugin.queueSave();
							this.plugin.applySettings();
							this.plugin.refreshSettingsTab?.();
							this.plugin.log("info", `Connected to Google Drive as ${who.email}.`);
							this.go("folder");
						} catch (e) {
							new Notice(`Power Connect: ${msg(e)}`, 8000);
							b.setDisabled(false);
						}
					})
			);
		this.footer({ back: "welcome", alt: this.joining ? { label: "Start over instead", onClick: () => this.startOverFlow() } : undefined });
	}

	private stepConnect() {
		if (this.plugin.settings.provider === "onedrive") return this.stepConnectOneDrive();
		if (this.plugin.settings.provider === "gdrive") return this.stepConnectGDrive();
		const c = this.contentEl;
		if (!this.joining || !this.plugin.settings.appKey) {
			c.createEl("p", {
				text: "One-time: create a Dropbox app of your own, paste its key here, then authorize. The app can only ever see its own folder, never the rest of your Dropbox.",
				cls: "pcon-muted",
			});
			const steps = c.createEl("ol", { cls: "pcon-steps" });
			const li1 = steps.createEl("li");
			li1.appendText("In the Dropbox App Console choose Create app, pick Scoped access, then App folder, and name it anything (for example Power Connect). ");
			const open = li1.createEl("a", { text: "Open the App Console", href: "https://www.dropbox.com/developers/apps" });
			open.setAttr("target", "_blank");
			const li2 = steps.createEl("li");
			li2.appendText("On the app's Permissions tab enable these permissions, then press Submit.");
			const scopes = li2.createEl("ul", { cls: "pcon-scopes" });
			// sharing.write is what lets this vault publish shares to other
			// people. It grants no view of anything outside the app folder;
			// leaving it off simply means shares cannot be created here.
			for (const scope of ["account_info.read", "files.metadata.read", "files.content.read", "files.content.write", "sharing.write"]) {
				scopes.createEl("li", { text: scope });
			}
			steps.createEl("li", { text: "Click the app's Settings tab, copy the App key, and paste it below. (The App secret is never needed.)" });
			steps.createEl("li", { text: "Press Open Dropbox authorization below, approve access in your browser, and paste the code Dropbox shows back into this wizard." });
		} else {
			c.createEl("p", {
				text: "An app key is already saved. Authorize this device, and paste the code Dropbox shows you. If Dropbox reports the app is disabled or missing, go back and choose Start over to create a new app.",
				cls: "pcon-muted",
			});
		}

		new Setting(c)
			.setName("App key")
			.addText((t) => {
				t.setPlaceholder("app key, or a setup code from another device")
					.setValue(this.plugin.settings.appKey)
					.onChange(this.applyIdInput);
				t.inputEl.addClass("pcon-wide-input");
				this.keyboardSafe(t);
			})
			.addExtraButton((b) =>
				b
					.setIcon("clipboard-paste")
					.setTooltip("Paste")
					.onClick(async () => {
						try {
							const txt = (await navigator.clipboard.readText()).trim();
							if (txt) this.applyIdInput(txt);
						} catch {
							new Notice("Power Connect: paste is not available here; tap the field and paste instead.");
						}
					})
			);

		new Setting(c)
			.setName("Authorize")
			.setDesc("Opens Dropbox in your browser. Approve access, and Dropbox shows a code to paste below.")
			.addButton((b) =>
				b
					.setButtonText("Open Dropbox authorization")
					.setCta()
					.onClick(async () => {
						const key = this.plugin.settings.appKey.trim();
						if (!key) {
							new Notice("Paste your Dropbox app key first.");
							return;
						}
						const bad = clientIdProblem("dropbox", key);
						if (bad) {
							new Notice(`Power Connect: ${bad}`, 10000);
							return;
						}
						this.verifier = randB64url(48);
						const challenge = await pkceChallenge(this.verifier);
						const url = authUrl(key, challenge);
						// window.open is a no-op inside the mobile shell; the
						// visible link below is the path that always works
						window.open(url, "_blank");
						authLink.setAttr("href", url);
						linkWrap.show();
						codeWrap.show();
					})
			);

		let codeInput: { setValue(v: string): unknown } | null = null;
		const linkWrap = c.createDiv();
		const linkP = linkWrap.createEl("p", { cls: "pcon-muted" });
		linkP.appendText("If your browser did not open, ");
		const authLink = linkP.createEl("a", { text: "tap here for the Dropbox authorization page", href: "#" });
		authLink.setAttr("target", "_blank");
		linkP.appendText(", then come back and paste the code.");
		linkWrap.hide();

		const codeWrap = c.createDiv();
		new Setting(codeWrap)
			.setName("Authorization code")
			.setDesc("Paste the code Dropbox showed you.")
			.addText((t) => {
				t.setPlaceholder("paste the code here")
					.setValue(this.codeVal)
					.onChange((v) => (this.codeVal = v));
				t.inputEl.addClass("pcon-wide-input");
				this.keyboardSafe(t);
				codeInput = t;
			})
			.addExtraButton((b) =>
				b
					.setIcon("clipboard-paste")
					.setTooltip("Paste")
					.onClick(async () => {
						try {
							const txt = (await navigator.clipboard.readText()).trim();
							if (!txt) return;
							this.codeVal = txt;
							codeInput?.setValue(txt);
						} catch {
							new Notice("Power Connect: paste is not available here; tap the field and paste instead.");
						}
					})
			);
		if (!this.verifier) codeWrap.hide();

		this.footer({
			back: "welcome",
			alt: this.joining ? { label: "Start over instead", onClick: () => this.startOverFlow() } : undefined,
			nextLabel: "Connect",
			onNext: async () => {
				const key = this.plugin.settings.appKey.trim();
				if (!key || !this.codeVal.trim() || !this.verifier) {
					new Notice("Authorize first, then paste the code.");
					return;
				}
				const t = await exchangeCode(key, this.codeVal, this.verifier);
				if (!t.refresh_token) throw new DropboxError("Dropbox returned no refresh token; check the app key and try again.");
				this.plugin.settings.refreshToken = t.refresh_token;
				this.plugin.settings.accessToken = t.access_token;
				this.plugin.settings.accessExpiry = Date.now() + t.expires_in * 1000;
				const who = await this.plugin.remote.account();
				this.plugin.settings.accountEmail = who.email;
				this.plugin.queueSave();
				this.plugin.applySettings();
				this.plugin.log("info", `Connected to Dropbox as ${who.email}.`);
				this.plugin.refreshSettingsTab?.();
				this.go("folder");
			},
		});
	}

	private stepFolder() {
		const c = this.contentEl;
		c.createEl("p", {
			text: "The folder under Apps that holds this vault. Every device syncing this vault must use the same name; leave it empty to use the vault's own name.",
			cls: "pcon-muted",
		});
		new Setting(c).setName(`${this.plugin.remote.name} folder`).addText((t) => {
			t.setPlaceholder(this.app.vault.getName())
				.setValue(this.folderVal)
				.onChange((v) => {
					this.folderVal = v;
					this.probe = null;
				});
			t.inputEl.addClass("pcon-wide-input");
			this.keyboardSafe(t);
		});
		const result = c.createDiv({ cls: "pcon-muted pcon-wiz-result" });
		this.footer({
			back: this.plugin.remote.connected ? "welcome" : "connect",
			nextLabel: "Next",
			onNext: async () => {
				result.setText("Looking at the folder...");
				this.probe = await this.plugin.probeFolder(this.folderVal);
				if (this.folderVal !== this.plugin.settings.remoteFolder) {
					this.plugin.settings.remoteFolder = this.folderVal;
					this.plugin.queueSave();
					this.plugin.applySettings();
				}
				// a folder change orphans the old journal; re-merging by
				// content is always safe and needs no user decision
				if (this.folderVal !== this.initialFolder) await this.plugin.resetState();
				this.go("privacy");
			},
		});
	}

	private stepPrivacy() {
		const c = this.contentEl;
		const p = this.probe;
		if (p?.state === "encrypted") {
			c.createEl("p", {
				text: "This folder holds an end-to-end encrypted copy. Enter the same passphrase you chose when encrypting it; it is checked against the folder before anything is touched, so a typo cannot corrupt files.",
				cls: "pcon-muted",
			});
			new Setting(c).setName("Passphrase").addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("passphrase").onChange((v) => (this.pass = v));
				t.inputEl.addClass("pcon-wide-input");
				this.keyboardSafe(t);
			});
			this.footer({
				back: "folder",
				nextLabel: "Verify and continue",
				onNext: async () => {
					const key = await deriveKey(this.pass, p.marker?.salt ?? "");
					if (!(await verifyCheck(key, p.marker?.check ?? ""))) {
						new Notice("Power Connect: that passphrase does not match this folder.", 8000);
						return;
					}
					this.plugin.settings.e2ePassphrase = this.pass;
					this.plugin.settings.e2eEnabled = true;
					this.plugin.queueSave();
					this.plugin.engine.markerDirty();
					await this.plugin.adoptRemoteSettings(this.rootPath(), key);
					this.go("done");
				},
			});
			return;
		}
		if (p?.state === "plain" && p.marker?.secrets) {
			// joining a plain folder whose plugin settings files are protected
			c.createEl("p", {
				text: `This folder holds ${p.files} file(s); notes are unencrypted, and plugin settings files are protected with a passphrase. Enter it to sync them on this device; everything else syncs either way.`,
				cls: "pcon-muted",
			});
			new Setting(c).setName("Passphrase").addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("passphrase").onChange((v) => (this.pass = v));
				t.inputEl.addClass("pcon-pass-input");
				this.keyboardSafe(t);
			});
			this.footer({
				back: "folder",
				alt: {
					label: "Skip for now",
					onClick: () => {
						void this.plugin.adoptRemoteSettings(this.rootPath(), null).then(() => this.go("done"));
					},
				},
				nextLabel: "Verify and continue",
				onNext: async () => {
					const sec = p.marker!.secrets!;
					const key = await deriveKey(this.pass, sec.salt);
					if (!(await verifyCheck(key, sec.check))) {
						new Notice("Power Connect: that passphrase does not match this folder.", 8000);
						return;
					}
					this.plugin.settings.e2ePassphrase = this.pass;
					this.plugin.queueSave();
					this.plugin.engine.markerDirty();
					this.protectionActive = true;
					await this.plugin.adoptRemoteSettings(this.rootPath(), null);
					this.go("done");
				},
			});
			return;
		}
		// choosing: an empty folder offers everything; an existing plain copy
		// cannot flip to full encryption, but can gain protection
		const empty = p?.state !== "plain";
		if (this.privacy === null) this.privacy = empty ? "secrets" : "off";
		c.createEl("p", {
			text: empty
				? "This folder is empty, so privacy is a free choice; full encryption is decided per folder before the first upload. Protecting plugin settings files encrypts only those (they routinely hold API keys) while notes stay readable in Dropbox. Either way, the passphrase is entered once on each device, and losing it makes the protected content unreadable."
				: `This folder already holds ${p?.files ?? 0} unencrypted file(s), and this device will join that copy. Plugin settings files (they routinely hold API keys) can be protected here with a passphrase; choosing full encryption goes back a step for a fresh folder name and one full upload.`,
			cls: "pcon-muted",
		});
		new Setting(c)
			.setName("Privacy")
			.setDesc("Applies to this folder before anything uploads.")
			.addDropdown((d) => {
				d.addOption("secrets", "Protect plugin settings files (recommended)");
				d.addOption("off", "Off: everything uploads as it is");
				d.addOption("on", "Everything end-to-end encrypted");
				d.setValue(this.privacy as string).onChange((v) => {
					this.privacy = v as "off" | "secrets" | "on";
					this.render();
				});
			});
		if (this.privacy !== "off") {
			new Setting(c).setName("Passphrase").addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("passphrase")
					.setValue(this.pass)
					.onChange((v) => (this.pass = v));
				t.inputEl.addClass("pcon-pass-input");
				this.keyboardSafe(t);
			});
			new Setting(c).setName("Passphrase again").addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("same passphrase")
					.setValue(this.pass2)
					.onChange((v) => (this.pass2 = v));
				t.inputEl.addClass("pcon-pass-input");
				this.keyboardSafe(t);
			});
			c.createEl("p", { text: "Store it in a password manager now; it is never written to any synced file.", cls: "pcon-muted" });
		}
		this.footer({
			back: "folder",
			nextLabel: this.privacy === "on" ? "Encrypt this folder" : this.privacy === "secrets" ? "Protect and continue" : "Continue unencrypted",
			onNext: async () => {
				if (this.privacy === "on" && !empty) {
					new Notice("Power Connect: full encryption is chosen against an empty folder. Pick a fresh folder name; it re-uploads everything once.", 10000);
					this.go("folder");
					return;
				}
				if (this.privacy !== "off") {
					if (!this.pass || this.pass !== this.pass2) {
						new Notice("Power Connect: the passphrases are empty or do not match.");
						return;
					}
					this.plugin.settings.e2ePassphrase = this.pass;
					this.plugin.queueSave();
				}
				if (!(await this.waitForIdle())) {
					new Notice("Power Connect: the sync is still running; try again when it finishes.", 8000);
					return;
				}
				if (this.privacy === "on") {
					const err = await this.plugin.setEncryption(true);
					if (err) {
						new Notice(`Power Connect: ${err}`, 10000);
						return;
					}
				} else {
					if (this.plugin.settings.e2eEnabled) {
						// switching an encrypted setup to a plain folder:
						// without this, the still-on setting would stamp the
						// new folder encrypted at the next sync
						if (empty) {
							const err = await this.plugin.setEncryption(false);
							if (err) {
								new Notice(`Power Connect: ${err}`, 10000);
								return;
							}
						} else {
							this.plugin.settings.e2eEnabled = false;
							this.plugin.queueSave();
							this.plugin.engine.markerDirty();
						}
					}
					const err = await this.plugin.setSecretsProtection(this.privacy === "secrets");
					if (err) {
						new Notice(`Power Connect: ${err}`, 10000);
						return;
					}
					this.protectionActive = this.privacy === "secrets";
				}
				if (!empty) await this.plugin.adoptRemoteSettings(this.rootPath(), null);
				this.go("done");
			},
		});
	}

	private stepDone() {
		// the settings tab may be open behind this modal, rendered before the
		// wizard made its choices; bring it up to date
		this.plugin.refreshSettingsTab?.();
		const c = this.contentEl;
		const s = this.plugin.settings;
		c.createEl("p", { text: "This device is ready.", cls: "pcon-muted" });
		const ul = c.createEl("ul", { cls: "pcon-steps" });
		ul.createEl("li", { text: `Account: ${this.plugin.accountLabel() || "connected"} (${this.plugin.remote.name})` });
		ul.createEl("li", { text: `Dropbox folder: ${s.remoteFolder || this.app.vault.getName()}` });
		ul.createEl("li", {
			text: s.e2eEnabled
				? "Encryption: on for everything (per-device passphrase)"
				: this.protectionActive
					? "Plugin settings files: protected (per-device passphrase); notes upload plain"
					: "Encryption: off",
		});
		c.createEl("p", {
			text: "Preview shows the exact plan (every upload, download, and delete) before anything happens. On each additional device, this same setup opens and asks only for that device's sign-in" + (s.e2eEnabled ? " and the passphrase." : "."),
			cls: "pcon-muted",
		});
		const bar = new Setting(c.createDiv({ cls: "pcon-wiz-footer" }));
		bar.addButton((b) => b.setButtonText("Add another device").onClick(() => new AddDeviceModal(this.app, this.plugin).open()));
		bar.addButton((b) =>
			b.setButtonText("Preview first sync").onClick(() => {
				this.close();
				void this.plugin.previewSync();
			})
		);
		bar.addButton((b) =>
			b
				.setButtonText("Sync now")
				.setCta()
				.onClick(() => {
					this.close();
					void this.plugin.syncNow("setup", true);
				})
		);
	}
}

/** The other side of the setup code: what to do on a new computer or phone,
 *  with the code that fills the wizard there. */
class AddDeviceModal extends Modal {
	constructor(
		app: App,
		private plugin: PowerConnectPlugin
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("pcon-modal");
		this.titleEl.setText("Add another device");
		const s = this.plugin.settings;
		const code = makeSetupCode({
			provider: s.provider,
			clientId: s.provider === "onedrive" ? s.odClientId : s.provider === "gdrive" ? s.gClientId : s.appKey,
			clientSecret: s.provider === "gdrive" ? s.gClientSecret : undefined,
			folder: s.remoteFolder || this.app.vault.getName(),
			e2e: s.e2eEnabled,
		});
		const steps = contentEl.createEl("ol", { cls: "pcon-steps" });
		steps.createEl("li", { text: "Install Obsidian on the device and open (or create) a vault for these notes. An empty vault fills itself on the first sync." });
		steps.createEl("li", {
			text: "Install and enable the Power Connect plugin there (community plugins, or copy the plugin folder from a GitHub release). This is the one manual install a device ever needs; updates arrive through sync afterwards.",
		});
		steps.createEl("li", { text: "The setup wizard opens on that device. Paste this setup code into the app key field; it fills in the key and the folder name." });
		steps.createEl("li", {
			text: s.e2eEnabled
				? `Sign in to  on that device and enter the encryption passphrase. Both stay on that device.`
				: `Sign in to  on that device.`,
		});
		steps.createEl("li", { text: "Preview the first sync, then let it run. Notes, settings, themes, and plugins arrive with it." });
		new Setting(contentEl)
			.setName("Setup code")
			.addText((t) => {
				t.setValue(code);
				t.inputEl.readOnly = true;
				t.inputEl.addClass("pcon-wide-input");
				t.inputEl.addEventListener("focus", () => t.inputEl.select());
			})
			.addButton((b) =>
				b
					.setButtonText("Copy")
					.setCta()
					.onClick(async () => {
						await navigator.clipboard.writeText(code);
						new Notice("Power Connect: setup code copied.");
					})
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class PlanModal extends Modal {
	constructor(
		app: App,
		private plugin: PowerConnectPlugin,
		private plan: Plan
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("pcon-modal");
		this.titleEl.setText("Sync preview");
		const p = this.plan;
		if (!p.actions.filter((a) => a.t !== "dropBase" && a.t !== "adopt").length) {
			contentEl.createEl("p", { text: p.adopts ? `Everything lines up: ${p.adopts} file(s) match by content and will pair up without any transfer.` : "Everything is in sync. Nothing to do." });
		}
		if (p.holdDeletes) {
			contentEl.createDiv({
				cls: "pcon-warnbox",
				text: "This plan deletes a large share of the vault, which usually means one side was moved or emptied. Look closely before syncing.",
			});
		}
		const section = (title: string, items: string[]) => {
			if (!items.length) return;
			contentEl.createEl("h4", { text: `${title} (${items.length})`, cls: "pcon-plan-h" });
			const list = contentEl.createDiv({ cls: "pcon-plan-list" });
			for (const it of items.slice(0, 150)) list.createDiv({ cls: "pcon-plan-item", text: it });
			if (items.length > 150) list.createDiv({ cls: "pcon-plan-item pcon-muted", text: `and ${items.length - 150} more` });
		};
		const of = (t: Action["t"]): string[] => p.actions.filter((a) => a.t === t).map((a) => ("path" in a ? a.path : "toPath" in a ? `${a.fromPath} to ${a.toPath}` : a.key));
		section("Upload to Dropbox", of("upload"));
		section("Download from Dropbox", of("download"));
		section("Move on Dropbox", of("moveRemote"));
		section("Conflicts to resolve", of("conflict"));
		section("Delete on Dropbox", of("deleteRemote"));
		section("Delete in this vault (to trash)", of("deleteLocal"));
		if (p.adopts) contentEl.createEl("p", { cls: "pcon-muted", text: `${p.adopts} file(s) already match by content and will pair up without any transfer.` });

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText("Sync now")
					.setCta()
					.onClick(() => {
						this.close();
						void this.plugin.syncNow("preview", true);
					})
			)
			.addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
	}

	onClose() {
		this.contentEl.empty();
	}
}

class DeleteHoldModal extends Modal {
	private resolve: ((v: "delete" | "skip" | "cancel") => void) | null = null;
	private answered = false;

	constructor(
		app: App,
		private plan: Plan
	) {
		super(app);
	}

	ask(): Promise<"delete" | "skip" | "cancel"> {
		return new Promise((res) => {
			this.resolve = res;
			this.open();
		});
	}

	private answer(v: "delete" | "skip" | "cancel") {
		if (!this.answered) {
			this.answered = true;
			this.resolve?.(v);
		}
		this.close();
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("pcon-modal");
		this.titleEl.setText("Review deletions");
		const n = this.plan.deletesLocal + this.plan.deletesRemote;
		contentEl.createEl("p", {
			text: `This sync wants to delete ${n} files (${this.plan.deletesLocal} here, ${this.plan.deletesRemote} on Dropbox). That is a large share of the vault, which usually means a folder was moved, renamed, or emptied on one side. Local deletions go to the trash, and Dropbox keeps 30 days of version history, but it is worth a look.`,
		});
		const list = contentEl.createDiv({ cls: "pcon-plan-list" });
		const paths = this.plan.actions.filter((a) => a.t === "deleteLocal" || a.t === "deleteRemote").map((a) => ("path" in a ? a.path : ""));
		for (const it of paths.slice(0, 30)) list.createDiv({ cls: "pcon-plan-item", text: it });
		if (paths.length > 30) list.createDiv({ cls: "pcon-plan-item pcon-muted", text: `and ${paths.length - 30} more` });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Sync without deleting").setCta().onClick(() => this.answer("skip")))
			.addButton((b) => markDestructive(b.setButtonText("Delete them")).onClick(() => this.answer("delete")))
			.addButton((b) => b.setButtonText("Cancel sync").onClick(() => this.answer("cancel")));
	}

	onClose() {
		this.contentEl.empty();
		if (!this.answered) {
			this.answered = true;
			this.resolve?.("cancel");
		}
	}
}

class ConflictModal extends Modal {
	private resolve: ((v: { choice: ConflictChoice; applyAll: boolean }) => void) | null = null;
	private answered = false;
	private applyAll = false;

	constructor(
		app: App,
		private path: string,
		private lMtime: number,
		private lSize: number,
		private rMtime: number,
		private rSize: number
	) {
		super(app);
	}

	ask(): Promise<{ choice: ConflictChoice; applyAll: boolean }> {
		return new Promise((res) => {
			this.resolve = res;
			this.open();
		});
	}

	private answer(choice: ConflictChoice) {
		if (!this.answered) {
			this.answered = true;
			this.resolve?.({ choice, applyAll: this.applyAll });
		}
		this.close();
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("pcon-modal");
		this.titleEl.setText("Sync conflict");
		contentEl.createEl("p", { text: this.path });
		const side = (label: string, mtime: number, size: number) =>
			contentEl.createDiv({ cls: "pcon-muted", text: `${label}: ${mtime ? new Date(mtime).toLocaleString() : "unknown time"}, ${fmtBytes(size)}` });
		side("This device", this.lMtime, this.lSize);
		side("Dropbox", this.rMtime, this.rSize);
		const applyRow = contentEl.createDiv({ cls: "pcon-applyall" });
		const cb = applyRow.createEl("input", { type: "checkbox" });
		cb.id = "pcon-applyall";
		applyRow.createEl("label", { text: "Do the same for every conflict in this sync" }).setAttr("for", "pcon-applyall");
		cb.addEventListener("change", () => (this.applyAll = cb.checked));
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Keep both").setCta().onClick(() => this.answer("both")))
			.addButton((b) => b.setButtonText("Keep this device's").onClick(() => this.answer("local")))
			.addButton((b) => b.setButtonText("Keep Dropbox's").onClick(() => this.answer("remote")));
	}

	onClose() {
		this.contentEl.empty();
		if (!this.answered) {
			this.answered = true;
			this.resolve?.({ choice: "both", applyAll: false });
		}
	}
}

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private body: string,
		private cta: string,
		private onConfirm: () => void
	) {
		super(app);
	}

	onOpen() {
		this.contentEl.addClass("pcon-modal");
		this.titleEl.setText(this.title);
		this.contentEl.createEl("p", { text: this.body });
		new Setting(this.contentEl)
			.addButton((b) =>
				markDestructive(b)
					.setButtonText(this.cta)
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
	}

	onClose() {
		this.contentEl.empty();
	}
}

class LogModal extends Modal {
	constructor(
		app: App,
		private plugin: PowerConnectPlugin
	) {
		super(app);
	}

	private level = "all";
	private filter = "";

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("pcon-modal");
		this.titleEl.setText("Sync log");
		const bar = contentEl.createDiv({ cls: "pcon-log-bar" });
		const levelSel = bar.createEl("select", { cls: "dropdown" });
		for (const [v, label] of [
			["all", "All"],
			["info", "Info and up"],
			["warn", "Warnings and errors"],
			["error", "Errors only"],
		] as const) {
			const o = levelSel.createEl("option", { text: label });
			o.value = v;
		}
		levelSel.value = this.level;
		const search = bar.createEl("input", { cls: "pcon-log-filter" });
		search.type = "search";
		search.placeholder = "Filter...";
		search.value = this.filter;
		const rank: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
		const min = () => (this.level === "all" ? 0 : rank[this.level]);
		const list = contentEl.createDiv({ cls: "pcon-log" });
		const render = () => {
			list.empty();
			const q = this.filter.toLowerCase();
			const rows = this.plugin.logRing.filter((e) => rank[e.level] >= min() && (!q || e.msg.toLowerCase().includes(q)));
			if (!rows.length) list.createDiv({ cls: "pcon-muted", text: this.plugin.logRing.length ? "Nothing matches the filter." : "Nothing logged yet this session." });
			for (const e of rows) {
				const row = list.createDiv({ cls: `pcon-log-row pcon-log-${e.level}` });
				row.createSpan({ cls: "pcon-log-ts", text: fmtClock(e.ts) });
				row.createSpan({ text: e.msg });
			}
			list.scrollTop = list.scrollHeight;
		};
		levelSel.addEventListener("change", () => {
			this.level = levelSel.value;
			render();
		});
		search.addEventListener("input", () => {
			this.filter = search.value;
			render();
		});
		render();
		this.plugin.logChanged = render;
		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Copy").onClick(async () => {
					const text = this.plugin.logRing.map((e) => `${new Date(e.ts).toISOString()} ${e.level.toUpperCase()} ${e.msg}`).join("\n");
					await navigator.clipboard.writeText(text);
					new Notice("Sync log copied.");
				})
			)
			.addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
	}

	onClose() {
		this.plugin.logChanged = null;
		this.contentEl.empty();
	}
}

/* ---------------- settings tab ---------------- */

/** Starting a share. Shows exactly what will leave this vault before
 *  anything does: a share is the one Power Connect operation whose blast
 *  radius is other people, so "I did not realize that folder was included"
 *  has to be impossible to reach by accident. */
class CreateShareModal extends Modal {
	private name = "";
	private preview: ResolveResult | null = null;
	private audit: { embeds: string[]; links: string[] } | null = null;
	private includeEmbeds = true;
	private busy = false;

	constructor(
		app: App,
		private plugin: PowerConnectPlugin,
		private seed: { homePath: string; attached: string[] }
	) {
		super(app);
		const base = seed.homePath || seed.attached[0] || "";
		this.name = base ? base.split("/").pop()?.replace(/\.md$/i, "") || "Shared notes" : "Shared notes";
	}

	onOpen() {
		this.render();
		void (async () => {
			this.preview = await this.plugin.shareFiles(this.seed);
			this.audit = await this.plugin.shareLinkAudit(this.seed);
			this.render();
		})();
	}

	onClose() {
		this.contentEl.empty();
	}

	private render() {
		const c = this.contentEl;
		c.empty();
		this.titleEl.setText("Share with someone");

		new Setting(c).setDesc(
			this.seed.homePath
				? `Everything in "${this.seed.homePath}" is shared, including anything you add to it later.`
				: "The notes you picked are shared. You can add more to this share afterwards."
		);

		new Setting(c)
			.setName("Name")
			.setDesc("What the other person sees.")
			.addText((t) => t.setValue(this.name).onChange((v) => (this.name = v)));

		if (!this.preview) {
			new Setting(c).setName("Working out what will be shared...");
		} else {
			const n = this.preview.files.length;
			const bytes = this.preview.files.reduce((a, f) => a + f.size, 0);
			new Setting(c).setName(`${n.toLocaleString()} file(s), ${fmtBytes(bytes)}`).setDesc(n ? "These leave your vault, encrypted, and only the invite code opens them." : "Nothing to share yet.");
			if (this.preview.skipped.length) {
				const list = c.createEl("ul", { cls: "pcon-share-skipped" });
				for (const s of this.preview.skipped.slice(0, 8)) list.createEl("li", { text: `${s.local} (${s.why})` });
				if (this.preview.skipped.length > 8) list.createEl("li", { text: `and ${this.preview.skipped.length - 8} more` });
			}
		}

		if (this.audit?.embeds.length) {
			new Setting(c)
				.setName(`${this.audit.embeds.length} attachment(s) live outside this selection`)
				.setDesc("Images and files these notes embed. Left out, the other person sees a broken embed where each one should be.")
				.addToggle((t) => t.setValue(this.includeEmbeds).onChange((v) => (this.includeEmbeds = v)))
				.setClass("pcon-share-audit");
		}
		if (this.audit?.links.length) {
			new Setting(c)
				.setName(`${this.audit.links.length} link(s) point to notes you are not sharing`)
				.setDesc("Those links will lead nowhere for the other person. Often that is deliberate, so nothing is added on your behalf. You can add them later from Contents.");
		}

		new Setting(c).setDesc(
			"Nobody can read this share until you approve them. You will send an invite code, they will send a request back, and you decide. You can stop sharing at any time."
		);

		const foot = new Setting(c);
		foot.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
		foot.addButton((b) =>
			b
				.setButtonText(this.busy ? "Publishing..." : "Create share")
				.setCta()
				.setDisabled(this.busy || !this.preview || !this.preview.files.length)
				.onClick(async () => {
					this.busy = true;
					this.render();
					const attached = [...this.seed.attached];
					if (this.includeEmbeds) for (const p of this.audit?.embeds ?? []) if (!attached.includes(p)) attached.push(p);
					const share = await this.plugin.createShare({ name: this.name, homePath: this.seed.homePath, attached });
					this.close();
					if (share?.manifestUrl) new ShareInviteModal(this.app, this.plugin, share).open();
				})
		);
	}
}

/** The invite. One code, and a plain statement of what handing it over
 *  means. */
class ShareInviteModal extends Modal {
	constructor(
		app: App,
		private plugin: PowerConnectPlugin,
		private share: OwnedShare
	) {
		super(app);
	}

	onOpen() {
		const c = this.contentEl;
		this.titleEl.setText(`Invite to "${this.share.name}"`);
		const code = inviteFor(this.share, this.plugin.accountLabel() || "");

		new Setting(c).setDesc(
			"Send this code to the person you are sharing with. They paste it into Power Connect (Settings, Shares, or the command Receive a share) and the notes arrive in a folder they choose. They do not need a storage account of their own."
		);

		const box = c.createEl("textarea", { cls: "pcon-share-code" });
		box.value = code;
		box.rows = 4;
		box.readOnly = true;
		box.addEventListener("focus", () => box.select());

		new Setting(c)
			.setName("Keep it like a password")
			.setDesc("The code carries the key that opens this share. Anyone who gets hold of it can read the share, so send it through a message or email, never by posting it somewhere public.");

		// sending from the user's own mail client keeps this serverless: no
		// mail API key to store, no third party handling the invite
		let to = "";
		new Setting(c)
			.setName("Send by email")
			.setDesc("Opens your mail app with the invite ready to send. Their address is only kept here to label them in your list.")
			.addText((t) => t.setPlaceholder("them@example.com").onChange((v) => (to = v)))
			.addButton((b) =>
				b.setButtonText("Compose").onClick(() => {
					const subject = `Notes shared with you: ${this.share.name}`;
					const body = [
						`I am sharing "${this.share.name}" with you through Obsidian.`,
						"",
						"In Obsidian, install Power Connect, then run the command Receive a share (or Settings, Power Connect, Shares) and paste this code:",
						"",
						code,
						"",
						"It will show you a short request code. Send that back to me and I will approve you, and the notes will start arriving. You do not need a Dropbox account.",
					].join("\n");
					window.open(`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
					// a request code carries a name, not an address, so this
					// cannot be matched automatically later; recording it is
					// what lets the roster show who was asked and never replied
					if (to.trim()) {
						this.share.invitesSent = [...this.share.invitesSent.filter((i) => i.email !== to.trim()), { email: to.trim(), sentAt: Date.now() }];
						void this.plugin.persistSettings();
					}
				})
			);

		const foot = new Setting(c);
		foot.addButton((b) =>
			b
				.setButtonText("Copy invite code")
				.setCta()
				.onClick(async () => {
					await navigator.clipboard.writeText(code);
					new Notice("Power Connect: invite code copied.");
				})
		);
		foot.addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
	}

	onClose() {
		this.contentEl.empty();
	}
}

export const VIEW_TYPE_SHARES = "powerconnect-shares";

/** Every share, published and received, in one place.
 *
 *  A settings tab cannot hold this: it has no search, no sort, nowhere to
 *  surface the one thing that is time-sensitive (people waiting on a
 *  decision), and it closes the moment you go back to work. A vault with
 *  hundreds of shares needs a dense table, not a stack of cards. */
class SharesView extends ItemView {
	private query = "";
	private tab: "publish" | "receive" = "publish";
	private sortBy: "attention" | "name" | "published" = "attention";
	private readonly onData = () => this.render();

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: PowerConnectPlugin
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_SHARES;
	}

	getDisplayText(): string {
		return "Shares";
	}

	getIcon(): string {
		return "share-2";
	}

	async onOpen() {
		this.plugin.sharesChanged = this.onData;
		this.render();
	}

	async onClose() {
		if (this.plugin.sharesChanged === this.onData) this.plugin.sharesChanged = null;
	}

	private matches(hay: string[]): boolean {
		const q = this.query.trim().toLowerCase();
		if (!q) return true;
		return hay.some((h) => h.toLowerCase().includes(q));
	}

	render() {
		const root = this.contentEl;
		root.empty();
		root.addClass("pcon-shares-root");

		const head = root.createDiv({ cls: "pcon-shares-head" });
		const tabs = head.createDiv({ cls: "pcon-shares-tabs" });
		const waiting = this.plugin.settings.shares.reduce((n, s) => n + s.members.filter((m) => m.state === "pending").length, 0);
		for (const t of [
			{ id: "publish" as const, label: `Shared by you (${this.plugin.settings.shares.length})` },
			{ id: "receive" as const, label: `Shared with you (${this.plugin.settings.subscriptions.length})` },
		]) {
			const b = tabs.createEl("button", { cls: "pcon-shares-tab", text: t.label });
			b.toggleClass("is-active", this.tab === t.id);
			b.onclick = () => {
				this.tab = t.id;
				this.render();
			};
		}

		const tools = head.createDiv({ cls: "pcon-shares-tools" });
		const search = tools.createEl("input", { cls: "pcon-shares-search" });
		search.type = "search";
		search.placeholder = this.tab === "publish" ? "Search shares, folders, people..." : "Search shares...";
		search.value = this.query;
		search.oninput = () => {
			this.query = search.value;
			this.renderBody();
		};
		if (this.tab === "publish") {
			const sort = tools.createEl("select", { cls: "pcon-shares-sort" });
			for (const o of [
				{ v: "attention", t: "Needs attention first" },
				{ v: "name", t: "Name" },
				{ v: "published", t: "Recently published" },
			]) {
				sort.createEl("option", { value: o.v, text: o.t });
			}
			sort.value = this.sortBy;
			sort.onchange = () => {
				this.sortBy = sort.value as typeof this.sortBy;
				this.renderBody();
			};
			tools.createEl("button", { cls: "mod-cta", text: "Publish all" }).onclick = () => void this.plugin.publishAll();
		} else {
			tools.createEl("button", { cls: "mod-cta", text: "Paste invite code" }).onclick = () => new ReceiveShareModal(this.app, this.plugin).open();
		}

		if (waiting && this.tab === "publish") {
			const banner = root.createDiv({ cls: "pcon-shares-banner" });
			banner.setText(`${waiting} ${waiting === 1 ? "person is" : "people are"} waiting for you to approve or deny access.`);
		}

		this.bodyEl = root.createDiv({ cls: "pcon-shares-body" });
		this.renderBody();
	}

	private bodyEl: HTMLElement | null = null;

	private renderBody() {
		const body = this.bodyEl;
		if (!body) return;
		body.empty();
		if (this.tab === "publish") this.renderPublished(body);
		else this.renderReceived(body);
	}

	private row(table: HTMLElement, cells: (string | HTMLElement)[], cls = ""): HTMLElement {
		const tr = table.createDiv({ cls: `pcon-shares-row ${cls}` });
		for (const c of cells) {
			const td = tr.createDiv({ cls: "pcon-shares-cell" });
			if (typeof c === "string") td.setText(c);
			else td.appendChild(c);
		}
		return tr;
	}

	private renderPublished(body: HTMLElement) {
		const shares = this.plugin.settings.shares
			.filter((s) => this.matches([s.name, s.homePath, ...s.members.map((m) => m.name)]))
			.sort((a, b) => {
				if (this.sortBy === "name") return a.name.localeCompare(b.name);
				if (this.sortBy === "published") return b.publishedAt - a.publishedAt;
				const pa = a.members.filter((m) => m.state === "pending").length;
				const pb = b.members.filter((m) => m.state === "pending").length;
				return pb - pa || a.name.localeCompare(b.name);
			});

		if (!this.plugin.settings.shares.length) {
			body.createDiv({ cls: "pcon-shares-empty", text: "You are not sharing anything yet. Right-click a folder or a note in the file list and choose Share." });
			return;
		}
		if (!shares.length) {
			body.createDiv({ cls: "pcon-shares-empty", text: "No share matches that search." });
			return;
		}

		const table = body.createDiv({ cls: "pcon-shares-table" });
		this.row(table, ["Share", "Contents", "People", "Last published", ""], "is-header");
		for (const s of shares) {
			const pending = s.members.filter((m) => m.state === "pending").length;
			const approved = s.members.filter((m) => m.state === "approved").length;

			const people = createSpan();
			people.setText(`${approved} approved`);
			if (pending) people.createSpan({ cls: "pcon-shares-badge", text: `${pending} waiting` });

			const actions = createSpan({ cls: "pcon-shares-actions" });
			actions.createEl("button", { text: "Invite" }).onclick = () => new ShareInviteModal(this.app, this.plugin, s).open();
			const peopleBtn = actions.createEl("button", { cls: pending ? "mod-cta" : "", text: pending ? `People (${pending})` : "People" });
			peopleBtn.onclick = () => new ManageShareModal(this.app, this.plugin, s).open();
			actions.createEl("button", { text: "Contents" }).onclick = () => new ShareContentsModal(this.app, this.plugin, s).open();
			actions.createEl("button", { text: "Publish" }).onclick = () => void this.plugin.publishShareNow(s.id, true);
			actions.createEl("button", { cls: "mod-warning", text: "Stop" }).onclick = () => void this.plugin.deleteShare(s.id);

			this.row(table, [s.name, s.homePath || `${s.attached.length} note(s)`, people, s.publishedAt ? new Date(s.publishedAt).toLocaleString() : "not yet", actions]);
		}
	}

	private renderReceived(body: HTMLElement) {
		const subs = this.plugin.settings.subscriptions.filter((s) => this.matches([s.name, s.owner, s.localPath]));
		if (!this.plugin.settings.subscriptions.length) {
			body.createDiv({ cls: "pcon-shares-empty", text: "Nothing has been shared with you yet. Paste an invite code to receive one." });
			return;
		}
		if (!subs.length) {
			body.createDiv({ cls: "pcon-shares-empty", text: "No share matches that search." });
			return;
		}

		const table = body.createDiv({ cls: "pcon-shares-table" });
		this.row(table, ["Share", "From", "Lands in", "Status", ""], "is-header");
		for (const sub of subs) {
			const st = this.plugin.shareStates[sub.id];
			const files = st ? Object.keys(st.entries).length : 0;
			const status = createSpan();
			if (!sub.key) status.createSpan({ cls: "pcon-shares-badge", text: "waiting for approval" });
			else status.setText(`${files.toLocaleString()} file(s), checked ${st?.lastPullMs ? new Date(st.lastPullMs).toLocaleString() : "not yet"}`);

			const actions = createSpan({ cls: "pcon-shares-actions" });
			if (!sub.key) {
				actions.createEl("button", { cls: "mod-cta", text: "Request code" }).onclick = () => new RequestCodeModal(this.app, this.plugin, sub, sub.memberName).open();
			}
			actions.createEl("button", { text: sub.paused ? "Resume" : "Pause" }).onclick = () => {
				sub.paused = !sub.paused;
				void this.plugin.persistSettings().then(() => this.render());
			};
			actions.createEl("button", { cls: "mod-warning", text: "Stop" }).onclick = () => void this.plugin.removeSubscription(sub.id).then(() => this.render());

			this.row(table, [sub.name, sub.owner || "someone", sub.localPath, status, actions]);
		}
	}
}

/** The other half of the handshake: what the recipient sends back. Shown
 *  right after accepting an invite, and again from the Shares screen for as
 *  long as the request is still waiting. */
class RequestCodeModal extends Modal {
	constructor(
		app: App,
		private plugin: PowerConnectPlugin,
		private sub: Subscription,
		private name: string
	) {
		super(app);
	}

	onOpen() {
		const c = this.contentEl;
		this.titleEl.setText("Send this back to finish");
		const code = makeJoinCode({ shareId: this.sub.id, memberId: this.sub.memberId, name: this.name.trim() || "Someone", publicKey: this.sub.publicKey });

		new Setting(c).setDesc(
			`Send this request code back to ${this.sub.owner || "whoever sent you the invite"}, the same way the invite reached you. They approve it, and the notes start arriving. Nothing is readable until they do.`
		);

		const box = c.createEl("textarea", { cls: "pcon-share-code" });
		box.value = code;
		box.rows = 4;
		box.readOnly = true;
		box.addEventListener("focus", () => box.select());

		new Setting(c)
			.setName("This code holds no secret")
			.setDesc("It is a name and a public key. It lets the owner grant you access; it does not let anyone read the share, including you, until they approve.");

		const foot = new Setting(c);
		foot.addButton((b) =>
			b
				.setButtonText("Copy request code")
				.setCta()
				.onClick(async () => {
					await navigator.clipboard.writeText(code);
					new Notice("Power Connect: request code copied.");
				})
		);
		foot.addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** What a share carries, and how to change it. Adding happens by right-click
 *  in the file list; this is where you see the whole set, take things out,
 *  and find out what the notes point at that is not coming with them. */
class ShareContentsModal extends Modal {
	private preview: ResolveResult | null = null;
	private audit: { embeds: string[]; links: string[] } | null = null;
	private homeEdit = "";
	private expiryEdit = "";

	constructor(
		app: App,
		private plugin: PowerConnectPlugin,
		private share: OwnedShare
	) {
		super(app);
		this.homeEdit = share.homePath;
		this.expiryEdit = share.expiresAt ? new Date(share.expiresAt).toISOString().slice(0, 10) : "";
	}

	onOpen() {
		this.render();
		void this.refresh();
	}

	onClose() {
		this.contentEl.empty();
	}

	private async refresh() {
		this.preview = await this.plugin.shareFiles(this.share);
		this.audit = await this.plugin.shareLinkAudit(this.share);
		this.render();
	}

	private async commit() {
		await this.plugin.persistSettings();
		this.plugin.refreshShareMarks();
		await this.refresh();
		void this.plugin.publishShareNow(this.share.id, true);
	}

	private render() {
		const c = this.contentEl;
		c.empty();
		this.titleEl.setText(`What "${this.share.name}" carries`);

		new Setting(c)
			.setName("Name")
			.addText((t) =>
				t.setValue(this.share.name).onChange((v) => {
					this.share.name = v.trim() || this.share.name;
				})
			)
			.addButton((b) => b.setButtonText("Save name").onClick(() => void this.commit()));

		new Setting(c).setName("Home folder").setHeading();
		new Setting(c)
			.setName(this.share.homePath || "No home folder")
			.setDesc(
				this.share.homePath
					? "Everything under this folder is shared, including anything added to it later."
					: "This share carries only the notes listed below."
			)
			.addText((t) => {
				t.setPlaceholder("Projects/Acme").setValue(this.homeEdit).onChange((v) => (this.homeEdit = v));
				new FolderSuggest(this.app, t.inputEl, (f) => {
					this.homeEdit = f.path;
					t.inputEl.value = f.path;
				});
			})
			.addButton((b) =>
				b.setButtonText("Change").onClick(() => {
					const next = normRel(this.homeEdit);
					if (next === normRel(this.share.homePath)) return;
					const move = () => {
						this.share.homePath = next;
						void this.commit();
					};
					// re-rooting renames every path inside the share, which to a
					// recipient reads as a withdrawal and a fresh arrival, so a
					// published share asks first. The app's own modal, not the
					// browser's confirm, which Obsidian's guidelines rule out.
					if (!this.share.publishedAt) return move();
					new ConfirmModal(
						this.app,
						"Move the home folder?",
						"This renames every path inside the share. People receiving it will see the old paths disappear and the notes arrive again in a new place.",
						"Move",
						move
					).open();
				})
			);

		new Setting(c)
			.setName("Stop working after")
			.setDesc(
				this.share.expiresAt
					? `This share stops working on ${new Date(this.share.expiresAt).toLocaleDateString()}. Dropbox enforces the date, so it holds even if this vault never opens again.`
					: "Optional. After the date, nobody can reach the notes or the key, whether or not you are around to switch it off."
			)
			.addText((t) => {
				t.inputEl.type = "date";
				t.setValue(this.share.expiresAt ? new Date(this.share.expiresAt).toISOString().slice(0, 10) : "");
				t.onChange((v) => (this.expiryEdit = v));
			})
			.addButton((b) =>
				b.setButtonText("Apply").onClick(() => {
					const at = this.expiryEdit ? new Date(`${this.expiryEdit}T23:59:59Z`).getTime() : 0;
					void this.plugin.setShareExpiry(this.share.id, Number.isFinite(at) ? at : 0).then(() => this.render());
				})
			);

		new Setting(c).setName(`Notes added individually (${this.share.attached.length})`).setHeading();
		if (!this.share.attached.length) {
			new Setting(c).setDesc("None. Right-click a note in the file list and choose Add this note to a share.");
		}
		for (const path of [...this.share.attached]) {
			new Setting(c).setName(pathBase(path)).setDesc(path).addButton((b) =>
				markDestructive(b)
					.setButtonText("Remove")
					.setTooltip("Stops sharing this note. The copy the other person already has stays in their vault.")
					.onClick(() => {
						this.share.attached = this.share.attached.filter((a) => a !== path);
						void this.commit();
					})
			);
		}

		new Setting(c).setName("What will be sent").setHeading();
		if (!this.preview) {
			new Setting(c).setDesc("Working it out...");
		} else {
			const bytes = this.preview.files.reduce((a, f) => a + f.size, 0);
			new Setting(c).setName(`${this.preview.files.length.toLocaleString()} file(s), ${fmtBytes(bytes)}`);
			if (this.preview.skipped.length) {
				const ul = c.createEl("ul", { cls: "pcon-share-skipped" });
				for (const s of this.preview.skipped.slice(0, 8)) ul.createEl("li", { text: `${s.local} (${s.why})` });
				if (this.preview.skipped.length > 8) ul.createEl("li", { text: `and ${this.preview.skipped.length - 8} more` });
			}
		}

		if (this.audit && (this.audit.embeds.length || this.audit.links.length)) {
			new Setting(c).setName("Points outside this share").setHeading();
			if (this.audit.embeds.length) {
				new Setting(c)
					.setName(`${this.audit.embeds.length} attachment(s) will not arrive`)
					.setDesc("Images and files these notes embed, which are not part of the share. The other person sees a broken embed where each one should be.")
					.addButton((b) =>
						b
							.setButtonText("Include them")
							.setCta()
							.onClick(() => {
								for (const p of this.audit?.embeds ?? []) if (!this.share.attached.includes(p)) this.share.attached.push(p);
								void this.commit();
							})
					);
				const ul = c.createEl("ul", { cls: "pcon-share-skipped" });
				for (const p of this.audit.embeds.slice(0, 8)) ul.createEl("li", { text: p });
				if (this.audit.embeds.length > 8) ul.createEl("li", { text: `and ${this.audit.embeds.length - 8} more` });
			}
			if (this.audit.links.length) {
				new Setting(c)
					.setName(`${this.audit.links.length} link(s) lead nowhere`)
					.setDesc("Notes these notes link to that are not in the share. Often deliberate, so nothing is added on your behalf.")
					.addButton((b) =>
						b.setButtonText("Include them").onClick(() => {
							for (const p of this.audit?.links ?? []) if (!this.share.attached.includes(p)) this.share.attached.push(p);
							void this.commit();
						})
					);
				const ul = c.createEl("ul", { cls: "pcon-share-skipped" });
				for (const p of this.audit.links.slice(0, 8)) ul.createEl("li", { text: p });
				if (this.audit.links.length > 8) ul.createEl("li", { text: `and ${this.audit.links.length - 8} more` });
			}
		}

		new Setting(c).addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
	}
}

/** The owner's side of the handshake: paste what came back, see who is
 *  asking, decide. */
class ManageShareModal extends Modal {
	private paste = "";

	constructor(
		app: App,
		private plugin: PowerConnectPlugin,
		private share: OwnedShare
	) {
		super(app);
	}

	onOpen() {
		this.render();
	}

	onClose() {
		this.contentEl.empty();
	}

	private render() {
		const c = this.contentEl;
		c.empty();
		this.titleEl.setText(`Who can read "${this.share.name}"`);

		new Setting(c)
			.setName("Add a request")
			.setDesc("Paste the request code someone sent back after receiving your invite.")
			.setClass("pcon-share-code")
			.addTextArea((t) => {
				t.setPlaceholder("PCON-JOIN:1:...").onChange((v) => (this.paste = v));
				t.inputEl.rows = 3;
				t.inputEl.addClass("pcon-share-code");
			});
		new Setting(c).addButton((b) =>
			b
				.setButtonText("Add request")
				.setCta()
				.onClick(async () => {
					const added = await this.plugin.addJoinRequest(this.paste);
					if (!added) {
						new Notice(
							looksLikeJoinCode(this.paste)
								? "Power Connect: that request code could not be read, or it is for a different share. Ask for the whole code again."
								: "Power Connect: that does not look like a request code. It starts with PCON-JOIN.",
							9000
						);
						return;
					}
					this.paste = "";
					this.render();
				})
		);

		const pending = this.share.members.filter((m) => m.state === "pending");
		const decided = this.share.members.filter((m) => m.state !== "pending");

		if (pending.length) {
			new Setting(c).setName("Waiting for you").setHeading();
			for (const m of pending) {
				const row = new Setting(c).setName(m.name).setDesc(`Asked ${new Date(m.requestedAt).toLocaleString()}.`);
				row.addButton((b) =>
					b
						.setButtonText("Approve")
						.setCta()
						.onClick(() => void this.plugin.setMemberState(this.share.id, m.memberId, "approved").then(() => this.render()))
				);
				row.addButton((b) => b.setButtonText("Deny").onClick(() => void this.plugin.setMemberState(this.share.id, m.memberId, "denied").then(() => this.render())));
			}
		}

		if (this.share.invitesSent.length) {
			const answered = new Set(this.share.members.map((m) => m.email.trim().toLowerCase()).filter(Boolean));
			const open = this.share.invitesSent.filter((i) => !answered.has(i.email.toLowerCase()));
			if (open.length) {
				new Setting(c).setName("Invited, no request yet").setHeading();
				new Setting(c).setDesc(
					"A request code carries the name someone types, not their address, so these cannot be matched for you. Put the address on a person below once you know who is who."
				);
				for (const i of open) {
					new Setting(c).setName(i.email).setDesc(`Invited ${new Date(i.sentAt).toLocaleDateString()}.`).addButton((b) =>
						b.setButtonText("Forget").onClick(() => {
							this.share.invitesSent = this.share.invitesSent.filter((x) => x.email !== i.email);
							void this.plugin.persistSettings().then(() => this.render());
						})
					);
				}
			}
		}

		new Setting(c).setName("People").setHeading();
		if (!decided.length) {
			new Setting(c).setDesc("Nobody has been approved yet. Send someone the invite code, then paste the request they send back.");
		}
		for (const m of decided) {
			const when = m.decidedAt ? new Date(m.decidedAt).toLocaleDateString() : "";
			const state = m.state === "approved" ? `Can read this share since ${when}.` : m.state === "denied" ? `Denied ${when}.` : `Access withdrawn ${when}.`;
			const row = new Setting(c).setName(m.name).setDesc(state);
			row.addText((t) =>
				t
					.setPlaceholder("their email (optional)")
					.setValue(m.email)
					.onChange((v) => {
						m.email = v.trim();
						void this.plugin.persistSettings();
					})
			);
			if (m.state === "approved") {
				row.addButton((b) =>
					markDestructive(b)
						.setButtonText("Remove")
						.setTooltip("Withdraws access and re-keys the share. What they already downloaded stays with them.")
						.onClick(() => void this.plugin.setMemberState(this.share.id, m.memberId, "revoked").then(() => this.render()))
				);
			} else {
				row.addButton((b) => b.setButtonText("Approve").onClick(() => void this.plugin.setMemberState(this.share.id, m.memberId, "approved").then(() => this.render())));
			}
		}
	}
}

/** Accepting an invite. Deliberately the entire setup a person needs in
 *  order to receive a share: one paste, one folder. No account, no sign-in,
 *  no provider. If this screen ever grows a "connect your storage" step,
 *  read-only sharing has lost the only thing that makes it worth having. */
class ReceiveShareModal extends Modal {
	private code = "";
	private folder = "";
	private touchedFolder = false;
	private requestName = "";

	constructor(
		app: App,
		private plugin: PowerConnectPlugin
	) {
		super(app);
	}

	onOpen() {
		this.render();
	}

	onClose() {
		this.contentEl.empty();
	}

	/** "Shared/Dana" out of whatever the invite says, without letting a
	 *  remote-supplied name choose a path this vault cannot write. */
	private defaultFolder(owner: string, name: string): string {
		const clean = sanitizeRemoteFolder(owner || name || "Shared notes");
		return `Shared/${clean}`;
	}

	private render() {
		const c = this.contentEl;
		c.empty();
		this.titleEl.setText("Receive a share");

		let parsed: ShareCode | null = null;
		let outdated = "";
		try {
			parsed = this.code.trim() ? parseShareCode(this.code) : null;
		} catch (e) {
			outdated = e instanceof ShareCodeOutdated ? e.message : msg(e);
		}

		new Setting(c).setDesc(
			"Someone sharing notes with you can send an invite code. Paste it here and the notes arrive in a folder you choose. You do not need a storage account, and nothing here signs you in to anything."
		);

		new Setting(c)
			.setName("Invite code")
			.setDesc("Starts with PCON-SHARE.")
			.setClass("pcon-share-code")
			.addTextArea((t) => {
				t.setPlaceholder("PCON-SHARE:1:...")
					.setValue(this.code)
					.onChange((v) => {
						this.code = v;
						if (!this.touchedFolder) {
							const p = parseShareCode(v);
							if (p) this.folder = this.defaultFolder(p.owner, p.name);
						}
						this.render();
					});
				t.inputEl.rows = 4;
				t.inputEl.addClass("pcon-share-code");
			});

		if (outdated) {
			new Setting(c).setName("That invite is out of date").setDesc(outdated).setClass("pcon-warn");
		} else if (this.code.trim() && !parsed) {
			new Setting(c)
				.setName(looksLikeShareCode(this.code) ? "That code could not be read" : "That does not look like an invite code")
				.setDesc(
					looksLikeShareCode(this.code)
						? "Copy the whole code and paste it again. Codes are long, and a partial copy cannot be recovered."
						: "An invite code starts with PCON-SHARE. A device setup code (PCON-SETUP) belongs in the setup wizard instead."
				)
				.setClass("pcon-warn");
		}

		if (parsed) {
			new Setting(c).setName(parsed.name).setDesc(parsed.owner ? `Shared by ${parsed.owner}.` : "Shared with you.");
			new Setting(c)
				.setName("Your name")
				.setDesc("Shown to the owner when they decide whether to let you in.")
				.addText((t) => t.setValue(this.requestName).onChange((v) => (this.requestName = v)));
			new Setting(c)
				.setName("Put the notes in")
				.setDesc("A folder in this vault. It is created if it does not exist.")
				.addText((t) => {
					t.setPlaceholder("Shared/Notes")
						.setValue(this.folder)
						.onChange((v) => {
							this.touchedFolder = true;
							this.folder = v;
						});
					new FolderSuggest(this.app, t.inputEl, (f) => {
						this.touchedFolder = true;
						this.folder = f.path;
						t.inputEl.value = f.path;
					});
				});
		}

		const foot = new Setting(c);
		foot.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
		foot.addButton((b) =>
			b
				.setButtonText("Receive share")
				.setCta()
				.setDisabled(!parsed)
				.onClick(() => {
					if (!parsed) return;
					const folder = normRel(this.folder) || this.defaultFolder(parsed.owner, parsed.name);
					const bad = windowsUnsafe(folder);
					if (bad) {
						new Notice(`Power Connect: that folder name will not work here (${bad}).`, 8000);
						return;
					}
					this.close();
					void (async () => {
						// this device's identity for this share. The private
						// half stays here; only the public half goes back to
						// the owner, and only they can let it in.
						const keys = await generateMemberKeys();
						const sub: Subscription = {
							id: parsed.id,
							name: parsed.name,
							owner: parsed.owner,
							manifestUrl: parsed.manifestUrl,
							keyringUrl: parsed.keyringUrl,
							memberId: keys.memberId,
							privateJwk: keys.privateJwk,
							publicKey: keys.publicKey,
							memberName: this.requestName.trim() || "Someone",
							key: "",
							localPath: folder,
							addedAt: Date.now(),
							paused: false,
						};
						await this.plugin.addSubscription(sub);
						new RequestCodeModal(this.app, this.plugin, sub, this.requestName).open();
					})();
				})
		);
	}
}

/** One row of the settings tab. `build` is handed a Setting whose name and
 *  description are already set, so it only adds the controls. Rows are data
 *  rather than drawing code so the two renderers cannot disagree about what
 *  the tab holds. */
type Row = { name: string; desc?: string; help?: string; cls?: string; aliases?: string[]; build?: (st: Setting) => void | (() => void) };

/** A run of rows under one heading. Each becomes a headed group on 1.13 and
 *  one section div in the fallback. */
type Group = { heading?: string; rows: Row[] };

/** One tab: a native settings page on Obsidian 1.13 and up, a tab button in
 *  the fallback renderer for older builds. */
type Page = { id: string; label: string; groups: Group[] };

class PconSettingTab extends PluginSettingTab {
	private activeTab = "account";
	private query = "";
	private helpEl: HTMLElement | null = null;
	private helpAnchor: HTMLElement | null = null;
	private helpPinned = false;
	private helpCleanup: (() => void) | null = null;

	constructor(
		app: App,
		private plugin: PowerConnectPlugin
	) {
		super(app, plugin);
		// Armed once, for the life of the tab. It used to be set in display() and
		// cleared in hide(), which the declarative renderer would leave null after
		// the first close, since it never calls display() again. refresh() bails
		// when the tab is off screen, so a closed tab still costs nothing.
		plugin.refreshSettingsTab = () => this.refresh();
	}

	hide() {
		this.closeHelp();
	}

	private closeHelp() {
		this.helpCleanup?.();
		this.helpCleanup = null;
		this.helpEl?.remove();
		this.helpEl = null;
		this.helpAnchor = null;
		this.helpPinned = false;
	}

	/** The family help popover: a soft theme-colored card. Hover shows it, a
	 *  click pins it; Esc, a click elsewhere, or scrolling closes it. */
	private openHelp(icon: HTMLElement, text: string, pin: boolean) {
		if (this.helpAnchor === icon && this.helpEl) {
			if (pin) this.helpPinned = true;
			return;
		}
		this.closeHelp();
		const el = document.body.createDiv({ cls: "pcon-help-pop", text });
		this.helpEl = el;
		this.helpAnchor = icon;
		this.helpPinned = pin;
		const r = icon.getBoundingClientRect();
		el.style.left = Math.max(8, Math.min(r.left - 12, window.innerWidth - el.offsetWidth - 8)) + "px";
		const below = r.bottom + 8;
		el.style.top = (below + el.offsetHeight > window.innerHeight - 8 ? r.top - el.offsetHeight - 8 : below) + "px";
		const onDocDown = (e: MouseEvent) => {
			if (e.target instanceof Node && (el.contains(e.target) || icon.contains(e.target))) return;
			this.closeHelp();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") this.closeHelp();
		};
		const onScroll = () => this.closeHelp();
		document.addEventListener("pointerdown", onDocDown, true);
		document.addEventListener("keydown", onKey, true);
		document.addEventListener("scroll", onScroll, true);
		this.helpCleanup = () => {
			document.removeEventListener("pointerdown", onDocDown, true);
			document.removeEventListener("keydown", onKey, true);
			document.removeEventListener("scroll", onScroll, true);
		};
	}

	/** Redraw when the rows themselves change: a device connecting, a folder
	 *  protected, a share arriving. Obsidian 1.13 rebuilds the tab from
	 *  getSettingDefinitions(); older builds have only the fallback renderer.
	 *
	 *  The plugin calls this from everywhere sync state moves, so it bails when
	 *  the tab is off screen rather than rebuilding a hidden container. */
	refresh() {
		if (!this.containerEl.isShown()) return;
		this.closeHelp(); // whatever the popover is anchored to is about to go
		// update() arrived with the declarative API in 1.13 and minAppVersion is
		// still 1.8.7, so it is reached through a cast rather than named outright:
		// an older build has no definitions to rebuild from and redraws instead.
		const tab = this as unknown as { update?: () => void };
		if (tab.update) tab.update();
		else this.renderFallback();
	}

	/** The family help icon after a setting's name. */
	private addHelp(st: Setting, text: string) {
		const ic = st.nameEl.createSpan({ cls: "pcon-setting-help" });
		setIcon(ic, "help-circle");
		ic.addEventListener("mouseenter", () => this.openHelp(ic, text, false));
		ic.addEventListener("mouseleave", () => {
			if (!this.helpPinned && this.helpAnchor === ic) this.closeHelp();
		});
		ic.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (this.helpPinned && this.helpAnchor === ic) this.closeHelp();
			else this.openHelp(ic, text, true);
		});
	}

	/** Obsidian 1.13 and up builds the tab from these and never calls display():
	 *  one native page per tab, standing in for the tab bar the fallback draws
	 *  for older builds. The master switch stays above the pages, because on and
	 *  off should never mean hunting through sections.
	 *
	 *  Every row renders itself rather than declaring a `control`. A declarative
	 *  control writes through Obsidian's generic setControlValue, which would
	 *  bypass queueSave and the settings merge behind it. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const pages = this.buildPages();
		const rowsOf = new Map(pages.map((p) => [p.label, p.groups.flatMap((g) => g.rows)] as const));
		return [
			{
				name: "",
				searchable: false, // it is a masthead, not a setting
				render: (st) => {
					st.settingEl.empty();
					this.renderAbout(st.settingEl);
				},
			},
			this.toDefinition(this.masterRow(), "Sync"),
			{
				type: "group",
				search: {
					placeholder: "Search settings...",
					// the entries here are whole tabs, so a tab stays up when anything
					// inside it matches. Obsidian's own search box, top left, reaches
					// the individual settings.
					match: (def, query) => {
						const q = query.trim().toLowerCase();
						if (!q) return true;
						const has = (v: string | undefined) => (v ?? "").toLowerCase().includes(q);
						return (rowsOf.get(def.name) ?? []).some(
							(r) => has(r.name) || has(r.desc) || (r.aliases ?? []).some(has)
						);
					},
				},
				items: pages.map(
					(p): SettingDefinitionPage => ({
						type: "page",
						name: p.label,
						// a lone unnamed section is the page itself, so it stays flat
						items:
							p.groups.length === 1 && !p.groups[0].heading
								? p.groups[0].rows.map((r) => this.toDefinition(r, p.label))
								: p.groups.map((g) => ({
										type: "group" as const,
										heading: g.heading,
										items: g.rows.map((r) => this.toDefinition(r, p.label)),
									})),
					})
				),
			},
		];
	}

	/** One row as a definition Obsidian can draw. The name and description are
	 *  its to render and it rebuilds both on a redraw, so a row only hands back
	 *  what it hung on the row element itself. */
	private toDefinition(r: Row, page: string): SettingDefinitionRender {
		return {
			name: r.name,
			desc: r.desc,
			// searching the tab name still finds its rows, the way a heading match
			// opened the whole section in the tab bar
			aliases: [...(r.aliases ?? []), page],
			render: (st) => {
				if (r.cls) st.settingEl.addClass(r.cls);
				const teardown = r.build?.(st);
				if (r.help) this.addHelp(st, r.help);
				return teardown;
			},
		};
	}

	/** What this plugin is and which build is running, above everything else.
	 *  Read off the manifest so it cannot drift from the released version. */
	private renderAbout(el: HTMLElement) {
		el.addClass("pcon-about");
		const head = el.createDiv({ cls: "pcon-about-head" });
		head.createSpan({ cls: "pcon-about-name", text: this.plugin.manifest.name });
		head.createSpan({ cls: "pcon-about-version", text: "v" + this.plugin.manifest.version });
		el.createDiv({ cls: "pcon-about-desc", text: this.plugin.manifest.description });
		// One Buy Me a Coffee page serves every Power Plugin, and a payment says
		// nothing about which one it came from, nor about what the person wanted.
		// The note that rides along can carry both, so it asks for both. The name is
		// read from the manifest rather than written out here, so it cannot drift
		// from what the plugin is actually called.
		//
		// It invites a request without promising to build one. What can be built
		// depends on what the mailbox and vault APIs allow, and a promise broken at
		// the price of a coffee would cost more than never making it. The last
		// sentence points at what has already happened instead, which is true and
		// commits to nothing.
		const support = el.createDiv({ cls: "pcon-about-support" });
		support.createEl("a", { text: "Buy me a coffee", href: "https://buymeacoffee.com/powerplugins" });
		support.createSpan({
			text: `. One page covers every Power Plugin, so mention ${this.plugin.manifest.name} in the note, and say what would make it better while you are there. A good deal of what is in these plugins started as someone's note.`,
		});
	}

	/** The master switch: on and off, above the sections rather than inside one. */
	private masterRow(): Row {
		return {
			name: "Sync",
			cls: "pcon-master",
			desc: this.plugin.subscriberOnly
				? "This vault receives shares from other people. Nothing of your own is being synced, which is fine: set up sync only if you also want your own notes backed up and on your other devices."
				: !this.plugin.remote.connected
					? "Not set up yet on this device."
					: this.plugin.paused
						? "Off: nothing syncs on this device until this is turned back on. Other devices are unaffected."
						: "On: this device syncs automatically while Obsidian is open.",
			build: (st) => {
				if (this.plugin.remote.connected) {
					st.addToggle((t) => t.setValue(!this.plugin.paused).onChange((v) => this.plugin.setPaused(!v)));
					return;
				}
				// a vault that only receives shares is already set up for what it
				// does; the offer stays available but stops shouting
				st.addButton((b) => {
					b.setButtonText("Set up sync").onClick(() => new SetupWizard(this.app, this.plugin).open());
					if (!this.plugin.subscriberOnly) b.setButtonText("Set up Power Connect").setCta();
				});
			},
		};
	}

	/** The pre-1.13 renderer: every section on one page, with a tab bar and a
	 *  search box of our own because there was no declarative API to hand the
	 *  work to. Obsidian 1.13 and up ignores this and renders the definitions
	 *  above instead, so the two only ever differ in how they draw, never in
	 *  what they draw. */
	display() {
		this.renderFallback();
	}

	private renderFallback() {
		const root = this.containerEl;
		root.empty();
		this.closeHelp();

		const pages = this.buildPages();
		if (!pages.some((p) => p.id === this.activeTab)) this.activeTab = pages[0].id;

		this.renderAbout(root.createDiv({ cls: "pcon-about-standalone" }));

		const searchWrap = root.createDiv({ cls: "pcon-settings-search" });
		const searchInput = searchWrap.createEl("input", { cls: "pcon-settings-search-input" });
		searchInput.type = "search";
		searchInput.placeholder = "Search settings...";
		searchInput.value = this.query;

		// the master switch lives above the tabs: on/off should never require
		// hunting through sections
		this.drawRow(root.createDiv(), this.masterRow());

		const tabBar = root.createDiv({ cls: "pcon-settings-tabs" });
		const body = root.createDiv({ cls: "pcon-settings-body" });

		// one section div per group, tagged with its tab so the tab bar and the
		// search box below can show and hide whole sections at a time
		for (const p of pages) {
			for (const g of p.groups) {
				const sec = body.createDiv({ cls: "pcon-settings-section" });
				sec.dataset.tab = p.id;
				sec.dataset.name = (g.heading ?? p.label).toLowerCase();
				if (g.heading) new Setting(sec).setName(g.heading).setHeading();
				for (const r of g.rows) this.drawRow(sec, r);
			}
		}

		const setVisible = (el: HTMLElement, v: boolean) => (el.style.display = v ? "" : "none");
		const applyView = () => {
			const q = this.query.trim().toLowerCase();
			setVisible(tabBar, !q);
			for (const sec of Array.from(body.children) as HTMLElement[]) {
				const items = Array.from(sec.querySelectorAll<HTMLElement>(":scope > .setting-item:not(.setting-item-heading)"));
				if (!q) {
					for (const it of items) setVisible(it, true);
					setVisible(sec, sec.dataset.tab === this.activeTab);
					continue;
				}
				const nameHit = (sec.dataset.name ?? "").includes(q);
				let anyHit = false;
				for (const it of items) {
					const name = it.querySelector(".setting-item-name")?.textContent?.toLowerCase() ?? "";
					const desc = it.querySelector(".setting-item-description")?.textContent?.toLowerCase() ?? "";
					const hit = nameHit || name.includes(q) || desc.includes(q) || (it.dataset.pconAlias ?? "").includes(q);
					setVisible(it, hit);
					if (hit) anyHit = true;
				}
				setVisible(sec, anyHit);
			}
		};

		for (const p of pages) {
			const btn = tabBar.createEl("button", { text: p.label, cls: "pcon-settings-tab" });
			btn.toggleClass("is-active", p.id === this.activeTab);
			btn.onclick = () => {
				if (this.activeTab === p.id) return;
				this.activeTab = p.id;
				for (const other of Array.from(tabBar.children) as HTMLElement[]) other.toggleClass("is-active", other === btn);
				applyView();
			};
		}

		searchInput.addEventListener("input", () => {
			this.query = searchInput.value;
			applyView();
		});

		applyView();
	}

	/** One row into a container, in the order Obsidian applies a definition:
	 *  name and description first, then the row's own content, so a row that
	 *  appends to either element lands in the same place under both renderers. */
	private drawRow(into: HTMLElement, r: Row) {
		const st = new Setting(into).setName(r.name);
		if (r.desc) st.setDesc(r.desc);
		if (r.cls) st.settingEl.addClass(r.cls);
		if (r.aliases?.length) st.settingEl.dataset.pconAlias = r.aliases.join(" ").toLowerCase();
		r.build?.(st);
		if (r.help) this.addHelp(st, r.help);
	}

	/** Every row of the settings tab, in order, as plain data: the one source
	 *  both renderers draw from, so they cannot drift apart. Built fresh on each
	 *  render because most of this tab reflects live sync state. */
	private buildPages(): Page[] {
		const s = this.plugin.settings;
		const save = () => this.plugin.queueSave();
		const intro = (text: string): Row => ({ name: "", desc: text, cls: "pcon-section-intro" });

		/* ---------------- Account ---------------- */

		const storage: Row[] = [
			intro("Power Connect syncs this vault with a folder in your own cloud storage account. Nothing passes through any other server."),
		];
		if (!this.plugin.remote.connected) {
			storage.push({
				name: "Not set up on this device",
				desc: "Press Set up Power Connect above. The guided setup owns every choice here: provider, sign-in, folder, and encryption. These settings appear once the device is connected.",
			});
		} else {
			storage.push({
				name: "Provider",
				help: "Dropbox is the first supported provider. The sync engine is storage-agnostic behind one small interface, so more providers (Box, OneDrive, and friends) can be added without changing anything else here. A vault syncs through one provider at a time.",
				build: (st) => {
					st.controlEl.createSpan({ text: this.plugin.remote.name });
				},
			});
			storage.push({
				name: "Connection",
				desc: this.plugin.accountLabel() ? `Connected as ${this.plugin.accountLabel()}.` : "Connected.",
				help: "The one-time setup creates a Dropbox app under your account with App folder access, so Power Connect can only ever see its own folder, never the rest of your Dropbox. Sign-in uses a paste-a-code flow that works the same on desktop and phone. Each device connects once; tokens stay on the device.",
				build: (st) => {
					st.addButton((b) =>
						b
							.setButtonText("Sign in again")
							.setTooltip("A sign-in keeps the permissions it was granted. Re-authorize after changing your app's permissions, for example to add sharing.")
							.onClick(() => new SetupWizard(this.app, this.plugin, "connect").open())
					);
					st.addButton((b) =>
						b.setButtonText("Disconnect").onClick(async () => {
							await this.plugin.remote.revoke();
							this.plugin.clearProviderAuth();
							save();
							this.plugin.applySettings();
							this.plugin.log("info", `Disconnected from ${this.plugin.remote.name}.`);
							this.refresh();
						})
					);
					const usage = st.descEl.createDiv({ cls: "pcon-muted" });
					usage.setText("Reading space usage...");
					this.plugin.remote
						.spaceUsage()
						.then((u) => {
							usage.setText(`${fmtBytes(u.used)} of ${fmtBytes(u.allocated)} used in ${this.plugin.remote.name}.`);
							const bar = usage.createDiv({ cls: "pcon-usage-bar" });
							bar.createDiv({ cls: "pcon-usage-fill" }).style.width = `${Math.min(100, Math.round((u.used / Math.max(1, u.allocated)) * 100))}%`;
						})
						.catch(() => usage.setText(""));
				},
			});

			const stats = this.plugin.engine.syncedStats();
			const held = this.plugin.engine.heldBackCount();
			storage.push({
				name: "Synced",
				desc: stats.files
					? `${stats.files.toLocaleString()} file(s) in ${stats.folders.toLocaleString()} folder(s), ${fmtBytes(stats.bytes)}. Last synced ${this.plugin.lastSyncMs ? new Date(this.plugin.lastSyncMs).toLocaleString() : "never"}.` +
						(held ? ` ${held.toLocaleString()} plugin settings file(s) held back until the passphrase is entered.` : "")
					: "Nothing synced on this device yet; the numbers appear after the first sync.",
				help: "Counted from this device's sync journal: the files both sides agree on, the folders they live in, and their size before any encryption. Open settings again after a sync for fresh numbers.",
			});

			storage.push({
				name: `${this.plugin.remote.name} folder`,
				desc:
					s.provider === "dropbox"
						? "The folder under Apps that holds this vault. Every device syncing this vault must use the same name."
						: "The folder holding this vault. Every device syncing this vault must use the same name.",
				help: "Empty means the vault's own name. On a second device, set this to the same name the first device used and run Preview sync: identical files pair up with no transfer, and only real differences move. Changing it later points syncing at a different copy; use Reset sync state after changing it.",
				build: (st) => {
					st.addText((t) =>
						t
							.setPlaceholder(this.app.vault.getName())
							.setValue(s.remoteFolder)
							.onChange((v) => {
								s.remoteFolder = v;
								save();
								this.plugin.applySettings();
							})
					);
				},
			});

			const protOn = this.plugin.engine.protectionSeen || !!this.plugin.engine.secretsKey;
			storage.push({
				name: "Encryption",
				desc: s.e2eEnabled
					? "On for this folder: everything uploads encrypted (AES-256-GCM); the passphrase is entered once per device."
					: protOn
						? this.plugin.engine.secretsKey || s.e2ePassphrase
							? "Plugin settings files upload encrypted with the passphrase; notes upload as they are."
							: "Plugin settings files are protected; enter the passphrase in setup to sync them on this device."
						: "Off for this folder. Plugin settings files are held back until protected; choose a privacy level in setup.",
				help: "Three levels, chosen in the guided setup: everything encrypted (decided per folder while it is empty; changing it later means a fresh folder and one full re-upload), only plugin settings files protected (can be added to a folder that already holds files), or off. Either passphrase is entered once per device and never written to a synced file.",
				build: (st) => {
					st.addButton((b) => b.setButtonText("Change in setup").onClick(() => new SetupWizard(this.app, this.plugin).open()));
				},
			});

			// selective folder encryption: available once there is a passphrase and
			// the folder is not already fully encrypted (which covers everything)
			if (!s.e2eEnabled) {
				const protectedFolders = s.protectedFolders ?? [];
				storage.push({
					name: "Encrypted folders",
					desc: s.e2ePassphrase
						? "Top-level folders that upload encrypted while the rest of the vault stays plain, sharing the one protection passphrase. Good for an Email folder or anything private. Files stay readable on this device; only the Dropbox copy is encrypted."
						: "Set a passphrase in setup first, then protect individual top-level folders here.",
					help: "Add as many folders as you like: pick or type a top-level folder (spaces and all) and click Protect, then repeat. Each protected folder is encrypted in transit and at rest on Dropbox but stays plaintext on this device, so search, Bases, and everything else keep working. Turning protection on re-uploads the folder's existing files as ciphertext; turning it off restores them to plaintext. One passphrase covers every protected folder and the plugin settings files.",
					build: (st) => {
						if (!s.e2ePassphrase) return;
						// add-a-folder row: a folder picker plus an explicit Protect
						// button, so a folder name with spaces can be typed in full and
						// several folders added one after another. Adding re-renders the
						// list, so each new folder shows up with its own remove control.
						let pending = "";
						const addFolder = async (raw: string) => {
							const top = raw.replace(/\\/g, "/").split("/")[0].trim();
							if (!top) {
								new Notice("Power Connect: pick a top-level folder to protect.", 6000);
								return;
							}
							if ((s.protectedFolders ?? []).some((f) => f.toLowerCase() === top.toLowerCase())) {
								new Notice(`Power Connect: "${top}" is already protected.`, 6000);
								return;
							}
							new Notice(`Power Connect: protecting "${top}" (re-encrypting its files on Dropbox)…`, 6000);
							const err = await this.plugin.setFolderProtection(top, true);
							if (err) new Notice("Power Connect: " + err, 8000);
							this.refresh();
						};
						st.addText((t) => {
							t.setPlaceholder("folder name (spaces are fine)");
							const sug = new FolderSuggest(this.app, t.inputEl, (folder) => {
								// a picked folder can be nested; protect its top-level parent
								pending = folder.path.split("/")[0];
								t.inputEl.value = pending;
							});
							sug.fillOnPick = true;
							t.onChange((v) => (pending = v));
							// Enter in the field protects what was typed, suggestion or not
							t.inputEl.addEventListener("keydown", (e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									const v = pending || t.getValue();
									t.setValue("");
									pending = "";
									void addFolder(v);
								}
							});
						});
						st.addButton((b) =>
							b
								.setButtonText("Protect")
								.setCta()
								.onClick(() => {
									const v = pending;
									pending = "";
									void addFolder(v);
								})
						);
					},
				});
				for (const pf of protectedFolders) {
					storage.push({
						name: `🔒 ${pf}`,
						desc: "Encrypted on Dropbox; plaintext on this device.",
						build: (st) => {
							st.addExtraButton((b) =>
								b
									.setIcon("trash")
									.setTooltip("Stop protecting (restores plaintext on Dropbox)")
									.onClick(() =>
										void this.plugin.setFolderProtection(pf, false).then((err) => {
											if (err) new Notice("Power Connect: " + err, 8000);
											else {
												new Notice(`Power Connect: "${pf}" is no longer encrypted on Dropbox.`, 6000);
												this.refresh();
											}
										})
									)
							);
						},
					});
				}
			}
		}

		const accountGroups: Group[] = [{ heading: "Storage", rows: storage }];
		if (this.plugin.remote.connected) {
			accountGroups.push({
				heading: "Other devices",
				rows: [
					intro("The same vault in Obsidian on another computer or phone stays in sync through this Dropbox folder. Each device installs Power Connect once; everything else arrives through sync."),
					{
						name: "Add another device",
						desc: "Set up this vault in Obsidian on another computer or phone. A setup code fills that device's wizard.",
						help: "Install the plugin on the other device, paste the setup code into its wizard, and authorize Dropbox there; the passphrase, if one is set, is entered on that device too. The first sync brings notes, settings, themes, and plugins, and afterwards updates flow by themselves.",
						build: (st) => {
							st.addButton((b) =>
								b
									.setButtonText("Show the steps and setup code")
									.setCta()
									.onClick(() => new AddDeviceModal(this.app, this.plugin).open())
							);
						},
					},
				],
			});
		}

		/* ---------------- Shares ---------------- */

		const shares = s.shares.length;
		const waiting = s.shares.reduce((n, sh) => n + sh.members.filter((m) => m.state === "pending").length, 0);
		const subs = s.subscriptions.length;
		const pendingSubs = s.subscriptions.filter((x) => !x.key).length;
		const shareRows: Row[] = [
			intro("Notes you share with other people, and notes they share with you. Everything is encrypted before it leaves this vault, and nobody can read a share until you approve them."),
			{
				name: shares || subs ? `${shares} share(s) published, ${subs} received` : "Not sharing anything yet",
				desc: waiting
					? `${waiting} ${waiting === 1 ? "person is" : "people are"} waiting for you to approve or deny access.`
					: pendingSubs
						? `${pendingSubs} of your requests ${pendingSubs === 1 ? "is" : "are"} waiting to be approved by their owner.`
						: "Right-click a folder or a note in the file list to share it, or paste an invite code someone sent you.",
				build: (st) => {
					// the list itself lives in its own view: a settings tab has no
					// search, no sort, and nowhere to put hundreds of rows
					st.addButton((b) =>
						b
							.setButtonText(waiting ? `Manage shares (${waiting})` : "Manage shares")
							.setCta()
							.onClick(() => {
								void this.plugin.openSharesView();
								(this.app as unknown as { setting?: { close: () => void } }).setting?.close();
							})
					);
				},
			},
			{
				name: "Mark shared items in the file list",
				desc: "Shows a small arrow and a colored edge beside shared folders and notes: outgoing, incoming, and waiting for approval.",
				build: (st) => {
					st.addToggle((t) =>
						t.setValue(s.shareMarks).onChange((v) => {
							s.shareMarks = v;
							save();
							this.plugin.refreshShareMarks();
						})
					);
				},
			},
			{
				name: "Receive a share",
				desc: "Paste an invite code from whoever is sharing with you.",
				build: (st) => {
					st.addButton((b) => b.setButtonText("Paste invite code").onClick(() => new ReceiveShareModal(this.app, this.plugin).open()));
				},
			},
		];
		if (!this.plugin.canPublish) {
			shareRows.push({
				name: s.provider === "dropbox" ? "Connect Dropbox to publish shares" : "Publishing needs Dropbox for now",
				desc: "Receiving shares from other people works without any of this, on any setup, including none at all.",
			});
		}

		/* ---------------- Sync ---------------- */

		const whenToSync: Row[] = [
			intro("Sync runs while Obsidian is open: shortly after launch, on a schedule, and after edits settle. On iPhone and iPad the app must be open; iOS does not run plugins in the background."),
			{
				name: "Sync on start",
				desc: "Run a sync a few seconds after Obsidian opens.",
				build: (st) => {
					st.addToggle((t) =>
						t.setValue(s.syncOnStart).onChange((v) => {
							s.syncOnStart = v;
							save();
						})
					);
				},
			},
			{
				name: "Sync when returning to Obsidian",
				desc: "Catch up moments after the app comes back into view.",
				help: "This is the trigger that matters on iPhone and iPad: iOS freezes plugins in the background, so the moment you reopen Obsidian is when catching up is possible. It also fires when you switch back to Obsidian on desktop. Skipped when a sync ran in the last few seconds.",
				build: (st) => {
					st.addToggle((t) =>
						t.setValue(s.syncOnResume).onChange((v) => {
							s.syncOnResume = v;
							save();
						})
					);
				},
			},
			{
				name: "Live sync (desktop)",
				desc: "Pick up other devices' changes within seconds instead of on the schedule.",
				help: "Holds Dropbox's change-notification endpoint open in the background (one idle HTTPS request, no polling). When any device uploads, this one hears about it within seconds and runs a delta sync. Desktop only: phones cannot keep the connection open in the background. The interval schedule stays as the safety net.",
				build: (st) => {
					st.addToggle((t) =>
						t.setValue(s.liveSync).onChange((v) => {
							s.liveSync = v;
							save();
							this.plugin.applySettings();
						})
					);
				},
			},
			{
				name: "Sync every",
				desc: "A steady background rhythm while Obsidian is open.",
				build: (st) => {
					st.addDropdown((d) => {
						const opts: [string, string][] = [
							["0", "Off"],
							["1", "1 minute"],
							["2", "2 minutes"],
							["5", "5 minutes"],
							["10", "10 minutes"],
							["15", "15 minutes"],
							["30", "30 minutes"],
							["60", "60 minutes"],
						];
						for (const [v, l] of opts) d.addOption(v, l);
						d.setValue(String(s.autoMinutes)).onChange((v) => {
							s.autoMinutes = Number(v);
							save();
							this.plugin.scheduleAuto();
						});
					});
				},
			},
			{
				name: "Sync after edits settle",
				desc: "Wait this long after the last change, then sync.",
				help: "Each edit restarts the countdown, so a writing session becomes one sync at the end instead of one per keystroke. Offline edits are safe regardless: the next successful sync always carries everything that changed since the last one.",
				build: (st) => {
					st.addDropdown((d) => {
						const opts: [string, string][] = [
							["0", "Off"],
							["10", "10 seconds"],
							["30", "30 seconds"],
							["60", "1 minute"],
							["120", "2 minutes"],
							["300", "5 minutes"],
						];
						for (const [v, l] of opts) d.addOption(v, l);
						d.setValue(String(s.watchSeconds)).onChange((v) => {
							s.watchSeconds = Number(v);
							save();
						});
					});
				},
			},
			{
				name: "Notices",
				desc: "How chatty sync results are.",
				build: (st) => {
					st.addDropdown((d) => {
						d.addOption("errors", "Errors only");
						d.addOption("changes", "When something changed");
						d.addOption("all", "Every sync");
						d.setValue(s.notices).onChange((v) => {
							s.notices = v as PconSettings["notices"];
							save();
						});
					});
				},
			},
		];

		const conflicts: Row[] = [
			{
				name: "When both sides changed",
				desc: "The same file edited on two devices between syncs.",
				help: "Keep both is the safe default: the newer edit keeps the file's name, the older lands beside it as 'Name (sync conflict ...)', and no words are ever lost. Identical edits are detected by content and never conflict. Ask only applies to syncs you start by hand; background syncs keep both rather than interrupting.",
				build: (st) => {
					st.addDropdown((d) => {
						d.addOption("both", "Keep both copies");
						d.addOption("local", "Prefer this device");
						d.addOption("remote", "Prefer Dropbox");
						d.addOption("ask", "Ask each time");
						d.setValue(s.conflictPolicy).onChange((v) => {
							s.conflictPolicy = v as PconSettings["conflictPolicy"];
							save();
						});
					});
				},
			},
			{
				name: "Merge concurrent edits",
				desc: "When the same note changed on two devices in different places, combine both edits into one file.",
				help: "A three-way merge against the revision both edits started from: changes to different lines both land, identical changes land once, and additions at the same spot go in edit order, so every device produces the same file. Edits that collide on the same lines still keep both copies, and non-text files never merge. Applies with the Keep both and Ask policies.",
				build: (st) => {
					st.addToggle((t) =>
						t.setValue(s.autoMerge).onChange((v) => {
							s.autoMerge = v;
							save();
						})
					);
				},
			},
			{
				name: "Delete guard",
				desc: "Pause when one sync would delete more than this share of the vault.",
				help: "If the Dropbox folder is emptied, or a scan goes wrong, a naive sync would mirror that destruction. Past this threshold (and always more than 10 files), Power Connect holds the deletions: a manual sync shows them for review, a background sync completes everything else and leaves the deletions for you. Local deletions also always go to the trash, and Dropbox keeps 30 days of history.",
				build: (st) => {
					st.addSlider((sl) =>
						showSliderValue(sl)
							.setLimits(5, 100, 5)
							.setValue(s.deleteGuardPct)
							.onChange((v) => {
								s.deleteGuardPct = v;
								save();
							})
					);
				},
			},
		];

		/* ---------------- Selection ---------------- */

		let exTarget: "shared" | "device" = "shared";
		const whatSyncs: Row[] = [
			intro("Everything in the vault syncs unless excluded here. Sign-in tokens, the passphrase, and the sync journal never sync; they live in per-device storage."),
			{
				name: "Exclude patterns",
				desc: "One per line, gitignore style.",
				cls: "pcon-excludes",
				help: "Patterns match anywhere unless they contain a slash; a leading slash anchors to the vault root, a trailing slash means a folder, * matches within a name, ** crosses folders, and ! re-includes. Examples: 'Private/' skips that folder anywhere, '/Templates/' only at the root, '*.pdf' skips PDFs everywhere. Newly excluded files are left alone everywhere, never deleted.",
				build: (st) => {
					st.addTextArea((t) => {
						t.setPlaceholder("Private/\n*.mp4\n/Big Attachments/\n!Private/share.md")
							.setValue(s.excludes)
							.onChange((v) => {
								s.excludes = v;
								save();
								this.plugin.applySettings();
							});
						t.inputEl.rows = 6;
					});
				},
			},
			{
				name: "Exclude patterns, this device only",
				desc: "Same syntax; applies only here and never syncs anywhere.",
				cls: "pcon-excludes",
				help: "For keeping a lean phone against a full desktop: exclude heavy folders here on the phone and every other device still syncs them. These rules live in this device's local storage, outside every synced file, so nothing that syncs settings between devices can carry them along.",
				build: (st) => {
					st.addTextArea((t) => {
						t.setPlaceholder("Attachments/\n*.mp3")
							.setValue(this.plugin.deviceExcludes)
							.onChange((v) => this.plugin.saveDeviceExcludes(v));
						t.inputEl.rows = 3;
					});
				},
			},
			{
				name: "Exclude a folder",
				desc: "Pick a folder and its pattern is written into the chosen list for you.",
				build: (st) => {
					st.addDropdown((d) =>
						d
							.addOption("shared", "Every device")
							.addOption("device", "This device only")
							.setValue(exTarget)
							.onChange((v) => (exTarget = v as "shared" | "device"))
					);
					st.addText((t) => {
						t.setPlaceholder("start typing a folder name");
						new FolderSuggest(this.app, t.inputEl, (folder) => {
							const line = `${folder.path}/`;
							if (exTarget === "device") this.plugin.saveDeviceExcludes(this.plugin.deviceExcludes ? `${this.plugin.deviceExcludes}\n${line}` : line);
							else {
								s.excludes = s.excludes ? `${s.excludes}\n${line}` : line;
								save();
								this.plugin.applySettings();
							}
							this.refresh();
						});
					});
				},
			},
		];

		// This was a bare heading inside "What syncs" rather than a section of its
		// own, so it becomes a group and keeps the line that explained it.
		const fileTypes: Row[] = [
			intro("Sugar over the device-only patterns above: turning a type off writes its extension patterns there."),
		];
		fileTypes.push(...TYPE_GROUPS.map((g) => ({
			name: g.name,
			desc: g.exts.map((e) => `.${e}`).join(", "),
			build: (st: Setting) => {
				const lines = () => this.plugin.deviceExcludes.split(/\r?\n/).map((l) => l.trim());
				const allOff = () => g.exts.every((e) => lines().includes(`*.${e}`));
				st.addToggle((t) =>
					t.setValue(!allOff()).onChange((on) => {
						let next = lines().filter((l) => !g.exts.includes(l.replace(/^\*\./, "")));
						if (!on) next = [...next, ...g.exts.map((e) => `*.${e}`)];
						this.plugin.saveDeviceExcludes(next.filter(Boolean).join("\n"));
						this.refresh();
					})
				);
			},
		})));

		// these sat under the file-types heading in the tab bar version, so they
		// stay in that group rather than gaining a heading of their own
		const limits: Row[] = [
			{
				name: "Skip files larger than",
				desc: "Big files stay where they are, in both directions.",
				help: "Over the cap, a file neither uploads from this device nor downloads to it; the sync log records each skip. Files that already synced are never deleted by lowering the cap, and raising it brings the bigger files back into play on the next sync.",
				build: (st) => {
					st.addDropdown((d) => {
						const opts: [string, string][] = [
							["0", "No limit"],
							["5", "5 MB"],
							["10", "10 MB"],
							["25", "25 MB"],
							["50", "50 MB"],
							["100", "100 MB"],
							["250", "250 MB"],
						];
						for (const [v, l] of opts) d.addOption(v, l);
						d.setValue(String(s.maxFileMB)).onChange((v) => {
							s.maxFileMB = Number(v);
							save();
						});
					});
				},
			},
			{
				// the folder is named after the vault's own config dir, which is
				// only `.obsidian` by default
				name: `Sync Obsidian settings (${this.plugin.app.vault.configDir})`,
				desc: "Themes, snippets, app settings, plugin list, and plugin code.",
				help: "Workspace layout files stay excluded (each device keeps its own open tabs); the ribbon is the one part of them that can travel, and the toggle below carries it. Plugin settings files (data.json) are excluded by default because plugins routinely keep API keys in them; another toggle below opts them in. Power Connect itself travels like any other plugin, so an update here reaches your other devices; its journal never syncs, and its own settings file always does (it holds no credentials).",
				build: (st) => {
					st.addToggle((t) =>
						t.setValue(s.syncConfig).onChange((v) => {
							s.syncConfig = v;
							save();
							this.plugin.applySettings();
							this.refresh(); // the plugin-data row below appears or goes
						})
					);
				},
			},
		];
		if (s.syncConfig) {
			limits.push({
				name: "Include the ribbon",
				desc: "Show the same icons in the left ribbon, in the same order, on every device.",
				help: "Obsidian keeps the ribbon inside workspace.json, alongside your open tabs and pane layout, and that file stays per-device on purpose: syncing it whole would push one machine's window layout onto the others and start a conflict every time either one moved a pane. So the ribbon alone travels in Power Connect's own settings instead. Desktop and mobile keep separate ribbons. The first device to run after you turn this on sets the shared ribbon and the others adopt it; after that, a change on any device reaches the rest. An icon belonging to a plugin one device does not have keeps its place on the devices that do.",
				build: (st) => {
					st.addToggle((t) =>
						t.setValue(s.syncRibbon).onChange((v) => {
							s.syncRibbon = v;
							save();
							this.plugin.applySettings();
						})
					);
				},
			});
			limits.push({
				name: "Include plugin settings files",
				desc: "Sync every plugin's data.json too. They routinely hold API keys, so they travel only under encryption: a fully encrypted folder, or plugin settings protection chosen in the guided setup. Without either, they are held back and the sync log says so.",
				help: "Consider end-to-end encryption if you turn this on: with it, Dropbox stores only ciphertext, so keys inside plugin settings stay private. Power Connect's own data.json is always excluded regardless, since it holds your Dropbox tokens.",
				build: (st) => {
					st.addToggle((t) =>
						t.setValue(s.syncPluginData).onChange((v) => {
							s.syncPluginData = v;
							save();
							this.plugin.applySettings();
						})
					);
				},
			});
		}

		/* ---------------- Advanced ---------------- */

		const run: Row[] = [
			{
				name: "Sync",
				desc: "Run one now, or preview what the next sync would do without touching anything.",
				build: (st) => {
					st.addButton((b) => b.setButtonText("Preview sync").onClick(() => void this.plugin.previewSync()));
					st.addButton((b) =>
						b
							.setButtonText("Sync now")
							.setCta()
							.onClick(() => void this.plugin.syncNow("settings", true))
					);
				},
			},
			{
				name: "Sync log",
				desc: "What happened, file by file, this session.",
				build: (st) => {
					st.addButton((b) => b.setButtonText("Show log").onClick(() => new LogModal(this.app, this.plugin).open()));
				},
			},
		];

		const tuning: Row[] = [
			{
				name: "Parallel transfers",
				desc: "How many files move at once. Uploads stage without Dropbox's write lock and commit in batches, so higher values genuinely help on a big first sync.",
				build: (st) => {
					st.addDropdown((d) => {
						for (const n of [1, 2, 3, 4, 6, 8, 12]) d.addOption(String(n), String(n));
						d.setValue(String(s.concurrency)).onChange((v) => {
							s.concurrency = Number(v);
							save();
						});
					});
				},
			},
			{
				name: "Verbose log",
				desc: "Include debug detail in the sync log.",
				build: (st) => {
					st.addToggle((t) =>
						t.setValue(s.verboseLog).onChange((v) => {
							s.verboseLog = v;
							save();
						})
					);
				},
			},
		];

		const recovery: Row[] = [
			{
				name: "Full rescan",
				desc: "Re-check every file's content against the journal on the next sync.",
				help: "The normal scan trusts unchanged size and modification time. A full rescan rehashes everything and relists Dropbox, which catches edits that kept the same timestamp. Slower, never destructive.",
				build: (st) => {
					st.addButton((b) =>
						b.setButtonText("Rescan and sync").onClick(() => {
							(this.app as unknown as { commands: { executeCommandById: (id: string) => void } }).commands.executeCommandById("powerconnect:rescan");
						})
					);
				},
			},
			{
				name: "Reset sync state",
				desc: "Forget the sync journal on this device. The next sync re-merges both sides from scratch.",
				build: (st) => {
					st.addButton((b) =>
						markDestructive(b)
							.setButtonText("Reset")
							.onClick(() =>
								new ConfirmModal(
									this.app,
									"Reset sync state?",
									"The journal on this device is forgotten. Nothing is deleted anywhere: the next sync pairs identical files by content and keeps both versions of any file that differs (as conflict copies). Use this after changing the Dropbox folder name, or if sync seems wedged.",
									"Reset",
									() => void this.plugin.resetState()
								).open()
							)
					);
				},
			},
			{
				name: "Device name",
				desc: "How this device is called in logs and status. Stays on this device.",
				help: "Per-device, like the journal and sign-in: it never syncs, so every device can have its own.",
				build: (st) => {
					st.addText((t) =>
						t
							.setPlaceholder("for example: Work laptop")
							.setValue((this.app.loadLocalStorage("pcon-device-name") as string | null) ?? "")
							.onChange((v) => this.app.saveLocalStorage("pcon-device-name", v.trim() || null))
					);
				},
			},
		];

		const about: Row[] = [
			{
				name: `Power Connect ${this.plugin.manifest.version}`,
				desc: `Build ${PCON_BUILD}. Last synced ${this.plugin.lastSyncMs ? new Date(this.plugin.lastSyncMs).toLocaleString() : "never"}.`,
			},
		];

		return [
			{ id: "account", label: "Account", groups: accountGroups },
			{
				id: "sync",
				label: "Sync",
				groups: [
					{ heading: "When to sync", rows: whenToSync },
					{ heading: "Conflicts and safety", rows: conflicts },
				],
			},
			{
				id: "selection",
				label: "Selection",
				groups: [
					{ heading: "What syncs", rows: whatSyncs },
					{ heading: "File types on this device", rows: [...fileTypes, ...limits] },
				],
			},
			{ id: "shares", label: "Shares", groups: [{ heading: "Shares", rows: shareRows }] },
			{
				id: "advanced",
				label: "Advanced",
				groups: [
					{ heading: "Run", rows: run },
					{ heading: "Tuning", rows: tuning },
					{ heading: "Recovery", rows: recovery },
					{ heading: "About", rows: about },
				],
			},
		];
	}
}
