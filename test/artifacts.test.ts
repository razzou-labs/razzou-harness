import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { zipEntry } from '../src/github/artifacts.ts';
import { parseCostEstimate } from '../src/review/cost-estimate.ts';

/** A zip with the given files, stored or deflated, the way an archiver writes one: local headers, data, central directory, end record. */
function zip(files: Record<string, string>, method: 0 | 8): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const stored = method === 8 ? deflateRawSync(data) : data;
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(stored.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    parts.push(local, nameBytes, stored);
    offset += local.length + nameBytes.length + stored.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

describe('workflow artifacts (v3 §5.5)', () => {
  it('reads a stored or deflated entry out of a zip, by name or by its last path segment', () => {
    const files = { 'cost.json': '{"totalMonthlyCost":"1.5"}', 'notes/readme.txt': 'hello '.repeat(200) };
    for (const method of [0, 8] as const) {
      const archive = zip(files, method);
      assert.equal(zipEntry(archive, 'cost.json'), files['cost.json']);
      assert.equal(zipEntry(archive, 'readme.txt'), files['notes/readme.txt']);
      assert.equal(zipEntry(archive, 'missing.json'), undefined);
    }
    assert.throws(() => zipEntry(Buffer.from('not a zip'), 'x'), /not a zip file/);
  });

  it('stops inflating a file past the most it may hold, 64 MiB unless told otherwise', () => {
    // 70 MiB of one byte deflates to some 70 kB.
    const bomb = zip({ 'cost.json': ' '.repeat(70 * 1024 * 1024) }, 8);
    assert.ok(bomb.length < 1024 * 1024);
    assert.throws(() => zipEntry(bomb, 'cost.json'), /cost\.json in the zip holds more than 67108864 bytes/);
    assert.throws(() => zipEntry(zip({ 'cost.json': '{"totalMonthlyCost":1}' }, 0), 'cost.json', 10), /holds more than 10 bytes/);
    assert.equal(zipEntry(zip({ 'cost.json': '{"totalMonthlyCost":1}' }, 8), 'cost.json', 100), '{"totalMonthlyCost":1}');
  });

  it("reads Infracost's monthly delta, or the total without a base, and nothing from other text", () => {
    assert.deepEqual(parseCostEstimate('{"totalMonthlyCost":"212.4","diffTotalMonthlyCost":"80.25"}'), { monthlyUsd: 80.25, source: 'diffTotalMonthlyCost' });
    assert.deepEqual(parseCostEstimate('{"totalMonthlyCost":12.504}'), { monthlyUsd: 12.5, source: 'totalMonthlyCost' });
    assert.deepEqual(parseCostEstimate('{"diffTotalMonthlyCost":"-3"}'), { monthlyUsd: -3, source: 'diffTotalMonthlyCost' });
    assert.equal(parseCostEstimate('{"projects":[]}'), undefined);
    assert.equal(parseCostEstimate('{"diffTotalMonthlyCost":""}'), undefined);
    assert.equal(parseCostEstimate('not json'), undefined);
  });

  it("gives no estimate when a project of Infracost's JSON reports errors, rather than its 0 USD", () => {
    const errors = [{ code: 101, message: 'Error loading Terraform modules', data: null }];
    assert.equal(parseCostEstimate(JSON.stringify({ totalMonthlyCost: '0', diffTotalMonthlyCost: '0', projects: [{ name: 'iac', metadata: { errors } }] })), undefined);
    assert.deepEqual(parseCostEstimate(JSON.stringify({ diffTotalMonthlyCost: '4', projects: [{ name: 'iac', metadata: { errors: [] } }, { name: 'b', metadata: {} }] })), {
      monthlyUsd: 4, source: 'diffTotalMonthlyCost',
    });
  });
});
