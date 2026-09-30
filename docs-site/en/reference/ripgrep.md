# Search Acceleration (ripgrep)

The `grep` and `glob` runtime tools prefer [ripgrep](https://github.com/BurntSushi/ripgrep) and fall back to a pure-JavaScript directory walk when it is unavailable. Both paths behave identically; only the speed differs, by an order of magnitude on large repositories.

## Resolution order

`util/ripgrep.mjs` looks for a usable `rg` in a fixed order:

1. `tools/bin/<arch>/rg` — the bundled binary committed with the repo (macOS arm64 and x64 only)
2. `rg` on `PATH` — a version you installed yourself
3. Neither found: fall back to the pure-JavaScript walk (no missing features, just slower)

## The bundled binary

The zero-dependency baseline allows exactly one kind of exception, "a binary committed with the repo", and ripgrep is the only one.

```bash
node tools/download-ripgrep.mjs            # current architecture only
node tools/download-ripgrep.mjs --all      # all macOS architectures (arm64 + x64)
node tools/download-ripgrep.mjs 14.1.1     # pin a version (14.1.1 by default)
```

The `.app` bundle copy list includes `tools/bin`. The downloader itself is zero-dependency: direct https, manual 302 following, gzip via `node:zlib`, and hand-written tar header parsing.

## Identical answers on both paths

The fallback path and the ripgrep path return the same answers because the ripgrep side explicitly passes `--no-ignore --hidden`: ignore rules are not decided by ripgrep but by the single source of truth in `util/agent/tools.mjs` (dependency directory blacklist plus the `.auroraagentignore` no-entry zone). Otherwise whether you have rg installed, and which version, would change which files the model can see.

The environment variable `AURORAAGENT_NO_RIPGREP=1` forces the fallback path — useful for comparing answers between the two paths, and it lets tests exercise the fallback for real.

## Ignore files

Drop a `.auroraagentignore` at the workspace root to keep `.env`, `node_modules/`, and key directories away from the model's read and write tools — more reliable than telling the model "don't touch that file" one message at a time. The syntax is a gitignore subset: `#` comments, `!` negation, a trailing `/` for directories, `*` `**` `?` `[]`, basename matching at any depth when the pattern contains no slash, and `!include <file>` for recursive includes (refusing to escape the workspace). Changes hot-reload with 150ms debounce, no restart needed. A hit marks the tool result with a lock symbol and a reason. The `ignore.enabled` config key turns the whole mechanism off (on by default).
