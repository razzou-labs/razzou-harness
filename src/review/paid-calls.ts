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

const TABLE: ReadonlyArray<{ service: string; pattern: RegExp }> = [
  { service: 'Bedrock', pattern: /\b(InvokeModel(?:WithResponseStream)?(?:Command)?|Converse(?:Stream)?(?:Command)?|invoke_model(?:_with_response_stream)?|converse(?:_stream)?|RetrieveAndGenerate(?:Command)?|retrieve_and_generate|BedrockRuntime(?:Client)?|bedrock-runtime|BedrockAgentRuntime(?:Client)?)\b/g },
  { service: 'Textract', pattern: /\b(AnalyzeDocument(?:Command)?|DetectDocumentText(?:Command)?|StartDocumentAnalysis(?:Command)?|AnalyzeExpense(?:Command)?|analyze_document|detect_document_text|start_document_analysis|Textract(?:Client)?)\b/g },
  { service: 'Rekognition', pattern: /\b(DetectLabels(?:Command)?|DetectFaces(?:Command)?|DetectText(?:Command)?|DetectModerationLabels(?:Command)?|CompareFaces(?:Command)?|detect_labels|detect_faces|detect_text|Rekognition(?:Client)?)\b/g },
  { service: 'Comprehend', pattern: /\b(DetectSentiment(?:Command)?|DetectEntities(?:Command)?|DetectKeyPhrases(?:Command)?|DetectPiiEntities(?:Command)?|detect_sentiment|detect_entities|detect_key_phrases|Comprehend(?:Client)?)\b/g },
  { service: 'Transcribe', pattern: /\b(StartTranscriptionJob(?:Command)?|StartStreamTranscription(?:Command)?|start_transcription_job|Transcribe(?:Streaming)?(?:Client)?)\b/g },
  { service: 'Polly', pattern: /\b(SynthesizeSpeech(?:Command)?|StartSpeechSynthesisTask(?:Command)?|synthesize_speech|Polly(?:Client)?)\b/g },
  { service: 'Translate', pattern: /\b(TranslateText(?:Command)?|TranslateDocument(?:Command)?|translate_text|TranslateClient)\b/g },
  { service: 'SES', pattern: /\b(SendEmail(?:Command)?|SendRawEmail(?:Command)?|SendBulkEmail(?:Command)?|SendTemplatedEmail(?:Command)?|send_email|send_raw_email|send_bulk_email|SES(?:v2)?(?:Client)?)\b/g },
  { service: 'SNS to a phone', pattern: /\b(PhoneNumber)\b/g },
  { service: 'Lambda invoke', pattern: /\b(InvokeCommand|InvokeAsyncCommand|InvokeWithResponseStream(?:Command)?|invoke_async|invoke_with_response_stream|LambdaClient)\b/g },
  { service: 'Step Functions', pattern: /\b(StartExecution(?:Command)?|StartSyncExecution(?:Command)?|start_execution|start_sync_execution|SFNClient)\b/g },
  { service: 'Location', pattern: /\b(SearchPlaceIndexFor(?:Text|Position)(?:Command)?|CalculateRoute(?:Matrix)?(?:Command)?|search_place_index_for_text|calculate_route|LocationClient)\b/g },
  { service: 'Kendra', pattern: /\b(Query(?:Command)?|Retrieve(?:Command)?)\b(?=.*[Kk]endra)|\bKendraClient\b/g },
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
        found.push({ service, call: match[1] ?? match[0], file, line: i + 1 });
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
