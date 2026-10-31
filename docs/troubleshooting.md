# Troubleshooting

The plugin is a bundle plus host/client modules. Some fixes need a page refresh,
some need a host restart — the difference is called out on every item below.
`$DSH_HOME` defaults to `~/.dsh` (desktop app: the app's own data directory).

## The plugin does not appear after installing

1. **Restart the host.** A `dsh.bundle` package is composed at startup; a page
   refresh cannot load it. Desktop: quit and reopen DeepSeek Harness;
   CLI: stop and start `dsh web`.
2. **Check that the bundle layer was recorded.** The profile manifest
   `$DSH_HOME/profiles/web/package.json` must list `dsh-obsidian-notes` in
   `dsh.profile.bundles` (and as a dependency). `dsh plugin --profile web add …`
   writes both.
3. **pnpm must exist.** `dsh plugin` forwards to pnpm; a missing binary fails
   with `pnpm not found on PATH`. Install it (`npm i -g pnpm` or
   `corepack enable`) and rerun the install.
4. **Legacy installs.** If you earlier injected a row into
   `$DSH_HOME/profiles/web/cordis.patch.yml` by hand, remove it and use
   `dsh plugin --profile web add dsh-obsidian-notes`. Two layers inserting the
   same plugin are not supported. See [legacy-install.md](legacy-install.md).
5. The sidebar row is **📚 Notes**, at the bottom of the workspace sidebar. If
   the sidebar is collapsed to the icon rail, click the **📚** icon.

After a page refresh the UI is current. After a **plugin upgrade** you must
restart the host: the host half (`/obsidian/*` routes) is replaced only at boot.

## "No chat input found — reference copied to clipboard" when citing

`⤴ Cite to chat` and the ask/explain button try three layers, in order:

| Layer | Mechanism | Applies when |
| --- | --- | --- |
| 1 | Official action surface `inputActions.insertText(...)` via the session's `conversation.composer.dock` slot | DSH 0.2+ — the normal path |
| 2 | DOM: `[data-input-scroll] > [data-composer-input]` contenteditable (or an old textarea), `execCommand("insertText")`, then a synthetic `beforeinput` | The slot is not mounted or an older/foreign build |
| 3 | Copy the mention to the clipboard and say so | No composer can be found |

If you see layer 3 every time, the composer is genuinely not reachable: open a
session (or select a workspace and start a new one) so the composer is rendered,
then try again. The fallback is intentional — the reference is never lost.

For a **selection ask**, the injected prompt is assembled as:

```text
@/abs/path/to/note.md
第 12–13 行
> quoted text
【问题】your question
```

The wrapper words (`第 … 行`, `【问题】`) are currently Chinese regardless of the
UI language; the payload (path, line numbers, quote) is what the model needs.
Long selections (> 1500 characters) are not quoted in full — the prompt asks the
model to read the named line range from the file instead.

## Deleted sessions come back after a refresh

`dsh web` prefers the sessions held in the process memory, so a session whose log
was deleted on disk is still listed until the process exits. The plugin has three
layers against that:

1. It never garbage-collects its local "deleted" tombstones before the session
   list snapshot is ready (`phase: "ready"`), so a refresh does not resurrect
   rows that were just deleted.
2. Deleting a row whose log is already gone is treated as "record removed" and
   the row is hidden instead of erroring with "No session found to delete".
3. The sidebar asks the host, read-only, on `/obsidian/session-state` whether
   each listed id still has a durable log (`sessionQuery.listSessions()`,
   `persisted` / `live` flags) and hides rows that are in the list but have no
   log on disk and are not running. If the service is unavailable or undecided,
   nothing is hidden (fail-soft) — a real session is never hidden by mistake.

The in-memory copy is released only when the process exits: the rows stay hidden
during this `dsh web` run and disappear for good after a **restart** (desktop:
quit and reopen).

## The chat surface still shows a deleted session, or the batch bar stays

- If the deleted session was the one open in the main view, the main view moves
  to the most recent remaining session, or clears to the empty state if none
  remain. It never deletes a log and keeps showing it, and never creates a new
  session on your behalf.
- Batch archive/permanent-delete exits the batch mode automatically after at
  least one success. Batch workspace deletion exits when every selected workspace
  was deleted; on partial failure the bar and the un-deleted selection stay so
  you can retry. If nothing was deleted, the selection is kept for a retry.
- These are client-side fixes for the most part: a page refresh is enough.
  Changes to the host routes need a host restart.

## `@/path` references do not resolve on Windows / Linux / macOS

The separator of the injected `@path` follows the vault root's platform: `\` on
Windows, `/` on Linux and macOS. This used to be hard-coded to `\`, which made
mentions such as `/home/me/vault/note\note.md` unresolvable outside Windows.
Fixed for the current version; if you are on an older build, upgrade.

## A note or folder delete does not go through the trash

Deleting a note or a folder is permanent (folder deletion is recursive) and asks
for confirmation. The only recoverable operation is session **archive** — and it
is one-way: DSH has no "archived" view, so restoring means removing the id from
`global.archivedSessionIds` in `$DSH_HOME/storages/workspace.json` while
`dsh web` is stopped. Reading a deleted session log directly (if a copy exists)
requires `zstd -dc` on its `.jsonl.zstd` file.

## Frontmatter is not shown in the editor

By design. The editor edits the note body; the host parses the leading YAML block
and stitches the original text back on save (including when an external editor
changed the YAML in the meantime). If you need to edit the YAML, use an external
editor — the plugin will not clobber it.

## Notes changed on disk are not visible in the preview

The preview polls the file's mtime every 3 seconds while it is open and in
preview mode (not while editing). The notes tree itself is not polled: click
**⟳** in the notes toolbar to re-read the directory. The tree also re-reads a
folder each time you expand it.

## Attachment folder changes

Changing the attachment folder moves the screenshots from the old directory to
the new one, rewrites every `![[…]]` embed that pointed at them, and removes the
old directory only when it is empty and not the vault root. Name collisions get
a ` (n)` suffix. Automatic orphan deletion is off by default: a file is removed
only if the embed was removed from a note **and** no other note references it —
and only while that opt-in setting is on.

## Asking about a selection sends Chinese wrapper text

Known limitation, see "No chat input found" above. The quoted text, path and line
numbers are correct; only the fixed wrapper words are Chinese for now.

## Where settings live

- Plugin settings: `$DSH_HOME/dsh-obsidian-vault.json` (vault root and
  attachment options).
- Profile/bundle wiring: `$DSH_HOME/profiles/web/package.json` and
  `cordis.patch.yml`.
- Session logs: `$DSH_HOME/sessions/`.
