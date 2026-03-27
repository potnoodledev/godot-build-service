import { SimpleAgent } from "./simple-agent.js";
import { DockerBashOperations } from "./docker-bash-ops.js";
import { buildSystemPrompt } from "./prompt-builder.js";
import { buildSystemPromptV2 } from "./prompt-v2.js";

const CONCEPTS = [
  "tap circles for points",
  "dodge falling blocks",
  "bouncing ball",
];

const API_KEY = process.env.MISTRAL_API_KEY;
const BASE_URL = "https://api.mistral.ai/v1";
const MODEL = "mistral-large-latest";
const COOLDOWN = 45000;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runOne(concept, promptFn) {
  const ops = new DockerBashOperations();
  ops.createContainer("godot-build");
  ops.startContainer();
  await new Promise(r => ops.exec("mkdir -p /workspace/template /workspace/output && cp -r /app/template/* /workspace/template/", "/root", { onData: () => {}, timeout: 30 }).then(r));

  const agent = new SimpleAgent({
    apiKey: API_KEY, baseUrl: BASE_URL, model: MODEL,
    systemPrompt: promptFn("/workspace"),
    maxSteps: 20, maxTokens: 16384,
    bashCwd: "/root", bashOps: ops,
  });

  let buildSuccess = false;
  let buildErrors = 0;
  agent.on("tool_result", (d) => {
    if (d.output.includes("BUILD_SUCCESS")) buildSuccess = true;
    if (d.output.includes("SCRIPT ERROR") || d.output.includes("BUILD_FAILED")) buildErrors++;
  });

  const t0 = Date.now();
  const r = await agent.run(`Build a game: ${concept}. Write main.gd, build, verify.`);
  const dur = Math.round((Date.now() - t0) / 1000);

  ops.destroyContainer();
  return { concept, success: buildSuccess, steps: r.steps, duration: dur, errors: buildErrors };
}

async function benchmark(name, promptFn) {
  console.log(`\n=== ${name} ===`);
  const results = [];

  for (const concept of CONCEPTS) {
    if (results.length > 0) {
      console.log(`  (cooling down ${COOLDOWN/1000}s...)`);
      await sleep(COOLDOWN);
    }
    const r = await runOne(concept, promptFn);
    const icon = r.success ? "✅" : "❌";
    console.log(`${icon} ${r.concept}: steps=${r.steps} dur=${r.duration}s errors=${r.errors}`);
    results.push(r);
  }

  const s = results.filter(r => r.success);
  console.log(`\nPass: ${s.length}/${results.length} | Avg steps: ${s.length ? Math.round(s.reduce((a,r) => a+r.steps, 0)/s.length) : '-'} | Avg time: ${s.length ? Math.round(s.reduce((a,r) => a+r.duration, 0)/s.length) : '-'}s`);
  return results;
}

console.log("Starting benchmark...\n");
const v1 = await benchmark("Current Prompt (v1)", buildSystemPrompt);
await sleep(60000);
const v2 = await benchmark("Improved Prompt (v2)", buildSystemPromptV2);

console.log("\n=== COMPARISON ===");
for (let i = 0; i < CONCEPTS.length; i++) {
  const a = v1[i], b = v2[i];
  console.log(`${CONCEPTS[i]}:`);
  console.log(`  v1: ${a.success?'✅':'❌'} ${a.steps} steps ${a.duration}s`);
  console.log(`  v2: ${b.success?'✅':'❌'} ${b.steps} steps ${b.duration}s`);
}

process.exit(0);
