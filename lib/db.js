const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'calls.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    call_sid TEXT UNIQUE,
    direction TEXT,
    from_number TEXT,
    to_number TEXT,
    agent_name TEXT,
    status TEXT DEFAULT 'initiated',
    duration INTEGER DEFAULT 0,
    outcome TEXT DEFAULT 'unknown',
    cost REAL DEFAULT 0,
    recording_url TEXT,
    recording_sid TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS transcripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT,
    role TEXT,
    message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (call_id) REFERENCES calls(id)
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT,
    role TEXT,
    direction TEXT,
    language TEXT,
    voice TEXT DEFAULT 'alloy',
    greeting TEXT,
    system_prompt TEXT,
    escalation_number TEXT,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed default agent if none exist
const agentCount = db.prepare('SELECT COUNT(*) as c FROM agents').get();
if (agentCount.c === 0) {
  db.prepare(`INSERT INTO agents (id, name, role, direction, language, voice, greeting, system_prompt, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'marina',
    'Marina',
    'Booking & reservations',
    'both',
    'en',
    'alloy',
    'Hi, this is Marina from SailorPro Fleet. Is this a good moment to chat about your charter booking?',
    `You are Marina, a friendly AI voice agent for SailorPro Fleet — a boat charter and sailing platform.
Your job is to help customers book charters, answer questions about the fleet, and take deposit payments.
Keep responses SHORT — this is a phone call, not a chat. One or two sentences max per turn.
Always confirm: charter type, date, number of guests, and price before ending.
If a customer is angry or asks for a human, say you will transfer them immediately.
Available vessels: 38ft Beneteau ($480/day), 42ft Jeanneau ($620/day), 52ft Lagoon Catamaran ($980/day).
Deposit is 30% — send SMS payment link after confirmation.`,
    1
  );
}

module.exports = db;
