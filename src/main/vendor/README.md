# dsh-cost-meter snapshot

Source: https://github.com/Han-1413141/dsh-cost-meter/tree/c9885ddf2f1b09260a1166bac943d30e1121cbae
Retrieved: 2026-09-30. License: MIT, retained in dsh-cost-meter-LICENSE.

- dsh-pricing.mjs: lib/pricing.js, unchanged apart from file extension/line endings.
- dsh-coding-plans.mjs: lib/coding-plans.js; net import points to dsh-net.mjs; unused custom-balance re-export removed.
- dsh-net.mjs: lib/net.js, unchanged apart from file extension/line endings.
- Declaration files describe only the exports consumed by Studio.

Studio uses pricing, model matching and pure quota parsers. Its own main-process quota client limits requests to fixed official endpoints, rejects redirects, bounds responses, and returns no credentials. It discovers keys from configured routes, Pi auth, environment variables and OpenCode login. It does not execute credential shell commands or renew OAuth tokens.

Positive saved cost estimates retain their historical amounts. Missing/zero estimates use the snapshot; custom rates override both. Pi token buckets are mutually exclusive. Subscription equivalent costs are separate from API estimates. Unknown models are explicitly unpriced; no DeepSeek default fallback is applied. Pricing snapshots are not a guarantee of current vendor prices. Only the upstream DeepSeek entries contain effective-date histories; other catalog fallbacks use the snapshot price.
