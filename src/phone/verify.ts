import { image, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { normalize } from "./navigation.js";
import type { Phone } from "./phone.js";

/** A deterministic check against the screen's OCR text (already normalized). */
export type Expectation = { label: string; test: (screen: string) => boolean };

/** What must be on screen: exact values in code, the overall meaning judged by Jev. */
export type ScreenCheck = { expect: readonly Expectation[]; question: string };

export type Verdict = { ok: true } | { ok: false; reason: string };

export type JudgeInput = {
  screenshot: Uint8Array;
  screenText: string;
  question: string;
};
/** Returns the probability that the answer to `question` is yes. */
export type Judge = (input: JudgeInput) => Promise<number>;

// Below this, Jev's "yes" is not trusted before or after an irreversible tap.
export const JEV_MIN_YES = 0.8;
const JEV_TIMEOUT_MS = 30_000;

export function textExpectation(text: string): Expectation {
  return {
    label: `"${text}"`,
    test: (screen) => screen.includes(normalize(text)),
  };
}

/** Matches the amount as the screen may print it: 1250, 1,250, 1250.00, ₹1,250.5 ... */
export function amountExpectation(amountInr: number): Expectation {
  const [rupees, paise] = amountInr.toFixed(2).split(".") as [string, string];
  const decimals =
    paise === "00"
      ? "(?:\\.0{1,2})?"
      : paise.endsWith("0")
        ? `\\.${paise[0]}0?`
        : `\\.${paise}`;
  // Neither more digits nor further decimals may follow: ₹1,250 must not match ₹1,250.50.
  const pattern = new RegExp(
    `(?<![\\d.])${rupees}${decimals}(?![\\d])(?!\\.\\d)`,
  );

  return {
    label: `₹${amountInr.toFixed(2)}`,
    test: (screen) => pattern.test(screen.replaceAll(",", "")),
  };
}

export async function verifyScreen(
  phone: Phone,
  judge: Judge,
  check: ScreenCheck,
): Promise<Verdict> {
  const screen = await phone.readText();
  const screenText = screen.lines.map((line) => line.text).join("\n");
  const normalized = normalize(screenText);

  const missing = check.expect.filter(
    (expectation) => !expectation.test(normalized),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `The screen does not show ${missing.map((item) => item.label).join(", ")}.`,
    };
  }

  const yes = await judge({
    screenshot: await phone.screenshot(),
    screenText,
    question: check.question,
  });
  if (yes < JEV_MIN_YES) {
    return {
      ok: false,
      reason: `Jev did not confirm (p=${yes.toFixed(2)}): ${check.question}`,
    };
  }
  return { ok: true };
}

/** Retries {@link verifyScreen} while the screen settles after a tap. */
export async function verifyEventually(
  phone: Phone,
  judge: Judge,
  check: ScreenCheck,
  attempts = 3,
  intervalMs = 1_500,
): Promise<Verdict> {
  let verdict: Verdict = { ok: false, reason: "not checked" };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    verdict = await verifyScreen(phone, judge, check);
    if (verdict.ok) return verdict;
    if (attempt < attempts) await phone.pause(intervalMs);
  }
  return verdict;
}

/** Jev (TypeSafe) judge. Sends the screenshot and its OCR text to TypeSafe's API. */
export function createJevJudge(): Judge {
  let client: TypeSafeClient | undefined;

  return async ({ screenshot, screenText, question }) => {
    client ??= new TypeSafeClient({ defaultModel: "jev-latest" });
    const response = await client.systemOne(
      {
        state: { screenshot: image(screenshot), ocr_text: screenText },
        questions: {
          answer: noul(
            `Looking at the iPhone screen in \`screenshot\` (its OCR text is in \`ocr_text\`): ${question}`,
          ),
        },
      },
      {
        headers: { "TypeSafe-Danger-Zone-Images": "true" },
        timeout: JEV_TIMEOUT_MS,
      },
    );
    return response.answers.answer.noul;
  };
}
