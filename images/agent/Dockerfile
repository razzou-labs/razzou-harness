# The image of every harness sandbox: Developers and checks now, the Manager and the
# Architect later. build.sh puts this machine's Claude Code binary next to this file.
# OpenShell doesn't pass an image's ENV to sandbox processes, so settings come from the
# daemon (--env), not from here.
FROM ubuntu:24.04

ARG NODE_VERSION=24.21.0
ARG TERRAFORM_VERSION=1.16.3
# AWS publishes signatures, not checksums: these are the sums of the two zips, whose
# signatures by the AWS CLI Team key (FB5D B77F D5C1 18B8 0511 ADA8 A631 0ACC 4672 475C)
# were checked when they were pinned. A new version needs new sums.
ARG AWS_CLI_VERSION=2.39.6
ARG AWS_CLI_SHA256_X86_64=7a121264f2637a3b90767aaf5bdd43ee88b8c925a931d0479fa2ce22b1a2fa76
ARG AWS_CLI_SHA256_AARCH64=5763332bdcb432c19ee122545856fd350c3bb306753212deedcfccc76f4d20c3
ARG CLAUDE_VERSION=unknown
LABEL org.opencontainers.image.title="razzou-harness agent" \
      dev.razzou-harness.claude-code="${CLAUDE_VERSION}"

RUN apt-get update && apt-get install -y --no-install-recommends \
        bash ca-certificates curl g++ git iproute2 jq make procps \
        python3 python3-pip python3-venv unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node and Terraform, each checked against its publisher's checksums; the AWS CLI against the sums above.
RUN arch="$(dpkg --print-architecture | sed 's/^amd64$/x64/')" \
    && file="node-v${NODE_VERSION}-linux-${arch}.tar.xz" \
    && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${file}" \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${file}\$" | sha256sum -c - \
    && tar -xJf "${file}" -C /usr/local --strip-components=1 --no-same-owner \
    && rm "${file}"
RUN arch="$(dpkg --print-architecture)" \
    && file="terraform_${TERRAFORM_VERSION}_linux_${arch}.zip" \
    && curl -fsSLO "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/${file}" \
    && curl -fsSL "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_SHA256SUMS" | grep " ${file}\$" | sha256sum -c - \
    && unzip -q "${file}" terraform -d /usr/local/bin \
    && rm "${file}"
RUN arch="$(uname -m)" \
    && case "${arch}" in x86_64) sum="${AWS_CLI_SHA256_X86_64}" ;; aarch64) sum="${AWS_CLI_SHA256_AARCH64}" ;; *) sum="" ;; esac \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${arch}-${AWS_CLI_VERSION}.zip" -o /tmp/awscli.zip \
    && echo "${sum}  /tmp/awscli.zip" | sha256sum -c - \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscli.zip

COPY claude /usr/local/bin/claude
RUN chmod 0755 /usr/local/bin/claude \
    && groupadd --gid 1500 agent \
    && useradd --uid 1500 --gid agent --create-home --home-dir /home/agent agent \
    && install -d -o agent -g agent /sandbox

WORKDIR /sandbox
USER agent
