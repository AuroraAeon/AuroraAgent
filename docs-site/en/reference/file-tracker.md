# File Freshness & Atomic Writes

## File freshness

The model edits a file from memory several rounds later while you changed the same spot in an editor in between — an `edit_file` that splices against stale content silently overwrites your change. File freshness tracking exists to prevent exactly that.

- `read_file` records the file's `(mtimeMs, size)` fingerprint
- `edit_file` / `write_file` compare fingerprints before writing: a mismatch means "changed externally during this session", so the original content is re-read first (the tool needs to read it anyway), and the tool result tells the model the result is based on the freshly re-read content
- After our own write the fingerprint is refreshed, otherwise every edit would mistake the previous write for an external change
- A file deleted externally also counts as "changed": `edit_file` reports the missing file itself, but `write_file` would silently recreate it, erasing your intent to delete
- Tracked per turn and cleared when the turn ends

**Why fingerprint snapshots instead of `fs.watch`**: a watcher needs one per file and must still tell "written by us" from "changed by someone else" (otherwise every edit is a false alarm), which is a pile of file descriptors and races over a long session. APFS mtimes are nanosecond-resolution, so fingerprint comparison is reliable enough and fully deterministic — tests never wait on filesystem events.

## Atomic writes

Config, sessions, providers, the message queue, scheduled jobs, and failover state all go through `writeFileAtomic`: write a temp file, `fsync`, `rename`, then `fsync` the directory.

- The temp file is explicitly `chmod 0600`: the `open` mode is subject to umask, so not pinning it can leave the file world-readable — and these files hold API keys, session transcripts, and job prompts
- The data directory is created `0700`
- A half-written file is a data incident and a world-readable one is a leak incident; both ends are closed
