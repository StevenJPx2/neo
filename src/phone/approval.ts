import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type ApprovalDecision = "approved" | "rejected" | "timed_out";
/** Asks the person at the Mac to approve `summary`. Never answered by the agent. */
export type Approver = (summary: string) => Promise<ApprovalDecision>;

const run = promisify(execFile);

// The summary arrives as an argument, never inside the script text, so it cannot inject AppleScript.
// "Reject" is both the default and the cancel button: Return or Escape never approves.
const DIALOG_SCRIPT = [
  "on run argv",
  "  set summary to item 1 of argv",
  "  set waitSeconds to (item 2 of argv) as integer",
  "  try",
  '    set reply to display dialog summary with title "neo: approve phone action" buttons {"Reject", "Approve"} default button "Reject" cancel button "Reject" with icon caution giving up after waitSeconds',
  "  on error number -128",
  '    return "rejected"',
  "  end try",
  '  if gave up of reply then return "timed_out"',
  '  if button returned of reply is "Approve" then return "approved"',
  '  return "rejected"',
  "end run",
];

export function createMacApprover(timeoutSeconds = 120): Approver {
  return async (summary) => {
    const args = DIALOG_SCRIPT.flatMap((line) => ["-e", line]);
    const { stdout } = await run(
      "osascript",
      [...args, summary, String(timeoutSeconds)],
      {
        timeout: (timeoutSeconds + 15) * 1_000,
      },
    );
    const answer = stdout.trim();
    return answer === "approved" || answer === "timed_out"
      ? answer
      : "rejected";
  };
}
