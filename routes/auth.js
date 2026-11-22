const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { HttpError, asyncHandler, signToken, authenticate } = require('../helpers');

const router = express.Router();

function publicUser(u) {
  return { id: u.id, full_name: u.full_name, email: u.email };
}

// POST /api/auth/register  { full_name, email, password }
router.post('/register', asyncHandler(async (req, res) => {
  const full_name = String(req.body.full_name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (full_name.length < 2) throw new HttpError(400, 'Enter your full name');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
  if (password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters');

  const exists = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (exists.rows.length) throw new HttpError(409, 'An account with this email already exists');

  const hash = await bcrypt.hash(password, 10);
  try {
    const r = await query(
      'INSERT INTO users (full_name, email, password_hash) VALUES ($1,$2,$3) RETURNING id, full_name, email',
      [full_name, email, hash]
    );
    const user = r.rows[0];
    res.status(201).json({ token: signToken(user.id), user: publicUser(user) });
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'An account with this email already exists');
    throw err;
  }
}));

// POST /api/auth/login  { email, password }
router.post('/login', asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) throw new HttpError(400, 'Enter your email and password');

  const r = await query('SELECT * FROM users WHERE email = $1', [email]);
  const user = r.rows[0];
  if (!user) throw new HttpError(401, 'Wrong email or password');

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw new HttpError(401, 'Wrong email or password');

  res.json({ token: signToken(user.id), user: publicUser(user) });
}));

// GET /api/auth/me
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const r = await query('SELECT id, full_name, email FROM users WHERE id = $1', [req.userId]);
  if (!r.rows.length) throw new HttpError(401, 'Account not found');
  res.json({ user: r.rows[0] });
}));

module.exports = router;
