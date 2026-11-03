import type { ScreenText } from "../ghosthand.js";
import type { FinalStep } from "../final.js";
import type { Screen, Step } from "../flow.js";
import {
  center,
  firstLine,
  NavigationError,
  normalize,
  waitForLine,
  type LinePicker,
} from "../navigation.js";
import { isTypeable } from "../phone.js";
import { textExpectation } from "../verify.js";
import { appOpen } from "./system.js";

// Experimental: Rapido's labels have not been read on the device yet.
const DESTINATION_LABELS = new Set([
  "where are you going?",
  "where to?",
  "enter drop location",
  "search destination",
]);
const destinationField = firstLine((text) => DESTINATION_LABELS.has(text));
export const VEHICLES = ["bike", "auto", "cab"] as const;
export type Vehicle = (typeof VEHICLES)[number];
const vehicleLine = (vehicle: Vehicle) =>
  firstLine((text) => text.startsWith(vehicle));
const bookButton = firstLine((text) => text.startsWith("book"));

export const RAPIDO_HOME: Screen<"rapido.home"> = {
  name: "rapido.home",
  description: "Rapido's home, with the destination field",
  shows: (screen) => destinationField(screen) !== undefined,
};
export const VEHICLE_LIST: Screen<"rapido.vehicles"> = {
  name: "rapido.vehicles",
  description: "Rapido's vehicle choices",
  shows: (screen) => VEHICLES.some((v) => vehicleLine(v)(screen) !== undefined),
};
export const READY: Screen<"rapido.ready"> = {
  name: "rapido.ready",
  description: "Rapido with a vehicle chosen and the Book button",
  shows: (screen) => bookButton(screen) !== undefined,
};
export const REQUESTED: Screen<"rapido.requested"> = {
  name: "rapido.requested",
  description: "Rapido looking for or assigning a captain",
  shows: (screen: ScreenText) =>
    screen.lines.some((line) =>
      /captain|searching|finding|on the way/.test(normalize(line.text)),
    ),
};

const BACK_PRESSES = 3;
const SETTLE_MS = 900;

/** Rapido reopens wherever it was left; Esc backs out until the destination field shows. */
export const showRapidoHome: Step<"rapido.open", "rapido.home"> = {
  name: "rapido.home",
  from: appOpen("rapido"),
  to: RAPIDO_HOME,
  act: async ({ phone }) => {
    for (let press = 1; press <= BACK_PRESSES; press += 1) {
      if (RAPIDO_HOME.shows(await phone.readText())) return;
      await phone.key("esc");
      await phone.pause(SETTLE_MS);
    }
  },
};

/** Types the destination and picks the first suggestion. */
export function searchDrop(
  drop: string,
): Step<"rapido.home", "rapido.vehicles"> {
  if (!isTypeable(drop))
    throw new Error("The destination must be plain ASCII.");
  return {
    name: "rapido.search_drop",
    from: RAPIDO_HOME,
    to: VEHICLE_LIST,
    act: async ({ phone }) => {
      const field = destinationField(await phone.readText());
      if (field === undefined)
        throw new NavigationError("No destination field.");
      await phone.tap(center(field));
      await phone.type(drop);
      await phone.tap(
        center(
          await waitForLine(
            phone,
            firstSuggestion(drop),
            `a suggestion for "${drop}"`,
          ),
        ),
      );
    },
  };
}

/** The typed text also shows in the field at the top; the first result is the next match below. */
function firstSuggestion(drop: string): LinePicker {
  const token = normalize(drop).split(" ")[0] ?? "";
  return (screen) =>
    screen.lines
      .filter((line) => normalize(line.text).includes(token))
      .sort((a, b) => a.y - b.y)[1];
}

export function pickVehicle(
  vehicle: Vehicle,
): Step<"rapido.vehicles", "rapido.ready"> {
  return {
    name: `rapido.pick_vehicle(${vehicle})`,
    from: VEHICLE_LIST,
    to: READY,
    act: async ({ phone }) => {
      await phone.tap(
        center(
          await waitForLine(
            phone,
            vehicleLine(vehicle),
            `the ${vehicle} option`,
          ),
        ),
      );
    },
  };
}

/** Irreversible: taps Book. */
export function book(
  drop: string,
  vehicle: Vehicle,
): FinalStep<"rapido.ready", "rapido.requested"> {
  return {
    name: "rapido.book",
    from: READY,
    to: REQUESTED,
    summary: `Book a Rapido ${vehicle} from the current location to "${drop}"`,
    ready: {
      expect: [textExpectation("book")],
      question: `Is this Rapido ready to book a ${vehicle} ride to "${drop}", not booked yet?`,
    },
    press: async (phone) =>
      phone.tap(
        center(await waitForLine(phone, bookButton, "the Book button")),
      ),
    done: {
      expect: [],
      question:
        "Has the Rapido ride been requested, e.g. searching for or assigned a captain?",
    },
  };
}
