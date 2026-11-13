/**
 * The cost job's estimate, from Infracost's JSON (v3 §5.3): the monthly cost the change
 * adds, `diffTotalMonthlyCost` when the job compared the head with the base, or else the
 * whole `totalMonthlyCost`, when the base had no infrastructure. Undefined when the text
 * isn't that JSON, carries no number, or a project reports errors: Infracost then counts
 * what it couldn't read as nothing, and its total says 0 USD.
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
  const projects = Array.isArray(fields.projects) ? (fields.projects as Array<{ metadata?: { errors?: unknown } } | null>) : [];
  if (projects.some((p) => Array.isArray(p?.metadata?.errors) && p.metadata.errors.length > 0)) return undefined;
  for (const source of ['diffTotalMonthlyCost', 'totalMonthlyCost']) {
    const value = fields[source];
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
    if (Number.isFinite(number)) return { monthlyUsd: Math.round(number * 100) / 100, source };
  }
  return undefined;
}
