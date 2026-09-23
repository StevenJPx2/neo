import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { WebDriverClient } from "./webdriver.js";
import type { DomNode, Locator, NeoSessionOptions, Tab } from "./types.js";

const DEFAULT_PORT = 7055;
const execFileAsync = promisify(execFile);

export class NeoBrowser {
  private readonly driver: WebDriverClient;
  private process: ChildProcess | undefined;
  private simulatorUdid: string | undefined;

  private constructor(
    private readonly options: NeoSessionOptions,
    driver: WebDriverClient,
  ) {
    this.driver = driver;
  }

  static async connect(options: NeoSessionOptions = {}): Promise<NeoBrowser> {
    const port = options.port ?? DEFAULT_PORT;
    const driver = new WebDriverClient(`http://127.0.0.1:${port}`);
    const browser = new NeoBrowser(options, driver);

    if (!(await browser.isDriverReady())) await browser.startDriver(port);
    if (options.simulator === true) await browser.prepareSimulator();

    await driver.createSession(browser.capabilities());
    if (options.url) await driver.navigate(options.url);
    return browser;
  }

  async navigate(url: string): Promise<void> {
    await this.driver.navigate(url);
  }

  async click(locator: Locator): Promise<void> {
    await this.driver.click(locator);
  }

  async type(locator: Locator, text: string): Promise<void> {
    await this.driver.type(locator, text);
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from(await this.driver.screenshot(), "base64");
  }

  async dom(): Promise<DomNode> {
    return this.driver.execute<DomNode>(`return (function walk(node) {
      return { tag: node.tagName.toLowerCase(), attributes: Object.fromEntries([...node.attributes].map(a => [a.name, a.value])), text: node.childElementCount ? '' : (node.textContent || '').trim(), children: [...node.children].map(walk) };
    })(document.documentElement);`);
  }

  async tabs(): Promise<Tab[]> {
    const handles = await this.driver.windowHandles();
    const currentUrl = await this.driver.currentUrl();
    const currentTitle = await this.driver.title();
    return handles.map((id) => ({ id, title: currentTitle, url: currentUrl }));
  }

  async switchTab(id: string): Promise<void> {
    await this.driver.switchToWindow(id);
  }

  async close(): Promise<void> {
    await this.driver.deleteSession();
    if (this.process && !this.process.killed) this.process.kill("SIGTERM");
    this.process = undefined;
  }

  private capabilities(): Record<string, unknown> {
    const capabilities: Record<string, unknown> = {
      browserName: "safari",
      platformName: "iOS",
    };
    if (this.options.simulator !== undefined)
      capabilities["safari:useSimulator"] = this.options.simulator;
    if (this.options.simulator === true)
      capabilities["safari:deviceType"] = "iPhone";
    if (this.options.deviceName)
      capabilities["safari:deviceName"] = this.options.deviceName;
    if (this.options.deviceUdid ?? this.simulatorUdid)
      capabilities["safari:deviceUDID"] =
        this.options.deviceUdid ?? this.simulatorUdid;
    if (this.options.platformVersion)
      capabilities["safari:platformVersion"] = this.options.platformVersion;
    return capabilities;
  }

  private async isDriverReady(): Promise<boolean> {
    try {
      return (await this.driver.status()).ready;
    } catch {
      return false;
    }
  }

  private async startDriver(port: number): Promise<void> {
    this.process = spawn(
      this.options.driverPath ?? "safaridriver",
      ["-p", String(port)],
      { stdio: "ignore" },
    );
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await this.isDriverReady()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("safaridriver did not become ready within 5 seconds");
  }

  private async prepareSimulator(): Promise<void> {
    const { stdout } = await execFileAsync("xcrun", [
      "simctl",
      "list",
      "devices",
      "available",
      "-j",
    ]);
    const devices = JSON.parse(stdout) as {
      devices: Record<
        string,
        Array<{ name: string; udid: string; state: string }>
      >;
    };
    const device = Object.values(devices.devices)
      .flat()
      .find((candidate) => candidate.name.startsWith("iPhone"));
    if (!device)
      throw new Error(
        "No available iPhone Simulator was found. Install an iOS Simulator runtime in Xcode.",
      );
    this.simulatorUdid = device.udid;
    if (device.state !== "Booted")
      await execFileAsync("xcrun", ["simctl", "boot", device.udid]);
    await execFileAsync("xcrun", ["simctl", "bootstatus", device.udid, "-b"]);
  }
}

export type { DomNode, Locator, NeoSessionOptions, Tab };
