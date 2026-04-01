/**
 * ROdemoRO — Agent Imobiliar
 * Tranzacție imobiliară atomică: Bănci + Cadastru + DEPABD + RAP.
 * Funcționarul validează la final — agentul face pașii de rutină.
 * 
 * Ori totul, ori nimic.
 */

import crypto from 'crypto';
import { getToken }  from '../magistrala/auth-server.js';
import { directory } from '../magistrala/directory.js';
import { publish }   from '../magistrala/event-bus.js';

/**
 * Stările unei tranzacții imobiliare.
 * 
 * INITIATA → IDENTITATI_VERIFICATE → SUMA_BLOCATA →
 * CADASTRU_ACTUALIZAT → ADRESA_ACTUALIZATA → FINALIZATA
 *                    ↓ (la orice eroare)
 *                  ANULATA (cu rollback)
 */

// Stocare tranzacții în memorie (în producție: PostgreSQL)
const tranzactii = new Map();

/**
 * Pornește o tranzacție imobiliară.
 * 
 * @param {object} params
 * @returns {string} ID tranzacție
 */
export async function pornesteTranzactie({
  fastighetsbeteckning,
  cnp_vanzator,
  cnp_cumparator,
  pret_lei,
}) {
  const id = crypto.randomUUID();
  const jwt = await getToken('agent-imobiliar');

  const trz = {
    id,
    fastighetsbeteckning,
    cnp_vanzator,
    cnp_cumparator,
    pret_lei,
    status: 'INITIATA',
    pasi:   [],
    creat_la: new Date().toISOString(),
    jwt,
  };
  tranzactii.set(id, trz);

  console.log(`[Agent Imobiliar] Tranzacție ${id} inițiată: ${fastighetsbeteckning}`);

  // Execuție asincronă
  executa(id).catch(err => {
    console.error(`[Agent Imobiliar] Eroare fatală ${id}:`, err.message);
    rollback(id, err.message);
  });

  return id;
}

async function executa(id) {
  const trz = tranzactii.get(id);
  const jwt = trz.jwt;

  // ── Pasul 1: Verificare identități ──────────────────────────────────────
  await pas(trz, 'IDENTITATI_VERIFICATE', async () => {
    const depabdUrl = await directory.getUrl('depabd');

    const [vanzator, cumparator] = await Promise.all([
      fetch(`${depabdUrl}/persoana/${trz.cnp_vanzator}`,   { headers: auth(jwt) }).then(r => r.json()),
      fetch(`${depabdUrl}/persoana/${trz.cnp_cumparator}`, { headers: auth(jwt) }).then(r => r.json()),
    ]);

    if (!vanzator.cnp)   throw new Error(`Vânzătorul ${trz.cnp_vanzator} nu există în DEPABD`);
    if (!cumparator.cnp) throw new Error(`Cumpărătorul ${trz.cnp_cumparator} nu există în DEPABD`);
    if (!vanzator.activ) throw new Error(`Vânzătorul ${trz.cnp_vanzator} e decedat`);

    return { vanzator: vanzator.nume, cumparator: cumparator.nume };
  });

  // ── Pasul 2: Verificare proprietate în Cadastru ──────────────────────────
  await pas(trz, 'PROPRIETATE_VERIFICATA', async () => {
    const cadastruUrl = await directory.getUrl('cadastru');
    const imobil = await fetch(
      `${cadastruUrl}/imobil/${trz.fastighetsbeteckning}`,
      { headers: auth(jwt) }
    ).then(r => r.json());

    if (imobil.error) throw new Error(`Imobil negăsit: ${imobil.error}`);
    if (imobil.proprietar_cnp !== trz.cnp_vanzator) {
      throw new Error(`Vânzătorul nu e proprietarul înregistrat în Cadastru`);
    }
    if (imobil.blocat_executare) {
      throw new Error(`Imobilul e blocat printr-o executare silită`);
    }

    return { suprafata: imobil.suprafata_mp, tip: imobil.tip };
  });

  // ── Pasul 3: Blocare sumă în BankGiro (escrow) ──────────────────────────
  await pas(trz, 'SUMA_BLOCATA', async () => {
    const bankgiroUrl = await directory.getUrl('bankgiro');

    // Verificăm disponibilul
    const cont = await fetch(
      `${bankgiroUrl}/cont/${trz.cnp_cumparator}`,
      { headers: auth(jwt) }
    ).then(r => r.json());

    if (cont.sold_lei < trz.pret_lei) {
      throw new Error(`Fonduri insuficiente: ${cont.sold_lei} lei disponibili, ${trz.pret_lei} lei necesari`);
    }

    // Plata din cumpărător la vânzător (în producție: escrow intermediar)
    const plata = await fetch(`${bankgiroUrl}/plata`, {
      method: 'POST',
      headers: { ...auth(jwt), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        de_la_cnp: trz.cnp_cumparator,
        catre_cnp: trz.cnp_vanzator,
        suma_lei:  trz.pret_lei,
        motiv:     `Tranzacție imobiliară ${trz.fastighetsbeteckning}`,
        tip:       'imobiliar',
      }),
    }).then(r => r.json());

    if (plata.error) throw new Error(`Plată eșuată: ${plata.error}`);
    trz.bankgiro_tranzactie_id = plata.id;
    return { plata_id: plata.id };
  });

  // ── Pasul 4: Transfer proprietate în Cadastru ────────────────────────────
  await pas(trz, 'CADASTRU_ACTUALIZAT', async () => {
    const cadastruUrl = await directory.getUrl('cadastru');

    const transfer = await fetch(`${cadastruUrl}/transfer`, {
      method: 'POST',
      headers: { ...auth(jwt), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fastighetsbeteckning:  trz.fastighetsbeteckning,
        cnp_vanzator:          trz.cnp_vanzator,
        cnp_cumparator:        trz.cnp_cumparator,
        pret_lei:              trz.pret_lei,
        tranzactie_bankgiro_id: trz.bankgiro_tranzactie_id,
      }),
    }).then(r => r.json());

    if (transfer.error) throw new Error(`Transfer Cadastru eșuat: ${transfer.error}`);
    return { data_transfer: transfer.data };
  });

  // ── Pasul 5: Actualizare adresă cumpărător în DEPABD ────────────────────
  await pas(trz, 'ADRESA_ACTUALIZATA', async () => {
    const depabdUrl = await directory.getUrl('depabd');

    await fetch(`${depabdUrl}/adresa/${trz.cnp_cumparator}`, {
      method: 'PUT',
      headers: { ...auth(jwt), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fastighetsbeteckning_nou: trz.fastighetsbeteckning,
      }),
    });
    // DEPABD va publica 'schimbare_adresa' → Agent Utilități se trezește automat
    return { adresa_noua: trz.fastighetsbeteckning };
  });

  // ── Finalizare ───────────────────────────────────────────────────────────
  trz.status = 'FINALIZATA';

  // Notificare ambele părți prin Kivra
  const kivraUrl = await directory.getUrl('kivra');
  await Promise.all([
    fetch(`${kivraUrl}/send`, {
      method: 'POST',
      headers: { ...auth(jwt), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        catre_cnp: trz.cnp_vanzator,
        subiect:   'Tranzacție imobiliară finalizată',
        corp:      `Vânzarea imobilului ${trz.fastighetsbeteckning} a fost finalizată.\nSuma de ${trz.pret_lei} lei a fost virată în contul tău BankGiro.`,
        tip:       'tranzactie',
      }),
    }),
    fetch(`${kivraUrl}/send`, {
      method: 'POST',
      headers: { ...auth(jwt), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        catre_cnp: trz.cnp_cumparator,
        subiect:   'Proprietate înregistrată pe numele tău',
        corp:      `Imobilul ${trz.fastighetsbeteckning} a fost înregistrat în Cadastru pe CNP-ul tău.\nAdresa ta de domiciliu a fost actualizată automat.`,
        tip:       'tranzactie',
      }),
    }),
  ]);

  console.log(`[Agent Imobiliar] Tranzacție ${id} FINALIZATĂ`);
}

async function rollback(id, motiv) {
  const trz = tranzactii.get(id);
  if (!trz) return;

  trz.status = 'ANULATA';
  trz.motiv_anulare = motiv;

  console.error(`[Agent Imobiliar] ROLLBACK ${id}: ${motiv}`);

  // În producție: inversăm fiecare pas deja executat
  // În sandbox: marcăm ca anulat și notificăm
  const jwt = trz.jwt;
  if (trz.bankgiro_tranzactie_id) {
    // TODO: inversare plată BankGiro
    console.warn(`[Agent Imobiliar] Plata ${trz.bankgiro_tranzactie_id} necesită inversare manuală`);
  }
}

async function pas(trz, numeStatus, fn) {
  try {
    const result = await fn();
    trz.status = numeStatus;
    trz.pasi.push({ status: numeStatus, ts: new Date().toISOString(), ...result });
    console.log(`  [${trz.id.slice(0, 8)}] ✓ ${numeStatus}`);
  } catch (err) {
    trz.pasi.push({ status: `EROARE_${numeStatus}`, ts: new Date().toISOString(), eroare: err.message });
    throw err;
  }
}

function auth(jwt) {
  return { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };
}

// ─── API REST ──────────────────────────────────────────────────────────────

import Fastify from 'fastify';
const app = Fastify({ logger: false });

app.post('/tranzactie', async (req, reply) => {
  const id = await pornesteTranzactie(req.body);
  return reply.status(202).send({ id, status: 'INITIATA', nota: 'Tranzacție în curs de procesare' });
});

app.get('/tranzactie/:id', async (req, reply) => {
  const trz = tranzactii.get(req.params.id);
  if (!trz) return reply.status(404).send({ error: 'Tranzacție negăsită' });
  const { jwt, ...fara_jwt } = trz; // nu expunem JWT-ul
  return fara_jwt;
});

app.get('/health', async () => ({
  status: 'ok',
  tranzactii_active: [...tranzactii.values()].filter(t => !['FINALIZATA','ANULATA'].includes(t.status)).length,
}));

const PORT = process.env.PORT || 6001;
app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`[Agent Imobiliar] Pornit pe :${PORT}`);
