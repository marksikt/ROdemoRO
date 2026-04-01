/**
 * ROdemoRO — Transport RO
 * Registrul Auto + Permise de Conducere.
 * Plăcuță format YYYYMMDD-LLL. Fără județ. Placa rămâne la vehicul.
 */

import Fastify  from 'fastify';
import Database from 'better-sqlite3';
import crypto   from 'crypto';
import { requireAuth }  from '../magistrala/auth-server.js';
import { publish, subscribe, alreadyProcessed } from '../../magistrala/event-bus.js';
import { getToken }     from '../../magistrala/auth-server.js';
import { genereazaPlaca, valideazaPlaca } from '../../cnp/inmatriculare.js';

const db = new Database(process.env.DB_PATH || './data/transport.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS vehicule (
    placa          TEXT PRIMARY KEY,
    vin            TEXT UNIQUE,
    marca          TEXT NOT NULL,
    model          TEXT,
    culoare        TEXT,
    an_fabricatie  INTEGER,
    tip            TEXT NOT NULL DEFAULT 'autoturism',
    proprietar_cnp TEXT NOT NULL,
    activ          INTEGER NOT NULL DEFAULT 1,
    creat_la       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS istoricul_vehicule (
    id          TEXT PRIMARY KEY,
    placa       TEXT NOT NULL,
    cnp         TEXT NOT NULL,
    de_la       TEXT NOT NULL,
    pana_la     TEXT,
    pret_lei    REAL
  );

  CREATE TABLE IF NOT EXISTS permise (
    cnp            TEXT PRIMARY KEY,
    categorii      TEXT NOT NULL DEFAULT 'B',
    data_emitere   TEXT NOT NULL,
    data_expirare  TEXT NOT NULL,
    activ          INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS ordine_zi (
    data_zi  TEXT PRIMARY KEY,
    ordine   INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_proprietar ON vehicule(proprietar_cnp);
`);

const app = Fastify({ logger: false });
app.addHook('onRequest', requireAuth);

// ─── Vehicule ──────────────────────────────────────────────────────────────

/**
 * POST /vehicul
 * Înmatriculare vehicul nou. Generează placa YYYYMMDD-LLL.
 */
app.post('/vehicul', async (req, reply) => {
  const { vin, marca, model, culoare, an_fabricatie,
          tip = 'autoturism', proprietar_cnp, data_inmatriculare } = req.body;

  if (!marca || !proprietar_cnp) {
    return reply.status(400).send({ error: 'marca și proprietar_cnp sunt obligatorii' });
  }

  const data = new Date(data_inmatriculare || new Date());
  const dataStr = data.toISOString().slice(0, 10);

  // Alocăm numărul de ordine al zilei
  const ordine = nextOrdineZi(dataStr);
  const placa  = genereazaPlaca(data, ordine);

  db.prepare(`
    INSERT INTO vehicule (placa, vin, marca, model, culoare, an_fabricatie, tip, proprietar_cnp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(placa, vin || null, marca, model || null, culoare || null,
         an_fabricatie || null, tip, proprietar_cnp);

  db.prepare(`
    INSERT INTO istoricul_vehicule (id, placa, cnp, de_la)
    VALUES (?, ?, ?, ?)
  `).run(crypto.randomUUID(), placa, proprietar_cnp, dataStr);

  console.log(`[Transport RO] Înmatriculat: ${placa} → ${proprietar_cnp}`);
  return reply.status(201).send({ placa, proprietar_cnp });
});

/**
 * GET /vehicul/:placa
 */
app.get('/vehicul/:placa', async (req, reply) => {
  const v = valideazaPlaca(req.params.placa);
  if (!v.valid) return reply.status(400).send({ error: v.error });

  const vehicul = db.prepare('SELECT * FROM vehicule WHERE placa = ?').get(req.params.placa);
  if (!vehicul) return reply.status(404).send({ error: 'Vehicul negăsit' });

  const istoricul = db.prepare(
    'SELECT * FROM istoricul_vehicule WHERE placa = ? ORDER BY de_la'
  ).all(req.params.placa);

  return { ...vehicul, istoricul_proprietarilor: istoricul };
});

/**
 * GET /vehicule/:cnp — toate vehiculele unui CNP
 */
app.get('/vehicule/:cnp', async (req) => {
  return db.prepare('SELECT * FROM vehicule WHERE proprietar_cnp = ? AND activ = 1').all(req.params.cnp);
});

/**
 * POST /transfer-auto
 * Transfer proprietate vehicul. Apelat de Agentul Auto.
 * Placa rămâne pe vehicul — doar proprietarul se schimbă.
 */
app.post('/transfer-auto', async (req, reply) => {
  const { placa, cnp_vanzator, cnp_cumparator, pret_lei } = req.body;

  const vehicul = db.prepare('SELECT * FROM vehicule WHERE placa = ?').get(placa);
  if (!vehicul) return reply.status(404).send({ error: 'Vehicul negăsit' });
  if (vehicul.proprietar_cnp !== cnp_vanzator) {
    return reply.status(403).send({ error: 'Vânzătorul nu e proprietarul înregistrat' });
  }

  const acum = new Date().toISOString().slice(0, 10);

  db.transaction(() => {
    db.prepare('UPDATE vehicule SET proprietar_cnp = ? WHERE placa = ?').run(cnp_cumparator, placa);
    db.prepare('UPDATE istoricul_vehicule SET pana_la = ?, pret_lei = ? WHERE placa = ? AND pana_la IS NULL')
      .run(acum, pret_lei || null, placa);
    db.prepare('INSERT INTO istoricul_vehicule (id, placa, cnp, de_la) VALUES (?, ?, ?, ?)')
      .run(crypto.randomUUID(), placa, cnp_cumparator, acum);
  })();

  const jwt = await getToken('transport-ro');
  await publish('transfer_auto', {
    from: 'transport-ro', to: '*',
    cnp: cnp_cumparator,
    payload: { placa, cnp_vanzator, cnp_cumparator, pret_lei, data: acum },
    jwt,
  });

  return { status: 'transferat', placa, noul_proprietar: cnp_cumparator };
});

// ─── Permise de Conducere ─────────────────────────────────────────────────

/**
 * POST /permis
 * Emite permis de conducere. Act de identitate — fără adresă.
 * Kivra primește notificare automată; alerta de expirare e programată.
 */
app.post('/permis', async (req, reply) => {
  const { cnp, categorii = 'B', valabilitate_ani = 10 } = req.body;
  if (!cnp) return reply.status(400).send({ error: 'CNP lipsă' });

  const azi    = new Date();
  const expira = new Date(azi);
  expira.setFullYear(expira.getFullYear() + valabilitate_ani);

  db.prepare(`
    INSERT OR REPLACE INTO permise (cnp, categorii, data_emitere, data_expirare, activ)
    VALUES (?, ?, ?, ?, 1)
  `).run(cnp, categorii, azi.toISOString().slice(0, 10), expira.toISOString().slice(0, 10));

  // Programăm alerta de expirare în Kivra (60 zile înainte)
  const kivraUrl = process.env.KIVRA_URL || 'http://localhost:5005';
  const jwt      = await getToken('transport-ro');
  await fetch(`${kivraUrl}/alerta-expirare`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cnp,
      tip_act: 'Permis de conducere',
      data_expirare: expira.toISOString().slice(0, 10),
      zile_inainte: 60,
    }),
  }).catch(() => {}); // non-blocking în sandbox

  const jwt2 = await getToken('transport-ro');
  await publish('permis_emis', {
    from: 'transport-ro', to: '*',
    cnp,
    payload: { categorii, data_emitere: azi.toISOString().slice(0, 10), data_expirare: expira.toISOString().slice(0, 10) },
    jwt: jwt2,
  });

  return reply.status(201).send({
    cnp,
    categorii,
    data_emitere:  azi.toISOString().slice(0, 10),
    data_expirare: expira.toISOString().slice(0, 10),
    nota: 'Permisul servește ca act de identitate. Nu conține adresă.',
  });
});

/**
 * GET /permis/:cnp
 */
app.get('/permis/:cnp', async (req, reply) => {
  const permis = db.prepare('SELECT * FROM permise WHERE cnp = ? AND activ = 1').get(req.params.cnp);
  if (!permis) return reply.status(404).send({ error: 'Permis negăsit sau inactiv' });
  return permis;
});

// La deces — dezactivare permis
await subscribe('deces', 'transport-ro', async (plic) => {
  if (await alreadyProcessed(plic.id, 'transport-ro')) return;
  db.prepare('UPDATE permise SET activ = 0 WHERE cnp = ?').run(plic.cnp);
  db.prepare('UPDATE vehicule SET activ = 0 WHERE proprietar_cnp = ?').run(plic.cnp);
});

// ─── Utilitare ─────────────────────────────────────────────────────────────

function nextOrdineZi(dataStr) {
  const row = db.prepare('SELECT ordine FROM ordine_zi WHERE data_zi = ?').get(dataStr);
  if (!row) {
    db.prepare('INSERT INTO ordine_zi (data_zi, ordine) VALUES (?, 1)').run(dataStr);
    return 0;
  }
  db.prepare('UPDATE ordine_zi SET ordine = ordine + 1 WHERE data_zi = ?').run(dataStr);
  return row.ordine;
}

app.get('/health', async () => ({
  status: 'ok',
  vehicule: db.prepare('SELECT COUNT(*) as n FROM vehicule').get().n,
  permise:  db.prepare('SELECT COUNT(*) as n FROM permise').get().n,
}));

const PORT = process.env.PORT || 5004;
app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`[Transport RO] Pornit pe :${PORT}`);
