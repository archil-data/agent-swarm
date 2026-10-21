import fs from "node:fs";
import { runHarness } from "./harness.mjs";
const config = JSON.parse(fs.readFileSync("/mnt/archil/runtime/config.json"));
const result = await runHarness(config);
console.log(JSON.stringify(result));
if (!result.success) process.exitCode = 1;
