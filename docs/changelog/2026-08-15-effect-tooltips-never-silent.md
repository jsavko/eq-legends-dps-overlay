# Effect tooltips: never silent, and real data for the classes P99 predates

**Date:** 2026-08-15

## The report

"The mouseover for effects on reward items still doesn't work." The rail-row reward
preview popped fine — James liked it — but hovering an effect name on the quest
pane's cards did nothing, despite the 2026-08-14 changelog recording the tooltips
as shipped and verified ("tooltip on Fury").

## The cause

Both claims were true at once, and that is the whole lesson. A tooltip only bound
when the effect had an entry in `effects.json`, and an absent entry rendered with
no underline and no popup — silence by design, on the theory that absence should be
honest. `effects.json` is scraped from the P99 wiki, which is classic-era and does
not have the beastlord class at all. James plays a beastlord. Coverage of the
dataset's 50 effect lines was 43 — and the seven misses included **all four
beastlord effects** (Whirl Bolt, Vigor of Zehkes, Herikol's Soothing, Sha's
Lethargy), plus one each for berserker, cleric and magician. So the feature worked
for fifteen classes and had never once fired on the pages the actual player opens.
The verification hovered a bard item; the player is not a bard.

This is the always-silent-filter failure class the alert rules already know: a
surface that can go completely quiet is indistinguishable from a broken one. It
also hid *behind* a passing audit — data shipped, code current in the packed asar,
IPC shape correct, CSS right. Nothing was broken; the coverage was just zero where
it counted. What cracked it was James's own bisect (rail previews work → machinery
fine) plus a per-class coverage run.

## The fix, in two halves

**Never silent again** (`src/renderer/quests/quests.js`): when tooltips are live,
every effect name binds the popup and wears the underline — entry or not. An
entry-less effect answers the hover with an honest absence card: the spell name,
the meta the card already parses, and one line saying the classic-era P99 wiki has
no page for this spell and nothing has been transcribed for it yet. Nothing is
guessed, but the hover always answers. The footer now names the *entry's own*
source instead of claiming "P99 wiki" globally, because the two data files below
make different claims.

**Real data for the seven** (`src/quests/effects-legends.json`, new): all seven
formerly-missing spells, hand-TRANSCRIBED — copied verbatim with the URL recorded
per entry, never authored, which is the distinction that keeps the original "no
guessed tooltips" rule intact. The find of the day: **eqlwiki.com**, an EverQuest
Legends wiki with client-mined spell data, covers six of the seven with the
*server's own values*, which live-EQ sources get wrong — Sha's Lethargy slows 40%
on Legends vs 30% on live, both beastlord pet heals heal flat amounts live EQ
prints as scaling, Fury of the Chosen has entirely different slots, and Blessing of
the Lord Commander is EQL-original with no live entry anywhere. Servant of Air (a
worn focus with no eqlwiki spell page) comes from Allakhazam. Each entry's `note`
records the live-EQ divergence so a future reader can see why eqlwiki won.

The merge (`src/quests/index.js`) loads both files and has two load-bearing rules:
`fetch-posky.js --write` only ever rewrites `effects.json`, so a wiki refresh can
never clobber the transcriptions; and where both files know a name, the fetched
snapshot wins, keeping the supplement strictly a gap-filler. `missing` is
recomputed post-merge and is now empty — 50 of 50 card effects resolve to a real
entry.

## Tests

`tests/quests-effects.test.js` (new) pins the contract: every effect on every card
resolves post-merge to an entry or an explicit `missing` name — no silent third
state; the four beastlord spells must have real entries (a merely honest absence
there means the supplement regressed); `missing` and `effects` stay disjoint; and
the supplement file must be transcription-shaped (url, source, verbatim lines) and
never shadow the wiki snapshot. Full suite: 843 passing.

## Verification

Headless Windows Chrome against the **true producer's payload** — the snapshot
built by the shipped `QuestProgress#snapshot()` itself, JSON-serialized (identical
to what survives Electron's structured clone), with only the IPC transport stubbed.
That closes the gap that let the 08-14 verification lie: the stub's *data* was
hand-built then; this time only the pipe is fake. Verified with real CDP gestures:
Windhowl / Spirit Render selected by click, Sha's Lethargy hovered → popup with
both verbatim lines, meta, and "EverQuest Legends wiki snapshot" footer, fully
on-screen; an absence-variant payload (entry deleted) → underline still present,
honest no-description card, no source footer claimed; rail preview regression →
still pops, still `tooltips: false` inside (a popup inside a popup helps nobody).

The overlay was mid-session (log written the same second) so the win-unpacked
repack was deferred rather than killing the meter under the player; kill → pack →
relaunch happens the moment the session ends.

## Files

- `src/renderer/quests/quests.js` — bind on every effect; absence card; per-entry
  source footer
- `src/renderer/quests/quests.css` — `#popup .pnone`, the absence card's register
- `src/quests/effects-legends.json` — NEW: seven transcribed entries, attribution,
  per-entry divergence notes
- `src/quests/index.js` — two-file merge with clobber-proof / wiki-wins rules
- `src/quests/effects.json` — attribution note updated to match the new policy
- `scripts/fetch-posky.js` — comments and attribution note stop promising the old
  silent rule; warn line points at the supplement
- `tests/quests-effects.test.js` — NEW: the coverage contract, beastlord pinned

## For next time

Coverage claims get checked against the class the player actually plays, not the
first row that renders. And eqlwiki.com is client-mined Legends data — if its
coverage proves broad, it is arguably the *better primary* for every effect on
these cards, not just the seven P99 lacks; the P99 snapshot would then become the
fallback. Deliberately not done today: the 43 P99 entries are believed close
enough, and swapping primaries deserves its own diff of every changed value.
