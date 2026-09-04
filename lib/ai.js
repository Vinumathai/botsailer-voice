const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// In-memory conversation history per call
const conversations = {};

function getHistory(callId) {
  if (!conversations[callId]) conversations[callId] = [];
  return conversations[callId];
}

function clearHistory(callId) {
  delete conversations[callId];
}

async function getAIResponse(callId, userSpeech, agent) {
  const history = getHistory(callId);

  // Save caller speech to DB
  db.prepare('INSERT INTO transcripts (call_id, role, message) VALUES (?, ?, ?)')
    .run(callId, 'caller', userSpeech);

  // Build Gemini chat history format
  // Gemini uses 'user' and 'model' roles
  const geminiHistory = history.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  // Get Gemini 2.0 Flash model
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: agent.system_prompt,
    generationConfig: {
      maxOutputTokens: 120,
      temperature: 0.7,
    },
  });

  // Start chat with history
  const chat = model.startChat({ history: geminiHistory });

  // Send new user message
  const result = await chat.sendMessage(userSpeech);
  const reply = result.response.text().trim();

  // Update in-memory history
  history.push({ role: 'user', content: userSpeech });
  history.push({ role: 'assistant', content: reply });

  // Save agent reply to DB
  db.prepare('INSERT INTO transcripts (call_id, role, message) VALUES (?, ?, ?)')
    .run(callId, 'agent', reply);

  return reply;
}

// Detect call outcome from conversation
async function detectOutcome(callId) {
  const history = getHistory(callId);
  if (!history.length) return 'no_answer';

  const text = history.map(m => m.content).join(' ').toLowerCase();

  if (text.includes('booked') || text.includes('confirmed') || text.includes('deposit')) return 'booked';
  if (text.includes('transfer') || text.includes('human') || text.includes('escalat')) return 'escalated';
  if (text.includes('voicemail') || text.includes('leave a message')) return 'voicemail';
  if (text.includes('call back') || text.includes('callback')) return 'callback_scheduled';
  if (text.includes('waitlist') || text.includes('not available')) return 'waitlisted';
  if (text.includes('sold') || text.includes('upgraded') || text.includes('membership')) return 'upsold';

  return 'completed';
}

module.exports = { getAIResponse, detectOutcome, clearHistory, getHistory };
