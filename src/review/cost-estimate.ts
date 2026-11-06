/**
 * The cost job's estimate, from Infracost's JSON (v3 §5.3): the monthly cost the change
 * adds, `diffTotalMonthlyCost` when the job compared the head with the base, or else the
 * whole `totalMonthlyCost`, when the base had no infrastructure. Undefined when the text
 * isn't that JSON, or carries no number.
 */
export function parseCostEstimate(text: string): { monthlyUsd: number; source: string } | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof json !== 'object' || json === null) return undefined;
  const fields = json as Record<string, unknown>;
  for (const source of ['diffTotalMonthlyCost', 'totalMonthlyCost']) {
    const value = fields[source];
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
    if (Number.isFinite(number)) return { monthlyUsd: Math.round(number * 100) / 100, source };
  }
  return undefined;
}
