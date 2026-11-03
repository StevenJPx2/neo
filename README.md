# neo

`neo` is a small TypeScript remote browser harness for Safari on a real USB or
Wi-Fi-connected iPhone. It exposes an agent-facing API for navigation, clicks,
typing, screenshots, DOM extraction, and tabs while using Apple's
W3C WebDriver server (`safaridriver`) underneath.

## Why this approach

Apple's current WebDriver documentation describes `safaridriver` as a local REST
server implementing the cross-platform W3C WebDriver API. Its current macOS
manual also explicitly supports `platformName: "iOS"`, paired devices, and iOS
Simulators, with `safari:useSimulator`, `safari:deviceName`, and
`safari:deviceUDID` capabilities. That makes the direct WebDriver boundary the
smallest supported path; no Appium or native app is required.

Safari automation is isolated from ordinary browsing data and only one session
can be attached at a time. `neo` preserves both constraints.

## Setup

```sh
npm install
safaridriver --enable
npm test
npm run build
```

Enable **Web Inspector** and **Remote Automation** on the iPhone, pair it with
the Mac, and keep Safari available. For a simulator, install Xcode and leave
`NEO_DEVICE_UDID` unset. `safaridriver` will select or boot an iPhone
Simulator automatically when `safari:useSimulator` is true.

## Smoke path

```sh
# Real paired device
NEO_DEVICE_UDID=<udid> npm run smoke

# Simulator fallback
npm run smoke
```

The smoke test starts `safaridriver` if port 7055 is not already listening,
creates an iOS session, navigates to `example.com`, extracts the DOM, captures
a screenshot, and always deletes the session. `NEO_DEVICE_NAME` and `NEO_URL`
are optional.

## API

```ts
const browser = await NeoBrowser.connect({ simulator: true });
await browser.navigate("https://example.com");
await browser.click({ using: "css selector", value: "a" });
await browser.type({ using: "css selector", value: "input" }, "hello");
const dom = await browser.dom();
const png = await browser.screenshot();
await browser.close();
```

## Optional: Ghosthand for on-device interaction

[Ghosthand](https://ghosthand.dev/) is a separate screen-based controller for
real iPhones. It complements Neo; it does not provide Neo’s WebDriver DOM API
or support the iOS Simulator. It requires a USB connection and Bluetooth pairing.

On the Mac, run `npx ghosthand setup` and complete sign-in, permissions, USB
trust, and Bluetooth pairing in the Ghosthand window. Check readiness with
`ghosthand setup status` (or `npx ghosthand setup status`).

Agents do not get Ghosthand's own MCP server: the included `opencode.json`
registers only `neo-phone` (below), which talks to the local daemon's socket and
allows only fixed, checked steps. Disconnect the phone or stop the daemon when
access is not needed.

## Phone actions and the `neo-phone` MCP server

`src/phone/` turns Ghosthand into fixed, safe-by-default actions:
`send_whatsapp_text`, `order_water`, `send_money` (UPI in CRED), `book_rapido`
(experimental) and `open_app`. Each action starts from any screen and is a chain
of small hardcoded steps whose start and end screens are checked on the device;
the steps are tools too, for agents that chain them. Each action stops before its
final tap unless called with `complete: true`, and then still needs Approve in a
dialog on the Mac.

```sh
npm run phone -- send_money '{"vpa":"shop@okhdfcbank","payeeName":"Ravi","amountInr":250}'
npm run phone -- phone_screen
npm run phone -- chain note-to-self '{"text":"Buy milk"}'
```

Sequences you run often can be saved as chains of steps with variables in
`~/.config/neo/chains.json`; see [src/phone/README.md](src/phone/README.md#saved-chains-chainsts).

The included `opencode.json` registers the actions and steps as the local
`neo-phone` MCP server. Setup, safety rules and the config file are in
[src/phone/README.md](src/phone/README.md).

## Sources

- [Apple: About WebDriver for Safari](https://developer.apple.com/documentation/webkit/about-webdriver-for-safari)
- Local `safaridriver(1)` manual from Safari 26.3 / Xcode 26.3, which documents
  the iOS device and simulator capabilities used above.
