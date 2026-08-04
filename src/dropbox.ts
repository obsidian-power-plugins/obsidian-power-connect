import { Platform, requestUrl, RequestUrlResponse } from "obsidian";
import { BatchCommit, BatchResult, DropboxError, ListEntry, RemoteFileMeta, asciiJsonHeader, assertWholeDownload, assertWholeUpload, backoffMs, isConflict, isNotFound, parseRetryAfter } from "./core";

/** On desktop, requestUrl (Electron's stack, no CORS constraints). On
 *  mobile, the webview's own fetch: the app-level native stack has been
 *  seen getting its connections reset by Dropbox's edge while Safari's
 *  stack on the same phone sails through, and Dropbox's API speaks
 *  browser CORS precisely so web clients can call it directly. */
async function transport(o: { url: string; method: string; contentType?: string; headers?: Record<string, string>; body?: string | ArrayBuffer }): Promise<RequestUrlResponse> {
	const headers = { ...(o.headers ?? {}) };
	if (o.contentType) headers["Content-Type"] = o.contentType;
	if (!Platform.isMobileApp) {
		return requestUrl({ url: o.url, method: o.method, headers, body: o.body, throw: false });
	}
	const res = await window.fetch(o.url, { method: o.method, headers, body: o.body });
	const buf = await res.arrayBuffer();
	const h: Record<string, string> = {};
	res.headers.forEach((v, k) => (h[k] = v));
	let text = "";
	try {
		text = new TextDecoder().decode(buf);
	} catch {
		text = "";
	}
	return {
		status: res.status,
		headers: h,
		arrayBuffer: buf,
		text,
		get json() {
			return JSON.parse(text) as unknown;
		},
	};
}

/* Dropbox v2: requestUrl on desktop (Electron, no CORS), the webview fetch
 * on mobile (see transport above). Auth is OAuth2 with PKCE against the user's own Dropbox app
 * (an app key is not a secret under PKCE). No redirect URI: Dropbox shows
 * the authorization code on screen and the user pastes it in, the one flow
 * that works identically on Windows, macOS, and iOS with no local server
 * and no protocol-handler registration. */

const API = "https://api.dropboxapi.com/2/";
const CONTENT = "https://content.dropboxapi.com/2/";
const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const AUTH_BASE = "https://www.dropbox.com/oauth2/authorize";

/** Single-call upload limit is 150 MB; stay well under it and keep memory
 *  peaks tame on phones by chunking anything past 16 MB. */
const CHUNK = 16 * 1024 * 1024;

interface TokenReply {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
}

function form(o: Record<string, string>): string {
	return Object.entries(o)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join("&");
}

/** requestUrl's `.json` throws on a non-JSON body; never let that mask the
 *  real status. */
function bodyJson(r: RequestUrlResponse): Record<string, unknown> | null {
	try {
		return (r.json as Record<string, unknown>) ?? null;
	} catch {
		return null;
	}
}

function header(r: RequestUrlResponse, name: string): string | undefined {
	const h = r.headers ?? {};
	for (const k of Object.keys(h)) if (k.toLowerCase() === name.toLowerCase()) return h[k];
	return undefined;
}

/** Collect the ".tag" chain out of a Dropbox error union, e.g.
 *  "path/not_found", so callers can branch without string-mining prose. */
function errTag(v: unknown, depth = 0): string {
	if (!v || typeof v !== "object" || depth > 6) return "";
	const o = v as Record<string, unknown>;
	const own = typeof o[".tag"] === "string" ? (o[".tag"]) : "";
	for (const k of Object.keys(o)) {
		if (k === ".tag") continue;
		const sub = errTag(o[k], depth + 1);
		if (sub) return own ? `${own}/${sub}` : sub;
	}
	return own;
}

function apiError(r: RequestUrlResponse, doing: string): DropboxError {
	const body = bodyJson(r);
	const tag = errTag(body?.error);
	const summary = typeof body?.error_summary === "string" ? body.error_summary : "";
	const msg = summary || (typeof r.text === "string" && r.text ? r.text.slice(0, 200) : `HTTP ${r.status}`);
	return new DropboxError(`Could not ${doing}: ${msg}`, r.status, tag || summary);
}

function fileMeta(o: Record<string, unknown>): RemoteFileMeta {
	return {
		pathDisplay: String(o.path_display ?? o.path_lower ?? ""),
		rev: String(o.rev ?? ""),
		size: Number(o.size ?? 0),
		contentHash: String(o.content_hash ?? ""),
		clientModified: String(o.client_modified ?? ""),
	};
}

/** Wait for the folder behind `cursor` to change. No auth header: the
 *  cursor itself is the credential, per Dropbox's notify endpoint. The
 *  server holds the request up to `timeoutSec` plus its own jitter, so
 *  callers should expect this to sit quietly for a minute or two. */
export async function longpollChanges(cursor: string, timeoutSec = 60): Promise<{ changes: boolean; backoff?: number }> {
	const r = await transport({
		url: "https://notify.dropboxapi.com/2/files/list_folder/longpoll",
		method: "POST",
		contentType: "application/json",
		body: JSON.stringify({ cursor, timeout: timeoutSec }),
	});
	if (r.status !== 200) throw apiError(r, "watch Dropbox for changes");
	const b = bodyJson(r) ?? {};
	return { changes: !!b.changes, backoff: typeof b.backoff === "number" ? (b.backoff) : undefined };
}

export function authUrl(appKey: string, challenge: string): string {
	return `${AUTH_BASE}?${form({
		client_id: appKey,
		response_type: "code",
		code_challenge: challenge,
		code_challenge_method: "S256",
		token_access_type: "offline",
	})}`;
}

async function oauthToken(params: Record<string, string>, doing: string): Promise<TokenReply> {
	const r = await transport({
		url: TOKEN_URL,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		body: form(params),
	});
	if (r.status !== 200) {
		const body = bodyJson(r);
		const code = typeof body?.error === "string" ? (body.error) : "";
		const desc = typeof body?.error_description === "string" ? (body.error_description) : "";
		throw new DropboxError(`Could not ${doing}: ${desc || code || `HTTP ${r.status}`}`, r.status, code);
	}
	return r.json as TokenReply;
}

export function exchangeCode(appKey: string, code: string, verifier: string): Promise<TokenReply> {
	return oauthToken({ code: code.trim(), grant_type: "authorization_code", code_verifier: verifier, client_id: appKey }, "finish Dropbox sign-in");
}

export class Dropbox {
	readonly id = "dropbox";
	readonly name = "Dropbox";
	private refreshing: Promise<string> | null = null;

	constructor(
		private o: {
			appKey: () => string;
			refreshToken: () => string;
			access: () => { token: string; expiry: number };
			saveAccess: (token: string, expiry: number) => void;
			log: (m: string) => void;
		}
	) {}

	get connected(): boolean {
		return !!(this.o.appKey() && this.o.refreshToken());
	}

	private async accessToken(force = false): Promise<string> {
		const cur = this.o.access();
		if (!force && cur.token && cur.expiry - Date.now() > 300_000) return cur.token;
		if (!this.refreshing) {
			this.refreshing = (async () => {
				try {
					const t = await oauthToken(
						{ grant_type: "refresh_token", refresh_token: this.o.refreshToken(), client_id: this.o.appKey() },
						"refresh the Dropbox session"
					);
					this.o.saveAccess(t.access_token, Date.now() + t.expires_in * 1000);
					return t.access_token;
				} finally {
					this.refreshing = null;
				}
			})();
		}
		return this.refreshing;
	}

	/** One HTTP call with the shared retry ladder: refresh once on 401, honor
	 *  Retry-After on 429, back off on 5xx and network drops. */
	private async call(url: string, headers: Record<string, string>, body: string | ArrayBuffer, doing: string): Promise<RequestUrlResponse> {
		let auth = await this.accessToken();
		for (let attempt = 0; ; attempt++) {
			let r: RequestUrlResponse | null = null;
			try {
				// an empty-string body is not the same wire shape as no body:
				// some stacks frame it in ways edges reject mid-connection,
				// and download-style calls need no body at all
				r = await transport({ url, method: "POST", headers: { ...headers, Authorization: `Bearer ${auth}` }, body: body === "" ? undefined : body });
			} catch (e) {
				// never summarize away the real failure: on phones especially,
				// "network unreachable" can be DNS, TLS, a denied cellular
				// path, or a webview quirk, and the message is the only clue
				const detail = e instanceof Error ? e.message : String(e);
				this.o.log(`request failed (attempt ${attempt + 1}/5) while trying to ${doing}: ${detail}`);
				if (attempt >= 4) throw new DropboxError(`Could not ${doing}: network unreachable (${detail}).`, 0, "network");
				await sleep(backoffMs(attempt, 1000));
				continue;
			}
			if (r.status === 401 && attempt === 0) {
				auth = await this.accessToken(true);
				continue;
			}
			if ((r.status === 429 || r.status >= 500) && attempt < 4) {
				const wait = parseRetryAfter(header(r, "retry-after")) || backoffMs(attempt, 1000);
				this.o.log(`Dropbox is busy (${r.status}); retrying in ${Math.round(wait / 1000)}s`);
				await sleep(wait);
				continue;
			}
			return r;
		}
	}

	private async rpc(name: string, args: unknown, doing: string): Promise<Record<string, unknown>> {
		const r = await this.call(API + name, { "Content-Type": "application/json" }, JSON.stringify(args ?? null), doing);
		if (r.status !== 200) throw apiError(r, doing);
		return bodyJson(r) ?? {};
	}

	/* ---------- account ---------- */

	async account(): Promise<{ email: string; name: string }> {
		const a = await this.rpc("users/get_current_account", null, "read the Dropbox account");
		const name = a.name as Record<string, unknown> | undefined;
		return { email: String(a.email ?? ""), name: String(name?.display_name ?? "") };
	}

	async spaceUsage(): Promise<{ used: number; allocated: number }> {
		const s = await this.rpc("users/get_space_usage", null, "read Dropbox space usage");
		const alloc = s.allocation as Record<string, unknown> | undefined;
		return { used: Number(s.used ?? 0), allocated: Number(alloc?.allocated ?? 0) };
	}

	async revoke(): Promise<void> {
		try {
			await this.rpc("auth/token/revoke", null, "sign out of Dropbox");
		} catch {
			/* revoking a dead token is fine */
		}
	}

	/* ---------- metadata ---------- */

	async ensureFolder(path: string): Promise<void> {
		try {
			await this.rpc("files/create_folder_v2", { path, autorename: false }, "create the Dropbox folder");
		} catch (e) {
			if (isConflict(e)) return; // already exists
			throw e;
		}
	}

	private toEntries(raw: unknown[]): ListEntry[] {
		const out: ListEntry[] = [];
		for (const e of raw) {
			const o = e as Record<string, unknown>;
			const tag = String(o[".tag"] ?? "");
			if (tag === "file") out.push({ tag: "file", meta: fileMeta(o) });
			else if (tag === "deleted") out.push({ tag: "deleted", pathDisplay: String(o.path_display ?? o.path_lower ?? "") });
			else if (tag === "folder") out.push({ tag: "folder", pathDisplay: String(o.path_display ?? "") });
		}
		return out;
	}

	async listAll(root: string): Promise<{ entries: ListEntry[]; cursor: string }> {
		let res = await this.rpc("files/list_folder", { path: root, recursive: true, limit: 2000 }, "list the Dropbox folder");
		const entries = this.toEntries((res.entries as unknown[]) ?? []);
		let cursor = String(res.cursor ?? "");
		for (let page = 0; res.has_more && page < 500; page++) {
			res = await this.rpc("files/list_folder/continue", { cursor }, "list the Dropbox folder");
			entries.push(...this.toEntries((res.entries as unknown[]) ?? []));
			cursor = String(res.cursor ?? cursor);
		}
		return { entries, cursor };
	}

	async listContinue(cursor: string): Promise<{ entries: ListEntry[]; cursor: string }> {
		let cur = cursor;
		const entries: ListEntry[] = [];
		for (let page = 0; page < 500; page++) {
			const res = await this.rpc("files/list_folder/continue", { cursor: cur }, "read Dropbox changes");
			entries.push(...this.toEntries((res.entries as unknown[]) ?? []));
			cur = String(res.cursor ?? cur);
			if (!res.has_more) break;
		}
		return { entries, cursor: cur };
	}

	async move(from: string, to: string): Promise<RemoteFileMeta> {
		const res = await this.rpc("files/move_v2", { from_path: from, to_path: to, autorename: false }, `move ${from}`);
		return fileMeta((res.metadata as Record<string, unknown>) ?? {});
	}

	/** Delete with a precondition: pass the rev the caller last synced so a
	 *  file another device just replaced 409s instead of losing the new
	 *  content. Already-gone is the goal state, not an error. */
	async del(path: string, parentRev?: string): Promise<void> {
		try {
			await this.rpc("files/delete_v2", parentRev ? { path, parent_rev: parentRev } : { path }, `delete ${path}`);
		} catch (e) {
			if (isNotFound(e)) return;
			throw e;
		}
	}

	/** One page of listing, for cheap "is this folder empty" probes. */
	async listProbe(root: string, limit = 10): Promise<ListEntry[]> {
		const res = await this.rpc("files/list_folder", { path: root, recursive: true, limit }, "check the Dropbox folder");
		return this.toEntries((res.entries as unknown[]) ?? []);
	}

	/* ---------- content ---------- */

	async download(path: string): Promise<{ bytes: ArrayBuffer; meta: RemoteFileMeta }> {
		const r = await this.call(CONTENT + "files/download", { "Dropbox-API-Arg": asciiJsonHeader({ path }) }, "", `download ${path}`);
		if (r.status !== 200) throw apiError(r, `download ${path}`);
		const metaRaw = header(r, "dropbox-api-result");
		const meta = fileMeta(metaRaw ? (JSON.parse(metaRaw) as Record<string, unknown>) : {});
		assertWholeDownload(path, r.arrayBuffer.byteLength, meta.size);
		return { bytes: r.arrayBuffer, meta };
	}

	/** Upload with the mode the planner decided: "add" fails if the file
	 *  appeared remotely in the meantime, {update: rev} fails if it moved past
	 *  the rev we synced from, and both failures surface as a conflict for the
	 *  next run instead of silently overwriting anyone. "overwrite" is for
	 *  conflict resolutions, where the engine has already compared content. */
	async upload(path: string, bytes: ArrayBuffer, opts: { mode: "add" | "overwrite" | { update: string }; clientModified: string }): Promise<RemoteFileMeta> {
		const commit = {
			path,
			mode: typeof opts.mode === "string" ? opts.mode : { ".tag": "update", update: opts.mode.update },
			autorename: false,
			client_modified: opts.clientModified,
			mute: true,
		};
		if (bytes.byteLength <= CHUNK) {
			const r = await this.call(
				CONTENT + "files/upload",
				{ "Dropbox-API-Arg": asciiJsonHeader(commit), "Content-Type": "application/octet-stream" },
				bytes,
				`upload ${path}`
			);
			if (r.status !== 200) throw apiError(r, `upload ${path}`);
			const meta = fileMeta(bodyJson(r) ?? {});
			assertWholeUpload(path, bytes.byteLength, meta.size);
			return meta;
		}
		// session upload for big files, one chunk at a time
		const first = await this.call(
			CONTENT + "files/upload_session/start",
			{ "Dropbox-API-Arg": asciiJsonHeader({ close: false }), "Content-Type": "application/octet-stream" },
			bytes.slice(0, CHUNK),
			`upload ${path}`
		);
		if (first.status !== 200) throw apiError(first, `upload ${path}`);
		const sessionId = String((bodyJson(first) ?? {}).session_id ?? "");
		let offset = CHUNK;
		while (bytes.byteLength - offset > CHUNK) {
			const r = await this.call(
				CONTENT + "files/upload_session/append_v2",
				{ "Dropbox-API-Arg": asciiJsonHeader({ cursor: { session_id: sessionId, offset }, close: false }), "Content-Type": "application/octet-stream" },
				bytes.slice(offset, offset + CHUNK),
				`upload ${path}`
			);
			if (r.status !== 200) throw apiError(r, `upload ${path}`);
			offset += CHUNK;
		}
		const fin = await this.call(
			CONTENT + "files/upload_session/finish",
			{ "Dropbox-API-Arg": asciiJsonHeader({ cursor: { session_id: sessionId, offset }, commit }), "Content-Type": "application/octet-stream" },
			bytes.slice(offset),
			`upload ${path}`
		);
		if (fin.status !== 200) throw apiError(fin, `upload ${path}`);
		const meta = fileMeta(bodyJson(fin) ?? {});
		assertWholeUpload(path, bytes.byteLength, meta.size);
		return meta;
	}

	/** A past revision's content, for three-way merges. Dropbox keeps 30
	 *  days of history; an expired rev throws and the caller keeps both. */
	async downloadRev(rev: string): Promise<ArrayBuffer> {
		const r = await this.call(CONTENT + "files/download", { "Dropbox-API-Arg": asciiJsonHeader({ path: "rev:" + rev }) }, "", `download revision ${rev}`);
		if (r.status !== 200) throw apiError(r, `download revision ${rev}`);
		const metaRaw = header(r, "dropbox-api-result");
		assertWholeDownload(`revision ${rev}`, r.arrayBuffer.byteLength, fileMeta(metaRaw ? (JSON.parse(metaRaw) as Record<string, unknown>) : {}).size);
		return r.arrayBuffer;
	}

	/* ---------- sharing links ---------- */

	/** The public link for a file, created if it has none. Verified against
	 *  the live API on 2026-07-25: an App-folder-scoped app may do this for
	 *  content inside its own app folder, so sharing costs one added
	 *  permission (`sharing.write`) and no widening of what this app can see.
	 *
	 *  Dropbox rejects a second link for the same file rather than returning
	 *  the first, so the conflict is the normal path on every republish, not
	 *  an error. */
	async createOrGetLink(path: string): Promise<string> {
		try {
			const r = await this.rpc(
				"sharing/create_shared_link_with_settings",
				{ path, settings: { audience: "public", access: "viewer", allow_download: true } },
				`share ${path}`
			);
			return String(r.url ?? "");
		} catch (e) {
			if (!(e instanceof DropboxError) || !/shared_link_already_exists/.test(e.tag || "")) throw e;
			const r = await this.rpc("sharing/list_shared_links", { path, direct_only: true }, `read the link for ${path}`);
			const links = (r.links as Record<string, unknown>[] | undefined) ?? [];
			const url = links.length ? String(links[0].url ?? "") : "";
			if (!url) throw e;
			return url;
		}
	}

	/** Set or clear a link's expiry. Dropbox enforces it server-side, which is
	 *  what makes an expiring share mean something: after the date the link
	 *  404s whether or not the owner's Obsidian ever opens again. */
	async setLinkExpiry(url: string, isoOrNull: string | null): Promise<void> {
		await this.rpc(
			"sharing/modify_shared_link_settings",
			isoOrNull ? { url, settings: { expires: isoOrNull } } : { url, settings: {}, remove_expiration: true },
			"change a share link's expiry"
		);
	}

	/** Withdraw a link. The bytes may live on for a moment behind Dropbox's
	 *  caches, so this is the first half of revoking access, never the whole
	 *  of it: rotating the share key is what actually ends it. */
	async revokeLink(url: string): Promise<void> {
		try {
			await this.rpc("sharing/revoke_shared_link", { url }, "revoke a share link");
		} catch (e) {
			if (isNotFound(e)) return;
			throw e;
		}
	}

	/** Stage one file's bytes as a closed upload session. Sessions do not
	 *  take the per-account write lock that files/upload commits do, so
	 *  these run genuinely in parallel. */
	async uploadStart(bytes: ArrayBuffer): Promise<string> {
		const r = await this.call(
			CONTENT + "files/upload_session/start",
			{ "Dropbox-API-Arg": asciiJsonHeader({ close: true }), "Content-Type": "application/octet-stream" },
			bytes,
			"stage an upload"
		);
		if (r.status !== 200) throw apiError(r, "stage an upload");
		return String((bodyJson(r) ?? {}).session_id ?? "");
	}

	/** Commit up to 1000 staged sessions in one call; one result per entry,
	 *  in order. */
	async uploadFinishBatch(entries: BatchCommit[]): Promise<BatchResult[]> {
		const body = await this.rpc(
			"files/upload_session/finish_batch_v2",
			{
				entries: entries.map((e) => ({
					cursor: { session_id: e.sessionId, offset: e.size },
					commit: {
						path: e.path,
						mode: typeof e.mode === "string" ? e.mode : { ".tag": "update", update: e.mode.update },
						autorename: false,
						client_modified: e.clientModified,
						mute: true,
					},
				})),
			},
			"commit uploads"
		);
		const out = (body.entries as Record<string, unknown>[] | undefined) ?? [];
		return entries.map((_, i) => {
			const entry = out[i];
			if (entry && entry[".tag"] === "success") {
				const meta = fileMeta(entry);
				// a commit that stored fewer bytes than were staged is a failed
				// upload, not a success: reporting ok here is what let a stump be
				// recorded as synced and then propagate to every other device
				if (meta.size !== entries[i].size)
					return { ok: false, error: `stored ${meta.size} bytes of ${entries[i].size}; not recorded, will re-upload` };
				return { ok: true, meta };
			}
			return { ok: false, error: entry ? JSON.stringify(entry).slice(0, 200) : "no result for this file" };
		});
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => window.setTimeout(r, ms));
}
