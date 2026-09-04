const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const { v4: uuidv4 } = require('uuid');
const db = require('../lib/db');
const { getAIResponse, detectOutcome, clearHistory } = require('../lib/ai');

const VoiceResponse = twilio.twiml.VoiceResponse;

// Helper: build TwiML to say something and gather next speech
function gatherSpeech(text, actionUrl, voice = 'Polly.Joanna') {
  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: actionUrl,
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
  });
  gather.say({ voice }, text);
  // Fallback if no speech detected
  twiml.redirect(actionUrl + '?timeout=1');
  return twiml.toString();
}

// ── INBOUND CALL ─────────────────────────────────────────────────────────────
// Twilio calls this when someone rings your Twilio number
router.post('/inbound', async (req, res) => {
  const callSid = req.body.CallSid;
  const from = req.body.From;
  const to = req.body.To;

  const callId = uuidv4();

  // Get default agent (marina)
  const agent = db.prepare('SELECT * FROM agents WHERE active=1 LIMIT 1').get();
  if (!agent) {
    const twiml = new VoiceResponse();
    twiml.say('Sorry, no agents are available right now. Goodbye.');
    twiml.hangup();
    return res.type('xml').send(twiml.toString());
  }

  // Log call
  db.prepare(`INSERT INTO calls (id, call_sid, direction, from_number, to_number, agent_name, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(callId, callSid, 'inbound', from, to, agent.name, 'in-progress');

  // Store callId mapped to callSid for later
  db.prepare('UPDATE calls SET id=? WHERE call_sid=?').run(callId, callSid);

  const twiml = gatherSpeech(
    agent.greeting,
    `${process.env.BASE_URL}/twilio/respond?callId=${callId}&agentId=${agent.id}`,
    'Polly.Joanna'
  );

  res.type('xml').send(twiml);
});

// ── CONVERSATION TURN ────────────────────────────────────────────────────────
// Called after every speech input from caller
router.post('/respond', async (req, res) => {
  const { callId, agentId } = req.query;
  const speechResult = req.body.SpeechResult || '';
  const timeout = req.query.timeout;

  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(agentId)
    || db.prepare('SELECT * FROM agents WHERE active=1 LIMIT 1').get();

  let replyText;

  if (timeout || !speechResult.trim()) {
    replyText = "Sorry, I didn't catch that. Could you say that again?";
  } else {
    try {
      replyText = await getAIResponse(callId, speechResult, agent);
    } catch (err) {
      console.error('AI error:', err.message);
      replyText = "I'm having a little trouble right now. Let me transfer you to our team.";
    }
  }

  // Check for escalation keywords
  const lower = replyText.toLowerCase();
  if ((lower.includes('transfer') || lower.includes('human')) && agent.escalation_number) {
    const twiml = new VoiceResponse();
    twiml.say({ voice: 'Polly.Joanna' }, replyText);
    twiml.dial(agent.escalation_number);
    db.prepare("UPDATE calls SET outcome='escalated', status='completed' WHERE id=?").run(callId);
    return res.type('xml').send(twiml.toString());
  }

  const twiml = gatherSpeech(
    replyText,
    `${process.env.BASE_URL}/twilio/respond?callId=${callId}&agentId=${agent.id}`,
    'Polly.Joanna'
  );

  res.type('xml').send(twiml);
});

// ── CALL STATUS CALLBACK ─────────────────────────────────────────────────────
router.post('/status', async (req, res) => {
  const { CallSid, CallStatus, CallDuration, RecordingUrl, RecordingSid } = req.body;

  const call = db.prepare('SELECT * FROM calls WHERE call_sid=?').get(CallSid);
  if (!call) return res.sendStatus(200);

  const outcome = await detectOutcome(call.id);
  const cost = ((parseInt(CallDuration) || 0) / 60 * 0.05).toFixed(4);

  db.prepare(`UPDATE calls SET
    status=?, duration=?, outcome=?, cost=?,
    recording_url=?, recording_sid=?, updated_at=CURRENT_TIMESTAMP
    WHERE call_sid=?`).run(
    CallStatus, parseInt(CallDuration) || 0, outcome,
    parseFloat(cost), RecordingUrl || null, RecordingSid || null, CallSid
  );

  clearHistory(call.id);
  res.sendStatus(200);
});

// ── OUTBOUND CALL ─────────────────────────────────────────────────────────────
// Called via webhook or dashboard to start an outbound call
router.post('/outbound', async (req, res) => {
  const { to, agentId, context } = req.body;

  if (!to) return res.status(400).json({ error: 'Missing "to" phone number' });

  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(agentId || 'marina')
    || db.prepare('SELECT * FROM agents WHERE active=1 LIMIT 1').get();

  const callId = uuidv4();

  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    const call = await client.calls.create({
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${process.env.BASE_URL}/twilio/outbound-answer?callId=${callId}&agentId=${agent.id}`,
      statusCallback: `${process.env.BASE_URL}/twilio/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['completed'],
      record: true,
      recordingStatusCallback: `${process.env.BASE_URL}/twilio/recording`,
    });

    db.prepare(`INSERT INTO calls (id, call_sid, direction, from_number, to_number, agent_name, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      callId, call.sid, 'outbound',
      process.env.TWILIO_PHONE_NUMBER, to, agent.name, 'initiated'
    );

    res.json({ success: true, callId, callSid: call.sid });
  } catch (err) {
    console.error('Outbound error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// TwiML for when outbound call is answered
router.post('/outbound-answer', (req, res) => {
  const { callId, agentId } = req.query;
  const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(agentId)
    || db.prepare('SELECT * FROM agents WHERE active=1 LIMIT 1').get();

  const twiml = gatherSpeech(
    agent.greeting,
    `${process.env.BASE_URL}/twilio/respond?callId=${callId}&agentId=${agent.id}`,
    'Polly.Joanna'
  );

  db.prepare("UPDATE calls SET status='in-progress' WHERE id=?").run(callId);
  res.type('xml').send(twiml);
});

// Recording callback
router.post('/recording', (req, res) => {
  const { CallSid, RecordingUrl, RecordingSid } = req.body;
  if (CallSid && RecordingUrl) {
    db.prepare('UPDATE calls SET recording_url=?, recording_sid=? WHERE call_sid=?')
      .run(RecordingUrl + '.mp3', RecordingSid, CallSid);
  }
  res.sendStatus(200);
});

module.exports = router;
