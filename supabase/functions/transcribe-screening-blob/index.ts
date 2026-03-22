/**
 * Invoked from the browser after eligibility screening voice clips (multipart FormData `file`).
 * Uses OpenAI Whisper — same as webhook-based transcribe-audio, but for raw uploads.
 */
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

  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) {
    return json({ error: "Server misconfiguration" }, 500);
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return json({ error: "invalid_form_data" }, 400);
  }

  const file = formData.get("file");
  if (!file || !(file instanceof Blob)) {
    return json({ error: "missing_file" }, 400);
  }

  const buf = await file.arrayBuffer();
  const mime = file.type || "audio/webm";
  const blob = new Blob([buf], { type: mime });
  const out = new FormData();
  out.append("file", blob, "clip.webm");
  out.append("model", "whisper-1");

  let tr: Response;
  try {
    tr = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}` },
      body: out,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: "openai_fetch_failed", detail: msg }, 502);
  }

  if (!tr.ok) {
    const errText = await tr.text();
    return json({ error: "openai_transcription_failed", detail: errText.slice(0, 2000) }, 502);
  }

  const data = (await tr.json()) as { text?: string };
  return json({ text: (data.text ?? "").trim() });
});

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
