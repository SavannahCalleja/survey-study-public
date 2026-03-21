/**
 * Survey app — Supabase client, recording UI, and submission.
 */
const SUPABASE_URL = 'https://dtlafcfgggortlnfdwbq.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR0bGFmY2ZnZ2dvcnRsbmZkd2JxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NTQwMTMsImV4cCI6MjA4OTUzMDAxM30.IamD-kXYosXMCM17Udr6br1Ac-E1biFW4RXnAmAwDC4';

let supabaseClient;

/** Pending voice answers only; uploaded to Supabase in submitSurvey(), not when recording stops. */
const recordedBlobs = {};
const previewUrls = {};
let currentRecordingQ = null;
let currentStream = null;
let currentRecorder = null;

function initSupabase() {
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    console.error('[Supabase] @supabase/supabase-js not loaded before app.js');
    return;
  }
  if (
    !SUPABASE_URL ||
    SUPABASE_URL.indexOf('REPLACE_WITH') !== -1 ||
    !SUPABASE_ANON_KEY ||
    SUPABASE_ANON_KEY.indexOf('REPLACE_WITH') !== -1
  ) {
    console.warn('[Supabase] Set SUPABASE_URL and SUPABASE_ANON_KEY in js/app.js');
  }
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

function getResponseText(q) {
  const el = document.getElementById('response_q' + q);
  return (el && el.value ? el.value : '').trim();
}

function getResponseMode(q) {
  const el = document.querySelector('input[name="response_mode_' + q + '"]:checked');
  return el && el.value === 'audio' ? 'audio' : 'text';
}

function clearQuestionAudio(q) {
  revokeAudioPreview(q);
  delete recordedBlobs['q' + q];
  const audio = document.querySelector('.audio-player[data-q="' + q + '"]');
  if (audio) {
    audio.pause();
    audio.src = '';
    audio.style.display = 'none';
  }
  setRecordButtonIdle(q);
}

function setResponseModeUI(q, mode) {
  const textPanel = document.querySelector('.response-text-panel[data-q="' + q + '"]');
  const audioPanel = document.querySelector('.response-audio-panel[data-q="' + q + '"]');
  const ta = document.getElementById('response_q' + q);
  if (mode === 'text') {
    if (textPanel) textPanel.hidden = false;
    if (audioPanel) audioPanel.hidden = true;
    clearQuestionAudio(q);
    if (ta) ta.disabled = false;
  } else {
    if (textPanel) textPanel.hidden = true;
    if (audioPanel) audioPanel.hidden = false;
    if (ta) {
      ta.value = '';
      ta.disabled = true;
    }
  }
}

function initResponseModes() {
  for (let q = 1; q <= 5; q++) {
    setResponseModeUI(q, getResponseMode(q));
  }
  applyRecordingLock(null, false);
}

function syncPrimaryModalityOtherUI() {
  const sel = document.getElementById('primary_modality_select');
  const wrap = document.getElementById('primary_modality_other_wrap');
  const input = document.getElementById('primary_modality_other');
  if (!sel || !wrap || !input) return;
  const show = sel.value === 'other';
  wrap.hidden = !show;
  if (!show) input.value = '';
}

function bindPrimaryModalityUI() {
  const sel = document.getElementById('primary_modality_select');
  if (!sel) return;
  sel.addEventListener('change', syncPrimaryModalityOtherUI);
  syncPrimaryModalityOtherUI();
}

function bindResponseModeRadios() {
  for (let q = 1; q <= 5; q++) {
    document.querySelectorAll('input[name="response_mode_' + q + '"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        if (!radio.checked) return;
        const qNum = parseInt(radio.getAttribute('data-q'), 10);
        stopAllRecordings();
        setResponseModeUI(qNum, radio.value);
        applyRecordingLock(null, false);
      });
    });
  }
}

/** Lock UI while recording; only voice-mode questions get an enabled Record button. */
function applyRecordingLock(activeQ, isRecording) {
  document.querySelectorAll('.response-mode-fieldset input[type="radio"]').forEach(function (radio) {
    radio.disabled = isRecording;
  });

  document.querySelectorAll('.record-btn').forEach(function (b) {
    const qq = parseInt(b.getAttribute('data-q'), 10);
    if (getResponseMode(qq) !== 'audio') {
      b.disabled = true;
      return;
    }
    b.disabled = isRecording && qq !== activeQ;
  });

  document.querySelectorAll('.response-card textarea').forEach(function (ta) {
    const card = ta.closest('.response-card');
    if (!card) return;
    const qq = parseInt(card.getAttribute('data-q'), 10);
    if (getResponseMode(qq) !== 'text') {
      ta.disabled = true;
      return;
    }
    ta.disabled = isRecording;
  });
}

function setRecordButtonIdle(q) {
  const btn = document.querySelector('.record-btn[data-q="' + q + '"]');
  if (!btn) return;
  btn.classList.remove('recording-active');
  btn.textContent = 'Record answer';
}

function setRecordButtonActive(q) {
  const btn = document.querySelector('.record-btn[data-q="' + q + '"]');
  if (!btn) return;
  btn.classList.add('recording-active');
  btn.textContent = 'Recording... Tap to Stop';
}

function resetAllRecordButtons() {
  document.querySelectorAll('.record-btn').forEach(function (b) {
    b.classList.remove('recording-active');
    b.textContent = 'Record answer';
  });
  applyRecordingLock(null, false);
}

function showError(msg) {
  const el = document.getElementById('error');
  if (!el) return;
  el.innerText = msg;
  el.style.display = 'block';
  setTimeout(function () {
    el.style.display = 'none';
  }, 7000);
}

function showSuccess(msg) {
  const el = document.getElementById('feedback');
  if (!el) return;
  el.innerText = msg;
  el.style.display = 'block';
  setTimeout(function () {
    el.style.display = 'none';
  }, 7000);
}

function setPlayerUI(q, dataUrl) {
  const audio = document.querySelector('.audio-player[data-q="' + q + '"]');
  if (dataUrl && audio) {
    audio.src = dataUrl;
    audio.style.display = 'inline';
  }
}

function revokeAudioPreview(q) {
  const key = 'q' + q;
  if (previewUrls[key]) {
    URL.revokeObjectURL(previewUrls[key]);
    delete previewUrls[key];
  }
}

function stopAllRecordings() {
  if (currentRecorder) {
    try {
      currentRecorder.stop();
    } catch (e) {}
    currentRecorder = null;
  }
  if (currentStream) {
    currentStream.getTracks().forEach(function (t) {
      t.stop();
    });
    currentStream = null;
  }
  if (currentRecordingQ !== null) {
    setRecordButtonIdle(currentRecordingQ);
    applyRecordingLock(null, false);
    currentRecordingQ = null;
  }
}

async function uploadAudioBlob(qnumber, blob) {
  const ts = Date.now();
  const nonce = Math.random().toString(36).slice(2, 10);
  const filename = 'q' + qnumber + '_' + ts + '_' + nonce + '.webm';
  const { error } = await supabaseClient.storage.from('voice-memos').upload(filename, blob, {
    upsert: false,
    contentType: 'audio/webm',
  });
  if (error) {
    console.error('[Supabase storage] upload failed:', error, { bucket: 'voice-memos', filename });
    throw error;
  }
  const { data: urlData } = supabaseClient.storage.from('voice-memos').getPublicUrl(filename);
  return urlData.publicUrl;
}

/**
 * Validates (written XOR voice per question), uploads to `voice-memos`, inserts into `research_responses`.
 * text_q* / trans_q* for written answers; for voice, trans_* starts empty until the DB webhook runs the Edge Function.
 * Success shows immediately after insert. Never call supabase.functions from the browser.
 */
async function submitSurvey(ev) {
  // Upload + insert only. Background transcription is triggered by the database webhook, not the client.
  ev.preventDefault();

  if (!supabaseClient) {
    showError('Survey is not connected. Check Supabase settings in js/app.js.');
    return;
  }

  stopAllRecordings();

  const submitBtn = document.querySelector('.submit-btn');
  submitBtn.disabled = true;
  const errEl = document.getElementById('error');
  const okEl = document.getElementById('feedback');
  if (errEl) errEl.style.display = 'none';
  if (okEl) okEl.style.display = 'none';

  const modalitySelectVal = document.getElementById('primary_modality_select').value;
  let primaryModalityValue = modalitySelectVal;
  if (modalitySelectVal === 'other') {
    primaryModalityValue = document.getElementById('primary_modality_other').value.trim();
    if (!primaryModalityValue) {
      showError('Please specify your primary modality when you select Other.');
      submitBtn.disabled = false;
      return;
    }
  }

  const demographics = {
    age: Number(document.getElementById('age').value),
    height: Number(document.getElementById('height').value),
    height_unit: document.getElementById('height_unit').value,
    bio_sex: document.getElementById('bio_sex').value,
    ethnicity: document.getElementById('ethnicity').value,
    years_training: Number(document.getElementById('years_training').value),
    typical_training_minutes: Number(document.getElementById('typical_training_minutes').value),
    current_weight: Number(document.getElementById('current_weight').value),
    weight_unit: document.getElementById('weight_unit').value,
    days_per_week: Number(document.getElementById('days_per_week').value),
    primary_modality: primaryModalityValue,
  };

  const missing = [];
  const mixed = [];
  for (let qi = 1; qi <= 5; qi++) {
    const mode = getResponseMode(qi);
    const text = getResponseText(qi);
    const hasAudio = !!recordedBlobs['q' + qi];
    if (mode === 'text') {
      if (!text) missing.push('Q' + qi + ' (written answer)');
      if (hasAudio) mixed.push('Q' + qi);
    } else {
      if (!hasAudio) missing.push('Q' + qi + ' (voice recording)');
      if (text) mixed.push('Q' + qi);
    }
  }
  if (mixed.length) {
    showError(
      'Each question must be answered with either writing or voice only — please fix: ' + mixed.join(', ')
    );
    submitBtn.disabled = false;
    return;
  }
  if (missing.length) {
    showError('Please complete every question: ' + missing.join('; '));
    submitBtn.disabled = false;
    return;
  }

  let needsUpload = false;
  for (let u = 1; u <= 5; u++) {
    if (getResponseMode(u) === 'audio' && recordedBlobs['q' + u]) {
      needsUpload = true;
      break;
    }
  }

  const audioUrls = {
    audio_q1: '',
    audio_q2: '',
    audio_q3: '',
    audio_q4: '',
    audio_q5: '',
  };

  /** Written text for text-mode questions; audio-mode leaves trans_* empty for background jobs. */
  const transByQ = { 1: '', 2: '', 3: '', 4: '', 5: '' };
  for (let qt = 1; qt <= 5; qt++) {
    if (getResponseMode(qt) === 'text') {
      transByQ[qt] = getResponseText(qt);
    }
  }

  const submitLabelDefault = submitBtn.textContent;
  submitBtn.textContent = 'Submitting…';

  if (needsUpload) {
    try {
      for (let qUp = 1; qUp <= 5; qUp++) {
        if (getResponseMode(qUp) === 'audio' && recordedBlobs['q' + qUp]) {
          audioUrls['audio_q' + qUp] = await uploadAudioBlob(qUp, recordedBlobs['q' + qUp]);
        }
      }
    } catch (err) {
      console.error('[Supabase storage] upload exception:', err);
      const msg = err && err.message ? err.message : String(err);
      showError('Audio upload failed: ' + msg);
      submitBtn.disabled = false;
      submitBtn.textContent = submitLabelDefault;
      return;
    }
  }

  const t1 = getResponseMode(1) === 'text' ? getResponseText(1) : '';
  const t2 = getResponseMode(2) === 'text' ? getResponseText(2) : '';
  const t3 = getResponseMode(3) === 'text' ? getResponseText(3) : '';
  const t4 = getResponseMode(4) === 'text' ? getResponseText(4) : '';
  const t5 = getResponseMode(5) === 'text' ? getResponseText(5) : '';

  const row = {
    age: demographics.age,
    height: demographics.height,
    height_unit: demographics.height_unit,
    bio_sex: demographics.bio_sex,
    ethnicity: demographics.ethnicity,
    years_training: demographics.years_training,
    typical_training_minutes: demographics.typical_training_minutes,
    current_weight: demographics.current_weight,
    weight_unit: demographics.weight_unit,
    days_per_week: demographics.days_per_week,
    primary_modality: demographics.primary_modality,
    text_q1: t1,
    text_q2: t2,
    text_q3: t3,
    text_q4: t4,
    text_q5: t5,
    trans_q1: transByQ[1],
    trans_q2: transByQ[2],
    trans_q3: transByQ[3],
    trans_q4: transByQ[4],
    trans_q5: transByQ[5],
    audio_q1: audioUrls.audio_q1 || '',
    audio_q2: audioUrls.audio_q2 || '',
    audio_q3: audioUrls.audio_q3 || '',
    audio_q4: audioUrls.audio_q4 || '',
    audio_q5: audioUrls.audio_q5 || '',
    submitted_at: new Date().toISOString(),
  };

  const { error } = await supabaseClient.from('research_responses').insert([row]);
  if (error) {
    console.error('[Supabase] insert research_responses failed:', error, {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
      payloadKeys: Object.keys(row),
    });
    showError('Submission error: ' + (error.message || error));
    submitBtn.disabled = false;
    submitBtn.textContent = submitLabelDefault;
    return;
  }

  for (let rq = 1; rq <= 5; rq++) revokeAudioPreview(rq);
  resetAllRecordButtons();
  for (let cq = 1; cq <= 5; cq++) delete recordedBlobs['q' + cq];
  showSuccess('Thank you! Your survey has been submitted.');
  document.getElementById('research-survey').reset();
  syncPrimaryModalityOtherUI();
  initResponseModes();
  document.querySelectorAll('.audio-player').forEach(function (a) {
    a.style.display = 'none';
    a.src = '';
  });
  submitBtn.disabled = false;
  submitBtn.textContent = submitLabelDefault;
}

function bindRecordButtons() {
  for (let q = 1; q <= 5; q++) {
    (function (qNum) {
      const btn = document.querySelector('.record-btn[data-q="' + qNum + '"]');
      if (!btn) return;
      btn.addEventListener('click', async function () {
        if (getResponseMode(qNum) !== 'audio') return;
        if (currentRecorder && currentRecordingQ === qNum) {
          currentRecorder.stop();
          stopAllRecordings();
          return;
        }
        stopAllRecordings();
        setRecordButtonActive(qNum);
        applyRecordingLock(qNum, true);
        try {
          currentStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const chunks = [];
          const recorder = new MediaRecorder(currentStream, { mimeType: 'audio/webm' });
          currentRecorder = recorder;
          currentRecordingQ = qNum;
          recorder.ondataavailable = function (e) {
            if (e.data.size) chunks.push(e.data);
          };
          recorder.onstop = function () {
            const blob = new Blob(chunks, { type: 'audio/webm' });
            recordedBlobs['q' + qNum] = blob;
            revokeAudioPreview(qNum);
            const objectUrl = URL.createObjectURL(blob);
            previewUrls['q' + qNum] = objectUrl;
            setPlayerUI(qNum, objectUrl);
          };
          recorder.start();
        } catch (err) {
          console.error('[Recording]', err);
          showError('Microphone permission needed to record. Please allow mic access.');
          setRecordButtonIdle(qNum);
          applyRecordingLock(null, false);
          currentRecordingQ = null;
          currentRecorder = null;
          if (currentStream) {
            currentStream.getTracks().forEach(function (t) {
              t.stop();
            });
            currentStream = null;
          }
        }
      });
    })(q);
  }
}

function boot() {
  initSupabase();
  const form = document.getElementById('research-survey');
  if (form) {
    form.addEventListener('submit', submitSurvey);
  }
  bindPrimaryModalityUI();
  bindResponseModeRadios();
  bindRecordButtons();
  initResponseModes();
}

window.submitSurvey = submitSurvey;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
