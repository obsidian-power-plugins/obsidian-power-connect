/* OneDrive over Microsoft Graph, satisfying the same RemoteIO surface the
 * engine drives Dropbox through. The vault lives under the app's own App
 * Folder (drive/special/approot), sign-in is the device-code flow (works
 * identically on desktop and phone: open a link anywhere, type a short
 * code), and change tracking rides the delta API. Revs are item eTags;
 * update-mode uploads use If-Match so a concurrent writer 409s instead of
 * being clobbered. Errors reuse the engine's error protocol (DropboxError
 * tags drive isConflict/isNotFound/isCursorReset regardless of provider). */

import { requestUrl, RequestUrlResponse } from "obsidian";
import { DropboxError, ListEntry, RemoteFileMeta, assertWholeDownload, backoffMs, msg, normRel, parseRetryAfter } from "./core";
import { ONEDRIVE_GRAPH as GRAPH, onedriveItemUrl, onedriveReferencePath, onedriveRelativePath } from "./onedrive-core";
import { quickXorHash } from "./quickxor";

const LOGIN = "https://login.microsoftonline.com/common/oauth2/v2.0";
const SCOPES = "Files.ReadWrite.AppFolder User.Read offline_access openid email";
const SIMPLE_MAX = 4 * 1024 * 1024;
const CHUNK = 10_485_760; // 32 x 320 KiB, the session upload granularity Graph requires

interface OneDriveOptions {
	clientId(): string;
	refreshToken(): string;
	access(): { token: string; expiry: number };
	saveTokens(refresh: string, access: string, expiry: number): void;
	log(m: string): void;
}

interface DeviceCode {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval: number;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => window.setTimeout(r, ms));
}

function graphError(r: RequestUrlResponse, doing: string): DropboxError {
	let tag = `http_${r.status}`;
	let text = "";
	try {
		const body = JSON.parse(r.text) as { error?: { code?: string; message?: string } };
		tag = body.error?.code ?? tag;
		text = body.error?.message ?? "";
	} catch {
		/* non-json body */
	}
	// map Graph's codes onto the engine's error protocol
	if (r.status === 409 || tag === "nameAlreadyExists" || r.status === 412) tag += " conflict";
	if (r.status === 404 || tag === "itemNotFound") tag += " not_found";
	if (r.status === 410 || tag === "resyncRequired") tag += " reset";
	return new DropboxError(`Could not ${doing}: ${text || tag}`, r.status, tag);
}

/** Start the device-code sign-in: the caller shows user_code and the link. */
export async function onedriveDeviceCode(clientId: string): Promise<DeviceCode> {
	const r = await requestUrl({
		url: `${LOGIN}/devicecode`,
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: `client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent(SCOPES)}`,
		throw: false,
	});
	if (r.status !== 200) throw graphError(r, "start the Microsoft sign-in");
	return JSON.parse(r.text) as DeviceCode;
}

/** Poll until the user finishes signing in; resolves with the tokens. */
export async function onedrivePollToken(clientId: string, dc: DeviceCode, cancelled: () => boolean): Promise<{ refresh: string; access: string; expiry: number }> {
	let interval = Math.max(2, dc.interval || 5) * 1000;
	for (;;) {
		if (cancelled()) throw new Error("Sign-in cancelled.");
		await sleep(interval);
		const r = await requestUrl({
			url: `${LOGIN}/token`,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: `grant_type=urn:ietf:params:oauth:grant-type:device_code&client_id=${encodeURIComponent(clientId)}&device_code=${encodeURIComponent(dc.device_code)}`,
			throw: false,
		});
		const body = JSON.parse(r.text) as { error?: string; refresh_token?: string; access_token?: string; expires_in?: number };
		if (r.status === 200 && body.access_token) {
			if (!body.refresh_token) throw new Error("Microsoft returned no refresh token. Confirm offline_access is allowed for the app, then sign in again.");
			return { refresh: body.refresh_token, access: body.access_token, expiry: Date.now() + (body.expires_in ?? 3600) * 1000 };
		}
		if (body.error === "authorization_pending") continue;
		if (body.error === "slow_down") {
			interval += 5000;
			continue;
		}
		throw new Error(`Microsoft sign-in failed: ${body.error ?? r.status}`);
	}
}

export class OneDrive {
	readonly id = "onedrive";
	readonly name = "OneDrive";
	/** Absolute Graph path prefix of the app folder, e.g.
	 *  "/drive/root:/Apps/Power Connect", learned on first use. */
	private approotPath = "";
	/** Human-readable form of approotPath, used to trim itemReference paths. */
	private approotDisplayPath = "";
	/** Coalesce the burst of refreshes when a concurrent sync reaches expiry. */
	private refreshing: Promise<string> | null = null;

	constructor(private o: OneDriveOptions) {}

	get connected(): boolean {
		return !!(this.o.clientId() && this.o.refreshToken());
	}

	private async accessToken(force = false): Promise<string> {
		const a = this.o.access();
		if (!force && a.token && Date.now() < a.expiry - 60_000) return a.token;
		if (!this.refreshing) {
			this.refreshing = (async () => {
				try {
					const r = await requestUrl({
						url: `${LOGIN}/token`,
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: `grant_type=refresh_token&client_id=${encodeURIComponent(this.o.clientId())}&refresh_token=${encodeURIComponent(this.o.refreshToken())}&scope=${encodeURIComponent(SCOPES)}`,
						throw: false,
					});
					if (r.status !== 200)
						throw new DropboxError(
							`Could not refresh the Microsoft sign-in: ${r.status}`,
							r.status,
							r.status === 400 ? "invalid_grant" : `http_${r.status}`
						);
					const body = JSON.parse(r.text) as { refresh_token?: string; access_token?: string; expires_in?: number };
					if (!body.access_token) throw new DropboxError("Microsoft returned an incomplete token response.", 0, "invalid_response");
					const expiry = Date.now() + (body.expires_in ?? 3600) * 1000;
					this.o.saveTokens(body.refresh_token ?? this.o.refreshToken(), body.access_token, expiry);
					return body.access_token;
				} finally {
					this.refreshing = null;
				}
			})();
		}
		return this.refreshing;
	}

	/** One call with the shared retry ladder: refresh once on 401, honor
	 *  Retry-After on 429, back off on 5xx and network drops. */
	private async call(url: string, doing: string, init?: { method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer }): Promise<RequestUrlResponse> {
		let auth = await this.accessToken();
		for (let attempt = 0; ; attempt++) {
			let r: RequestUrlResponse | null = null;
			try {
				r = await requestUrl({
					url,
					method: init?.method ?? "GET",
					headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${auth}` },
					body: init?.body,
					throw: false,
				});
			} catch (e) {
				if (attempt >= 4) throw new DropboxError(`Could not ${doing}: network unreachable (${msg(e)}).`, 0, "network");
				await sleep(backoffMs(attempt, 1000));
				continue;
			}
			if (r.status === 401 && attempt === 0) {
				auth = await this.accessToken(true);
				continue;
			}
			if ((r.status === 429 || r.status >= 500) && attempt < 4) {
				const wait = parseRetryAfter(r.headers["retry-after"] ?? r.headers["Retry-After"] ?? "") || backoffMs(attempt, 1000);
				this.o.log(`OneDrive is busy (${r.status}); retrying in ${Math.round(wait / 1000)}s`);
				await sleep(wait);
				continue;
			}
			return r;
		}
	}

	/** Upload-session URLs are pre-authorized and must not receive the bearer
	 * token. They still need the same retry discipline as ordinary Graph calls. */
	private async uploadChunk(url: string, path: string, body: ArrayBuffer, start: number, end: number, total: number): Promise<RequestUrlResponse> {
		for (let attempt = 0; ; attempt++) {
			let r: RequestUrlResponse;
			try {
				r = await requestUrl({
					url,
					method: "PUT",
					headers: { "Content-Length": String(end - start), "Content-Range": `bytes ${start}-${end - 1}/${total}` },
					body,
					throw: false,
				});
			} catch (e) {
				if (attempt >= 4) throw new DropboxError(`Could not upload ${path}: network unreachable (${msg(e)}).`, 0, "network");
				await sleep(backoffMs(attempt, 1000));
				continue;
			}
			if ((r.status === 429 || r.status >= 500) && attempt < 4) {
				const wait = parseRetryAfter(r.headers["retry-after"] ?? r.headers["Retry-After"] ?? "") || backoffMs(attempt, 1000);
				this.o.log(`OneDrive is busy (${r.status}); retrying an upload in ${Math.round(wait / 1000)}s`);
				await sleep(wait);
				continue;
			}
			return r;
		}
	}

	/** URL for an engine path like "/Root/sub/file.md" under the app folder. */
	private itemUrl(path: string, suffix = ""): string {
		return onedriveItemUrl(path, suffix);
	}

	private async approotBase(): Promise<string> {
		if (this.approotPath) return this.approotPath;
		const r = await this.call(`${GRAPH}/me/drive/special/approot`, "reach the app folder");
		if (r.status !== 200) throw graphError(r, "reach the app folder");
		const it = JSON.parse(r.text) as { name: string; parentReference?: { path?: string } };
		const parent = it.parentReference?.path ?? "/drive/root:";
		this.approotPath = onedriveReferencePath(parent, it.name);
		this.approotDisplayPath = `${decodeURIComponent(parent)}/${it.name}`;
		return this.approotPath;
	}

	private itemMeta(it: Record<string, unknown>): RemoteFileMeta {
		const parent = ((it.parentReference as Record<string, unknown> | undefined)?.path as string | undefined) ?? "";
		const file = it.file as Record<string, unknown> | undefined;
		const hashes = (file?.hashes as Record<string, unknown> | undefined) ?? {};
		return {
			pathDisplay: onedriveRelativePath(parent, this.approotDisplayPath, String(it.name ?? "")),
			rev: String(it.eTag ?? ""),
			size: Number(it.size ?? 0),
			contentHash: String(hashes.quickXorHash ?? ""),
			clientModified: String(((it.fileSystemInfo as Record<string, unknown> | undefined)?.lastModifiedDateTime as string | undefined) ?? it.lastModifiedDateTime ?? ""),
		};
	}

	private toEntries(items: Record<string, unknown>[]): ListEntry[] {
		const out: ListEntry[] = [];
		for (const it of items) {
			if (it.deleted) {
				const parent = ((it.parentReference as Record<string, unknown> | undefined)?.path as string | undefined) ?? "";
				out.push({ tag: "deleted", pathDisplay: onedriveRelativePath(parent, this.approotDisplayPath, String(it.name ?? "")) });
			} else if (it.folder) {
				out.push({ tag: "folder", pathDisplay: this.itemMeta(it).pathDisplay });
			} else if (it.file) {
				out.push({ tag: "file", meta: this.itemMeta(it) });
			}
		}
		return out;
	}

	async hashOf(bytes: ArrayBuffer): Promise<string> {
		return quickXorHash(bytes);
	}

	async ensureFolder(path: string): Promise<void> {
		await this.approotBase();
		const segs = normRel(path).split("/").filter(Boolean);
		let sofar = "";
		for (const seg of segs) {
			const parentUrl = sofar ? this.itemUrl(sofar, "/children") : `${GRAPH}/me/drive/special/approot/children`;
			const r = await this.call(parentUrl, `create the folder ${seg}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: seg, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
			});
			if (r.status !== 201 && r.status !== 409) throw graphError(r, `create the folder ${seg}`);
			sofar = sofar ? `${sofar}/${seg}` : seg;
		}
	}

	async listAll(root: string): Promise<{ entries: ListEntry[]; cursor: string }> {
		await this.approotBase();
		const entries: ListEntry[] = [];
		let url = this.itemUrl(root, "/delta");
		for (;;) {
			const r = await this.call(url, "list the OneDrive folder", { headers: { deltaExcludeParent: "true" } });
			if (r.status !== 200) throw graphError(r, "list the OneDrive folder");
			const body = JSON.parse(r.text) as { value: Record<string, unknown>[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };
			entries.push(...this.toEntries(body.value));
			if (body["@odata.nextLink"]) url = body["@odata.nextLink"];
			else return { entries, cursor: body["@odata.deltaLink"] ?? "" };
		}
	}

	async listContinue(cursor: string): Promise<{ entries: ListEntry[]; cursor: string }> {
		await this.approotBase();
		const entries: ListEntry[] = [];
		let url = cursor;
		for (;;) {
			const r = await this.call(url, "read OneDrive changes", { headers: { deltaExcludeParent: "true" } });
			if (r.status === 410) throw new DropboxError("delta reset", 410, "reset");
			if (r.status !== 200) throw graphError(r, "read OneDrive changes");
			const body = JSON.parse(r.text) as { value: Record<string, unknown>[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };
			entries.push(...this.toEntries(body.value));
			if (body["@odata.nextLink"]) url = body["@odata.nextLink"];
			else return { entries, cursor: body["@odata.deltaLink"] ?? cursor };
		}
	}

	async listProbe(root: string, limit = 10): Promise<ListEntry[]> {
		await this.approotBase();
		const r = await this.call(this.itemUrl(root, `/children?$top=${limit}`), "probe the OneDrive folder");
		if (r.status === 404) return [];
		if (r.status !== 200) throw graphError(r, "probe the OneDrive folder");
		const body = JSON.parse(r.text) as { value: Record<string, unknown>[] };
		return this.toEntries(body.value);
	}

	async download(path: string): Promise<{ bytes: ArrayBuffer; meta: RemoteFileMeta }> {
		await this.approotBase();
		const rm = await this.call(this.itemUrl(path), `download ${path}`);
		if (rm.status !== 200) throw graphError(rm, `download ${path}`);
		const meta = this.itemMeta(JSON.parse(rm.text) as Record<string, unknown>);
		const rc = await this.call(this.itemUrl(path, "/content"), `download ${path}`);
		if (rc.status !== 200) throw graphError(rc, `download ${path}`);
		assertWholeDownload(path, rc.arrayBuffer.byteLength, meta.size);
		return { bytes: rc.arrayBuffer, meta };
	}

	async upload(path: string, bytes: ArrayBuffer, opts: { mode: "add" | "overwrite" | { update: string }; clientModified: string }): Promise<RemoteFileMeta> {
		await this.approotBase();
		const behavior = opts.mode === "add" ? "fail" : "replace";
		const headers: Record<string, string> = {};
		if (typeof opts.mode === "object") headers["If-Match"] = opts.mode.update;
		if (bytes.byteLength <= SIMPLE_MAX) {
			const r = await this.call(this.itemUrl(path, `/content?@microsoft.graph.conflictBehavior=${behavior}`), `upload ${path}`, {
				method: "PUT",
				headers: { ...headers, "Content-Type": "application/octet-stream" },
				body: bytes,
			});
			if (r.status !== 200 && r.status !== 201) throw graphError(r, `upload ${path}`);
			const uploaded = JSON.parse(r.text) as Record<string, unknown>;
			// The content endpoint cannot carry fileSystemInfo. Stamp the client's
			// mtime immediately, guarded by the revision the upload just returned.
			const stampHeaders: Record<string, string> = { "Content-Type": "application/json" };
			if (uploaded.eTag) stampHeaders["If-Match"] = String(uploaded.eTag);
			const stamped = await this.call(this.itemUrl(path), `preserve the timestamp for ${path}`, {
				method: "PATCH",
				headers: stampHeaders,
				body: JSON.stringify({ fileSystemInfo: { lastModifiedDateTime: opts.clientModified } }),
			});
			if (stamped.status !== 200) throw graphError(stamped, `preserve the timestamp for ${path}`);
			return this.itemMeta(JSON.parse(stamped.text) as Record<string, unknown>);
		}
		const rs = await this.call(this.itemUrl(path, "/createUploadSession"), `upload ${path}`, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({
				item: {
					"@microsoft.graph.conflictBehavior": behavior,
					fileSystemInfo: { lastModifiedDateTime: opts.clientModified },
				},
			}),
		});
		if (rs.status !== 200) throw graphError(rs, `upload ${path}`);
		const session = (JSON.parse(rs.text) as { uploadUrl: string }).uploadUrl;
		let off = 0;
		while (off < bytes.byteLength) {
			const end = Math.min(off + CHUNK, bytes.byteLength);
			const r = await this.uploadChunk(session, path, bytes.slice(off, end), off, end, bytes.byteLength);
			if (r.status === 200 || r.status === 201) return this.itemMeta(JSON.parse(r.text) as Record<string, unknown>);
			if (r.status !== 202) throw graphError(r, `upload ${path}`);
			const ranges = (JSON.parse(r.text) as { nextExpectedRanges?: string[] }).nextExpectedRanges ?? [];
			const next = Number.parseInt(ranges[0]?.split("-")[0] ?? "", 10);
			off = Number.isFinite(next) && next > off ? next : end;
		}
		throw new DropboxError(`Could not upload ${path}: the session ended without a result.`, 0, "network");
	}

	async move(from: string, to: string): Promise<RemoteFileMeta> {
		await this.approotBase();
		const toRel = normRel(to);
		const parent = toRel.includes("/") ? toRel.slice(0, toRel.lastIndexOf("/")) : "";
		const name = toRel.slice(toRel.lastIndexOf("/") + 1);
		// parentReference.path is returned as useful metadata, but Graph marks it
		// read-only. Resolve the target folder and move by its stable item id.
		const parentMeta = await this.call(parent ? this.itemUrl(parent) : `${GRAPH}/me/drive/special/approot`, `find the destination for ${to}`);
		if (parentMeta.status !== 200) throw graphError(parentMeta, `find the destination for ${to}`);
		const parentId = String((JSON.parse(parentMeta.text) as { id?: string }).id ?? "");
		if (!parentId) throw new DropboxError(`Could not find the destination for ${to}: OneDrive returned no folder id.`, 0, "invalid_response");
		const r = await this.call(this.itemUrl(from), `move ${from}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name,
				parentReference: { id: parentId },
			}),
		});
		if (r.status !== 200) throw graphError(r, `move ${from}`);
		return this.itemMeta(JSON.parse(r.text) as Record<string, unknown>);
	}

	async del(path: string, parentRev?: string): Promise<void> {
		await this.approotBase();
		const headers: Record<string, string> = {};
		if (parentRev) headers["If-Match"] = parentRev;
		const r = await this.call(this.itemUrl(path), `delete ${path}`, { method: "DELETE", headers });
		if (r.status === 404) return; // already gone is the goal state
		if (r.status !== 204) throw graphError(r, `delete ${path}`);
	}

	async account(): Promise<{ email: string; name: string }> {
		const r = await this.call(`${GRAPH}/me`, "read the Microsoft account");
		if (r.status !== 200) throw graphError(r, "read the Microsoft account");
		const b = JSON.parse(r.text) as { displayName?: string; mail?: string; userPrincipalName?: string };
		return { email: b.mail ?? b.userPrincipalName ?? "", name: b.displayName ?? "" };
	}

	async spaceUsage(): Promise<{ used: number; allocated: number }> {
		const r = await this.call(`${GRAPH}/me/drive`, "read OneDrive usage");
		if (r.status !== 200) throw graphError(r, "read OneDrive usage");
		const q = (JSON.parse(r.text) as { quota?: { used?: number; total?: number } }).quota ?? {};
		return { used: q.used ?? 0, allocated: q.total ?? 0 };
	}

	async revoke(): Promise<void> {
		// Microsoft has no token revocation endpoint for this flow; the
		// caller clears the stored tokens, which is the whole sign-out
	}
}
