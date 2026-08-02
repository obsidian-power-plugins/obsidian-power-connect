# Power Connect

Sync your Obsidian vault with your own Dropbox. Two-way, selective, and cross-platform: Windows, macOS, Linux, iPhone, iPad, and Android, all from the storage you already pay for. No sync subscription, no third-party server, no size tier to outgrow.

Power Connect talks straight from Obsidian to Dropbox over your own Dropbox "app", so your notes never pass through anyone else's machine. It syncs deltas, pairs identical files by content instead of re-uploading them, keeps both versions when two devices edit the same note, previews any sync before it happens, and can encrypt everything end-to-end so Dropbox itself cannot read a word.

## How it works

- Your vault lives in one folder under `Apps/<your app>/` in Dropbox. The app you create has **App folder** access only: Power Connect cannot see the rest of your Dropbox even if it wanted to.
- Each device keeps a private sync journal: for every file, the last state both sides agreed on. A sync compares three things (the vault, Dropbox, and the journal) and only moves what actually changed. Local edits are detected by content hash, remote edits by Dropbox revision. Clock differences between machines never matter.
- Remote changes arrive as a delta (Dropbox cursor), so a steady-state sync is one cheap request plus whatever actually moved.
- Uploads are staged as parallel upload sessions and committed hundreds at a time in single batch calls, sidestepping Dropbox's per-commit write lock; a first upload of many small files runs at connection speed instead of request-overhead speed.
- An edit on one side beats a delete on the other: the edited file is restored, never silently dropped.
- Renames made in Obsidian become one cheap move on Dropbox instead of a re-upload.

## Providers

- **Dropbox**: the original and most proven path. Paste-a-code sign-in on every platform, batched uploads, live change push on desktop, and automatic merge via revision history.
- **OneDrive**: sign-in by device code (a short code entered at Microsoft's page, from any browser on any device). Changes arrive on the schedule and on return rather than by live push, and conflicting edits keep both copies rather than merging, for now.
- **Google Drive (beta)**: sign-in needs a desktop for now (Google requires a loopback browser flow). Automatic merge works via Drive revisions. Drive addresses files by id rather than path, so this adapter is the newest code here; treat it as a beta and keep the delete guard on.

Every provider gets the same engine, the same encryption levels, the same wizard, and the same setup codes; a setup code carries its provider, so a new device lands in the right sign-in automatically.

## Setup (about three minutes, once)

Enable the plugin and the setup wizard opens (it is also behind the status bar's `⇄ set up`, the **Set up Power Connect** command, and the button at the top of settings). It walks through, in the only order that never backfires:

1. **Storage**: Dropbox is the first supported provider. The wizard also notices when Obsidian Sync is on or the vault lives inside a cloud-synced folder, and says what to do about it.
2. **Connect**: create your own Dropbox app (guided, with the four permissions listed), paste its key, authorize in the browser, paste the code back. The app key is not a secret: sign-in uses PKCE, so the key plus your explicit browser approval is what grants access.
3. **Folder**: the folder under `Apps/` that holds this vault; every device uses the same name.
4. **Privacy**: decided here, against the folder, before the first upload. Three levels: everything end-to-end encrypted, only plugin settings files protected (recommended: they routinely hold API keys, while notes stay readable in Dropbox), or off. The wizard looks at what the folder actually holds and asks the matching question: empty folders offer every choice, an encrypted or protected folder asks for its passphrase (verified before anything is touched), and an existing plain copy can still gain plugin settings protection.
5. **Finish**: preview the first sync (the exact plan, nothing moved yet) or start it.

When a vault already has Power Connect settings (from vault-config sync, or from an earlier setup on the same machine), the wizard says so and offers two paths: sign in and use them as they are, or start over and choose everything again. Tokens and the passphrase are per-device on purpose; the shared settings travel on their own.

## Switching from Obsidian Sync (or iCloud/OneDrive)

Run both during the move; that is also how the plugin itself travels. The order that works:

1. Set up Power Connect on one device and let its first full upload finish.
2. Open Obsidian on each other device: vault-config sync delivers the plugin, and the wizard opens asking for that device's sign-in (and passphrase, if encrypted). Existing files pair up by content with no re-transfer.
3. When every device syncs through Power Connect and you trust it, turn the other system's file syncing off. An Obsidian Sync subscription can lapse after that; your remote vault there remains a frozen rollback copy while it lasts.

While both run, the occasional duplicate conflict copy can appear; annoying rather than dangerous, and it stops when one system stands down.

### Adding more devices (five computers and a phone)

Set up the first computer with the wizard, then press **Add another device** (in the wizard's last step, or Settings, Storage). It shows the steps and a setup code. On each new device:

1. Install Obsidian and open (or create) a vault; an empty vault fills itself on the first sync.
2. Install and enable Power Connect (community plugins, or the plugin folder from a GitHub release). This is the one manual install a device ever needs: a plugin cannot deliver itself to a machine that has nothing installed to receive it, which is the one thing a built-in service can do that a plugin cannot. Everything after this point is automatic.
3. The wizard opens. Paste the setup code into the app key field (it fills the key and folder), authorize Dropbox with the paste-a-code flow, and enter the passphrase if the folder is encrypted.
4. Before the first sync, the wizard adopts the vault's shared settings from the Dropbox copy (config sync, excludes, conflict policy), so the first sync behaves exactly like the first computer's. Preview it, let it run, and notes, settings, themes, and plugins arrive; identical files pair up by content with no transfer.

From then on the fleet maintains itself: change a setting or update Power Connect on one device, and sync carries it to the rest.

### iPhone and iPad

Everything works on mobile, including sign-in. Two iOS realities to know:

- iOS does not run app plugins in the background. Power Connect syncs while Obsidian is open: on launch, the moment the app returns to the foreground, on the schedule, and after edits settle. Reopening the app is the catch-up trigger, and it fires within a second or two.
- Very large first syncs are happier on Wi-Fi and with the app in the foreground.

## When sync happens

- **On start**: a few seconds after Obsidian opens.
- **On return**: the moment Obsidian comes back into view, on every platform. This is what keeps a phone feeling current.
- **Live sync (desktop)**: an idle change-notification connection to Dropbox, so another device's upload lands here within seconds. No polling; the interval schedule stays as the safety net.
- **After edits settle**: a configurable quiet period after your last change.
- **On a schedule** and **on demand** (ribbon, command palette, status bar click).

## Choosing what syncs

Settings, Selection tab:

- **Exclude patterns**, one per line, gitignore style: `Private/` skips that folder anywhere, `/Templates/` only at the vault root, `*.mp4` skips videos everywhere, `**` crosses folders, and `!pattern` re-includes. Newly excluded files are left in place on both sides, never deleted.
- **Device-only excludes**: a second list that applies only on the current device and never syncs anywhere. Keep a lean phone against a full desktop by excluding heavy folders there alone.
- **Skip files larger than N MB**: over the cap, a file neither uploads from nor downloads to the device. Lowering the cap never deletes anything that already synced.
- **Sync Obsidian settings** (on by default) also syncs `.obsidian`: themes, snippets, app settings, plugin list and code, which is how a plugin update on one device reaches the rest. Workspace layout files stay per-device. From each plugin folder only the plugin itself travels: main.js, manifest.json, styles.css, and data.json; caches, search indexes, and other derived state stay per-device. Plugin data.json files routinely keep API keys, so they travel only under an encryption envelope: a fully encrypted folder, or plugin settings protection chosen in setup. Without either they are held back, and the sync log says so. Power Connect's own settings file is the one exception; it is credential-free by design and stays readable so joining devices can adopt the shared settings.
- Power Connect's sync journal never syncs (it is per-device state), and tokens and the passphrase live outside any synced file. The plugin's code and its credential-free settings file travel like any other plugin's, so with config sync on, updating Power Connect on one device updates the others. Only a brand-new device needs a one-time manual install before it can join.

## Conflicts

If the same file changed on two devices between syncs, nothing is ever lost:

- **Automatic merge** (on by default): concurrent edits to the same text file combine into one file when they touch different lines, using the revision both edits started from as the common ancestor. Additions at the same spot land in edit order, identically on every device. Only edits that collide on the same lines fall through to the choices below, and non-text files never merge.
- **Keep both** (default): the newer edit keeps the file's name; the older one lands beside it as `Name (sync conflict 2026-07-17 1432 a1b2c3).md`. The conflict name is deterministic, so two devices resolving the same conflict independently converge on the same two files instead of breeding conflict copies of conflict copies.
- **Prefer this device** or **Prefer Dropbox**: one side always wins.
- **Ask each time**: manual syncs show a chooser per file (with "apply to all"); background syncs keep both rather than interrupting you.

Identical edits are recognized by content and never conflict at all.

## Safety

- **Dry-run preview**: the exact plan (every upload, download, move, and delete) before anything happens.
- **Delete guard**: when one sync wants to delete more than a set share of the vault (and more than 10 files), deletions pause. A manual sync shows them for review; a background sync completes everything else and leaves the deletions for you. A wiped Dropbox folder can never silently empty your vault.
- **Trash, not oblivion**: local deletions go to the system trash (or the vault's `.trash`). Dropbox keeps 30 days of version history on its side.
- **Mid-sync edits**: uploads read the file at send time, and downloads step aside if you edited the file while the sync ran. Typing during a sync is safe.
- **Crash-safe journal**: state is checkpointed during the run; a crash costs a re-check, not your notes.

## Plugin settings protection (the middle privacy level)

Most vaults hold nothing that needs encrypting except the API keys inside plugin settings files. Protection encrypts exactly those: `plugins/*/data.json` uploads as ciphertext (AES-256-GCM, key derived from a passphrase), everything else stays plain, previewable, and seedable. Unlike full encryption it can be turned on against a folder that already holds files; protected files re-upload encrypted the next time they change, and downloads tell plain from ciphertext by the bytes themselves. A device without the passphrase syncs everything else and simply holds those files back until the passphrase is entered in setup. Losing this passphrase costs re-entering plugin settings, not your notes.

## End-to-end encryption (optional)

Turn it on and every file is encrypted on-device (AES-256-GCM, key derived from your passphrase with PBKDF2) before upload. Dropbox stores only ciphertext; file names remain readable, contents do not. The passphrase never leaves your devices, a wrong passphrase fails loudly before touching anything, and losing the passphrase makes the Dropbox copy permanently unreadable, so keep it somewhere safe.

Encryption is chosen per Dropbox folder while it is still empty (mixing plain and encrypted files in one tree is how sync tools corrupt vaults). To encrypt an existing setup: change the Dropbox folder name to a fresh one, turn encryption on, and let one full upload run.

## Commands and surfaces

- **Sync now**, also the ribbon button and a click on the status bar item.
- **Preview sync (dry run)**
- **Pause or resume automatic sync**
- **Full rescan and sync**: rehashes everything, for when you suspect a file changed without its timestamp.
- **Show sync log**: what happened, file by file, with a copy button.
- Status bar: last sync time, live progress (`3/40`), and a clear signal when something needs attention.

## Good to know

- Obsidian must be running for sync to happen; there is no background daemon. On desktop the schedule makes this invisible; on iOS, opening the app is the trigger.
- Phones have no status bar, so the desktop status item does not exist there. Mobile controls: the sync icon in the left drawer, the Sync now and Show sync status commands (both addable to the mobile toolbar under Settings, Toolbar), and the buttons on the Advanced settings tab.
- If you also run another sync system (Obsidian Sync, iCloud, OneDrive) on the same vault, turn file syncing off in one of them. Two syncers writing the same files invites duplicate conflict copies.
- **Transitioning from another sync system**: running both for a while works, and it is how the plugin itself travels to your other devices. Connect Power Connect on one device first and let its first full upload finish before the others join; each additional device then pairs its files by content with no re-upload. Every device keeps its own private journal (a journal carried over by the other sync system is recognized and ignored), but two syncers racing on the same files can still produce the occasional conflict copy, which is annoying rather than dangerous. When you are ready, disable the other system's file syncing.
- Dropbox is case-insensitive, and so are Windows, macOS, and iOS defaults. Power Connect treats `Note.md` and `note.md` as the same file.
- Empty folders do not sync (files define the tree).
- File names that Windows cannot store (a colon, a trailing dot) are skipped with a log entry on Windows and synced everywhere else.
- The sync journal lives in `.obsidian/plugins/powerconnect/state.json`. Deleting it is always safe: the next sync re-merges by content.
- Power Connect's settings file (`data.json`) may travel between devices via another sync system; that is fine and how shared settings arrive. Dropbox sign-in tokens and the encryption passphrase are never in that file: they live in per-device storage, so each device signs in and enters the passphrase once, and a traveling settings file can neither leak credentials nor undo another device's sign-in.

## How it is tested

The sync engine is a standalone module with no Obsidian inside, and the test suite runs it two ways:

- **Unit tests** cover every pure decision: the full planner table (who changed, who wins, what deletes), the ignore compiler, Dropbox's content-hash algorithm against an independent implementation, the encryption format, and deterministic conflict naming.
- **A simulation suite** runs the real engine as a fleet of simulated devices against an in-memory Dropbox that mirrors the semantics that matter: revisions, delta cursors, upload and delete preconditions, cursor invalidation. Scenarios include divergent edits on multiple devices, edit-versus-delete races, mass-delete holds, folder deletions arriving as one delta entry, process crashes injected at every stage of a run, end-to-end encryption across devices, and randomized multi-device fuzzing. After every scenario the suite asserts that all devices converge to identical vaults and that no edited content was lost.

Around 260 assertions run on every build and in CI before any release is published.

## Install

Until it lands in the community store: grab `manifest.json`, `main.js`, and `styles.css` from the latest release into `<vault>/.obsidian/plugins/powerconnect/`, reload Obsidian, and enable Power Connect. BRAT works too.

## Privacy and network use

Power Connect talks only to the storage provider you connect, through an app you register under your own account. There is no telemetry, no analytics, and no third-party server: your notes go from Obsidian to your own storage and nowhere else.

Which endpoints are used depends on the provider you choose:

- **Dropbox**: `api.dropboxapi.com`, `content.dropboxapi.com`, `notify.dropboxapi.com`, and `www.dropbox.com` for sign-in.
- **OneDrive**: `login.microsoftonline.com` for sign-in and `graph.microsoft.com` for files.
- **Google Drive**: `accounts.google.com` and `oauth2.googleapis.com` for sign-in, `www.googleapis.com` for files, and a short-lived loopback listener on `127.0.0.1` to catch the sign-in redirect.

**Credentials never sync.** Access and refresh tokens, the connected account's email, and the encryption passphrase are held in Obsidian's per-device local storage, and are stripped out of `data.json` before it is written. A `data.json` that travels to another device by any means carries no sign-in with it.

With end-to-end encryption on, file **contents** are encrypted in your vault before upload (AES-256-GCM, key derived from your passphrase with PBKDF2), so the provider stores bytes it cannot read. File and folder **names are not encrypted**: your vault's structure is still visible to the provider, and only what is inside each file is hidden.

## License

MIT
