/* Unit tests over the pure modules (core.ts, crypto.ts).
 * Run via: npm test. No Obsidian, no network, no framework. */
import {
	Action,
	BaseEntry,
	DEFAULT_SETTINGS,
	LocalEntry,
	PCON_BUILD,
	Plan,
	RemoteEntry,
	RibbonItem,
	ribbonEqual,
	weaveRibbon,
	asciiJsonHeader,
	assertWholeDownload,
	isShortRead,
	b64url,
	backoffMs,
	buildIgnore,
	clientIdProblem,
	compileIgnore,
	conflictName,
	conflictWinner,
	contentHash,
	fmtBytes,
	forcedExcludes,
	looksLikeSetupCode,
	makeSetupCode,
	parseSetupCode,
	hiddenBlocked,
	compareVersions,
	isIgnored,
	isPluginCodePath,
	isPluginDataPath,
	isoToMs,
	junkFile,
	manifestVersion,
	mergeForSave,
	mergePluginData,
	pluginDirOf,
	mergeThree,
	mergeableText,
	msToIsoSec,
	normKey,
	normRel,
	parseRetryAfter,
	pathBase,
	pathParent,
	pkceChallenge,
	planSummary,
	planSync,
	sanitizeRemoteFolder,
	stripDeletes,
	tierTransfers,
	transferTier,
	windowsUnsafe,
	withinSizeLimit,
} from "../src/core";
import { NotEncryptedError, WrongKeyError, b64ToBytes, bytesToB64, decryptBytes, deriveKey, encryptBytes, looksEncrypted, makeCheck, makeSalt, verifyCheck } from "../src/crypto";
import {
	MemberKeys,
	ShareCodeOutdated,
	OwnedShare,
	PublishIO,
	ShareEntry,
	ShareFile,
	ShareIO,
	ShareManifest,
	ShareUnreadable,
	Subscription,
	decodeManifest,
	directUrl,
	emptyShareState,
	encodeManifest,
	fetchableUrl,
	importShareKey,
	looksLikeShareCode,
	makeShareCode,
	makeShareKey,
	parseShareCode,
	ShareNotApproved,
	buildKeyring,
	generateMemberKeys,
	looksLikeJoinCode,
	makeJoinCode,
	parseJoinCode,
	planSharePublish,
	planSharePull,
	publishKeyring,
	nextCheckDelay,
	resolveMemberKey,
	shareSignatures,
	unwrapContentKey,
	wrapKeyFor,
	publishShare,
	pullShare,
	resolveShareFiles,
} from "../src/share";
import { FakeServer, SimDevice, bytesOf, contentSurvives, converge, fleetDiff, mulberry32, textOf } from "./sim";
import manifest from "../manifest.json";
import pkg from "../package.json";
import versions from "../versions.json";

let failures = 0;
function eq(a: unknown, b: unknown, msg: string) {
	const sa = JSON.stringify(a);
	const sb = JSON.stringify(b);
	if (sa === sb) console.log("  ok -", msg);
	else {
		failures++;
		console.error("  FAIL -", msg, "\n    got:     ", sa, "\n    expected:", sb);
	}
}
function ok(v: unknown, msg: string) {
	eq(!!v, true, msg);
}

/* ---------- release consistency ---------- */

console.log("release consistency");
eq(manifest.version, PCON_BUILD, "manifest version matches the build stamp");
eq((pkg as { version: string }).version, manifest.version, "package.json version matches manifest");
ok((versions as Record<string, string>)[manifest.version], "versions.json maps the current version");
eq(manifest.id, "powerconnect", "plugin id");
eq((manifest as { isDesktopOnly: boolean }).isDesktopOnly, false, "mobile support declared");

/* ---------- paths ---------- */

console.log("paths");
eq(normRel("\\a\\b\\c.md"), "a/b/c.md", "backslashes and leading slash normalize");
eq(normRel("a//b///c.md"), "a/b/c.md", "duplicate slashes collapse");
eq(normRel("folder/"), "folder", "trailing slash drops");
eq(normRel("Café.md"), "Café.md", "NFD composes to NFC");
eq(normKey("Notes/Café.MD"), "notes/café.md", "key lowercases");
eq(pathBase("a/b/c.md"), "c.md", "pathBase");
eq(pathBase("c.md"), "c.md", "pathBase at root");
eq(pathParent("a/b/c.md"), "a/b", "pathParent");
eq(pathParent("c.md"), "", "pathParent at root");
eq(sanitizeRemoteFolder("My/Vault: 2026?"), "My Vault 2026", "remote folder flattens to one clean segment");
eq(sanitizeRemoteFolder(""), "Vault", "empty remote folder falls back");
ok(junkFile("sub/.DS_Store"), "junk: .DS_Store");
ok(junkFile("Desktop.ini"), "junk: desktop.ini case-insensitive");
ok(!junkFile("notes.md"), "junk: normal file is not junk");
eq(windowsUnsafe("a/ok file (1).md"), null, "windows: spaces and parens are fine");
ok(windowsUnsafe("a/b:c.md"), "windows: colon rejected");
ok(windowsUnsafe("a/trailing./x.md"), "windows: trailing dot rejected");
ok(windowsUnsafe("CON.md"), "windows: reserved device name rejected");
eq(windowsUnsafe("console.md"), null, "windows: reserved name must be the whole stem");

/* ---------- ignore rules ---------- */

console.log("ignore rules");
{
	const ig = compileIgnore(["# comment", "", "*.pdf", "Private/", "!Private/share.md", "/Top.md", "temp?", "assets/**/big", "**/draft.md"]);
	ok(isIgnored("a/b/file.pdf", ig), "*.pdf matches at depth");
	ok(isIgnored("FILE.PDF", ig), "matching is case-insensitive");
	ok(isIgnored("Private/x.md", ig), "dir pattern matches contents");
	ok(!isIgnored("Private", ig), "dir pattern does not match a file of that name");
	ok(!isIgnored("Private/share.md", ig), "negation re-includes");
	ok(isIgnored("Top.md", ig), "anchored pattern at root");
	ok(!isIgnored("a/Top.md", ig), "anchored pattern only at root");
	ok(isIgnored("temp1", ig), "? matches one char");
	ok(!isIgnored("temp12", ig), "? matches exactly one char");
	ok(isIgnored("assets/big", ig), "** matches zero dirs");
	ok(isIgnored("assets/x/y/big", ig), "** matches deep dirs");
	ok(isIgnored("a/draft.md", ig), "leading **/ matches anywhere");
	ok(isIgnored("draft.md", ig), "leading **/ matches root");
}
{
	const ig = compileIgnore(["sub/dir"]);
	ok(isIgnored("sub/dir", ig), "slash pattern anchors");
	ok(isIgnored("sub/dir/x.md", ig), "slash pattern covers subtree");
	ok(!isIgnored("a/sub/dir", ig), "slash pattern does not float");
}
{
	const s = { ...DEFAULT_SETTINGS, syncConfig: false };
	const ig = buildIgnore(s, ".obsidian", "powerconnect");
	ok(isIgnored(".obsidian/app.json", ig), "config off: .obsidian excluded");
	ok(!isIgnored("notes/a.md", ig), "config off: normal notes included");
	ok(isIgnored(".trash/old.md", ig), "trash always excluded");
	ok(isIgnored(".git/config", ig), ".git always excluded");
}
{
	const s = { ...DEFAULT_SETTINGS, syncConfig: true, syncPluginData: false };
	const ig = buildIgnore(s, ".obsidian", "powerconnect");
	ok(!isIgnored(".obsidian/app.json", ig), "config on: core settings included");
	ok(isIgnored(".obsidian/workspace.json", ig), "config on: workspace stays excluded");
	ok(isIgnored(".obsidian/plugins/powertables/data.json", ig), "plugin data off: sibling data.json excluded");
	const igDef = buildIgnore({ ...DEFAULT_SETTINGS, syncConfig: true }, ".obsidian", "powerconnect");
	ok(!isIgnored(".obsidian/plugins/powertables/data.json", igDef), "plugin data on by default: rules admit it; the engine holds it back without an encryption envelope");
	ok(!isIgnored(".obsidian/plugins/powertables/main.js", ig), "config on: plugin code included");
	ok(!isIgnored(".obsidian/plugins/powertables/styles.css", ig), "config on: plugin styles included");
	ok(isIgnored(".obsidian/plugins/powerdesk/cache.json", ig), "plugin caches never sync");
	ok(isIgnored(".obsidian/plugins/powerexplorer/search-index.json", ig), "derived indexes never sync");
	ok(isIgnored(".obsidian/plugins/powerassistant/whatever.bin", ig), "unknown plugin files stay per-device");
	ok(!isIgnored(".obsidian/plugins/powerconnect/data.json", ig), "our own data.json syncs; it holds no credentials");
	ok(!isIgnored(".obsidian/plugins/powerconnect/main.js", ig), "our own code syncs; updates reach other devices");
	ok(isIgnored(".obsidian/plugins/powerconnect/state.json", ig), "our own journal never syncs");
}
{
	// Keeping core config synced but holding one file out of it. Obsidian holds
	// app.json in memory and writes the whole file back, so two running devices
	// take turns overwriting each other's copy: a device whose settings predate
	// a change lands its stale copy on top and the change is simply gone (the
	// attachment folder is the one people notice). Excluding it by exact path
	// has to leave the rest of the config folder, and the same names elsewhere,
	// alone.
	const s = { ...DEFAULT_SETTINGS, syncConfig: true, excludes: "/.obsidian/app.json" };
	const ig = buildIgnore(s, ".obsidian", "powerconnect");
	ok(isIgnored(".obsidian/app.json", ig), "an exact-path exclude holds core settings back");
	ok(!isIgnored(".obsidian/appearance.json", ig), "and stops at that file: appearance still syncs");
	ok(!isIgnored(".obsidian/community-plugins.json", ig), "the enabled-plugin list still syncs");
	ok(!isIgnored("Notes/app.json", ig), "a leading slash anchors it: the same name elsewhere is untouched");
	ok(!isIgnored(".obsidian/plugins/powerconnect/data.json", ig), "our own settings still travel, so the exclude reaches other devices");
}
{
	const s = { ...DEFAULT_SETTINGS, syncConfig: true, syncPluginData: true, excludes: "!.obsidian/plugins/powerconnect/state.json" };
	const ig = buildIgnore(s, ".obsidian", "powerconnect");
	ok(!isIgnored(".obsidian/plugins/powertables/data.json", ig), "plugin data opt-in includes sibling data.json");
	ok(isIgnored(".obsidian/plugins/powerconnect/state.json", ig), "no negation can re-include the journal");
}
{
	const s = { ...DEFAULT_SETTINGS, excludes: "*.pdf" };
	const ig = buildIgnore(s, ".obsidian", "powerconnect", ["Attachments/", "!keep.pdf"]);
	ok(isIgnored("Attachments/img.png", ig), "device rules exclude");
	ok(isIgnored("a/b.pdf", ig), "shared rules still apply alongside device rules");
	ok(!isIgnored("a/keep.pdf", ig), "device rules can re-include shared excludes");
	const ig2 = buildIgnore(s, ".obsidian", "powerconnect", ["!.obsidian/plugins/powerconnect/state.json"]);
	ok(isIgnored(".obsidian/plugins/powerconnect/state.json", ig2), "device rules cannot re-include the journal either");
}
{
	const p = parseSetupCode(makeSetupCode({ provider: "dropbox", clientId: "a1b2c3d4", folder: "Notes Vault", e2e: true }));
	ok(!!p && p.provider === "dropbox" && p.clientId === "a1b2c3d4" && p.folder === "Notes Vault" && p.e2e === true, "setup code round-trips, provider defaulting to dropbox");
	eq(parseSetupCode("PCON-SETUP:1:!!!!"), null, "garbage setup code rejected");
	eq(parseSetupCode("a1b2c3d4"), null, "a bare app key is not a setup code");
	const p2 = parseSetupCode(makeSetupCode({ provider: "dropbox", clientId: "k", folder: "Notatki ąę", e2e: false }));
	ok(!!p2 && p2.folder === "Notatki ąę" && p2.e2e === false, "setup code survives non-ascii folder names");
	const mangled = makeSetupCode({ provider: "dropbox", clientId: "a1b2c3d4", folder: "Steve", e2e: true }).replace("PCON-SETUP", "pcon–setup");
	const p3 = parseSetupCode(mangled);
	ok(!!p3 && p3.clientId === "a1b2c3d4", "a lowercased, dash-swapped prefix still parses; the base64 body is untouched");
	ok(looksLikeSetupCode("pcon-setup:1:truncated!!"), "a mangled code is still recognized as one, never mistaken for an app key");
	ok(!looksLikeSetupCode("a1b2c3d4"), "a plain app key is not flagged as a code");
	const pod = parseSetupCode(makeSetupCode({ provider: "onedrive", clientId: "azure-id", folder: "Vault", e2e: false }));
	ok(!!pod && pod.provider === "onedrive" && pod.clientId === "azure-id", "onedrive setup code carries its provider");
	const pg = parseSetupCode(makeSetupCode({ provider: "gdrive", clientId: "g-id", clientSecret: "g-sec", folder: "Vault", e2e: false }));
	ok(!!pg && pg.provider === "gdrive" && pg.clientId === "g-id" && pg.clientSecret === "g-sec", "gdrive setup code carries id and installed-app secret");
}
{
	eq(clientIdProblem("dropbox", "kf8d2xy9plq4m1z"), null, "a real-shaped Dropbox app key passes");
	eq(clientIdProblem("dropbox", " kf8d2xy9plq4m1z "), null, "surrounding whitespace from a paste is tolerated");
	ok(!!clientIdProblem("dropbox", "plugins"), "a folder name pasted from a file manager is caught, not sent to Dropbox");
	ok(!!clientIdProblem("dropbox", "kf8d2xy9 plq4m1z"), "a key with a space in it is caught");
	ok(!!clientIdProblem("dropbox", "https://www.dropbox.com/developers/apps"), "a pasted console URL is caught");
	ok(!!clientIdProblem("dropbox", ""), "an empty field is caught");
	const asCode = clientIdProblem("dropbox", makeSetupCode({ provider: "dropbox", clientId: "kf8d2xy9plq4m1z", folder: "V", e2e: false }));
	ok(!!asCode && asCode.includes("setup code"), "a setup code left in the id field says so specifically");
	eq(clientIdProblem("onedrive", "5F1B2C34-9D8E-4A7F-B061-2C3D4E5F6A7B"), null, "an Azure GUID passes in either case");
	ok(!!clientIdProblem("onedrive", "plugins"), "junk in the Azure field is caught");
	ok(!!clientIdProblem("onedrive", "kf8d2xy9plq4m1z"), "a Dropbox-shaped key is not an Azure client id");
	eq(clientIdProblem("gdrive", "918273645-a1b2c3d4e5.apps.googleusercontent.com"), null, "a Google client id passes");
	ok(!!clientIdProblem("gdrive", "918273645-a1b2c3d4e5"), "a Google id missing its suffix is caught");
}
console.log("transfer order");
{
	const cfg = ".obsidian";
	eq(transferTier(".obsidian/plugins/powerexplorer/main.js", cfg), 0, "plugin code goes first");
	eq(transferTier(".obsidian/plugins/powerexplorer/manifest.json", cfg), 0, "so does its manifest");
	eq(transferTier(".obsidian/plugins/powerexplorer/styles.css", cfg), 0, "and its styles");
	eq(transferTier(".obsidian/plugins/powerexplorer/data.json", cfg), 1, "plugin settings follow the code that reads them");
	eq(transferTier(".obsidian/community-plugins.json", cfg), 2, "the enabled list lands after the code it names");
	eq(transferTier(".obsidian/app.json", cfg), 2, "the rest of the config folder is one tier");
	eq(transferTier("notes/deep/one.md", cfg), 3, "notes come last");
	eq(transferTier("Attachments/scan.pdf", cfg), 3, "so do attachments");
	eq(transferTier("plugins/main.js", cfg), 3, "a note path that merely looks like a plugin path is still a note");

	const dl = (path: string): Action => ({ t: "download", key: path.toLowerCase(), path, why: "new" });
	const tiers = tierTransfers([dl("b.md"), dl(".obsidian/app.json"), dl(".obsidian/plugins/x/data.json"), dl("a.md"), dl(".obsidian/plugins/x/main.js")], cfg);
	eq(
		tiers.map((t) => t.map((a) => (a.t === "download" ? a.path : a.t))),
		[[".obsidian/plugins/x/main.js"], [".obsidian/plugins/x/data.json"], [".obsidian/app.json"], ["b.md", "a.md"]],
		"tiers run plugin code, plugin settings, config, then notes, keeping the plan's order within a tier"
	);
	eq(tierTransfers([dl("a.md"), dl("b.md")], cfg).length, 1, "a notes-only plan is one tier, not four");
	eq(tierTransfers([], cfg), [], "an empty plan needs no tiers");
	const moves = tierTransfers([{ t: "moveRemote", fromKey: "a.md", toKey: "b.md", fromPath: "a.md", toPath: "b.md" }, dl(".obsidian/plugins/x/main.js")], cfg);
	eq(moves[0].map((a) => a.t), ["download"], "a move is tiered by its destination, so plugin code still leads");
}
console.log("three-way merge");
{
	const base = "title\n\nalpha\nbeta\ngamma";
	eq(mergeThree(base, "title\n\nALPHA\nbeta\ngamma", "title\n\nalpha\nbeta\nGAMMA", true), "title\n\nALPHA\nbeta\nGAMMA", "edits on different lines both land");
	eq(mergeThree(base, base + "\nfrom A", base + "\nfrom B", true), base + "\nfrom A\nfrom B", "same-point appends order local first when asked");
	eq(mergeThree(base, base + "\nfrom A", base + "\nfrom B", false), base + "\nfrom B\nfrom A", "same-point appends order remote first when asked");
	eq(mergeThree(base, "title\n\nALPHA\nbeta\ngamma", "title\n\nOMEGA\nbeta\ngamma", true), null, "colliding edits refuse to merge");
	eq(mergeThree(base, "title\n\nALPHA\nbeta\ngamma", "title\n\nALPHA\nbeta\ngamma", true), "title\n\nALPHA\nbeta\ngamma", "identical edits land once");
	eq(mergeThree(base, "title\n\nbeta\ngamma", "title\n\nalpha\nbeta\ngamma!", true), "title\n\nbeta\ngamma!", "a deletion and a distant edit combine");
	eq(mergeThree(base, "title\n\nbeta\ngamma", "title\n\nalpha?\nbeta\ngamma", true), null, "deleting a line one side edited refuses to merge");
	eq(mergeThree(base, "intro\ntitle\n\nalpha\nbeta\ngamma", "title\n\nalpha\nbeta\ngamma\noutro", true), "intro\ntitle\n\nalpha\nbeta\ngamma\noutro", "prepend and append combine");
	eq(mergeThree("", "only A", "only B", true), "only A\nonly B", "both filled an empty file: ordered append");
	eq(mergeThree("a\nb\n", "a\nb\nX", "a\nb\nY\n", false), "a\nb\nY\nX\n", "trailing-newline drift still merges appends (the field case)");
	eq(mergeThree("a\nb", "a\nb\nX\n", "a\nb\nY", true), "a\nb\nX\nY\n", "an append that adds the trailing newline merges too");
	ok(mergeableText(new TextEncoder().encode("plain text").buffer as ArrayBuffer) === "plain text", "utf-8 text is mergeable");
	ok(mergeableText(new Uint8Array([0xff, 0xfe, 0x00, 0xff]).buffer as ArrayBuffer) === null, "binary is not mergeable");
}

// --- mergePluginData (settings files merge by key, not by mtime) ---
{
	ok(isPluginDataPath(".obsidian/plugins/powerexplorer/data.json", ".obsidian"), "a plugin's data.json matches");
	ok(isPluginDataPath(".obsidian/plugins/powerconnect/data.json", ".obsidian"), "our own data.json matches too");
	ok(!isPluginDataPath(".obsidian/plugins/powerexplorer/search-index.json", ".obsidian"), "other plugin files do not");
	ok(!isPluginDataPath(".obsidian/app.json", ".obsidian"), "config outside plugins does not");
	ok(!isPluginDataPath("notes/data.json", ".obsidian"), "a note named data.json does not");

	const j = (o: object) => JSON.stringify(o);
	const S0 = j({ layout: "onenote", orders: { A: ["x", "y"] }, recent: ["old.md"] });
	// THE INCIDENT'S COUSIN: a laptop off for two weeks boots, touches only
	// its recents, and syncs against weeks of settings changes. Its touch
	// stays; everything else takes the fleet's side; nothing is contested.
	const laptop = j({ layout: "onenote", orders: { A: ["x", "y"] }, recent: ["tapped.md"] });
	const fleet = j({ layout: "drill", orders: { A: ["y", "x"], B: ["z"] }, recent: ["old.md"] });
	eq(
		JSON.parse(mergePluginData(S0, laptop, fleet, false) ?? "{}"),
		{ layout: "drill", orders: { A: ["y", "x"], B: ["z"] }, recent: ["tapped.md"] },
		"a stale device's touch and the fleet's changes both land"
	);
	// contested key: both sides changed it; the named winner takes it
	eq(JSON.parse(mergePluginData(j({ w: 1 }), j({ w: 2 }), j({ w: 3 }), true) ?? "{}"), { w: 3 }, "a both-changed key goes to remote when asked");
	eq(JSON.parse(mergePluginData(j({ w: 1 }), j({ w: 2 }), j({ w: 3 }), false) ?? "{}"), { w: 2 }, "a both-changed key goes to local when asked");
	// deletions by the changed side hold; a contested delete follows the winner
	eq(JSON.parse(mergePluginData(j({ a: 1, b: 2 }), j({ b: 2 }), j({ a: 1, b: 5 }), false) ?? "{}"), { b: 5 }, "a one-sided delete holds while the other side edits elsewhere");
	eq(JSON.parse(mergePluginData(j({ a: 1 }), j({}), j({ a: 9 }), true) ?? "{}"), { a: 9 }, "a contested delete loses to the winner's edit");
	// new keys on either side arrive
	eq(JSON.parse(mergePluginData(j({}), j({ mine: 1 }), j({ theirs: 2 }), true) ?? "{}"), { mine: 1, theirs: 2 }, "new keys from both sides land");
	// anything that is not a plain object refuses, and keep-both handles it
	eq(mergePluginData("[1]", j({}), j({}), true), null, "an array root refuses to merge");
	eq(mergePluginData(j({}), "not json", j({}), true), null, "unparseable input refuses to merge");
	// identical inputs on every device produce identical bytes
	eq(
		mergePluginData(S0, laptop, fleet, false),
		mergePluginData(S0, laptop, fleet, false),
		"the merge is deterministic"
	);
	// and the real test of that: the SAME pair merged from each device's own
	// point of view. A merge that only agrees with itself lets two devices
	// publish different bytes and re-merge each other forever.
	eq(mergePluginData(S0, laptop, fleet, true), mergePluginData(S0, fleet, laptop, false), "both devices merge a pair to the same bytes");

	// THE REORDERING REPORT: three computers, three different page orders.
	// `orders` is ONE key holding every folder's arrangement, so comparing it
	// whole made any drag anywhere contest the whole map, and the tiebreak
	// loser forfeited every folder it had ever arranged.
	const O = (o: object) => j({ layout: "onenote", orders: o });
	const shared = { "Apple/Phase 2": ["Finder", "Spotlight"], "Acme": ["a", "b"], "Projects": ["p", "q"] };
	const b3 = O(shared);
	const mac = O({ ...shared, "Apple/Phase 2": ["Spotlight", "Finder"] });
	const pc = O({ ...shared, "Acme": ["b", "a"] });
	for (const preferRemote of [true, false]) {
		const m = JSON.parse(mergePluginData(b3, mac, pc, preferRemote) ?? "{}") as { orders: Record<string, string[]> };
		eq(m.orders["Apple/Phase 2"], ["Spotlight", "Finder"], `the Mac's drag survives (preferRemote=${preferRemote})`);
		eq(m.orders["Acme"], ["b", "a"], `the PC's drag survives too (preferRemote=${preferRemote})`);
		eq(m.orders["Projects"], ["p", "q"], `a folder neither device touched is untouched (preferRemote=${preferRemote})`);
	}
	// a third device folds into the same map rather than replacing it
	const twoWay = mergePluginData(b3, mac, pc, false) ?? "{}";
	const laptop3 = O({ ...shared, "Projects": ["q", "p"] });
	const three = JSON.parse(mergePluginData(b3, laptop3, twoWay, false) ?? "{}") as { orders: Record<string, string[]> };
	eq(three.orders["Apple/Phase 2"], ["Spotlight", "Finder"], "three devices: the Mac's drag still stands");
	eq(three.orders["Acme"], ["b", "a"], "three devices: the PC's drag still stands");
	eq(three.orders["Projects"], ["q", "p"], "three devices: the laptop's drag lands beside them");

	// the same folder on both devices is still a race, and still resolves
	const sameFolder = JSON.parse(mergePluginData(b3, O({ ...shared, "Acme": ["a", "b", "c"] }), O({ ...shared, "Acme": ["c", "a", "b"] }), true) ?? "{}") as { orders: Record<string, string[]> };
	eq(sameFolder.orders["Acme"], ["c", "a", "b"], "one folder arranged on both devices goes to the named winner");
	// a folder deleted on one side (Reset manual order) is not resurrected
	const dropped = JSON.parse(mergePluginData(b3, O({ "Apple/Phase 2": shared["Apple/Phase 2"], "Projects": shared["Projects"] }), O({ ...shared, "Projects": ["q", "p"] }), false) ?? "{}") as { orders: Record<string, string[]> };
	ok(!("Acme" in dropped.orders), "a reset folder stays reset while the other device arranges elsewhere");
	eq(dropped.orders["Projects"], ["q", "p"], "and the other device's arrangement still lands");
	// arrays are values, never merged element-wise
	eq(JSON.parse(mergePluginData(j({ r: [1, 2] }), j({ r: [3] }), j({ r: [4] }), true) ?? "{}"), { r: [4] }, "a contested list is taken whole, not spliced");
	// nesting deeper than one level follows the same rule
	const deepB = j({ a: { b: { c: 1, d: 2 } } });
	eq(
		JSON.parse(mergePluginData(deepB, j({ a: { b: { c: 9, d: 2 } } }), j({ a: { b: { c: 1, d: 8 } } }), true) ?? "{}"),
		{ a: { b: { c: 9, d: 8 } } },
		"a nested map merges at whatever depth the change happened"
	);
}

// --- plugin build artifacts: version decides, never the clock ---
{
	ok(isPluginCodePath(".obsidian/plugins/powerexplorer/main.js", ".obsidian"), "main.js is a build artifact");
	ok(isPluginCodePath(".obsidian/plugins/powerexplorer/manifest.json", ".obsidian"), "manifest.json is one too");
	ok(isPluginCodePath(".obsidian/plugins/powerexplorer/styles.css", ".obsidian"), "styles.css is one too");
	ok(!isPluginCodePath(".obsidian/plugins/powerexplorer/data.json", ".obsidian"), "data.json is settings, not a build artifact");
	ok(!isPluginCodePath("notes/main.js", ".obsidian"), "a note named main.js is not");
	eq(pluginDirOf(".obsidian/plugins/powerexplorer/main.js", ".obsidian"), ".obsidian/plugins/powerexplorer", "the plugin folder is derived from any of its files");
	eq(pluginDirOf("notes/one.md", ".obsidian"), null, "a note belongs to no plugin folder");

	eq(manifestVersion('{"version":"1.22.2"}'), "1.22.2", "a version is read from a manifest");
	eq(manifestVersion('{"id":"x"}'), null, "a manifest without a version reads null");
	eq(manifestVersion("not json"), null, "an unreadable manifest reads null");

	eq(compareVersions("1.22.2", "1.21.0"), 1, "a newer build wins");
	eq(compareVersions("1.21.0", "1.22.2"), -1, "an older build loses");
	eq(compareVersions("1.22.0", "1.22.0"), 0, "equal versions have no opinion");
	eq(compareVersions("1.22.10", "1.22.9"), 1, "version parts compare as numbers, not text");
	eq(compareVersions("1.7", "1.7.0"), 0, "a missing patch level reads as zero");
	eq(compareVersions("2.0", "1.99.99"), 1, "a major bump outranks everything below it");
	// no opinion is the only safe answer for anything unusual: guessing here
	// would install the wrong code on every device
	eq(compareVersions("1.0.0-beta", "1.0.0"), 0, "a prerelease suffix yields no opinion");
	eq(compareVersions(null, "1.0.0"), 0, "a missing version yields no opinion");
	eq(compareVersions("", "1.0.0"), 0, "an empty version yields no opinion");
	eq(compareVersions("1.0.0", "garbage"), 0, "an unparseable version yields no opinion");
}

ok(withinSizeLimit(999_999_999, 0), "size cap off admits everything");
ok(withinSizeLimit(5 * 1024 * 1024, 5), "size cap boundary is inclusive");
ok(!withinSizeLimit(5 * 1024 * 1024 + 1, 5), "size cap excludes past the boundary");
ok(hiddenBlocked(".journal/notes.md", ".obsidian"), "dot-paths outside config are engine-invisible");
ok(hiddenBlocked("sub/.hidden.md", ".obsidian"), "nested dot-files are engine-invisible");
ok(!hiddenBlocked(".obsidian/app.json", ".obsidian"), "config paths are not blocked");
ok(!hiddenBlocked(".obsidian/plugins/x/main.js", ".obsidian"), "deep config paths are not blocked");
ok(!hiddenBlocked("notes/plain.md", ".obsidian"), "normal paths are not blocked");

/* ---------- helpers ---------- */

console.log("helpers");
eq(asciiJsonHeader({ path: "/V/Ä.md" }), '{"path":"/V/\\u00c4.md"}', "non-ascii escapes for the header");
eq(JSON.parse(asciiJsonHeader({ p: "é中" })), { p: "é中" }, "escaped header parses back");
eq(asciiJsonHeader({ p: "plain" }), '{"p":"plain"}', "ascii passes through");
eq(msToIsoSec(Date.UTC(2026, 6, 17, 14, 34, 56, 789)), "2026-07-17T14:34:57Z", "client_modified has no millis and rounds");
eq(isoToMs("2026-07-17T14:34:57Z"), Date.UTC(2026, 6, 17, 14, 34, 57), "iso parses back");
eq(isoToMs("garbage"), 0, "bad iso is 0, not NaN");
eq(backoffMs(0, 500), 500, "backoff base");
eq(backoffMs(3, 500), 4000, "backoff doubles");
eq(backoffMs(20, 500), 30000, "backoff caps");
eq(parseRetryAfter("3"), 3000, "retry-after seconds");
eq(parseRetryAfter(undefined), 0, "retry-after absent");
eq(parseRetryAfter("900"), 120000, "retry-after capped");
eq(fmtBytes(0), "0 B", "bytes");
eq(fmtBytes(5 * 1024 * 1024), "5.0 MB", "megabytes");
eq(b64url(new Uint8Array([251, 255, 190])), "-_--", "b64url uses - and _ and strips padding");
{
	const roundtrip = b64ToBytes(bytesToB64(new Uint8Array([0, 1, 250, 255])));
	eq(Array.from(roundtrip), [0, 1, 250, 255], "b64 roundtrip");
}
eq(conflictName("Notes/Plan.md", Date.UTC(2026, 6, 17, 14, 32), "abcdef1234"), "Notes/Plan (sync conflict 2026-07-17 1432 abcdef).md", "conflict name with extension");
eq(conflictName("raw", Date.UTC(2026, 0, 2, 3, 4), "1234567"), "raw (sync conflict 2026-01-02 0304 123456)", "conflict name without extension");
eq(conflictWinner(200, "aaa", 100, "bbb"), "local", "newer mtime wins");
eq(conflictWinner(100, "aaa", 200, "bbb"), "remote", "newer mtime wins remote");
eq(conflictWinner(100, "bbb", 100, "aaa"), "local", "tie falls to hash order");
eq(conflictWinner(100, "aaa", 100, "bbb"), "remote", "tie falls to hash order remote");

/* ---------- mergeForSave ---------- */

console.log("mergeForSave");
{
	type S = { favs: string[]; recent: string[]; token: string };
	const baseline: S = { favs: ["a"], recent: ["x"], token: "t1" };
	const ours: S = { favs: ["a", "b"], recent: ["x"], token: "t1" };
	const disk: S = { favs: ["a"], recent: ["x", "y"], token: "t2" };
	eq(mergeForSave(ours, baseline, disk), { favs: ["a", "b"], recent: ["x", "y"], token: "t2" }, "only our changed keys overwrite disk");
	eq(mergeForSave(ours, baseline, null), ours, "no disk file writes memory as-is");
	eq(mergeForSave({ favs: [] } as unknown as S, { favs: ["a"] } as unknown as S, { favs: ["a", "b"] } as unknown as S), { favs: [] }, "an intentional clear is a change and wins");
	eq(mergeForSave(ours, baseline, { favs: ["a"] } as Partial<S>), { favs: ["a", "b"], recent: ["x"], token: "t1" }, "keys missing on disk keep ours");
}

{
	// A key holding one value per item is a whole vault's worth of settings behind
	// a single name. Changing ONE of them used to publish ALL of them, erasing
	// every item another device had configured since this one last read.
	type M = { map: Record<string, number[]> };
	eq(
		mergeForSave({ map: { A: [2] } } as M, { map: { A: [1] } } as M, { map: { A: [1], B: [9] } } as M),
		{ map: { A: [2], B: [9] } },
		"one entry's change publishes that entry, not the whole map"
	);
	eq(
		mergeForSave({ map: { A: [1] } } as M, { map: { A: [1], B: [9] } } as M, { map: { A: [1], B: [9] } } as M),
		{ map: { A: [1] } },
		"an entry we removed stays removed"
	);
	eq(
		mergeForSave({ map: { A: [1] } } as M, { map: { A: [1] } } as M, { map: { A: [7] } } as M),
		{ map: { A: [7] } },
		"an entry we did not touch takes the disk's"
	);
}

/* ---------- the ribbon ---------- */

console.log("ribbon");
{
	const r = (spec: string): RibbonItem[] => spec.split(" ").filter(Boolean).map((s) => ({ id: s.replace(/^-/, ""), hidden: s.startsWith("-") }));
	const spec = (items: RibbonItem[]): string => items.map((i) => (i.hidden ? "-" : "") + i.id).join(" ");

	ok(ribbonEqual(r("a b c"), r("a b c")), "the same ribbon is the same ribbon");
	ok(!ribbonEqual(r("a b c"), r("a -b c")), "hiding an icon is a change");
	ok(!ribbonEqual(r("a b c"), r("b a c")), "so is dragging one, which a set comparison would miss");
	ok(!ribbonEqual(r("a b"), r("a b c")), "and so is gaining one");

	// The whole point: one device's ribbon, put on another device.
	eq(spec(weaveRibbon(r("c -a b"), r("a b c"))), "c -a b", "a shared ribbon replaces the local order and states");

	// A plugin installed on one device only. Its icon must not be swept to the
	// end of the ribbon every time the other device syncs.
	eq(spec(weaveRibbon(r("a b c"), r("a mine b c"))), "a mine b c", "a local-only icon holds its place after the icon it follows");
	eq(spec(weaveRibbon(r("a b c"), r("mine a b c"))), "mine a b c", "one that leads the ribbon stays at the front");
	eq(spec(weaveRibbon(r("a b c"), r("a b c mine"))), "a b c mine", "one that trails it stays at the back");
	eq(spec(weaveRibbon(r("a b c"), r("a -mine b c"))), "a -mine b c", "and keeps the state it has here, which the other device knows nothing about");

	// Sharing this device's ribbon: the same weave, the other way round, so an
	// icon only the other devices have is not dropped by the one that lacks it.
	eq(spec(weaveRibbon(r("-b a"), r("a theirs b"))), "-b a theirs", "sharing keeps an icon this device does not have");

	// Round trip: adopt, then share back, and nothing moves. A device that
	// drifted here would rewrite its ribbon on every pass forever.
	const shared = r("c -a b theirs");
	const local = r("a b c mine");
	const here = new Set(local.map((i) => i.id));
	const applied = weaveRibbon(shared, local).filter((i) => here.has(i.id));
	// `mine` sits after `c` here, so it travels with `c` rather than staying at
	// the end: it holds its place relative to the icon it follows, not its index.
	eq(spec(applied), "c mine -a b", "what actually lands: the shared order, minus what is not installed here");
	eq(spec(weaveRibbon(applied, shared)), "c mine -a b theirs", "sharing it back keeps the absent icon");
	const second = weaveRibbon(weaveRibbon(applied, shared), applied).filter((i) => here.has(i.id));
	ok(ribbonEqual(second, applied), "and a second pass is a no-op, so devices settle instead of taking turns");

	// mergeForSave has to see the ribbon as one value. As a map it would merge
	// key by key: a pure reorder changes no key's value, so every entry would
	// read as untouched and the drag would never reach the file.
	type S = { ribbon: RibbonItem[] };
	eq(
		mergeForSave({ ribbon: r("b a") } as S, { ribbon: r("a b") } as S, { ribbon: r("a b") } as S),
		{ ribbon: r("b a") },
		"a reorder with no state change still reaches disk"
	);
	eq(mergeForSave({ ribbon: r("a b") } as S, { ribbon: r("a b") } as S, { ribbon: r("c a b") } as S), { ribbon: r("c a b") }, "a ribbon we did not touch takes the other device's");
}

/* ---------- the planner ---------- */

console.log("planner");
const le = (path: string, hash: string, mtime = 100, size = 1): [string, LocalEntry] => [normKey(path), { path, mtime, size, hash }];
const re = (path: string, rev: string, hash: string, mtime = 100, size = 1): [string, RemoteEntry] => [normKey(path), { path, rev, size, hash, mtime }];
const be = (path: string, rev: string, hash: string, lhash = hash, mtime = 100, size = 1): [string, BaseEntry] => [normKey(path), { rev, hash, lhash, mtime, size }];
const plan = (l: [string, LocalEntry][], r: [string, RemoteEntry][], b: [string, BaseEntry][], extra?: Partial<Parameters<typeof planSync>[0]>): Plan =>
	planSync({ local: new Map(l), remote: new Map(r), base: new Map(b), ...extra });
const acts = (p: Plan): string[] =>
	p.actions.filter((a) => a.t !== "dropBase").map((a) => `${a.t}:${"path" in a ? a.path : (a as { toPath: string }).toPath}`);

eq(acts(plan([], [], [])), [], "empty everywhere plans nothing");
{
	const p = plan([le("a.md", "h1")], [], []);
	eq(acts(p), ["upload:a.md"], "new local file uploads");
	eq((p.actions[0] as { baseRev: string | null }).baseRev, null, "new upload has no base rev");
}
eq(acts(plan([], [re("b.md", "r1", "h1")], [])), ["download:b.md"], "new remote file downloads");
eq(acts(plan([le("c.md", "same")], [re("c.md", "r1", "same")], [])), ["adopt:c.md"], "both new with equal hash adopts without transfer");
eq(acts(plan([le("c.md", "same")], [re("c.md", "r1", "same")], [], { e2e: true })), ["conflict:c.md"], "encrypted hashes are never comparable, so both-new defers to the executor");
eq(acts(plan([le("c.md", "one")], [re("c.md", "r1", "two")], [])), ["conflict:c.md"], "both new and different is a conflict");
eq(acts(plan([le("d.md", "h1")], [re("d.md", "r1", "h1")], [be("d.md", "r1", "h1")])), [], "in sync plans nothing");
{
	const p = plan([le("e.md", "h2")], [re("e.md", "r1", "h1")], [be("e.md", "r1", "h1")]);
	eq(acts(p), ["upload:e.md"], "local edit uploads");
	eq((p.actions[0] as { baseRev: string | null }).baseRev, "r1", "edit upload carries the base rev for the race check");
}
eq(acts(plan([le("f.md", "h1")], [re("f.md", "r2", "h2")], [be("f.md", "r1", "h1")])), ["download:f.md"], "remote edit downloads");
eq(acts(plan([le("g.md", "h1")], [re("g.md", "r2", "h1")], [be("g.md", "r1", "h1")])), ["adopt:g.md"], "new rev with same stored bytes is a metadata echo, adopt");
eq(acts(plan([le("h.md", "h2")], [re("h.md", "r2", "h3")], [be("h.md", "r1", "h1")])), ["conflict:h.md"], "both edited is a conflict");
eq(acts(plan([le("i.md", "h2")], [re("i.md", "r2", "h2")], [be("i.md", "r1", "h1")])), ["adopt:i.md"], "both edited to the same content adopts");
eq(acts(plan([], [re("j.md", "r1", "h1")], [be("j.md", "r1", "h1")])), ["deleteRemote:j.md"], "local delete propagates");
eq(acts(plan([], [re("k.md", "r2", "h2")], [be("k.md", "r1", "h1")])), ["download:k.md"], "remote edit outranks local delete");
eq(acts(plan([], [re("k2.md", "r2", "h1")], [be("k2.md", "r1", "h1")])), ["deleteRemote:k2.md"], "a metadata echo does not resurrect a local delete");
eq(acts(plan([le("l.md", "h1")], [], [be("l.md", "r1", "h1")])), ["deleteLocal:l.md"], "remote delete propagates");
eq(acts(plan([le("m.md", "h2")], [], [be("m.md", "r1", "h1")])), ["upload:m.md"], "local edit outranks remote delete");
{
	const p = plan([], [], [be("n.md", "r1", "h1")]);
	eq(
		p.actions.map((a) => a.t),
		["dropBase"],
		"gone on both sides drops the base entry"
	);
}
{
	const p = plan([le("Note.md", "h1")], [re("note.md", "r1", "h1")], []);
	eq(acts(p), ["adopt:Note.md"], "case-different names are one file");
}

// renames
{
	const p = plan([le("new.md", "h1", 100)], [re("old.md", "r1", "sh1", 90)], [be("old.md", "r1", "sh1", "h1", 100)], {
		moves: [{ from: "old.md", to: "new.md" }],
	});
	eq(acts(p), ["moveRemote:new.md"], "a clean rename becomes one remote move");
}
{
	const p = plan([le("new.md", "h2", 200)], [re("old.md", "r1", "sh1", 90)], [be("old.md", "r1", "sh1", "h1", 100)], {
		moves: [{ from: "old.md", to: "new.md" }],
	});
	eq(acts(p), ["upload:new.md", "deleteRemote:old.md"], "a rename with edits falls back to upload plus delete");
}
{
	const p = plan([le("new.md", "h1", 100)], [re("old.md", "r2", "sh2", 90)], [be("old.md", "r1", "sh1", "h1", 100)], {
		moves: [{ from: "old.md", to: "new.md" }],
	});
	eq(acts(p), ["download:old.md", "upload:new.md"], "a rename over a remote edit keeps both files");
}

// delete guard
{
	const b: [string, BaseEntry][] = [];
	const r: [string, RemoteEntry][] = [];
	for (let i = 0; i < 60; i++) {
		b.push(be(`f${i}.md`, "r1", "h1"));
		r.push(re(`f${i}.md`, "r1", "h1"));
	}
	const p = plan([], r, b);
	eq(p.deletesRemote, 60, "guard case plans the deletes");
	ok(p.holdDeletes, "mass delete trips the guard");
}
{
	const b: [string, BaseEntry][] = [];
	const l: [string, LocalEntry][] = [];
	for (let i = 0; i < 60; i++) {
		b.push(be(`f${i}.md`, "r1", "h1"));
		if (i >= 8) l.push(le(`f${i}.md`, "h1"));
	}
	const r: [string, RemoteEntry][] = [];
	for (let i = 0; i < 60; i++) r.push(re(`f${i}.md`, "r1", "h1"));
	const p = plan(l, r, b);
	eq(p.deletesRemote, 8, "small delete batch is counted");
	ok(!p.holdDeletes, "10 or fewer deletes never trip the guard");
}
{
	const p = plan(
		[le("z.md", "h1"), le("a.md", "h2"), le("gone.md", "h1")],
		[re("z.md", "r9", "hz"), re("q.md", "r1", "hq")],
		[be("z.md", "r1", "h1"), be("gone.md", "r1", "h1")]
	);
	eq(acts(p), ["download:q.md", "download:z.md", "upload:a.md", "deleteLocal:gone.md"], "actions come out grouped and sorted");
}
{
	const b: [string, BaseEntry][] = [];
	for (let i = 0; i < 30; i++) b.push(be(`f${i}.md`, "r1", "h1"));
	const r: [string, RemoteEntry][] = b.map(([, v], i) => re(`f${i}.md`, v.rev, v.hash));
	const p = planSync({ local: new Map([le("new.md", "hx")]), remote: new Map(r), base: new Map(b) });
	ok(p.holdDeletes, "guard fixture trips");
	const s = stripDeletes(p);
	eq(acts(s), ["upload:new.md"], "stripDeletes keeps the transfers");
	eq([s.deletesLocal, s.deletesRemote, s.holdDeletes], [0, 0, false], "stripDeletes clears the delete counters");
}
eq(planSummary(plan([le("a.md", "h1")], [], [])), "1 up", "summary reads");
eq(planSummary(plan([], [], [])), "everything in sync", "empty summary reads");

console.log("short reads: a 200 with a partial body is not a download");
{
	const threw = (got: number, expected: number) => {
		try {
			assertWholeDownload("x.webm", got, expected);
			return null;
		} catch (e) {
			return e;
		}
	};
	ok(isShortRead(threw(2_097_152, 62_858_638)), "a truncated body is refused");
	eq(threw(62_858_638, 62_858_638), null, "the whole file passes");
	eq(threw(0, 0), null, "an empty file passes");
	eq(threw(120, 0), null, "no published size means no opinion");
	ok(isShortRead(threw(80, 60)), "an over-long body is refused too: it is not the file either");
}

/* ---------- async: hashes, pkce, crypto ---------- */

async function main() {
	console.log("content hash (Dropbox algorithm, oracle vectors from an independent implementation)");
	eq(await contentHash(new ArrayBuffer(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "empty file");
	eq(await contentHash(new TextEncoder().encode("hello world").buffer as ArrayBuffer), "bc62d4b80d9e36da29c16c5d4d9f11731f36052c72401a76c23c0fb5a9b74423", "single block");
	{
		const big = new Uint8Array(4 * 1024 * 1024 + 5).fill(7);
		eq(await contentHash(big.buffer), "a8cbe1823c43d0f6cfc1093cd1b61ded18b3e259f1683e2fb5f45780395dd258", "multi block");
	}

	console.log("pkce");
	eq(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "RFC 7636 vector");

	console.log("encryption");
	const salt = makeSalt();
	const key = await deriveKey("correct horse", salt);
	const other = await deriveKey("wrong pony", salt);
	const secret = new TextEncoder().encode("very private note é中").buffer as ArrayBuffer;
	const sealed = await encryptBytes(key, secret);
	ok(looksEncrypted(sealed), "sealed bytes carry the magic");
	ok(!looksEncrypted(secret), "plaintext does not look encrypted");
	eq(new TextDecoder().decode(await decryptBytes(key, sealed)), "very private note é中", "roundtrip");
	{
		const two = await encryptBytes(key, secret);
		ok(bytesToB64(new Uint8Array(sealed)) !== bytesToB64(new Uint8Array(two)), "fresh IV every encryption");
	}
	let threw = "";
	try {
		await decryptBytes(other, sealed);
	} catch (e) {
		threw = e instanceof WrongKeyError ? "wrong-key" : "other";
	}
	eq(threw, "wrong-key", "wrong passphrase fails loudly");
	{
		const tampered = new Uint8Array(sealed.slice(0));
		tampered[tampered.length - 1] ^= 0xff;
		let t2 = "";
		try {
			await decryptBytes(key, tampered.buffer);
		} catch (e) {
			t2 = e instanceof WrongKeyError ? "wrong-key" : "other";
		}
		eq(t2, "wrong-key", "tampered bytes fail loudly");
	}
	{
		let t3 = "";
		try {
			await decryptBytes(key, secret);
		} catch (e) {
			t3 = e instanceof NotEncryptedError ? "not-encrypted" : "other";
		}
		eq(t3, "not-encrypted", "plaintext under an encrypted sync is its own error");
	}
	const check = await makeCheck(key);
	ok(await verifyCheck(key, check), "check verifies with the right key");
	ok(!(await verifyCheck(other, check)), "check rejects the wrong key");

	await shareScenarios();
	await simScenarios();

	if (failures) {
		console.error(`\n${failures} test(s) failed`);
		process.exit(1);
	}
	console.log("\nAll tests passed");
}

/* ---------------- sharing: the subscriber side ---------------- */

/** A vault and a network, faked. Records everything so a test can assert on
 *  what was NOT written as easily as on what was. */
class FakeShareIO implements ShareIO {
	files = new Map<string, { bytes: ArrayBuffer; mtime: number }>();
	net = new Map<string, ArrayBuffer>();
	logs: string[] = [];
	writes: string[] = [];

	async fetchBytes(url: string): Promise<ArrayBuffer> {
		const b = this.net.get(url);
		if (!b) throw new Error(`no such url: ${url}`);
		return b;
	}
	async read(rel: string): Promise<ArrayBuffer> {
		const f = this.files.get(rel);
		if (!f) throw new Error(`no such file: ${rel}`);
		return f.bytes;
	}
	async write(rel: string, bytes: ArrayBuffer, mtimeMs: number): Promise<void> {
		this.files.set(rel, { bytes, mtime: mtimeMs });
		this.writes.push(rel);
	}
	async exists(rel: string): Promise<boolean> {
		return this.files.has(rel);
	}
	log(level: "info" | "warn" | "error" | "debug", text: string) {
		this.logs.push(`${level}: ${text}`);
	}

	/* the owner's side of the same fake world: uploads land at URLs the
	 * subscriber half can then fetch, so one test can publish and receive */
	failReadsFor = new Set<string>();
	private urlFor(remotePath: string): string {
		return `https://dl.dropboxusercontent.com/x/${encodeURIComponent(remotePath)}?dl=1`;
	}
	publishIO(): PublishIO {
		return {
			read: async (local) => {
				if (this.failReadsFor.has(local)) throw new Error("this file could not be read");
				return this.read(local);
			},
			upload: async (path, bytes) => {
				this.net.set(this.urlFor(path), bytes);
			},
			link: async (path) => this.urlFor(path),
			remove: async (path) => {
				this.net.delete(this.urlFor(path));
			},
			unlink: async (url) => {
				this.net.delete(url);
			},
			log: (level, text) => this.log(level, text),
		};
	}

	text(rel: string): string | null {
		const f = this.files.get(rel);
		return f ? new TextDecoder().decode(f.bytes) : null;
	}
	put(rel: string, body: string, mtime = 1_800_000_000_000) {
		this.files.set(rel, { bytes: new TextEncoder().encode(body).buffer as ArrayBuffer, mtime });
	}
}

/** Publish a share the way stage 2 will: encrypt each file, host it at a
 *  plausible CDN URL, and encrypt the manifest that names them. */
async function seedShare(io: FakeShareIO, key: CryptoKey, files: Record<string, string>, opts: { id?: string; mtime?: number } = {}): Promise<ShareManifest> {
	const entries: ShareEntry[] = [];
	for (const [path, body] of Object.entries(files)) {
		const bytes = new TextEncoder().encode(body).buffer as ArrayBuffer;
		const url = `https://dl.dropboxusercontent.com/scl/fi/${encodeURIComponent(path)}?dl=1`;
		io.net.set(url, await encryptBytes(key, bytes));
		entries.push({ path, url, hash: await contentHash(bytes), size: bytes.byteLength, mtime: opts.mtime ?? 1_800_000_000_000 });
	}
	const m: ShareManifest = { v: 1, id: opts.id ?? "shr1", name: "Acme", owner: "Steve", updated: 1_800_000_000_000, files: entries };
	io.net.set("https://dl.dropboxusercontent.com/manifest?dl=1", await encodeManifest(key, m));
	return m;
}

function subscription(keyB64: string, keys?: MemberKeys): Subscription {
	return {
		id: "shr1",
		name: "Acme",
		owner: "Steve",
		manifestUrl: "https://dl.dropboxusercontent.com/manifest?dl=1",
		keyringUrl: "https://dl.dropboxusercontent.com/keyring?dl=1",
		memberId: keys?.memberId ?? "m1",
		privateJwk: keys?.privateJwk ?? "",
		publicKey: keys?.publicKey ?? "",
		memberName: "Tester",
		key: keyB64,
		localPath: "Shared/Steve",
		addedAt: 1_800_000_000_000,
		paused: false,
	};
}

async function shareScenarios() {
	console.log("sharing: link rewriting");
	eq(directUrl("https://www.dropbox.com/scl/fi/abc/n.md?rlkey=k&dl=0"), "https://dl.dropboxusercontent.com/scl/fi/abc/n.md?rlkey=k&dl=1", "share page URL becomes a direct URL");
	eq(directUrl("https://dropbox.com/scl/fi/abc/n.md?rlkey=k"), "https://dl.dropboxusercontent.com/scl/fi/abc/n.md?rlkey=k&dl=1", "dl=1 is appended when absent");
	eq(directUrl(""), "", "empty stays empty");
	ok(fetchableUrl("https://dl.dropboxusercontent.com/x"), "the Dropbox content host is fetchable");
	ok(!fetchableUrl("http://dl.dropboxusercontent.com/x"), "plain http is refused");
	ok(!fetchableUrl("https://www.dropbox.com/scl/fi/x"), "the share page host is not a file host");
	ok(!fetchableUrl("file:///etc/passwd"), "local files are not fetchable");
	ok(!fetchableUrl("https://evil.example.com/x"), "an unknown host is refused");

	console.log("sharing: invite code");
	{
		const code = makeShareCode({ id: "abc", name: "Acme", owner: "Steve", manifestUrl: "https://dl.dropboxusercontent.com/m?dl=1", keyringUrl: "https://dl.dropboxusercontent.com/r?dl=1" });
		ok(looksLikeShareCode(code), "a share code looks like one");
		ok(!looksLikeShareCode("PCON-SETUP:1:xyz"), "a device setup code is not a share code");
		ok(looksLikeShareCode("pcon-share:1:xyz"), "an en-dash from a phone keyboard still looks like a code");
		const back = parseShareCode(code);
		ok(back, "code roundtrips");
		eq(back?.id, "abc", "id survives");
		eq(back?.name, "Acme", "name survives");
		ok(parseShareCode(code.replace("PCON-SHARE", "pcon–share")), "a lowercased, en-dashed prefix from a phone still parses");
		eq(parseShareCode(code.slice(0, code.length - 12)), null, "a truncated code does not silently parse");
		eq(parseShareCode("PCON-SHARE:2:not base64 at all"), null, "a damaged body is refused");
		{
			let why = "";
			try {
				parseShareCode("PCON-SHARE:1:" + b64url(new TextEncoder().encode("{}")));
			} catch (e) {
				why = e instanceof ShareCodeOutdated ? "outdated" : "other";
			}
			eq(why, "outdated", "an invite from the key-in-the-code design is named as outdated, not as damaged");
		}
		eq(parseShareCode("PCON-SHARE:2:" + b64url(new TextEncoder().encode(JSON.stringify({ i: "x", r: "https://dl.dropboxusercontent.com/r", m: "https://evil.example.com/m" })))), null, "a code pointing at an unknown host is refused");
	}

	console.log("sharing: manifest envelope");
	{
		const io = new FakeShareIO();
		const keyB64 = makeShareKey();
		const key = await importShareKey(keyB64);
		const m = await seedShare(io, key, { "a.md": "alpha" });
		const raw = io.net.get(m.files.length ? "https://dl.dropboxusercontent.com/manifest?dl=1" : "")!;
		ok(looksEncrypted(raw), "the manifest is published encrypted");
		eq((await decodeManifest(key, raw)).id, "shr1", "manifest roundtrips");
		let why = "";
		try {
			await decodeManifest(await importShareKey(makeShareKey()), raw);
		} catch (e) {
			why = e instanceof ShareUnreadable ? "unreadable" : "other";
		}
		eq(why, "unreadable", "a rotated key reports revocation, not a crash");
		let why2 = "";
		try {
			await decodeManifest(key, new TextEncoder().encode("<html>404</html>").buffer as ArrayBuffer);
		} catch (e) {
			why2 = e instanceof ShareUnreadable ? "unreadable" : "other";
		}
		eq(why2, "unreadable", "an error page where a manifest should be reports revocation");
	}

	console.log("sharing: pull planning");
	{
		const io = new FakeShareIO();
		const key = await importShareKey(makeShareKey());
		const m = await seedShare(io, key, { "a.md": "alpha", "b.md": "beta" });
		const state = emptyShareState();

		eq(planSharePull(m, new Map(), state).adds, 2, "a fresh share is all adds");

		const cur = new Map<string, string | null>([
			["a.md", m.files[0].hash],
			["b.md", m.files[1].hash],
		]);
		state.entries["a.md"] = { hash: m.files[0].hash, mtime: 1, size: 1 };
		state.entries["b.md"] = { hash: m.files[1].hash, mtime: 1, size: 1 };
		eq(planSharePull(m, cur, state).actions.length, 0, "an unchanged share plans nothing at all");

		const edited = new Map(cur);
		edited.set("a.md", "localhash");
		eq(planSharePull(m, edited, state).actions[0]?.t, "keepLocal", "a reader's edit stands while the owner's copy is unchanged");

		const moved: ShareManifest = { ...m, files: [{ ...m.files[0], hash: "ownerhash" }, m.files[1]] };
		eq(planSharePull(moved, cur, state).actions[0]?.t, "update", "an owner edit over an untouched file updates");
		eq(planSharePull(moved, edited, state).actions[0]?.t, "conflict", "both sides changed means conflict, never overwrite");

		const strangerHere = new Map<string, string | null>([["a.md", "somethingelse"]]);
		eq(planSharePull({ ...m, files: [m.files[0]] }, strangerHere, emptyShareState()).actions[0]?.t, "conflict", "an existing file where a share lands is a conflict, not a clobber");

		const dropped = planSharePull({ ...m, files: [m.files[0]] }, cur, state);
		eq(dropped.releases, 1, "a file removed from the share is released");
		eq(
			dropped.actions.find((a) => a.t === "release")?.path,
			"b.md",
			"the released path is the one dropped"
		);

		const gone = new Map<string, string | null>([["a.md", null], ["b.md", null]]);
		eq(planSharePull(m, gone, state).actions.length, 0, "a file the reader deleted is not re-added");
	}

	console.log("sharing: refuses what a manifest must not name");
	{
		const io = new FakeShareIO();
		const key = await importShareKey(makeShareKey());
		const m = await seedShare(io, key, { "a.md": "alpha" });
		const bad = (path: string, url?: string): ShareManifest => ({ ...m, files: [{ ...m.files[0], path, url: url ?? m.files[0].url }] });

		// the configuration folder is named by the caller, never assumed here
		eq(planSharePull(bad(".obsidian/plugins/x/main.js"), new Map(), emptyShareState(), 0, ".obsidian").actions.length, 0, "a share may not carry plugin code");
		eq(planSharePull(bad("../outside.md"), new Map(), emptyShareState()).actions.length, 0, "path traversal is refused");
		eq(planSharePull(bad("a/b:c.md"), new Map(), emptyShareState()).actions[0]?.t, "unsafe", "a name Windows cannot write is reported, not attempted");
		eq(planSharePull(bad("ok.md", "https://evil.example.com/x"), new Map(), emptyShareState()).actions[0]?.t, "unsafe", "a link to an unknown host is refused");
	}

	console.log("sharing: end to end pull");
	{
		const io = new FakeShareIO();
		const keyB64 = makeShareKey();
		const key = await importShareKey(keyB64);
		await seedShare(io, key, { "a.md": "alpha", "sub/b.md": "beta" });
		const sub = subscription(keyB64);
		const state = emptyShareState();

		const first = await pullShare(io, sub, state, keyB64);
		eq(first.written, 2, "first pull writes both files");
		eq(io.text("Shared/Steve/a.md"), "alpha", "content decrypts into the chosen folder");
		eq(io.text("Shared/Steve/sub/b.md"), "beta", "nested paths survive");
		eq(io.files.get("Shared/Steve/a.md")?.mtime, 1_800_000_000_000, "the manifest's mtime is written, not now()");

		io.writes.length = 0;
		const second = await pullShare(io, sub, state, keyB64);
		eq(second.written, 0, "a second pull writes nothing");
		eq(io.writes.length, 0, "and touches no file at all, so the reader's own sync stays quiet");

		// the owner edits; the reader has not touched it
		await seedShare(io, key, { "a.md": "alpha revised", "sub/b.md": "beta" });
		const third = await pullShare(io, sub, state, keyB64);
		eq(third.written, 1, "an owner edit arrives");
		eq(io.text("Shared/Steve/a.md"), "alpha revised", "with the new content");

		// the reader edits, then the owner edits the same file
		io.put("Shared/Steve/a.md", "my own thoughts");
		await seedShare(io, key, { "a.md": "alpha revised twice", "sub/b.md": "beta" });
		const fourth = await pullShare(io, sub, state, keyB64);
		eq(fourth.conflicts.length, 1, "a collision keeps the reader's work");
		eq(io.text("Shared/Steve/a.md"), "alpha revised twice", "the owner's copy lands at the shared path");
		ok(
			[...io.files.keys()].some((k) => k !== "Shared/Steve/a.md" && io.text(k) === "my own thoughts"),
			"and the reader's version survives as a conflict copy"
		);
	}

	console.log("sharing: a share that lies about its contents");
	{
		const io = new FakeShareIO();
		const keyB64 = makeShareKey();
		const key = await importShareKey(keyB64);
		const m = await seedShare(io, key, { "a.md": "alpha" });
		// same URL, different bytes than the manifest's hash promises
		io.net.set(m.files[0].url, await encryptBytes(key, new TextEncoder().encode("not what was promised").buffer as ArrayBuffer));
		const r = await pullShare(io, subscription(keyB64), emptyShareState(), keyB64);
		eq(r.written, 0, "content that does not match the index is not written");
		eq(r.failed.length, 1, "and is reported as skipped");
		eq(io.text("Shared/Steve/a.md"), null, "nothing lands in the vault");
	}

	console.log("sharing: scaling to many shares");
	{
		const files = [
			{ path: "Projects/Acme/a.md", mtime: 10 },
			{ path: "Projects/Acme/deep/b.md", mtime: 30 },
			{ path: "Projects/Other/c.md", mtime: 20 },
			{ path: "Meetings/m.md", mtime: 40 },
		];
		const sigs = shareSignatures(
			[
				{ id: "s1", homePath: "Projects/Acme", attached: [] },
				{ id: "s2", homePath: "", attached: ["Meetings/m.md"] },
				{ id: "s3", homePath: "Projects", attached: [] },
				{ id: "s4", homePath: "Nothing/Here", attached: [] },
			],
			files
		);
		eq(sigs.get("s1"), { latest: 30, count: 2 }, "a home folder counts its whole subtree");
		eq(sigs.get("s2"), { latest: 40, count: 1 }, "an attached file counts on its own");
		eq(sigs.get("s3"), { latest: 30, count: 3 }, "a share nested above another sees both subtrees");
		eq(sigs.get("s4"), { latest: 0, count: 0 }, "a share whose folder is empty signs as empty");

		// the property the batching exists for: cost must not scale with the
		// number of shares. 400 shares over 400 files stays a few thousand
		// lookups, where the per-share walk would be 160,000.
		const many = Array.from({ length: 400 }, (_, i) => ({ id: `s${i}`, homePath: `F${i}`, attached: [] }));
		const manyFiles = Array.from({ length: 400 }, (_, i) => ({ path: `F${i}/note.md`, mtime: i }));
		const t0 = Date.now();
		const big = shareSignatures(many, manyFiles);
		ok(Date.now() - t0 < 500, "400 shares over 400 files signs quickly");
		eq(big.get("s399"), { latest: 399, count: 1 }, "and every share still gets its own answer");
		eq(big.get("s0"), { latest: 0, count: 1 }, "including the first");

		eq(nextCheckDelay(300_000, 0), 300_000, "an active share is checked at the base interval");
		eq(nextCheckDelay(300_000, 3), 2_400_000, "a share that keeps coming back empty backs off");
		eq(nextCheckDelay(300_000, 40), 7_200_000, "and the backoff is capped");
	}

	console.log("sharing: the approval handshake");
	{
		const alice = await generateMemberKeys();
		const bob = await generateMemberKeys();
		const contentKey = makeShareKey();

		const req = makeJoinCode({ shareId: "s1", memberId: alice.memberId, name: "Alice", publicKey: alice.publicKey });
		ok(looksLikeJoinCode(req), "a request code looks like one");
		ok(!looksLikeShareCode(req), "and is not mistaken for an invite");
		const back = parseJoinCode(req);
		eq(back?.name, "Alice", "the name comes through for the approval screen");
		eq(back?.publicKey, alice.publicKey, "and so does the public key");
		eq(parseJoinCode("PCON-JOIN:1:" + b64url(new TextEncoder().encode(JSON.stringify({ s: "s1", m: "m", k: "shortkey" })))), null, "a key that is not a P-256 point is refused");
		ok(!req.includes(alice.privateJwk.slice(10, 30)), "a request code carries nothing private");

		const entry = await wrapKeyFor(alice.publicKey, alice.memberId, contentKey);
		eq(await unwrapContentKey(alice.privateJwk, entry), contentKey, "an approved member opens their own entry");

		let why = "";
		try {
			await unwrapContentKey(bob.privateJwk, entry);
		} catch {
			why = "refused";
		}
		eq(why, "refused", "and nobody else can open it, even holding the whole keyring");

		const twice = await wrapKeyFor(alice.publicKey, alice.memberId, contentKey);
		ok(twice.ephemeral !== entry.ephemeral, "each wrap uses a fresh ephemeral key");

		const share: OwnedShare = {
			id: "s1",
			name: "S",
			key: contentKey,
			members: [
				{ memberId: alice.memberId, name: "Alice", publicKey: alice.publicKey, state: "approved", requestedAt: 1, decidedAt: 2, email: "" },
				{ memberId: bob.memberId, name: "Bob", publicKey: bob.publicKey, state: "pending", requestedAt: 1, decidedAt: 0, email: "" },
			],
			keyringUrl: "",
			homePath: "P",
			attached: [],
			remoteFolder: "s1",
			manifestUrl: "",
			createdAt: 1,
			publishedAt: 0,
			expiresAt: 0,
			invitesSent: [],
		};
		const ring = await buildKeyring(share);
		eq(ring.entries.length, 1, "only approved members get a keyring entry");
		eq(ring.entries[0].memberId, alice.memberId, "and it is the approved one");
	}

	console.log("sharing: approval gates the whole share");
	{
		const io = new FakeShareIO();
		const keyB64 = makeShareKey();
		const alice = await generateMemberKeys();
		const share: OwnedShare = {
			id: "shr1",
			name: "Acme",
			key: keyB64,
			members: [{ memberId: alice.memberId, name: "Alice", publicKey: alice.publicKey, state: "pending", requestedAt: 1, decidedAt: 0, email: "" }],
			keyringUrl: "",
			homePath: "P",
			attached: [],
			remoteFolder: "shr1",
			manifestUrl: "",
			createdAt: 1,
			publishedAt: 0,
			expiresAt: 0,
			invitesSent: [],
		};
		io.put("P/a.md", "the goods");
		const files = async (): Promise<ShareFile[]> => {
			const b = io.files.get("P/a.md")!;
			return [{ local: "P/a.md", share: "a.md", hash: await contentHash(b.bytes), size: b.bytes.byteLength, mtime: b.mtime }];
		};

		const r = await publishShare(io.publishIO(), share, await files(), null);
		share.manifestUrl = r.manifestUrl;
		share.keyringUrl = r.keyringUrl;

		const sub = subscription("", alice);
		sub.manifestUrl = share.manifestUrl;
		sub.keyringUrl = share.keyringUrl;
		sub.key = "";

		// pending: the bytes are right there, and are worth nothing
		let state = "";
		try {
			await resolveMemberKey(io, sub);
		} catch (e) {
			state = e instanceof ShareNotApproved ? "waiting" : "other";
		}
		eq(state, "waiting", "a member who has not been approved cannot open the share");
		ok(io.net.has(share.manifestUrl), "even though the index is sitting there in the open");

		// approved
		share.members[0].state = "approved";
		share.keyringUrl = await publishKeyring(io.publishIO(), share);
		const got = await resolveMemberKey(io, sub);
		eq(got, keyB64, "approving hands over the content key");
		const pulled = await pullShare(io, sub, emptyShareState(), got);
		eq(pulled.written, 1, "and the notes arrive");
		eq(io.text("Shared/Steve/a.md"), "the goods", "with the right content");

		// revoked, with a key rotation behind it
		share.members[0].state = "revoked";
		share.key = makeShareKey();
		share.keyringUrl = await publishKeyring(io.publishIO(), share);
		await publishShare(io.publishIO(), share, await files(), null);
		let after = "";
		try {
			await resolveMemberKey(io, sub);
		} catch (e) {
			after = e instanceof ShareNotApproved ? "withdrawn" : "other";
		}
		eq(after, "withdrawn", "a revoked member loses their entry");
		let stale = "";
		try {
			// and the key they kept from before no longer opens the new content
			await pullShare(io, sub, emptyShareState(), keyB64);
		} catch {
			stale = "useless";
		}
		eq(stale, "useless", "the key they kept opens nothing after the rotation");
	}

	console.log("sharing: resolving what a share carries");
	{
		const all = [
			{ path: "Projects/Acme/Kickoff.md", size: 10, mtime: 1 },
			{ path: "Projects/Acme/notes/Deep.md", size: 10, mtime: 2 },
			{ path: "Projects/Other/Secret.md", size: 10, mtime: 3 },
			{ path: "Meetings/2026-07-20.md", size: 10, mtime: 4 },
			{ path: ".obsidian/plugins/x/data.json", size: 10, mtime: 5 },
		];
		const hashes = new Map(all.map((f) => [f.path, `h-${f.path}`]));

		const home = resolveShareFiles({ homePath: "Projects/Acme", attached: [] }, all, hashes);
		eq(home.files.map((f) => f.share).sort(), ["Kickoff.md", "notes/Deep.md"], "a home folder shares its subtree, relative to itself");
		ok(!home.files.some((f) => f.local.startsWith("Projects/Other")), "a sibling folder is not swept in");

		const mixed = resolveShareFiles({ homePath: "Projects/Acme", attached: ["Meetings/2026-07-20.md"] }, all, hashes);
		eq(mixed.files.map((f) => f.share).sort(), ["Kickoff.md", "Meetings/2026-07-20.md", "notes/Deep.md"], "an attached note keeps its own path");

		const pagesOnly = resolveShareFiles({ homePath: "", attached: ["Meetings/2026-07-20.md", "Projects/Other/Secret.md"] }, all, hashes);
		eq(pagesOnly.files.length, 2, "a share can be nothing but individual pages");

		// the folder is named here rather than assumed by the code under test, which
		// is the point: a vault can call its configuration folder anything
		const config = resolveShareFiles({ homePath: "", attached: [".obsidian/plugins/x/data.json"] }, all, hashes, 0, ".obsidian");
		eq(config.files.length, 0, "plugin settings can never be attached to a share");
		eq(config.skipped.length, 1, "and the refusal is reported, not silent");

		const gone = resolveShareFiles({ homePath: "", attached: ["Deleted.md"] }, all, hashes);
		eq(gone.skipped[0]?.why, "it is no longer in this vault", "an attachment that was deleted is reported");

		const dupe = resolveShareFiles({ homePath: "Projects/Acme", attached: ["Projects/Acme/Kickoff.md"] }, all, hashes);
		eq(dupe.files.length, 2, "attaching a file the home folder already carries does not double it");
	}

	console.log("sharing: size limits");
	{
		const all = [
			{ path: "P/small.md", size: 100, mtime: 1 },
			{ path: "P/huge.mp4", size: 50 * 1024 * 1024, mtime: 2 },
		];
		const hashes = new Map(all.map((f) => [f.path, `h-${f.path}`]));
		const capped = resolveShareFiles({ homePath: "P", attached: [] }, all, hashes, 10 * 1024 * 1024);
		eq(capped.files.map((f) => f.share), ["small.md"], "a file over the vault's limit is not published");
		eq(capped.skipped.length, 1, "and is reported rather than dropped in silence");
		eq(resolveShareFiles({ homePath: "P", attached: [] }, all, hashes, 0).files.length, 2, "no limit means no limit");

		const manifest: ShareManifest = {
			v: 1,
			id: "s",
			name: "s",
			owner: "",
			updated: 1,
			files: [
				{ path: "small.md", url: "https://dl.dropboxusercontent.com/a", hash: "h1", size: 100, mtime: 1 },
				{ path: "huge.mp4", url: "https://dl.dropboxusercontent.com/b", hash: "h2", size: 50 * 1024 * 1024, mtime: 2 },
			],
		};
		const plan = planSharePull(manifest, new Map(), emptyShareState(), 10 * 1024 * 1024);
		eq(plan.adds, 1, "a reader's own size limit applies to what arrives");
		eq(plan.actions.filter((a) => a.t === "unsafe").length, 1, "and the oversized one is reported");
	}

	console.log("sharing: publish planning");
	{
		const f = (local: string, hash: string): ShareFile => ({ local, share: local, hash, size: 1, mtime: 1 });
		const first = planSharePublish([f("a.md", "h1"), f("b.md", "h2")], null);
		eq(first.uploads.length, 2, "a first publish uploads everything");
		eq(first.orphans.length, 0, "and orphans nothing");

		const prev: ShareManifest = {
			v: 1,
			id: "s",
			name: "s",
			owner: "",
			updated: 1,
			files: [
				{ path: "a.md", url: "https://dl.dropboxusercontent.com/h1", hash: "h1", size: 1, mtime: 1 },
				{ path: "b.md", url: "https://dl.dropboxusercontent.com/h2", hash: "h2", size: 1, mtime: 1 },
			],
		};
		const same = planSharePublish([f("a.md", "h1"), f("b.md", "h2")], prev);
		eq(same.uploads.length, 0, "republishing unchanged files uploads nothing");
		eq(same.unchanged, 2, "and counts them as unchanged");

		const moved = planSharePublish([f("renamed.md", "h1"), f("b.md", "h2")], prev);
		eq(moved.uploads.length, 0, "a renamed note reuses its blob and its link");

		const edited = planSharePublish([f("a.md", "h1-new"), f("b.md", "h2")], prev);
		eq(edited.uploads.length, 1, "an edited note uploads once");
		eq(edited.orphans.map((o) => o.hash), ["h1"], "and its old blob becomes an orphan");

		const twins = planSharePublish([f("a.md", "hx"), f("copy.md", "hx")], null);
		eq(twins.uploads.length, 1, "two identical files upload once");
	}

	console.log("sharing: publish and receive, end to end");
	{
		const io = new FakeShareIO();
		const keyB64 = makeShareKey();
		const share: OwnedShare = {
			id: "shr9",
			name: "Acme",
			key: keyB64,
			members: [],
			keyringUrl: "",
			homePath: "Projects/Acme",
			attached: [],
			remoteFolder: "shr9",
			manifestUrl: "",
			createdAt: 1,
			publishedAt: 0,
			expiresAt: 0,
			invitesSent: [],
		};
		const pio = io.publishIO();

		io.put("Projects/Acme/Kickoff.md", "the kickoff");
		io.put("Projects/Acme/notes/Deep.md", "deeper");
		const files = async () => {
			const all = [...io.files.entries()].filter(([p]) => p.startsWith("Projects/")).map(([path, v]) => ({ path, size: v.bytes.byteLength, mtime: v.mtime }));
			const hashes = new Map<string, string>();
			for (const a of all) hashes.set(a.path, await contentHash(io.files.get(a.path)!.bytes));
			return resolveShareFiles(share, all, hashes).files;
		};

		const r1 = await publishShare(pio, share, await files(), null);
		eq(r1.uploaded, 2, "publish uploads both files");
		share.manifestUrl = r1.manifestUrl;

		// now receive it in a different "vault" and check it round-trips
		const sub = subscription(keyB64);
		sub.manifestUrl = share.manifestUrl;
		const state = emptyShareState();
		const got = await pullShare(io, sub, state, keyB64);
		eq(got.written, 2, "a subscriber receives both files");
		eq(io.text("Shared/Steve/Kickoff.md"), "the kickoff", "content survives publish and pull");
		eq(io.text("Shared/Steve/notes/Deep.md"), "deeper", "including nested paths");

		// the owner edits one file and republishes
		io.put("Projects/Acme/Kickoff.md", "the kickoff, revised");
		const r2 = await publishShare(pio, share, await files(), r1.manifest);
		eq(r2.uploaded, 1, "only the edited file republishes");
		eq(r2.reused, 1, "the untouched one is reused");
		eq(r2.removed, 1, "and the stale blob is withdrawn");
		const got2 = await pullShare(io, sub, state, keyB64);
		eq(got2.written, 1, "the subscriber pulls only what changed");
		eq(io.text("Shared/Steve/Kickoff.md"), "the kickoff, revised", "and sees the new content");

		// unsharing a file withdraws it without touching the reader's copy
		io.files.delete("Projects/Acme/Kickoff.md");
		const r3 = await publishShare(pio, share, await files(), r2.manifest);
		eq(r3.manifest.files.length, 1, "withdrawing a file drops it from the index");
		const got3 = await pullShare(io, sub, state, keyB64);
		eq(got3.plan.releases, 1, "the subscriber releases it");
		eq(io.text("Shared/Steve/Kickoff.md"), "the kickoff, revised", "and keeps the note as an ordinary file");

		// moving the home folder re-roots every path in the share: to a
		// subscriber that is a withdrawal and a fresh arrival, not a move.
		// Surprising enough to pin down, and worth warning about in the UI.
		share.homePath = "Projects/Acme/notes";
		const r4 = await publishShare(pio, share, await files(), r3.manifest);
		eq(
			r4.manifest.files.map((f) => f.path),
			["Deep.md"],
			"re-rooting the home folder rewrites the paths inside the share"
		);
		eq(r4.uploaded, 0, "content is unchanged, so nothing re-uploads");
		const got4 = await pullShare(io, sub, state, keyB64);
		eq(got4.plan.releases, 1, "the old path is released");
		eq(io.text("Shared/Steve/Deep.md"), "deeper", "and the same note arrives at the new path");
	}

	console.log("sharing: a publish that partly fails still leaves a coherent share");
	{
		const io = new FakeShareIO();
		const keyB64 = makeShareKey();
		const share: OwnedShare = { id: "s2", name: "S", key: keyB64, members: [], keyringUrl: "", homePath: "P", attached: [], remoteFolder: "s2", manifestUrl: "", createdAt: 1, publishedAt: 0, expiresAt: 0, invitesSent: [] };
		io.put("P/a.md", "one");
		const mk = async (paths: string[]): Promise<ShareFile[]> => {
			const out: ShareFile[] = [];
			for (const p of paths) {
				const b = io.files.get(p)!;
				out.push({ local: p, share: p.slice(2), hash: await contentHash(b.bytes), size: b.bytes.byteLength, mtime: b.mtime });
			}
			return out;
		};
		const r1 = await publishShare(io.publishIO(), share, await mk(["P/a.md"]), null);
		share.manifestUrl = r1.manifestUrl;

		io.put("P/b.md", "two");
		io.failReadsFor.add("P/b.md"); // one file cannot be read this run
		const r2 = await publishShare(io.publishIO(), share, await mk(["P/a.md", "P/b.md"]), r1.manifest);
		eq(r2.failed.length, 1, "the failure is reported");
		eq(
			r2.manifest.files.map((f) => f.path),
			["a.md"],
			"and the index never names a file nobody can fetch"
		);
		const sub = subscription(keyB64);
		sub.manifestUrl = share.manifestUrl;
		const got = await pullShare(io, sub, emptyShareState(), keyB64);
		eq(got.written, 1, "the subscriber still receives a coherent share");
		eq(got.failed.length, 0, "with nothing broken in it");
	}

	console.log("sharing: one dead link does not sink the share");
	{
		const io = new FakeShareIO();
		const keyB64 = makeShareKey();
		const key = await importShareKey(keyB64);
		const m = await seedShare(io, key, { "a.md": "alpha", "b.md": "beta" });
		io.net.delete(m.files[0].url);
		const r = await pullShare(io, subscription(keyB64), emptyShareState(), keyB64);
		eq(r.written, 1, "the reachable file still arrives");
		eq(r.failed.length, 1, "the dead one is reported");
		eq(io.text("Shared/Steve/b.md"), "beta", "and the rest of the share is intact");
	}
}

/* ---------------- the simulation: real engines, fake world ---------------- */

async function simScenarios() {
	console.log("simulation: two devices, first sync");
	{
		const srv = new FakeServer();
		const A = new SimDevice("A", srv, {}, 1_800_000_000_000);
		const B = new SimDevice("B", srv, {}, 1_800_500_000_000);
		A.vault.user("notes/one.md", "one");
		A.vault.user("notes/two.md", "two");
		A.vault.user("three.md", "three");
		const r1 = await A.sync();
		eq(r1.stats.up, 3, "first device uploads everything");
		const r2 = await B.sync();
		eq(r2.stats.down, 3, "second device downloads everything");
		eq(await converge([A, B]), 1, "fleet settles immediately");
		eq(fleetDiff([A, B]), null, "fleets identical");
		eq(B.vault.text("notes/one.md"), "one", "content arrived intact");
	}

	console.log("simulation: a truncated download is refused, and does not stick");
	{
		const srv = new FakeServer();
		const A = new SimDevice("A", srv, {}, 1_800_000_000_000);
		const B = new SimDevice("B", srv, {}, 1_800_500_000_000);
		const whole = "the whole meeting, every word of it";
		A.vault.user("recording.md", whole);
		await A.sync();

		// the stream ends early while the metadata still describes the whole
		// file: the shape that used to be written to disk and then recorded as
		// a perfect match, so no later scan could ever notice
		const remotePath = [...srv.files.values()].find((f) => f.display.endsWith("recording.md"))!.display;
		srv.truncateNextRead(remotePath, 9);
		const bad = await B.sync();
		eq(bad.stats.down, 0, "a partial body does not count as a download");
		eq(bad.stats.skipped, 1, "it is skipped instead");
		eq(B.vault.text("recording.md"), null, "and nothing lands in the vault");

		// the half that matters: the bad transfer must not be recorded as synced
		const good = await B.sync();
		eq(good.stats.down, 1, "the next sync retries it");
		eq(B.vault.text("recording.md"), whole, "and the whole file arrives");
		eq(fleetDiff([A, B]), null, "fleets identical once it lands");
	}

	console.log("simulation: same content both sides pairs with no transfer");
	{
		const srv = new FakeServer();
		const A = new SimDevice("A", srv);
		const B = new SimDevice("B", srv, {}, 1_800_900_000_000);
		A.vault.user("same.md", "identical words");
		B.vault.user("same.md", "identical words");
		await A.sync();
		const r = await B.sync();
		eq([r.stats.adopts, r.stats.up, r.stats.down], [1, 0, 0], "identical file adopts, nothing moves");
		eq(fleetDiff([A, B]), null, "fleets identical after adopt");
	}

	console.log("simulation: an adopt storm keeps checkpoints bounded");
	{
		// a new device meeting an already-uploaded vault pairs thousands of
		// files in seconds; the checkpoint requests during that burst must
		// stay rare (the renderer once died under a flood of eager
		// journal serializations)
		const srv = new FakeServer();
		const A = new SimDevice("A", srv);
		const B = new SimDevice("B", srv, {}, 1_800_900_000_000);
		for (let i = 0; i < 450; i++) {
			A.vault.user(`bulk/n${i}.md`, `note ${i}`);
			B.vault.user(`bulk/n${i}.md`, `note ${i}`);
		}
		await A.sync();
		B.saves = 0;
		const r = await B.sync();
		eq(r.stats.adopts, 450, "every file adopts with no transfer");
		ok(B.saves <= 5, `checkpoint requests stay bounded during the storm (got ${B.saves})`);
		eq(fleetDiff([A, B]), null, "fleets identical after the storm");
	}

	console.log("simulation: divergent edits keep both, deterministically");
	{
		const srv = new FakeServer();
		const A = new SimDevice("A", srv, {}, 1_800_000_000_000);
		const B = new SimDevice("B", srv, {}, 1_800_500_000_000); // B's clock is later: B wins names
		A.vault.user("plan.md", "base");
		await converge([A, B]);
		A.vault.user("plan.md", "from A");
		B.vault.user("plan.md", "from B");
		await A.sync();
		const rb = await B.sync();
		eq(rb.stats.conflicts, 1, "the stale device sees the conflict");
		eq(await converge([A, B]) > 0, true, "fleet settles after the conflict");
		eq(fleetDiff([A, B]), null, "both devices hold the same two files");
		ok(contentSurvives(A, "from A") && contentSurvives(A, "from B"), "no words lost on A");
		ok(contentSurvives(B, "from A") && contentSurvives(B, "from B"), "no words lost on B");
		eq(B.vault.text("plan.md"), "from B", "the newer edit keeps the name");
		eq([...A.vault.files.values()].length, 2, "exactly one conflict copy");
	}

	console.log("simulation: an edit outranks a delete");
	{
		const srv = new FakeServer();
		const A = new SimDevice("A", srv);
		const B = new SimDevice("B", srv, {}, 1_800_500_000_000);
		A.vault.user("keep.md", "v1");
		await converge([A, B]);
		A.vault.userDelete("keep.md");
		B.vault.user("keep.md", "v2 survives");
		await A.sync(); // delete propagates first
		await B.sync(); // B's edit restores the file
		await converge([A, B]);
		eq(A.vault.text("keep.md"), "v2 survives", "the edit came back to the deleting device");
		eq(fleetDiff([A, B]), null, "fleets identical after restore");
	}

	console.log("simulation: delete precondition saves a fresh edit");
	{
		const srv = new FakeServer();
		const A = new SimDevice("A", srv);
		const B = new SimDevice("B", srv, {}, 1_800_500_000_000);
		A.vault.user("race.md", "v1");
		await converge([A, B]);
		A.vault.userDelete("race.md"); // A queues a delete against rev v1
		B.vault.user("race.md", "v2 fresh");
		await B.sync(); // B's new content lands first
		const ra = await A.sync(); // A's delete hits the precondition and steps aside
		eq(ra.stats.delRemote, 0, "the stale delete did not go through");
		eq(ra.stats.skipped >= 1 || ra.stats.down >= 1, true, "the delete was skipped or the edit already pulled");
		await converge([A, B]);
		eq(A.vault.text("race.md"), "v2 fresh", "the fresh edit survived the stale delete");
		eq(fleetDiff([A, B]), null, "fleets identical");
	}

	console.log("simulation: renames move remotely instead of re-uploading");
	{
		const srv = new FakeServer();
		const A = new SimDevice("A", srv);
		const B = new SimDevice("B", srv, {}, 1_800_500_000_000);
		A.vault.user("old name.md", "big content that should not re-upload");
		await converge([A, B]);
		A.rename("old name.md", "sub/new name.md");
		const r = await A.sync();
		eq([r.stats.moves, r.stats.up], [1, 0], "a clean rename is one remote move, zero uploads");
		await converge([A, B]);
		eq(B.vault.text("sub/new name.md"), "big content that should not re-upload", "the other device follows the rename");
		eq(B.vault.text("old name.md"), null, "the old name is gone everywhere");
		eq(fleetDiff([A, B]), null, "fleets identical after rename");
	}

	console.log("simulation: mass deletes hold for a human, then apply");
	{
		const srv = new FakeServer();
		const A = new SimDevice("A", srv);
		const B = new SimDevice("B", srv, {}, 1_800_500_000_000);
		for (let i = 0; i < 30; i++) A.vault.user(`bulk/f${i}.md`, `content ${i}`);
		await converge([A, B]);
		for (let i = 0; i < 25; i++) A.vault.userDelete(`bulk/f${i}.md`);
		const held = await A.sync(false);
		eq(held.deferredDeletes, 25, "an unattended sync defers the mass delete");
		eq(srv.files.size >= 30, true, "nothing was deleted remotely while held");
		await A.sync(true); // the user reviewed and confirmed
		const heldB = await B.sync(false);
		eq(heldB.deferredDeletes, 25, "the other device holds its local mass delete too");
		await B.sync(true);
		await converge([A, B], 10, true);
		eq([...A.vault.files.values()].length, 5, "confirmed deletes applied");
		eq(fleetDiff([A, B]), null, "fleets identical after the confirmed sweep");
		eq(B.vault.trashed.length, 25, "local deletions went to the trash, not oblivion");
	}

	console.log("simulation: a folder deleted in Dropbox arrives as one entry");
	{
		const srv = new FakeServer();
		const A = new SimDevice("A", srv);
		A.vault.user("sub/a.md", "a");
		A.vault.user("sub/b.md", "b");
		A.vault.user("root.md", "r");
		await A.sync();
		srv.deleteFolderCascade("/SimVault/sub");
		await A.sync();
		eq(A.vault.text("sub/a.md"), null, "cascade delete reached file a");
		eq(A.vault.text("sub/b.md"), null, "cascade delete reached file b");
		eq(A.vault.text("root.md"), "r", "unrelated file untouched");
	}

	console.log("simulation: cursor reset recovers by relisting");
	{
		const srv = new FakeServer();
		const A = new SimDevice("A", srv);
		const B = new SimDevice("B", srv, {}, 1_800_500_000_000);
		A.vault.user("note.md", "v1");
		await converge([A, B]);
		srv.invalidateCursors();
		A.vault.user("note.md", "v2 after reset");
		await A.sync();
		await converge([A, B]);
		eq(B.vault.text("note.md"), "v2 after reset", "the edit crossed the reset");
		eq(fleetDiff([A, B]), null, "fleets identical after reset");
	}

	console.log("simulation: crashes at every point still converge");
	{
		for (const failAt of [1, 3, 5, 8, 12, 17, 23]) {
			const srv = new FakeServer();
			const A = new SimDevice("A", srv);
			const B = new SimDevice("B", srv, {}, 1_800_500_000_000);
			for (let i = 0; i < 8; i++) A.vault.user(`c/f${i}.md`, `payload ${i}`);
			srv.failAfter(failAt);
			const r = await A.sync();
			ok(r.crashed || r.stats.up > 0, `run at failpoint ${failAt} either crashed or progressed`);
			const rounds = await converge([A, B]);
			eq(rounds > 0, true, `fleet settles after a crash at op ${failAt}`);
			const diff = fleetDiff([A, B]);
			eq(diff, null, `fleets identical after crash at op ${failAt}${diff ? ` (${diff})` : ""}`);
			for (let i = 0; i < 8; i++) eq(B.vault.text(`c/f${i}.md`), `payload ${i}`, `payload ${i} intact after crash at op ${failAt}`);
		}
	}

	console.log("simulation: end-to-end encryption across devices");
	{
		const srv = new FakeServer();
		const A = new SimDevice("A", srv, { e2eEnabled: true, e2ePassphrase: "sim pass" });
		const B = new SimDevice("B", srv, { e2ePassphrase: "sim pass" }, 1_800_500_000_000);
		A.vault.user("secret.md", "private words é中");
		await A.sync();
		for (const [k, f] of srv.files) {
			if (k.endsWith(".powerconnect.json")) continue;
			ok(looksEncrypted(f.bytes), "server stores only ciphertext");
		}
		await B.sync();
		eq(B.vault.text("secret.md"), "private words é中", "the passphrase device decrypts");
		eq(B.settings.e2eEnabled, true, "the second device adopted encryption from the marker");
		const C = new SimDevice("C", srv, { e2ePassphrase: "wrong" }, 1_800_900_000_000);
		const rc = await C.sync();
		ok(!!rc.blocked && rc.blocked.includes("passphrase"), "a wrong passphrase blocks before touching anything");
		eq([...C.vault.files.values()].length, 0, "the blocked device wrote nothing");
	}

	console.log("simulation: protected plugin settings files");
	{
		// no envelope at all: plugin data.json is held back, everything else moves
		const srv0 = new FakeServer();
		const A0 = new SimDevice("A", srv0);
		A0.vault.user("note.md", "hello");
		A0.vault.user(".obsidian/plugins/foo/data.json", '{"apiKey":"sk-secret"}');
		await A0.sync();
		ok(!srv0.files.has("/simvault/.obsidian/plugins/foo/data.json"), "no envelope: plugin data.json held back");
		ok(srv0.files.has("/simvault/note.md"), "no envelope: notes still sync");

		// protection on: only plugin data.json is ciphertext
		const srv = new FakeServer();
		const salt = makeSalt();
		const check = await makeCheck(await deriveKey("pp", salt));
		await srv.putFile(
			"/SimVault/.powerconnect.json",
			new TextEncoder().encode(JSON.stringify({ format: 1, e2e: false, secrets: { salt, check } })).buffer as ArrayBuffer,
			"add",
			"2027-01-01T00:00:00Z"
		);
		const A = new SimDevice("A", srv, { e2ePassphrase: "pp" });
		A.vault.user("note.md", "plain words");
		A.vault.user(".obsidian/plugins/foo/data.json", '{"apiKey":"sk-secret"}');
		A.vault.user(".obsidian/plugins/powerconnect/data.json", '{"remoteFolder":"SimVault"}');
		await A.sync();
		const cipher = srv.files.get("/simvault/.obsidian/plugins/foo/data.json");
		ok(!!cipher && looksEncrypted(cipher.bytes), "protected data.json is ciphertext on the server");
		const note = srv.files.get("/simvault/note.md");
		ok(!!note && !looksEncrypted(note.bytes), "notes stay plaintext beside protection");
		const own = srv.files.get("/simvault/.obsidian/plugins/powerconnect/data.json");
		ok(!!own && !looksEncrypted(own.bytes), "our own settings file stays readable for joining devices");

		const B = new SimDevice("B", srv, {}, 1_800_500_000_000);
		await B.sync();
		eq(B.vault.text("note.md"), "plain words", "no passphrase: notes arrive");
		eq(B.vault.text(".obsidian/plugins/foo/data.json"), null, "no passphrase: protected file held back, not failed");

		const C = new SimDevice("C", srv, { e2ePassphrase: "pp" }, 1_800_900_000_000);
		await C.sync();
		eq(C.vault.text(".obsidian/plugins/foo/data.json"), '{"apiKey":"sk-secret"}', "with the passphrase the protected file arrives intact");

		const D = new SimDevice("D", srv, { e2ePassphrase: "nope" }, 1_801_200_000_000);
		const rd = await D.sync();
		ok(!rd.blocked, "a wrong protection passphrase does not block the run");
		eq(D.vault.text("note.md"), "plain words", "wrong passphrase: notes still arrive");
		eq(D.vault.text(".obsidian/plugins/foo/data.json"), null, "wrong passphrase: protected file held back");
	}

	console.log("simulation: selective folder encryption");
	{
		// a marker that protects the top-level "Email" folder while the rest of
		// the vault stays plain, sharing the one protection passphrase
		const srv = new FakeServer();
		const salt = makeSalt();
		const check = await makeCheck(await deriveKey("pp", salt));
		await srv.putFile(
			"/SimVault/.powerconnect.json",
			new TextEncoder().encode(JSON.stringify({ format: 1, e2e: false, protectedFolders: ["Email"], secrets: { salt, check } })).buffer as ArrayBuffer,
			"add",
			"2027-01-01T00:00:00Z"
		);
		const A = new SimDevice("A", srv, { e2ePassphrase: "pp" });
		A.vault.user("Email/CoServ bill.md", "Amount: $837.00");
		A.vault.user("Email/Inbox/Amazon order.md", "Order 111-8099753");
		A.vault.user("Personal/journal.md", "a plain note");
		await A.sync();

		// THE ONE THAT MATTERS: files inside the protected folder are ciphertext
		// on the server, including nested ones; everything outside stays plain.
		const bill = srv.files.get("/simvault/email/coserv bill.md");
		ok(!!bill && looksEncrypted(bill.bytes), "a file in the protected folder is ciphertext on the server");
		const nested = srv.files.get("/simvault/email/inbox/amazon order.md");
		ok(!!nested && looksEncrypted(nested.bytes), "a nested file in the protected folder is also ciphertext");
		const journal = srv.files.get("/simvault/personal/journal.md");
		ok(!!journal && !looksEncrypted(journal.bytes), "a file outside the protected folder stays plaintext");

		// a device WITH the passphrase reconstructs the folder in plaintext locally
		const B = new SimDevice("B", srv, { e2ePassphrase: "pp" }, 1_800_500_000_000);
		await B.sync();
		eq(B.vault.text("Email/CoServ bill.md"), "Amount: $837.00", "with the passphrase the protected folder arrives intact");
		eq(B.vault.text("Personal/journal.md"), "a plain note", "and the plain folder too");

		// a device WITHOUT the passphrase gets the plain remainder but not the folder
		const C = new SimDevice("C", srv, {}, 1_800_900_000_000);
		const rc = await C.sync();
		ok(!rc.blocked, "a passphrase-less device is not blocked by a protected folder");
		eq(C.vault.text("Personal/journal.md"), "a plain note", "it still receives the plain folder");
		eq(C.vault.text("Email/CoServ bill.md"), null, "but the protected folder is held back, not corrupted");

		// and it must never upload plaintext over the ciphertext it cannot read
		C.vault.user("Personal/new.md", "added on C");
		await C.sync();
		const stillCipher = srv.files.get("/simvault/email/coserv bill.md");
		ok(!!stillCipher && looksEncrypted(stillCipher.bytes), "the passphrase-less device leaves the ciphertext untouched");
		ok(srv.files.has("/simvault/personal/new.md"), "while still syncing its own plain edits");
	}

	console.log("simulation: a note moved into a protected folder is re-encrypted");
	{
		const srv = new FakeServer();
		const salt = makeSalt();
		const check = await makeCheck(await deriveKey("pp", salt));
		await srv.putFile(
			"/SimVault/.powerconnect.json",
			new TextEncoder().encode(JSON.stringify({ format: 1, e2e: false, protectedFolders: ["Email"], secrets: { salt, check } })).buffer as ArrayBuffer,
			"add",
			"2027-01-01T00:00:00Z"
		);
		const A = new SimDevice("A", srv, { e2ePassphrase: "pp" });
		A.vault.user("Drafts/receipt.md", "Total: $42.00");
		await A.sync();
		const plain = srv.files.get("/simvault/drafts/receipt.md");
		ok(!!plain && !looksEncrypted(plain.bytes), "the note starts plaintext outside the protected folder");

		// moving it into Email/ crosses the encryption boundary: the cheap rename
		// must be refused so it re-uploads as ciphertext instead
		A.rename("Drafts/receipt.md", "Email/receipt.md");
		await A.sync();
		const moved = srv.files.get("/simvault/email/receipt.md");
		ok(!!moved && looksEncrypted(moved.bytes), "after moving into the protected folder it is ciphertext");
		ok(!srv.files.has("/simvault/drafts/receipt.md"), "and the plaintext copy is gone from its old location");

		// a second device with the key sees the moved file intact
		const B = new SimDevice("B", srv, { e2ePassphrase: "pp" }, 1_800_500_000_000);
		await B.sync();
		eq(B.vault.text("Email/receipt.md"), "Total: $42.00", "the moved-and-encrypted note reconstructs on another device");
	}

	console.log("protectionZone: folder names with spaces and multiple folders");
	{
		const { protectionZone } = require("../src/core");
		const folders = ["My Email", "Bank Statements"];
		// a space in the folder name must not break the match at any depth
		eq(protectionZone("My Email/CoServ bill.md", ".obsidian", "powerconnect", folders), "folder:my email", "a top-level folder with a space matches its files");
		eq(protectionZone("My Email/Inbox/deep note.md", ".obsidian", "powerconnect", folders), "folder:my email", "and matches nested files too");
		eq(protectionZone("Bank Statements/2026.pdf", ".obsidian", "powerconnect", folders), "folder:bank statements", "a second protected folder matches independently");
		eq(protectionZone("Personal/journal.md", ".obsidian", "powerconnect", folders), "", "an unprotected folder stays plain");
		// a folder whose name is a prefix of another must not over-match
		eq(protectionZone("My Emails Archive/x.md", ".obsidian", "powerconnect", ["My Email"]), "", "a longer sibling name is not caught by a prefix");
		eq(protectionZone("My Email", ".obsidian", "powerconnect", folders), "folder:my email", "the folder note itself is in-zone");
	}

	console.log("simulation: two folders with spaces protect independently");
	{
		const srv = new FakeServer();
		const salt = makeSalt();
		const check = await makeCheck(await deriveKey("pp", salt));
		await srv.putFile(
			"/SimVault/.powerconnect.json",
			new TextEncoder().encode(JSON.stringify({ format: 1, e2e: false, protectedFolders: ["My Email", "Bank Statements"], secrets: { salt, check } })).buffer as ArrayBuffer,
			"add",
			"2027-01-01T00:00:00Z"
		);
		const A = new SimDevice("A", srv, { e2ePassphrase: "pp" });
		A.vault.user("My Email/CoServ bill.md", "Amount: $837.00");
		A.vault.user("Bank Statements/July.md", "closing balance 4210.55");
		A.vault.user("Notes/plain.md", "nothing secret");
		await A.sync();
		ok(looksEncrypted(srv.files.get("/simvault/my email/coserv bill.md")!.bytes), "the first spaced folder is ciphertext");
		ok(looksEncrypted(srv.files.get("/simvault/bank statements/july.md")!.bytes), "the second spaced folder is ciphertext");
		ok(!looksEncrypted(srv.files.get("/simvault/notes/plain.md")!.bytes), "an unprotected folder stays plaintext");

		const B = new SimDevice("B", srv, { e2ePassphrase: "pp" }, 1_800_500_000_000);
		await B.sync();
		eq(B.vault.text("My Email/CoServ bill.md"), "Amount: $837.00", "the first spaced folder reconstructs with the passphrase");
		eq(B.vault.text("Bank Statements/July.md"), "closing balance 4210.55", "the second spaced folder reconstructs too");
	}

	console.log("simulation: protecting an existing folder migrates its files");
	{
		// the real-world case: a folder has been syncing in PLAINTEXT, and the
		// user decides to protect it after the fact. Its existing files on the
		// server must be re-uploaded as ciphertext, not left readable.
		const srv = new FakeServer();
		const A = new SimDevice("A", srv, { e2ePassphrase: "pp" });
		A.vault.user("Email/bill.md", "Amount: $837.00");
		A.vault.user("Notes/keep.md", "stays plain");
		await A.sync();
		const before = srv.files.get("/simvault/email/bill.md");
		ok(!!before && !looksEncrypted(before.bytes), "the folder starts as plaintext on the server");

		// user turns protection on: write the envelope + folder list, then migrate
		const salt = makeSalt();
		const check = await makeCheck(await deriveKey("pp", salt));
		await srv.putFile(
			"/SimVault/.powerconnect.json",
			new TextEncoder().encode(JSON.stringify({ format: 1, e2e: false, protectedFolders: ["Email"], secrets: { salt, check } })).buffer as ArrayBuffer,
			"overwrite",
			"2027-06-01T00:00:00Z"
		);
		A.engine.markerDirty();
		const migrated = await A.migrateProtection(["Email"]);
		eq(migrated, 1, "exactly the one file in the protected folder is re-keyed");

		// THE ONE THAT MATTERS: what was plaintext on the server is now ciphertext
		const after = srv.files.get("/simvault/email/bill.md");
		ok(!!after && looksEncrypted(after.bytes), "the existing file is re-uploaded as ciphertext");
		const keep = srv.files.get("/simvault/notes/keep.md");
		ok(!!keep && !looksEncrypted(keep.bytes), "a file outside the folder is untouched by the migration");

		// migration is quiet on a second run and everything still converges
		await A.sync();
		const B = new SimDevice("B", srv, { e2ePassphrase: "pp" }, 1_802_000_000_000);
		await B.sync();
		eq(B.vault.text("Email/bill.md"), "Amount: $837.00", "another device reconstructs the migrated file");
		ok((await converge([A, B])) >= 0, "the fleet still converges after a migration");
		ok(!fleetDiff([A, B]), "and both devices hold identical trees");
	}

	console.log("simulation: concurrent edits merge");
	{
		const srv = new FakeServer();
		const A = new SimDevice("A", srv);
		const B = new SimDevice("B", srv, {}, 1_800_500_000_000);
		A.vault.user("note.md", "title\n\nline one");
		await A.sync();
		await B.sync();
		A.vault.user("note.md", "title\n\nline one\nfrom A");
		await A.sync();
		B.vault.user("note.md", "title\n\nline one\nfrom B");
		await B.sync();
		eq(B.vault.text("note.md"), "title\n\nline one\nfrom A\nfrom B", "concurrent appends merge in edit order");
		await A.sync();
		eq(A.vault.text("note.md"), "title\n\nline one\nfrom A\nfrom B", "the merge converges on the first device");
		eq([...B.vault.files.keys()].filter((k) => k.includes("conflict")).length, 0, "no conflict copies for merged edits");

		A.vault.user("note.md", "title\n\nline CHANGED by A\nfrom A\nfrom B");
		await A.sync();
		B.vault.user("note.md", "title\n\nline CHANGED by B\nfrom A\nfrom B");
		await B.sync();
		await converge([A, B], 6);
		ok([...A.vault.files.keys()].some((k) => k.includes("conflict")), "colliding edits still keep both copies");
		eq(fleetDiff([A, B]), null, "collision fallback converges the fleet");
	}

	console.log("simulation: merge under encryption");
	{
		const srv = new FakeServer();
		const A = new SimDevice("A", srv, { e2eEnabled: true, e2ePassphrase: "sim pass" });
		const B = new SimDevice("B", srv, { e2ePassphrase: "sim pass" }, 1_800_500_000_000);
		A.vault.user("enc.md", "one\ntwo\nthree");
		await A.sync();
		await B.sync();
		A.vault.user("enc.md", "ONE\ntwo\nthree");
		await A.sync();
		B.vault.user("enc.md", "one\ntwo\nTHREE");
		await B.sync();
		await A.sync();
		eq(A.vault.text("enc.md"), "ONE\ntwo\nTHREE", "edits merge through the encrypted base revision");
		eq(fleetDiff([A, B]), null, "encrypted merge converges");
	}

	console.log("simulation: backgrounding fast flush");
	{
		const srv = new FakeServer();
		const A = new SimDevice("A", srv);
		const B = new SimDevice("B", srv, {}, 1_800_500_000_000);
		A.vault.user("note.md", "first");
		await A.sync();
		await B.sync();
		A.vault.user("note.md", "first\nedited on the way out");
		const flushed = await A.engine.flushPaths(["note.md"]);
		eq(flushed, ["note.md"], "a dirty file flushes without a full sync");
		await B.sync();
		eq(B.vault.text("note.md"), "first\nedited on the way out", "the flushed edit reaches the other device");
		B.vault.user("note.md", "B side");
		await B.sync();
		A.vault.user("note.md", "A side");
		const deferred = await A.engine.flushPaths(["note.md"]);
		eq(deferred, [], "a flush against a moved remote defers instead of clobbering");
	}

	console.log("simulation: a joining device's fresh config loses to the vault's");
	{
		const srv = new FakeServer();
		const A = new SimDevice("A", srv, {}, 1_800_000_000_000);
		A.vault.user(".obsidian/community-plugins.json", '["powerexplorer","powerconnect"]');
		A.vault.user("welcome.md", "the vault's welcome");
		await A.sync();
		// THE NEW-LAPTOP INCIDENT: plugins installed by hand wrote fresh config
		// minutes ago, so every local file is NEWER than the fleet's. Joining
		// must hand config to the vault anyway, and keep the newborn file as
		// the conflict copy rather than silently discarding it.
		const B = new SimDevice("B", srv, {}, 1_800_900_000_000);
		B.vault.user(".obsidian/community-plugins.json", "[]");
		B.vault.user("welcome.md", "fresh install welcome");
		const rb = await B.sync();
		eq(rb.stats.conflicts, 2, "the join sees both conflicts");
		await converge([A, B]);
		eq(B.vault.text(".obsidian/community-plugins.json"), '["powerexplorer","powerconnect"]', "the vault's config keeps the name on the joiner");
		eq(A.vault.text(".obsidian/community-plugins.json"), '["powerexplorer","powerconnect"]', "the fleet never regressed");
		ok([...B.vault.files.keys()].some((k) => k.includes("sync conflict") && k.includes(".obsidian")), "the newborn config survives as a conflict copy");
		eq(B.vault.text("welcome.md"), "fresh install welcome", "notes are not config: the newer note still wins the name");
		ok(contentSurvives(B, "the vault's welcome"), "and the vault's note survives beside it");
	}

	console.log("simulation: settings merge even with no common ancestor");
	{
		// A device whose journal was lost re-joins with no base rev for ANY file,
		// so every settings conflict in that pass used to take keep-both: two
		// half-true data.json files, one named "(sync conflict ...)" and read by
		// nothing. That is how one pass produced ~14 conflict copies on
		// 2026-07-29, five of them plugin settings.
		//
		// Text still needs an ancestor (no way to tell an addition from a
		// deletion without one), but a key-value file does not: merging against an
		// empty base keeps the union of both sides' keys.
		const srv = new FakeServer();
		const A = new SimDevice("A", srv, { syncConfig: true, syncPluginData: true }, 1_800_000_000_000);
		const B = new SimDevice("B", srv, { syncConfig: true, syncPluginData: true }, 1_800_900_000_000);
		// this plugin's OWN data.json, which syncs without an encryption envelope
		// (it holds no credentials); another plugin's would be held back here and
		// never reach a conflict at all
		const F = ".obsidian/plugins/powerconnect/data.json";
		// each device arranges a DIFFERENT folder, and neither has ever synced,
		// so there is no shared history to merge against
		A.vault.user(F, JSON.stringify({ layout: "onenote", orders: { Apple: ["a.md", "b.md"] } }));
		await A.sync();
		B.vault.user(F, JSON.stringify({ layout: "onenote", orders: { Acme: ["x.md", "y.md"] } }));
		const rb = await B.sync();
		eq(rb.stats.merged, 1, "the settings file merged instead of keeping both");
		ok(![...B.vault.files.keys()].some((k) => k.includes("sync conflict")), "no conflict copy was written");
		await converge([A, B]);
		const merged = JSON.parse(B.vault.text(F) ?? "{}") as { orders: Record<string, string[]> };
		eq(merged.orders["Apple"], ["a.md", "b.md"], "A's arrangement survived with no ancestor");
		eq(merged.orders["Acme"], ["x.md", "y.md"], "and so did B's");
		eq(B.vault.text(F), A.vault.text(F), "both devices agree on the result");

		// a NOTE with no ancestor still keeps both: without a base there is no way
		// to tell an addition from a deletion, and guessing loses words
		const srv2 = new FakeServer();
		const C = new SimDevice("C", srv2, {}, 1_800_000_000_000);
		const D = new SimDevice("D", srv2, {}, 1_800_900_000_000);
		C.vault.user("note.md", "C's paragraph");
		await C.sync();
		D.vault.user("note.md", "D's different paragraph");
		await D.sync();
		await converge([C, D]);
		ok(contentSurvives(D, "C's paragraph"), "C's words survive");
		ok(contentSurvives(D, "D's different paragraph"), "and D's do too");
		ok([...D.vault.files.keys()].some((k) => k.includes("sync conflict")), "a note with no ancestor still keeps both copies");
	}

	console.log("simulation: a short read never resolves a conflict");
	{
		// THE TRUNCATED RECORDING: a download that ends early still carries
		// metadata describing the whole file, so a short body is
		// indistinguishable from success. doDownload has always checked the
		// bytes against that checksum; the conflict path did not, and wrote
		// them over the copy the user actually had, how two of Steve's
		// recordings came to be 8 MiB and 52 MiB prefixes of themselves.
		const srv = new FakeServer();
		const A = new SimDevice("A", srv, {}, 1_800_000_000_000);
		A.vault.user("rec.md", "the whole recording, every word of it");
		await A.sync();
		const B = new SimDevice("B", srv, {}, 1_800_500_000_000);
		await B.sync();
		// both edit it, so the next sync on B is a conflict, and B's copy is
		// the newer one: under "keep both" the remote lands as the conflict copy
		A.vault.user("rec.md", "A's whole version, every word of it");
		await A.sync();
		B.vault.user("rec.md", "B's whole version, every word of it");

		srv.truncateNextRead("/SimVault/rec.md", 6);
		const bad = await B.sync();
		eq(bad.stats.conflicts, 0, "a conflict is not resolved against bytes that failed their checksum");
		eq(bad.stats.skipped, 1, "it is skipped instead");
		eq(B.vault.text("rec.md"), "B's whole version, every word of it", "and the local file is left exactly as it was");
		ok(
			![...B.vault.files.keys()].some((k) => k.includes("sync conflict")),
			"no conflict copy is written from a half-read file"
		);

		// the server is healthy again: the next run resolves it properly and
		// neither side's words are lost
		await converge([A, B]);
		ok(contentSurvives(B, "A's whole version, every word of it"), "A's words survive the retry");
		ok(contentSurvives(B, "B's whole version, every word of it"), "and so do B's");
		ok([...B.vault.files.keys()].some((k) => k.includes("sync conflict")), "the retry keeps both, as it always would have");
	}

	console.log("simulation: a short upload never becomes the truth");
	{
		// THE 2026-07-29 INCIDENT, from the direction that eats data. A short
		// DOWNLOAD can be re-fetched; a short UPLOAD puts a stump on the remote,
		// and because the stump's size matches its own metadata no download check
		// can object. Worse, declining to record it is not enough: the stump is a
		// real remote file with no base entry, so the next run calls it a conflict
		// and it can win outright. Field evidence: recordings on Dropbox at
		// exactly 8.000 and 52.000 MiB, disk and remote agreeing, journal calling
		// it a clean sync. So the engine repairs it in the same run.
		const path = "_resources/audio/recording.webm";
		const remote = "/simvault/" + path;
		const whole = "W".repeat(4000);

		// transient: one short commit, repaired before the run ends
		const srv = new FakeServer();
		const A = new SimDevice("A", srv, {}, 1_800_000_000_000);
		A.vault.user(path, whole);
		srv.truncateNextWrite(remote, 1000);
		const r1 = await A.sync();
		ok(A.logs.some((l) => l.includes("landed short")), "the short write was noticed, so the fault really did fire");
		eq(r1.stats.errors.length, 0, "and was repaired, not reported as a failure");
		eq(r1.stats.up, 1, "counted as one upload, once it actually landed");
		const after = srv.files.get(remote);
		eq(after ? after.bytes.byteLength : -1, 4000, "the remote holds the WHOLE file by the end of the run");
		eq(A.vault.text(path), whole, "the local file was never touched");
		ok(A.engine.baseMap.has(path), "and only the whole file was recorded as synced");

		// a second device must never meet the stump
		const B = new SimDevice("B", srv, {}, 1_800_900_000_000);
		await B.sync();
		eq(B.vault.text(path), whole, "the joining device gets the complete recording");
		ok(![...B.vault.files.keys()].some((k) => k.includes("sync conflict")), "no conflict copy was manufactured");

		// persistent: the repair lands short too, so NOTHING may be recorded
		const srv2 = new FakeServer();
		const C = new SimDevice("C", srv2, {}, 1_800_000_000_000);
		C.vault.user(path, whole);
		srv2.truncateNextWrites(remote, 1000, 2);
		const rc = await C.sync();
		ok(rc.stats.errors.length > 0, "a persistent short write is reported loudly");
		eq(rc.stats.up, 0, "nothing counted as uploaded");
		ok(!C.engine.baseMap.has(path), "nothing recorded, so no journal entry vouches for the stump");
		eq(C.vault.text(path), whole, "the complete file is still on disk: that is what must never be lost");
		// with the fault spent, the fleet heals and the stump loses
		await C.sync();
		const healed = srv2.files.get(remote);
		eq(healed ? healed.bytes.byteLength : -1, 4000, "the next pass replaces the stump with the whole file");
		eq(C.vault.text(path), whole, "and the local file survived the round trip");
	}

	console.log("simulation: a joining device's plugins arrive before its notes");
	{
		const srv = new FakeServer();
		const A = new SimDevice("A", srv, { syncConfig: true }, 1_800_000_000_000);
		for (let i = 0; i < 40; i++) A.vault.user(`Notes/note-${i}.md`, `note ${i}`);
		A.vault.user(".obsidian/app.json", '{"promptDelete":false}');
		A.vault.user(".obsidian/community-plugins.json", '["powerexplorer"]');
		A.vault.user(".obsidian/plugins/powerexplorer/main.js", "/* the plugin */");
		A.vault.user(".obsidian/plugins/powerexplorer/manifest.json", '{"id":"powerexplorer","version":"1.22.1"}');
		A.vault.user(".obsidian/plugins/powerexplorer/data.json", '{"layout":"drill"}');
		await A.sync();

		const B = new SimDevice("B", srv, { syncConfig: true, syncPluginData: true }, 1_800_900_000_000);
		await B.sync();
		const arrived = B.logs.filter((l) => l.startsWith("info: Downloaded: ")).map((l) => l.slice("info: Downloaded: ".length));
		const at = (p: string) => arrived.indexOf(p);
		ok(arrived.length > 40, "the whole vault came down in one pass");
		ok(at(".obsidian/plugins/powerexplorer/main.js") >= 0, "the plugin's code arrived");
		ok(at(".obsidian/plugins/powerexplorer/main.js") < at("Notes/note-0.md"), "plugin code beat the first note");
		ok(at(".obsidian/plugins/powerexplorer/manifest.json") < at("Notes/note-0.md"), "so did its manifest");
		// the ordering that matters most: Obsidian must not meet an enabled-list
		// naming a plugin whose code is not on disk yet
		ok(at(".obsidian/plugins/powerexplorer/main.js") < at(".obsidian/community-plugins.json"), "code lands before the list that enables it");
		ok(at(".obsidian/plugins/powerexplorer/data.json") < at(".obsidian/app.json"), "plugin settings precede the rest of the config folder");
		ok(at(".obsidian/app.json") < at("Notes/note-0.md"), "and all of the config folder precedes the notes");
		eq(B.vault.text(".obsidian/plugins/powerexplorer/main.js"), "/* the plugin */", "the plugin is intact, not merely early");
		eq(B.vault.text("Notes/note-39.md"), "note 39", "and the notes still all landed");
	}

	console.log("simulation: a stale device's touch merges with weeks of settings changes");
	{
		const srv = new FakeServer();
		const A = new SimDevice("A", srv, {}, 1_800_000_000_000);
		const B = new SimDevice("B", srv, {}, 1_800_500_000_000); // B's clock is later: B would win an mtime contest
		A.vault.user(".obsidian/plugins/powerconnect/data.json", '{"layout":"onenote","recent":["old.md"]}');
		await converge([A, B]);
		// two weeks pass: A reshapes settings; B, off the whole time, boots
		// and touches only its recents seconds before its first sync
		A.vault.user(".obsidian/plugins/powerconnect/data.json", '{"layout":"drill","recent":["old.md"],"colors":{"A":"#f00"}}');
		await A.sync();
		B.vault.user(".obsidian/plugins/powerconnect/data.json", '{"layout":"onenote","recent":["tapped.md"]}');
		const rb = await B.sync();
		eq(rb.stats.merged, 1, "the settings conflict merged instead of keeping both");
		await converge([A, B]);
		// keys come out sorted: a merge has to produce the same bytes on both
		// devices, and each side's own key order cannot decide the result
		eq(
			JSON.parse(B.vault.text(".obsidian/plugins/powerconnect/data.json") ?? "{}"),
			{ colors: { A: "#f00" }, layout: "drill", recent: ["tapped.md"] },
			"the fleet's changes and the stale touch both landed"
		);
		eq(A.vault.text(".obsidian/plugins/powerconnect/data.json"), B.vault.text(".obsidian/plugins/powerconnect/data.json"), "devices agree on the merged file");
		ok(![...B.vault.files.keys()].some((k) => k.includes("sync conflict")), "no conflict copies were made");
	}

	console.log("simulation: an older plugin build never overwrites a newer one");
	{
		const srv = new FakeServer();
		const A = new SimDevice("A", srv, {}, 1_800_000_000_000);
		const B = new SimDevice("B", srv, {}, 1_800_500_000_000); // B's clock is later: B would win every mtime contest
		const mf = (v: string) => `{"id":"powerexplorer","version":"${v}"}`;
		const dir = ".obsidian/plugins/powerexplorer";
		A.vault.user(`${dir}/manifest.json`, mf("1.21.0"));
		A.vault.user(`${dir}/main.js`, "var build = '1.21.0';\nvar shared = 1;\n");
		await converge([A, B]);
		// A ships 1.22.0. B, whose clock runs later, then installs an OLD
		// 1.21.5 build by hand (a stale checkout deployed, or BRAT reinstalling
		// an earlier release): B's files are newer by every clock, older by
		// version. Version must win.
		A.vault.user(`${dir}/manifest.json`, mf("1.22.0"));
		A.vault.user(`${dir}/main.js`, "var build = '1.22.0';\nvar shared = 1;\nvar feature = 'new';\n");
		await A.sync();
		B.vault.user(`${dir}/manifest.json`, mf("1.21.5"));
		B.vault.user(`${dir}/main.js`, "var build = '1.21.5';\nvar shared = 1;\nvar old = 'stale';\n");
		await B.sync();
		await converge([A, B]);
		eq(B.vault.text(`${dir}/manifest.json`), mf("1.22.0"), "the newer build won on the downgrading device");
		eq(A.vault.text(`${dir}/manifest.json`), mf("1.22.0"), "and the fleet was never downgraded");
		eq(B.vault.text(`${dir}/main.js`), "var build = '1.22.0';\nvar shared = 1;\nvar feature = 'new';\n", "main.js is exactly the newer build");
		ok(!(B.vault.text(`${dir}/main.js`) ?? "").includes("stale"), "no trace of the older build survived in the bundle");
		ok(!(A.vault.text(`${dir}/main.js`) ?? "").includes("stale"), "and none reached the fleet");
		ok(![...B.vault.files.keys()].some((k) => k.includes("sync conflict")), "a rebuildable artifact leaves no conflict litter");
		eq(fleetDiff([A, B]), null, "fleets identical");
	}

	console.log("simulation: two builds never line-merge into a bundle that never existed");
	{
		const srv = new FakeServer();
		const A = new SimDevice("A", srv, {}, 1_800_000_000_000);
		const B = new SimDevice("B", srv, {}, 1_800_500_000_000);
		const dir = ".obsidian/plugins/powerexplorer";
		// a bundle whose two ends are far apart: exactly the disjoint-hunks
		// shape the line merger happily splices together
		const bundle = (tag: string, head: string, tail: string) => `var build = '${tag}';\n${head}\n` + "var filler = 0;\n".repeat(20) + `${tail}\n`;
		A.vault.user(`${dir}/manifest.json`, '{"id":"powerexplorer","version":"1.0.0"}');
		A.vault.user(`${dir}/main.js`, bundle("1.0.0", "var head = 'base';", "var tail = 'base';"));
		await converge([A, B]);
		// same version on both sides (a dev rebuild), different bytes at
		// opposite ends: the version rule has no opinion, so this is the case
		// that must still refuse to merge
		A.vault.user(`${dir}/main.js`, bundle("1.0.0", "var head = 'from A';", "var tail = 'base';"));
		await A.sync();
		B.vault.user(`${dir}/main.js`, bundle("1.0.0", "var head = 'base';", "var tail = 'from B';"));
		const rb = await B.sync();
		eq(rb.stats.merged, 0, "no merge was attempted on a build artifact");
		await converge([A, B]);
		const winner = B.vault.text(`${dir}/main.js`) ?? "";
		ok(!(winner.includes("from A") && winner.includes("from B")), "no hybrid bundle was ever written");
		eq(fleetDiff([A, B]), null, "fleets identical");
	}

	console.log("simulation: randomized fuzz, three devices");
	{
		for (const seed of [7, 1234, 987654]) {
			const rnd = mulberry32(seed);
			const srv = new FakeServer();
			const devices = [new SimDevice("A", srv, {}, 1_800_000_000_000), new SimDevice("B", srv, {}, 1_800_500_000_000), new SimDevice("C", srv, {}, 1_801_000_000_000)];
			const paths = ["a.md", "b.md", "sub/c.md", "sub/deep/d.md", "e.md"];
			for (let round = 0; round < 6; round++) {
				const opCount = 1 + Math.floor(rnd() * 4);
				for (let i = 0; i < opCount; i++) {
					const d = devices[Math.floor(rnd() * devices.length)];
					const p = paths[Math.floor(rnd() * paths.length)];
					const dice = rnd();
					if (dice < 0.55) d.vault.user(p, `w${seed}-${round}-${i} on ${d.name}`);
					else if (dice < 0.7 && d.vault.text(p) != null) d.vault.userDelete(p);
					else if (dice < 0.85 && d.vault.text(p) != null && d.vault.text(`moved-${p.replace("/", "-")}`) == null) d.rename(p, `moved-${p.replace("/", "-")}`);
					else d.vault.user(p, `w${seed}-${round}-${i} again on ${d.name}`);
				}
				const who = devices[Math.floor(rnd() * devices.length)];
				await who.sync();
			}
			const rounds = await converge(devices, 12);
			eq(rounds > 0, true, `fuzz seed ${seed} settles (rounds=${rounds})`);
			const diff = fleetDiff(devices);
			eq(diff, null, `fuzz seed ${seed} fleets identical${diff ? ` (${diff})` : ""}`);
		}
	}
}

void main().catch((e) => {
	console.error("FAIL - harness crashed:", e);
	process.exit(1);
});

// --- the deploy guard ---
// Two sessions building this plugin at once is enough for the second to
// overwrite the first with an older build, silently. The comparison is where a
// bug would disable the guard without failing anything, so it is pinned here.
{
	const { compareVersions, isDowngrade, versionFromManifest } = require("../deploy-guard.mjs");

	eq(compareVersions("1.89.1", "1.89.0") > 0, true, "a later patch sorts after");
	eq(compareVersions("1.89.0", "1.89.1") < 0, true, "and an earlier one before");
	eq(compareVersions("1.89.1", "1.89.1"), 0, "the same version ties");
	// the whole reason this compares numbers: as strings, "1.9.0" sorts after
	// "1.10.0", which is exactly backwards
	eq(compareVersions("1.10.0", "1.9.0") > 0, true, "10 is a later minor than 9, not an earlier one");
	eq(compareVersions("1.88.10", "1.88.9") > 0, true, "and the same holds for the patch");
	eq(compareVersions("2.0.0", "1.99.99") > 0, true, "a major bump outranks everything under it");
	eq(compareVersions("1.89", "1.89.0"), 0, "a missing part counts as zero");
	eq(compareVersions("", ""), 0, "two unreadable versions tie rather than throwing");

	eq(isDowngrade("1.89.1", "1.88.1"), true, "deploying an older build over a newer one is the collision this catches");
	eq(isDowngrade("1.88.1", "1.89.1"), false, "the ordinary direction is not");
	eq(isDowngrade("1.89.1", "1.89.1"), false, "and neither is redeploying the same version, which is what developing looks like");
	eq(isDowngrade(null, "1.89.1"), false, "a vault with nothing installed has nothing to lose");
	eq(isDowngrade("", "1.89.1"), false, "nor one whose version could not be read");

	eq(versionFromManifest("{ not json"), null, "a manifest too broken to parse names no version");
	eq(versionFromManifest("{}"), null, "and neither does one with no version key");
	eq(versionFromManifest('{"version":"1.2.3"}'), "1.2.3", "otherwise the version is read off it");
	eq(versionFromManifest('{"version":"  "}'), null, "a blank version is no version");
}
