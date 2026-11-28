# The Claude Code Harness image (ADR 0029): the kit's base image plus
# /opt/agent-kit, which holds the pinned CLI and the Node it runs on. Built
# for amd64 and arm64 by .github/workflows/harness-images.yml with
# `node docker/harness-images/image.mjs publish claude-code`, which passes the
# CLI version the adapter pins (cli/src/harness/claude-code.mjs); the adapter
# records the digest. It has no build context.
#
# The monthly refresh (harness-images-refresh.yml) moves both FROM digests and
# REFRESHED, so a rebuild takes Debian's current packages and the newest Node 24
# of the node image's tag, for the harness and the project alike.

# The harness: the pinned CLI and its own Node, all under /opt/agent-kit, off
# the project's path. A later stage, or a local build on another glibc image,
# copies that one directory. The pinned CLI is a native binary, so nothing runs
# that Node today: ADR 0029 puts it there so the harness never leans on the
# project's, and the last check below holds the CLI to that.
FROM node:24-trixie-slim@sha256:4d00acb4bcc42c454c4eb801526f7ad7f772ea3bd4fd168c5cc2e384abcbb9d4 AS harness
ARG CLI_VERSION
RUN set -eu; \
  test -n "$CLI_VERSION"; \
  mkdir -p /opt/agent-kit/bin /opt/agent-kit/node/bin; \
  npm install --global --prefix /opt/agent-kit/cli --no-audit --no-fund "@anthropic-ai/claude-code@$CLI_VERSION"; \
  cp /usr/local/bin/node /opt/agent-kit/node/bin/node; \
  ln -s ../cli/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe /opt/agent-kit/bin/claude

# The kit's base: Debian slim with the tools a Stage and an ordinary Node or
# Python project need, from Debian's own packages, and Node 24 LTS from the
# pinned node image above (ADR 0029: Debian's Node is past its end of life).
FROM debian:trixie-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0
ARG CLI_VERSION
ARG REFRESHED=2026-11
RUN set -eu; \
  echo "packages as of $REFRESHED"; \
  apt-get update; \
  DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
    bash ca-certificates curl git python3 python3-pip python3-venv; \
  rm -rf /var/lib/apt/lists/*
# The project's Node 24 and its npm, as the node image lays them out. The
# harness's own copy stays in /opt/agent-kit, off the path.
COPY --from=harness /usr/local/bin/node /usr/local/bin/node
COPY --from=harness /usr/local/include/node /usr/local/include/node
COPY --from=harness /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
RUN node --version | grep -E '^v24\.' && npm --version && npx --version
# The sandbox is one run's own, so pip may install beside Debian's packages.
ENV DISABLE_AUTOUPDATER=1 PIP_BREAK_SYSTEM_PACKAGES=1
COPY --from=harness /opt/agent-kit /opt/agent-kit
# The pinned CLI first, as on a layered image: a `claude` a setup step installs
# never runs in its place. This `bin` holds that CLI alone, never the Node.
ENV PATH="/opt/agent-kit/bin:${PATH}"
# The adapter's install layer, as it runs on another image.
RUN ln -sf /opt/agent-kit/bin/claude /usr/local/bin/claude \
  && mkdir -p /etc/claude-code \
  && printf '%s\n' '{"env":{"DISABLE_AUTOUPDATER":"1"}}' > /etc/claude-code/managed-settings.json
# The build fails unless the CLI that runs is the pinned one, and unless it
# runs with nothing on the path, as on a recipe image with no Node: a CLI that
# needed one would have to be started with /opt/agent-kit/node/bin/node.
RUN claude --version | grep -F "$CLI_VERSION"
RUN env -i PATH=/nonexistent /opt/agent-kit/bin/claude --version | grep -F "$CLI_VERSION"
WORKDIR /workspace
