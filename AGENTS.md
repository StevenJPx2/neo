# neo agent instructions

## Scope

neo is a local macOS service for driving Safari through Apple's W3C WebDriver
server (`safaridriver`). It targets a paired iPhone/iPad first and an iOS
Simulator second.

## Commands

- `npm run build` — strict TypeScript check
- `npm test` — unit and contract tests
- `npm run smoke` — live smoke test; selects a paired iOS host when available,
  otherwise requests an iPhone Simulator session

## Constraints

- Keep the public API browser-agent friendly and WebDriver-shaped.
- Do not expose arbitrary shell execution or arbitrary WebDriver endpoints.
- Allow only one active session; this mirrors Safari's own limitation.
- Keep process and session cleanup explicit.
- Use native Node APIs before adding dependencies.
