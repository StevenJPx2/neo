# neo agent instructions

## Scope

neo is a local macOS service for driving Safari through Apple's W3C WebDriver
server (`safaridriver`). It targets a paired iPhone/iPad first and an iOS
Simulator second.

`src/phone/` adds fixed phone actions (WhatsApp, water, UPI in CRED, Rapido)
driven through the local Ghosthand daemon. Each action is a chain of hardcoded
steps (`src/phone/steps/`); actions and steps are exposed as the `neo-phone` MCP
server and a CLI. Agents use `neo-phone`, not Ghosthand's own MCP. See
`src/phone/README.md` and `src/phone/steps/README.md`.

## Commands

- `npm run build` — strict TypeScript check
- `npm test` — unit and contract tests
- `npm run smoke` — live smoke test; selects a paired iOS host when available,
  otherwise requests an iPhone Simulator session
- `npm run phone -- <action or step> '<json>'` — run one tool against the real iPhone
- `npm run phone:mcp` — the `neo-phone` MCP server (stdio)

## Constraints

- Keep the public API browser-agent friendly and WebDriver-shaped.
- Do not expose arbitrary shell execution or arbitrary WebDriver endpoints.
- Allow only one active session; this mirrors Safari's own limitation.
- Keep process and session cleanup explicit.
- Use native Node APIs before adding dependencies.

## Phone action rules

- Phone actions are fixed, named actions. Do not add a tool that taps, types or
  opens URLs from free-form input.
- Actions run inside the apps themselves; do not route through Safari or deep
  links (Enter does not work in Safari's address bar from the Bluetooth keyboard).
- Every action starts with `phone.reset` (the base setup), so it works from any
  screen. Every step declares its start and end `Screen`, read from the device
  first; pair steps with `chain(...).then(...)` so mismatches fail to compile.
- Saved chains (`~/.config/neo/chains.json`, from the dotfiles repo's
  `configs/neo`) may only name step tools. `complete` is never saved in them,
  and they are checked in full before the phone is leased.
- An irreversible step (send, pay, book) needs `complete: true`, a passing
  screen check (OCR values in code and Jev), and Approve in the macOS dialog.
  Never bypass, auto-answer, or retry past any of the three.
- The only secret neo types is the iPhone passcode, and only in `unlock.ts`: read
  from the macOS Keychain, typed into the iOS passcode prompt for the app being
  unlocked (OCR and Jev both confirm it), at most once per call, never retried,
  never logged or returned. Never type a UPI PIN or any other password.
- After a final tap whose result is unconfirmed, report it; never repeat the tap.
