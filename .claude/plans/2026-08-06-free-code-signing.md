---
status: created
---
# Free code signing: get past SmartScreen without buying a certificate

**Date:** 2026-08-06

---

## Goal

Today the portable exe is unsigned. `README.md` says so out loud — *"It is **not
code-signed**, so Windows SmartScreen shows 'Windows protected your PC' on first run:
More info → Run anyway. Signing needs a paid certificate."* That last sentence is the
thing being tested here: **there is a genuinely free path, and this project is unusually
well positioned to take it.**

Signing buys three things, in descending order of how much they matter here:

1. **The friend stops seeing "Windows protected your PC."** One click today, but the
   auto-update plan (`.claude/plans/2026-08-05-auto-update.md`) turns one artifact into a
   release cadence, and every *portable* download re-earns the warning.
2. **Antivirus false positives drop.** An unsigned, self-updating NSIS installer that
   rewrites its own install directory is textbook heuristic bait — the auto-update plan
   rejected a roll-your-own updater partly for this reason. Signing is the single most
   effective mitigation.
3. **`electron-updater` gets a real signature to verify.** On Windows it checks the
   installer's `publisherName` against the value baked into `app-update.yml` before
   running it. Unsigned, that check is skipped; signed, a tampered update is rejected.

Scope: **Windows only.** There is no macOS or Linux target and no plan for one — Apple's
$99/yr Developer Program is the only route to notarization there and it is not in
question.

Constraint carried in from `CLAUDE.md`: **no native modules, ever.** Every option below
is either a config change, a hosted service, or a CI step, so the invariant is safe.
The two-worlds setup also has to survive — `scripts/dev.sh dist` must keep working
unchanged for local iteration, whatever happens to release builds.

## Approaches Considered

### 1. SignPath Foundation — free OV certificate for open-source projects
- **Description:** SignPath Foundation is a nonprofit that sponsors code signing for
  qualifying OSS. Approved projects sign through the SignPath platform against a Sectigo
  OV certificate; a GitHub Action submits the built artifact from CI and gets the signed
  artifact back. Eligibility, from
  [their terms](https://signpath.org/terms.html): OSI-approved license, no commercial
  dual-licensing, public repository, actively maintained, no proprietary components, MFA
  on both SignPath and GitHub, a published code-signing policy naming the project's
  authors/reviewers/approvers, and — the load-bearing one — **binaries must come from
  verifiable automated builds from source**, i.e. a public CI pipeline, not a laptop.
- **Pros:** Actually free, permanently, with no card on file. The certificate is issued
  to *SignPath Foundation*, an identity shared across many well-known OSS projects, so it
  arrives carrying **existing SmartScreen reputation** rather than starting at zero —
  which is the part a fresh $500 OV certificate cannot buy. Signs in CI with no hardware
  token and no key on any machine. Moving releases to GitHub Actions is a genuine
  side-benefit: it kills the "the build fails while the overlay is running (locked
  files)" dance documented in `CLAUDE.md`.
- **Cons:** Requires the repo to be **public with an OSI license** — public is already
  decided (the auto-update plan records the confirmation), a license file is not. Requires
  **moving release builds to GitHub Actions**, which is real work and a second build path
  to keep honest. Application is human-reviewed and takes **days to weeks**; a five-day-old
  repo with no releases and no users is a plausible rejection — their terms want "actively
  maintained" and "already released" projects. The publisher string users see is
  "SignPath Foundation", not "James Savko". Post-build signing breaks `latest.yml`'s
  checksum unless handled (see Notes).

### 2. Azure Artifact Signing (formerly Trusted Signing) — $9.99/month
- **Description:** Microsoft's own signing service. Identity is verified once, then
  short-lived certificates (~72h) are minted on demand from a Microsoft CA that Windows
  already trusts. `electron-builder` has first-class support via `win.azureSignOptions`
  (`endpoint`, `codeSigningAccountName`, `certificateProfileName`, `publisherName`), so
  it signs *during* packaging — `latest.yml` is generated from the already-signed file
  and the auto-update plan needs no rework.
- **Pros:** By far the least engineering. No repo visibility requirement, no license
  requirement, no CI requirement — it can sign straight from the existing
  `dev.sh dist` on the Windows side with three environment variables. Microsoft-issued
  certificates carry strong SmartScreen standing. The publisher name is *James's own*.
  Individual (non-company) accounts are open in the **US and Canada**.
- **Cons:** **Not free** — $9.99/mo, ~$120/yr, forever, for an app with one other user.
  Requires an Azure subscription and an Entra app registration; several developers have
  hit surprise licensing walls setting up roles. Geographic eligibility must be confirmed.
  Rebranded mid-flight (Trusted Signing → Artifact Signing), so half the documentation on
  the internet is stale.

### 3. Microsoft Store (MSIX) — free registration, Microsoft signs the package
- **Description:** Individual developer registration for the Microsoft Store became free
  in September 2025 (company registration followed in May 2026). Store-distributed
  packages are **re-signed by Microsoft** after certification, which means zero warnings
  and zero certificate cost. `electron-builder` has an `appx` target; Win32/Electron apps
  are explicitly supported by the Store.
- **Pros:** Free with no eligibility hurdles beyond store policy. Perfect SmartScreen
  outcome — Microsoft's own signature. Store-managed updates could replace
  `electron-updater` entirely.
- **Cons:** Replaces the distribution channel wholesale and **guts the auto-update plan**
  a day before it ships. Every release waits on certification review (days), which is the
  opposite of "cut a release with one command". MSIX runs under filesystem/registry
  virtualization — a log-tailing, always-on-top, click-through, global-hotkey overlay is
  exactly the shape of app that finds MSIX's edges, and each one would need proving. And
  the policy risk is real and unquantified: this is a third-party overlay that reads
  another company's game's log files and carries its trademark in the product name. A
  rejection after all that work costs the most of any option here.

### 4. Self-signed certificate
- **Description:** Generate a certificate with PowerShell's `New-SelfSignedCertificate`,
  sign with it, and have each user import it into Trusted Root / Trusted Publishers.
- **Pros:** Free, immediate, entirely under local control.
- **Cons:** **Does not solve the problem.** SmartScreen is reputation-based, not merely
  validity-based; an unknown certificate has no reputation and the blue box still appears.
  It only stops "Unknown publisher" *after* the user manually installs a root certificate
  — asking a friend to add a root CA to their machine is a worse ask than "click More
  info", and it teaches exactly the wrong security habit. Signing theater.

### 5. Certum Open Source Developer certificate — ~€69 first year, ~€29/yr after
- **Description:** The cheapest real OV certificate: Certum issues to individuals with
  `Organization = "Open Source Developer"` after ID verification, delivered on a
  cryptographic smartcard (reader + card ~€85 one-off, or a cloud-signing variant from
  ~$116).
- **Pros:** Cheap for a real certificate in the developer's own name. No CI requirement.
- **Cons:** Not free, which is the whole question. Identity verification means a notary or
  an in-person visit and a physical token in the mail. **A hardware token cannot sign from
  CI** and must be plugged into the Windows machine at build time — friction on every
  single release, forever, in a build that already crosses a WSL/Windows boundary. Starts
  at zero SmartScreen reputation, so the warnings do not stop on day one anyway.

### 6. Status quo — stay unsigned, spend the one click
- **Description:** Ship the auto-update plan as written. The friend clicks through
  SmartScreen once on the Setup installer; every subsequent auto-update is downloaded by
  `electron-updater` and installed silently with no mark-of-the-web and no warning.
- **Pros:** Zero cost, zero work, zero new failure modes. Already the documented plan.
  For an audience of exactly one known person, the warning is a 5-second conversation.
- **Cons:** Portable-exe users re-earn the warning on every manual download. Does nothing
  about antivirus false positives on a self-updating unsigned installer, which is the
  failure mode that actually costs an evening to diagnose. `electron-updater`'s signature
  verification stays off. And the answer to "isn't there a free way?" is left as no when
  it is in fact yes.

## Chosen Approach

**Approach 1 — SignPath Foundation — applied for now and wired in when approved, with
approach 6 as the standing behavior until then and approach 2 as the fallback if the
application is rejected.**

The reasoning:

- The question asked was specifically about *free*, and SignPath is the only option that
  is free, permanent, and yields a certificate the Windows ecosystem already trusts. Store
  distribution is also free but costs the auto-update design; everything else costs money.
- **Its two hard prerequisites are already on the roadmap or nearly free.** The repo goes
  public in the auto-update plan's first task. An MIT `LICENSE` file is a five-minute
  addition to a personal project with no commercial intent. That is the entire delta most
  projects find prohibitive.
- **The shared-identity reputation is the real prize.** Buying a certificate — at any of
  these price points — gets a valid signature with *no reputation*, and SmartScreen keeps
  warning until downloads accumulate, which for a niche raid overlay with one user is
  never. SignPath Foundation's certificate is used across many published OSS projects and
  arrives with that history attached. A free option that works better than a paid one is
  not a compromise.
- **The CI requirement is a feature disguised as a cost.** `CLAUDE.md` documents that the
  dist build fails while the overlay is running, so shipping means quitting mid-game. A
  GitHub Actions Windows runner removes that entirely, and `dev.sh dist` stays exactly as
  it is for local iteration — additive, not a replacement, so the two-worlds setup is
  untouched.

Sequencing matters because approval latency is the long pole:

- **Apply first, build second.** The application goes in before the CI work, so review
  runs in parallel with everything else.
- **Do not block the auto-update plan on this.** That plan ships unsigned exactly as
  written; the friend spends the one documented click. Signing lands afterwards as a
  release that quietly stops the warnings.
- **If rejected** (the honest risk: a young repo with no user base), fall back to Azure
  Artifact Signing at $9.99/mo — and the GitHub Actions pipeline built in the meantime is
  not wasted, since `azureSignOptions` slots into the same workflow with three secrets.
  Re-applying to SignPath after a few months of releases and some actual users is also a
  perfectly good move.

## Tasks

**Phase 0 — prerequisites (also unblocks the auto-update plan)**

- [ ] Confirm the repo is public: `gh repo edit jsavko/eq-legends-dps-overlay --visibility
      public --accept-visibility-change-consequences`. Shared with the auto-update plan —
      whichever runs first satisfies both. Skim git history for anything accidental before
      flipping (the auto-update plan makes the same point; it is irreversible).
- [ ] Add a root `LICENSE` file — **MIT** unless there's a reason to prefer otherwise.
      SignPath requires an OSI-approved license with no commercial dual-licensing.
      Add the matching `"license": "MIT"` field to `package.json`.
- [ ] Add `docs/code-signing-policy.md` and link it from `README.md`: who the authors,
      reviewers and approvers are (all James, stated plainly — solo projects are fine),
      how artifacts are built and signed, and the attribution line SignPath Foundation
      requires ("Free code signing provided by SignPath.io, certificate by SignPath
      Foundation").
- [ ] Confirm MFA is enabled on the GitHub account (`gh api user` won't show it — check
      github.com/settings/security). Required by SignPath's terms.
- [ ] `README.md`: make sure the build instructions are followable by a reviewer who has
      never seen the two-worlds setup — the reviewer's job is to convince themselves the
      binary comes from this source.

**Phase 1 — apply (do this early; approval takes days to weeks)**

- [ ] Submit the application at https://signpath.org/apply with: repository URL, license,
      download URL (the GitHub Releases page), and a description covering what the app
      does, who it's for, and that the signed artifacts are a Windows NSIS installer and a
      portable exe. Be explicit that it reads a game's own chat log file and makes no
      network calls beyond GitHub release checks — a "game overlay" reads as adjacent to
      the tooling category SignPath refuses ("hacking tools… circumvent security
      measures"), and pre-empting that reading is worth two sentences.
- [ ] Record the application date here in Notes so the wait is measurable.

**Phase 2 — move release builds to GitHub Actions (start while waiting; useful signed or not)**

- [ ] `.github/workflows/release.yml` on `windows-latest`, triggered on tag push
      (`v*`) and `workflow_dispatch`: checkout, setup-node, `npm install` (no lockfile
      exists — see Notes), `npx electron-builder --win`, upload the artifacts.
- [ ] Verify the CI build produces byte-comparable output to `dev.sh dist` — same targets,
      same `artifactName`s, same icon. Any divergence is a bug to fix before signing is
      layered on.
- [ ] Remove `"signAndEditExecutable": false` from `package.json`'s `build.win`. It has
      been there since the first commit with no recorded reason and it disables `rcedit`
      resource embedding as well as signing — **check first whether the current exe
      actually carries `src/assets/icon.ico`**; if it does, something else is applying it
      and the flag is inert, and if it doesn't, this fixes a live cosmetic bug on the way
      past.
- [ ] Decide how the workflow publishes: extend the auto-update plan's `dev.sh release`
      to just push a tag, or have the workflow itself create the GitHub Release with
      `gh release create`. Prefer the latter — one command, one source of truth, and no
      artifacts crossing the WSL boundary.

**Phase 3 — wire signing in (once approved)**

- [ ] Add the SignPath organization/project/signing-policy IDs and an API token as
      repository secrets; enable the SignPath GitHub App on the repo.
- [ ] Add `signpath/github-action-submit-signing-request` to the workflow between build
      and publish, for **both** the NSIS Setup exe and the portable exe.
- [ ] **Fix the `latest.yml` ordering problem** (see Notes — this is the one that silently
      breaks auto-update). Either sign inside the build via `electron-builder`'s custom
      `win.sign` hook so the manifest hashes an already-signed file, or regenerate
      `latest.yml`'s `sha512` and `size` from the signed artifact before publishing.
      Prefer the custom-sign hook; keep the regeneration script as the fallback.
- [ ] Set `build.win.publisherName` to exactly the signed subject (**"SignPath
      Foundation"**, not "James Savko"). `electron-updater` compares this against the
      downloaded installer's signature and **refuses the update if it disagrees** — get
      this wrong and auto-update stops working with a confusing error.
- [ ] Verify end to end on a Windows machine: `signtool verify /pa /v` on both artifacts,
      then download the Setup exe through a browser (so it carries mark-of-the-web) and
      confirm what SmartScreen does. Then confirm an actual `0.x.y → 0.x.y+1` auto-update
      completes against the real release.

**Phase 4 — document**

- [ ] `README.md`: replace *"Signing needs a paid certificate"* with what actually
      happens, and add the SignPath Foundation attribution.
- [ ] `CLAUDE.md`: document the CI release path alongside `dev.sh dist`, and note that
      `publisherName` is load-bearing for auto-update.
- [ ] `docs/changelog/YYYY-MM-DD-code-signing.md`, dated the day it ships.
- [ ] Archive this plan to `.claude/plans/archive/`.

## Notes

- **The `latest.yml` gotcha, stated plainly.** `electron-builder` writes `latest.yml`
  with a `sha512` of the installer *as it existed when packaging finished*. A GitHub
  Action that signs afterwards mutates the file, so the hash in the manifest no longer
  matches and `electron-updater` rejects every update with a checksum error — after the
  release is already public. Signing during the build via the custom `win.sign` hook
  avoids the whole class; regenerating the manifest post-signing also works but is one
  more script that has to stay correct. This is the single highest-risk detail in the
  plan.
- **`publisherName` is the second tripwire.** Same failure shape: everything looks fine
  until a real update is attempted, then it fails for a user who cannot debug it.
- **No lockfile exists** (verified 2026-08-06, same finding as the auto-update plan). CI
  will therefore use `npm install`, not `npm ci`. Worth adding `package-lock.json` at some
  point for reproducible builds — SignPath's reviewers care about build verifiability, and
  a lockfile is the cheapest signal of it — but it is not a blocker.
- **Relationship to the auto-update plan:** strictly sequential, not entangled. Ship
  auto-update unsigned as written; this plan removes the SmartScreen click it documents as
  acceptable. The repo-goes-public task is genuinely shared — do it once.
- **Open question for James:** MIT for the `LICENSE`, or something else? MIT is assumed
  above. This is the only decision in Phase 0 that isn't already made.
- **Eligibility risk, named honestly:** the repo is five days old, has zero stars, no
  releases, and one known user. SignPath's terms specify no popularity threshold, but they
  do require "actively maintained" and "already released", and review is human. Shipping
  the auto-update plan first — which creates a real GitHub Releases page with real
  artifacts — measurably improves the application. Consider applying *after* 0.6.0 is
  released rather than before, trading a week of latency for a better-looking application.
- **Azure fallback specifics**, if it comes to that: individual (non-company) Public Trust
  eligibility is limited to the **US and Canada** — confirm before counting on it.
  `electron-builder` v25 already supports `win.azureSignOptions`, so the change is config
  plus `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`, and it signs during
  packaging, which sidesteps the `latest.yml` problem entirely.
- **What signing does not fix:** SmartScreen reputation is partly per-file. A brand-new
  binary signed with a well-established certificate is *much* less likely to warn, but
  "never warns from day one" is not a promise anyone can make. The antivirus
  false-positive reduction and the `electron-updater` verification are the guaranteed
  wins.

## Sources

- [SignPath Foundation conditions for Open Source projects](https://signpath.org/terms.html)
- [SignPath for Open Source Projects](https://signpath.io/solutions/open-source-community)
- [Applying for the SignPath Foundation: Free Code Signing for OSS](https://zenn.dev/shm_7ec/articles/signpath-oss-code-signing?locale=en)
- [Azure Artifact Signing (formerly Trusted Signing)](https://azure.microsoft.com/en-us/products/artifact-signing)
- [Trusted Signing is now open for individual developers](https://techcommunity.microsoft.com/blog/microsoft-security-blog/trusted-signing-is-now-open-for-individual-developers-to-sign-up-in-public-previ/4273554)
- [electron-builder: Code Signing for Windows](https://www.electron.build/code-signing-win)
- [Free developer registration for individual developers on Microsoft Store](https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/)
- [Publish to Microsoft Store as a company — now with free registration](https://blogs.windows.com/windowsdeveloper/2026/05/07/publish-to-microsoft-store-as-a-company-now-with-free-registration-and-faster-onboarding/)
- [SmartScreen reputation for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [Certum Open Source Code Signing](https://certum.store/open-source-code-signing-code.html)
