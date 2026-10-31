# Contributing

Thanks for helping. `main` is protected: only the maintainer can push to it, and everyone else
contributes through pull requests.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Change sources under `src/`. Never hand-edit `lib/client.js` — it is a build artifact; `npm run build` regenerates it.
3. Keep the test suite offline (no network, no API keys). Add or adjust tests under `test/`; `npm test` must pass on Node 22 and 24.
4. Run `npm run check:bundle` when you touch `package.json`, `cordis.patch.yml` or `build.mjs`.
5. Open the PR against `main`. CI (Node 22/24, offline tests, bundle-manifest check, `npm pack --dry-run`) must be green; the maintainer reviews and merges.

## Design guardrails

- No new runtime dependencies in the host or client half — the client bundle is assembled by a zero-dependency script.
- Every file access must stay inside the configured vault (lexical normalization first, then `realpath` containment).
- The plugin must not modify the DSH installation; it only contributes a bundle layer plus host/client plugin modules.
- Keep the plugin's existing settings file and browser localStorage keys stable so upgrades do not lose user state.
