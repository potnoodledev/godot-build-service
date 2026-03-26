/**
 * Simple agent loop — calls any OpenAI-compatible API with tool use.
 * No dependencies beyond Node's built-in fetch.
 *
 * Usage:
 *   const agent = new SimpleAgent({ apiKey, baseUrl, model, systemPrompt, maxSteps, tools });
 *   agent.on('tool', ({ step, command }) => ...);
 *   agent.on('tool_result', ({ output }) => ...);
 *   agent.on('text', ({ content }) => ...);
 *   agent.on('thinking', ({ content }) => ...);
 *   agent.on('error', ({ error }) => ...);
 *   const result = await agent.run(userPrompt);
 */

import { execSync, spawn } from "child_process";

export class SimpleAgent {
  constructor({ apiKey, baseUrl, model, systemPrompt, maxSteps = 30, maxTokens = 16384, bashCwd = "/tmp", bashOps = null }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
    this.systemPrompt = systemPrompt;
    this.maxSteps = maxSteps;
    this.maxTokens = maxTokens;
    this.bashCwd = bashCwd;
    this.bashOps = bashOps; // Optional: DockerBashOperations or LocalBashOperations
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
    while (step < this.maxSteps && !this.aborted) {
      // Call the LLM
      let response;
      try {
        response = await this._callApi(messages, tools);
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
        for (const tc of msg.tool_calls) {
          step++;
          let args = {};
          try { args = JSON.parse(tc.function.arguments); } catch {}
          const command = args.command || "";

          this.emit("tool", { step, command });

          // Execute bash command
          let output = "";
          try {
            output = await this._execBash(command);
          } catch (err) {
            output = `Error: ${err.message}`;
          }

          this.emit("tool_result", { output: output.slice(0, 2000) });

          // Add tool result to messages
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: output.slice(0, 10000), // Limit context size
          });
        }
      } else {
        // No tool calls — model is done
        break;
      }
    }

    return { success: true, steps: step, messages };
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
      throw new Error(`API ${resp.status}: ${errText.slice(0, 300)}`);
    }

    return await resp.json();
  }

  async _execBash(command) {
    if (this.bashOps) {
      // Use Docker/Local bash operations
      return new Promise((resolve, reject) => {
        let output = "";
        this.bashOps.exec(command, this.bashCwd, {
          onData: (d) => { output += d.toString(); },
          timeout: 120,
        }).then(() => resolve(output)).catch(reject);
      });
    }

    // Direct execution (fallback)
    try {
      return execSync(command, { cwd: this.bashCwd, encoding: "utf-8", timeout: 120000, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      return (err.stdout || "") + (err.stderr || "") + (err.message || "");
    }
  }
}
