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

/** Screening Q3/Q4 detail: written or voice (same bucket as main survey). */
const screeningRecordedBlobs = {};
const screeningPreviewUrls = {};
let screeningCurrentRecorder = null;
let screeningCurrentStream = null;
let screeningCurrentWhich = null;

/** Picks a MIME type supported by MediaRecorder (WebM in Chrome/Firefox; MP4/AAC on Safari). */
function getBestSupportedAudioMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  var types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/aac',
  ];
  for (var i = 0; i < types.length; i++) {
    if (MediaRecorder.isTypeSupported(types[i])) return types[i];
  }
  return '';
}

/** Shared by main survey and eligibility screening — do not hard-code audio/webm only. */
function createAudioMediaRecorder(stream) {
  var mime = getBestSupportedAudioMimeType();
  try {
    if (mime) return new MediaRecorder(stream, { mimeType: mime });
  } catch (e) {}
  return new MediaRecorder(stream);
}

function buildAudioBlobFromChunks(chunks, recorder) {
  var t = recorder && recorder.mimeType ? recorder.mimeType : 'audio/webm';
  return new Blob(chunks, { type: t });
}

/** Same entry point main survey and screening use to start a MediaRecorder with a supported codec. */
function startRecording(stream) {
  return createAudioMediaRecorder(stream);
}

function fileExtensionForAudioBlob(blob) {
  var t = blob.type || '';
  if (t.indexOf('mp4') !== -1 || t.indexOf('aac') !== -1) return 'm4a';
  if (t.indexOf('mpeg') !== -1) return 'mp3';
  if (t.indexOf('ogg') !== -1) return 'ogg';
  if (t.indexOf('webm') !== -1) return 'webm';
  return 'webm';
}

function storageContentTypeForBlob(blob) {
  if (blob.type && blob.type.indexOf('audio/') === 0) return blob.type;
  return 'audio/webm';
}

/** Set when eligibility is passed; submitSurvey requires this so the main form cannot be sent without screening. */
const SCREENING_PASS_STORAGE_KEY = 'research_survey_screening_passed';

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

  /** Only main survey buttons (have data-q). Screening uses .screening-record-btn + data-screening-q — must not be disabled here. */
  document.querySelectorAll('.record-btn[data-q]').forEach(function (b) {
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
  btn.classList.remove('recording');
  btn.textContent = 'Record answer';
}

function setRecordButtonActive(q) {
  const btn = document.querySelector('.record-btn[data-q="' + q + '"]');
  if (!btn) return;
  btn.classList.add('recording');
  btn.textContent = 'Recording... Tap to Stop';
}

function resetAllRecordButtons() {
  document.querySelectorAll('.record-btn[data-q]').forEach(function (b) {
    b.classList.remove('recording');
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

/** Hides the survey and shows the full-view thank-you screen (see index.html, css/style.css). */
function showSubmissionSuccessView() {
  try {
    sessionStorage.removeItem(SCREENING_PASS_STORAGE_KEY);
  } catch (e) {}
  const survey = document.getElementById('survey-container');
  const success = document.getElementById('success-screen');
  const phase = document.getElementById('screening-phase');
  const ineligible = document.getElementById('screening-ineligible');
  if (survey) survey.classList.add('is-hidden');
  if (success) success.classList.add('is-visible');
  if (phase) phase.classList.add('is-hidden');
  if (ineligible) ineligible.classList.remove('is-visible');
  window.scrollTo(0, 0);
}

const SCREENING_NAMES = [
  'screen_age',
  'screen_ten_years',
  'screen_noninjury_break',
  'screen_pause_count',
  'screen_current_min',
];

function getScreeningValue(name) {
  const el = document.querySelector('input[name="' + name + '"]:checked');
  return el ? el.value : null;
}

/**
 * Hard gates (Q1 age, Q2 10 years training, Q5 current volume): No → ineligible screen only.
 * Q3/Q4 "Yes" is a soft gate (follow-up only) and does not disqualify.
 */
function screeningHardIneligible() {
  if (getScreeningValue('screen_age') === 'no') return true;
  if (getScreeningValue('screen_ten_years') === 'no') return true;
  if (getScreeningValue('screen_current_min') === 'no') return true;
  return false;
}

function allScreeningAnswered() {
  for (let i = 0; i < SCREENING_NAMES.length; i++) {
    if (getScreeningValue(SCREENING_NAMES[i]) === null) return false;
  }
  return true;
}

/** True when user may click "Proceed to survey" (all radios, hard gates pass, soft follow-ups complete if needed). */
function canProceedFromScreening() {
  if (!allScreeningAnswered()) return false;
  if (screeningHardIneligible()) return false;
  if (!screeningDescribeValid()) return false;
  return true;
}

function screeningPasses() {
  return canProceedFromScreening();
}

function updateScreeningProceedButton() {
  const btn = document.getElementById('screening-proceed-btn');
  if (!btn) return;
  const ok = canProceedFromScreening();
  btn.disabled = !ok;
  btn.setAttribute('aria-disabled', ok ? 'false' : 'true');
}

function getScreeningReasonText(id) {
  const el = document.getElementById(id);
  return el && el.value ? String(el.value).trim() : '';
}

function getScreeningDetailMode(which) {
  const el = document.querySelector('input[name="screening_detail_mode_q' + which + '"]:checked');
  return el ? el.value : 'text';
}

function clearScreeningDetail(which) {
  const ta = document.getElementById('screening_q' + which + '_reason');
  if (ta) ta.value = '';
  delete screeningRecordedBlobs['sq' + which];
  revokeScreeningPreview(which);
  screeningAudioPlayerClear(which);
  setScreeningRecordButtonIdle(which);
}

function revokeScreeningPreview(which) {
  const key = 'sq' + which;
  if (screeningPreviewUrls[key]) {
    URL.revokeObjectURL(screeningPreviewUrls[key]);
    delete screeningPreviewUrls[key];
  }
}

function setScreeningPlayerUI(which, dataUrl) {
  const audio = document.querySelector('.screening-audio-player[data-screening-q="' + which + '"]');
  if (dataUrl && audio) {
    audio.src = dataUrl;
    audio.style.display = 'inline';
  }
}

function screeningAudioPlayerClear(which) {
  const a = document.querySelector('.screening-audio-player[data-screening-q="' + which + '"]');
  if (a) {
    a.pause();
    a.src = '';
    a.style.display = 'none';
  }
}

function setScreeningRecordButtonIdle(which) {
  const btn = document.getElementById('record-screening-q' + which);
  if (!btn) return;
  btn.classList.remove('recording');
  btn.textContent = 'Record answer';
}

function setScreeningRecordButtonActive(which) {
  const btn = document.getElementById('record-screening-q' + which);
  if (!btn) return;
  btn.classList.add('recording');
  btn.textContent = 'Recording... Tap to Stop';
}

function stopScreeningRecording() {
  if (screeningCurrentRecorder) {
    try {
      screeningCurrentRecorder.stop();
    } catch (e) {}
    screeningCurrentRecorder = null;
  }
  if (screeningCurrentStream) {
    screeningCurrentStream.getTracks().forEach(function (t) {
      t.stop();
    });
    screeningCurrentStream = null;
  }
  if (screeningCurrentWhich !== null) {
    setScreeningRecordButtonIdle(screeningCurrentWhich);
    screeningCurrentWhich = null;
  }
}

function syncScreeningDetailPanels(which) {
  const mode = getScreeningDetailMode(which);
  const textPanel = document.getElementById('screening_q' + which + '_text_panel');
  const audioPanel = document.getElementById('screening_q' + which + '_audio_panel');
  if (!textPanel || !audioPanel) return;
  const isText = mode === 'text';
  textPanel.hidden = !isText;
  audioPanel.hidden = isText;
  if (isText) {
    delete screeningRecordedBlobs['sq' + which];
    revokeScreeningPreview(which);
    screeningAudioPlayerClear(which);
    if (screeningCurrentWhich === which) stopScreeningRecording();
  } else {
    const ta = document.getElementById('screening_q' + which + '_reason');
    if (ta) ta.value = '';
  }
}

/** When Q3 or Q4 is Yes, a written response or a recorded clip is required before "Proceed to survey" can be used. */
function screeningDescribeValid() {
  if (getScreeningValue('screen_noninjury_break') === 'yes') {
    if (!screeningDetailComplete(3)) return false;
  }
  if (getScreeningValue('screen_pause_count') === 'yes') {
    if (!screeningDetailComplete(4)) return false;
  }
  return true;
}

function screeningDetailComplete(which) {
  if (getScreeningDetailMode(which) === 'text') {
    return !!getScreeningReasonText('screening_q' + which + '_reason');
  }
  return !!screeningRecordedBlobs['sq' + which];
}

function syncScreeningDetailVisibility() {
  const w3 = document.getElementById('screening_q3_detail_wrap');
  const w4 = document.getElementById('screening_q4_detail_wrap');
  const show3 = getScreeningValue('screen_noninjury_break') === 'yes';
  const show4 = getScreeningValue('screen_pause_count') === 'yes';
  if (w3) w3.classList.toggle('screening-detail-wrap--visible', show3);
  if (w4) w4.classList.toggle('screening-detail-wrap--visible', show4);
  if (!show3) {
    clearScreeningDetail(3);
    document.querySelectorAll('input[name="screening_detail_mode_q3"]').forEach(function (r) {
      r.checked = r.value === 'text';
    });
  }
  if (!show4) {
    clearScreeningDetail(4);
    document.querySelectorAll('input[name="screening_detail_mode_q4"]').forEach(function (r) {
      r.checked = r.value === 'text';
    });
  }
  if (show3) syncScreeningDetailPanels(3);
  if (show4) syncScreeningDetailPanels(4);
}

async function onScreeningChange() {
  syncScreeningDetailVisibility();
  if (screeningHardIneligible()) {
    await showScreeningIneligible();
    return;
  }
  updateScreeningProceedButton();
}

async function buildScreeningRowExtras() {
  const out = {
    screening_q3_reason: '',
    screening_q4_reason: '',
    screening_q3_audio_url: '',
    screening_q4_audio_url: '',
  };
  if (getScreeningValue('screen_noninjury_break') === 'yes') {
    if (getScreeningDetailMode(3) === 'text') {
      out.screening_q3_reason = getScreeningReasonText('screening_q3_reason');
    } else if (screeningRecordedBlobs.sq3) {
      out.screening_q3_audio_url = await uploadScreeningAudioBlob(3, screeningRecordedBlobs.sq3);
    }
  }
  if (getScreeningValue('screen_pause_count') === 'yes') {
    if (getScreeningDetailMode(4) === 'text') {
      out.screening_q4_reason = getScreeningReasonText('screening_q4_reason');
    } else if (screeningRecordedBlobs.sq4) {
      out.screening_q4_audio_url = await uploadScreeningAudioBlob(4, screeningRecordedBlobs.sq4);
    }
  }
  return out;
}

/** Saves screening responses when participant is excluded (add columns in Supabase if needed). */
async function persistScreeningScreenout() {
  if (!supabaseClient) return;
  try {
    const extras = await buildScreeningRowExtras();
    const row = Object.assign({}, extras, {
      submitted_at: new Date().toISOString(),
    });
    const { error } = await supabaseClient.from('research_responses').insert([row]);
    if (error) {
      console.warn('[Screening] Could not save screening data (add columns or relax NOT NULL):', error.message);
    }
  } catch (e) {
    console.warn('[Screening] persistScreeningScreenout:', e);
  }
}

async function showScreeningIneligible() {
  try {
    sessionStorage.removeItem(SCREENING_PASS_STORAGE_KEY);
  } catch (e) {}
  const phase = document.getElementById('screening-phase');
  const survey = document.getElementById('survey-container');
  const bad = document.getElementById('screening-ineligible');
  if (phase) phase.classList.add('is-hidden');
  if (survey) survey.classList.add('is-hidden');
  if (bad) bad.classList.add('is-visible');
  await persistScreeningScreenout();
  window.scrollTo(0, 0);
}

function showSurveyAfterScreening() {
  try {
    sessionStorage.setItem(SCREENING_PASS_STORAGE_KEY, '1');
  } catch (e) {}
  const phase = document.getElementById('screening-phase');
  const survey = document.getElementById('survey-container');
  const bad = document.getElementById('screening-ineligible');
  if (phase) phase.classList.add('is-hidden');
  if (survey) survey.classList.remove('is-hidden');
  if (bad) bad.classList.remove('is-visible');
  window.scrollTo(0, 0);
}

function bindScreeningRadios() {
  SCREENING_NAMES.forEach(function (name) {
    document.querySelectorAll('input[name="' + name + '"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        onScreeningChange().catch(function (e) {
          console.warn('[Screening]', e);
        });
      });
    });
  });
}

function bindScreeningDetailTextareas() {
  ['screening_q3_reason', 'screening_q4_reason'].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', function () {
        onScreeningChange().catch(function (e) {
          console.warn('[Screening]', e);
        });
      });
    }
  });
}

function bindScreeningModeRadios() {
  [3, 4].forEach(function (which) {
    document.querySelectorAll('input[name="screening_detail_mode_q' + which + '"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        if (!radio.checked) return;
        syncScreeningDetailPanels(which);
        onScreeningChange().catch(function (e) {
          console.warn('[Screening]', e);
        });
      });
    });
  });
}

/**
 * Delegated clicks on #screening-phase so listeners work even when the audio panel is hidden at load.
 * Uses the same startRecording / stopRecording pipeline as the main survey.
 */
function bindScreeningRecordButtons() {
  const phase = document.getElementById('screening-phase');
  if (!phase) return;
  phase.addEventListener('click', function (e) {
    const btn = e.target.closest('#record-screening-q3, #record-screening-q4');
    if (!btn) return;
    if (btn.disabled) return;
    const which = btn.id === 'record-screening-q3' ? 3 : btn.id === 'record-screening-q4' ? 4 : null;
    if (which === null) return;
    e.preventDefault();
    handleScreeningRecordClick(which);
  });
}

function handleScreeningRecordClick(which) {
  if (getScreeningDetailMode(which) !== 'audio') return;
  if (screeningCurrentRecorder && screeningCurrentWhich === which) {
    screeningCurrentRecorder.stop();
    stopScreeningRecording();
    return;
  }
  stopRecording();
  setScreeningRecordButtonActive(which);
  navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then(function (stream) {
      screeningCurrentStream = stream;
      const chunks = [];
      const recorder = startRecording(stream);
      screeningCurrentRecorder = recorder;
      screeningCurrentWhich = which;
      recorder.ondataavailable = function (e) {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.onstop = function () {
        const blob = buildAudioBlobFromChunks(chunks, recorder);
        screeningRecordedBlobs['sq' + which] = blob;
        revokeScreeningPreview(which);
        const objectUrl = URL.createObjectURL(blob);
        screeningPreviewUrls['sq' + which] = objectUrl;
        setScreeningPlayerUI(which, objectUrl);
        onScreeningChange().catch(function (err) {
          console.warn('[Screening]', err);
        });
      };
      recorder.start();
    })
    .catch(function (err) {
      console.error('[Screening recording]', err);
      showError('Microphone permission needed to record. Please allow mic access.');
      setScreeningRecordButtonIdle(which);
      screeningCurrentRecorder = null;
      screeningCurrentWhich = null;
      if (screeningCurrentStream) {
        screeningCurrentStream.getTracks().forEach(function (t) {
          t.stop();
        });
        screeningCurrentStream = null;
      }
    });
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
  stopScreeningRecording();
}

/** Stops main-survey and screening recorders; same entry point both UIs should use before starting a new clip. */
function stopRecording() {
  stopAllRecordings();
}

async function uploadAudioBlob(qnumber, blob) {
  const ts = Date.now();
  const nonce = Math.random().toString(36).slice(2, 10);
  const ext = fileExtensionForAudioBlob(blob);
  const filename = 'q' + qnumber + '_' + ts + '_' + nonce + '.' + ext;
  const { error } = await supabaseClient.storage.from('voice-memos').upload(filename, blob, {
    upsert: false,
    contentType: storageContentTypeForBlob(blob),
  });
  if (error) {
    console.error('[Supabase storage] upload failed:', error, { bucket: 'voice-memos', filename });
    throw error;
  }
  const { data: urlData } = supabaseClient.storage.from('voice-memos').getPublicUrl(filename);
  return urlData.publicUrl;
}

async function uploadScreeningAudioBlob(which, blob) {
  const ts = Date.now();
  const nonce = Math.random().toString(36).slice(2, 10);
  const ext = fileExtensionForAudioBlob(blob);
  const filename = 'screening_q' + which + '_' + ts + '_' + nonce + '.' + ext;
  const { error } = await supabaseClient.storage.from('voice-memos').upload(filename, blob, {
    upsert: false,
    contentType: storageContentTypeForBlob(blob),
  });
  if (error) {
    console.error('[Supabase storage] screening upload failed:', error, { bucket: 'voice-memos', filename });
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

  let screeningPassed = false;
  try {
    screeningPassed = sessionStorage.getItem(SCREENING_PASS_STORAGE_KEY) === '1';
  } catch (e) {}
  if (!screeningPassed) {
    showError('You must complete the eligibility screening and qualify before you can submit this survey.');
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

  let screeningExtras;
  try {
    screeningExtras = await buildScreeningRowExtras();
  } catch (err) {
    console.error('[Screening] upload failed:', err);
    const msg = err && err.message ? err.message : String(err);
    showError('Could not upload screening audio: ' + msg);
    submitBtn.disabled = false;
    submitBtn.textContent = submitLabelDefault;
    return;
  }

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
    screening_q3_reason: screeningExtras.screening_q3_reason,
    screening_q4_reason: screeningExtras.screening_q4_reason,
    screening_q3_audio_url: screeningExtras.screening_q3_audio_url,
    screening_q4_audio_url: screeningExtras.screening_q4_audio_url,
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
  showSubmissionSuccessView();
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

function bindScreeningProceedButton() {
  const btn = document.getElementById('screening-proceed-btn');
  if (!btn) return;
  btn.addEventListener('click', function () {
    if (!canProceedFromScreening()) return;
    showSurveyAfterScreening();
  });
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
          stopRecording();
          return;
        }
        stopRecording();
        setRecordButtonActive(qNum);
        applyRecordingLock(qNum, true);
        try {
          currentStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const chunks = [];
          const recorder = startRecording(currentStream);
          currentRecorder = recorder;
          currentRecordingQ = qNum;
          recorder.ondataavailable = function (e) {
            if (e.data.size) chunks.push(e.data);
          };
          recorder.onstop = function () {
            const blob = buildAudioBlobFromChunks(chunks, recorder);
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
  const screeningPhaseEl = document.getElementById('screening-phase');
  if (screeningPhaseEl && !screeningPhaseEl.classList.contains('is-hidden')) {
    try {
      sessionStorage.removeItem(SCREENING_PASS_STORAGE_KEY);
    } catch (e) {}
  }
  bindScreeningRadios();
  bindScreeningDetailTextareas();
  bindScreeningModeRadios();
  bindScreeningRecordButtons();
  bindScreeningProceedButton();
  syncScreeningDetailVisibility();
  updateScreeningProceedButton();
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
