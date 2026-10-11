# Spike 2: AWS and Terraform through OpenShell's SigV4 signing

Checked 2026-10-10 with OpenShell 0.1.2, AWS CLI 2.37.12, and Terraform 1.16.3 with
AWS provider 6.68.0. The question was whether agents in a sandbox can read real
infrastructure and run `terraform plan` as the read-only role of proposal v2 §12.2,
with OpenShell signing every request, and whether every write and data read is
refused.

## Setup

- **Role.** `terraform-bootstrap` PR #9 created `harness-<project>-staging-view` and the
  `harness-gateway` user. The owner created that user's access key by hand.
- **OpenShell provider.**
  - An `aws`-type provider created with `--runtime-credentials`.
  - Its refresh uses the `aws-sts-assume-role` strategy, with the view role's ARN, the
    session name `harness-agents`, the region, and the gateway key passed through
    `--secret-material-env`.
  - The gateway then assumes the role and mints one-hour credentials. Refresh status
    showed `refreshed` with no failure.
- **Sandbox policy.** It binds these endpoints to the provider with
  `credential_signing: sigv4` and each endpoint's `signing_service`:
  - `sts`, `ec2`, `secretsmanager` and `ssm` in the project's region;
  - `iam.amazonaws.com` with `signing_region: us-east-1`;
  - `s3.<region>.amazonaws.com` and `*.s3.<region>.amazonaws.com`.

  It also allows the Terraform registry read-only.

## Results

| Check | Result |
|---|---|
| What the sandbox sees | Placeholders only for `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`. OpenShell also sets `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` and similar variables to its own certificate authority. The AWS CLI and Terraform trusted it with no extra setting. |
| `sts get-caller-identity` | `assumed-role/harness-<project>-staging-view/harness-agents` |
| Reads | `ec2 describe-vpcs`, `iam list-roles` and listing the state bucket all worked. |
| Own state file | `head-object` returned 404: the read is permitted and the file doesn't exist yet. |
| Another project's state file | `AccessDenied` |
| Writes | `iam create-user` returned `AccessDenied`. `ec2 create-tags --dry-run` on a real VPC returned `UnauthorizedOperation`. |
| Secret and parameter values | `AccessDeniedException` for both, from the explicit deny |
| `terraform init`, real S3 backend | Worked. The AWS provider downloaded through the allowlisted registry. |
| `terraform plan -lock=false` | Worked. The data sources were read through the signing proxy. |
| `terraform plan` with locking | `Error acquiring the state lock`, 403 on the lock file |
| `terraform apply` of an SSM parameter | Both writes were refused: `ssm:PutParameter` on the resource, and `s3:PutObject` on the state. `describe-parameters` then found nothing: no resource was created. |

## Gotchas

- **Image `ENV` doesn't reach sandbox processes.** The image set `AWS_DEFAULT_REGION`,
  `CHECKPOINT_DISABLE` and `AWS_PAGER`, and none was present, even in a login shell.
  `HOME` is `/sandbox`. Pass settings with `openshell sandbox create --env`, or export
  them in the launchers.
- **Without a region, the AWS CLI uses global endpoints.** It called
  `sts.amazonaws.com` and `s3.amazonaws.com`, which the policy doesn't list. Always set
  `AWS_DEFAULT_REGION` and `AWS_REGION`.
- **EC2 checks resource ids before authorization.** A write probe on a fake id returns
  `InvalidVpcID.NotFound`, not `UnauthorizedOperation`, so write probes need real ids.
- **Signing settings vary by service.** Every signed endpoint needs its
  `signing_service`, and global IAM needs `signing_region: us-east-1`. The harness
  generates these entries from `aws.services`.

## Consequences for the design

- **§12 works as designed.** Agents can see the infrastructure and run
  `terraform plan -lock=false`. Applying is impossible.
- **§5.4:** environment settings move to `--env` and the launchers.
- **`harness doctor --probe` (§6.2)** can reuse these checks as they are.
