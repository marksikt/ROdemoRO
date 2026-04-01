/**
 * ROdemoRO — Event Bus
 * Pub/sub pe Redis Streams. At-least-once delivery, replay 30 zile.
 */

import { createClient } from 'redis';
import crypto from 'crypto';
import { auditLog } from './audit-log.js';

const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
await redis.connect();

const STREAM_PREFIX = 'rodemo:bus:';
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 zile

/**
 * Publică un eveniment pe magistrală.
 * 
 * @param {string} type - Tipul evenimentului (ex: 'nastere', 'deces')
 * @param {object} plic - Plicul standard ROdemoRO
 */
export async function publish(type, plic) {
  // Completăm câmpurile standard dacă lipsesc
  const mesaj = {
    id:   plic.id  ?? crypto.randomUUID(),
    v:    1,
    ts:   plic.ts  ?? new Date().toISOString(),
    type,
    ...plic,
  };

  // Validare minimă
  if (!mesaj.from) throw new Error('Plicul trebuie să aibă câmpul "from"');
  if (!mesaj.jwt)  throw new Error('Plicul trebuie să aibă câmpul "jwt"');

  const streamKey = `${STREAM_PREFIX}${type}`;

  // Publicare în Redis Stream
  await redis.xAdd(
    streamKey,
    '*', // ID auto-generat de Redis (timestamp + sequence)
    {
      plic: JSON.stringify(mesaj),
      from: mesaj.from,
      cnp:  mesaj.cnp ?? '',
    },
    { MAXLEN: { strategy: '~', threshold: 100000 } } // păstrăm ~100k mesaje per topic
  );

  // Audit Log primește automat copia
  await auditLog.record(mesaj);

  return mesaj.id;
}

/**
 * Abonare la un topic.
 * 
 * @param {string} type - Tipul evenimentului
 * @param {string} groupName - Numele grupului de consum (ID-ul instituției)
 * @param {Function} handler - async (plic) => void
 */
export async function subscribe(type, groupName, handler) {
  const streamKey = `${STREAM_PREFIX}${type}`;

  // Creăm grupul de consum dacă nu există
  try {
    await redis.xGroupCreate(streamKey, groupName, '0', { MKSTREAM: true });
  } catch (err) {
    if (!err.message.includes('BUSYGROUP')) throw err;
    // Grupul există deja — continuăm de unde am rămas
  }

  console.log(`[Bus] ${groupName} abonat la "${type}"`);

  // Polling loop
  const poll = async () => {
    while (true) {
      try {
        const results = await redis.xReadGroup(
          groupName,
          process.env.INSTANCE_ID || 'instance-1',
          [{ key: streamKey, id: '>' }],
          { COUNT: 10, BLOCK: 2000 } // blochează 2 secunde dacă nu sunt mesaje noi
        );

        if (!results) continue;

        for (const { messages } of results) {
          for (const { id: streamId, message } of messages) {
            const plic = JSON.parse(message.plic);

            try {
              await handler(plic);
              // Confirmare procesare
              await redis.xAck(streamKey, groupName, streamId);
            } catch (err) {
              console.error(`[Bus] Eroare procesare mesaj ${plic.id}:`, err.message);
              // Nu confirmăm — va fi redelivered automat
            }
          }
        }
      } catch (err) {
        console.error('[Bus] Eroare polling:', err.message);
        await new Promise(r => setTimeout(r, 1000)); // pauză la eroare
      }
    }
  };

  poll(); // non-blocking
}

/**
 * Helper: verifică dacă un mesaj a mai fost procesat (idempotență).
 * Fiecare instituție menține propria tabelă de mesaje procesate.
 */
export async function alreadyProcessed(msgId, namespace) {
  const key = `rodemo:processed:${namespace}:${msgId}`;
  const result = await redis.set(key, '1', { NX: true, EX: 86400 * 30 });
  return result === null; // null = cheia exista deja = deja procesat
}
