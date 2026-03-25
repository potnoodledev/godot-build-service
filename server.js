import express from "express";
import { spawn } from "child_process";
import { createInterface } from "readline";
import { homedir } from "os";
import {
  mkdirSync,
  cpSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { buildSystemPrompt } from "./prompt-builder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || "";
const PI_BIN = process.env.PI_BIN || "pi";
const WORKSPACE = process.env.WORKSPACE || "/tmp/workspace";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO =
  process.env.GITHUB_REPO || "potnoodledev/game-a-day-godot-games";
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.NVIDIA_NIM_API_KEY || "";
const TEMPLATE_DIR = join(__dirname, "template");
const SKILL_TEMPLATES_DIR = join(__dirname, "skill-templates");

const app = express();
app.use(express.json({ limit: "50mb" }));

// ── Auth middleware ──────────────────────────────────────────────────

function checkAuth(req, res, next) {
  if (!API_KEY) return next();
  const key = req.body?.api_key || req.query?.api_key || "";
  if (key !== API_KEY) return res.status(403).json({ error: "Invalid api_key" });
  next();
}

// ── Health ───────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ status: "ok", pi: PI_BIN, godot: existsSync("/usr/local/bin/godot") });
});

// ── Pi RPC Process ──────────────────────────────────────────────────

class PiRpcProcess {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.process = null;
    this.rl = null;
    this.listeners = new Set();
    this.ready = false;
  }

  start(cwd, systemPrompt) {
    const args = ["--mode", "rpc", "--cwd", cwd];
    if (systemPrompt) args.push("--system-prompt", systemPrompt);

    this.process = spawn(PI_BIN, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: homedir(),
      },
    });

    this.rl = createInterface({ input: this.process.stdout });
    this.rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        for (const listener of this.listeners) listener(msg);
      } catch {
        console.log(`[pi:${this.sessionId}] ${line}`);
      }
    });

    this.process.stderr.on("data", (data) => {
      console.error(`[pi:${this.sessionId}:err] ${data.toString().trim()}`);
    });

    this.process.on("exit", (code) => {
      console.log(`[pi:${this.sessionId}] Exited with code ${code}`);
      this.ready = false;
    });

    this.ready = true;
    console.log(`[pi:${this.sessionId}] Started in ${cwd}`);
  }

  send(command) {
    if (!this.process || !this.ready) throw new Error("Pi process not running");
    this.process.stdin.write(JSON.stringify(command) + "\n");
  }

  addListener(fn) { this.listeners.add(fn); }
  removeListener(fn) { this.listeners.delete(fn); }

  kill() {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.ready = false;
    }
  }
}

// ── Workspace setup ─────────────────────────────────────────────────

function createWorkspace(sessionId) {
  const workDir = join(WORKSPACE, "builds", sessionId);
  mkdirSync(workDir, { recursive: true });

  // Copy template
  const templateDst = join(workDir, "template");
  cpSync(TEMPLATE_DIR, templateDst, { recursive: true });

  // Install skills
  const skillsDir = join(workDir, ".pi", "skills");
  mkdirSync(skillsDir, { recursive: true });
  cpSync(join(SKILL_TEMPLATES_DIR, "build-game"), join(skillsDir, "build-game"), { recursive: true });
  cpSync(join(SKILL_TEMPLATES_DIR, "deploy-game"), join(skillsDir, "deploy-game"), { recursive: true });

  // Create output dir
  mkdirSync(join(workDir, "output"), { recursive: true });

  return workDir;
}

// ── Generate Game (autonomous agent) ────────────────────────────────

app.post("/generate-game", checkAuth, async (req, res) => {
  const { concept, day, project_name } = req.body;
  if (!concept) return res.status(400).json({ error: "concept is required" });

  const sessionId = randomUUID().slice(0, 8);
  const workDir = createWorkspace(sessionId);
  const systemPrompt = buildSystemPrompt(workDir);

  console.log(`[generate] Session ${sessionId}: "${concept}" (day ${day || "?"})`);

  const rpc = new PiRpcProcess(sessionId);
  const agentLog = [];
  let finalCode = "";
  let pckBase64 = "";
  let ghpagesUrl = "";

  try {
    rpc.start(workDir, systemPrompt);

    // Collect agent output
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Agent timed out (5 minutes)"));
      }, 5 * 60 * 1000);

      rpc.addListener((msg) => {
        if (msg.type === "thinking" || msg.type === "text") {
          agentLog.push(msg.content || "");
        }
        if (msg.type === "tool_use") {
          agentLog.push(`[tool] ${msg.tool}: ${(msg.input || "").slice(0, 200)}`);
        }
        if (msg.type === "tool_result") {
          agentLog.push(`[result] ${(msg.output || "").slice(0, 500)}`);
        }
        if (msg.type === "response" || msg.type === "result") {
          clearTimeout(timeout);
          resolve(msg);
        }
        if (msg.type === "error") {
          clearTimeout(timeout);
          reject(new Error(msg.content || msg.error || "Agent error"));
        }
      });

      // Send the concept as the first prompt
      const prompt = day
        ? `Build a game for the concept: "${concept}". Day number: ${day}. Title: "${project_name || concept}". Write main.gd, build it, and deploy it.`
        : `Build a game for the concept: "${concept}". Write main.gd and build it.`;

      rpc.send({ type: "prompt", message: prompt });
    });

    // Read the generated code
    const mainGdPath = join(workDir, "main.gd");
    const templateMainGd = join(workDir, "template", "main.gd");
    if (existsSync(mainGdPath)) {
      finalCode = readFileSync(mainGdPath, "utf-8");
    } else if (existsSync(templateMainGd)) {
      finalCode = readFileSync(templateMainGd, "utf-8");
    }

    // Read .pck if build succeeded
    const pckPath = join(workDir, "output", "index.pck");
    if (existsSync(pckPath)) {
      pckBase64 = readFileSync(pckPath).toString("base64");
    }

    // Check for gh-pages URL in agent log
    const urlMatch = agentLog.join("\n").match(/https:\/\/potnoodledev\.github\.io[^\s"']*/);
    if (urlMatch) ghpagesUrl = urlMatch[0];

    res.json({
      success: !!pckBase64,
      day: day || 0,
      code: finalCode,
      pck_base64: pckBase64,
      pck_size: pckBase64 ? Buffer.from(pckBase64, "base64").length : 0,
      ghpages_url: ghpagesUrl,
      agent_log: agentLog.slice(-50),
      session_id: sessionId,
    });
  } catch (err) {
    console.error(`[generate] Error: ${err.message}`);
    res.status(500).json({
      success: false,
      error: err.message,
      agent_log: agentLog.slice(-50),
      session_id: sessionId,
    });
  } finally {
    rpc.kill();
    // Clean up workspace after a delay (keep for debugging)
    setTimeout(() => {
      rmSync(workDir, { recursive: true, force: true });
      console.log(`[cleanup] Removed workspace ${sessionId}`);
    }, 60000);
  }
});

// ── Internal deploy endpoint (called by deploy skill script) ────────

app.post("/internal/deploy", async (req, res) => {
  const { day, title, pck_base64, output_dir } = req.body;
  if (!day || !pck_base64) {
    return res.status(400).json({ error: "day and pck_base64 required" });
  }
  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: "GITHUB_TOKEN not configured" });
  }

  try {
    const dayPadded = String(day).padStart(5, "0");
    const basePath = `builds/day-${dayPadded}`;
    const pckBytes = Buffer.from(pck_base64, "base64");

    // Push .pck
    await ghPutFile(`${basePath}/index.pck`, pckBytes, `Build day ${day}: ${title}`);

    // Push runtime files from output dir if available
    if (output_dir) {
      const runtimeFiles = [
        "index.js",
        "index.audio.worklet.js",
        "index.audio.position.worklet.js",
      ];
      for (const fname of runtimeFiles) {
        const fpath = join(output_dir, fname);
        if (existsSync(fpath)) {
          await ghPutFile(`${basePath}/${fname}`, readFileSync(fpath), `Build day ${day}`);
        }
      }

      // Gzip and push wasm
      const wasmPath = join(output_dir, "index.wasm");
      if (existsSync(wasmPath)) {
        const { gzipSync } = await import("zlib");
        const gzipped = gzipSync(readFileSync(wasmPath));
        await ghPutFile(`${basePath}/index.wasm.gz`, gzipped, `Build day ${day}`);
      }
    }

    // Push standalone HTML
    const html = buildStandaloneHtml(title, day);
    await ghPutFile(`${basePath}/index.html`, Buffer.from(html), `Build day ${day}`);

    const url = `https://potnoodledev.github.io/game-a-day-godot-games/${basePath}/`;
    console.log(`[deploy] Day ${day} → ${url}`);
    res.json({ ghpages_url: url });
  } catch (err) {
    console.error(`[deploy] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── GitHub Pages helpers ────────────────────────────────────────────

async function ghPutFile(path, contentBuffer, message) {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Check if file exists (get SHA for update)
  let sha = null;
  const checkResp = await fetch(apiUrl, { headers, method: "GET" });
  // Add ref param for gh-pages
  const checkUrl = `${apiUrl}?ref=gh-pages`;
  const checkResp2 = await fetch(checkUrl, { headers });
  if (checkResp2.ok) {
    const data = await checkResp2.json();
    sha = data.sha;
  }

  const payload = {
    message,
    content: contentBuffer.toString("base64"),
    branch: "gh-pages",
  };
  if (sha) payload.sha = sha;

  const resp = await fetch(apiUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub PUT ${path} failed: ${resp.status} ${text.slice(0, 300)}`);
  }
}

function buildStandaloneHtml(title, day) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>${title} — Game-A-Day Day ${day}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#0a0a1a;overflow:hidden}
canvas#canvas{display:block;width:100%;height:100%}
#loading{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
color:#aaa;font:16px system-ui;background:#0a0a1a}
</style>
</head>
<body>
<div id="loading">Loading ${title}...</div>
<canvas id="canvas" tabindex="1"></canvas>
<script src="index.js"></script>
<script>
const canvas=document.getElementById('canvas');
canvas.width=window.innerWidth;canvas.height=window.innerHeight;
window.addEventListener('resize',()=>{canvas.width=window.innerWidth;canvas.height=window.innerHeight});
const _fetch=window.fetch;
window.fetch=async(input,init)=>{
const url=typeof input==='string'?input:input instanceof URL?input.toString():input.url;
if(url.endsWith('.wasm')){
const resp=await _fetch(url+'.gz',init);
if(resp.ok){const buf=await resp.arrayBuffer();const h=new Uint8Array(buf,0,2);
if(h[0]===0x1f&&h[1]===0x8b){const ds=new DecompressionStream('gzip');const w=ds.writable.getWriter();
w.write(buf);w.close();return new Response(ds.readable,{headers:{'Content-Type':'application/wasm'}});}
return new Response(buf,{headers:{'Content-Type':'application/wasm'}});}}
return _fetch(input,init);};
if(typeof Engine==='function'){
const engine=new Engine({canvasResizePolicy:2,executable:'index',focusCanvas:true,
ensureCrossOriginIsolationHeaders:false,experimentalVK:false,emscriptenPoolSize:0,godotPoolSize:0});
engine.startGame({onProgress:(c,t)=>{if(c>0&&t>0)document.getElementById('loading').textContent='Loading... '+Math.round(c/t*100)+'%';}})
.then(()=>{document.getElementById('loading').style.display='none';});}
</script>
</body>
</html>`;
}

// ── Existing raw build endpoint (kept for backward compat) ──────────

app.post("/build", checkAuth, async (req, res) => {
  // Forward to the Python server if it's running, or handle inline
  // For now, return a message pointing to /generate-game
  res.json({ error: "Use POST /generate-game for autonomous builds, or the Python server for raw builds" });
});

// ── Start ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Godot Build Service listening on port ${PORT}`);
  console.log(`  PI_BIN: ${PI_BIN}`);
  console.log(`  WORKSPACE: ${WORKSPACE}`);
  console.log(`  GITHUB_REPO: ${GITHUB_REPO}`);
  console.log(`  LLM key: ${LLM_API_KEY ? "set" : "NOT SET"}`);
});
