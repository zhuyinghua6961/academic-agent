import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(scriptsDir, "..");
const input = join(webRoot, "../../contracts/openapi/platform.v1.yaml");
const output = join(webRoot, "src/api/schema.d.ts");
const openapiTypescript = join(webRoot, "node_modules/.bin/openapi-typescript");

execFileSync(openapiTypescript, [input, "-o", output], { stdio: "inherit" });

console.log(`Generated ${output}`);
