# BotSailer Voice — AI Call Platform (Gemini Edition)

Inbound + outbound AI voice agent. Brain: **Gemini 2.0 Flash** (free tier available).
Voice: **Twilio Polly** (free, included). Calls: **Twilio**.

---

## Cost per call (real numbers)

| Item              | Per minute  |
|-------------------|-------------|
| Twilio inbound    | $0.0085     |
| Twilio outbound   | $0.0140     |
| Gemini 2.0 Flash  | ~$0.0002    |
| Twilio Polly TTS  | $0.00 free  |
| Recording storage | $0.0025     |
| **Total inbound** | **~$0.011** |
| **Total outbound**| **~$0.017** |

Sell to customers at $0.08–0.12/min → 5–7× margin.

---

## Go live in 10 minutes

### 1. Get your free Gemini API key
→ https://aistudio.google.com/app/apikey
Free tier: 1,500 requests/day, no credit card needed.

### 2. Push to GitHub
```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/YOUR_NAME/botsailer-voice.git
git push -u origin main
```

### 3. Deploy on Render
- render.com → New Web Service → connect repo
- Build: `npm install`
- Start: `node server.js`

### 4. Set environment variables on Render

| Key | Value | Get it from |
|-----|-------|-------------|
| TWILIO_ACCOUNT_SID | ACxxxxxxxx | Twilio Console |
| TWILIO_AUTH_TOKEN | your token | Twilio Console |
| TWILIO_PHONE_NUMBER | +1XXXXXXXXXX | Twilio Console |
| GEMINI_API_KEY | AIzaSy... | aistudio.google.com |
| BASE_URL | https://your-app.onrender.com | Render dashboard |
| PORT | 3000 | — |

### 5. Configure Twilio phone number
In Twilio Console → Phone Numbers → your number:
- **Voice webhook:** `https://your-app.onrender.com/twilio/inbound` (POST)
- **Status callback:** `https://your-app.onrender.com/twilio/status` (POST)

### 6. Test
Call your Twilio number. Marina answers immediately.

---

## BotSailer / buzz360.io webhook

Trigger outbound call from your automation:

```
POST https://your-app.onrender.com/api/trigger

{
  "api_key": "your_secret_key",
  "agent_id": "marina",
  "to": "+13054829103",
  "context": {
    "customer_name": "John",
    "intent": "charter_booking"
  }
}
```

---

## Architecture

```
Customer phone
     │
     ▼
Twilio ──► /twilio/inbound
               │
               ▼
        Gemini 2.0 Flash  ◄── system prompt (agent personality)
               │
               ▼
        Twilio Polly TTS (free voice)
               │
               ▼
        SQLite (transcripts, call log)
               │
               ▼
        Live dashboard (/index.html)
```
