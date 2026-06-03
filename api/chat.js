/* ═══════════════════════════════════════════════════════════════════
   RIKSAN AI — api/chat.js
   Vercel Serverless Proxy — Secure API Gateway
   
   Environment Variables required in Vercel:
     AI_API_KEY = your_hidepulsa_api_key
   ═══════════════════════════════════════════════════════════════════ */

const API_BASE   = 'https://ai.hidepulsa.com/v1';
const API_PATH   = '/chat/completions';
const MODEL      = 'deepseek-3.2';
const MAX_TOKENS = 4096;

// ── Rate limiting (in-memory per cold start) ───────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 min
const RATE_LIMIT_MAX    = 30;         // 30 req/min per IP

function checkRateLimit(ip) {
  const now  = Date.now();
  const data = rateLimitMap.get(ip) || { count: 0, reset: now + RATE_LIMIT_WINDOW };

  if (now > data.reset) {
    data.count = 0;
    data.reset = now + RATE_LIMIT_WINDOW;
  }

  data.count++;
  rateLimitMap.set(ip, data);

  // Cleanup old IPs
  if (rateLimitMap.size > 5000) {
    for (const [k, v] of rateLimitMap) {
      if (Date.now() > v.reset) rateLimitMap.delete(k);
    }
  }

  return data.count <= RATE_LIMIT_MAX;
}

// ── Validate request body ──────────────────────────────────────────
function validateBody(body) {
  if (!body || typeof body !== 'object') return 'Invalid request body';
  if (!Array.isArray(body.messages))     return 'messages must be an array';
  if (body.messages.length === 0)        return 'messages cannot be empty';
  if (body.messages.length > 60)         return 'Too many messages';

  for (const m of body.messages) {
    if (!m || typeof m !== 'object')       return 'Invalid message object';
    if (!['user','assistant','system'].includes(m.role)) return `Invalid role: ${m.role}`;
    if (typeof m.content !== 'string')     return 'Message content must be a string';
    if (m.content.length === 0)            return 'Message content cannot be empty';
    if (m.content.length > 32000)          return 'Message content too long';
  }

  return null;
}

// ── Main handler ───────────────────────────────────────────────────
export default async function handler(req, res) {
  // Only POST
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify origin (basic CSRF protection)
  const origin  = req.headers.origin  || '';
  const referer = req.headers.referer || '';
  const xrw     = req.headers['x-requested-with'] || '';

  if (!origin && !referer && xrw !== 'XMLHttpRequest') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Rate limiting
  const ip = (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }

  // API Key
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) {
    console.error('AI_API_KEY environment variable not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Parse & validate body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (_) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const validationError = validateBody(body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  // Build upstream payload
  const payload = {
    model:       MODEL,
    messages:    body.messages,
    max_tokens:  Math.min(body.max_tokens || MAX_TOKENS, MAX_TOKENS),
    stream:      body.stream !== false, // default true
    temperature: Math.min(Math.max(body.temperature || 0.7, 0), 2),
  };

  if (body.system) {
    // Prepend system message
    payload.messages = [
      { role: 'system', content: body.system.slice(0, 4000) },
      ...payload.messages,
    ];
  }

  // Forward to upstream AI
  let upstream;
  try {
    upstream = await fetch(`${API_BASE}${API_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent':    'RiksanAI/2.0',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(55000),
    });
  } catch (err) {
    console.error('Upstream fetch error:', err.message);
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ error: 'AI service timed out. Please try again.' });
    }
    return res.status(502).json({ error: 'Failed to connect to AI service' });
  }

  if (!upstream.ok) {
    let errBody = '';
    try { errBody = await upstream.text(); } catch (_) {}
    console.error('Upstream error:', upstream.status, errBody.slice(0, 200));

    const status  = upstream.status >= 500 ? 502 : upstream.status;
    const message =
      upstream.status === 401 ? 'Authentication error' :
      upstream.status === 429 ? 'AI service rate limit reached' :
      upstream.status >= 500  ? 'AI service error. Please try again.' :
      'AI service error';

    return res.status(status).json({ error: message });
  }

  // Stream response
  if (payload.stream) {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');

    const reader = upstream.body?.getReader();
    if (!reader) {
      return res.status(500).json({ error: 'Streaming not available' });
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        // Flush for Vercel edge
        if (typeof res.flush === 'function') res.flush();
      }
    } catch (err) {
      console.error('Stream pipe error:', err.message);
    } finally {
      try { reader.releaseLock(); } catch (_) {}
      res.end();
    }
    return;
  }

  // Non-streaming response
  let data;
  try {
    data = await upstream.json();
  } catch (_) {
    return res.status(502).json({ error: 'Invalid response from AI service' });
  }

  return res.status(200).json(data);
}
