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
  console.log("[transcribe-audio] Incoming request", { method: req.method, url: req.url });

  if (req.method === "OPTIONS") {
    console.log("[transcribe-audio] OPTIONS preflight — responding ok");
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    console.log("[transcribe-audio] Rejecting non-POST");
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    console.log("[transcribe-audio] Received webhook — parsing JSON body");
    const rawBody = await req.text();
    console.log("[transcribe-audio] Raw body length (chars):", rawBody.length);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch (parseErr) {
      console.error("[transcribe-audio] JSON parse failed:", parseErr);
      throw parseErr;
    }

    console.log("[transcribe-audio] Parsed top-level keys:", Object.keys(parsed));

    const extracted = extractRecordFromWebhook(parsed);
    console.log("[transcribe-audio] Payload extraction source:", extracted.source, {
      eventType: extracted.eventType,
      table: extracted.table,
      hasRecord: !!extracted.record,
    });

    if (!extracted.record || typeof extracted.record !== "object") {
      console.error(
        "[transcribe-audio] SAFE_CHECK: Could not find record on payload. Tried body.record, top-level record, payload.record. Keys:",
        Object.keys(parsed)
      );
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
      console.error("[transcribe-audio] SAFE_CHECK: record.id is missing");
      return json({ ok: false, error: "missing_record_id" }, 400);
    }

    console.log('Processing record ID:', record['id']);

    const eventType = extracted.eventType ?? (typeof parsed.type === "string" ? parsed.type : null);
    if (eventType && eventType !== "INSERT") {
      console.log("[transcribe-audio] Skipping — not INSERT:", eventType);
      return json({ ok: true, skipped: "only_insert_processed" });
    }

    const tableName = extracted.table ?? (typeof parsed.table === "string" ? parsed.table : null);
    if (tableName && tableName !== "research_responses") {
      console.log("[transcribe-audio] Skipping — wrong table:", tableName);
      return json({ ok: true, skipped: "wrong_table" });
    }

    const audioSources = gatherAudioSources(record);
    if (audioSources.length === 0) {
      console.error(
        "[transcribe-audio] SAFE_CHECK: No audio URL on record — expected at least one of audio_url, audio_q1..audio_q5. Record keys:",
        Object.keys(record)
      );
      return json({
        ok: false,
        error: "no_audio_url_on_record",
        message:
          "Transcription skipped: no audio_url or audio_q1..audio_q5 present on record (would crash downstream).",
      });
    }

    console.log("[transcribe-audio] Checking OPENAI_API_KEY");
    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      console.error("[transcribe-audio] OPENAI_API_KEY is not set");
      return json({ error: "Server misconfiguration" }, 500);
    }
    console.log("[transcribe-audio] OPENAI_API_KEY present (length):", openaiKey.length);

    console.log("[transcribe-audio] Checking SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      console.error("[transcribe-audio] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing", {
        hasUrl: !!supabaseUrl,
        hasServiceKey: !!serviceKey,
      });
      return json({ error: "Server misconfiguration" }, 500);
    }
    console.log("[transcribe-audio] SUPABASE_URL:", supabaseUrl);
    console.log("[transcribe-audio] SUPABASE_SERVICE_ROLE_KEY present (length):", serviceKey.length);

    console.log("[transcribe-audio] Creating Supabase client with SUPABASE_SERVICE_ROLE_KEY for research_responses update");
    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const updates: Record<string, string> = {};

    for (const { q, url: raw } of audioSources) {
      console.log(`[transcribe-audio] Q${q} raw URL:`, raw);

      try {
        console.log(`[transcribe-audio] Q${q} — Building full public URL for bucket '${VOICE_MEMOS_BUCKET}'`);
        const fullUrl = resolveFullPublicAudioUrl(raw, supabaseUrl);
        console.log(`[transcribe-audio] Q${q} — Resolved URL:`, fullUrl);

        console.log(`[transcribe-audio] Q${q} — Calling OpenAI Whisper`);
        const text = await transcribeAudioUrl(fullUrl, openaiKey, q);
        console.log(`[transcribe-audio] Q${q} — Transcription length (chars):`, text.length);

        updates[`trans_q${q}`] = text;
      } catch (qErr) {
        const msg = qErr instanceof Error ? qErr.message : String(qErr);
        const stack = qErr instanceof Error ? qErr.stack : undefined;
        console.error(`[transcribe-audio] Q${q} — FAILED:`, msg, stack ?? "");
        throw qErr;
      }
    }

    console.log("[transcribe-audio] Applying DB update to research_responses with SUPABASE_SERVICE_ROLE_KEY, keys:", Object.keys(updates));
    try {
      const { data: updateData, error } = await supabase
        .from("research_responses")
        .update(updates)
        .eq("id", idStr)
        .select("id");

      if (error) {
        console.error("[transcribe-audio] Supabase update error (full):", JSON.stringify(error));
        return json({ error: error.message }, 500);
      }
      console.log("[transcribe-audio] DB update success:", updateData);
    } catch (dbErr) {
      console.error("[transcribe-audio] DB update threw:", dbErr);
      throw dbErr;
    }

    console.log("[transcribe-audio] Handler finished OK");
    return json({ ok: true, transcribed: Object.keys(updates) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    console.error("[transcribe-audio] TOP-LEVEL CATCH — error message:", message);
    console.error("[transcribe-audio] TOP-LEVEL CATCH — stack:", stack ?? "(no stack)");
    console.error("[transcribe-audio] TOP-LEVEL CATCH — raw:", e);
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
  // 1) body.record (common wrapper / proxy shape)
  let body: unknown = parsed.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body) as Record<string, unknown>;
      console.log("[transcribe-audio] Parsed body as JSON string");
    } catch {
      console.log("[transcribe-audio] body was string but not JSON — ignoring");
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

  // 2) Top-level record (documented Supabase webhook shape)
  if (parsed.record && typeof parsed.record === "object") {
    return {
      record: parsed.record as Record<string, unknown>,
      eventType: typeof parsed.type === "string" ? parsed.type : null,
      table: typeof parsed.table === "string" ? parsed.table : null,
      source: "top-level.record",
    };
  }

  // 3) payload.record
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
  console.log("[transcribe-audio] resolveFullPublicAudioUrl input:", raw);

  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    console.log("[transcribe-audio] Using absolute URL as-is (already full public URL)");
    return raw;
  }

  const base = supabaseUrl.replace(/\/+$/, "");
  let objectPath = raw.replace(/^\/+/, "");

  if (objectPath.startsWith(`${VOICE_MEMOS_BUCKET}/`)) {
    objectPath = objectPath.slice(VOICE_MEMOS_BUCKET.length + 1);
  }

  const pathSegments = objectPath.split("/").map((s) => encodeURIComponent(s));
  const encodedPath = pathSegments.join("/");
  const full = `${base}/storage/v1/object/public/${VOICE_MEMOS_BUCKET}/${encodedPath}`;

  console.log("[transcribe-audio] Built full public URL:", full);
  return full;
}

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function transcribeAudioUrl(audioUrl: string, apiKey: string, q: number): Promise<string> {
  console.log(`[transcribe-audio] Q${q} — Fetching audio bytes from URL`);

  let res: Response;
  try {
    res = await fetch(audioUrl);
  } catch (fetchErr) {
    console.error(`[transcribe-audio] Q${q} — fetch() threw:`, fetchErr);
    throw fetchErr;
  }

  console.log(`[transcribe-audio] Q${q} — Audio fetch status:`, res.status, res.statusText);

  if (!res.ok) {
    let errBody = "";
    try {
      errBody = await res.text();
    } catch (_) {
      errBody = "(could not read body)";
    }
    console.error(`[transcribe-audio] Q${q} — Audio fetch failed body:`, errBody);
    throw new Error(`Failed to fetch audio (${res.status}): ${errBody.slice(0, 500)}`);
  }

  let buf: ArrayBuffer;
  try {
    buf = await res.arrayBuffer();
  } catch (bufErr) {
    console.error(`[transcribe-audio] Q${q} — arrayBuffer() failed:`, bufErr);
    throw bufErr;
  }

  console.log(`[transcribe-audio] Q${q} — Downloaded bytes:`, buf.byteLength);

  console.log(`[transcribe-audio] Q${q} — Building multipart body for OpenAI`);
  const blob = new Blob([buf], { type: "audio/webm" });
  const form = new FormData();
  form.append("file", blob, "audio.webm");
  form.append("model", "whisper-1");

  console.log(`[transcribe-audio] Q${q} — POST https://api.openai.com/v1/audio/transcriptions`);

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
    console.error(`[transcribe-audio] Q${q} — OpenAI fetch threw:`, openaiFetchErr);
    throw openaiFetchErr;
  }

  console.log(`[transcribe-audio] Q${q} — OpenAI response status:`, tr.status, tr.statusText);

  if (!tr.ok) {
    let errText = "";
    try {
      errText = await tr.text();
    } catch (te) {
      console.error(`[transcribe-audio] Q${q} — Could not read OpenAI error body:`, te);
      errText = "(unreadable)";
    }
    console.error(`[transcribe-audio] Q${q} — OpenAI error body:`, errText);
    throw new Error(`OpenAI transcription failed (${tr.status}): ${errText.slice(0, 2000)}`);
  }

  let data: { text?: string };
  try {
    data = (await tr.json()) as { text?: string };
  } catch (jsonErr) {
    console.error(`[transcribe-audio] Q${q} — JSON parse of OpenAI response failed:`, jsonErr);
    throw jsonErr;
  }

  const text = (data.text ?? "").trim();
  console.log(`[transcribe-audio] Q${q} — Parsed transcription preview:`, text.slice(0, 120));
  return text;
}
