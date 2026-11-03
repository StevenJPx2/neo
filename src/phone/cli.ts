import { defaultRuntime, PHONE_TOOLS, runPhoneTool } from "./tools.js";

const [name, json = "{}"] = process.argv.slice(2);
const tool = PHONE_TOOLS.find((candidate) => candidate.name === name);

if (tool === undefined) {
  console.error(`Usage: npm run phone -- <action> '<json input>'\n\nActions:`);
  for (const candidate of PHONE_TOOLS)
    console.error(`  ${candidate.name.padEnd(20)} ${candidate.title}`);
  process.exitCode = 2;
} else {
  const outcome = await runPhoneTool(tool, JSON.parse(json), defaultRuntime());
  console.log(JSON.stringify(outcome, null, 2));
  process.exitCode = outcome.status === "blocked" ? 1 : 0;
}
