/* Google Drive behind the engine's RemoteIO surface. Drive is ID-based
 * where the engine thinks in paths, so this adapter keeps a path-to-id
 * index rebuilt from listings and maintained by the changes feed. The
 * drive.file scope means the app sees only what it created: the vault's
 * root folder here is the whole visible world, an app folder in effect.
 * Revs are headRevisionId; update-mode uploads compare-before-write and
 * the engine's next run reconciles the narrow race that leaves. Sign-in
 * is OAuth with a loopback redirect, which needs a desktop; phones join
 * a Google vault after a desktop connects once per device. Merges get
 * real base content from the revisions API. */

import { Platform, requestUrl, RequestUrlResponse } from "obsidian";
import { DropboxError, ListEntry, RemoteFileMeta, assertWholeDownload, backoffMs, msg, normKey, normRel, parseRetryAfter, randB64url, pkceChallenge } from "./core";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const TOKEN = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.file email";
const FILE_FIELDS = "id,name,mimeType,parents,trashed,headRevisionId,sha256Checksum,modifiedTime,size";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const SIMPLE_MAX = 5 * 1024 * 1024;

interface GDriveOptions {
	clientId(): string;
	clientSecret(): string;
	refreshToken(): string;
	access(): { token: string; expiry: number };
	saveTokens(refresh: string, access: string, expiry: number): void;
	log(m: string): void;
}

interface GFile {
	id: string;
	name: string;
	mimeType: string;
	parents?: string[];
	trashed?: boolean;
	headRevisionId?: string;
	sha256Checksum?: string;
	modifiedTime?: string;
	size?: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => window.setTimeout(r, ms));
}

function gError(r: RequestUrlResponse, doing: string): DropboxError {
	let reason = `http_${r.status}`;
	let text = "";
	try {
		const b = JSON.parse(r.text) as { error?: { message?: string; errors?: { reason?: string }[] } };
		reason = b.error?.errors?.[0]?.reason ?? reason;
		text = b.error?.message ?? "";
	} catch {
		/* non-json */
	}
	if (r.status === 404) reason += " not_found";
	if (r.status === 409 || r.status === 412) reason += " conflict";
	return new DropboxError(`Could not ${doing}: ${text || reason}`, r.status, reason);
}

/** Desktop-only sign-in: a loopback server catches the OAuth redirect. */
export async function gdriveSignIn(clientId: string, clientSecret: string, openUrl: (url: string) => void): Promise<{ refresh: string; access: string; expiry: number }> {
	if (!Platform.isDesktopApp) throw new Error("Google sign-in needs a desktop; connect there first.");
	const http = require("node:http") as typeof import("node:http");
	const verifier = randB64url(48);
	const challenge = await pkceChallenge(verifier);
	let redirectUsed = "";
	const code = await new Promise<string>((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const u = new URL(req.url ?? "/", "http://127.0.0.1");
			const got = u.searchParams.get("code");
			const err = u.searchParams.get("error");
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end("<html><body><p>Power Connect is connected. You can close this tab and return to Obsidian.</p></body></html>");
			if (got || err) {
				server.close();
				window.clearTimeout(timer);
				if (got) resolve(got);
				else reject(new Error(`Google sign-in failed: ${err}`));
			}
		});
		const timer = window.setTimeout(
			() => {
				server.close();
				reject(new Error("Google sign-in timed out."));
			},
			5 * 60_000
		);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			redirectUsed = `http://127.0.0.1:${port}`;
			const url =
				"https://accounts.google.com/o/oauth2/v2/auth" +
				`?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUsed)}` +
				`&response_type=code&scope=${encodeURIComponent(SCOPE)}&access_type=offline&prompt=consent` +
				`&code_challenge=${challenge}&code_challenge_method=S256`;
			openUrl(url);
		});
	});
	// the exchange must present the exact loopback redirect the code was
	// issued against, port included
	const r = await requestUrl({
		url: TOKEN,
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body:
			`grant_type=authorization_code&code=${encodeURIComponent(code)}&client_id=${encodeURIComponent(clientId)}` +
			`&client_secret=${encodeURIComponent(clientSecret)}&code_verifier=${verifier}&redirect_uri=${encodeURIComponent(redirectUsed)}`,
		throw: false,
	});
	if (r.status !== 200) throw new Error(`Google token exchange failed (${r.status}).`);
	const b = JSON.parse(r.text) as { refresh_token?: string; access_token: string; expires_in: number };
	return { refresh: b.refresh_token ?? "", access: b.access_token, expiry: Date.now() + b.expires_in * 1000 };
}

export class GDrive {
	readonly id = "gdrive";
	readonly name = "Google Drive";
	/** path (normKey, relative to the drive root) -> id, for folders and files */
	private ids = new Map<string, string>();
	private folderIds = new Map<string, string>(); // id -> path, for change resolution
	private rootId = "";
	private rootName = "";

	constructor(private o: GDriveOptions) {}

	get connected(): boolean {
		return !!(this.o.clientId() && this.o.refreshToken());
	}

	private async accessToken(): Promise<string> {
		const a = this.o.access();
		if (a.token && Date.now() < a.expiry - 60_000) return a.token;
		const r = await requestUrl({
			url: TOKEN,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body:
				`grant_type=refresh_token&refresh_token=${encodeURIComponent(this.o.refreshToken())}` +
				`&client_id=${encodeURIComponent(this.o.clientId())}&client_secret=${encodeURIComponent(this.o.clientSecret())}`,
			throw: false,
		});
		if (r.status !== 200) throw new DropboxError(`Could not refresh the Google sign-in: ${r.status}`, r.status, r.status === 400 ? "invalid_grant" : `http_${r.status}`);
		const b = JSON.parse(r.text) as { access_token: string; expires_in: number };
		const expiry = Date.now() + b.expires_in * 1000;
		this.o.saveTokens(this.o.refreshToken(), b.access_token, expiry);
		return b.access_token;
	}

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
				this.o.saveTokens(this.o.refreshToken(), "", 0);
				auth = await this.accessToken();
				continue;
			}
			if ((r.status === 429 || r.status >= 500) && attempt < 4) {
				const wait = parseRetryAfter(r.headers["retry-after"] ?? r.headers["Retry-After"] ?? "") || backoffMs(attempt, 1000);
				this.o.log(`Google Drive is busy (${r.status}); retrying in ${Math.round(wait / 1000)}s`);
				await sleep(wait);
				continue;
			}
			return r;
		}
	}

	private meta(f: GFile, path: string): RemoteFileMeta {
		return {
			pathDisplay: path,
			rev: f.headRevisionId ?? "",
			size: Number(f.size ?? 0),
			contentHash: f.sha256Checksum ?? "",
			clientModified: f.modifiedTime ?? "",
		};
	}

	async hashOf(bytes: ArrayBuffer): Promise<string> {
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	}

	private async query(q: string, doing: string, pageToken?: string): Promise<{ files: GFile[]; nextPageToken?: string }> {
		const url =
			`${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`nextPageToken,files(${FILE_FIELDS})`)}` +
			`&pageSize=1000&spaces=drive${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
		const r = await this.call(url, doing);
		if (r.status !== 200) throw gError(r, doing);
		return JSON.parse(r.text) as { files: GFile[]; nextPageToken?: string };
	}

	/** Root folder for the engine root ("/Vault"): find or create at My Drive. */
	private async ensureRoot(root: string): Promise<string> {
		const name = normRel(root);
		if (this.rootId && this.rootName === name) return this.rootId;
		const found = await this.query(`name='${name.replace(/'/g, "\\'")}' and mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`, "find the Drive folder");
		let id = found.files[0]?.id ?? "";
		if (!id) {
			const r = await this.call(`${API}/files?fields=${encodeURIComponent(FILE_FIELDS)}`, "create the Drive folder", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: ["root"] }),
			});
			if (r.status !== 200) throw gError(r, "create the Drive folder");
			id = (JSON.parse(r.text) as GFile).id;
		}
		this.rootId = id;
		this.rootName = name;
		this.ids.set(normKey(name), id);
		this.folderIds.set(id, name);
		return id;
	}

	async ensureFolder(path: string): Promise<void> {
		const segs = normRel(path).split("/").filter(Boolean);
		if (!segs.length) return;
		let parentId = await this.ensureRoot(segs[0]);
		let sofar = segs[0];
		for (const seg of segs.slice(1)) {
			sofar = `${sofar}/${seg}`;
			const known = this.ids.get(normKey(sofar));
			if (known) {
				parentId = known;
				continue;
			}
			const found = await this.query(`name='${seg.replace(/'/g, "\\'")}' and mimeType='${FOLDER_MIME}' and '${parentId}' in parents and trashed=false`, "find a folder");
			let id = found.files[0]?.id ?? "";
			if (!id) {
				const r = await this.call(`${API}/files?fields=${encodeURIComponent(FILE_FIELDS)}`, `create the folder ${seg}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: seg, mimeType: FOLDER_MIME, parents: [parentId] }),
				});
				if (r.status !== 200) throw gError(r, `create the folder ${seg}`);
				id = (JSON.parse(r.text) as GFile).id;
			}
			this.ids.set(normKey(sofar), id);
			this.folderIds.set(id, sofar);
			parentId = id;
		}
	}

	async listAll(root: string): Promise<{ entries: ListEntry[]; cursor: string }> {
		const rootName = normRel(root);
		const rootId = await this.ensureRoot(rootName);
		this.ids = new Map([[normKey(rootName), rootId]]);
		this.folderIds = new Map([[rootId, rootName]]);
		const entries: ListEntry[] = [];
		const queue: { id: string; path: string }[] = [{ id: rootId, path: rootName }];
		while (queue.length) {
			const { id, path } = queue.shift() as { id: string; path: string };
			let pageToken: string | undefined;
			do {
				const page = await this.query(`'${id}' in parents and trashed=false`, "list the Drive folder", pageToken);
				for (const f of page.files) {
					const p = `${path}/${f.name}`;
					if (f.mimeType === FOLDER_MIME) {
						this.ids.set(normKey(p), f.id);
						this.folderIds.set(f.id, p);
						entries.push({ tag: "folder", pathDisplay: `/${p}` });
						queue.push({ id: f.id, path: p });
					} else {
						this.ids.set(normKey(p), f.id);
						entries.push({ tag: "file", meta: this.meta(f, `/${p}`) });
					}
				}
				pageToken = page.nextPageToken;
			} while (pageToken);
		}
		const r = await this.call(`${API}/changes/startPageToken`, "read the Drive change token");
		if (r.status !== 200) throw gError(r, "read the Drive change token");
		return { entries, cursor: (JSON.parse(r.text) as { startPageToken: string }).startPageToken };
	}

	private async pathOfParent(parentId: string): Promise<string | null> {
		const known = this.folderIds.get(parentId);
		if (known !== undefined) return known;
		const r = await this.call(`${API}/files/${parentId}?fields=${encodeURIComponent(FILE_FIELDS)}`, "resolve a folder");
		if (r.status !== 200) return null;
		const f = JSON.parse(r.text) as GFile;
		if (f.mimeType !== FOLDER_MIME) return null;
		const pp = f.parents?.[0] ? await this.pathOfParent(f.parents[0]) : null;
		const path = pp == null ? f.name : `${pp}/${f.name}`;
		// only paths under the synced root matter; anything else is invisible
		if (normKey(path) !== normKey(this.rootName) && !normKey(path).startsWith(normKey(this.rootName) + "/")) return null;
		this.folderIds.set(parentId, path);
		return path;
	}

	async listContinue(cursor: string): Promise<{ entries: ListEntry[]; cursor: string }> {
		const entries: ListEntry[] = [];
		let token = cursor;
		for (;;) {
			const url =
				`${API}/changes?pageToken=${encodeURIComponent(token)}&spaces=drive&pageSize=1000` +
				`&fields=${encodeURIComponent(`nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`)}`;
			const r = await this.call(url, "read Drive changes");
			if (r.status === 404 || r.status === 400) throw new DropboxError("change token reset", r.status, "reset");
			if (r.status !== 200) throw gError(r, "read Drive changes");
			const body = JSON.parse(r.text) as { changes: { fileId: string; removed?: boolean; file?: GFile }[]; nextPageToken?: string; newStartPageToken?: string };
			for (const ch of body.changes) {
				const f = ch.file;
				if (!f || ch.removed || f.trashed) {
					// find the path we knew this id under, if any
					let gone: string | null = null;
					for (const [k, v] of this.ids) if (v === ch.fileId) gone = k;
					if (gone) {
						this.ids.delete(gone);
						entries.push({ tag: "deleted", pathDisplay: `/${gone}` });
					}
					continue;
				}
				const parentPath = f.parents?.[0] ? await this.pathOfParent(f.parents[0]) : null;
				if (parentPath == null) continue; // outside the synced root
				const p = `${parentPath}/${f.name}`;
				if (f.mimeType === FOLDER_MIME) {
					this.ids.set(normKey(p), f.id);
					this.folderIds.set(f.id, p);
					entries.push({ tag: "folder", pathDisplay: `/${p}` });
				} else {
					this.ids.set(normKey(p), f.id);
					entries.push({ tag: "file", meta: this.meta(f, `/${p}`) });
				}
			}
			if (body.nextPageToken) token = body.nextPageToken;
			else return { entries, cursor: body.newStartPageToken ?? token };
		}
	}

	async listProbe(root: string, limit = 10): Promise<ListEntry[]> {
		const rootId = await this.ensureRoot(normRel(root));
		const page = await this.query(`'${rootId}' in parents and trashed=false`, "probe the Drive folder");
		return page.files.slice(0, limit).map((f) => {
			const p = `/${normRel(root)}/${f.name}`;
			return f.mimeType === FOLDER_MIME ? ({ tag: "folder", pathDisplay: p } as ListEntry) : ({ tag: "file", meta: this.meta(f, p) } as ListEntry);
		});
	}

	private async idOf(path: string, doing: string): Promise<{ id: string; file: GFile }> {
		const key = normKey(path);
		let id = this.ids.get(key);
		if (!id) {
			// resolve by walking from the root; listAll normally primes this
			const segs = normRel(path).split("/").filter(Boolean);
			let parentId = await this.ensureRoot(segs[0]);
			let sofar = segs[0];
			for (const seg of segs.slice(1)) {
				sofar = `${sofar}/${seg}`;
				const cached = this.ids.get(normKey(sofar));
				if (cached) {
					parentId = cached;
					continue;
				}
				const found = await this.query(`name='${seg.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`, doing);
				const hit = found.files[0];
				if (!hit) throw new DropboxError(`Could not ${doing}: not found`, 404, "not_found");
				this.ids.set(normKey(sofar), hit.id);
				parentId = hit.id;
			}
			id = parentId;
		}
		const r = await this.call(`${API}/files/${id}?fields=${encodeURIComponent(FILE_FIELDS)}`, doing);
		if (r.status !== 200) throw gError(r, doing);
		return { id, file: JSON.parse(r.text) as GFile };
	}

	async download(path: string): Promise<{ bytes: ArrayBuffer; meta: RemoteFileMeta }> {
		const { id, file } = await this.idOf(path, `download ${path}`);
		const r = await this.call(`${API}/files/${id}?alt=media`, `download ${path}`);
		if (r.status !== 200) throw gError(r, `download ${path}`);
		const meta = this.meta(file, path);
		assertWholeDownload(path, r.arrayBuffer.byteLength, meta.size);
		return { bytes: r.arrayBuffer, meta };
	}

	async downloadRev(rev: string, path?: string): Promise<ArrayBuffer> {
		if (!path) throw new DropboxError("revision lookup needs a path here", 404, "not_found");
		const { id } = await this.idOf(`/${this.rootName}/${normRel(path)}`, "read a revision");
		const r = await this.call(`${API}/files/${id}/revisions/${encodeURIComponent(rev)}?alt=media`, "read a revision");
		if (r.status !== 200) throw gError(r, "read a revision");
		return r.arrayBuffer;
	}

	async upload(path: string, bytes: ArrayBuffer, opts: { mode: "add" | "overwrite" | { update: string }; clientModified: string }): Promise<RemoteFileMeta> {
		const rel = normRel(path);
		const parent = rel.slice(0, rel.lastIndexOf("/"));
		const name = rel.slice(rel.lastIndexOf("/") + 1);
		await this.ensureFolder(parent);
		const parentId = this.ids.get(normKey(parent)) as string;
		const existingId = this.ids.get(normKey(rel));
		if (opts.mode === "add" && existingId) throw new DropboxError(`upload conflict on ${path}`, 409, "conflict");
		if (typeof opts.mode === "object") {
			if (!existingId) throw new DropboxError(`upload conflict on ${path}`, 409, "conflict");
			const { file } = await this.idOf(rel, `upload ${path}`);
			if ((file.headRevisionId ?? "") !== opts.mode.update) throw new DropboxError(`upload conflict on ${path}`, 409, "conflict");
		}
		const metaPart = { name, modifiedTime: opts.clientModified, ...(existingId ? {} : { parents: [parentId] }) };
		const url = existingId
			? `${UPLOAD}/files/${existingId}?uploadType=${bytes.byteLength <= SIMPLE_MAX ? "multipart" : "resumable"}&fields=${encodeURIComponent(FILE_FIELDS)}`
			: `${UPLOAD}/files?uploadType=${bytes.byteLength <= SIMPLE_MAX ? "multipart" : "resumable"}&fields=${encodeURIComponent(FILE_FIELDS)}`;
		const method = existingId ? "PATCH" : "POST";
		if (bytes.byteLength <= SIMPLE_MAX) {
			const boundary = "pconb" + Math.abs(bytes.byteLength * 31 + 7);
			const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metaPart)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
			const tail = `\r\n--${boundary}--`;
			const enc = new TextEncoder();
			const hb = enc.encode(head);
			const tb = enc.encode(tail);
			const body = new Uint8Array(hb.byteLength + bytes.byteLength + tb.byteLength);
			body.set(hb, 0);
			body.set(new Uint8Array(bytes), hb.byteLength);
			body.set(tb, hb.byteLength + bytes.byteLength);
			const r = await this.call(url, `upload ${path}`, {
				method,
				headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
				body: body.buffer as ArrayBuffer,
			});
			if (r.status !== 200) throw gError(r, `upload ${path}`);
			const f = JSON.parse(r.text) as GFile;
			this.ids.set(normKey(rel), f.id);
			return this.meta(f, path);
		}
		const rs = await this.call(url, `upload ${path}`, {
			method,
			headers: { "Content-Type": "application/json; charset=UTF-8" },
			body: JSON.stringify(metaPart),
		});
		if (rs.status !== 200) throw gError(rs, `upload ${path}`);
		const session = rs.headers["location"] ?? rs.headers["Location"] ?? "";
		const r = await requestUrl({ url: session, method: "PUT", headers: { "Content-Length": String(bytes.byteLength) }, body: bytes, throw: false });
		if (r.status !== 200 && r.status !== 201) throw gError(r, `upload ${path}`);
		const f = JSON.parse(r.text) as GFile;
		this.ids.set(normKey(rel), f.id);
		return this.meta(f, path);
	}

	async move(from: string, to: string): Promise<RemoteFileMeta> {
		const fromRel = normRel(from);
		const toRel = normRel(to);
		const { id, file } = await this.idOf(fromRel, `move ${from}`);
		if (this.ids.get(normKey(toRel))) throw new DropboxError(`move conflict on ${to}`, 409, "conflict");
		const toParent = toRel.slice(0, toRel.lastIndexOf("/"));
		await this.ensureFolder(toParent);
		const newParent = this.ids.get(normKey(toParent)) as string;
		const oldParent = file.parents?.[0] ?? "";
		const r = await this.call(
			`${API}/files/${id}?fields=${encodeURIComponent(FILE_FIELDS)}&addParents=${encodeURIComponent(newParent)}&removeParents=${encodeURIComponent(oldParent)}`,
			`move ${from}`,
			{ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: toRel.slice(toRel.lastIndexOf("/") + 1) }) }
		);
		if (r.status !== 200) throw gError(r, `move ${from}`);
		this.ids.delete(normKey(fromRel));
		const f = JSON.parse(r.text) as GFile;
		this.ids.set(normKey(toRel), f.id);
		return this.meta(f, to);
	}

	async del(path: string, parentRev?: string): Promise<void> {
		let hit: { id: string; file: GFile };
		try {
			hit = await this.idOf(normRel(path), `delete ${path}`);
		} catch (e) {
			if (e instanceof DropboxError && e.tag.includes("not_found")) return; // already gone is the goal state
			throw e;
		}
		if (parentRev && (hit.file.headRevisionId ?? "") !== parentRev) throw new DropboxError(`delete conflict on ${path}`, 409, "conflict");
		const r = await this.call(`${API}/files/${hit.id}`, `delete ${path}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ trashed: true }),
		});
		if (r.status !== 200) throw gError(r, `delete ${path}`);
		this.ids.delete(normKey(normRel(path)));
	}

	async account(): Promise<{ email: string; name: string }> {
		const r = await this.call(`${API}/about?fields=user`, "read the Google account");
		if (r.status !== 200) throw gError(r, "read the Google account");
		const u = (JSON.parse(r.text) as { user?: { emailAddress?: string; displayName?: string } }).user ?? {};
		return { email: u.emailAddress ?? "", name: u.displayName ?? "" };
	}

	async spaceUsage(): Promise<{ used: number; allocated: number }> {
		const r = await this.call(`${API}/about?fields=storageQuota`, "read Drive usage");
		if (r.status !== 200) throw gError(r, "read Drive usage");
		const q = (JSON.parse(r.text) as { storageQuota?: { usage?: string; limit?: string } }).storageQuota ?? {};
		return { used: Number(q.usage ?? 0), allocated: Number(q.limit ?? 0) };
	}

	async revoke(): Promise<void> {
		try {
			await requestUrl({ url: `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(this.o.refreshToken())}`, method: "POST", throw: false });
		} catch {
			/* clearing the stored tokens is the sign-out either way */
		}
	}
}
