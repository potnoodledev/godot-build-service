/**
 * Simple agent loop — calls any OpenAI-compatible API with tool use.
 * No dependencies beyond Node's built-in fetch.
 *
 * Improvements from pi-agent analysis:
 * - Retry with exponential backoff on 429/5xx (respects Retry-After)
 * - Tool errors fed back as structured messages (model can self-fix)
 * - Context size tracking with automatic truncation of old tool results
 * - Abort signal support
 * - Text-only response nudging (3 attempts)
 */

import { execSync } from "child_process";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;
const MAX_CONTEXT_CHARS = 100000; // ~25k tokens

export class SimpleAgent {
  constructor({ apiKey, baseUrl, model, systemPrompt, maxSteps = 30, maxTokens = 16384, bashCwd = "/tmp", bashOps = null }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
    this.systemPrompt = systemPrompt;
    this.maxSteps = maxSteps;
    this.maxTokens = maxTokens;
    this.bashCwd = bashCwd;
    this.bashOps = bashOps;
    this.listeners = {};
    this.aborted = false;
  }

  on(event, fn) { (this.listeners[event] ||= []).push(fn); return this; }
  emit(event, data) { for (const fn of (this.listeners[event] || [])) fn(data); }
  abort() { this.aborted = true; }

  async run(userPrompt) {
    const messages = [];
    if (this.systemPrompt) messages.push({ role: "system", content: this.systemPrompt });
    messages.push({ role: "user", content: userPrompt });

    const tools = [{
      type: "function",
      function: {
        name: "bash",
        description: "Run a bash command. Returns stdout+stderr.",
        parameters: {
          type: "object",
          properties: { command: { type: "string", description: "The bash command to run" } },
          required: ["command"],
        },
      },
    }];

    let step = 0;
    let textOnlyTurns = 0;

    while (step < this.maxSteps && !this.aborted) {
      // Compact context if too large
      this._compactMessages(messages);

      // Call the LLM with retry
      let response;
      try {
        response = await this._callApiWithRetry(messages, tools);
      } catch (err) {
        this.emit("error", { error: err.message });
        return { success: false, error: err.message, steps: step };
      }

      const choice = response.choices?.[0];
      if (!choice) {
        this.emit("error", { error: "No response from model" });
        return { success: false, error: "No response", steps: step };
      }

      const msg = choice.message;

      // Emit any text content
      if (msg.content) {
        this.emit("text", { content: msg.content });
      }

      // Add assistant message to history
      messages.push(msg);

      // Check for tool calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        textOnlyTurns = 0; // Reset nudge counter

        for (const tc of msg.tool_calls) {
          if (this.aborted) break;
          step++;
          let args = {};
          try { args = JSON.parse(tc.function.arguments); } catch {}
          const command = args.command || "";

          this.emit("tool", { step, command });

          // Execute bash command — errors become tool results, not exceptions
          let output = "";
          let isError = false;
          try {
            output = await this._execBash(command);
          } catch (err) {
            output = `Error executing command: ${err.message}`;
            isError = true;
          }

          this.emit("tool_result", { output: output.slice(0, 2000), isError });

          // Feed result back — model sees errors and can fix them
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: output.slice(0, 8000),
          });
        }
      } else {
        // No tool calls — nudge the model to use tools (up to 3 times)
        textOnlyTurns++;
        if (textOnlyTurns >= 3) break;
        messages.push({ role: "user", content: "Please use the bash tool to execute the commands. Do not output code as text." });
      }
    }

    return { success: true, steps: step, messages };
  }

  // ── API call with retry + backoff ────────────────────────────────

  async _callApiWithRetry(messages, tools) {
    let lastError;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (this.aborted) throw new Error("Aborted");

      try {
        return await this._callApi(messages, tools);
      } catch (err) {
        lastError = err;
        const status = err.status || 0;
        const isRetryable = status === 429 || status >= 500 || err.message.includes("fetch failed");

        if (!isRetryable || attempt >= MAX_RETRIES) throw err;

        // Extract retry delay from error or use exponential backoff
        let delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
        const retryAfter = err.retryAfter;
        if (retryAfter) delayMs = Math.max(delayMs, retryAfter * 1000);
        delayMs = Math.min(delayMs, 60000); // Cap at 60s

        this.emit("status", { message: `Rate limited, retrying in ${Math.round(delayMs/1000)}s... (${attempt+1}/${MAX_RETRIES})` });
        await this._sleep(delayMs);
      }
    }

    throw lastError;
  }

  async _callApi(messages, tools) {
    const body = {
      model: this.model,
      messages,
      tools,
      max_tokens: this.maxTokens,
    };

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      const err = new Error(`API ${resp.status}: ${errText.slice(0, 300)}`);
      err.status = resp.status;

      // Parse Retry-After header
      const retryAfter = resp.headers.get("retry-after");
      if (retryAfter) err.retryAfter = parseInt(retryAfter, 10) || 0;

      throw err;
    }

    return await resp.json();
  }

  // ── Context compaction ───────────────────────────────────────────

  _compactMessages(messages) {
    // Estimate total context size
    let totalChars = 0;
    for (const m of messages) {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
      totalChars += content.length;
      if (m.tool_calls) totalChars += JSON.stringify(m.tool_calls).length;
    }

    if (totalChars <= MAX_CONTEXT_CHARS) return;

    // Truncate old tool results (keep system, user prompts, and recent messages)
    // Strategy: keep first 2 messages (system + user) and last 6 messages, truncate middle
    const keep = 6;
    if (messages.length <= keep + 2) return;

    const preserved = messages.slice(0, 2); // system + initial user prompt
    const recent = messages.slice(-keep);
    const middle = messages.slice(2, -keep);

    // Summarize middle as a single user message
    let summary = "[Previous conversation truncated for context. ";
    let toolCount = 0;
    for (const m of middle) {
      if (m.role === "tool") toolCount++;
    }
    summary += `${toolCount} tool calls were made. Continue from where you left off.]`;

    messages.length = 0;
    messages.push(...preserved, { role: "user", content: summary }, ...recent);

    this.emit("status", { message: `Context compacted: ${middle.length} messages summarized` });
  }

  // ── Bash execution ───────────────────────────────────────────────

  async _execBash(command) {
    if (this.bashOps) {
      return new Promise((resolve, reject) => {
        let output = "";
        this.bashOps.exec(command, this.bashCwd, {
          onData: (d) => { output += d.toString(); },
          timeout: 120,
        }).then(() => resolve(output)).catch(reject);
      });
    }

    try {
      return execSync(command, { cwd: this.bashCwd, encoding: "utf-8", timeout: 120000, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      return (err.stdout || "") + (err.stderr || "") + (err.message || "");
    }
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
