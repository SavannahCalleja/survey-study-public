/**
 * Database Webhook on `research_responses` (INSERT or UPDATE): transcribe audio URLs on the row.
 * - `q1_audio_url`..`q5_audio_url` → `trans_q1`..`trans_q5` (main survey)
 * - `screening_q3_audio_url` → `screening_q3_reason`, `screening_q4_audio_url` → `screening_q4_reason` (eligibility voice)
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
    if (eventType === "DELETE") {
      return json({ ok: true, skipped: "delete_not_processed" });
    }

    const tableName = extracted.table ?? (typeof parsed.table === "string" ? parsed.table : null);
    if (tableName && tableName !== "research_responses") {
      return json({ ok: true, skipped: "wrong_table" });
    }

    const oldRecord = extractOldRecordFromWebhook(parsed);

    const jobs = collectTranscriptionJobs(record, oldRecord);
    if (jobs.length === 0) {
      console.log(
        `[transcribe-audio] Skip row=${idStr}: no new/changed q1_audio_url..q5_audio_url, screening_q3_audio_url, or screening_q4_audio_url`
      );
      return json({
        ok: true,
        skipped: "no_new_or_changed_audio_urls",
        message:
          "Nothing to transcribe: no new/changed q*_audio_url, screening_q3_audio_url, or screening_q4_audio_url.",
      });
    }

    console.log(
      `[transcribe-audio] row=${idStr} jobs=${jobs.length} → columns: ${jobs.map((j) => j.dbColumn).join(", ")}`
    );

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      console.error("[transcribe-audio] OPENAI_API_KEY is missing");
      return json({ error: "Server misconfiguration" }, 500);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    /** Service role only — never use SUPABASE_ANON_KEY here; RLS would block row updates. */
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("[transcribe-audio] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing");
      return json({ error: "Server misconfiguration" }, 500);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const updates: Record<string, string> = {};

    for (const { dbColumn, url: raw } of jobs) {
      const fullUrl = resolveFullPublicAudioUrl(raw, supabaseUrl);
      console.log(
        `[transcribe-audio] Whisper start row=${idStr} dest=${dbColumn} resolvedUrl=${fullUrl.slice(0, 120)}${fullUrl.length > 120 ? "…" : ""}`
      );
      try {
        const text = await transcribeAudioUrl(fullUrl, openaiKey, `row=${idStr} dest=${dbColumn}`);
        updates[dbColumn] = text;
        console.log(
          `[transcribe-audio] Whisper ok row=${idStr} dest=${dbColumn} chars=${text.length}`
        );
      } catch (jobErr) {
        const msg = jobErr instanceof Error ? jobErr.message : String(jobErr);
        const stack = jobErr instanceof Error ? jobErr.stack : undefined;
        console.error(`[transcribe-audio] Whisper FAILED row=${idStr} dest=${dbColumn}: ${msg}`, stack ?? "");
        throw jobErr;
      }
    }

    const { data: updatedRows, error } = await supabase
      .from("research_responses")
      .update(updates)
      .eq("id", idStr)
      .select("id");

    if (error) {
      console.error("Update failed:", error);
      return json({ error: error.message }, 500);
    }

    if (!updatedRows || updatedRows.length === 0) {
      const noRowErr = new Error(`No row updated for id=${idStr} (missing row or policy blocked write)`);
      console.error("Update failed:", noRowErr);
      return json({ error: noRowErr.message }, 500);
    }

    console.log("Update successful");
    return json({ ok: true, transcribed: Object.keys(updates) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    console.error("[transcribe-audio] Unhandled error:", message, stack ?? "");
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

function extractOldRecordFromWebhook(parsed: Record<string, unknown>): Record<string, unknown> | null {
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
    if (b.old_record && typeof b.old_record === "object") {
      return b.old_record as Record<string, unknown>;
    }
  }
  if (parsed.old_record && typeof parsed.old_record === "object") {
    return parsed.old_record as Record<string, unknown>;
  }
  const payload = parsed.payload;
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (p.old_record && typeof p.old_record === "object") {
      return p.old_record as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * INSERT: transcribe every non-empty audio URL on the row.
 * UPDATE: only when a watched URL changed vs `oldRecord` (second screening clip, final survey audio, etc.).
 */
function collectTranscriptionJobs(
  record: Record<string, unknown>,
  oldRecord: Record<string, unknown> | null
): { dbColumn: string; url: string }[] {
  const jobs: { dbColumn: string; url: string }[] = [];

  const urlChanged = (key: string): boolean => {
    const u = record[key];
    if (typeof u !== "string" || !u.trim()) return false;
    if (!oldRecord) return true;
    return oldRecord[key] !== u;
  };

  for (let q = 1; q <= 5; q++) {
    const uk = `q${q}_audio_url`;
    if (urlChanged(uk)) {
      const u = record[uk];
      if (typeof u === "string" && u.trim()) {
        jobs.push({ dbColumn: `trans_q${q}`, url: u.trim() });
      }
    }
  }

  if (urlChanged("screening_q3_audio_url")) {
    const u = record["screening_q3_audio_url"];
    if (typeof u === "string" && u.trim()) {
      jobs.push({ dbColumn: "screening_q3_reason", url: u.trim() });
    }
  }
  if (urlChanged("screening_q4_audio_url")) {
    const u = record["screening_q4_audio_url"];
    if (typeof u === "string" && u.trim()) {
      jobs.push({ dbColumn: "screening_q4_reason", url: u.trim() });
    }
  }

  return jobs;
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

async function transcribeAudioUrl(audioUrl: string, apiKey: string, context: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(audioUrl);
  } catch (fetchErr) {
    const m = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    console.error(`[transcribe-audio] Audio fetch network error (${context}):`, m, fetchErr);
    throw fetchErr;
  }

  if (!res.ok) {
    let errBody = "";
    try {
      errBody = await res.text();
    } catch (_) {
      errBody = "(could not read body)";
    }
    const msg = `Failed to fetch audio (${context}) HTTP ${res.status}: ${errBody.slice(0, 500)}`;
    console.error(`[transcribe-audio] ${msg}`);
    throw new Error(msg);
  }

  let buf: ArrayBuffer;
  try {
    buf = await res.arrayBuffer();
  } catch (bufErr) {
    const m = bufErr instanceof Error ? bufErr.message : String(bufErr);
    console.error(`[transcribe-audio] Failed to read audio body (${context}):`, m, bufErr);
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
    const m = openaiFetchErr instanceof Error ? openaiFetchErr.message : String(openaiFetchErr);
    console.error(`[transcribe-audio] OpenAI request network error (${context}):`, m, openaiFetchErr);
    throw openaiFetchErr;
  }

  if (!tr.ok) {
    let errText = "";
    try {
      errText = await tr.text();
    } catch {
      errText = "(unreadable)";
    }
    const msg = `OpenAI Whisper failed (${context}) HTTP ${tr.status}: ${errText.slice(0, 2000)}`;
    console.error(`[transcribe-audio] ${msg}`);
    throw new Error(msg);
  }

  let data: { text?: string };
  try {
    data = (await tr.json()) as { text?: string };
  } catch (jsonErr) {
    const m = jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
    console.error(`[transcribe-audio] OpenAI JSON parse error (${context}):`, m, jsonErr);
    throw jsonErr;
  }

  return (data.text ?? "").trim();
}
