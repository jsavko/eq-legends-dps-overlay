# The quest chip identifies every drop; coverage rides in the wording

**Date:** 2026-08-14 (follow-up to `2026-08-14-log-derived-turnins-and-quests-cleanup.md`)

James: "The toast isn't showing up for what item can be made from the sky drops. Did
that not go in?" It went in — and the audit showed it working exactly as designed,
which was the problem. The chip fired only for slots still *needed* (quest not done,
item not owned), and by this afternoon his ledger said he needed almost nothing: the
morning's eqlposky import marked ~50 quests done, and the new derivations covered the
rest. Every Sky item he looted that hour (Silken Wrap, Nebulous Sapphire, Shimmering
Pearl, both Efreeti weapons) resolved to fully-covered slots — so the surface went
mute, which reads as "the feature is gone", not as fifty questions answered.

The deeper miss: he was never asking for a need alert. He was asking for
identification — *what can be made from this drop*. Rebuilt to match (his pick from
three offered filters):

- **Every counted quest drop chips**, naming class → reward. Coverage rides in the
  wording instead of muting the chip: "Bard — Ervaj's Flute of Flight **· already
  turned in**" (or "· already owned" — the wording says which kind of covered).
- Partial coverage counts down: "2 of 7 class tests still need this"; a single
  remaining class is named outright ("Monk — Wu's Fist of Mastery · rest covered"
  when others are done).
- **The one silence: a fully-covered rune.** Runes fall zone-wide all night and
  serve up to seven classes each; re-announcing "all covered" on every one is the
  noise that teaches a player to stop reading alerts. A rune chips only while some
  class still needs it.
- Hand-ins (`offer` events) still never chip — the feed answer now carries
  `kind: 'loot' | 'offer'` so the caller can tell.

The wording and the silence live in `QuestProgress#lootChip` (pure, unit-tested);
`noteQuestLoot` in main.js is just the push into the chip stack.

Files: `src/quests/progress.js` (lootChip, `kind` on the feed answer),
`src/main/main.js` (chip call site), `tests/quests.test.js`. 811 tests green;
packed and relaunched.
