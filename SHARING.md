# Power Connect sharing — design

Sharing a folder, or a handful of notes out of one, with another person who also runs
Obsidian + Power Connect: gated by an invite, with a roster and a revoke.

Status: design only. Nothing here is implemented as of 1.10.2.

## 1. The constraint that shapes everything

Every provider today is **app-folder scoped**, on purpose:

- Dropbox: the wizard tells the user to create a Scoped-access app with **App folder**
  access and exactly four permissions — `account_info.read`, `files.metadata.read`,
  `files.content.read`, `files.content.write` (`main.ts:1721`, `main.ts:1727`).
- OneDrive: everything hangs off `/me/drive/special/approot` (`onedrive.ts:169`).
- Google Drive: the app's root "is the whole visible world, an app folder in effect"
  (`gdrive.ts:5`).
- The README sells this: "Power Connect cannot see the rest of your Dropbox even if it
  wanted to" (`README.md:9`).

Each person creates their own app under their own account. Two people therefore have
**no byte of storage they can both reach today**. Sharing is a transport problem before
it is a UI problem.

## 2. Transport

Two different things get called "access", and keeping them apart is the whole of this
section:

- **What the peer can see.** In every option below: the share, and nothing else. This is
  the provider's own folder-sharing feature — you name a folder, you add a person by
  email, they get that folder. Nobody gains a view into the rest of your account under
  any option here.
- **What the plugin can reach inside your own account, on your own machine.** This is
  the only thing that varies, and the only thing to decide.

| | Peer sees | Plugin's reach in **your own** account | Two-way |
| --- | --- | --- | --- |
| **A.** Native shared folder | the share only | whole Dropbox | yes |
| **B.** Paired one-way links | the share only | app folder + `sharing.*` | yes, two channels merged locally — *if* the scope permits it |
| **C.** ~~Shared folder relocated into the app folder~~ | — | — | **ruled out, see below** |

Two-way editing is available in both surviving options. The earlier framing of this as
"two-way versus read-only" was wrong.

### A. Native provider shared folder, via a second connection

The share lives in a normal Dropbox folder outside the app folder, e.g. `/Power Connect
Shares/<share name>/`, reached through a second, opt-in connection with Full Dropbox
access. Dropbox then does the hard parts natively:

| Requirement | Dropbox API |
| --- | --- |
| invite | `sharing/add_folder_member` (by email, `access_level` editor or viewer) |
| accept | recipient accepts in Dropbox; nothing to trust in our code |
| roster | `sharing/list_folder_members` |
| disconnect | `sharing/remove_folder_member` |

Access control is enforced by Dropbox's servers, not by our honor system.

Cost: your own copy of the plugin can see your whole Dropbox. The README promise
survives only if it is re-scoped to *the vault connection*, with the share connection a
separate, clearly labelled thing that people who never share never create.

### B. Published links

**Proven 2026-07-25**: an App-folder-scoped token *can* mint public shared links on its
own content. `sharing/create_shared_link_with_settings` on a file inside the app folder
returned `200`, with `audience: public` allowed and `can_revoke`, `can_set_expiry`,
`can_set_password` all true. The only change to the existing app is adding
`sharing.write` to the four permissions in `main.ts:1727`. Nothing gains a view of the
rest of the account.

This makes read-only sharing **zero-setup for the recipient**, which no other option
manages:

1. The owner mints one link per shared file and publishes an encrypted **manifest** at a
   stable link: share-relative path → direct URL → content hash. URLs are rewritten to
   `dl.dropboxusercontent.com` with `dl=1` (see field test 2c — the URL the API returns
   is unusable from a webview).
2. The recipient polls the manifest over plain HTTPS, downloads what changed by direct
   URL, and decrypts with the share key from the invite. No Dropbox account, no app, no
   authorization, nothing to configure.
3. Unlisted links are public to anyone holding the URL — which is exactly why content is
   encrypted under a per-share key delivered out of band. A found URL yields ciphertext.
4. Revoke: `sharing/revoke_shared_link` plus a key rotation.

Two-way through paired links (each side publishing its own outbox, each merging the
peer's) remains possible but doubles the channels and the conflict surface. The
subscribe half is untested — see field test 2.

### C. Shared folder relocated into the app folder — ruled out

Dropbox forbids this in both directions, by design. From the shared-folder FAQ, on what
produces an error: sharing an app folder, and adding a shared folder to an app folder.
App folders and shared folders are mutually exclusive containers — which is coherent,
since an app folder's whole promise is that exactly one app and one account reach it.

There is no version of this that costs nothing in permissions. Closed.

### Recommendation

**Read-only sharing on B, and ship it first.** It costs one added permission
(`sharing.write`), keeps every promise in the README intact, and asks the recipient for
nothing but an invite code. That covers "here are my project notes, follow along", which
is most of what sharing is for.

**Two-way on A, later, opt-in.** Co-editing needs someone to write back, and writing
needs authorization against the space — which means a Full Dropbox connection on both
sides. Worth it for people who want it; not worth imposing on everyone who just wants to
send a folder.

## 2.1 What each side actually needs

The recipient's own sync — Obsidian Sync, OneDrive, iCloud, Syncthing, git, nothing —
is irrelevant to how a share arrives. In the read-only design the transport is entirely
the **owner's** provider; the recipient performs an unauthenticated HTTPS fetch. A
Dropbox owner can share with a OneDrive user, or with someone who has no cloud account
at all.

| | Owner | Recipient |
| --- | --- | --- |
| Read-only | existing provider connection + `sharing.write` | **nothing** — paste invite code |
| Two-way | Full Dropbox connection | Full Dropbox connection (so: a Dropbox account) |

Two consequences:

- **Power Connect needs a subscriber-only mode.** The wizard today is built around
  signing into a provider and naming a folder (`main.ts:1377-1379`), which dead-ends a
  user who only wants to receive a share. Install, paste invite code, choose where it
  lands, never authenticate anything. This is a prerequisite for read-only sharing, not
  a nicety.
- **The recipient's own sync will replicate the received notes to their other devices**,
  which is the desired outcome — the share reaches their phone through whatever they
  already use. It stays quiet only if the pull is a genuine no-op when the local hash
  already matches the manifest, and written files carry the manifest's mtime rather than
  now. Otherwise every subscribed device rewrites identical bytes with fresh timestamps
  and their sync churns forever. Because the share is read-only and content-addressed,
  concurrent subscribers then converge instead of conflicting.

## 3. What a share is

Not a folder. A **path set**, because sharing three notes out of twenty in a folder is a
first-class case, not an edge case.

Every share has a **home folder on each side** — yours and theirs. Anything either
person creates inside their home folder joins the share; that is the "share a whole
folder" case, and it is what gives the peer's new notes somewhere to land. On top of
that, you may **attach individual notes from anywhere else in your vault**. They arrive
under the peer's home folder with their relative structure preserved, so links among
them survive: your `Meetings/2026-07-20.md` becomes their
`Shared/Steve/Meetings/2026-07-20.md`.

```
Share
  id            random, stable
  name          what the peer sees
  homePath      "Projects/Acme"          (this side's home folder)
  attached[]    explicit vault paths from elsewhere
  remoteName    the provider folder
  key           random AES-256 key, per share
  members[]     { email, access, invitedAt, acceptedAt, lastSeenAt }
```

The manifest is keyed by **share-relative path**, with the local path recorded against
it. Moving your note inside your vault updates the manifest, not the share path — so
reorganizing your vault does not churn the peer's.

Hard rules:

- `.obsidian/**` is never shareable, at any path, by any route. Shares carry vault
  content only: no plugin code, no plugin settings, no themes.
- The vault root is not shareable.
- Attachments referenced by shared notes are detected at share time and the user
  chooses to include them or accept broken links.

## 4. Invite, roster, revoke

### The problem with a key in the invite

Shipped in 1.11.x, the invite carries the share key outright. Anyone who gets hold of the
code can read the share, because with no server in the design the key *is* the
authorization. There is nothing to hold a request pending, and no way to tell one holder
of the code from another.

That is the wrong default for something whose blast radius is other people.

### The handshake: invite, request, approve

The invite stops carrying the key, and a second code comes back the other way.

1. **Invite** — `PCON-SHARE:2:...` carrying share id and index URL. No key. Useless alone.
2. **Request** — the recipient's device generates a keypair and emits
   `PCON-JOIN:1:...` carrying their public key and a display name they choose. They send
   it back however they got the invite.
3. **Approve** — the owner pastes it into the share's member list, where it appears as a
   pending request to accept or deny.
4. **Grant** — approving wraps the share's content key to that member's public key
   (ECDH P-256 to an AES-KW wrap) and publishes `keys/<memberId>.pcs`. The member polls,
   unwraps, and reads the share.

A stolen invite is then worth nothing: its holder was never approved, so no key was ever
wrapped for them, and all they can fetch is ciphertext.

Cost: one extra round trip before the first sync. That is a real dent in "the recipient
does nothing", and it is worth it. Sharing a folder of notes with a person is exactly the
operation that should ask before it opens.

**Roster** — per share: name, state (pending, approved, denied, revoked), and when each
changed. It cannot show activity. Recipients have no write access anywhere in this
design, so nothing can report back that they synced; an earlier draft of this section
claimed a per-member heartbeat, which was written while option A (a native shared folder
members could write to) was still on the table. Under published links it is impossible.

**Revoke** — one button per member: delete their wrapped key, rotate the content key,
re-wrap for everyone still approved, re-encrypt and republish. Content-addressed blobs
make that cheap, and no invite ever needs reissuing because the index link never moves.

Per-member wrapping is what makes this possible at all. With one shared key (1.11.x),
removing one person means re-keying everyone and reissuing every code by hand.

The UI still says the honest thing: revoking stops future access. It does not reach into
anyone's computer and delete what they already have, and an approved member can always
copy what they were given. What the handshake controls is who gets in, and who keeps
getting updates.

## 5. Marking shared items in the file explorer

Power Explorer already solves this without a MutationObserver or the unofficial
`fileItems` API: it injects a stylesheet keyed on the explorer's own `data-path`
attributes (`power-explorer/main.ts:1759-1764`), using `box-shadow: inset 3px 0 0 0
<color>` for a spine and `::before { content }` for a glyph. Power Connect uses the same
technique, extended from `.nav-folder-title` to `.nav-file-title`.

Four states, distinguishable at a glance and by more than colour alone:

| State | Mark |
| --- | --- |
| Shared by you | share glyph + accent spine |
| Shared with you | same glyph, second accent |
| Invite pending | glyph outlined, muted |
| Access revoked or lost | glyph struck, muted |

Rules that keep it from becoming noise:

- Mark the home folder and each attached note. Do **not** mark every descendant of a
  shared folder, and do not mark ancestors; both turn the sidebar into a barcode.
- Colours come from CSS variables in `styles.css` so themes can restyle them, and the
  whole thing is one toggle for people who want a quiet sidebar.
- Same DOM on mobile, so this costs nothing extra there.
- Power Explorer's own `.pe-page[data-path]` rows are the natural second surface. Power
  Connect should expose the share lookup so Power Explorer can mark them too, rather
  than either plugin reaching into the other.

Entry point is the file menu: right-click a note or folder → **Share** → pick an
existing share or start one. A share's panel then lists both its members and its
contents, both editable.

## 6. How it lands in the code

The engine is already the right shape. `SyncEngine` (`engine.ts:151`) takes a `VaultIO`,
a `RemoteIO`, and an `EngineHost`, and carries its own journal (cursor, rootKey, remote
map, base map). A share is **a second engine instance**:

- **VaultIO** — a path-set adapter over the existing one: filter `listVisible()` through
  the manifest, map local paths to share-relative paths on the way out and back. No
  engine change.
- **RemoteIO** — the existing `Dropbox` class pointed at the share connection's token
  and root. It already satisfies `RemoteIO` directly (`engine.ts:85`).
- **Journal** — one per share, keyed by share id, alongside the vault journal.
- **Encryption** — the share key goes where `PrepResult.key` goes today
  (`engine.ts:127`).

Two engines write the same local files, so the ordering rule matters: **a received share
is excluded from the recipient's own vault sync by default.** Their other devices get it
by subscribing to the share themselves, and the subscription rides along in synced
plugin settings, so joining on the phone is automatic. Per-device exclusions already
exist (`main.ts:2946`), and per-device secrets are already held out of synced settings —
share tokens follow that same path.

## 7. Hazards to design against

- **Dangling links.** Share 3 notes of 20 and `[[Other Note]]` points at nothing. Check
  before the first sync: "4 links and 2 attachments point outside this share — include
  them, or let them dangle?"
- **Unsharing is not deleting.** Removing a note from a share stops syncing it and
  leaves the peer's copy as an ordinary note. Deleting someone's work because you
  narrowed a selection is the wrong default.
- **A recipient editing a read-only share.** They will, because it looks like an
  ordinary note. The next pull must not silently overwrite it: compare against what was
  last written, and if it differs, keep their version as a conflict copy exactly as the
  vault sync does. Silently destroying someone's edit because the share was "read-only"
  is the worst failure this feature can have.
- **Preview before the first upload.** Exactly what will be sent, file by file. Same
  idiom as the existing dry-run.
- **Moving a share's home folder re-roots every path in it.** `Projects/Acme` becoming
  `Projects/Acme/notes` turns `notes/Deep.md` into `Deep.md`, which to a recipient is a
  withdrawal and a fresh arrival, not a move. Content does not re-upload (blobs are
  content-addressed) but the recipient's folder churns. Pinned by a test; the UI should
  warn before allowing it.
- **Double sync.** Covered in §6; the default exclusion is what stops a conflict storm.
- **Deletion blast radius.** The existing delete threshold (`main.ts:2897`) applies per
  share. A peer emptying a folder must not quietly empty yours.
- **Version-aware plugin rules do not apply.** Shares carry no plugin code, so the 1.9.0
  manifest-version logic stays out of the share path entirely.
- **Mobile.** Share traffic rides the same webview-fetch rule as everything else
  (`dropbox.ts:4-8`). Do not let a new code path reintroduce `requestUrl`.
- **Leaving a share** is one button on the peer's side too, and it leaves the notes in
  place as ordinary files.

## 8. Field tests

**1. Can a shared-folder mount live inside an app folder? — ANSWERED: no.**
Dropbox's shared-folder FAQ lists both "share an app folder" and "add a shared folder to
an app folder" as errors. Option C is closed; no empirical test needed.

**2a. Can an App-folder-scoped token mint links on its own content? — ANSWERED: yes.**
Tested 2026-07-25 against a throwaway App-folder app with `sharing.write` added.
`sharing/create_shared_link_with_settings` on a file in the app folder → `200`, public
audience allowed, revocable, expiry and password available. Read-only sharing is
unblocked. Script: `scratchpad/test-sharing-scope.sh`.

**2b. Can it *read* a link owned by another account? — still open.** Only needed for the
authenticated subscriber path and for two-way over paired links; the zero-setup
recipient path does not need it, since that fetch is unauthenticated. Same script,
probes 2 and 3, with a link to content outside the app folder.

**2c. Does an unauthenticated fetch work from the Obsidian webview? — ANSWERED: yes, on
one host only.** Tested 2026-07-25 with `Origin: app://obsidian.md` and
`capacitor://localhost`:

| Host | ACAO | Body |
| --- | --- | --- |
| `dl.dropboxusercontent.com` | `*` | raw bytes |
| `www.dropbox.com/scl/...` | *(none)* | `text/html` |

The CDN also sets `Access-Control-Expose-Headers` covering `Content-Length`,
`Accept-Ranges`, `Content-Range`, `Content-Disposition`, and `X-Dropbox-Metadata`, so
range requests work and a recipient can detect changes from response headers alone.

**Consequence for the design:** the manifest stores URLs rewritten to
`dl.dropboxusercontent.com` with `dl=1`, never the `www.dropbox.com` URL that
`create_shared_link_with_settings` returns. Using the returned URL as-is fails CORS on
mobile and downloads an HTML page on desktop.

Confirmed against a 404 at the edge, which carries Dropbox's own CORS configuration
rather than a generic error page. Worth one re-check against a live link before shipping.

**3. Does adding `sharing.*` to an existing app force every device to re-consent? —
ANSWERED 2026-07-25: no, and that cuts both ways.** The App Console states plainly that
existing access tokens are not affected by a permissions change. So nothing in the fleet
is logged out, no device is pushed back into the wizard, and a scope addition is safe to
ship.

The other half: a token keeps the scopes it was minted with. An existing refresh token
predating `sharing.write` yields access tokens that still lack it, so **any device that
wants to publish must re-authorize once**. Devices that only sync, or only receive
shares, never need to.

This shapes the rollout. Publishing must detect the missing scope and explain the
re-authorization rather than presenting it as a failure, which is what
`publishShareNow` does on any `missing_scope` error.

**4.** OneDrive equivalents: `createLink`, `/shares/{id}/driveItem`, permissions list.
Graph's app-folder scope (`Files.ReadWrite.AppFolder`) looks structurally identical to
Dropbox's, so expect the same answer and the same forced choice.

**5.** Google Drive is the weak provider — `drive.file` scope may not see a file the app
did not create. Shares may ship Dropbox-first.

## 9. Staging

**Stage 1 — subscriber-only mode. BUILT 2026-07-25, not yet released.** Power Connect
runs with no provider connection at all: install, paste an invite code, choose where the
share lands, fetch over plain HTTPS, decrypt with the share key.

Landed: `share.ts` (model, invite code, manifest envelope, pull planner, executor) with
50 assertions in `tests.ts`; `Subscription` and `subscriptions` in `PconSettings`;
per-share journals in `state.json`; the desktop/mobile fetch split; a `ReceiveShareModal`;
a Shares tab in settings; two commands; and the quiet-when-receive-only treatment of the
wizard, the status bar, and the master toggle. Received folders are auto-excluded from
the recipient's own vault sync, and un-excluded when they stop receiving.

Not yet done: nothing produces an invite code (that is stage 2), so the path is
untested against a real share. `npm run build` has deliberately not been run, so no
build artifact carries this yet.

This is the foundation, not a feature: nothing else can ship without it, because the
whole value of read-only sharing is that the recipient sets up nothing. It also happens
to be the lowest-friction way anyone will ever first encounter the plugin.

**Stage 2 — owner-side publishing. BUILT 2026-07-25, not yet released.** Share creation
from the file menu, the path-set manifest, link minting with URLs rewritten to the CDN
host, the encrypted index at a stable link, and the `PCON-SHARE` invite code.

Blobs are named by the hash of their plaintext, which buys three things at once:
identical files upload once, a note that is only moved or renamed keeps its blob *and its
link* (no re-upload, no new URL for recipients), and no note title ever appears in a
remote path. The index is written last and orphan blobs are swept after it, so a publish
that dies halfway leaves every recipient reading a coherent share.

Publishing reads the live index rather than trusting local state, so publishing from a
second device needs no handoff. Automatic republishing is gated on a signature taken from
Obsidian's in-memory file list (latest mtime plus file count, no reads), because
otherwise every interval would re-hash the whole share.

`sharing.write` is now listed in the wizard's permission steps. Existing installs will
not have it, and the failure is caught and explained rather than thrown (see field
test 3, still open).

*Stages 1 and 2 together are the first shippable release.* Stage 1 alone has nothing to
receive; stage 2 alone has nobody to receive it.

**Stage 3 — the visible surface.** File-explorer marks, the file-menu entry point, the
share panel listing members and contents, and the pre-upload preview.

**Stage 4 — the handshake, roster, and revoke.** Per-member keypairs, the
invite/request/approve exchange, the pending-request list, and revoke by key rotation.

Promoted above stage 3: it changes the invite format (v2) and removes the key from it, so
every hour spent on surface polish before it is an hour spent on a flow that is about to
change. Nothing published by 1.11.x has to survive the change, since no real share exists
yet. Ship the v1 reader anyway for anything already handed out, or accept a clean break
while the only user is the author.

**Stage 5 — two-way.** The opt-in Full Dropbox connection, reusing the existing
three-way merge and conflict copies. Only for people who want co-editing and accept a
second connection to get it.

**Stage 6 — other owner providers.** OneDrive, then Google Drive or a documented "not
supported". Low urgency: the owner's provider decides the transport and the recipient
never needs one, so shipping Dropbox-only excludes nobody from *receiving* a share.

## 10. Providers, for sharing specifically

Sharing fitness is a different axis from sync fitness. A provider needs four things
here: a narrow-scoped app can mint an anonymous link on its own content; the direct
host serves raw bytes; that host sends CORS headers the Obsidian webview accepts; and
links are revocable.

CORS probed 2026-07-25 with `Origin: app://obsidian.md` against error responses (the
config sits at the gateway, so it is good evidence but not proof of the success path):

| | Anonymous fetch host | CORS | Verdict |
| --- | --- | --- | --- |
| **Dropbox** | `dl.dropboxusercontent.com` | `*` | **Best.** Minting proven from App-folder scope; revocable, expiry, range requests, metadata header exposed |
| **OneDrive** | `api.onedrive.com/v1.0/shares/{token}/root/content` | echoes origin | **Viable, with a policy risk** |
| **Google Drive** | `googleapis.com/drive/v3/files/{id}?alt=media` | echoes origin | **Worst** |

Notes that matter more than the table:

- **OneDrive's blocker is not technical, it is administrative.** Business and school
  tenants routinely disable anonymous sharing links by policy — which would include
  Steve's own work account. Personal Microsoft accounts are fine. Any OneDrive
  implementation must detect the refusal and say so plainly rather than producing a
  link that silently fails for recipients. Also untested: whether
  `Files.ReadWrite.AppFolder` scope may call `createLink` with `scope: anonymous` at
  all.
- **Both OneDrive and Dropbox punish using the user-facing share URL.** `1drv.ms`
  returned no CORS headers, exactly like `www.dropbox.com`. Both need the API host form,
  not the URL the share dialog hands you.
- **Google Drive fails on the paths people actually use.** `drive.google.com/uc` and
  `drive.usercontent.google.com` send no CORS headers at all. The only CORS-friendly
  route is the `googleapis.com` media endpoint, which needs an embedded API key plus an
  `anyone` permission on each file, on top of `drive.file` scope narrowness, Workspace
  admin policy, and the download interstitials Google has been tightening. Documenting
  it as unsupported for sharing is a defensible answer.
