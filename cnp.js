/**
 * ROdemoRO — CNP Utilities
 * Format: YYYYMMDD-NNNNNC
 * 
 * Nicio semantică encodată. Fără sex, fără județ, fără secol ambiguu.
 */

/**
 * Calculează cifra de control Luhn pentru primele 13 cifre ale CNP-ului.
 * Operează pe string-ul de cifre fără separator.
 */
export function luhnControl(digits13) {
  // digits13: 'YYYYMMDDNNNNN' — 13 cifre
  if (digits13.length !== 13 || !/^\d+$/.test(digits13)) {
    throw new Error(`Luhn: așteptat 13 cifre, primit: ${digits13}`);
  }

  let sum = 0;
  for (let i = 0; i < 13; i++) {
    let d = parseInt(digits13[i], 10);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Generează un CNP pentru o dată dată și un număr de ordine.
 * 
 * @param {Date|string} data - Data nașterii sau înregistrării
 * @param {number} ordine - Numărul de ordine (1–99999)
 * @returns {string} CNP în format 'YYYYMMDD-NNNNNC'
 */
export function genereazaCNP(data, ordine) {
  const d = data instanceof Date ? data : new Date(data);
  
  const yyyy = d.getFullYear().toString().padStart(4, '0');
  const mm   = (d.getMonth() + 1).toString().padStart(2, '0');
  const dd   = d.getDate().toString().padStart(2, '0');
  const nnnnn = ordine.toString().padStart(5, '0');
  
  if (ordine < 1 || ordine > 99999) {
    throw new Error(`Numărul de ordine trebuie să fie 1–99999, primit: ${ordine}`);
  }

  const digits13 = `${yyyy}${mm}${dd}${nnnnn}`;
  const control = luhnControl(digits13);
  
  return `${yyyy}${mm}${dd}-${nnnnn}${control}`;
}

/**
 * Validează un CNP.
 * 
 * @param {string} cnp - CNP în format 'YYYYMMDD-NNNNNC' sau 'YYYYMMDD-NNNNNC-LLL'
 * @returns {{ valid: boolean, error?: string, data?: Date, ordine?: number }}
 */
export function valideazaCNP(cnp) {
  if (!cnp || typeof cnp !== 'string') {
    return { valid: false, error: 'CNP lipsă sau invalid' };
  }

  // Acceptăm format standard și cu extensie 3 litere
  const match = cnp.match(/^(\d{4})(\d{2})(\d{2})-(\d{5})(\d)(-[A-Z]{3})?$/);
  if (!match) {
    return { valid: false, error: `Format invalid. Așteptat: YYYYMMDD-NNNNNC, primit: ${cnp}` };
  }

  const [, yyyy, mm, dd, nnnnn, control, extensie] = match;

  // Validare dată
  const data = new Date(`${yyyy}-${mm}-${dd}`);
  if (isNaN(data.getTime())) {
    return { valid: false, error: `Data invalidă: ${yyyy}-${mm}-${dd}` };
  }
  if (data > new Date()) {
    return { valid: false, error: 'Data nu poate fi în viitor' };
  }

  // Validare Luhn
  const digits13 = `${yyyy}${mm}${dd}${nnnnn}`;
  const controlAsteptat = luhnControl(digits13);
  if (parseInt(control, 10) !== controlAsteptat) {
    return { 
      valid: false, 
      error: `Cifră de control incorectă. Așteptat: ${controlAsteptat}, primit: ${control}` 
    };
  }

  return {
    valid:   true,
    data,
    ordine:  parseInt(nnnnn, 10),
    extensie: extensie?.slice(1) ?? null, // fără cratimă
  };
}

/**
 * Parsează un CNP valid și returnează componentele.
 */
export function parseazaCNP(cnp) {
  const result = valideazaCNP(cnp);
  if (!result.valid) throw new Error(result.error);
  return result;
}

/**
 * Generează numărul de telefon din CNP.
 * Format: +40-YYYYMMDD-NNNNNC
 */
export function cnpLaTelefon(cnp) {
  const { valid, error } = valideazaCNP(cnp);
  if (!valid) throw new Error(error);
  return `+40-${cnp}`;
}

/**
 * Generează date sintetice pentru teste.
 */
export function genereazaCNPSintetic(opts = {}) {
  const {
    an    = 1980 + Math.floor(Math.random() * 43),
    luna  = 1 + Math.floor(Math.random() * 12),
    zi    = 1 + Math.floor(Math.random() * 28),
    ordine = 1 + Math.floor(Math.random() * 999),
  } = opts;

  const data = new Date(an, luna - 1, zi);
  return genereazaCNP(data, ordine);
}

// CLI: node cnp.js valideaza 19550530-001373
if (process.argv[2] === 'valideaza') {
  const cnp = process.argv[3];
  const result = valideazaCNP(cnp);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[2] === 'genereaza') {
  const [, , , data, ordine] = process.argv;
  console.log(genereazaCNP(data || new Date(), parseInt(ordine) || 1));
}
