---
status: created
---
# Sign Windows builds with Azure Artifact Signing

**Date:** 2026-08-14

---

## Goal

Get the release artifacts (`EQL-DPS-Overlay-Setup-<ver>.exe`, the portable exe, and the
app exe inside them) code-signed so users stop hitting SmartScreen "unknown publisher"
warnings on every release, and so electron-updater downloads can be signature-verified.

First, the question that prompted this: **Azure Artifact Signing (formerly Trusted
Signing) is NOT free.** The facts as of August 2026:

- **Basic plan: $9.99/month** — 5,000 signatures/month, 1 certificate profile. (Premium
  is $99.99/mo for 100k signatures — irrelevant at our volume; a release signs a
  handful of files.)
- It **requires a paid Azure subscription** (pay-as-you-go or EA). Free trial, Student,
  and sponsored subscriptions are rejected at account creation.
- The monthly fee is **not pro-rated** — you're billed the full month from account
  creation regardless of usage.
- **Individuals in the USA and Canada can sign up** (orgs additionally in EU/UK).
  Individual identity validation runs through Microsoft Entra Verified ID: a
  government-issued photo ID with your address on it, plus a selfie/FaceCheck in the
  Microsoft Authenticator app. Validation can take days and expires yearly (renewal
  reminders start 60 days out).
- The certificate's CN is **your validated legal name** — "James Savko", not
  "EQL DPS Overlay". No custom CN/O allowed.
- Certificates are short-lived (rotated every ~3 days) and issued fresh at signing
  time; you never hold the key. Signatures are timestamped, so they outlive the cert.
- Not EV. SmartScreen reputation still accrues per publisher identity, which is the
  entire point: today every release's unsigned exe starts reputation from zero
  (hash-based); a signed release inherits the identity's accumulated reputation.

So the real cost is ~$120/year plus a one-time identity-validation dance. Cheap by
code-signing standards, not free.

## Approaches Considered

### 1. Azure Artifact Signing via electron-builder `azureSignOptions`
- **Description:** Create an Artifact Signing account (Basic) + Individual identity
  validation + Public Trust certificate profile in Azure. electron-builder signs during
  the Windows-side build: the installed 25.1.8 already ships
  `windowsSignAzureManager.js`, which auto-installs the `TrustedSigning` PowerShell
  module (pinned 0.4.1) and calls `Invoke-TrustedSigning` per file. Auth is a service
  principal via env vars (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`).
- **Pros:** No key custody (nothing to lose or leak beyond a revocable client secret);
  no hardware token — works headless in the existing `dev.sh dist` flow; supported
  natively by the electron-builder version already installed; durable publisher
  identity for SmartScreen.
- **Cons:** $9.99/mo forever + paid Azure subscription; identity validation friction;
  cert says "James Savko" not the app name; env vars must cross the WSL→cmd.exe
  boundary; US/Canada-only for individuals.

### 2. Traditional OV certificate from a CA (Certum, SSL.com, DigiCert…)
- **Description:** Buy a 1–3 year OV code-signing cert; since June 2023 the key must
  live on a hardware token or in the CA's cloud HSM. Sign via `win.signtoolOptions`.
- **Pros:** One-time-ish cost (Certum's open-source cert is ~€70/yr, mainstream CAs
  $200–400/yr); no Azure dependency.
- **Cons:** Hardware token breaks the unattended `dev.sh dist` flow (PIN prompt per
  file) or cloud-HSM per-signature fees; identity validation is no lighter; comparable
  or higher yearly cost than Artifact Signing with more moving parts.

### 3. SignPath.io free open-source tier
- **Description:** SignPath donates signing (their cert, or a cert they manage) to
  approved open-source projects; signing runs through their service, normally wired
  into CI.
- **Pros:** Actually free.
- **Cons:** Requires OSS approval and their process; built around CI pipelines, not a
  local WSL→Windows hand-rolled build; publisher identity is theirs to govern; approval
  is discretionary and revocable. A lot of process for a hobby overlay.

### 4. Stay unsigned (status quo)
- **Description:** Keep shipping unsigned; users click through SmartScreen.
- **Pros:** Free.
- **Cons:** Every release is a brand-new unknown hash, so the warning never goes away;
  some users will be scared off; electron-updater downloads are integrity-checked
  (sha512 from latest.yml) but not publisher-verified.

## Chosen Approach

**Approach 1 — Azure Artifact Signing**, contingent on James deciding $9.99/mo is worth
it (that's a standing cost, not a code decision — nothing below gets built until he
says go). It's the only option that is simultaneously headless (fits `dev.sh
dist`/`release` untouched in shape), token-free, and supported by the exact
electron-builder already installed on the Windows side. Verified empirically:
`app-builder-lib` 25.1.8 in `C:\eqoverlay-dev\node_modules` contains the Azure signing
manager, so no dependency change is required to start.

Design decisions within the approach:

- **Sign on `dist`/`release` only; `pack` stays unsigned.** electron-builder *fails the
  build* if `azureSignOptions` is set but the AZURE_* env vars are absent, so the
  everyday `pack` must not carry the config. Solution: move the `build` block from
  `package.json` into `electron-builder.config.mjs` (ESM matches the repo) that adds
  `win.azureSignOptions` only when `AZURE_TENANT_ID` is set. No native modules, no new
  deps — honors the repo invariant.
- **Secrets live WSL-side, git-ignored** (e.g. `~/.config/eqoverlay/signing.env`),
  sourced by `dev.sh` in the `dist`/`release` branches and forwarded across the
  WSL→Windows boundary with `WSLENV` (`AZURE_TENANT_ID/w:AZURE_CLIENT_ID/w:...`) —
  cmd.exe children don't inherit WSL exports otherwise.
- **Updater verification is a follow-up check, not a blocker.** electron-updater
  verifies a download's publisher only if `publisherName` lands in app-update.yml. In
  25.1.8, `azureSignOptions` passes unknown extra fields straight to
  `Invoke-TrustedSigning` (where a stray `-publisherName` would error), so verify
  whether 25.1.8 derives the publisher for app-update.yml; if not, upgrading to
  electron-builder ^26 (which has an explicit `azureSignOptions.publisherName`) is the
  fix. Either way sha512 verification keeps working, and the unsigned→signed
  transition release is safe: the *installed* (old, unsigned) copy carries no
  publisherName to check against.

## Tasks

Azure-side (manual, James, in the portal — roughly an afternoon plus validation wait):
- [ ] Upgrade/confirm a pay-as-you-go Azure subscription; register the
      `Microsoft.CodeSigning` resource provider on it
- [ ] Create an Artifact Signing account, **Basic** SKU, in a supported region (note
      the region — it fixes the endpoint, e.g. East US → `https://eus.codesigning.azure.net`)
- [ ] Assign yourself the "Artifact Signing Identity Verifier" role, then complete an
      **Individual** identity validation (gov photo ID with address + Microsoft
      Authenticator Verified ID FaceCheck; wait for status **Completed**)
- [ ] Create a **Public Trust** certificate profile bound to that validation
- [ ] Create an Entra app registration + client secret; grant it the "Artifact Signing
      Certificate Profile Signer" role on the signing account

Repo-side (code, after the above exists):
- [ ] Write `~/.config/eqoverlay/signing.env` (chmod 600): `AZURE_TENANT_ID`,
      `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, plus `ARTIFACT_SIGNING_ENDPOINT`,
      `ARTIFACT_SIGNING_ACCOUNT`, `ARTIFACT_SIGNING_PROFILE`
- [ ] Move the `build` block from `package.json` into `electron-builder.config.mjs`;
      add `win.azureSignOptions = { endpoint, codeSigningAccountName,
      certificateProfileName }` from env, only when `AZURE_TENANT_ID` is present
- [ ] `scripts/dev.sh`: in `dist` and `release`, source `signing.env` if it exists and
      export `WSLENV` so the AZURE_*/ARTIFACT_* vars reach `npm.cmd` through cmd.exe;
      print a loud "building UNSIGNED" note when the file is absent
- [ ] Check 25.1.8's app-update.yml: does a signed build embed `publisherName`? If not,
      evaluate the electron-builder ^26 upgrade for `azureSignOptions.publisherName`
      (test suite + a `pack` smoke test before adopting)
- [ ] Cut a test `dist`; verify with `signtool verify /pa /v` on the Setup exe, the
      portable exe, and `win-unpacked\EQL DPS Overlay.exe`; confirm the Properties →
      Digital Signatures tab shows "James Savko" with a timestamp
- [ ] Install the signed Setup build over an existing install and confirm
      electron-updater still updates cleanly from a prior unsigned version
- [ ] `docs/changelog/2026-08-XX-signed-builds.md` documenting the account names,
      endpoint, env-file location, and the pack-unsigned/dist-signed split

## Notes

- **Blocked on a money decision first:** $9.99/mo + a paid Azure sub is the ante.
  Nothing in the task list starts until James confirms.
- First build on a given Windows user profile will run
  `Install-Module TrustedSigning 0.4.1` (CurrentUser scope) automatically; the module
  needs a .NET runtime on the Windows side — if `Invoke-TrustedSigning` fails silently,
  check .NET 6/8 runtime presence (it's in the service's own troubleshooting table).
- Each signed file costs one signature from the 5,000/month pool; a `dist` signs ~4–6
  files (app exe, uninstaller, Setup exe, portable). No realistic quota risk.
- The winCodeSign/rcedit symlink workaround in `dev.sh` is unrelated and untouched —
  Azure signing goes through PowerShell, not signtool from that bundle.
- SmartScreen prompts don't vanish on day one even signed; reputation accrues to the
  certificate identity and then persists across releases (the FAQ documents this, and
  a file can be submitted to Microsoft Security Intelligence to nudge it).
- If the identity-validation address check fails against the billing address, the FAQ's
  `az billing account update` incantation fixes formatting mismatches the portal can't.
- Rename gag to be aware of when reading docs: Azure Code Signing → Trusted Signing →
  Artifact Signing. The PowerShell module (`TrustedSigning`), the Stack Overflow tag,
  and the `codesigning.azure.net` endpoints all still wear older names.
