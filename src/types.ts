export type Locator =
  | { using: "css selector"; value: string }
  | { using: "xpath"; value: string }
  | { using: "tag name"; value: string }
  | { using: "link text"; value: string };

export type Tab = { id: string; title: string; url: string };

export type DomNode = {
  tag: string;
  attributes: Record<string, string>;
  text: string;
  children: DomNode[];
};

export type NeoSessionOptions = {
  url?: string;
  deviceName?: string;
  deviceUdid?: string;
  platformVersion?: string;
  simulator?: boolean;
  port?: number;
  driverPath?: string;
};
