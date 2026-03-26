/**
 * Custom streamFn for Cohere that strips unsupported OpenAI fields.
 * Wraps pi-ai's streamSimple but intercepts the fetch to fix the request body.
 */

const COHERE_BASE = "https://api.cohere.ai/compatibility/v1";

export function createCohereStreamFn(apiKey) {
  // Monkey-patch: intercept the fetch call to fix the request body
  const origFetch = globalThis.fetch;

  return async function cohereStreamFn(model, messages, options) {
    // Temporarily override fetch to strip unsupported fields
    globalThis.fetch = async (url, init) => {
      if (typeof url === "string" && url.includes("cohere.ai")) {
        try {
          const body = JSON.parse(init.body);
          // Remove fields Cohere doesn't support
          delete body.stream_options;
          delete body.store;
          // Cohere uses max_tokens, not max_completion_tokens
          if (body.max_completion_tokens) {
            body.max_tokens = body.max_completion_tokens;
            delete body.max_completion_tokens;
          }
          init.body = JSON.stringify(body);
        } catch {}
      }
      return origFetch(url, init);
    };

    try {
      const { streamSimple } = await import("@mariozechner/pi-ai");
      return await streamSimple(model, messages, options);
    } finally {
      globalThis.fetch = origFetch;
    }
  };
}
