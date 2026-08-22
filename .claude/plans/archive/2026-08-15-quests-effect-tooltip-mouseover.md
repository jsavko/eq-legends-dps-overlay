---
status: completed
---
# Quests window: effect tooltips are 100% silent on the beastlord page

**Date:** 2026-08-15

---

## Goal

Hovering an effect name on a reward card in the quest pane should float the spell's
description, as the approved Pencil mockups show. James measures that it never
happens. The popup machinery itself is fine — he confirmed the rail-row reward
preview (same `#popup`, same `bindPopup`) works and likes it.

**Root cause, found:** a tooltip only binds when the effect has an entry in
`effects.json`, and an absent entry gets *no underline and no popup* — silence by
design ("absence honest, nothing guessed"). `effects.json` is scraped from the P99
wiki, which is classic-era and has no Beastlord class at all. Rhale is a beastlord.
Per-class coverage of the dataset:

- **Beastlord: 0 of 4** — Whirl Bolt, Vigor of Zehkes, Herikol's Soothing, Sha's
  Lethargy are ALL in the `missing` list. On James's own quest pages the feature
  has never once fired.
- Also missing: Fury of the Chosen (berserker), Blessing of the Lord Commander
  (cleric), Servant of Air (magician). Every other class is fully covered
  (43 of 50 effect lines overall).

So the feature "works" for fifteen classes and is invisible for the one James
plays. This is the always-silent-filter failure class: a surface that can go
completely quiet reads as breakage, exactly as the alerts/toasts rule already
records. Two things need fixing — the silence (an effect with no entry must still
answer the hover) and the data (James's own gear deserves real descriptions).

## Approaches Considered

### 1. Live-debug the packaged app with DevTools
- **Description:** The original plan: attach to the real window and walk the
  binding→data→machinery→visibility fork.
- **Pros:** Would have found the same answer.
- **Cons:** Obsolete — James's rail-preview observation bisected the machinery
  question, and the per-class coverage run pinned the cause statically. Running
  it now would be ceremony.

### 2. Data only: source the 7 missing spells, keep silence for absent entries
- **Description:** Fill the missing entries from a Luclin-era spell source; an
  effect that still has no entry keeps rendering with no underline and no popup.
- **Pros:** Small diff; James's pages light up.
- **Cons:** The failure class survives. The next `fetch-posky.js --write` after a
  wiki hiccup, or the next dataset item with an unsourceable spell, goes silently
  dead again — and reads as breakage again. Also fragile alone: any spell we
  cannot source stays a hole.

### 3. Affordance only: every effect answers the hover, absent entries say so
- **Description:** Bind the popup on every effect name when tooltips are on. An
  entry-less effect gets an honest popup: the spell name, the meta the card
  already parses, and one line stating there is no description because the
  classic-era P99 wiki has no page for this Luclin-era spell.
- **Pros:** The surface can never go silent again, for any class or any future
  data state. Nothing guessed — the popup words its own absence.
- **Cons:** James hovers Windhowl and learns *why* there's no description instead
  of reading one. Honest, but not what he opened the window for.

### 4. Both: never-silent binding + a supplement file for Luclin-era spells (chosen)
- **Description:** Approach 3 as the durable rule, plus a second data file
  (`src/quests/effects-legends.json`) holding the 7 Luclin-era spells with lines
  copied verbatim from a real spell-data source (Allakhazam-style spell pages),
  each entry carrying its own `url` and `source`. `src/quests/index.js` merges it
  over the P99 snapshot at load, so `fetch-posky.js --write` can regenerate
  `effects.json` forever without clobbering the supplement. The tooltip footer
  names each entry's actual source instead of claiming "P99 wiki" globally.
- **Pros:** James gets real descriptions on his own gear; the silent state is
  gone for good; the P99 snapshot stays a pure artifact of its scraper; per-entry
  attribution stays exact.
- **Cons:** Two data files to understand instead of one — mitigated by the merge
  living in one commented place (`index.js`) and each entry naming its source.

## Chosen Approach

**Approach 4.** Copying a spell's effect lines from a published source with its
URL recorded is the same snapshot process `fetch-posky.js` automates, done once by
hand — distinct from the "hand-authored description" the original design rightly
banned, which meant *writing* a summary from memory. Anything that genuinely
cannot be sourced (Legends-invented spells may exist) stays entry-less, and the
never-silent popup covers it honestly. Supplement merges at load time, not write
time, so the two files each remain a faithful artifact of their source.

## Tasks

- [x] `src/renderer/quests/quests.js` `buildCard`: when `tooltips` is on, bind
      `bindPopup` on *every* effect name — entry or not — and add the `.tip`
      underline to all of them, so hovering is taught uniformly
- [x] `effectTip`: with an entry, render its lines and a footer naming *that
      entry's* source (from `entry.source` / `entry.url`, defaulting to the P99
      wording); without one, render name + parsed meta + one line stating the
      description is absent because the classic-era wiki has no page for this
      Luclin-era spell — and drop the now-false global footer "an effect with no
      entry gets no tooltip"
- [x] Create `src/quests/effects-legends.json`: all SEVEN spells sourced, none
      left out. Key find: eqlwiki.com (client-mined EverQuest Legends data)
      covers six with the *server's own values* — Sha's Lethargy slows 40% on
      Legends vs 30% on live EQ, both beastlord pet heals differ, Fury of the
      Chosen has different slots, Blessing of the Lord Commander is EQL-original
      with no live entry at all. Servant of Air (a worn focus, no eqlwiki spell
      page) comes from Allakhazam. Per-entry notes record every live-EQ
      divergence; cross-checked against eqlbuildforge.com and a Lazarus allaclone
- [x] `src/quests/index.js`: merge the supplement over the P99 snapshot in
      `EFFECTS` (supplement fills gaps only — a name P99 later gains keeps the
      P99 entry), recompute `missing` after the merge, and update the doc comment
      that currently promises "those render with NO tooltip"
- [x] Update the stale comment in `scripts/fetch-posky.js` (lines ~245–247) the
      same way — it documents the old silent rule (also the attribution note it
      writes, mirrored into the shipped effects.json, and the console.warn wording)
- [x] `tests/quests-effects.test.js` (new sibling): every effect line on every
      card resolves post-merge to entry-or-missing (no silent third state), the
      beastlord quests pinned by class id, missing/effects buckets disjoint, and
      the supplement file — once present — must be transcription-shaped (url,
      source, verbatim lines) and never shadow the wiki snapshot
- [x] `npm test` in WSL — 843 passing
- [x] Verify the renderer against the TRUE producer's payload (headless Windows
      Chrome, snapshot built by the shipped `QuestProgress#snapshot()` itself,
      only the IPC pipe stubbed): Windhowl selected by real click, Sha's Lethargy
      hovered by real CDP gesture → popup with verbatim lines + "EverQuest
      Legends wiki snapshot" footer, on-screen; absence variant → underline +
      honest no-description card, no source claimed; rail preview regression clean
- [x] `scripts/dev.sh pack` + relaunch — deferred through James's play session
      (never killed under him; he shut the overlay down himself), then packed,
      supplement confirmed in the new asar (9 eqlwiki hits), and relaunched.
      James's tray click is the final human check: Quests → Windhowl / Spirit
      Render → hover Sha's Lethargy
- [x] `docs/changelog/2026-08-15-effect-tooltips-never-silent.md` written; plan
      archives when the pack lands

## Notes

- The bisect that cracked it was James's own report: rail previews work, effect
  tooltips never fire. Machinery was never the problem; binding coverage was.
- The 08-14 headless verification checked "tooltip on Fury" — a bard reward, a
  covered class. Coverage claims need to be checked against the class the player
  plays, not the first row that renders.
- Fallback if no scrapeable source for a spell exists: James can read the spell's
  in-game description aloud and that text goes in with `source: "in-game spell
  description"` — still a transcription, still not authored.
- Secondary popup-lifecycle nits spotted during the earlier audit (a rail preview
  orphans if its row is clicked away mid-hover; a pinned popup survives a
  re-render with a detached anchor) are real but unrelated — not in scope here.
