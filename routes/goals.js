const express = require('express');
const {
  HttpError, round2, parseAmount, parseId, asyncHandler, authenticate,
  withUser, addTx, formatGoal,
} = require('../helpers');

const router = express.Router();
router.use(authenticate);

const GOAL_COLUMNS = `id, name, target_amount, saved_amount,
  to_char(deadline, 'YYYY-MM-DD') AS deadline,
  (deadline - CURRENT_DATE) AS days_left`;

// GET /api/goals
router.get('/', asyncHandler(async (req, res) => {
  const out = await withUser(req.userId, async (client, user) => {
    const r = await client.query(
      'SELECT ' + GOAL_COLUMNS + ' FROM goals WHERE user_id = $1 ORDER BY created_at DESC',
      [user.id]
    );
    return { goals: r.rows.map(formatGoal), flex_balance: Number(user.flex_balance) };
  });
  res.json(out);
}));

// POST /api/goals  { name, target_amount, deadline: "YYYY-MM-DD" }
router.post('/', asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const target = parseAmount(req.body.target_amount, 100000000);
  const deadline = String(req.body.deadline || '').trim();

  if (name.length < 2 || name.length > 100) throw new HttpError(400, 'Give your goal a name');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || isNaN(new Date(deadline + 'T00:00:00Z'))) {
    throw new HttpError(400, 'Choose a valid deadline date');
  }
  if (new Date(deadline + 'T00:00:00Z') <= new Date()) {
    throw new HttpError(400, 'Deadline must be a future date');
  }

  const goal = await withUser(req.userId, async (client, user) => {
    const r = await client.query(
      `INSERT INTO goals (user_id, name, target_amount, deadline)
       VALUES ($1,$2,$3,$4)
       RETURNING ${GOAL_COLUMNS}`,
      [user.id, name, target, deadline]
    );
    return formatGoal(r.rows[0]);
  });
  res.status(201).json({ message: 'Goal created', goal });
}));

// POST /api/goals/:id/deposit  { amount }  (money comes from the Flex wallet)
router.post('/:id/deposit', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const amount = parseAmount(req.body.amount);

  const out = await withUser(req.userId, async (client, user) => {
    const found = await client.query(
      'SELECT * FROM goals WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [id, user.id]
    );
    const goal = found.rows[0];
    if (!goal) throw new HttpError(404, 'Goal not found');

    const left = round2(Number(goal.target_amount) - Number(goal.saved_amount));
    if (left <= 0) throw new HttpError(400, 'This goal is already complete');
    if (amount > left) {
      throw new HttpError(400, 'You only need $' + left.toFixed(2) + ' more to reach this goal');
    }
    if (Number(user.flex_balance) < amount) {
      throw new HttpError(400, 'Not enough money in your Flex wallet. Deposit first.');
    }

    const w = await client.query(
      'UPDATE users SET flex_balance = flex_balance - $1 WHERE id = $2 RETURNING flex_balance',
      [amount, user.id]
    );
    await client.query('UPDATE goals SET saved_amount = saved_amount + $1 WHERE id = $2', [amount, goal.id]);
    await addTx(client, user.id, 'goal_deposit', 'goal', amount, 'Saved to goal: ' + goal.name);

    const g = await client.query('SELECT ' + GOAL_COLUMNS + ' FROM goals WHERE id = $1', [goal.id]);
    return { goal: formatGoal(g.rows[0]), flex_balance: Number(w.rows[0].flex_balance) };
  });
  res.json({ message: '$' + amount.toFixed(2) + ' added to your goal', ...out });
}));

// DELETE /api/goals/:id  (saved money returns to the Flex wallet)
router.delete('/:id', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const out = await withUser(req.userId, async (client, user) => {
    const found = await client.query(
      'SELECT * FROM goals WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [id, user.id]
    );
    const goal = found.rows[0];
    if (!goal) throw new HttpError(404, 'Goal not found');

    const saved = Number(goal.saved_amount);
    if (saved > 0) {
      await client.query('UPDATE users SET flex_balance = flex_balance + $1 WHERE id = $2', [saved, user.id]);
      await addTx(client, user.id, 'goal_refund', 'goal', saved, 'Goal removed: ' + goal.name);
    }
    await client.query('DELETE FROM goals WHERE id = $1', [goal.id]);
    return { refunded: saved };
  });
  res.json({ message: 'Goal removed', ...out });
}));

module.exports = router;
