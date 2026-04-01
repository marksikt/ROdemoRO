/**
 * ROdemoRO — BankGiro RO
 * Rutare plăți prin CNP. Plătitorul nu știe la ce bancă e destinatarul.
 * Numărul BankGiro e permanent — schimbi banca, BankGiro-ul rămâne.
 */

import Fastify  from 'fastify';
import Database from 'better-sqlite3';
import crypto   from 'crypto';
import { requireAuth } from '../magistrala/auth-server.js';
import { publish }     from '../../magistrala/event-bus.js';
import { getToken }    from '../../magistrala/auth-server.js';

const db = new Database(process.env.DB_PATH || './data/bankgiro.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS conturi (
    cnp          TEXT PRIMARY KEY,
    bankgiro_nr  TEXT NOT NULL UNIQUE,
    sold_lei     REAL NOT NULL DEFAULT 0,
    banca_id     TEXT NOT NULL DEFAULT 'banca-demo',
    activ        INTEGER NOT NULL DEFAULT 1,
    creat_la     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS tranzactii (
    id           TEXT PRIMARY KEY,
    de_la_cnp    TEXT NOT NULL,
    catre_cnp    TEXT NOT NULL,
    suma_lei     REAL NOT NULL,
    motiv        TEXT NOT NULL,
    tip          TEXT NOT NULL DEFAULT 'transfer',
    status       TEXT NOT NULL DEFAULT 'procesat',
    creat_la     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS plati_recurente (
    id           TEXT PRIMARY KEY,
    catre_cnp    TEXT NOT NULL,
    suma_lei     REAL NOT NULL,
    motiv        TEXT NOT NULL,
    zi_lunara    INTEGER NOT NULL DEFAULT 1,
    data_start   TEXT NOT NULL DEFAULT (date('now')),
    data_stop    TEXT,
    activa       INTEGER NOT NULL DEFAULT 1,
    urmatoarea   TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_trz_de_la ON tranzactii(de_la_cnp);
  CREATE INDEX IF NOT EXISTS idx_trz_catre ON tranzactii(catre_cnp);
`);

const app = Fastify({ logger: false });
app.addHook('onRequest', requireAuth);

// ─── Conturi ───────────────────────────────────────────────────────────────

/**
 * Creează cont BankGiro pentru un CNP nou. Apelat de DEPABD la naștere.
 */
app.post('/cont', async (req, reply) => {
  const { cnp } = req.body;
  if (!cnp) return reply.status(400).send({ error: 'CNP lipsă' });

  // Numărul BankGiro e derivat din CNP (deterministc, unic)
  const bgNr = cnpLaBankGiro(cnp);

  try {
    db.prepare(`
      INSERT INTO conturi (cnp, bankgiro_nr, sold_lei)
      VALUES (?, ?, ?)
    `).run(cnp, bgNr, 10000); // sold inițial de demo: 10.000 lei

    return { cnp, bankgiro_nr: bgNr, sold_lei: 10000 };
  } catch {
    return reply.status(409).send({ error: 'Cont existent' });
  }
});

/**
 * GET /cont/:cnp
 */
app.get('/cont/:cnp', async (req, reply) => {
  const cont = db.prepare('SELECT * FROM conturi WHERE cnp = ?').get(req.params.cnp);
  if (!cont) return reply.status(404).send({ error: 'Cont negăsit' });
  return cont;
});

// ─── Plăți ─────────────────────────────────────────────────────────────────

/**
 * POST /plata
 * Transfer simplu între două CNP-uri.
 */
app.post('/plata', async (req, reply) => {
  const { de_la_cnp, catre_cnp, suma_lei, motiv, tip = 'transfer' } = req.body;

  if (suma_lei <= 0) return reply.status(400).send({ error: 'Suma trebuie să fie pozitivă' });

  const platitor = db.prepare('SELECT * FROM conturi WHERE cnp = ? AND activ = 1').get(de_la_cnp);
  if (!platitor) return reply.status(404).send({ error: 'Cont platitor negăsit' });
  if (platitor.sold_lei < suma_lei) return reply.status(422).send({ error: 'Fonduri insuficiente' });

  // Destinatarul — creăm cont dacă nu există (în sandbox)
  let destinatar = db.prepare('SELECT * FROM conturi WHERE cnp = ?').get(catre_cnp);
  if (!destinatar) {
    const bgNr = cnpLaBankGiro(catre_cnp);
    db.prepare('INSERT INTO conturi (cnp, bankgiro_nr, sold_lei) VALUES (?, ?, 0)').run(catre_cnp, bgNr);
    destinatar = db.prepare('SELECT * FROM conturi WHERE cnp = ?').get(catre_cnp);
  }

  // Tranzacție atomică
  const id = crypto.randomUUID();
  const tranzactie = db.transaction(() => {
    db.prepare('UPDATE conturi SET sold_lei = sold_lei - ? WHERE cnp = ?').run(suma_lei, de_la_cnp);
    db.prepare('UPDATE conturi SET sold_lei = sold_lei + ? WHERE cnp = ?').run(suma_lei, catre_cnp);
    db.prepare(`
      INSERT INTO tranzactii (id, de_la_cnp, catre_cnp, suma_lei, motiv, tip)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, de_la_cnp, catre_cnp, suma_lei, motiv, tip);
    return id;
  });

  tranzactie();

  // Eveniment pe magistrală
  const jwt = await getToken('bankgiro');
  await publish('plata_efectuata', {
    from: 'bankgiro', to: '*',
    cnp: de_la_cnp,
    payload: { id, de_la_cnp, catre_cnp, suma_lei, motiv, tip },
    jwt,
  });

  return { id, status: 'procesat', suma_lei, sold_nou: platitor.sold_lei - suma_lei };
});

/**
 * POST /plata-recurenta
 * Programează o plată lunară (alocații, pensii, chirii).
 */
app.post('/plata-recurenta', async (req, reply) => {
  const { catre_cnp, suma_lei, motiv, zi_lunara = 1, data_stop } = req.body;

  const id = crypto.randomUUID();
  const urmatoarea = calculeazaUrmatoarea(zi_lunara);

  db.prepare(`
    INSERT INTO plati_recurente (id, catre_cnp, suma_lei, motiv, zi_lunara, data_stop, urmatoarea)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, catre_cnp, suma_lei, motiv, zi_lunara, data_stop || null, urmatoarea);

  return { id, status: 'programat', prima_plata: urmatoarea };
});

/**
 * POST /plata-recurenta/stop
 * Oprește o plată recurentă (la majorat, la deces etc.).
 */
app.post('/plata-recurenta/stop', async (req) => {
  const { motiv_cnp, data_stop } = req.body;
  db.prepare(`
    UPDATE plati_recurente SET activa = 0, data_stop = ?
    WHERE catre_cnp = ? AND activa = 1
  `).run(data_stop || new Date().toISOString().slice(0, 10), motiv_cnp);
  return { status: 'oprit', cnp: motiv_cnp };
});

/**
 * GET /extras/:cnp
 * Extrasul de cont — ultimele N tranzacții.
 */
app.get('/extras/:cnp', async (req) => {
  const { limit = 20 } = req.query;
  const tranzactii = db.prepare(`
    SELECT * FROM tranzactii
    WHERE de_la_cnp = ? OR catre_cnp = ?
    ORDER BY creat_la DESC LIMIT ?
  `).all(req.params.cnp, req.params.cnp, parseInt(limit));

  const cont = db.prepare('SELECT sold_lei, bankgiro_nr FROM conturi WHERE cnp = ?').get(req.params.cnp);

  return { cnp: req.params.cnp, ...cont, tranzactii };
});

// Procesare plăți recurente — rulat zilnic (la fiecare oră în sandbox)
async function proceseazaRecurente() {
  const azi = new Date().toISOString().slice(0, 10);
  const ziua = new Date().getDate();

  const dePlata = db.prepare(`
    SELECT * FROM plati_recurente
    WHERE activa = 1
    AND zi_lunara = ?
    AND (data_stop IS NULL OR data_stop > ?)
    AND date(urmatoarea) <= date('now')
  `).all(ziua, azi);

  for (const p of dePlata) {
    // Plata din contul statului (CNP special pentru plăți de stat)
    const CNP_STAT = '20000101-000001';
    const id = crypto.randomUUID();

    db.transaction(() => {
      db.prepare('UPDATE conturi SET sold_lei = sold_lei + ? WHERE cnp = ?').run(p.suma_lei, p.catre_cnp);
      db.prepare(`
        INSERT INTO tranzactii (id, de_la_cnp, catre_cnp, suma_lei, motiv, tip)
        VALUES (?, ?, ?, ?, ?, 'beneficiu')
      `).run(id, CNP_STAT, p.catre_cnp, p.suma_lei, p.motiv);
      db.prepare('UPDATE plati_recurente SET urmatoarea = ? WHERE id = ?')
        .run(calculeazaUrmatoarea(p.zi_lunara, new Date()), p.id);
    })();

    console.log(`[BankGiro] Recurentă procesată: ${p.suma_lei} lei → ${p.catre_cnp} (${p.motiv})`);
  }
}

setInterval(proceseazaRecurente, 3600 * 1000);

// ─── Utilitare ─────────────────────────────────────────────────────────────

function cnpLaBankGiro(cnp) {
  // BankGiro derivat determinist din CNP — stabil, unic
  const hash = crypto.createHash('sha256').update(cnp).digest('hex');
  const nr   = parseInt(hash.slice(0, 8), 16) % 100000000;
  return `BG-${nr.toString().padStart(8, '0')}`;
}

function calculeazaUrmatoarea(ziLunara, de_la = new Date()) {
  const d = new Date(de_la);
  d.setDate(ziLunara);
  if (d <= de_la) d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

app.get('/health', async () => ({
  status: 'ok',
  conturi: db.prepare('SELECT COUNT(*) as n FROM conturi').get().n,
  tranzactii: db.prepare('SELECT COUNT(*) as n FROM tranzactii').get().n,
}));

const PORT = process.env.PORT || 5006;
app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`[BankGiro RO] Pornit pe :${PORT}`);
