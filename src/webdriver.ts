import type { Locator } from "./types.js";

type WireResponse<T> = { value: T };

export class WebDriverError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(message);
    this.name = "WebDriverError";
  }
}

export class WebDriverClient {
  private sessionId: string | undefined;

  constructor(private readonly baseUrl: string) {}

  async status(): Promise<{ ready: boolean }> {
    return this.request("/status", "GET");
  }

  async createSession(capabilities: Record<string, unknown>): Promise<string> {
    const response = await this.request<{
      sessionId?: string;
      value?: { sessionId?: string };
    }>("/session", "POST", { capabilities: { alwaysMatch: capabilities } });
    const id = response.sessionId ?? response.value?.sessionId;

    if (!id)
      throw new WebDriverError(
        "WebDriver did not return a session id",
        200,
        response,
      );

    this.sessionId = id;
    return id;
  }

  async deleteSession(): Promise<void> {
    if (!this.sessionId) return;

    try {
      await this.request(`/session/${this.sessionId}`, "DELETE");
    } finally {
      this.sessionId = undefined;
    }
  }

  async navigate(url: string): Promise<void> {
    await this.command("/url", "POST", { url });
  }

  async currentUrl(): Promise<string> {
    return this.command<string>("/url", "GET");
  }

  async title(): Promise<string> {
    return this.command<string>("/title", "GET");
  }

  async find(locator: Locator): Promise<string> {
    const result = await this.command<{
      "element-6066-11e4-a52e-4f735466cecf": string;
    }>("/element", "POST", locator);
    return result["element-6066-11e4-a52e-4f735466cecf"];
  }

  async windowHandles(): Promise<string[]> {
    return this.command<string[]>("/window/handles", "GET");
  }

  async switchToWindow(handle: string): Promise<void> {
    await this.command("/window", "POST", { handle });
  }

  async click(locator: Locator): Promise<void> {
    const element = await this.find(locator);
    await this.command(`/element/${element}/click`, "POST");
  }

  async type(locator: Locator, text: string): Promise<void> {
    const element = await this.find(locator);
    await this.command(`/element/${element}/value`, "POST", {
      text: [...text],
    });
  }

  async screenshot(): Promise<string> {
    return this.command<string>("/screenshot", "GET");
  }

  async execute<T>(script: string, args: unknown[] = []): Promise<T> {
    return this.command<T>("/execute/sync", "POST", { script, args });
  }

  private async command<T>(
    path: string,
    method: string,
    body?: unknown,
  ): Promise<T> {
    if (!this.sessionId)
      throw new WebDriverError("No active WebDriver session", 0, undefined);
    return this.request<T>(`/session/${this.sessionId}${path}`, method, body);
  }

  private async request<T>(
    path: string,
    method: string,
    body?: unknown,
  ): Promise<T> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${this.baseUrl}${path}`, init);
    const payload = (await response.json()) as WireResponse<T> | T;

    if (!response.ok) {
      throw new WebDriverError(
        `WebDriver request failed: ${method} ${path}`,
        response.status,
        payload,
      );
    }

    if (payload && typeof payload === "object" && "value" in payload)
      return payload.value;
    return payload as T;
  }
}
