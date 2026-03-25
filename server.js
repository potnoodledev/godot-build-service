import express from "express";
import { execSync } from "child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { buildSystemPrompt } from "./prompt-builder.js";

import { Agent } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { createBashTool } from "@mariozechner/pi-coding-agent";
import { DockerBashOperations } from "./docker-bash-ops.js";
import { LocalBashOperations } from "./local-bash-ops.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO =
  process.env.GITHUB_REPO || "potnoodledev/game-a-day-godot-games";
const NIM_API_KEY = process.env.LLM_API_KEY || process.env.NVIDIA_NIM_API_KEY || "";
const DOCKER_IMAGE = process.env.DOCKER_IMAGE || "godot-build";
const MAX_STEPS = 30;
const CONTAINER_CWD = "/root";

// Detect if Docker is available
let HAS_DOCKER = false;
try { execSync("docker info", { stdio: "pipe" }); HAS_DOCKER = true; } catch {}

// Detect if Godot is available locally (Railway container)
let HAS_LOCAL_GODOT = false;
try { execSync("godot --version", { stdio: "pipe" }); HAS_LOCAL_GODOT = true; } catch {}

const TEMPLATE_DIR = join(__dirname, "template");

const PREVIEWS_DIR = join("/tmp", "previews");
mkdirSync(PREVIEWS_DIR, { recursive: true });

// Track active sessions
const sessions = new Map(); // sessionId → { day, title, success, previewUrl }

const app = express();
app.use(express.json({ limit: "50mb" }));

// Serve preview files
app.use("/preview", express.static(PREVIEWS_DIR));

// ── Auth ────────────────────────────────────────────────────────────

function checkAuth(req, res, next) {
  if (!API_KEY) return next();
  const key = req.body?.api_key || req.query?.api_key || "";
  if (key !== API_KEY) return res.status(403).json({ error: "Invalid api_key" });
  next();
}

// ── Health ──────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ status: "ok", nim_key: !!NIM_API_KEY, docker: HAS_DOCKER, local_godot: HAS_LOCAL_GODOT, mode: HAS_DOCKER ? "docker" : "local" });
});

// ── NIM Model ──────────────────────────────────────────────────────

function nimModel(modelId) {
  return {
    id: modelId,
    name: modelId.split("/").pop() || modelId,
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 4096,
    headers: { Authorization: `Bearer ${NIM_API_KEY}` },
  };
}

// ── Generate Game (Docker-isolated agent) ───────────────────────────

app.post("/generate-game", checkAuth, async (req, res) => {
  const { concept, day, project_name } = req.body;
  if (!concept) return res.status(400).json({ error: "concept is required" });
  if (!NIM_API_KEY) return res.status(500).json({ error: "LLM_API_KEY not configured" });

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };
  const sessionId = randomUUID().slice(0, 8);
  const modelId = process.env.LLM_MODEL || "moonshotai/kimi-k2.5";
  const useDocker = HAS_DOCKER && !process.env.FORCE_LOCAL;
  const ops = useDocker ? new DockerBashOperations() : new LocalBashOperations(TEMPLATE_DIR);

  console.log(`[generate] Session ${sessionId}: "${concept}" (model: ${modelId}, ${useDocker ? "docker" : "local"})`);
  send({ type: "session", session_id: sessionId, model: modelId });

  let workspacePath;
  try {
    // 1. Setup workspace
    if (useDocker) {
      send({ type: "status", message: "Starting Docker container..." });
      const containerId = ops.createContainer(DOCKER_IMAGE);
      ops.startContainer();
      workspacePath = "/workspace";
      await ops.exec(
        "mkdir -p /workspace/template /workspace/output && cp -r /app/template/* /workspace/template/ && echo 'Ready'",
        "/root",
        { onData: (d) => console.log(`  [setup] ${d.toString().trim()}`), timeout: 30 },
      );
    } else {
      send({ type: "status", message: "Setting up workspace..." });
      workspacePath = ops.createWorkspace();
    }
    send({ type: "status", message: "Workspace ready" });

    // 2. Create model + tools
    const model = nimModel(modelId);
    const bashCwd = useDocker ? "/root" : workspacePath;
    const bashTool = createBashTool(bashCwd, { operations: ops });

    // 3. Build system prompt
    const systemPrompt = buildSystemPrompt(workspacePath);

    // 4. Create agent
    let stepCount = 0;
    let succeeded = false;

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools: [bashTool],
        thinkingLevel: "off",
      },
      streamFn: streamSimple,
      getApiKey: () => NIM_API_KEY,
    });

    agent.subscribe((event) => {
      switch (event.type) {
        case "message_end":
          if (event.message?.role === "assistant") {
            const text = event.message.content
              ?.map((c) => c.text || "").join("") || "";
            if (text) send({ type: "text", content: text.slice(0, 500) });
          }
          break;

        case "tool_execution_start":
          stepCount++;
          const cmd = event.args?.command || "";
          send({ type: "tool", step: stepCount, command: cmd.slice(0, 200) });
          console.log(`  [${sessionId}] Step ${stepCount}: ${cmd.slice(0, 100)}`);
          if (stepCount >= MAX_STEPS) {
            send({ type: "status", message: `Max steps (${MAX_STEPS}) reached` });
            agent.abort();
          }
          break;

        case "tool_execution_end": {
          const resultText = typeof event.result === "string"
            ? event.result
            : event.result?.content?.map((c) => c.text || "").join("") || "";

          // Stream key results
          if (resultText.includes("BUILD_SUCCESS") || resultText.includes("BUILD_FAIL") ||
              resultText.includes("SCRIPT ERROR") || resultText.includes("Wrote main.gd")) {
            send({ type: "build_output", output: resultText.slice(0, 1000) });
          }

          if (resultText.includes("BUILD_SUCCESS")) {
            succeeded = true;
          }
          break;
        }
      }
    });

    // 5. Run agent
    send({ type: "status", message: "Agent thinking..." });
    const prompt = `Build a game for the concept: "${concept}". Title: "${project_name || concept}".
Write the complete main.gd, build it with Godot, and verify the build succeeds.
If the build fails, fix the errors and rebuild.`;

    await agent.prompt(prompt);
    await agent.waitForIdle();

    // 6. Collect results
    let code = "";
    let pckBase64 = "";

    // Read main.gd from workspace
    try {
      const readResult = await new Promise((resolve) => {
        let output = "";
        ops.exec(`cat ${workspacePath}/template/main.gd 2>/dev/null`, bashCwd, {
          onData: (d) => { output += d.toString(); },
          timeout: 5,
        }).then(() => resolve(output)).catch(() => resolve(""));
      });
      code = readResult;
    } catch {}

    // Read .pck from workspace
    if (succeeded) {
      try {
        const pckResult = await new Promise((resolve) => {
          let output = "";
          ops.exec(`base64 -w0 ${workspacePath}/output/index.pck 2>/dev/null`, bashCwd, {
            onData: (d) => { output += d.toString(); },
            timeout: 10,
          }).then(() => resolve(output.trim())).catch(() => resolve(""));
        });
        pckBase64 = pckResult;
      } catch {}
    }

    // 7. Copy build output to preview directory
    let previewUrl = "";
    if (succeeded) {
      send({ type: "status", message: "Setting up preview..." });
      const previewDir = join(PREVIEWS_DIR, sessionId);
      mkdirSync(previewDir, { recursive: true });

      // Copy output files to preview dir
      const filesToCopy = ["index.pck", "index.js", "index.wasm", "index.audio.worklet.js", "index.audio.position.worklet.js"];
      for (const fname of filesToCopy) {
        try {
          let content = "";
          await ops.exec(`base64 -w0 ${workspacePath}/output/${fname} 2>/dev/null`, bashCwd, {
            onData: (d) => { content += d.toString(); },
            timeout: 30,
          });
          if (content.trim()) {
            const buf = Buffer.from(content.trim(), "base64");
            // Gzip wasm
            if (fname === "index.wasm") {
              const { gzipSync } = await import("zlib");
              writeFileSync(join(previewDir, "index.wasm.gz"), gzipSync(buf));
            } else {
              writeFileSync(join(previewDir, fname), buf);
            }
          }
        } catch {}
      }

      // Write standalone HTML
      const title = project_name || concept;
      writeFileSync(join(previewDir, "index.html"), buildStandaloneHtml(title, day || 0));
      previewUrl = `/preview/${sessionId}/`;
    }

    // Store session info
    sessions.set(sessionId, {
      day: day || 0,
      title: project_name || concept,
      concept,
      success: succeeded,
      previewUrl,
      pckBase64,
      code: code.slice(0, 50000),
      steps: stepCount,
      model: modelId,
      createdAt: Date.now(),
    });

    send({
      type: "done",
      success: succeeded,
      day: day || 0,
      preview_url: previewUrl,
      pck_size: pckBase64 ? Buffer.from(pckBase64, "base64").length : 0,
      steps: stepCount,
      model: modelId,
      session_id: sessionId,
    });
  } catch (err) {
    console.error(`[generate] Error: ${err.message}`);
    send({ type: "error", error: err.message });
  } finally {
    ops.destroyContainer();
    res.end();
  }
});

// ── GitHub Pages deploy ─────────────────────────────────────────────

async function pushToGhPages(day, title, pckBase64, ops, workspacePath, bashCwd) {
  const dayPadded = String(day).padStart(5, "0");
  const basePath = `builds/day-${dayPadded}`;
  const pckBytes = Buffer.from(pckBase64, "base64");
  const msg = `Build day ${day}: ${title}`;

  // Push .pck
  await ghPutFile(`${basePath}/index.pck`, pckBytes, msg);

  // Push runtime files from container
  for (const fname of ["index.js", "index.audio.worklet.js", "index.audio.position.worklet.js"]) {
    try {
      let content = "";
      await ops.exec(`base64 -w0 ${workspacePath}/output/${fname} 2>/dev/null`, bashCwd, {
        onData: (d) => { content += d.toString(); },
        timeout: 10,
      });
      if (content.trim()) {
        await ghPutFile(`${basePath}/${fname}`, Buffer.from(content.trim(), "base64"), msg);
      }
    } catch {}
  }

  // Push gzipped wasm
  try {
    let wasmGz = "";
    await ops.exec(`gzip -c ${workspacePath}/output/index.wasm | base64 -w0`, bashCwd, {
      onData: (d) => { wasmGz += d.toString(); },
      timeout: 30,
    });
    if (wasmGz.trim()) {
      await ghPutFile(`${basePath}/index.wasm.gz`, Buffer.from(wasmGz.trim(), "base64"), msg);
    }
  } catch {}

  // Push standalone HTML
  const html = buildStandaloneHtml(title, day);
  await ghPutFile(`${basePath}/index.html`, Buffer.from(html), msg);

  return `https://potnoodledev.github.io/game-a-day-godot-games/${basePath}/`;
}

async function ghPutFile(path, contentBuffer, message) {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  let sha = null;
  const checkResp = await fetch(`${apiUrl}?ref=gh-pages`, { headers });
  if (checkResp.ok) sha = (await checkResp.json()).sha;

  const payload = { message, content: contentBuffer.toString("base64"), branch: "gh-pages" };
  if (sha) payload.sha = sha;

  const resp = await fetch(apiUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[ghpages] PUT ${path} failed: ${resp.status} ${text.slice(0, 200)}`);
  }
}

function buildStandaloneHtml(title, day) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>${title} — Day ${day}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#0a0a1a;overflow:hidden}
canvas#canvas{display:block;width:100%;height:100%}
#loading{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#aaa;font:16px system-ui;background:#0a0a1a}</style>
</head><body><div id="loading">Loading ${title}...</div><canvas id="canvas" tabindex="1"></canvas>
<script src="index.js"></script><script>
const c=document.getElementById('canvas');c.width=innerWidth;c.height=innerHeight;
addEventListener('resize',()=>{c.width=innerWidth;c.height=innerHeight});
const _f=fetch;window.fetch=async(i,o)=>{const u=typeof i==='string'?i:i.url||i.toString();
if(u.endsWith('.wasm')){const r=await _f(u+'.gz',o);if(r.ok){const b=await r.arrayBuffer();const h=new Uint8Array(b,0,2);
if(h[0]===0x1f&&h[1]===0x8b){const d=new DecompressionStream('gzip');const w=d.writable.getWriter();w.write(b);w.close();
return new Response(d.readable,{headers:{'Content-Type':'application/wasm'}});}
return new Response(b,{headers:{'Content-Type':'application/wasm'}});}}return _f(i,o);};
if(typeof Engine==='function'){new Engine({canvasResizePolicy:2,executable:'index',focusCanvas:true,
ensureCrossOriginIsolationHeaders:false,experimentalVK:false,emscriptenPoolSize:0,godotPoolSize:0})
.startGame({onProgress:(c,t)=>{if(c>0&&t>0)document.getElementById('loading').textContent='Loading... '+Math.round(c/t*100)+'%';}})
.then(()=>{document.getElementById('loading').style.display='none';});}
</script></body></html>`;
}

// ── Deploy to GitHub Pages ───────────────────────────────────────────

app.post("/deploy", checkAuth, async (req, res) => {
  const { session_id, day } = req.body;
  const session = sessions.get(session_id);
  if (!session || !session.success) {
    return res.status(404).json({ error: "Session not found or build failed" });
  }
  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: "GITHUB_TOKEN not configured" });
  }
  const deployDay = day || session.day;
  if (!deployDay) {
    return res.status(400).json({ error: "day number required" });
  }

  try {
    // Read files from preview dir
    const previewDir = join(PREVIEWS_DIR, session_id);
    const pckBytes = Buffer.from(session.pckBase64, "base64");
    const dayPadded = String(deployDay).padStart(5, "0");
    const basePath = `builds/day-${dayPadded}`;
    const msg = `Build day ${deployDay}: ${session.title}`;

    await ghPutFile(`${basePath}/index.pck`, pckBytes, msg);

    // Push runtime files from preview
    for (const fname of ["index.js", "index.wasm.gz", "index.audio.worklet.js", "index.audio.position.worklet.js"]) {
      const fpath = join(previewDir, fname);
      if (existsSync(fpath)) {
        await ghPutFile(`${basePath}/${fname}`, readFileSync(fpath), msg);
      }
    }

    // Push HTML
    await ghPutFile(`${basePath}/index.html`, Buffer.from(buildStandaloneHtml(session.title, deployDay)), msg);

    const url = `https://potnoodledev.github.io/game-a-day-godot-games/${basePath}/`;
    res.json({ success: true, ghpages_url: url, day: deployDay });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── List sessions ───────────────────────────────────────────────────

app.get("/sessions", (req, res) => {
  const list = [];
  for (const [id, s] of sessions) {
    list.push({ id, day: s.day, title: s.title, concept: s.concept, success: s.success, preview_url: s.previewUrl, steps: s.steps, model: s.model, created: s.createdAt });
  }
  list.sort((a, b) => b.created - a.created);
  res.json(list);
});

// ── Frontend ────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.send(FRONTEND_HTML);
});

const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Game-A-Day Builder</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui;background:#0a0a1a;color:#ccc;padding:20px;max-width:800px;margin:0 auto}
h1{color:#ff6d33;margin-bottom:8px;font-size:1.5em}
.subtitle{color:#666;margin-bottom:20px;font-size:0.85em}
.form{display:flex;gap:8px;margin-bottom:16px}
.form input{flex:1;padding:10px;background:#1a1a2e;border:1px solid #333;border-radius:8px;color:#eee;font-size:14px}
.form button{padding:10px 20px;background:#ff6d33;color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer}
.form button:disabled{opacity:0.5;cursor:not-allowed}
#log{background:#111;border:1px solid #222;border-radius:8px;padding:12px;font-family:monospace;font-size:12px;
  max-height:300px;overflow-y:auto;margin-bottom:16px;white-space:pre-wrap;display:none}
#preview-frame{width:100%;height:500px;border:1px solid #333;border-radius:8px;background:#000;display:none}
#result{margin-bottom:16px;display:none}
#result a{color:#ff6d33}
.sessions{margin-top:20px}
.session{background:#1a1a2e;border:1px solid #222;border-radius:8px;padding:10px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}
.session-title{font-weight:600;color:#eee}
.session-meta{font-size:0.8em;color:#666}
.session-links a{color:#ff6d33;text-decoration:none;margin-left:8px;font-size:0.85em}
.deploy-btn{background:#333;color:#ff6d33;border:1px solid #ff6d33;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:0.8em;margin-left:8px}
</style></head><body>
<h1>Game-A-Day Builder</h1>
<p class="subtitle">Enter a game concept — AI writes the code, Godot builds it, you play it.</p>
<div class="form">
  <input id="concept" placeholder="e.g. space invaders with powerups" />
  <button id="build-btn" onclick="generate()">Build</button>
</div>
<div id="log"></div>
<div id="result"></div>
<iframe id="preview-frame"></iframe>
<div class="sessions" id="sessions"></div>
<script>
const log=document.getElementById('log'),result=document.getElementById('result'),frame=document.getElementById('preview-frame');
let building=false;

async function generate(){
  if(building)return;
  const concept=document.getElementById('concept').value.trim();
  if(!concept)return;
  building=true;
  document.getElementById('build-btn').disabled=true;
  log.style.display='block';log.textContent='Starting...\\n';
  result.style.display='none';frame.style.display='none';

  const res=await fetch('/generate-game',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({concept,project_name:concept.slice(0,30),api_key:''})});
  const reader=res.body.getReader();
  const decoder=new TextDecoder();
  let buf='';

  while(true){
    const{done,value}=await reader.read();
    if(done)break;
    buf+=decoder.decode(value,{stream:true});
    const lines=buf.split('\\n');
    buf=lines.pop();
    for(const line of lines){
      if(!line.startsWith('data: '))continue;
      try{
        const d=JSON.parse(line.slice(6));
        if(d.type==='status')log.textContent+=d.message+'\\n';
        else if(d.type==='tool')log.textContent+='  step '+d.step+': '+d.command.slice(0,100)+'\\n';
        else if(d.type==='build_output')log.textContent+='  >> '+d.output.slice(0,150)+'\\n';
        else if(d.type==='done'){
          if(d.success&&d.preview_url){
            result.innerHTML='<b>Build succeeded!</b> <a href="'+d.preview_url+'" target="_blank">Open in new tab</a>';
            result.style.display='block';
            frame.src=d.preview_url;frame.style.display='block';
          }else{
            result.innerHTML='<b>Build failed</b> ('+d.steps+' steps)';
            result.style.display='block';
          }
          log.textContent+=d.success?'\\n✅ BUILD SUCCESS\\n':'\\n❌ BUILD FAILED\\n';
        }
        log.scrollTop=log.scrollHeight;
      }catch{}
    }
  }
  building=false;
  document.getElementById('build-btn').disabled=false;
  loadSessions();
}

async function loadSessions(){
  try{
    const res=await fetch('/sessions');
    const list=await res.json();
    const el=document.getElementById('sessions');
    if(!list.length){el.innerHTML='';return;}
    el.innerHTML='<h3 style="color:#888;margin-bottom:8px">Recent Builds</h3>'+list.map(s=>
      '<div class="session"><div><span class="session-title">'+s.title+'</span>'+
      '<div class="session-meta">'+(s.success?'✅':'❌')+' '+s.steps+' steps · '+s.model.split('/').pop()+'</div></div>'+
      '<div class="session-links">'+(s.preview_url?'<a href="'+s.preview_url+'" target="_blank">Play</a>':'')+
      '</div></div>'
    ).join('');
  }catch{}
}
loadSessions();
</script></body></html>`;

// ── Existing raw build endpoint ─────────────────────────────────────

app.post("/build", checkAuth, async (req, res) => {
  res.json({ message: "Use /generate-game for autonomous builds, or visit / for the web UI" });
});

// ── Start ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Godot Build Service on port ${PORT}`);
  console.log(`  NIM key: ${NIM_API_KEY ? "set" : "NOT SET"}`);
  console.log(`  Mode: ${HAS_DOCKER ? "docker (" + DOCKER_IMAGE + ")" : "local (godot: " + HAS_LOCAL_GODOT + ")"}`);
  console.log(`  GitHub repo: ${GITHUB_REPO}`);
});
