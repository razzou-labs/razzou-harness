import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Where the project's Terraform is, as `harness/config.json` says under `terraform`. */
export interface TerraformLayout {
  dir: string;
  backendConfig: string;
  varFile: string;
}

/** What a project's Terraform scaffold says: where its state lives, and the facts its Terraform reads. */
export interface TerraformScaffold {
  region: string;
  account: string;
  /** The bootstrap's state bucket, and the project's key in it. */
  bucket: string;
  key: string;
  /** The repository and its numeric ids, which OIDC trust policies pin; none for a local project. */
  github?: { repo: string; ownerId: string; repoId: string } | undefined;
}

/** Every file the scaffold may write, from the project's root. */
export function scaffoldFiles(layout: TerraformLayout): string[] {
  return ['versions.tf', 'backend.tf', 'variables.tf', 'providers.tf', layout.backendConfig, layout.varFile].map((path) => `${layout.dir}/${path}`);
}

/** The text of the folder's own `.tf` files, which Terraform reads as one module. */
export function terraformSource(folder: string): string {
  if (!existsSync(folder)) return '';
  return readdirSync(folder).filter((f) => f.endsWith('.tf')).map((f) => readFileSync(join(folder, f), 'utf8')).join('\n');
}

/** Whether the module declares a block, like `backend "s3"` or `variable "env"`: a second one would be an error. */
const declares = (source: string, block: string, label?: string) => new RegExp(`^\\s*${block}\\s+"${label ?? '[^"]+'}"`, 'm').test(source);

/**
 * Writes the Terraform scaffold the bootstrap expects in the layout's folder: a partial
 * `backend "s3"` block in a file of its own, `backend.tf`, the backend config and the
 * variables file, and what those feed: the required provider, the variables and the AWS
 * provider. Only what is missing is written: an existing file, or a block any of the
 * folder's `.tf` files declares already, is the project's own; a second one would be an
 * error. The backend config sets no encryption, so the bucket's default, the bootstrap's
 * KMS key, applies: `encrypt = true` without `kms_key_id` would replace it with SSE-S3.
 * Every file is as `terraform fmt` writes it, which CI checks. Returns the paths written,
 * from the project's root.
 */
export function writeTerraformScaffold(projectDir: string, layout: TerraformLayout, values: TerraformScaffold): string[] {
  const { dir } = layout;
  const written: string[] = [];
  const write = (path: string, content: string) => {
    const file = join(projectDir, dir, path);
    if (existsSync(file)) return false;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    written.push(`${dir}/${path}`);
    return true;
  };
  const source = terraformSource(join(projectDir, dir));
  if (!/^\s*required_providers\s*\{/m.test(source)) {
    write('versions.tf', [
      'terraform {',
      '  required_version = ">= 1.10"',
      '',
      '  required_providers {',
      '    aws = {',
      '      source  = "hashicorp/aws"',
      '      version = "~> 6.65"',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'));
  }
  // Without a backend block, CI's `terraform init -backend-config=...` only warns, and the state stays on the runner.
  if (!declares(source, 'backend')) {
    write('backend.tf', [
      'terraform {',
      `  # Partial configuration: the values are in ${layout.backendConfig}, for`,
      `  #   terraform init -backend-config=${layout.backendConfig}`,
      '  backend "s3" {}',
      '}',
      '',
    ].join('\n'));
  }
  write(layout.backendConfig, [
    ...assignments([['bucket', values.bucket], ['key', values.key], ['region', values.region]]),
    '',
    "# No encrypt or kms_key_id: the bucket's default encryption, its KMS key, applies.",
    '# encrypt = true without kms_key_id would replace it with SSE-S3.',
    'use_lockfile = true',
    '',
  ].join('\n'));
  const github = values.github;
  const variables: Array<[string, string, string]> = [
    ['env', 'staging', 'The environment.'],
    ['aws_account_id', values.account, 'The AWS account the environment is in.'],
    ['aws_region', values.region, 'The AWS region the environment is in.'],
    ...(github ? [
      ['github_repo', github.repo, 'The GitHub repository, as owner/name.'],
      ['github_owner_id', github.ownerId, "The repository owner's numeric id, which OIDC trust policies pin."],
      ['github_repo_id', github.repoId, "The repository's numeric id, which OIDC trust policies pin."],
    ] as Array<[string, string, string]> : []),
  ];
  const tfvars = [
    ...assignments(variables.slice(0, 3).map(([name, value]) => [name, value])),
    ...(github ? ['', ...assignments(variables.slice(3).map(([name, value]) => [name, value]))] : []),
    '',
  ].join('\n');
  // The variables follow the values: a tfvars file of the project's own sets its own.
  if (write(layout.varFile, tfvars)) {
    const undeclared = variables.filter(([name]) => !declares(source, 'variable', name));
    if (undeclared.length > 0) {
      write('variables.tf', undeclared.map(([name, , description]) => [
        `variable "${name}" {`,
        ...assignments([['description', description], ['type', 'string']], ['type']).map((line) => `  ${line}`),
        '}',
      ].join('\n')).join('\n\n') + '\n');
    }
    if (!declares(source, 'provider', 'aws')) write('providers.tf', ['provider "aws" {', '  region = var.aws_region', '}', ''].join('\n'));
  }
  return written;
}

/**
 * `name = "value"` lines with their equals signs aligned, as `terraform fmt` aligns them;
 * `bare` names take an expression, unquoted. In a quoted value, `${` and `%{` would start
 * a template: they are escaped, so a value is always the text it says.
 */
function assignments(pairs: Array<[string, string]>, bare: string[] = []): string[] {
  const width = Math.max(...pairs.map(([name]) => name.length));
  const quoted = (value: string) => JSON.stringify(value).replace(/([$%])\{/g, '$1$1{');
  return pairs.map(([name, value]) => `${name.padEnd(width)} = ${bare.includes(name) ? value : quoted(value)}`);
}
