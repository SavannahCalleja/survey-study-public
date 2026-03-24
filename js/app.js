/**
 * Survey app — Supabase client, recording UI, and submission.
 */
const SUPABASE_URL = 'https://dtlafcfgggortlnfdwbq.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR0bGFmY2ZnZ2dvcnRsbmZkd2JxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NTQwMTMsImV4cCI6MjA4OTUzMDAxM30.IamD-kXYosXMCM17Udr6br1Ac-E1biFW4RXnAmAwDC4';

let supabaseClient;

/** Pending voice answers; main survey uploads immediately on stop (URLs cached here for submit). */
const recordedBlobs = {};
const previewUrls = {};
/** Pre-uploaded Storage public URLs for main survey Q1–Q5 (fire-and-forget after each recording). */
const mainSurveyUploadedAudioUrls = { 1: '', 2: '', 3: '', 4: '', 5: '' };

/**
 * `research_responses` columns filled only by the transcribe Edge Function.
 * submitSurvey must not send these (would overwrite server transcriptions with empty strings).
 */
const SCREENING_TRANSCRIPTION_ONLY_COLUMNS = [
  'screening_q3_reason',
  'screening_q4_reason',
  'q3_reason',
  'q4_reason',
];

/** Main survey: trans_q1…trans_q5 — never send from the browser on final submit. */
const MAIN_SURVEY_TRANSCRIPTION_COLUMNS = ['trans_q1', 'trans_q2', 'trans_q3', 'trans_q4', 'trans_q5'];

const BACKEND_ONLY_TRANSCRIPTION_COLUMNS = SCREENING_TRANSCRIPTION_ONLY_COLUMNS.concat(
  MAIN_SURVEY_TRANSCRIPTION_COLUMNS
);

/** Used only in `submitSurvey` (final main-survey save). Screening "Proceed" does not call this. */
function stripBackendTranscriptionColumns(payload) {
  var out = Object.assign({}, payload);
  var k;
  for (k = 0; k < BACKEND_ONLY_TRANSCRIPTION_COLUMNS.length; k++) {
    delete out[BACKEND_ONLY_TRANSCRIPTION_COLUMNS[k]];
  }
  for (k = 1; k <= 5; k++) {
    delete out['trans_q' + k];
  }
  return out;
}
let currentRecordingQ = null;
let currentStream = null;
let currentRecorder = null;

/**
 * Optional draft row id (e.g. set before final submit). Final survey submit updates this row when present.
 */
const SCREENING_ROW_ID_KEY = 'research_survey_screening_row_id';

/**
 * Audio pipeline (single source of truth — browser never waits on server text jobs):
 * 1) Browser uploads to Storage via `uploadParticipantAudio` → object key `survey/{participantId}_{questionSlug}_{timestamp}.ext`.
 * 2) Client writes the matching `*_url` column on `research_responses` (INSERT/UPDATE), without blocking the UI afterward.
 * 3) Optional: DB/Storage webhooks can run your Edge Function to fill text columns from those URLs.
 */
const AUDIO_STORAGE_BUCKET = 'voice-memos';
const AUDIO_STORAGE_SURVEY_PREFIX = 'survey';
const PARTICIPANT_ID_STORAGE_KEY = 'research_survey_participant_id';

const EMPTY_MAIN_Q_AUDIO_URLS = {
  q1_audio_url: '',
  q2_audio_url: '',
  q3_audio_url: '',
  q4_audio_url: '',
  q5_audio_url: '',
};

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
  getOrCreateParticipantId();
}

/** One stable id per tab/session for Storage paths (not Supabase Auth). */
function getOrCreateParticipantId() {
  try {
    var existing = sessionStorage.getItem(PARTICIPANT_ID_STORAGE_KEY);
    if (existing) return existing;
    var id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now()) + '_' + Math.random().toString(36).slice(2, 12);
    sessionStorage.setItem(PARTICIPANT_ID_STORAGE_KEY, id);
    return id;
  } catch (e) {
    return String(Date.now()) + '_' + Math.random().toString(36).slice(2, 12);
  }
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
  mainSurveyUploadedAudioUrls[q] = '';
  setMainSurveyUploadStatus(q, 'clear');
  const audio = document.querySelector('.audio-player[data-q="' + q + '"]');
  if (audio) {
    audio.pause();
    audio.src = '';
    audio.style.display = 'none';
  }
  setRecordButtonIdle(q);
}

/** @param {'uploading'|'saved'|'clear'} kind */
function setMainSurveyUploadStatus(q, kind) {
  var el = document.getElementById('main_survey_q' + q + '_audio_status');
  if (!el) return;
  el.className = 'main-survey-audio-status';
  if (kind === 'uploading') {
    el.classList.add('main-survey-audio-status--uploading');
    el.textContent = 'Uploading…';
    el.hidden = false;
  } else if (kind === 'saved') {
    el.classList.add('main-survey-audio-status--saved');
    el.textContent = 'Saved';
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}

/** Uploads to Storage only; stores public URL on `mainSurveyUploadedAudioUrls[qNum]` for submitSurvey. */
function runMainSurveyUploadAfterStop(qNum, blob) {
  if (!supabaseClient) {
    showError('Survey is not connected. Check Supabase settings in js/app.js.');
    return;
  }
  setMainSurveyUploadStatus(qNum, 'uploading');
  uploadMainSurveyQuestionAudio(qNum, blob)
    .then(function (url) {
      mainSurveyUploadedAudioUrls[qNum] = String(url || '').trim();
      setMainSurveyUploadStatus(qNum, 'saved');
    })
    .catch(function (err) {
      console.error('[Main survey] audio upload:', err);
      mainSurveyUploadedAudioUrls[qNum] = '';
      setMainSurveyUploadStatus(qNum, 'clear');
      showError('Could not upload your recording. Please try recording again.');
    });
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
  mainSurveyUploadedAudioUrls[q] = '';
  setMainSurveyUploadStatus(q, 'clear');
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

/** HTML `name` on radios → `research_responses` / snapshot keys (for eligibility logging). */
const SCREENING_HTML_TO_DB = {
  screen_age: 'screening_age',
  screen_ten_years: 'screening_ten_years',
  screen_noninjury_break: 'screening_noninjury_break',
  screen_pause_count: 'screening_pause_count',
  screen_current_min: 'screening_current_min',
};

function getScreeningValue(name) {
  const el = document.querySelector('input[name="' + name + '"]:checked');
  return el ? el.value : null;
}

/** DB boolean columns: 'yes' → true, 'no' → false, unanswered → null. */
function screeningYesNoBoolean(htmlRadioName) {
  const v = getScreeningValue(htmlRadioName);
  if (v === 'yes') return true;
  if (v === 'no') return false;
  return null;
}

/**
 * Structured eligibility state aligned with `getScreeningAnswersSnapshot()` keys (screening_age, …).
 * Proceed requires: Q1=Yes, Q2=Yes, Q3=No, Q4=No, Q5=Yes (Q3/Q4 are exclusion criteria — Yes disqualifies).
 */
function getEligibilityCheckResult() {
  const snapshot = getScreeningAnswersSnapshot();
  const unansweredDbKeys = [];
  for (let i = 0; i < SCREENING_NAMES.length; i++) {
    const htmlName = SCREENING_NAMES[i];
    if (getScreeningValue(htmlName) === null) {
      unansweredDbKeys.push(SCREENING_HTML_TO_DB[htmlName] || htmlName);
    }
  }

  const hardReasons = [];
  if (getScreeningValue('screen_age') === 'no') hardReasons.push('screening_age:no (hard ineligible)');
  if (getScreeningValue('screen_ten_years') === 'no') hardReasons.push('screening_ten_years:no (hard ineligible)');
  if (getScreeningValue('screen_noninjury_break') === 'yes') {
    hardReasons.push('screening_noninjury_break:yes (exclusion — Q3)');
  }
  if (getScreeningValue('screen_pause_count') === 'yes') {
    hardReasons.push('screening_pause_count:yes (exclusion — Q4)');
  }
  if (getScreeningValue('screen_current_min') === 'no') hardReasons.push('screening_current_min:no (hard ineligible)');

  const canProceed = unansweredDbKeys.length === 0 && hardReasons.length === 0;

  return {
    snapshot,
    unansweredDbKeys,
    hardIneligible: hardReasons.length > 0,
    hardReasons,
    canProceed,
  };
}

/** Same as `getEligibilityCheckResult().canProceed` — all radios answered; inclusion + exclusion rules satisfied. */
function isEligible() {
  return getEligibilityCheckResult().canProceed;
}

/**
 * Inclusion: Q1, Q2, Q5 must be Yes. Exclusion: Q3 and Q4 must be No (Yes on those disqualifies).
 */
function screeningHardIneligible() {
  if (getScreeningValue('screen_age') === 'no') return true;
  if (getScreeningValue('screen_ten_years') === 'no') return true;
  if (getScreeningValue('screen_noninjury_break') === 'yes') return true;
  if (getScreeningValue('screen_pause_count') === 'yes') return true;
  if (getScreeningValue('screen_current_min') === 'no') return true;
  return false;
}

/** True when user may click "Proceed to survey" (Q1=Yes, Q2=Yes, Q3=No, Q4=No, Q5=Yes, all answered). */
function canProceedFromScreening() {
  return getEligibilityCheckResult().canProceed;
}

function screeningPasses() {
  return canProceedFromScreening();
}

function updateScreeningProceedButton() {
  const btn = document.getElementById('screening-proceed-btn');
  if (!btn) return;
  const eligibilityResult = getEligibilityCheckResult();
  console.log('Eligibility Check:', eligibilityResult);
  const ok = eligibilityResult.canProceed;
  if (ok) {
    btn.removeAttribute('disabled');
    btn.setAttribute('aria-disabled', 'false');
  } else {
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
  }
}

async function onScreeningChange() {
  if (screeningHardIneligible()) {
    await showScreeningIneligible();
    return;
  }
  updateScreeningProceedButton();
}

/**
 * Eligibility → `research_responses` insert keys (must match Supabase column names).
 *
 * HTML radio `name`      → DB column / shape
 * screen_age             → screening_age (boolean)
 * screen_ten_years       → screening_ten_years (boolean)
 * screen_noninjury_break → screening_noninjury_break (boolean)
 * screen_pause_count     → screening_pause_count (string yes|no in DB column if text)
 * screen_current_min     → screening_current_min (boolean)
 *
 * screening_q*_detail_mode and screening free-text/audio URL columns remain on the schema but are left empty from this UI.
 */
function getScreeningAnswersSnapshot() {
  return {
    screening_age: screeningYesNoBoolean('screen_age'),
    screening_ten_years: screeningYesNoBoolean('screen_ten_years'),
    screening_noninjury_break: screeningYesNoBoolean('screen_noninjury_break'),
    screening_pause_count: getScreeningValue('screen_pause_count') || '',
    screening_current_min: screeningYesNoBoolean('screen_current_min'),
    screening_q3_detail_mode: '',
    screening_q4_detail_mode: '',
  };
}

/** @see getScreeningAnswersSnapshot — merged with empty reason/audio fields. Used by persistScreeningScreenout + submitSurvey. */
async function buildScreeningRowExtras() {
  return Object.assign(getScreeningAnswersSnapshot(), {
    screening_q3_reason: '',
    screening_q4_reason: '',
    screening_q3_audio_url: '',
    screening_q4_audio_url: '',
    q3_reason: '',
    q4_reason: '',
  });
}

/** Saves screening responses when participant is excluded (add columns in Supabase if needed). */
async function persistScreeningScreenout() {
  if (!supabaseClient) return;
  try {
    const extras = await buildScreeningRowExtras();
    const row = Object.assign({}, extras, {
      submitted_at: new Date().toISOString(),
    });
    let draftId = null;
    try {
      draftId = sessionStorage.getItem(SCREENING_ROW_ID_KEY);
    } catch (e) {}
    if (draftId) {
      const { error } = await supabaseClient.from('research_responses').update(row).eq('id', draftId);
      if (error) {
        console.warn('[Screening] Could not update screening draft row:', error.message);
      }
    } else {
      const { error } = await supabaseClient.from('research_responses').insert([row]);
      if (error) {
        console.warn('[Screening] Could not save screening data (add columns or relax NOT NULL):', error.message);
      }
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

/** Stops main survey recorder (e.g. before starting another clip). */
function stopRecording() {
  stopAllRecordings();
}

/**
 * Universal audio upload: `survey/{participantId}_{questionSlug}_{Date.now()}.{ext}`
 * Timestamp keeps keys unique per take; `upsert: true` allows overwrite if the same key is reused.
 * Main survey uses slugs `main_q1`…`main_q5`.
 */
async function uploadParticipantAudio(questionSlug, blob) {
  if (!supabaseClient) throw new Error('Supabase not initialized');
  var participantId = getOrCreateParticipantId();
  var ext = fileExtensionForAudioBlob(blob);
  var ts = Date.now();
  var path = AUDIO_STORAGE_SURVEY_PREFIX + '/' + participantId + '_' + questionSlug + '_' + ts + '.' + ext;
  var { error } = await supabaseClient.storage.from(AUDIO_STORAGE_BUCKET).upload(path, blob, {
    upsert: true,
    contentType: storageContentTypeForBlob(blob),
  });
  if (error) {
    var errMsg =
      (error && error.message) ||
      (typeof error === 'string' ? error : '') ||
      (error && error.error) ||
      String(error);
    console.error('[Supabase storage] upload failed — full message:', errMsg, {
      bucket: AUDIO_STORAGE_BUCKET,
      path: path,
      errorName: error && error.name,
      errorCode: error && error.statusCode,
      fullError: error,
    });
    throw error;
  }
  var { data: urlData } = supabaseClient.storage.from(AUDIO_STORAGE_BUCKET).getPublicUrl(path);
  return urlData.publicUrl;
}

function uploadMainSurveyQuestionAudio(questionIndex, blob) {
  return uploadParticipantAudio('main_q' + questionIndex, blob);
}

/**
 * Validates (written XOR voice per question), saves `research_responses`.
 * Voice clips upload to Storage as soon as recording stops (main survey + screening); text columns may be filled server-side later.
 */
async function submitSurvey(ev) {
  // Final save: merge row; optional server jobs may run after save.
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

  /** Per-question public URLs for submit; must always be filled from cache or upload (never skip when cache is warm). */
  const qAudioUrls = { 1: '', 2: '', 3: '', 4: '', 5: '' };

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

  try {
    for (let qUp = 1; qUp <= 5; qUp++) {
      if (getResponseMode(qUp) === 'audio' && recordedBlobs['q' + qUp]) {
        qAudioUrls[qUp] = mainSurveyUploadedAudioUrls[qUp]
          ? mainSurveyUploadedAudioUrls[qUp]
          : await uploadMainSurveyQuestionAudio(qUp, recordedBlobs['q' + qUp]);
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

  const t1 = getResponseMode(1) === 'text' ? getResponseText(1) : '';
  const t2 = getResponseMode(2) === 'text' ? getResponseText(2) : '';
  const t3 = getResponseMode(3) === 'text' ? getResponseText(3) : '';
  const t4 = getResponseMode(4) === 'text' ? getResponseText(4) : '';
  const t5 = getResponseMode(5) === 'text' ? getResponseText(5) : '';

  const row = stripBackendTranscriptionColumns({
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
    ...screeningExtras,
    q1_audio_url: String(qAudioUrls[1] || mainSurveyUploadedAudioUrls[1] || '').trim(),
    q2_audio_url: String(qAudioUrls[2] || mainSurveyUploadedAudioUrls[2] || '').trim(),
    q3_audio_url: String(qAudioUrls[3] || mainSurveyUploadedAudioUrls[3] || '').trim(),
    q4_audio_url: String(qAudioUrls[4] || mainSurveyUploadedAudioUrls[4] || '').trim(),
    q5_audio_url: String(qAudioUrls[5] || mainSurveyUploadedAudioUrls[5] || '').trim(),
    submitted_at: new Date().toISOString(),
  });

  let draftRowId = null;
  try {
    draftRowId = sessionStorage.getItem(SCREENING_ROW_ID_KEY);
  } catch (e) {}

  let error = null;
  if (draftRowId) {
    const res = await supabaseClient.from('research_responses').update(row).eq('id', draftRowId);
    error = res.error;
  } else {
    const res = await supabaseClient.from('research_responses').insert([row]);
    error = res.error;
  }

  if (error) {
    console.error('[Supabase] save research_responses failed:', error, {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
      payloadKeys: Object.keys(row),
      draftRowId: draftRowId,
    });
    showError('Submission error: ' + (error.message || error));
    submitBtn.disabled = false;
    submitBtn.textContent = submitLabelDefault;
    return;
  }

  try {
    sessionStorage.removeItem(SCREENING_ROW_ID_KEY);
  } catch (e) {}

  for (let rq = 1; rq <= 5; rq++) revokeAudioPreview(rq);
  resetAllRecordButtons();
  for (let cq = 1; cq <= 5; cq++) {
    delete recordedBlobs['q' + cq];
    mainSurveyUploadedAudioUrls[cq] = '';
    setMainSurveyUploadStatus(cq, 'clear');
  }
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
            runMainSurveyUploadAfterStop(qNum, blob);
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
  bindScreeningProceedButton();
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
