# dsh-agy-cli

[![npm](https://img.shields.io/npm/v/dsh-agy-cli)](https://www.npmjs.com/package/dsh-agy-cli)
[![license](https://img.shields.io/github/license/Gaudi-XIX/dsh-agy-cli)](LICENSE)

Runs the locally authenticated **Google Antigravity CLI (`agy`)** as a first-class model provider for [DeepSeek Harness (DSH)](https://github.com/darkings/dsh). **All upstream traffic is signed by the official binary itself; tool execution, approvals and workspace sandbox stay 100% inside DSH.**

> **Continuation notice**: this project continues [`darkings/dsh-agy-provider`](https://github.com/darkings/dsh-agy-provider) — the original author has been inactive since 2026-08-28. Maintained here since 2026-10-12 (DSH 0.2.0-rc.2 host adaptation, MCP tool bridge, a full-source security audit). The git history preserves every original attribution; MIT license unchanged. The model route id stays `agy`.

For the full market-position survey (25 AGY-family plugins across 6 technical dimensions, the three provider routes, and honest comparisons against `dsh-agy-safe` and `dsh-antigravity-acp`), see [README.md](README.md) (Chinese). The short version:

- **Dimension**: model-provider integration — the largest of the 6 dimensions (12 of 25 plugins).
- **Our cell**: *official channel + DSH-owned harness*. The only cell of the three provider routes that is immune to how strong or weak the upstream agent's own harness is. Its CLI front now has exactly one maintained plugin — this one.
- **Versus the OAuth-extraction majority (8 plugins)**: they gain freedom (account pools, image generation) at the cost of forged-client traffic and ban risk; we keep zero forged traffic.
- **Versus `dsh-antigravity-acp`**: same harness ownership, different protocol — it speaks the official ACP standard through a separately downloaded server process (~52 s cold start), we speak the CLI's private stream-json through the light binary you already have (seconds to start). Our edge is lightness and the widest-compatible channel; theirs is a standards-grade contract and deeper feature polish. Both are honest choices of the same first principles: no token extraction, official-signed traffic, tools owned by DSH.

## Install

```console
dsh plugin --profile <your profile> add dsh-agy-cli
```

Requires the official Antigravity CLI installed and signed in locally; Node ≥ 22. Migrating from `dsh-agy-provider` or `dsh-agy-safe`: the route id is unchanged (`agy`); the runtime data directory moved from `~/.dsh/agy-link/` to `~/.dsh/agy-cli/`.

## License

MIT. Original work copyright Darkings (darkings/dsh-agy-provider); this continuation preserves the full attribution history under the same license.
