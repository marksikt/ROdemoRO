/**
 * ROdemoRO — Audit Log
 * Append-only. SHA-256 hash per plic. Non-repudiabil. 10 ani retenție.
 * 
 * Orice mesaj pe magistrală e înregistrat automat — instituțiile nu scriu direct.
 */

import Fastify  from 'fastify';
import crypto   from 'crypto';
import Database from 'better-sqlite3';
import path     from 'path';

const DB_PATH = process.env.AUDIT_DB || path.resolve('./data/audit.db');
const db = new Database(DB_PATH);

// Schema — append-only: niciun UPDATE, niciun DELETE
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    log_ts      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    msg_id      TEXT    NOT NULL,
    msg_ts      TEXT    NOT NULL,
    from_svc    TEXT    NOT NULL,
    to_svc      TEXT    NOT NULL,
    type        TEXT    NOT NULL,
    cnp         TEXT,
    hash_sha256 TEXT    NOT NULL,
    plic_json   TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cnp      ON audit_log(cnp);
  CREATE INDEX IF NOT EXISTS idx_type     ON audit_log(type);
  CREATE INDEX IF NOT EXISTS idx_from_svc ON audit_log(from_svc);
  CREATE INDEX IF NOT EXISTS idx_msg_ts   ON audit_log(msg_ts);
`);

// Trigger care blochează UPDATE și DELETE — imutabilitate garantată la nivel DB
db.exec(`
  CREATE TRIGGER IF NOT EXISTS no_update_audit
    BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'Audit log este imutabil'); END;

  CREATE TRIGGER IF NOT EXISTS no_delete_audit
    BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'Audit log este imutabil'); END;
`);

const insert = db.prepare(`
  INSERT INTO audit_log (msg_id, msg_ts, from_svc, to_svc, type, cnp, hash_sha256, plic_json)
  VALUES (@msg_id, @msg_ts, @from_svc, @to_svc, @type, @cnp, @hash_sha256, @plic_json)
`);

/**
 * Înregistrează un plic în audit log.
 * Apelat automat de event-bus.js la orice publish.
 */
export function record(plic) {
  const json = JSON.stringify(plic);
  const hash = crypto.createHash('sha256').update(json).digest('hex');

  insert.run({
    msg_id:      plic.id    || 'unknown',
    msg_ts:      plic.ts    || new Date().toISOString(),
    from_svc:    plic.from  || 'unknown',
    to_svc:      plic.to    || '*',
    type:        plic.type  || 'unknown',
    cnp:         plic.cnp   || null,
    hash_sha256: hash,
    plic_json:   json,
  });

  return hash;
}

export const auditLog = { record };

// ─── API REST ──────────────────────────────────────────────────────────────

const app = Fastify({ logger: false });

// GET /audit?cnp=...&type=...&from=...&limit=50
app.get('/audit', async (req) => {
  const { cnp, type, from, limit = 50, offset = 0 } = req.query;

  let sql = 'SELECT id, log_ts, msg_id, from_svc, to_svc, type, cnp, hash_sha256 FROM audit_log WHERE 1=1';
  const params = [];

  if (cnp)   { sql += ' AND cnp = ?';      params.push(cnp); }
  if (type)  { sql += ' AND type = ?';     params.push(type); }
  if (from)  { sql += ' AND from_svc = ?'; params.push(from); }

  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(Math.min(parseInt(limit), 1000), parseInt(offset));

  return db.prepare(sql).all(...params);
});

// GET /audit/:id — înregistrare completă cu plic JSON
app.get('/audit/:id', async (req, reply) => {
  const row = db.prepare('SELECT * FROM audit_log WHERE id = ?').get(req.params.id);
  if (!row) return reply.status(404).send({ error: 'Înregistrare negăsită' });
  return { ...row, plic: JSON.parse(row.plic_json) };
});

// GET /audit/verify/:msg_id — verifică integritatea unui mesaj
app.get('/audit/verify/:msg_id', async (req, reply) => {
  const row = db.prepare('SELECT * FROM audit_log WHERE msg_id = ?').get(req.params.msg_id);
  if (!row) return reply.status(404).send({ error: 'Mesaj negăsit' });

  const hashRecalculat = crypto
    .createHash('sha256')
    .update(row.plic_json)
    .digest('hex');

  const integru = hashRecalculat === row.hash_sha256;

  return {
    msg_id:          row.msg_id,
    integru,
    hash_stocat:     row.hash_sha256,
    hash_recalculat: hashRecalculat,
    inregistrat_la:  row.log_ts,
  };
});

// GET /audit/stats — statistici rapide
app.get('/audit/stats', async () => {
  const total  = db.prepare('SELECT COUNT(*) as n FROM audit_log').get().n;
  const tipuri = db.prepare('SELECT type, COUNT(*) as n FROM audit_log GROUP BY type ORDER BY n DESC').all();
  return { total, tipuri };
});

app.get('/health', async () => ({
  status: 'ok',
  total_inregistrari: db.prepare('SELECT COUNT(*) as n FROM audit_log').get().n,
}));

const PORT = process.env.PORT || 4002;
app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`[Audit Log] Pornit pe :${PORT}`);
