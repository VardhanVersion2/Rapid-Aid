// RapidAid 2.0 - User Application Client Logic
// Mobile-First Emergency Assistance, 4-Question AI Triage, Voice Recording, Live Dispatch & Maps

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A very small scroll-linked accent adds depth without running a continuous animation loop.
let parallaxQueued = false;
window.addEventListener('scroll', () => {
  if (parallaxQueued) return;
  parallaxQueued = true;
  requestAnimationFrame(() => {
    document.documentElement.style.setProperty('--scroll-depth', String(Math.min(window.scrollY * .025, 18)));
    parallaxQueued = false;
  });
}, { passive: true });

// Global State
let token = localStorage.getItem('rapidAidToken') || '';
let currentUser = null;
let pos = null;
let gpsLocked = false;
let map = null;
let mapLayer = null;
let userMarker = null;
let eventSource = null;
let activeAlert = null;
let selectedCategory = 'Road Accident';
let countdownInterval = null;

// MediaRecorder State
let mediaRecorder = null;
let audioChunks = [];
let audioBlob = null;
let recordTimerInterval = null;
let recordSeconds = 0;
let selectedPhotoFile = null;

// 4-Question AI Emergency Triage State
const triageAnswers = {
  q1: 'Conscious & breathing normally',
  q2: 'No visible bleeding',
  q3: 'None of these symptoms',
  q4: 'Single patient, scene secure'
};

// Notification Toast
function showToast(msg, duration = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hide');
  clearTimeout(t.timer);
  t.timer = setTimeout(() => t.classList.add('hide'), duration);
}

// Hide Splash Screen
function hideSplashScreen() {
  const splash = $('splash-screen');
  if (splash) {
    splash.classList.add('fade-out');
    setTimeout(() => {
      try { splash.remove(); } catch {}
    }, 600);
  }
}

// REST API Helper
async function api(path, method = 'GET', body = null, isFormData = false) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let requestBody = body;
  if (body && !isFormData && !(body instanceof FormData) && !(body instanceof Blob)) {
    headers['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }

  const res = await fetch('/api' + path, { method, headers, body: requestBody });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} Request Failed`);
  }
  return data;
}

// Haversine Distance (km)
function calcKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 +
            Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// ---- Authentication ----
let authMode = 'login';
function setAuthTab(mode) {
  authMode = mode;
  const isReg = mode === 'reg';
  $('tab-login').className = isReg ? 'btn-alt btn-sm' : 'btn-primary btn-sm';
  $('tab-reg').className = isReg ? 'btn-primary btn-sm' : 'btn-alt btn-sm';
  $('reg-fields').classList.toggle('hide', !isReg);
  $('auth-submit').textContent = isReg ? 'Register as User' : 'Login';
}

async function handleAuthSubmit() {
  const phone = $('auth-phone').value.trim();
  const password = $('auth-password').value;
  const name = $('reg-name').value.trim();

  if (!phone || !password) return showToast('Please enter phone and password');
  if (authMode === 'reg' && !name) return showToast('Please enter your full name');

  try {
    const payload = { phone, password, role: 'user' };
    if (authMode === 'reg') payload.name = name;

    const res = await api(authMode === 'reg' ? '/register' : '/login', 'POST', payload);
    token = res.token;
    localStorage.setItem('rapidAidToken', token);
    showToast(`Welcome, ${res.user.name}!`);
    initUserSession();
  } catch (err) {
    showToast(err.message);
  }
}

function logout() {
  localStorage.removeItem('rapidAidToken');
  token = '';
  currentUser = null;
  if (eventSource) eventSource.close();
  location.reload();
}

// ---- Session Initialization ----
async function initUserSession() {
  setTimeout(hideSplashScreen, 1200);

  if (!token) {
    $('auth-section').classList.remove('hide');
    $('user-dashboard').classList.add('hide');
    setAuthTab('login');
    return;
  }

  try {
    currentUser = await api('/me');
    if (currentUser.role === 'responder') {
      location.href = '/responder.html';
      return;
    }

    $('auth-section').classList.add('hide');
    $('user-dashboard').classList.remove('hide');
    $('logout-btn').classList.remove('hide');
    $('user-pill').textContent = `${currentUser.name} (${currentUser.phone})`;

    // Initialize Map and GPS
    initLeafletMap();
    requestGpsLocation();

    // Start SSE stream for real-time alerts
    initServerSentEvents();

    // Check active alert
    await refreshActiveAlert();
    selectCategory('Road Accident');
  } catch (err) {
    console.error('Session init error:', err);
    logout();
  }
}

// ---- Map & Geolocation ----
function initLeafletMap() {
  if (map) return;
  map = L.map('map').setView([20.5937, 78.9629], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(map);

  mapLayer = L.layerGroup().addTo(map);

  map.on('click', e => {
    setCoordinates(e.latlng.lat, e.latlng.lng, false);
    showToast('Location pin repositioned from map.');
  });
}

function setCoordinates(lat, lng, isGps = false) {
  pos = { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
  gpsLocked = isGps;

  $('gps-status-badge').textContent = isGps ? 'VERIFIED SATELLITE GPS' : 'MANUAL MAP PIN';
  $('gps-status-badge').className = isGps ? 'badge badge-accepted' : 'badge badge-closed';
  $('gps-coords-text').textContent = `Satellite Coordinates: Latitude ${pos.lat}, Longitude ${pos.lng}`;

  renderMapMarkers();
  loadNearbyFacilities();

  if (activeAlert && ['sent', 'accepted', 'on_the_way', 'arrived'].includes(activeAlert.status)) {
    api(`/alerts/${activeAlert.id}/location`, 'POST', pos).catch(() => {});
  }
}

function requestGpsLocation() {
  if (!navigator.geolocation) {
    showToast('Geolocation API not supported by browser. Tap map to set location.');
    if (!pos) setCoordinates(26.4499, 80.3319, false);
    return;
  }

  navigator.geolocation.getCurrentPosition(
    p => {
      setCoordinates(p.coords.latitude, p.coords.longitude, true);
      map.setView([p.coords.latitude, p.coords.longitude], 14);
    },
    err => {
      console.warn('GPS notice:', err.message);
      showToast('GPS unavailable. Setting default incident coordinates.');
      if (!pos) setCoordinates(26.4499, 80.3319, false);
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
  );

  navigator.geolocation.watchPosition(
    p => {
      setCoordinates(p.coords.latitude, p.coords.longitude, true);
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 5000 }
  );
}

function renderMapMarkers() {
  if (!mapLayer || !pos) return;
  mapLayer.clearLayers();

  // User Marker
  userMarker = L.circleMarker([pos.lat, pos.lng], {
    radius: 10,
    color: '#dc2626',
    fillColor: '#ef4444',
    fillOpacity: 0.9,
    weight: 2
  }).addTo(mapLayer);
  userMarker.bindPopup(`<b>Emergency Incident Location</b><br>${pos.lat}, ${pos.lng}`).openPopup();

  // Assigned Responding Facility Marker
  if (activeAlert && activeAlert.facility && activeAlert.facility.lat && activeAlert.facility.lng) {
    const f = activeAlert.facility;
    L.circleMarker([f.lat, f.lng], {
      radius: 11,
      color: '#16a34a',
      fillColor: '#22c55e',
      fillOpacity: 0.9,
      weight: 3
    }).addTo(mapLayer).bindPopup(`<b>Responding Hospital:</b><br>${esc(f.name)}<br>📞 ${esc(f.phone)}`);
  }
}

// ---- Nearby Facilities ----
async function loadNearbyFacilities() {
  if (!pos) return;
  const listEl = $('nearby-list');

  try {
    const rapidAidResponders = await api(`/facilities/nearby?lat=${pos.lat}&lng=${pos.lng}&radius=50`).catch(() => []);

    if (rapidAidResponders.length === 0) {
      listEl.innerHTML = '<p class="text-muted">Searching for verified emergency response centers within 50 km...</p>';
      return;
    }

    listEl.innerHTML = rapidAidResponders.map(f => `
      <div class="card" style="margin-bottom: 8px; padding: 12px; border-left: 4px solid var(--primary);">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <strong>${esc(f.name)}</strong>
            <span class="badge badge-accepted" style="font-size: 0.72rem; margin-left: 6px;">
              RapidAid Connected
            </span>
            <div class="text-muted" style="font-size: 0.85rem; margin-top: 2px;">
              📍 ${f.address || 'Emergency Response Center'} • <strong>${f.distance.toFixed(1)} km away</strong>
            </div>
          </div>
          ${f.phone ? `<a href="tel:${esc(f.phone)}" class="btn btn-primary btn-sm">📞 Call ${esc(f.phone)}</a>` : ''}
        </div>
      </div>
    `).join('');

    rapidAidResponders.forEach(f => {
      L.circleMarker([f.lat, f.lng], {
        radius: 8,
        color: '#2563eb',
        fillColor: '#3b82f6',
        fillOpacity: 0.85
      }).addTo(mapLayer).bindPopup(`<b>${esc(f.name)}</b><br>${f.distance.toFixed(1)} km away<br>📞 ${esc(f.phone || '')}`);
    });
  } catch (err) {
    console.error('Failed to load facilities:', err);
  }
}

// ---- Category Selection ----
function selectCategory(cat) {
  selectedCategory = cat;
  const catMap = {
    'Road Accident': 'btn-cat-accident',
    'Injury': 'btn-cat-injury',
    'Breathing Difficulty': 'btn-cat-breathing',
    'Medical Emergency': 'btn-cat-cardiac'
  };

  Object.values(catMap).forEach(id => {
    const b = $(id);
    if (b) b.className = 'btn btn-outline';
  });

  const activeId = catMap[cat];
  if (activeId && $(activeId)) {
    $(activeId).className = 'btn btn-primary';
  }
}

// ---- 4-Question AI Emergency Triage Protocol ----
function openTriageQuestionsModal() {
  $('triage-modal').classList.remove('hide');
}

function closeTriageModal() {
  $('triage-modal').classList.add('hide');
}

function selectTriageOption(q, value, btn) {
  triageAnswers[q] = value;
  const parent = btn.parentElement;
  parent.querySelectorAll('.triage-opt-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
}

async function submitTriageAssessment() {
  closeTriageModal();
  showToast('⏳ Analyzing clinical triage answers...');

  // If no active alert exists, create it automatically!
  if (!activeAlert) {
    try {
      if (!pos) setCoordinates(26.4499, 80.3319, false);
      activeAlert = await api('/alerts', 'POST', {
        lat: pos.lat,
        lng: pos.lng,
        type: selectedCategory,
        note: `Triage: ${triageAnswers.q1}, ${triageAnswers.q2}`
      });
      renderActiveAlertUI(activeAlert);
    } catch (err) {
      showToast('SOS trigger error: ' + err.message);
      return;
    }
  }

  try {
    const res = await api(`/alerts/${activeAlert.id}/triage`, 'POST', {
      q1_consciousness: triageAnswers.q1,
      q2_bleeding: triageAnswers.q2,
      q3_cardiac: triageAnswers.q3,
      q4_scene: triageAnswers.q4
    });
    showToast(`✅ Triage Complete: ${res.triageAssessment.triageCode}`);
    activeAlert.triageAssessment = res.triageAssessment;
    renderActiveAlertUI(activeAlert);
  } catch (err) {
    showToast('Triage transmission error: ' + err.message);
  }
}

// ---- Voice Recording (MediaRecorder API) ----
async function toggleVoiceRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopVoiceRecording();
  } else {
    startVoiceRecording();
  }
}

async function startVoiceRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Voice recording is not supported in this browser.');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      $('audio-preview').src = URL.createObjectURL(audioBlob);
      $('audio-preview-container').classList.remove('hide');
      $('rerecord-btn').classList.remove('hide');

      processRecordedVoice(audioBlob);
    };

    mediaRecorder.start(250);
    recordSeconds = 0;
    $('record-btn-text').textContent = 'Stop Recording';
    $('record-btn').className = 'btn btn-alt';
    $('record-icon').textContent = '⏹️';
    $('record-timer').classList.remove('hide');

    recordTimerInterval = setInterval(() => {
      recordSeconds++;
      const mins = String(Math.floor(recordSeconds / 60)).padStart(2, '0');
      const secs = String(recordSeconds % 60).padStart(2, '0');
      $('record-timer').textContent = `${mins}:${secs}`;
      if (recordSeconds >= 45) stopVoiceRecording();
    }, 1000);

    showToast('🎙️ Recording voice... Speak in Hindi or English.');
  } catch (err) {
    showToast('Microphone error: ' + err.message);
  }
}

function stopVoiceRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(track => track.stop());
  }
  clearInterval(recordTimerInterval);
  $('record-btn-text').textContent = 'Record Emergency Voice Note';
  $('record-btn').className = 'btn btn-danger';
  $('record-icon').textContent = '⏺️';
}

function resetVoiceRecording() {
  stopVoiceRecording();
  audioBlob = null;
  audioChunks = [];
  $('audio-preview').src = '';
  $('audio-preview-container').classList.add('hide');
  $('rerecord-btn').classList.add('hide');
  $('record-timer').classList.add('hide');
  $('ai-review-card').classList.add('hide');
  showToast('Voice recording discarded.');
}

async function processRecordedVoice(blob) {
  if (!activeAlert) {
    showToast('Voice recorded. Transmitting alongside SOS.');
    return;
  }

  showToast('⏳ Uploading audio & generating AI medical summary...');
  try {
    const formData = new FormData();
    formData.append('audio', blob, 'voice.webm');
    await api(`/alerts/${activeAlert.id}/audio`, 'POST', formData, true);

    const sttRes = await api(`/alerts/${activeAlert.id}/transcribe`, 'POST');
    $('summary-transcript').value = sttRes.transcript;

    const sumRes = await api(`/alerts/${activeAlert.id}/summarize`, 'POST', { transcript: sttRes.transcript });
    $('summary-symptoms').value = sumRes.summary.reportedInjuryOrSymptoms || '';
    $('summary-responder').value = sumRes.summary.responderSummary || '';

    $('ai-review-card').classList.remove('hide');
    showToast('✨ AI Summary ready! Review and confirm.');
  } catch (err) {
    showToast('Voice Assistant notice: ' + err.message);
  }
}

async function confirmAiSummary() {
  if (!activeAlert) return showToast('No active emergency found.');

  const confirmedSummary = {
    emergencyType: selectedCategory,
    reportedInjuryOrSymptoms: $('summary-symptoms').value.trim(),
    patientStatement: $('summary-transcript').value.slice(0, 200),
    responderSummary: $('summary-responder').value.trim()
  };

  try {
    await api(`/alerts/${activeAlert.id}/summary`, 'POST', {
      confirmedSummary,
      transcript: $('summary-transcript').value.trim()
    });
    showToast('✅ Confirmed summary transmitted to hospital dispatch.');
    $('ai-status-tag').textContent = 'CONFIRMED';
    $('ai-status-tag').className = 'badge badge-arrived';
    refreshActiveAlert();
  } catch (err) {
    showToast(err.message);
  }
}

async function regenerateAiSummary() {
  const transcript = $('summary-transcript').value.trim();
  if (!transcript) return showToast('No transcript available.');
  showToast('🔄 Asking Gemini to re-analyze...');
  try {
    const res = await api(`/alerts/${activeAlert.id}/summarize`, 'POST', { transcript });
    $('summary-symptoms').value = res.summary.reportedInjuryOrSymptoms || '';
    $('summary-responder').value = res.summary.responderSummary || '';
    showToast('Summary refreshed.');
  } catch (err) {
    showToast(err.message);
  }
}

// ---- Photo Upload ----
function handlePhotoSelect(e) {
  const file = e.target.files[0];
  if (!file) return;

  selectedPhotoFile = file;
  const reader = new FileReader();
  reader.onload = ev => {
    $('photo-preview-img').src = ev.target.result;
    $('photo-preview-wrap').classList.remove('hide');
  };
  reader.readAsDataURL(file);

  if (activeAlert) {
    uploadPhotoToAlert(activeAlert.id, file);
  }
}

async function uploadPhotoToAlert(alertId, file) {
  try {
    const fd = new FormData();
    fd.append('photo', file);
    await api(`/alerts/${alertId}/photo`, 'POST', fd, true);
    showToast('📷 Scene photo uploaded.');
  } catch (err) {
    showToast('Photo upload notice: ' + err.message);
  }
}

function clearSelectedPhoto() {
  selectedPhotoFile = null;
  $('accident-photo-input').value = '';
  $('photo-preview-img').src = '';
  $('photo-preview-wrap').classList.add('hide');
}

// ---- SOS Modal & Trigger ----
function openSosModal() {
  if (!pos) setCoordinates(26.4499, 80.3319, false);

  $('sos-selected-type').textContent = `Category: ${selectedCategory}`;
  $('sos-modal').classList.remove('hide');

  let count = 5;
  $('sos-countdown-display').textContent = count;
  clearInterval(countdownInterval);

  countdownInterval = setInterval(() => {
    count--;
    $('sos-countdown-display').textContent = count;
    if (count <= 0) {
      clearInterval(countdownInterval);
      triggerSosNow();
    }
  }, 1000);
}

function closeSosModal() {
  clearInterval(countdownInterval);
  $('sos-modal').classList.add('hide');
}

async function triggerSosNow() {
  closeSosModal();
  showToast('🚨 Transmitting emergency distress alert...');

  try {
    const payload = {
      lat: pos.lat,
      lng: pos.lng,
      type: selectedCategory,
      note: `Rapid SOS Broadcast`
    };

    activeAlert = await api('/alerts', 'POST', payload);
    renderActiveAlertUI(activeAlert);
    showToast(`SOS Broadcast Active! Alerted ${activeAlert.notifiedCount} trauma centers.`);

    if (audioBlob) processRecordedVoice(audioBlob);
    if (selectedPhotoFile) uploadPhotoToAlert(activeAlert.id, selectedPhotoFile);

    // Prompt user to complete the 4 clinical questions
    setTimeout(openTriageQuestionsModal, 800);
  } catch (err) {
    showToast(err.message);
  }
}

// ---- Active Alert Tracking UI ----
async function refreshActiveAlert() {
  try {
    activeAlert = await api('/alerts/active');
    renderActiveAlertUI(activeAlert);
  } catch (err) {
    console.error('Refresh active alert error:', err);
  }
}

function renderActiveAlertUI(a) {
  const box = $('active-alert-box');
  if (!a) {
    box.classList.add('hide');
    renderMapMarkers();
    return;
  }

  box.classList.remove('hide');
  const badge = $('alert-status-badge');
  badge.textContent = (a.status || 'SENT').toUpperCase();
  badge.className = `badge badge-${a.status}`;

  const statusMessages = {
    sent: '🚨 Distress broadcast active. Waiting for closest hospital to accept dispatch…',
    accepted: '✅ Help accepted! Responding medical team preparing dispatch.',
    on_the_way: '🚑 Responder dispatched! Ambulance unit en route to your coordinates.',
    arrived: '📍 Emergency responders have arrived on scene. Stay calm.',
    unanswered: '⚠️ No registered facility has responded. CALL 112 DIRECTLY!',
    closed: 'Emergency case resolved and closed.',
    cancelled: 'Emergency alert cancelled by caller.'
  };

  $('alert-status-desc').textContent = statusMessages[a.status] || a.status;

  // Display Clinical Triage Assessment
  const triageEl = $('alert-triage-display');
  if (triageEl) {
    if (a.triageAssessment) {
      triageEl.classList.remove('hide');
      triageEl.className = `triage-banner triage-banner-${a.triageAssessment.color || 'yellow'}`;
      $('alert-triage-code').textContent = a.triageAssessment.triageCode;
      $('alert-triage-tag').textContent = `PRIORITY ${a.triageAssessment.priority || 1}`;
      $('alert-triage-tag').className = `badge badge-code-${a.triageAssessment.color || 'yellow'}`;
      $('alert-triage-guidance').innerHTML = `
        <strong>Immediate First-Aid:</strong> ${esc(a.triageAssessment.bystanderGuidance)}<br/>
        <span class="text-muted" style="font-size: 0.8rem;">Clinical Risk: ${esc(a.triageAssessment.primaryRisk)}</span>
      `;
    } else {
      triageEl.classList.add('hide');
    }
  }

  // Responding facility details
  const facEl = $('alert-facility-info');
  const callBtn = $('call-facility-btn');
  if (a.facility) {
    facEl.classList.remove('hide');
    facEl.innerHTML = `
      <strong>Responding Unit: ${esc(a.facility.name)}</strong>
      <div>Emergency Hotline: <a href="tel:${esc(a.facility.phone)}" style="font-weight: 700; color: var(--primary);">${esc(a.facility.phone)}</a></div>
      <div class="text-muted" style="font-size: 0.82rem;">${esc(a.facility.address || 'Trauma Center Base')}</div>
    `;
    if (a.facility.phone) {
      callBtn.href = `tel:${a.facility.phone}`;
      callBtn.classList.remove('hide');
      callBtn.textContent = `📞 Call ${esc(a.facility.name)}`;
    }
  } else {
    facEl.classList.add('hide');
    callBtn.classList.add('hide');
  }

  renderMapMarkers();
}

async function cancelActiveAlert() {
  if (!activeAlert) return;
  if (!confirm('Are you sure you want to cancel this emergency alert?')) return;

  try {
    await api(`/alerts/${activeAlert.id}/cancel`, 'POST');
    showToast('Emergency alert cancelled.');
    activeAlert = null;
    renderActiveAlertUI(null);
  } catch (err) {
    showToast(err.message);
  }
}

// ---- Real-time Server-Sent Events (SSE) ----
function initServerSentEvents() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/stream?token=${token}`);

  eventSource.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.t === 'update' || msg.t === 'summary_ready' || msg.t === 'triage_ready') {
        refreshActiveAlert();
      }
    } catch {}
  };

  eventSource.onerror = () => {
    eventSource.close();
    setTimeout(initServerSentEvents, 3000);
  };
}

// Bootstrap
document.addEventListener('DOMContentLoaded', initUserSession);
