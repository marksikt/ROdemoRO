/**
 * ROdemoRO — Kivra RO
 * Cutia poștală digitală oficială. Orice act oficial ajunge aici.
 * Notificări automate la expirarea actelor.
 */

import Fastify  from 'fastify';
import Database from 'better-sqlite3';
import crypto   from 'crypto';
import { requireAuth } from '../magistrala/auth-server.js';

const db = new Database(process.env.DB_PATH || './data/kivra.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS mesaje (
    id          TEXT PRIMARY KEY,
    catre_cnp   TEXT    NOT NULL,
    de_la       TEXT    NOT NULL,
    subiect     TEXT    NOT NULL,
    corp        TEXT    NOT NULL,
    tip         TEXT    NOT NULL DEFAULT 'general',
    citit       INTEGER NOT NULL DEFAULT 0,
    creat_la    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    actiune_url TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_catre ON mesaje(catre_cnp, citit);
  CREATE INDEX IF NOT EXISTS idx_tip   ON mesaje(tip);

  CREATE TABLE IF NOT EXISTS alerte_expirare (
    cnp         TEXT NOT NULL,
    tip_act     TEXT NOT NULL,
    data_expir  TEXT NOT NULL,
    zile_inainte INTEGER NOT NULL DEFAULT 60,
    trimis      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (cnp, tip_act)
  );
`);

const app = Fastify({ logger: false });
app.addHook('onRequest', requireAuth);

// ─── Trimitere mesaje ──────────────────────────────────────────────────────

/**
 * POST /send
 * Trimite un mesaj în cutia unui cetățean.
 */
app.post('/send', async (req, reply) => {
  const { catre_cnp, subiect, corp, tip = 'general', actiune_url } = req.body;

  if (!catre_cnp || !subiect || !corp) {
    return reply.status(400).send({ error: 'catre_cnp, subiect și corp sunt obligatorii' });
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO mesaje (id, catre_cnp, de_la, subiect, corp, tip, actiune_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, catre_cnp, req.caller.sub, subiect, corp, tip, actiune_url || null);

  return { id, status: 'livrat' };
});

// ─── Inbox ─────────────────────────────────────────────────────────────────

/**
 * GET /inbox/:cnp
 * Lista mesajelor. Parametru ?necitite=true pentru doar necitite.
 */
app.get('/inbox/:cnp', async (req) => {
  const { cnp } = req.params;
  const { necitite, tip, limit = 50, offset = 0 } = req.query;

  let sql = 'SELECT id, de_la, subiect, tip, citit, creat_la, actiune_url FROM mesaje WHERE catre_cnp = ?';
  const params = [cnp];

  if (necitite === 'true') { sql += ' AND citit = 0'; }
  if (tip)                 { sql += ' AND tip = ?'; params.push(tip); }

  sql += ' ORDER BY creat_la DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const mesaje = db.prepare(sql).all(...params);
  const total  = db.prepare('SELECT COUNT(*) as n FROM mesaje WHERE catre_cnp = ?').get(cnp).n;
  const necit  = db.prepare('SELECT COUNT(*) as n FROM mesaje WHERE catre_cnp = ? AND citit = 0').get(cnp).n;

  return { cnp, total, necitite: necit, mesaje };
});

/**
 * GET /mesaj/:id
 * Conținutul complet al unui mesaj. Marchează ca citit.
 */
app.get('/mesaj/:id', async (req, reply) => {
  const mesaj = db.prepare('SELECT * FROM mesaje WHERE id = ?').get(req.params.id);
  if (!mesaj) return reply.status(404).send({ error: 'Mesaj negăsit' });

  db.prepare('UPDATE mesaje SET citit = 1 WHERE id = ?').run(req.params.id);

  return mesaj;
});

// ─── Alerte expirare acte ─────────────────────────────────────────────────

/**
 * POST /alerta-expirare
 * Înregistrează o alertă de expirare pentru un act (CI, permis, etc.).
 * Serviciul de alertare verifică zilnic și trimite notificări.
 */
app.post('/alerta-expirare', async (req) => {
  const { cnp, tip_act, data_expirare, zile_inainte = 60 } = req.body;

  db.prepare(`
    INSERT OR REPLACE INTO alerte_expirare (cnp, tip_act, data_expir, zile_inainte, trimis)
    VALUES (?, ?, ?, ?, 0)
  `).run(cnp, tip_act, data_expirare, zile_inainte);

  return { status: 'înregistrat', cnp, tip_act, data_expirare };
});

/**
 * Verificare zilnică — apelat de un cron job (sau la pornire în sandbox).
 * Trimite notificări pentru acte care expiră în curând.
 */
export async function verificaAlerte() {
  const azi = new Date();

  const alerte = db.prepare(`
    SELECT * FROM alerte_expirare
    WHERE trimis = 0
    AND date(data_expir, '-' || zile_inainte || ' days') <= date('now')
    AND date(data_expir) > date('now')
  `).all();

  for (const alerta of alerte) {
    const expira = new Date(alerta.data_expir);
    const zile   = Math.round((expira - azi) / (24 * 3600 * 1000));

    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO mesaje (id, catre_cnp, de_la, subiect, corp, tip)
      VALUES (?, ?, 'kivra-sistem', ?, ?, 'expirare')
    `).run(
      id,
      alerta.cnp,
      `${alerta.tip_act} expiră în ${zile} zile`,
      `Actul tău de tip "${alerta.tip_act}" expiră pe ${alerta.data_expir}.\n` +
      `Mai ai ${zile} zile să îl reînnoiești.\n\n` +
      `Poți iniția reînnoirea direct din portalul cetățean.`,
    );

    db.prepare('UPDATE alerte_expirare SET trimis = 1 WHERE cnp = ? AND tip_act = ?')
      .run(alerta.cnp, alerta.tip_act);

    console.log(`[Kivra] Alertă expirare trimisă: ${alerta.cnp} — ${alerta.tip_act} (${zile} zile)`);
  }

  return alerte.length;
}

// Verificare zilnică în sandbox (la fiecare oră)
setInterval(verificaAlerte, 3600 * 1000);
verificaAlerte();

app.get('/health', async () => ({
  status: 'ok',
  total_mesaje: db.prepare('SELECT COUNT(*) as n FROM mesaje').get().n,
}));

const PORT = process.env.PORT || 5005;
app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`[Kivra RO] Pornit pe :${PORT}`);
