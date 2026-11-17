// RapidAid 2.0 - Hospital & Emergency Dispatch CAD Terminal
// Official EMS-CAD Operational Console, Clinical Triage Telemetry, First-Accept Concurrency

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Global CAD State
let token = localStorage.getItem('rapidAidResponderToken') || '';
let responderUser = null;
let facility = null;
let map = null;
let mapLayer = null;
let eventSource = null;
let currentAlerts = [];
let audioCache = new Map();
let photoCache = new Map();

// Toast notification
function showToast(msg, duration = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hide');
  clearTimeout(t.timer);
  t.timer = setTimeout(() => t.classList.add('hide'), duration);
}

// REST API Helper
async function api(path, method = 'GET', body = null) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch('/api' + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

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

// Emergency CAD Alert Chime
function playAlertChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.2);
    gain.gain.setValueAtTime(0.35, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.7);

    osc.start();
    osc.stop(ctx.currentTime + 0.7);
  } catch {}
}

// ---- Clock Telemetry ----
function startCadClock() {
  const el = $('cad-clock');
  const update = () => {
    const now = new Date();
    if (el) el.textContent = `${now.toLocaleTimeString()} IST`;
  };
  update();
  setInterval(update, 1000);
}

// ---- Authentication ----
let authMode = 'login';
function setResponderAuthTab(mode) {
  authMode = mode;
  const isReg = mode === 'reg';
  $('rtab-login').className = isReg ? 'btn-alt btn-sm' : 'btn-primary btn-sm';
  $('rtab-reg').className = isReg ? 'btn-primary btn-sm' : 'btn-alt btn-sm';
  $('resp-reg-fields').classList.toggle('hide', !isReg);
  $('resp-auth-submit').textContent = isReg ? 'Register Hospital / Facility' : 'Authenticate into CAD Terminal';
}

function useCurrentLocationForFacility() {
  if (!navigator.geolocation) return showToast('Geolocation not available.');
  navigator.geolocation.getCurrentPosition(
    p => {
      $('fac-lat').value = p.coords.latitude.toFixed(6);
      $('fac-lng').value = p.coords.longitude.toFixed(6);
      showToast('Facility base coordinates acquired from GPS.');
    },
    () => showToast('Could not acquire GPS. Please enter coordinates manually.'),
    { enableHighAccuracy: true }
  );
}

async function handleResponderAuthSubmit() {
  const phone = $('resp-phone').value.trim();
  const password = $('resp-password').value;

  if (!phone || !password) return showToast('Please enter mobile phone and password');

  try {
    if (authMode === 'login') {
      const res = await api('/login', 'POST', { phone, password });
      token = res.token;
      localStorage.setItem('rapidAidResponderToken', token);
      initResponderSession();
    } else {
      const name = $('resp-name').value.trim();
      const fname = $('fac-name').value.trim();
      const ftype = $('fac-type').value;
      const fphone = $('fac-phone').value.trim() || phone;
      const faddress = $('fac-address').value.trim();
      const flat = parseFloat($('fac-lat').value);
      const flng = parseFloat($('fac-lng').value);

      if (!name) return showToast('Please enter dispatcher name');
      if (!fname || isNaN(flat) || isNaN(flng)) {
        return showToast('Facility name, latitude, and longitude are required');
      }

      const res = await api('/register', 'POST', {
        name,
        phone,
        password,
        role: 'responder',
        facility: {
          name: fname,
          type: ftype,
          phone: fphone,
          address: faddress,
          lat: flat,
          lng: flng
        }
      });

      token = res.token;
      localStorage.setItem('rapidAidResponderToken', token);
      showToast('Facility registered successfully!');
      initResponderSession();
    }
  } catch (err) {
    showToast(err.message);
  }
}

function responderLogout() {
  localStorage.removeItem('rapidAidResponderToken');
  token = '';
  responderUser = null;
  facility = null;
  if (eventSource) eventSource.close();
  location.reload();
}

// ---- Session Bootstrap ----
async function initResponderSession() {
  startCadClock();

  if (!token) {
    $('resp-auth-section').classList.remove('hide');
    $('resp-dashboard').classList.add('hide');
    setResponderAuthTab('login');
    return;
  }

  try {
    responderUser = await api('/me');
    if (responderUser.role !== 'responder') {
      showToast('Access restricted: Account is not authorized as a medical dispatcher.');
      responderLogout();
      return;
    }

    facility = responderUser.facility;
    $('resp-auth-section').classList.add('hide');
    $('resp-dashboard').classList.remove('hide');
    $('resp-logout-btn').classList.remove('hide');
    $('resp-user-pill').textContent = `${responderUser.name} • ${facility.name}`;

    // Populate Facility Telemetry
    $('facility-name-display').textContent = facility.name;
    $('facility-type-tag').textContent = (facility.type || 'TRAUMA CENTER').toUpperCase();
    $('facility-meta-display').textContent = `${facility.address || 'Regional Base'} • Hotline: ${facility.phone}`;
    updateAvailabilityUI(facility.available);

    // Initialize Map and Real-Time SSE
    initResponderMap();
    initResponderSSE();

    // Load Incident Stream
    loadResponderAlerts();
    loadIncidentHistory();
  } catch (err) {
    console.error('CAD bootstrap failed:', err);
    responderLogout();
  }
}

// ---- Facility Availability ----
function updateAvailabilityUI(isAvailable) {
  const btn = $('avail-toggle-btn');
  btn.className = isAvailable ? 'status-toggle btn-success' : 'status-toggle btn-alt';
  $('avail-dot').textContent = isAvailable ? '🟢' : '🔴';
  $('avail-text').textContent = isAvailable ? 'ONLINE (ACCEPTING DISPATCHES)' : 'BUSY (DISPATCH PAUSED)';
}

async function toggleResponderAvailability() {
  try {
    const updated = await api('/facility', 'PATCH', { available: !facility.available });
    facility.available = updated.facility.available;
    updateAvailabilityUI(facility.available);
    showToast(`Dispatch status updated: ${facility.available ? 'ONLINE' : 'BUSY'}.`);
    loadResponderAlerts();
  } catch (err) {
    showToast(err.message);
  }
}

// ---- Radar Map ----
function initResponderMap() {
  if (map || !facility) return;
  map = L.map('resp-map').setView([facility.lat, facility.lng], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(map);

  mapLayer = L.layerGroup().addTo(map);

  L.circleMarker([facility.lat, facility.lng], {
    radius: 11,
    color: '#0284c7',
    fillColor: '#0ea5e9',
    fillOpacity: 0.9,
    weight: 3
  }).addTo(mapLayer).bindPopup(`<b>${esc(facility.name)}</b><br>Hospital Base Location`).openPopup();
}

function updateMapIncidents(alerts) {
  if (!mapLayer || !facility) return;
  mapLayer.clearLayers();

  L.circleMarker([facility.lat, facility.lng], {
    radius: 11,
    color: '#0284c7',
    fillColor: '#0ea5e9',
    fillOpacity: 0.9,
    weight: 3
  }).addTo(mapLayer).bindPopup(`<b>${esc(facility.name)}</b><br>Base Station`);

  alerts.forEach(a => {
    const isMine = a.facilityId === facility.id;
    const markerColor = isMine ? '#16a34a' : '#dc2626';
    L.circleMarker([a.lat, a.lng], {
      radius: 9,
      color: '#fff',
      fillColor: markerColor,
      fillOpacity: 0.9,
      weight: 2
    }).addTo(mapLayer).bindPopup(`
      <b>${esc(a.type)}</b> - Patient: ${esc(a.userName)}<br>
      Status: ${a.status.toUpperCase()}<br>
      Distance: ${calcKm(facility, a).toFixed(1)} km<br>
      <a target="_blank" href="https://www.google.com/maps/dir/?api=1&destination=${a.lat},${a.lng}">Turn-by-turn Directions</a>
    `);
  });
}

// ---- Incidents Feed & Dispatch Actions ----
async function loadResponderAlerts() {
  try {
    currentAlerts = await api('/responder/alerts');
    renderAlertsFeed(currentAlerts);
    updateMapIncidents(currentAlerts);
  } catch (err) {
    console.error('Failed to load incident feed:', err);
  }
}

function renderAlertsFeed(alerts) {
  const container = $('alerts-container');
  if (!alerts || alerts.length === 0) {
    container.innerHTML = `
      <div style="background: #1c2541; border: 1px dashed #334155; border-radius: 8px; text-align: center; padding: 32px 20px; color: #94a3b8;">
        <div style="font-size: 1.8rem; margin-bottom: 8px;">📡</div>
        <p style="font-size: 1.1rem; color: #f8fafc; font-weight: 600;">All Incident Queues Clear</p>
        <p style="font-size: 0.85rem;">CAD telemetry terminal active and monitoring incoming emergency transmissions.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = alerts.map(a => {
    const isAssigned = a.facilityId === facility.id;
    const distanceKm = calcKm(facility, a).toFixed(1);

    // Lifecycle Status Advancers
    const nextSteps = {
      accepted: { next: 'on_the_way', label: '🚑 DISPATCH AMBULANCE UNIT (ON THE WAY)' },
      on_the_way: { next: 'arrived', label: '📍 CONFIRM ARRIVAL ON SCENE' },
      arrived: { next: 'closed', label: '✅ RESOLVE & ARCHIVE INCIDENT' }
    };
    const step = nextSteps[a.status];

    // Priority Styling
    let priorityBadge = '<span class="badge badge-code-yellow">PRIORITY 2 - URGENT</span>';
    let cardClass = 'cad-incident-yellow';

    if (a.triageAssessment) {
      if (a.triageAssessment.priority === 1) {
        priorityBadge = '<span class="badge badge-code-red">PRIORITY 1 - CODE RED (CRITICAL)</span>';
        cardClass = 'cad-incident-red';
      } else if (a.triageAssessment.priority === 3) {
        priorityBadge = '<span class="badge badge-code-green">PRIORITY 3 - CODE GREEN</span>';
        cardClass = 'cad-incident-green';
      }
    }

    // Equipment badges
    const eqTags = a.triageAssessment && a.triageAssessment.ambulanceEquipment
      ? a.triageAssessment.ambulanceEquipment.split(',').map(s => `<span class="cad-equipment-tag">${esc(s.trim())}</span>`).join('')
      : '<span class="cad-equipment-tag">Standard Trauma Kit</span>';

    return `
      <div class="cad-incident-card ${cardClass}">
        <!-- Incident Header -->
        <div class="cad-incident-header">
          <div>
            ${priorityBadge}
            <strong style="margin-left: 8px; font-size: 1.05rem; color: #0f172a;">${esc(a.type)}</strong>
            <span class="badge badge-${a.status}" style="margin-left: 6px;">${a.status.toUpperCase()}</span>
          </div>
          <span style="font-weight: 700; color: #dc2626; font-size: 0.95rem;">
            📍 ${distanceKm} km from Base
          </span>
        </div>

        <div class="cad-body" style="color: #0f172a;">
          <div class="grid-2">
            <!-- Patient / Caller Telemetry -->
            <div>
              <p><strong>Caller Name:</strong> ${esc(a.userName)}</p>
              <p><strong>Emergency Telephone:</strong> <a href="tel:${esc(a.userPhone)}" style="font-weight: 700; color: #2563eb;">📞 ${esc(a.userPhone)}</a></p>
              <p><strong>Broadcast Time:</strong> ${new Date(a.created).toLocaleTimeString()} IST</p>
              
              ${a.medical ? `
                <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 8px 10px; margin-top: 6px;">
                  <strong style="color: #b91c1c; font-size: 0.82rem;">🩺 CONFIDENTIAL MEDICAL ALERT:</strong><br>
                  <span style="font-size: 0.88rem;">${esc(a.medical)}</span>
                </div>
              ` : ''}

              <!-- 4-Question Triage Findings -->
              ${a.triageAssessment ? `
                <div class="cad-telemetry-box">
                  <strong style="color: #0f172a; font-size: 0.82rem; text-transform: uppercase;">Clinical Triage Telemetry:</strong>
                  <div style="margin-top: 4px;">• <strong>Consciousness:</strong> ${esc(a.triageAssessment.answers.consciousness)}</div>
                  <div>• <strong>Trauma/Blood:</strong> ${esc(a.triageAssessment.answers.bleeding)}</div>
                  <div>• <strong>Cardiac/Stroke:</strong> ${esc(a.triageAssessment.answers.cardiac)}</div>
                  <div>• <strong>Scene Safety:</strong> ${esc(a.triageAssessment.answers.scene)}</div>
                  <div style="margin-top: 4px; color: #b91c1c; font-weight: 700;">
                    Risk Assessment: ${esc(a.triageAssessment.primaryRisk)}
                  </div>
                </div>
              ` : ''}
            </div>

            <!-- Triage Summary & Action Brief -->
            <div>
              <div class="cad-telemetry-box" style="margin-top: 0; background: #f0fdf4; border-color: #bbf7d0;">
                <strong style="color: #15803d; font-size: 0.82rem; text-transform: uppercase;">Paramedic Dispatch Brief:</strong>
                <div style="margin-top: 4px; font-weight: 600; color: #0f172a;">
                  ${a.confirmedSummary ? esc(a.confirmedSummary.responderSummary) : 'Emergency dispatch broadcast. Review triage telemetry.'}
                </div>
                ${a.confirmedSummary && a.confirmedSummary.reportedInjuryOrSymptoms ? `
                  <div style="margin-top: 4px; font-size: 0.82rem;"><strong>Symptoms:</strong> ${esc(a.confirmedSummary.reportedInjuryOrSymptoms)}</div>
                ` : ''}
              </div>

              <!-- Required Equipment Checklist -->
              <div style="margin-top: 8px;">
                <strong style="font-size: 0.78rem; color: #64748b; text-transform: uppercase;">Recommended Unit Gear:</strong>
                <div style="margin-top: 2px;">${eqTags}</div>
              </div>

              <!-- Audio Stream & Photo -->
              ${a.hasAudio ? `
                <div style="margin-top: 8px;" id="audio-wrap-${a.id}">
                  <button class="btn btn-outline btn-sm" onclick="loadAndPlayAudio('${a.id}')">
                    🔊 Stream Caller Voice Recording
                  </button>
                </div>
              ` : ''}

              ${a.hasPhoto ? `
                <div style="margin-top: 6px;" id="photo-wrap-${a.id}">
                  <button class="btn btn-outline btn-sm" onclick="loadAndShowPhoto('${a.id}')">
                    📷 View Accident Scene Photo
                  </button>
                </div>
              ` : ''}
            </div>
          </div>

          <!-- Official CAD Action Row -->
          <div class="row" style="margin-top: 14px; border-top: 1px solid #e2e8f0; padding-top: 12px;">
            ${a.status === 'sent' ? `
              <button class="btn btn-success" onclick="acceptEmergencyAlert('${a.id}')">
                ✅ ACCEPT DISPATCH
              </button>
              <button class="btn btn-alt" onclick="declineEmergencyAlert('${a.id}')">
                Decline / Escalate
              </button>
            ` : ''}

            ${isAssigned && step ? `
              <button class="btn btn-primary" onclick="advanceAlertStatus('${a.id}', '${step.next}')">
                ${step.label}
              </button>
            ` : ''}

            <a href="tel:${esc(a.userPhone)}" class="btn btn-alt">📞 Call Caller</a>
            <a target="_blank" href="https://www.google.com/maps/dir/?api=1&destination=${a.lat},${a.lng}" class="btn btn-alt">
              🗺️ Turn-by-Turn GPS
            </a>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Concurrency-Protected Acceptance
async function acceptEmergencyAlert(alertId) {
  try {
    await api(`/alerts/${alertId}/accept`, 'POST');
    showToast('✅ Dispatch Accepted: Assigned to your emergency facility.');
    loadResponderAlerts();
    loadIncidentHistory();
  } catch (err) {
    showToast('⚠️ Alert Unavailable: ' + err.message);
    loadResponderAlerts();
  }
}

async function declineEmergencyAlert(alertId) {
  try {
    await api(`/alerts/${alertId}/reject`, 'POST');
    showToast('Incident declined. Auto-escalated to next nearest hospital.');
    loadResponderAlerts();
  } catch (err) {
    showToast(err.message);
  }
}

async function advanceAlertStatus(alertId, newStatus) {
  try {
    await api(`/alerts/${alertId}/status`, 'POST', { status: newStatus });
    showToast(`Status Advanced: ${newStatus.toUpperCase()}`);
    loadResponderAlerts();
    loadIncidentHistory();
  } catch (err) {
    showToast(err.message);
  }
}

// ---- Media Playback ----
async function loadAndPlayAudio(alertId) {
  const wrap = $(`audio-wrap-${alertId}`);
  if (audioCache.has(alertId)) {
    const cachedUrl = audioCache.get(alertId);
    wrap.innerHTML = `<audio controls autoplay src="${cachedUrl}" style="width: 100%; margin-top: 4px;"></audio>`;
    return;
  }

  try {
    wrap.innerHTML = '<span class="text-muted" style="font-size: 0.82rem;">⏳ Decrypting audio stream...</span>';
    const res = await fetch(`/api/alerts/${alertId}/audio`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Audio stream unavailable');
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    audioCache.set(alertId, blobUrl);
    wrap.innerHTML = `<audio controls autoplay src="${blobUrl}" style="width: 100%; margin-top: 4px;"></audio>`;
  } catch (err) {
    showToast('Audio playback notice: ' + err.message);
    wrap.innerHTML = `<button class="btn btn-outline btn-sm" onclick="loadAndPlayAudio('${alertId}')">Retry Audio</button>`;
  }
}

async function loadAndShowPhoto(alertId) {
  let photoUrl = photoCache.get(alertId);
  if (!photoUrl) {
    try {
      showToast('⏳ Decrypting incident photograph...');
      const res = await fetch(`/api/alerts/${alertId}/photo`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Photo unavailable');
      const blob = await res.blob();
      photoUrl = URL.createObjectURL(blob);
      photoCache.set(alertId, photoUrl);
    } catch (err) {
      showToast('Photo notice: ' + err.message);
      return;
    }
  }

  $('photo-modal-img').src = photoUrl;
  $('photo-modal').classList.remove('hide');
}

function closePhotoModal() {
  $('photo-modal').classList.add('hide');
  $('photo-modal-img').src = '';
}

// ---- Case Archive ----
async function loadIncidentHistory() {
  try {
    const list = await api('/alerts/history');
    const container = $('resp-history-container');
    if (!list || list.length === 0) {
      container.innerHTML = '<p style="color: #94a3b8; font-size: 0.85rem;">No past incidents archived.</p>';
      return;
    }

    container.innerHTML = list.map(a => `
      <div style="background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 10px; margin-bottom: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong style="color: #f8fafc; font-size: 0.9rem;">${esc(a.type)}</strong>
          <span class="badge badge-${a.status}">${a.status}</span>
        </div>
        <div style="color: #94a3b8; font-size: 0.8rem; margin-top: 2px;">
          ${new Date(a.created).toLocaleString()} • Patient: ${esc(a.userName)}
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('History load error:', err);
  }
}

// ---- Real-time SSE Stream ----
function initResponderSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/stream?token=${token}`);

  eventSource.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.t === 'new_alert') {
        playAlertChime();
        showToast('🚨 INCOMING PRIORITY EMERGENCY BROADCAST!', 5000);
        loadResponderAlerts();
      } else if (msg.t === 'update' || msg.t === 'summary_ready' || msg.t === 'triage_ready') {
        loadResponderAlerts();
      }
    } catch {}
  };

  eventSource.onerror = () => {
    eventSource.close();
    setTimeout(initResponderSSE, 3000);
  };
}

// Bootstrap CAD
document.addEventListener('DOMContentLoaded', initResponderSession);
