/**
 * ROdemoRO — Agent Alocație Copil
 * 
 * Declanșat de evenimentul "nastere" din DEPABD.
 * Verifică venitul părinților prin ANAF, calculează cuantumul,
 * programează plata lunară recurentă prin BankGiro.
 * 
 * Funcționarul supervizează excepțiile — agentul face rutina.
 */

import { subscribe, alreadyProcessed } from '../magistrala/event-bus.js';
import { publish }                      from '../magistrala/event-bus.js';
import { getToken }                     from '../magistrala/auth-server.js';
import { directory }                    from '../magistrala/directory.js';

const CUANTUM_BAZA_LEI = 700; // sumă demonstrativă
const PRAG_VENIT_REDUS = 3000;

/**
 * Pornire agent — se abonează la evenimentele relevante.
 */
export async function porneste() {
  await subscribe('nastere', 'agent-alocatie', handleNastere);
  await subscribe('deces',   'agent-alocatie', handleDecesCopil);
  console.log('[Agent Alocație] Pornit și abonat la nastere + deces');
}

/**
 * La fiecare naștere înregistrată în DEPABD.
 */
async function handleNastere(plic) {
  const { cnp, payload } = plic;
  const { cnp_mama, cnp_tata } = payload;
  const cnp_custode = cnp_mama ?? cnp_tata;

  if (!cnp_custode) {
    await escaladeazaLaFunctionar(cnp, 'Lipsă CNP custode — intervenție manuală necesară');
    return;
  }

  // Idempotență — nu procesăm de două ori același eveniment
  if (await alreadyProcessed(plic.id, 'agent-alocatie')) return;

  const jwt = await getToken('agent-alocatie');

  // 1. Verificăm venitul custodelui prin ANAF
  const anafUrl = await directory.getUrl('anaf');
  const venituri = await fetch(`${anafUrl}/venituri/${cnp_custode}`, {
    headers: { Authorization: `Bearer ${jwt}` }
  }).then(r => r.json());

  // 2. Calculăm cuantumul
  const cuantum = calculeazaCuantum(venituri.venit_lunar_net);

  // 3. Programăm plata lunară în BankGiro
  const bankgiroUrl = await directory.getUrl('bankgiro');
  const { id: plata_id } = await fetch(`${bankgiroUrl}/plata-recurenta`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      catre_cnp:  cnp_custode,
      suma_lei:   cuantum,
      motiv:      `Alocatie copil ${cnp}`,
      zi_lunara:  1, // prima zi a lunii
      data_stop:  calculeazaDataMajoratului(payload.data_nasterii),
    }),
  }).then(r => r.json());

  // 4. Notificăm custodele prin Kivra
  const kivraUrl = await directory.getUrl('kivra');
  await fetch(`${kivraUrl}/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      catre_cnp: cnp_custode,
      subiect:   'Alocație activată automat',
      corp:      `Alocația pentru copilul cu CNP ${cnp} a fost activată.\n` +
                 `Suma lunară: ${cuantum} lei\n` +
                 `Prima plată: 1 ${lunaViitoare()}\n` +
                 `Plata se oprește automat la majorat (${calculeazaDataMajoratului(payload.data_nasterii)}).`,
    }),
  });

  console.log(`[Agent Alocație] Activat pentru copil ${cnp}, custode ${cnp_custode}, ${cuantum} lei/lună`);
}

/**
 * La decesul unui copil minor — oprire automată alocație.
 */
async function handleDecesCopil(plic) {
  const { cnp, payload } = plic;
  if (await alreadyProcessed(plic.id, 'agent-alocatie-deces')) return;

  const jwt = await getToken('agent-alocatie');
  const bankgiroUrl = await directory.getUrl('bankgiro');

  // Oprim plata recurentă
  await fetch(`${bankgiroUrl}/plata-recurenta/stop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ motiv_cnp: cnp, data_stop: payload.data_deces }),
  });
}

// ─── Calcule ───────────────────────────────────────────────────────────────

function calculeazaCuantum(venit_lunar_net) {
  if (venit_lunar_net < PRAG_VENIT_REDUS) {
    return Math.round(CUANTUM_BAZA_LEI * 1.5); // majorare pentru venituri mici
  }
  return CUANTUM_BAZA_LEI;
}

function calculeazaDataMajoratului(data_nasterii) {
  const d = new Date(data_nasterii);
  d.setFullYear(d.getFullYear() + 18);
  return d.toISOString().slice(0, 10);
}

function lunaViitoare() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toLocaleString('ro-RO', { month: 'long', year: 'numeric' });
}

async function escaladeazaLaFunctionar(cnp, motiv) {
  // Publică pe un topic special pentru supervizare
  await publish('exceptie_agent', {
    from:    'agent-alocatie',
    to:      'supervizor',
    cnp,
    payload: { motiv, agent: 'alocatie', necesita_atentie: true },
    jwt: await getToken('agent-alocatie'),
  });
  console.warn(`[Agent Alocație] Escaladare funcționar: ${cnp} — ${motiv}`);
}

// Pornire
porneste().catch(console.error);
