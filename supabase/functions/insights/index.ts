// Supabase Edge Function: POST /insights  (Deno runtime).
// Takes the user's aggregated time-by-category summary (computed client-side from time_blocks)
// and returns a short, friendly AI read of where their time goes + a couple of suggestions.
// Auth is the caller's JWT (RLS); the LLM call uses the OPENAI_API_KEY secret.

import { createClient } from 'jsr:@supabase/supabase-js@2';

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Promise<Response>): void };

interface CatMin { label: string; minutes: number }
interface DaySummary { day: string; items: CatMin[] }
interface InsightsBody {
  period?: string;
  scope?: string;
  language?: string;
  total_min?: number;
  tasks_done?: number;
  tasks_total?: number;
  categories?: CatMin[];
  per_day?: DaySummary[];
}

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

    const body = (await req.json()) as InsightsBody;
    const cats = (body.categories ?? []).filter((c) => c.minutes > 0);
    if (cats.length === 0) return json({ analysis: '' });

    const apiKey = Deno.env.get('OPENAI_API_KEY');
    if (!apiKey) return json({ error: 'analysis is not configured' }, 500);
    const model = Deno.env.get('INSIGHTS_MODEL') ?? 'gpt-5.3';

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        instructions: buildInstructions(body.language),
        input: buildSummary(body, cats),
        max_output_tokens: 650,
      }),
    });
    const j = (await res.json()) as { output?: Array<Record<string, unknown>>; error?: { message?: string } };
    if (j.error) return json({ error: j.error.message ?? 'analysis failed' }, 502);
    const text = (j.output ?? [])
      .filter((o) => o.type === 'message')
      .flatMap((o) => ((o.content as Array<Record<string, unknown>>) ?? [])
        .filter((c) => c.type === 'output_text')
        .map((c) => String(c.text ?? '')))
      .join('\n')
      .trim();
    return json({ analysis: text || 'No analysis available right now.' });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

function buildInstructions(language?: string): string {
  const lang = language && language.length > 0 ? language : "the user's language";
  return [
    'You are Planfect — a warm, insightful day-planning companion. The user is reviewing how their',
    'time is allocated. From the category breakdown, write a SHORT, friendly analysis: 3–5 sentences',
    'or 3–4 short bullet points. Interpret, do not just repeat the numbers. Cover what stands out,',
    'the balance across work / focus / rest / health / fitness / social, anything notably dominant or',
    'missing, and how follow-through looks (tasks done vs planned). End with 1–2 gentle, concrete',
    'suggestions. Be encouraging and human — not preachy or clinical. At most a couple of light emoji.',
    `Reply in ${lang}. Keep it tight and skimmable.`,
  ].join(' ');
}

function buildSummary(body: InsightsBody, cats: CatMin[]): string {
  const total = body.total_min ?? cats.reduce((s, c) => s + c.minutes, 0);
  const lines: string[] = [];
  lines.push(`Period: ${body.period ?? 'recent'} (${body.scope ?? 'range'}).`);
  lines.push(`Total planned: ${hm(total)}. Tasks done: ${body.tasks_done ?? 0} of ${body.tasks_total ?? 0}.`);
  lines.push('Time by category:');
  for (const c of cats) {
    const pct = total > 0 ? Math.round((c.minutes / total) * 100) : 0;
    lines.push(`- ${c.label}: ${hm(c.minutes)} (${pct}%)`);
  }
  const perDay = body.per_day ?? [];
  if (perDay.length > 0) {
    lines.push('Per day:');
    for (const d of perDay) {
      const parts = d.items.filter((i) => i.minutes > 0).map((i) => `${i.label} ${hm(i.minutes)}`);
      if (parts.length) lines.push(`- ${d.day}: ${parts.join(', ')}`);
    }
  }
  return lines.join('\n');
}

function hm(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
