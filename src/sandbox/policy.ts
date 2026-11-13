import { BUNDLES, bundleNames, checkHost, type HostRule } from './allowlist.ts';
import { GLOBAL_SERVICES, REGIONAL_SERVICES } from './aws-services.ts';

/** A third-party API the sandboxes may call with any method; with `key`, the variable its key is read from. */
export interface Api {
  host: string;
  key?: string | undefined;
}

export interface PolicyOptions {
  bundles: string[];
  extraHosts: string[];
  /** Third-party APIs: one without a key is opened here; one with a key comes with its provider, whose profile opens it (apiProfile). */
  apis?: Api[] | undefined;
  /** The project's AWS endpoints, signed in the proxy with the view-only role (§12.3). */
  aws?: { region: string; provider: string; services: string[] };
}

/** Services whose endpoints don't follow `<service>.<region>.amazonaws.com`. Global ones sign for us-east-1. */
const AWS_SERVICES: Record<string, { hosts: (region: string) => string[]; signing: string; global?: boolean }> = {
  iam: { hosts: () => ['iam.amazonaws.com'], signing: 'iam', global: true },
  s3: { hosts: (region) => [`s3.${region}.amazonaws.com`, `*.s3.${region}.amazonaws.com`], signing: 's3' },
  cloudwatch: { hosts: (region) => [`monitoring.${region}.amazonaws.com`], signing: 'monitoring' },
  ecr: { hosts: (region) => [`api.ecr.${region}.amazonaws.com`], signing: 'ecr' },
  // SDKs and Terraform's AWS provider call DynamoDB at the account's own endpoint by default.
  dynamodb: { hosts: (region) => [`dynamodb.${region}.amazonaws.com`, `*.ddb.${region}.amazonaws.com`], signing: 'dynamodb' },
  cloudfront: { hosts: () => ['cloudfront.amazonaws.com'], signing: 'cloudfront', global: true },
  route53: { hosts: () => ['route53.amazonaws.com'], signing: 'route53', global: true },
};

/** In `aws.services`, every AWS service: the view role alone then decides what agents read. */
export const ALL_SERVICES = 'all';

/**
 * One signed endpoint per host. `access: full`, because most AWS APIs are POSTs: the
 * role itself is what allows only reads (spike 2). OpenShell signs only for endpoints
 * named with their service, with no rule for every AWS host, so `all` names every one
 * the AWS SDK knows (aws-services.ts), with the hosts that carry a bucket's or an
 * account's name in front: S3's, S3 Control's and DynamoDB's (`<account>.ddb.<region>`),
 * which botocore's endpoint data doesn't list.
 *
 * Every service but S3 is signed with `sigv4:body`: the hash of the request's body, an
 * empty one for a GET. OpenShell's automatic `sigv4` signs a request with neither a body
 * nor `x-amz-content-sha256` as UNSIGNED-PAYLOAD, which only S3 accepts, so every other
 * service's GET failed (NVIDIA/OpenShell#5375). S3 keeps it: its SDKs say how to sign.
 */
function awsEndpoints(aws: NonNullable<PolicyOptions['aws']>): object[] {
  const signed = (host: string, service: string, region?: string): { host: string } => ({
    host,
    port: 443,
    protocol: 'rest',
    enforcement: 'enforce',
    access: 'full',
    credential_binding: { provider: aws.provider },
    credential_signing: service === 's3' ? 'sigv4' : 'sigv4:body',
    signing_service: service,
    ...(region ? { signing_region: region } : {}),
  } as { host: string });
  const named = aws.services.filter((service) => service !== ALL_SERVICES).flatMap((service) => {
    const known = AWS_SERVICES[service];
    const hosts = known ? known.hosts(aws.region) : [`${service}.${aws.region}.amazonaws.com`];
    return hosts.map((host) => signed(host, known?.signing ?? service, known?.global ? 'us-east-1' : undefined));
  });
  const all = aws.services.includes(ALL_SERVICES)
    ? [
        ...REGIONAL_SERVICES.map(([prefix, service, template]) => signed((template ?? '{service}.{region}.{dnsSuffix}').replace('{service}', prefix).replace('{region}', aws.region).replace('{dnsSuffix}', 'amazonaws.com'), service)),
        signed(`*.s3.${aws.region}.amazonaws.com`, 's3'),
        signed(`*.s3-control.${aws.region}.amazonaws.com`, 's3'),
        signed(`*.ddb.${aws.region}.amazonaws.com`, 'dynamodb'),
        ...GLOBAL_SERVICES.map(([, host, service, region]) => signed(host, service, region)),
      ]
    : [];
  // One rule per host, a named service's first.
  const endpoints = [...named, ...all];
  return endpoints.filter((endpoint, i) => endpoints.findIndex((other) => other.host === endpoint.host) === i);
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
  for (const name of bundleNames(options.bundles)) {
    const bundle = BUNDLES[name];
    if (!bundle) throw new Error(`unknown network bundle "${name}" (known: all, ${Object.keys(BUNDLES).join(', ')})`);
    rules.push(...bundle);
  }
  rules.push(...options.extraHosts.map((host): HostRule => ({ host, access: 'read' })));

  // A host's first rule wins: a bundle's, like github.com's with git, over an extra host's read-only one.
  // An API's own rule wins over both, so a host listed as an API takes every method; a git
  // host can't be one, or every method would reach it, push included.
  const apis = options.apis ?? [];
  const git = new Set(rules.filter((rule) => rule.access === 'git').map((rule) => rule.host));
  const pushable = apis.find((api) => git.has(api.host));
  if (pushable) throw new Error(`network.apis: ${pushable.host} is a git host, which sandboxes only clone and fetch from, so it can't be an API`);
  const apiHosts = new Set(apis.map((api) => api.host));
  const unique = rules.filter((rule, i) => rules.findIndex((r) => r.host === rule.host) === i && !apiHosts.has(rule.host));
  unique.forEach((rule) => checkHost(rule.host));
  apis.forEach((api) => checkHost(api.host));
  const keyless = apis.filter((api) => !api.key);
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
      ...(keyless.length > 0 ? { third_party_apis: { endpoints: keyless.map((api) => apiEndpoint(api.host)), binaries } } : {}),
    },
  };
}

/** A third-party API's host, open to every method: the project's code calls it as it would in production. */
function apiEndpoint(host: string): object {
  return { host, port: 443, protocol: 'rest', enforcement: 'enforce', access: 'full' };
}

/**
 * The OpenShell provider, and its profile, that hold a third-party API's key for a
 * project. Providers are per machine, so the name says whose and which.
 */
export function apiProviderName(project: string, host: string): string {
  const safe = (text: string) => text.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `api-${safe(project)}-${safe(host)}`;
}

/**
 * The provider profile of a third-party API's key. A sandbox with the provider sees a
 * placeholder in the variable, and OpenShell's proxy puts the key in its place on
 * requests to the host alone: in any header, Basic auth included, and in the URL, but
 * not in a request's body. The profile also opens the host to every method.
 */
export function apiProfile(project: string, api: Required<Api>): object {
  return {
    id: apiProviderName(project, api.host),
    display_name: `${api.host} for ${project}`,
    description: `The key of ${api.host} that the harness's sandboxes of ${project} use, as ${api.key}`,
    category: 'other',
    credentials: [{ name: 'key', description: `The key of ${api.host}`, env_vars: [api.key], required: true, auth_style: 'bearer', header_name: 'authorization' }],
    endpoints: [{ host: api.host, port: 443, protocol: 'rest', access: 'full', enforcement: 'enforce' }],
    binaries: BINARIES,
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

/**
 * Where each git host takes a fetch's POST: a path that only a repository has. `/**` would
 * also match a path of the host's own API that ends in git-upload-pack, like a file made
 * through GitLab's files API. On github.com a repository is `/<owner>/<name>`; GitLab's
 * groups nest, but its git paths end in `.git`, where git's first request is redirected.
 * A git host without a shape here gets no POST: clone works through its archives only.
 */
const UPLOAD_PACK: Record<string, string> = {
  'github.com': '/*/*/git-upload-pack',
  'gitlab.com': '/**/*.git/git-upload-pack',
};

/** Clone and fetch over HTTPS: GET and HEAD for refs, POST only to a repository's git-upload-pack. Push (git-receive-pack) never. */
function gitEndpoint(rule: HostRule): object {
  const post = UPLOAD_PACK[rule.host];
  return {
    host: rule.host,
    port: 443,
    protocol: 'rest',
    enforcement: 'enforce',
    rules: [
      { allow: { method: 'GET', path: '**' } },
      { allow: { method: 'HEAD', path: '**' } },
      ...(post ? [{ allow: { method: 'POST', path: post } }] : []),
    ],
  };
}
