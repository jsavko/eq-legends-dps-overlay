/**
 * The Second Screen dialog: draw the QR for the URL main reports, or say plainly why
 * there is nothing to draw. All state arrives from main (`mobileState` on open,
 * `MOBILE_CHANGED` pushes after) — this file holds none of its own.
 */

import qrcode from '../vendor/qrcode.js';

const $ = (id) => document.getElementById(id);

for (const btn of document.querySelectorAll('.open-settings')) {
  btn.addEventListener('click', () => window.api.openSettings());
}
// The switch lives HERE — the dialog that says "off" is the dialog that turns it on.
// No local state flip: main rebuilds the server and pushes MOBILE_CHANGED, and the
// redraw shows what is actually true (the QR, or why not).
$('enable').addEventListener('click', () => window.api.setEnabled(true));
$('disable').addEventListener('click', () => window.api.setEnabled(false));
// Retrying is just asserting the same intent again: CONFIG_SET rebuilds wholesale.
$('retry').addEventListener('click', () => window.api.setEnabled(true));

window.api.onChanged(render);
render(await window.api.mobileState());

function render(state) {
  const on = state.enabled && state.running && state.urls.length > 0;
  const off = !state.enabled;
  $('on').hidden = !on;
  $('off').hidden = !off;
  $('failed').hidden = on || off;

  if (!on) {
    if (!off && state.running) {
      // Enabled, listening, but no LAN address to print — a laptop between networks.
      $('failed-lead').textContent = 'No network address to show.';
      $('failed-note').textContent =
        'The server is running, but this PC reports no LAN address. Connect it to the network the phone is on and reopen this dialog.';
    }
    return;
  }

  // Type 0 = pick the smallest QR version that fits; 'M' recovery matches what every
  // pairing code in the wild uses. The URL is ~45 chars, so this stays easily scannable.
  const qr = qrcode(0, 'M');
  qr.addData(state.urls[0]);
  qr.make();
  // The tile supplies the quiet zone; scalable SVG fills the tile's width.
  $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });

  $('url').textContent = state.urls[0];
  $('alts').textContent = state.urls.length > 1
    ? `Also reachable at: ${state.urls.slice(1).join('  ·  ')}`
    : '';
}
