# Charm-scoped pet mappings: the charm group that blanked the meter

The Aug 13 evening session (an undead zone, the whole group running charm pets) scored
almost nothing on the pulls that mattered: a 2:56 fight shown at 2.0 group DPS, a 1:52
one at 0.7, while the group killed continuously. Replaying the slice with a
seen-vs-scored audit put the healthy hour at 98–100% of rule-matched damage scored and
the charm half-hour at **67%** — and the missing third was concentrated in exactly the
fights the player was watching. After this change the same slice scores 100% in every
half-hour, no encounter is titled after the group's own pet, and the five `pets …`
commands typed that night parse (four as commands, one still malformed on a stray `;`).

## What was wrong

Three mechanisms, compounding:

1. **Mob-named pet mappings had the wrong lifetime.** A charmed monk reports in under
   its plain mob name (`A skeletal monk told you, '… Master.'`), and that line wrote
   `skeletal monk → Rhale` into the durable `petOwners` table. Charm is transient; the
   mapping was not — after the charm broke, every hostile skeletal monk resolved to its
   ex-charmer, its swings read as friendly fire, and everyone's damage on it was
   dropped. The leak had already reached disk: the live config contained
   `"basilisk": "Rhale"`, a charm learned mid-session and persisted forever by a later
   unrelated `pets` command (which saves the whole table).

2. **The explicit charm-break line had no rule.** `Your Charm spell has worn off of a
   skeletal monk.` is the log stating the end of your own charm outright; the parser
   waited for the freed mob's first swing at its ex-master instead, and everything in
   between was misread.

3. **The `" pet"` suffix was unknown.** EQ Legends writes every pet that is not your own
   as `<base> pet` (1,354 such lines that night, hostile necromancers' pets included),
   while the charm line, the Master report and the typed command all use the plain base
   name — so a party member's charm mapping never matched a single line their pet
   actually produced. The pet stayed a mob-shaped stranger; two encounters were titled
   after the group's own charm tanks.

On top of that, the `pets` command's captures were `[A-Za-z]{2,32}` — one token, no
spaces — so `pets a skeletal monk = Rhale` (typed twice, correctly) fell to the
malformed rule, which answered with the very syntax the player was already following.

## What changed

**The unifying rule: a mob-shaped pet name is evidence of a charm, and charm is
transient.** Every path that learns one converges on the charm store; every path that
ends one tears it down; and mapping writes override, they do not layer.

- `rules.js` — new `worn-off` rule for `Your <Spell> spell has worn off of <Target>.`
  (fires for every spell; charm-ness is judged in the parser). The `pet-command-set`
  captures are now loose (`PET_NAME`: letters, spaces, backticks) with all validation
  moved to the handler; the anchors and the mandatory `=` still keep chatter out.
- `index.js` — `handleWornOff` uncharms when the faded spell is charm-like.
  `handlePetCommand` accepts mob-shaped pet names and routes them to
  `roster.charm()` (acknowledged as "X = Y (while charmed)" so the lifetime is
  explicit), strips the game's `" pet"` marker from typed names, answers a reversed
  `pets <Player> = <mob>` with a direction hint instead of the generic syntax line,
  clears every store on `= none`, and evicts a live charm entry when setting a durable
  player-shaped mapping. `pet ?` lists live charms, labelled.
- `roster.js` — the Master-line `pet-owner` path routes mob-shaped names to the charm
  store (named summons like `Gann` keep the durable path). `charm()` evicts the name
  from the durable and learned tables; `ownerOf`/`isCharmed` fall back from `<base> pet`
  to `<base>` — one direction only, so a binding recorded *against* a suffixed name
  (summon adjacency on somebody's animation) never claims the plain wild mob.
- `entities.js` — `stripPetSuffix`, with the warning that the suffix means "somebody's
  pet", never whose, and must not fold anything by shape.
- `setup.js` — the pets-in-force list labels a live charm "charmed right now" rather
  than presenting it as a durable binding.

Because mob names no longer enter `petOwners` in-session at all, `emitPetOwners` needs
no output filter — the only mob-shaped entry that can exist there is one the user put in
their own settings, and filtering would have silently rewritten their settings box.

**Config note for existing installs:** a leaked entry may already be saved. James's
config carries `"basilisk": "Rhale"` — delete it from the pets box in settings (it now
does exactly what it says: every wild basilisk anywhere folds into Rhale).

## What is deliberately unchanged

- The scoring axis. Damage on the engaged mob counts whoever landed it; there is still
  no friend test in the scoring path. This change is entirely about *identity* — which
  row, what a pull is against, which direction a line reads after a charm ends.
- Same-name collisions. A hostile lurking mummy and a charmed one fought in the same
  second that night; the log carries no instance identity, so while a charm is live the
  hostile twin's lines misread as friendly. Known, accepted, same class as "a fire
  giant warrior cleaves a fire giant warrior".
- A commanded mob-name mapping dies on zone/reset with the rest of the charm store.
  That is the correct lifetime for a charm, and the acknowledgement says so.

## Verification

- 726 tests pass, including new coverage: the worn-off rule and its pet-buff
  non-match; the loosened command on the exact live-log lines; charm-scoped Master-line
  learning; suffix fallback in both stores and its one-way direction; override
  semantics (command beats stale charm attribution, uncharm leaves nothing stale
  underneath); the direction hint; clear-then-recharm.
- Replay of the Aug 13 slice: seen-vs-scored 67% → 100% in the charm half-hour,
  100% elsewhere; 49 encounters (was 40 — pets-only kills can now open fights); the
  2:56 "skeletal monk" ghost fight is now a 55.3 DPS fight against the actual dry bone
  skeletons plus an honest 16-second monk fight exactly where the charm broke; both
  pet-titled encounters are gone; unmatched lines fell by exactly the 19 worn-off
  lines. No new unmatched shapes.
