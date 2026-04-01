# Instituții — Ghid de implementare

## Structura unui serviciu

Fiecare instituție este un microserviciu Node.js independent cu aceeași structură:

```
src/institutii/nume-institutie/
├── index.js      ← server Fastify + logică
├── schema.sql    ← schema bazei de date (opțional)
└── README.md     ← descriere specifică (opțional)
```

### Template minim

```javascript
import Fastify from 'fastify';
import { requireAuth } from '../magistrala/auth-server.js';
import { subscribe, publish } from '../magistrala/event-bus.js';
import { getToken } from '../magistrala/auth-server.js';

const app = Fastify({ logger: false });
app.addHook('onRequest', requireAuth); // toate endpoint-urile necesită JWT

// Abonare la evenimente relevante
await subscribe('nastere', 'institutia-mea', async (plic) => {
  // procesare idempotentă
});

// Endpoint-uri REST
app.get('/resursa/:id', async (req, reply) => { ... });
app.post('/resursa', async (req, reply) => {
  // după o acțiune importantă: publică eveniment
  const jwt = await getToken('institutia-mea');
  await publish('tip_eveniment', { from: 'institutia-mea', ..., jwt });
});

app.get('/health', async () => ({ status: 'ok' }));
app.listen({ port: process.env.PORT || 5000, host: '0.0.0.0' });
```

---

## Instituții implementate

### DEPABD+ (`src/institutii/depabd/`)
**Port:** 5001

Sursa de adevăr pentru persoane fizice. Stochează CNP, date personale,
fastighetsbeteckning (adresa), stare civilă, relații familiale.

**Publică:** `nastere`, `deces`, `casatorie`, `divort`, `schimbare_adresa`

**Endpoint-uri principale:**
```
GET  /persoana/:cnp
GET  /adresa/:cnp
GET  /familie/:cnp
POST /nastere
POST /deces
PUT  /adresa/:cnp
POST /casatorie
```

---

### Cadastru (`src/institutii/cadastru/`)
**Port:** 5003

Registrul proprietăților. Identificator primar: fastighetsbeteckning (W3W).
La transfer, emite eveniment — DEPABD actualizează adresa, RAP actualizează asociația.

**Publică:** `transfer_proprietate`
**Ascultă:** `deces` (marchează imobile pentru succesiune)

**Endpoint-uri principale:**
```
POST /imobil
GET  /imobil/:fastighetsbeteckning
GET  /proprietati/:cnp
POST /transfer
POST /sechestru
```

---

### Transport RO (`src/institutii/transport-ro/`)
**Port:** 5004

Registrul Auto + Permise de conducere.
Plăcuță format `YYYYMMDD-LLL`. Permisul e act de identitate, fără adresă.

**Publică:** `transfer_auto`, `permis_emis`
**Ascultă:** `deces` (dezactivare permis + vehicule)

**Endpoint-uri principale:**
```
POST /vehicul
GET  /vehicul/:placa
GET  /vehicule/:cnp
POST /transfer-auto
POST /permis
GET  /permis/:cnp
```

---

### Kivra RO (`src/institutii/kivra/`)
**Port:** 5005

Cutia poștală digitală oficială. Orice act oficial ajunge aici.
Notificări automate la expirarea actelor (CI, permis, pașaport).

**Endpoint-uri principale:**
```
POST /send
GET  /inbox/:cnp
GET  /mesaj/:id
POST /alerta-expirare
```

---

### BankGiro RO (`src/institutii/bankgiro/`)
**Port:** 5006

Rutare plăți prin CNP. Plătitorul nu știe la ce bancă e destinatarul.
Numărul BankGiro e derivat din CNP — stabil, permanent.

**Publică:** `plata_efectuata`

**Endpoint-uri principale:**
```
POST /cont
GET  /cont/:cnp
POST /plata
POST /plata-recurenta
POST /plata-recurenta/stop
GET  /extras/:cnp
```

---

## Instituții de implementat

Acestea sunt definite în spec dar nu au cod încă. Contribuțiile sunt binevenite.

| Instituție | Port | Topics ascultate | Topics publicate |
|---|---|---|---|
| ANAF | 5002 | nastere, deces, casatorie | angajare, concediere |
| CNAS | 5007 | nastere, deces, pensionare | asigurare_activa |
| CNPP | 5008 | deces | pensie_activa |
| Dosar Medical | 5009 | nastere, deces | reteta_emisa, internare |
| Poliție | 5010 | — | ci_emisa, pasaport_emis |
| eID | 5011 | deces | — |
| RSN | 5012 | nastere | inscriere_scoala |
| RAP | 5013 | transfer_proprietate | — |

---

## Agenți implementați

### Agent Alocație (`src/agenti/agent-alocatie.js`)
Declanșat de `nastere`. ANAF → BankGiro → Kivra.

### Agent Imobiliar (`src/agenti/agent-imobiliar.js`)
Pornit la cerere. 5 pași atomici: identități → proprietate → escrow → Cadastru → DEPABD.

### Agent Pensionare (`src/agenti/agent-pensionare.js`)
Pornit la cerere. 8 pași: CNPP → calcul → ANAF → activare → BankGiro → ANAF → CNAS → Kivra.

---

## Agenți de implementat

| Agent | Declanșat de | Pași principali |
|---|---|---|
| Agent Auto | Cerere | Transport RO + ANAF + BankGiro |
| Agent Căsătorie | Cerere | DEPABD + ANAF + Kivra |
| Agent Divorț | Cerere | DEPABD + Instanțe + Cadastru |
| Agent Bursă | Semestru (cron) | RSN + ANAF + BankGiro |
| Agent Utilități | schimbare_adresa | Toți furnizorii |
| Agent Șomaj | concediere (ANAF) | CNAS + BankGiro + Kivra |
| Agent Dizabilitate | Cerere + Dosar Med | ANAF + Transport + BankGiro |

---

## Convenții

### Gestionare erori
```javascript
// Returnează întotdeauna JSON, chiar și la erori
app.setErrorHandler((error, req, reply) => {
  reply.status(error.statusCode || 500).send({
    error: error.message,
    code:  error.code || 'INTERNAL_ERROR',
  });
});
```

### Idempotență
Orice handler de eveniment trebuie să fie idempotent:
```javascript
import { alreadyProcessed } from '../../magistrala/event-bus.js';

bus.on('nastere', async (plic) => {
  if (await alreadyProcessed(plic.id, 'institutia-mea')) return;
  // procesare
});
```

### Logging
```javascript
console.log(`[Institutia Mea] Acțiune: ${cnp}`); // format standard
```

### Health check
Fiecare serviciu expune `GET /health` cu status și statistici de bază.
Docker Compose folosește acest endpoint pentru liveness probe.
