/* ═══════════════════════════════════════════════════════════════════
   RIKSAN AI — api.js
   API Client & Streaming Handler
   ═══════════════════════════════════════════════════════════════════ */

'use strict';

const RiksanAPI = (() => {

  // ── Config ────────────────────────────────────────────────────────
  const CONFIG = {
    endpoint:   '/api/chat',
    model:      'deepseek-3.2',
    maxTokens:  4096,
    timeout:    60000,   // 60 seconds
    retries:    2,
    retryDelay: 1000,
    systemPrompt: `You are Riksan AI, a premium intelligent assistant powered by DeepSeek. You are:

- Expert in programming, software architecture, and web development
- Proficient in business analysis, market research, and strategic planning  
- Skilled in content writing, research, and summarization
- Excellent at problem-solving, brainstorming, and creative tasks

Guidelines:
- Be direct, concise, and accurate
- Use clear markdown formatting for structured responses
- Use code blocks with proper language tags for all code
- Always provide working, production-ready code
- Be helpful, professional, and thorough
- For Indonesian users: you can respond in Bahasa Indonesia when the user writes in it`,
  };

  // ── Validate & sanitize messages ──────────────────────────────────
  function validateMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('Invalid messages array');
    }
    return messages
      .filter(m => m && m.role && typeof m.content === 'string' && m.content.trim())
      .map(m => ({
        role: ['user', 'assistant', 'system'].includes(m.role) ? m.role : 'user',
        content: m.content.slice(0, 32000),
      }));
  }

  // ── Sleep helper ──────────────────────────────────────────────────
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ── Stream Chat ───────────────────────────────────────────────────
  async function streamChat(messages, onChunk, signal, attempt = 0) {
    const validated = validateMessages(messages);

    const body = JSON.stringify({
      model:      CONFIG.model,
      messages:   validated,
      max_tokens: CONFIG.maxTokens,
      system:     CONFIG.systemPrompt,
      stream:     true,
    });

    let response;
    try {
      response = await fetch(CONFIG.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body,
        signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;

      // Network error — retry
      if (attempt < CONFIG.retries) {
        await sleep(CONFIG.retryDelay * (attempt + 1));
        return streamChat(messages, onChunk, signal, attempt + 1);
      }
      throw new Error('Network error. Please check your connection.');
    }

    // Handle HTTP errors
    if (!response.ok) {
      let errMsg = `HTTP ${response.status}`;
      try {
        const errData = await response.json();
        errMsg = errData?.error?.message || errData?.message || errMsg;
      } catch (_) {}

      // Retry on 5xx
      if (response.status >= 500 && attempt < CONFIG.retries) {
        await sleep(CONFIG.retryDelay * (attempt + 1));
        return streamChat(messages, onChunk, signal, attempt + 1);
      }

      throw new Error(errMsg);
    }

    // Read stream
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Streaming not supported');

    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // keep incomplete line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') return;

          try {
            const parsed = JSON.parse(data);
            const chunk = extractChunk(parsed);
            if (chunk) onChunk(chunk);
          } catch (_) {
            // Non-JSON line, skip
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim().startsWith('data:')) {
        const data = buffer.trim().slice(5).trim();
        if (data && data !== '[DONE]') {
          try {
            const parsed = JSON.parse(data);
            const chunk = extractChunk(parsed);
            if (chunk) onChunk(chunk);
          } catch (_) {}
        }
      }

    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }
  }

  // ── Extract text chunk from SSE event ─────────────────────────────
  function extractChunk(parsed) {
    // OpenAI-compatible format
    if (parsed?.choices?.[0]?.delta?.content) {
      return parsed.choices[0].delta.content;
    }
    // Anthropic format
    if (parsed?.type === 'content_block_delta' && parsed?.delta?.text) {
      return parsed.delta.text;
    }
    if (parsed?.delta?.text) {
      return parsed.delta.text;
    }
    // Generic text field
    if (typeof parsed?.text === 'string') {
      return parsed.text;
    }
    return null;
  }

  // ── Non-streaming fallback ────────────────────────────────────────
  async function chat(messages, attempt = 0) {
    const validated = validateMessages(messages);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.timeout);

    let response;
    try {
      response = await fetch(CONFIG.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          model:      CONFIG.model,
          messages:   validated,
          max_tokens: CONFIG.maxTokens,
          system:     CONFIG.systemPrompt,
          stream:     false,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error('Request timed out');
      if (attempt < CONFIG.retries) {
        await sleep(CONFIG.retryDelay * (attempt + 1));
        return chat(messages, attempt + 1);
      }
      throw new Error('Network error. Please check your connection.');
    }

    clearTimeout(timer);

    if (!response.ok) {
      let errMsg = `HTTP ${response.status}`;
      try {
        const errData = await response.json();
        errMsg = errData?.error?.message || errData?.message || errMsg;
      } catch (_) {}
      if (response.status >= 500 && attempt < CONFIG.retries) {
        await sleep(CONFIG.retryDelay * (attempt + 1));
        return chat(messages, attempt + 1);
      }
      throw new Error(errMsg);
    }

    const data = await response.json();

    // Extract content
    const content =
      data?.choices?.[0]?.message?.content ||
      data?.content?.[0]?.text ||
      data?.message?.content ||
      data?.text ||
      '';

    if (!content) throw new Error('Empty response from AI');
    return content;
  }

  return { streamChat, chat };

})();
