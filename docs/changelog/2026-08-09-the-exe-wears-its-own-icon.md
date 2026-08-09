# The exe wears its own icon

**2026-08-09**

Shortcuts made by the installer showed the Electron logo instead of the app's icon. The
tray icon was always right, which is the clue: that one is set at runtime from a PNG and
never touches the executable's resources.

---

## What was actually wrong

`win.signAndEditExecutable: false`, present in `package.json` since the very first commit.
With executable editing off, electron-builder never stamps the icon or the version strings
into the exe, so it keeps Electron's own — and NSIS builds every Start Menu and desktop
shortcut from the exe's embedded icon.

The icon asset was never the problem. `src/assets/icon.ico` is a proper multi-resolution
file (16, 24, 32, 48, 64, 128, 256) and `win.icon` pointed at it correctly the whole time.

Simply removing the flag makes the build **fail**:

```
ERROR: Cannot create symbolic link : A required privilege is not held by the client.
  : ...\Cache\winCodeSign\<n>\darwin\10.12\lib\libcrypto.dylib
• Above command failed, retrying 3 more times
```

which is presumably why it was set in the first place. `rcedit-x64.exe` — the tool that
stamps the icon — ships inside electron-builder's `winCodeSign` bundle, and that bundle
also carries a macOS OpenSSL build whose `.dylib` entries are symlinks. Creating a symlink
on Windows needs a privilege an ordinary account does not hold unless Developer Mode is on,
so the archive cannot be unpacked, so there is no rcedit, so the build dies.

Worth knowing: this is not avoidable by going around electron-builder. `app-builder rcedit`
downloads the same bundle and fails the same way — rcedit only exists inside it.

## The fix

`scripts/dev.sh` now unpacks that bundle itself, before `dist` and `release`, with
`-xr!darwin`. Dropping the macOS tree drops every symlink in the archive; nothing built here
targets macOS, so those files could not be used even if they unpacked. It is idempotent —
the archive is fetched, and unpacked, only when `rcedit-x64.exe` is not already present —
and it fails loudly rather than silently proceeding to a build that would produce the wrong
icon again.

With the tool available, `signAndEditExecutable` is simply removed and electron-builder does
the stamping natively. No hook, no extra dependency.

An `afterPack` hook was written first and then deleted: it needed the same bundle, so it
solved nothing and only added a moving part.

**Enabling Windows Developer Mode is the other fix** and needs no script at all — it grants
the symlink privilege, after which electron-builder unpacks the bundle itself. It is left as
the alternative rather than the answer because it is a per-machine OS setting, and anyone
else building this repo would hit the same wall with no clue why.

## Result

Verified on the built exe:

```
ProductName    : EQL DPS Overlay
FileDescription: Real-time group DPS overlay for EverQuest Legends
ProductVersion : 0.8.1.0
icon           : matches src/assets/icon-32.png, not the Electron logo
```

The version strings are the other half of the same omission — without them the exe
introduced itself as Electron in Task Manager, in its Properties pane, and in the
"app has stopped responding" dialog.

**This lands in the next release, not the current one.** v0.8.1 was published before the fix,
so shortcuts created by that installer keep the Electron icon until a build made after this
is released.

## Files

| File | Change |
|---|---|
| `package.json` | `win.signAndEditExecutable: false` removed |
| `scripts/dev.sh` | `ensure_wincodesign` — unpacks the toolchain minus the macOS symlinks, before `dist` and `release` |
