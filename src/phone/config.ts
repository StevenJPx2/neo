import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { normalizePhoneNumber } from "./formats.js";

export const DEFAULT_CONFIG_PATH = join(
  homedir(),
  ".config",
  "neo",
  "phone.json",
);

const PhoneNumberSchema = z
  .string()
  .refine(
    (value) => tryNormalize(value) !== undefined,
    "Use a phone number with country code, e.g. +919876543210",
  );

const ASCII = /^[\x20-\x7e]+$/;
const ASCII_HINT = "Use plain ASCII: the phone keyboard types US-ASCII only.";

const ConfigSchema = z.strictObject({
  contacts: z.record(z.string().min(1), PhoneNumberSchema).default({}),
  water: z
    .strictObject({
      vendor: z
        .string()
        .min(1)
        .describe(
          "The supplier's WhatsApp chat name, a contact name above, or a phone number",
        ),
      // Typed on the phone's keyboard, which types US-ASCII only.
      address: z.string().min(1).max(300).regex(ASCII, ASCII_HINT),
      item: z
        .string()
        .min(1)
        .max(60)
        .regex(ASCII, ASCII_HINT)
        .default("20 L water can"),
    })
    .optional(),
  payments: z
    .strictObject({
      maxAmountInr: z.number().positive().max(100_000).default(5_000),
    })
    .prefault({}),
});
export type PhoneConfig = z.infer<typeof ConfigSchema>;

export function configPath(): string {
  return process.env["NEO_PHONE_CONFIG"] ?? DEFAULT_CONFIG_PATH;
}

/** Reads the config file; a missing file means the defaults (no contacts, no water vendor). */
export async function loadConfig(
  path: string = configPath(),
): Promise<PhoneConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return ConfigSchema.parse({});
    throw error;
  }
  return parseConfig(raw, path);
}

export function parseConfig(raw: string, source = "phone config"): PhoneConfig {
  const result = ConfigSchema.safeParse(JSON.parse(raw));
  if (!result.success)
    throw new Error(`Invalid ${source}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** Who a WhatsApp message goes to: a chat found by its name, or by a phone number. */
export type Recipient =
  | { kind: "chat"; name: string }
  | { kind: "number"; label: string; digits: string };

const PHONE_NUMBER_LIKE = /^\+?[\d\s()-]{10,}$/;

/** A saved contact's number, a phone number, or else a WhatsApp chat name. */
export function resolveRecipient(config: PhoneConfig, to: string): Recipient {
  const saved = config.contacts[to];
  if (saved !== undefined)
    return { kind: "number", label: to, digits: normalizePhoneNumber(saved) };
  if (PHONE_NUMBER_LIKE.test(to))
    return { kind: "number", label: to, digits: normalizePhoneNumber(to) };
  return { kind: "chat", name: to };
}

function tryNormalize(value: string): string | undefined {
  try {
    return normalizePhoneNumber(value);
  } catch {
    return undefined;
  }
}
