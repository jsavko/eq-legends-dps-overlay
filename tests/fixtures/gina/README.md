# GINA fixture corpus

Real, publicly-shared GINA trigger packages, committed so the importer is tested against
what the format actually contains rather than against what its (offline) documentation
claimed. Every schema decision in `src/triggers/gina.js` was measured here first.

Total ~5 KB. These are test fixtures only — nothing here ships in the installer, and no
third-party pack is redistributed to players. See the changelog for why.

| File | Source | Licence | What it pins |
|---|---|---|---|
| `common-casting.gtp` | [mattnac/gina_cloud](https://github.com/mattnac/gina_cloud) `triggers/common_casting.gtp` | Apache-2.0 | `{S}` in both regex and literal patterns; `{C}` in output; four of five triggers are **TTS-only** (`DisplayText` empty, `TextToVoiceText` set) — the case that would import as a silent no-op without the speech-to-chip fallback |
| `sieve.gtp` | [mattnac/gina_cloud](https://github.com/mattnac/gina_cloud) `triggers/sieve.gtp` | Apache-2.0 | .NET named groups `(?<mob>…)` referenced as `${mob}`; `{COUNTER}`; `CopyToClipboard`; `RestartTimer`; `TimerMillisecondDuration` winning over `TimerDuration` |
| `zone-timers-gina.gtp` | [mattnac/gina_cloud](https://github.com/mattnac/gina_cloud) `zone-timers-gina.gtp` | Apache-2.0 | nine timer triggers; **duplicate `(?<mob>…)` across regex alternatives**, which .NET has always allowed and JavaScript only accepted from ES2025 (V8 12.5 / Node 22) |
| `respawn-slice.gtp` | [perotan/respawntimer](https://github.com/perotan/respawntimer) `RespawnTimer.gtp`, first two groups of 35 | MIT | `{C}` **inside a pattern**; `${2}${3}${4}` across an alternation where only one group ever matches; `TimerEarlyEnders`/`EarlyEnder`/`EarlyEndText`; `TimerEndingTrigger` as an element with children; an **empty** `TimerMillisecondDuration` falling back to `TimerDuration`; the same element name (`TimerEarlyEnders`) appearing twice in one trigger |
| `bare-shared-data.xml` | hand-written | — | the unzipped form, which circulates as `all-data.xml` in the same repo; plus CDATA, an XML comment, loose booleans (`true`/`1`), a top-level `SharedData > Triggers` with no group, and an `MM:SS` duration |

## Re-fetching

```bash
B=https://raw.githubusercontent.com/mattnac/gina_cloud/master
curl -O $B/triggers/common_casting.gtp -O $B/triggers/sieve.gtp -O $B/zone-timers-gina.gtp
gh api repos/perotan/respawntimer/contents/RespawnTimer.gtp --jq .content | base64 -d > RespawnTimer.gtp
```

`eq.gimasoft.com` — GINA's own site and its share-code service — no longer resolves, so
these community mirrors are what is left of the corpus. That is a large part of why
reading the orphaned `.gtp` files still in circulation is worth doing.
