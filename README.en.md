# Vault iCloud Sync

[中文](README.md) | [English](README.en.md)

An Obsidian **desktop** plugin: sync your local vault one-way into an iCloud backup folder, with **per-file, explicit reverse operations** — restore from backup, prune stale backup files, or pick "back up / restore" file by file in a diff list.

> [!note] Why
> Putting a vault directly inside iCloud Drive invites overwrite conflicts between devices and `.icloud` placeholder files that can't be read. Sync services are either paid/closed or too coarse when you need to roll back **specific files**.
> This plugin takes a simpler stance: **the local vault is the single source of truth; the iCloud copy is a backup.** Everyday sync is one-way and never deletes. Rolling back is something you do explicitly, file by file.

## Features

| Feature | What it does |
|---------|--------------|
| Daily auto sync | On the first launch of the day, wait N seconds (default 60), diff both sides, and sync only when something changed. Disabling it also cancels a pending timer; unloading kills any in-flight rsync |
| Manual sync | Command palette / ribbon icon / settings button |
| Diff list | Read-only scan, then a modal listing every difference (`local-only / differs / backup-only / type conflict`). Check rows and choose a direction per row before anything is written |
| Restore from backup | Lists restorable files; only checked ones are copied back. "Move local-only files into trash" is an independent checkbox and works with zero restore items selected |
| Prune backup | Lists files that exist only in the backup; checked ones move into the backup's timestamped trash. Empty-directory pruning follows the same confirmation flow |
| Last result | Modal with counts, duration and samples of the last sync / plan / restore / prune |
| Trash folder | Nothing is hard-deleted: moved files go to `.vault-sync-trash/<timestamp>/`. Root trash is always excluded — deleting its exclude rule in settings cannot expose it |

A plan row's direction is editable:

```
☐ differs       [backup] 03-Personal/example.md     ← click the chip to switch to restore
☐ backup-only   [restore] 02-Business/2026-meeting.md
☐ type conflict [backup] 04-Operations/some-folder  ← target moved to trash, then source copied as a tree
```

Batch buttons operate on the **currently filtered** rows. Lists are chunked (300 rows + "show more"). Source-side mtime is carried over, so a processed file does not show up as a new difference in the next run.

## Install

Manual installation:

1. Clone or download this repository;
2. Copy `main.js`, `manifest.json`, `styles.css` into `<your vault>/.obsidian/plugins/vault-icloud-sync/`;
3. Obsidian → Settings → Community plugins → turn off Safe mode → refresh → enable **Vault iCloud Sync**.

Desktop only (`isDesktopOnly: true`): the plugin shells out to the system `rsync` and uses Node's `fs` / `child_process`.

## Quick start

1. Set **iCloud backup folder** in the plugin settings (an existing directory, not equal to and not a parent/child of the current vault);
2. Click **Check differences** to review the list;
3. Sync manually — or let the daily run do it;
4. Roll back only when you mean to, and only for the rows you checked.

Defaults worth knowing: comparison is size + mtime (matching rsync); MD5 mode exists but is slower; `~` in the configured path is expanded. `.obsidian` and other dot-folders are excluded, so the backup is a "notes only" copy. User exclude rules are treated as **literal paths** (glob metacharacters are escaped before being passed to rsync); only the plugin's own iCloud-placeholder rule intentionally matches `.<name>.icloud` stubs.

## Safety rails

- **No rsync `--delete` domain.** rsync only copies. Deletion and trashing are done by the plugin against this run's verified list. Failed-to-trash files stay exactly where they were, and the result is reported as a partial failure — never an extra hard-delete as a side effect.
- **Strict path discipline.** local ≠ remote, and neither may contain the other (including symlink aliases). Writes refuse any nearest existing parent whose realpath leaves the allowed root. A destination path that is itself a symlink is unlinked before copy (so contents never transparently overwrite the link target).
- **Scan integrity.** Any unreadable subtree makes tree comparison untrustworthy — mirror-delete, prune and "fully identical" recovery abort rather than treating it as thousands of stale files. A missing MD5 on either side is never treated as "same contents".
- **Second-level safety revalidation.** Before every write, the target is re-checked with full `mtimeMs`, byte size, file/dir type and link target. Same-second rewrites and redirected links cause a skip, not an overwrite. lstat failures are treated as changed rather than safe.
- **Type conflicts are atomic families.** A file↔directory conflict appears as its own row. The target side is moved to trash first; if that fails, the whole sync aborts rather than replacing an unprotected original. Children selected along with their parent conflict are folded into the parent operation rather than acting independently.
- **iCloud placeholder awareness.** Only single-segment `.name.icloud` stubs count as evicted. Backup stubs are skipped by both sides of the scan and by rsync; a real `report.icloud` still syncs normally. A local file evicted by iCloud does not make its real backup copy "orphan", and leftover stubs whose real file exists are moved into trash even on an otherwise no-op run.
- **Persistence and lifecycle.** State writes are serialized and caught, so completion notices never depend on a save succeeding. Pending timers honour the auto-enabled toggle and plugin unload; an in-flight rsync is killed on unload.

## Two macOS quirks handled explicitly

1. **Never parse `rsync -i` output.** macOS ships openrsync, which escapes non-ASCII names (`战略.md` → `\#210\#230\#225`), so the plugin walks the trees with `readdir` instead.
2. **Never use `--backup-dir` with `--delete`.** openrsync silently skips deletions in that combination. The plugin moves files to trash itself; there is no `--delete` anywhere in the write path.

## Tests

No dependencies, no build step. The Obsidian API is stubbed; tests run against a real temporary filesystem and the real `rsync`:

```bash
node tests/run.js
```

58 scenarios cover tree diffing, forward sync, restore (default / opt-in / none / cancel / empty backup), prune (partial / empty local / nothing to do), diff plan (default direction / forced direction / idempotency / no selection), and regressions for: evicted placeholders, symlinks (including dangling links and external parent symlinks), type conflicts including empty trees and parent+child plans, root overlap and alias rejection, literal vs glob exclude semantics, mirror-delete guards, run-lock transfer, mtime/size revalidation, partial trash failures, untrusted-directory path checks, scan errors, and persistence failures. Each new regression scenario is first verified to fail on the older version.

## Limitations

- Not two-way sync: no conflict merging, no filesystem watching;
- No version history (pair it with Git or Time Machine);
- Don't edit the backup copy — the next sync overwrites it with local content;
- Requires the system `rsync` (path configurable).

## License

[MIT](LICENSE)
