const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'calls.db.json');
let _db = null;

async function getDb() {
  if (_db) return _db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      _db = new SQL.Database(Buffer.from(saved, 'base64'));
    } catch(e) { _db = new SQL.Database(); }
  } else { _db = new SQL.Database(); }

  _db.run(`
    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY, call_sid TEXT, direction TEXT, from_number TEXT,
      to_number TEXT, agent_name TEXT, status TEXT DEFAULT 'initiated',
      duration INTEGER DEFAULT 0, outcome TEXT DEFAULT 'unknown',
      cost REAL DEFAULT 0, recording_url TEXT, recording_sid TEXT,
      customer_id TEXT, created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, role TEXT,
      message TEXT, timestamp TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, role TEXT, direction TEXT,
      language TEXT, voice TEXT DEFAULT 'alloy', greeting TEXT,
      system_prompt TEXT, escalation_number TEXT, active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY, name TEXT, email TEXT, phone TEXT,
      plan TEXT DEFAULT 'starter', credit_balance REAL DEFAULT 0,
      api_key TEXT, webhook_url TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT,
      type TEXT, amount REAL, description TEXT, balance_after REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const count = _db.exec("SELECT COUNT(*) FROM agents");
  if (!count.length || !count[0].values[0][0]) {
    _db.run(`INSERT INTO agents (id,name,role,direction,language,voice,greeting,system_prompt,active) VALUES (?,?,?,?,?,?,?,?,?)`, [
      'marina','Marina','Booking & reservations','both','en','alloy',
      'Hi, this is Marina from SailorPro Fleet. Is this a good moment to chat about your charter booking?',
      `You are Marina, a friendly AI voice agent for SailorPro Fleet. Keep responses SHORT — 1-2 sentences max, this is a phone call. Help customers book charters. Available vessels: 38ft Beneteau ($480/day), 42ft Jeanneau ($620/day), 52ft Lagoon Catamaran ($980/day). All include skipper. 30% deposit to confirm. If customer is angry or asks for human, say you will transfer them.`,
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
    fs.writeFileSync(DB_PATH, Buffer.from(data).toString('base64'), 'utf8');
  } catch(e) {}
}

const db = {
  _instance: null,
  async init() {
    if (!this._instance) this._instance = await getDb();
  },
  prepare(sql) {
    const self = this;
    return {
      run(...params) {
        if (!self._instance) return;
        try {
          let i = 0;
          const s = self._instance.prepare(sql);
          s.run(params);
          s.free();
          save();
        } catch(e) { console.error('DB run error:', e.message, sql); }
      },
      get(...params) {
        if (!self._instance) return null;
        try {
          const s = self._instance.prepare(sql);
          s.bind(params);
          if (s.step()) {
            const cols = s.getColumnNames();
            const row = s.get();
            s.free();
            return Object.fromEntries(cols.map((c,i) => [c, row[i]]));
          }
          s.free();
          return null;
        } catch(e) { return null; }
      },
      all(...params) {
        if (!self._instance) return [];
        try {
          const s = self._instance.prepare(sql);
          s.bind(params);
          const rows = [];
          const cols = s.getColumnNames();
          while (s.step()) {
            const row = s.get();
            rows.push(Object.fromEntries(cols.map((c,i) => [c, row[i]])));
          }
          s.free();
          return rows;
        } catch(e) { return []; }
      }
    };
  },
  exec(sql) { if (!this._instance) return []; return this._instance.exec(sql); }
};

db.init().catch(console.error);
module.exports = db;
