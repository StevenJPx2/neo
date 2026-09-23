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

## Sources

- [Apple: About WebDriver for Safari](https://developer.apple.com/documentation/webkit/about-webdriver-for-safari)
- Local `safaridriver(1)` manual from Safari 26.3 / Xcode 26.3, which documents
  the iOS device and simulator capabilities used above.
