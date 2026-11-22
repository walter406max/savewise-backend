const express = require('express');
const { query } = require('../db');
const {
  FLEX_RATE, LOCK_RATE, DAY_MS, HttpError, round2, parseAmount, parseId,
  asyncHandler, authenticate, withUser, addTx, flexPending, settleFlex,
  lockPending, formatLock, formatGoal, formatTx,
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

// Autosave runs "lazily": whenever you open the app, any rule that is due
// is executed (free Render servers sleep, so no background timer is possible).
async function processAutosave(client, user) {
  const now = new Date();
  const due = await client.query(
    `SELECT * FROM autosave_rules
      WHERE user_id = $1 AND active = TRUE AND next_run <= $2
      ORDER BY id FOR UPDATE`,
    [user.id, now]
  );
  if (!due.rows.length) return user;

  const settled = await settleFlex(client, user, true);
  const u = settled.user;
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
      client, u.id, 'autosave', 'flex', total,
      'Autosave (' + rule.frequency + ')' + (runs > 1 ? ' x' + runs : '')
    );
    grand += total;
  }

  const r = await client.query(
    'UPDATE users SET flex_balance = flex_balance + $1 WHERE id = $2 RETURNING *',
    [round2(grand), u.id]
  );
  return r.rows[0];
}

// GET /api/wallet/summary  -> everything the dashboard needs
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
    const flexInterest = flexPending(user, now);
    const lockInterest = round2(locks.reduce((s, l) => s + lockPending(l, now), 0));

    return {
      user: { id: user.id, full_name: user.full_name, email: user.email },
      total_balance: round2(flex + lockedTotal + goalsTotal),
      total_interest: Number(user.total_interest),
      pending_interest: round2(flexInterest + lockInterest),
      wallets: {
        flex: { balance: flex, rate: FLEX_RATE, pending_interest: flexInterest },
        safelock: { total: lockedTotal, count: locks.length, rate: LOCK_RATE, pending_interest: lockInterest },
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
    const settled = await settleFlex(client, user, true);
    const r = await client.query(
      'UPDATE users SET flex_balance = flex_balance + $1 WHERE id = $2 RETURNING flex_balance',
      [amount, settled.user.id]
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
    const settled = await settleFlex(client, user, true);
    if (Number(settled.user.flex_balance) < amount) {
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

// POST /api/wallet/claim-interest  -> adds Flex + SafeLock interest to Flex wallet
router.post('/claim-interest', asyncHandler(async (req, res) => {
  const out = await withUser(req.userId, async (client, user) => {
    const now = new Date();
    const settled = await settleFlex(client, user, false);
    let u = settled.user;

    const locks = (await client.query(
      `SELECT * FROM safelocks WHERE user_id = $1 AND status = 'active' FOR UPDATE`,
      [u.id]
    )).rows;

    let lockTotal = 0;
    for (const lock of locks) {
      const interest = lockPending(lock, now);
      if (interest >= 0.01) {
        await client.query(
          'UPDATE safelocks SET interest_earned = interest_earned + $1, last_claim = $2 WHERE id = $3',
          [interest, now, lock.id]
        );
        lockTotal = round2(lockTotal + interest);
      }
    }

    if (lockTotal >= 0.01) {
      const r = await client.query(
        `UPDATE users
           SET flex_balance = flex_balance + $1, total_interest = total_interest + $1
         WHERE id = $2 RETURNING *`,
        [lockTotal, u.id]
      );
      u = r.rows[0];
      await addTx(client, u.id, 'interest', 'safelock', lockTotal, 'SafeLock interest (' + LOCK_RATE + '% p.a.)');
    }

    const total = round2(settled.credited + lockTotal);
    if (total < 0.01) {
      throw new HttpError(400, 'No interest to claim yet. It grows every day, check back soon!');
    }
    return {
      claimed: total,
      flex_balance: Number(u.flex_balance),
      total_interest: Number(u.total_interest),
    };
  });
  res.json({ message: '$' + out.claimed.toFixed(2) + ' interest added to your Flex wallet', ...out });
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
  res.json({ rate: LOCK_RATE, safelocks: r.rows.map((l) => formatLock(l, now)) });
}));

// POST /api/wallet/safelock  { amount, days }  (days = 30, 60 or 90)
router.post('/safelock', asyncHandler(async (req, res) => {
  const amount = parseAmount(req.body.amount);
  const days = Number(req.body.days);
  if (![30, 60, 90].includes(days)) throw new HttpError(400, 'Choose 30, 60 or 90 days');

  const out = await withUser(req.userId, async (client, user) => {
    const settled = await settleFlex(client, user, true);
    if (Number(settled.user.flex_balance) < amount) {
      throw new HttpError(400, 'Not enough money in your Flex wallet. Deposit first.');
    }
    const now = new Date();
    const end = new Date(now.getTime() + days * DAY_MS);

    await client.query('UPDATE users SET flex_balance = flex_balance - $1 WHERE id = $2', [amount, user.id]);
    const r = await client.query(
      `INSERT INTO safelocks (user_id, amount, rate, lock_days, start_date, end_date, last_claim)
       VALUES ($1,$2,$3,$4,$5,$6,$5) RETURNING *`,
      [user.id, amount, LOCK_RATE, days, now, end]
    );
    await addTx(client, user.id, 'safelock_lock', 'safelock', amount, 'Locked for ' + days + ' days');
    return { safelock: formatLock(r.rows[0], now) };
  });
  res.status(201).json({ message: '$' + amount.toFixed(2) + ' locked for ' + days + ' days', ...out });
}));

// POST /api/wallet/safelock/:id/withdraw  -> only works after the lock date
router.post('/safelock/:id/withdraw', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const out = await withUser(req.userId, async (client, user) => {
    const found = await client.query(
      `SELECT * FROM safelocks WHERE id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`,
      [id, user.id]
    );
    const lock = found.rows[0];
    if (!lock) throw new HttpError(404, 'SafeLock not found');

    const now = new Date();
    const end = new Date(lock.end_date);
    if (now < end) {
      throw new HttpError(400, 'This money is locked until ' + end.toDateString() + '. You cannot withdraw early.');
    }

    const interest = lockPending(lock, now);
    const principal = Number(lock.amount);

    await settleFlex(client, user, true);
    await client.query(
      `UPDATE safelocks
         SET status = 'withdrawn', interest_earned = interest_earned + $1, last_claim = $2
       WHERE id = $3`,
      [interest, now, lock.id]
    );
    const r = await client.query(
      `UPDATE users
         SET flex_balance = flex_balance + $1, total_interest = total_interest + $2
       WHERE id = $3 RETURNING flex_balance`,
      [round2(principal + interest), interest, user.id]
    );
    await addTx(client, user.id, 'safelock_unlock', 'safelock', principal, 'SafeLock matured, moved to Flex wallet');
    if (interest >= 0.01) {
      await addTx(client, user.id, 'interest', 'safelock', interest, 'SafeLock interest (' + LOCK_RATE + '% p.a.)');
    }
    return { paid_out: round2(principal + interest), flex_balance: Number(r.rows[0].flex_balance) };
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

// POST /api/wallet/autosave  { amount, frequency }  (daily | weekly | monthly)
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
    await processAutosave(client, user); // first save happens right away
  });
  res.status(201).json({ message: 'Autosave of $' + amount.toFixed(2) + ' (' + frequency + ') is on' });
}));

// DELETE /api/wallet/autosave/:id  -> stop a rule
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
