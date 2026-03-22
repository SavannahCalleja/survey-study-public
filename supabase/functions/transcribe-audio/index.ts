/**
 * Triggered by a Supabase Database Webhook on INSERT into `research_responses`.
 * Transcribes each non-empty `audio_q*` URL (or legacy `audio_url`) via OpenAI Whisper, then updates the same row’s `trans_q*` fields.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const VOICE_MEMOS_BUCKET = "voice-memos";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const rawBody = await req.text();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch (parseErr) {
      throw parseErr;
    }

    const extracted = extractRecordFromWebhook(parsed);

    if (!extracted.record || typeof extracted.record !== "object") {
      return json(
        {
          ok: false,
          error: "missing_record",
          message: "No record found — expected body.record or top-level record",
        },
        400
      );
    }

    const record = extracted.record as Record<string, unknown>;

    const idVal = record["id"];
    const idStr = idVal != null ? String(idVal) : "";
    if (!idStr) {
      return json({ ok: false, error: "missing_record_id" }, 400);
    }

    const eventType = extracted.eventType ?? (typeof parsed.type === "string" ? parsed.type : null);
    if (eventType && eventType !== "INSERT") {
      return json({ ok: true, skipped: "only_insert_processed" });
    }

    const tableName = extracted.table ?? (typeof parsed.table === "string" ? parsed.table : null);
    if (tableName && tableName !== "research_responses") {
      return json({ ok: true, skipped: "wrong_table" });
    }

    const audioSources = gatherAudioSources(record);
    if (audioSources.length === 0) {
      return json({
        ok: false,
        error: "no_audio_url_on_record",
        message:
          "Transcription skipped: no audio_url or audio_q1..audio_q5 present on record (would crash downstream).",
      });
    }

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      return json({ error: "Server misconfiguration" }, 500);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      return json({ error: "Server misconfiguration" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const updates: Record<string, string> = {};

    for (const { q, url: raw } of audioSources) {
      const fullUrl = resolveFullPublicAudioUrl(raw, supabaseUrl);
      const text = await transcribeAudioUrl(fullUrl, openaiKey);
      updates[`trans_q${q}`] = text;
    }

    const { error } = await supabase
      .from("research_responses")
      .update(updates)
      .eq("id", idStr)
      .select("id");

    if (error) {
      return json({ error: error.message }, 500);
    }

    return json({ ok: true, transcribed: Object.keys(updates) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    return json({ error: message, detail: stack }, 500);
  }
});

type ExtractResult = {
  record: Record<string, unknown> | null;
  eventType: string | null;
  table: string | null;
  source: string;
};

/**
 * Supabase Database Webhooks may send the row as top-level `record`, or nested under `body.record`.
 */
function extractRecordFromWebhook(parsed: Record<string, unknown>): ExtractResult {
  let body: unknown = parsed.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body) as Record<string, unknown>;
    } catch {
      body = undefined;
    }
  }
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (b.record && typeof b.record === "object") {
      return {
        record: b.record as Record<string, unknown>,
        eventType: typeof b.type === "string" ? b.type : null,
        table: typeof b.table === "string" ? b.table : null,
        source: "body.record",
      };
    }
  }

  if (parsed.record && typeof parsed.record === "object") {
    return {
      record: parsed.record as Record<string, unknown>,
      eventType: typeof parsed.type === "string" ? parsed.type : null,
      table: typeof parsed.table === "string" ? parsed.table : null,
      source: "top-level.record",
    };
  }

  const payload = parsed.payload;
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (p.record && typeof p.record === "object") {
      return {
        record: p.record as Record<string, unknown>,
        eventType: typeof p.type === "string" ? p.type : null,
        table: typeof p.table === "string" ? p.table : null,
        source: "payload.record",
      };
    }
  }

  return { record: null, eventType: null, table: null, source: "none" };
}

/** Collect per-question audio URLs; if only `audio_url` is set, treat as Q1. */
function gatherAudioSources(record: Record<string, unknown>): { q: number; url: string }[] {
  const out: { q: number; url: string }[] = [];
  for (let q = 1; q <= 5; q++) {
    const raw = record[`audio_q${q}`];
    if (typeof raw === "string" && raw.trim() !== "") {
      out.push({ q, url: raw.trim() });
    }
  }
  if (out.length === 0) {
    const single = record["audio_url"];
    if (typeof single === "string" && single.trim() !== "") {
      out.push({ q: 1, url: single.trim() });
    }
  }
  return out;
}

/**
 * Ensures we fetch from the full public Storage URL for `voice-memos`.
 */
function resolveFullPublicAudioUrl(raw: string, supabaseUrl: string): string {
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw;
  }

  const base = supabaseUrl.replace(/\/+$/, "");
  let objectPath = raw.replace(/^\/+/, "");

  if (objectPath.startsWith(`${VOICE_MEMOS_BUCKET}/`)) {
    objectPath = objectPath.slice(VOICE_MEMOS_BUCKET.length + 1);
  }

  const pathSegments = objectPath.split("/").map((s) => encodeURIComponent(s));
  const encodedPath = pathSegments.join("/");
  return `${base}/storage/v1/object/public/${VOICE_MEMOS_BUCKET}/${encodedPath}`;
}

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function transcribeAudioUrl(audioUrl: string, apiKey: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(audioUrl);
  } catch (fetchErr) {
    throw fetchErr;
  }

  if (!res.ok) {
    let errBody = "";
    try {
      errBody = await res.text();
    } catch (_) {
      errBody = "(could not read body)";
    }
    throw new Error(`Failed to fetch audio (${res.status}): ${errBody.slice(0, 500)}`);
  }

  let buf: ArrayBuffer;
  try {
    buf = await res.arrayBuffer();
  } catch (bufErr) {
    throw bufErr;
  }

  const blob = new Blob([buf], { type: "audio/webm" });
  const form = new FormData();
  form.append("file", blob, "audio.webm");
  form.append("model", "whisper-1");

  let tr: Response;
  try {
    tr = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    });
  } catch (openaiFetchErr) {
    throw openaiFetchErr;
  }

  if (!tr.ok) {
    let errText = "";
    try {
      errText = await tr.text();
    } catch {
      errText = "(unreadable)";
    }
    throw new Error(`OpenAI transcription failed (${tr.status}): ${errText.slice(0, 2000)}`);
  }

  let data: { text?: string };
  try {
    data = (await tr.json()) as { text?: string };
  } catch (jsonErr) {
    throw jsonErr;
  }

  return (data.text ?? "").trim();
}
