# Charmed pet attribution

**Date:** 2026-07-31

Charmed mobs now count toward whoever charmed them. Previously their damage was
discarded entirely.

## The problem

A charmed mob keeps its mob name (`a tal ghoul wizard`), so it failed the player-name
test, was never in the roster, and hit only other mobs. Both sides of the exchange looked
hostile, so `handleDamage` dropped it. The log records the damage plainly —
`A tal ghoul wizard slashes a ghoul savant for 40 points of damage.` and a 148-point
`Lightning Bolt` — and none of it was being counted.

## What the log gives us

Established by reading a 23,471-line session rather than by assumption:

- **Charm lands:** `a tal ghoul wizard has been charmed.` — 4 occurrences. Names the mob
  but **not** the caster.
- **The caster** is only inferable from a nearby `Rhain begins casting Beguile.`
- **Charm breaks:** *no message whatsoever.* Grepping every charm-related line in the
  session returns only the four "has been charmed" lines.
- **Mez is a separate thing:** `a shin ghoul knight has been mesmerized.` (119
  occurrences). A mezzed mob is asleep, not fighting for you, and must never be treated
  as charm.

## Implementation

- **Attribution by spell name, not by cast proximity.** Several people are casting at
  once — the sample has `Emalina begins casting Greater Healing V.` immediately before
  `Rhain begins casting Beguile.` — so "the only caster in flight" fails. Matching the
  spell name against a charm-spell pattern picks Rhain unambiguously. With no charm spell
  in flight, nobody is credited.
- **Break inference.** A charmed mob resolves to its owner, who is friendly, so a
  "friendly hits friendly" line involving a charmed mob can only mean the charm broke.
  That covers both directions — the ex-pet turning on the group and the group turning on
  it — and the triggering line is re-handled so its damage is not lost. Death and zoning
  also end a charm.
- **Charms kept separate from `petOwners`.** The two have opposite lifetimes: configured
  pet ownership is durable, a charm lasts seconds. Separating them means editing settings
  cannot disturb a live charm, and a breaking charm cannot delete the user's settings.
- **One charm per charmer** — landing a new one releases the old.
- **Cast-table TTL raised to 10s**, with each consumer filtering to its own window (2s for
  stray non-melee, 8s for charm). Charm has a cast time, so the old 2s prune deleted the
  Beguile entry before the charm line arrived.

## Bug fixed

**Mob-named pets could never be mapped at all.** `petOwners` keys were stored verbatim
while every lookup arrives article-stripped, so an entry like `a tal ghoul wizard = Rhain`
silently did nothing. Keys are now normalized on the way in. This also affected the
automatic self-pet mapping for any pet whose name carries an article.

## Verification

- 134 tests pass, including charm attribution, mez-is-not-charm, break in both
  directions, death, zoning, one-charm-per-charmer, and mob-vs-mob still being ignored.
- Measured A/B over the real session: **3,813 damage recovered, 1.5% of the group total**,
  all of it Rhain's. In the fights where charm was actually up it is far more — 2,076 of
  his 6,773 in one encounter.

## Known limitations

Mob names are generic, so with two `a tal ghoul wizard` up and one charmed, the other's
damage is credited too. And since a break is only noticed on the next relevant line, a few
swings after a silent break can land on the charmer. Both are consequences of what the log
does and does not say, and are documented in the README.
