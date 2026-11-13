import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe("the agents' image", () => {
  const dockerfile = readFileSync(new URL('../images/agent/Dockerfile', import.meta.url), 'utf8');

  it("carries zip, which CI's runners have and checks use", () => {
    const packages = /apt-get install[^\n]*\n([\s\S]*?)&&/.exec(dockerfile)?.[1]?.split(/\s+/) ?? [];
    for (const tool of ['zip', 'unzip', 'git', 'curl', 'jq', 'make']) assert.ok(packages.includes(tool), tool);
  });

  it('pins its base image by digest', () => {
    assert.match(dockerfile, /^FROM ubuntu:24\.04@sha256:[0-9a-f]{64}$/m);
  });
});
