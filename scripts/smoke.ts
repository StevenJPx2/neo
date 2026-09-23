import { NeoBrowser } from "../src/neo.js";

const options =
  process.env.NEO_DEVICE_UDID === undefined
    ? { simulator: true, url: process.env.NEO_URL ?? "https://example.com" }
    : {
        simulator: false,
        deviceUdid: process.env.NEO_DEVICE_UDID,
        ...(process.env.NEO_DEVICE_NAME
          ? { deviceName: process.env.NEO_DEVICE_NAME }
          : {}),
        url: process.env.NEO_URL ?? "https://example.com",
      };
const browser = await NeoBrowser.connect(options);

try {
  const dom = await browser.dom();
  const image = await browser.screenshot();
  console.log(
    JSON.stringify({
      url: process.env.NEO_URL ?? "https://example.com",
      root: dom.tag,
      bytes: image.byteLength,
    }),
  );
} finally {
  await browser.close();
}
