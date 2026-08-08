/**
 * A ZIP writer that emits STORED (uncompressed) entries only.
 *
 * Not compressing is the point, not a shortcut. A trigger pack is a few kilobytes of XML,
 * so deflate would save a rounding error while adding a whole class of bugs — mismatched
 * sizes, wrong CRCs against the compressed rather than the raw bytes, and the general
 * inability to eyeball the output. .NET's `ZipArchive`, which GINA itself uses to read
 * `.gtp` files, reads stored entries without complaint, and so does every other unzipper.
 *
 * The CRC-32 is computed here rather than reached for, for the same reason `unzip.js`
 * exists: no native modules, and no new runtime dependency (see CLAUDE.md). Node's zlib
 * has a crc32 as of v20 but it is still marked experimental, and this is thirty lines.
 */

/** Precomputed on first use — 256 entries built once beats a bit-loop per byte. */
let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}

export function crc32(buf) {
  const table = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const METHOD_STORED = 0;

/**
 * Build a ZIP from a list of entries.
 *
 * @param {Array<{name: string, data: Buffer|string}>} entries
 * @param {{mtime?: Date}} [opts]
 *   A fixed timestamp may be supplied so an export is byte-for-byte reproducible, which
 *   is what lets a round-trip test assert on the bytes rather than only on the content.
 * @returns {Buffer}
 */
export function writeZip(entries, opts = {}) {
  const { date, time } = dosDateTime(opts.mtime ?? new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);          // version needed: 2.0, which stored+deflate is
    // Bit 11 (UTF-8 names) is deliberately NOT set: the entry name is `ShareData.xml`,
    // pure ASCII, and older .NET readers treat the flag as a reason to re-decode.
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(METHOD_STORED, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);   // stored: compressed size IS the real size
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(METHOD_STORED, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);   // where this entry's LOCAL header starts

    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, eocd]);
}

/**
 * MS-DOS date and time, which is what a ZIP header holds.
 *
 * Two-second resolution and an epoch of 1980 — a date before that cannot be represented,
 * so it is clamped rather than allowed to write a negative year that unzippers read as
 * garbage.
 */
function dosDateTime(when) {
  const year = Math.max(1980, when.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
  };
}
