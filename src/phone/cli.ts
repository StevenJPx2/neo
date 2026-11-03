import { defaultRuntime, PHONE_TOOLS, runPhoneTool } from "./tools.js";

const USAGE = [
  "Usage:",
  "  npm run phone -- <tool> '<json input>'",
  "  npm run phone -- chain <name> '<json vars>'   (staged: same as run_chain with complete false)",
  "",
  "Tools:",
];

const args = process.argv.slice(2);
// "chain <name> <vars>" is shorthand for run_chain; finishing a chain needs run_chain's "complete".
const [name, json = "{}"] =
  args[0] === "chain"
    ? [
        "run_chain",
        JSON.stringify({ name: args[1], vars: JSON.parse(args[2] ?? "{}") }),
      ]
    : args;
const tool = PHONE_TOOLS.find((candidate) => candidate.name === name);

if (tool === undefined) {
  console.error(USAGE.join("\n"));
  for (const candidate of PHONE_TOOLS)
    console.error(`  ${candidate.name.padEnd(30)} ${candidate.title}`);
  process.exitCode = 2;
} else {
  const outcome = await runPhoneTool(tool, JSON.parse(json), defaultRuntime());
  console.log(JSON.stringify(outcome, null, 2));
  process.exitCode = outcome.status === "blocked" ? 1 : 0;
}
