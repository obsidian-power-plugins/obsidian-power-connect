# Power Connect

Sync your vault using storage you already pay for: Dropbox, OneDrive, or Google Drive. Works on Windows, macOS, Linux, iPhone, iPad, and Android. No sync subscription, no size tier to outgrow, and no third-party server in the middle.

Your notes go straight from Obsidian to your own storage and nowhere else. You can also encrypt everything so the provider itself cannot read a word.

## How it works

Your vault lives in one folder in your own cloud storage, in an app you create under your own account. Power Connect can only see that folder, never the rest of your files.

Each device keeps a private record of what both sides last agreed on, so a sync only moves what actually changed. Clock differences between machines never matter, renames are a cheap move rather than a re-upload, and an edit on one side always beats a delete on the other: the edited file is restored, never silently dropped.

## Providers

- **Dropbox**: the most proven path. Sign in by pasting a code, on every platform. Changes from another device land within seconds.
- **OneDrive**: sign in with a short code entered at Microsoft's page, from any browser. Changes arrive on a schedule rather than instantly, and conflicting edits keep both copies.
- **Google Drive (beta)**: sign-in needs a desktop for now. This is the newest code here, so treat it as a beta and keep the delete guard on.

All three use the same engine, the same encryption choices, and the same setup.

## Setup, about three minutes

Enable the plugin and a wizard opens. It walks you through picking your storage, creating your own app and signing in, naming the folder for this vault, and choosing how private you want it. Then it previews the first sync so you can see the exact plan before anything moves.

**Privacy is chosen once, up front,** with three levels:

- Everything encrypted end to end.
- **Only plugin settings protected (recommended).** Those files routinely hold API keys, while your notes stay readable in your storage.
- Off.

### Adding more devices

Set up the first computer, then press **Add another device** for a setup code. On each new device, install Obsidian and Power Connect, paste the code, sign in, and let it run. Files that already match pair up by content with nothing re-transferred.

That manual install is the only one a device ever needs. After that the fleet maintains itself: update Power Connect or change a setting on one device and sync carries it to the rest.

### On iPhone and iPad

Everything works, including sign-in. iOS does not let plugins run in the background, so Power Connect syncs while Obsidian is open: on launch, the moment you return to the app, on a schedule, and after your edits settle. Reopening the app catches up within a second or two.

## When sync happens

On start, the moment Obsidian comes back into view, after your edits settle, on a schedule, and on demand from the ribbon, command palette, or status bar. On desktop there is also a live connection, so another device's upload lands here within seconds.

## Choosing what syncs

- **Exclude patterns**, one per line, the same style as `.gitignore`. Newly excluded files are left alone on both sides, never deleted.
- **Device-only excludes** keep a lean phone against a full desktop.
- **Skip files larger than N MB.** Lowering the cap never deletes anything already synced.
- **Sync Obsidian settings** (on by default) carries themes, snippets, and your plugins, which is how a plugin update on one device reaches the rest. Workspace layouts stay per device.

Plugin settings files often hold API keys, so they only travel encrypted. Without encryption or plugin settings protection they are held back, and the log says so.

## Conflicts

If the same file changed in two places, nothing is ever lost.

- **Automatic merge** (default): edits that touch different lines combine into one file.
- **Keep both**: the newer edit keeps the name, the older lands beside it with the date in its name. Two devices resolving the same conflict independently end up with the same two files, rather than breeding copies of copies.
- **Prefer this device** or **Prefer the cloud**: one side always wins.
- **Ask each time**: manual syncs show a chooser, background syncs quietly keep both.

Identical edits are recognized by content and never conflict at all.

## Safety

- **Dry-run preview**: every upload, download, move, and delete, before anything happens.
- **Delete guard**: if one sync wants to delete a large share of your vault, deletions pause for you to review. A wiped cloud folder can never silently empty your vault.
- **Trash, not oblivion**: deletions go to the system trash, and your provider keeps its own version history.
- **Typing during a sync is safe.** Uploads read the file at send time, and downloads step aside if you edited it while the sync ran.
- **Crash-safe**: a crash costs a re-check, not your notes.

## Encryption

**Plugin settings protection** encrypts just the settings files that hold API keys, and can be turned on against a folder that already has files in it. Losing that passphrase costs re-entering some plugin settings, not your notes.

**Full end-to-end encryption** encrypts every file on your device before upload (AES-256-GCM, key from your passphrase). File names stay readable, contents do not. The passphrase never leaves your devices, and losing it makes the cloud copy permanently unreadable, so keep it somewhere safe. It is chosen while the folder is still empty, because mixing plain and encrypted files in one tree is how sync tools corrupt vaults.

## Good to know

- Obsidian must be running for sync to happen. There is no background service.
- If you also run Obsidian Sync, iCloud, or OneDrive on the same vault, turn file syncing off in one of them. Two syncers writing the same files invites duplicate conflict copies. Running both during a move is fine, and is how the plugin reaches your other devices in the first place.
- Empty folders do not sync, since files define the tree.
- `Note.md` and `note.md` are treated as the same file, because your storage and your operating system treat them that way.

## How it is tested

The sync engine is a standalone module with no Obsidian inside, so the tests can run it hard. Unit tests cover every decision the planner can make. A simulation suite then runs the real engine as a fleet of simulated devices against an in-memory cloud, including divergent edits, edit-versus-delete races, mass deletions, crashes injected at every stage, encryption across devices, and randomized fuzzing. Every scenario asserts that all devices end up identical and that no edit was lost.

Around 260 assertions run on every build and in CI before any release.

## Privacy and network use

Power Connect talks only to the storage provider you connect, through an app you register under your own account. No telemetry, no analytics, no third-party server.

- **Dropbox**: `api.dropboxapi.com`, `content.dropboxapi.com`, `notify.dropboxapi.com`, and `www.dropbox.com` for sign-in.
- **OneDrive**: `login.microsoftonline.com` for sign-in and `graph.microsoft.com` for files.
- **Google Drive**: `accounts.google.com` and `oauth2.googleapis.com` for sign-in, `www.googleapis.com` for files, and a short-lived loopback listener on `127.0.0.1` to catch the sign-in redirect.

**Credentials never sync.** Tokens, the connected account's email, and the encryption passphrase live in per-device storage and are stripped out of `data.json` before it is written. A settings file that travels to another device carries no sign-in with it.

### What the catalog's scan reports

The community catalog scans a plugin for what it is *capable* of, which is not the same as what it does with it. Power Connect reports three things.

| What the scan reports | What it is | Where |
| --- | --- | --- |
| **Vault enumeration** | Listing your files with sizes and modification times, which is the whole of how a sync plugin decides what changed. Nothing reads a file's *contents* because it appeared in that list; a file is opened only when it is actually being uploaded. | [`src/main.ts`](src/main.ts), the manifest and share builders |
| **Clipboard access** | **Writing:** four **Copy** buttons, for the pairing, invite, request, and recovery codes. **Reading:** three **Paste** buttons beside the fields those codes go into. All seven are a button you just pressed. | [`src/main.ts`](src/main.ts), the setup and pairing panels |
| **Local network listener** | Google Drive sign-in only. OAuth for a desktop app returns its result to a loopback address, so a server binds to `127.0.0.1` on an ephemeral port, catches the one redirect, and closes. Bound to loopback rather than every interface, so nothing outside your machine can reach it, and a five-minute timer closes it either way. Dropbox and OneDrive never use it. | [`src/gdrive.ts`](src/gdrive.ts) `gdriveSignIn` |

Two `fetch` calls appear in the built `main.js` alongside the plugin's `requestUrl` ones. Both are the mobile branch of a single request helper, going to the same endpoints listed above. There is no `eval`, no `Function` constructor, no `innerHTML`, no code fetched and run at runtime, and no processes started.

With end-to-end encryption on, file **contents** are encrypted before upload, so the provider stores bytes it cannot read. File and folder **names are not encrypted**: your vault's structure is still visible, and only what is inside each file is hidden.

## More Power Plugins

Each one works on its own, and they fit together when you have more than one.

- **[Power Assistant](https://github.com/obsidian-power-plugins/obsidian-power-assistant)**: record and summarize meetings, capture anything from a link, and ask your notes questions.
- **[Power Bases](https://github.com/obsidian-power-plugins/obsidian-power-bases)**: board, calendar, timeline, chart, and gallery views for Bases.
- **[Power Desk](https://github.com/obsidian-power-plugins/obsidian-power-desk)**: your calendars and your mail, inside your vault.
- **[Power Editor](https://github.com/obsidian-power-plugins/obsidian-power-editor)**: a formatting toolbar, drag-and-drop blocks, and WYSIWYG editing.
- **[Power Explorer](https://github.com/obsidian-power-plugins/obsidian-power-explorer)**: arrange files by hand, and search a huge vault instantly.
- **[Power Extract](https://github.com/obsidian-power-plugins/power-extract)**: reads the text inside images so you can search it.
- **[Power Tables](https://github.com/obsidian-power-plugins/obsidian-power-tables)**: colors, live formulas, and sorting for Markdown tables.

## License

MIT

## Support

Power Connect is built and maintained by one person. If it earns a place in your daily vault, you can [buy me a coffee](https://buymeacoffee.com/powerplugins). Nothing in the plugin is held back either way.

[![Buy me a coffee](docs/images/buy-me-a-coffee.png)](https://buymeacoffee.com/powerplugins)
