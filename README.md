# ROdemoRO

Un stat român simulat — funcțional, vizitabil, testabil.

ROdemoRO este un **test rig public** al administrației publice românești: o oglindă digitală cu date sintetice, unde orice dezvoltator, firmă, cercetător sau cetățean poate experimenta cum ar arăta un stat complet digitalizat.

Pornind de la [DemoANAF](https://demoanaf.ro) al lui Daniel Tamas, extindem ecosistemul cu toate instituțiile majore, conectate printr-o magistrală simplă de mesaje.

---

## Ce este

- **Nu** este un proiect guvernamental
- **Nu** conține date reale despre cetățeni
- **Este** un sandbox complet funcțional, cu API-uri reale, date sintetice, și agenți automatizați
- **Este** documentație vie pentru cum ar trebui să arate digitalizarea publică în România

Inspirat din sistemul public suedez: Skatteverket, Folkbokföring, BankID, Kivra, Lantmäteriet, Transportstyrelsen.

---

## Arhitectura în două propoziții

Fiecare instituție este un serviciu REST independent. Serviciile comunică prin **4 componente**: Auth Server (JWT), Event Bus (pub/sub), Directory (catalog servicii), Audit Log (append-only). Nimic altceva.

---

## Instituții implementate

### Registre de bază (sursa de adevăr)
| Instituție | Descriere | Status |
|---|---|---|
| **DEPABD+** | Evidența populației + Stare Civilă | 🚧 în lucru |
| **Cadastru** | Registrul proprietăților, legat prin CNP | 📋 spec |
| **ONRC / RCO** | Registrul Comun al Organizațiilor | 📋 spec |
| **RAP** | Registrul Asociațiilor de Proprietari | 📋 spec |
| **RSN** | Registrul Școlar Național | 📋 spec |

### Servicii fiscale și sociale
| Instituție | Descriere | Status |
|---|---|---|
| **ANAF** | Fiscal — bazat pe DemoANAF | ✅ existent |
| **CNAS** | Sănătate și asigurări | 📋 spec |
| **CNPP** | Pensii publice | 📋 spec |

### Identitate și infrastructură digitală
| Instituție | Descriere | Status |
|---|---|---|
| **eID RO** | Identitate digitală, interoperabil eIDAS | 📋 spec |
| **Kivra RO** | Cutie poștală digitală oficială | 📋 spec |
| **BankGiro RO** | Sistem de rutare plăți prin CNP | 📋 spec |
| **Transport RO** | Permise de conducere, Registrul Auto | 📋 spec |
| **CNT** | Cardul Național de Transport | 📋 spec |

### Documente de identitate
| Instituție | Descriere | Status |
|---|---|---|
| **Poliție** | CI Națională, Pașapoarte | 📋 spec |

### Sănătate
| Instituție | Descriere | Status |
|---|---|---|
| **Dosar Medical Național** | Un CNP, tot istoricul medical | 📋 spec |
| **e-Rețetă** | Prescripție electronică instantanee | 📋 spec |
| **Farmacii** | Rețea, stoc, decontare CNAS | 📋 spec |
| **DSP** | Supraveghere și sănătate publică | 📋 spec |

### Sistem judiciar
| Instituție | Descriere | Status |
|---|---|---|
| **Registrul Dosarelor** | Național, public, actualizat în timp real | 📋 spec |
| **Executori Judecătorești** | Titluri executorii, poprire digitală | 📋 spec |
| **Cazier Judiciar** | Legat de CNP, eliberat online cu eID | 📋 spec |

### Utilități
| Utilitate | Descriere | Status |
|---|---|---|
| **Energie / Gaz / Apă** | Contracte legate de imobil în Cadastru | 📋 spec |
| **ANCOM / Telefonie** | SIM legat de CNP, portabilitate automată | 📋 spec |

### Agenți automatizați
Agenții execută rutine care implică mai multe instituții, supervizați de funcționari pentru validare.

| Agent | Declanșat de | Orchestrează |
|---|---|---|
| Agent Imobiliar | Tranzacție | Cadastru + Bănci + DEPABD |
| Agent Auto | Vânzare | Transport RO + ANAF + Bănci |
| Agent Căsătorie | Cerere | DEPABD + Stare Civilă + ANAF |
| Agent Divorț | Cerere | DEPABD + Instanțe + Cadastru |
| Agent Pensionare | Cerere | CNPP + CNAS + ANAF |
| Agent Alocație | Naștere (DEPABD) | ANAF + BankGiro + Kivra |
| Agent Bursă | Semestru (RSN) | RSN + ANAF + BankGiro |
| Agent Special | Ad-hoc, 2 cetățeni | Dinamic |
| Agent Utilități | Mutare (DEPABD) | Toți furnizorii |

---

## Standarde de identificare

### CNP — Codul Numeric Personal

Format: `YYYYMMDD-NNNNNC`

- `YYYYMMDD` — data nașterii (persoane fizice) sau data înregistrării (persoane juridice)
- `NNNNN` — 5 cifre ordine, alocate secvențial în ziua respectivă
- `C` — cifră de control Luhn
- Extensie opțională: `YYYYMMDD-NNNNNC-LLL` (3 litere, 17.576× capacitate suplimentară)

**Capacitate:** 99.999 persoane/zi → 91× vârful istoric românesc (1.100 nașteri/zi în 1967).

**Principiu fundamental:** nicio semantică encodată în număr. Fără sex, fără județ, fără secol. Registrul știe tipul entității — numărul nu.

Același format pentru persoane fizice și juridice, registre separate (DEPABD vs RCO). Un câmp în orice bază de date acceptă ambele.

### Număr de telefon

Format: `+40-YYYYMMDD-NNNNNC`

Numărul de telefon al unui cetățean este prefixul internațional urmat de CNP. Permanent, atribuit la naștere. Operatorul furnizează rețeaua, nu numărul.

### Înmatriculare auto

Format: `YYYYMMDD-LLL`

- `YYYYMMDD` — data primei înmatriculări
- `LLL` — 3 litere ordine (26³ = 17.576 combinații/zi)

Fără județ. Placa rămâne pe vehicul la vânzare — proprietarul se schimbă în Registrul Auto.

### Fastighetsbeteckning (identificator imobil)

Format: `cuvant.cuvant.cuvant` (What3Words)

Centrul geometric al clădirii exprimat în sistemul W3W — grilă globală de 3m × 3m. Identificator primar al imobilului în Cadastru. Imutabil, global, independent de adresa poștală.

---

## Magistrala

### Componente (4 total, nimic altceva)

```
┌─────────────────────────────────────────────────────┐
│                    Auth Server                       │
│          OAuth 2.0 · JWT RS256 · 15 min TTL          │
└──────────────────────┬──────────────────────────────┘
                       │ token
        ┌──────────────▼──────────────┐
        │          Event Bus           │
        │   pub/sub · replay 30 zile   │
        └──────────────┬──────────────┘
                       │ events
        ┌──────────────▼──────────────┐
        │          Directory           │
        │  catalog servicii · OpenAPI  │
        └──────────────┬──────────────┘
                       │ audit
        ┌──────────────▼──────────────┐
        │          Audit Log           │
        │  append-only · SHA-256 hash  │
        └─────────────────────────────┘
```

### Plicul standard

Orice mesaj pe magistrală are același format:

```json
{
  "id":      "uuid-v4",
  "v":       1,
  "ts":      "2024-05-30T14:22:00Z",
  "from":    "depabd",
  "to":      "anaf",
  "type":    "nastere",
  "cnp":     "20240530-001373",
  "payload": {},
  "jwt":     "eyJhbGci..."
}
```

### Topic-uri standard (catalog evenimente)

| Topic | Emis de | Abonați tipici |
|---|---|---|
| `nastere` | DEPABD | ANAF, CNAS, Dosar Medical, Agent Alocație |
| `deces` | DEPABD | ANAF, CNPP, Cadastru, eID |
| `casatorie` | Agent Căsătorie | DEPABD, ANAF, Kivra |
| `divort` | Agent Divorț | DEPABD, Cadastru, ANAF |
| `transfer_proprietate` | Cadastru | DEPABD, ANAF, RAP, Agent Utilități |
| `transfer_auto` | Transport RO | ANAF, Asigurări |
| `pensionare` | Agent Pensionare | CNPP, CNAS, ANAF, BankGiro |
| `inscriere_scoala` | RSN | Agent Bursă, CNAS |
| `reteta_emisa` | Dosar Medical | Farmacii, CNAS |
| `dosar_judiciar` | Instanțe | Executori, Cazier, Kivra |

---

## Pornire rapidă

```bash
git clone https://github.com/ROdemoRO/ROdemoRO
cd ROdemoRO
cp .env.example .env
docker-compose up
```

Accesează:
- Portal cetățean: http://localhost:3000
- API Gateway / Swagger: http://localhost:3001/docs
- Demo Zone: http://localhost:3000/demo

### Date de test

CNP-uri sintetice pre-generate pentru scenarii:

| CNP | Profil |
|---|---|
| `19550530-001373` | Pensionar, proprietar apartament, 2 copii |
| `19880312-027415` | Adult activ, salariat, fără proprietăți |
| `20060715-003821` | Minor, elev liceu, bursă activă |
| `20031215-J00428` | SRL activ, 3 angajați, TVA plătitor |

---

## Contribuie

Fiecare instituție e un microserviciu independent în `src/institutii/`. Poți adăuga o instituție nouă fără să atingi codul altora:

1. Creează `src/institutii/numele-tau/`
2. Implementează spec-ul din `docs/institutii/numele-tau.md`
3. Înregistrează-te în Directory: `POST /directory`
4. Abonează-te la topic-urile relevante
5. Publică evenimentele tale pe Bus

Nu există dependențe directe între instituții. Comunicarea se face exclusiv prin magistrală.

---

## Licență

MIT — liber pentru orice folosință, inclusiv comercială.

---

## Mulțumiri

- [Daniel Tamas](https://demoanaf.ro) — DemoANAF, punctul de pornire
- Sistemul public suedez — modelul de referință
- [What3Words](https://what3words.com) — fastighetsbeteckning
