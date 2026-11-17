import os
from fpdf import FPDF

class PDFReport(FPDF):
    def header(self):
        if self.page_no() > 1:
            self.set_font("helvetica", "B", 8)
            self.set_text_color(100, 116, 139)
            self.cell(190, 8, "RapidAid 2.0 - Emergency Medical Assistance Platform Guide", border=0, align="L")
            self.ln(6)
            self.set_draw_color(226, 232, 240)
            self.line(10, 16, 200, 16)
            self.ln(4)

    def footer(self):
        self.set_y(-15)
        self.set_font("helvetica", "I", 8)
        self.set_text_color(148, 163, 184)
        self.cell(190, 10, f"Page {self.page_no()} | RapidAid 2.0 B.Tech CSE Minor Project", border=0, align="C")

    def chapter_title(self, title):
        self.set_font("helvetica", "B", 12)
        self.set_text_color(15, 23, 42)
        self.cell(190, 8, title, border=0, align="L")
        self.ln(7)
        self.set_draw_color(220, 38, 38)
        self.set_line_width(0.6)
        self.line(10, self.get_y(), 200, self.get_y())
        self.ln(3)

    def sub_title(self, title):
        self.set_font("helvetica", "B", 10)
        self.set_text_color(37, 99, 235)
        self.cell(190, 6, title, border=0, align="L")
        self.ln(5)

    def body_p(self, text):
        self.set_font("helvetica", "", 8.5)
        self.set_text_color(30, 41, 59)
        self.multi_cell(190, 4.5, text)
        self.ln(2)

    def bullet(self, text):
        self.set_font("helvetica", "", 8)
        self.set_text_color(30, 41, 59)
        self.multi_cell(190, 4.2, f"  * {text}")
        self.ln(1)

    def qa(self, q, a):
        self.set_font("helvetica", "B", 8.5)
        self.set_text_color(15, 23, 42)
        self.multi_cell(190, 4.2, q)
        self.set_font("helvetica", "", 8)
        self.set_text_color(51, 65, 85)
        self.multi_cell(190, 4.0, a)
        self.ln(2)

def generate_pdf():
    pdf = PDFReport()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()

    # Cover Title
    pdf.set_font("helvetica", "B", 20)
    pdf.set_text_color(220, 38, 38)
    pdf.cell(190, 9, "RAPIDAID 2.0", border=0, align="C")
    pdf.ln(8)

    pdf.set_font("helvetica", "B", 11)
    pdf.set_text_color(15, 23, 42)
    pdf.cell(190, 6, "EMERGENCY MEDICAL PLATFORM WITH AI VOICE SUMMARIZATION", border=0, align="C")
    pdf.ln(6)

    pdf.set_font("helvetica", "I", 9)
    pdf.set_text_color(100, 116, 139)
    pdf.cell(190, 5, "Architecture, System Flow, Setup, Dry-Run & Viva Defense Manual", border=0, align="C")
    pdf.ln(6)
    pdf.set_draw_color(220, 38, 38)
    pdf.line(10, 35, 200, 35)
    pdf.ln(4)

    # 1. Project Overview & Flow
    pdf.chapter_title("1. Project Overview & Complete System Flow")
    pdf.body_p("RapidAid 2.0 is an emergency medical assistance system built with zero external runtime dependencies using native Node.js, HTML5, CSS3, and Vanilla JavaScript. It connects two separate, synchronized interfaces through Server-Sent Events (SSE):")
    pdf.bullet("Android APK (RapidAid.apk): Native Android app package with full hardware GPS, microphone audio capture, camera scene uploads, and instant SOS dispatch.")
    pdf.bullet("User Web Application (http://localhost:3000): Mobile-first interface with ECG loading animation, 1-tap SOS, 4-Question AI Emergency Triage protocol, voice recording, and nearby hospital directory.")
    pdf.bullet("Hospital/Responder CAD Terminal (http://localhost:3000/responder.html): Official Emergency Medical Dispatch (EMS-CAD) console with live telemetry clock, real-time SSE alerts, audible chimes, first-accept-wins concurrency, equipment checklists, and lifecycle status tracking.")
    pdf.bullet("4-Question AI Triage Engine: Evaluates Consciousness, Severe Bleeding, Cardiac/Stroke signs, and Scene Hazards to assign Priority Code Red/Yellow/Green and ambulance equipment prep.")
    pdf.bullet("AI Panic Voice Assistant: Spoken voice notes (Hindi/English/Hinglish) are transcribed via OpenAI Audio Transcriptions API and synthesized into an editable briefing by Google Gemini.")
    pdf.ln(2)

    # 2. System Architecture Setup
    pdf.chapter_title("2. System Architecture & Setup Breakdown")
    pdf.sub_title("A. Frontend Architecture:")
    pdf.bullet("Framework: Pure Vanilla JavaScript, HTML5, and CSS3 (zero build steps, instant load time on 2G/3G mobile networks).")
    pdf.bullet("Interactive Mapping: Leaflet 1.9.4 + OpenStreetMap tiles with GPS Geolocation API and manual map-tap pin fallback.")
    pdf.bullet("Voice Capture: Native browser MediaRecorder API generating WebM audio buffers with duration counter.")
    pdf.bullet("Real-Time Receiver: EventSource connecting to /api/stream with automatic 3s reconnect logic.")

    pdf.sub_title("B. Backend Architecture (server.js):")
    pdf.bullet("Runtime: Built-in Node.js HTTP server (http module) with custom regex URL routing.")
    pdf.bullet("Security: Salted password hashing with crypto.scryptSync and timing-safe checks (timingSafeEqual). Stateless HMAC-SHA256 bearer tokens.")
    pdf.bullet("Geospatial Engine: Pure JavaScript Haversine formula calculating distance in kilometers between patient and facilities.")
    pdf.bullet("Real-Time Streamer: Server-Sent Events (SSE) broadcasting new alerts and status changes to connected clients.")
    pdf.bullet("Protected Storage: Uploaded voice notes and scene photos stored in private uploads/ directory, accessible only through authenticated routes.")

    pdf.sub_title("C. Database & Reliability Setup (data/db.json):")
    pdf.bullet("Atomic Writes: Server writes to temporary files (db.tmp.<id>) and executes atomic fs.renameSync to prevent file corruption.")
    pdf.bullet("Serialized Write Queue: Disk updates are chained onto a Promise queue to prevent concurrent write collisions.")
    pdf.bullet("First-Accept Mutex: Emergency acceptance checks status === 'sent' inside a lock. If two responders click accept, the second receives HTTP 409 Conflict.")
    pdf.ln(2)

    # 3. Dry-Run Instructions
    pdf.chapter_title("3. Step-by-Step Dry-Run Demonstration Procedure")
    pdf.body_p("Perform this demonstration across two browser windows to showcase the full real-time connected workflow:")
    pdf.bullet("Step 1 (Start Server): Run 'node server.js' in the terminal. Server runs on http://localhost:3000 in Demo Mode.")
    pdf.bullet("Step 2 (Open Responder Window): Navigate to http://localhost:3000/responder.html. Click 'Register Facility'. Register Dr. Anand (+919876543201) with City Care Hospital (Lat 26.46, Lng 80.33). Facility status becomes Available.")
    pdf.bullet("Step 3 (Open User Window): Open an Incognito window at http://localhost:3000/. Register Rahul Sharma (+919876543202). Save medical notes: 'Blood Group O+, Asthmatic'.")
    pdf.bullet("Step 4 (Voice & SOS): In User App, select 'Road Accident'. Click 'Record Voice Note', speak into microphone, then click Stop. Click 'EMERGENCY SOS'. AI summarizes voice message. User reviews and clicks 'Confirm & Transmit Summary'.")
    pdf.bullet("Step 5 (Responder Alert): Look at Responder Window. An audible chime plays without refreshing! Incident card displays distance, patient phone, AI summary, and voice recording player.")
    pdf.bullet("Step 6 (Accept & Sync): Responder clicks 'Accept Emergency'. User window updates to ACCEPTED in real time. Responding hospital name and phone link appear on user screen. Responder advances status to 'On The Way' -> 'Arrived' -> 'Closed'.")
    pdf.ln(2)

    # 4. Top Viva Questions & Answers
    pdf.chapter_title("4. Key Viva Questions & Model Answers")
    viva_list = [
        ("Q1: Why did we use Vanilla JavaScript instead of React or Vue?",
         "Emergency platforms must load in milliseconds on low-end smartphones under poor cellular connections. Vanilla JS has zero bundle overhead, loads instantly, and runs natively in every browser."),
        ("Q2: What is Server-Sent Events (SSE) and why use it over WebSockets?",
         "SSE is a lightweight HTTP streaming standard (text/event-stream) where the server pushes updates to the client. It is simpler than WebSockets, handles auto-reconnection natively, and avoids custom TCP protocols."),
        ("Q3: What does the Haversine formula do?",
         "It calculates the great-circle distance between two latitude/longitude points on a spherical Earth, allowing RapidAid to accurately rank and notify the nearest hospitals."),
        ("Q4: How do we prevent two responders from accepting the same emergency?",
         "We implement First-Accept-Wins concurrency protection. The acceptance endpoint checks if status is 'sent' inside a serialized lock. If another facility attempts to accept, the server rejects them with HTTP 409 Conflict."),
        ("Q5: What safety rules are enforced in the AI summarization prompt?",
         "The AI must never diagnose medical conditions, must not hallucinate unmentioned symptoms, must not guess coordinates from speech, and requires human confirmation before transmission."),
        ("Q6: How are audio recordings and accident photos protected?",
         "They are stored in private directories outside the public web root. Access requires an authenticated route that verifies the requester is either the patient or an assigned responder."),
        ("Q7: How is data persisted reliably without corrupting db.json?",
         "We use Serialized Atomic File Updates. Saves are chained on a Promise queue so writes execute sequentially. Node writes data to a temporary file (db.tmp.<id>) and then uses atomic fs.renameSync to replace db.json, preventing file corruption if the process terminates mid-write.")
    ]
    for q, a in viva_list:
        pdf.qa(q, a)

    pdf.output("RapidAid_2.0_Project_Guide.pdf")
    print("PDF generated successfully: RapidAid_2.0_Project_Guide.pdf")

if __name__ == "__main__":
    generate_pdf()
