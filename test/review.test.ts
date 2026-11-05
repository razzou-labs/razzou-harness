import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readReview } from '../src/agents/claude-code.ts';
import { describePaidCalls, paidCallDiff, paidCalls } from '../src/review/paid-calls.ts';

describe('the paid-call inventory', () => {
  it('finds pay-per-use operations by pattern, in the SDKs\' forms', () => {
    const code = [
      "import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';",
      'const out = await client.send(new InvokeModelCommand(input));',
      'response = bedrock.invoke_model(modelId=MODEL, body=body)',
      "ses.send_email(Source='a@b.c', Destination={'ToAddresses': [to]})",
      'const x = 1;',
    ].join('\n');
    assert.deepEqual(paidCalls(code, 'src/a.ts').map((c) => [c.service, c.call, c.line]), [
      ['Bedrock', 'BedrockRuntimeClient', 1], ['Bedrock', 'InvokeModelCommand', 1], ['Bedrock', 'bedrock-runtime', 1], ['Bedrock', 'InvokeModelCommand', 2], ['Bedrock', 'invoke_model', 3], ['SES', 'send_email', 4],
    ]);
    assert.deepEqual(paidCalls(code, 'node_modules/x/index.js'), []);
    assert.deepEqual(paidCalls(code, 'package-lock.json'), []);
  });

  it('diffs the inventory between the base and the head, per file', async () => {
    const base: Record<string, string> = { 'src/a.ts': 'client.send(new InvokeModelCommand(a));\n', 'src/b.py': 'polly.synthesize_speech(Text=t)\n' };
    const head: Record<string, string> = { 'src/a.ts': 'client.send(new InvokeModelCommand(a));\nclient.send(new InvokeModelCommand(b));\n', 'src/b.py': 'print(1)\n', 'src/c.ts': 'await ses.send(new SendEmailCommand(m));\n' };
    const diff = await paidCallDiff(['src/a.ts', 'src/b.py', 'src/c.ts'], async (f) => base[f], async (f) => head[f]);
    assert.deepEqual(diff.added.map((c) => `${c.service} ${c.call} ${c.file}:${c.line}`), ['Bedrock InvokeModelCommand src/a.ts:2', 'SES SendEmailCommand src/c.ts:1']);
    assert.deepEqual(diff.removed.map((c) => `${c.service} ${c.call} ${c.file}:${c.line}`), ['Polly synthesize_speech src/b.py:1']);
    assert.equal(describePaidCalls(diff), '+ Bedrock: InvokeModelCommand at src/a.ts:2\n+ SES: SendEmailCommand at src/c.ts:1\n- Polly: synthesize_speech at src/b.py:1');
    assert.match(describePaidCalls({ added: [], removed: [] }), /^None found by pattern/);
  });
});

describe('a reviewer\'s report', () => {
  const line = (event: object) => `${JSON.stringify(event)}\n`;

  it('is read from the structured output of the final result', () => {
    const report = { verdict: 'block', summary: 'One leak.', findings: [{ file: 'src/a.ts', line: 3, severity: 'blocking', title: 'Secret in a log', detail: 'Remove it.' }] };
    const stream = line({ type: 'assistant', message: {} }) + line({ type: 'result', subtype: 'success', is_error: false, result: 'done', structured_output: report, usage: { input_tokens: 5, output_tokens: 2 } });
    const read = readReview(stream, 0);
    assert.equal(read.outcome, 'done');
    assert.deepEqual(read.report, report);
    assert.deepEqual(read.usage, { inputTokens: 5, outputTokens: 2 });
  });

  it('reports a session without a result, a malformed report, and a usage limit', () => {
    assert.deepEqual(readReview('', 1, 'Error: bad flag'), { outcome: 'error', detail: 'the session ended without a result: Error: bad flag' });
    assert.equal(readReview(line({ type: 'result', subtype: 'success', is_error: false, result: 'x', structured_output: { verdict: 'maybe' } }), 0).outcome, 'no_report');
    assert.equal(readReview(line({ type: 'result', subtype: 'error', is_error: true, result: 'You have hit your usage limit' }), 1).outcome, 'usage_limit');
  });
});
