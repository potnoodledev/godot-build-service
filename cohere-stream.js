/**
 * Custom streamFn for Cohere that strips unsupported OpenAI fields.
 * Patches the global fetch before calling streamSimple, then restores it.
 * Must be applied at module scope to catch OpenAI SDK's fetch.
 */

import { streamSimple } from "@mariozechner/pi-ai";

let cohereApiKey = "";

// Patch fetch ONCE at module load to intercept Cohere requests
const _origFetch = globalThis.fetch;
globalThis.fetch = async function patchedFetch(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input?.url || "";
  if (url.includes("cohere.ai") && init?.body) {
    try {
      const body = JSON.parse(init.body);
      // Strip fields Cohere's compatibility API doesn't support
      delete body.stream_options;
      delete body.store;
      if (body.max_completion_tokens) {
        body.max_tokens = body.max_completion_tokens;
        delete body.max_completion_tokens;
      }
      init = { ...init, body: JSON.stringify(body) };
    } catch {}
  }
  return _origFetch(input, init);
};

export function createCohereStreamFn(apiKey) {
  cohereApiKey = apiKey;
  // Just return streamSimple — the global fetch patch handles the rest
  return streamSimple;
}
