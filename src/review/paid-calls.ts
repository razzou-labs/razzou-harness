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

const TABLE: ReadonlyArray<{ service: string; pattern: RegExp }> = [
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
  { service: 'Kendra', pattern: servicePattern([], ['KendraClient', 'AWS.Kendra'], ['kendra'], /\b(?:QueryCommand|RetrieveCommand)\b(?=.*[Kk]endra)|(?<=[Kk]endra\w*\.)(?:query|retrieve|Query|Retrieve)(?=\s*\()/) },
];

/** Files that aren't code the project runs, or are too long to be worth a scan. */
const SKIPPED = /(^|\/)(node_modules|vendor|dist|build|\.terraform)\/|(^|\/)package-lock\.json$|\.lock$|\.min\.(js|css)$|\.(png|jpg|jpeg|gif|svg|ico|pdf|zip|gz|woff2?|ttf|map)$/;
const MAX_BYTES = 1_000_000;

/** The paid calls in one file, by line. */
export function paidCalls(text: string, file: string): PaidCall[] {
  if (SKIPPED.test(file) || text.length > MAX_BYTES) return [];
  const found: PaidCall[] = [];
  const lines = text.split('\n');
  lines.forEach((content, i) => {
    for (const { service, pattern } of TABLE) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
        found.push({ service, call: match[0], file, line: i + 1 });
        if (match[0].length === 0) pattern.lastIndex++;
      }
    }
  });
  return found;
}

export interface PaidCallDiff {
  added: PaidCall[];
  removed: PaidCall[];
}

/**
 * What a change adds and removes, per file: a call counts as added when the head has
 * more of it than the base, with the head's lines; as removed in the opposite case.
 */
export async function paidCallDiff(files: string[], base: (file: string) => Promise<string | undefined>, head: (file: string) => Promise<string | undefined>): Promise<PaidCallDiff> {
  const added: PaidCall[] = [];
  const removed: PaidCall[] = [];
  for (const file of files) {
    const before = paidCalls((await base(file)) ?? '', file);
    const after = paidCalls((await head(file)) ?? '', file);
    const key = (c: PaidCall) => `${c.service}\t${c.call}`;
    const counts = new Map<string, number>();
    for (const call of before) counts.set(key(call), (counts.get(key(call)) ?? 0) - 1);
    for (const call of after) counts.set(key(call), (counts.get(key(call)) ?? 0) + 1);
    for (const [k, delta] of counts) {
      if (delta > 0) added.push(...after.filter((c) => key(c) === k).slice(-delta));
      if (delta < 0) removed.push(...before.filter((c) => key(c) === k).slice(0, -delta));
    }
  }
  return { added, removed };
}

/** The difference as the reviewer reads it. */
export function describePaidCalls(diff: PaidCallDiff): string {
  if (diff.added.length === 0 && diff.removed.length === 0) return 'None found by pattern. Look for what patterns miss: a client built by name, a call behind a wrapper.';
  const line = (sign: string, c: PaidCall) => `${sign} ${c.service}: ${c.call} at ${c.file}:${c.line}`;
  return [...diff.added.map((c) => line('+', c)), ...diff.removed.map((c) => line('-', c))].join('\n');
}
