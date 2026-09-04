const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const twilio = require('twilio');

// ── CALLS ────────────────────────────────────────────────────────────────────
router.get('/calls', (req, res) => {
  const { agent, direction, limit = 50 } = req.query;
  let query = 'SELECT * FROM calls WHERE 1=1';
  const params = [];
  if (agent) { query += ' AND agent_name=?'; params.push(agent); }
  if (direction) { query += ' AND direction=?'; params.push(direction); }
  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(parseInt(limit));
  res.json(db.prepare(query).all(...params));
});

router.get('/calls/:id', (req, res) => {
  const call = db.prepare('SELECT * FROM calls WHERE id=?').get(req.params.id);
  if (!call) return res.status(404).json({ error: 'Not found' });
  const transcript = db.prepare('SELECT * FROM transcripts WHERE call_id=? ORDER BY timestamp').all(req.params.id);
  res.json({ ...call, transcript });
});

// ── STATS ────────────────────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  const todayCalls = db.prepare(`SELECT COUNT(*) as c FROM calls WHERE date(created_at)=?`).get(today);
  const avgDur = db.prepare(`SELECT AVG(duration) as a FROM calls WHERE date(created_at)=? AND duration > 0`).get(today);
  const totalCost = db.prepare(`SELECT SUM(cost) as s FROM calls WHERE date(created_at)=?`).get(today);
  const resolved = db.prepare(`SELECT COUNT(*) as c FROM calls WHERE date(created_at)=? AND outcome IN ('booked','completed','confirmed','upsold')`).get(today);

  const agentStats = db.prepare(`
    SELECT agent_name,
      COUNT(*) as total,
      AVG(duration) as avg_duration,
      SUM(CASE WHEN outcome IN ('booked','completed','confirmed','upsold') THEN 1 ELSE 0 END) as resolved
    FROM calls WHERE date(created_at)=? GROUP BY agent_name`).all(today);

  // 7-day chart
  const weekData = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as calls
    FROM calls
    WHERE created_at >= date('now','-6 days')
    GROUP BY date(created_at)
    ORDER BY day`).all();

  res.json({
    today: {
      calls: todayCalls.c,
      avg_duration: Math.round(avgDur.a || 0),
      cost: (totalCost.s || 0).toFixed(2),
      resolution_rate: todayCalls.c > 0 ? Math.round((resolved.c / todayCalls.c) * 100) : 0,
    },
    agents: agentStats,
    week: weekData,
  });
});

// ── AGENTS ───────────────────────────────────────────────────────────────────
router.get('/agents', (req, res) => {
  res.json(db.prepare('SELECT * FROM agents ORDER BY created_at').all());
});

router.post('/agents', (req, res) => {
  const { id, name, role, direction, language, voice, greeting, system_prompt, escalation_number } = req.body;
  if (!name || !id) return res.status(400).json({ error: 'name and id required' });
  db.prepare(`INSERT OR REPLACE INTO agents (id, name, role, direction, language, voice, greeting, system_prompt, escalation_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, name, role, direction, language || 'en', voice || 'alloy', greeting, system_prompt, escalation_number || null);
  res.json({ success: true });
});

router.patch('/agents/:id', (req, res) => {
  const { active } = req.body;
  db.prepare('UPDATE agents SET active=? WHERE id=?').run(active ? 1 : 0, req.params.id);
  res.json({ success: true });
});

// ── TRANSCRIPTS ───────────────────────────────────────────────────────────────
router.get('/transcripts/:callId', (req, res) => {
  const rows = db.prepare('SELECT * FROM transcripts WHERE call_id=? ORDER BY timestamp').all(req.params.callId);
  res.json(rows);
});

// ── OUTBOUND TRIGGER (webhook from BotSailer) ─────────────────────────────────
router.post('/trigger', async (req, res) => {
  const { api_key, agent_id, to, language, context } = req.body;

  // Simple API key check (set your key in .env)
  if (api_key !== process.env.API_KEY && process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  // Forward to outbound route
  try {
    const response = await fetch(`${process.env.BASE_URL}/twilio/outbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, agentId: agent_id, context }),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
