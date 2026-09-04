'use strict';
const cfg = require('../../config');

const API = 'https://integrate.api.nvidia.com/v1/chat/completions';

/* Minimal NVIDIA NIM client (OpenAI-compatible) returning parsed JSON. */
async function chatJson(system, user, opts = {}) {
  const model = opts.model || cfg.nimModel;
  const key = cfg.nvapiKey;
  if (!key) throw new Error('NVAPI_KEY missing');
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0,
    max_tokens: opts.maxTokens || 8000,
    reasoning_effort: opts.reasoning || 'low'
  };
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs || 150000)
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`nim ${res.status}: ${t.slice(0, 200)}`);
      }
      const data = await res.json();
      const content = data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content : null;
      if (!content) throw new Error('nim empty content');
      return extractJson(content);
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

function extractJson(text) {
  // strip code fences
  let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  // try direct parse, else largest {...} span
  try { return JSON.parse(t); } catch (_) {}
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
  throw new Error('nim did not return JSON');
}

module.exports = { chatJson };
