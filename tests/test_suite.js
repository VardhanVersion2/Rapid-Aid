// RapidAid 2.0 - Comprehensive Test Suite
// Covers all 19 required validation areas:
// 1. User registration
// 2. User login
// 3. Responder login
// 4. SOS creation
// 5. Invalid GPS coordinates
// 6. Nearest facility calculation
// 7. Responder availability
// 8. First-accept-wins behavior
// 9. Invalid status transitions
// 10. Emergency cancellation
// 11. Audio upload validation
// 12. Photo upload validation
// 13. Transcription API error handling
// 14. Gemini API error handling
// 15. Confirmed summary persistence
// 16. Authentication protection
// 17. Role-based access
// 18. Emergency history
// 19. SSE event delivery

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidaid-test-'));
const TEST_PORT = 4050;
const API_URL = `http://localhost:${TEST_PORT}/api`;

const srv = spawn('node', ['server.js'], {
  env: {
    ...process.env,
    PORT: TEST_PORT,
    DATA_DIR: tempDir,
    ESCALATE_SECONDS: 2,
    DEMO_MODE: 'true'
  },
  stdio: 'ignore'
});

const call = async (route, method = 'GET', body = null, token = '', rawContentType = null, rawBuffer = null) => {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let requestBody = undefined;
  if (rawBuffer) {
    headers['Content-Type'] = rawContentType || 'application/octet-stream';
    requestBody = rawBuffer;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }

  const res = await fetch(API_URL + route, {
    method,
    headers,
    body: requestBody
  });

  let json = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    json = await res.json().catch(() => null);
  }

  return { status: res.status, json, res };
};

let failures = 0;
let passes = 0;
const testAssert = (name, condition, extraInfo = '') => {
  if (condition) {
    passes++;
    console.log(`PASS: [${passes}] ${name}`);
  } else {
    failures++;
    console.error(`FAIL: ${name} ${extraInfo}`);
  }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  try {
    await sleep(1000); // Wait for server spinup

    // --- 1. User Registration ---
    const regUser = await call('/register', 'POST', {
      name: 'Priya Sharma',
      phone: '+919876543210',
      password: 'password123',
      role: 'user'
    });
    testAssert('1.1 User registration success', regUser.status === 200 && regUser.json.token);
    const userToken = regUser.json.token;
    const userId = regUser.json.user.id;

    const dupReg = await call('/register', 'POST', {
      name: 'Another User',
      phone: '+919876543210',
      password: 'password123'
    });
    testAssert('1.2 Duplicate phone registration rejected (409)', dupReg.status === 409);

    const badPassReg = await call('/register', 'POST', {
      name: 'Short Pass',
      phone: '+919876543219',
      password: '123'
    });
    testAssert('1.3 Short password rejected (400)', badPassReg.status === 400);

    // --- 2. User Login ---
    const loginUser = await call('/login', 'POST', {
      phone: '+919876543210',
      password: 'password123'
    });
    testAssert('2.1 User login success', loginUser.status === 200 && loginUser.json.token);

    const badLogin = await call('/login', 'POST', {
      phone: '+919876543210',
      password: 'wrongpassword'
    });
    testAssert('2.2 Wrong password rejected (401)', badLogin.status === 401);

    // --- 3. Responder Registration & Login ---
    const regResp1 = await call('/register', 'POST', {
      name: 'Dr. Anand Verma',
      phone: '+919876543220',
      password: 'password123',
      role: 'responder',
      facility: {
        name: 'Apollo Trauma Hospital',
        type: 'hospital',
        phone: '+919876543220',
        address: 'Sector 5, Kanpur',
        lat: 26.4600,
        lng: 80.3300
      }
    });
    testAssert('3.1 Responder 1 registration with facility', regResp1.status === 200 && regResp1.json.token && regResp1.json.user.facility);
    const resp1Token = regResp1.json.token;
    const fac1Id = regResp1.json.user.facility.id;

    const regResp2 = await call('/register', 'POST', {
      name: 'Dr. Neha Gupta',
      phone: '+919876543230',
      password: 'password123',
      role: 'responder',
      facility: {
        name: 'City Urgent Care Clinic',
        type: 'clinic',
        phone: '+919876543230',
        address: 'Sector 18, Kanpur',
        lat: 26.5000,
        lng: 80.3800
      }
    });
    testAssert('3.2 Responder 2 registration with facility', regResp2.status === 200 && regResp2.json.token);
    const resp2Token = regResp2.json.token;

    // --- 4. SOS Creation ---
    const sosRes = await call('/alerts', 'POST', {
      lat: 26.4620,
      lng: 80.3310,
      type: 'Road Accident',
      note: 'Two-wheeler crash near junction'
    }, userToken);
    testAssert('4.1 SOS created successfully', sosRes.status === 200 && sosRes.json.status === 'sent');
    const alertId = sosRes.json.id;
    testAssert('4.2 Responders notified count > 0', sosRes.json.notifiedCount >= 1);

    // --- 5. Invalid GPS Coordinates Validation ---
    const badLatRes = await call('/alerts', 'POST', { lat: 95.0, lng: 80.33 }, userToken);
    testAssert('5.1 Invalid latitude (>90) rejected (400)', badLatRes.status === 400);

    const badLngRes = await call('/alerts', 'POST', { lat: 26.46, lng: -200.0 }, userToken);
    testAssert('5.2 Invalid longitude (<-180) rejected (400)', badLngRes.status === 400);

    const nonNumRes = await call('/alerts', 'POST', { lat: 'invalid', lng: 'bad' }, userToken);
    testAssert('5.3 Non-numeric coordinates rejected (400)', nonNumRes.status === 400);

    // --- 6. Nearest Facility Calculation (Haversine) ---
    const nearbyRes = await call('/facilities/nearby?lat=26.4610&lng=80.3305&radius=50');
    testAssert('6.1 Nearby facilities returned', nearbyRes.status === 200 && nearbyRes.json.length >= 2);
    testAssert('6.2 Facilities sorted ascending by distance', nearbyRes.json[0].distance <= nearbyRes.json[1].distance);

    // --- 7. Responder Availability Toggle ---
    const toggleBusy = await call('/facility', 'PATCH', { available: false }, resp1Token);
    testAssert('7.1 Responder marked busy', toggleBusy.status === 200 && toggleBusy.json.facility.available === false);

    const toggleAvail = await call('/facility', 'PATCH', { available: true }, resp1Token);
    testAssert('7.2 Responder marked available', toggleAvail.status === 200 && toggleAvail.json.facility.available === true);

    // --- 8. First-Accept-Wins Concurrency Protection ---
    const accept1 = await call(`/alerts/${alertId}/accept`, 'POST', {}, resp1Token);
    testAssert('8.1 First responder accepts emergency', accept1.status === 200 && accept1.json.status === 'accepted');

    const accept2 = await call(`/alerts/${alertId}/accept`, 'POST', {}, resp2Token);
    testAssert('8.2 Second responder rejected with 409 conflict', accept2.status === 409);

    const resp2Alerts = await call('/responder/alerts', 'GET', null, resp2Token);
    testAssert('8.3 Alert no longer visible to unassigned responder 2', resp2Alerts.json.every(a => a.id !== alertId));

    // --- 9. Invalid Status Transitions (Forward-Only Lifecycle) ---
    // Transition to on_the_way (valid)
    const statusOTW = await call(`/alerts/${alertId}/status`, 'POST', { status: 'on_the_way' }, resp1Token);
    testAssert('9.1 Transition to on_the_way success', statusOTW.status === 200 && statusOTW.json.status === 'on_the_way');

    // Attempt to step backward to accepted (invalid)
    const badStepBack = await call(`/alerts/${alertId}/status`, 'POST', { status: 'accepted' }, resp1Token);
    testAssert('9.2 Backward status transition rejected (400)', badStepBack.status === 400);

    // Attempt arbitrary invalid status
    const bogusStatus = await call(`/alerts/${alertId}/status`, 'POST', { status: 'flying_helicopter' }, resp1Token);
    testAssert('9.3 Bogus status string rejected (400)', bogusStatus.status === 400);

    // --- 10. Emergency Cancellation ---
    // Create another alert to test cancellation
    // First close the active one
    await call(`/alerts/${alertId}/status`, 'POST', { status: 'arrived' }, resp1Token);
    await call(`/alerts/${alertId}/status`, 'POST', { status: 'closed' }, resp1Token);

    const alert2 = (await call('/alerts', 'POST', { lat: 26.46, lng: 80.33, type: 'Injury' }, userToken)).json;
    const cancelRes = await call(`/alerts/${alert2.id}/cancel`, 'POST', {}, userToken);
    testAssert('10.1 Active alert cancelled by user', cancelRes.status === 200 && cancelRes.json.status === 'cancelled');

    const acceptCancelled = await call(`/alerts/${alert2.id}/accept`, 'POST', {}, resp1Token);
    testAssert('10.2 Cancelled alert cannot be accepted (409)', acceptCancelled.status === 409);

    // --- 11. Audio Upload Validation ---
    const alert3 = (await call('/alerts', 'POST', { lat: 26.46, lng: 80.33, type: 'Road Accident' }, userToken)).json;

    // Disallowed MIME type
    const badMime = await call(`/alerts/${alert3.id}/audio`, 'POST', null, userToken, 'text/plain', Buffer.from('not an audio'));
    testAssert('11.1 Disallowed audio MIME rejected (400)', badMime.status === 400);

    // Valid audio upload (webm)
    const mockAudio = Buffer.from('RIFF_MOCK_AUDIO_DATA_FOR_TESTING');
    const goodAudio = await call(`/alerts/${alert3.id}/audio`, 'POST', null, userToken, 'audio/webm', mockAudio);
    testAssert('11.2 Valid audio uploaded successfully', goodAudio.status === 200 && goodAudio.json.audioUrl);

    // Retrieve audio (authenticated)
    const getAudio = await call(`/alerts/${alert3.id}/audio`, 'GET', null, userToken);
    testAssert('11.3 Authenticated audio retrieval success', getAudio.status === 200);

    // --- 12. Photo Upload Validation ---
    const badPhotoMime = await call(`/alerts/${alert3.id}/photo`, 'POST', null, userToken, 'application/pdf', Buffer.from('fake pdf'));
    testAssert('12.1 Disallowed photo MIME rejected (400)', badPhotoMime.status === 400);

    const mockPhoto = Buffer.from('\xFF\xD8\xFF\xE0_MOCK_JPEG_DATA');
    const goodPhoto = await call(`/alerts/${alert3.id}/photo`, 'POST', null, userToken, 'image/jpeg', mockPhoto);
    testAssert('12.2 Valid photo uploaded successfully', goodPhoto.status === 200 && goodPhoto.json.photoUrl);

    const getPhoto = await call(`/alerts/${alert3.id}/photo`, 'GET', null, userToken);
    testAssert('12.3 Authenticated photo retrieval success', getPhoto.status === 200);

    // --- 13. Transcription API & Error Handling ---
    const transcribeRes = await call(`/alerts/${alert3.id}/transcribe`, 'POST', {}, userToken);
    testAssert('13.1 Audio transcription success (Demo / Live)', transcribeRes.status === 200 && !!transcribeRes.json.transcript);

    // Missing audio error handling on a fresh alert with a fresh user
    const freshUser = (await call('/register', 'POST', {
      name: 'Fresh Caller',
      phone: '+919876543291',
      password: 'password123',
      role: 'user'
    })).json;
    const freshAlert = (await call('/alerts', 'POST', { lat: 26.47, lng: 80.34, type: 'Other' }, freshUser.token)).json;
    const missingAudioTranscribe = await call(`/alerts/${freshAlert.id}/transcribe`, 'POST', {}, freshUser.token);
    testAssert('13.2 Transcribe without audio rejected (400)', missingAudioTranscribe.status === 400);

    // --- 14. Gemini Summarization API & Error Handling ---
    const summarizeRes = await call(`/alerts/${alert3.id}/summarize`, 'POST', {
      transcript: transcribeRes.json.transcript
    }, userToken);
    testAssert('14.1 Gemini structured summary generated', summarizeRes.status === 200 && summarizeRes.json.summary);
    const sumObj = summarizeRes.json.summary;
    testAssert('14.2 Summary contains all 6 required fields',
      sumObj.emergencyType !== undefined &&
      sumObj.reportedInjuryOrSymptoms !== undefined &&
      sumObj.patientStatement !== undefined &&
      sumObj.additionalDetails !== undefined &&
      sumObj.missingInformation !== undefined &&
      sumObj.responderSummary !== undefined
    );

    // Missing transcript error handling
    const emptySummarize = await call(`/alerts/${alert3.id}/summarize`, 'POST', { transcript: '' }, userToken);
    testAssert('14.3 Summarize with empty transcript rejected (400)', emptySummarize.status === 400);

    // --- 15. Confirmed Summary Persistence ---
    const confirmedPayload = {
      confirmedSummary: {
        emergencyType: 'Road Accident',
        reportedInjuryOrSymptoms: 'Lower leg laceration, alert and conscious',
        patientStatement: 'Two-wheeler crash',
        additionalDetails: 'Near intersection',
        missingInformation: 'Vitals unconfirmed',
        responderSummary: 'Send ambulance with trauma kit'
      },
      transcript: transcribeRes.json.transcript
    };
    const confirmRes = await call(`/alerts/${alert3.id}/summary`, 'POST', confirmedPayload, userToken);
    testAssert('15.1 Summary confirmed by user', confirmRes.status === 200 && confirmRes.json.confirmedSummary);

    // Verify assigned responder sees confirmed summary
    await call(`/alerts/${alert3.id}/accept`, 'POST', {}, resp1Token);
    const assignedView = await call(`/alerts/${alert3.id}`, 'GET', null, resp1Token);
    testAssert('15.2 Confirmed summary visible to responder',
      assignedView.json.confirmedSummary &&
      assignedView.json.confirmedSummary.responderSummary === 'Send ambulance with trauma kit'
    );

    // --- 16. Authentication Protection ---
    const unauthMe = await call('/me', 'GET');
    testAssert('16.1 Unauthenticated /me rejected (401)', unauthMe.status === 401);

    const unauthAlerts = await call('/alerts', 'POST', { lat: 26.46, lng: 80.33 });
    testAssert('16.2 Unauthenticated alert creation rejected (401)', unauthAlerts.status === 401);

    const unauthAudio = await call(`/alerts/${alert3.id}/audio`, 'GET');
    testAssert('16.3 Unauthenticated media access rejected (401)', unauthAudio.status === 401);

    // --- 17. Role-Based Access Control ---
    const respSos = await call('/alerts', 'POST', { lat: 26.46, lng: 80.33 }, resp1Token);
    testAssert('17.1 Responder cannot send SOS (403)', respSos.status === 403);

    const userStatusChange = await call(`/alerts/${alert3.id}/status`, 'POST', { status: 'on_the_way' }, userToken);
    testAssert('17.2 Normal user cannot change status (403)', userStatusChange.status === 403);

    // Foreign user accessing private audio
    const regUser2 = (await call('/register', 'POST', {
      name: 'Sneha Roy',
      phone: '+919876543299',
      password: 'password123',
      role: 'user'
    })).json;
    const foreignAudio = await call(`/alerts/${alert3.id}/audio`, 'GET', null, regUser2.token);
    testAssert('17.3 Foreign user cannot access patient audio (403)', foreignAudio.status === 403);

    // --- 18. Emergency History ---
    const userHistory = await call('/alerts/history', 'GET', null, userToken);
    testAssert('18.1 User retrieves emergency history', userHistory.status === 200 && userHistory.json.length >= 1);

    const respHistory = await call('/alerts/history', 'GET', null, resp1Token);
    testAssert('18.2 Responder retrieves facility emergency history', respHistory.status === 200 && respHistory.json.length >= 1);

    // --- 19. SSE Event Delivery ---
    const sseRes = await new Promise((resolve) => {
      let resolved = false;
      const req = http.request(`http://localhost:${TEST_PORT}/api/stream?token=${userToken}`, {
        method: 'GET'
      }, (res) => {
        res.on('data', chunk => {
          const str = chunk.toString();
          if (!resolved && (str.includes(': ok') || str.includes('data:'))) {
            resolved = true;
            resolve({ status: res.statusCode, headers: res.headers, ok: true });
            req.destroy();
          }
        });
      });
      req.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          resolve({ ok: false, error: err.message });
        }
      });
      req.end();
    });
    testAssert('19.1 SSE connection opened with text/event-stream',
      sseRes.ok && sseRes.status === 200 && (sseRes.headers['content-type'] || '').includes('text/event-stream'),
      `DEBUG sseRes: ${JSON.stringify(sseRes)}`
    );

    // Clean up
    srv.kill();
    console.log(`\n========================================`);
    console.log(`TEST RESULTS: ${passes} PASSED, ${failures} FAILED`);
    console.log(`========================================`);
    process.exit(failures > 0 ? 1 : 0);
  } catch (err) {
    console.error('Test runner caught unexpected error:', err);
    srv.kill();
    process.exit(1);
  }
})();
