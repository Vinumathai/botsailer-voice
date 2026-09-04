const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'calls.db.json');

let _db = null;

async function getDb() {
  if (_db) return _db;
  const SQL = await initSqlJs();
  
  // Load existing DB or create new
  if (fs.existsSync(DB_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      const buf = Buffer.from(saved, 'base64');
      _db = new SQL.Database(buf);
    } catch(e) {
      _db = new SQL.Database();
    }
  } else {
    _db = new SQL.Database();
  }

  // Create tables
  _db.run(`
    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      call_sid TEXT,
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
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id TEXT,
      role TEXT,
      message TEXT,
      timestamp TEXT DEFAULT (datetime('now'))
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
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed default agent
  const count = _db.exec("SELECT COUNT(*) as c FROM agents")[0];
  const agentCount = count ? count.values[0][0] : 0;
  
  if (agentCount === 0) {
    _db.run(`INSERT INTO agents (id, name, role, direction, language, voice, greeting, system_prompt, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
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
    ]);
  }

  save();
  return _db;
}

function save() {
  if (!_db) return;
  try {
    const data = _db.export();
    const buf = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buf.toString('base64'), 'utf8');
  } catch(e) { /* ignore */ }
}

// Sync-like wrapper for compatibility
const db = {
  _ready: false,
  _instance: null,
  _queue: [],

  async init() {
    this._instance = await getDb();
    this._ready = true;
  },

  prepare(sql) {
    const self = this;
    return {
      run(...params) {
        if (!self._instance) return;
        self._instance.run(sql, params);
        save();
      },
      get(...params) {
        if (!self._instance) return null;
        const res = self._instance.exec(sql.replace(/\?/g, () => {
          const p = params.shift();
          return typeof p === 'string' ? `'${p.replace(/'/g, "''")}'` : p;
        }));
        if (!res.length || !res[0].values.length) return null;
        const cols = res[0].columns;
        const vals = res[0].values[0];
        return Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
      },
      all(...params) {
        if (!self._instance) return [];
        try {
          const res = self._instance.exec(sql.replace(/\?/g, () => {
            const p = params.shift();
            return typeof p === 'string' ? `'${p.replace(/'/g, "''")}'` : p === null ? 'NULL' : p;
          }));
          if (!res.length) return [];
          const cols = res[0].columns;
          return res[0].values.map(vals => Object.fromEntries(cols.map((c, i) => [c, vals[i]])));
        } catch(e) { return []; }
      }
    };
  },

  exec(sql) {
    if (!this._instance) return [];
    return this._instance.exec(sql);
  }
};

// Initialize immediately
db.init().catch(console.error);

module.exports = db;
