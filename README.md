# RapidAid 2.0 — Emergency Medical Assistance Platform

> **A lightweight, full-stack emergency medical platform with dual real-time interfaces, AI panic voice summarization (OpenAI + Google Gemini), and zero-dependency Node.js architecture.**

---

## 1. Project Overview & Problem Statement

### The Problem
During severe medical emergencies, road crashes, or acute health crises:
1. **Panicked callers cannot articulate symptoms**: Callers struggle to type or speak coherently, leading to delayed or inaccurate triage.
2. **First responders lack upfront context**: Ambulances arrive without knowing whether the victim has severe head trauma, arterial bleeding, or an airway obstruction.
3. **Dispatch contention**: Multiple hospitals or ambulances may attempt to accept an emergency simultaneously or drop calls, creating confusion.
4. **Heavy web frameworks fail on low-end devices**: Modern bloated JavaScript SPAs (React/Vue/Angular) have slow initial load times, requiring heavy bundles that fail under poor 2G/3G connectivity.

### The Solution: RapidAid 2.0
RapidAid 2.0 connects patients and medical dispatchers through two synchronized interfaces communicating with a lightweight Node.js backend:
- **Instant SOS Dispatch**: High-accuracy GPS capture with Haversine distance sorting to find the closest registered facilities.
- **AI Panic Voice Assistant**: Victims speak in Hindi, English, or Hinglish. OpenAI transcribes the voice note, and Google Gemini extracts structured medical facts (symptoms, patient statement, unknowns, and responder triage action) into a human-reviewable briefing.
- **Dual Synchronized Interfaces**: Real-time bidirectional status synchronization via **Server-Sent Events (SSE)**.
- **Concurrency-Protected Dispatch**: Atomic first-accept-wins locking ensures only one responder claims an incident.
- **Zero-Dependency Architecture**: Runs on native Node.js standard libraries (`http`, `fs`, `crypto`) with zero runtime `npm install` packages required.

---

## 2. Key Features

### User Application (`/` or `/index.html`)
- **Single-Tap Red SOS**: Large high-contrast emergency trigger with 5-second cancel countdown.
- **GPS & Manual Fallback**: Browser Geolocation API with interactive OpenStreetMap pin-drop fallback.
- **Emergency Categories & Silent Presets**: Selectable categories (Road Accident, Injury, Breathing Difficulty, Medical Emergency, Other) + one-tap presets for users unable to speak.
- **AI Voice Assistant**: In-browser audio recording (MediaRecorder API) with live transcription and Gemini structured summary generation.
- **Summary Review & Confirmation**: User reviews, edits, and confirms the summary before transmitting it to responders.
- **Accident Scene Photo**: Optional upload of scene/injury photos, stored in protected private storage.
- **Hospital Directory & Verified Calling**: Direct `tel:` links to call hospital emergency rooms or India's 112 hotline.
- **Live Dispatch Tracker**: Real-time status tracker (`SENT` → `ACCEPTED` → `ON THE WAY` → `ARRIVED` → `CLOSED`).
- **Confidential Medical Profile**: Allergies, blood group, and conditions revealed *only* to the responder who accepts.

### Hospital / Responder Dashboard (`/responder.html`)
- **Real-Time Dispatch Console**: Incoming alerts stream over SSE with audible alert chimes.
- **Interactive Radar Map**: Leaflet map plotting facility base and active incident locations.
- **Incident Briefing Card**: Displays patient name, phone, distance in km, directions link, and confidential medical history.
- **AI Triage Section**: Confirmed structured summary, original speech transcript, embedded private audio player, and accident photo preview.
- **First-Accept-Wins Protection**: Concurrency lock prevents two responders from accepting the same emergency.
- **Lifecycle Status Management**: Forward-only status controls (`ACCEPTED` → `ON THE WAY` → `ARRIVED` → `CLOSED`).
- **Availability Toggle**: 🟢 Available / 🔴 Busy switch to pause incoming dispatch notifications.

---

## 3. Architecture & Data Flow

```
+-------------------------------------------------------------------------+
|                              USER CLIENT                                |
|  (index.html / app.js - Browser Geolocation + MediaRecorder + Leaflet)  |
+-------------------------------------------------------------------------+
        |                                                   ^
        | 1. POST /api/alerts (lat, lng, type)              | 8. SSE /api/stream
        | 3. POST /api/alerts/:id/audio                     |    (Status updates:
        | 4. POST /api/alerts/:id/transcribe + /summarize   |     ACCEPTED, OTW,
        | 5. POST /api/alerts/:id/summary (User confirms)   |     ARRIVED, CLOSED)
        v                                                   |
+-------------------------------------------------------------------------+
|                         NODE.JS UNIFIED BACKEND                         |
|      (server.js - Built-in HTTP, Scrypt Crypto, SSE, Media Storage)     |
|                                                                         |
|  - Haversine Geospatial Routing    - Atomic JSON DB (db.json)           |
|  - Concurrency Lock (First Accept) - Protected Media Storage (/uploads) |
|  - OpenAI STT Integration          - Google Gemini AI Summarizer        |
+-------------------------------------------------------------------------+
        |                                                   ^
        | 2. SSE Broadcast (new_alert)                      | 6. POST /api/alerts/:id/accept
        | 5. SSE Broadcast (summary_ready)                  | 7. POST /api/alerts/:id/status
        v                                                   |
+-------------------------------------------------------------------------+
|                           RESPONDER DASHBOARD                           |
|       (responder.html / responder.js - Medical Dispatch Terminal)       |
+-------------------------------------------------------------------------+
```

---

## 4. Technology Stack

| Layer | Technology | Reason for Selection |
|---|---|---|
| **Frontend UI** | HTML5, CSS3, Vanilla JavaScript | Extremely fast load times, zero bundle compilation, runs on any mobile browser |
| **Backend Server** | Node.js (v18+) Built-in `http` | Zero-dependency, lightweight, easy for academic demonstration and viva |
| **Real-time Engine** | Server-Sent Events (SSE) | Unidirectional HTTP streaming, native browser auto-reconnect, simpler and lighter than WebSockets |
| **Mapping & GIS** | Leaflet.js + OpenStreetMap | Free, open-source mapping without proprietary Google Maps billing or API keys |
| **Geospatial Distance**| Haversine Formula | Calculates spherical Earth distance between patient GPS and hospital coordinates |
| **Voice Recording** | Browser MediaRecorder API | Native audio capture in WebM/WAV formats without plugins |
| **Speech-to-Text** | OpenAI Audio Transcriptions API | Converts multilingual spoken audio (Hindi, English, Hinglish) into clean text |
| **AI Summarization** | Google Gemini Flash API | Structured JSON synthesis adhering to strict medical safety rules |
| **Persistence** | Serialized Atomic JSON (`fs.renameSync`) | Simple, inspectable, human-readable data with crash-safe atomic updates |
| **Authentication** | Custom HMAC-SHA256 & Scrypt | Cryptographically secure tokens and salted password hashing |
| **Testing** | Node.js Test Runner | Automated validation of 46 test cases covering all edge cases |

### Android APK

The Android app is a native Java WebView shell that loads the same responsive interface from the deployed RapidAid server. The APK connects automatically to the HTTPS demo at `https://rapid-aid-xqvr.onrender.com/`; it does not need a local server address or a shared Wi-Fi network. Use `build_apk.ps1` to rebuild `RapidAid.apk` after frontend or Android changes. The APK uses a debug signing key for project/demo installation.

## 5. Container Deployment

The included `Dockerfile` packages the zero-dependency Node.js server and web UI. `compose.yaml` keeps the JSON database and uploaded media in persistent Docker volumes. For a local container run, use `docker compose up -d --build` and open `http://localhost:3000`. For a public deployment, choose a Node/Docker hosting provider that supports persistent storage for both `/app/data` and `/app/uploads`; use the provider's HTTPS domain in the APK. Demo mode is enabled by default in the Compose file. Set `DEMO_MODE=false` and configure API keys in the hosting provider's secret settings to enable live AI transcription and summarization. Do not copy API keys into the image.

---

## 6. Folder Structure

```
Rapid aid/
│
├── server.js               # Central HTTP server, custom router, auth, SSE & AI endpoints
├── package.json            # Node.js project configuration and test commands
├── .env.example            # Environment variables template
├── .gitignore              # Ignores .env and temporary upload files
├── README.md               # Complete project documentation & setup manual
├── VIVA.md                 # 30+ College Viva questions and detailed answers
│
├── public/                 # Static web assets served to clients
│   ├── index.html          # User / Patient Emergency Application
│   ├── responder.html      # Hospital / Responder Medical Dispatch Terminal
│   ├── app.css             # Unified modern CSS design system
│   ├── app.js              # User application client logic (GPS, Audio, SOS, Map)
│   └── responder.js        # Responder terminal client logic (SSE Alerts, Dispatch)
│
├── data/
│   └── db.json             # Atomic serialized JSON database file
│
├── uploads/                # Protected media directory (NOT statically served!)
│   ├── audio/              # Voice recording audio files (.webm, .wav)
│   └── photos/             # Accident scene photos (.jpg, .png)
│
└── tests/
    └── test_suite.js       # 46 automated integration tests covering all requirements
```

---

## 7. Installation & Quick Start

### Prerequisites
- **Node.js**: Version 18.0.0 or higher.
- No external packages (`npm install`) are required! RapidAid runs entirely on Node's native modules.

### Step 1: Clone or Navigate to Project
```bash
cd "c:\Users\VARDHAN\Downloads\Rapid aid"
```

### Step 2: Environment Configuration
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Open `.env` in any text editor:
```env
PORT=3000
OPENAI_API_KEY=
GEMINI_API_KEY=
GEMINI_MODEL=gemini-1.5-flash
DEMO_MODE=true
ESCALATE_SECONDS=45
```
> **Note on Demo Mode**: By default, `DEMO_MODE=true` is enabled. If you do not have OpenAI or Gemini API keys, the application automatically provides realistic mock voice transcriptions and Gemini emergency summaries. This guarantees that your college demonstration and viva work 100% reliably even offline!

### Step 3: Run the Server
```bash
node server.js
```
The terminal will display:
```
🚑 RapidAid 2.0 running on http://localhost:3000
📡 Mode: Demo Mode (Offline-Safe)
```

---

## 8. How to Demonstrate (Two-Window College Demo)

To demonstrate the connected two-interface system:

1. **Open Responder Dashboard**:
   - Open a browser window (or incognito) at: `http://localhost:3000/responder.html`
   - Click **Register Facility**.
   - Enter name `Dr. Anand`, phone `+919876543201`, password `password123`.
   - Facility details: Hospital Name `Apollo Trauma Center`, Type `Hospital`, Lat `26.4600`, Lng `80.3300` (or tap "Set Facility Coordinates from Current Location").
   - Click **Register Hospital / Facility**. The responder dashboard will open, showing status: 🟢 **Available**.

2. **Open User Application**:
   - Open a second browser window at: `http://localhost:3000/`
   - Click **Register**, enter name `Rahul`, phone `+919876543202`, password `password123`.
   - Save your confidential medical profile (e.g. `Blood Group O+, allergic to Sulfa`).

3. **Simulate Voice & SOS**:
   - In the User App, select category `Road Accident`.
   - Click **Record Voice Note**. Speak into your microphone (e.g. *"Crash at intersection, severe bleeding from leg!"*).
   - Click **Stop Recording**.
   - Click **EMERGENCY SOS**. The 5-second countdown will start, or click **Send SOS Immediately**.
   - The audio uploads, transcribes, and Gemini generates a structured summary.
   - The user reviews the summary and clicks **✅ Confirm & Transmit Summary to Responder**.

4. **Watch Responder Dashboard React in Real Time**:
   - The Responder Dashboard instantly plays an emergency alert chime without refreshing the page!
   - The incident appears with distance in km, patient name, contact number, and the confirmed AI briefing.
   - Click **🔊 Listen to Patient Voice Recording** to hear the actual audio.
   - Click **✅ Accept Emergency**.
   - Look back at the User window: The status updates to **ACCEPTED** in real time!
   - Advance the responder lifecycle: `Dispatch Ambulance` → `Mark Responders Arrived` → `Close Incident Case`. Both screens stay in sync.

---

## 9. REST API Reference

### Authentication
- `POST /api/register` — Register a patient user or a responder with facility details.
- `POST /api/login` — Authenticate and receive HMAC bearer token.
- `GET /api/me` — Retrieve current authenticated user profile.
- `PUT /api/me` — Update emergency contacts and confidential medical history.

### Facilities & Responders
- `GET /api/facilities` — List all registered medical facilities.
- `GET /api/facilities/nearby?lat=...&lng=...&radius=...` — Haversine-sorted nearest facilities.
- `PATCH /api/facility` — Toggle responder availability (`available: true/false`).

### Emergency Alerts
- `POST /api/alerts` — Create an SOS alert (validates lat/lng, finds nearest responders, broadcasts SSE).
- `GET /api/alerts/active` — Get current active emergency for logged-in user.
- `GET /api/alerts/history` — Get incident history (user or responder).
- `POST /api/alerts/:id/location` — Transmit updated live GPS coordinates.
- `POST /api/alerts/:id/cancel` — Cancel active emergency.
- `GET /api/responder/alerts` — Get incoming & assigned alerts for responder's facility.
- `POST /api/alerts/:id/accept` — Concurrency-protected emergency acceptance (first-accept-wins).
- `POST /api/alerts/:id/reject` — Decline emergency and escalate to next nearest facility.
- `POST /api/alerts/:id/status` — Advance emergency status (`accepted` → `on_the_way` → `arrived` → `closed`).

### AI Voice Assistant & Media
- `POST /api/alerts/:id/audio` — Upload audio recording (WebM/WAV, max 15MB).
- `GET /api/alerts/:id/audio` — Stream protected audio recording (authenticated).
- `POST /api/alerts/:id/photo` — Upload accident scene photo (JPEG/PNG, max 10MB).
- `GET /api/alerts/:id/photo` — Retrieve protected accident photo (authenticated).
- `POST /api/alerts/:id/transcribe` — Transcribe voice recording using OpenAI Audio Transcriptions API.
- `POST /api/alerts/:id/summarize` — Generate structured summary using Google Gemini.
- `POST /api/alerts/:id/summary` — Confirm and persist editable AI summary; notify responders.

### Real-time Streaming
- `GET /api/stream?token=...` — Server-Sent Events (SSE) persistent event connection.

---

## 10. Automated Testing

RapidAid includes two complete test suites:

### Run All Tests
```bash
npm test
```
Or directly:
```bash
node test.js && node tests/test_suite.js
```

### Test Coverage Highlights (46 Comprehensive Tests)
1. User registration & validation (duplicate phone, weak password).
2. User and responder login.
3. Responder registration with facility details.
4. SOS alert creation and notification count.
5. GPS coordinate bounds validation (`-90 <= lat <= 90`, `-180 <= lng <= 180`).
6. Haversine distance calculation and sorting.
7. Responder availability toggle.
8. First-accept-wins concurrency (HTTP 409 conflict on second accept).
9. Forward-only status lifecycle enforcement (rejection of backward transitions).
10. Emergency cancellation and post-cancel accept prevention.
11. Audio MIME validation and authenticated streaming.
12. Photo MIME validation and authenticated retrieval.
13. OpenAI Speech-to-Text transcription error handling.
14. Google Gemini 6-field structured summary validation.
15. Confirmed summary persistence and responder visibility.
16. Authentication protection (HTTP 401 on unauthenticated private routes).
17. Role-based access control (responders cannot trigger SOS; users cannot change responder status).
18. Emergency history for patients and facilities.
19. Real-time Server-Sent Events delivery with keepalive pings.

---

## 11. Current Limitations & Future Scope

### Current Limitations
1. **JSON File Database**: `data/db.json` is optimal for single-server local deployment, but enterprise production would benefit from PostgreSQL or MongoDB.
2. **In-Memory Server-Sent Events**: Active SSE client connections reside in memory; multi-instance horizontal scaling would require Redis Pub/Sub.
3. **Browser Geolocation Constraints**: Browsers require localhost or HTTPS to provide high-accuracy GPS coordinates.

### Future Scope
1. **Turn-by-Turn Routing**: Integrate Open Source Routing Machine (OSRM) for live route geometry on Leaflet.
2. **SMS Gateway Integration**: Automatically trigger Twilio or Fast2SMS alerts to emergency contacts.
3. **Wearable IoT Sync**: Connect smartwatches to trigger SOS automatically on high G-force crash detection or severe heart rate drops.
