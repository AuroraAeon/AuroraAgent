# Full-Text Session Search

The sidebar search box searches session titles and full transcripts together (user messages, assistant replies, thinking, tool calls and results). Chinese sessions are indexed by bigram tokenization, so two characters are enough for a hit.

## Tokenization and ranking

- Tokenization: CJK runs are cut into bigrams, Latin runs are lowercased by word — indexing a Chinese session as whole sentences means two typed characters never match, and a third-party tokenizer would break the zero-dependency baseline, so it is self-implemented
- Ranking: a self-implemented Okapi BM25 — long documents cannot farm score by length, and ties break by session id so paging is reproducible
- Tool results are truncated to 4000 characters before indexing: those are for the model, not for humans to search
- Snippets are produced by reading files on demand (capped at 160 characters); transcript text is not kept resident in memory

## Incremental index

The index is an in-memory inverted index and is not persisted — transcripts run to hundreds of KB, serializing term frequencies would yield tens of MB rewritten in full on every append, which costs more than the search itself.

- Writes update it incrementally through an observer: an append merges only the new record's text (no full transcript re-read); replace / fork / rename rebuild from the file; delete removes the entry
- Only sessions whose `(mtimeMs, size)` fingerprint changed are re-tokenized; unchanged sessions cost nothing
- A reconcile runs every 5 minutes as a backstop: forks, external edits, and deletions are all discovered there
- The terminal client passes no observer and pays nothing

## HTTP API

| Method and path | Effect |
| --- | --- |
| `GET /api/sessions/search?q=` | Full-text search; `q` is capped at 200 characters and returns at most 20 hits with score and snippet. `/api/agent/sessions/search` is a synonym |

A missing query term returns 400. Results carry session metadata (title, update time, and so on) so the frontend can render them straight into the sidebar.
