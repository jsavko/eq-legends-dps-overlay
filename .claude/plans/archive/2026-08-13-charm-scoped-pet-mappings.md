---
status: completed
---
# Charm-scoped pet mappings: mob-named pets break the pets command and leak across fights

**Date:** 2026-08-13

---

## Goal

Make the pet machinery work when the pet is a charmed mob with a mob-shaped name — because
in a group where charm pets do the killing, the current machinery doesn't just misfile
rows, it **blanks the meter**. Tonight's session (Aug 13, ~22:45–23:25, an undead zone
where the whole group ran charm pets) is the evidence base:

- The live pipeline was healthy all night — the history store has encounters persisted
  through 23:23 — so this is scoring, not a crash.
- Replaying the slice: the healthy hour (22:00–23:00, before/early charm play) scores
  98–100% of the damage the rules match; the charm half-hour scores **67%**, and the
  pulls James actually watched were effectively blank — "skeletal monk", 2:56 at 2.0
  group DPS, and "lurking mummy pet", 1:52 at 0.7 group DPS, while the group was killing
  continuously. (Audit script: scratchpad `audit-drops.mjs`, seen-vs-scored per
  half-hour.)
- The deletion has two mechanisms that compound: **stale charm mappings** make hostile
  same-name mobs read as 'ours', so everyone's damage on them is dropped as friendly
  fire (James's slashes on a lurking mummy at 23:16 — a mummy was charmed at 23:12 —
  scored nothing); and **unmapped charm pets** are mob-shaped strangers, so their kills
  are mob-vs-mob lines that score nothing, can't open an encounter, and can't engage the
  mob they're killing. In a charm group that is most of the damage.
- The wrong-lifetime bug has already escaped into persisted config: James's live
  `config.json` contains `"basilisk": "Rhale"` inside `petOwners` — a charm learned by
  the Master line into the durable table, then written to disk by a later successful
  `pets` command (which persists the whole table). Every session since loads "every
  basilisk = Rhale" at startup.

Three concrete failures underneath, all reproduced from the live log:

1. **The pets command refuses mob names.** James typed five variants ending in the
   correct-order `pets a skeletal monk = Rhale` (23:19:27, retried 23:19:37). The
   `pet-command-set` rule requires `[A-Za-z]{2,32}` per name — one token, no spaces — so
   every attempt fell to `pet-command-malformed`, which answered with the very syntax he
   was already typing. Meanwhile `roster.setPetOwners` (the settings path) explicitly
   supports mob-named pets ("a tal ghoul wizard", article-stripped) — the command and the
   settings disagree about what a pet can be called.

2. **What auto-learning does learn, it stores with the wrong lifetime.** The charmed monk
   reports in under its plain mob name — `A skeletal monk told you, 'Attacking a lurking
   mummy Master.'` (23:20:39) — and the `pet-owner` path writes `skeletal monk → Rhale`
   into **durable petOwners**. Charm is transient; the mapping is not. After the charm
   breaks, every hostile skeletal monk for the rest of the session resolves to Rhale:
   its swings at James read as friendly-fire instead of damage taken, and `standing()`
   calls it 'ours' by construction. Same story for `handleCharm`'s attribution, which is
   correctly transient — but the explicit break line, `Your Charm spell has worn off of a
   skeletal monk.` (23:19:18, 23:20:25), has **no rule at all**, so a freed pet keeps
   resolving to its charmer until the friendly-hits-friendly inference notices. (CLAUDE.md
   claims "the log has no charm-break message" — tonight's log disproves that for your
   own charm.)

3. **Other people's pets carry a `" pet"` suffix the parser has never seen.** EQ Legends
   names every pet that isn't yours `<base> pet`: Rhain's animation is `A dark boned
   skeleton pet` (2s after "Rhain animates an undead servant"), and hostile necro mobs'
   pets read the same way (`A dark boned skeleton pet hits YOU`, 22:41). 1,354 such lines
   tonight. `charmedPets` and `petOwners` key on the plain base name, so a party member's
   charm mapping ("ghoul → Ribbers") never matches the lines their pet actually produces
   ("A ghoul pet…") — the mapping is dead on arrival, the pet is a mob-shaped stranger,
   and two encounters tonight were literally titled after the group's own pets
   ("dark boned skeleton pet" 22:52, "lurking mummy pet" 22:56).

Not in scope: two same-named entities on opposite sides at once (a hostile lurking mummy
harm-touched Rhain in the same second James's charmed mummy fought for us). The log
carries no instance identity; this is the accepted ambiguity class ("a fire giant warrior
cleaves a fire giant warrior") and no name-keyed fix exists.

## Approaches Considered

### 1. Loosen the command regex only, keep durable petOwners
- **Description:** Accept multi-word names in `pet-command-set`, drop the
  `looksLikePlayerName` gate in `handlePetCommand`, store into petOwners as today.
- **Pros:** Smallest diff; unblocks the exact command James typed.
- **Cons:** Makes failure 2 *worse* — a durable "skeletal monk = Rhale" outlives the
  charm and folds every later hostile monk into Rhale (already observable tonight via
  the Master-line bind). Does nothing for the `" pet"` suffix, so other members' pets
  stay broken. Does nothing for wear-off flapping.

### 2. Charm-scoped mob-name mappings + suffix-aware lookup + explicit wear-off rule
- **Description:** A mob-shaped pet name is charm-scoped by definition, so both entry
  points that produce one — the typed command and the pet-reports-to-Master line — write
  into the transient `charmedPets` store instead of durable petOwners. `ownerOf` /
  `isCharmed` fall back from `<base> pet` to `<base>` so a mapping matches both spellings.
  A new rule reads `Your <Spell> spell has worn off of <Target>.` and the parser uncharms
  when the spell is charm-like. Player-shaped named pets (Gann, Jonarn) keep the durable
  path unchanged.
- **Pros:** Mapping lifetime matches the thing being mapped; a wrong answer costs one
  fight, not a session — the project's stated standard. Fixes all three observed leaks.
  No shape-decides-side rule anywhere: the fight still decides who counts; only *identity*
  is being answered, which is roster's job. The wear-off line is game truth, better than
  the swing inference it currently waits for.
- **Cons:** Touches four files. A commanded mob-name mapping dies on zone/reset
  (clearCharms) — correct for charm, and the settings path still covers a permanent
  mob-named summon if one ever exists.

### 3. Teach entities.js the suffix as a structural pet marker
- **Description:** Treat `<base> pet` like the backtick form — fold it to an owner by
  shape, attributing by proximity or pending summon.
- **Pros:** One-file change; suffix pets stop looking like wild mobs.
- **Cons:** The suffix means "somebody's pet", not "our pet" — hostile mobs' pets carry
  it too (`A dark boned skeleton pet hits YOU`). Attributing by shape is exactly the bug
  class the fight-decides re-axis removed. Rejected.

### 4. Instance tracking for same-named entities
- **Description:** Model each same-named combatant as a separate instance to untangle
  charmed-vs-hostile collisions.
- **Pros:** Would solve the one thing nothing else can.
- **Cons:** The log provides no instance identity; every assignment of a line to an
  instance is a guess, and honest-numbers forbids guessing. A rewrite for an ambiguity
  the project has already accepted. Rejected.

## Chosen Approach

Approach 2. The unifying idea: **a mob-shaped pet name is evidence of a charm, and charm
is transient** — so every path that learns one (command, Master line, charm attribution)
converges on `charmedPets`, and every path that ends one (wear-off line, swing inference,
zone) tears it down. The suffix fallback makes the mapping actually reach the lines the
pet produces. Durable petOwners returns to holding only what is genuinely durable:
player-shaped named summons. And mappings **override rather than layer**: writing an
owner for a name evicts that name from every other store, so the newest explicit
statement always wins and the lookup order never arbitrates a conflict.

## Tasks

- [x] `rules.js`: add a `worn-off` rule — `^Your (.+?) spell has worn off of (.+)\.$` →
      `{ kind: 'worn-off', ability, target }`, with a `(confirmed)` comment citing
      tonight's line. Must not catch `Your pet's X spell has worn off.` (no "of" — it
      doesn't). Emit for every spell; deciding charm-ness is the parser's job.
- [x] `rules.js`: loosen `pet-command-set` name captures to letters, spaces and backticks
      (e.g. `([A-Za-z][A-Za-z \x60]{0,47}?)` both sides, whitespace-forgiving at the
      seams), keeping the full-message anchor, keyword and `=` as the safety. Validation
      moves to the handler so a near miss gets a specific answer, never the generic
      syntax line for a line that already matches the printed syntax.
- [x] `index.js` `handlePetCommand`: strip article and a trailing `" pet"` suffix from the
      pet side. Mob-shaped pet (per `looksLikeMobName`) → `roster.charm(base, owner)`
      with an ack that says the scope ("skeletal monk = Rhale (while charmed)");
      `= none` → `uncharm` (no notPets blacklist — a future "has been charmed" line is
      game truth and may re-map). Player-shaped pet → existing durable path unchanged.
- [x] `index.js` `handlePetCommand`: reversed-direction detection — left side is a proven
      friendly player AND right side is mob-shaped (`pets Rhale = a dark boned skeletone`,
      typed twice tonight) → pointed toast naming the direction ("Owner goes on the
      right: pet <Pet> = <Owner>"), refuse rather than auto-swap.
- [x] `index.js`: `pet ?` list output includes live charm mappings alongside petOwners.
- [x] `roster.js` `applyEvent` pet-owner: when the stripped pet name is mob-shaped, call
      `this.charm(key, owner)` instead of `petOwners.set(key, owner)` — the Master line
      from a mob-named pet is a charm report, not durable configuration. Named pets
      (Gann) unchanged.
- [x] `roster.js` `ownerOf` and `isCharmed`: suffix fallback — when the key ends in
      `' pet'`, also try the base name (charmedPets first, then petOwners/learned, so a
      settings-entered mob-named pet matches its suffixed lines too).
- [x] **Mapping writes are exclusive, not layered** (James: "pet mappings should override
      not additive"). Setting an owner for a pet name — typed command, Master line, or
      charm attribution — evicts that name from every *other* store, so `ownerOf`'s
      precedence order never has two answers to choose between. The hole today:
      `handlePetCommand` clears `learnedPetOwners` and `notPets` but not `charmedPets`,
      which `ownerOf` consults FIRST — a stale charm attribution silently outranks a
      command the player just typed and had acknowledged. One name, one owner; the newest
      explicit statement wins, and after an uncharm nothing stale resurfaces from a
      lower-precedence store.
- [x] `index.js`: handle `worn-off` — when `CHARM_SPELL_RE.test(ability)`, `uncharm(target)`
      and bump revision. Ignore all other spells.
- [x] Config hygiene: `emitPetOwners` must never persist mob-shaped names — the charm
      store is session-only by design, and the leak (Master-line learning into petOwners,
      then any successful command persisting the whole table) is how `"basilisk": "Rhale"`
      got into the live config. Existing saved entries are the user's visible settings and
      are not silently rewritten; the changelog tells James to delete `basilisk` from the
      pets box (or we remove it for him with his OK — one-line manual edit).
- [x] Tests — `rules.test.js`: worn-off event shape; the command accepts tonight's exact
      lines (`pets a skeletal monk = Rhale`) and still routes `pets Jektik = Khanvikt`
      as before. `roster.test.js` (or wherever roster is covered): suffix fallback;
      Master-line mob name lands in charmedPets not petOwners. Parser end-to-end: charm
      → plain and suffixed swings fold into the charmer; worn-off → the next monk swing
      at Rhale scores as damage taken, not friendly fire; commanded mob-name mapping
      folds and clears on `= none`.
- [x] Empirical check: replay tonight's slice (scratchpad `tonight.txt`, lines
      1665855–1689032 of the live log) before/after. The success metric is the
      seen-vs-scored ratio from scratchpad `audit-drops.mjs`: the 23:00 half-hour sits at
      67% today against 98–100% for the healthy hour — it should come up near parity.
      Spot-check 23:15–23:25 (the monk stretch, currently 2.0 group DPS over 2:56) and
      the 22:52/22:56 pet-titled encounters; confirm no encounter is titled after a
      mapped friendly pet and Rhale's charm damage lands in his row. Run
      `collect-unknown.js` to confirm no new unmatched forms.
- [x] Docs: changelog `docs/changelog/2026-08-13-charm-scoped-pet-mappings.md`; correct
      the CLAUDE.md sentence "the log has no charm-break message" (it has one for your
      own charm: the worn-off line); note the `" pet"` suffix in the entities/roster
      sections.

## Notes

- The suffix means "somebody's pet", never "our pet" — hostile pets carry it (22:41,
  `A dark boned skeleton pet hits YOU`). Nothing may fold a suffixed name by shape alone;
  folding happens only through an existing mapping, which is why the fix is a *lookup*
  fallback and not an entities.js resolution rule.
- `resolve()` already folds through `roster.ownerOf(entity.name)` and sets
  `isPet: true` on the result, so the suffix fallback needs no renderer or encounter
  changes.
- `attributeCharm` already works for James's own charms (`You begin casting Charm.`
  matches `CHARM_SPELL_RE`); the command remains the manual fallback for charmers whose
  cast the log can't place.
- Charm mappings are cleared on zone and reset (`clearCharms`), which matches charm
  mechanics; a commanded mapping is gone after zoning and must be retyped. Acceptable —
  and the ack text saying "(while charmed)" sets that expectation.
- Same-name plain collisions (hostile + charmed lurking mummy at 22:52) remain: while the
  charm is live, the hostile twin's damage will misread as friendly. Known, accepted,
  out of scope — but worth a sentence in the changelog so it isn't rediscovered as a bug.

## Execution notes (added on completion)

- Result: seen-vs-scored on the Aug 13 slice went 67% → 100% in the charm half-hour
  (100% everywhere); 49 encounters vs 40 (pets-only kills can now open fights); both
  pet-titled encounters gone; the 2:56 "skeletal monk" ghost fight became a 55.3-DPS
  dry-bone-skeleton fight plus an honest 16s monk fight where the charm actually broke.
  4 of the 5 live-log commands now parse; `pets PCT; = …` stays malformed on the `;`.
- The direction check tests article-or-spaces on the raw right side, NOT
  `looksLikeMobName` — a bare lowercase token ("kadomony") must still reach the
  capitalization-forgiving owner validation. Same on the pet side, judged on the RAW
  spelling because stripArticle removes the very evidence ("a basilisk").
- `emitPetOwners` got no output filter after all: with both learning paths routed to the
  charm store, the only mob-shaped petOwners entries left are user-typed settings, and
  filtering those on save would silently rewrite the user's own settings box. The
  invariant is documented on the method instead.
- `= none` still blacklists via notPets (which never gated the charm store), so a later
  "has been charmed" line re-maps honestly while summon-adjacency stays vetoed.
- James still needs to delete `"basilisk": "Rhale"` from his saved config (settings →
  pets box); the changelog says so.
