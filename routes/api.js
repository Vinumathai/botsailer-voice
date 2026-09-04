const express = require('express');
const router = express.Router();
const db = require('../lib/db');

// ── CALLS ─────────────────────────────────────────────
router.get('/calls', async (req, res) => {
  const { agent, direction, limit = 50, customer_id } = req.query;
  await db.init();
  let sql = 'SELECT * FROM calls WHERE 1=1';
  const params = [];
  if (agent) { sql += ` AND agent_name='${agent}'`; }
  if (direction) { sql += ` AND direction='${direction}'`; }
  if (customer_id) { sql += ` AND customer_id='${customer_id}'`; }
  sql += ` ORDER BY created_at DESC LIMIT ${parseInt(limit)}`;
  try {
    res.json(db.prepare(sql).all());
  } catch(e) { res.json([]); }
});

router.get('/calls/:id', async (req, res) => {
  await db.init();
  const call = db.prepare('SELECT * FROM calls WHERE id=?').get(req.params.id);
  if (!call) return res.status(404).json({ error: 'Not found' });
  const transcript = db.prepare('SELECT * FROM transcripts WHERE call_id=? ORDER BY timestamp').all(req.params.id);
  res.json({ ...call, transcript });
});

// ── STATS ─────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  await db.init();
  const today = new Date().toISOString().split('T')[0];
  try {
    const todayCalls = db.prepare(`SELECT COUNT(*) as c FROM calls WHERE date(created_at)=?`).get(today) || {c:0};
    const avgDur = db.prepare(`SELECT AVG(duration) as a FROM calls WHERE date(created_at)=? AND duration > 0`).get(today) || {a:0};
    const totalCost = db.prepare(`SELECT SUM(cost) as s FROM calls WHERE date(created_at)=?`).get(today) || {s:0};
    const resolved = db.prepare(`SELECT COUNT(*) as c FROM calls WHERE date(created_at)=? AND outcome IN ('booked','completed','confirmed','upsold')`).get(today) || {c:0};
    const agentStats = db.prepare(`SELECT agent_name, COUNT(*) as total, AVG(duration) as avg_duration, SUM(CASE WHEN outcome IN ('booked','completed','confirmed','upsold') THEN 1 ELSE 0 END) as resolved FROM calls WHERE date(created_at)=? GROUP BY agent_name`).all(today);
    res.json({
      today: {
        calls: todayCalls.c,
        avg_duration: Math.round(avgDur.a || 0),
        cost: (totalCost.s || 0).toFixed(2),
        resolution_rate: todayCalls.c > 0 ? Math.round((resolved.c / todayCalls.c) * 100) : 0,
      },
      agents: agentStats,
    });
  } catch(e) { res.json({ today: {calls:0,avg_duration:0,cost:'0.00',resolution_rate:0}, agents:[] }); }
});

// ── AGENTS ─────────────────────────────────────────────
router.get('/agents', async (req, res) => {
  await db.init();
  try { res.json(db.prepare('SELECT * FROM agents ORDER BY created_at').all()); }
  catch(e) { res.json([]); }
});

router.post('/agents', async (req, res) => {
  await db.init();
  const { id, name, role, direction, language, voice, greeting, system_prompt, escalation_number } = req.body;
  if (!name || !id) return res.status(400).json({ error: 'name and id required' });
  db.prepare(`INSERT OR REPLACE INTO agents (id,name,role,direction,language,voice,greeting,system_prompt,escalation_number) VALUES (?,?,?,?,?,?,?,?,?)`).run(id,name,role,direction,language||'en',voice||'alloy',greeting,system_prompt,escalation_number||null);
  res.json({ success: true });
});

router.patch('/agents/:id', async (req, res) => {
  await db.init();
  const { active } = req.body;
  db.prepare('UPDATE agents SET active=? WHERE id=?').run(active ? 1 : 0, req.params.id);
  res.json({ success: true });
});

// ── TRANSCRIPTS ──────────────────────────────────────
router.get('/transcripts/:callId', async (req, res) => {
  await db.init();
  try { res.json(db.prepare('SELECT * FROM transcripts WHERE call_id=? ORDER BY timestamp').all(req.params.callId)); }
  catch(e) { res.json([]); }
});

// ── CUSTOMERS ────────────────────────────────────────
router.get('/customers', async (req, res) => {
  await db.init();
  try { res.json(db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all()); }
  catch(e) { res.json([]); }
});

router.post('/customers', async (req, res) => {
  await db.init();
  const { id, name, email, phone, plan, credit_balance } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  db.prepare(`INSERT OR REPLACE INTO customers (id,name,email,phone,plan,credit_balance) VALUES (?,?,?,?,?,?)`).run(id,name,email||'',phone||'',plan||'starter',credit_balance||0);
  res.json({ success: true });
});

router.patch('/customers/:id/topup', async (req, res) => {
  await db.init();
  const { amount } = req.body;
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const newBalance = (customer.credit_balance || 0) + parseFloat(amount);
  db.prepare('UPDATE customers SET credit_balance=? WHERE id=?').run(newBalance, req.params.id);
  res.json({ success: true, new_balance: newBalance });
});

// ── BUZZ360 / BOTSAILER WEBHOOK ──────────────────────
// This endpoint receives triggers FROM buzz360.io / BotSailer
// Add this URL in your BotSailer automation as the webhook action
router.post('/webhook/botsailer', async (req, res) => {
  const { api_key, event, customer_id, phone, agent_id, context } = req.body;

  // Validate API key
  if (process.env.API_KEY && api_key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  // Log the incoming event
  console.log(`[BotSailer webhook] event=${event} customer=${customer_id} phone=${phone}`);

  if (event === 'trigger_call' || event === 'outbound_call') {
    // Trigger outbound call
    try {
      const twilio = require('twilio');
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const { v4: uuidv4 } = require('uuid');
      const callId = uuidv4();

      await db.init();
      const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(agent_id || 'marina')
        || db.prepare('SELECT * FROM agents WHERE active=1 LIMIT 1').get();

      const call = await client.calls.create({
        to: phone,
        from: process.env.TWILIO_PHONE_NUMBER,
        url: `${process.env.BASE_URL}/twilio/outbound-answer?callId=${callId}&agentId=${agent.id}`,
        statusCallback: `${process.env.BASE_URL}/twilio/status`,
        statusCallbackMethod: 'POST',
        record: true,
      });

      db.prepare(`INSERT INTO calls (id,call_sid,direction,from_number,to_number,agent_name,status,customer_id) VALUES (?,?,?,?,?,?,?,?)`).run(callId, call.sid, 'outbound', process.env.TWILIO_PHONE_NUMBER, phone, agent.name, 'initiated', customer_id || null);

      res.json({ success: true, call_id: callId, call_sid: call.sid });
    } catch(err) {
      console.error('Outbound call error:', err.message);
      res.status(500).json({ error: err.message });
    }
  } else if (event === 'message_received') {
    // WhatsApp message received in BotSailer — log it
    res.json({ success: true, message: 'Event logged' });
  } else {
    res.json({ success: true, message: 'Event received' });
  }
});

// ── OUTBOUND TRIGGER (legacy) ─────────────────────────
router.post('/trigger', async (req, res) => {
  // Forward to webhook handler
  req.body.event = 'trigger_call';
  return router.handle(Object.assign(req, { url: '/webhook/botsailer', path: '/webhook/botsailer' }), res, () => {});
});

module.exports = router;
