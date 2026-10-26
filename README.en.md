# Vault iCloud Sync

[中文](README.md) | [English](README.en.md)

An Obsidian **desktop** plugin: sync your local vault one-way into an iCloud backup folder, with **per-file, explicit reverse operations** — restore from backup, prune stale backup files, or pick "back up / restore" file by file in a diff list.

> [!note] Why
> Putting a vault directly inside iCloud Drive invites overwrite conflicts between devices and `.icloud` placeholder files that can't be read. Syncing services are either paid/closed or too coarse when you need to roll back **specific files**.
> This plugin takes a simpler stance: **the local vault is the single source of truth; the iCloud copy is a backup.** Everyday sync is one-way and never deletes. Rolling back is something you do explicitly, file by file.

## Features

| Feature | What it does |
|---------|--------------|
| Daily auto sync | On the first launch of the day, wait N seconds (default 60), diff both sides, sync only if something changed |
| Manual sync | Command palette / ribbon icon / settings button |
| Diff list | Read-only scan, then a modal listing every difference (`local-only / differs / backup-only`); check items and pick a direction per row before anything is written |
| Restore from backup | Lists restorable files; only the checked ones are copied back; local-only files are kept unless you opt in |
| Prune backup | Lists files that exist only in the backup; checked ones are moved into the backup's trash folder |
| Last result | Modal with counts, duration and samples of the last sync / plan / restore / prune |
| Trash folder | Nothing is ever hard-deleted: moved files go to `.vault-sync-trash/<timestamp>/` |

Mtime of the **source** side is copied along with the content, so a processed file won't show up as a difference in the next run.

## Install

Manual installation:

1. Clone or download this repository;
2. Copy `main.js`, `manifest.json`, `styles.css` into `<your vault>/.obsidian/plugins/vault-icloud-sync/`;
3. Obsidian → Settings → Community plugins → turn off Safe mode → reload → enable **Vault iCloud Sync**.

Desktop only (`isDesktopOnly: true`): it shells out to the system `rsync` and uses Node's `fs` / `child_process`.

## Quick start

1. Set **iCloud backup folder** in the plugin settings (an existing folder, different from the current vault);
2. Click **Check differences** to review the list;
3. Sync manually — or let the daily run do it;
4. Roll back only when you mean to, and only the files you check.

Defaults worth knowing: comparison uses size + mtime (matching rsync); MD5 mode exists but is slower; `.obsidian` and other dot-folders are excluded, so the backup is a "notes only" copy.

## Safety rails

- Every reverse operation opens a confirm modal with **nothing pre-selected**; cancel/Esc writes nothing.
- The currently opened vault must equal the configured local folder, otherwise the operation aborts.
- Restore aborts when the backup contains no files; it warns when the backup is less than half the local file count, and when local files are newer than their backup copies.
- Prune aborts when the local vault scans empty (wrong mount / iCloud not ready).
- Deletions are `fs.rename` into a timestamped trash folder, with a copy+unlink fallback.
- Only one job (sync / restore / prune) runs at a time.

## macOS quirks handled here

1. **Never parse `rsync -i` output.** macOS ships openrsync, which escapes non-ASCII names (`战略.md` → `\#210\#230\#225`), so the plugin walks the trees with `readdir` instead.
2. **Never use `--backup-dir` with `--delete`.** openrsync silently skips deletions in that combination, so the plugin moves files itself and lets rsync only prune empty directories.

iCloud placeholders (`.foo.md.icloud`) are filtered out of scans and restores.

## Tests

No dependencies, no build step; the Obsidian API is stubbed and tests run against a real temp filesystem and the real `rsync`:

```bash
node tests/run.js
```

16 scenarios covering tree diffing, forward sync, restore (default / opt-in / none / cancel / empty backup), prune (partial / empty local / nothing to do), diff plan (default direction / forced direction / idempotency / no selection) and settings/command registration.

## Limitations

- Not two-way sync: no conflict merging, no filesystem watching;
- No version history (pair it with Git or Time Machine);
- Don't edit the backup copy — the next sync overwrites it with local content;
- Requires the system `rsync` (path configurable).

## License

[MIT](LICENSE)
