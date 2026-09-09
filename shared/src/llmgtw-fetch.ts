/** Compatibility for the llmgtw Gemini route verified with non-streaming requests. */
export function createLlmgtwFetch(transport: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== 'https://gateway.llmgtw.io' || url.pathname !== '/v1/chat/completions' || typeof init?.body !== 'string') {
      return transport(input, init);
    }
    const body = JSON.parse(init.body);
    if (body.model !== 'gemini-3.1-pro-preview') return transport(input, init);
    // This route's accepted probe uses JSON, max_completion_tokens and no temperature.
    if (body.stream === true) throw new Error('llmgtw Gemini requires non-streaming generation');
    body.stream = false;
    if (body.max_completion_tokens === undefined && body.max_tokens !== undefined) body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
    delete body.stream_options;
    delete body.temperature;
    // Single attempt: failures and ambiguous responses must not replay paid inference.
    return transport(input, { ...init, body: JSON.stringify(body), redirect: 'error' });
  };
}
