# CNP — Specificație Tehnică

## Format

```
YYYYMMDD-NNNNNC
```

| Segment | Lungime | Descriere |
|---|---|---|
| `YYYY` | 4 | An (naștere sau înregistrare) |
| `MM` | 2 | Lună, 01–12 |
| `DD` | 2 | Zi, 01–31 |
| `-` | 1 | Separator |
| `NNNNN` | 5 | Număr ordine, alocat secvențial în ziua respectivă |
| `C` | 1 | Cifră de control Luhn |

**Lungime totală:** 15 caractere (incluzând separatorul).

**Caractere permise:** cifre 0–9 și cratima `-` la poziția 9.

## Extensie opțională

Dacă spațiul de 99.999 ordine/zi se epuizează (improbabil), se activează extensia:

```
YYYYMMDD-NNNNNC-LLL
```

Cele 3 litere (`LLL`, A–Z) adaugă 26³ = 17.576 grupuri suplimentare. Nu se activează implicit.

## Principiu de design

**Nicio semantică encodată în număr.**

CNP-ul actual românesc encodează sexul, județul și secolul — informații care discriminează, se pot schimba și cuplează numărul de un context geografic sau social. Noul CNP este opac: un șir de cifre care identifică unic o înregistrare într-un registru.

Registrul (DEPABD sau RCO) știe tipul entității. Numărul nu.

## Cifra de control Luhn

Algoritmul Luhn se aplică pe primele 14 cifre (fără separator):

```javascript
function luhn(digits) {
  // digits: string de 14 cifre (YYYYMMDDNNNNN + placeholder 0)
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = parseInt(digits[i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}
```

## Alocare ordine

Numărul ordine `NNNNN` este alocat secvențial de instituția emitentă:

- **Persoane fizice:** DEPABD alocă la înregistrarea nașterii sau la imigrare
- **Persoane juridice:** RCO alocă la înregistrarea entității

Alocarea începe de la `00001` și crește cu 1 pentru fiecare înregistrare din ziua respectivă. La miezul nopții, contorul se resetează pentru ziua nouă.

## Capacitate

| Metrică | Valoare |
|---|---|
| Ordine disponibile/zi | 99.999 |
| Nașteri/zi vârf RO (1967) | ~1.100 |
| Înregistrări firme/zi vârf RO | ~700 |
| Headroom față de vârf | ~91× |

## Persoane fizice vs juridice

Același format, registre separate.

```
19550530-001373   ← persoană fizică, DEPABD
20031215-005284   ← persoană juridică, RCO
```

Nu există coliziune funcțională: orice API specifică în contextul său dacă se uită în DEPABD sau RCO. Un număr singur, fără context, nu înseamnă nimic — exact cum trebuie.

## Număr de telefon derivat

```
+40-YYYYMMDD-NNNNNC
```

Numărul de telefon al unui cetățean este prefixul internațional României (`+40`) urmat de CNP. Permanent, atribuit la naștere. Operatorul de telefonie furnizează rețeaua, nu numărul.

```
+40-19550530-001373    ← cetățean
+40-20031215-005284    ← firmă (ID din RCO)
```

## Migrarea de la CNP actual

La adoptare, fiecare cetățean primește un CNP nou. Maparea vechi→nou se stochează în DEPABD cu acces restricționat. Sistemele existente pot continua să folosească CNP-ul vechi în paralel pe o perioadă de tranziție, cu un serviciu de conversie disponibil prin magistrală.

## Referințe

- [Personnummer suedez](https://skatteverket.se/personnummer) — inspirația principală
- [Algoritmul Luhn](https://en.wikipedia.org/wiki/Luhn_algorithm)
- [What3Words](https://what3words.com) — folosit pentru fastighetsbeteckning, nu pentru CNP
