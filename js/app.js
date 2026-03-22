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
const BACKEND_ONLY_TRANSCRIPTION_COLUMNS = [
  'screening_q3_reason',
  'screening_q4_reason',
  'q3_reason',
  'q4_reason',
  'trans_q1',
  'trans_q2',
  'trans_q3',
  'trans_q4',
  'trans_q5',
];

/** Used only in `submitSurvey` (final main-survey save). Screening "Proceed" does not call this. */
function stripBackendTranscriptionColumns(payload) {
  var out = Object.assign({}, payload);
  for (var i = 0; i < BACKEND_ONLY_TRANSCRIPTION_COLUMNS.length; i++) {
    delete out[BACKEND_ONLY_TRANSCRIPTION_COLUMNS[i]];
  }
  return out;
}
let currentRecordingQ = null;
let currentStream = null;
let currentRecorder = null;

/** Screening Q3/Q4 detail: written or voice (same bucket as main survey). */
const screeningRecordedBlobs = {};
const screeningPreviewUrls = {};
let screeningCurrentRecorder = null;
let screeningCurrentStream = null;
let screeningCurrentWhich = null;

/** Eligibility Q3/Q4 voice: in-memory mirror of DB `screening_q3_reason` / `screening_q4_reason` (also written as `q3_reason`/`q4_reason` on submit if present). */
let q3_reason = '';
let q4_reason = '';
/** Public Storage URLs after upload (reused on final submit). */
let screeningQ3UploadedUrl = '';
let screeningQ4UploadedUrl = '';

/**
 * Draft `research_responses` row created on first screening voice clip.
 * Final survey submit updates this row instead of inserting again.
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

/** Uploads to Storage only; UI unlocks as soon as `uploadParticipantAudio` resolves. */
function runMainSurveyUploadAfterStop(qNum, blob) {
  if (!supabaseClient) {
    showError('Survey is not connected. Check Supabase settings in js/app.js.');
    return;
  }
  setMainSurveyUploadStatus(qNum, 'uploading');
  uploadMainSurveyQuestionAudio(qNum, blob)
    .then(function (url) {
      mainSurveyUploadedAudioUrls[qNum] = url;
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
 * Use for debugging and for enabling the Proceed button.
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
  if (getScreeningValue('screen_current_min') === 'no') hardReasons.push('screening_current_min:no (hard ineligible)');

  const q3Needed = getScreeningValue('screen_noninjury_break') === 'yes';
  const q4Needed = getScreeningValue('screen_pause_count') === 'yes';
  const q3Ok = !q3Needed || screeningDetailComplete(3);
  const q4Ok = !q4Needed || screeningDetailComplete(4);

  const followUpReasons = [];
  if (q3Needed && !q3Ok) {
    followUpReasons.push(
      'screening Q3 follow-up incomplete (need screening_q3_reason text, or screening_q3_audio_url after upload)'
    );
  }
  if (q4Needed && !q4Ok) {
    followUpReasons.push(
      'screening Q4 follow-up incomplete (need screening_q4_reason text, or screening_q4_audio_url after upload)'
    );
  }

  const canProceed =
    unansweredDbKeys.length === 0 && hardReasons.length === 0 && q3Ok && q4Ok;

  return {
    snapshot,
    unansweredDbKeys,
    hardIneligible: hardReasons.length > 0,
    hardReasons,
    screening_noninjury_break_yes_needs_q3: q3Needed,
    screening_pause_count_yes_needs_q4: q4Needed,
    q3FollowUpComplete: q3Ok,
    q4FollowUpComplete: q4Ok,
    followUpReasons,
    canProceed,
  };
}

/** Same as `getEligibilityCheckResult().canProceed` — all radios answered, hard gates pass, follow-ups done. */
function isEligible() {
  return getEligibilityCheckResult().canProceed;
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

/** True when user may click "Proceed to survey" (all radios, hard gates pass, soft follow-ups complete if needed). */
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
  if (which === 3) {
    q3_reason = '';
    screeningQ3UploadedUrl = '';
    setScreeningUploadStatus(3, 'clear');
  }
  if (which === 4) {
    q4_reason = '';
    screeningQ4UploadedUrl = '';
    setScreeningUploadStatus(4, 'clear');
  }
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

function eligibilityRecordButtonId(which) {
  return which === 3 ? 'record-q3' : 'record-q4';
}

/** @param {'uploading'|'saved'|'clear'} kind */
function setScreeningUploadStatus(which, kind) {
  var el = document.getElementById('screening_q' + which + '_upload_status');
  if (!el) return;
  el.className = 'screening-upload-status';
  if (kind === 'uploading') {
    el.classList.add('screening-upload-status--uploading');
    el.textContent = 'Uploading…';
    el.hidden = false;
  } else if (kind === 'saved') {
    el.classList.add('screening-upload-status--saved');
    el.textContent = 'Saved';
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}

function setScreeningRecordButtonIdle(which) {
  const btn = document.getElementById(eligibilityRecordButtonId(which));
  if (!btn) return;
  btn.classList.remove('recording');
  btn.disabled = false;
  btn.textContent = 'Record answer';
}

function setScreeningRecordButtonActive(which) {
  const btn = document.getElementById(eligibilityRecordButtonId(which));
  if (!btn) return;
  btn.disabled = false;
  btn.classList.add('recording');
  btn.textContent = 'Recording... Tap to Stop';
  if (which === 3) {
    screeningQ3UploadedUrl = '';
    q3_reason = '';
  } else {
    screeningQ4UploadedUrl = '';
    q4_reason = '';
  }
  setScreeningUploadStatus(which, 'clear');
}

function stopScreeningRecording(opts) {
  opts = opts || {};
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
    if (!opts.skipButtonIdle) {
      setScreeningRecordButtonIdle(screeningCurrentWhich);
    }
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
    if (which === 3) {
      q3_reason = '';
      screeningQ3UploadedUrl = '';
      setScreeningUploadStatus(3, 'clear');
    }
    if (which === 4) {
      q4_reason = '';
      screeningQ4UploadedUrl = '';
      setScreeningUploadStatus(4, 'clear');
    }
    if (screeningCurrentWhich === which) stopScreeningRecording();
  } else {
    const ta = document.getElementById('screening_q' + which + '_reason');
    if (ta) ta.value = '';
  }
}

/**
 * Follow-up complete when: main question is No (handled by caller), or Yes with text in textarea,
 * or Yes with voice: **Storage upload finished** (public URL in memory). Does not wait on DB or transcription.
 */
function screeningDetailComplete(which) {
  if (getScreeningDetailMode(which) === 'text') {
    return !!getScreeningReasonText('screening_q' + which + '_reason');
  }
  if (which === 3) {
    return !!(screeningQ3UploadedUrl && String(screeningQ3UploadedUrl).trim());
  }
  if (which === 4) {
    return !!(screeningQ4UploadedUrl && String(screeningQ4UploadedUrl).trim());
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

/**
 * Eligibility → `research_responses` insert keys (must match Supabase column names).
 *
 * HTML radio `name`          → DB column
 * screen_age                 → screening_age (boolean)
 * screen_ten_years           → screening_ten_years (boolean)
 * screen_noninjury_break     → screening_noninjury_break (boolean)
 * screen_pause_count         → screening_pause_count
 * screen_current_min         → screening_current_min (boolean)
 * (when Q3 follow-up shown)  → screening_q3_detail_mode  ('text'|'audio'|'' )
 * (when Q4 follow-up shown)  → screening_q4_detail_mode  ('text'|'audio'|'' )
 *
 * buildScreeningRowExtras() also sets screening audio URLs and (for drafts / screenout) reason text.
 * Final submitSurvey strips transcription-only columns so the Edge Function is not overwritten.
 */
function getScreeningAnswersSnapshot() {
  const q3FollowUp = getScreeningValue('screen_noninjury_break') === 'yes';
  const q4FollowUp = getScreeningValue('screen_pause_count') === 'yes';
  return {
    screening_age: screeningYesNoBoolean('screen_age'),
    screening_ten_years: screeningYesNoBoolean('screen_ten_years'),
    screening_noninjury_break: screeningYesNoBoolean('screen_noninjury_break'),
    screening_pause_count: getScreeningValue('screen_pause_count') || '',
    screening_current_min: screeningYesNoBoolean('screen_current_min'),
    screening_q3_detail_mode: q3FollowUp ? getScreeningDetailMode(3) : '',
    screening_q4_detail_mode: q4FollowUp ? getScreeningDetailMode(4) : '',
  };
}

/** @see getScreeningAnswersSnapshot — same keys merged with reasons + audio URLs. Used by persistScreeningScreenout + submitSurvey. */
async function buildScreeningRowExtras() {
  const out = Object.assign(getScreeningAnswersSnapshot(), {
    screening_q3_reason: '',
    screening_q4_reason: '',
    screening_q3_audio_url: '',
    screening_q4_audio_url: '',
    q3_reason: '',
    q4_reason: '',
  });
  if (getScreeningValue('screen_noninjury_break') === 'yes') {
    if (getScreeningDetailMode(3) === 'text') {
      out.screening_q3_reason = getScreeningReasonText('screening_q3_reason');
      out.q3_reason = out.screening_q3_reason;
    } else if (screeningRecordedBlobs.sq3) {
      const q3Url = screeningQ3UploadedUrl || (await uploadEligibilityScreeningAudio(3, screeningRecordedBlobs.sq3));
      out.screening_q3_audio_url = q3Url;
      screeningQ3UploadedUrl = q3Url;
      out.q3_reason = q3_reason.trim();
      out.screening_q3_reason = q3_reason.trim();
    }
  }
  if (getScreeningValue('screen_pause_count') === 'yes') {
    if (getScreeningDetailMode(4) === 'text') {
      const t4 = getScreeningReasonText('screening_q4_reason');
      out.screening_q4_reason = t4;
      out.q4_reason = t4;
    } else if (screeningRecordedBlobs.sq4) {
      const q4Url = screeningQ4UploadedUrl || (await uploadEligibilityScreeningAudio(4, screeningRecordedBlobs.sq4));
      out.screening_q4_audio_url = q4Url;
      screeningQ4UploadedUrl = q4Url;
      out.q4_reason = q4_reason.trim();
      out.screening_q4_reason = q4_reason.trim();
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
 * Dedicated listeners on #record-q3 and #record-q4 (eligibility only — not main survey Q3/Q4).
 */
function bindScreeningRecordButtons() {
  [3, 4].forEach(function (which) {
    const el = document.getElementById(eligibilityRecordButtonId(which));
    if (!el) return;
    el.addEventListener('click', function (e) {
      e.preventDefault();
      handleScreeningRecordClick(which);
    });
  });
}

function handleScreeningRecordClick(which) {
  if (getScreeningDetailMode(which) !== 'audio') return;
  if (screeningCurrentRecorder && screeningCurrentWhich === which) {
    screeningCurrentRecorder.stop();
    stopScreeningRecording({ skipButtonIdle: which === 3 || which === 4 });
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
        runScreeningVoiceUploadPipeline(which, blob).catch(function (err) {
          console.warn('[Screening Q' + which + ' upload]', err);
          if (which === 3) {
            screeningQ3UploadedUrl = '';
          } else {
            screeningQ4UploadedUrl = '';
          }
          setScreeningUploadStatus(which, 'clear');
          setScreeningRecordButtonIdle(which);
          updateScreeningProceedButton();
          showError('Could not upload this recording. Please type your answer or try again.');
          onScreeningChange().catch(function (e) {
            console.warn('[Screening]', e);
          });
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

/**
 * Universal audio upload: `survey/{participantId}_{questionSlug}_{Date.now()}.{ext}`
 * Timestamp keeps keys unique per take; `upsert: true` allows overwrite if the same key is reused.
 * questionSlug examples: `main_q1`…`main_q5`, `screening_q3`, `screening_q4`.
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

/** Storage upload only — same as `uploadParticipantAudio` with a screening slug. */
function uploadEligibilityScreeningAudio(which3Or4, blob) {
  return uploadParticipantAudio('screening_q' + which3Or4, blob);
}

/**
 * Persist screening audio URL to `research_responses` (draft insert or update). Fire-and-forget from the upload pipeline; does not gate the UI.
 */
async function persistScreeningDraftAudioUrl(which, publicUrl) {
  if (!supabaseClient) throw new Error('Supabase not initialized');
  const urlField = which === 3 ? 'screening_q3_audio_url' : 'screening_q4_audio_url';
  let rowId = null;
  try {
    rowId = sessionStorage.getItem(SCREENING_ROW_ID_KEY);
  } catch (e) {}

  if (!rowId) {
    const base = Object.assign({}, EMPTY_MAIN_Q_AUDIO_URLS, getScreeningAnswersSnapshot(), {
      screening_q3_audio_url: '',
      screening_q4_audio_url: '',
      screening_q3_reason: '',
      screening_q4_reason: '',
      q3_reason: '',
      q4_reason: '',
      submitted_at: null,
    });
    base[urlField] = publicUrl;
    const { data, error } = await supabaseClient.from('research_responses').insert([base]).select('id').single();
    if (error) throw error;
    try {
      sessionStorage.setItem(SCREENING_ROW_ID_KEY, data.id);
    } catch (e) {}
  } else {
    const { error } = await supabaseClient.from('research_responses').update({ [urlField]: publicUrl }).eq('id', rowId);
    if (error) throw error;
  }
}

/**
 * Awaits only Supabase Storage upload → then Saved + Proceed. DB row update runs after, without blocking.
 */
async function runScreeningVoiceUploadPipeline(which, blob) {
  if (!supabaseClient) throw new Error('Supabase not initialized');

  setScreeningUploadStatus(which, 'uploading');
  var recordBtn = document.getElementById(eligibilityRecordButtonId(which));
  if (recordBtn) {
    recordBtn.disabled = true;
    recordBtn.classList.remove('recording');
    recordBtn.textContent = 'Uploading…';
  }

  const publicUrl = await uploadEligibilityScreeningAudio(which, blob);
  if (which === 3) {
    screeningQ3UploadedUrl = publicUrl;
  } else {
    screeningQ4UploadedUrl = publicUrl;
  }

  setScreeningUploadStatus(which, 'saved');
  setScreeningRecordButtonIdle(which);
  updateScreeningProceedButton();

  /** Draft row is optional for Proceed — Storage URL already proves the clip; do not clear URL on DB errors. */
  persistScreeningDraftAudioUrl(which, publicUrl).catch(function (err) {
    console.warn('[Screening] Could not save audio URL to database (you can still proceed):', err);
    showError(
      'Your recording is saved to storage, but the survey could not link it to your profile yet. You may continue; your answers will still be submitted.'
    );
  });
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

  let needsUpload = false;
  for (let u = 1; u <= 5; u++) {
    if (getResponseMode(u) === 'audio' && recordedBlobs['q' + u] && !mainSurveyUploadedAudioUrls[u]) {
      needsUpload = true;
      break;
    }
  }

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

  if (needsUpload) {
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
    q1_audio_url: qAudioUrls[1] || '',
    q2_audio_url: qAudioUrls[2] || '',
    q3_audio_url: qAudioUrls[3] || '',
    q4_audio_url: qAudioUrls[4] || '',
    q5_audio_url: qAudioUrls[5] || '',
    ...screeningExtras,
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
