const express = require('express');
const { query } = require('../db');
const {
  DAY_MS, HttpError, round2, parseAmount, parseId, asyncHandler,
  authenticate, withUser, addTx, formatLock, formatGoal, formatTx,
} = require('../helpers');

const router = express.Router();
router.use(authenticate);

const MAX_CATCHUP = 30;

function addPeriod(date, frequency) {
  const d = new Date(date);
  if (frequency === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (frequency === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

// Autosave runs when the user opens the app (free servers sleep, so there is no background timer).
async function processAutosave(client, user) {
  const now = new Date();
  const due = await client.query(
    `SELECT * FROM autosave_rules
      WHERE user_id = $1 AND active = TRUE AND next_run <= $2
      ORDER BY id FOR UPDATE`,
    [user.id, now]
  );
  if (!due.rows.length) return user;

  let grand = 0;
  for (const rule of due.rows) {
    let next = new Date(rule.next_run);
    let runs = 0;
    while (next <= now && runs < MAX_CATCHUP) {
      runs++;
      next = addPeriod(next, rule.frequency);
    }
    if (next <= now) next = addPeriod(now, rule.frequency);

    const total = round2(Number(rule.amount) * runs);
    await client.query('UPDATE autosave_rules SET next_run = $1 WHERE id = $2', [next, rule.id]);
    await addTx(
      client, user.id, 'autosave', 'flex', total,
      'Autosave (' + rule.frequency + ')' + (runs > 1 ? ' x' + runs : '')
    );
    grand += total;
  }

  const r = await client.query(
    'UPDATE users SET flex_balance = flex_balance + $1 WHERE id = $2 RETURNING *',
    [round2(grand), user.id]
  );
  return r.rows[0];
}

// GET /api/wallet/summary
router.get('/summary', asyncHandler(async (req, res) => {
  const data = await withUser(req.userId, async (client, startUser) => {
    const user = await processAutosave(client, startUser);
    const now = new Date();

    const locks = (await client.query(
      `SELECT * FROM safelocks WHERE user_id = $1 AND status = 'active' ORDER BY end_date`,
      [user.id]
    )).rows;

    const goals = (await client.query(
      `SELECT id, name, target_amount, saved_amount,
              to_char(deadline, 'YYYY-MM-DD') AS deadline,
              (deadline - CURRENT_DATE) AS days_left
         FROM goals WHERE user_id = $1 ORDER BY created_at DESC`,
      [user.id]
    )).rows;

    const tx = (await client.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 5',
      [user.id]
    )).rows;

    const flex = Number(user.flex_balance);
    const lockedTotal = round2(locks.reduce((s, l) => s + Number(l.amount), 0));
    const goalsTotal = round2(goals.reduce((s, g) => s + Number(g.saved_amount), 0));

    return {
      user: { id: user.id, full_name: user.full_name, email: user.email },
      total_balance: round2(flex + lockedTotal + goalsTotal),
      wallets: {
        flex: { balance: flex },
        safelock: { total: lockedTotal, count: locks.length },
        goals: { total: goalsTotal, count: goals.length },
      },
      goals: goals.map(formatGoal),
      safelocks: locks.map((l) => formatLock(l, now)),
      recent_transactions: tx.map(formatTx),
    };
  });
  res.json(data);
}));

// POST /api/wallet/deposit  { amount }
router.post('/deposit', asyncHandler(async (req, res) => {
  const amount = parseAmount(req.body.amount);
  const out = await withUser(req.userId, async (client, user) => {
    const r = await client.query(
      'UPDATE users SET flex_balance = flex_balance + $1 WHERE id = $2 RETURNING flex_balance',
      [amount, user.id]
    );
    await addTx(client, user.id, 'deposit', 'flex', amount, 'Deposit to Flex wallet');
    return { flex_balance: Number(r.rows[0].flex_balance) };
  });
  res.json({ message: '$' + amount.toFixed(2) + ' deposited', ...out });
}));

// POST /api/wallet/withdraw  { amount }
router.post('/withdraw', asyncHandler(async (req, res) => {
  const amount = parseAmount(req.body.amount);
  const out = await withUser(req.userId, async (client, user) => {
    if (Number(user.flex_balance) < amount) {
      throw new HttpError(400, 'Not enough money in your Flex wallet');
    }
    const r = await client.query(
      'UPDATE users SET flex_balance = flex_balance - $1 WHERE id = $2 RETURNING flex_balance',
      [amount, user.id]
    );
    await addTx(client, user.id, 'withdraw', 'flex', amount, 'Withdrawal from Flex wallet');
    return { flex_balance: Number(r.rows[0].flex_balance) };
  });
  res.json({ message: '$' + amount.toFixed(2) + ' withdrawn', ...out });
}));

// GET /api/wallet/transactions?limit=100
router.get('/transactions', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const r = await query(
    'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
    [req.userId, limit]
  );
  res.json({ transactions: r.rows.map(formatTx) });
}));

// ---------------- SAFELOCK ----------------

// GET /api/wallet/safelock
router.get('/safelock', asyncHandler(async (req, res) => {
  const r = await query(
    'SELECT * FROM safelocks WHERE user_id = $1 ORDER BY created_at DESC',
    [req.userId]
  );
  const now = new Date();
  res.json({ safelocks: r.rows.map((l) => formatLock(l, now)) });
}));

// POST /api/wallet/safelock  { amount, days }  (30, 60 or 90)
router.post('/safelock', asyncHandler(async (req, res) => {
  const amount = parseAmount(req.body.amount);
  const days = Number(req.body.days);
  if (![30, 60, 90].includes(days)) throw new HttpError(400, 'Choose 30, 60 or 90 days');

  const out = await withUser(req.userId, async (client, user) => {
    if (Number(user.flex_balance) < amount) {
      throw new HttpError(400, 'Not enough money in your Flex wallet. Deposit first.');
    }
    const now = new Date();
    const end = new Date(now.getTime() + days * DAY_MS);

    await client.query('UPDATE users SET flex_balance = flex_balance - $1 WHERE id = $2', [amount, user.id]);
    const r = await client.query(
      `INSERT INTO safelocks (user_id, amount, lock_days, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [user.id, amount, days, now, end]
    );
    await addTx(client, user.id, 'safelock_lock', 'safelock', amount, 'Locked for ' + days + ' days');
    return { safelock: formatLock(r.rows[0], now) };
  });
  res.status(201).json({ message: '$' + amount.toFixed(2) + ' locked for ' + days + ' days', ...out });
}));

// POST /api/wallet/safelock/:id/withdraw  (only after the unlock date)
router.post('/safelock/:id/withdraw', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const out = await withUser(req.userId, async (client, user) => {
    const found = await client.query(
      `SELECT * FROM safelocks WHERE id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`,
      [id, user.id]
    );
    const lock = found.rows[0];
    if (!lock) throw new HttpError(404, 'SafeLock not found');

    const end = new Date(lock.end_date);
    if (new Date() < end) {
      throw new HttpError(400, 'This money is locked until ' + end.toDateString() + '. It cannot be withdrawn early.');
    }

    const principal = Number(lock.amount);
    await client.query(`UPDATE safelocks SET status = 'withdrawn' WHERE id = $1`, [lock.id]);
    const r = await client.query(
      'UPDATE users SET flex_balance = flex_balance + $1 WHERE id = $2 RETURNING flex_balance',
      [principal, user.id]
    );
    await addTx(client, user.id, 'safelock_unlock', 'safelock', principal, 'SafeLock matured, moved to Flex wallet');
    return { paid_out: principal, flex_balance: Number(r.rows[0].flex_balance) };
  });
  res.json({ message: '$' + out.paid_out.toFixed(2) + ' moved to your Flex wallet', ...out });
}));

// ---------------- AUTOSAVE ----------------

// GET /api/wallet/autosave
router.get('/autosave', asyncHandler(async (req, res) => {
  const rules = await withUser(req.userId, async (client, user) => {
    await processAutosave(client, user);
    const r = await client.query(
      'SELECT id, amount, frequency, next_run FROM autosave_rules WHERE user_id = $1 AND active = TRUE ORDER BY id DESC',
      [user.id]
    );
    return r.rows.map((x) => ({
      id: x.id,
      amount: Number(x.amount),
      frequency: x.frequency,
      next_run: x.next_run,
    }));
  });
  res.json({ rules });
}));

// POST /api/wallet/autosave  { amount, frequency }
router.post('/autosave', asyncHandler(async (req, res) => {
  const amount = parseAmount(req.body.amount, 100000);
  const frequency = String(req.body.frequency || '').toLowerCase();
  if (!['daily', 'weekly', 'monthly'].includes(frequency)) {
    throw new HttpError(400, 'Choose daily, weekly or monthly');
  }
  await withUser(req.userId, async (client, user) => {
    await client.query(
      'INSERT INTO autosave_rules (user_id, amount, frequency, next_run) VALUES ($1,$2,$3,$4)',
      [user.id, amount, frequency, new Date()]
    );
    await processAutosave(client, user); // first save runs right away
  });
  res.status(201).json({ message: 'Autosave of $' + amount.toFixed(2) + ' (' + frequency + ') is on' });
}));

// DELETE /api/wallet/autosave/:id
router.delete('/autosave/:id', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const r = await query(
    'UPDATE autosave_rules SET active = FALSE WHERE id = $1 AND user_id = $2 AND active = TRUE',
    [id, req.userId]
  );
  if (!r.rowCount) throw new HttpError(404, 'Rule not found');
  res.json({ message: 'Autosave rule stopped' });
}));

module.exports = router;
