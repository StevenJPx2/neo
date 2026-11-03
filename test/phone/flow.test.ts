import { describe, expect, it } from "vitest";
import { chain, runStep, WrongScreenError } from "../../src/phone/flow.js";
import { NavigationError } from "../../src/phone/navigation.js";
import {
  launchFromSpotlight,
  openApp,
  openSpotlight,
  reset,
} from "../../src/phone/steps/system.js";
import {
  openSearch,
  showChatList,
  typeDraft,
} from "../../src/phone/steps/whatsapp.js";
import { FakePhone, screensWith, systemTransition } from "./fake-phone.js";

const context = (phone: FakePhone) => ({
  phone,
  judge: async () => 0.95,
  passcode: async () => undefined,
});

describe("pairing steps", () => {
  it("joins steps whose screens meet, and names the chain after them", () => {
    const route = chain(reset).then(openSpotlight);
    expect(route.name).toBe("phone.reset → spotlight.open");
    expect(openApp("whatsapp").then(showChatList).to.name).toBe(
      "whatsapp.chat_list",
    );
  });

  it("rejects a pair whose screens do not meet, at compile time", () => {
    // @ts-expect-error typing a draft needs a chat, not the chat list
    chain(showChatList).then(typeDraft("hi"));
    // @ts-expect-error an app launches from Spotlight, not straight from the Home Screen
    chain(reset).then(launchFromSpotlight("whatsapp"));
    const launched = chain(reset)
      .then(openSpotlight)
      .then(launchFromSpotlight("whatsapp"));
    // @ts-expect-error WhatsApp may be locked after launching: unlock comes first
    launched.then(showChatList);
  });

  it("lets a step that starts anywhere (the base reset) follow any step", () => {
    expect(chain(showChatList).then(reset).to.name).toBe("home");
  });
});

describe("running steps", () => {
  it("refuses a step whose start screen is not showing, without any input", async () => {
    const phone = new FakePhone("home", screensWith({}), systemTransition);

    await expect(runStep(context(phone), openSearch)).rejects.toThrow(
      WrongScreenError,
    );
    expect(phone.inputs).toEqual([]);
  });

  it("base setup: gets to the Home Screen from inside an app", async () => {
    const phone = new FakePhone(
      "app",
      screensWith({
        app: [
          ["<", 20, 68],
          ["Some app", 117, 71],
          ["Done", 300, 70],
        ],
      }),
      systemTransition,
    );

    await runStep(context(phone), reset);
    expect(phone.state).toBe("home");
    expect(phone.inputs).toEqual(["key:home"]);
  });

  it("recognizes Spotlight reopened with an old query, whose results hide the Search pill", async () => {
    const phone = new FakePhone(
      "home",
      screensWith({
        stale: [
          ["WhatsAppl", 48, 50],
          ["WhatsApp", 42, 227],
          ["Settings", 37, 399],
          ["Search in App a", 259, 400],
          ["Asha Menon", 99, 565],
          ["Files", 37, 801],
        ],
      }),
      (state, input) =>
        state === "home" && input === "tap:Q Search" ? "stale" : undefined,
    );

    await runStep(context(phone), openSpotlight);
    expect(phone.state).toBe("stale");
  });

  it("base setup: gives up after three Home presses on a locked iPhone", async () => {
    const phone = new FakePhone("locked", screensWith({}), () => undefined);

    await expect(runStep(context(phone), reset)).rejects.toThrow(
      NavigationError,
    );
    expect(phone.inputs).toEqual(["key:home", "key:home", "key:home"]);
  });
});
