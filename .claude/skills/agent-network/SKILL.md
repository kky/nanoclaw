---
name: agent-network
description: Per-agent outbound internet access policy via a Squid HTTP proxy, plus inter-agent ACL via the existing agent_destinations table. First-class operator control of which agents can reach which sites and which other agents. Triggers on "agent network", "internet access", "agent-network", "agent firewall", "set up squid", "limit agent internet", "block agent from internet", "whitelist domain", "allow domain", "add domain to agent", "block domain", "remove domain from whitelist", "what can the agent reach", "review agent network", "show agent network", "what's allowed for the agent".
---

# /agent-network

Installs a `SquidNetworkPolicyProvider` that gates each agent's outbound HTTP/HTTPS through a Squid proxy with per-agent destination ACLs, while keeping the existing OneCLI gateway in the path for credential injection. Inter-agent communication is gated by the existing `agent_destinations` row mechanism (no new architecture); this skill ships a CLI to manage those rows.

## Architecture in one sentence

Every agent container attaches to a `--internal` (no-NAT) Docker network on a deterministic, pre-allocated IP; Squid listens on `172.30.0.2:3128` and applies per-source-IP destination ACLs, forwarding via `cache_peer parent ... login=PASSTHRU` to OneCLI on the host. The agent's OneCLI BasicAuth is preserved end-to-end, OneCLI remains the sole MITM, and any container whose IP isn't in `data/squid/ips.json` falls through to a default-deny — no allocation, no internet.

## Security note (read before installing)

The egress guarantee — "every agent goes through Squid, no exceptions" — only holds **after the host has been bounced post-install**. The provider's `applyContainerArgs` hook is what attaches each agent container to the `--internal` egress network; without that hook running, Docker spawns the agent on its default bridge with full NAT. So: after `install.ts`, **bounce the host before you start trusting the gating**.

## Install

```bash
pnpm exec tsx .claude/skills/agent-network/scripts/install.ts
```

This is idempotent. Each step is "exists? skip ; missing? do."

It will:

1. Build the Squid container image (`<install-slug>-squid:latest`).
2. Append the `SquidNetworkPolicyProvider` self-registration import to `src/modules/network/index.ts`.
3. Run `pnpm run build` to refresh `dist/`.
4. Print the bounce instruction. Run that yourself — the host needs to restart for the registered provider to take effect.

The first host startup after install runs `ensure()`, which creates the `<install-slug>-egress` Docker network, generates `data/squid/squid.conf` from current DB state, and starts the Squid container. Watch `logs/nanoclaw.log` for `squid-policy-provider:` log lines if anything fails.

## Configure

All commands run as `pnpm exec tsx .claude/skills/agent-network/scripts/configure.ts <flags>`.

### Set an agent's WAN bucket

```bash
# No restrictions — current behavior with no provider.
configure.ts --agent <id-or-folder> --wan full

# Allow only specific domains (the agent's provider's hosts are unioned in
# automatically — no need to remember to whitelist api.anthropic.com).
configure.ts --agent <id-or-folder> --wan whitelisted --domains nytimes.com,reuters.com

# Allow only the agent's provider's API hosts (Anthropic for `claude`,
# localhost for a future `ollama`, etc.). Most-restrictive useful posture
# for an agent that should only ever talk to its model.
configure.ts --agent <id-or-folder> --wan model-only
```

`--wan whitelisted` with `--domains` *replaces* the whitelist wholesale. For incremental edits, use `--add-domain` / `--remove-domain` (below).

### Edit an agent's whitelist incrementally

```bash
# Add one domain. The `--note` is operator-facing — it won't reach Squid.
# Include hints about why and when this entry can be removed so the
# whitelist doesn't accumulate cruft.
configure.ts --agent <id-or-folder> --add-domain proton.me --note "for calendar/mail; permanent"
configure.ts --agent <id-or-folder> --add-domain api.nyt.com --note "research subscription; review 2026-09"

# Remove one domain by name.
configure.ts --agent <id-or-folder> --remove-domain api.nyt.com
```

Both require the agent to already be in `whitelisted` bucket — they refuse to change the bucket implicitly. Each operation persists the change, regenerates Squid config, and runs `squid -k reconfigure` so the new ACL takes effect without dropping connections.

Each domain is stored with its added timestamp; `--show` displays both the timestamp and the note so you can periodically audit and clean.

### Manage inter-agent edges

`agent_destinations` rows are directional — adding `A → B` doesn't add `B → A`. Asymmetric row presence is how publisher-without-ACK works (only one row exists; the receiver has no row back to publish replies through).

```bash
# Add a directional edge. Source's local_name is how it addresses the
# target via send_message inside the container.
configure.ts --add-edge <source-id-or-folder>=<local-name>:<target-id-or-folder>

# Remove a directional edge. The inverse row (if any) is left alone.
configure.ts --remove-edge <source-id-or-folder>=<local-name>

# Inspect — prints WAN policy + every destination this agent has + every
# destination pointing back at this agent.
configure.ts --show <id-or-folder>

# List every agent group with a quick summary line.
configure.ts --list-agents
```

Edits run live — the script calls `writeDestinations` for every active session of the affected source agent, so the running container picks up the new wiring on its next inbound message poll. No restart needed.

## Inspecting state

The DB wrapper avoids depending on a system `sqlite3` binary:

```bash
# Internet access policy column on every agent, sorted by name.
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT id, name, internet_access_policy FROM agent_groups ORDER BY name"

# IP allocations on the egress network.
cat data/squid/ips.json

# Generated Squid config.
cat data/squid/squid.conf

# Squid container logs.
docker logs <install-slug>-squid 2>&1 | tail -50

# Squid access log (every CONNECT incl. denials), persistent on host.
tail -f data/squid/logs/access.log

# DNS query log (every lookup any agent attempts, with source IP).
tail -f data/squid/logs/dns.log
```

## Uninstall

```bash
pnpm exec tsx .claude/skills/agent-network/scripts/uninstall.ts
```

Stops and removes the Squid container, removes the egress Docker network, strips the self-registration import from `src/modules/network/index.ts`, and rebuilds `dist/`. `data/squid/` is left in place so re-install is fast — delete it manually if you want a clean slate.

## Known constraints

- **Configuration is via CLI only.** No interactive UI — operators run `configure.ts` with flags.
- **Newly-created agents start unrestricted** (`internet_access_policy = NULL` is treated as `full`). The `/create-agent` skill doesn't currently call into `/agent-network`. If you want stricter defaults for new agents, set the policy after creation.
- **Inter-agent comms have no direction flags.** `agent_destinations` is a single-row "X may send to Y" gate. Asymmetric row presence handles the publisher and one-way patterns; if you need response-only-with-credit semantics, that's a separate architectural change.
- **Browser access to OneCLI-managed hosts loses credential injection.** Chromium refuses proxy URLs with embedded credentials, so we set `AGENT_BROWSER_PROXY` to a no-auth form. The Node SDK path (via `HTTPS_PROXY` with auth) is the correct route to managed hosts; the browser is for unmanaged ones.

## Removing later

If you decide this skill isn't for you, run the uninstall script. It's reversible — your `agent_destinations` rows and `internet_access_policy` blobs are left in place; only the Squid runtime infra is torn down. Re-installing later picks up where you left off.
