import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { execSync } from "child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { gzipSync } from "zlib";
import { buildSystemPrompt } from "./prompt-builder.js";

import { DockerBashOperations } from "./docker-bash-ops.js";
import { LocalBashOperations } from "./local-bash-ops.js";
import { SimpleAgent } from "./simple-agent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "potnoodledev/game-a-day-godot-games";
const NIM_API_KEY = process.env.LLM_API_KEY || process.env.NVIDIA_NIM_API_KEY || "";
const COHERE_API_KEY = process.env.COHERE_API_KEY || "";
const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY || "";
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || "";
const ZHIPU_API_KEY = process.env.ZHIPU_AI_BIGMODEL_CN_KEY || "";
const DOCKER_IMAGE = process.env.DOCKER_IMAGE || "godot-build";
const MAX_STEPS = 30;

// Available models
const MODELS = {
  "gemini-2.5-flash": { id: "gemini-2.5-flash", provider: "gemini", name: "Gemini 2.5 Flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", maxTokens: 16384 },
  "mistral-large": { id: "mistral-large-latest", provider: "mistral", name: "Mistral Large", baseUrl: "https://api.mistral.ai/v1", maxTokens: 16384 },
  "glm-4-plus": { id: "glm-4-plus", provider: "zhipu", name: "GLM-4 Plus", baseUrl: "https://open.bigmodel.cn/api/paas/v4", maxTokens: 8192 },
  "kimi-k2.5": { id: "moonshotai/kimi-k2.5", provider: "nim", name: "Kimi K2.5", baseUrl: "https://integrate.api.nvidia.com/v1", maxTokens: 16384 },
  "command-a": { id: "command-a-03-2025", provider: "cohere", name: "Command A", baseUrl: "https://api.cohere.ai/compatibility/v1", maxTokens: 8192 },
};
const DEFAULT_MODEL = MISTRAL_API_KEY ? "mistral-large" : GEMINI_API_KEY ? "gemini-2.5-flash" : "kimi-k2.5";

let HAS_DOCKER = false;
try { execSync("docker info", { stdio: "pipe" }); HAS_DOCKER = true; } catch {}
let HAS_LOCAL_GODOT = false;
try { execSync("godot --version", { stdio: "pipe" }); HAS_LOCAL_GODOT = true; } catch {}

const TEMPLATE_DIR = join(__dirname, "template");
const PREVIEWS_DIR = join("/tmp", "previews");
const SESSIONS_DIR = join("/tmp", "sessions");
mkdirSync(PREVIEWS_DIR, { recursive: true });
mkdirSync(SESSIONS_DIR, { recursive: true });

const sessions = new Map();
let activeSessionId = null;
const activeListeners = new Set();

// Persist session events to a JSONL file
function appendSessionLog(sessionId, event) {
  try {
    const logFile = join(SESSIONS_DIR, `${sessionId}.jsonl`);
    appendFileSync(logFile, JSON.stringify(event) + "\n");
  } catch {}
}

function readSessionLog(sessionId) {
  try {
    const logFile = join(SESSIONS_DIR, `${sessionId}.jsonl`);
    if (!existsSync(logFile)) return [];
    return readFileSync(logFile, "utf-8").trim().split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use("/preview", (req, res, next) => {
  // Set COOP/COEP headers so Godot doesn't trigger the Chrome warning
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  next();
}, express.static(PREVIEWS_DIR));

// ── Health ──────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ status: "ok", nim_key: !!NIM_API_KEY, cohere_key: !!COHERE_API_KEY, gemini_key: !!GEMINI_API_KEY, docker: HAS_DOCKER, local_godot: HAS_LOCAL_GODOT, mode: HAS_DOCKER ? "docker" : "local" });
});

app.get("/models", (req, res) => {
  const available = {};
  for (const [key, spec] of Object.entries(MODELS)) {
    const keyMap = { gemini: GEMINI_API_KEY, mistral: MISTRAL_API_KEY, zhipu: ZHIPU_API_KEY, cohere: COHERE_API_KEY, nim: NIM_API_KEY };
    const hasKey = !!(keyMap[spec.provider] || NIM_API_KEY);
    if (hasKey) available[key] = { name: spec.name, provider: spec.provider };
  }
  res.json({ models: available, default: DEFAULT_MODEL });
});

app.get("/sessions", (req, res) => {
  const list = [];
  for (const [id, s] of sessions) {
    list.push({ id, day: s.day, title: s.title, concept: s.concept, success: s.success, status: s.status, preview_url: s.previewUrl, steps: s.steps, model: s.model, created: s.createdAt, duration: s.duration });
  }
  list.sort((a, b) => b.created - a.created);
  res.json(list);
});

app.get("/active", (req, res) => {
  if (activeSessionId) {
    const s = sessions.get(activeSessionId);
    res.json({ active: true, session_id: activeSessionId, concept: s?.concept, title: s?.title, steps: s?.steps, log: s?.log?.slice(-30) });
  } else {
    res.json({ active: false });
  }
});

app.get("/sessions/:id", (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Not found" });
  const { pckBase64, log: memLog, ...safe } = s;
  // Use file log (ordered) instead of in-memory log
  const fileLog = readSessionLog(req.params.id);
  res.json({ ...safe, id: req.params.id, hasPck: !!pckBase64, log: fileLog });
});

function getApiKeyForModel(modelKey) {
  const spec = MODELS[modelKey] || MODELS[DEFAULT_MODEL];
  if (spec.provider === "gemini") return GEMINI_API_KEY;
  if (spec.provider === "mistral") return MISTRAL_API_KEY;
  if (spec.provider === "zhipu") return ZHIPU_API_KEY;
  if (spec.provider === "cohere") return COHERE_API_KEY;
  return NIM_API_KEY;
}

// ── Build runner (called from WebSocket) ────────────────────────────

async function runBuild(sessionId, concept, projectName, day, send, modelKey) {
  modelKey = modelKey || DEFAULT_MODEL;
  const modelSpec = MODELS[modelKey] || MODELS[DEFAULT_MODEL];
  const modelId = modelSpec.id;
  const startTime = Date.now();
  const useDocker = HAS_DOCKER && !process.env.FORCE_LOCAL;
  const ops = useDocker ? new DockerBashOperations() : new LocalBashOperations(TEMPLATE_DIR);

  const session = { day: day || 0, title: projectName || concept, concept, success: false, previewUrl: "", steps: 0, model: modelId, log: [], createdAt: Date.now(), status: "building" };
  sessions.set(sessionId, session);
  activeSessionId = sessionId;

  // Broadcast to all listeners and persist to log file (with timestamps)
  const broadcast = (data) => {
    data.ts = Date.now();
    appendSessionLog(sessionId, data);
    send(data);
    for (const listener of activeListeners) {
      if (listener !== send) { try { listener(data); } catch {} }
    }
  };

  console.log(`[generate] ${sessionId}: "${concept}" (${modelId}, ${useDocker ? "docker" : "local"})`);
  broadcast({ type: "session", session_id: sessionId, model: modelId });

  let workspacePath, bashCwd;
  try {
    // 1. Setup workspace
    broadcast({ type: "status", message: "Setting up workspace..." });
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
    broadcast({ type: "status", message: "Workspace ready" });

    // 2. Create agent (simple direct API approach — no pi-agent dependency)
    const systemPrompt = buildSystemPrompt(workspacePath);
    const apiKey = getApiKeyForModel(modelKey);

    let succeeded = false;

    const agent = new SimpleAgent({
      apiKey,
      baseUrl: modelSpec.baseUrl,
      model: modelId,
      systemPrompt,
      maxSteps: MAX_STEPS,
      maxTokens: modelSpec.maxTokens,
      bashCwd,
      bashOps: ops,
    });

    agent.on("tool", (d) => {
      broadcast({ type: "tool", step: d.step, command: d.command.slice(0, 300) });
      console.log(`  [${sessionId}] Step ${d.step}: ${d.command.slice(0, 80)}`);
    });
    agent.on("tool_result", (d) => {
      broadcast({ type: "tool_result", output: d.output.slice(0, 2000) });
      if (d.output.includes("BUILD_SUCCESS")) succeeded = true;
    });
    agent.on("text", (d) => {
      if (d.content.length > 5) broadcast({ type: "text_delta", content: d.content });
    });
    agent.on("error", (d) => {
      broadcast({ type: "error", error: d.error });
    });
    agent.on("status", (d) => {
      broadcast({ type: "status", message: d.message });
    });

    // 3. Run
    broadcast({ type: "status", message: "Agent thinking..." });
    const result = await agent.run(`Build a game for the concept: "${concept}". Title: "${projectName || concept}". Write main.gd, build it, fix errors if needed.`);

    session.steps = result.steps;

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
      broadcast({ type: "status", message: "Setting up preview..." });
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

    session.duration = Math.round((Date.now() - startTime) / 1000);
    broadcast({ type: "done", success: succeeded, preview_url: session.previewUrl, pck_size: pckBase64 ? Buffer.from(pckBase64, "base64").length : 0, steps: session.steps, session_id: sessionId, duration: session.duration, model: modelSpec.name });
  } catch (err) {
    console.error(`[generate] Error: ${err.message}`);
    session.status = "error";
    session.log.push(`ERROR: ${err.message}`);
    broadcast({ type: "error", error: err.message });
  } finally {
    activeSessionId = null;
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
h1{color:#ff6d33;margin-bottom:4px;display:flex;align-items:center;gap:10px}
.ws-dot{width:10px;height:10px;border-radius:50%;background:#444;flex-shrink:0}
.ws-dot.connected{background:#4caf50}.ws-dot.building{background:#ff6d33;animation:pulse .8s infinite alternate}
@keyframes pulse{from{opacity:.4}to{opacity:1}}
@keyframes spin{to{transform:rotate(360deg)}}
p.sub{color:#666;margin-bottom:16px;font-size:.85em}
.form{display:flex;gap:8px;margin-bottom:12px}.form input{flex:1;padding:10px;background:#1a1a2e;border:1px solid #333;border-radius:8px;color:#eee;font-size:14px}
.form select{padding:10px;background:#1a1a2e;border:1px solid #333;border-radius:8px;color:#eee;font-size:13px}
.form button{padding:10px 20px;background:#ff6d33;color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:6px}.form button:disabled{opacity:.5}
.ts{color:#555;font-size:10px}
.spinner{width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite;display:none}
.form button:disabled .spinner{display:block}
#log{background:#111;border:1px solid #222;border-radius:8px;padding:12px;font:12px monospace;max-height:300px;overflow-y:auto;margin-bottom:12px;white-space:pre-wrap;display:none}
#result{margin-bottom:12px;display:none}#result a{color:#ff6d33}
iframe{width:100%;height:500px;border:1px solid #333;border-radius:8px;background:#000;display:none}
.sessions{margin-top:16px}.session{background:#1a1a2e;border:1px solid #222;border-radius:8px;padding:10px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center}
.s-title{font-weight:600;color:#eee;font-size:.9em}.s-meta{font-size:.75em;color:#666}.s-links a{color:#ff6d33;text-decoration:none;font-size:.85em}
.retry-btn{background:#333;color:#ff6d33;border:1px solid #ff6d33;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:.8em;margin-left:8px}
</style></head><body>
<h1>Game-A-Day Builder <span class="ws-dot" id="ws-dot" title="Disconnected"></span></h1>
<p class="sub">Enter a concept. AI writes the code, Godot builds it, you play it.</p>
<div class="form"><input id="concept" placeholder="e.g. asteroid dodger with powerups"><select id="model-select"></select><button id="btn" onclick="go()"><span class="spinner" id="spinner"></span><span id="btn-text">Build</span></button></div>
<div id="log"></div><div id="result"></div><iframe id="frame"></iframe>
<div class="sessions" id="sessions"></div>
<script>
const log=document.getElementById('log'),result=document.getElementById('result'),frame=document.getElementById('frame'),btn=document.getElementById('btn');
const dot=document.getElementById('ws-dot'),btnText=document.getElementById('btn-text');
function addLog(s){log.textContent+=s+'\\n';log.scrollTop=log.scrollHeight;}
function setBuilding(on){btn.disabled=on;btnText.textContent=on?'Building...':'Build';dot.className='ws-dot'+(on?' building':activeWs?' connected':'');}
function setConnected(on){dot.className='ws-dot'+(on?(btn.disabled?' building':' connected'):'');dot.title=on?'Connected':'Disconnected';}

let activeWs=null;

function handleMsg(d){
  if(d.type==='status')addLog('>> '+d.message);
  else if(d.type==='thinking')addLog('\\n💭 '+d.message);
  else if(d.type==='thinking_delta'){log.textContent+=d.content;log.scrollTop=log.scrollHeight;}
  else if(d.type==='text_delta'){log.textContent+=d.content;log.scrollTop=log.scrollHeight;}
  else if(d.type==='tool')addLog('\\n🔧 step '+d.step+': '+d.command.slice(0,120));
  else if(d.type==='tool_result')addLog('  → '+(d.output||'').slice(0,200));
  else if(d.type==='session'){addLog('>> Building: '+d.model);setBuilding(true);}
  else if(d.type==='active_build'){
    setBuilding(true);
    log.style.display='block';log.textContent='>> Rejoined active build\\n';
  }
  else if(d.type==='done'){
    addLog(d.success?'\\n✅ BUILD SUCCESS':'\\n❌ BUILD FAILED');
    if(d.success&&d.preview_url){
      result.innerHTML='<b>Game ready!</b> <a href="'+d.preview_url+'" target="_blank">Open in new tab</a>';
      result.style.display='block';frame.src=d.preview_url;frame.style.display='block';
    }
    setBuilding(false);loadSessions();
  }else if(d.type==='error'){addLog('ERROR: '+d.error);setBuilding(false);loadSessions();}
}

function connectWs(onOpen){
  const proto=location.protocol==='https:'?'wss:':'ws:';
  const ws=new WebSocket(proto+'//'+location.host+'/ws');
  ws.onopen=()=>{activeWs=ws;setConnected(true);if(onOpen)onOpen(ws);};
  ws.onmessage=(e)=>{try{handleMsg(JSON.parse(e.data));}catch{}};
  ws.onerror=()=>{addLog('WebSocket error');setBuilding(false);setConnected(false);};
  ws.onclose=()=>{activeWs=null;setConnected(false);if(btn.disabled){addLog('\\n⚠️ Connection lost');setBuilding(false);loadSessions();}};
  return ws;
}

function go(){
  const concept=document.getElementById('concept').value.trim();
  if(!concept)return;
  const model=document.getElementById('model-select').value;
  setBuilding(true);
  log.style.display='block';log.textContent='';result.style.display='none';frame.style.display='none';
  connectWs(ws=>ws.send(JSON.stringify({type:'generate',concept,project_name:concept.slice(0,30),model})));
}

function retry(sessionId){
  setBuilding(true);
  log.style.display='block';log.textContent='';result.style.display='none';frame.style.display='none';
  connectWs(ws=>ws.send(JSON.stringify({type:'retry',session_id:sessionId})));
}

// Load available models
fetch('/models').then(r=>r.json()).then(d=>{
  const sel=document.getElementById('model-select');
  for(const[k,v]of Object.entries(d.models)){
    const opt=document.createElement('option');opt.value=k;opt.textContent=v.name;
    if(k===d.default)opt.selected=true;
    sel.appendChild(opt);
  }
}).catch(()=>{});

// On page load, check for active build
fetch('/active').then(r=>r.json()).then(d=>{
  if(d.active){connectWs();}
}).catch(()=>{});

async function loadSessions(){
  try{const r=await fetch('/sessions');const list=await r.json();const el=document.getElementById('sessions');
  if(!list.length){el.innerHTML='';return;}
  el.innerHTML='<h3 style="color:#888;margin-bottom:8px;font-size:.9em">Recent Builds</h3>'+list.slice(0,10).map(s=>{
    const icon=s.status==='building'?'🔨':s.success?'✅':'❌';
    const dur=s.duration?s.duration+'s':'';
    const showRetry=s.status!=='building'&&!s.success;
    return '<div class="session"><div><span class="s-title">'+s.title+'</span><div class="s-meta">'+icon+' '+(s.status==='building'?'building...':s.steps+' steps')+' · '+(s.model||'').split('/').pop()+(dur?' · '+dur:'')+'</div></div>'+
    '<div class="s-links">'+
    '<a href="#" onclick="viewSession(\\''+s.id+'\\');return false">Log</a>'+
    (s.preview_url?'<a href="'+s.preview_url+'" target="_blank">Play</a>':'')+
    (showRetry?'<button class="retry-btn" onclick="retry(\\''+s.id+'\\')">Retry</button>':'')+
    '</div></div>';
  }).join('');}catch{}
}
async function viewSession(id){
  try{
    const r=await fetch('/sessions/'+id);
    const s=await r.json();
    log.style.display='block';
    log.textContent='=== '+s.title+' ('+s.status+') ===\\n';
    log.textContent+='Concept: '+s.concept+'\\nModel: '+(s.model||'')+'\\nSteps: '+s.steps+(s.duration?' · '+s.duration+'s':'')+'\\n\\n';
    const t0=s.log&&s.log[0]?.ts||0;
    if(s.log)s.log.forEach(d=>{
      const elapsed=d.ts&&t0?'+'+Math.round((d.ts-t0)/1000)+'s ':'';
      if(d.type==='status')log.textContent+=elapsed+'>> '+d.message+'\\n';
      else if(d.type==='thinking')log.textContent+='\\n'+elapsed+'💭 '+d.message+'\\n';
      else if(d.type==='thinking_delta')log.textContent+=d.content;
      else if(d.type==='text_delta')log.textContent+=d.content;
      else if(d.type==='tool')log.textContent+='\\n'+elapsed+'🔧 step '+d.step+': '+(d.command||'').slice(0,200)+'\\n';
      else if(d.type==='tool_result')log.textContent+=elapsed+'  → '+(d.output||'').slice(0,300)+'\\n';
      else if(d.type==='build_output')log.textContent+=elapsed+'  >> '+(d.output||'').slice(0,300)+'\\n';
      else if(d.type==='done')log.textContent+='\\n'+elapsed+(d.success?'✅ SUCCESS':'❌ FAILED')+(d.duration?' ('+d.duration+'s)':'')+'\\n';
      else if(d.type==='error')log.textContent+='\\n'+elapsed+'ERROR: '+d.error+'\\n';
    });
    if(s.previewUrl){
      result.innerHTML='<a href="'+s.previewUrl+'" target="_blank">Play this game</a>';
      result.style.display='block';frame.src=s.previewUrl;frame.style.display='block';
    }else{result.style.display='none';frame.style.display='none';}
    log.scrollTop=0;
  }catch(e){alert('Failed to load session');}
}
loadSessions();
</script></body></html>`;

// ── HTTP + WebSocket server ─────────────────────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  console.log("[ws] Client connected");
  const send = (data) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(data)); } catch {} };

  // If a build is active, replay the full log then subscribe to live updates
  if (activeSessionId) {
    const fullLog = readSessionLog(activeSessionId);
    send({ type: "active_build", session_id: activeSessionId, replay: true });
    for (const event of fullLog) {
      send(event);
    }
    send({ type: "status", message: "Rejoined — streaming live..." });
    activeListeners.add(send);
  }

  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "generate" || msg.type === "retry") {
        if (activeSessionId) {
          send({ type: "error", error: "A build is already in progress. Wait for it to finish." });
          return;
        }
        const concept = msg.type === "retry" ? sessions.get(msg.session_id)?.concept : msg.concept;
        const title = msg.type === "retry" ? sessions.get(msg.session_id)?.title : msg.project_name;
        const modelKey = msg.model || DEFAULT_MODEL;
        if (!concept) { send({ type: "error", error: "No concept" }); return; }
        activeListeners.add(send);
        const sessionId = randomUUID().slice(0, 8);
        await runBuild(sessionId, concept, title, msg.day, send, modelKey);
        activeListeners.delete(send);
      } else if (msg.type === "watch") {
        activeListeners.add(send);
        if (activeSessionId) {
          const fullLog = readSessionLog(activeSessionId);
          send({ type: "active_build", session_id: activeSessionId, replay: true });
          for (const event of fullLog) send(event);
          send({ type: "status", message: "Rejoined — streaming live..." });
        }
      }
    } catch (err) {
      send({ type: "error", error: err.message });
    }
  });

  ws.on("close", () => {
    activeListeners.delete(send);
    console.log("[ws] Client disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`Godot Build Service on port ${PORT}`);
  console.log(`  NIM key: ${NIM_API_KEY ? "set" : "NOT SET"}`);
  console.log(`  Mode: ${HAS_DOCKER ? "docker" : "local (godot: " + HAS_LOCAL_GODOT + ")"}`);
});
