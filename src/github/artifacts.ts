import { inflateRawSync } from 'node:zlib';

/** The most a file out of an artifact may hold: a small zip can inflate to gigabytes. */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/**
 * One file out of a zip, as GitHub serves a workflow artifact (v3 §5.5): entries stored
 * or deflated, no encryption, no zip64. The central directory at the end names the
 * entries; each local header precedes its data. Undefined when the zip has no such file;
 * throws when the file holds more than `maxBytes`, rather than inflating it whole.
 */
export function zipEntry(zip: Buffer, name: string, maxBytes = MAX_ENTRY_BYTES): string | undefined {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip file');
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('a damaged zip file: no central directory entry where one should be');
    const method = zip.readUInt16LE(offset + 10);
    const compressed = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const entryName = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name && !entryName.endsWith(`/${name}`)) continue;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compressed);
    const tooLarge = () => new Error(`${name} in the zip holds more than ${maxBytes} bytes, which the harness doesn't read`);
    if (method === 0) {
      if (data.length > maxBytes) throw tooLarge();
      return data.toString('utf8');
    }
    if (method === 8) {
      try {
        return inflateRawSync(data, { maxOutputLength: maxBytes }).toString('utf8');
      } catch (error) {
        if (error instanceof RangeError) throw tooLarge();
        throw error;
      }
    }
    throw new Error(`${name} in the zip uses compression method ${method}, which the harness doesn't read`);
  }
  return undefined;
}
