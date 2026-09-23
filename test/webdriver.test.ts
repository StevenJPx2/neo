import { describe, expect, it } from "vitest";
import { WebDriverClient } from "../src/webdriver.js";

describe("WebDriverClient", () => {
  it("uses the W3C session response and element endpoint", async () => {
    const requests: Request[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      requests.push(new Request(input, init));
      const url = String(input);
      const body = url.endsWith("/session")
        ? { value: { sessionId: "abc" } }
        : url.endsWith("/element")
          ? { value: { "element-6066-11e4-a52e-4f735466cecf": "el" } }
          : { value: null };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const client = new WebDriverClient("http://127.0.0.1:7055");
      await client.createSession({ browserName: "safari" });
      await client.click({ using: "css selector", value: "button" });
      expect(
        requests.map(
          (request) => `${request.method} ${new URL(request.url).pathname}`,
        ),
      ).toEqual([
        "POST /session",
        "POST /session/abc/element",
        "POST /session/abc/element/el/click",
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
