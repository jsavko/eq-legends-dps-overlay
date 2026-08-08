/**
 * A ZIP reader, in about a hundred lines, because a `.gtp` is a ZIP and this project
 * does not take dependencies it can avoid.
 *
 * The no-native-modules rule (see CLAUDE.md) is the reason: any real ZIP library either
 * is native or drags one in, and a native dependency in the two-worlds build has to be
 * built twice — win32 under Windows npm for the app, linux under WSL for the test suite.
 * A `.gtp` is a few kilobytes holding one XML file, so almost none of the format is
 * relevant: `zlib.inflateRawSync` is in Node already, and everything else is header
 * arithmetic.
 *
 * What this deliberately does NOT do is guess. Zip64, encryption and unsupported
 * compression methods throw with the reason named, because a truncated import that
 * reports success is exactly the failure mode this project refuses — the player would
 * get a pack that is quietly missing half its triggers and no way to tell.
 */

import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_ZIP64_EOCD_LOCATOR = 0x07064b50;

/** Stored and deflated are the only methods that exist in practice; GINA writes deflate. */
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** Bit 0 of the general-purpose flags. Encrypted entries cannot be read without a password. */
const FLAG_ENCRYPTED = 0x01;

export class ZipError extends Error {}

/**
 * Read every entry out of a ZIP buffer.
 *
 * @param {Buffer} buf
 * @returns {Array<{name: string, data: Buffer}>} in central-directory order
 */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf)) throw new ZipError('not a buffer');
  if (buf.length < 22) throw new ZipError('too short to be a zip file');

  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  // 0xffffffff in a 32-bit field is zip64's "look in the zip64 record instead" marker.
  // A .gtp never reaches 4 GB, so this can only mean the file is not what we think.
  if (offset === 0xffffffff || count === 0xffff) {
    throw new ZipError('zip64 archives are not supported');
  }
  if (buf.length >= 20 && findSignatureBefore(buf, eocd, SIG_ZIP64_EOCD_LOCATOR) !== -1) {
    throw new ZipError('zip64 archives are not supported');
  }

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw new ZipError('corrupt central directory');
    }

    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    // Directories are entries too, and they carry no payload worth inflating.
    if (!name.endsWith('/')) {
      entries.push({ name, data: readEntry(buf, { name, flags, method, compressedSize, localOffset }) });
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * The XML inside a `.gtp`.
 *
 * The entry is named `ShareData.xml` in every one of the nine packages measured — no
 * "d", while the root element is `<SharedData>` — but the name is NOT hardcoded here.
 * The same trigger data circulates unzipped as `all-data.xml`, and a reader that
 * insisted on one filename would reject a pack for a spelling nobody controls. First
 * `.xml` entry wins.
 *
 * @param {Buffer} buf
 * @returns {{name: string, data: Buffer}}
 */
export function readPackageXml(buf) {
  const entries = readZip(buf);
  const xml = entries.find((e) => e.name.toLowerCase().endsWith('.xml'));
  if (!xml) {
    const names = entries.map((e) => e.name).join(', ') || 'nothing';
    throw new ZipError(`no .xml entry in the package (found: ${names})`);
  }
  return xml;
}

/** True if this buffer looks like a ZIP rather than bare XML — the import fork. */
export function looksLikeZip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.readUInt32LE(0) === SIG_LOCAL;
}

// ---------------------------------------------------------------------------

/**
 * Find the end-of-central-directory record.
 *
 * Scanned backwards because a ZIP may carry a trailing comment of up to 64 KB, so the
 * EOCD is not simply the last 22 bytes. Backwards also means the first hit is the real
 * one: a byte sequence that happens to match inside compressed data sits earlier in the
 * file than the genuine record.
 */
function findEocd(buf) {
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new ZipError('not a zip file (no end-of-central-directory record)');
}

/** Scan a bounded window before `end` for a signature — used only to detect zip64. */
function findSignatureBefore(buf, end, signature) {
  for (let i = end - 4; i >= Math.max(0, end - 128); i--) {
    if (buf.readUInt32LE(i) === signature) return i;
  }
  return -1;
}

function readEntry(buf, { name, flags, method, compressedSize, localOffset }) {
  if (flags & FLAG_ENCRYPTED) throw new ZipError(`entry "${name}" is encrypted`);
  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
    throw new ZipError(`corrupt local header for "${name}"`);
  }

  // The local header repeats the name and extra-field lengths, and they may DIFFER from
  // the central directory's — the extra field in particular often does. Reading the
  // local header's own values is the only way to land on the first payload byte.
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const end = start + compressedSize;
  if (end > buf.length) throw new ZipError(`entry "${name}" is truncated`);

  const raw = buf.subarray(start, end);
  if (method === METHOD_STORED) return Buffer.from(raw);
  if (method === METHOD_DEFLATE) {
    try {
      return zlib.inflateRawSync(raw);
    } catch (err) {
      throw new ZipError(`entry "${name}" failed to inflate: ${err.message}`);
    }
  }
  throw new ZipError(`entry "${name}" uses unsupported compression method ${method}`);
}
