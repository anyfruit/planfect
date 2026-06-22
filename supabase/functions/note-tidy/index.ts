// Supabase Edge Function: POST /note-tidy  (Deno runtime).
// Takes a task's free-text note (often a run-on line, typed or dictated) and returns the SAME note
// reorganized into clean, scannable bullet points — no information added or dropped. Auth is the
// caller's JWT (RLS); the LLM call uses the OPENAI_API_KEY secret. A cheap/fast model is plenty.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { estimateCostUsd } from '../../../server/usage.ts';

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Promise<Response>): void };

interface TidyBody { text?: string; title?: string; language?: string }

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const url = Deno.env.get('SUPABASE_URL')!;
    const supabase = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: 'unauthorized' }, 401);

    const body = (await req.json()) as TidyBody;
    const text = (body.text ?? '').trim();
    if (!text) return json({ text: '' });                 // nothing to tidy
    if (text.length > 4000) return json({ text }, 200);   // outsized note — leave as-is, don't burn tokens

    // AI cleanup is a Pro feature once billing is enforced (dormant unless BILLING_ENFORCED=1).
    if (Deno.env.get('BILLING_ENFORCED') === '1') {
      const { data: prof } = await supabase.from('profiles').select('is_pro').eq('id', user.id).single();
      if (!prof?.is_pro) return json({ text, upgrade: true });
    }

    const apiKey = Deno.env.get('OPENAI_API_KEY');
    if (!apiKey) return json({ error: 'note cleanup is not configured' }, 500);
    const model = Deno.env.get('NOTE_TIDY_MODEL') ?? 'gpt-4.1-mini';

    const input = (body.title && body.title.trim() ? `Task: ${body.title.trim()}\n` : '') + `Note:\n${text}`;
    const t0 = Date.now();
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, instructions: INSTRUCTIONS, input, max_output_tokens: 700 }),
    });
    const j = (await res.json()) as {
      output?: Array<Record<string, unknown>>;
      error?: { message?: string };
      usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
    };
    if (j.error) return json({ error: j.error.message ?? 'cleanup failed' }, 502);

    // Best-effort usage logging (service role bypasses the admin-only RLS) — never fail the request on it.
    try {
      const sr = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      if (sr && j.usage) {
        const inputTokens = j.usage.input_tokens ?? 0;
        const outputTokens = j.usage.output_tokens ?? 0;
        const cachedInputTokens = j.usage.input_tokens_details?.cached_tokens ?? 0;
        await createClient(url, sr, { auth: { persistSession: false } }).from('usage_events').insert({
          user_id: user.id, provider: 'openai', model, action: 'note_tidy',
          input_tokens: inputTokens, output_tokens: outputTokens, cached_input_tokens: cachedInputTokens,
          cost_usd: estimateCostUsd('openai', model, { inputTokens, outputTokens, cachedInputTokens }),
          latency_ms: Date.now() - t0, success: true,
        });
      }
    } catch (_) { /* analytics is best-effort */ }

    const cleaned = (j.output ?? [])
      .filter((o) => o.type === 'message')
      .flatMap((o) => ((o.content as Array<Record<string, unknown>>) ?? [])
        .filter((c) => c.type === 'output_text')
        .map((c) => String(c.text ?? '')))
      .join('\n')
      .trim();
    return json({ text: cleaned || text });   // fall back to the original if the model returned nothing
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

const INSTRUCTIONS = [
  'You clean up ONE task\'s note. The note is usually a quick, run-on jot or dictation — little or no',
  'punctuation, everything on one line. Reorganize it into a tidy, scannable note:',
  '- Use short bullet points, each line beginning with "• ".',
  '- Group related items and order them sensibly: timing first (when to leave / be there), then what',
  '  to bring, then where / who, then anything else.',
  '- Preserve EVERY detail — times, places, items, names, numbers. Do NOT invent, omit, summarize away,',
  '  or answer questions; only reorganize and lightly punctuate. Keep the user\'s own wording.',
  '- Reply in the SAME language as the note.',
  '- If the note is already short and clean, or is a single item, just return it tidied — do not pad it',
  '  out into multiple bullets.',
  'Output ONLY the cleaned note text: no title, no preamble, no explanation, no markdown code fences.',
].join('\n');

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
