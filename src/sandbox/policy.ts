import { BUNDLES, checkHost, type HostRule } from './allowlist.ts';

export interface PolicyOptions {
  bundles: string[];
  extraHosts: string[];
  /** The project's AWS endpoints, signed in the proxy with the view-only role (§12.3). */
  aws?: { region: string; provider: string; services: string[] };
}

/** Services whose endpoints don't follow `<service>.<region>.amazonaws.com`. Global ones sign for us-east-1. */
const AWS_SERVICES: Record<string, { hosts: (region: string) => string[]; signing: string; global?: boolean }> = {
  iam: { hosts: () => ['iam.amazonaws.com'], signing: 'iam', global: true },
  s3: { hosts: (region) => [`s3.${region}.amazonaws.com`, `*.s3.${region}.amazonaws.com`], signing: 's3' },
  cloudwatch: { hosts: (region) => [`monitoring.${region}.amazonaws.com`], signing: 'monitoring' },
  ecr: { hosts: (region) => [`api.ecr.${region}.amazonaws.com`], signing: 'ecr' },
  cloudfront: { hosts: () => ['cloudfront.amazonaws.com'], signing: 'cloudfront', global: true },
  route53: { hosts: () => ['route53.amazonaws.com'], signing: 'route53', global: true },
};

/**
 * One signed endpoint per host. `access: full`, because most AWS APIs are POSTs: the
 * role itself is what allows only reads (spike 2).
 */
function awsEndpoints(aws: NonNullable<PolicyOptions['aws']>): object[] {
  return aws.services.flatMap((service) => {
    const known = AWS_SERVICES[service];
    const hosts = known ? known.hosts(aws.region) : [`${service}.${aws.region}.amazonaws.com`];
    return hosts.map((host) => ({
      host,
      port: 443,
      protocol: 'rest',
      enforcement: 'enforce',
      access: 'full',
      credential_binding: { provider: aws.provider },
      credential_signing: 'sigv4',
      signing_service: known?.signing ?? service,
      ...(known?.global ? { signing_region: 'us-east-1' } : {}),
    }));
  });
}

/**
 * Programs whose connections the rules cover. A rule also applies to the processes a
 * listed program starts, and everything an agent runs starts from one of these. A
 * command that `bash -c` replaces itself with has no listed ancestor: its connections
 * are refused, whatever the host.
 */
const BINARIES = ['/usr/local/bin/claude', '/usr/bin/bash', '/usr/bin/dash'];

/**
 * The OpenShell policy of a Developer or check sandbox. The Claude provider adds
 * `api.anthropic.com` by itself; AWS endpoints are signed rules added in M5. The result
 * is written as JSON, which is valid YAML.
 */
export function buildPolicy(options: PolicyOptions): object {
  const rules: HostRule[] = [];
  for (const name of options.bundles) {
    const bundle = BUNDLES[name];
    if (!bundle) throw new Error(`unknown network bundle "${name}" (known: ${Object.keys(BUNDLES).join(', ')})`);
    rules.push(...bundle);
  }
  rules.push(...options.extraHosts.map((host): HostRule => ({ host, access: 'read' })));

  const unique = [...new Map(rules.map((rule) => [rule.host, rule])).values()];
  unique.forEach((rule) => checkHost(rule.host));
  const binaries = BINARIES.map((path) => ({ path }));

  return {
    version: 1,
    filesystem_policy: {
      include_workdir: true,
      read_only: ['/usr', '/lib', '/etc'],
      read_write: ['/tmp', '/sandbox'],
    },
    network_policies: {
      read_only_web: { endpoints: unique.filter((r) => r.access === 'read').map(readEndpoint), binaries },
      git_fetch: { endpoints: unique.filter((r) => r.access === 'git').map(gitEndpoint), binaries },
      ...(options.aws ? { aws_view: { endpoints: awsEndpoints(options.aws), binaries } } : {}),
    },
  };
}

function readEndpoint(rule: HostRule): object {
  return {
    host: rule.host,
    port: 443,
    protocol: 'rest',
    enforcement: 'enforce',
    access: 'read-only',
    ...(rule.encodedSlash ? { allow_encoded_slash: true } : {}),
  };
}

/** Clone and fetch over HTTPS: GET and HEAD for refs, POST only to git-upload-pack. Push (git-receive-pack) never. */
function gitEndpoint(rule: HostRule): object {
  return {
    host: rule.host,
    port: 443,
    protocol: 'rest',
    enforcement: 'enforce',
    rules: [
      { allow: { method: 'GET', path: '**' } },
      { allow: { method: 'HEAD', path: '**' } },
      { allow: { method: 'POST', path: '/**/git-upload-pack' } },
    ],
  };
}
