import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { execSync } from "child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { gzipSync } from "zlib";
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
const GITHUB_REPO = process.env.GITHUB_REPO || "potnoodledev/game-a-day-godot-games";
const NIM_API_KEY = process.env.LLM_API_KEY || process.env.NVIDIA_NIM_API_KEY || "";
const DOCKER_IMAGE = process.env.DOCKER_IMAGE || "godot-build";
const MAX_STEPS = 30;

let HAS_DOCKER = false;
try { execSync("docker info", { stdio: "pipe" }); HAS_DOCKER = true; } catch {}
let HAS_LOCAL_GODOT = false;
try { execSync("godot --version", { stdio: "pipe" }); HAS_LOCAL_GODOT = true; } catch {}

const TEMPLATE_DIR = join(__dirname, "template");
const PREVIEWS_DIR = join("/tmp", "previews");
mkdirSync(PREVIEWS_DIR, { recursive: true });

const sessions = new Map();

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use("/preview", express.static(PREVIEWS_DIR));

// ── Health ──────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ status: "ok", nim_key: !!NIM_API_KEY, docker: HAS_DOCKER, local_godot: HAS_LOCAL_GODOT, mode: HAS_DOCKER ? "docker" : "local" });
});

app.get("/sessions", (req, res) => {
  const list = [];
  for (const [id, s] of sessions) {
    list.push({ id, day: s.day, title: s.title, concept: s.concept, success: s.success, preview_url: s.previewUrl, steps: s.steps, model: s.model, created: s.createdAt, log: s.log?.slice(-20) });
  }
  list.sort((a, b) => b.created - a.created);
  res.json(list);
});

app.get("/sessions/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Not found" });
  res.json({ ...s, id: req.params.id });
});

// ── NIM Model ──────────────────────────────────────────────────────

function nimModel(modelId) {
  return {
    id: modelId, name: modelId.split("/").pop() || modelId,
    api: "openai-completions", provider: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072, maxTokens: 16384,
    headers: { Authorization: `Bearer ${NIM_API_KEY}` },
  };
}

// ── Build runner (called from WebSocket) ────────────────────────────

async function runBuild(sessionId, concept, projectName, day, send) {
  const modelId = process.env.LLM_MODEL || "moonshotai/kimi-k2.5";
  const useDocker = HAS_DOCKER && !process.env.FORCE_LOCAL;
  const ops = useDocker ? new DockerBashOperations() : new LocalBashOperations(TEMPLATE_DIR);

  const session = { day: day || 0, title: projectName || concept, concept, success: false, previewUrl: "", steps: 0, model: modelId, log: [], createdAt: Date.now(), status: "building" };
  sessions.set(sessionId, session);

  console.log(`[generate] ${sessionId}: "${concept}" (${modelId}, ${useDocker ? "docker" : "local"})`);
  send({ type: "session", session_id: sessionId, model: modelId });

  let workspacePath, bashCwd;
  try {
    // 1. Setup workspace
    send({ type: "status", message: "Setting up workspace..." });
    if (useDocker) {
      ops.createContainer(DOCKER_IMAGE);
      ops.startContainer();
      workspacePath = "/workspace";
      bashCwd = "/root";
      await ops.exec("mkdir -p /workspace/template /workspace/output && cp -r /app/template/* /workspace/template/", "/root", { onData: () => {}, timeout: 30 });
    } else {
      workspacePath = ops.createWorkspace();
      bashCwd = workspacePath;
    }
    send({ type: "status", message: "Workspace ready" });

    // 2. Create agent
    const model = nimModel(modelId);
    const bashTool = createBashTool(bashCwd, { operations: ops });
    const systemPrompt = buildSystemPrompt(workspacePath);

    let stepCount = 0;
    let succeeded = false;

    const agent = new Agent({
      initialState: { systemPrompt, model, tools: [bashTool], thinkingLevel: "off" },
      streamFn: streamSimple,
      getApiKey: () => NIM_API_KEY,
    });

    agent.subscribe((event) => {
      switch (event.type) {
        case "message_start":
          if (event.message?.role === "assistant") {
            send({ type: "thinking", message: "Thinking..." });
          }
          break;
        case "message_update": {
          const ae = event.assistantMessageEvent;
          if (ae?.type === "text_delta" && ae.delta) {
            send({ type: "text_delta", content: ae.delta });
          } else if (ae?.type === "thinking_delta" && ae.delta) {
            send({ type: "thinking_delta", content: ae.delta });
          }
          break;
        }
        case "message_end":
          if (event.message?.role === "assistant") {
            const text = event.message.content?.map((c) => c.text || "").join("") || "";
            if (text) session.log.push(text.slice(0, 200));
          }
          break;
        case "tool_execution_start": {
          stepCount++;
          const cmd = event.args?.command || "";
          send({ type: "tool", step: stepCount, command: cmd.slice(0, 300) });
          session.log.push(`step ${stepCount}: ${cmd.slice(0, 100)}`);
          console.log(`  [${sessionId}] Step ${stepCount}: ${cmd.slice(0, 80)}`);
          if (stepCount >= MAX_STEPS) agent.abort();
          break;
        }
        case "tool_execution_end": {
          const rt = typeof event.result === "string" ? event.result : event.result?.content?.map((c) => c.text || "").join("") || "";
          send({ type: "tool_result", output: rt.slice(0, 2000) });
          session.log.push(rt.slice(0, 200));
          if (rt.includes("BUILD_SUCCESS")) succeeded = true;
          break;
        }
      }
    });

    // 3. Run
    send({ type: "status", message: "Agent thinking..." });
    await agent.prompt(`Build a game for the concept: "${concept}". Title: "${projectName || concept}". Write main.gd, build it, fix errors if needed.`);
    await agent.waitForIdle();

    session.steps = stepCount;

    // 4. Collect results
    let code = "", pckBase64 = "";
    try {
      let out = ""; await ops.exec(`cat ${workspacePath}/template/main.gd 2>/dev/null`, bashCwd, { onData: (d) => { out += d; }, timeout: 5 }); code = out;
    } catch {}

    if (succeeded) {
      try {
        let out = ""; await ops.exec(`base64 -w0 ${workspacePath}/output/index.pck 2>/dev/null`, bashCwd, { onData: (d) => { out += d; }, timeout: 10 }); pckBase64 = out.trim();
      } catch {}
    }

    // 5. Copy to preview dir
    if (succeeded && pckBase64) {
      send({ type: "status", message: "Setting up preview..." });
      const previewDir = join(PREVIEWS_DIR, sessionId);
      mkdirSync(previewDir, { recursive: true });

      for (const fname of ["index.pck", "index.js", "index.wasm", "index.audio.worklet.js", "index.audio.position.worklet.js"]) {
        try {
          let c = ""; await ops.exec(`base64 -w0 ${workspacePath}/output/${fname} 2>/dev/null`, bashCwd, { onData: (d) => { c += d; }, timeout: 30 });
          if (c.trim()) {
            const buf = Buffer.from(c.trim(), "base64");
            writeFileSync(join(previewDir, fname === "index.wasm" ? "index.wasm.gz" : fname), fname === "index.wasm" ? gzipSync(buf) : buf);
          }
        } catch {}
      }
      writeFileSync(join(previewDir, "index.html"), buildStandaloneHtml(projectName || concept, day || 0));
      session.previewUrl = `/preview/${sessionId}/`;
    }

    session.success = succeeded;
    session.code = code.slice(0, 50000);
    session.pckBase64 = pckBase64;
    session.status = succeeded ? "done" : "failed";

    send({ type: "done", success: succeeded, preview_url: session.previewUrl, pck_size: pckBase64 ? Buffer.from(pckBase64, "base64").length : 0, steps: stepCount, session_id: sessionId });
  } catch (err) {
    console.error(`[generate] Error: ${err.message}`);
    session.status = "error";
    session.log.push(`ERROR: ${err.message}`);
    send({ type: "error", error: err.message });
  } finally {
    ops.destroyContainer();
  }
}

// ── Deploy to GitHub Pages ──────────────────────────────────────────

app.post("/deploy", async (req, res) => {
  const { session_id, day, api_key } = req.body;
  if (API_KEY && api_key !== API_KEY) return res.status(403).json({ error: "Invalid api_key" });
  const session = sessions.get(session_id);
  if (!session?.success) return res.status(404).json({ error: "Session not found or failed" });
  if (!GITHUB_TOKEN) return res.status(500).json({ error: "GITHUB_TOKEN not set" });
  const deployDay = day || session.day;
  if (!deployDay) return res.status(400).json({ error: "day required" });

  try {
    const pckBytes = Buffer.from(session.pckBase64, "base64");
    const dayPadded = String(deployDay).padStart(5, "0");
    const basePath = `builds/day-${dayPadded}`;
    const msg = `Build day ${deployDay}: ${session.title}`;
    const previewDir = join(PREVIEWS_DIR, session_id);

    await ghPutFile(`${basePath}/index.pck`, pckBytes, msg);
    for (const f of ["index.js", "index.wasm.gz", "index.audio.worklet.js", "index.audio.position.worklet.js"]) {
      const fp = join(previewDir, f);
      if (existsSync(fp)) await ghPutFile(`${basePath}/${f}`, readFileSync(fp), msg);
    }
    await ghPutFile(`${basePath}/index.html`, Buffer.from(buildStandaloneHtml(session.title, deployDay)), msg);

    res.json({ success: true, ghpages_url: `https://potnoodledev.github.io/game-a-day-godot-games/${basePath}/` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GitHub helpers ──────────────────────────────────────────────────

async function ghPutFile(path, buf, msg) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
  const h = { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  let sha = null;
  const ck = await fetch(`${url}?ref=gh-pages`, { headers: h });
  if (ck.ok) sha = (await ck.json()).sha;
  const payload = { message: msg, content: buf.toString("base64"), branch: "gh-pages" };
  if (sha) payload.sha = sha;
  const r = await fetch(url, { method: "PUT", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!r.ok) console.error(`[ghpages] PUT ${path}: ${r.status}`);
}

function buildStandaloneHtml(title, day) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>${title}</title><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#0a0a1a;overflow:hidden}canvas#canvas{display:block;width:100%;height:100%}#loading{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#aaa;font:16px system-ui;background:#0a0a1a}</style></head><body><div id="loading">Loading ${title}...</div><canvas id="canvas" tabindex="1"></canvas><script src="index.js"></script><script>const c=document.getElementById('canvas');c.width=innerWidth;c.height=innerHeight;addEventListener('resize',()=>{c.width=innerWidth;c.height=innerHeight});const _f=fetch;window.fetch=async(i,o)=>{const u=typeof i==='string'?i:i.url||i.toString();if(u.endsWith('.wasm')){const r=await _f(u+'.gz',o);if(r.ok){const b=await r.arrayBuffer();const h=new Uint8Array(b,0,2);if(h[0]===0x1f&&h[1]===0x8b){const d=new DecompressionStream('gzip');const w=d.writable.getWriter();w.write(b);w.close();return new Response(d.readable,{headers:{'Content-Type':'application/wasm'}});}return new Response(b,{headers:{'Content-Type':'application/wasm'}});}}return _f(i,o);};if(typeof Engine==='function'){new Engine({canvasResizePolicy:2,executable:'index',focusCanvas:true,ensureCrossOriginIsolationHeaders:false,experimentalVK:false,emscriptenPoolSize:0,godotPoolSize:0}).startGame({onProgress:(c,t)=>{if(c>0&&t>0)document.getElementById('loading').textContent='Loading... '+Math.round(c/t*100)+'%';}}).then(()=>{document.getElementById('loading').style.display='none';});}</script></body></html>`;
}

// ── Frontend ────────────────────────────────────────────────────────

app.get("/", (req, res) => { res.send(FRONTEND_HTML); });

const FRONTEND_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Game Builder</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0a0a1a;color:#ccc;padding:20px;max-width:900px;margin:0 auto}
h1{color:#ff6d33;margin-bottom:4px}p.sub{color:#666;margin-bottom:16px;font-size:.85em}
.form{display:flex;gap:8px;margin-bottom:12px}.form input{flex:1;padding:10px;background:#1a1a2e;border:1px solid #333;border-radius:8px;color:#eee;font-size:14px}
.form button{padding:10px 20px;background:#ff6d33;color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer}.form button:disabled{opacity:.5}
#log{background:#111;border:1px solid #222;border-radius:8px;padding:12px;font:12px monospace;max-height:250px;overflow-y:auto;margin-bottom:12px;white-space:pre-wrap;display:none}
#result{margin-bottom:12px;display:none}#result a{color:#ff6d33}
iframe{width:100%;height:500px;border:1px solid #333;border-radius:8px;background:#000;display:none}
.sessions{margin-top:16px}.session{background:#1a1a2e;border:1px solid #222;border-radius:8px;padding:10px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center}
.s-title{font-weight:600;color:#eee;font-size:.9em}.s-meta{font-size:.75em;color:#666}.s-links a{color:#ff6d33;text-decoration:none;font-size:.85em}
</style></head><body>
<h1>Game-A-Day Builder</h1><p class="sub">Enter a concept. AI writes the code, Godot builds it, you play it.</p>
<div class="form"><input id="concept" placeholder="e.g. asteroid dodger with powerups"><button id="btn" onclick="go()">Build</button></div>
<div id="log"></div><div id="result"></div><iframe id="frame"></iframe>
<div class="sessions" id="sessions"></div>
<script>
const log=document.getElementById('log'),result=document.getElementById('result'),frame=document.getElementById('frame'),btn=document.getElementById('btn');
function addLog(s){log.textContent+=s+'\\n';log.scrollTop=log.scrollHeight;}

function go(){
  const concept=document.getElementById('concept').value.trim();
  if(!concept)return;
  btn.disabled=true;log.style.display='block';log.textContent='';result.style.display='none';frame.style.display='none';

  const proto=location.protocol==='https:'?'wss:':'ws:';
  const ws=new WebSocket(proto+'//'+location.host+'/ws');
  ws.onopen=()=>{
    addLog('Connected. Sending concept...');
    ws.send(JSON.stringify({type:'generate',concept,project_name:concept.slice(0,30)}));
  };
  ws.onmessage=(e)=>{
    try{
      const d=JSON.parse(e.data);
      if(d.type==='status')addLog('>> '+d.message);
      else if(d.type==='thinking')addLog('\\n💭 '+d.message);
      else if(d.type==='thinking_delta'){document.getElementById('log').textContent+=d.content;}
      else if(d.type==='text_delta'){document.getElementById('log').textContent+=d.content;}
      else if(d.type==='tool')addLog('\\n🔧 step '+d.step+': '+d.command.slice(0,120));
      else if(d.type==='tool_result')addLog('  → '+d.output.slice(0,200));
      else if(d.type==='done'){
        addLog(d.success?'\\n✅ BUILD SUCCESS':'\\n❌ BUILD FAILED');
        if(d.success&&d.preview_url){
          result.innerHTML='<b>Game ready!</b> <a href="'+d.preview_url+'" target="_blank">Open in new tab</a>';
          result.style.display='block';frame.src=d.preview_url;frame.style.display='block';
        }
        btn.disabled=false;ws.close();loadSessions();
      }else if(d.type==='error'){addLog('ERROR: '+d.error);btn.disabled=false;ws.close();}
    }catch{}
  };
  ws.onerror=()=>{addLog('WebSocket error');btn.disabled=false;};
  ws.onclose=()=>{if(btn.disabled){addLog('Connection closed');btn.disabled=false;}};
}

async function loadSessions(){
  try{const r=await fetch('/sessions');const list=await r.json();const el=document.getElementById('sessions');
  if(!list.length){el.innerHTML='';return;}
  el.innerHTML='<h3 style="color:#888;margin-bottom:8px;font-size:.9em">Recent Builds</h3>'+list.slice(0,10).map(s=>
    '<div class="session"><div><span class="s-title">'+s.title+'</span><div class="s-meta">'+(s.success?'✅':'❌')+' '+s.steps+' steps · '+s.model.split('/').pop()+'</div></div>'+
    '<div class="s-links">'+(s.preview_url?'<a href="'+s.preview_url+'" target="_blank">Play</a>':'')+'</div></div>'
  ).join('');}catch{}
}
loadSessions();
</script></body></html>`;

// ── HTTP + WebSocket server ─────────────────────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  console.log("[ws] Client connected");
  const send = (data) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(data)); } catch {} };

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "generate") {
        const sessionId = randomUUID().slice(0, 8);
        await runBuild(sessionId, msg.concept, msg.project_name, msg.day, send);
      }
    } catch (err) {
      send({ type: "error", error: err.message });
    }
  });

  ws.on("close", () => console.log("[ws] Client disconnected"));
});

server.listen(PORT, () => {
  console.log(`Godot Build Service on port ${PORT}`);
  console.log(`  NIM key: ${NIM_API_KEY ? "set" : "NOT SET"}`);
  console.log(`  Mode: ${HAS_DOCKER ? "docker" : "local (godot: " + HAS_LOCAL_GODOT + ")"}`);
});
