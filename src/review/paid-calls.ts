/**
 * The paid-call inventory (proposal v3 §5.3): pay-per-use AWS operations found in the
 * code by pattern, in the base and in the head of a pull request. The cost reviewer
 * starts from the difference and judges what a pattern can't: loops, fan-outs, retries,
 * sizes. Patterns cover the SDKs' operation names, their snake_case and camelCase
 * forms, and the clients, in the languages a project is likely to use.
 */
export interface PaidCall {
  service: string;
  call: string;
  file: string;
  line: number;
}

/** An operation as the SDKs spell it: a JS v3 command, PascalCase, camelCase and snake_case. */
function spellings(operation: string): string[] {
  return [`${operation}Command`, operation, `${operation[0]!.toLowerCase()}${operation.slice(1)}`, operation.replace(/\B[A-Z]/g, (c) => `_${c}`).toLowerCase()];
}

/**
 * A service's pattern: its operations in every spelling (`SendEmailCommand`, `SendEmail`,
 * `sendEmail`, `send_email`), and its clients, by class (`SESv2Client`, `AWS.SES`) or by the
 * id boto3 and the JS SDKs name them with (`client('ses')`, `@aws-sdk/client-ses`). `also`
 * holds an operation named by a common word, which counts only where its context says so.
 */
function servicePattern(operations: string[], classes: string[], ids: string[], also?: RegExp): RegExp {
  const names = [...operations.flatMap(spellings), ...classes.map((c) => c.replace('.', '\\.'))];
  const sources = [`\\b(?:${names.join('|')})\\b`, `(?<=\\bclients?(?:\\(\\s*['"]|[-/]))(?:${ids.join('|')})\\b`, ...(also ? [also.source] : [])];
  return new RegExp(sources.join('|'), 'g');
}

/** A service's pattern; with `line`, it counts only on a line that matches that too, tested once per line. */
const TABLE: ReadonlyArray<{ service: string; pattern: RegExp; line?: RegExp }> = [
  // Converse is also a word: only as a command, or called (`.converse(`).
  {
    service: 'Bedrock',
    pattern: servicePattern(['InvokeModel', 'InvokeModelWithResponseStream', 'ConverseStream', 'RetrieveAndGenerate', 'RetrieveAndGenerateStream'], ['BedrockRuntimeClient', 'BedrockAgentRuntimeClient', 'AWS.BedrockRuntime', 'AWS.BedrockAgentRuntime'], ['bedrock-runtime', 'bedrock-agent-runtime'], /\bConverseCommand\b|(?<=\.)[Cc]onverse(?=\s*\()/),
  },
  { service: 'Textract', pattern: servicePattern(['AnalyzeDocument', 'DetectDocumentText', 'StartDocumentAnalysis', 'AnalyzeExpense'], ['TextractClient', 'AWS.Textract'], ['textract']) },
  { service: 'Rekognition', pattern: servicePattern(['DetectLabels', 'DetectFaces', 'DetectText', 'DetectModerationLabels', 'CompareFaces'], ['RekognitionClient', 'AWS.Rekognition'], ['rekognition']) },
  { service: 'Comprehend', pattern: servicePattern(['DetectSentiment', 'DetectEntities', 'DetectKeyPhrases', 'DetectPiiEntities'], ['ComprehendClient', 'AWS.Comprehend'], ['comprehend']) },
  { service: 'Transcribe', pattern: servicePattern(['StartTranscriptionJob', 'StartStreamTranscription'], ['TranscribeClient', 'TranscribeStreamingClient', 'AWS.TranscribeService'], ['transcribe-streaming', 'transcribe']) },
  { service: 'Polly', pattern: servicePattern(['SynthesizeSpeech', 'StartSpeechSynthesisTask'], ['PollyClient', 'AWS.Polly'], ['polly']) },
  { service: 'Translate', pattern: servicePattern(['TranslateText', 'TranslateDocument'], ['TranslateClient', 'AWS.Translate'], ['translate']) },
  { service: 'SES', pattern: servicePattern(['SendEmail', 'SendRawEmail', 'SendBulkEmail', 'SendTemplatedEmail'], ['SESClient', 'SESv2Client', 'AWS.SES', 'AWS.SESV2'], ['sesv2', 'ses']) },
  // A phone number passed as SNS's Publish takes it, a key or a keyword argument; not a type of that name.
  { service: 'SNS to a phone', pattern: /(?<!\btype\s+)\bPhoneNumber(?=['"]?\s*[:=])/g },
  // Invoke is also a word: only as a command, or called on a client named after Lambda (`lambda_client.invoke(`).
  {
    service: 'Lambda invoke',
    pattern: servicePattern(['InvokeWithResponseStream'], ['LambdaClient', 'AWS.Lambda'], ['lambda'], /\b(?:InvokeCommand|InvokeAsyncCommand)\b|(?<=[Ll]ambda\w*\.)(?:invoke|invoke_async|invokeAsync|Invoke)(?=\s*\()/),
  },
  { service: 'Step Functions', pattern: servicePattern(['StartExecution', 'StartSyncExecution'], ['SFNClient', 'AWS.StepFunctions'], ['sfn', 'stepfunctions']) },
  { service: 'Location', pattern: servicePattern(['SearchPlaceIndexForText', 'SearchPlaceIndexForPosition', 'CalculateRoute', 'CalculateRouteMatrix'], ['LocationClient', 'AWS.Location'], ['location']) },
  // Query and Retrieve are also words, and other services' commands: only with Kendra on the line, or called on its client.
  { service: 'Kendra', pattern: servicePattern([], ['KendraClient', 'AWS.Kendra'], ['kendra'], /(?<=[Kk]endra\w*\.)(?:query|retrieve|Query|Retrieve)(?=\s*\()/) },
  { service: 'Kendra', pattern: /\b(?:QueryCommand|RetrieveCommand)\b/g, line: /kendra/i },
];

/** Files that aren't code the project runs. */
const SKIPPED = /(^|\/)(node_modules|vendor|dist|build|\.terraform)\/|(^|\/)package-lock\.json$|\.lock$|\.min\.(js|css)$|\.(png|jpg|jpeg|gif|svg|ico|pdf|zip|gz|woff2?|ttf|map)$/;
/** A file, and a line, too long to be worth a scan: minified or generated, and slow for the patterns on the daemon's one thread. */
const MAX_BYTES = 1_000_000;
const MAX_LINE = 2_000;

/** The paid calls in one file, by line, and what wasn't scanned: the file when too long, or its lines too long. */
function scan(text: string, file: string): { calls: PaidCall[]; unscanned?: string } {
  if (text.length > MAX_BYTES) return { calls: [], unscanned: `${file} (over ${MAX_BYTES / 1_000_000} MB)` };
  const calls: PaidCall[] = [];
  const long: number[] = [];
  text.split('\n').forEach((content, i) => {
    if (content.length > MAX_LINE) {
      long.push(i + 1);
      return;
    }
    const found: Array<PaidCall & { at: number }> = [];
    for (const { service, pattern, line } of TABLE) {
      if (line && !line.test(content)) continue;
      pattern.lastIndex = 0;
      for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
        found.push({ service, call: match[0], file, line: i + 1, at: match.index });
        if (match[0].length === 0) pattern.lastIndex++;
      }
    }
    // In the order they are on the line, whichever pattern found them.
    calls.push(...found.sort((a, b) => a.at - b.at).map(({ at: _at, ...call }) => call));
  });
  const lines = long.length > 3 ? `${long.slice(0, 3).join(', ')} and ${long.length - 3} more` : long.join(', ');
  return { calls, ...(long.length > 0 ? { unscanned: `${file}, line${long.length === 1 ? '' : 's'} ${lines} (over ${MAX_LINE.toLocaleString('en')} characters)` } : {}) };
}

/** The paid calls in one file, by line. */
export function paidCalls(text: string, file: string): PaidCall[] {
  return SKIPPED.test(file) ? [] : scan(text, file).calls;
}

export interface PaidCallDiff {
  added: PaidCall[];
  removed: PaidCall[];
  /** The code the patterns didn't scan, too long: a call there goes unseen. */
  unscanned?: string[];
}

/**
 * What a change adds and removes, per file: a call counts as added when the head has
 * more of it than the base, with the head's lines; as removed in the opposite case. A
 * file the skip list names isn't read at all.
 */
export async function paidCallDiff(files: string[], base: (file: string) => Promise<string | undefined>, head: (file: string) => Promise<string | undefined>): Promise<PaidCallDiff> {
  const added: PaidCall[] = [];
  const removed: PaidCall[] = [];
  const unscanned: string[] = [];
  for (const file of files.filter((f) => !SKIPPED.test(f))) {
    const { calls: before } = scan((await base(file)) ?? '', file);
    const { calls: after, unscanned: missed } = scan((await head(file)) ?? '', file);
    if (missed) unscanned.push(missed);
    const key = (c: PaidCall) => `${c.service}\t${c.call}`;
    const counts = new Map<string, number>();
    for (const call of before) counts.set(key(call), (counts.get(key(call)) ?? 0) - 1);
    for (const call of after) counts.set(key(call), (counts.get(key(call)) ?? 0) + 1);
    for (const [k, delta] of counts) {
      if (delta > 0) added.push(...after.filter((c) => key(c) === k).slice(-delta));
      if (delta < 0) removed.push(...before.filter((c) => key(c) === k).slice(0, -delta));
    }
  }
  return { added, removed, ...(unscanned.length > 0 ? { unscanned } : {}) };
}

/** The difference as the reviewer reads it, and the code it couldn't scan, which the reviewer reads itself. */
export function describePaidCalls(diff: PaidCallDiff): string {
  const unscanned = (diff.unscanned ?? []).map((what) => `Not scanned, too long: ${what}. Read it yourself.`);
  if (diff.added.length === 0 && diff.removed.length === 0) {
    return ['None found by pattern. Look for what patterns miss: a client built by name, a call behind a wrapper.', ...unscanned].join('\n');
  }
  const line = (sign: string, c: PaidCall) => `${sign} ${c.service}: ${c.call} at ${c.file}:${c.line}`;
  return [...diff.added.map((c) => line('+', c)), ...diff.removed.map((c) => line('-', c)), ...unscanned].join('\n');
}
