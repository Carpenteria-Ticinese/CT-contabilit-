// TimberMaster — Pre-Contabilità
// app.js — Logica principale (Fase 1 + Fase 2)
// Stack: HTML/JS vanilla + Supabase JS v2

'use strict'

// ─── Configurazione Supabase ──────────────────────────────────────────────────
const SUPABASE_URL = 'https://wgidgbauhivdctdxfjnk.supabase.co'
const SUPABASE_KEY = 'sb_publishable_Ke7MTQGHPYVXvKInfOrUQQ_Ys6qKJvD'
const STORAGE_BUCKET = 'conta-allegati'

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)

// ─── Stato globale ────────────────────────────────────────────────────────────
let currentUser = null
let currentAziendaId = null
let currentPage = 'login'

// Fase 3 — classificazione
let daClassList   = []        // movimenti attualmente mostrati in «Da classificare»
let contiCache    = null      // [{id, codice_conto, descrizione, tipo, azienda_id}]
let ivaCache      = null      // [{id, codice, descrizione, aliquota}]
let cantieriCache = null      // [{id, nome}] oppure null se non disponibile
let classifyMode  = 'single'  // 'single' | 'bulk'
let classifyTargets = []      // movimenti oggetto della classificazione corrente
let ivaInclusaState = true    // toggle IVA inclusa/esclusa nella modale

// Fase 4 — audit trail
let classificatiList = []     // movimenti già classificati mostrati (per indice)
let utentiEmailCache = {}     // id utente -> email (best-effort, per la Storia)

// Fase 5 — export + blocco periodo
let classByKey = {}           // "origine_tipo:origine_id" -> riga classificazione (con stato)
let exportPeriodRows = []     // righe export calcolate per il periodo corrente
let exportModo       = 'anno' // 'anno' | 'trimestre' | 'mese' | 'custom'
let exportDataset    = null   // cache dati export (fatture, acquisti, movimenti, classificazioni)

// Fase 6 — fatture
let fattureList       = []     // fatture caricate per la lista
let editorFatturaId   = null   // id bozza in modifica (null = nuova)
let editorTipo        = 'fattura'  // 'fattura' | 'nota_credito'
let editorRifId       = null   // rif_fattura_id (per note di credito)
let editorRifTotale   = null   // totale della fattura originale stornata (limite storno)
let editorRifInfo     = null   // {numero, data_emissione, totale} della fattura originale

// Fase 8 — rubrica IBAN per cantiere
let ibanRubrica       = null   // [{id, etichetta, iban, attivo}]
let editingIbanId     = null   // id voce rubrica in modifica (Impostazioni)

// Fase 10 — fatture d'acquisto + conferma emissione vendite
let acquistiList      = []     // fatture d'acquisto caricate
let editingAcquistoId = null   // id acquisto in modifica (null = nuovo)
let acquistoOriginal  = null   // valori originali (per "Annulla ripristina")
let acquistoDocPath   = null   // doc_path esistente in modifica
let acquistoIvaManuale = false // true = imponibile/IVA scritti a mano (non ricalcolare)
let pendingEmitFn     = null   // callback della modale di conferma emissione
let fatturaRighe      = []     // righe in editor: {descrizione, quantita, prezzo_unitario, codice_iva_id}
let aziendaInfo       = null   // dati azienda (best-effort) per l'intestazione fattura
let currentDetailFattura = null
// FASE 22 — righe e riferimento della fattura aperta, per rifare il foglio di
// stampa quando cambia la polizza QR senza rileggere dal database.
let righeDetailCorrenti = null
let rifInfoCorrente = null

// ══════════════════════════════════════════════════════════════════════════════
// FASE 21 — I PAESI
//
// Il campo Paese era un testo libero di due caratteri, e chi scriveva
// «Svizzera» si ritrovava «SV» — che nello standard ISO 3166-1 e' El
// Salvador, non la Svizzera. Quel codice finiva stampato sulla fattura e
// renderebbe invalida la parte pagamento QR.
//
// Adesso si sceglie da un elenco: a schermo il nome, nel database il codice.
// In cima i sei paesi che servono davvero qui, poi il resto in ordine.
// ══════════════════════════════════════════════════════════════════════════════

var PAESI_FREQUENTI = [
  { c: 'CH', n: 'Svizzera' },
  { c: 'IT', n: 'Italia' },
  { c: 'DE', n: 'Germania' },
  { c: 'FR', n: 'Francia' },
  { c: 'AT', n: 'Austria' },
  { c: 'LI', n: 'Liechtenstein' }
]

var PAESI_ALTRI = [
  { c: 'AL', n: 'Albania' }, { c: 'AD', n: 'Andorra' }, { c: 'SA', n: 'Arabia Saudita' },
  { c: 'AR', n: 'Argentina' }, { c: 'AM', n: 'Armenia' }, { c: 'AU', n: 'Australia' },
  { c: 'AZ', n: 'Azerbaigian' }, { c: 'BE', n: 'Belgio' }, { c: 'BY', n: 'Bielorussia' },
  { c: 'BA', n: 'Bosnia ed Erzegovina' }, { c: 'BR', n: 'Brasile' }, { c: 'BG', n: 'Bulgaria' },
  { c: 'CA', n: 'Canada' }, { c: 'CN', n: 'Cina' }, { c: 'CY', n: 'Cipro' },
  { c: 'VA', n: 'Citt\u00e0 del Vaticano' }, { c: 'KR', n: 'Corea del Sud' },
  { c: 'HR', n: 'Croazia' }, { c: 'DK', n: 'Danimarca' }, { c: 'EG', n: 'Egitto' },
  { c: 'AE', n: 'Emirati Arabi Uniti' }, { c: 'EE', n: 'Estonia' }, { c: 'FI', n: 'Finlandia' },
  { c: 'GE', n: 'Georgia' }, { c: 'JP', n: 'Giappone' }, { c: 'GI', n: 'Gibilterra' },
  { c: 'GR', n: 'Grecia' }, { c: 'IN', n: 'India' }, { c: 'ID', n: 'Indonesia' },
  { c: 'IE', n: 'Irlanda' }, { c: 'IS', n: 'Islanda' }, { c: 'IL', n: 'Israele' },
  { c: 'LV', n: 'Lettonia' }, { c: 'LT', n: 'Lituania' }, { c: 'LU', n: 'Lussemburgo' },
  { c: 'MK', n: 'Macedonia del Nord' }, { c: 'MT', n: 'Malta' }, { c: 'MA', n: 'Marocco' },
  { c: 'MX', n: 'Messico' }, { c: 'MD', n: 'Moldova' }, { c: 'MC', n: 'Monaco' },
  { c: 'ME', n: 'Montenegro' }, { c: 'NO', n: 'Norvegia' }, { c: 'NZ', n: 'Nuova Zelanda' },
  { c: 'NL', n: 'Paesi Bassi' }, { c: 'PL', n: 'Polonia' }, { c: 'PT', n: 'Portogallo' },
  { c: 'GB', n: 'Regno Unito' }, { c: 'CZ', n: 'Repubblica Ceca' }, { c: 'RO', n: 'Romania' },
  { c: 'RU', n: 'Russia' }, { c: 'SM', n: 'San Marino' }, { c: 'RS', n: 'Serbia' },
  { c: 'SG', n: 'Singapore' }, { c: 'SK', n: 'Slovacchia' }, { c: 'SI', n: 'Slovenia' },
  { c: 'ES', n: 'Spagna' }, { c: 'US', n: 'Stati Uniti' }, { c: 'ZA', n: 'Sudafrica' },
  { c: 'SE', n: 'Svezia' }, { c: 'TH', n: 'Thailandia' }, { c: 'TR', n: 'Turchia' },
  { c: 'UA', n: 'Ucraina' }, { c: 'HU', n: 'Ungheria' }
]

// Il codice e' valido se sta in uno dei due elenchi.
function paeseValido(codice) {
  var c = String(codice == null ? '' : codice).trim().toUpperCase()
  if (!c) return false
  return PAESI_FREQUENTI.concat(PAESI_ALTRI).some(function (p) { return p.c === c })
}

function nomePaese(codice) {
  var c = String(codice == null ? '' : codice).trim().toUpperCase()
  var t = PAESI_FREQUENTI.concat(PAESI_ALTRI).filter(function (p) { return p.c === c })[0]
  return t ? t.n : ''
}

// Le voci della tendina. Un codice che non sta in elenco NON viene cambiato in
// silenzio: entra come voce «da correggere», cosi' si vede che c'e' e che va
// sistemato. Indovinare al posto di chi ha scritto sarebbe peggio del difetto.
function buildPaeseOptions(selected) {
  var sel = String(selected == null ? '' : selected).trim().toUpperCase()
  var out = '<option value="">— nessun paese —</option>'
  function voce(p) {
    return '<option value="' + esc(p.c) + '"' + (p.c === sel ? ' selected' : '') + '>' +
           esc(p.n + ' (' + p.c + ')') + '</option>'
  }
  out += '<optgroup label="Pi\u00f9 usati">' + PAESI_FREQUENTI.map(voce).join('') + '</optgroup>'
  out += '<optgroup label="Tutti gli altri">' + PAESI_ALTRI.map(voce).join('') + '</optgroup>'
  if (sel && !paeseValido(sel)) {
    out += '<optgroup label="Da correggere">' +
             '<option value="' + esc(sel) + '" selected>' +
             '\u26a0\ufe0f ' + esc(sel) + ' — codice non valido, da correggere' +
             '</option></optgroup>'
  }
  return out
}

// Riempie una tendina paese e ci posiziona il codice indicato. Da usare sempre
// al posto di `el(id).value = codice`: con una tendina, assegnare un valore che
// non e' fra le opzioni lo lascerebbe vuoto in silenzio.
function impostaPaese(id, codice) {
  var e = el(id)
  if (!e) return
  e.innerHTML = buildPaeseOptions(codice)
  e.value = String(codice == null ? '' : codice).trim().toUpperCase()
}

// FASE 19 — il paese che il programma mette da solo in una fattura nuova.
// Serve saperlo per distinguerlo da un paese scelto da chi scrive: il primo si
// puo' rimpiazzare col paese del cliente, il secondo no.
var PAESE_PREDEFINITO = 'CH'
var paeseFatturaToccato = false   // true = il campo Paese l'ha scritto l'utente

// Fase 3 — modifica Canale B
let editingMovimentoId = null
let originalEditValues = null
let editingDocPath     = null
let recentiList        = []   // ultimi movimenti Canale B mostrati (per indice)

// Schema confermato via ispezione REST (select limit 1 su tabelle reali — COMPLETO):
//
// spese → id, data, descrizione, importo, valuta, cantiere_id, note, created_at, created_by
//
// regia → id, data, descrizione, cantiere_id, operaio_id, note, created_at,
//          tipo, created_by, quantita, costo_unitario, prezzo_unitario, um, fatturato
//   Regia è SEMPRE lato ricavo nella pre-contabilità:
//     fatturato=true  → importo = quantita × prezzo_unitario  (proposta conto 3100, da confermare)
//     fatturato=false → mostrata come "da fatturare" (informativa), NESSUN importo, NESSUN conto
//   La manodopera è già nei salari (payroll): NON usare costo_unitario → 5xxx, evita doppio conteggio
//
// tm_fatture / tm_costi → schema incerto, saltate (istr. sezione 4: "se incerta, lasciala per dopo")

// ─── Utilità DOM ─────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id) }

function html(id, markup) {
  const elem = el(id)
  if (elem) elem.innerHTML = markup
}

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function badge(cls, label) {
  return '<span class="badge badge-' + cls + '">' + esc(label) + '</span>'
}

// ── Vocabolario del pagamento ────────────────────────────────────────────────
// Nel database i valori sono due soli: 'aperto' e 'pagato'.
// A schermo diventano quattro parole diverse, a seconda della direzione del
// denaro: «Pagato» su una fattura che abbiamo emesso noi non vuol dire niente,
// quella si incassa.
// TUTTE le etichette di stato pagamento escono da qui. Nessuna scritta a mano
// altrove: e' cosi' che i vocabolari tornano a divergere.
function etichettaPagamento(verso, stato) {
  // FASE 8 — gli stati sono TRE. Prima erano due e la funzione era binaria:
  // «tutto cio' che non e' pagato» diventava «Da pagare». Con 'parziale' quella
  // scorciatoia direbbe che una fattura pagata a meta' non e' stata toccata.
  //
  // Queste sono le etichette di STATO DI UN DOCUMENTO. I riquadri della
  // Situazione restano «Da pagare» / «Da incassare» perche' li' non e' lo stato
  // di un documento: e' il totale di quanto resta da versare. Due cose diverse,
  // due nomi diversi.
  if (verso === 'entrata') {
    if (stato === 'pagato')   return { icona: '✅', testo: 'Incassato',          cls: 'ok'   }
    if (stato === 'parziale') return { icona: '🟠', testo: 'Incassato in parte', cls: 'warn' }
    return { icona: '🔵', testo: 'Non incassato', cls: 'warn' }
  }
  if (stato === 'pagato')   return { icona: '✅', testo: 'Pagato',          cls: 'ok'   }
  if (stato === 'parziale') return { icona: '🟠', testo: 'Pagato in parte', cls: 'warn' }
  return { icona: '⏳', testo: 'Non pagato', cls: 'warn' }
}

// Badge completo: icona SEMPRE seguita dall'etichetta testuale.
// Mai il solo colore, mai la sola icona: chi legge deve capire senza dover
// interpretare una sfumatura.
function badgePagamento(verso, stato) {
  var e = etichettaPagamento(verso, stato)
  return badge(e.cls, e.icona + ' ' + e.testo)
}

// Testo del bottone che porta ALLO stato indicato.
// Deriva dallo stesso vocabolario dei badge, cosi' anche le azioni dicono
// «Segna da incassare» su una vendita e «Segna pagato» su un acquisto, senza
// che nessuno debba ricordarsi a mano quale parola va dove.
function azionePagamento(verso, statoTarget) {
  var e = etichettaPagamento(verso, statoTarget)
  return (statoTarget === 'pagato' ? '✅' : '↩️') + ' Segna ' + e.testo.toLowerCase()
}

function loadingRow(msg) {
  return '<div class="loading-row"><span class="spinner" aria-hidden="true"></span><span>' + esc(msg) + '</span></div>'
}

function checkRow(ok, name, detail) {
  const cls  = ok === null ? 'warn' : ok ? 'ok' : 'err'
  const icon = ok === null ? '⚠️'   : ok ? '✅' : '❌'
  return (
    '<div class="check-row ' + cls + '">' +
      '<span class="check-icon" aria-hidden="true">' + icon + '</span>' +
      '<span class="check-name">' + esc(name) + '</span>' +
      '<span class="check-detail">' + esc(detail) + '</span>' +
    '</div>'
  )
}

function fmtDate(dateStr) {
  if (!dateStr) return '—'
  try {
    return new Date(dateStr).toLocaleDateString('it-CH', { day: '2-digit', month: '2-digit', year: 'numeric' })
  } catch (_) { return dateStr }
}

function fmtImporto(importo, valuta) {
  if (importo == null) return '<span class="dim">n/d</span>'
  const n = parseFloat(importo)
  if (isNaN(n)) return '<span class="dim">n/d</span>'
  return esc(fmtNumIt(n) + ' ' + (valuta || 'CHF'))
}

// Numero in formato italiano: 15.000,00 — punto migliaia, virgola decimali.
// REGOLA FISSA del progetto: mai il formato svizzero 15'000.00.
// Si passa da qui per ogni cifra mostrata nel cruscotto.
function fmtNumIt(n) {
  if (n == null || isNaN(n)) return '0,00'
  // minimumGroupingDigits: 1 forza il punto anche sotto le cinque cifre.
  // Senza, l'italiano scrive «1200,00» e mette il punto solo da 10.000 in su:
  // due cifre uguali si leggerebbero in due modi diversi nella stessa colonna.
  try {
    return Number(n).toLocaleString('it-IT', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
      useGrouping: true, minimumGroupingDigits: 1
    })
  } catch (_) {
    // Browser che non conosce minimumGroupingDigits: si ripiega sul raggruppamento
    // predefinito, che resta leggibile.
    return Number(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
}

// Converte in numero finito oppure null (mai NaN che si propaga nei calcoli)
function safeNum(v) {
  if (v == null || v === '') return null
  const n = parseFloat(v)
  return isNaN(n) ? null : n
}

// Formatta un numero a 2 decimali per la UI; '—' se non disponibile.
// Passa da fmtNumIt: il formato italiano si decide in un posto solo.
function fmtNum2(n) {
  if (n == null || isNaN(n)) return '—'
  return fmtNumIt(n)
}

// ─── Navigazione pagine ───────────────────────────────────────────────────────
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active') })
  document.querySelectorAll('.nav-item[data-page]').forEach(function (n) { n.classList.remove('active') })
  const page = el('page-' + pageId)
  if (page) page.classList.add('active')
  const navBtn = document.querySelector('.nav-item[data-page="' + pageId + '"]')
  if (navBtn) navBtn.classList.add('active')
  var cambiata = (currentPage !== pageId)
  currentPage = pageId
  // La schermata entra nella cronologia: cosi' il tasto Indietro torna qui
  // invece di uscire dal programma. Durante un «indietro» non si ripusha.
  if (cambiata) spingiStato(pageId, vistaCorrente[pageId], false)
}

// ─── Stato auth nella sidebar ─────────────────────────────────────────────────
function updateSidebarAuth() {
  const userDiv  = el('sidebar-user')
  const emailEl  = el('sidebar-user-email')
  const authBtns = document.querySelectorAll('.nav-item.auth-only')

  if (currentUser) {
    if (userDiv)  { userDiv.style.display = 'block' }
    if (emailEl)  { emailEl.textContent = currentUser.email || 'Utente' }
    authBtns.forEach(function (btn) {
      btn.removeAttribute('disabled')
      btn.removeAttribute('aria-disabled')
      btn.classList.remove('disabled')
    })
  } else {
    if (userDiv)  { userDiv.style.display = 'none' }
    authBtns.forEach(function (btn) {
      btn.setAttribute('disabled', '')
      btn.setAttribute('aria-disabled', 'true')
      btn.classList.add('disabled')
    })
  }
}

// ─── Auth — login / logout ────────────────────────────────────────────────────
async function doLogin() {
  const emailEl  = el('login-email')
  const passEl   = el('login-password')
  const btnEl    = el('login-btn')
  const errDiv   = el('login-error')
  const errMsg   = el('login-error-msg')

  if (errDiv) errDiv.style.display = 'none'
  if (btnEl)  { btnEl.disabled = true; btnEl.textContent = '⏳ Accesso…' }

  try {
    const email    = emailEl ? emailEl.value.trim() : ''
    const password = passEl  ? passEl.value         : ''
    if (!email || !password) throw new Error('Inserisci email e password.')

    const { data, error } = await sb.auth.signInWithPassword({ email: email, password: password })
    if (error) throw error

    currentUser = data.user
    await loadAziendaId()
    updateSidebarAuth()
    showPage('setup')
    runSetupCheck()
    await refreshDaClassificareCount()
    // FASE 4 — badge delle scadenze e, se serve, la finestrella di riepilogo
    await refreshScadenzeCount()
    forseMostraFinestraScadenze()
  } catch (e) {
    if (errDiv) { errDiv.style.display = 'flex' }
    if (errMsg) { errMsg.textContent = e.message || 'Errore di accesso.' }
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Accedi' }
  }
}

async function doLogout() {
  try {
    await sb.auth.signOut()
  } catch (_) { /* ignora errori di logout */ }
  currentUser = null
  currentAziendaId = null
  // FASE 23 / P2 — i dati della ditta se ne vanno con la sessione. Restavano
  // in memoria dopo l'uscita, e chi fosse entrato dopo si sarebbe trovato
  // l'intestazione della ditta precedente su un documento nuovo.
  aziendaInfo = null
  updateSidebarAuth()
  html('nav-badge-movimenti', '0')
  showPage('login')
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 22 / P2 — CAMBIA PASSWORD
//
// Prima si doveva uscire dal programma e andare su Supabase per una cosa che
// si fa da dentro.
//
// LA PASSWORD ATTUALE SI VERIFICA DAVVERO, e non e' una formalita':
// sb.auth.updateUser({ password }) da solo cambia la password a chiunque abbia
// in mano una sessione aperta. Senza questa verifica, chi si siede al computer
// di Umberto mentre il programma e' aperto puo' cambiargli la password e
// chiuderlo fuori dal suo gestionale. Si rifa' percio' il login con
// signInWithPassword sull'email in sessione, e solo se passa si cambia.
//
// signInWithPassword sullo STESSO utente rinnova la sessione al posto di
// chiuderla: dopo il cambio si resta dentro.
//
// I messaggi sono in italiano, sempre. Il testo grezzo di Supabase («Password
// should be at least 6 characters») non arriva mai a schermo: finisce in
// console per chi deve capirci qualcosa, e all'utente si dice cos'e' successo.
// ══════════════════════════════════════════════════════════════════════════════

var LUNGHEZZA_MINIMA_PASSWORD = 8

// L'errore di Supabase tradotto. Quello che non si riconosce non si mostra:
// meglio una frase generica ma comprensibile di una inglese e precisa.
function messaggioErrorePassword(e) {
  var m = String((e && e.message) || '').toLowerCase()
  if (m.indexOf('should be at least') !== -1 || m.indexOf('at least') !== -1 ||
      m.indexOf('too short') !== -1 || m.indexOf('weak') !== -1) {
    return 'La nuova password è troppo corta o troppo semplice: usane una di almeno ' +
           LUNGHEZZA_MINIMA_PASSWORD + ' caratteri.'
  }
  if (m.indexOf('different from the old') !== -1 || m.indexOf('same as the old') !== -1) {
    return 'La nuova password deve essere diversa da quella attuale.'
  }
  if (m.indexOf('rate limit') !== -1 || m.indexOf('too many') !== -1) {
    return 'Troppi tentativi di seguito. Aspetta un minuto e riprova.'
  }
  if (m.indexOf('failed to fetch') !== -1 || m.indexOf('network') !== -1) {
    return 'Non c’è collegamento con il server: controlla internet e riprova.'
  }
  return 'Non è stato possibile cambiare la password. Riprova.'
}

async function cambiaPassword() {
  html('imp-pwd-banner', '')
  // NON si usa getVal: quello fa .trim(), e una password puo' legittimamente
  // cominciare o finire con uno spazio. Tagliarlo vorrebbe dire rifiutare la
  // password giusta, o peggio salvarne una diversa da quella scritta.
  function valorePwd(id) { var e = el(id); return e ? e.value : '' }
  var attuale  = valorePwd('imp-pwd-attuale')
  var nuova    = valorePwd('imp-pwd-nuova')
  var conferma = valorePwd('imp-pwd-conferma')

  function stop(msg) { showFattureBanner('imp-pwd-banner', 'err', msg) }

  if (!attuale)  { stop('Scrivi la password che usi adesso.'); return }
  if (!nuova)    { stop('Scrivi la nuova password.'); return }
  if (nuova.length < LUNGHEZZA_MINIMA_PASSWORD) {
    stop('La nuova password è troppo corta: servono almeno ' +
         LUNGHEZZA_MINIMA_PASSWORD + ' caratteri.'); return
  }
  if (nuova !== conferma) {
    stop('Le due nuove password non coincidono: riscrivile uguali.'); return
  }
  if (nuova === attuale) {
    stop('La nuova password è uguale a quella di adesso: non cambierebbe niente.'); return
  }

  // L'email dell'utente in sessione. Se non c'e', non c'e' nemmeno la sessione.
  var email = currentUser && currentUser.email ? currentUser.email : null
  if (!email) {
    try {
      const { data } = await sb.auth.getSession()
      if (data && data.session && data.session.user) email = data.session.user.email
    } catch (_) { /* resta null, gestito sotto */ }
  }
  if (!email) { stop('La sessione è scaduta: rientra e riprova.'); return }

  var btn = el('imp-pwd-btn')
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Cambio in corso…' }
  try {
    // 1. La password attuale e' quella giusta? Se no, si esce senza cambiare.
    const verifica = await sb.auth.signInWithPassword({ email: email, password: attuale })
    if (verifica.error) {
      console.warn('Cambio password — verifica fallita:', verifica.error.message)
      stop('La password attuale non è corretta.')
      return
    }

    // 2. Solo adesso si cambia.
    const { error } = await sb.auth.updateUser({ password: nuova })
    if (error) {
      console.error('Cambio password — updateUser:', error)
      stop(messaggioErrorePassword(error))
      return
    }

    setVal('imp-pwd-attuale', '')
    setVal('imp-pwd-nuova', '')
    setVal('imp-pwd-conferma', '')
    showFattureBanner('imp-pwd-banner', 'ok',
      'Password cambiata. La sessione resta aperta: non devi rientrare. ' +
      'Dalla prossima volta entra con quella nuova.')
  } catch (e) {
    console.error('Cambio password:', e)
    stop(messaggioErrorePassword(e))
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔑 Cambia la password' }
  }
}

// ─── Carica azienda_id dall'utente loggato ────────────────────────────────────
async function loadAziendaId() {
  if (!currentUser) { currentAziendaId = null; return }
  try {
    const { data, error } = await sb
      .from('tm_utenti')
      .select('azienda_id')
      .eq('id', currentUser.id)
      .single()
    if (error) throw error
    currentAziendaId = data ? data.azienda_id : null
  } catch (e) {
    currentAziendaId = null
    console.warn('loadAziendaId:', e.message)
  }
}

// ─── CANALE A — legge spese e regia (App Cantieri) ───────────────────────────
async function loadCanalA() {
  const movimenti = []

  // FASE 23 / P2 — LA GUARDIA SULLA SESSIONE, ANCHE QUI.
  //
  // `spese` e `regia` sono tabelle di App Cantieri protette da RLS: senza
  // sessione la lettura NON da' errore, restituisce zero righe. Le altre due
  // sorgenti sono gia' dentro `if (currentAziendaId)`, queste no.
  //
  // Il guaio non era un elenco vuoto: era che il riquadro dei movimenti
  // mostrava il banner VERDE «Tutti i movimenti classificati!» proprio quando
  // il programma non aveva potuto leggere niente. Un messaggio di successo su
  // un dato mancante e' peggio di nessun messaggio. Adesso si LANCIA, cosi' il
  // chiamante lo raccoglie e scrive «Alcune sorgenti non hanno risposto».
  if (!currentAziendaId) {
    throw new Error('Sessione non attiva: le spese e la regia di App Cantieri non si possono leggere. Rientra e riprova.')
  }

  // spese: id, data, descrizione, importo, valuta, cantiere_id, note
  try {
    const { data, error } = await sb
      .from('spese')
      .select('id, data, descrizione, importo, valuta, cantiere_id, note')
      .order('data', { ascending: false })
    if (error) throw error
    for (var i = 0; i < (data || []).length; i++) {
      var s = data[i]
      movimenti.push({
        origine_tipo: 'spesa',
        origine_id:   s.id,
        data:         s.data,
        descrizione:  s.descrizione || '(senza descrizione)',
        importo:      safeNum(s.importo),
        valuta:       s.valuta || 'CHF',
        cantiere_id:  s.cantiere_id || null,
        ente:         null,
        extra:        s.cantiere_id ? 'Cantiere ' + s.cantiere_id : null,
        _sorgente:    'App Cantieri',
        _tipo_label:  'Spesa',
        _icon:        '📦',
        _match_field: 'desc',
        _match_value: s.descrizione || null
      })
    }
  } catch (e) {
    console.warn('Canale A / spese:', e.message)
  }

  // regia: SEMPRE lato ricavo.
  //   fatturato=true  → importo = quantita × prezzo_unitario  (da classificare, proposta 3100)
  //   fatturato=false → informativa "da fatturare", importo null, NESSUN conto assegnato
  //   costo_unitario NON usato: evita doppio conteggio con il payroll
  try {
    const { data, error } = await sb
      .from('regia')
      .select('id, data, descrizione, cantiere_id, operaio_id, tipo, quantita, prezzo_unitario, um, fatturato, note')
      .order('data', { ascending: false })
    if (error) throw error
    for (var j = 0; j < (data || []).length; j++) {
      var r = data[j]

      var isFat = r.fatturato === true || r.fatturato === 'true'
      var qta   = safeNum(r.quantita)
      var pru   = safeNum(r.prezzo_unitario)

      // Importo solo se fatturata e dati disponibili; altrimenti null (informativa)
      var importoCalc = null
      if (isFat && qta != null && pru != null) {
        importoCalc = Math.round(qta * pru * 100) / 100
      }

      var descParts = [r.descrizione]
      if (r.tipo) descParts.push('[' + r.tipo + ']')
      if (qta != null && r.um) descParts.push(qta + ' ' + r.um)

      movimenti.push({
        origine_tipo: 'regia',
        origine_id:   r.id,
        data:         r.data,
        descrizione:  descParts.filter(Boolean).join(' ') || '(regia)',
        importo:      importoCalc,
        valuta:       'CHF',
        cantiere_id:  r.cantiere_id || null,
        ente:         null,
        extra:        r.cantiere_id ? 'Cantiere ' + r.cantiere_id : null,
        _sorgente:    'App Cantieri',
        _tipo_label:  isFat ? 'Regia · Ricavo fatturato' : 'Regia · Da fatturare',
        _icon:        isFat ? '🔧' : '📋',
        _fatturato:   isFat,
        _match_field: 'desc',
        _match_value: r.descrizione || null
      })
    }
  } catch (e) {
    console.warn('Canale A / regia:', e.message)
  }

  // fatture emesse (Fase 6) → entrano nel Registratore come origine_tipo='fattura' (lato ricavo).
  // La fattura resta la sua casa: qui si LEGGE soltanto, la classificazione la arricchisce.
  if (currentAziendaId) {
    try {
      const { data, error } = await sb
        .from('tm_conta_fatture')
        .select('id, numero, data_emissione, cliente_nome, totale, valuta, tipo, stato')
        .eq('azienda_id', currentAziendaId)
        .eq('stato', 'emessa')
        .order('data_emissione', { ascending: false })
      if (error) throw error
      for (var f = 0; f < (data || []).length; f++) {
        var ft = data[f]
        var isNC = ft.tipo === 'nota_credito'
        var tot = safeNum(ft.totale)
        var imp = tot == null ? null : (isNC ? -tot : tot)   // nota di credito = storno (negativo)
        movimenti.push({
          origine_tipo: 'fattura',
          origine_id:   ft.id,
          data:         ft.data_emissione,
          descrizione:  (isNC ? 'Nota di credito ' : 'Fattura ') + (ft.numero || '') + ' — ' + (ft.cliente_nome || ''),
          importo:      imp,
          valuta:       ft.valuta || 'CHF',
          cantiere_id:  null,
          ente:         ft.cliente_nome || null,
          extra:        ft.cliente_nome ? 'Cliente: ' + ft.cliente_nome : null,
          _sorgente:    'Fatture',
          _tipo_label:  isNC ? 'Nota di credito' : 'Fattura emessa',
          _icon:        isNC ? '↩️' : '🧾',
          _match_field: 'desc',
          _match_value: ft.cliente_nome || null
        })
      }
    } catch (e) {
      console.warn('Canale A / fatture:', e.message)
    }
  }

  // fatture d'acquisto (Fase 10) → entrano nel Registratore come origine_tipo='acquisto'
  // (lato costo, importo positivo). Restano la loro casa: qui si LEGGONO soltanto.
  if (currentAziendaId) {
    try {
      const { data, error } = await sb
        .from('tm_conta_fatture_acquisto')
        .select('id, fornitore, numero_fornitore, data, importo, valuta, codice_iva_id')
        .eq('azienda_id', currentAziendaId)
        .order('data', { ascending: false })
      if (error) throw error
      for (var q = 0; q < (data || []).length; q++) {
        var acq = data[q]
        var desc = 'Acquisto' + (acq.numero_fornitore ? ' ' + acq.numero_fornitore : '') + ' — ' + (acq.fornitore || '')
        movimenti.push({
          origine_tipo: 'acquisto',
          origine_id:   acq.id,
          // FASE 20 — il codice IVA e' gia' sul documento: si porta fin qui,
          // cosi' la classificazione non lo richiede da capo.
          codice_iva_id: acq.codice_iva_id || null,
          data:         acq.data,
          descrizione:  desc,
          importo:      safeNum(acq.importo),
          valuta:       acq.valuta || 'CHF',
          cantiere_id:  null,
          ente:         acq.fornitore || null,
          extra:        acq.fornitore ? 'Fornitore: ' + acq.fornitore : null,
          _sorgente:    'Fatture acquisto',
          _tipo_label:  'Fattura acquisto',
          _icon:        '📥',
          _match_field: 'ente',
          _match_value: acq.fornitore || null
        })
      }
    } catch (e) {
      console.warn('Canale A / acquisti:', e.message)
    }
  }

  return movimenti
}

// ─── CANALE B — legge tm_conta_movimenti_propri ────────────────────────────
async function loadCanalB() {
  if (!currentAziendaId) return []
  try {
    const { data, error } = await sb
      .from('tm_conta_movimenti_propri')
      .select('id, data, descrizione, ente_fornitore, importo, valuta, ricorrente, periodicita, created_at, stato_conferma')
      .eq('azienda_id', currentAziendaId)
      .order('data', { ascending: false })
    if (error) throw error
    return (data || []).map(function (m) {
      return {
        origine_tipo: 'proprio',
        origine_id:   m.id,
        data:         m.data,
        descrizione:  m.descrizione || '(senza descrizione)',
        importo:      safeNum(m.importo),
        valuta:       m.valuta || 'CHF',
        cantiere_id:  null,
        ente:         m.ente_fornitore || null,
        extra:        m.ente_fornitore || null,
        _sorgente:    'Inserito manualmente',
        _tipo_label:  m.ricorrente ? 'Manuale · Ricorrente (' + (m.periodicita || '') + ')' : 'Manuale',
        _icon:        m.ricorrente ? '🔄' : '🏢',
        _match_field: 'ente',
        _match_value: m.ente_fornitore || null
      }
    })
  } catch (e) {
    console.warn('Canale B:', e.message)
    return []
  }
}

// ─── LISTA «DA CLASSIFICARE» ──────────────────────────────────────────────────
async function loadDaClassificare() {
  if (!currentUser) {
    html('movimenti-banner',
      '<div class="fase-banner warn" role="alert">' +
        '<span class="icon" aria-hidden="true">🔐</span>' +
        '<div class="msg">Accesso richiesto<small>Effettua il login per visualizzare i movimenti.</small></div>' +
      '</div>'
    )
    html('movimenti-lista', '')
    return
  }

  html('movimenti-banner', '')
  html('movimenti-lista', loadingRow('Caricamento movimenti da Canale A (spese + regia) e Canale B…'))
  html('movimenti-sorgenti', '')

  var canalA = []
  var canalB = []
  var errori = []

  // Carica entrambi i canali
  try { canalA = await loadCanalA() } catch (e) { errori.push('Canale A: ' + e.message) }
  try { canalB = await loadCanalB() } catch (e) { errori.push('Canale B: ' + e.message) }

  var tutti = canalA.concat(canalB)

  // Carica le classificazioni già esistenti per questa azienda (riga completa)
  var classMap = {}   // "origine_tipo:origine_id" -> riga classificazione
  if (currentAziendaId) {
    try {
      const { data, error } = await sb
        .from('tm_conta_classificazioni')
        .select('id, origine_tipo, origine_id, conto_id, codice_iva_id, categoria, note, imponibile, iva_importo, iva_inclusa, cantiere_id, stato')
        .eq('azienda_id', currentAziendaId)
      if (error) throw error
      for (var k = 0; k < (data || []).length; k++) {
        classMap[data[k].origine_tipo + ':' + data[k].origine_id] = data[k]
      }
    } catch (e) {
      errori.push('Classificazioni: ' + e.message)
    }
  }
  classByKey = classMap   // disponibile ai guard di blocco (Fase 5)

  // Nomi leggibili conto/IVA (servono alla lista «classificati» e alla Storia)
  await ensureContiIva()

  // Separa non classificati / già classificati
  var daClass = []
  var classificati = []
  for (var t = 0; t < tutti.length; t++) {
    var mm = tutti[t]
    var cls = classMap[mm.origine_tipo + ':' + mm.origine_id]
    if (cls) { mm._class = cls; classificati.push(mm) }
    else { daClass.push(mm) }
  }

  function byDataDesc(a, b) { return (b.data || '').localeCompare(a.data || '') }
  daClass.sort(byDataDesc)
  classificati.sort(byDataDesc)

  // Rende le liste disponibili ai pannelli (per indice)
  daClassList = daClass
  classificatiList = classificati

  // Aggiorna badge nav + titolo pagina (conta i NON classificati)
  var count = daClass.length
  var badgeNav = el('nav-badge-movimenti')
  if (badgeNav) {
    badgeNav.textContent = String(count)
    badgeNav.setAttribute('aria-label', count + ' movimenti da classificare')
  }
  var countBadge = el('movimenti-count-badge')
  if (countBadge) {
    countBadge.textContent = count + ' da classificare'
    countBadge.className = 'badge badge-' + (count > 0 ? 'warn' : 'ok')
  }

  // Riquadro sorgenti
  var speseCnt = canalA.filter(function (m) { return m.origine_tipo === 'spesa' }).length
  var regiaCnt = canalA.filter(function (m) { return m.origine_tipo === 'regia' }).length
  var propriCnt = canalB.length
  // FASE 23 / P2 — se il Canale A non ha risposto, i suoi due contatori non
  // sono «zero»: sono «non lo so». Un 0 e uno «?» si leggono in modo diverso,
  // ed e' proprio la differenza fra «non c'e' niente» e «non ho letto niente».
  var canalAMuto = errori.some(function (x) { return String(x).indexOf('Canale A') === 0 })
  html('movimenti-sorgenti',
    '<div class="grid-3" style="margin-bottom:20px">' +
      statCard('📦 Spese', canalAMuto ? '?' : speseCnt,
               canalAMuto ? 'App Cantieri — non ha risposto' : 'App Cantieri — Canale A') +
      statCard('🔧 Regia', canalAMuto ? '?' : regiaCnt,
               canalAMuto ? 'App Cantieri — non ha risposto' : 'App Cantieri — Canale A') +
      statCard('🏢 Propri', propriCnt, 'Inseriti manualmente — Canale B') +
    '</div>'
  )

  // Banner errori (non bloccante)
  if (errori.length > 0) {
    html('movimenti-banner',
      '<div class="fase-banner warn" role="alert" style="margin-bottom:16px">' +
        '<span class="icon" aria-hidden="true">⚠️</span>' +
        '<div class="msg">Alcune sorgenti non hanno risposto<small>' + esc(errori.join(' · ')) + '</small></div>' +
      '</div>'
    )
  }

  // ── Sezione: da classificare ───────────────────────────────────────────────
  var sezioneDaClass
  if (daClass.length === 0 && errori.length > 0) {
    // FASE 23 / P2 — «Tutti classificati!» quando una sorgente non ha risposto
    // e' un complimento su un dato che non c'e'. Zero da classificare vale solo
    // se si e' letto tutto.
    sezioneDaClass =
      '<div class="fase-banner warn" role="alert">' +
        '<span class="icon" aria-hidden="true">⚠️</span>' +
        '<div class="msg">Non ci sono movimenti da classificare, ma non ho letto tutto.' +
          '<small>Qui sopra c’è scritto quale sorgente non ha risposto: finché non risponde, ' +
          'questo elenco non è completo e non vuol dire che il lavoro sia finito.</small>' +
        '</div>' +
      '</div>'
  } else if (daClass.length === 0) {
    sezioneDaClass =
      '<div class="fase-banner ok" role="status">' +
        '<span class="icon" aria-hidden="true">✅</span>' +
        '<div class="msg">Tutti i movimenti classificati!' +
          '<small>Ottimo lavoro. ' + esc(classificati.length) + ' movimenti sono già classificati. ' +
          'Quando ci sono nuove spese in App Cantieri o hai inserito nuovi movimenti manuali, premi Aggiorna.</small>' +
        '</div>' +
      '</div>'
  } else {
    var rows = ''
    for (var i = 0; i < daClass.length; i++) {
      var m = daClass[i]
      var isProprio = m.origine_tipo === 'proprio'
      var azioni =
        '<button class="icon-btn classify" onclick="event.stopPropagation(); openClassifyPanel(' + i + ')">🏷 Classifica</button>'
      if (isProprio) {
        azioni +=
          '<button class="icon-btn" title="Modifica" onclick="event.stopPropagation(); startEditFromRow(' + i + ')">✏️</button>' +
          '<button class="icon-btn danger" title="Elimina" onclick="event.stopPropagation(); deleteFromRow(' + i + ')">🗑️</button>'
      }
      rows += (
        '<tr class="row-clickable" onclick="openClassifyPanel(' + i + ')">' +
          '<td onclick="event.stopPropagation()" style="width:34px;text-align:center">' +
            '<input type="checkbox" class="row-check" data-idx="' + i + '" onclick="onRowCheck()" aria-label="Seleziona movimento">' +
          '</td>' +
          '<td class="dim num" style="white-space:nowrap">' + esc(fmtDate(m.data)) + '</td>' +
          '<td>' +
            '<div class="mov-desc">' + esc(m.descrizione) + '</div>' +
            (m.extra ? '<div class="dim" style="font-size:11px;margin-top:2px">' + esc(m.extra) + '</div>' : '') +
          '</td>' +
          '<td class="num">' + fmtImporto(m.importo, m.valuta) + '</td>' +
          '<td>' +
            '<span class="origin-tag">' +
              '<span aria-hidden="true">' + m._icon + '</span>' +
              '<span class="origin-label">' + esc(m._sorgente + ' · ' + m._tipo_label) + '</span>' +
            '</span>' +
          '</td>' +
          '<td class="row-actions">' + azioni + '</td>' +
        '</tr>'
      )
    }
    sezioneDaClass =
      '<div class="bulk-bar">' +
        '<label><input type="checkbox" id="check-all" onclick="toggleAllRows(this.checked)"> Seleziona tutti</label>' +
        '<span class="bulk-spacer"></span>' +
        '<button class="btn-primary" id="bulk-btn" onclick="openBulkPanel()" disabled>' +
          '🏷 Classifica selezionati (<span id="bulk-count">0</span>)' +
        '</button>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-title">' +
          '📋 Movimenti da classificare ' + badge('warn', daClass.length + ' totali') +
        '</div>' +
        '<div class="table-wrap"><table>' +
          '<thead><tr>' +
            '<th style="width:34px"></th>' +
            '<th style="width:100px">Data</th>' +
            '<th>Descrizione</th>' +
            '<th style="width:130px;text-align:right">Importo</th>' +
            '<th style="width:180px">Origine</th>' +
            '<th style="width:150px">Azioni</th>' +
          '</tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table></div>' +
        '<div class="sql-tip">' +
          'ℹ️ Clicca una riga (o «Classifica») per assegnare conto + IVA: ogni proposta è modificabile e nulla è ufficiale finché non valida il commercialista. ' +
          'Le voci «Regia · Da fatturare» non hanno ancora un importo. «n/d» = non disponibile dalla sorgente.' +
        '</div>' +
      '</div>'
  }

  // ── Sezione: già classificati (con Storia + Riclassifica) ──────────────────
  var sezioneClassificati = ''
  if (classificati.length) {
    var crows = ''
    for (var j = 0; j < classificati.length; j++) {
      var cm = classificati[j]
      var cc = cm._class
      var bloccato = cc.stato === 'bloccato'
      var azioniCls = '<button class="icon-btn" title="Storia modifiche" onclick="openStoria(' + j + ')">🕐 Storia</button>'
      if (bloccato) {
        azioniCls += '<span class="lock-tag" title="Periodo consegnato — sola lettura">🔒 Consegnato</span>'
      } else {
        azioniCls += '<button class="icon-btn classify" title="Riclassifica" onclick="openRiclassifica(' + j + ')">✏️ Riclassifica</button>'
      }
      crows += (
        '<tr>' +
          '<td class="dim num" style="white-space:nowrap">' + esc(fmtDate(cm.data)) + '</td>' +
          '<td>' +
            '<div class="mov-desc">' + esc(cm.descrizione) + '</div>' +
            (cm.extra ? '<div class="dim" style="font-size:11px;margin-top:2px">' + esc(cm.extra) + '</div>' : '') +
          '</td>' +
          '<td class="num">' + fmtImporto(cm.importo, cm.valuta) + '</td>' +
          '<td><span class="cod">' + esc(contoLabel(cc.conto_id)) + '</span></td>' +
          '<td>' + esc(ivaLabel(cc.codice_iva_id)) + '</td>' +
          '<td>' + statoBadge(cc.stato) + '</td>' +
          '<td class="row-actions">' + azioniCls + '</td>' +
        '</tr>'
      )
    }
    sezioneClassificati =
      '<div class="card">' +
        '<div class="card-title">✅ Già classificati ' + badge('ok', classificati.length + ' totali') + '</div>' +
        '<div class="table-wrap"><table>' +
          '<thead><tr>' +
            '<th style="width:100px">Data</th>' +
            '<th>Descrizione</th>' +
            '<th style="width:120px;text-align:right">Importo</th>' +
            '<th style="width:150px">Conto</th>' +
            '<th style="width:150px">Codice IVA</th>' +
            '<th style="width:90px">Stato</th>' +
            '<th style="width:170px">Azioni</th>' +
          '</tr></thead>' +
          '<tbody>' + crows + '</tbody>' +
        '</table></div>' +
        '<div class="sql-tip">🕐 «Storia» mostra chi ha cambiato cosa e quando (audit automatico a livello database). «Riclassifica» riapre la proposta, modificabile.</div>' +
      '</div>'
  }

  html('movimenti-lista', sezioneDaClass + sezioneClassificati)
}

// Aggiorna solo il badge nel nav (chiamato dopo insert Canale B)
async function refreshDaClassificareCount() {
  if (!currentUser || !currentAziendaId) return
  try {
    var canalA = await loadCanalA()
    var canalB = await loadCanalB()
    var tutti = canalA.concat(canalB)

    var classified = new Set()
    const { data, error } = await sb
      .from('tm_conta_classificazioni')
      .select('origine_tipo, origine_id')
      .eq('azienda_id', currentAziendaId)
    if (!error) {
      for (var k = 0; k < (data || []).length; k++) {
        classified.add(data[k].origine_tipo + ':' + data[k].origine_id)
      }
    }

    var count = tutti.filter(function (m) {
      return !classified.has(m.origine_tipo + ':' + m.origine_id)
    }).length

    var badgeNav = el('nav-badge-movimenti')
    if (badgeNav) {
      badgeNav.textContent = String(count)
      badgeNav.setAttribute('aria-label', count + ' movimenti da classificare')
    }
  } catch (_) { /* non bloccante */ }
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 3 — CLASSIFICAZIONE (conto + IVA)
// Ogni conto/IVA è una PROPOSTA modificabile: nulla è ufficiale finché non
// valida il commercialista.
// ══════════════════════════════════════════════════════════════════════════════

function round2(n) { return Math.round(n * 100) / 100 }

// Calcolo IVA — formula da istruzioni, NON inventata.
//   inclusa: imponibile = importo/(1+aliq/100); iva = importo − imponibile
//   esclusa: imponibile = importo;             iva = importo × aliq/100
//   aliquota 0: iva = 0, imponibile = importo
function calcolaIva(importo, aliquota, ivaInclusa) {
  var imp = safeNum(importo)
  if (imp == null) return { imponibile: null, iva: null, totale: null }
  var alq = safeNum(aliquota)
  if (alq == null || alq === 0) {
    return { imponibile: round2(imp), iva: 0, totale: round2(imp) }
  }
  if (ivaInclusa) {
    var imponibile = round2(imp / (1 + alq / 100))
    return { imponibile: imponibile, iva: round2(imp - imponibile), totale: round2(imp) }
  }
  var iva = round2(imp * alq / 100)
  return { imponibile: round2(imp), iva: iva, totale: round2(imp + iva) }
}

// Carica conti (pacchetto + propri) e codici IVA in cache (una volta).
async function ensureContiIva(force) {
  // Come per i gruppi: si controlla che ci sia DENTRO qualcosa. Un array vuoto
  // e' «vero» in JavaScript, e un tentativo fallito prima del login bloccava
  // ogni tentativo successivo.
  if (cacheOk('conti') && cacheOk('iva') && !force) return
  // FASE 22 — senza sessione non si legge niente, ma non e' una lettura
  // riuscita: segnarla tale bloccherebbe ogni tentativo dopo il login.
  // Stessa guardia di loadContatti e loadCantieri.
  if (!currentAziendaId) return
  try {
    const { data, error } = await sb
      .from('tm_conta_piano_conti')
      .select('id, codice_conto, descrizione, tipo, azienda_id, attivo, gruppo_codice')
      .eq('paese', 'CH')
      .eq('attivo', true)
      .order('codice_conto')
    if (error) throw error
    contiCache = data || []
    segnaCacheOk('conti')
  } catch (e) {
    // NON si scrive [] nella cache: il prossimo tentativo deve poter riuscire.
    contiCache = contiCache || []
    console.warn('Conti:', e.message)
  }
  try {
    const { data, error } = await sb
      .from('tm_conta_codici_iva')
      .select('id, codice, descrizione, aliquota')
      .eq('paese', 'CH')
      .eq('attivo', true)
      .order('aliquota', { ascending: false })
    if (error) throw error
    ivaCache = data || []
    segnaCacheOk('iva')
  } catch (e) {
    ivaCache = ivaCache || []
    console.warn('IVA:', e.message)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// LE CACHE — ricordarsi se la lettura e' RIUSCITA, non solo cosa ha dato
//
// Lo schema di prima era «if (xxxCache) return xxxCache», e un array vuoto in
// JavaScript e' vero. Una lettura fallita — tipicamente prima del login,
// quando la RLS blocca tutto — lasciava [] nella cache, e da li' in poi
// nessuno riprovava piu': i menu restavano vuoti per il resto della sessione,
// senza un errore da nessuna parte.
//
// Non basta pero' controllare che la cache abbia righe dentro: «zero righe» e
// «non sono riuscito a leggere» sono due cose diverse. La tabella spese di
// App Cantieri e' legittimamente vuota, e rileggerla a ogni chiamata perche'
// e' vuota sarebbe un difetto nuovo al posto di quello vecchio.
//
// Percio' la riuscita si tiene a parte, qui. Una lettura riuscita che non
// trova niente e' un risultato valido e non si ripete; una fallita si ritenta.
//
// La cache resta comunque un array anche dopo un errore: c'e' chi la legge
// senza passare dal caricatore, e trovarla a null farebbe rompere quel codice
// invece di mostrargli un elenco vuoto.
// ══════════════════════════════════════════════════════════════════════════════
var cacheRiuscite = {}
function cacheOk(nome)        { return cacheRiuscite[nome] === true }
function segnaCacheOk(nome)   { cacheRiuscite[nome] = true }
function scadeCache(nome)     { cacheRiuscite[nome] = false }

// Carica cantieri (sola lettura, con fallback progressivo). Mai bloccante.
async function loadCantieri(force) {
  if (cacheOk('cantieri') && !force) return
  // FASE 21 — LA CAUSA DELL'ELENCO SEMPRE VUOTO.
  // `cantieri` e' protetta da RLS: senza sessione la lettura non da' errore,
  // restituisce zero righe. Questa funzione la segnava come riuscita, e da
  // quel momento la cache diceva «nessun cantiere» per tutta la sessione,
  // anche dopo il login. E' lo stesso caso per cui loadContatti ha gia' la sua
  // guardia, con lo stesso commento: senza sessione non si legge niente, ma
  // non e' una lettura riuscita.
  if (!currentAziendaId) { cantieriCache = cantieriCache || []; return }
  try {
    // FASE 6A — servono anche luogo e stato: il luogo distingue due cantieri
    // con lo stesso nome, lo stato decide l'ordine della tendina.
    // 'cantieri' e' una tabella di App Cantieri, in produzione. Qui si legge
    // e basta. L'unica scrittura di tutto il programma su questa tabella e'
    // createCustomCantiere() (FASE 22 / P4), che inserisce una riga con
    // quattro colonne. Nessuna ALTER, nessun UPDATE, nessuna cancellazione.
    const { data, error } = await sb.from('cantieri')
      .select('id, nome, luogo, stato, committente').limit(500)
    if (error) throw error
    cantieriCache = (data || []).map(function (c) {
      return { id: c.id, nome: c.nome, luogo: c.luogo || null,
               stato: c.stato || null, committente: c.committente || null }
    })
    segnaCacheOk('cantieri')
    return
  } catch (e0) {
  try {
    const { data, error } = await sb.from('cantieri').select('id, nome').limit(500)
    if (error) throw error
    cantieriCache = (data || []).map(function (c) { return { id: c.id, nome: c.nome } })
    segnaCacheOk('cantieri')
    return
  } catch (e1) {
    try {
      const { data, error } = await sb.from('cantieri').select('id').limit(500)
      if (error) throw error
      cantieriCache = (data || []).map(function (c) { return { id: c.id, nome: null } })
      segnaCacheOk('cantieri')
      return
    } catch (e2) {
      // La cache resta un array vuoto per chi la legge, ma NON si segna come
      // riuscita: il prossimo tentativo riprova.
      cantieriCache = cantieriCache || []
      console.warn('Cantieri non disponibili:', e2.message)
    }
  }
  }
}

// L'ordine della tendina: prima quelli su cui si sta lavorando, in fondo i
// chiusi. Un cantiere completato NON si nasconde: e' proprio li' che si vede
// se ci si e' guadagnato.
function ordineStatoCantiere(stato) {
  var s = String(stato || '').toLowerCase()
  if (s.indexOf('attiv') !== -1) return 0
  if (s.indexOf('paus') !== -1 || s.indexOf('sospes') !== -1) return 1
  if (s.indexOf('complet') !== -1 || s.indexOf('chius') !== -1 || s.indexOf('finit') !== -1) return 2
  return 3     // stato sconosciuto: in fondo, ma comunque mostrato
}

// I cantieri ordinati per stato e poi per nome. Usata dalla tendina della
// classificazione e dalle schermate della FASE 6.
function cantieriOrdinati() {
  return (cantieriCache || []).slice().sort(function (a, b) {
    var d = ordineStatoCantiere(a.stato) - ordineStatoCantiere(b.stato)
    if (d !== 0) return d
    return String(a.nome || '').localeCompare(String(b.nome || ''), 'it')
  })
}

// Nome del cantiere come si legge nelle tendine e negli elenchi:
// «Skinner — Cadenazzo», con lo stato solo se non e' attivo.
function nomeCantiere(c, conStato) {
  if (!c) return ''
  var n = c.nome || String(c.id).slice(0, 8)
  if (c.luogo) n += ' — ' + c.luogo
  // FASE 21 — lo stato si scrive SEMPRE, anche sugli attivi: nella
  // classificazione compaiono anche i cantieri completati (si classificano
  // documenti di lavori finiti) e il nome da solo non dice quale sia quale.
  if (conStato && c.stato) n += ' (' + c.stato + ')'
  return n
}

// Costruisce le <option> del conto (filtrate), con conti propri etichettati "mio".
function buildContoOptions(filter, selectedId) {
  var conti = contiCache || []
  var f = (filter || '').toLowerCase().trim()
  if (f) {
    conti = conti.filter(function (c) {
      return (String(c.codice_conto) + ' ' + String(c.descrizione)).toLowerCase().indexOf(f) !== -1
    })
  }
  var pacchetto = conti.filter(function (c) { return c.azienda_id == null })
  var propri    = conti.filter(function (c) { return c.azienda_id != null })
  function opt(c) {
    var sel = (selectedId && c.id === selectedId) ? ' selected' : ''
    var mio = c.azienda_id != null ? ' — mio' : ''
    return '<option value="' + esc(c.id) + '"' + sel + '>' + esc(c.codice_conto + ' · ' + c.descrizione + mio) + '</option>'
  }
  if (!contiCache || !contiCache.length) {
    return '<option value="">⚠️ Piano dei conti non caricato — ricarica la pagina</option>'
  }
  if (!conti.length) return '<option value="" disabled>Nessun conto trovato con questo filtro</option>'
  var out = ''
  if (propri.length)    out += '<optgroup label="I miei conti">' + propri.map(opt).join('') + '</optgroup>'
  if (pacchetto.length) out += '<optgroup label="Pacchetto CH">' + pacchetto.map(opt).join('') + '</optgroup>'
  return out
}

function buildIvaOptions(selectedId) {
  var iva = ivaCache || []
  if (!iva.length) return '<option value="">⚠️ Codici IVA non caricati — ricarica la pagina</option>'
  var out = '<option value="">— Seleziona codice IVA —</option>'
  out += iva.map(function (c) {
    var alq = safeNum(c.aliquota)
    var alqLabel = (alq == null ? '?' : (alq === 0 ? '0' : fmtNum2(alq))) + '%'
    var sel = (selectedId && c.id === selectedId) ? ' selected' : ''
    return '<option value="' + esc(c.id) + '" data-aliquota="' + (alq == null ? '' : alq) + '"' + sel + '>' +
      esc(c.codice + ' · ' + c.descrizione + ' (' + alqLabel + ')') + '</option>'
  }).join('')
  return out
}

// FASE 20 — un menu con dentro solo «nessun cantiere» non dice se i cantieri
// non ci sono o se il programma non riesce a leggerli. La tabella `cantieri`
// e' di App Cantieri e si legge in sola lettura: se torna vuota, la causa piu'
// probabile sono i permessi di lettura, non un errore di questo programma.
function notaCantieriVuoti() {
  if (cantieriCache && cantieriCache.length) return ''
  return '<div class="form-hint" role="status">' +
           '⚠️ <strong>Nessun cantiere disponibile.</strong> I cantieri arrivano da ' +
           'App&nbsp;Cantieri. Se in App&nbsp;Cantieri ce ne sono, il permesso di lettura ' +
           'su questa tabella non è attivo per questo programma: la classificazione ' +
           'funziona lo stesso, il documento resta «Ditta (generale)». ' +
           'Con «➕ Nuovo cantiere» qui sopra ne puoi creare uno.' +
         '</div>'
}

function buildCantiereOptions(selectedId, includeGenerale) {
  // FASE 6A — «nessun cantiere» e' una risposta valida, non un campo lasciato
  // vuoto per distrazione: il testo lo dice.
  var out = includeGenerale ? '<option value="">— nessun cantiere (spesa aziendale) —</option>' : ''
  var list = cantieriOrdinati()
  var found = false
  for (var i = 0; i < list.length; i++) {
    var c = list[i]
    var sel = (selectedId && c.id === selectedId) ? ' selected' : ''
    if (sel) found = true
    out += '<option value="' + esc(c.id) + '"' + sel + '>' + esc(nomeCantiere(c, true)) + '</option>'
  }
  if (selectedId && !found) {
    out += '<option value="' + esc(selectedId) + '" selected>Cantiere ' + esc(String(selectedId).slice(0, 8)) + '…</option>'
  }
  return out
}

function filterConti() {
  var sel = el('cls-conto')
  if (!sel) return
  var current = sel.value
  sel.innerHTML = buildContoOptions(el('cls-conto-search') ? el('cls-conto-search').value : '', current)
}

function getSelectedAliquota() {
  var sel = el('cls-iva')
  if (!sel || sel.selectedIndex < 0) return null
  var opt = sel.options[sel.selectedIndex]
  return opt ? safeNum(opt.getAttribute('data-aliquota')) : null
}

function setIvaInclusa(v) {
  ivaInclusaState = !!v
  var on = el('cls-incl-on'), off = el('cls-incl-off')
  if (on)  on.classList.toggle('active', ivaInclusaState)
  if (off) off.classList.toggle('active', !ivaInclusaState)
  recalcIvaDisplay()
}

function calcBoxes(r, valuta) {
  var v = valuta || 'CHF'
  return (
    '<div class="calc-box"><div class="calc-label">Imponibile</div><div class="calc-value">' + fmtNum2(r.imponibile) + '</div></div>' +
    '<div class="calc-box"><div class="calc-label">IVA</div><div class="calc-value">' + fmtNum2(r.iva) + '</div></div>' +
    '<div class="calc-box tot"><div class="calc-label">Totale ' + esc(v) + '</div><div class="calc-value">' + fmtNum2(r.totale) + '</div></div>'
  )
}

function recalcIvaDisplay() {
  var box = el('cls-calc')
  if (!box) return
  var alq = getSelectedAliquota()
  if (classifyMode === 'single') {
    var m = classifyTargets[0]
    if (!m || m.importo == null) {
      box.innerHTML = '<div class="calc-box"><div class="calc-label">Importo non disponibile</div><div class="calc-value">—</div></div>'
      return
    }
    box.innerHTML = calcBoxes(calcolaIva(m.importo, alq, ivaInclusaState), m.valuta)
    return
  }
  // bulk: somma indicativa (per ciascun movimento viene comunque salvato il suo)
  var tot = { imponibile: 0, iva: 0, totale: 0 }
  var anyAmount = false
  for (var i = 0; i < classifyTargets.length; i++) {
    var t = classifyTargets[i]
    if (t.importo == null) continue
    anyAmount = true
    var rr = calcolaIva(t.importo, alq, ivaInclusaState)
    tot.imponibile += rr.imponibile || 0
    tot.iva       += rr.iva || 0
    tot.totale    += rr.totale || 0
  }
  if (!anyAmount) {
    box.innerHTML = '<div class="calc-box"><div class="calc-label">Nessun importo nei selezionati</div><div class="calc-value">—</div></div>'
    return
  }
  tot.imponibile = round2(tot.imponibile); tot.iva = round2(tot.iva); tot.totale = round2(tot.totale)
  box.innerHTML =
    '<div style="width:100%;font-size:11px;color:var(--text2);margin-bottom:6px">Totale indicativo sui ' + classifyTargets.length + ' movimenti:</div>' +
    calcBoxes(tot, 'CHF')
}

function showClsBanner(tipo, msg) {
  var b = el('cls-banner')
  if (!b) return
  var cls  = tipo === 'ok' ? 'ok' : tipo === 'warn' ? 'warn' : 'err'
  var icon = tipo === 'ok' ? '✅' : tipo === 'warn' ? '⚠️' : '❌'
  b.innerHTML = '<div class="fase-banner ' + cls + '" style="margin-bottom:14px">' +
    '<span class="icon" aria-hidden="true">' + icon + '</span><div class="msg">' + esc(msg) + '</div></div>'
}

// ── Selezione righe (classificazione in blocco) ──────────────────────────────
function getCheckedIdxs() {
  var idxs = []
  document.querySelectorAll('.row-check').forEach(function (b) {
    if (b.checked) idxs.push(parseInt(b.getAttribute('data-idx'), 10))
  })
  return idxs
}
function onRowCheck() { updateBulkButton() }
function toggleAllRows(checked) {
  document.querySelectorAll('.row-check').forEach(function (b) { b.checked = checked })
  updateBulkButton()
}
function updateBulkButton() {
  var n = getCheckedIdxs().length
  var btn = el('bulk-btn'), cnt = el('bulk-count')
  if (cnt) cnt.textContent = String(n)
  if (btn) btn.disabled = n === 0
}

// ── Apertura pannello (singolo) ──────────────────────────────────────────────
// prefill = riga di classificazione esistente (riclassifica) oppure null (nuova)
async function openSingleClassify(m, prefill) {
  if (!m) return
  classifyMode = 'single'
  classifyTargets = [m]

  el('cls-title').textContent = prefill ? '✏️ Riclassifica movimento' : '🏷 Classifica movimento'
  el('cls-banner').innerHTML = ''
  el('cls-suggest').style.display = 'none'
  el('cls-nuovo-conto').style.display = 'none'
  if (el('cls-nuovo-cantiere')) el('cls-nuovo-cantiere').style.display = 'none'
  el('cls-note').value = (prefill && prefill.note) ? prefill.note : ''
  el('cls-conto-search').value = ''
  el('cls-cantiere-group').style.display = 'block'
  el('cls-cantiere-bulk-group').style.display = 'none'

  el('cls-summary').innerHTML =
    '<div class="cls-sum-desc">' + esc(m.descrizione) + '</div>' +
    '<div class="cls-sum-meta">' +
      '<span>📅 ' + esc(fmtDate(m.data)) + '</span>' +
      '<span class="cls-sum-amount">' + fmtImporto(m.importo, m.valuta) + '</span>' +
      '<span>' + esc(m._sorgente + ' · ' + m._tipo_label) + '</span>' +
    '</div>'

  el('classify-overlay').style.display = 'flex'
  registraAperturaModale('classify-overlay')

  await ensureContiIva()
  await loadCantieri()
  el('cls-conto').innerHTML = buildContoOptions('', prefill ? prefill.conto_id : null)
  preparaCampoGruppo()
  // FASE 20 — ordine delle fonti: una classificazione gia' fatta vince su
  // tutto (e' una decisione presa), poi il codice IVA scritto sul documento.
  // Resta modificabile: una spesa si puo' dividere su conti con IVA diversa.
  el('cls-iva').innerHTML = buildIvaOptions(
    prefill ? prefill.codice_iva_id : (m.codice_iva_id || null))
  el('cls-cantiere').innerHTML = buildCantiereOptions(prefill ? prefill.cantiere_id : m.cantiere_id, true)
  html('cls-cantiere-vuoto', notaCantieriVuoti())
  setIvaInclusa(prefill ? (prefill.iva_inclusa !== false) : true)

  // Suggerimento solo per una classificazione nuova (non in riclassifica)
  if (!prefill) {
    try {
      var s = await suggestClassificazione(m)
      if (s) applySuggestion(s)
    } catch (_) { /* suggerimento non bloccante */ }
  }
}

async function openClassifyPanel(idx) { return openSingleClassify(daClassList[idx], null) }

async function openRiclassifica(idx) {
  var m = classificatiList[idx]
  if (!m) return
  if (m._class && m._class.stato === 'bloccato') {
    alert('Periodo consegnato (bloccato). Riaprilo dalla pagina «Export & consegna» per riclassificare.')
    return
  }
  return openSingleClassify(m, m._class)
}

// ── Apertura pannello (in blocco) ────────────────────────────────────────────
async function openBulkPanel() {
  var idxs = getCheckedIdxs()
  if (!idxs.length) return
  classifyMode = 'bulk'
  classifyTargets = idxs.map(function (i) { return daClassList[i] }).filter(Boolean)
  if (!classifyTargets.length) return

  el('cls-title').textContent = '🏷 Classifica ' + classifyTargets.length + ' movimenti'
  el('cls-banner').innerHTML = ''
  el('cls-suggest').style.display = 'none'
  el('cls-nuovo-conto').style.display = 'none'
  if (el('cls-nuovo-cantiere')) el('cls-nuovo-cantiere').style.display = 'none'
  el('cls-note').value = ''
  el('cls-conto-search').value = ''
  el('cls-cantiere-group').style.display = 'none'
  el('cls-cantiere-bulk-group').style.display = 'block'
  el('cls-cantiere-comune-chk').checked = false
  el('cls-cantiere-comune').style.display = 'none'

  var listHtml = classifyTargets.map(function (m) {
    return '<div class="cls-sum-list-item"><span>' + esc(fmtDate(m.data) + ' · ' + m.descrizione) + '</span><span>' + fmtImporto(m.importo, m.valuta) + '</span></div>'
  }).join('')
  el('cls-summary').innerHTML =
    '<div class="cls-sum-desc">' + classifyTargets.length + ' movimenti selezionati</div>' +
    '<div class="cls-sum-list">' + listHtml + '</div>'

  el('classify-overlay').style.display = 'flex'
  registraAperturaModale('classify-overlay')

  await ensureContiIva()
  await loadCantieri()
  el('cls-conto').innerHTML = buildContoOptions('', null)
  preparaCampoGruppo()
  el('cls-iva').innerHTML = buildIvaOptions(null)
  el('cls-cantiere-comune').innerHTML = buildCantiereOptions(null, true)
  html('cls-cantiere-bulk-vuoto', notaCantieriVuoti())
  setIvaInclusa(true)
}

function closeClassifyPanel() {
  var o = el('classify-overlay')
  if (o) o.style.display = 'none'
  classifyTargets = []
}

function toggleCantiereComune(checked) {
  var sel = el('cls-cantiere-comune')
  if (sel) sel.style.display = checked ? 'block' : 'none'
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 22 / P4 — CREARE UN CANTIERE DA QUI
//
// ATTENZIONE, e' un cambio di regola. Fino alla FASE 21 questo programma su
// `cantieri` LEGGEVA soltanto: e' la tabella dell'App Cantieri, in produzione.
// Da adesso ci scrive, ma per una sola operazione e su quattro colonne:
// nome (l'unico obbligatorio), luogo, committente, stato.
//
// Le altre nove colonne della tabella (via, cap, citta, email_committente,
// telefono_committente, paese, note) esistono e restano dell'App Cantieri:
// metterle anche qui vorrebbe dire due porte sullo stesso dato, che e' il modo
// piu' rapido di farlo divergere.
//
// `stato` non ha nessun CHECK sul database, ma si scrive 'Attivo' con la A
// maiuscola perche' e' il valore reale usato in tabella (gli altri cantieri
// hanno 'Attivo' e 'Completato') ed e' quello che l'App Cantieri si aspetta.
// ══════════════════════════════════════════════════════════════════════════════

function toggleNuovoCantiere() {
  var box = el('cls-nuovo-cantiere')
  if (!box) return
  var apri = box.style.display === 'none'
  box.style.display = apri ? 'block' : 'none'
  html('cls-nuovo-cantiere-banner', '')
  if (apri && el('ncant-nome')) el('ncant-nome').focus()
}

// Il rifiuto delle policy non e' un errore da mostrare grezzo: e' una cosa
// che si risolve una volta sola, e va detto cosa fare.
function eRifiutoPolicy(e) {
  var c = String((e && e.code) || '')
  var m = String((e && e.message) || '').toLowerCase()
  return c === '42501' || m.indexOf('row-level security') !== -1 ||
         m.indexOf('violates row') !== -1 || m.indexOf('policy') !== -1
}

async function createCustomCantiere() {
  var nome = el('ncant-nome') ? el('ncant-nome').value.trim() : ''
  var luogo = el('ncant-luogo') ? el('ncant-luogo').value.trim() : ''
  var committente = el('ncant-committente') ? el('ncant-committente').value.trim() : ''

  function stop(msg) { showFattureBanner('cls-nuovo-cantiere-banner', 'err', msg) }
  if (!nome) { stop('Il nome del cantiere è obbligatorio.'); return }
  if (!currentAziendaId) { stop('Sessione non attiva: rientra e riprova.'); return }

  var btn = el('ncant-save-btn')
  if (btn) { btn.disabled = true; btn.textContent = '⏳…' }
  try {
    const { data, error } = await sb
      .from('cantieri')
      .insert({
        nome: nome,
        luogo: luogo || null,
        committente: committente || null,
        stato: 'Attivo'
      })
      .select('id, nome, luogo, stato, committente')
    if (error) throw error

    var nuovo = data && data[0]
    if (!nuovo) throw new Error('Il database non ha restituito il cantiere appena creato.')

    // Nella cache subito, cosi' e' scegliibile senza ricaricare la pagina.
    if (!cantieriCache) cantieriCache = []
    cantieriCache.push({
      id: nuovo.id, nome: nuovo.nome, luogo: nuovo.luogo || null,
      stato: nuovo.stato || 'Attivo', committente: nuovo.committente || null
    })

    // Le due tendine: quella singola e quella del blocco massivo, se aperta.
    if (el('cls-cantiere')) el('cls-cantiere').innerHTML = buildCantiereOptions(nuovo.id, true)
    if (el('cls-cantiere-comune')) {
      var precedente = el('cls-cantiere-comune').value
      el('cls-cantiere-comune').innerHTML = buildCantiereOptions(precedente || nuovo.id, true)
    }
    // L'avviso «nessun cantiere» non ha piu' ragione di esserci.
    html('cls-cantiere-vuoto', '')
    html('cls-cantiere-bulk-vuoto', '')

    if (el('ncant-nome')) el('ncant-nome').value = ''
    if (el('ncant-luogo')) el('ncant-luogo').value = ''
    if (el('ncant-committente')) el('ncant-committente').value = ''
    toggleNuovoCantiere()
    showClsBanner('ok', 'Cantiere «' + nomeCantiere(nuovo, false) + '» creato e già selezionato.')
  } catch (e) {
    if (eRifiutoPolicy(e)) {
      console.error('Creazione cantiere rifiutata dalle policy:', e)
      stop('Il database non permette a questo programma di creare cantieri. ' +
           'È un permesso da aggiungere una volta sola: lancia SQL_FASE22_cantieri.sql ' +
           'dal SQL Editor di Supabase. Intanto non è stato creato niente.')
    } else {
      stop('Creazione cantiere: ' + (e.message || e))
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Crea cantiere' }
  }
}

// ── Conti personalizzati ─────────────────────────────────────────────────────
function toggleNuovoConto() {
  var box = el('cls-nuovo-conto')
  if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none'
}

async function createCustomConto() {
  var codice = el('nc-codice') ? el('nc-codice').value.trim() : ''
  var desc   = el('nc-descrizione') ? el('nc-descrizione').value.trim() : ''
  var tipo   = el('nc-tipo') ? el('nc-tipo').value : 'costo'
  if (!codice || !desc) { showClsBanner('err', 'Inserisci codice e descrizione del nuovo conto.'); return }
  if (!currentAziendaId) { showClsBanner('err', 'Azienda non definita: impossibile creare il conto.'); return }

  var btn = el('nc-save-btn')
  if (btn) { btn.disabled = true; btn.textContent = '⏳…' }
  try {
    const { data, error } = await sb
      .from('tm_conta_piano_conti')
      .insert({ paese: 'CH', codice_conto: codice, descrizione: desc, tipo: tipo, attivo: true, azienda_id: currentAziendaId })
      .select()
    if (error) throw error
    var nuovo = data && data[0]
    if (nuovo) {
      if (!contiCache) contiCache = []
      contiCache.push(nuovo)
      contiCache.sort(function (a, b) { return String(a.codice_conto).localeCompare(String(b.codice_conto)) })
    }
    el('cls-conto').innerHTML = buildContoOptions('', nuovo ? nuovo.id : null)
    // Conto creato al volo: anche qui il gruppo si riallinea al nuovo conto.
    aggiornaGruppoDaConto(true)
    if (el('cls-conto-search')) el('cls-conto-search').value = ''
    if (el('nc-codice')) el('nc-codice').value = ''
    if (el('nc-descrizione')) el('nc-descrizione').value = ''
    toggleNuovoConto()
    showClsBanner('ok', 'Conto «' + codice + '» creato (etichetta «mio»).')
    recalcIvaDisplay()
  } catch (e) {
    showClsBanner('err', 'Creazione conto: ' + e.message)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Crea conto' }
  }
}

// ── Suggerimento ultimo-usato (solo proposta) ────────────────────────────────
async function suggestClassificazione(mov) {
  if (!currentAziendaId || !mov._match_value) return null
  var ids = []
  try {
    if (mov.origine_tipo === 'proprio') {
      const { data, error } = await sb
        .from('tm_conta_movimenti_propri')
        .select('id')
        .eq('azienda_id', currentAziendaId)
        .eq('ente_fornitore', mov._match_value)
      if (error) throw error
      ids = (data || []).map(function (r) { return r.id })
    } else {
      const { data, error } = await sb
        .from(mov.origine_tipo === 'regia' ? 'regia' : 'spese')
        .select('id')
        .eq('descrizione', mov._match_value)
      if (error) throw error
      ids = (data || []).map(function (r) { return r.id })
    }
  } catch (e) { return null }

  ids = ids.filter(function (id) { return id !== mov.origine_id })
  if (!ids.length) return null

  try {
    const { data, error } = await sb
      .from('tm_conta_classificazioni')
      .select('conto_id, codice_iva_id, iva_inclusa, created_at')
      .eq('azienda_id', currentAziendaId)
      .eq('origine_tipo', mov.origine_tipo)
      .in('origine_id', ids)
      .order('created_at', { ascending: false })
      .limit(1)
    if (error) throw error
    if (data && data.length && data[0].conto_id) return data[0]
  } catch (e) { return null }
  return null
}

function applySuggestion(s) {
  if (!s) return
  // Il suggerimento cambia il conto dopo l'apertura: il gruppo deve seguirlo.
  if (s.conto_id) { el('cls-conto').innerHTML = buildContoOptions('', s.conto_id); aggiornaGruppoDaConto(true) }
  if (s.codice_iva_id) el('cls-iva').innerHTML = buildIvaOptions(s.codice_iva_id)
  setIvaInclusa(typeof s.iva_inclusa === 'boolean' ? s.iva_inclusa : true)

  var sg = el('cls-suggest')
  if (sg) {
    var conto = (contiCache || []).filter(function (c) { return c.id === s.conto_id })[0]
    sg.style.display = 'block'
    sg.innerHTML = '💡 <strong>Proposta</strong> dall\'ultima classificazione simile' +
      (conto ? ': conto ' + esc(conto.codice_conto + ' · ' + conto.descrizione) : '') +
      '. È solo un suggerimento, modificabile.'
  }
}

// ── Salvataggio classificazione (singolo o blocco) ───────────────────────────
function buildClassRow(m, contoId, ivaId, calc, inclusa, cantiere, note) {
  return {
    azienda_id:    currentAziendaId,
    origine_tipo:  m.origine_tipo,
    origine_id:    m.origine_id,
    conto_id:      contoId,
    codice_iva_id: ivaId,
    imponibile:    calc.imponibile,
    iva_importo:   calc.iva,
    iva_inclusa:   inclusa,
    cantiere_id:   cantiere || null,
    note:          note || null,
    stato:         'confermato',
    created_by:    currentUser ? currentUser.id : null,
    updated_by:    currentUser ? currentUser.id : null
  }
}

async function saveClassificazione() {
  if (!currentAziendaId) { showClsBanner('err', 'Azienda non definita.'); return }
  if (classifyMode === 'single' && classifyTargets[0] &&
      isBloccato(classifyTargets[0].origine_tipo, classifyTargets[0].origine_id)) {
    showClsBanner('err', 'Periodo consegnato (bloccato): sblocca il periodo dalla pagina Export per modificare.')
    return
  }
  var contoId = el('cls-conto') ? el('cls-conto').value : ''
  var ivaId   = el('cls-iva') ? el('cls-iva').value : ''
  var note    = el('cls-note') ? el('cls-note').value.trim() : ''
  if (!contoId) { showClsBanner('err', 'Seleziona un conto (proposta modificabile).'); return }
  if (!ivaId)   { showClsBanner('err', 'Seleziona un codice IVA.'); return }
  var alq = getSelectedAliquota()

  var btn = el('cls-save-btn')
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Salvataggio…' }
  try {
    var rows = []
    if (classifyMode === 'single') {
      var m = classifyTargets[0]
      var cantiere = el('cls-cantiere') ? (el('cls-cantiere').value || null) : null
      rows.push(buildClassRow(m, contoId, ivaId, calcolaIva(m.importo, alq, ivaInclusaState), ivaInclusaState, cantiere, note))
    } else {
      var comuneOn = el('cls-cantiere-comune-chk') && el('cls-cantiere-comune-chk').checked
      var cantiereComune = comuneOn && el('cls-cantiere-comune') ? (el('cls-cantiere-comune').value || null) : null
      for (var i = 0; i < classifyTargets.length; i++) {
        var t = classifyTargets[i]
        var cant = comuneOn ? cantiereComune : (t.cantiere_id || null)
        rows.push(buildClassRow(t, contoId, ivaId, calcolaIva(t.importo, alq, ivaInclusaState), ivaInclusaState, cant, note))
      }
    }

    const { data, error } = await sb
      .from('tm_conta_classificazioni')
      .upsert(rows, { onConflict: 'origine_tipo,origine_id' })
      .select()
    if (error) throw error

    // L'override del gruppo si scrive DOPO: la classificazione e' gia' salvata,
    // e un errore qui non deve farla perdere.
    await salvaOverrideGruppo(classifyMode === 'single' ? [classifyTargets[0]] : classifyTargets)

    closeClassifyPanel()
    if (currentPage === 'movimenti') await loadDaClassificare()
    await refreshDaClassificareCount()
    // Se si stava riclassificando da una scheda, il riquadro si rifa' subito:
    // altrimenti mostrerebbe ancora il conto vecchio.
    var t0 = classifyTargets && classifyTargets[0]
    if (t0) {
      if (t0.origine_tipo === 'fattura' && el('fatture-classificazione'))
        await aggiornaBoxClassificazione('tm_conta_fatture', t0.origine_id, 'fatture-classificazione')
      if (t0.origine_tipo === 'acquisto' && el('acquisti-classificazione'))
        await aggiornaBoxClassificazione('tm_conta_fatture_acquisto', t0.origine_id, 'acquisti-classificazione')
      if (t0.origine_tipo === 'proprio' && currentPage === 'inserimento')
        await loadRecentiInseriti()
      if (t0.origine_tipo === 'acquisto' && editingAcquistoId === t0.origine_id)
        await aggiornaRigaClassificazioneForm('tm_conta_fatture_acquisto', t0.origine_id,
                                              'a-classificazione-riga')
    }
  } catch (e) {
    showClsBanner('err', 'Salvataggio: ' + e.message)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✅ Conferma classificazione' }
  }
}

// ── Modifica / elimina movimenti manuali (Canale B) ──────────────────────────
function startEditFromRow(idx) {
  var m = daClassList[idx]
  if (m && m.origine_tipo === 'proprio') startEditMovimento(m.origine_id)
}
function deleteFromRow(idx) {
  var m = daClassList[idx]
  if (m && m.origine_tipo === 'proprio') deleteMovimento(m.origine_id, m.descrizione)
}
function editRecente(i)   { var m = recentiList[i]; if (m) startEditMovimento(m.id) }
function deleteRecente(i) { var m = recentiList[i]; if (m) deleteMovimento(m.id, m.descrizione) }

function fillFormFromValues(vals) {
  if (el('f-data'))        el('f-data').value = vals.data || ''
  if (el('f-descrizione')) el('f-descrizione').value = vals.descrizione || ''
  if (el('f-ente'))        el('f-ente').value = vals.ente || ''
  if (el('f-importo'))     el('f-importo').value = (vals.importo == null || vals.importo === '') ? '' : vals.importo
  if (el('f-valuta'))      el('f-valuta').value = vals.valuta || 'CHF'
  if (el('f-ricorrente'))  el('f-ricorrente').checked = !!vals.ricorrente
  togglePeriodicita(!!vals.ricorrente)
  if (el('f-periodicita')) el('f-periodicita').value = vals.periodicita || 'mensile'
  if (el('f-allegato'))    el('f-allegato').value = ''
  // ── FASE 2: contatto collegato, gruppo, scadenza, stato pagamento
  if (el('f-scadenza'))    el('f-scadenza').value = vals.data_scadenza || ''
  if (el('f-contatto-id')) el('f-contatto-id').value = vals.contatto_id || ''
  if (el('f-stato-pagamento')) el('f-stato-pagamento').value = vals.stato_pagamento || 'pagato'
  if (el('f-data-pagamento'))  el('f-data-pagamento').value = vals.data_pagamento || ''
  riempiSelectGruppi('f-gruppo', vals.gruppo_codice || '')
  onMovStatoChange()
  aggiornaLegatoDaId('f', vals.contatto_id)
}

// Ridisegna il riquadro «contatto collegato» partendo dal solo id: serve quando
// il form viene ripopolato (modifica, annulla) e non da una scelta dell'utente.
function aggiornaLegatoDaId(prefix, id) {
  var c = rubricaCampi(prefix)
  if (!id) { html(c.legato, ''); return }
  loadContatti().then(function (list) {
    var x = (list || []).filter(function (k) { return k.id === id })[0]
    renderContattoLegato(prefix, x, null)
  }).catch(function () { html(c.legato, '') })
}

// Allegato già presente sul movimento Canale B: nome + apri + rimuovi
function renderMovimentoAllegatoCorrente() {
  // FASE 9 — vedi renderAcquistoAllegatoCorrente().
  var box = el('f-allegato-corrente')
  if (box) { box.style.display = 'none'; box.innerHTML = '' }
}

// FASE 9 — rimuoviAllegatoMovimento() e' stata tolta: cancellava dallo Storage
// un file che adesso e' nominato da una riga di tm_conta_allegati, lasciando
// un allegato che non si apre. Si elimina dalla scheda, con eliminaAllegato().

async function startEditMovimento(id) {
  if (!currentAziendaId) return
  if (isBloccato('proprio', id)) {
    alert('Questo movimento è in un periodo consegnato (bloccato). Sbloccalo dalla pagina «Export & consegna» per modificarlo.')
    return
  }
  try {
    const { data, error } = await sb
      .from('tm_conta_movimenti_propri')
      .select('id, data, descrizione, ente_fornitore, importo, valuta, ricorrente, periodicita,' +
              ' data_scadenza, stato_pagamento, data_pagamento, gruppo_codice, contatto_id')
      .eq('id', id)
      .eq('azienda_id', currentAziendaId)
      .single()
    if (error) throw error

    var vals = {
      data:        data.data || '',
      descrizione: data.descrizione || '',
      ente:        data.ente_fornitore || '',
      importo:     data.importo != null ? data.importo : '',
      valuta:      data.valuta || 'CHF',
      ricorrente:  !!data.ricorrente,
      periodicita: data.periodicita || 'mensile',
      data_scadenza:   data.data_scadenza || '',
      stato_pagamento: data.stato_pagamento || 'pagato',
      data_pagamento:  data.data_pagamento || '',
      gruppo_codice:   data.gruppo_codice || '',
      contatto_id:     data.contatto_id || ''
    }
    editingMovimentoId = id
    originalEditValues = vals

    showPage('inserimento')
    fillFormFromValues(vals)
    renderMovimentoAllegatoCorrente()
    var bar = el('edit-mode-bar'); if (bar) bar.style.display = 'flex'
    var d = el('edit-mode-desc'); if (d) d.textContent = '«' + vals.descrizione + '»'
    var ct = el('inserimento-card-title'); if (ct) ct.textContent = '✏️ Modifica movimento'
    var sbtn = el('inserimento-submit-btn'); if (sbtn) sbtn.textContent = '💾 Salva modifiche'
    html('inserimento-banner', '')
  } catch (e) {
    showPage('inserimento')
    showInserimentoBanner('err', 'Impossibile aprire il movimento', e.message)
  }
}

function onAnnullaClick() {
  if (editingMovimentoId && originalEditValues) {
    fillFormFromValues(originalEditValues)   // ripristina i valori originali (finché non salvi)
    html('inserimento-banner', '')
  } else {
    resetInserimentoForm()
  }
}

function exitEditMode() {
  editingMovimentoId = null
  originalEditValues = null
  editingDocPath = null
  var bar = el('edit-mode-bar'); if (bar) bar.style.display = 'none'
  var ct = el('inserimento-card-title'); if (ct) ct.textContent = '➕ Nuovo movimento'
  var sbtn = el('inserimento-submit-btn'); if (sbtn) sbtn.textContent = '💾 Salva movimento'
  resetInserimentoForm()
  renderMovimentoAllegatoCorrente()   // editingDocPath è null → nasconde il box
}

async function deleteMovimento(id, descrizione) {
  if (!currentAziendaId) return
  if (isBloccato('proprio', id)) {
    alert('Questo movimento è in un periodo consegnato (bloccato). Sbloccalo dalla pagina «Export & consegna» per eliminarlo.')
    return
  }
  var ok = window.confirm('Sicuro? Non si può annullare.\n\nMovimento: «' + (descrizione || '') + '»\nVerrà eliminato insieme alla sua eventuale classificazione.')
  if (!ok) return
  try {
    const delClass = await sb
      .from('tm_conta_classificazioni')
      .delete()
      .eq('azienda_id', currentAziendaId)
      .eq('origine_tipo', 'proprio')
      .eq('origine_id', id)
      .select()
    if (delClass.error) throw delClass.error

    const { error } = await sb
      .from('tm_conta_movimenti_propri')
      .delete()
      .eq('id', id)
      .eq('azienda_id', currentAziendaId)
      .select()
    if (error) throw error

    if (editingMovimentoId === id) exitEditMode()
    try {
      await loadRecentiInseriti()
      await refreshDaClassificareCount()
      if (currentPage === 'movimenti') await loadDaClassificare()
    } catch (_) { /* refresh UI non bloccante */ }
  } catch (e) {
    alert('Eliminazione non riuscita: ' + e.message)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 4 — AUDIT TRAIL (storia delle modifiche)
// La registrazione avviene a livello DATABASE (trigger), non qui: il JS legge
// e mostra soltanto. Vedi migrations/migration_fase4.sql.
// ══════════════════════════════════════════════════════════════════════════════

// Etichette leggibili (lookup sui dati già caricati; fallback all'UUID)
function contoLabel(id) {
  if (!id) return '—'
  var c = (contiCache || []).filter(function (x) { return x.id === id })[0]
  return c ? (c.codice_conto + ' · ' + c.descrizione) : String(id)
}
function ivaLabel(id) {
  if (!id) return '—'
  var c = (ivaCache || []).filter(function (x) { return x.id === id })[0]
  if (!c) return String(id)
  var alq = safeNum(c.aliquota)
  return c.codice + ' (' + (alq == null ? '?' : (alq === 0 ? '0' : fmtNum2(alq))) + '%)'
}
function cantiereLabel(id) {
  if (!id) return 'aziendale'
  var c = (cantieriCache || []).filter(function (x) { return x.id === id })[0]
  return c ? nomeCantiere(c, false) : String(id)
}
function statoBadge(stato) {
  var map = { bozza: 'info', confermato: 'ok', esportato: 'gold', bloccato: 'warn' }
  return badge(map[stato] || 'info', stato || 'confermato')
}

function auditFieldLabel(field) {
  var map = {
    conto_id: 'Conto', codice_iva_id: 'Codice IVA', categoria: 'Categoria',
    note: 'Note', imponibile: 'Imponibile', iva_importo: 'IVA',
    iva_inclusa: 'IVA inclusa', cantiere_id: 'Cantiere', stato: 'Stato',
    // Campi dei pagamenti (SQL_FASE13)
    data: 'Data del pagamento', importo: 'Importo', metodo: 'Metodo',
    riferimento: 'Riferimento',
    pagamento_creato: 'Pagamento registrato',
    pagamento_eliminato: 'Pagamento eliminato'
  }
  return map[field] || field
}
function prettyAuditValue(field, val) {
  if (val == null || val === '') return '(vuoto)'
  if (field === 'conto_id')      return contoLabel(val)
  if (field === 'codice_iva_id') return ivaLabel(val)
  if (field === 'cantiere_id')   return cantiereLabel(val)
  if (field === 'iva_inclusa')   return (val === 'true' || val === true) ? 'IVA inclusa' : 'IVA esclusa'
  if (field === 'importo' && !isNaN(parseFloat(val))) return fmtNumIt(parseFloat(val)) + ' CHF'
  if (field === 'data' && /^\d{4}-\d{2}-\d{2}$/.test(String(val))) return fmtDate(val)
  // «400.00 del 2026-08-10»: il trigger lo scrive composto, qui si rimette
  // nel formato del resto del programma.
  var comp = /^([0-9]+(?:\.[0-9]+)?) del (\d{4}-\d{2}-\d{2})$/.exec(String(val))
  if (comp) return fmtNumIt(parseFloat(comp[1])) + ' CHF del ' + fmtDate(comp[2])
  return String(val)
}
function fmtDateTime(ts) {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleString('it-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch (_) { return String(ts) }
}

// Risolve email utenti (best-effort: se manca la colonna o la RLS blocca, resta l'id)
async function loadUtentiEmails(ids) {
  var need = ids.filter(function (id) { return id && !(id in utentiEmailCache) })
  if (!need.length) return
  try {
    const { data, error } = await sb.from('tm_utenti').select('id, email').in('id', need)
    if (error) throw error
    for (var i = 0; i < (data || []).length; i++) utentiEmailCache[data[i].id] = data[i].email
  } catch (e) { /* email non recuperabile: si mostrerà l'id */ }
}
function utenteLabel(id) {
  if (!id) return 'sistema / non identificato'
  if (currentUser && id === currentUser.id) return currentUser.email || 'tu'
  if (utentiEmailCache[id]) return utentiEmailCache[id]
  return String(id)
}

// Apre la storia (audit) di un movimento già classificato
async function openStoria(idx) {
  var m = classificatiList[idx]
  if (!m || !m._class) return
  var classId = m._class.id

  el('storia-summary').innerHTML =
    '<div class="cls-sum-desc">' + esc(m.descrizione) + '</div>' +
    '<div class="cls-sum-meta">' +
      '<span>📅 ' + esc(fmtDate(m.data)) + '</span>' +
      '<span class="cls-sum-amount">' + fmtImporto(m.importo, m.valuta) + '</span>' +
      '<span>Conto: ' + esc(contoLabel(m._class.conto_id)) + '</span>' +
    '</div>'
  el('storia-body').innerHTML = loadingRow('Caricamento storia…')
  el('storia-overlay').style.display = 'flex'

  await ensureContiIva()
  await loadCantieri()

  try {
    const { data, error } = await sb
      .from('tm_conta_audit')
      .select('campo, valore_prima, valore_dopo, utente, timestamp')
      .eq('classificazione_id', classId)
      .order('timestamp', { ascending: false })
    if (error) throw error
    var rows = data || []
    var ids = []
    for (var i = 0; i < rows.length; i++) { if (rows[i].utente) ids.push(rows[i].utente) }
    await loadUtentiEmails(ids)
    renderStoria(rows)
  } catch (e) {
    el('storia-body').innerHTML = '<p style="color:var(--err);padding:8px">Errore: ' + esc(e.message) + '</p>'
  }
}

function renderStoria(rows) {
  if (!rows || !rows.length) {
    el('storia-body').innerHTML = '<div class="dim" style="padding:12px 0">Nessuna modifica registrata.</div>'
    return
  }
  var out = '<div class="storia-list">'
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i]
    out +=
      '<div class="storia-item">' +
        '<div class="storia-field">' + esc(auditFieldLabel(r.campo)) + '</div>' +
        '<div class="storia-change">' +
          '<span class="storia-prima">' + esc(prettyAuditValue(r.campo, r.valore_prima)) + '</span>' +
          ' <span class="storia-arrow" aria-hidden="true">→</span> ' +
          '<span class="storia-dopo">' + esc(prettyAuditValue(r.campo, r.valore_dopo)) + '</span>' +
        '</div>' +
        '<div class="storia-meta">👤 ' + esc(utenteLabel(r.utente)) + ' · 🕐 ' + esc(fmtDateTime(r.timestamp)) + '</div>' +
      '</div>'
  }
  out += '</div>'
  el('storia-body').innerHTML = out
}

function closeStoria() {
  var o = el('storia-overlay')
  if (o) o.style.display = 'none'
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 5 — EXPORT (Excel/CSV) + BLOCCO PERIODO
// Export GENERICO. Il formato Banana è predisposto ma NON implementato qui.
// Il blocco periodo è applicato nell'app; ogni cambio di stato passa da UPDATE,
// quindi resta tracciato dall'audit (Fase 4).
// ══════════════════════════════════════════════════════════════════════════════

function isBloccato(origine_tipo, origine_id) {
  var c = classByKey[origine_tipo + ':' + origine_id]
  return !!(c && c.stato === 'bloccato')
}

function inPeriodo(d, da, a) {
  if (!d) return false
  if (da && d < da) return false   // date 'YYYY-MM-DD' → confronto lessicale corretto
  if (a && d > a) return false
  return true
}

function validPeriodo(da, a) {
  if (!da || !a) { showExportBanner('err', 'Imposta entrambe le date del periodo (da / a).'); return false }
  if (da > a)    { showExportBanner('err', 'La data «da» è successiva alla data «a».'); return false }
  return true
}

function exportFileName(da, a, ext) {
  return 'CT_export_' + (da || 'inizio') + '_' + (a || 'fine') + '.' + ext
}

function showExportBanner(tipo, msg) {
  var cls  = tipo === 'ok' ? 'ok' : tipo === 'warn' ? 'warn' : 'err'
  var icon = tipo === 'ok' ? '✅' : tipo === 'warn' ? '⚠️' : '❌'
  html('export-banner',
    '<div class="fase-banner ' + cls + '">' +
      '<span class="icon" aria-hidden="true">' + icon + '</span><div class="msg">' + esc(msg) + '</div>' +
    '</div>'
  )
}

function downloadBlob(content, filename, mime) {
  var blob = new Blob([content], { type: mime || 'application/octet-stream' })
  var url = URL.createObjectURL(blob)
  var a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
}

// Movimenti classificati nel periodo (con importo): { mov, cls }
async function getClassificatiNelPeriodo(da, a) {
  if (!currentAziendaId) throw new Error('Azienda non definita.')

  var canalA = []
  var canalB = []
  try { canalA = await loadCanalA() } catch (_) {}
  try { canalB = await loadCanalB() } catch (_) {}
  var tutti = canalA.concat(canalB)

  var classMap = {}
  try {
    const { data, error } = await sb
      .from('tm_conta_classificazioni')
      .select('id, origine_tipo, origine_id, conto_id, codice_iva_id, imponibile, iva_importo, iva_inclusa, cantiere_id, note, stato')
      .eq('azienda_id', currentAziendaId)
    if (error) throw error
    for (var k = 0; k < (data || []).length; k++) {
      classMap[data[k].origine_tipo + ':' + data[k].origine_id] = data[k]
    }
  } catch (e) {
    throw new Error('Lettura classificazioni: ' + e.message)
  }
  classByKey = classMap

  await ensureContiIva()
  await loadCantieri()

  var out = []
  for (var i = 0; i < tutti.length; i++) {
    var m = tutti[i]
    var c = classMap[m.origine_tipo + ':' + m.origine_id]
    if (!c) continue                         // non classificato → escluso
    if (!inPeriodo(m.data, da, a)) continue   // fuori periodo
    if (c.imponibile == null) continue        // niente importo (es. regia da fatturare) → escluso
    out.push({ mov: m, cls: c })
  }
  out.sort(function (x, y) { return (x.mov.data || '').localeCompare(y.mov.data || '') })
  return out
}

// Costruisce i 3 fogli (array di array) per l'export
function buildExportAoa(pairs) {
  var movimenti = [[
    'Data', 'Origine', 'Descrizione', 'Ente/Fornitore', 'Conto', 'Codice IVA',
    'IVA', 'Imponibile', 'IVA importo', 'Totale', 'Valuta', 'Cantiere', 'Note'
  ]]
  var perConto = {}
  var perIva = {}

  for (var i = 0; i < pairs.length; i++) {
    var m = pairs[i].mov, c = pairs[i].cls
    var imp = safeNum(c.imponibile) || 0
    var ivaImp = safeNum(c.iva_importo) || 0
    var tot = round2(imp + ivaImp)
    var contoLbl = contoLabel(c.conto_id)
    var ivaLbl = ivaLabel(c.codice_iva_id)

    movimenti.push([
      m.data || '',
      m.origine_tipo,
      m.descrizione || '',
      m.ente || '',
      contoLbl,
      ivaLbl,
      (c.iva_inclusa === false ? 'esclusa' : 'inclusa'),
      imp, ivaImp, tot,
      m.valuta || 'CHF',
      cantiereLabel(c.cantiere_id),
      c.note || ''
    ])

    if (!perConto[contoLbl]) perConto[contoLbl] = { imp: 0, iva: 0, tot: 0 }
    perConto[contoLbl].imp += imp; perConto[contoLbl].iva += ivaImp; perConto[contoLbl].tot += tot
    if (!perIva[ivaLbl]) perIva[ivaLbl] = { imp: 0, iva: 0 }
    perIva[ivaLbl].imp += imp; perIva[ivaLbl].iva += ivaImp
  }

  var pc = [['Conto', 'Imponibile', 'IVA', 'Totale']]
  Object.keys(perConto).sort().forEach(function (kk) {
    pc.push([kk, round2(perConto[kk].imp), round2(perConto[kk].iva), round2(perConto[kk].tot)])
  })
  var pi = [['Codice IVA', 'Imponibile', 'IVA']]
  Object.keys(perIva).sort().forEach(function (kk) {
    pi.push([kk, round2(perIva[kk].imp), round2(perIva[kk].iva)])
  })

  return { movimenti: movimenti, perConto: pc, perIva: pi }
}

// ══════════════════════════════════════════════════════════════════════════════
// EXPORT — dataset unico, sezioni separate, periodo rapido
// ══════════════════════════════════════════════════════════════════════════════
function pad2(n) { return (n < 10 ? '0' : '') + n }
function ultimoGiornoMese(anno, mese) {
  var d = new Date(anno, mese, 0)          // giorno 0 del mese dopo = ultimo del mese
  return anno + '-' + pad2(mese) + '-' + pad2(d.getDate())
}

// Carica UNA volta tutto ciò che serve all'export (poi si filtra per periodo)
async function loadExportDataset(force) {
  if (exportDataset && !force) return exportDataset
  if (!currentAziendaId) throw new Error('Azienda non definita.')

  var fatture = [], acquisti = [], movimentiAll = [], classMap = {}, numeroById = {}

  try {
    const { data, error } = await sb
      .from('tm_conta_fatture')
      .select('id, numero, data_emissione, cliente_nome, totale_imponibile, totale_iva, totale, valuta, stato, stato_pagamento, data_scadenza, data_pagamento, gruppo_codice, contatto_id, tipo, iban, rif_fattura_id')
      .eq('azienda_id', currentAziendaId)
      .eq('stato', 'emessa')
    if (error) throw error
    fatture = data || []
    for (var i = 0; i < fatture.length; i++) numeroById[fatture[i].id] = fatture[i].numero
  } catch (e) { console.warn('Export / fatture:', e.message) }

  var CAMPI_ACQ = 'id, fornitore, numero_fornitore, data, importo, valuta, imponibile, iva_importo, stato_pagamento, data_pagamento, metodo_pagamento'
  try {
    const { data, error } = await sb
      .from('tm_conta_fatture_acquisto')
      .select(CAMPI_ACQ + ', stato_conferma')
      .eq('azienda_id', currentAziendaId)
    if (error) throw error
    acquisti = data || []
  } catch (e) {
    // Colonna non ancora presente (SQL_FASE5.sql non applicato): si rilegge
    // senza. Meglio un export completo senza il filtro che un export a cui
    // mancano tutti gli acquisti.
    try {
      const { data, error: e2 } = await sb
        .from('tm_conta_fatture_acquisto')
        .select(CAMPI_ACQ)
        .eq('azienda_id', currentAziendaId)
      if (e2) throw e2
      acquisti = data || []
      console.warn('Export / acquisti: stato_conferma non disponibile, filtro non applicato.')
    } catch (e3) { console.warn('Export / acquisti:', e3.message) }
  }

  try {
    var canalA = await loadCanalA()
    var canalB = await loadCanalB()
    movimentiAll = canalA.concat(canalB)
  } catch (e) { console.warn('Export / movimenti:', e.message) }

  try {
    const { data, error } = await sb
      .from('tm_conta_classificazioni')
      .select('id, origine_tipo, origine_id, conto_id, codice_iva_id, imponibile, iva_importo, iva_inclusa, cantiere_id, note, stato')
      .eq('azienda_id', currentAziendaId)
    if (error) throw error
    for (var k = 0; k < (data || []).length; k++) {
      classMap[data[k].origine_tipo + ':' + data[k].origine_id] = data[k]
    }
  } catch (e) { throw new Error('Lettura classificazioni: ' + e.message) }

  classByKey = classMap
  await ensureContiIva()
  await loadCantieri()
  await loadAziendaInfo()

  exportDataset = { fatture: fatture, acquisti: acquisti, movimentiAll: movimentiAll, classMap: classMap, numeroById: numeroById }
  return exportDataset
}

function sezioniSelezionate() {
  function on(id) { var e = el(id); return e ? e.checked : true }
  return { vendite: on('exp-sec-vendite'), note: on('exp-sec-note'), acquisti: on('exp-sec-acquisti'), spese: on('exp-sec-spese') }
}

// Documenti del periodo, divisi per sezione
function docsPeriodo(ds, da, a) {
  var vendite = [], note = [], acquisti = [], spese = [], classificatiTutti = []
  // FASE 5C — quello che una persona non ha ancora guardato non va al
  // commercialista. Vale per l'export come per il Cruscotto e le Scadenze.
  // Se la colonna non c'e' (SQL_FASE5.sql non ancora applicato) il valore e'
  // undefined e la riga passa: nessuna regressione rispetto a prima.
  var scartatiDaConfermare = 0
  function confermato(r) {
    if (r && r.stato_conferma === 'da_confermare') { scartatiDaConfermare++; return false }
    return true
  }
  for (var i = 0; i < ds.fatture.length; i++) {
    var f = ds.fatture[i]
    if (!inPeriodo(f.data_emissione, da, a)) continue
    if (f.tipo === 'nota_credito') note.push(f); else vendite.push(f)
  }
  for (var j = 0; j < ds.acquisti.length; j++) {
    if (!confermato(ds.acquisti[j])) continue
    if (inPeriodo(ds.acquisti[j].data, da, a)) acquisti.push(ds.acquisti[j])
  }
  for (var m = 0; m < ds.movimentiAll.length; m++) {
    var mov = ds.movimentiAll[m]
    var c = ds.classMap[mov.origine_tipo + ':' + mov.origine_id]
    if (!confermato(mov)) continue
    if (!c || !inPeriodo(mov.data, da, a) || c.imponibile == null) continue
    classificatiTutti.push({ mov: mov, cls: c })
    // il foglio "Spese e movimenti" esclude fatture e acquisti (hanno fogli propri)
    if (mov.origine_tipo !== 'fattura' && mov.origine_tipo !== 'acquisto') spese.push({ mov: mov, cls: c })
  }
  function byData(x, y) { return String(x.data || x.data_emissione || (x.mov && x.mov.data) || '').localeCompare(String(y.data || y.data_emissione || (y.mov && y.mov.data) || '')) }
  vendite.sort(byData); note.sort(byData); acquisti.sort(byData); spese.sort(byData)
  // Il numero torna a chi chiama: l'anteprima dell'export lo dice in chiaro,
  // altrimenti dei documenti sparirebbero dal file senza che nessuno lo sappia.
  return { vendite: vendite, note: note, acquisti: acquisti, spese: spese,
           classificatiTutti: classificatiTutti, scartatiDaConfermare: scartatiDaConfermare }
}

// ── Fogli ────────────────────────────────────────────────────────────────────
function buildSheetVendite(list, ds, negativo, mappaAllegati) {
  var head = ['Numero', 'Data', 'Cliente', 'Cantiere', 'Imponibile', 'IVA', 'Totale', 'Valuta', 'Stato pagamento', 'IBAN']
  if (negativo) head.push('Rif. fattura stornata')
  // FASE 7 — le colonne compaiono SOLO nel pacchetto. Senza mappa questo foglio
  // resta identico a quello dell'export Excel di sempre.
  // FASE 8 — PAGATO e RESIDUO: vedi la nota sul foglio Acquisti.
  if (mappaAllegati) head.push('PAGATO', 'RESIDUO', 'ALLEGATO')
  var aoa = [head]
  var segno = negativo ? -1 : 1
  for (var i = 0; i < list.length; i++) {
    var f = list[i]
    var c = ds.classMap['fattura:' + f.id]
    var riga = [
      f.numero || '',
      f.data_emissione || '',
      f.cliente_nome || '',
      c ? cantiereLabel(c.cantiere_id) : '',
      round2(segno * (safeNum(f.totale_imponibile) || 0)),
      round2(segno * (safeNum(f.totale_iva) || 0)),
      round2(segno * (safeNum(f.totale) || 0)),
      f.valuta || 'CHF',
      f.stato || '',
      (f.iban && String(f.iban).trim()) ? f.iban : ((aziendaInfo && aziendaInfo.iban) || '')
    ]
    if (negativo) riga.push(ds.numeroById[f.rif_fattura_id] || '—')
    if (mappaAllegati) {
      var pagatoF = totalePagatoDi('tm_conta_fatture', f.id)
      riga.push(round2(segno * pagatoF),
                round2(segno * ((safeNum(f.totale) || 0) - pagatoF)),
                mappaAllegati['vendite:' + f.id] || '')
    }
    aoa.push(riga)
  }
  return aoa
}

function buildSheetAcquisti(list, ds, mappaAllegati) {
  var head = ['Fornitore', 'Numero fornitore', 'Data', 'Imponibile', 'IVA', 'Totale', 'Valuta',
              'Stato pagamento', 'Data pagamento', 'Metodo pagamento', 'Conto', 'Codice IVA']
  // FASE 8 — PAGATO e RESIDUO servono al commercialista per debitori e
  // creditori a fine anno: senza, un documento pagato a meta' sembra aperto
  // per l'intero importo. Le rate non entrano: non sono documenti.
  if (mappaAllegati) head.push('PAGATO', 'RESIDUO', 'ALLEGATO')
  var aoa = [head]
  for (var i = 0; i < list.length; i++) {
    var x = list[i]
    var c = ds.classMap['acquisto:' + x.id]
    aoa.push([
      x.fornitore || '',
      x.numero_fornitore || '',
      x.data || '',
      safeNum(x.imponibile) != null ? safeNum(x.imponibile) : '',
      safeNum(x.iva_importo) != null ? safeNum(x.iva_importo) : '',
      safeNum(x.importo) || 0,
      x.valuta || 'CHF',
      etichettaPagamento('uscita', x.stato_pagamento).testo,
      x.data_pagamento || '',
      x.metodo_pagamento || '',
      c ? contoLabel(c.conto_id) : '',
      c ? ivaLabel(c.codice_iva_id) : ''
    ])
    if (mappaAllegati) {
      var pagatoX = totalePagatoDi('tm_conta_fatture_acquisto', x.id)
      aoa[aoa.length - 1].push(round2(pagatoX),
                               round2((safeNum(x.importo) || 0) - pagatoX),
                               mappaAllegati['acquisti:' + x.id] || '')
    }
  }
  return aoa
}

function buildSheetSpese(pairs, mappaAllegati) {
  var head = ['Data', 'Origine', 'Descrizione', 'Ente/Fornitore', 'Conto', 'Codice IVA',
              'IVA', 'Imponibile', 'IVA importo', 'Totale', 'Valuta', 'Cantiere', 'Note']
  if (mappaAllegati) head.push('ALLEGATO')
  var aoa = [head]
  for (var i = 0; i < pairs.length; i++) {
    var m = pairs[i].mov, c = pairs[i].cls
    var imp = safeNum(c.imponibile) || 0
    var ivaImp = safeNum(c.iva_importo) || 0
    aoa.push([
      m.data || '', m.origine_tipo, m.descrizione || '', m.ente || '',
      contoLabel(c.conto_id), ivaLabel(c.codice_iva_id),
      (c.iva_inclusa === false ? 'esclusa' : 'inclusa'),
      imp, ivaImp, round2(imp + ivaImp),
      m.valuta || 'CHF', cantiereLabel(c.cantiere_id), c.note || ''
    ])
    // Gli allegati esistono solo per i movimenti propri: spesa e regia di
    // App Cantieri non hanno un file collegato a questa riga.
    if (mappaAllegati) {
      aoa[aoa.length - 1].push(
        (m.origine_tipo === 'proprio') ? (mappaAllegati['movimenti:' + m.origine_id] || '') : '')
    }
  }
  return aoa
}

// Totali di sezione (usati da anteprima e foglio Riepilogo)
function totaliSezioni(d) {
  function sumF(list, campo) { var s = 0; for (var i = 0; i < list.length; i++) s += safeNum(list[i][campo]) || 0; return round2(s) }
  var totVendite  = sumF(d.vendite, 'totale')
  var totNote     = -sumF(d.note, 'totale')                       // storno → negativo
  var totAcquisti = sumF(d.acquisti, 'importo')
  var totSpese = 0
  for (var i = 0; i < d.spese.length; i++) {
    totSpese += (safeNum(d.spese[i].cls.imponibile) || 0) + (safeNum(d.spese[i].cls.iva_importo) || 0)
  }
  totSpese = round2(totSpese)
  return {
    vendite: totVendite, note: totNote, acquisti: totAcquisti, spese: totSpese,
    saldo: round2(totVendite + totNote - totAcquisti - totSpese)
  }
}

function buildSheetRiepilogo(d, sez, da, a) {
  var t = totaliSezioni(d)
  var aoa = [['RIEPILOGO', ''], ['Periodo', da + ' → ' + a], ['', '']]
  aoa.push(['Sezione', 'Documenti', 'Totale CHF'])
  if (sez.vendite)  aoa.push(['Fatture di vendita', d.vendite.length, t.vendite])
  if (sez.note)     aoa.push(['Note di credito', d.note.length, t.note])
  if (sez.acquisti) aoa.push(['Fatture d\'acquisto', d.acquisti.length, t.acquisti])
  if (sez.spese)    aoa.push(['Spese e movimenti', d.spese.length, t.spese])
  aoa.push(['', '', ''])
  aoa.push(['SALDO (vendite − note − acquisti − spese)', '', t.saldo])

  // Riepiloghi per conto e per codice IVA (su tutto il classificato del periodo)
  var perConto = {}, perIva = {}
  for (var i = 0; i < d.classificatiTutti.length; i++) {
    var c = d.classificatiTutti[i].cls
    var imp = safeNum(c.imponibile) || 0, ivaImp = safeNum(c.iva_importo) || 0
    var ck = contoLabel(c.conto_id), ik = ivaLabel(c.codice_iva_id)
    if (!perConto[ck]) perConto[ck] = { imp: 0, iva: 0, tot: 0 }
    perConto[ck].imp += imp; perConto[ck].iva += ivaImp; perConto[ck].tot += round2(imp + ivaImp)
    if (!perIva[ik]) perIva[ik] = { imp: 0, iva: 0 }
    perIva[ik].imp += imp; perIva[ik].iva += ivaImp
  }
  aoa.push(['', '', ''])
  aoa.push(['RIEPILOGO PER CONTO', '', ''])
  aoa.push(['Conto', 'Imponibile', 'IVA', 'Totale'])
  Object.keys(perConto).sort().forEach(function (kk) {
    aoa.push([kk, round2(perConto[kk].imp), round2(perConto[kk].iva), round2(perConto[kk].tot)])
  })
  aoa.push(['', '', ''])
  aoa.push(['RIEPILOGO PER CODICE IVA', '', ''])
  aoa.push(['Codice IVA', 'Imponibile', 'IVA'])
  Object.keys(perIva).sort().forEach(function (kk) {
    aoa.push([kk, round2(perIva[kk].imp), round2(perIva[kk].iva)])
  })
  return aoa
}

// Sezioni pronte per l'export: solo spuntate e non vuote
function sezioniDaEsportare(d, sez, ds) {
  var out = []
  if (sez.vendite  && d.vendite.length)  out.push({ nome: 'Vendite',            aoa: buildSheetVendite(d.vendite, ds, false) })
  if (sez.note     && d.note.length)     out.push({ nome: 'Note di credito',    aoa: buildSheetVendite(d.note, ds, true) })
  if (sez.acquisti && d.acquisti.length) out.push({ nome: 'Acquisti',           aoa: buildSheetAcquisti(d.acquisti, ds) })
  if (sez.spese    && d.spese.length)    out.push({ nome: 'Spese e movimenti',  aoa: buildSheetSpese(d.spese) })
  return out
}

// ── Selettori rapidi di periodo ──────────────────────────────────────────────
function setPeriodoModo(modo) {
  exportModo = modo
  var modi = ['anno', 'trimestre', 'mese', 'custom']
  for (var i = 0; i < modi.length; i++) {
    var b = el('modo-' + modi[i])
    if (b) { if (modi[i] === modo) b.classList.add('active'); else b.classList.remove('active') }
  }
  if (el('exp-anno-group'))      el('exp-anno-group').style.display      = (modo !== 'custom') ? 'block' : 'none'
  if (el('exp-trimestre-group')) el('exp-trimestre-group').style.display = (modo === 'trimestre') ? 'block' : 'none'
  if (el('exp-mese-group'))      el('exp-mese-group').style.display      = (modo === 'mese') ? 'block' : 'none'
  if (modo === 'custom') updateExportPreview()
  else applicaPeriodoRapido()
}

function applicaPeriodoRapido() {
  if (exportModo === 'custom') return
  var anno = parseInt(getVal('exp-anno'), 10) || new Date().getFullYear()
  var da, a
  if (exportModo === 'trimestre') {
    var t = parseInt(getVal('exp-trimestre'), 10) || 1
    var m1 = (t - 1) * 3 + 1
    da = anno + '-' + pad2(m1) + '-01'
    a  = ultimoGiornoMese(anno, m1 + 2)
  } else if (exportModo === 'mese') {
    var m = parseInt(getVal('exp-mese'), 10) || 1
    da = anno + '-' + pad2(m) + '-01'
    a  = ultimoGiornoMese(anno, m)
  } else {                                   // anno intero (in CH l'anno fiscale è solare)
    da = anno + '-01-01'
    a  = anno + '-12-31'
  }
  setVal('exp-da', da); setVal('exp-a', a)
  aggiornaTutteLeAnteprime()
}

function onPeriodoManuale() { setPeriodoModo('custom') }

// FASE 7 — quando cambia il periodo cambia anche il pacchetto: l'anteprima si
// rifa' da sola, cosi' il peso stimato non resta quello di prima.
function aggiornaTutteLeAnteprime() {
  updateExportPreview()
  if (typeof aggiornaAnteprimaPacchetto === 'function') aggiornaAnteprimaPacchetto()
}

function popolaAnniDisponibili(ds) {
  var sel = el('exp-anno')
  if (!sel) return
  var anni = {}
  function add(d) { if (d && String(d).length >= 4) anni[String(d).slice(0, 4)] = true }
  for (var i = 0; i < ds.fatture.length; i++) add(ds.fatture[i].data_emissione)
  for (var j = 0; j < ds.acquisti.length; j++) add(ds.acquisti[j].data)
  for (var m = 0; m < ds.movimentiAll.length; m++) add(ds.movimentiAll[m].data)
  add(String(new Date().getFullYear()))      // l'anno corrente c'è sempre
  var lista = Object.keys(anni).sort().reverse()
  var precedente = sel.value
  sel.innerHTML = lista.map(function (y) { return '<option value="' + y + '">' + y + '</option>' }).join('')
  if (precedente && lista.indexOf(precedente) !== -1) sel.value = precedente
  else sel.value = String(new Date().getFullYear())
}

async function initExportPage() {
  if (!el('exp-da') || !el('exp-a')) return
  html('export-banner', '')
  html('exp-preview', loadingRow('Caricamento dati…'))
  try {
    var ds = await loadExportDataset(true)     // ricarica: i dati possono essere cambiati
    popolaAnniDisponibili(ds)
    setPeriodoModo(exportModo || 'anno')       // imposta da/a e aggiorna l'anteprima
  } catch (e) {
    html('exp-preview', '<span style="color:var(--err)">Errore caricamento: ' + esc(e.message || e) + '</span>')
  }
}

async function updateExportPreview() {
  var prev = el('exp-preview')
  if (!prev) return
  var da = el('exp-da') ? el('exp-da').value : ''
  var a  = el('exp-a') ? el('exp-a').value : ''
  if (!da || !a) { prev.innerHTML = '<span class="dim">Imposta il periodo per vedere l\'anteprima.</span>'; return }
  if (da > a)    { prev.innerHTML = '<span class="dim">Periodo non valido: «da» dopo «a».</span>'; return }

  prev.innerHTML = loadingRow('Calcolo anteprima…')
  try {
    var ds = await loadExportDataset()
    var d = docsPeriodo(ds, da, a)
    var sez = sezioniSelezionate()
    var t = totaliSezioni(d)
    exportPeriodRows = d.classificatiTutti     // usato dal blocco periodo

    function riga(attiva, etichetta, n, totale) {
      if (!attiva) return '<div class="exp-riga exp-vuoto"><span>' + etichetta + ' — escluso</span><span>—</span></div>'
      return '<div class="exp-riga"><span>' + etichetta + ': <strong>' + n + '</strong> doc.</span>' +
             '<span>' + fmtNum2(totale) + ' CHF</span></div>'
    }
    var nBlocc = 0
    for (var i = 0; i < d.classificatiTutti.length; i++) if (d.classificatiTutti[i].cls.stato === 'bloccato') nBlocc++

    prev.innerHTML =
      riga(sez.vendite,  '📤 Fatture di vendita', d.vendite.length,  t.vendite) +
      riga(sez.note,     '↩️ Note di credito',    d.note.length,     t.note) +
      riga(sez.acquisti, '📥 Fatture d\'acquisto', d.acquisti.length, t.acquisti) +
      riga(sez.spese,    '🧾 Spese e movimenti',  d.spese.length,    t.spese) +
      '<div class="exp-riga" style="border-top:1px solid var(--border);margin-top:6px;padding-top:8px">' +
        '<span><strong>Saldo del periodo</strong></span><span class="exp-amount">' + fmtNum2(t.saldo) + ' CHF</span></div>' +
      (nBlocc ? '<div class="exp-riga exp-vuoto"><span>' + nBlocc + ' movimenti già consegnati 🔒</span><span></span></div>' : '') +
      // FASE 5C — i documenti da confermare NON entrano nel file, ma il loro
      // numero si vede: un documento che sparisce senza dirlo e' peggio di un
      // documento che manca e lo dichiara.
      (d.scartatiDaConfermare
        ? '<div class="exp-riga exp-vuoto"><span>⏳ ' + d.scartatiDaConfermare +
          (d.scartatiDaConfermare === 1
            ? ' documento da confermare: escluso dal file'
            : ' documenti da confermare: esclusi dal file') +
          '</span><span></span></div>'
        : '')
  } catch (e) {
    exportPeriodRows = []
    prev.innerHTML = '<span style="color:var(--err)">Errore anteprima: ' + esc(e.message || e) + '</span>'
  }
}

async function exportExcel() {
  if (typeof XLSX === 'undefined') { showExportBanner('err', 'Libreria Excel non caricata: controlla la connessione e ricarica la pagina.'); return }
  var da = el('exp-da').value, a = el('exp-a').value
  if (!validPeriodo(da, a)) return
  var btn = el('exp-xlsx-btn')
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Genero…' }
  try {
    var ds = await loadExportDataset()
    var d = docsPeriodo(ds, da, a)
    var sez = sezioniSelezionate()
    var sezioni = sezioniDaEsportare(d, sez, ds)
    if (!sezioni.length) {
      showExportBanner('warn', 'Nessun documento da esportare: controlla il periodo e le sezioni spuntate.')
      return
    }
    var wb = XLSX.utils.book_new()
    for (var i = 0; i < sezioni.length; i++) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sezioni[i].aoa), sezioni[i].nome)
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildSheetRiepilogo(d, sez, da, a)), 'Riepilogo')
    XLSX.writeFile(wb, exportFileName(da, a, 'xlsx'))
    var nomi = sezioni.map(function (s) { return s.nome }).join(', ')
    showExportBanner('ok', 'Excel generato con i fogli: ' + nomi + ' + Riepilogo. Controlla i download del browser.')
  } catch (e) {
    showExportBanner('err', 'Export Excel: ' + (e.message || e))
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📊 Genera Excel (.xlsx)' }
  }
}

// CSV: un file per sezione (il CSV non supporta i fogli)
async function exportCsv() {
  if (typeof XLSX === 'undefined') { showExportBanner('err', 'Libreria CSV non caricata: controlla la connessione e ricarica la pagina.'); return }
  var da = el('exp-da').value, a = el('exp-a').value
  if (!validPeriodo(da, a)) return
  var btn = el('exp-csv-btn')
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Genero…' }
  try {
    var ds = await loadExportDataset()
    var d = docsPeriodo(ds, da, a)
    var sez = sezioniSelezionate()
    var sezioni = sezioniDaEsportare(d, sez, ds)
    if (!sezioni.length) {
      showExportBanner('warn', 'Nessun documento da esportare: controlla il periodo e le sezioni spuntate.')
      return
    }
    sezioni.push({ nome: 'Riepilogo', aoa: buildSheetRiepilogo(d, sez, da, a) })
    for (var i = 0; i < sezioni.length; i++) {
      var ws = XLSX.utils.aoa_to_sheet(sezioni[i].aoa)
      var csv = '﻿' + XLSX.utils.sheet_to_csv(ws, { FS: ';' })   // BOM + ';' per Excel europeo
      var slug = sezioni[i].nome.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      downloadBlob(csv, 'CT_export_' + da + '_' + a + '_' + slug + '.csv', 'text/csv;charset=utf-8;')
    }
    showExportBanner('ok', 'Generati ' + sezioni.length + ' file CSV (uno per sezione). Controlla i download del browser.')
  } catch (e) {
    showExportBanner('err', 'Export CSV: ' + (e.message || e))
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📄 Genera CSV (uno per sezione)' }
  }
}

async function lockPeriod() {
  var da = el('exp-da').value, a = el('exp-a').value
  if (!validPeriodo(da, a)) return
  try {
    var pairs = await getClassificatiNelPeriodo(da, a)
    var daBloccare = pairs.filter(function (p) { return p.cls.stato !== 'bloccato' })
    if (!daBloccare.length) { showExportBanner('warn', 'Nessuna classificazione da bloccare nel periodo (o sono già tutte consegnate).'); return }

    var ok = window.confirm('Segnare come CONSEGNATO il periodo ' + da + ' → ' + a + '?\n\n' +
      daBloccare.length + ' classificazioni diventeranno di sola lettura (stato «bloccato»).\n' +
      'Potrai riaprirle con «Sblocca periodo».')
    if (!ok) return

    var ids = daBloccare.map(function (p) { return p.cls.id })
    const { error } = await sb
      .from('tm_conta_classificazioni')
      .update({ stato: 'bloccato' })
      .in('id', ids)
      .eq('azienda_id', currentAziendaId)
      .select()
    if (error) throw error

    // Log export: non fatale. Se migration_fase5.sql non è ancora applicata, il
    // CHECK su formato può rifiutare 'generico': il blocco è comunque avvenuto.
    var logOk = true, logMsg = ''
    try {
      const { error: logErr } = await sb
        .from('tm_conta_export_log')
        .insert({ azienda_id: currentAziendaId, periodo_da: da, periodo_a: a, formato: 'generico', n_righe: daBloccare.length, created_by: currentUser ? currentUser.id : null })
        .select()
      if (logErr) throw logErr
    } catch (logE) { logOk = false; logMsg = logE.message }

    if (logOk) {
      showExportBanner('ok', 'Periodo consegnato: ' + daBloccare.length + ' classificazioni bloccate e registrate nel log export.')
    } else {
      showExportBanner('warn', 'Periodo consegnato: ' + daBloccare.length + ' classificazioni bloccate. ' +
        'Log export NON scritto (' + logMsg + '). Applica migration_fase5.sql per abilitare il log.')
    }
    exportDataset = null   // stati cambiati: ricarica i dati
    await updateExportPreview()
    await refreshDaClassificareCount()
  } catch (e) {
    showExportBanner('err', 'Blocco periodo: ' + e.message)
  }
}

async function unlockPeriod() {
  var da = el('exp-da').value, a = el('exp-a').value
  if (!validPeriodo(da, a)) return
  try {
    var pairs = await getClassificatiNelPeriodo(da, a)
    var daSbloccare = pairs.filter(function (p) { return p.cls.stato === 'bloccato' })
    if (!daSbloccare.length) { showExportBanner('warn', 'Nessun periodo bloccato da riaprire qui.'); return }

    var ok = window.confirm('Stai RIAPRENDO un periodo già consegnato (' + da + ' → ' + a + ').\n\n' +
      daSbloccare.length + ' classificazioni torneranno modificabili (stato «confermato»). Continuare?')
    if (!ok) return

    var ids = daSbloccare.map(function (p) { return p.cls.id })
    const { error } = await sb
      .from('tm_conta_classificazioni')
      .update({ stato: 'confermato' })
      .in('id', ids)
      .eq('azienda_id', currentAziendaId)
      .select()
    if (error) throw error

    showExportBanner('ok', 'Periodo riaperto: ' + daSbloccare.length + ' classificazioni di nuovo modificabili.')
    exportDataset = null   // stati cambiati: ricarica i dati
    await updateExportPreview()
    await refreshDaClassificareCount()
  } catch (e) {
    showExportBanner('err', 'Sblocco periodo: ' + e.message)
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 6 — FATTURE (emissione manuale)
// Numerazione assegnata SOLO all'emissione (RPC DB tm_conta_emetti_fattura,
// gap-free + concorrenza-safe). Dopo l'emissione la fattura è immutabile
// (forzato anche da trigger DB): si corregge con una nota di credito.
// ══════════════════════════════════════════════════════════════════════════════

function showFattureView(which) {
  registraVista('fatture', which)
  var views = ['list', 'edit', 'detail']
  for (var i = 0; i < views.length; i++) {
    var v = el('fatture-' + views[i] + '-view')
    if (v) v.style.display = (views[i] === which) ? 'block' : 'none'
  }
}
function fattureBackToList() { showFattureView('list') }

function showFattureBanner(elId, tipo, msg) {
  var cls  = tipo === 'ok' ? 'ok' : tipo === 'warn' ? 'warn' : 'err'
  var icon = tipo === 'ok' ? '✅' : tipo === 'warn' ? '⚠️' : '❌'
  html(elId, '<div class="fase-banner ' + cls + '"><span class="icon" aria-hidden="true">' + icon + '</span><div class="msg">' + esc(msg) + '</div></div>')
}

// Traduce i rifiuti del DB (immutabilità post-emissione) in un messaggio chiaro.
function friendlyFatturaError(e) {
  var m = (e && e.message) ? e.message : String(e || 'Errore sconosciuto')
  var low = m.toLowerCase()
  if (low.indexOf('sola lettura') !== -1 || low.indexOf('emessa') !== -1 ||
      low.indexOf('immutabil') !== -1 || low.indexOf('cancellare') !== -1 ||
      low.indexOf('non può') !== -1 || low.indexOf('non puo') !== -1) {
    return 'Questa fattura è emessa e non si può modificare né eliminare: per correggere usa una nota di credito.'
  }
  return m
}

function statoFatturaBadge(stato) {
  // Solo ciclo di vita del documento: l'incasso e' un'altra cosa e ha il suo
  // badge separato (badgePagamento). Un badge unico che mostrava l'incasso al
  // posto di «emessa» faceva sparire l'informazione che la fattura era emessa.
  var map  = { bozza: 'info', emessa: 'warn', annullata: 'err' }
  var icon = { bozza: '✏️', emessa: '📨', annullata: '🚫' }
  return badge(map[stato] || 'info', (icon[stato] || '') + ' ' + (stato || ''))
}

async function initFatturePage() {
  fattureBackToList()
  await loadFattureList()
}

async function loadFattureList() {
  try { await loadAllegati() } catch (_) {}
  if (!currentAziendaId) { html('fatture-table', '<div class="dim">Accedi per vedere le fatture.</div>'); return }
  html('fatture-table', loadingRow('Caricamento fatture…'))
  try {
    const { data, error } = await sb
      .from('tm_conta_fatture')
      .select('id, numero, anno, data_emissione, cliente_nome, totale, valuta, stato, stato_pagamento, data_scadenza, tipo, created_at')
      .eq('azienda_id', currentAziendaId)
      .order('created_at', { ascending: false })
    if (error) throw error
    fattureList = data || []
    renderFattureTable()
  } catch (e) {
    html('fatture-table', '<p style="color:var(--err)">Errore: ' + esc(e.message) + '</p>')
  }
}

function fattureRowActions(f) {
  var a = '<button class="icon-btn" onclick="event.stopPropagation(); viewFattura(\'' + f.id + '\')">👁 Apri</button>'
  if (f.stato === 'bozza') {
    a += '<button class="icon-btn classify" onclick="event.stopPropagation(); editFattura(\'' + f.id + '\')">✏️</button>' +
         '<button class="icon-btn danger" onclick="event.stopPropagation(); deleteBozza(\'' + f.id + '\')">🗑️</button>'
  }
  return a
}

function clearFattureSearch() {
  var inp = el('fatture-search')
  if (inp) inp.value = ''
  renderFattureTable()
  if (inp) inp.focus()
}

function renderFattureTable() {
  var stato = el('fatture-filtro-stato') ? el('fatture-filtro-stato').value : ''
  // Due filtri distinti: lo stato del DOCUMENTO e lo stato dell'INCASSO.
  // Sono due domande diverse e prima erano schiacciate in un menu solo.
  var incasso = el('fatture-filtro-incasso') ? el('fatture-filtro-incasso').value : ''
  var anno  = el('fatture-filtro-anno') ? el('fatture-filtro-anno').value : ''
  var q = el('fatture-search') ? el('fatture-search').value.trim().toLowerCase() : ''

  // mostra/nasconde il pulsante di pulizia ricerca
  var clearBtn = el('fatture-search-clear')
  if (clearBtn) clearBtn.style.display = q ? 'flex' : 'none'

  // filtri esistenti (stato/anno)
  var list = fattureList.filter(function (f) {
    if (stato && f.stato !== stato) return false
    if (incasso && f.stato_pagamento !== incasso) return false
    if (anno && String(f.anno) !== String(anno)) return false
    return true
  })

  // ricerca testuale DENTRO il risultato filtrato: numero, cliente, totale
  // (case-insensitive, per pezzi di parola; tutti i termini devono combaciare)
  if (q) {
    var termini = q.split(/\s+/)
    list = list.filter(function (f) {
      var totNum = safeNum(f.totale)
      var hay = (
        (f.numero || '') + ' ' +
        (f.cliente_nome || '') + ' ' +
        (totNum != null ? String(totNum) + ' ' + totNum.toFixed(2) : '')
      ).toLowerCase()
      return termini.every(function (t) { return hay.indexOf(t) !== -1 })
    })
  }

  if (!list.length) {
    var filtroAttivo = q || stato || incasso || anno
    var msg = filtroAttivo
      ? 'Nessuna fattura trovata. Prova a cambiare la ricerca o i filtri.'
      : 'Nessuna fattura.'
    html('fatture-table', '<div class="dim" style="padding:10px 0">' + msg + '</div>')
    return
  }
  var rows = list.map(function (f) {
    return '<tr class="row-clickable" onclick="viewFattura(\'' + f.id + '\')">' +
      '<td><span class="cod">' + esc(f.numero || '— bozza —') + '</span></td>' +
      '<td class="dim">' + esc(fmtDate(f.data_emissione)) + '</td>' +
      '<td>' + esc(f.cliente_nome || '') + (f.tipo === 'nota_credito' ? ' ' + badge('warn', 'Nota credito') : '') + '</td>' +
      '<td class="num">' + fmtImporto(f.totale, f.valuta) + '</td>' +
      '<td>' + statoFatturaBadge(f.stato) +
        // L'incasso si mostra solo sulle fatture emesse: su una bozza non
        // significa niente, su una annullata sarebbe fuorviante.
        (f.stato === 'emessa' ? ' ' + badgePagamento('entrata', f.stato_pagamento) : '') +
        // FASE 7 — si vede a colpo d'occhio a quali fatture manca il PDF: senza
        // questa spia il pacchetto esce incompleto e ci si accorge solo dopo.
        (f.stato === 'emessa' && !contaAllegati('tm_conta_fatture', f.id)
          ? ' <span class="pdf-mancante">📎 PDF mancante</span>'
          : '') + '</td>' +
      '<td class="row-actions">' + fattureRowActions(f) + '</td>' +
    '</tr>'
  }).join('')
  html('fatture-table', '<div class="table-wrap"><table><thead><tr>' +
    '<th style="width:110px">Numero</th><th style="width:100px">Data</th><th>Cliente</th>' +
    '<th style="width:130px;text-align:right">Totale</th><th style="width:120px">Stato</th><th style="width:150px">Azioni</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>')
}

// ── Editor bozza ─────────────────────────────────────────────────────────────
function ivaAliquotaById(id) {
  if (!id) return 0
  var c = (ivaCache || []).filter(function (x) { return x.id === id })[0]
  return c ? safeNum(c.aliquota) : 0
}

// Riga fattura: il prezzo è IVA ESCLUSA → riusa calcolaIva con ivaInclusa=false.
// Se l'azienda NON è soggetta IVA: nessun calcolo IVA, totale = imponibile.
// ══════════════════════════════════════════════════════════════════════════════
// FASE 21 — UNITA' DI MISURA E RIGHE-TITOLO
//
// Due cose che sulle fatture dei fornitori di Umberto ci sono sempre e qui
// mancavano: l'unita' accanto alla quantita', e le righe-titolo che
// raggruppano le voci senza avere un importo proprio.
//
// La numerazione di posizione (a., a.1., b., b.1.) NON si salva: si calcola
// alla stampa. Salvarla vorrebbe dire ritrovarsi numeri sbagliati la prima
// volta che si toglie una riga in mezzo.
// ══════════════════════════════════════════════════════════════════════════════

// Le unita' che si usano davvero in carpenteria. Sono SUGGERIMENTI: il campo
// resta libero, perche' prima o poi serve un'unita' che qui non c'e'.
var UNITA_SUGGERITE = ['ml', 'm2', 'm3', 'kg', 'h', 'fr/h', 'ac.', 'pz', 'forfait']

function isRigaTitolo(r) {
  return !!r && r.tipo_riga === 'titolo'
}

// a, b, c … z, poi aa, ab. Oltre le ventisei lettere non ci si arriva su una
// fattura, ma un titolo senza numero sarebbe peggio di un numero strano.
function letteraPosizione(i) {
  var s = ''
  i = i + 1
  while (i > 0) {
    var resto = (i - 1) % 26
    s = String.fromCharCode(97 + resto) + s
    i = Math.floor((i - 1) / 26)
  }
  return s
}

// La numerazione, calcolata in un colpo solo su tutte le righe:
//   titolo                  -> 'a.'   'b.'   'c.'
//   voce sotto un titolo    -> 'a.1.' 'a.2.' 'b.1.'
//   voce prima di ogni titolo (o fattura senza titoli, com'e' oggi) -> '1.' '2.'
// Torna un array parallelo a `righe`.
function posizioniRighe(righe) {
  var out = []
  var titoliVisti = -1     // -1 = nessun titolo ancora incontrato
  var sotto = 0            // voci sotto il titolo corrente
  var semplice = 0         // voci prima di qualsiasi titolo
  for (var i = 0; i < (righe || []).length; i++) {
    if (isRigaTitolo(righe[i])) {
      titoliVisti++
      sotto = 0
      out.push(letteraPosizione(titoliVisti) + '.')
    } else if (titoliVisti >= 0) {
      sotto++
      out.push(letteraPosizione(titoliVisti) + '.' + sotto + '.')
    } else {
      semplice++
      out.push(semplice + '.')
    }
  }
  return out
}

function calcolaRiga(r) {
  // FASE 21 — una riga-titolo vale zero e resta fuori da ogni somma. Tornando
  // null qui, recalcFatturaTotals e computeCurrentTotale la saltano da soli:
  // saltano gia' tutto quello che non ha un imponibile.
  if (isRigaTitolo(r)) return { imponibile: null, iva: null, totale: null }
  var qta = safeNum(r.quantita), prezzo = safeNum(r.prezzo_unitario)
  if (qta == null || prezzo == null) return { imponibile: null, iva: null, totale: null }
  var aliquota = isSoggettoIva() ? ivaAliquotaById(r.codice_iva_id) : 0
  return calcolaIva(round2(qta * prezzo), aliquota, false)
}

// Mostra/nasconde le colonne IVA dell'editor e la riga IVA nei totali
function applyIvaModeEditor() {
  var on = isSoggettoIva()
  var ids = ['th-riga-codiva', 'th-riga-iva', 'fatture-tot-iva-row']
  for (var i = 0; i < ids.length; i++) {
    var e = el(ids[i])
    if (e) e.style.display = on ? '' : 'none'
  }
  var thImp = el('th-riga-imponibile')
  if (thImp) thImp.textContent = on ? 'Imponibile' : 'Importo'
  var lblImp = el('fatture-tot-imponibile-row')
  if (lblImp) {
    var lbl = lblImp.querySelector('.ft-label')
    if (lbl) lbl.textContent = on ? 'Imponibile' : 'Somma importi'
  }
}

async function newFattura(tipo) {
  editorFatturaId = null
  editorTipo = tipo || 'fattura'
  editorRifId = null
  editorRifTotale = null
  editorRifInfo = null
  fatturaRighe = [{ descrizione: '', quantita: 1, prezzo_unitario: '', codice_iva_id: '', unita: '', tipo_riga: 'voce' }]
  el('fatture-edit-title').textContent = editorTipo === 'nota_credito' ? 'Nuova nota di credito' : 'Nuova fattura'
  el('f-cli-nome').value = ''
  // FASE 17 — collegamento alla rubrica: si azzera con il resto dell'intestazione,
  // altrimenti la fattura nuova nascerebbe legata al cliente di quella prima.
  if (el('f-cli-contatto-id')) el('f-cli-contatto-id').value = ''
  html('f-cli-contatto-legato', '')
  html('f-cli-nome-suggest', '')
  el('f-cli-indirizzo').value = ''
  impostaPaese('f-cli-paese', PAESE_PREDEFINITO)
  paeseFatturaToccato = false   // e' il predefinito, non una scelta
  el('f-cli-iva').value = ''
  el('f-fat-data').value = oggiISO()
  el('f-fat-valuta').value = 'CHF'
  el('f-fat-note').value = ''
  html('fatture-edit-banner', '')
  showFattureView('edit')
  await ensureContiIva()
  await loadAziendaInfo()
  await loadIbanRubrica()
  populateEditorIban(null)
  applyIvaModeEditor()
  renderRigheEditor()
}

async function editFattura(id) {
  if (!currentAziendaId) return
  html('fatture-edit-banner', '')
  try {
    const { data: f, error } = await sb.from('tm_conta_fatture').select('*').eq('id', id).eq('azienda_id', currentAziendaId).single()
    if (error) throw error
    if (f.stato !== 'bozza') {
      showFattureBanner('fatture-list-banner', 'warn', 'Solo le bozze sono modificabili. Questa fattura è «' + f.stato + '»: per correggerla usa una nota di credito.')
      return
    }
    const { data: righe, error: rErr } = await sb.from('tm_conta_fatture_righe').select('*').eq('fattura_id', id).order('ordine')
    if (rErr) throw rErr

    editorFatturaId = f.id
    editorTipo = f.tipo
    editorRifId = f.rif_fattura_id || null
    editorRifTotale = null
    editorRifInfo = null
    // Per le note di credito: carica la fattura originale (limite di storno + riferimento)
    if (f.tipo === 'nota_credito' && f.rif_fattura_id) {
      try {
        const { data: rif, error: rifErr } = await sb
          .from('tm_conta_fatture')
          .select('id, numero, data_emissione, totale')
          .eq('id', f.rif_fattura_id)
          .eq('azienda_id', currentAziendaId)
          .single()
        if (!rifErr && rif) { editorRifTotale = safeNum(rif.totale); editorRifInfo = rif }
      } catch (_) { /* riferimento non disponibile: nessun limite mostrato */ }
    }
    fatturaRighe = (righe || []).map(function (r) {
      return { descrizione: r.descrizione || '', quantita: r.quantita,
               prezzo_unitario: r.prezzo_unitario, codice_iva_id: r.codice_iva_id || '',
               // FASE 21 — le righe salvate prima della migrazione non hanno
               // le due colonne: unita vuota e tipo 'voce', che e' quello che
               // sono sempre state.
               unita: r.unita || '', tipo_riga: r.tipo_riga || 'voce' }
    })
    if (!fatturaRighe.length) fatturaRighe = [{ descrizione: '', quantita: 1, prezzo_unitario: '', codice_iva_id: '', unita: '', tipo_riga: 'voce' }]

    el('fatture-edit-title').textContent = (f.tipo === 'nota_credito' ? 'Nota di credito' : 'Fattura') + ' (bozza)'
    el('f-cli-nome').value = f.cliente_nome || ''
    // FASE 17 — si ricostruisce il riquadro «collegato in rubrica» dal solo id
    // salvato: riaprendo una bozza il collegamento deve essere ancora li'.
    if (el('f-cli-contatto-id')) el('f-cli-contatto-id').value = f.contatto_id || ''
    html('f-cli-nome-suggest', '')
    aggiornaLegatoDaId('v', f.contatto_id)
    el('f-cli-indirizzo').value = f.cliente_indirizzo || ''
    impostaPaese('f-cli-paese', f.cliente_paese || PAESE_PREDEFINITO)
    // Un paese gia' salvato sulla bozza e' una decisione presa: scegliendo un
    // contatto non va sovrascritto. Se invece era vuoto, il CH qui sopra e'
    // solo il predefinito e puo' cedere il posto al paese del cliente.
    paeseFatturaToccato = !!f.cliente_paese
    el('f-cli-iva').value = f.cliente_iva || ''
    el('f-fat-data').value = f.data_emissione || oggiISO()
    el('f-fat-valuta').value = f.valuta || 'CHF'
    el('f-fat-note').value = f.note || ''
    html('fatture-edit-banner', '')
    showFattureView('edit')
    await ensureContiIva()
    await loadAziendaInfo()
    await loadIbanRubrica()
    populateEditorIban(f.iban || null)
    applyIvaModeEditor()
    renderRigheEditor()
  } catch (e) {
    showFattureBanner('fatture-list-banner', 'err', 'Apertura bozza: ' + friendlyFatturaError(e))
  }
}

function renderRigheEditor() {
  var tb = el('fatture-righe')
  if (!tb) return
  var ivaOn = isSoggettoIva()
  var rows = ''
  for (var i = 0; i < fatturaRighe.length; i++) {
    var r = fatturaRighe[i]
    var calc = calcolaRiga(r)
    var titolo = isRigaTitolo(r)
    // FASE 21 — su una riga-titolo i campi numerici non ci sono proprio: non
    // devono essere «disattivati ma presenti», perche' un campo grigio invita
    // comunque a provarci. Al loro posto una cella vuota.
    // unita, quantita, prezzo, [codice IVA], imponibile, [importo IVA]
    var celleVuote = '<td></td><td></td><td></td>' + (ivaOn ? '<td></td>' : '') +
                     '<td></td>' + (ivaOn ? '<td></td>' : '')
    rows +=
      '<tr' + (titolo ? ' class="riga-titolo"' : '') + '>' +
        // FASE 20 — descrizione su piu' righe: e' la parte che legge il
        // cliente, e su una riga sola il testo lungo spariva a destra. Il
        // «\n» dopo il tag e' voluto: l'HTML scarta il primo a capo dentro un
        // textarea, e senza di quello una descrizione che comincia con un a
        // capo lo perderebbe al primo salvataggio.
        '<td><textarea class="cell-input cell-desc' + (titolo ? ' cell-titolo' : '') + '" rows="1"' +
          ' placeholder="' + (titolo ? 'Titolo del gruppo (senza importi)' : 'Descrizione') + '"' +
          ' oninput="onRigaInput(' + i + ',\'descrizione\',this.value); autoGrowRiga(this)">' +
          '\n' + esc(r.descrizione || '') + '</textarea></td>' +
        (titolo ? celleVuote :
          // FASE 21 — l'unita': campo libero con i suggerimenti piu' usati.
          // Una tendina chiusa prima o poi non ha l'unita' che serve.
          '<td><input class="cell-input cell-unita" list="unita-suggerite" maxlength="16"' +
            ' value="' + esc(r.unita || '') + '" placeholder="—"' +
            ' oninput="onRigaInput(' + i + ',\'unita\',this.value)"></td>' +
          // FASE 20 — onfocus/select: il campo parte con «1» (quantita) e col
          // valore gia' scritto (prezzo). Senza la selezione, la prima cifra si
          // ACCODA invece di sostituire: scrivere 150 sopra 0 dava 1500, ed e'
          // finito su una fattura vera.
          '<td><input class="cell-input num" type="number" step="0.001" value="' + esc(r.quantita == null ? '' : String(r.quantita)) + '" onfocus="this.select()" oninput="onRigaInput(' + i + ',\'quantita\',this.value)"></td>' +
          '<td><input class="cell-input num" type="number" step="0.01" value="' + esc(r.prezzo_unitario == null ? '' : String(r.prezzo_unitario)) + '" onfocus="this.select()" oninput="onRigaInput(' + i + ',\'prezzo_unitario\',this.value)"></td>' +
          (ivaOn ? '<td><select class="cell-input" onchange="onRigaInput(' + i + ',\'codice_iva_id\',this.value)">' + buildIvaOptions(r.codice_iva_id) + '</select></td>' : '') +
          '<td class="num" id="imp-cell-' + i + '">' + importoRigaTesto(calc.imponibile) + '</td>' +
          (ivaOn ? '<td class="num" id="iva-cell-' + i + '">' + importoRigaTesto(calc.iva) + '</td>' : '')
        ) +
        '<td><button class="icon-btn danger" title="Rimuovi riga" onclick="removeRiga(' + i + ')">✕</button></td>' +
      '</tr>'
  }
  tb.innerHTML = rows
  // Le descrizioni gia' scritte devono aprirsi alla loro altezza, non a una
  // riga con il resto nascosto.
  var aree = tb.querySelectorAll('textarea.cell-desc')
  for (var j = 0; j < aree.length; j++) autoGrowRiga(aree[j])
  recalcFatturaTotals()
}

// FASE 20 — il campo cresce col testo, cosi' si vede tutto senza scorrere
// dentro il campo. Si azzera prima di misurare: senza, l'altezza puo' solo
// aumentare e il campo non si richiude piu' cancellando righe.
function autoGrowRiga(ta) {
  if (!ta) return
  ta.style.height = 'auto'
  ta.style.height = ta.scrollHeight + 'px'
}

// FASE 20 — l'importo di una riga dell'editor: una riga ancora vuota vale
// zero, e si scrive «0,00». Il trattino dice «dato non disponibile», che qui
// non e' vero: il dato c'e' ed e' zero finche' non si scrive un prezzo.
function importoRigaTesto(v) {
  return fmtNum2(v == null ? 0 : v)
}

function onRigaInput(i, field, value) {
  if (!fatturaRighe[i]) return
  fatturaRighe[i][field] = value
  var calc = calcolaRiga(fatturaRighe[i])
  var impCell = el('imp-cell-' + i), ivaCell = el('iva-cell-' + i)
  if (impCell) impCell.textContent = importoRigaTesto(calc.imponibile)
  if (ivaCell) ivaCell.textContent = importoRigaTesto(calc.iva)
  recalcFatturaTotals()
}

// FASE 21 — la riga-titolo si aggiunge da un bottone suo: trasformare una
// voce in titolo con una tendina avrebbe voluto dire un campo in piu' su ogni
// riga, per una cosa che si decide una volta.
function addTitolo() {
  fatturaRighe.push({ descrizione: '', quantita: '', prezzo_unitario: '',
                      codice_iva_id: '', unita: '', tipo_riga: 'titolo' })
  renderRigheEditor()
}

function addRiga() {
  fatturaRighe.push({ descrizione: '', quantita: 1, prezzo_unitario: '', codice_iva_id: '', unita: '', tipo_riga: 'voce' })
  renderRigheEditor()
}
function removeRiga(i) {
  fatturaRighe.splice(i, 1)
  if (!fatturaRighe.length) fatturaRighe.push({ descrizione: '', quantita: 1, prezzo_unitario: '', codice_iva_id: '', unita: '', tipo_riga: 'voce' })
  renderRigheEditor()
}

// Calcola i totali dalle righe SENZA scrivere nel DOM (usato dalle validazioni,
// evita ricorsione con updateNcRefInfo)
function computeCurrentTotale() {
  var ti = 0, tv = 0
  for (var i = 0; i < fatturaRighe.length; i++) {
    var c = calcolaRiga(fatturaRighe[i])
    if (c.imponibile != null) ti += c.imponibile
    if (c.iva != null) tv += c.iva
  }
  return round2(round2(ti) + round2(tv))
}

// Verifica storno: la nota di credito non deve superare il totale della fattura originale
function ncStornoCheck() {
  if (editorTipo !== 'nota_credito' || editorRifTotale == null) return { applicable: false, exceeds: false }
  var tot = computeCurrentTotale()
  var max = round2(editorRifTotale)
  return { applicable: true, exceeds: tot > max + 0.005, tot: tot, max: max }
}

function updateNcRefInfo() {
  var box = el('fatture-nc-ref')
  if (!box) return
  if (editorTipo !== 'nota_credito') { box.style.display = 'none'; box.innerHTML = ''; return }
  var rif = editorRifInfo || {}
  var max = editorRifTotale
  var tot = computeCurrentTotale()
  var over = (max != null) && (tot > round2(max) + 0.005)
  var refTxt = rif.numero
    ? ('fattura ' + rif.numero + (rif.data_emissione ? ' del ' + fmtDate(rif.data_emissione) : ''))
    : 'fattura originale'
  box.style.display = 'block'
  box.className = 'nc-ref' + (over ? ' nc-ref-over' : '')
  box.innerHTML =
    '↩️ Nota di credito — storno della ' + esc(refTxt) + '. ' +
    (max != null
      ? 'Totale originale: <strong>' + fmtNum2(round2(max)) + '</strong> · Storno corrente: <strong>' + fmtNum2(tot) + '</strong>. ' +
        'Rimuovi righe o riduci quantità/prezzo per uno storno parziale.'
      : '') +
    (over ? '<div class="nc-ref-warn">⚠️ Lo storno supera il totale della fattura originale: riducilo prima di emettere.</div>' : '')
}

function recalcFatturaTotals() {
  var ti = 0, tv = 0
  for (var i = 0; i < fatturaRighe.length; i++) {
    var c = calcolaRiga(fatturaRighe[i])
    if (c.imponibile != null) ti += c.imponibile
    if (c.iva != null) tv += c.iva
  }
  ti = round2(ti); tv = round2(tv)
  var tt = round2(ti + tv)
  if (el('fatture-tot-imponibile')) el('fatture-tot-imponibile').textContent = fmtNum2(ti)
  if (el('fatture-tot-iva'))        el('fatture-tot-iva').textContent = fmtNum2(tv)
  if (el('fatture-tot-totale'))     el('fatture-tot-totale').textContent = fmtNum2(tt)
  updateNcRefInfo()
  return { imponibile: ti, iva: tv, totale: tt }
}

function collectFatturaHeader() {
  var nome = el('f-cli-nome') ? el('f-cli-nome').value.trim() : ''
  if (!nome) throw new Error('Il nome cliente è obbligatorio.')
  var dataVal = el('f-fat-data') ? el('f-fat-data').value : ''
  var anno = dataVal ? parseInt(dataVal.slice(0, 4), 10) : new Date().getFullYear()
  var tot = recalcFatturaTotals()
  return {
    azienda_id:        currentAziendaId,
    cliente_nome:      nome,
    // FASE 17 — il cliente e' collegato alla rubrica come il fornitore della
    // fattura d'acquisto. Resta facoltativo: un nome scritto a mano si salva
    // lo stesso, con contatto_id nullo.
    contatto_id:       (el('f-cli-contatto-id') && el('f-cli-contatto-id').value) || null,
    cliente_indirizzo: el('f-cli-indirizzo') ? (el('f-cli-indirizzo').value.trim() || null) : null,
    cliente_paese:     (el('f-cli-paese') && el('f-cli-paese').value.trim()) || PAESE_PREDEFINITO,
    cliente_iva:       el('f-cli-iva') ? (el('f-cli-iva').value.trim() || null) : null,
    valuta:            el('f-fat-valuta') ? el('f-fat-valuta').value : 'CHF',
    data_emissione:    dataVal || null,
    anno:              anno,
    tipo:              editorTipo,
    rif_fattura_id:    editorRifId,
    iban:              resolveEditorIban(),
    note:              el('f-fat-note') ? (el('f-fat-note').value.trim() || null) : null,
    totale_imponibile: tot.imponibile,
    totale_iva:        tot.iva,
    totale:            tot.totale
  }
}

async function replaceRighe(fatturaId) {
  const del = await sb.from('tm_conta_fatture_righe').delete().eq('fattura_id', fatturaId).select()
  if (del.error) throw del.error
  var payload = []
  for (var i = 0; i < fatturaRighe.length; i++) {
    var r = fatturaRighe[i]
    var desc = (r.descrizione || '').trim()
    // Una riga senza descrizione non e' niente: vale per le voci come per i
    // titoli. Un titolo ha SEMPRE una descrizione (e' tutto quello che ha),
    // quindi questa regola non ne butta via nessuno.
    if (!desc) continue
    var titolo = isRigaTitolo(r)
    var calc = calcolaRiga(r)
    payload.push({
      fattura_id:      fatturaId,
      descrizione:     desc,
      // FASE 21 — su un titolo tutti i numeri vanno a zero e l'unita' sparisce:
      // le colonne sono NOT NULL con default 0, e uno zero esplicito e' piu'
      // onesto di un residuo lasciato nel modulo prima di cambiare tipo riga.
      unita:           titolo ? null : ((r.unita || '').trim() || null),
      tipo_riga:       titolo ? 'titolo' : 'voce',
      quantita:        titolo ? 0 : (safeNum(r.quantita) != null ? safeNum(r.quantita) : 0),
      prezzo_unitario: titolo ? 0 : (safeNum(r.prezzo_unitario) != null ? safeNum(r.prezzo_unitario) : 0),
      codice_iva_id:   (titolo || !isSoggettoIva()) ? null : (r.codice_iva_id || null),
      imponibile_riga: calc.imponibile != null ? calc.imponibile : 0,
      iva_riga:        calc.iva != null ? calc.iva : 0,
      totale_riga:     calc.totale != null ? calc.totale : 0,
      ordine:          i
    })
  }
  if (payload.length) {
    const ins = await sb.from('tm_conta_fatture_righe').insert(payload).select()
    if (ins.error) throw ins.error
  }
}

async function persistBozza() {
  await maybeSaveNewIbanToRubrica()   // se "nuovo IBAN" + "salva in rubrica"
  var header = collectFatturaHeader()
  header.stato = 'bozza'
  var fatturaId = editorFatturaId
  if (fatturaId) {
    const { error } = await sb.from('tm_conta_fatture').update(header).eq('id', fatturaId).eq('azienda_id', currentAziendaId).select()
    if (error) throw error
  } else {
    header.created_by = currentUser ? currentUser.id : null
    const { data, error } = await sb.from('tm_conta_fatture').insert(header).select()
    if (error) throw error
    fatturaId = data && data[0] ? data[0].id : null
    editorFatturaId = fatturaId
  }
  if (!fatturaId) throw new Error('ID fattura non disponibile dopo il salvataggio.')
  await replaceRighe(fatturaId)
  return fatturaId
}

async function saveBozza() {
  html('fatture-edit-banner', '')
  var btn = el('btn-salva-bozza'); if (btn) btn.disabled = true
  try {
    await persistBozza()
    var ncChk = ncStornoCheck()
    if (ncChk.applicable && ncChk.exceeds) {
      showFattureBanner('fatture-edit-banner', 'warn',
        'Bozza salvata, ma lo storno (' + fmtNum2(ncChk.tot) + ') supera la fattura originale (' + fmtNum2(ncChk.max) + '): riducilo prima di emettere.')
    } else {
      showFattureBanner('fatture-edit-banner', 'ok', 'Bozza salvata.')
    }
    await loadFattureList()
  } catch (e) {
    showFattureBanner('fatture-edit-banner', 'err', e.message)
  } finally {
    if (btn) btn.disabled = false
  }
}

async function emettiFatturaCorrente() {
  // FASE 22 / P5 — le righe-titolo non contano, e il messaggio lo dice.
  //
  // Il controllo di prima non guardava tipo_riga: funzionava per caso, perche'
  // su una riga-titolo calcolaRiga() azzera il prezzo. Una riga-titolo vecchia
  // rimasta con prezzo_unitario = 0 sarebbe passata (safeNum(0) non e' null) e
  // avrebbe emesso una fattura fatta di soli titoli. Adesso i titoli sono
  // esclusi in modo esplicito, con l'helper che esiste gia'.
  var voci = 0, titoli = 0
  for (var i = 0; i < fatturaRighe.length; i++) {
    var r = fatturaRighe[i]
    if (isRigaTitolo(r)) { titoli++; continue }
    if ((r.descrizione || '').trim() && safeNum(r.prezzo_unitario) != null) voci++
  }
  if (!voci) {
    showFattureBanner('fatture-edit-banner', 'err', titoli
      ? 'Le righe-titolo non hanno importo: servono a raggruppare, non fanno somma. ' +
        'Aggiungi almeno una voce vera, con descrizione e prezzo.'
      : 'Aggiungi almeno una riga con descrizione e prezzo.')
    return
  }
  if (!el('f-cli-nome').value.trim()) { showFattureBanner('fatture-edit-banner', 'err', 'Il nome cliente è obbligatorio.'); return }

  var ncChk = ncStornoCheck()
  if (ncChk.applicable && ncChk.exceeds) {
    showFattureBanner('fatture-edit-banner', 'err',
      'La nota di credito (' + fmtNum2(ncChk.tot) + ') supera il totale della fattura originale (' + fmtNum2(ncChk.max) + '). Riduci righe o importi prima di emettere.')
    return
  }

  // Riepilogo di conferma (evita emissioni per distrazione)
  var tipoLbl = editorTipo === 'nota_credito' ? 'Nota di credito' : 'Fattura'
  var cliente = el('f-cli-nome') ? el('f-cli-nome').value.trim() : ''
  var dataVal = el('f-fat-data') ? el('f-fat-data').value : ''
  var valuta  = el('f-fat-valuta') ? el('f-fat-valuta').value : 'CHF'
  var tot     = recalcFatturaTotals().totale
  var sumRows = [['Tipo', tipoLbl], ['Cliente', cliente || '—'], ['Data', dataVal ? fmtDate(dataVal) : 'oggi (all\'emissione)']]
  if (editorTipo !== 'nota_credito') {
    // FASE 18 — l'emissione e' il punto in cui l'errore diventa definitivo:
    // l'IBAN si legge per intero, a gruppi di 4.
    var ibanConf = resolveEditorIban() || (aziendaInfo && aziendaInfo.iban) || ''
    sumRows.push(['IBAN', ibanConf ? ibanLeggibile(ibanConf) : '— predefinito —'])
  }
  sumRows.push(['Totale', fmtNum2(tot) + ' ' + valuta, true])
  openEmitConfirm(emitSummaryRows(sumRows), doEmitCorrente)
}

async function doEmitCorrente() {
  var btn = el('btn-emetti'); if (btn) { btn.disabled = true; btn.textContent = '⏳ Emissione…' }
  try {
    await persistBozza()
    const { data, error } = await sb.rpc('tm_conta_emetti_fattura', { p_fattura_id: editorFatturaId })
    if (error) throw error
    var emessa = Array.isArray(data) ? data[0] : data
    await loadFattureList()
    try { await refreshDaClassificareCount() } catch (_) {}
    if (emessa && emessa.id) viewFattura(emessa.id)
    else fattureBackToList()
  } catch (e) {
    showFattureBanner('fatture-edit-banner', 'err', 'Emissione: ' + friendlyFatturaError(e))
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📨 Emetti (assegna numero)' }
  }
}

async function emettiFatturaById(id) {
  var f = currentDetailFattura
  var sumRows
  if (f && f.id === id) {
    var tLbl = f.tipo === 'nota_credito' ? 'Nota di credito' : 'Fattura'
    sumRows = [['Tipo', tLbl], ['Cliente', f.cliente_nome || '—'], ['Data', f.data_emissione ? fmtDate(f.data_emissione) : 'oggi (all\'emissione)']]
    // FASE 18 — stessa conferma, stesso IBAN per intero.
    if (f.tipo !== 'nota_credito') {
      var ibanConfId = (f.iban && String(f.iban).trim()) ? f.iban : ((aziendaInfo && aziendaInfo.iban) || '')
      sumRows.push(['IBAN', ibanConfId ? ibanLeggibile(ibanConfId) : '— predefinito —'])
    }
    sumRows.push(['Totale', fmtNum2(safeNum(f.totale)) + ' ' + (f.valuta || 'CHF'), true])
  } else {
    sumRows = [['Documento', 'pronto per l\'emissione']]
  }
  openEmitConfirm(emitSummaryRows(sumRows), function () { doEmitById(id) })
}

async function doEmitById(id) {
  html('fatture-detail-banner', loadingRow('Emissione in corso…'))
  try {
    const { error } = await sb.rpc('tm_conta_emetti_fattura', { p_fattura_id: id })
    if (error) throw error
    await loadFattureList()
    try { await refreshDaClassificareCount() } catch (_) {}
    await viewFattura(id)
  } catch (e) {
    showFattureBanner('fatture-detail-banner', 'err', 'Emissione: ' + friendlyFatturaError(e))
  }
}

async function deleteBozza(id) {
  if (!window.confirm('Eliminare la bozza? Verranno cancellate la fattura e le sue righe. (Solo le bozze si possono eliminare — le fatture emesse restano.)')) return
  html('fatture-list-banner', loadingRow('Eliminazione…'))
  try {
    // .eq('stato','bozza') → non tocca mai una emessa (i numeri non si riusano)
    const { data, error } = await sb
      .from('tm_conta_fatture')
      .delete()
      .eq('id', id)
      .eq('azienda_id', currentAziendaId)
      .eq('stato', 'bozza')
      .select()
    if (error) throw error
    fattureBackToList()
    await loadFattureList()
    if (data && data.length) showFattureBanner('fatture-list-banner', 'ok', 'Bozza eliminata.')
    else showFattureBanner('fatture-list-banner', 'warn', 'Nessuna bozza eliminata: la fattura potrebbe essere già emessa (in tal caso usa una nota di credito).')
  } catch (e) {
    fattureBackToList()
    showFattureBanner('fatture-list-banner', 'err', 'Eliminazione: ' + friendlyFatturaError(e))
  }
}

// Registra l'incasso di una fattura emessa.
// Prima l'incasso veniva scritto dentro il campo «stato», cioe' sopra il ciclo
// di vita del documento, e la DATA non veniva salvata da nessuna parte.
// Ora l'incasso ha un campo suo e una data sua, e lo stato del documento
// (emessa) non viene piu' toccato.
// FASE 8 — questa funzione non esiste piu' come azione dell'interfaccia.
// «Segna incassata» in un clic scriveva stato_pagamento a mano: adesso lo
// stato lo calcola il trigger dai pagamenti, e togliere un incasso significa
// cancellare i versamenti registrati, uno per uno, con la loro conferma.
// Resta qui solo per intercettare eventuali chiamate rimaste in giro.
async function setIncassata(id, toIncassata) {
  console.warn('setIncassata non e piu in uso: usare apriRegistraPagamento o eliminaPagamento.')
  window.alert('Per registrare o togliere un incasso usa il riquadro «Pagamenti» nella scheda della fattura.')
}

async function creaNotaCredito(id) {
  if (!window.confirm('Creare una nota di credito che storna questa fattura? Viene creata come bozza, poi potrai emetterla con numerazione propria.')) return
  html('fatture-detail-banner', loadingRow('Creazione nota di credito…'))
  try {
    const { data: f, error } = await sb.from('tm_conta_fatture').select('*').eq('id', id).eq('azienda_id', currentAziendaId).single()
    if (error) throw error
    const { data: righe, error: rErr } = await sb.from('tm_conta_fatture_righe').select('*').eq('fattura_id', id).order('ordine')
    if (rErr) throw rErr

    var header = {
      azienda_id:        currentAziendaId,
      cliente_nome:      f.cliente_nome,
      cliente_indirizzo: f.cliente_indirizzo,
      cliente_paese:     f.cliente_paese,
      cliente_iva:       f.cliente_iva,
      valuta:            f.valuta,
      data_emissione:    oggiISO(),
      anno:              new Date().getFullYear(),
      tipo:              'nota_credito',
      rif_fattura_id:    f.id,
      stato:             'bozza',
      note:              'Storno della fattura ' + (f.numero || ''),
      totale_imponibile: f.totale_imponibile,
      totale_iva:        f.totale_iva,
      totale:            f.totale,
      created_by:        currentUser ? currentUser.id : null
    }
    const { data: ins, error: insErr } = await sb.from('tm_conta_fatture').insert(header).select()
    if (insErr) throw insErr
    var ncId = ins && ins[0] ? ins[0].id : null
    if (ncId && righe && righe.length) {
      var rp = righe.map(function (r, idx) {
        return {
          fattura_id: ncId, descrizione: r.descrizione, quantita: r.quantita, prezzo_unitario: r.prezzo_unitario,
          codice_iva_id: r.codice_iva_id, imponibile_riga: r.imponibile_riga, iva_riga: r.iva_riga, totale_riga: r.totale_riga, ordine: idx,
          unita: r.unita || null, tipo_riga: r.tipo_riga || 'voce'   // FASE 21
        }
      })
      const { error: rErr2 } = await sb.from('tm_conta_fatture_righe').insert(rp).select()
      if (rErr2) throw rErr2
    }
    await loadFattureList()
    if (ncId) await editFattura(ncId)
  } catch (e) {
    showFattureBanner('fatture-detail-banner', 'err', 'Nota di credito: ' + friendlyFatturaError(e))
  }
}

// ── Rubrica IBAN per cantiere (Fase 8) ───────────────────────────────────────
// FASE 18 — questa funzione non ha piu' nessun chiamante: tutti i punti in cui
// si sceglie o si conferma un IBAN adesso lo mostrano intero (ibanLeggibile).
// Resta qui, e non e' una svista: se un domani un IBAN andasse mostrato a
// qualcuno che non e' Umberto, il mascheramento serve gia' pronto.
function maskIban(iban) {
  var s = String(iban || '').replace(/\s+/g, '')
  return s.length <= 4 ? s : '…' + s.slice(-4)
}

// FASE 18 — l'IBAN scritto per intero, a gruppi di 4 come si legge sulla
// fattura. Sono gli IBAN dell'azienda, che finiscono comunque stampati sul
// documento: nasconderne le cifre non protegge niente e toglie l'unico modo
// per distinguere due conti che finiscono con le stesse quattro cifre.
function ibanLeggibile(iban) {
  var s = String(iban || '').replace(/\s+/g, '').toUpperCase()
  if (!s) return ''
  return s.replace(/(.{4})/g, '$1 ').trim()
}

async function loadIbanRubrica(force) {
  if (ibanRubrica !== null && !force) return
  if (!currentAziendaId) { ibanRubrica = []; return }
  try {
    const { data, error } = await sb
      .from('tm_conta_iban')
      .select('id, etichetta, iban, attivo')
      .eq('azienda_id', currentAziendaId)
      .order('attivo', { ascending: false })
      .order('etichetta')
    if (error) throw error
    ibanRubrica = data || []
  } catch (e) {
    ibanRubrica = ibanRubrica || []
    console.warn('IBAN rubrica:', e.message)
  }
}

// ── Editor fattura: selezione IBAN ───────────────────────────────────────────
function buildEditorIbanOptions(currentIban) {
  var a = aziendaInfo || {}
  // FASE 18 — IBAN per intero: qui si SCEGLIE su quale conto farsi pagare, e
  // due conti che finiscono uguale erano indistinguibili.
  var defMask = a.iban ? ' (' + ibanLeggibile(a.iban) + ')' : ' (non impostato)'
  var out = '<option value="">Predefinito aziendale' + esc(defMask) + '</option>'
  var attive = (ibanRubrica || []).filter(function (x) { return x.attivo })
  for (var i = 0; i < attive.length; i++) {
    var e = attive[i]
    var sel = (currentIban && e.iban === currentIban) ? ' selected' : ''
    out += '<option value="' + esc(e.iban) + '"' + sel + '>' + esc(e.etichetta + ' — ' + ibanLeggibile(e.iban)) + '</option>'
  }
  out += '<option value="__new__">➕ Nuovo IBAN…</option>'
  return out
}

function populateEditorIban(currentIban) {
  var sel = el('f-fat-iban-select')
  if (!sel) return
  // reset stato "nuovo"
  if (el('f-fat-iban-save')) el('f-fat-iban-save').checked = false
  if (el('f-fat-iban-label')) { el('f-fat-iban-label').value = ''; el('f-fat-iban-label').style.display = 'none' }
  if (el('f-fat-iban-manual')) el('f-fat-iban-manual').value = ''

  sel.innerHTML = buildEditorIbanOptions(currentIban)
  // IBAN presente ma non in rubrica (manuale non salvato) → "__new__" precompilato
  if (currentIban && sel.value !== currentIban) {
    sel.value = '__new__'
    if (el('f-fat-iban-manual')) el('f-fat-iban-manual').value = currentIban
  }
  onIbanSelectChange()
}

function onIbanSelectChange() {
  var sel = el('f-fat-iban-select')
  var grp = el('f-fat-iban-new-group')
  if (grp) grp.style.display = (sel && sel.value === '__new__') ? 'block' : 'none'
}
function onIbanSaveToggle(checked) {
  var lbl = el('f-fat-iban-label')
  if (lbl) lbl.style.display = checked ? 'block' : 'none'
}
function updateEditorIbanState() { /* riservato: nessuna azione live necessaria */ }

// IBAN effettivo da salvare in tm_conta_fatture.iban ('' / predefinito → null)
function resolveEditorIban() {
  var sel = el('f-fat-iban-select')
  if (!sel) return null
  var v = sel.value
  if (v === '') return null
  if (v === '__new__') {
    var manual = el('f-fat-iban-manual') ? el('f-fat-iban-manual').value.trim() : ''
    return manual || null
  }
  return v
}

// Se "nuovo IBAN" + "salva in rubrica" spuntato: crea la voce (non bloccante)
async function maybeSaveNewIbanToRubrica() {
  var sel = el('f-fat-iban-select')
  if (!sel || sel.value !== '__new__') return
  if (!(el('f-fat-iban-save') && el('f-fat-iban-save').checked)) return
  var iban = el('f-fat-iban-manual') ? el('f-fat-iban-manual').value.trim() : ''
  var etichetta = el('f-fat-iban-label') ? el('f-fat-iban-label').value.trim() : ''
  if (!iban || !etichetta) return   // servono entrambi; altrimenti si salta
  try {
    const { error } = await sb
      .from('tm_conta_iban')
      .insert({ azienda_id: currentAziendaId, etichetta: etichetta, iban: iban, attivo: true })
      .select()
    if (error) throw error
    await loadIbanRubrica(true)
  } catch (e) { console.warn('Salvataggio IBAN in rubrica:', e.message) }
}

// ── Rubrica IBAN in ⚙️ Impostazioni ditta ────────────────────────────────────
async function renderIbanRubrica() {
  var box = el('iban-list')
  if (!box) return
  await loadIbanRubrica()
  var showClosed = el('iban-show-closed') && el('iban-show-closed').checked
  var list = (ibanRubrica || []).filter(function (x) { return showClosed || x.attivo })
  if (!list.length) { box.innerHTML = '<div class="dim" style="padding:6px 0">Nessun IBAN in rubrica.</div>'; return }
  box.innerHTML = list.map(function (e) {
    return '<div class="iban-row' + (e.attivo ? '' : ' chiuso') + '">' +
      '<span class="iban-etichetta">' + esc(e.etichetta) + '</span>' +
      // FASE 18 — anche qui per intero: e' l'elenco da cui si sceglie quale
      // conto modificare o chiudere, e sbagliare riga si paga caro.
      '<span class="iban-mask">' + esc(ibanLeggibile(e.iban)) + '</span>' +
      (e.attivo ? '' : ' ' + badge('warn', 'chiuso')) +
      '<span class="iban-actions">' +
        '<button class="icon-btn" title="Modifica" onclick="editIbanEntry(\'' + e.id + '\')">✏️</button>' +
        (e.attivo
          ? '<button class="icon-btn" title="Segna chiuso" onclick="toggleIbanChiuso(\'' + e.id + '\', false)">🔒 Chiudi</button>'
          : '<button class="icon-btn" title="Riapri" onclick="toggleIbanChiuso(\'' + e.id + '\', true)">↩︎ Riapri</button>') +
      '</span>' +
    '</div>'
  }).join('')
}

function openIbanForm() {
  editingIbanId = null
  if (el('iban-form-etichetta')) el('iban-form-etichetta').value = ''
  if (el('iban-form-iban')) el('iban-form-iban').value = ''
  if (el('iban-form-save-btn')) el('iban-form-save-btn').textContent = '💾 Salva IBAN'
  var f = el('iban-form'); if (f) f.style.display = 'block'
  html('iban-banner', '')
}
function closeIbanForm() {
  editingIbanId = null
  var f = el('iban-form'); if (f) f.style.display = 'none'
}
function editIbanEntry(id) {
  var e = (ibanRubrica || []).filter(function (x) { return x.id === id })[0]
  if (!e) return
  editingIbanId = id
  if (el('iban-form-etichetta')) el('iban-form-etichetta').value = e.etichetta || ''
  if (el('iban-form-iban')) el('iban-form-iban').value = e.iban || ''
  if (el('iban-form-save-btn')) el('iban-form-save-btn').textContent = '💾 Aggiorna IBAN'
  var f = el('iban-form'); if (f) f.style.display = 'block'
  html('iban-banner', '')
}

async function saveIbanEntry() {
  var etichetta = getVal('iban-form-etichetta')
  var iban = getVal('iban-form-iban')
  if (!etichetta || !iban) { showFattureBanner('iban-banner', 'err', 'Servono sia l\'etichetta sia l\'IBAN.'); return }
  if (!currentAziendaId) { showFattureBanner('iban-banner', 'err', 'Azienda non trovata.'); return }
  var btn = el('iban-form-save-btn'); if (btn) btn.disabled = true
  try {
    if (editingIbanId) {
      const { error } = await sb.from('tm_conta_iban').update({ etichetta: etichetta, iban: iban }).eq('id', editingIbanId).eq('azienda_id', currentAziendaId).select()
      if (error) throw error
    } else {
      const { error } = await sb.from('tm_conta_iban').insert({ azienda_id: currentAziendaId, etichetta: etichetta, iban: iban, attivo: true }).select()
      if (error) throw error
    }
    closeIbanForm()
    await loadIbanRubrica(true)
    renderIbanRubrica()
    showFattureBanner('iban-banner', 'ok', 'IBAN salvato in rubrica.')
  } catch (e) {
    showFattureBanner('iban-banner', 'err', 'Salvataggio IBAN: ' + (e.message || e))
  } finally {
    if (btn) btn.disabled = false
  }
}

async function toggleIbanChiuso(id, toAttivo) {
  if (!currentAziendaId) return
  try {
    const { error } = await sb.from('tm_conta_iban').update({ attivo: toAttivo }).eq('id', id).eq('azienda_id', currentAziendaId).select()
    if (error) throw error
    await loadIbanRubrica(true)
    renderIbanRubrica()
    showFattureBanner('iban-banner', 'ok', toAttivo ? 'IBAN riaperto.' : 'IBAN segnato come chiuso.')
  } catch (e) {
    showFattureBanner('iban-banner', 'err', 'Aggiornamento IBAN: ' + (e.message || e))
  }
}

// ── Vista / stampa documento ─────────────────────────────────────────────────
async function loadAziendaInfo() {
  if (aziendaInfo !== null) return
  // FASE 23 / P2 — due difetti nella stessa funzione.
  //
  // 1. LA GUARDIA. Senza sessione la lettura fallisce, il catch scriveva
  //    `aziendaInfo = {}` — e `{}` NON e' null, quindi la riga qui sopra
  //    faceva uscire ogni chiamata successiva: non si ritentava mai piu',
  //    nemmeno dopo il login. E' la stessa trappola della cache «riuscita»
  //    gia' chiusa per i cantieri e per le impostazioni.
  // 2. COSA COMPORTA. Con aziendaInfo vuoto isSoggettoIva() torna false, e la
  //    fattura si stampa SENZA colonne IVA, senza riepilogo IVA e senza numero
  //    IVA. Nessun errore, nessun avviso: un documento non conforme che sembra
  //    a posto. Sulla busta sparivano via e NPA del mittente.
  //
  // Percio': senza sessione non si scrive niente in cache e si riprova dopo.
  if (!currentAziendaId) return
  try {
    const { data, error } = await sb.from('tm_aziende').select('*').eq('id', currentAziendaId).single()
    if (error) throw error
    aziendaInfo = data || {}
  } catch (e) {
    console.warn('Dati della ditta non letti:', e.message || e)
    // NON si mette {}: lascerebbe la funzione bloccata per sempre. Si lascia
    // null, cosi' il prossimo tentativo riprova davvero.
  }
}

// I dati della ditta ci sono davvero? Chi stampa un documento deve poterlo
// chiedere invece di scoprire a cose fatte che l'intestazione e' vuota.
function datiDittaMancanti() { return aziendaInfo === null || !aziendaInfo.nome }
function aziendaNome() {
  var a = aziendaInfo || {}
  return a.nome || a.ragione_sociale || a.denominazione || a.name || 'Carpenteria Ticinese Sàgl'
}
function aziendaDettagli() {
  var a = aziendaInfo || {}
  var parts = []
  if (a.indirizzo) parts.push(a.indirizzo)
  var npa = a.npa || a.cap
  var citta = a.localita || a.citta || a.luogo
  if (npa || citta) parts.push([npa, citta].filter(Boolean).join(' '))
  if (a.iva || a.partita_iva || a.numero_iva) parts.push('IVA ' + (a.iva || a.partita_iva || a.numero_iva))
  return parts.join('\n')
}

async function viewFattura(id) {
  if (!currentAziendaId) return
  showFattureView('detail')
  html('fatture-detail-banner', '')
  html('fatture-print', loadingRow('Caricamento fattura…'))
  html('fatture-detail-actions', '')
  try {
    const { data: f, error } = await sb.from('tm_conta_fatture').select('*').eq('id', id).eq('azienda_id', currentAziendaId).single()
    if (error) throw error
    const { data: righe, error: rErr } = await sb.from('tm_conta_fatture_righe').select('*').eq('fattura_id', id).order('ordine')
    if (rErr) throw rErr
    currentDetailFattura = f
    await ensureContiIva()
    await loadAziendaInfo()
    // FASE 19 — servono i giorni di pagamento del contatto per l'anteprima
    // della scadenza su una bozza. Cache condivisa: se e' gia' letta non costa
    // niente, e se fallisce la fattura si vede lo stesso.
    try { await loadContatti() } catch (_) { /* la scadenza ripiega sull'azienda */ }
    // Per la nota di credito: carica il riferimento alla fattura originale (per la stampa)
    var rifInfo = null
    if (f.tipo === 'nota_credito' && f.rif_fattura_id) {
      try {
        const { data: rif, error: rifErr } = await sb
          .from('tm_conta_fatture')
          .select('numero, data_emissione')
          .eq('id', f.rif_fattura_id)
          .eq('azienda_id', currentAziendaId)
          .single()
        if (!rifErr && rif) rifInfo = rif
      } catch (_) { /* riferimento non disponibile */ }
    }
    // FASE 22 — gli allegati PRIMA di comporre il foglio di stampa: la nota
    // sulla polizza («allegata a parte» oppure «nell'ultima pagina») dipende
    // da quello che c'e' allegato. Leggendoli dopo, la prima apertura di una
    // fattura con la polizza avrebbe stampato la nota sbagliata.
    try { await loadAllegati() } catch (_) { /* la fattura si vede lo stesso */ }
    // Righe e riferimento si tengono da parte: servono a rifare il foglio di
    // stampa quando si allega o si toglie la polizza, senza rileggere tutto.
    righeDetailCorrenti = righe || []
    rifInfoCorrente = rifInfo
    renderFatturaPrint(f, righe || [], rifInfo)
    renderDetailActions(f)
    // FASE 8 — pagamenti e rate. Solo sui documenti veri: su una bozza non
    // esiste ancora niente da pagare.
    try {
      await loadPagamenti(); await loadRate()
      html('fatture-pagamenti', f.stato === 'bozza' ? ''
        : boxPagamentiHtml('tm_conta_fatture', f.id, f.totale, 'entrata', f.cliente_nome))
    } catch (ePag) { html('fatture-pagamenti', '') }
    // Il riquadro della classificazione: c'e' solo sui documenti veri, non
    // sulle bozze, che non sono ancora niente da classificare.
    if (f.stato === 'bozza') html('fatture-classificazione', '')
    else await aggiornaBoxClassificazione('tm_conta_fatture', f.id, 'fatture-classificazione', f)
    await aggiornaBoxAllegati('tm_conta_fatture', f.id, 'fatture-allegati',
                              'Fattura ' + (f.numero || ''))
    // FASE 22 — la polizza QR della banca: il riquadro per caricarla e la
    // pagina in coda al foglio di stampa.
    await disegnaBoxPolizza(f.id)
    await preparaPolizzaPerStampa(f.id)
  } catch (e) {
    html('fatture-print', '<p style="color:var(--err)">Errore: ' + esc(e.message) + '</p>')
  }
}

// FASE 19 — i giorni di pagamento da applicare a una fattura, cercati
// nell'ordine in cui li cerca anche SQL_FASE18.sql: prima il contatto
// collegato, poi i termini dell'azienda, in ultimo 30. Le due precedenze
// devono restare identiche: se divergessero, il documento stampato e la
// scadenza salvata nel database direbbero due date diverse.
function giorniPagamentoFattura(f, a) {
  if (f && f.contatto_id) {
    var x = (contattiCache || []).filter(function (k) { return k.id === f.contatto_id })[0]
    var gContatto = x ? safeNum(x.giorni_pagamento) : null
    if (gContatto != null) return gContatto
  }
  var gAzienda = safeNum((a || {}).termini_pagamento_giorni)
  if (gAzienda != null) return gAzienda
  return 30
}

// FASE 20 — unisce dei pezzi di testo con un separatore, saltando quelli che
// non ci sono. Uno spazio vuoto non e' un valore: filter(Boolean) lo teneva, e
// il separatore restava stampato con niente dopo.
function unisciParti(parti, sep) {
  return (parti || [])
    .map(function (p) { return p == null ? '' : String(p).trim() })
    .filter(function (p) { return p !== '' })
    .join(sep)
}

// La forma giuridica da aggiungere al nome, oppure '' se il nome la contiene
// gia'. Il confronto ignora maiuscole, punti e spazi: «SAGL», «Sagl» e
// «S.a.g.l.» sono la stessa cosa.
function formaGiuridicaDaMostrare(nome, forma) {
  var f = String(forma == null ? '' : forma).trim()
  if (!f) return ''
  function nudo(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, '') }
  var n = nudo(nome), fn = nudo(f)
  if (!fn) return ''
  // «finisce con» e non «contiene»: una ditta che si chiamasse «Sagliani SA»
  // non deve perdere la sua forma giuridica per via delle lettere nel nome.
  if (n.length >= fn.length && n.slice(-fn.length) === fn) return ''
  return f
}

function renderFatturaPrint(f, righe, rifInfo) {
  var a = aziendaInfo || {}
  var v = esc(f.valuta || 'CHF')
  var isNC = f.tipo === 'nota_credito'
  var titolo = isNC ? 'NOTA DI CREDITO' : 'FATTURA'
  var ivaOn = isSoggettoIva()   // interruttore IVA: colonne/riepilogo/numero IVA solo se ON

  // Righe (colonne IVA solo se soggetto IVA)
  // FASE 21 — la numerazione si calcola QUI, alla stampa, e non si salva:
  // togliendo una riga in mezzo i numeri si rifanno da soli.
  var posizioni = posizioniRighe(righe)
  // Quante colonne stanno a destra della descrizione: servono per il colspan
  // della riga-titolo, che occupa tutto il resto della larghezza.
  var colonneDopoDesc = 4 + (ivaOn ? 2 : 0)   // Un., Q.tà, Prezzo, [IVA], Importo, [IVA]
  var righeHtml = ''
  for (var i = 0; i < righe.length; i++) {
    var r = righe[i]
    if (r.tipo_riga === 'titolo') {
      righeHtml +=
        '<tr class="inv-riga-titolo">' +
          '<td class="inv-pos">' + esc(posizioni[i]) + '</td>' +
          '<td class="inv-desc" colspan="' + colonneDopoDesc + '">' +
            esc(r.descrizione || '') + '</td>' +
        '</tr>'
      continue
    }
    righeHtml +=
      '<tr>' +
        '<td class="inv-pos">' + esc(posizioni[i]) + '</td>' +
        '<td class="inv-desc">' + esc(r.descrizione || '') + '</td>' +
        // FASE 21 — l'unita' resta VUOTA sulle righe che non ce l'hanno: un
        // trattino o un «pz» messo d'ufficio sarebbe un dato inventato.
        '<td class="inv-un">' + esc(r.unita || '') + '</td>' +
        '<td class="num">' + fmtNum2(safeNum(r.quantita)) + '</td>' +
        '<td class="num">' + fmtNum2(safeNum(r.prezzo_unitario)) + '</td>' +
        (ivaOn ? '<td>' + esc(ivaLabel(r.codice_iva_id)) + '</td>' : '') +
        '<td class="num">' + fmtNum2(safeNum(r.imponibile_riga)) + '</td>' +
        (ivaOn ? '<td class="num">' + fmtNum2(safeNum(r.iva_riga)) + '</td>' : '') +
      '</tr>'
  }
  var righeHead =
    '<th class="inv-pos">Pos</th><th>Descrizione</th><th class="inv-un">Un.</th>' +
    '<th class="num">Q.tà</th><th class="num">Prezzo</th>' +
    (ivaOn ? '<th>IVA</th>' : '') +
    '<th class="num">' + (ivaOn ? 'Imponibile' : 'Importo') + '</th>' +
    (ivaOn ? '<th class="num">IVA</th>' : '')

  // Riepilogo IVA per aliquota — SOLO se soggetto IVA
  var ivaSumHtml = ''
  if (ivaOn) {
    var perAliq = {}
    for (var j = 0; j < righe.length; j++) {
      var rj = righe[j]
      var alq = ivaAliquotaById(rj.codice_iva_id)
      if (alq == null) alq = 0
      var key = String(alq)
      if (!perAliq[key]) perAliq[key] = { alq: alq, imp: 0, iva: 0 }
      perAliq[key].imp += safeNum(rj.imponibile_riga) || 0
      perAliq[key].iva += safeNum(rj.iva_riga) || 0
    }
    var aliqKeys = Object.keys(perAliq).sort(function (x, y) { return perAliq[y].alq - perAliq[x].alq })
    var ivaSumRows = ''
    for (var k = 0; k < aliqKeys.length; k++) {
      var g = perAliq[aliqKeys[k]]
      ivaSumRows +=
        '<tr>' +
          '<td>IVA ' + (g.alq === 0 ? '0' : fmtNum2(g.alq)) + '%</td>' +
          '<td>' + fmtNum2(round2(g.imp)) + ' ' + v + '</td>' +
          '<td>' + fmtNum2(round2(g.iva)) + ' ' + v + '</td>' +
        '</tr>'
    }
    if (ivaSumRows) {
      ivaSumHtml = '<div class="inv-ivasum"><table><thead><tr><th>Riepilogo IVA</th><th>Imponibile</th><th>Importo IVA</th></tr></thead><tbody>' + ivaSumRows + '</tbody></table></div>'
    }
  }

  // Totali: con IVA → imponibile/IVA/totale; senza IVA → solo totale documento
  var totHtml = '<div class="inv-tot">' +
    (ivaOn
      ? '<div><span>Totale imponibile</span><span>' + fmtNum2(safeNum(f.totale_imponibile)) + ' ' + v + '</span></div>' +
        '<div><span>Totale IVA</span><span>' + fmtNum2(safeNum(f.totale_iva)) + ' ' + v + '</span></div>'
      : '') +
    '<div class="inv-grand"><span>Totale documento</span><span>' + fmtNum2(safeNum(f.totale)) + ' ' + v + '</span></div>' +
    '</div>'

  // Logo: logo_url se presente, altrimenti img/logo.png; onerror → fallback → nascondi
  // FASE 22 — una sorgente sola, condivisa con la busta (era scritta due volte).
  var logoSrc = logoAziendaSrc()

  // Intestazione azienda (nome = ragione sociale; indirizzo, NPA città, tel, email)
  var azNome = a.nome || aziendaNome()
  // FASE 20 — la forma giuridica si stampa solo se NON e' gia' dentro il nome.
  // Con la ragione sociale scritta per intero («… Sagl») e il campo forma
  // giuridica compilato («Sagl»), sul documento usciva due volte: sulla carta
  // che va al cliente sembra un errore di stampa.
  var formaExtra = formaGiuridicaDaMostrare(azNome, a.forma_giuridica)
  var addrLines = []
  if (a.indirizzo) addrLines.push(a.indirizzo)
  // FASE 20 — i separatori si mettono solo FRA due valori che esistono
  // davvero: unisciParti scarta anche i campi che contengono solo spazi, che
  // filter(Boolean) invece teneva. Era il «·» sospeso dopo il telefono.
  var cittaRiga = unisciParti([a.cap, a.citta], ' ')
  if (cittaRiga) addrLines.push(cittaRiga)
  var contattiLine = unisciParti([(a.telefono ? 'Tel. ' + a.telefono : null), a.email], ' · ')
  if (contattiLine) addrLines.push(contattiLine)
  if (ivaOn && a.numero_iva) addrLines.push('IVA ' + a.numero_iva)
  var addrText = addrLines.join('\n')

  // FASE 19 — Scadenza (solo fattura). La data SALVATA e' l'unica verita': se
  // c'e', si stampa quella e non si ricalcola niente. Il calcolo resta solo per
  // l'anteprima di una bozza non ancora emessa, e usa la stessa precedenza di
  // SQL_FASE18.sql. Prima questa riga leggeva solo i termini dell'azienda: con
  // la scadenza calcolata sui giorni del cliente, il documento in mano al
  // cliente e lo scadenzario avrebbero detto due date diverse.
  var giorni = giorniPagamentoFattura(f, a)
  var scadenza = null
  if (!isNC) {
    scadenza = f.data_scadenza || addDays(f.data_emissione, giorni)
    // Il «termine di pagamento» scritto sotto deve concordare con la data qui
    // sopra: su una scadenza salvata si ricava da quella, non dalla catena.
    if (f.data_scadenza) {
      var gSalvati = diffGiorni(f.data_scadenza, f.data_emissione)
      if (gSalvati != null) giorni = gSalvati
    }
  }

  // Meta a destra: numero, data, scadenza (fattura) / riferimento (NC), stato
  var metaRows =
    '<tr><td>N.</td><td class="inv-num-cell">' + esc(f.numero || 'bozza') + '</td></tr>' +
    '<tr><td>Data</td><td>' + esc(fmtDate(f.data_emissione)) + '</td></tr>' +
    (scadenza ? '<tr><td>Scadenza</td><td>' + esc(fmtDate(scadenza)) + '</td></tr>' : '') +
    (isNC ? '<tr><td>Rif.</td><td>Fatt. ' + esc((rifInfo && rifInfo.numero) ? rifInfo.numero : '—') +
            ((rifInfo && rifInfo.data_emissione) ? ' del ' + esc(fmtDate(rifInfo.data_emissione)) : '') + '</td></tr>' : '') +
    '<tr><td>Stato</td><td>' + esc(f.stato) + '</td></tr>'

  // Blocco pagamento (fattura) OPPURE riferimento alla fattura stornata (nota di credito)
  var payHtml
  if (isNC) {
    var rifNum = (rifInfo && rifInfo.numero) ? rifInfo.numero : '—'
    var rifData = (rifInfo && rifInfo.data_emissione) ? fmtDate(rifInfo.data_emissione) : '—'
    payHtml =
      '<div class="inv-pay">' +
        '<div class="inv-pay-row"><span class="inv-pay-lbl">Documento di riferimento</span><span>Fattura ' + esc(rifNum) + ' del ' + esc(rifData) + '</span></div>' +
        '<div class="inv-pay-row"><span class="inv-pay-lbl">Natura</span><span>Storno a credito del cliente</span></div>' +
      '</div>'
  } else {
    // IBAN della fattura (snapshot); se vuoto → IBAN aziendale predefinito
    var ibanShown = (f.iban && String(f.iban).trim()) ? f.iban : a.iban
    payHtml =
      '<div class="inv-pay">' +
        (ibanShown ? '<div class="inv-pay-row"><span class="inv-pay-lbl">IBAN</span><span>' + esc(ibanShown) + '</span></div>' : '') +
        '<div class="inv-pay-row"><span class="inv-pay-lbl">Termine di pagamento</span><span>' + giorni + ' giorni</span></div>' +
        (scadenza ? '<div class="inv-pay-row"><span class="inv-pay-lbl">Scadenza</span><span class="inv-scad">' + esc(fmtDate(scadenza)) + '</span></div>' : '') +
        // FASE 22 — la nota vale solo finche' la polizza va spedita a parte.
        // Quando e' allegata alla fattura, dire il contrario sul documento
        // stesso sarebbe una bugia stampata.
        (polizzaDi(f.id)
          ? '<div class="inv-qrnote">Polizza QR nell’ultima pagina di questo documento.</div>'
          : '<div class="inv-qrnote">Polizza QR allegata a parte.</div>') +
      '</div>'
  }

  // Piè di pagina centrato
  var footerParts = [esc(azNome)]
  if (unisciParti([a.uid], '')) footerParts.push('UID ' + esc(String(a.uid).trim()))
  if (unisciParti([a.sito_web], '')) footerParts.push(esc(String(a.sito_web).trim()))
  var footerHtml =
    '<div class="inv-footer">' +
      '<strong>' + footerParts.join(' · ') + '</strong><br>' +
      'Iscritta al Registro di Commercio del Cantone Ticino' +
    '</div>'

  html('fatture-print',
    '<div class="inv">' +
      '<div class="inv-head">' +
        '<div class="inv-brand">' +
          '<img src="' + esc(logoSrc) + '" alt="Logo azienda" class="inv-logo" onerror="logoOnError(this)">' +
          '<div class="inv-brand-info">' +
            '<div class="inv-azienda-nome">' + esc(azNome) +
              (formaExtra ? ' <span class="inv-forma">' + esc(formaExtra) + '</span>' : '') +
            '</div>' +
            '<div class="inv-azienda-addr">' + esc(addrText) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="inv-meta">' +
          '<div class="inv-title">' + titolo + '</div>' +
          '<table class="inv-meta-tbl">' + metaRows + '</table>' +
        '</div>' +
      '</div>' +
      '<div class="inv-cliente">' +
        '<div class="inv-cliente-lbl">Fatturare a</div>' +
        '<div class="inv-cliente-nome">' + esc(f.cliente_nome || '') + '</div>' +
        (f.cliente_indirizzo ? '<div class="inv-cli-addr">' + esc(f.cliente_indirizzo) + '</div>' : '') +
        (f.cliente_paese ? '<div>' + esc(f.cliente_paese) + '</div>' : '') +
        (f.cliente_iva ? '<div>IVA: ' + esc(f.cliente_iva) + '</div>' : '') +
      '</div>' +
      '<table class="inv-table"><thead><tr>' + righeHead + '</tr></thead><tbody>' + righeHtml + '</tbody></table>' +
      ivaSumHtml +
      totHtml +
      payHtml +
      (!ivaOn ? '<div class="inv-note">Non soggetto IVA.</div>' : '') +
      (f.note ? '<div class="inv-note">' + esc(f.note) + '</div>' : '') +
      footerHtml +
      // FASE 22 — il posto della polizza QR. Resta VUOTO finche'
      // preparaPolizzaPerStampa() non ha caricato davvero l'immagine: un <img>
      // ancora vuoto stamperebbe una pagina bianca in coda alla fattura, e non
      // se ne accorgerebbe nessuno prima di aver spedito.
      '<div id="fatture-qrpage"></div>' +
    '</div>'
  )
}

function renderDetailActions(f) {
  var a = '<div class="form-actions" style="margin-top:0">'
  a += '<button class="btn-primary" onclick="printFattura()">🖨 Stampa</button>'
  // Stesso CSS di stampa, stesso risultato: cambia solo il nome del file proposto.
  a += '<button class="btn-secondary" onclick="scaricaFatturaPDF()">📄 Scarica PDF</button>'
  // FASE 21 — la busta col destinatario gia' pronto.
  a += '<button class="btn-secondary" onclick="apriBustaDaFattura(\'' + esc(f.id) + '\')">✉️ Stampa busta</button>'
  // FASE 7 — il PDF si allega dopo averlo generato: da li' entra nel pacchetto
  // per il commercialista. Il testo cambia se ce n'e' gia' uno.
  if (f.stato !== 'bozza') {
    // Una via sola per allegare, la finestra. Il tipo arriva gia' su «Fattura»,
    // che e' quello che si allega da qui.
    a += '<button class="btn-secondary" onclick="apriAggiungiAllegato(\'tm_conta_fatture\', \'' +
      esc(f.id) + '\', \'Fattura ' + esc(String(f.numero || '').replace(/'/g, '')) +
      '\', \'fattura\')">' +
      (contaAllegati('tm_conta_fatture', f.id)
        ? '📎 Aggiungi un allegato' : '📎 Allega il PDF della fattura') + '</button>'
  }
  if (f.stato === 'bozza') {
    a += '<button class="btn-secondary" onclick="editFattura(\'' + f.id + '\')">✏️ Modifica bozza</button>'
    a += '<button class="btn-primary" onclick="emettiFatturaById(\'' + f.id + '\')">📨 Emetti</button>'
    // Elimina SOLO sulle bozze (numero non ancora assegnato). Mai sulle emesse.
    a += '<button class="btn-secondary" onclick="deleteBozza(\'' + f.id + '\')">🗑️ Elimina</button>'
  } else if (f.stato === 'emessa') {
    // Emessa → NON modificabile: si corregge con una nota di credito
    a += '<span class="lock-tag" title="Documento definitivo">🔒 Emessa — sola lettura</span>'
    // Il bottone dipende dall'INCASSO, non piu' dallo stato del documento:
    // una fattura incassata resta emessa, non diventa un'altra cosa.
    // FASE 8 — niente piu' «Segna incassata / non incassata»: un clic solo che
    // cancella tre versamenti registrati e' troppo facile da premere per sbaglio.
    // Al suo posto si registra un pagamento, e i pagamenti si tolgono uno per
    // uno dall'elenco, con una conferma che dice importo e data.
    a += '<button class="btn-primary" onclick="apriRegistraPagamento(\'tm_conta_fatture\', \'' +
         f.id + '\', ' + (safeNum(f.totale) || 0) + ', \'entrata\', \'' +
         esc(String(f.cliente_nome || '').replace(/'/g, '')) + '\')">➕ Registra incasso</button>'
    if (f.tipo !== 'nota_credito') a += '<button class="btn-secondary" onclick="creaNotaCredito(\'' + f.id + '\')">↩️ Crea nota di credito</button>'
  } else if (f.stato === 'annullata') {
    // Ramo che prima non esisteva: lo stato annullata era gia ammesso dal
    // database ma nell'interfaccia la scheda restava senza indicazioni.
    a += '<span class="lock-tag" title="Documento annullato">🚫 Annullata — sola lettura</span>'
  }
  a += '<button class="btn-secondary" onclick="fattureBackToList()">← Indietro</button>'
  a += '</div>'
  html('fatture-detail-actions', a)
}

// FASE 22 — prima di stampare ci si assicura che la polizza sia davvero
// caricata. Se non lo e', si stampa lo stesso: la fattura senza polizza e'
// un documento valido, una fattura non stampata no.
async function printFattura() {
  try {
    if (currentDetailFattura && polizzaDi(currentDetailFattura.id)) {
      await preparaPolizzaPerStampa(currentDetailFattura.id)
    }
  } catch (e) { console.warn('Polizza in stampa:', e.message || e) }
  window.print()
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 10 — CONFERMA EMISSIONE (riepilogo prima di rendere definitiva la vendita)
// ══════════════════════════════════════════════════════════════════════════════
function emitSummaryRows(rows) {
  return rows.map(function (r) {
    return '<div class="emit-row"><span class="emit-lbl">' + esc(r[0]) + '</span>' +
      '<span class="emit-val' + (r[2] ? ' big' : '') + '">' + esc(r[1]) + '</span></div>'
  }).join('')
}
function openEmitConfirm(summaryHtml, fn) {
  pendingEmitFn = fn
  var s = el('emit-confirm-summary'); if (s) s.innerHTML = summaryHtml
  var o = el('emit-confirm-overlay'); if (o) o.style.display = 'flex'
  registraAperturaModale('emit-confirm-overlay')
}
function closeEmitConfirm() {
  pendingEmitFn = null
  var o = el('emit-confirm-overlay'); if (o) o.style.display = 'none'
}
function confirmEmitNow() {
  var fn = pendingEmitFn
  closeEmitConfirm()
  if (typeof fn === 'function') fn()
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 10 — FATTURE D'ACQUISTO (registrazione manuale di documenti ricevuti)
// Numero del fornitore (libero), modificabili ed eliminabili. Entrano nel
// Registratore come origine_tipo='acquisto' (lato costo).
// ══════════════════════════════════════════════════════════════════════════════
function showAcquistiView(which) {
  registraVista('acquisti', which)
  var views = ['list', 'detail', 'edit']
  for (var i = 0; i < views.length; i++) {
    var v = el('acquisti-' + views[i] + '-view')
    if (v) v.style.display = (views[i] === which) ? 'block' : 'none'
  }
}

// ── Vista di SOLA LETTURA della fattura d'acquisto ───────────────────────────
async function viewAcquisto(id) {
  if (!currentAziendaId) return
  showAcquistiView('detail')
  html('acquisti-detail-banner', '')
  html('acquisti-detail-actions', '')
  html('acquisti-detail-body', loadingRow('Caricamento…'))
  try {
    const { data, error } = await sb.from('tm_conta_fatture_acquisto').select('*').eq('id', id).eq('azienda_id', currentAziendaId).single()
    if (error) throw error
    await ensureContiIva()
    renderAcquistoDetail(data)
  } catch (e) {
    html('acquisti-detail-body', '<p style="color:var(--err)">Errore: ' + esc(e.message || e) + '</p>')
  }
}

function renderAcquistoDetail(a) {
  function riga(lbl, val, mono) {
    if (val === null || val === undefined || val === '') return ''
    return '<div class="ro-lbl">' + esc(lbl) + '</div><div class="ro-val' + (mono ? ' mono' : '') + '">' + val + '</div>'
  }
  var impo = safeNum(a.imponibile), ivaI = safeNum(a.iva_importo)
  var pagato = a.stato_pagamento === 'pagato'

  var body = '<div class="ro-grid">' +
    '<div class="ro-section">Documento</div>' +
    riga('Fornitore', esc(a.fornitore || '')) +
    riga('Numero fornitore', esc(a.numero_fornitore || '—')) +
    riga('Data', esc(fmtDate(a.data))) +
    riga('Scadenza', a.scadenza ? esc(fmtDate(a.scadenza)) : '') +
    '<div class="ro-sep"></div>' +
    '<div class="ro-section">Importi</div>' +
    riga('Totale', fmtImporto(a.importo, a.valuta), true) +
    riga('Codice IVA', a.codice_iva_id ? esc(ivaLabel(a.codice_iva_id)) : '—') +
    riga('Imponibile', impo != null ? fmtNum2(impo) + ' ' + esc(a.valuta || 'CHF') : '', true) +
    riga('IVA', ivaI != null ? fmtNum2(ivaI) + ' ' + esc(a.valuta || 'CHF') : '', true) +
    (isSoggettoIva() ? '' : '<div class="ro-lbl"></div><div class="ro-val" style="font-weight:400;color:var(--text3)">ℹ️ IVA non recuperabile (non soggetto IVA)</div>') +
    '<div class="ro-sep"></div>' +
    '<div class="ro-section">Pagamento</div>' +
    riga('Stato', statoAcquistoBadge(a.stato_pagamento)) +
    // Data pagamento resta: la scrive il trigger dai pagamenti, e' il dato vero.
    (pagato || a.data_pagamento ? riga('Data pagamento', a.data_pagamento ? esc(fmtDate(a.data_pagamento)) : '—') : '') +
    // Metodo e Riferimento NON stanno piu' qui: dalla FASE 8 ogni versamento ha
    // il suo, nel riquadro Pagamenti. Mostrarne uno solo accanto allo stato
    // dava due risposte alla stessa domanda nella stessa schermata. Le colonne
    // vecchie restano leggibili in fondo, dichiarate per quello che sono.
    (a.note ? '<div class="ro-sep"></div><div class="ro-section">Note</div><div class="ro-lbl"></div><div class="ro-val" style="font-weight:400;white-space:pre-line">' + esc(a.note) + '</div>' : '') +
    '</div>'

  // I valori delle colonne storiche, se ci sono: non si nascondono, si
  // separano e si datano. Su una fattura nuova questo blocco non compare.
  if (a.metodo_pagamento || a.riferimento_pagamento) {
    body += '<div class="ro-grid" style="margin-top:16px">' +
      '<div class="ro-section">Dati storici (prima di agosto 2026)</div>' +
      riga('Metodo', esc(a.metodo_pagamento || '—')) +
      riga('Riferimento', esc(a.riferimento_pagamento || '—')) +
      '<div class="ro-lbl"></div><div class="ro-val" style="font-weight:400;color:var(--text3)">' +
        'ℹ️ Scritti prima che i pagamenti avessero una riga ciascuno. ' +
        'I metodi in uso stanno nel riquadro Pagamenti.' +
      '</div>' +
    '</div>'
  }

  // Gli allegati NON stanno piu' qui: hanno il loro riquadro sotto, che li
  // mostra tutti invece del primo.
  html('acquisti-detail-body', body)
  // FASE 8 — pagamenti e rate sotto il dettaglio dell'acquisto.
  loadPagamenti().then(function () { return loadRate() }).then(function () {
    html('acquisti-pagamenti',
      boxPagamentiHtml('tm_conta_fatture_acquisto', a.id, a.importo, 'uscita', a.fornitore))
  }).catch(function () { html('acquisti-pagamenti', '') })
  // Separata dai pagamenti: se la lettura dei pagamenti fallisce, la
  // classificazione non c'entra e non deve sparire con loro.
  aggiornaBoxClassificazione('tm_conta_fatture_acquisto', a.id, 'acquisti-classificazione', a)
  // Gli allegati: riquadro suo, separato anche questo. Se la classificazione
  // non si legge, gli allegati non c'entrano e devono comparire lo stesso.
  aggiornaBoxAllegati('tm_conta_fatture_acquisto', a.id, 'acquisti-allegati',
                      'Fattura ' + (a.numero_fornitore || '') + ' ' + (a.fornitore || ''))

  // FASE 10B.4 — chi sta guardando la scheda puo' confermare da li': e' il
  // momento in cui ha davanti data e importo.
  if (daConfermare(a)) {
    html('acquisti-detail-conferma',
      '<div class="card avviso-conferma">' +
        '<div class="card-title">⏳ Da confermare</div>' +
        '<div>Questa fattura è stata letta automaticamente e <strong>non entra ancora</strong> ' +
          'nei totali, nelle scadenze e nell\'export.</div>' +
        '<div class="form-hint" style="margin-top:8px">' +
          'L\'AI sbaglia le date e legge male gli importi sulle foto storte. Controlla prima di confermare.' +
        '</div>' +
        '<div class="form-actions" style="margin-top:12px">' +
          '<button type="button" class="btn-primary" onclick="confermaAcquisto(\'' + esc(a.id) + '\')">' +
            '✅ Conferma la fattura</button>' +
        '</div>' +
      '</div>')
  } else {
    html('acquisti-detail-conferma', '')
  }

  // Azioni: Modifica sempre consentita sugli acquisti
  html('acquisti-detail-actions',
    '<div class="form-actions" style="margin-top:0">' +
      '<button class="btn-primary" onclick="editAcquisto(\'' + a.id + '\')">✏️ Modifica</button>' +
      // FASE 8 — vedi la nota sulle fatture di vendita: si registra un pagamento,
      // non si «segna pagato» in un colpo solo.
      '<button class="btn-primary" onclick="apriRegistraPagamento(\'tm_conta_fatture_acquisto\', \'' +
        a.id + '\', ' + (safeNum(a.importo) || 0) + ', \'uscita\', \'' +
        esc(String(a.fornitore || '').replace(/'/g, '')) + '\')">➕ Registra pagamento</button>' +
      '<button class="btn-secondary" onclick="deleteAcquisto(\'' + a.id + '\')">🗑️ Elimina</button>' +
      '<button class="btn-secondary" onclick="acquistiBackToList()">← Indietro</button>' +
    '</div>')
}
function acquistiBackToList() { showAcquistiView('list') }

async function initAcquistiPage() {
  acquistiBackToList()
  await loadAcquistiList()
}

async function loadAcquistiList() {
  // Gli allegati servono a disegnare «📎 3» su ogni riga: si leggono prima,
  // una volta sola, non una query per riga.
  try { await loadAllegati() } catch (_) {}
  // Le chiavi dei doppioni: una query sua, tre colonne, cosi' la spia non
  // dipende da quali righe l'elenco ha caricato.
  try { await caricaChiaviDoppioni(true) } catch (_) {}
  try { await refreshDaConfermareCount() } catch (_) {}
  if (!currentAziendaId) { html('acquisti-table', '<div class="dim">Accedi per vedere le fatture d\'acquisto.</div>'); return }
  html('acquisti-table', loadingRow('Caricamento…'))
  try {
    const { data, error } = await sb
      .from('tm_conta_fatture_acquisto')
      .select('id, fornitore, numero_fornitore, data, importo, valuta, scadenza, stato_pagamento, note, created_at, codice_iva_id, imponibile, iva_importo, data_pagamento, gruppo_codice, contatto_id, origine, stato_conferma')
      .eq('azienda_id', currentAziendaId)
      .order('data', { ascending: false })
    if (error) throw error
    acquistiList = data || []
    // FASE 6A — il cantiere di ogni fattura sta nelle classificazioni: servono
    // la mappa e i nomi dei cantieri prima di disegnare la tabella.
    try { await loadCantieri(); await loadMappaCantieri(true) } catch (_) { /* la tabella si mostra lo stesso */ }
    riempiFiltroCantieriAcquisti()
    renderAcquistiTable()
  } catch (e) {
    html('acquisti-table', '<p style="color:var(--err)">Errore: ' + esc(e.message) + '</p>')
  }
}

function statoAcquistoBadge(stato) {
  // Etichetta e icona dall'helper unico: una fattura d'acquisto e' sempre
  // denaro in uscita, quindi «Da pagare» / «Pagato».
  return badgePagamento('uscita', stato)
}

function acquistiRowActions(a) {
  var pagato = a.stato_pagamento === 'pagato'
  return (daConfermare(a)
      ? '<button class="icon-btn conferma" onclick="event.stopPropagation(); confermaAcquisto(\'' +
        esc(a.id) + '\')" title="Controlla data e importo, poi conferma">✅ Conferma</button>'
      : '') +
    badgeAllegati('tm_conta_fatture_acquisto', a.id, 'acquisti-list-banner') +
    spiaDoppione(a) +
    '<button class="icon-btn classify" onclick="event.stopPropagation(); editAcquisto(\'' + a.id + '\')">✏️ Modifica</button>' +
    (pagato
      // FASE 8 — l'icona apre la modale del pagamento invece di segnare
      // pagato in un colpo: l'importo va scelto, puo' essere un acconto.
      ? ''
      : '<button class="icon-btn" title="Registra un pagamento" onclick="event.stopPropagation(); apriRegistraPagamento(\'tm_conta_fatture_acquisto\', \'' + a.id + '\', ' + (safeNum(a.importo) || 0) + ', \'uscita\', \'\')">💳</button>') +
    '<button class="icon-btn danger" title="Elimina" onclick="event.stopPropagation(); deleteAcquisto(\'' + a.id + '\')">🗑️</button>'
}

function clearAcquistiSearch() {
  var inp = el('acquisti-search'); if (inp) inp.value = ''
  renderAcquistiTable(); if (inp) inp.focus()
}

// FASE 6A — a quale cantiere e' assegnata questa fattura d'acquisto.
// Il dato sta nella classificazione, non sulla fattura: si legge dalla mappa
// caricata da loadMappaCantieri(). Se la mappa non c'e' ancora, si risponde
// «non so» invece di «nessuno»: sono due cose diverse.
function cantiereDiAcquisto(idAcquisto) {
  if (!classCantiereMap) return null
  return classCantiereMap['acquisto:' + idAcquisto] || null
}

// Una riga senza cantiere non resta vuota: «aziendale» in grigio dice che e'
// una spesa della ditta, non un dato mancante.
function etichettaCantiereRiga(cantiereId) {
  if (!cantiereId) return '<span class="dim">aziendale</span>'
  return esc(cantiereLabel(cantiereId))
}

// Riempie il filtro con i cantieri che compaiono davvero fra gli acquisti,
// piu' la voce per le spese aziendali.
function riempiFiltroCantieriAcquisti() {
  var sel = el('acquisti-filtro-cantiere')
  if (!sel) return
  var usati = {}, senza = false
  ;(acquistiList || []).forEach(function (a) {
    var c = cantiereDiAcquisto(a.id)
    if (c) usati[c] = true; else senza = true
  })
  var prec = sel.value
  var opts = '<option value="">Tutti</option>'
  cantieriOrdinati().forEach(function (c) {
    if (usati[c.id]) opts += '<option value="' + esc(c.id) + '">' + esc(nomeCantiere(c, true)) + '</option>'
  })
  if (senza) opts += '<option value="__nessuno__">— aziendale (nessun cantiere) —</option>'
  sel.innerHTML = opts
  if (prec) sel.value = prec
}

function renderAcquistiTable() {
  var stato = el('acquisti-filtro-stato') ? el('acquisti-filtro-stato').value : ''
  var anno  = el('acquisti-filtro-anno') ? el('acquisti-filtro-anno').value : ''
  var qv    = el('acquisti-search') ? el('acquisti-search').value.trim().toLowerCase() : ''
  var clearBtn = el('acquisti-search-clear'); if (clearBtn) clearBtn.style.display = qv ? 'flex' : 'none'

  // FASE 6A — filtro per cantiere. '__nessuno__' = le spese aziendali, che sono
  // una risposta valida e devono potersi cercare come le altre.
  var cantF = el('acquisti-filtro-cantiere') ? el('acquisti-filtro-cantiere').value : ''
  var list = acquistiList.filter(function (a) {
    if (stato && a.stato_pagamento !== stato) return false
    if (anno && (!a.data || String(a.data).slice(0, 4) !== String(anno))) return false
    if (cantF) {
      var ca = cantiereDiAcquisto(a.id)
      if (cantF === '__nessuno__') { if (ca) return false }
      else if (ca !== cantF) return false
    }
    return true
  })
  if (qv) {
    var termini = qv.split(/\s+/)
    list = list.filter(function (a) {
      var imp = safeNum(a.importo)
      var hay = ((a.fornitore || '') + ' ' + (a.numero_fornitore || '') + ' ' +
        (imp != null ? String(imp) + ' ' + imp.toFixed(2) : '')).toLowerCase()
      return termini.every(function (t) { return hay.indexOf(t) !== -1 })
    })
  }
  if (!list.length) {
    var attivo = qv || stato || anno
    html('acquisti-table', '<div class="dim" style="padding:10px 0">' +
      (attivo ? 'Nessuna fattura trovata. Prova a cambiare la ricerca o i filtri.' : 'Nessuna fattura d\'acquisto.') + '</div>')
    return
  }
  var rows = list.map(function (a) {
    // riga secondaria compatta: scomposizione IVA
    var impo = safeNum(a.imponibile), ivaI = safeNum(a.iva_importo)
    var ivaSub = (impo != null || ivaI != null)
      ? '<span class="cell-sub">imp. ' + fmtNum2(impo) + ' · IVA ' + fmtNum2(ivaI) + '</span>'
      : ''
    // Riga secondaria: la sola data del pagamento, che il trigger scrive dai
    // pagamenti veri. Il metodo NON si mostra piu' qui: dalla FASE 8 ogni
    // versamento ha il suo, e mostrarne uno solo accanto allo stato dava due
    // risposte alla stessa domanda. Sta nel riquadro Pagamenti della scheda.
    var paySub = (a.stato_pagamento === 'pagato' && a.data_pagamento)
      ? '<span class="cell-sub">il ' + esc(fmtDate(a.data_pagamento)) + '</span>'
      : ''
    return '<tr class="row-clickable' + (daConfermare(a) ? ' riga-da-confermare' : '') +
      '" onclick="viewAcquisto(\'' + a.id + '\')">' +
      '<td>' + esc(a.fornitore || '') + spiaDaConfermare(a) + '</td>' +
      '<td class="dim">' + esc(a.numero_fornitore || '—') + '</td>' +
      '<td class="dim">' + esc(fmtDate(a.data)) + '</td>' +
      '<td class="num">' + fmtImporto(a.importo, a.valuta) + ivaSub + '</td>' +
      '<td>' + statoAcquistoBadge(a.stato_pagamento) + paySub + '</td>' +
      '<td>' + etichettaCantiereRiga(cantiereDiAcquisto(a.id)) + '</td>' +
      '<td class="row-actions">' + acquistiRowActions(a) + '</td>' +
    '</tr>'
  }).join('')
  html('acquisti-table', '<div class="table-wrap"><table><thead><tr>' +
    '<th>Fornitore</th><th style="width:130px">Numero</th><th style="width:100px">Data</th>' +
    '<th style="width:130px;text-align:right">Importo</th><th style="width:120px">Stato</th>' +
    '<th style="width:150px">Cantiere</th><th style="width:170px">Azioni</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>')
}

// ── IVA sulle fatture d'acquisto (IVA inclusa nel totale) ────────────────────
// Stessa formula della Fase 3: imponibile = importo/(1+aliq/100); iva = importo − imponibile.
function acquistoAliquotaSelezionata() {
  var sel = el('a-codice-iva')
  if (!sel || !sel.value) return null           // nessun codice scelto
  var alq = ivaAliquotaById(sel.value)
  return alq == null ? 0 : alq
}

function recalcAcquistoIva() {
  acquistoIvaManuale = false
  var imp = safeNum(getVal('a-importo'))
  var alq = acquistoAliquotaSelezionata()
  if (imp == null || alq == null) {
    // niente totale o nessun codice IVA → campi vuoti (si salva solo il totale)
    setVal('a-imponibile', '')
    setVal('a-iva', '')
  } else {
    var c = calcolaIva(imp, alq, true)          // true = IVA inclusa nel totale
    setVal('a-imponibile', c.imponibile == null ? '' : c.imponibile)
    setVal('a-iva', c.iva == null ? '' : c.iva)
  }
  updateAcquistoIvaSummary()
}

function onAcquistoIvaCodeChange() { recalcAcquistoIva() }

function onAcquistoImportoChange() {
  if (!acquistoIvaManuale) recalcAcquistoIva()
  else updateAcquistoIvaSummary()
}

function onAcquistoIvaManual() {
  acquistoIvaManuale = true                     // l'utente comanda: teniamo i suoi valori
  updateAcquistoIvaSummary()
}

function updateAcquistoIvaSummary() {
  var box = el('a-iva-summary')
  if (!box) return
  var imp  = safeNum(getVal('a-importo'))
  var impo = safeNum(getVal('a-imponibile'))
  var iva  = safeNum(getVal('a-iva'))
  var alq  = acquistoAliquotaSelezionata()
  var valuta = getVal('a-valuta') || 'CHF'
  var nota = isSoggettoIva() ? '' :
    '<span class="iva-nota">ℹ️ IVA non recuperabile (non soggetto IVA) — il dato resta per archivio.</span>'

  if (imp == null) { box.innerHTML = 'Inserisci il totale per vedere la scomposizione IVA.' + nota; return }
  if (impo == null && iva == null) {
    box.innerHTML = 'Totale <strong>' + fmtNum2(imp) + ' ' + esc(valuta) + '</strong> — nessun codice IVA scelto: si salva solo il totale.' + nota
    return
  }
  var somma = round2((impo || 0) + (iva || 0))
  var diff = Math.abs(round2(somma - imp)) > 0.005
  box.innerHTML =
    'Totale <strong>' + fmtNum2(imp) + ' ' + esc(valuta) + '</strong> = imponibile <strong>' + fmtNum2(impo) +
    '</strong> + IVA <strong>' + fmtNum2(iva) + '</strong>' +
    (alq != null ? ' (aliquota ' + (alq === 0 ? '0' : fmtNum2(alq)) + '%)' : '') +
    (acquistoIvaManuale ? ' · <em>valori inseriti a mano</em>' : '') +
    (diff ? ' <span style="color:var(--warn)">⚠️ imponibile + IVA = ' + fmtNum2(somma) + ', diverso dal totale</span>' : '') +
    nota
}

// ── Stato del pagamento ──────────────────────────────────────────────────────
// I campi «data, metodo, riferimento» non stanno piu' nel form: dalla FASE 8
// ogni pagamento e' una riga di tm_conta_pagamenti, con la sua data e il suo
// metodo. Qui resta solo lo stato, che e' in sola lettura perche' lo calcola
// il trigger dai pagamenti registrati.
function onAcquistoStatoChange() {
  /* niente da abilitare: il riquadro dei dati di pagamento non c'e' piu' */
}

// ── «Gia' pagata per intero» ───────────────────────────────────────────────
// La scorciatoia era stata tolta nella FASE 8b perche' creava il pagamento con
// la data del documento e nessun modo di cambiarla. Torna con quel difetto
// risolto: data e metodo si scelgono qui. Resta una sola strada di scrittura —
// si crea una riga in tm_conta_pagamenti, esattamente come farebbe
// «+ Registra pagamento», e lo stato lo ricalcola il trigger.
function onAcquistoGiaPagata() {
  var spunta = el('a-gia-pagata')
  var campi = el('a-gia-pagata-campi')
  var acceso = !!(spunta && spunta.checked)
  if (campi) campi.style.display = acceso ? 'flex' : 'none'
  // La data si propone dalla fattura, ma resta modificabile: pagare il giorno
  // stesso e' il caso comune, non una regola.
  if (acceso && !getVal('a-pag-data')) setVal('a-pag-data', getVal('a-data') || oggiISO())
}

// Decide se mostrare la spunta o dire che i pagamenti ci sono gia'.
async function aggiornaGiaPagata(idAcquisto, importoDoc) {
  var box = el('a-gia-pagata-box')
  var avviso = el('a-pagamenti-esistenti')
  if (!box || !avviso) return

  function soloSpunta() {
    box.style.display = ''
    avviso.style.display = 'none'
    avviso.innerHTML = ''
  }

  if (!idAcquisto) { soloSpunta(); return }   // documento nuovo: non ha pagamenti

  try {
    await loadPagamenti(true)
    var gia = totalePagatoDi('tm_conta_fatture_acquisto', idAcquisto)
    if (!(gia > 0.005)) { soloSpunta(); return }

    // Con dei pagamenti gia' registrati la spunta non ha piu' senso: aggiungerne
    // un altro «per intero» porterebbe il totale oltre l'importo della fattura.
    box.style.display = 'none'
    var spunta = el('a-gia-pagata')
    if (spunta) spunta.checked = false
    var campi = el('a-gia-pagata-campi')
    if (campi) campi.style.display = 'none'
    avviso.style.display = ''
    avviso.innerHTML = '💳 Pagato <strong>' + esc(fmtNumIt(gia)) + '</strong> di <strong>' +
      esc(fmtNumIt(safeNum(importoDoc) || 0)) + '</strong> — gestisci i pagamenti dalla scheda.'
  } catch (e) {
    // Se i pagamenti non si leggono si mostra la spunta: il salvataggio la
    // ricontrolla comunque prima di creare qualcosa.
    console.warn('Pagamenti non letti:', e.message || e)
    soloSpunta()
  }
}

function fillAcquistoForm(v) {
  v = v || {}
  setVal('a-fornitore', v.fornitore)
  setVal('a-numero',    v.numero_fornitore)
  setVal('a-data',      v.data)
  setVal('a-importo',   v.importo == null ? '' : v.importo)
  setVal('a-valuta',    v.valuta || 'CHF')
  setVal('a-scadenza',  v.scadenza || '')
  // FASE 8 — sola lettura: il valore arriva dal documento, che a sua volta lo
  // ha ricevuto dal trigger. Qui non si sceglie piu' niente.
  setVal('a-stato',     v.stato_pagamento || 'aperto')
  // La spunta «già pagata per intero» riparte sempre spenta: e' un'azione, non
  // un dato del documento, e ripresentarla accesa in modifica farebbe creare un
  // secondo pagamento a chi salva senza guardare.
  var spunta = el('a-gia-pagata')
  if (spunta) spunta.checked = false
  setVal('a-pag-data', '')
  setVal('a-pag-metodo', '')
  onAcquistoGiaPagata()
  // FASE 2: gruppo e contatto collegato
  if (el('a-contatto-id')) el('a-contatto-id').value = v.contatto_id || ''
  riempiSelectGruppi('a-gruppo', v.gruppo_codice || '')
  aggiornaLegatoDaId('a', v.contatto_id)
  setVal('a-note',      v.note || '')
  // IVA: il menu va costruito prima di impostare il valore
  var ivaSel = el('a-codice-iva')
  if (ivaSel) ivaSel.innerHTML = buildIvaOptions(v.codice_iva_id || null)
  setVal('a-imponibile', v.imponibile == null ? '' : v.imponibile)
  setVal('a-iva',        v.iva_importo == null ? '' : v.iva_importo)
  // valori già presenti = inseriti/confermati in precedenza: non sovrascriverli
  acquistoIvaManuale = (v.imponibile != null || v.iva_importo != null)
  // I dati del pagamento non si compilano piu' da qui: vedi il rimando
   // «a-pagamento-rimando» nel form e la scheda del documento.
  // NB: l'input file NON si azzera qui. fillAcquistoForm può girare DOPO await di
  // rete, quando il form è già visibile: azzerarlo cancellerebbe il file scelto
  // dall'utente e l'upload verrebbe saltato in silenzio. Si azzera esplicitamente
  // con clearAcquistoFileInput(), prima di mostrare il form o su "Annulla".
  onAcquistoStatoChange()
  updateAcquistoIvaSummary()
  renderAcquistoAllegatoCorrente()   // solo un div: non tocca l'input file
}

function clearAcquistoFileInput() {
  var f = el('a-allegato')
  if (f) f.value = ''
}

// Mostra l'allegato già presente: nome + apri + rimuovi. L'input file funge da
// "sostituisci" (caricando un nuovo file si rimpiazza il vecchio al salvataggio).
function renderAcquistoAllegatoCorrente() {
  // FASE 9 — il riquadro «allegato corrente» non c'e' piu': gli allegati si
  // gestiscono dalla scheda, dove si vedono tutti e non solo il primo. Qui
  // resta solo l'input per allegarne uno mentre si crea il documento.
  var box = el('a-allegato-corrente')
  if (box) { box.style.display = 'none'; box.innerHTML = '' }
}

// FASE 9 — rimuoviAllegatoAcquisto() e' stata tolta: cancellava dallo Storage
// un file che adesso e' nominato da una riga di tm_conta_allegati, lasciando
// un allegato che non si apre. Si elimina dalla scheda, con eliminaAllegato().

async function newAcquisto() {
  doppioneAccettato = false
  lettaDaAI = false
  editingAcquistoId = null
  acquistoOriginal = null
  acquistoDocPath = null
  acquistoIvaManuale = false
  clearAcquistoFileInput()    // PRIMA di mostrare il form: mai dopo (cancellerebbe la scelta)
  if (el('acquisti-edit-title')) el('acquisti-edit-title').textContent = 'Nuova fattura d\'acquisto'
  html('acquisti-edit-banner', '')
  showAcquistiView('edit')
  await ensureContiIva()      // per il menu Codice IVA
  await loadAziendaInfo()     // per la nota "non soggetto IVA"
  fillAcquistoForm({ data: oggiISO(), valuta: 'CHF', stato_pagamento: 'aperto' })
  await aggiornaGiaPagata(null, null)  // nuovo: la spunta e' disponibile
  // La lettura automatica vale solo su un documento nuovo: rileggere una
  // fattura gia' corretta a mano sovrascriverebbe il lavoro fatto, e non si
  // saprebbe piu' quali campi erano stati sistemati.
  mostraBottoneLettura(true)
  html('a-classificazione-riga', '')   // documento nuovo: niente da classificare
  // FASE 2: nessun contatto collegato su un documento nuovo
  if (el('a-contatto-id')) el('a-contatto-id').value = ''
  html('a-contatto-legato', '')
  html('a-fornitore-suggest', '')
  // FASE 5A: il ponte riparte pulito, senza le segnalazioni del documento prima
  chiudiIncollaRisposta()
  html('ponte-ai-banner', '')
  html('ponte-ai-note', '')
}

async function editAcquisto(id) {
  if (!currentAziendaId) return
  doppioneAccettato = false
  lettaDaAI = false
  html('acquisti-edit-banner', '')
  try {
    const { data, error } = await sb.from('tm_conta_fatture_acquisto').select('*').eq('id', id).eq('azienda_id', currentAziendaId).single()
    if (error) throw error
    editingAcquistoId = id
    var vals = {
      fornitore: data.fornitore || '', numero_fornitore: data.numero_fornitore || '',
      data: data.data || '', importo: data.importo == null ? '' : data.importo,
      valuta: data.valuta || 'CHF', scadenza: data.scadenza || '',
      stato_pagamento: data.stato_pagamento || 'aperto', note: data.note || '',
      codice_iva_id: data.codice_iva_id || null,
      imponibile: data.imponibile, iva_importo: data.iva_importo,
      gruppo_codice: data.gruppo_codice || null, contatto_id: data.contatto_id || null
    }
    acquistoOriginal = vals
    clearAcquistoFileInput()   // PRIMA di mostrare il form: mai dopo
    if (el('acquisti-edit-title')) el('acquisti-edit-title').textContent = 'Modifica fattura d\'acquisto'
    mostraBottoneLettura(false)      // in modifica no: vedi newAcquisto()
    showAcquistiView('edit')
    await ensureContiIva()
    await loadAziendaInfo()
    fillAcquistoForm(vals)
    await aggiornaGiaPagata(id, data.importo)
    await aggiornaRigaClassificazioneForm('tm_conta_fatture_acquisto', id,
                                          'a-classificazione-riga', data)
  } catch (e) {
    showFattureBanner('acquisti-list-banner', 'err', 'Apertura: ' + (e.message || e))
  }
}

function collectAcquisto() {
  var fornitore = getVal('a-fornitore')
  var dataVal = getVal('a-data')
  var importo = safeNum(getVal('a-importo'))
  if (!fornitore) throw new Error('Il fornitore è obbligatorio.')
  if (!dataVal) throw new Error('La data è obbligatoria.')
  if (importo == null || importo <= 0) throw new Error('L\'importo dev\'essere un numero positivo.')
  var impo = safeNum(getVal('a-imponibile'))
  var ivaI = safeNum(getVal('a-iva'))
  return {
    azienda_id:       currentAziendaId,
    fornitore:        fornitore,
    numero_fornitore: getVal('a-numero') || null,
    data:             dataVal,
    importo:          importo,
    valuta:           getVal('a-valuta') || 'CHF',
    scadenza:         getVal('a-scadenza') || null,
    // FASE 8 — stato_pagamento NON si scrive piu' da qui: lo calcola il trigger
    // dai pagamenti registrati. Scriverlo a mano creerebbe la seconda verita'
    // che abbiamo passato tre fasi a togliere di mezzo.
    // FASE 2: raggruppamento e collegamento alla rubrica
    gruppo_codice:    getVal('a-gruppo') || null,
    contatto_id:      getVal('a-contatto-id') || null,
    // IVA (restano NULL se non si sceglie un codice: si salva solo il totale)
    codice_iva_id:    getVal('a-codice-iva') || null,
    imponibile:       impo,
    iva_importo:      ivaI,
    // FASE 8 — data, metodo e riferimento stanno su OGNI pagamento, in
    // tm_conta_pagamenti: un documento pagato in tre volte ha tre metodi, e
    // queste colonne non potrebbero dirlo. Restano nel database come storico
    // (vedi i COMMENT in SQL_FASE8.sql) ma non si scrivono piu'.
    note:             getVal('a-note') || null
  }
}

// FASE 8b — la scorciatoia «già pagata per intero» è stata rimossa: il
// pagamento si registra sempre dalla scheda del documento, con
// «+ Registra pagamento», dove data/metodo/riferimento restano modificabili.

async function saveAcquisto() {
  html('acquisti-edit-banner', '')
  // Il file va letto SUBITO, prima di qualunque await: un re-render successivo
  // non deve poter far sparire la scelta dell'utente.
  var fileInput = el('a-allegato')
  var fileDaCaricare = (fileInput && fileInput.files && fileInput.files.length > 0) ? fileInput.files[0] : null

  var btn = el('acq-save-btn'); if (btn) { btn.disabled = true; btn.textContent = '⏳ Salvataggio…' }
  try {
    var payload = collectAcquisto()

    // FASE 10B.4 — da dove viene il documento, e se qualcuno l'ha guardato.
    // Si scrivono SOLO alla creazione: in modifica lo stato di conferma non si
    // tocca, altrimenti correggere una virgola rimetterebbe in dubbio una
    // fattura gia' controllata — o, peggio, confermerebbe senza guardare.
    if (!editingAcquistoId) {
      payload.origine        = lettaDaAI ? 'import_ai' : 'manuale'
      payload.stato_conferma = lettaDaAI ? 'da_confermare' : 'confermato'
    }

    // FASE 9B — il doppione. Si controlla PRIMA di scrivere, e non blocca:
    // avvisa, dice quale fattura, e lascia decidere. Chi ha gia' deciso
    // («Salva lo stesso») passa oltre.
    if (!doppioneAccettato) {
      var altra = null
      try {
        altra = await cercaDoppione(payload.fornitore, payload.numero_fornitore, editingAcquistoId)
      } catch (eDop) {
        // Se il controllo non si puo' fare, il salvataggio non si ferma: un
        // avviso mancato e' meglio di una fattura che non si riesce a salvare.
        console.warn('Controllo doppione non riuscito:', eDop.message || eDop)
      }
      if (altra) {
        html('acquisti-edit-banner', avvisoDoppioneHtml(altra))
        if (btn) { btn.disabled = false; btn.textContent = '💾 Salva' }
        return
      }
    }

    // FASE 9 — doc_path non si scrive piu'. Il file diventa una riga in
    // tm_conta_allegati, creata DOPO il salvataggio: prima il documento non ha
    // un id a cui attaccarla.
    var allegatoFallito = false

    if (editingAcquistoId) {
      const { error } = await sb.from('tm_conta_fatture_acquisto').update(payload).eq('id', editingAcquistoId).eq('azienda_id', currentAziendaId).select()
      if (error) throw error
    } else {
      payload.created_by = currentUser ? currentUser.id : null
      const { data, error } = await sb.from('tm_conta_fatture_acquisto').insert(payload).select()
      if (error) throw error
      editingAcquistoId = data && data[0] ? data[0].id : null
    }
    if (fileDaCaricare) {
      allegatoFallito = await creaAllegatoDaForm(
        fileDaCaricare, 'tm_conta_fatture_acquisto', editingAcquistoId)
    }
    acquistoOriginal = null
    clearAcquistoFileInput()   // caricato (o fallito): l'input riparte pulito

    // «Già pagata per intero»: il pagamento si crea DOPO che la fattura esiste,
    // perche' senza il suo id non avrebbe a cosa attaccarsi. Se fallisce, la
    // fattura resta salvata e lo si dice: sparire in silenzio farebbe credere
    // che il pagamento ci sia.
    var pagamentoFallito = null
    var spuntaPag = el('a-gia-pagata')
    if (spuntaPag && spuntaPag.checked && editingAcquistoId) {
      try {
        var dataPag = getVal('a-pag-data') || payload.data
        if (!validaData(dataPag)) throw new Error('la data del pagamento non è valida')
        // Si ricontrolla adesso: fra l'apertura del form e il salvataggio
        // qualcuno potrebbe aver registrato un pagamento dalla scheda.
        await loadPagamenti(true)
        if (totalePagatoDi('tm_conta_fatture_acquisto', editingAcquistoId) > 0.005) {
          throw new Error('la fattura ha già dei pagamenti: registrali dalla scheda')
        }
        const { error: ePag } = await sb.from('tm_conta_pagamenti').insert({
          azienda_id: currentAziendaId,
          tabella_origine: 'tm_conta_fatture_acquisto',
          id_origine: editingAcquistoId,
          data: dataPag,
          importo: payload.importo,
          metodo: getVal('a-pag-metodo') || null,
          created_by: currentUser ? currentUser.id : null
        }).select()
        if (ePag) throw ePag
        invalidaCachePagamenti()
      } catch (errPag) {
        pagamentoFallito = errPag.message || String(errPag)
        console.error('Pagamento «già pagata» non creato:', errPag)
      }
    }

    doppioneAccettato = false      // vale una volta sola
    lettaDaAI = false              // idem: vale per il documento appena salvato
    invalidaChiaviDoppioni()
    try { await refreshDaConfermareCount() } catch (_) {}
    await loadAcquistiList()
    try { await refreshDaClassificareCount() } catch (_) {}
    acquistiBackToList()
    if (pagamentoFallito) {
      showFattureBanner('acquisti-list-banner', 'warn',
        'Fattura salvata MA pagamento NON registrato: ' + pagamentoFallito +
        '. Registralo dalla scheda con «+ Registra pagamento».')
    } else if (allegatoFallito) {
      showFattureBanner('acquisti-list-banner', 'warn', 'Fattura salvata MA allegato NON caricato: ' + allegatoFallito)
    } else if (spuntaPag && spuntaPag.checked) {
      showFattureBanner('acquisti-list-banner', 'ok',
        'Fattura d\'acquisto salvata e segnata come pagata.')
    } else if (fileDaCaricare) {
      showFattureBanner('acquisti-list-banner', 'ok', 'Fattura d\'acquisto salvata con allegato «' + fileDaCaricare.name + '».')
    } else {
      showFattureBanner('acquisti-list-banner', 'ok', 'Fattura d\'acquisto salvata.')
    }
  } catch (e) {
    showFattureBanner('acquisti-edit-banner', 'err', 'Salvataggio: ' + (e.message || e))
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Salva' }
  }
}

function onAcquistoAnnulla() {
  if (editingAcquistoId && acquistoOriginal) {
    fillAcquistoForm(acquistoOriginal)   // ripristina i valori originali
    clearAcquistoFileInput()             // "Annulla" annulla anche il file scelto
    html('acquisti-edit-banner', '')
  } else {
    acquistiBackToList()
  }
}

async function deleteAcquisto(id) {
  if (!currentAziendaId) return
  if (!window.confirm('Sicuro? Non si può annullare.\n\nLa fattura d\'acquisto verrà eliminata (con la sua eventuale classificazione).')) return
  try {
    const delClass = await sb.from('tm_conta_classificazioni').delete()
      .eq('azienda_id', currentAziendaId).eq('origine_tipo', 'acquisto').eq('origine_id', id).select()
    if (delClass.error) throw delClass.error
    const { error } = await sb.from('tm_conta_fatture_acquisto').delete().eq('id', id).eq('azienda_id', currentAziendaId).select()
    if (error) throw error
    if (editingAcquistoId === id) acquistiBackToList()
    await loadAcquistiList()
    try { await refreshDaClassificareCount() } catch (_) {}
    showFattureBanner('acquisti-list-banner', 'ok', 'Fattura d\'acquisto eliminata.')
  } catch (e) {
    showFattureBanner('acquisti-list-banner', 'err', 'Eliminazione: ' + (e.message || e))
  }
}

// FASE 8 — vedi la nota su setIncassata: sostituita dai pagamenti.
async function toggleAcquistoPagato(id, toPagato) {
  console.warn('toggleAcquistoPagato non e piu in uso: usare apriRegistraPagamento o eliminaPagamento.')
  window.alert('Per registrare o togliere un pagamento usa il riquadro «Pagamenti» nella scheda del documento.')
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 7 — IMPOSTAZIONI DITTA (dati azienda in tm_aziende)
// tm_aziende è condivisa con TimberMaster: si aggiornano SOLO le colonne del
// modulo, con .select(). Nessuna funzione delle fasi precedenti viene sostituita.
// ══════════════════════════════════════════════════════════════════════════════

// Fallback logo: prova img/logo.png, poi nascondi. Niente layout rotto.
function logoOnError(img) {
  // FASE 24 — il ripiego e' il logo INCORPORATO, non piu' un file da scaricare.
  // Prima si ripiegava su 'img/logo.png': un secondo giro sulla rete che, sulla
  // busta, cominciava a finestra di stampa gia' aperta. Un data URI e' gia'
  // qui: si vede subito o non si vede mai, e in stampa non cambia sotto i piedi.
  if (img.src.indexOf('data:image') !== 0 && LOGO_INCORPORATO) {
    img.src = LOGO_INCORPORATO
  } else if (img.src.indexOf('img/logo.png') === -1 && !LOGO_INCORPORATO) {
    img.src = 'img/logo.png'
  } else {
    img.onerror = null
    img.style.display = 'none'       // ripiego finale: nascondi
  }
}

// Interruttore IVA: TRUE solo se l'azienda è registrata AFC (tm_aziende.soggetto_iva)
function isSoggettoIva() {
  return !!(aziendaInfo && aziendaInfo.soggetto_iva === true)
}

// Impostazioni: il campo N. IVA è editabile solo se soggetto IVA = ON
function toggleSoggettoIva(checked) {
  var iva = el('imp-iva')
  if (iva) iva.disabled = !checked
}

// Un oggetto Date → 'YYYY-MM-DD' nel fuso LOCALE.
// NON si usa toISOString(): quella converte in UTC, e a mezzanotte locale in
// Ticino (UTC+1/+2) restituisce il giorno PRIMA. Su una scadenza di pagamento
// un giorno di scarto non e' un dettaglio.
function dataISO(d) {
  if (!d || isNaN(d.getTime())) return null
  var m = String(d.getMonth() + 1)
  var g = String(d.getDate())
  return d.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (g.length < 2 ? '0' + g : g)
}

// La data di oggi, nel fuso di chi sta usando il programma.
function oggiISO() { return dataISO(new Date()) }

// data 'YYYY-MM-DD' + giorni → 'YYYY-MM-DD' (scadenze di fatture e movimenti)
function addDays(dateStr, days) {
  if (!dateStr) return null
  var d = new Date(dateStr + 'T00:00:00')
  if (isNaN(d.getTime())) return null
  d.setDate(d.getDate() + (parseInt(days, 10) || 0))
  return dataISO(d)
}

function setVal(id, val) { var e = el(id); if (e) e.value = (val == null ? '' : val) }
function getVal(id) { var e = el(id); return e ? e.value.trim() : '' }

async function initImpostazioniPage() {
  if (!currentAziendaId) {
    showFattureBanner('impostazioni-banner', 'err', 'Azienda non trovata: rieffettua il login.')
    return
  }
  // FASE 4 — le due voci degli avvisi stanno in tm_conta_impostazioni, non in
  // tm_aziende: si leggono e si salvano a parte.
  try {
    await loadImpostazioniConta(true)
    if (el('imp-giorni-preavviso')) el('imp-giorni-preavviso').value = giorniPreavviso()
    if (el('imp-finestra-scadenze')) el('imp-finestra-scadenze').checked = finestraScadenzeAttiva()
    // FASE 6 — costo orario: valore, data e spunta di verifica
    var co = costoOrario()
    if (el('imp-costo-orario')) el('imp-costo-orario').value = (co == null ? '' : co)
    if (el('imp-costo-verificato')) el('imp-costo-verificato').checked = costoOrarioVerificato()
    renderStatoCostoOrario(false)
    // FASE 10B.1 — l'indirizzo del Worker e lo stato della lettura automatica.
    setVal('imp-lettura-url', impostazione('worker_lettura_url', ''))
    aggiornaStatoLettura()
    // FASE 24 — il logo congelato per la stampa: c'e' o non c'e'.
    statoLogoPreparato()
    // FASE 24 — le due aliquote IVA (vedi il blocco della differenza IVA).
    setVal('imp-iva-ordinaria', impostazione('iva_aliquota_ordinaria', String(IVA_ORDINARIA_DEFAULT)))
    setVal('imp-iva-saldo', impostazione('iva_aliquota_saldo', ''))
  } catch (_) { /* i dati della ditta si caricano lo stesso */ }
  html('impostazioni-banner', loadingRow('Caricamento dati azienda…'))
  try {
    const { data, error } = await sb.from('tm_aziende').select('*').eq('id', currentAziendaId).single()
    if (error) throw error
    aziendaInfo = data || {}
    fillImpostazioniForm(aziendaInfo)
    html('impostazioni-banner', '')
    closeIbanForm()
    await loadIbanRubrica(true)
    renderIbanRubrica()
    var missing = impostazioniMancanti(aziendaInfo)
    if (missing.length) {
      showFattureBanner('impostazioni-banner', 'warn', 'Per fatture complete mancano: ' + missing.join(', ') + '. Puoi compilarli e salvare.')
    }
  } catch (e) {
    showFattureBanner('impostazioni-banner', 'err', 'Caricamento impostazioni: ' + e.message)
  }
}

function fillImpostazioniForm(a) {
  a = a || {}
  setVal('imp-ragione',  a.nome)                       // ragione sociale = colonna esistente "nome"
  setVal('imp-forma',    a.forma_giuridica)
  setVal('imp-uid',      a.uid)
  setVal('imp-iva',      a.numero_iva)
  setVal('imp-indirizzo', a.indirizzo)
  setVal('imp-npa',      a.cap)                         // NPA = colonna esistente "cap"
  setVal('imp-citta',    a.citta)
  // FASE 22 / P3 — il Paese della ditta si sceglie da un elenco, come in
  // rubrica e in fattura. impostaPaese e NON setVal: su una <select> ancora
  // vuota setVal lascerebbe il campo vuoto senza dire niente. Se il valore
  // salvato non e' un codice ISO valido, buildPaeseOptions lo mostra come
  // «da correggere» invece di sostituirlo di nascosto.
  impostaPaese('imp-paese', a.paese || 'CH')
  setVal('imp-iban',     a.iban)
  setVal('imp-termini',  a.termini_pagamento_giorni == null ? '' : a.termini_pagamento_giorni)
  setVal('imp-email',    a.email)
  setVal('imp-telefono', a.telefono)
  setVal('imp-sito',     a.sito_web)                   // sito = colonna esistente "sito_web"
  setVal('imp-logo',     a.logo_url)
  var chk = el('imp-soggetto-iva')
  if (chk) chk.checked = a.soggetto_iva === true
  toggleSoggettoIva(a.soggetto_iva === true)
}

// Ritorna la lista dei campi essenziali per fatturare che risultano vuoti
function impostazioniMancanti(a) {
  a = a || {}
  var miss = []
  if (!a.nome)       miss.push('ragione sociale')
  if (!a.indirizzo)  miss.push('indirizzo')
  if (!a.iban)       miss.push('IBAN')
  // Il N. IVA serve solo se l'azienda è registrata IVA
  if (a.soggetto_iva === true && !a.numero_iva) miss.push('N. IVA')
  return miss
}

// FASE 4 — salva le due voci degli avvisi. Separata dal salvataggio dei dati
// ditta perche' finisce in un'altra tabella: se una fallisce, l'altra resta.
async function salvaAvvisiScadenze() {
  var g = el('imp-giorni-preavviso') ? parseInt(el('imp-giorni-preavviso').value, 10) : 7
  if (isNaN(g) || g < 0 || g > 365) {
    throw new Error('I giorni di preavviso devono essere un numero fra 0 e 365.')
  }
  var mostra = el('imp-finestra-scadenze') ? el('imp-finestra-scadenze').checked : true
  await salvaImpostazioneConta('giorni_preavviso_scadenze', g,
    'Giorni di anticipo con cui una scadenza entra nel blocco «in scadenza».')
  await salvaImpostazioneConta('mostra_finestra_scadenze', mostra ? 'si' : 'no',
    'si = la finestra di riepilogo compare una volta al giorno all-apertura.')
  await refreshScadenzeCount()
}

// FASE 6 — costo orario: tre chiavi che viaggiano insieme.
// La data si aggiorna DA SOLA a ogni salvataggio del valore: e' il senso della
// riga «ultimo aggiornamento», che deve dire quando quel numero e' stato deciso,
// non quando qualcuno ha aperto la pagina.
async function salvaCostoOrario() {
  var grezzo = el('imp-costo-orario') ? el('imp-costo-orario').value : ''
  var verif = el('imp-costo-verificato') ? el('imp-costo-verificato').checked : false

  if (String(grezzo).trim() === '') {
    // Campo svuotato: si azzera l'impostazione. Meglio nessun costo orario che
    // uno vecchio dimenticato li'.
    await salvaImpostazioneConta('costo_orario_medio', '',
      'Costo di un ora di manodopera (CHF/h): salario lordo + oneri + assicurazioni, diviso le ore produttive. NON e la tariffa di vendita.')
    await salvaImpostazioneConta('costo_orario_verificato', 'no', 'si = controllato dal commercialista.')
    return
  }

  var n = safeNum(grezzo)
  if (n == null || n <= 0 || n > 500) {
    throw new Error('Il costo orario deve essere un numero fra 0 e 500 CHF/h.')
  }

  var precedente = safeNum(impostazione('costo_orario_medio', null))
  var cambiato = (precedente == null) || Math.abs(precedente - n) > 0.004

  await salvaImpostazioneConta('costo_orario_medio', n,
    'Costo di un ora di manodopera (CHF/h): salario lordo + oneri + assicurazioni, diviso le ore produttive. NON e la tariffa di vendita.')

  // La data cambia solo se cambia il numero: riaprire e risalvare la pagina
  // senza toccare niente non deve far sembrare il valore piu' fresco di quanto sia.
  if (cambiato) {
    await salvaImpostazioneConta('costo_orario_aggiornato_il', oggiISO(),
      'Data in cui il costo orario e stato cambiato l ultima volta.')
    // Numero nuovo = da rifar controllare, qualunque cosa dica la spunta.
    verif = false
    if (el('imp-costo-verificato')) el('imp-costo-verificato').checked = false
  }

  await salvaImpostazioneConta('costo_orario_verificato', verif ? 'si' : 'no',
    'si = il commercialista ha controllato questo costo orario. Si azzera da sola quando il numero cambia.')
}

async function saveImpostazioni() {
  if (!currentAziendaId) {
    showFattureBanner('impostazioni-banner', 'err', 'Azienda non trovata: rieffettua il login.')
    return
  }
  // FASE 10B.1 — l'indirizzo del Worker. Si salva con le altre impostazioni:
  // e' una preferenza della ditta, non un dato dell'anagrafica.
  try {
    await salvaImpostazioneConta('worker_lettura_url', String(getVal('imp-lettura-url') || '').trim(),
                                 'Indirizzo del Worker Cloudflare per la lettura automatica')
    aggiornaStatoLettura()
  } catch (eW) {
    console.warn('Indirizzo del Worker non salvato:', eW.message || eW)
  }

  var termini = getVal('imp-termini')
  var soggettoIva = el('imp-soggetto-iva') ? el('imp-soggetto-iva').checked : false
  var payload = {
    nome:            getVal('imp-ragione') || null,
    forma_giuridica: getVal('imp-forma') || null,
    uid:             getVal('imp-uid') || null,
    soggetto_iva:    soggettoIva,
    numero_iva:      getVal('imp-iva') || null,
    indirizzo:       getVal('imp-indirizzo') || null,
    cap:             getVal('imp-npa') || null,
    citta:           getVal('imp-citta') || null,
    // FASE 22 / P3 — niente troncamento: il valore arriva da una tendina di
    // codici ISO, e tagliare «Svizzera» a «SV» (che e' El Salvador) e' proprio
    // il difetto che si sta togliendo.
    paese:           getVal('imp-paese') || null,
    iban:            getVal('imp-iban') || null,
    termini_pagamento_giorni: termini === '' ? null : (safeNum(termini) != null ? Math.round(safeNum(termini)) : null),
    email:           getVal('imp-email') || null,
    telefono:        getVal('imp-telefono') || null,
    sito_web:        getVal('imp-sito') || null,
    logo_url:        getVal('imp-logo') || null
  }

  var btn = el('imp-save-btn')
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Salvataggio…' }
  html('impostazioni-banner', loadingRow('Salvataggio…'))
  try {
    const { data, error } = await sb
      .from('tm_aziende')
      .update(payload)
      .eq('id', currentAziendaId)
      .select()
    if (error) throw error
    if (!data || !data.length) {
      // Nessuna riga aggiornata: quasi sempre RLS che nega l'UPDATE
      showFattureBanner('impostazioni-banner', 'err',
        'Salvataggio non riuscito: il database non ha aggiornato la riga (probabile permesso RLS mancante). Applica la sezione 2 di migration_fase7.sql.')
      return
    }
    aziendaInfo = data[0]

    // FASE 4 — le due voci degli avvisi vanno in tm_conta_impostazioni.
    // Se falliscono, i dati della ditta restano salvati: si avvisa e basta.
    var avvisiOk = true
    try { await salvaAvvisiScadenze(); await salvaCostoOrario(); renderStatoCostoOrario(false) }
    catch (eAvv) {
      avvisiOk = false
      showFattureBanner('impostazioni-banner', 'warn',
        'Dati della ditta salvati. Avvisi scadenze o costo orario NO: ' + (eAvv.message || eAvv))
    }

    var missing = impostazioniMancanti(aziendaInfo)
    if (missing.length) {
      showFattureBanner('impostazioni-banner', 'warn', 'Salvato. ⚠️ Per fatture complete mancano ancora: ' + missing.join(', ') + '.')
    } else if (avvisiOk) {
      showFattureBanner('impostazioni-banner', 'ok', 'Impostazioni salvate, avvisi scadenze compresi.')
    }
  } catch (e) {
    var m = e && e.message ? e.message : String(e)
    var low = m.toLowerCase()
    if (low.indexOf('column') !== -1 || low.indexOf('schema cache') !== -1 || m.indexOf('PGRST204') !== -1) {
      m = 'Alcune colonne non esistono ancora nel database: applica prima migration_fase7.sql. (' + m + ')'
    }
    showFattureBanner('impostazioni-banner', 'err', 'Salvataggio impostazioni: ' + m)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Salva impostazioni' }
  }
}

// ─── CANALE B — form inserimento ─────────────────────────────────────────────
function togglePeriodicita(checked) {
  var group = el('f-periodicita-group')
  if (group) {
    group.style.display = checked ? 'block' : 'none'
    var sel = el('f-periodicita')
    if (sel) sel.required = checked
  }
}

function showBucketInfo(evt) {
  if (evt) evt.preventDefault()
  var card = el('bucket-info-card')
  if (card) {
    card.style.display = card.style.display === 'none' ? 'block' : 'none'
  }
}

// Tutto quello che serve alla pagina «Inserimento manuale» quando si apre.
// Prima non esisteva: la pagina si limitava a caricare gli ultimi movimenti,
// e i menu che vanno riempiti da JavaScript restavano vuoti.
async function initInserimentoPage() {
  try { await loadRecentiInseriti() } catch (e) { console.warn('Recenti:', e.message || e) }
  try { await riempiSelectGruppi('f-gruppo', getVal('f-gruppo') || '') }
  catch (e) { console.warn('Gruppi:', e.message || e) }
}

function resetInserimentoForm() {
  var form = el('form-inserimento')
  if (form) form.reset()
  togglePeriodicita(false)
  if (el('f-data')) el('f-data').value = oggiISO()
  html('inserimento-banner', '')
  // FASE 2: il collegamento in rubrica non deve sopravvivere al reset del form
  if (el('f-contatto-id')) el('f-contatto-id').value = ''
  html('f-contatto-legato', '')
  html('f-ente-suggest', '')
  riempiSelectGruppi('f-gruppo', '')
  proponiStatoDaData()
}

function showInserimentoBanner(tipo, titolo, dettaglio) {
  html('inserimento-banner',
    '<div class="fase-banner ' + tipo + '" role="' + (tipo === 'ok' ? 'status' : 'alert') + '">' +
      '<span class="icon" aria-hidden="true">' + (tipo === 'ok' ? '✅' : tipo === 'warn' ? '⚠️' : '❌') + '</span>' +
      '<div class="msg">' + esc(titolo) +
        (dettaglio ? '<small>' + esc(dettaglio) + '</small>' : '') +
      '</div>' +
    '</div>'
  )
}

async function handleInserimentoSubmit(event) {
  event.preventDefault()
  if (!currentUser) {
    showInserimentoBanner('err', 'Accesso richiesto', 'Effettua il login prima di inserire un movimento.')
    return
  }
  if (!currentAziendaId) {
    showInserimentoBanner('err', 'Azienda non trovata', 'Impossibile trovare l\'azienda associata al tuo account. Ricarica la pagina.')
    return
  }

  var btn = el('inserimento-submit-btn')
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Salvataggio…' }
  html('inserimento-banner', '')

  try {
    var dataVal    = el('f-data')       ? el('f-data').value              : ''
    var desc       = el('f-descrizione') ? el('f-descrizione').value.trim() : ''
    var ente       = el('f-ente')       ? el('f-ente').value.trim()       : ''
    var importoVal = el('f-importo')    ? parseFloat(el('f-importo').value) : NaN
    var valuta     = el('f-valuta')     ? el('f-valuta').value            : 'CHF'
    var ricorrente = el('f-ricorrente') ? el('f-ricorrente').checked      : false
    var periodicita = ricorrente && el('f-periodicita') ? el('f-periodicita').value : null
    var fileInput  = el('f-allegato')

    if (!dataVal)          throw new Error('La data è obbligatoria.')
    if (!desc)             throw new Error('La descrizione è obbligatoria.')
    if (isNaN(importoVal) || importoVal <= 0) throw new Error('L\'importo deve essere un numero positivo.')
    if (ricorrente && !periodicita) throw new Error('Seleziona la periodicità per le spese ricorrenti.')

    // FASE 9 — come nel form acquisto: il file si legge adesso, ma l'allegato
    // si crea dopo il salvataggio, quando il movimento ha un id.
    var fileMovimento = (fileInput && fileInput.files && fileInput.files.length > 0)
      ? fileInput.files[0] : null
    var allegatoFallito = false

    // FASE 8 — lo stato non si sceglie piu': se il movimento e' gia' stato
    // pagato lo si dice con la spunta, e si crea un pagamento vero. La regola
    // della FASE 2 resta come PROPOSTA: una spesa con data passata di norma
    // e' gia' uscita, e la spunta parte gia' attiva.
    var giaPagato = el('f-gia-pagata') ? el('f-gia-pagata').checked : false
    var dataPag   = el('f-data-pagamento') ? el('f-data-pagamento').value : ''

    var payload = {
      azienda_id:    currentAziendaId,
      data:          dataVal,
      descrizione:   desc,
      ente_fornitore: ente || null,
      importo:       importoVal,
      valuta:        valuta,
      ricorrente:    ricorrente,
      periodicita:   periodicita,
      // ── Colonne della FASE 1: senza queste il movimento non comparirebbe
      //    correttamente in v_conta_flussi (e quindi nel cruscotto).
      data_documento:  dataVal,
      importo_totale:  importoVal,
      verso:           'uscita',            // il Canale B registra solo uscite
      origine:         'manuale',
      stato_conferma:  'confermato',        // inserito a mano da chi lo sa
      // stato_pagamento e data_pagamento NON si scrivono: li mette il trigger
      // quando il pagamento viene registrato, subito sotto.
      data_scadenza:   (el('f-scadenza') && el('f-scadenza').value) || null,
      gruppo_codice:   (el('f-gruppo') && el('f-gruppo').value) || null,
      contatto_id:     (el('f-contatto-id') && el('f-contatto-id').value) || null
    }

    if (editingMovimentoId) {
      const { error } = await sb
        .from('tm_conta_movimenti_propri')
        .update(payload)
        .eq('id', editingMovimentoId)
        .eq('azienda_id', currentAziendaId)
        .select()
      if (error) throw error
      allegatoFallito = await creaAllegatoDaForm(
        fileMovimento, 'tm_conta_movimenti_propri', editingMovimentoId)
      exitEditMode()
      if (allegatoFallito) {
        showInserimentoBanner('warn', 'Modifiche salvate (senza nuovo allegato)', 'L\'allegato non è stato caricato: ' + allegatoFallito)
      } else {
        showInserimentoBanner('ok', 'Modifiche salvate', 'Il movimento è stato aggiornato.')
      }
    } else {
      payload.created_by = currentUser.id
      const { data: creatoMov, error } = await sb
        .from('tm_conta_movimenti_propri')
        .insert(payload)
        .select()
      if (error) throw error
      allegatoFallito = await creaAllegatoDaForm(
        fileMovimento, 'tm_conta_movimenti_propri', creatoMov && creatoMov[0] ? creatoMov[0].id : null)

      // FASE 8 — «gia' pagata»: si registra il versamento, e il trigger porta
      // il movimento a 'pagato' da solo.
      if (giaPagato && creatoMov && creatoMov[0]) {
        try {
          const { error: ePag } = await sb.from('tm_conta_pagamenti').insert({
            azienda_id: currentAziendaId,
            tabella_origine: 'tm_conta_movimenti_propri',
            id_origine: creatoMov[0].id,
            data: dataPag || dataVal,
            importo: importoVal,
            note: 'Registrato alla creazione con «gia pagata».',
            created_by: currentUser.id
          }).select()
          if (ePag) throw ePag
          invalidaCachePagamenti()
        } catch (ePg) {
          showInserimentoBanner('warn', 'Movimento salvato, pagamento NO',
            'Il movimento c e, ma il pagamento non e stato registrato: ' + (ePg.message || ePg) +
            ' — puoi aggiungerlo dalla scheda del documento.')
        }
      }
      resetInserimentoForm()
      if (allegatoFallito) {
        showInserimentoBanner('warn', 'Movimento salvato (senza allegato)', 'L\'allegato non è stato caricato: ' + allegatoFallito + ' — Il movimento è comunque in «Da classificare».')
      } else {
        showInserimentoBanner('ok', 'Movimento salvato', 'Ora compare nella lista «Da classificare».')
      }
    }

    // Aggiornamenti UI non bloccanti: il salvataggio è già andato a buon fine,
    // quindi un loro errore non deve trasformarsi in un banner di errore.
    try {
      await loadRecentiInseriti()
      await refreshDaClassificareCount()
      if (currentPage === 'movimenti') await loadDaClassificare()
    } catch (_) { /* ignora: dati già salvati */ }

  } catch (e) {
    showInserimentoBanner('err', 'Errore', e.message)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = editingMovimentoId ? '💾 Salva modifiche' : '💾 Salva movimento' }
  }
}

// ─── Upload allegato su Storage ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
// ALLEGATI — apertura con link firmato (bucket PRIVATO), nome file, rimozione
// ══════════════════════════════════════════════════════════════════════════════

// "azienda_id/1718900000000_fattura.pdf" → "fattura.pdf"
function allegatoNomeFile(path) {
  if (!path) return ''
  var base = String(path).split('/').pop()
  return base.replace(/^\d{10,}_/, '')
}

// Avviso leggibile: banner se disponibile, altrimenti alert. Mai silenzioso.
function avvisoAllegato(bannerId, tipo, msg) {
  if (bannerId && el(bannerId)) showFattureBanner(bannerId, tipo, msg)
  else window.alert(msg)
}

// Bucket privato → link temporaneo (1 ora) e apertura in nuova scheda
async function openAllegato(path, bannerId) {
  if (!path) { avvisoAllegato(bannerId, 'warn', 'Nessun allegato associato a questo documento.'); return }
  try {
    const { data, error } = await sb.storage.from(STORAGE_BUCKET).createSignedUrl(path, 3600)
    if (error) throw error
    if (!data || !data.signedUrl) throw new Error('Il server non ha restituito un link firmato.')
    window.open(data.signedUrl, '_blank', 'noopener')
  } catch (e) {
    console.error('openAllegato — createSignedUrl fallita:', e, 'path:', path)
    var code = e.statusCode || e.status || ''
    avvisoAllegato(bannerId, 'err',
      'Impossibile aprire l\'allegato: ' + (e.message || e) + (code ? ' [HTTP ' + code + ']' : '') + ' — path: ' + path)
  }
}

// Elimina il file dallo Storage (usato da "Rimuovi allegato")
async function deleteAllegatoStorage(path) {
  const { error } = await sb.storage.from(STORAGE_BUCKET).remove([path])
  if (error) {
    console.error('deleteAllegatoStorage — errore:', error, 'path:', path)
    var code = error.statusCode || error.status || ''
    throw new Error((error.message || 'errore sconosciuto') + (code ? ' [HTTP ' + code + ']' : ''))
  }
}

// Pulsante compatto "📎 Apri allegato" per le liste
function allegatoBtn(path, bannerId) {
  if (!path) return ''
  return '<button class="icon-btn" title="Apri allegato" onclick="event.stopPropagation(); openAllegato(\'' +
    esc(path) + '\', \'' + esc(bannerId || '') + '\')">📎 Allegato</button>'
}

async function uploadAllegato(file) {
  if (!currentAziendaId) throw new Error('Azienda non definita, impossibile caricare allegato.')
  var ts       = Date.now()
  var safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  // Path = "{azienda_id}/{ts}_{nome}" — split_part(name,'/',1) nella policy Storage
  // restituisce esattamente l'azienda_id, garantendo l'isolamento per azienda.
  var path = currentAziendaId + '/' + ts + '_' + safeName

  const { data, error } = await sb.storage.from(STORAGE_BUCKET).upload(path, file, { upsert: false })
  if (error) {
    // Riporta SEMPRE l'errore reale (niente diagnosi inventate): serve per capire
    // se è il bucket, una policy RLS o altro.
    console.error('uploadAllegato — errore Storage:', error)
    var msg  = error.message || ''
    var code = error.statusCode || error.status || ''
    var full = msg + (code ? ' [HTTP ' + code + ']' : '')
    var low  = msg.toLowerCase()
    if (low.indexOf('bucket') !== -1) {
      throw new Error('Bucket "' + STORAGE_BUCKET + '" non raggiungibile — ' + full)
    }
    if (String(code) === '403' || low.indexOf('row-level security') !== -1 || low.indexOf('unauthorized') !== -1 || low.indexOf('policy') !== -1) {
      throw new Error('Storage: permesso negato dalle policy (path "' + path + '") — ' + full)
    }
    throw new Error('Upload allegato: ' + (full || 'errore sconosciuto'))
  }
  return data ? data.path : path
}

// ─── Ultimi inseriti Canale B ─────────────────────────────────────────────────
async function loadRecentiInseriti() {
  try { await loadAllegati() } catch (_) {}
  if (!currentAziendaId) {
    html('inserimento-recenti', '<div class="dim" style="padding:8px 0">Accedi per vedere i movimenti.</div>')
    return
  }
  html('inserimento-recenti', loadingRow('Caricamento…'))
  try {
    const { data, error } = await sb
      .from('tm_conta_movimenti_propri')
      .select('id, data, descrizione, importo, valuta, ente_fornitore, ricorrente, periodicita')
      .eq('azienda_id', currentAziendaId)
      .order('created_at', { ascending: false })
      .limit(8)
    if (error) throw error

    if (!data || data.length === 0) {
      recentiList = []
      html('inserimento-recenti', '<div class="dim" style="padding:8px 0">Nessun movimento ancora inserito.</div>')
      return
    }

    recentiList = data

    // Stato classificazione di questi movimenti (per marcare i bloccati come sola lettura)
    var statoById = {}
    try {
      var ids = data.map(function (m) { return m.id })
      const { data: cls, error: clsErr } = await sb
        .from('tm_conta_classificazioni')
        .select('id, origine_tipo, origine_id, conto_id, codice_iva_id, cantiere_id, note, stato')
        .eq('azienda_id', currentAziendaId)
        .eq('origine_tipo', 'proprio')
        .in('origine_id', ids)
      if (!clsErr && cls) {
        for (var ci = 0; ci < cls.length; ci++) {
          statoById[cls[ci].origine_id] = cls[ci].stato
          classByKey['proprio:' + cls[ci].origine_id] = cls[ci]
        }
      }
      // I conti servono per scrivere il nome accanto al numero.
      await ensureContiIva()
    } catch (_) { /* non bloccante */ }

    var rows = data.map(function (m, i) {
      var importoStr = fmtImporto(m.importo, m.valuta)
      var bloccato = statoById[m.id] === 'bloccato'
      // I movimenti propri non hanno una scheda a se': l'elenco e' il loro
      // dettaglio, quindi la classificazione si mostra e si corregge da qui.
      var cls = classByKey['proprio:' + m.id]
      var classTxt = cls && cls.conto_id
        ? '🏷 ' + esc(contoLabel(cls.conto_id))
        : '<span class="dim">🏷 Non ancora classificato</span>'
      var classRiga = '<div class="class-riga-compatta">' + classTxt + '</div>'

      var azioni = badgeAllegati('tm_conta_movimenti_propri', m.id, 'inserimento-banner') + (bloccato
        ? '<span class="lock-tag" title="Periodo consegnato — sola lettura">🔒 Consegnato</span>'
        : '<button class="icon-btn" title="' +
            (cls && cls.conto_id ? 'Cambia conto, gruppo, cantiere o IVA' : 'Assegna conto e IVA') + '" ' +
            'onclick="riclassificaDocumento(\'tm_conta_movimenti_propri\', \'' + esc(m.id) + '\')">' +
            (cls && cls.conto_id ? '🏷 Riclassifica' : '🏷 Classifica') + '</button>' +
          '<button class="icon-btn" title="Modifica" onclick="editRecente(' + i + ')">✏️ Modifica</button>' +
          '<button class="icon-btn danger" title="Elimina" onclick="deleteRecente(' + i + ')">🗑️ Elimina</button>')
      return (
        '<div class="recent-item">' +
          '<div class="recent-meta">' +
            '<span class="recent-date dim">' + esc(fmtDate(m.data)) + '</span>' +
            (m.ricorrente ? ' ' + badge('info', '🔄 ' + (m.periodicita || 'Ricorrente')) : '') +
          '</div>' +
          '<div class="recent-desc">' + esc(m.descrizione) + '</div>' +
          (m.ente_fornitore ? '<div class="dim" style="font-size:11px">' + esc(m.ente_fornitore) + '</div>' : '') +
          '<div class="recent-amount">' + importoStr + '</div>' +
          classRiga +
          '<div class="row-actions" style="margin-top:6px">' + azioni + '</div>' +
        '</div>'
      )
    }).join('')

    html('inserimento-recenti', '<div class="recent-list">' + rows + '</div>')
  } catch (e) {
    html('inserimento-recenti', '<p style="color:var(--err);font-size:13px">Errore: ' + esc(e.message) + '</p>')
  }
}

// ─── FASE 1 — Setup check ─────────────────────────────────────────────────────
async function runSetupCheck() {
  html('fase1-banner', loadingRow('Connessione a Supabase in corso…'))
  html('fase1-checks', loadingRow('Verifica tabelle…'))
  html('fase1-stats',  loadingRow('Lettura pacchetto CH…'))
  html('fase1-pdc',    '')
  html('fase1-iva',    '')

  const results = []
  let allOk = true
  let connectionOk = false

  // 1. Connessione
  try {
    const { error } = await sb.from('tm_conta_piano_conti').select('id').limit(1)
    connectionOk = !error
    if (error) throw error
    results.push({ ok: true, name: 'Connessione Supabase', detail: 'Progetto wgidgbauhivdctdxfjnk raggiunto' })
  } catch (e) {
    allOk = false
    results.push({ ok: false, name: 'Connessione Supabase', detail: e.message || 'Impossibile connettersi' })
  }

  // 2. Tabelle tm_conta_*
  const tables = [
    { name: 'tm_conta_piano_conti',      label: 'Piano dei conti'    },
    { name: 'tm_conta_codici_iva',       label: 'Codici IVA'         },
    { name: 'tm_conta_classificazioni',  label: 'Classificazioni'    },
    { name: 'tm_conta_movimenti_propri', label: 'Movimenti propri'   },
    { name: 'tm_conta_export_log',       label: 'Export log'         },
    { name: 'tm_conta_audit',            label: 'Audit trail'        },
  ]
  const tableCounts = {}
  for (var ti = 0; ti < tables.length; ti++) {
    var t = tables[ti]
    try {
      const { count, error } = await sb.from(t.name).select('*', { count: 'exact', head: true })
      if (error) throw error
      tableCounts[t.name] = count || 0
      results.push({ ok: true, name: t.label + ' (' + t.name + ')', detail: (count || 0) + ' righe' })
    } catch (e) {
      allOk = false
      tableCounts[t.name] = null
      results.push({
        ok: false,
        name: t.label + ' (' + t.name + ')',
        detail: (e.message.indexOf('relation') !== -1 || e.message.indexOf('does not exist') !== -1)
          ? 'Tabella mancante — applicare 001_fondamenta.sql'
          : e.message
      })
    }
  }

  // 3. Pacchetto CH
  let pdcCH = 0, ivaCH = 0, pdcOk = false, ivaOk = false
  try {
    const { count, error } = await sb.from('tm_conta_piano_conti').select('*', { count: 'exact', head: true }).eq('paese', 'CH')
    if (!error) { pdcCH = count || 0; pdcOk = pdcCH > 0 }
  } catch (_) {}
  try {
    const { count, error } = await sb.from('tm_conta_codici_iva').select('*', { count: 'exact', head: true }).eq('paese', 'CH')
    if (!error) { ivaCH = count || 0; ivaOk = ivaCH > 0 }
  } catch (_) {}

  if (pdcOk) {
    results.push({ ok: true,  name: 'Pacchetto CH — Piano dei conti', detail: pdcCH + ' conti caricati' })
  } else if (tableCounts['tm_conta_piano_conti'] !== null) {
    allOk = false
    results.push({ ok: false, name: 'Pacchetto CH — Piano dei conti', detail: 'Dati mancanti — applicare 002_pacchetto_ch.sql' })
  }
  if (ivaOk) {
    results.push({ ok: true,  name: 'Pacchetto CH — Codici IVA', detail: ivaCH + ' codici caricati' })
  } else if (tableCounts['tm_conta_codici_iva'] !== null) {
    allOk = false
    results.push({ ok: false, name: 'Pacchetto CH — Codici IVA', detail: 'Dati mancanti — applicare 002_pacchetto_ch.sql' })
  }

  // 4. Tabelle sorgente Fase 2 (Canale A)
  var sorgenti = [
    { name: 'spese', label: 'App Cantieri — Spese (Canale A)' },
    { name: 'regia', label: 'App Cantieri — Regia (Canale A)' },
  ]
  for (var si = 0; si < sorgenti.length; si++) {
    var s = sorgenti[si]
    try {
      const { count, error } = await sb.from(s.name).select('*', { count: 'exact', head: true })
      if (error) throw error
      results.push({ ok: true, name: s.label, detail: (count || 0) + ' righe (Canale A lettura OK)' })
    } catch (e) {
      results.push({ ok: null, name: s.label, detail: 'Non accessibile: ' + e.message })
    }
  }

  // ── Banner principale ─────────────────────────────────────────────────────
  var fase1Pronta = allOk && pdcOk && ivaOk
  var bannerHtml = ''
  if (fase1Pronta) {
    bannerHtml = (
      '<div class="fase-banner ok" role="status">' +
        '<span class="icon" aria-hidden="true">✅</span>' +
        '<div class="msg">FASE 1 COMPLETATA' +
          '<small>Fondamenta OK — ' + pdcCH + ' conti + ' + ivaCH + ' codici IVA CH. Fase 2 attiva.</small>' +
        '</div>' +
        badge('ok', 'Pronto') +
      '</div>'
    )
  } else if (!connectionOk) {
    bannerHtml = (
      '<div class="fase-banner err" role="alert">' +
        '<span class="icon" aria-hidden="true">❌</span>' +
        '<div class="msg">Connessione Supabase fallita<small>Verifica URL, chiave e connessione internet.</small></div>' +
      '</div>'
    )
  } else {
    bannerHtml = (
      '<div class="fase-banner warn" role="alert">' +
        '<span class="icon" aria-hidden="true">⚠️</span>' +
        '<div class="msg">Setup parziale — azioni richieste<small>Applica le migration SQL indicate e ricarica.</small></div>' +
        badge('warn', 'Incompleto') +
      '</div>'
    )
  }
  html('fase1-banner', bannerHtml)

  // ── Check list ────────────────────────────────────────────────────────────
  html('fase1-checks',
    '<div class="check-list">' +
      results.map(function (r) { return checkRow(r.ok, r.name, r.detail) }).join('') +
    '</div>'
  )

  // ── Stats ────────────────────────────────────────────────────────────────
  if (fase1Pronta) {
    html('fase1-stats',
      '<div class="grid-3">' +
        statCard('Conti CH', pdcCH, 'Piano dei conti PMI svizzero') +
        statCard('Codici IVA', ivaCH, 'Aliquote CH 2024') +
        statCard('Paese', 'CH 🇨🇭', 'Pacchetto attivo') +
      '</div>'
    )
  } else {
    html('fase1-stats', '')
  }

  if (pdcOk) { await renderPianoConti() }
  if (ivaOk) { await renderCodiciIVA() }
}

function statCard(label, value, detail) {
  return (
    '<div class="stat-card">' +
      '<div class="stat-label">' + esc(label) + '</div>' +
      '<div class="stat-value">' + esc(String(value)) + '</div>' +
      '<div class="stat-detail">' + esc(detail) + '</div>' +
    '</div>'
  )
}

// ─── Piano dei conti (Fase 1) ─────────────────────────────────────────────────
async function renderPianoConti() {
  html('fase1-pdc', loadingRow('Caricamento piano dei conti…'))
  // FASE 23 / P2 — senza sessione la RLS non da' errore: restituisce zero
  // righe. Senza questa guardia si disegnava una tabella vuota col badge VERDE
  // «0 conti», che si legge come un esito riuscito. Un elenco vuoto deve dire
  // perche' e' vuoto — come fa notaCantieriVuoti per i cantieri.
  if (!currentAziendaId) {
    html('fase1-pdc', '<div class="cru-vuoto"><strong>Piano dei conti non disponibile.</strong><br>' +
      'La sessione non &egrave; attiva, quindi il programma non pu&ograve; leggerlo. ' +
      'Rientra e riprova: il dato c&rsquo;&egrave;, &egrave; l&rsquo;accesso che manca.</div>')
    return
  }

  var conti = []
  try {
    const { data, error } = await sb.from('tm_conta_piano_conti').select('codice_conto, descrizione, tipo, attivo').eq('paese', 'CH').order('codice_conto')
    if (error) throw error
    conti = data || []
  } catch (e) {
    html('fase1-pdc', '<p style="color:var(--err);padding:12px">Errore: ' + esc(e.message) + '</p>')
    return
  }

  var classi = {
    '1': { label: 'Classe 1 — Attivi', rows: [] },
    '2': { label: 'Classe 2 — Passivi e Patrimonio', rows: [] },
    '3': { label: 'Classe 3 — Ricavi', rows: [] },
    '4': { label: 'Classe 4 — Costi materiali', rows: [] },
    '5': { label: 'Classe 5 — Costi personale', rows: [] },
    '6': { label: 'Classe 6 — Costi operativi', rows: [] },
    '7': { label: 'Classe 7 — Costi diversi e imposte', rows: [] },
  }
  for (var i = 0; i < conti.length; i++) {
    var c = conti[i]
    var cls = c.codice_conto.charAt(0)
    if (classi[cls]) classi[cls].rows.push(c)
  }

  var tipoBadge = {
    attivo: badge('info', 'Attivo'), passivo: badge('warn', 'Passivo'),
    ricavo: badge('ok', 'Ricavo'),   costo:   badge('err',  'Costo'),
    patrimonio: badge('gold', 'Patrimonio'),
  }

  var rows = ''
  var keys = Object.keys(classi)
  for (var ki = 0; ki < keys.length; ki++) {
    var group = classi[keys[ki]]
    if (group.rows.length === 0) continue
    rows += '<tr class="class-header"><td colspan="3">' + esc(group.label) + '</td></tr>'
    for (var ri = 0; ri < group.rows.length; ri++) {
      var cc = group.rows[ri]
      rows += '<tr><td><span class="cod">' + esc(cc.codice_conto) + '</span></td><td>' + esc(cc.descrizione) + '</td><td>' + (tipoBadge[cc.tipo] || badge('info', cc.tipo)) + '</td></tr>'
    }
  }

  html('fase1-pdc',
    '<div class="card">' +
      // FASE 23 — «0 conti» in verde e' la bugia piu' corta del programma.
      '<div class="card-title">📋 Piano dei conti CH — Kontenrahmen KMU ' +
        badge(conti.length ? 'ok' : 'warn', conti.length + ' conti') + '</div>' +
      '<div class="table-wrap"><table><thead><tr><th style="width:90px">Conto</th><th>Descrizione</th><th style="width:110px">Tipo</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="sql-tip">💡 Piano dei conti provvisorio. Il piano definitivo è fornito dal commercialista.</div>' +
    '</div>'
  )
}

// ─── Codici IVA (Fase 1) ──────────────────────────────────────────────────────
async function renderCodiciIVA() {
  html('fase1-iva', loadingRow('Caricamento codici IVA…'))
  // FASE 23 / P2 — senza sessione la RLS non da' errore: restituisce zero
  // righe. Senza questa guardia si disegnava una tabella vuota col badge VERDE
  // «0 conti», che si legge come un esito riuscito. Un elenco vuoto deve dire
  // perche' e' vuoto — come fa notaCantieriVuoti per i cantieri.
  if (!currentAziendaId) {
    html('fase1-iva', '<div class="cru-vuoto"><strong>Elenco dei codici IVA non disponibile.</strong><br>' +
      'La sessione non &egrave; attiva, quindi il programma non pu&ograve; leggerlo. ' +
      'Rientra e riprova: il dato c&rsquo;&egrave;, &egrave; l&rsquo;accesso che manca.</div>')
    return
  }

  var codici = []
  try {
    const { data, error } = await sb.from('tm_conta_codici_iva').select('codice, descrizione, aliquota, attivo').eq('paese', 'CH').order('aliquota', { ascending: false })
    if (error) throw error
    codici = data || []
  } catch (e) {
    html('fase1-iva', '<p style="color:var(--err);padding:12px">Errore: ' + esc(e.message) + '</p>')
    return
  }

  var rows = codici.map(function (c) {
    var alq = parseFloat(c.aliquota)
    var alqLabel = alq === 0 ? '0%' : alq.toFixed(2) + '%'
    var alqBadge = badge('info', alqLabel)
    if (alq === 8.1) alqBadge = badge('err',  '8.1%')
    if (alq === 2.6) alqBadge = badge('warn', '2.6%')
    if (alq === 3.8) alqBadge = badge('gold', '3.8%')
    if (alq === 0)   alqBadge = badge('ok',   '0%')
    return '<tr><td><span class="cod">' + esc(c.codice) + '</span></td><td>' + esc(c.descrizione) + '</td><td class="num">' + alqBadge + '</td></tr>'
  }).join('')

  html('fase1-iva',
    '<div class="card">' +
      '<div class="card-title">🏷 Codici IVA CH ' +
        badge(codici.length ? 'ok' : 'warn', codici.length + ' codici') + '</div>' +
      '<div class="table-wrap"><table><thead><tr><th style="width:110px">Codice</th><th>Descrizione</th><th style="width:90px;text-align:right">Aliquota</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="sql-tip">ℹ️ Aliquote IVA CH in vigore dal 01.01.2024 (riforma IVA).</div>' +
    '</div>'
  )
}

// ─── Istruzioni SQL (Fase 1) ──────────────────────────────────────────────────
function renderSqlInstructions() {
  html('fase1-sql',
    '<div class="card">' +
      '<div class="card-title">📂 Istruzioni migration SQL</div>' +
      '<ol style="padding-left:20px;line-height:2;font-size:13px;color:var(--text2)">' +
        '<li>Apri <strong>Supabase Dashboard</strong> → progetto <code>wgidgbauhivdctdxfjnk</code> → <strong>SQL Editor</strong></li>' +
        '<li>Incolla ed esegui <code>migrations/001_fondamenta.sql</code></li>' +
        '<li>Incolla ed esegui <code>migrations/002_pacchetto_ch.sql</code></li>' +
        '<li>Ricarica questa pagina (F5)</li>' +
      '</ol>' +
    '</div>'
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 2 — RUBRICA CONTATTI
// Anagrafica unica (tm_contatti) condivisa da tutte le app dell'ecosistema.
// Prima di questa fase la controparte era testo libero, riscritto ogni volta e
// scollegato: «UBS», «U.B.S.» e «ubs» erano tre fornitori diversi.
// ══════════════════════════════════════════════════════════════════════════════

let contattiCache   = null   // [{...}] tutti i contatti dell'azienda
let gruppiCache     = null   // [{codice, nome, esempi, ordine}]
let rubricaTab      = 'cliente'
let editingContattoId = null
let contattoLetturaId = null   // FASE 18 — contatto aperto in sola lettura
let rubricaSuggest  = { prefix: null, list: [], hi: -1 }   // stato del menu a tendina

// FASE 17 — le colonne e_cliente / e_fornitore arrivano con SQL_FASE17.sql.
// Se il programma viene aperto prima che la migrazione sia stata lanciata,
// leggerle farebbe fallire l'intera lettura della rubrica. Qui si tiene traccia
// se ci sono: quando mancano, il doppio uso semplicemente non esiste e tutto
// funziona come prima, a categoria singola.
let contattiDoppiaCategoria = true

// ── Caricamento dati di base ─────────────────────────────────────────────────

// I 9 gruppi di costo/ricavo. Tabella condivisa, si carica una volta sola.
async function loadGruppi(force) {
  // La guardia controlla anche che ci sia DENTRO qualcosa: un array vuoto e'
  // «vero» in JavaScript, e prima bastava un tentativo fallito — di solito
  // prima del login, quando la RLS blocca tutto — per lasciare i menu vuoti
  // per il resto della sessione, senza un errore da nessuna parte.
  if (cacheOk('gruppi') && !force) return gruppiCache || []
  // FASE 22 — senza sessione non si legge niente, ma non e' una lettura
  // riuscita: segnarla tale bloccherebbe ogni tentativo dopo il login.
  // Stessa guardia di loadContatti e loadCantieri.
  if (!currentAziendaId) { gruppiCache = gruppiCache || []; return gruppiCache }
  try {
    const { data, error } = await sb
      .from('tm_conta_gruppi')
      .select('codice, nome, esempi, ordine')
      .order('ordine')
    if (error) throw error
    gruppiCache = data || []
    segnaCacheOk('gruppi')
  } catch (e) {
    // Non si segna come riuscita: il prossimo tentativo riprova.
    gruppiCache = gruppiCache || []
    console.warn('Gruppi non caricati:', e.message || e)
  }
  return gruppiCache || []
}

// Opzioni per un menu «gruppo». La voce vuota è esplicita: «nessun gruppo» è
// una scelta legittima, non un campo dimenticato.
function buildGruppoOptions(selected) {
  // Protetto alla fonte, non solo in riempiSelectGruppi: chiunque la chiami
  // deve ottenere un menu che dice la verita', non uno muto.
  if (!gruppiCache || !gruppiCache.length) return opzioneGruppiMancanti()
  var out = '<option value="">— nessun gruppo —</option>'
  ;(gruppiCache || []).forEach(function (g) {
    out += '<option value="' + esc(g.codice) + '"' +
           (g.codice === selected ? ' selected' : '') + '>' +
           esc(g.codice + ' · ' + g.nome) + '</option>'
  })
  return out
}

// Se i gruppi non ci sono, il menu lo DICE. Prima restava con la sola voce
// «— nessun gruppo —»: indistinguibile da un elenco che non si e' caricato,
// e chi lo guardava non aveva modo di capire che era un guasto.
function opzioneGruppiMancanti() {
  return '<option value="">⚠️ Gruppi non caricati — ricarica la pagina</option>'
}

async function riempiSelectGruppi(id, selected) {
  var sel = el(id)
  if (!sel) return                       // l'elemento non c'e' ancora: niente da fare
  // Si aspettano i gruppi invece di uscire in silenzio.
  var g = await loadGruppi()
  if (!g || !g.length) {
    sel.innerHTML = opzioneGruppiMancanti()
    return
  }
  sel.innerHTML = buildGruppoOptions(selected || '')
}

async function loadContatti(force) {
  if (cacheOk('contatti') && !force) return contattiCache || []
  // Senza sessione non si legge niente, ma non e' una lettura riuscita:
  // segnarla tale bloccherebbe ogni tentativo dopo il login.
  if (!currentAziendaId) { contattiCache = []; return contattiCache }
  var campiBase = 'id, categoria, ragione_sociale, nome, cognome, indirizzo, cap, citta, paese,' +
                  ' telefono, email, sito_web, uid_partita_iva, iban, gruppo_default,' +
                  ' giorni_pagamento, note, attivo'
  async function leggi(campi) {
    return await sb
      .from('tm_contatti')
      .select(campi)
      .eq('azienda_id', currentAziendaId)
      .order('ragione_sociale', { nullsFirst: false })
  }
  var res = await leggi(campiBase + ', e_cliente, e_fornitore')
  // Migrazione FASE 17 non ancora lanciata: si rilegge senza le due colonne
  // invece di lasciare la rubrica vuota con un errore incomprensibile.
  if (res.error && /e_cliente|e_fornitore/.test(String(res.error.message || ''))) {
    contattiDoppiaCategoria = false
    res = await leggi(campiBase)
  }
  const { data, error } = res
  if (error) throw error
  contattiCache = data || []
  segnaCacheOk('contatti')
  return contattiCache
}

// Il nome con cui un contatto compare ovunque: ragione sociale se c'è,
// altrimenti cognome + nome. Un contatto senza nessuno dei due non si salva.
function contattoNome(c) {
  if (!c) return ''
  if (c.ragione_sociale) return c.ragione_sociale
  return [c.cognome, c.nome].filter(Boolean).join(' ')
}

// Riga secondaria: località, poi i recapiti. Solo i campi valorizzati.
function contattoSub(c) {
  var parti = []
  if (c.citta) parti.push([c.cap, c.citta].filter(Boolean).join(' '))
  if (c.telefono) parti.push('☎ ' + c.telefono)
  if (c.email) parti.push('✉ ' + c.email)
  if (c.gruppo_default) parti.push('gruppo ' + c.gruppo_default)
  if (c.giorni_pagamento != null) parti.push(c.giorni_pagamento + ' giorni')
  return parti.join(' · ')
}

// FASE 17 — un contatto appartiene a una scheda o per la sua categoria, oppure
// per una delle due spunte di doppio uso. Il doppio uso vale solo per clienti e
// fornitori: e' li' che capita davvero (il fornitore che ogni tanto compra una
// prestazione). Collaboratori e generici restano a categoria singola.
// FASE 18 — in quali schede compare un contatto, scritto a parole. Serve nella
// vista «Tutti», dove categorie diverse stanno una sotto l'altra.
var RUBRICA_ETICHETTE = {
  cliente: 'Cliente', fornitore: 'Fornitore',
  collaboratore: 'Collaboratore', generico: 'Generico'
}

function contattoSchedeTesto(c) {
  if (!c) return ''
  var principale = RUBRICA_ETICHETTE[c.categoria] || 'Generico'
  var extra = []
  if (c.categoria !== 'cliente'   && c.e_cliente   === true) extra.push('anche cliente')
  if (c.categoria !== 'fornitore' && c.e_fornitore === true) extra.push('anche fornitore')
  return extra.length ? principale + ' · ' + extra.join(' · ') : principale
}

function contattoInCategoria(c, cat) {
  if (!c) return false
  if (c.categoria === cat) return true
  if (cat === 'cliente'   && c.e_cliente   === true) return true
  if (cat === 'fornitore' && c.e_fornitore === true) return true
  return false
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 21 / P9 — LA BUSTA
//
// LE ZONE NON SONO INVENTATE. Vengono dalle «Spezifikationen Briefgestaltung
// von A-Z» della Posta Svizzera (edizione luglio 2026), scaricate e lette:
//
//   Frankierzone (affrancatura)  74 x 38 mm, in alto a DESTRA, a filo dei
//                                bordi. Deve restare libera.
//   Codierzone   (codifica)      140 x 15 mm fino al formato B5, 140 x 35 mm
//                                da B5 a B4. In basso a DESTRA, a filo dei
//                                bordi. DEVE restare libera: e' la fascia su
//                                cui stampa la macchina di smistamento.
//   Lesezone     (lettura)       la fascia in mezzo alle due, a filo del bordo
//                                destro: e' li' che va l'indirizzo.
//
// Il blocco indirizzo e' posato DENTRO la zona di lettura con margini larghi.
// La sua distanza esatta dal bordo sinistro non e' un numero della specifica:
// il disegno della Posta e' schematico e non in scala (verificato sui
// rettangoli del PDF). Per questo c'e' la taratura, e per questo c'e' la
// stampa di prova su A4 da appoggiare sopra la busta.
// ══════════════════════════════════════════════════════════════════════════════

// FASE 22 / P6b — i formati europei standard, non piu' solo due.
// La zona di codifica e' 140 x 15 mm fino al formato B5 e 140 x 35 mm da B5 a
// B4 (specifica della Posta, vedi sopra): il C4 e' l'unico di questo elenco a
// superare il B5.
var FORMATI_BUSTA = {
  c6:   { etichetta: 'C6',        larghezza: 162, altezza: 114, codificaH: 15 },
  c56:  { etichetta: 'C5/6 (DL)', larghezza: 220, altezza: 110, codificaH: 15 },
  c5:   { etichetta: 'C5',        larghezza: 229, altezza: 162, codificaH: 15 },
  b5:   { etichetta: 'B5',        larghezza: 250, altezza: 176, codificaH: 15 },
  c4:   { etichetta: 'C4',        larghezza: 324, altezza: 229, codificaH: 35 },
  // Le misure della personalizzata si leggono dai due campi: qui restano
  // vuote apposta, cosi' non c'e' un secondo posto dove possano divergere.
  pers: { etichetta: 'Personalizzata', larghezza: null, altezza: null, codificaH: null }
}

// Zona di affrancatura: uguale su tutti i formati.
var BUSTA_FRANC_W = 74
var BUSTA_FRANC_H = 38
// Zona di codifica: larghezza uguale, altezza secondo il formato.
var BUSTA_CODIF_W = 140

// I limiti della busta personalizzata: sotto il C6 la zona di lettura non ci
// sta, sopra il B4 non e' piu' una busta da lettera.
var BUSTA_PERS_MIN = 90
var BUSTA_PERS_MAX = 353

// ══════════════════════════════════════════════════════════════════════════════
// FASE 23 / P4a — IL MARGINE DI SICUREZZA DAL BORDO
//
// La busta si stampa con @page { margin: 0 }: tutte le misure partono dal
// bordo FISICO del foglio. Ma nessuna stampante stampa fino al bordo — su
// busta la fascia morta e' tipicamente 4-6 mm, e sui supporti spessi anche di
// piu', perche' i rulli devono tenere il foglio.
//
// Il mittente stava a 8 mm da sinistra e 7 dall'alto, ed e' uscito con le
// prime lettere mozzate a meta'. Dieci millimetri lasciano due millimetri di
// aria sopra il minimo richiesto, e sono UN NUMERO SOLO da alzare se una
// stampante si rivelasse peggiore.
// ══════════════════════════════════════════════════════════════════════════════
var BUSTA_MARGINE_SICUREZZA = 10   // mm, quanto sta dentro tutto cio' che si stampa
var BUSTA_MARGINE_MINIMO    = 8    // mm, sotto i quali il controllo protesta

// ══════════════════════════════════════════════════════════════════════════════
// FASE 23 / P1 — COSA SI STAMPA SULLA BUSTA
//
// Umberto compra anche buste gia' intestate, e buste gia' affrancate con i
// WebStamp della Posta, che escono dalla stampante della Posta con mittente,
// logo e francobollo gia' sopra. Ristamparci sopra il mittente fa un pasticcio.
//
// LA REGOLA CHE NON SI TOCCA: il destinatario sta NELLO STESSO PUNTO in tutti
// e tre i modi. E' il senso della funzione — la busta e' gia' stampata, e
// l'indirizzo deve cadere dove cadrebbe comunque, dentro la zona di lettura e
// dentro la finestrella se la busta ne ha una. Non si ricentra e non si sposta
// in alto «perche' tanto c'e' spazio libero».
// ══════════════════════════════════════════════════════════════════════════════
var MODI_BUSTA = [
  { v: 'tutto',      et: 'Tutto: logo + mittente + destinatario' },
  { v: 'senza_logo', et: 'Mittente + destinatario, senza logo' },
  { v: 'solo_dest',  et: 'Solo destinatario (busta gia’ intestata o WebStamp)' }
]

function modoBusta() {
  var v = getVal('busta-modo')
  for (var i = 0; i < MODI_BUSTA.length; i++) if (MODI_BUSTA[i].v === v) return v
  return 'tutto'      // il predefinito resta quello di sempre
}

function etichettaModoBusta() {
  var v = modoBusta()
  for (var i = 0; i < MODI_BUSTA.length; i++) if (MODI_BUSTA[i].v === v) return MODI_BUSTA[i].et
  return MODI_BUSTA[0].et
}

// Un numero per il CSS: punto decimale, mai la virgola di it-IT. Le misure che
// si mostrano all'utente passano da fmtNumIt; queste finiscono in uno style, e
// «38,2mm» il browser non lo capisce.
function fmtMm(n) { return String(Math.round((safeNum(n) || 0) * 10) / 10) }

// ── Quanto e' grande il logo sulla busta, in millimetri ─────────────────────
// Si scrivono ENTRAMBE le misure sull'<img> invece di lasciare width:auto:
// un'immagine di cui non si conoscono ancora le proporzioni con width:auto e'
// larga ZERO, e in stampa lascia un buco. Le proporzioni vere si prendono
// dall'immagine quando c'e'; finche' non c'e' si usa un rapporto tipico, che
// e' comunque meglio di zero.
var BUSTA_LOGO_H = 11          // mm, l'altezza di sempre
var BUSTA_LOGO_RAPPORTO = 3.5  // ripiego: larghezza / altezza

function misureLogoBusta() {
  var r = BUSTA_LOGO_RAPPORTO
  try {
    // Una qualunque immagine del logo gia' caricata nella pagina va bene: la
    // fattura e l'anteprima della busta ne hanno una.
    var imgs = document.querySelectorAll('.busta-logo, .inv-logo')
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].naturalWidth > 0 && imgs[i].naturalHeight > 0) {
        r = imgs[i].naturalWidth / imgs[i].naturalHeight
        break
      }
    }
  } catch (_) { /* si resta sul rapporto di ripiego */ }
  return { h: BUSTA_LOGO_H, l: Math.round(BUSTA_LOGO_H * r * 10) / 10 }
}

function formatoBustaCorrente() {
  var v = getVal('busta-formato') || 'c56'
  return FORMATI_BUSTA[v] ? v : 'c56'
}

// Il formato con le misure gia' risolte. Da usare SEMPRE al posto di
// FORMATI_BUSTA[...]: e' l'unico punto che sa cosa vuol dire «personalizzata».
function formatoBusta() {
  var k = formatoBustaCorrente()
  var f = FORMATI_BUSTA[k]
  if (k !== 'pers') return { chiave: k, etichetta: f.etichetta, larghezza: f.larghezza,
                             altezza: f.altezza, codificaH: f.codificaH }
  var l = safeNum(getVal('busta-pers-l'))
  var h = safeNum(getVal('busta-pers-h'))
  // Senza misure valide si ripiega sul C5, e la stampa lo dice: meglio una
  // busta sbagliata di formato che una busta di 0 x 0 mm.
  if (l == null || h == null || l < BUSTA_PERS_MIN || h < BUSTA_PERS_MIN ||
      l > BUSTA_PERS_MAX || h > BUSTA_PERS_MAX) {
    var c5 = FORMATI_BUSTA.c5
    return { chiave: 'pers', etichetta: 'Personalizzata (misure mancanti — uso il C5)',
             larghezza: c5.larghezza, altezza: c5.altezza, codificaH: c5.codificaH,
             misureMancanti: true }
  }
  return { chiave: 'pers', etichetta: 'Personalizzata ' + fmtNumIt(l) + ' × ' + fmtNumIt(h) + ' mm',
           larghezza: l, altezza: h, codificaH: (l > 250 ? 35 : 15) }
}

// ── FASE 22 / P6c — la dimensione dei caratteri ─────────────────────────────
// Il mittente sta SEMPRE piu' piccolo del destinatario: sono le due misure
// che si scelgono, non una sola, perche' una busta piccola con un indirizzo
// lungo e una busta grande con tre righe non vogliono lo stesso corpo.
var CORPI_DESTINATARIO = [
  { v: '10', et: 'Piccolo (10 pt)' },
  { v: '12', et: 'Normale (12 pt)' },
  { v: '14', et: 'Grande (14 pt)' },
  { v: '16', et: 'Molto grande (16 pt)' }
]
var CORPI_MITTENTE = [
  { v: '7', et: 'Piccolo (7 pt)' },
  { v: '8', et: 'Normale (8 pt)' },
  { v: '9', et: 'Grande (9 pt)' }
]

function corpoDestinatario() {
  var v = getVal('busta-font-dest')
  return safeNum(v) != null ? safeNum(v) : 12
}
function corpoMittente() {
  var v = getVal('busta-font-mitt')
  var n = safeNum(v) != null ? safeNum(v) : 8
  // Il mittente non puo' superare il destinatario: su una busta chi la riceve
  // viene prima di chi la manda.
  return Math.min(n, Math.max(6, corpoDestinatario() - 1))
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 24 — IL LOGO E' DENTRO IL PROGRAMMA, NON PIU' UN INDIRIZZO DA CHIEDERE
//
// I FATTI, misurati e non supposti:
//   - busta e fattura usavano la STESSA espressione (questa funzione): stesso
//     indirizzo, carattere per carattere. Il difetto non era «indirizzi
//     diversi»;
//   - `img/logo.png` sul sito pubblicato risponde 200, image/png, 136 KB. Non
//     e' un 404;
//   - eppure sulla busta il riquadro restava vuoto, e sulla fattura no.
//
// La differenza e' sempre stata il TEMPO. La fattura ha l'immagine nel DOM da
// quando si apre il documento; la busta la ricrea e stampa subito dopo. Se
// l'indirizzo configurato in Impostazioni non risponde, scatta il ripiego su
// `img/logo.png` — un SECONDO scaricamento, che comincia quando la finestra di
// stampa e' gia' aperta. Il riquadro esce con le sue misure e senza contenuto.
//
// La cura non e' aspettare meglio: e' non chiedere niente alla rete.
// Il logo sta qui dentro come data URI (800 x 221 px, ricavato una volta dal
// file pubblicato). Nessuna richiesta, nessun ripiego, nessuna corsa contro
// window.print(). E' largo abbastanza per tutti e due gli usi:
//   busta   38,5 mm  -> a 300 dpi servono 455 px
//   fattura 55,6 mm  -> a 300 dpi servono 657 px
//
// L'ordine delle sorgenti qui sotto NON toglie niente a chi ha configurato un
// logo suo: `logo_url` continua a vincere sull'incorporato. Cambia solo il
// RIPIEGO, che da richiesta di rete diventa un dato gia' in memoria.
// ══════════════════════════════════════════════════════════════════════════════

var LOGO_INCORPORATO = 'data:image/png;base64,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IQiC0ENIQPJDAlL4kIBQSEBIQCTbRcchASEIgtBDSEDyQwJS+JCAUEhASEAk20XHIQEhCILQQ0hA8kMCUviQgFBIQEhAJNtFxyEBIQiC0ENIQPJDAlL4kIBQSEBIQCTbRcchASEIgtBDSEDyQwJS+JCAUEhASEAk20XHIQEhCILQQ0hA8kMCUviQgFBIQEhAJNtFxyEBIQiC0ENIQPJDAlL4kIBQSEBIQCTbRcchASEIgtBDSEDyQwJS+JCAUEhASEAk20XHIQEhCILQQ0hA8kMCUviQgFBIQEhAJNtFxyEBIQiC0ENIQPJDAlL4kIBQSEBIQCTbRcchASEIgtBDSEDyQwJS+JCAUEhASEAk20XHIQEhCILQQ0hA8kMCUviQgFBIQEhAJNtFxyEBIQiC0ENIQPJDAlL4kIBQSEBIQCTbRcchASEIgtBDSEDyQwJS+JCAUEhASEAk20XHIQEhCILQQ0hA8kMCUviQgFBIQEhAJNtFxyEBIQiC0ENIQPJDAlL4kIBQSEBIQCTbRcchASEIgtBDSEDyQwJS+JCAUEhASEAk20XHIQEhCILQQ0hA8kMCUviQgFBIQEhAJNtFxyEBIQiC0ENIQPJDAlL4kIBQSEBIQCTbRcchASEIgtBDSEDyQwJS+JCAUEhASEAk20XHIQEhCILQQ0hA8kMCUviQgFBIQEhAJNtFxyEBIQiC0ENIQPJDAlL4kIBQSEBIQCTbRcchASEIgtBDSEDyQwJS+JCAUEhASEAk20XHIQEhCILQQ0hA8kMCUviQgFBIQEhAJNtFxyEBIQiC0ENIQPJDAlL4kIBQSEBIQCTbRcchASEIgtBDSEDyQwJS+JCAUEhASEAk20XHIQEhCILQQ0hA8kMCUviQgFBIQEhAJNtFxyEBIQiC0ENIQPJDAlL4kIBQSEBIQCTbRcchASEIgtBDSEDyQwJS+JCAUEhASEAk20XHIQEhCILQQ0hA8kMCUviQgFBIQEhAJNtFxyEBIQiC0ENIQPJDAlL4kIBQSEBIQCTbRcchASEIgtBDSEDyQwJS+JCAUEhASEAk20XHIQEhCILQQ0hA8kMCUviQgFBIQEhAJNtFxyEBIQiC0ENIQPJDAlL4kIBQSEBIQCTbRcchASEIgtBDSEDyQwJS+JCAUEhASEAk20XHIQEhCILQQ0hA8kMCUviQgFBIQEhAJNtFxyEBIQiC0ENIQPJDAlL4kIBQSEBIQCTbRcchASEIgtBDSEDyQwJS+JCAUEhASEAk20XHIQEhCILQQ0hA8kMCUviQgFBIQEhAJNtFxyEBIQiC0ENIQPJDAlL4kIBQSEBIQCTbRcchASEIgtBDnkVF/FoQAbnh7ekm/kmxh3Ue/ssEJKYgAsJ+t5r4ZwbFTZ9TI7QkIM3FIgoEa79SJCDFI38JiJP9PfHuLRAvHz/uXJwE5JDV1Ofscf1/4uUVe254ebgYiIAsFKtMEARRvGFvQiX0PYnxr4c4WE35VwG5dd7PS+rvi2nKHZkz8/kclI/3CQjruHtuWI0jIBYSf6/3eRJ+YzxXAWloDn67NqKAdJYq731hv290zdNVSQJi+BEEpGMLCPY48UDqvn5fsrOzexyzmVEsBARfM47YzHzJrqv8P6+zuOaWv6+nvgvI+l4/svew8yul6l8UYa9zX4vdAoIgCO1y98rFcY+DA19Gnjv7MuLcGb3MrQvnXoZ4uSvWs46oZdO673nx/gZsO7cG3707029fuiB5O8Upkf5nWbv4v9o96fec3M65hICw71mx9jo4c7I68sK5N/g3Urelr4m6eP7lFWfHhIXftQPr5vUlrq/wwc7jkVmTIerSOVmkv69kuVKJunT+tfu6lW9t2jQWOrBSt00xjMxq1UC4Dz3Wr8rGx1hEAV778DXoxqmT8k3D+r/3NciQgq8ZuyeOzcHXEEN7XfiY4HvCWfbeYNu5ld5+gGDd8huY174ZXDhyMPn25aJ/D8PHQXRQ4PPHUWHjxO4BQRCE9vDZtfXmyu/bwSLWeV/0bRu9jW2nljBL4kX73cxq1RDmtmsGi7pI30ZxDHaIpdri3di0bgwLv9Xv+1cy7H607djiX+/3wqcxLGAdEcky3xNsv4K0NcVwMqdtk4K/VrDfw9Evqdsx1ODjeZEhvi58TNj9h+8NsyQ/qNGf4HvY/A7NdfIetqBTC1j1UxeI9PdVid0DgiAI7XF6++Ybc1s1ED5hxk+G9DmS04z+EfxkU+pvi2vwDUuqHd4N/o7U3xpEWvL/tPJj24NGPopXPua1oiCvQYYSg35d+IgYyvPXWkfvYTiyN49JWtjZ04li94AgCEJ7MAEJmd+2cbF6Y6VQKBQKhVLwoITYdmwJYb4+SrF7QBAEoT18tm8JX9iuibArytw2jSkUCoVCoXxisWnZABZ1boUjIKli94AgCEJ7MAE5P79NI+WsVg2Us1o3pFAoFAqF8onFqkV9pW2HlsowP58n/x/vD5TEPDIlxgAAAABJRU5ErkJggg=='

function logoAziendaSrc() {
  // 1. Il logo «preparato per la stampa»: un data URI salvato nelle
  //    impostazioni dal bottone in Impostazioni ditta. Vince su tutto perche'
  //    e' quello che Umberto ha scelto E che non ha bisogno della rete.
  var pronto = impostazione('logo_data_uri', '')
  if (pronto && String(pronto).indexOf('data:image') === 0) return pronto
  // 2. L'indirizzo configurato, come prima.
  var a = aziendaInfo || {}
  if (a.logo_url && String(a.logo_url).trim()) return a.logo_url
  // 3. Il ripiego: non piu' 'img/logo.png' (una richiesta di rete che sulla
  //    busta arrivava tardi), ma il logo incorporato qui sopra.
  return LOGO_INCORPORATO || 'img/logo.png'
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 24 — CONGELARE IL LOGO IN UN DATA URI
//
// Serve a chi ha messo un indirizzo suo nel campo Logo (URL): lo si scarica
// UNA VOLTA, lo si rimpicciolisce e lo si salva nelle impostazioni. Da li' in
// poi non c'e' piu' nessuna richiesta di rete al momento di stampare — che era
// la causa del riquadro vuoto sulla busta.
//
// Larghezza massima 800 px: bastano per tutti e due gli usi a 300 dpi (busta
// 38,5 mm -> 455 px; fattura 55,6 mm -> 657 px), e restano poche decine di KB.
// ══════════════════════════════════════════════════════════════════════════════

var LOGO_LARGHEZZA_MAX = 800

function statoLogoPreparato() {
  var d = impostazione('logo_data_uri', '')
  var box = el('imp-logo-stato')
  if (!box) return
  if (d && String(d).indexOf('data:image') === 0) {
    var kb = Math.round(String(d).length / 1024)
    html('imp-logo-stato',
      '<span class="badge badge-ok">✅ Preparato</span> ' +
      '<span class="dim">' + kb + ' KB, dentro le impostazioni. In stampa non serve internet.</span>' +
      '<div style="margin-top:8px"><img src="' + esc(d) + '" alt="Logo preparato" ' +
        'style="height:44px;width:auto;border:1px solid var(--border);border-radius:4px;' +
        'background:#fff;padding:4px"></div>')
  } else {
    html('imp-logo-stato',
      '<span class="badge badge-info">Non preparato</span> ' +
      '<span class="dim">Si usa il logo incorporato nel programma, che va bene lo stesso.</span>')
  }
}

async function preparaLogoPerStampa() {
  var btn = el('imp-logo-prep-btn')
  var indirizzo = getVal('imp-logo')
  if (!indirizzo) {
    showFattureBanner('impostazioni-banner', 'warn',
      'Non c’è nessun indirizzo nel campo Logo (URL): non c’è niente da preparare. ' +
      'Il programma usa già il logo che ha dentro di sé.')
    return
  }
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Preparo…' }
  try {
    var img = await new Promise(function (risolvi, rifiuta) {
      var i = new Image()
      // Senza questo il canvas si «sporca» e toDataURL viene rifiutato dal
      // browser: e' la regola di sicurezza sulle immagini di un altro sito.
      i.crossOrigin = 'anonymous'
      i.onload = function () { risolvi(i) }
      i.onerror = function () { rifiuta(new Error('non risponde')) }
      i.src = indirizzo
    })
    if (!img.naturalWidth) throw new Error('immagine vuota')

    var l = Math.min(img.naturalWidth, LOGO_LARGHEZZA_MAX)
    var h = Math.round(l * img.naturalHeight / img.naturalWidth)
    var canvas = document.createElement('canvas')
    canvas.width = l; canvas.height = h
    canvas.getContext('2d').drawImage(img, 0, 0, l, h)
    // PNG e non JPEG: il logo puo' avere il fondo trasparente, e il JPEG lo
    // riempirebbe di nero.
    var dati = canvas.toDataURL('image/png')

    await salvaImpostazioneConta('logo_data_uri', dati,
      'Logo gia pronto per la stampa (data URI): evita di chiederlo alla rete mentre si stampa')
    statoLogoPreparato()
    showFattureBanner('impostazioni-banner', 'ok',
      'Logo preparato: ' + l + ' × ' + h + ' px, ' + Math.round(dati.length / 1024) +
      ' KB. Da adesso fattura e busta lo stampano senza chiedere niente a internet.')
  } catch (e) {
    console.error('Preparazione logo:', e)
    showFattureBanner('impostazioni-banner', 'err',
      'Non sono riuscito a preparare il logo da «' + indirizzo + '»: ' +
      (e.message === 'non risponde'
        ? 'quell’indirizzo non risponde, oppure il sito che lo ospita non ne permette la copia.'
        : (e.message || e)) +
      ' Controlla l’indirizzo, oppure lascialo vuoto: il programma ha già il suo logo dentro.')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🖼️ Prepara il logo per la stampa' }
  }
}

async function togliLogoPreparato() {
  try {
    await salvaImpostazioneConta('logo_data_uri', '',
      'Logo preparato per la stampa: tolto')
    statoLogoPreparato()
    showFattureBanner('impostazioni-banner', 'ok',
      'Logo preparato tolto. Si torna all’indirizzo configurato, o al logo incorporato.')
  } catch (e) {
    showFattureBanner('impostazioni-banner', 'err', 'Non tolto: ' + (e.message || e))
  }
}

// FASE 22 / P6a — il logo sulla busta c'era gia', ma quando non si caricava
// spariva in silenzio (logoOnError lo nasconde). Su una busta e' la prima cosa
// che si vede: se manca, si dice perche'.
function bustaLogoOnError(img) {
  logoOnError(img)
  if (img && img.style.display === 'none') {
    showFattureBanner('busta-banner', 'warn',
      'Il logo non si carica: l’indirizzo scritto in Impostazioni ditta → Logo (URL) non ' +
      'risponde, e img/logo.png non c’è. La busta si stampa lo stesso, col solo mittente.')
  }
}

// L'indirizzo come va su una busta: via, NPA e localita', e il paese solo se
// non e' la Svizzera. Su una lettera interna il paese non si scrive.
function indirizzoPerBusta(x) {
  if (!x) return ''
  var righe = []
  if (x.indirizzo) righe.push(String(x.indirizzo).trim())
  var citta = unisciParti([x.cap, x.citta], ' ')
  if (citta) righe.push(citta)
  var p = String(x.paese || '').trim().toUpperCase()
  if (p && p !== 'CH') righe.push(paeseValido(p) ? nomePaese(p).toUpperCase() : p)
  return righe.join('\n')
}

async function initBustaPage() {
  await loadAziendaInfo()
  await loadImpostazioniConta()
  caricaPreferenzeBusta()
  caricaTaraturaBusta()
  onAffrancaturaChange()
  disegnaBusta()
}

// Le due chiavi della taratura, una coppia per formato.
function chiaviTaraturaBusta(formato) {
  return { x: 'busta_off_x_' + formato, y: 'busta_off_y_' + formato }
}

// Gli scostamenti sono PER FORMATO: cambiando formato si ricaricano.
function caricaTaraturaBusta() {
  var k = chiaviTaraturaBusta(formatoBustaCorrente())
  if (el('busta-off-x')) el('busta-off-x').value = impostazione(k.x, '0')
  if (el('busta-off-y')) el('busta-off-y').value = impostazione(k.y, '0')
  mostraCampiPersonalizzata()
}

// FASE 22 — i corpi dei caratteri e le misure della personalizzata NON sono
// per formato: si caricano una volta sola, all'apertura della pagina.
// Rileggerli a ogni cambio di formato cancellerebbe quello che si e' appena
// scelto senza salvare.
function caricaPreferenzeBusta() {
  if (el('busta-pers-l')) el('busta-pers-l').value = impostazione('busta_pers_l', '229')
  if (el('busta-pers-h')) el('busta-pers-h').value = impostazione('busta_pers_h', '162')
  if (el('busta-font-dest')) el('busta-font-dest').value = impostazione('busta_font_dest', '12')
  if (el('busta-font-mitt')) el('busta-font-mitt').value = impostazione('busta_font_mitt', '8')
  // FASE 23 — cosa si stampa: vale per tutti i formati, come i caratteri.
  if (el('busta-modo')) el('busta-modo').value = impostazione('busta_modo', 'tutto')
  onModoBustaChange()
}

// I due campi delle misure si vedono solo quando servono.
function mostraCampiPersonalizzata() {
  var g = el('busta-pers-group')
  if (g) g.style.display = formatoBustaCorrente() === 'pers' ? 'block' : 'none'
}

async function salvaTaraturaBusta() {
  var k = chiaviTaraturaBusta(formatoBustaCorrente())
  var f = formatoBusta()
  try {
    await salvaImpostazioneConta(k.x, safeNum(getVal('busta-off-x')) || 0,
      'Taratura busta ' + f.etichetta + ': scostamento orizzontale in mm')
    await salvaImpostazioneConta(k.y, safeNum(getVal('busta-off-y')) || 0,
      'Taratura busta ' + f.etichetta + ': scostamento verticale in mm')
    // FASE 22 — corpi dei caratteri e misure personalizzate, salvati insieme
    // alla taratura: sono la stessa regolazione della stessa busta.
    await salvaImpostazioneConta('busta_font_dest', corpoDestinatario(),
      'Busta: corpo del destinatario in punti')
    await salvaImpostazioneConta('busta_font_mitt', corpoMittente(),
      'Busta: corpo del mittente in punti')
    await salvaImpostazioneConta('busta_modo', modoBusta(),
      'Busta: cosa si stampa (tutto / senza_logo / solo_dest)')
    if (formatoBustaCorrente() === 'pers') {
      await salvaImpostazioneConta('busta_pers_l', safeNum(getVal('busta-pers-l')) || 0,
        'Busta personalizzata: larghezza in mm')
      await salvaImpostazioneConta('busta_pers_h', safeNum(getVal('busta-pers-h')) || 0,
        'Busta personalizzata: altezza in mm')
    }
    html('busta-banner',
      '<div class="fase-banner ok" role="status"><span class="icon" aria-hidden="true">✅</span>' +
      '<div class="msg">Salvati per il formato ' + esc(f.etichetta) +
        ': taratura, caratteri e il modo «' + esc(etichettaModoBusta()) + '».</div></div>')
  } catch (e) {
    html('busta-banner',
      '<div class="fase-banner err" role="alert"><span class="icon" aria-hidden="true">❌</span>' +
      '<div class="msg">Taratura non salvata: ' + esc(e.message || e) + '</div></div>')
  }
}

function onFormatoBustaChange() {
  caricaTaraturaBusta()      // solo gli scostamenti: sono l'unica cosa per formato
  disegnaBusta()
}

function onAffrancaturaChange() {
  var digital = getVal('busta-affrancatura') === 'digital'
  var g = el('busta-digital-group')
  if (g) g.style.display = (digital && modoBusta() !== 'solo_dest') ? 'block' : 'none'
  disegnaBusta()
}

// FASE 23 / P1 — cambiando modo si nasconde quello che non verra' stampato:
// compilare un campo che non finisce sulla busta e' un invito a sbagliare.
function onModoBustaChange() {
  var soloDest = modoBusta() === 'solo_dest'
  var ga = el('busta-affrancatura-group')
  if (ga) ga.style.display = soloDest ? 'none' : 'block'
  onAffrancaturaChange()      // rivaluta anche il campo del codice, poi ridisegna
}

// Il contenuto della busta, in millimetri. Lo stesso HTML serve per
// l'anteprima a schermo e per la stampa: una cosa sola, che non puo' divergere.
function bustaHtml(conGuide) {
  var f = formatoBusta()
  var offX = safeNum(getVal('busta-off-x')) || 0
  var offY = safeNum(getVal('busta-off-y')) || 0
  var a = aziendaInfo || {}
  var modo = modoBusta()
  var conLogo = modo === 'tutto'
  var conMitt = modo !== 'solo_dest'

  // Mittente in alto a sinistra: se una lettera torna indietro, la Posta deve
  // sapere a chi renderla senza doverla aprire.
  var mitt = unisciParti([
    a.nome || aziendaNome(),
    a.indirizzo,
    unisciParti([a.cap, a.citta], ' ')
  ], '\n')

  var logo = logoAziendaSrc()

  var nome = getVal('busta-nome')
  var indirizzo = el('busta-indirizzo') ? el('busta-indirizzo').value : ''
  var destinatario = unisciParti([nome, indirizzo], '\n')

  var digital = getVal('busta-affrancatura') === 'digital'
  var codice = getVal('busta-digital')

  // Il blocco indirizzo sta dentro la zona di lettura: sotto l'affrancatura
  // (38 mm dall'alto) e sopra la zona di codifica.
  var indTop  = BUSTA_FRANC_H + 8
  var indLeft = Math.round(f.larghezza * 0.45)
  var indMaxH = f.altezza - indTop - f.codificaH - 4

  var guide = conGuide
    ? '<div class="bz bz-franc" style="width:' + BUSTA_FRANC_W + 'mm;height:' + BUSTA_FRANC_H + 'mm">' +
        '<span>zona affrancatura 74 × 38 — libera</span></div>' +
      '<div class="bz bz-codif" style="width:' + BUSTA_CODIF_W + 'mm;height:' + f.codificaH + 'mm">' +
        '<span>zona di codifica ' + BUSTA_CODIF_W + ' × ' + f.codificaH + ' — DEVE restare libera</span></div>' +
      '<div class="bz bz-lettura" style="top:' + BUSTA_FRANC_H + 'mm;bottom:' + f.codificaH + 'mm">' +
        '<span>zona di lettura</span></div>'
    : ''

  // FASE 23 / P4a — IL MARGINE DI SICUREZZA.
  // La busta si stampa con @page { margin: 0 }, quindi queste misure partono
  // dal bordo FISICO del foglio. Nessuna stampante stampa fino al bordo: su
  // busta il margine morto e' tipicamente 4-6 mm e sui supporti spessi di piu'.
  // Il mittente stava a 8 mm da sinistra e 7 dall'alto: le prime lettere
  // finivano dentro quella fascia e uscivano mozzate a meta'.
  //
  // NON si risolve con la taratura: quella sposta l'INTERA busta e sposterebbe
  // anche il destinatario, che invece cade giusto. E' il blocco mittente che
  // va messo piu' dentro.
  var mL = BUSTA_MARGINE_SICUREZZA
  var ml = misureLogoBusta()
  var mittHtml = conMitt
    ? '<div class="busta-mitt" style="left:' + mL + 'mm;top:' + mL + 'mm;' +
           'max-width:' + Math.max(60, Math.round(f.larghezza * 0.5)) + 'mm">' +
        (conLogo
          // FASE 23 / P4b — le misure del logo scritte QUI, in millimetri.
          // Con height+width:auto un'immagine non ancora caricata e' larga
          // ZERO, e in stampa esce un buco: e' esattamente quello che
          // succedeva. Scrivendo le due misure il posto e' giusto comunque.
          ? '<img src="' + esc(logo) + '" alt="" class="busta-logo"' +
              ' style="width:' + fmtMm(ml.l) + 'mm;height:' + fmtMm(ml.h) + 'mm"' +
              ' onerror="bustaLogoOnError(this)">'
          : '') +
        '<div class="busta-mitt-testo" style="font-size:' + corpoMittente() + 'pt">' +
          esc(mitt) + '</div>' +
      '</div>'
    : ''

  return '<div class="busta busta-' + formatoBustaCorrente() + '"' +
           ' style="width:' + f.larghezza + 'mm;height:' + f.altezza + 'mm">' +
           '<div class="busta-contenuto" style="transform:translate(' + offX + 'mm,' + offY + 'mm)">' +
             guide +
             mittHtml +
             (conMitt && digital && codice
               ? '<div class="busta-digital" style="width:' + BUSTA_FRANC_W + 'mm;' +
                      'right:' + mL + 'mm;top:' + mL + 'mm;height:' +
                      (BUSTA_FRANC_H - mL) + 'mm">' +
                   '<div class="busta-digital-et">DigitalStamp</div>' +
                   '<div class="busta-digital-cod">' + esc(codice) + '</div>' +
                 '</div>'
               : '') +
             // max-height NON taglia piu' il testo: se sborda si deve VEDERE
             // che sborda, sia in anteprima sia nel controllo. A tagliarlo di
             // nascosto si stampa una busta senza il numero civico.
             '<div class="busta-dest" style="left:' + indLeft + 'mm;top:' + indTop + 'mm;' +
                  'font-size:' + corpoDestinatario() + 'pt">' +
               esc(destinatario || 'Destinatario da compilare') +
             '</div>' +
           '</div>' +
         '</div>'
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 22 / P6c — L'INDIRIZZO CHE SBORDA
//
// Con i caratteri grandi, o un indirizzo lungo, o una busta piccola, il blocco
// del destinatario esce dalla zona di lettura e finisce nella zona di codifica
// — quella che la macchina di smistamento della Posta usa per stampare. Li'
// dentro non ci deve andare niente.
//
// Prima il blocco aveva max-height con overflow:hidden: il testo in piu' non
// si vedeva, ma spariva anche dalla stampa. Una busta senza numero civico e'
// peggio di una busta che non si stampa.
//
// La misura si prende dall'anteprima, che e' la stessa busta rimpicciolita:
// si converte da pixel a millimetri usando la larghezza, che in mm la sappiamo.
// Cosi' non serve conoscere ne' la scala ne' i DPI dello schermo.
// ══════════════════════════════════════════════════════════════════════════════
function verificaIndirizzoBusta() {
  try {
    var wrap = el('busta-anteprima-wrap')
    if (!wrap) return null
    var bustaEl = wrap.querySelector('.busta')
    var destEl  = wrap.querySelector('.busta-dest')
    if (!bustaEl || !destEl) return null

    var rb = bustaEl.getBoundingClientRect()
    var rd = destEl.getBoundingClientRect()
    if (!rb.width) return null

    var f = formatoBusta()
    var mmPerPx = f.larghezza / rb.width          // la scala, qualunque sia

    var indTop   = BUSTA_FRANC_H + 8
    var altezzaMm = rd.height * mmPerPx
    var bassoMm   = indTop + altezzaMm            // dove finisce, dall'alto
    var limiteMm  = f.altezza - f.codificaH - 4   // dove comincia il vietato
    var destraMm  = (rd.right - rb.left) * mmPerPx

    // Un millimetro di tolleranza: la misura viene da pixel dello schermo
    // riportati in millimetri, e mezzo pixel di arrotondamento non e' un
    // motivo per rifiutare una busta che in realta' ci sta.
    var TOLLERANZA = 1
    var MARGINE_DESTRO = 3    // spazio da lasciare fra testo e bordo

    var problemi = []
    // Il consiglio finale cambia col problema: «usa caratteri piu' piccoli»
    // non serve a niente se il difetto e' che qualcosa sta troppo al bordo.
    var soloMargine = true
    if (bassoMm > limiteMm + TOLLERANZA) {
      soloMargine = false
      problemi.push('l’indirizzo scende ' + fmtNumIt(Math.round((bassoMm - limiteMm) * 10) / 10) +
                    ' mm dentro la zona di codifica, che deve restare libera')
    }
    if (destraMm > f.larghezza - MARGINE_DESTRO + TOLLERANZA) {
      soloMargine = false
      var restano = Math.round((f.larghezza - destraMm) * 10) / 10
      problemi.push(restano < 0
        ? 'l’indirizzo esce di ' + fmtNumIt(-restano) + ' mm dal bordo destro della busta'
        : 'l’indirizzo arriva a ' + fmtNumIt(restano) + ' mm dal bordo destro: ne servono almeno ' +
          MARGINE_DESTRO)
    }

    // FASE 23 / P4a — il margine dal bordo fisico, per TUTTO quello che si
    // stampa: e' la fascia che la stampante non raggiunge, ed e' li' che il
    // mittente e' uscito tagliato. Si misura sul disegno vero, non sui numeri
    // che abbiamo scritto: se una regola CSS spostasse qualcosa, il controllo
    // se ne accorgerebbe lo stesso.
    var pezzi = bustaEl.querySelectorAll('.busta-mitt, .busta-dest, .busta-digital')
    var nomi = { 'busta-mitt': 'il mittente', 'busta-dest': 'l’indirizzo',
                 'busta-digital': 'il codice DigitalStamp' }
    var giaDetto = {}
    for (var i = 0; i < pezzi.length; i++) {
      var r = pezzi[i].getBoundingClientRect()
      if (!r.width || !r.height) continue
      var cls = pezzi[i].className.split(' ')[0]
      var nome = nomi[cls] || 'un elemento'
      var sinistraMm = (r.left - rb.left) * mmPerPx
      var altoMm     = (r.top  - rb.top)  * mmPerPx
      var vicini = []
      if (sinistraMm < BUSTA_MARGINE_MINIMO - TOLLERANZA) {
        vicini.push('a ' + fmtNumIt(Math.round(sinistraMm * 10) / 10) + ' mm dal bordo sinistro')
      }
      if (altoMm < BUSTA_MARGINE_MINIMO - TOLLERANZA) {
        vicini.push('a ' + fmtNumIt(Math.round(altoMm * 10) / 10) + ' mm dal bordo superiore')
      }
      if (vicini.length && !giaDetto[cls]) {
        giaDetto[cls] = true
        soloMargine = soloMargine && true
        problemi.push(nome + ' finisce ' + vicini.join(' e ') +
                      ': sotto gli ' + BUSTA_MARGINE_MINIMO +
                      ' mm la stampante non arriva e il testo esce mozzato')
      }
    }
    if (!problemi.length) return null
    return 'Così com’è, ' + problemi.join('; ') + '. ' + (soloMargine
      ? 'Ho già messo tutto a ' + BUSTA_MARGINE_SICUREZZA + ' mm dal bordo: se compare ' +
        'questo avviso, qualcosa lo sta spostando. Segnalalo invece di stampare.'
      : 'Scegli un corpo più piccolo, accorcia l’indirizzo ' +
        'o passa a un formato di busta più grande.')
  } catch (e) {
    console.warn('Controllo sbordo busta:', e.message || e)
    return null   // un controllo che non riesce non deve impedire di stampare
  }
}

function disegnaBusta() {
  if (!el('busta-foglio')) return
  html('busta-foglio', bustaHtml(false))
  // L'anteprima e' la stessa busta rimpicciolita: se le due divergessero,
  // quella a schermo non varrebbe niente.
  html('busta-anteprima-wrap',
    '<div class="busta-scala">' + bustaHtml(true) + '</div>')
  // Il controllo si fa a ogni ridisegno, cosi' l'avviso compare mentre si
  // scrive l'indirizzo e non solo quando si preme Stampa. Ha un posto suo e
  // non il banner generale: li' ci scrivono anche il logo e la taratura, e si
  // cancellerebbero a vicenda.
  var problema = verificaIndirizzoBusta()
  var f = formatoBusta()
  if (problema) showFattureBanner('busta-avviso-indirizzo', 'warn', problema)
  else if (f.misureMancanti) {
    showFattureBanner('busta-avviso-indirizzo', 'warn',
      'Scrivi larghezza e altezza della busta personalizzata (fra ' + BUSTA_PERS_MIN +
      ' e ' + BUSTA_PERS_MAX + ' mm). Intanto sto disegnando un C5.')
  } else {
    html('busta-avviso-indirizzo', '')
  }
}

// Il foglio A4, per la prova. Se la busta ci sta per il lungo si stampa
// verticale, altrimenti orizzontale.
var A4_CORTO = 210
var A4_LUNGO = 297

// Come esce la prova su A4: il verso, e di quanto la busta sborda dal foglio.
// FASE 22 — il C4 (324 mm) non entra in un A4 nemmeno per il lungo: prima si
// stampava lo stesso, tagliato, e sembrava una prova valida.
function provaSuA4(f) {
  if (f.larghezza <= A4_CORTO && f.altezza <= A4_LUNGO) {
    return { verso: 'portrait', fogliaL: A4_CORTO, fogliaH: A4_LUNGO }
  }
  return { verso: 'landscape', fogliaL: A4_LUNGO, fogliaH: A4_CORTO }
}

// La misura del foglio si decide qui e non nel CSS fisso: cambia con il
// formato scelto, e la stampa di prova esce su A4.
function impostaPaginaBusta(perProva) {
  var f = formatoBusta()
  var st = el('busta-page-style')
  if (!st) return
  st.textContent = perProva
    ? '@media print { @page { size: A4 ' + provaSuA4(f).verso + '; margin: 0; } }'
    : '@media print { @page { size: ' + f.larghezza + 'mm ' + f.altezza + 'mm; margin: 0; } }'
}

// FASE 23 — e finita la stampa lo si svuota.
// Quel tag arriva DOPO il <link> del CSS, quindi il suo @page vince su quello
// della fattura (A4 con i margini). Non svuotandolo, dopo aver stampato una
// busta la fattura successiva usciva sul formato della busta — e a nessuno
// sarebbe venuto in mente di collegare le due cose.
function azzeraPaginaBusta() {
  var st = el('busta-page-style')
  if (st) st.textContent = ''
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 23 / P4b — PERCHE' IL LOGO NON USCIVA
//
// La spiegazione data la volta scorsa («l'immagine non si carica») era
// sbagliata: sulla fattura lo stesso logo, dalla stessa sorgente, si stampa
// benissimo. La differenza non e' l'indirizzo dell'immagine, e' IL MOMENTO.
//
//   fattura: l'<img> nasce quando si apre il documento (renderFatturaPrint), e
//            window.print() arriva quando Umberto preme il bottone — secondi o
//            minuti dopo. Il browser ha avuto tutto il tempo.
//   busta:   stampaBusta() rifaceva l'HTML e chiamava window.print() SETTE
//            RIGHE DOPO, nello stesso tick. L'<img> era appena nato, e con
//            height + width:auto un'immagine senza proporzioni note e' larga
//            ZERO. In stampa restava un buco.
//
// Due rimedi, tutti e due necessari: le misure scritte in millimetri (in
// bustaHtml) e questa attesa. Il modello e' preparaPolizzaPerStampa, che gia'
// aspetta l'immagine della polizza prima di stampare.
//
// Se l'attesa scade SI STAMPA LO STESSO: una busta senza logo si spedisce, una
// busta non stampata no.
// ══════════════════════════════════════════════════════════════════════════════
function attendiImmagini(contenitore, msMax) {
  var el0 = typeof contenitore === 'string' ? el(contenitore) : contenitore
  if (!el0) return Promise.resolve(true)
  var imgs = Array.prototype.slice.call(el0.querySelectorAll('img'))
  if (!imgs.length) return Promise.resolve(true)

  var attese = imgs.map(function (img) {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve(true)
    // decode() aspetta anche la DECODIFICA, non solo lo scaricamento: e' la
    // differenza fra «il file c'e'» e «il browser sa quanto e' larga».
    if (img.decode) return img.decode().then(function () { return true },
                                             function () { return false })
    return new Promise(function (risolvi) {
      img.onload  = function () { risolvi(true) }
      img.onerror = function () { risolvi(false) }
    })
  })

  var scaduto = new Promise(function (risolvi) {
    setTimeout(function () { risolvi(false) }, msMax || 2000)
  })
  return Promise.race([
    Promise.all(attese).then(function (esiti) {
      return esiti.every(function (x) { return x })
    }),
    scaduto
  ])
}

async function stampaBusta() {
  // FASE 22 — se l'indirizzo sborda in una zona vietata non si stampa storto:
  // si dice cosa non va e si lascia correggere.
  var problema = verificaIndirizzoBusta()
  if (problema) {
    showFattureBanner('busta-banner', 'err', 'Non stampo: ' + problema)
    var av = el('busta-avviso-indirizzo')
    if (av) av.scrollIntoView({ block: 'center' })
    return
  }
  impostaPaginaBusta(false)
  html('busta-foglio', bustaHtml(false))
  document.body.classList.add('stampa-busta')
  var pulisci = function () {
    document.body.classList.remove('stampa-busta')
    azzeraPaginaBusta()
    window.removeEventListener('afterprint', pulisci)
  }
  window.addEventListener('afterprint', pulisci)
  var pronte = await attendiImmagini('busta-foglio', 2000)
  if (!pronte) {
    showFattureBanner('busta-banner', 'warn',
      'Il logo non è arrivato in tempo: la busta si stampa lo stesso, ma potrebbe uscire ' +
      'senza. Se ti serve, chiudi la finestra di stampa e riprova fra un momento.')
  }
  window.print()
  setTimeout(pulisci, 60000)
}

// La prova: su A4 normale, col contorno della busta e i riquadri delle zone.
// Si appoggia il foglio sopra la busta in controluce e si vede di quanto
// spostare. Cosi' non si sprecano buste per tarare.
async function stampaProvaBusta() {
  impostaPaginaBusta(true)
  var f = formatoBusta()
  var p = provaSuA4(f)
  var fuoriL = Math.round((f.larghezza - p.fogliaL) * 10) / 10
  var fuoriH = Math.round((f.altezza - p.fogliaH) * 10) / 10
  var avviso = ''
  if (fuoriL > 0 || fuoriH > 0) {
    var pezzi = []
    if (fuoriL > 0) pezzi.push(fmtNumIt(fuoriL) + ' mm a destra')
    if (fuoriH > 0) pezzi.push(fmtNumIt(fuoriH) + ' mm in basso')
    avviso = '<div class="busta-prova-avviso">⚠️ Attenzione: il formato ' +
      esc(f.etichetta) + ' è più grande di un foglio A4. Il contorno esce dal foglio di ' +
      pezzi.join(' e ') + ': quella parte non viene stampata. Il blocco ' +
      'dell’indirizzo però ci sta, ed è quello che serve per tarare — allinea ' +
      'l’angolo in alto a sinistra del foglio con quello della busta.</div>'
  }
  html('busta-foglio',
    '<div class="busta-prova-nota">Prova di taratura — formato ' +
      esc(f.etichetta) + ', modo «' + esc(etichettaModoBusta()) + '»' +
      '. Appoggia questo foglio sopra la busta, in controluce, e correggi gli ' +
      'scostamenti finché il contorno combacia. Il contorno e i riquadri delle ' +
      'zone si stampano solo qui: sulla busta vera non ci vanno.</div>' +
    avviso +
    bustaHtml(true))
  document.body.classList.add('stampa-busta', 'stampa-busta-prova')
  var pulisci = function () {
    document.body.classList.remove('stampa-busta', 'stampa-busta-prova')
    azzeraPaginaBusta()
    disegnaBusta()
    window.removeEventListener('afterprint', pulisci)
  }
  window.addEventListener('afterprint', pulisci)
  // FASE 23 — anche qui si aspetta il logo: la prova serve a tarare, e una
  // prova senza logo non e' la busta che uscira'.
  await attendiImmagini('busta-foglio', 2000)
  window.print()
  setTimeout(pulisci, 60000)
}

// Le due porte d'ingresso: dal documento e dalla rubrica.
async function apriBustaDaFattura(id) {
  var f = (currentDetailFattura && currentDetailFattura.id === id) ? currentDetailFattura : null
  showPage('busta')
  await initBustaPage()
  if (f) {
    if (el('busta-nome')) el('busta-nome').value = f.cliente_nome || ''
    if (el('busta-indirizzo')) {
      var righe = [f.cliente_indirizzo || '']
      var p = String(f.cliente_paese || '').trim().toUpperCase()
      if (p && p !== 'CH') righe.push(paeseValido(p) ? nomePaese(p).toUpperCase() : p)
      el('busta-indirizzo').value = unisciParti(righe, '\n')
    }
    if (el('busta-contatto-id')) el('busta-contatto-id').value = f.contatto_id || ''
    html('busta-contatto-legato', '')
  }
  disegnaBusta()
}

async function apriBustaDaContatto(id) {
  var c = (contattiCache || []).filter(function (x) { return x.id === id })[0]
  showPage('busta')
  await initBustaPage()
  if (c) {
    if (el('busta-nome')) el('busta-nome').value = contattoNome(c)
    if (el('busta-indirizzo')) el('busta-indirizzo').value = indirizzoPerBusta(c)
    if (el('busta-contatto-id')) el('busta-contatto-id').value = c.id
    renderContattoLegato('b', c, null)
  }
  disegnaBusta()
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 21 / P8 — IL FOGLIO DEI CODICI
//
// Un foglio solo, da stampare e tenere sul tavolo mentre si classifica: il
// piano dei conti e i nove gruppi. Si legge dai dati veri, non da un elenco
// scritto qui dentro: un elenco scritto nel codice il giorno dopo e' gia'
// vecchio, e nessuno se ne accorge finche' non sbaglia una classificazione.
// ══════════════════════════════════════════════════════════════════════════════

async function initCodiciPage(force) {
  html('codici-foglio', loadingRow('Lettura di conti e gruppi…'))
  try {
    await ensureContiIva(force)
    await loadGruppi(force)
    html('codici-foglio', foglioCodiciHtml())
  } catch (e) {
    html('codici-foglio',
      '<div class="fase-banner err" role="alert">' +
        '<span class="icon" aria-hidden="true">\u274c</span>' +
        '<div class="msg">Elenco non caricato: ' + esc(e.message || e) +
          '. Ricarica la pagina e riprova.</div>' +
      '</div>')
  }
}

function foglioCodiciHtml() {
  var conti  = contiCache || []
  var gruppi = gruppiCache || []

  // Lo stesso ordine che si vede classificando: prima i conti propri, poi il
  // pacchetto CH, e dentro ciascun blocco per numero di conto. Un foglio che
  // ordina in un altro modo costringe a cercare due volte.
  var propri    = conti.filter(function (c) { return c.azienda_id != null })
  var pacchetto = conti.filter(function (c) { return c.azienda_id == null })

  function righeConti(list) {
    return list.map(function (c) {
      return '<tr>' +
               '<td class="cod-num">' + esc(String(c.codice_conto)) + '</td>' +
               '<td>' + esc(c.descrizione || '') + '</td>' +
             '</tr>'
    }).join('')
  }

  function blocco(titolo, list) {
    if (!list.length) return ''
    return '<h3 class="cod-sottotitolo">' + esc(titolo) +
             ' <span class="cod-quanti">(' + list.length + ')</span></h3>' +
           '<table class="cod-tabella">' +
             '<thead><tr><th class="cod-num">Conto</th><th>Descrizione</th></tr></thead>' +
             '<tbody>' + righeConti(list) + '</tbody>' +
           '</table>'
  }

  var contiHtml = (propri.length || pacchetto.length)
    ? blocco('I miei conti', propri) + blocco('Pacchetto CH', pacchetto)
    : '<div class="dim">Piano dei conti non disponibile: rientra e riprova.</div>'

  var gruppiHtml = gruppi.length
    ? '<table class="cod-tabella">' +
        '<thead><tr><th class="cod-num">Gruppo</th><th>Significato</th></tr></thead>' +
        '<tbody>' + gruppi.map(function (g) {
          return '<tr>' +
                   '<td class="cod-num">' + esc(g.codice) + '</td>' +
                   '<td><strong>' + esc(g.nome || '') + '</strong>' +
                     (g.esempi ? '<br><span class="cod-esempi">' + esc(g.esempi) + '</span>' : '') +
                   '</td>' +
                 '</tr>'
        }).join('') + '</tbody>' +
      '</table>'
    : '<div class="dim">Gruppi non disponibili: rientra e riprova.</div>'

  // Intestazione: chi e quando. Su un foglio stampato senza data non si sa se
  // e' quello di oggi o quello dell'anno scorso.
  var a = aziendaInfo || {}
  return '<div class="cod-foglio">' +
           '<div class="cod-testata">' +
             '<div class="cod-ditta">' + esc(a.nome || aziendaNome() || '') + '</div>' +
             '<div class="cod-titolo">Elenco dei codici</div>' +
             '<div class="cod-data">Stampato il ' + esc(fmtDate(oggiISO())) + '</div>' +
           '</div>' +
           '<h2 class="cod-sezione">Piano dei conti</h2>' +
           contiHtml +
           '<h2 class="cod-sezione">I nove gruppi di costo e ricavo</h2>' +
           gruppiHtml +
         '</div>'
}

function stampaElencoCodici() {
  window.print()
}

// ── Pagina Rubrica ───────────────────────────────────────────────────────────

async function initRubricaPage() {
  if (!currentAziendaId) {
    showRubricaBanner('err', 'Azienda non trovata: rieffettua il login.')
    return
  }
  mostraRubricaVista('lista')
  html('rubrica-table', loadingRow('Caricamento rubrica…'))
  try {
    await loadGruppi()
    await loadContatti(true)
    renderContattiList()
  } catch (e) {
    html('rubrica-table', '')
    showRubricaBanner('err', 'Rubrica non caricata: ' + (e.message || e))
  }
}

function showRubricaBanner(tipo, msg) {
  var icona = tipo === 'ok' ? '✅' : tipo === 'warn' ? '⚠️' : '❌'
  html('rubrica-banner',
    '<div class="fase-banner ' + tipo + '" role="' + (tipo === 'ok' ? 'status' : 'alert') + '">' +
      '<span class="icon" aria-hidden="true">' + icona + '</span>' +
      '<div class="msg">' + esc(msg) + '</div>' +
    '</div>')
}

function mostraRubricaVista(quale) {
  registraVista('rubrica', quale)
  var lista   = el('rubrica-lista-view')
  var lettura = el('rubrica-lettura-view')   // FASE 18 — sola lettura
  var scheda  = el('rubrica-scheda-view')
  if (lista)   lista.style.display   = (quale === 'lista')   ? 'block' : 'none'
  if (lettura) lettura.style.display = (quale === 'lettura') ? 'block' : 'none'
  if (scheda)  scheda.style.display  = (quale === 'scheda')  ? 'block' : 'none'
}

// FASE 18 — «tutti» è una scheda in più, non una categoria: non esiste nel
// database, vive solo qui come filtro.
var RUBRICA_SCHEDE = ['tutti', 'cliente', 'fornitore', 'collaboratore', 'generico']

function setRubricaTab(cat) {
  rubricaTab = cat
  RUBRICA_SCHEDE.forEach(function (c) {
    var t = el('tab-' + c)
    if (t) t.setAttribute('aria-selected', c === cat ? 'true' : 'false')
  })
  renderContattiList()
}

function renderContattiList() {
  var q = el('rubrica-search') ? el('rubrica-search').value.trim().toLowerCase() : ''
  var mostraInattivi = el('rubrica-show-inattivi') ? el('rubrica-show-inattivi').checked : false
  var tutti = contattiCache || []

  // I contatori sulle schede contano SEMPRE i soli contatti attivi: servono a
  // dire quanti contatti utilizzabili ci sono, non quanti ne esistono in tutto.
  ;['cliente', 'fornitore', 'collaboratore', 'generico'].forEach(function (c) {
    var n = tutti.filter(function (x) { return contattoInCategoria(x, c) && x.attivo !== false }).length
    var b = el('cnt-' + c)
    if (b) b.textContent = String(n)
  })

  // FASE 18 — «Tutti» conta i contatti DISTINTI, non la somma delle altre
  // schede: chi ha la spunta del doppio uso sta in due schede, ma è una
  // persona sola e va contata una volta.
  var bTutti = el('cnt-tutti')
  if (bTutti) {
    bTutti.textContent = String(tutti.filter(function (x) { return x.attivo !== false }).length)
  }

  var list = tutti.filter(function (c) {
    if (rubricaTab !== 'tutti' && !contattoInCategoria(c, rubricaTab)) return false
    if (!mostraInattivi && c.attivo === false) return false
    return true
  })

  if (q) {
    var termini = q.split(/\s+/)
    list = list.filter(function (c) {
      var hay = (contattoNome(c) + ' ' + (c.citta || '') + ' ' + (c.cap || '') + ' ' +
                 (c.email || '') + ' ' + (c.telefono || '') + ' ' +
                 (c.uid_partita_iva || '')).toLowerCase()
      return termini.every(function (t) { return hay.indexOf(t) !== -1 })
    })
  }

  list.sort(function (a, b) { return contattoNome(a).localeCompare(contattoNome(b), 'it') })

  if (!list.length) {
    var vuotoMsg = q
      ? 'Nessun contatto trovato per «' + esc(q) + '». Prova a cercare un pezzo di parola.'
      : (rubricaTab === 'tutti'
          ? 'La rubrica è vuota. Premi «➕ Nuovo contatto» per aggiungere il primo.'
          : 'Nessun contatto in questa scheda. Premi «➕ Nuovo contatto» per aggiungerne uno.')
    html('rubrica-table', '<div class="dim" style="padding:14px 2px">' + vuotoMsg + '</div>')
    return
  }

  var rows = list.map(function (c) {
    var nome = contattoNome(c)
    var azioni = ''
    // Azioni rapide: icona SEMPRE accompagnata dall'etichetta testuale.
    // stopPropagation: il clic sull'azione non deve aprire anche la scheda.
    if (c.telefono) {
      azioni += '<a class="azione-rapida" href="tel:' + esc(String(c.telefono).replace(/\s/g, '')) + '"' +
                ' onclick="event.stopPropagation()"' +
                ' aria-label="Chiama ' + esc(nome) + '">📞 Chiama</a>'
    }
    if (c.email) {
      azioni += '<a class="azione-rapida" href="mailto:' + esc(c.email) + '"' +
                ' onclick="event.stopPropagation()"' +
                ' aria-label="Scrivi una mail a ' + esc(nome) + '">✉️ Scrivi mail</a>'
    }
    // FASE 18 — la scheda si apre in lettura: la matita direbbe una cosa falsa.
    azioni += '<button class="azione-rapida" onclick="event.stopPropagation(); apriContatto(\'' + c.id + '\')">👁️ Apri scheda</button>'

    return '<div class="contatto-row' + (c.attivo === false ? ' inattivo' : '') + '"' +
             ' onclick="apriContatto(\'' + c.id + '\')" role="button" tabindex="0"' +
             ' onkeydown="if(event.key===\'Enter\'){apriContatto(\'' + c.id + '\')}">' +
             '<div class="contatto-main">' +
               '<div class="contatto-nome">' + esc(nome) +
                 (c.attivo === false ? ' ' + badge('warn', '📦 Archiviato') : '') + '</div>' +
               // FASE 18 — nella scheda «Tutti» clienti e fornitori sono
               // mescolati: senza dire chi è chi l'elenco non si legge.
               (rubricaTab === 'tutti'
                 ? '<div class="contatto-cat">' + esc(contattoSchedeTesto(c)) + '</div>'
                 : '') +
               '<div class="contatto-sub">' + esc(contattoSub(c) || 'nessun recapito registrato') + '</div>' +
             '</div>' +
             '<div class="contatto-azioni">' + azioni + '</div>' +
           '</div>'
  }).join('')

  html('rubrica-table',
    '<div class="dim" style="margin-bottom:10px">' +
      list.length + (list.length === 1 ? ' contatto' : ' contatti') +
      (q ? (list.length === 1 ? ' trovato con la ricerca' : ' trovati con la ricerca') : '') +
      '</div>' + rows)
}

// ── Scheda contatto ──────────────────────────────────────────────────────────

async function nuovoContatto(categoriaIniziale) {
  editingContattoId = null
  await riempiSelectGruppi('c-gruppo', '')
  var form = el('form-contatto')
  if (form) form.reset()
  // FASE 18 — «tutti» non è una categoria: dalla scheda «Tutti» si propone
  // Cliente, che è la voce più frequente, e resta cambiabile dal menu.
  var catIniziale = categoriaIniziale || (rubricaTab === 'tutti' ? 'cliente' : rubricaTab)
  if (el('c-categoria')) el('c-categoria').value = catIniziale
  impostaPaese('c-paese', PAESE_PREDEFINITO)
  if (el('c-attivo'))    el('c-attivo').checked = true
  if (el('c-anche-cliente'))   el('c-anche-cliente').checked = false
  if (el('c-anche-fornitore')) el('c-anche-fornitore').checked = false
  onCategoriaContattoChange()
  if (el('contatto-card-title')) el('contatto-card-title').textContent = '➕ Nuovo contatto'
  if (el('contatto-submit-btn')) el('contatto-submit-btn').textContent = '💾 Salva contatto'
  html('contatto-banner', '')
  renderAzioniRapide()
  mostraRubricaVista('scheda')
  if (el('c-ragione')) el('c-ragione').focus()
}

// FASE 18 — aprire un contatto lo MOSTRA soltanto. Prima si entrava dritti nel
// modulo modificabile, e bastava sfiorare un campo per cambiare un dato senza
// accorgersene. Per modificare si passa dal bottone «✏️ Modifica».
async function apriContatto(id) {
  var c = (contattiCache || []).filter(function (x) { return x.id === id })[0]
  if (!c) { showRubricaBanner('err', 'Contatto non trovato: ricarica la pagina.'); return }
  contattoLetturaId = id
  editingContattoId = null            // in lettura non si sta modificando niente

  if (el('contatto-lettura-titolo')) {
    el('contatto-lettura-titolo').textContent = '👤 ' + contattoNome(c)
  }
  html('contatto-lettura-banner', '')
  html('contatto-lettura-azioni', azioniRapideHtml(c.telefono, c.email, contattoNome(c)))
  html('contatto-lettura-dati', contattoLetturaHtml(c))
  html('contatto-lettura-fatture', loadingRow('Caricamento fatture…'))
  mostraRubricaVista('lettura')
  // Le fatture arrivano dopo: la scheda si vede subito, senza aspettare la rete.
  renderFattureDelContatto(id)
}

// La scheda letta, con gli stessi dati del modulo. Solo i campi valorizzati:
// una griglia di trattini non dice niente.
function contattoLetturaHtml(c) {
  function riga(lbl, val, mono) {
    if (val === null || val === undefined || val === '') return ''
    return '<div class="ro-lbl">' + esc(lbl) + '</div>' +
           '<div class="ro-val' + (mono ? ' mono' : '') + '">' + val + '</div>'
  }
  var luogo = [c.cap, c.citta].filter(Boolean).join(' ')
  var out = '<div class="ro-grid">' +
    '<div class="ro-section">Chi è</div>' +
    riga('Categoria', esc(contattoSchedeTesto(c))) +
    riga('Ragione sociale', esc(c.ragione_sociale || '')) +
    riga('Nome e cognome', esc([c.nome, c.cognome].filter(Boolean).join(' '))) +
    (c.attivo === false ? riga('Stato', badge('warn', '📦 Archiviato')) : '') +
    '<div class="ro-sep"></div>' +
    '<div class="ro-section">Dove</div>' +
    riga('Indirizzo', esc(c.indirizzo || '')) +
    riga('NPA e località', esc(luogo)) +
    riga('Paese', c.paese
      ? (paeseValido(c.paese)
          ? esc(nomePaese(c.paese) + ' (' + String(c.paese).toUpperCase() + ')')
          : esc(String(c.paese)) + ' ' + badge('err', '\u26a0\ufe0f codice non valido'))
      : '') +
    '<div class="ro-sep"></div>' +
    '<div class="ro-section">Recapiti</div>' +
    riga('Telefono', esc(c.telefono || '')) +
    riga('Email', esc(c.email || '')) +
    riga('Sito web', esc(c.sito_web || '')) +
    '<div class="ro-sep"></div>' +
    '<div class="ro-section">Dati amministrativi</div>' +
    riga('UID / Partita IVA', esc(c.uid_partita_iva || ''), true) +
    // L'IBAN del contatto per intero, come gli altri: serve a confrontarlo con
    // quello scritto su una fattura ricevuta.
    riga('IBAN', esc(ibanLeggibile(c.iban || '')), true) +
    riga('Gruppo predefinito', esc(c.gruppo_default || '')) +
    riga('Giorni di pagamento', c.giorni_pagamento == null ? '' : esc(String(c.giorni_pagamento) + ' giorni')) +
    riga('Note', c.note ? esc(c.note).replace(/\n/g, '<br>') : '') +
    '</div>'
  return out
}

// Gli stessi bottoni «Chiama / Scrivi mail» dell'elenco, su un contatto letto.
function azioniRapideHtml(tel, email, nome) {
  var out = ''
  if (tel) {
    out += '<a class="azione-rapida" href="tel:' + esc(String(tel).replace(/\s/g, '')) + '"' +
           ' aria-label="Chiama ' + esc(nome || '') + '">📞 Chiama ' + esc(tel) + '</a> '
  }
  if (email) {
    out += '<a class="azione-rapida" href="mailto:' + esc(email) + '"' +
           ' aria-label="Scrivi una mail a ' + esc(nome || '') + '">✉️ Scrivi mail a ' + esc(email) + '</a>'
  }
  if (!out) {
    out = '<div class="dim" style="font-size:12px">Nessun recapito registrato: né telefono né email.</div>'
  }
  return out
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 18 / A5 — Le fatture di vendita intestate a un contatto
// Si leggono da tm_conta_fatture filtrando su contatto_id. Quel collegamento
// esiste solo dalla FASE 17 in avanti: le fatture emesse prima non ce l'hanno
// e non compaiono. Lo dice il riquadro stesso, altrimenti sembrano dati persi.
// ══════════════════════════════════════════════════════════════════════════════

var AVVISO_FATTURE_STORICHE =
  'ℹ️ Compaiono solo le fatture collegate a questo contatto in rubrica: ' +
  'quelle emesse prima di questo collegamento non ce l\'hanno e non si vedono qui.'

// Dalla rubrica alla fattura: viewFattura() da sola cambia solo la vista dentro
// la pagina Fatture, e restando in Rubrica non si vedrebbe niente.
async function apriFatturaDaRubrica(id) {
  showPage('fatture')
  await viewFattura(id)
}

async function renderFattureDelContatto(contattoId) {
  var box = 'contatto-lettura-fatture'
  if (!currentAziendaId) { html(box, ''); return }
  try {
    const { data, error } = await sb
      .from('tm_conta_fatture')
      .select('id, numero, data_emissione, totale, valuta, stato, stato_pagamento, tipo')
      .eq('azienda_id', currentAziendaId)
      .eq('contatto_id', contattoId)
      .order('data_emissione', { ascending: false, nullsFirst: false })
    if (error) throw error

    // Il residuo non si ricalcola qui: lo espone gia' v_conta_flussi, che tiene
    // conto dei pagamenti parziali e del segno delle note di credito. Rifarlo a
    // mano darebbe un secondo numero, e prima o poi i due divergerebbero.
    var residuo = null
    try {
      var flussi = await loadFlussi()
      residuo = 0
      for (var i = 0; i < flussi.length; i++) {
        var r = flussi[i]
        if (r.tabella_origine !== 'tm_conta_fatture') continue
        if (r.contatto_id !== contattoId) continue
        if (r.stato_pagamento === 'pagato') continue
        var res = safeNum(r.residuo)
        if (res == null) res = (safeNum(r.importo_totale) || 0) - (safeNum(r.importo_pagato) || 0)
        residuo += res
      }
      residuo = round2(residuo)
    } catch (e) { residuo = null }   // il totale è un di più: l'elenco si vede lo stesso

    // La scheda puo' essere gia' cambiata mentre la lettura era in corso.
    if (contattoLetturaId !== contattoId) return
    html(box, fattureContattoHtml(data || [], residuo))
  } catch (e) {
    if (contattoLetturaId !== contattoId) return
    html(box,
      '<div class="card-sub">' +
        '<div class="card-title">🧾 Fatture di vendita</div>' +
        '<div class="fase-banner warn" role="alert">' +
          '<span class="icon" aria-hidden="true">⚠️</span>' +
          '<div class="msg">Elenco non caricato: ' + esc(e.message || e) + '</div>' +
        '</div>' +
      '</div>')
  }
}

function fattureContattoHtml(list, residuo) {
  var testa = '<div class="card-title">🧾 Fatture di vendita</div>'

  if (!list.length) {
    return '<div class="card-sub">' + testa +
      '<div class="dim" style="padding:6px 0">' +
        'Nessuna fattura collegata a questo contatto.' +
      '</div>' +
      '<div class="form-hint">' + esc(AVVISO_FATTURE_STORICHE) + '</div>' +
    '</div>'
  }

  var valuta = 'CHF'
  for (var i = 0; i < list.length; i++) if (list[i].valuta) valuta = list[i].valuta

  var righe = list.map(function (f) {
    var isNC = f.tipo === 'nota_credito'
    var nome = f.numero ? esc(f.numero) : 'bozza senza numero'
    var stati = statoFatturaBadge(f.stato) +
                (f.stato === 'emessa' && !isNC ? ' ' + badgePagamento('entrata', f.stato_pagamento) : '')
    return '<div class="contatto-fatt-row"' +
             ' onclick="apriFatturaDaRubrica(\'' + f.id + '\')" role="button" tabindex="0"' +
             ' onkeydown="if(event.key===\'Enter\'){apriFatturaDaRubrica(\'' + f.id + '\')}">' +
             '<div class="contatto-fatt-main">' +
               '<div class="contatto-fatt-num">' +
                 (isNC ? '↩️ Nota di credito ' : '🧾 Fattura ') + nome +
               '</div>' +
               '<div class="contatto-fatt-sub">' +
                 (f.data_emissione ? esc(fmtDate(f.data_emissione)) : 'senza data') +
                 ' · ' + stati +
               '</div>' +
             '</div>' +
             '<div class="contatto-fatt-tot' + (isNC ? ' nc' : '') + '">' +
               (isNC ? '− ' : '') + esc(fmtImporto(f.totale, f.valuta)) +
             '</div>' +
           '</div>'
  }).join('')

  var somma = (residuo == null)
    ? '<span class="contatto-fatt-somma dim">Totale da incassare non disponibile</span>'
    : '<span class="contatto-fatt-somma">Ancora da incassare: <strong>' +
        esc(fmtNum2(residuo) + ' ' + valuta) + '</strong></span>'

  return '<div class="card-sub">' + testa +
    '<div class="contatto-fatt-testa">' +
      '<span>' + list.length + (list.length === 1 ? ' documento collegato' : ' documenti collegati') + '</span>' +
      somma +
    '</div>' +
    righe +
    '<div class="form-hint">' + esc(AVVISO_FATTURE_STORICHE) + '</div>' +
  '</div>'
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 21 / P4 — Eliminare un contatto
//
// Un contatto si elimina solo se non e' nominato da nessun documento. Una
// fattura deve continuare a dire a chi e' stata fatta: staccarla dal suo
// contatto per far posto a una cancellazione sarebbe rovinare il documento
// per comodita' dell'anagrafica. Quando ci sono documenti l'unica strada e'
// l'archiviazione, che toglie il contatto dagli elenchi e lascia intatto il
// passato.
// ══════════════════════════════════════════════════════════════════════════════

// Le TRE tabelle che nominano un contatto (verificate su SQL_PASSO1.sql:
// nessun'altra ha la colonna contatto_id).
var TABELLE_CON_CONTATTO = [
  { tabella: 'tm_conta_fatture',           uno: 'fattura di vendita',  molti: 'fatture di vendita' },
  { tabella: 'tm_conta_fatture_acquisto',  uno: 'fattura d\'acquisto', molti: 'fatture d\'acquisto' },
  { tabella: 'tm_conta_movimenti_propri',  uno: 'movimento',           molti: 'movimenti' }
]

async function contaDocumentiContatto(contattoId) {
  // FASE 23 / P2 — QUI ZERO NON E' UN ELENCO VUOTO, E' UN SEMAFORO VERDE.
  //
  // Le tre tabelle sono protette da RLS: senza sessione il conteggio torna
  // zero SENZA errore. Il chiamante leggeva quello zero come «nessun documento
  // lo nomina» e proponeva il bottone rosso «Sì, elimina definitivamente» su un
  // contatto in realta' collegato a fatture emesse. Il ramo protettivo che dice
  // «Senza quel conteggio non elimino niente» non scattava, perche' non c'era
  // nessun errore da raccogliere.
  //
  // Percio' si LANCIA: meglio non poter cancellare che cancellare al buio.
  if (!currentAziendaId) {
    throw new Error('sessione non attiva, il conteggio dei documenti collegati non è possibile')
  }
  var esito = { totale: 0, pezzi: [] }
  for (var i = 0; i < TABELLE_CON_CONTATTO.length; i++) {
    var t = TABELLE_CON_CONTATTO[i]
    const { count, error } = await sb
      .from(t.tabella)
      .select('id', { count: 'exact', head: true })
      .eq('azienda_id', currentAziendaId)
      .eq('contatto_id', contattoId)
    if (error) throw error
    var n = count || 0
    if (n > 0) {
      esito.totale += n
      esito.pezzi.push(n + ' ' + (n === 1 ? t.uno : t.molti))
    }
  }
  return esito
}

async function chiediEliminaContatto() {
  if (!contattoLetturaId) return
  var c = (contattiCache || []).filter(function (x) { return x.id === contattoLetturaId })[0]
  if (!c) return
  var btn = el('contatto-elimina-btn')
  if (btn) { btn.disabled = true }
  html('contatto-lettura-banner', loadingRow('Controllo i documenti collegati…'))
  try {
    var uso = await contaDocumentiContatto(contattoLetturaId)
    if (uso.totale > 0) {
      html('contatto-lettura-banner',
        '<div class="fase-banner warn" role="alert">' +
          '<span class="icon" aria-hidden="true">\ud83d\udd12</span>' +
          '<div class="msg">' +
            '<strong>Non si pu\u00f2 eliminare: \u00e8 collegato a ' + uso.totale +
              (uso.totale === 1 ? ' documento' : ' documenti') + '</strong> (' +
              esc(uso.pezzi.join(', ')) + ').' +
            '<div style="margin-top:4px">Una fattura deve continuare a dire a chi \u00e8 stata ' +
              'fatta: eliminando il contatto quei documenti resterebbero senza intestatario. ' +
              'La strada \u00e8 <strong>archiviarlo</strong> — sparisce dagli elenchi e dalle ' +
              'ricerche, il passato resta leggibile.</div>' +
            '<div class="dop-azioni">' +
              '<button type="button" class="btn-primary" onclick="archiviaContattoCorrente()">' +
                '\ud83d\udce6 Archivia il contatto</button>' +
              '<button type="button" class="btn-secondary" onclick="annullaEliminaContatto()">' +
                '\u2716\ufe0f Annulla</button>' +
            '</div>' +
          '</div>' +
        '</div>')
      return
    }
    html('contatto-lettura-banner',
      '<div class="fase-banner err" role="alert">' +
        '<span class="icon" aria-hidden="true">\ud83d\uddd1\ufe0f</span>' +
        '<div class="msg">' +
          '<strong>Vuoi eliminare definitivamente ' + esc(contattoNome(c)) + '?</strong>' +
          '<div style="margin-top:4px">Nessun documento lo nomina, quindi si pu\u00f2 togliere ' +
            'del tutto. <strong>L\u2019operazione non si annulla.</strong></div>' +
          '<div class="dop-azioni">' +
            '<button type="button" class="btn-danger" onclick="eliminaContattoConfermato()">' +
              '\ud83d\uddd1\ufe0f S\u00ec, elimina definitivamente</button>' +
            '<button type="button" class="btn-secondary" onclick="annullaEliminaContatto()">' +
              '\u2716\ufe0f Annulla</button>' +
          '</div>' +
        '</div>' +
      '</div>')
  } catch (e) {
    html('contatto-lettura-banner',
      '<div class="fase-banner err" role="alert">' +
        '<span class="icon" aria-hidden="true">\u274c</span>' +
        '<div class="msg">Non sono riuscito a contare i documenti collegati: ' +
          esc(e.message || e) + '. Senza quel conteggio non elimino niente.</div>' +
      '</div>')
  } finally {
    if (btn) btn.disabled = false
  }
}

function annullaEliminaContatto() { html('contatto-lettura-banner', '') }

async function eliminaContattoConfermato() {
  var id = contattoLetturaId
  if (!id) return
  var c = (contattiCache || []).filter(function (x) { return x.id === id })[0]
  var nome = c ? contattoNome(c) : 'il contatto'
  html('contatto-lettura-banner', loadingRow('Eliminazione…'))
  try {
    const { error } = await sb.from('tm_contatti')
      .delete().eq('id', id).eq('azienda_id', currentAziendaId).select()
    if (error) throw error
    await loadContatti(true)
    contattoLetturaId = null
    mostraRubricaVista('lista')
    renderContattiList()
    showRubricaBanner('ok', 'Contatto eliminato: ' + nome + '.')
  } catch (e) {
    // Il caso piu' probabile e' il permesso di cancellazione mancante: lo si
    // dice con parole sue invece di lasciare l'errore Postgres grezzo.
    var m = String(e.message || e)
    var spiega = (/row-level security|violates row-level|permission denied/i.test(m))
      ? 'il database ha rifiutato la cancellazione. La policy c\'è (contatti_own, FOR ALL ' +
        'agli utenti autenticati): riprova dopo aver rifatto il login, e se resta così ' +
        'segnalalo — vuol dire che le regole di sicurezza sono cambiate.'
      : friendlyContattoError(e)
    html('contatto-lettura-banner',
      '<div class="fase-banner err" role="alert">' +
        '<span class="icon" aria-hidden="true">\u274c</span>' +
        '<div class="msg">Non eliminato: ' + esc(spiega) + '</div>' +
      '</div>')
  }
}

// L'archiviazione dalla scheda letta: la stessa cosa che fa la spunta
// «Contatto attivo» nel modulo, senza dover entrare in modifica.
async function archiviaContattoCorrente() {
  var id = contattoLetturaId
  if (!id) return
  html('contatto-lettura-banner', loadingRow('Archiviazione…'))
  try {
    const { error } = await sb.from('tm_contatti')
      .update({ attivo: false }).eq('id', id).eq('azienda_id', currentAziendaId).select()
    if (error) throw error
    await loadContatti(true)
    mostraRubricaVista('lista')
    renderContattiList()
    showRubricaBanner('ok', 'Contatto archiviato: non compare più negli elenchi, i suoi documenti restano.')
  } catch (e) {
    html('contatto-lettura-banner',
      '<div class="fase-banner err" role="alert">' +
        '<span class="icon" aria-hidden="true">\u274c</span>' +
        '<div class="msg">Non archiviato: ' + esc(friendlyContattoError(e)) + '</div>' +
      '</div>')
  }
}

function modificaContattoCorrente() {
  // Restituisce la promessa: chi chiama puo' aspettare che il modulo sia pronto.
  return contattoLetturaId ? modificaContatto(contattoLetturaId) : Promise.resolve()
}

async function modificaContatto(id) {
  var c = (contattiCache || []).filter(function (x) { return x.id === id })[0]
  if (!c) { showRubricaBanner('err', 'Contatto non trovato: ricarica la pagina.'); return }
  editingContattoId = id
  await riempiSelectGruppi('c-gruppo', c.gruppo_default || '')
  if (el('c-categoria')) el('c-categoria').value = c.categoria || 'generico'
  if (el('c-ragione'))   el('c-ragione').value   = c.ragione_sociale || ''
  if (el('c-nome'))      el('c-nome').value      = c.nome || ''
  if (el('c-cognome'))   el('c-cognome').value   = c.cognome || ''
  if (el('c-indirizzo')) el('c-indirizzo').value = c.indirizzo || ''
  if (el('c-cap'))       el('c-cap').value       = c.cap || ''
  if (el('c-citta'))     el('c-citta').value     = c.citta || ''
  impostaPaese('c-paese', c.paese || PAESE_PREDEFINITO)
  if (el('c-telefono'))  el('c-telefono').value  = c.telefono || ''
  if (el('c-email'))     el('c-email').value     = c.email || ''
  if (el('c-sito'))      el('c-sito').value      = c.sito_web || ''
  if (el('c-uid'))       el('c-uid').value       = c.uid_partita_iva || ''
  if (el('c-iban'))      el('c-iban').value      = c.iban || ''
  if (el('c-giorni'))    el('c-giorni').value    = c.giorni_pagamento == null ? '' : c.giorni_pagamento
  if (el('c-note'))      el('c-note').value      = c.note || ''
  if (el('c-attivo'))    el('c-attivo').checked  = c.attivo !== false
  if (el('c-anche-cliente'))   el('c-anche-cliente').checked   = c.e_cliente   === true
  if (el('c-anche-fornitore')) el('c-anche-fornitore').checked = c.e_fornitore === true
  onCategoriaContattoChange()
  if (el('contatto-card-title')) el('contatto-card-title').textContent = '👤 ' + contattoNome(c)
  if (el('contatto-submit-btn')) el('contatto-submit-btn').textContent = '💾 Salva modifiche'
  html('contatto-banner', '')
  renderAzioniRapide()
  mostraRubricaVista('scheda')
}

function chiudiSchedaContatto() {
  // Se si torna indietro senza salvare, si torna al documento di partenza
  if (rubricaRitorno && rubricaRitorno.prefix) {
    var rit = rubricaRitorno
    rubricaRitorno = null
    editingContattoId = null
    mostraRubricaVista('lista')
    showPage(rit.page)
    return
  }
  editingContattoId = null
  mostraRubricaVista('lista')
  renderContattiList()
}

// Chiama / Scrivi mail sulla scheda: si aggiornano mentre si scrive il recapito,
// così si vede subito che il numero inserito è utilizzabile.
function renderAzioniRapide() {
  var tel   = getVal('c-telefono')
  var email = getVal('c-email')
  var out = (tel || email)
    ? azioniRapideHtml(tel, email, getVal('c-ragione') || getVal('c-cognome'))
    : '<div class="dim" style="font-size:12px">Inserisci telefono o email: qui compaiono i pulsanti per chiamare e scrivere.</div>'
  html('contatto-azioni-rapide', out)
}

// FASE 17 — la spunta che ripete la categoria gia' scelta non ha senso e
// confonde: un contatto di categoria «cliente» non ha bisogno di dichiarare che
// compare anche fra i clienti. Si nasconde e si toglie la spunta, cosi' non
// resta una scelta invisibile che poi finisce salvata.
function onCategoriaContattoChange() {
  var cat = getVal('c-categoria') || 'generico'
  ;[['cliente', 'c-anche-cliente'], ['fornitore', 'c-anche-fornitore']].forEach(function (p) {
    var ridondante = (cat === p[0]) || !contattiDoppiaCategoria
    var box = el(p[1])
    var riga = el(p[1] + '-riga')
    if (ridondante && box) box.checked = false
    if (riga) riga.style.display = ridondante ? 'none' : ''
  })
}

function raccogliContatto() {
  var ragione = getVal('c-ragione')
  var cognome = getVal('c-cognome')
  if (!ragione && !cognome) {
    throw new Error('Serve almeno la ragione sociale oppure il cognome: è il nome con cui il contatto compare negli elenchi.')
  }
  var giorni = getVal('c-giorni')
  var giorniNum = giorni === '' ? null : parseInt(giorni, 10)
  if (giorniNum != null && (isNaN(giorniNum) || giorniNum < 0 || giorniNum > 365)) {
    throw new Error('I giorni di pagamento devono essere un numero fra 0 e 365.')
  }
  var categoria = getVal('c-categoria') || 'generico'
  var payload = {
    azienda_id:      currentAziendaId,
    categoria:       categoria,
    ragione_sociale: ragione || null,
    nome:            getVal('c-nome') || null,
    cognome:         cognome || null,
    indirizzo:       getVal('c-indirizzo') || null,
    cap:             getVal('c-cap') || null,
    citta:           getVal('c-citta') || null,
    paese:           getVal('c-paese') || null,
    telefono:        getVal('c-telefono') || null,
    email:           getVal('c-email') || null,
    sito_web:        getVal('c-sito') || null,
    uid_partita_iva: getVal('c-uid') || null,
    iban:            getVal('c-iban') ? getVal('c-iban').replace(/\s/g, '').toUpperCase() : null,
    gruppo_default:  getVal('c-gruppo') || null,
    giorni_pagamento: giorniNum,
    note:            getVal('c-note') || null,
    attivo:          el('c-attivo') ? el('c-attivo').checked : true
  }

  // FASE 17 — doppio uso. La spunta vale solo se NON ripete la categoria gia'
  // scelta: altrimenti si forza false, cosi' una spunta rimasta nascosta da un
  // cambio di categoria non finisce salvata. Se la migrazione non e' stata
  // lanciata le due colonne non esistono e non si scrivono affatto.
  if (contattiDoppiaCategoria) {
    payload.e_cliente = (categoria !== 'cliente') &&
      !!(el('c-anche-cliente') && el('c-anche-cliente').checked)
    payload.e_fornitore = (categoria !== 'fornitore') &&
      !!(el('c-anche-fornitore') && el('c-anche-fornitore').checked)
  }
  return payload
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 18 / B3 — Avviso doppione, mai blocco
// ══════════════════════════════════════════════════════════════════════════════

var contattoForzaNuovo = false   // «Salva comunque»: vale per un solo salvataggio

// Le forme societarie non distinguono due ditte: «Bianchi SA» e «Bianchi Sagl»
// scritte per la stessa ditta devono somigliarsi. Si tolgono, insieme ad
// accenti, punteggiatura e spazi doppi.
var FORME_SOCIETARIE = /\b(sa|sagl|srl|sarl|ag|gmbh|spa|snc|sas)\b/g

function normalizzaNomeContatto(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // accenti
    // I punti si TOLGONO, non diventano spazio: «S.R.L.» dev'essere «srl», non
    // tre lettere sciolte che nessuna regola riconosce piu' come forma
    // societaria. Il resto della punteggiatura separa, e diventa spazio.
    .replace(/\./g, '')
    .replace(/[,;:'’"`()\[\]\/\\-]/g, ' ')
    .replace(FORME_SOCIETARIE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// L'UID si confronta a cifre nude: «CHE-123.456.789» e «CHE123456789» sono lo
// stesso numero scritto in due modi.
function normalizzaUid(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

// Restituisce i contatti che assomigliano a quello che si sta salvando.
// `forte` = stesso UID: due ditte diverse non hanno lo stesso UID, li' e'
// quasi certo che sia lo stesso soggetto.
function cercaContattiSimili(payload) {
  var nome = normalizzaNomeContatto(payload.ragione_sociale ||
                                    [payload.cognome, payload.nome].filter(Boolean).join(' '))
  var uid = normalizzaUid(payload.uid_partita_iva)
  var fuori = []
  ;(contattiCache || []).forEach(function (x) {
    var uidUguale = !!uid && normalizzaUid(x.uid_partita_iva) === uid
    var nomeUguale = !!nome && normalizzaNomeContatto(contattoNome(x)) === nome
    if (uidUguale || nomeUguale) fuori.push({ c: x, forte: uidUguale })
  })
  return fuori
}

function mostraAvvisoDoppione(simili) {
  var forte = simili.some(function (s) { return s.forte })
  var righe = simili.map(function (s) {
    var x = s.c
    var dettagli = [x.citta, x.telefono].filter(Boolean).join(' · ')
    return '<div class="dop-riga">' +
             '<div class="dop-chi">' +
               '<strong>' + esc(contattoNome(x)) + '</strong>' +
               (s.forte ? ' ' + badge('err', '🆔 stesso UID') : ' ' + badge('warn', '👥 stesso nome')) +
               (x.attivo === false ? ' ' + badge('warn', '📦 Archiviato') : '') +
               '<div class="dim">' + esc(dettagli || 'nessun recapito registrato') + '</div>' +
             '</div>' +
             '<button type="button" class="btn-secondary"' +
               ' onclick="apriContattoDaAvviso(\'' + x.id + '\')">📂 Apri quello esistente</button>' +
           '</div>'
  }).join('')

  html('contatto-banner',
    '<div class="fase-banner ' + (forte ? 'err' : 'warn') + '" role="alert">' +
      '<span class="icon" aria-hidden="true">' + (forte ? '🆔' : '👥') + '</span>' +
      '<div class="msg">' +
        '<strong>' + (forte
          ? 'C\'è già un contatto con lo stesso UID / partita IVA.'
          : 'C\'è già un contatto con lo stesso nome.') + '</strong>' +
        '<div style="margin-top:4px">' + (forte
          ? 'Due ditte diverse non hanno lo stesso UID: quasi sicuramente è lo stesso soggetto.'
          : 'Può essere un omonimo, oppure lo stesso soggetto già in rubrica.') +
        ' Decidi tu: il programma non salva e non scarta niente da solo.</div>' +
        '<div class="dop-lista">' + righe + '</div>' +
        '<div class="dop-azioni">' +
          '<button type="button" class="btn-primary"' +
            ' onclick="salvaComunqueContatto()">💾 Salva comunque come nuovo</button>' +
          '<button type="button" class="btn-secondary"' +
            ' onclick="annullaAvvisoDoppione()">✖️ Annulla</button>' +
        '</div>' +
        '<div class="form-hint" style="margin-top:8px">' +
          'Aprendo quello esistente, quello che hai scritto qui non viene salvato.' +
        '</div>' +
      '</div>' +
    '</div>')
}

// «Salva comunque»: si risalva senza altre domande. La forzatura vale una volta
// sola, cosi' il contatto dopo torna a essere controllato.
function salvaComunqueContatto() {
  contattoForzaNuovo = true
  return salvaContatto()   // si restituisce la promessa: il salvataggio è atteso
}

function annullaAvvisoDoppione() {
  contattoForzaNuovo = false
  html('contatto-banner', '')
}

function apriContattoDaAvviso(id) {
  contattoForzaNuovo = false
  html('contatto-banner', '')
  // Si arrivava da un documento («crea al volo»): quel ritorno non ha piu'
  // senso se si abbandona il contatto nuovo, e lasciarlo appeso farebbe
  // ripartire il rientro al primo salvataggio successivo.
  rubricaRitorno = null
  apriContatto(id)
}

async function salvaContatto(event) {
  if (event) event.preventDefault()
  var btn = el('contatto-submit-btn')
  var testoBtn = btn ? btn.textContent : ''
  html('contatto-banner', '')
  try {
    var payload = raccogliContatto()

    // FASE 18 — avviso doppione. Solo su un contatto NUOVO: in modifica un
    // contatto somiglierebbe a se stesso. E' un AVVISO, non un blocco: gli
    // omonimi esistono, e lo stesso soggetto con due IBAN oggi si registra due
    // volte perche' la scheda ha un solo campo IBAN. Decide Umberto.
    if (!editingContattoId && !contattoForzaNuovo) {
      var simili = cercaContattiSimili(payload)
      if (simili.length) { mostraAvvisoDoppione(simili); return }
    }
    contattoForzaNuovo = false

    if (btn) { btn.disabled = true; btn.textContent = '⏳ Salvataggio…' }

    var nuovoIdSalvato = editingContattoId
    if (editingContattoId) {
      const { error } = await sb.from('tm_contatti')
        .update(payload)
        .eq('id', editingContattoId)
        .eq('azienda_id', currentAziendaId)
        .select()
      if (error) throw error
    } else {
      const { data, error } = await sb.from('tm_contatti').insert(payload).select()
      if (error) throw error
      if (data && data[0]) { editingContattoId = data[0].id; nuovoIdSalvato = data[0].id }
    }

    await loadContatti(true)

    // Se si era arrivati qui da un documento («crea al volo»), si torna al
    // documento con il contatto gia' collegato: il lavoro a meta' non si perde.
    if (rubricaRitorno && rubricaRitorno.prefix) {
      var rit = rubricaRitorno
      rubricaRitorno = null
      editingContattoId = null
      mostraRubricaVista('lista')
      showPage(rit.page)
      await scegliContatto(rit.prefix, nuovoIdSalvato)
      return
    }

    chiudiSchedaContatto()
    showRubricaBanner('ok', 'Contatto salvato: ' + (payload.ragione_sociale || payload.cognome) + '.')
  } catch (e) {
    showContattoBanner('err', 'Non salvato: ' + friendlyContattoError(e))
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = testoBtn || '💾 Salva contatto' }
  }
}

function showContattoBanner(tipo, msg) {
  var icona = tipo === 'ok' ? '✅' : tipo === 'warn' ? '⚠️' : '❌'
  html('contatto-banner',
    '<div class="fase-banner ' + tipo + '" role="alert">' +
      '<span class="icon" aria-hidden="true">' + icona + '</span>' +
      '<div class="msg">' + esc(msg) + '</div>' +
    '</div>')
}

// Gli errori Postgres grezzi non dicono niente a chi li legge: qui diventano
// frasi che indicano il campo e cosa fare.
function friendlyContattoError(e) {
  var m = (e && (e.message || e.msg)) ? String(e.message || e.msg) : String(e)
  if (m.indexOf('gruppo_default') !== -1 && m.indexOf('foreign key') !== -1) {
    return 'il gruppo scelto non esiste più. Riapri il menu «Gruppo predefinito» e scegline un altro.'
  }
  if (m.indexOf('categoria') !== -1 && m.indexOf('check constraint') !== -1) {
    return 'la categoria non è valida: usa Cliente, Fornitore, Collaboratore o Generico.'
  }
  if (m.indexOf('row-level security') !== -1 || m.indexOf('violates row-level') !== -1) {
    return 'accesso negato dal database. Rieffettua il login e riprova.'
  }
  return m
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 2 — Ricerca in rubrica dentro i form (movimento e fattura d'acquisto)
// Un solo motore per entrambi i form: il prefisso 'f' è il movimento,
// 'a' è la fattura d'acquisto. Gli id dei campi seguono lo stesso schema.
// ══════════════════════════════════════════════════════════════════════════════

// Mappa prefisso -> id dei campi coinvolti. Tenerla qui evita di sparpagliare
// i nomi degli elementi in dieci funzioni diverse.
function rubricaCampi(prefix) {
  if (prefix === 'a') {
    return { testo: 'a-fornitore', hidden: 'a-contatto-id', suggest: 'a-fornitore-suggest',
             legato: 'a-contatto-legato', gruppo: 'a-gruppo', scadenza: 'a-scadenza',
             data: 'a-data', categoria: 'fornitore',
             btnSfoglia: 'a-fornitore-sfoglia' }   // FASE 19
  }
  // FASE 17 — 'v' e' la fattura di VENDITA. Gruppo e scadenza restano nulli:
  // la vendita non e' un nostro debito, non c'e' niente da proporre li'. Il
  // motore li salta da solo, controlla sempre el(c.gruppo) prima di usarli.
  if (prefix === 'v') {
    return { testo: 'f-cli-nome', hidden: 'f-cli-contatto-id', suggest: 'f-cli-nome-suggest',
             legato: 'f-cli-contatto-legato', gruppo: null, scadenza: null,
             data: 'f-fat-data', categoria: 'cliente',
             // FASE 18 — l'anagrafica che si compila da sola scegliendo il
             // cliente: e' il motivo per cui un cliente si collega a una fattura.
             indirizzo: 'f-cli-indirizzo', paese: 'f-cli-paese', uid: 'f-cli-iva',
             btnSfoglia: 'f-cli-sfoglia' }
  }
  // FASE 21 — 'b' e' la busta. Niente gruppo, niente scadenza: si sta solo
  // scrivendo un indirizzo su un pezzo di carta.
  if (prefix === 'b') {
    return { testo: 'busta-nome', hidden: 'busta-contatto-id', suggest: 'busta-nome-suggest',
             legato: 'busta-contatto-legato', gruppo: null, scadenza: null,
             data: null, categoria: 'cliente', btnSfoglia: 'busta-sfoglia' }
  }
  return { testo: 'f-ente', hidden: 'f-contatto-id', suggest: 'f-ente-suggest',
           legato: 'f-contatto-legato', gruppo: 'f-gruppo', scadenza: 'f-scadenza',
           data: 'f-data', categoria: 'fornitore',
           btnSfoglia: 'f-ente-sfoglia' }   // FASE 19
}

function chiudiSuggerimenti(prefix) {
  var c = rubricaCampi(prefix)
  html(c.suggest, '')
  rubricaSuggest = { prefix: null, list: [], hi: -1, sfoglia: false }
}

async function rubricaSuggerisci(prefix) {
  var c = rubricaCampi(prefix)
  var q = getVal(c.testo).toLowerCase()

  // Scrivere a mano scollega il contatto: il testo e il collegamento devono
  // dire la stessa cosa, altrimenti si salva il nome di uno e l'id di un altro.
  if (el(c.hidden) && el(c.hidden).value) {
    var legatoNome = (contattiCache || []).filter(function (x) { return x.id === el(c.hidden).value })[0]
    if (!legatoNome || contattoNome(legatoNome).toLowerCase() !== q) {
      scollegaContatto(prefix, true)
    }
  }

  if (q.length < 2) { chiudiSuggerimenti(prefix); return }

  try { await loadContatti() } catch (e) { /* la ricerca è un aiuto, non un requisito */ }

  var termini = q.split(/\s+/)
  var trovati = (contattiCache || []).filter(function (x) {
    if (x.attivo === false) return false
    var hay = (contattoNome(x) + ' ' + (x.citta || '') + ' ' + (x.email || '')).toLowerCase()
    return termini.every(function (t) { return hay.indexOf(t) !== -1 })
  }).slice(0, 8)

  mostraSuggerimenti(prefix, trovati)
}

// FASE 18 — «📇 Scegli dalla rubrica»: lo stesso menu, ma con TUTTI i contatti
// attivi, anche a campo vuoto. Se il nome non si ricorda, prima si era fermi.
// Nessun secondo motore: si riusa lo stesso elenco e lo stesso scegliContatto.
async function rubricaSfoglia(prefix) {
  var c = rubricaCampi(prefix)
  var box = el(c.suggest)
  // Secondo clic sul bottone: si richiude, come ci si aspetta da un menu.
  if (box && box.innerHTML && rubricaSuggest.prefix === prefix && rubricaSuggest.sfoglia) {
    chiudiSuggerimenti(prefix)
    return
  }
  try { await loadContatti() } catch (e) { /* l'elenco è un aiuto, non un requisito */ }
  var tutti = (contattiCache || []).filter(function (x) { return x.attivo !== false })
  tutti.sort(function (a, b) { return contattoNome(a).localeCompare(contattoNome(b), 'it') })
  mostraSuggerimenti(prefix, tutti, true)
  if (el(c.testo)) el(c.testo).focus()
}

// Disegna il menu a tendina. Unico punto in cui si costruiscono le voci:
// ricerca e sfoglia devono comportarsi allo stesso modo alla scelta.
function mostraSuggerimenti(prefix, trovati, sfoglia) {
  var c = rubricaCampi(prefix)
  var out = ''

  if (sfoglia && !trovati.length) {
    out += '<div class="suggest-vuoto dim">La rubrica non ha ancora nessun contatto attivo.</div>'
  }

  out += trovati.map(function (x) {
    return '<button type="button" class="suggest-item" role="option"' +
           ' onclick="scegliContatto(\'' + prefix + '\', \'' + x.id + '\')">' +
           esc(contattoNome(x)) +
           '<span class="s-sub">' + esc(contattoSub(x) || x.categoria) + '</span>' +
           '</button>'
  }).join('')

  // La creazione al volo è sempre in fondo: si crea solo se davvero non c'è.
  // Sfogliando a campo vuoto non c'è nessun nome da creare: si offre solo
  // quando qualcosa è stato scritto.
  var scritto = getVal(c.testo)
  if (scritto) {
    out += '<button type="button" class="suggest-item suggest-new"' +
           ' onclick="creaContattoAlVolo(\'' + prefix + '\')">' +
           '➕ Crea «' + esc(scritto) + '» come nuovo contatto' +
           '<span class="s-sub">lo salva in rubrica e lo collega a questo documento</span>' +
           '</button>'
  }

  html(c.suggest, out)
  rubricaSuggest = { prefix: prefix, list: trovati, hi: -1, sfoglia: !!sfoglia }
}

// Frecce su/giù per scorrere, Invio per scegliere, Esc per chiudere.
function rubricaTasti(event, prefix) {
  var c = rubricaCampi(prefix)
  var box = el(c.suggest)
  if (!box || !box.innerHTML) return
  var items = box.querySelectorAll('.suggest-item')
  if (!items.length) return

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    var n = items.length
    rubricaSuggest.hi = (event.key === 'ArrowDown')
      ? (rubricaSuggest.hi + 1) % n
      : (rubricaSuggest.hi - 1 + n) % n
    for (var i = 0; i < n; i++) items[i].classList.toggle('hi', i === rubricaSuggest.hi)
    items[rubricaSuggest.hi].scrollIntoView({ block: 'nearest' })
  } else if (event.key === 'Enter' && rubricaSuggest.hi >= 0) {
    event.preventDefault()
    items[rubricaSuggest.hi].click()
  } else if (event.key === 'Escape') {
    chiudiSuggerimenti(prefix)
  }
}

// Selezione di un contatto: compila da solo il gruppo predefinito e calcola la
// scadenza. Entrambi restano modificabili — sono proposte, non imposizioni.
async function scegliContatto(prefix, id) {
  var c = rubricaCampi(prefix)
  var x = (contattiCache || []).filter(function (k) { return k.id === id })[0]
  if (!x) return

  if (el(c.testo))  el(c.testo).value = contattoNome(x)
  if (el(c.hidden)) el(c.hidden).value = id
  chiudiSuggerimenti(prefix)

  // FASE 21 — sulla busta l'indirizzo si RIFA' ogni volta che si sceglie un
  // destinatario: qui la regola «solo se vuoto» sarebbe d'impiccio, perche'
  // cambiando destinatario resterebbe l'indirizzo di quello di prima. Resta
  // comunque correggibile a mano: quello che si vede e' quello che si stampa.
  if (prefix === 'b') {
    if (el('busta-indirizzo')) el('busta-indirizzo').value = indirizzoPerBusta(x)
    renderContattoLegato(prefix, x, null)
    if (typeof disegnaBusta === 'function') disegnaBusta()
    return
  }

  var compilati = []

  // Gruppo predefinito: si propone solo se il campo è ancora vuoto, per non
  // sovrascrivere una scelta già fatta a mano.
  if (x.gruppo_default && el(c.gruppo)) {
    await riempiSelectGruppi(c.gruppo, el(c.gruppo).value || x.gruppo_default)
    if (!el(c.gruppo).value) el(c.gruppo).value = x.gruppo_default
    if (el(c.gruppo).value === x.gruppo_default) compilati.push('gruppo ' + x.gruppo_default)
  }

  // Scadenza = data documento + giorni di pagamento del contatto.
  // Riusa addDays(), la stessa funzione della scadenza fattura: un solo posto
  // dove il calcolo puo' sbagliare, non due.
  if (x.giorni_pagamento != null && el(c.scadenza) && !el(c.scadenza).value) {
    var scad = addDays(getVal(c.data), x.giorni_pagamento)
    if (scad) {
      el(c.scadenza).value = scad
      compilati.push('scadenza fra ' + x.giorni_pagamento + ' giorni')
    }
  }

  // FASE 18 — anagrafica del cliente sulla fattura di vendita. Stessa regola
  // del gruppo: si compila SOLO il campo vuoto. Quello che c'e' scritto puo'
  // essere una correzione fatta a mano, e vale piu' del dato in rubrica.
  var indirizzoFatt = indirizzoPerFattura(x)
  if (indirizzoFatt && el(c.indirizzo) && !el(c.indirizzo).value.trim()) {
    el(c.indirizzo).value = indirizzoFatt
    compilati.push('indirizzo')
  }
  // FASE 19 — il Paese fa eccezione alla regola «solo se vuoto», e la fa per un
  // motivo preciso: newFattura() ci mette gia' CH, quindi vuoto non e' mai, e
  // con la regola vecchia un cliente estero restava CH da correggere a mano
  // ogni volta. Qui vale «vuoto OPPURE ancora il predefinito e mai toccato».
  // Quello che ha scritto l'utente resta intoccabile come tutto il resto.
  if (x.paese && el(c.paese)) {
    var paeseOra = el(c.paese).value.trim()
    var cede = !paeseOra ||
               (!paeseFatturaToccato && paeseOra.toUpperCase() === PAESE_PREDEFINITO)
    var paeseNuovo = String(x.paese).trim().toUpperCase()
    // Si annuncia solo un cambiamento vero: scrivere CH sopra CH non e'
    // «compilato in automatico», e dirlo sarebbe rumore.
    if (cede && paeseNuovo !== paeseOra.toUpperCase()) {
      impostaPaese(c.paese, paeseNuovo)
      compilati.push('paese')
    }
  }
  if (x.uid_partita_iva && el(c.uid) && !el(c.uid).value.trim()) {
    el(c.uid).value = x.uid_partita_iva
    compilati.push('n. IVA')
  }

  renderContattoLegato(prefix, x, compilati)
}

// FASE 19 — da qui in avanti il Paese lo ha scelto chi scrive, e nessuna
// scelta di contatto lo tocca piu'. Chiamata dall'oninput del campo.
function paeseFatturaModificato() {
  paeseFatturaToccato = true
}

// L'indirizzo come si stampa in fattura: la via su una riga, NPA e localita'
// sulla seconda. Il paese ha un campo suo e non entra qui.
function indirizzoPerFattura(x) {
  if (!x) return ''
  var righe = []
  if (x.indirizzo) righe.push(String(x.indirizzo).trim())
  var cittaRiga = [x.cap, x.citta].filter(Boolean).join(' ').trim()
  if (cittaRiga) righe.push(cittaRiga)
  return righe.join('\n')
}

// Riquadro sotto il campo: dice quale contatto è collegato e cosa è stato
// compilato in automatico. Testo esplicito, non un colore.
function renderContattoLegato(prefix, x, compilati) {
  var c = rubricaCampi(prefix)
  if (!x) { html(c.legato, ''); return }
  var extra = (compilati && compilati.length)
    ? '<span class="auto-hint">✨ compilato in automatico: ' + esc(compilati.join(', ')) + ' — modificabile</span>'
    : ''
  html(c.legato,
    '<div class="contatto-legato">' +
      '<span aria-hidden="true">🔗</span>' +
      '<span>Collegato in rubrica: <strong>' + esc(contattoNome(x)) + '</strong></span>' +
      extra +
      '<button type="button" class="cl-x" onclick="scollegaContatto(\'' + prefix + '\')">Scollega</button>' +
    '</div>')
}

function scollegaContatto(prefix, silenzioso) {
  var c = rubricaCampi(prefix)
  if (el(c.hidden)) el(c.hidden).value = ''
  html(c.legato, '')
  if (!silenzioso && el(c.testo)) el(c.testo).focus()
}

// Creazione al volo: si apre la scheda già compilata con quello che si stava
// scrivendo. Al salvataggio si torna al form di partenza, con il contatto
// collegato: non si perde il documento a metà.
var rubricaRitorno = null   // {prefix, page} da cui si è partiti

async function creaContattoAlVolo(prefix) {
  var c = rubricaCampi(prefix)
  var testo = getVal(c.testo)
  chiudiSuggerimenti(prefix)
  rubricaRitorno = { prefix: prefix, page: currentPage }
  showPage('rubrica')
  await initRubricaPage()
  await nuovoContatto(c.categoria)
  if (el('c-ragione')) el('c-ragione').value = testo
  showContattoBanner('warn',
    'Stai creando un contatto al volo. Appena lo salvi torni al documento, con il contatto già collegato.')
}

// ── Stato pagamento sul form movimento ───────────────────────────────────────

function onMovStatoChange() {
  var pagato = el('f-gia-pagata') ? el('f-gia-pagata').checked : false
  var grp = el('f-data-pagamento-group')
  if (grp) grp.style.display = pagato ? 'block' : 'none'
  // Proposta, non obbligo: se segno pagato e non c'è data, uso quella del movimento
  if (pagato && el('f-data-pagamento') && !getVal('f-data-pagamento')) {
    el('f-data-pagamento').value = getVal('f-data') || ''
  }
  var hint = el('f-stato-hint')
  if (hint) {
    hint.textContent = pagato
      ? 'Il movimento non comparirà fra le scadenze da pagare.'
      : 'Comparirà fra le spese da pagare, con la sua scadenza.'
  }
}

// Regola identica al backfill della FASE 1: una spesa con data passata si
// considera già saldata, una con data futura no. Fra un arretrato fittizio
// (visibile e correggibile) e una spesa che sparisce, si sceglie il visibile.
function proponiStatoDaData() {
  var d = getVal('f-data')
  if (!d || !el('f-stato-pagamento')) return
  var oggi = oggiISO()
  // FASE 8 — la proposta muove la SPUNTA, non piu' un menu di stato.
  var chk = el('f-gia-pagata')
  if (chk) chk.checked = (d <= oggi)
  onMovStatoChange()
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 2 — Scarica PDF della fattura di vendita
// Usa il CSS di stampa già esistente (@media print): il risultato è lo stesso
// identico di Ctrl+P, senza librerie aggiuntive e senza un secondo impaginatore
// da tenere allineato.
// Il nome del file proposto dal browser viene dal titolo del documento: lo
// cambiamo un attimo prima di stampare e lo rimettiamo subito dopo.
// NOTA: nessuna pagina web può salvare un PDF senza passare dalla finestra di
// stampa — è una protezione del browser. Qui la finestra si apre già con il
// nome giusto e la destinazione «Salva come PDF» da scegliere una volta sola.
// ══════════════════════════════════════════════════════════════════════════════

// «Fattura_2026-003_Skinner.pdf»: niente spazi, niente accenti, niente
// caratteri che i file system rifiutano.
// FASE 20 — AAAA-MM-GG_Fattura_NUMERO_Cliente
// La data per prima e in forma AAAA-MM-GG: cosi' l'ordine alfabetico della
// cartella e' anche l'ordine cronologico, senza che nessuno debba ordinare.
// Prima il cliente era troncato alla PRIMA PAROLA: «Ghisletta Stefano»
// diventava «Ghisletta», e due clienti con lo stesso cognome davano lo stesso
// nome di file.
//
// Il pezzo del cantiere non c'e': vedi nomeClientePerFile() qui sotto e il
// riepilogo della FASE 20 — sulla fattura di vendita un cantiere non e'
// registrato da nessuna parte, e inventarlo sarebbe peggio che ometterlo.
function nomeFilePdfFattura(f) {
  if (!f) return 'Fattura'
  var tipo = (f.tipo === 'nota_credito') ? 'NotaCredito' : 'Fattura'
  var num  = f.numero || 'bozza'
  // Una bozza non ha ancora una data di emissione: si usa oggi, cosi' il file
  // non nasce senza data. dataISO()/oggiISO(), mai toISOString().
  var data = f.data_emissione || oggiISO()
  var chi  = nomeClientePerFile(f.cliente_nome)
  return unisciParti([data, tipo, num, chi], '_').replace(/\s+/g, '_')
}

// Il nome del cliente ridotto a qualcosa che un file system accetta, INTERO:
// accenti sciolti nella lettera semplice, spazi in trattino, il resto via.
// Si taglia solo se e' davvero lunghissimo, e mai a meta' di una parola.
function nomeClientePerFile(nome) {
  var s = String(nome == null ? '' : nome)
  if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  s = s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (s.length <= 48) return s
  // Taglio all'ultimo trattino prima del limite: meglio un nome piu' corto di
  // una parola spezzata a meta'.
  var tagliato = s.slice(0, 48)
  var ultimo = tagliato.lastIndexOf('-')
  return (ultimo > 12 ? tagliato.slice(0, ultimo) : tagliato).replace(/-+$/, '')
}

async function scaricaFatturaPDF() {
  var f = currentDetailFattura
  // FASE 22 — come per la stampa: la polizza dev'essere caricata prima, se c'e'.
  try {
    if (f && polizzaDi(f.id)) await preparaPolizzaPerStampa(f.id)
  } catch (e) { console.warn('Polizza nel PDF:', e.message || e) }
  var nome = nomeFilePdfFattura(f)
  var titoloPrima = document.title
  document.title = nome
  // Il ripristino va fatto dopo la stampa, non subito: alcuni browser leggono
  // il titolo quando la finestra si è già aperta.
  var ripristina = function () {
    document.title = titoloPrima
    window.removeEventListener('afterprint', ripristina)
  }
  window.addEventListener('afterprint', ripristina)
  window.print()
  // Rete di sicurezza: se «afterprint» non arriva (succede su qualche browser),
  // il titolo torna comunque a posto.
  setTimeout(ripristina, 60000)
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 3 — CRUSCOTTO
//
// Legge SOLO v_conta_flussi. Mai le tre tabelle direttamente: se i totali si
// calcolassero anche altrove, prima o poi darebbero numeri diversi.
//
// IL CRUSCOTTO E' DI CASSA. Il periodo si applica alla data in cui il denaro si
// e' mosso (data_pagamento), non alla data del documento. Risponde a «quanto e'
// uscito e quanto e' entrato in questo periodo».
// Per questo i suoi totali NON coincidono con quelli della schermata Export,
// che filtra per data del documento (competenza) e comprende anche spese e
// regia di App Cantieri. Sono due domande diverse, non un errore.
// Il confronto che invece deve tornare e' nel BLOCCO 7 di SQL_FASE3.sql.
// ══════════════════════════════════════════════════════════════════════════════

let flussiCache    = null     // righe di v_conta_flussi per l'azienda corrente
let cruscottoModo  = 'anno'   // 'anno' | 'trimestre' | 'mese' | 'custom'
let ivaPeriodiCache = null    // periodi IVA (vuoto finche' CT non e' assoggettata)

// ── Periodo ──────────────────────────────────────────────────────────────────

// Calcolo puro del periodo: nessun accesso al DOM, cosi' lo usano sia il
// Cruscotto sia l'Export senza che la stessa aritmetica sia scritta due volte.
function calcolaPeriodo(modo, anno, trimestre, mese) {
  anno = parseInt(anno, 10) || new Date().getFullYear()
  if (modo === 'trimestre') {
    var t = parseInt(trimestre, 10) || 1
    var m1 = (t - 1) * 3 + 1
    return { da: anno + '-' + pad2(m1) + '-01', a: ultimoGiornoMese(anno, m1 + 2) }
  }
  if (modo === 'mese') {
    var m = parseInt(mese, 10) || 1
    return { da: anno + '-' + pad2(m) + '-01', a: ultimoGiornoMese(anno, m) }
  }
  // anno intero: in Svizzera l'anno fiscale coincide con quello solare
  return { da: anno + '-01-01', a: anno + '-12-31' }
}

function setCruscottoModo(modo) {
  cruscottoModo = modo
  var modi = ['anno', 'trimestre', 'mese', 'custom']
  for (var i = 0; i < modi.length; i++) {
    var b = el('cru-modo-' + modi[i])
    if (b) { if (modi[i] === modo) b.classList.add('active'); else b.classList.remove('active') }
  }
  if (el('cru-anno-group'))      el('cru-anno-group').style.display      = (modo !== 'custom') ? 'block' : 'none'
  if (el('cru-trimestre-group')) el('cru-trimestre-group').style.display = (modo === 'trimestre') ? 'block' : 'none'
  if (el('cru-mese-group'))      el('cru-mese-group').style.display      = (modo === 'mese') ? 'block' : 'none'
  if (modo === 'custom') renderCruscotto()
  else applicaPeriodoCruscotto()
}

function applicaPeriodoCruscotto() {
  if (cruscottoModo === 'custom') return
  var p = calcolaPeriodo(cruscottoModo, getVal('cru-anno'), getVal('cru-trimestre'), getVal('cru-mese'))
  setVal('cru-da', p.da)
  setVal('cru-a', p.a)
  renderCruscotto()
}

function onPeriodoCruscottoManuale() { setCruscottoModo('custom') }

function periodoCruscotto() { return { da: getVal('cru-da'), a: getVal('cru-a') } }

// ── Dati ─────────────────────────────────────────────────────────────────────

async function loadFlussi(force) {
  if (cacheOk('flussi') && !force) return flussiCache || []
  // Senza sessione non si legge niente, ma non e' una lettura riuscita:
  // segnarla tale bloccherebbe ogni tentativo dopo il login.
  if (!currentAziendaId) { flussiCache = []; return flussiCache }
  const { data, error } = await sb
    .from('v_conta_flussi')
    .select('id_origine, tabella_origine, origine_tipo, verso, contatto_id, controparte_nome, descrizione,' +
            ' data_documento, data_scadenza, importo_totale, importo_iva, stato_pagamento,' +
            ' data_pagamento, conto_codice, conto_descrizione, gruppo_codice, gruppo_manuale,' +
            ' gruppo_da_conto, stato_conferma, importo_pagato, residuo, prossima_rata')
    .eq('azienda_id', currentAziendaId)
  if (error) throw error
  flussiCache = data || []
  segnaCacheOk('flussi')
  return flussiCache
}

async function loadIvaPeriodi(force) {
  if (cacheOk('ivaPeriodi') && !force) return ivaPeriodiCache || []
  // FASE 22 — senza sessione non si legge niente, ma non e' una lettura
  // riuscita: segnarla tale bloccherebbe ogni tentativo dopo il login.
  // Stessa guardia di loadContatti e loadCantieri.
  if (!currentAziendaId) { ivaPeriodiCache = ivaPeriodiCache || []; return ivaPeriodiCache }
  try {
    const { data, error } = await sb
      .from('tm_conta_iva_periodi')
      .select('id, valido_da, valido_a, metodo, aliquota_saldo, criterio')
      .eq('azienda_id', currentAziendaId)
      .order('valido_da')
    if (error) throw error
    ivaPeriodiCache = data || []
    segnaCacheOk('ivaPeriodi')
  } catch (e) {
    ivaPeriodiCache = ivaPeriodiCache || []   // non riuscita: il prossimo tentativo riprova
    console.warn('Periodi IVA non letti:', e.message || e)
  }
  return ivaPeriodiCache
}

// La data che conta per la cassa. Ripiego su data_documento per le fatture
// storiche: fino alla FASE 1 l'incasso non registrava nessuna data, quindi il
// dato non esiste. Le righe cosi' ottenute vengono marcate nell'elenco.
function dataCassa(r) { return r.data_pagamento || r.data_documento }
function haRipiegoData(r) { return !r.data_pagamento && r.stato_pagamento === 'pagato' }

// Nulla che sia «da confermare» entra nei totali: oggi nessuno lo produce, lo
// fara' il Ponte AI della FASE 5. Se il filtro mancasse, i totali cambierebbero
// da soli il giorno in cui quella fase arriva.
function confermata(r) { return r.stato_conferma !== 'da_confermare' }

// ── Calcolo dei quattro totali ───────────────────────────────────────────────

function calcolaTotaliCruscotto(righe, da, a) {
  var t = {
    speso:       { importo: 0, righe: [] },
    incassato:   { importo: 0, righe: [] },
    daPagare:    { importo: 0, righe: [] },
    daIncassare: { importo: 0, righe: [] }
  }
  for (var i = 0; i < righe.length; i++) {
    var r = righe[i]
    if (!confermata(r)) continue
    var imp = safeNum(r.importo_totale) || 0

    // FASE 8 — DA PAGARE e DA INCASSARE sono i RESIDUI, non gli importi interi.
    // Prima un documento non saldato contava per tutto il suo valore: con i
    // pagamenti parziali sarebbe un debito gonfiato di quanto e' gia' stato
    // versato. Ignorano il periodo: «quanto devo ancora» e' una fotografia di
    // oggi, non una domanda su un intervallo.
    var res = safeNum(r.residuo)
    if (res == null) res = imp - (safeNum(r.importo_pagato) || 0)   // vista vecchia
    if (r.stato_pagamento !== 'pagato' && Math.abs(res) > 0.005) {
      if (r.verso === 'uscita')  { t.daPagare.importo += res;    t.daPagare.righe.push(r) }
      else                       { t.daIncassare.importo += res; t.daIncassare.righe.push(r) }
    }
  }
  return t
}

// FASE 8 — SPESO e INCASSATO non si leggono piu' dai documenti ma dai
// PAGAMENTI: sono la somma di quello che si e' davvero mosso nel periodo.
// Prima si sommava l'importo intero dei documenti in stato 'pagato', il che
// con i versamenti parziali non direbbe piu' la verita': un documento da 400
// pagato per 200 muoveva 200, non 400 e nemmeno 0.
function sommaPagamentiPeriodo(t, pagamenti, righe, da, a) {
  // indice documento -> verso, per sapere se un pagamento e' entrata o uscita
  var verso = {}, doc = {}
  ;(righe || []).forEach(function (r) {
    if (!confermata(r)) return          // le righe da confermare restano fuori
    verso[r.tabella_origine + ':' + r.id_origine] = r.verso
    doc[r.tabella_origine + ':' + r.id_origine] = r
  })
  ;(pagamenti || []).forEach(function (pg) {
    var k = pg.tabella_origine + ':' + pg.id_origine
    if (!verso[k]) return               // documento non visibile o da confermare
    if (!inPeriodo(pg.data, da, a)) return
    var imp = safeNum(pg.importo) || 0
    if (verso[k] === 'uscita') { t.speso.importo += imp;     t.speso.righe.push(doc[k]) }
    else                       { t.incassato.importo += imp; t.incassato.righe.push(doc[k]) }
  })
  return t
}

// Le barre dei gruppi seguono la stessa regola di cassa dei riquadri: sono la
// scomposizione di SPESO, quindi devono sommare esattamente a SPESO.
function calcolaGruppi(righeSpeso) {
  var per = {}
  for (var i = 0; i < righeSpeso.length; i++) {
    var r = righeSpeso[i]
    var k = r.gruppo_codice || '__nessuno__'
    if (!per[k]) per[k] = { codice: r.gruppo_codice || null, importo: 0, righe: [] }
    per[k].importo += safeNum(r.importo_totale) || 0
    per[k].righe.push(r)
  }
  var lista = Object.keys(per).map(function (k) { return per[k] })
  // Ordinate per importo. «Non assegnato» sempre in fondo, qualunque sia la cifra:
  // non e' un gruppo, e' un lavoro che manca.
  lista.sort(function (x, y) {
    if (!x.codice && y.codice) return 1
    if (x.codice && !y.codice) return -1
    return y.importo - x.importo
  })
  return lista
}

function nomeGruppo(codice) {
  if (!codice) return 'Non assegnato'
  var g = (gruppiCache || []).filter(function (x) { return x.codice === codice })[0]
  return g ? g.nome : codice
}

// ── Disegno della schermata ──────────────────────────────────────────────────

async function initCruscottoPage() {
  if (!currentAziendaId) {
    showCruscottoBanner('err', 'Azienda non trovata: rieffettua il login.')
    return
  }
  html('cru-riquadri', loadingRow('Caricamento movimenti…'))
  try {
    await loadGruppi()
    await loadIvaPeriodi(true)
    await loadFlussi(true)
    await loadPagamenti(true)        // FASE 8: SPESO e INCASSATO vengono da qui
    popolaAnniCruscotto()
    setCruscottoModo('anno')     // default all'apertura: anno in corso
  } catch (e) {
    html('cru-riquadri', '')
    showCruscottoBanner('err', 'Cruscotto non caricato: ' + (e.message || e))
  }
}

function popolaAnniCruscotto() {
  var sel = el('cru-anno')
  if (!sel) return
  var anni = {}
  ;(flussiCache || []).forEach(function (r) {
    var d = dataCassa(r)
    if (d && String(d).length >= 4) anni[String(d).slice(0, 4)] = true
  })
  // FASE 8 — anche gli anni in cui si e' pagato, che possono essere diversi
  // da quelli dei documenti.
  ;(pagamentiCache || []).forEach(function (pg) {
    if (pg.data && String(pg.data).length >= 4) anni[String(pg.data).slice(0, 4)] = true
  })
  anni[String(new Date().getFullYear())] = true   // l'anno corrente c'e' sempre
  var lista = Object.keys(anni).sort().reverse()
  var prec = sel.value
  sel.innerHTML = lista.map(function (y) { return '<option value="' + y + '">' + y + '</option>' }).join('')
  sel.value = (prec && lista.indexOf(prec) !== -1) ? prec : String(new Date().getFullYear())
}

function showCruscottoBanner(tipo, msg) {
  var icona = tipo === 'ok' ? '✅' : tipo === 'warn' ? '⚠️' : '❌'
  html('cruscotto-banner',
    '<div class="fase-banner ' + tipo + '" role="' + (tipo === 'ok' ? 'status' : 'alert') + '">' +
      '<span class="icon" aria-hidden="true">' + icona + '</span>' +
      '<div class="msg">' + esc(msg) + '</div>' +
    '</div>')
}

function renderCruscotto() {
  if (!flussiCache) return
  var p = periodoCruscotto()
  var t = calcolaTotaliCruscotto(flussiCache, p.da, p.a)
  // FASE 8 — SPESO e INCASSATO sono la somma dei PAGAMENTI del periodo.
  sommaPagamentiPeriodo(t, pagamentiCache, flussiCache, p.da, p.a)

  renderRiquadri(t)
  renderSaldoPeriodo(t)
  renderIvaRiga(p)
  renderDifferenzaIva(p)        // FASE 24 - l'indicatore, sotto la riga IVA
  renderGruppi(t.speso)
  chiudiElencoCruscotto()
}

// Un riquadro: etichetta, importo con valuta scritta, numero di documenti.
// Mai un numero da solo, mai il solo colore a dare l'informazione.
function boxCruscotto(id, cls, icona, etichetta, dato, notaVuoto) {
  var n = dato.righe.length
  var vuoto = (n === 0)
  var conta = vuoto ? 'nessun documento' : (n === 1 ? '1 documento' : n + ' documenti')
  return '<button type="button" class="cru-box ' + cls + (vuoto ? ' vuoto' : '') + '"' +
           ' id="' + id + '"' +
           (vuoto ? ' aria-disabled="true"' : ' onclick="apriElencoCruscotto(\'' + id + '\')"') +
           ' aria-label="' + esc(etichetta + ': ' + fmtNumIt(dato.importo) + ' franchi, ' + conta) + '">' +
           '<span class="cru-box-etichetta"><span aria-hidden="true">' + icona + '</span>' + esc(etichetta) + '</span>' +
           '<div class="cru-box-importo">' + esc(fmtNumIt(dato.importo)) +
             '<span class="cru-box-valuta"> CHF</span></div>' +
           '<div class="cru-box-conta">' + esc(conta) + '</div>' +
           (vuoto && notaVuoto ? '<div class="cru-box-nota">' + esc(notaVuoto) + '</div>' : '') +
         '</button>'
}

function renderRiquadri(t) {
  // Se non c'e' nulla in sospeso, il numero zero da solo sembra un dato mancante:
  // la frase accanto dice che e' un risultato.
  var notaPagare    = (t.daPagare.righe.length === 0)    ? 'Tutto pagato' : ''
  var notaIncassare = (t.daIncassare.righe.length === 0) ? 'Tutto incassato' : ''

  html('cru-riquadri',
    boxCruscotto('cru-box-speso',       'uscita',        '💸', 'Speso',        t.speso) +
    boxCruscotto('cru-box-incassato',   'entrata',       '💰', 'Incassato',    t.incassato) +
    boxCruscotto('cru-box-dapagare',    'attesa-uscita', '⏳', 'Da pagare',    t.daPagare, notaPagare) +
    boxCruscotto('cru-box-daincassare', 'attesa-entrata','🔵', 'Da incassare', t.daIncassare, notaIncassare)
  )
}

// Il saldo del periodo: quanto e' rimasto, fra quello che e' entrato e quello
// che e' uscito. Stessa regola di cassa dei quattro riquadri: conta la data in
// cui il denaro si e' mosso, non quella dei documenti.
//
// Il segno e' SEMPRE scritto, anche quando e' positivo: «4.726,75» da solo non
// dice se sono soldi entrati o usciti, «+ 4.726,75» si'. E sotto c'e' il conto
// per esteso, perche' un totale che non si puo' rifare a mano non si controlla.
function renderSaldoPeriodo(t) {
  var saldo = t.incassato.importo - t.speso.importo
  var inPerdita = saldo < 0
  // Lo zero non ha segno: «+ 0,00» e «- 0,00» sarebbero solo confusi.
  var segno = (Math.abs(saldo) < 0.005) ? '' : (inPerdita ? '−' : '+')
  var cls = (Math.abs(saldo) < 0.005) ? 'pari' : (inPerdita ? 'perdita' : 'utile')

  html('cru-saldo',
    '<div class="saldo-box ' + cls + '">' +
      '<div class="saldo-etichetta">SALDO DEL PERIODO</div>' +
      '<div class="saldo-importo">' +
        (segno ? '<span class="saldo-segno">' + segno + '</span> ' : '') +
        esc(fmtNumIt(Math.abs(saldo))) + ' <span class="saldo-valuta">CHF</span>' +
      '</div>' +
      '<div class="saldo-calcolo">' +
        'incassato ' + esc(fmtNumIt(t.incassato.importo)) +
        ' − speso ' + esc(fmtNumIt(t.speso.importo)) +
      '</div>' +
      // In perdita: icona E parole. Il rosso da solo non lo direbbe a chi non
      // distingue i colori, e non lo direbbe affatto se stampato in bianco e nero.
      (inPerdita
        ? '<div class="saldo-avviso"><span aria-hidden="true">⚠️</span>' +
          '<span>In perdita nel periodo: è uscito più denaro di quanto ne sia entrato.</span></div>'
        : '') +
    '</div>')
}

// ═════════════════════════════════════════════════════════════════════════════
// FASE 24 — LA DIFFERENZA IVA, COME INDICATORE
//
// COS'E' E COSA NON E'.
// Non e' una dichiarazione IVA e non deve sembrarlo. Umberto oggi NON e'
// soggetto IVA: vende senza IVA, e l'IVA che paga ai fornitori e' per lui puro
// costo. Piu' avanti dovra' registrarsi, e vuole vedere fin d'ora come starebbe
// messo. Quello che c'e' qui e' un'IPOTESI, scritta in chiaro nell'interfaccia:
// il modulo propone, la dichiarazione vera la fa il commercialista.
//
// I DUE CONTI, E PERCHE' SI MOSTRANO AFFIANCATI.
//   (a) metodo effettivo  = IVA sulle vendite - IVA sugli acquisti
//   (b) metodo saldo      = aliquota saldo x cifra d'affari LORDA, e l'IVA
//                           sugli acquisti NON si recupera
// Il confronto fra i due e' il motivo per cui la funzione esiste: serve a
// decidere quale metodo chiedere all'AFC al momento di registrarsi.
//
// DA DOVE ARRIVANO I NUMERI.
// Da `v_conta_flussi`, la stessa vista di Cruscotto, Scadenze ed Export. La
// colonna `importo_iva` e' gia' quella registrata sul documento — totale_iva
// sulle fatture di vendita, iva_importo sulle classificazioni d'acquisto,
// importo_iva sui movimenti propri. NON si ricalcola l'IVA dai totali: si
// userebbe una regola diversa da quella con cui il documento e' stato
// registrato, e due numeri diversi per la stessa cosa sono peggio di nessun
// numero. Stessa regola anche sui documenti da confermare: esclusi, con
// confermata(), come ovunque.
//
// LE ALIQUOTE SONO IMPOSTAZIONI, NON NUMERI SCRITTI QUI.
// L'aliquota saldo dipende dal ramo e la assegna l'AFC: per la carpenteria non
// e' 8,1. Parte VUOTA, e senza di lei il conto (b) non si mostra e si dice
// perche'. L'aliquota ordinaria e' 8,1% oggi, ma e' cambiata in passato e
// cambiera' ancora: sta anche lei nelle impostazioni.
// ═════════════════════════════════════════════════════════════════════════════

var IVA_ORDINARIA_DEFAULT = 8.1

function ivaAliquotaOrdinaria() {
  var n = safeNum(impostazione('iva_aliquota_ordinaria', String(IVA_ORDINARIA_DEFAULT)))
  return (n == null || n <= 0) ? IVA_ORDINARIA_DEFAULT : n
}

// null quando non e' impostata: e' un'informazione, non un valore da inventare.
function ivaAliquotaSaldo() {
  var g = impostazione('iva_aliquota_saldo', '')
  if (g === '' || g == null) return null
  var n = safeNum(g)
  return (n == null || n <= 0) ? null : n
}

// ── Il conto ────────────────────────────────────────────────────────────────
// Un giro solo sulle righe del periodo. Le note di credito hanno gia' il segno
// invertito nella vista, quindi si sommano e basta.
function calcolaDifferenzaIva(righe, da, a) {
  var r = {
    ivaVendite: 0, ivaAcquisti: 0,
    lordoVendite: 0,
    docVendite: 0, docAcquisti: 0,
    senzaIvaVendite: 0, senzaIvaAcquisti: 0,
    scartatiDaConfermare: 0
  }
  for (var i = 0; i < (righe || []).length; i++) {
    var x = righe[i]
    var d = x.data_documento
    if (!d) continue
    if (da && d < da) continue
    if (a && d > a) continue
    // Stessa regola di Cruscotto, Scadenze ed Export: i documenti da
    // confermare non entrano in nessun totale.
    if (!confermata(x)) { r.scartatiDaConfermare++; continue }

    var iva = safeNum(x.importo_iva)
    var tot = safeNum(x.importo_totale) || 0

    if (x.verso === 'entrata') {
      r.docVendite++
      r.lordoVendite += tot
      if (iva == null || iva === 0) r.senzaIvaVendite++
      else r.ivaVendite += iva
    } else {
      r.docAcquisti++
      if (iva == null || iva === 0) r.senzaIvaAcquisti++
      else r.ivaAcquisti += iva
    }
  }
  r.effettivo = r.ivaVendite - r.ivaAcquisti
  var saldo = ivaAliquotaSaldo()
  r.aliquotaSaldo = saldo
  r.metodoSaldo = (saldo == null) ? null : (r.lordoVendite * saldo / 100)
  return r
}

// ── Come si legge un risultato ────────────────────────────────────────────────
// Mai il solo segno o il solo colore: si scrive a parole da che parte va.
function versoIva(n) {
  if (Math.abs(n) < 0.005) return { testo: 'in pareggio', cls: 'neutro', icona: '\u2796' }
  return n > 0
    ? { testo: 'da versare allo Stato',    cls: 'da-versare', icona: '\u2B06\uFE0F' }
    : { testo: 'a credito verso lo Stato', cls: 'a-credito',  icona: '\u2B07\uFE0F' }
}

function rigaContoIva(etichetta, valore, spiegazione) {
  var v = versoIva(valore)
  return '<div class="iva-conto ' + v.cls + '">' +
           '<div class="iva-conto-et">' + etichetta + '</div>' +
           '<div class="iva-conto-val">' + fmtNum2(Math.abs(valore)) + ' CHF</div>' +
           '<div class="iva-conto-verso"><span aria-hidden="true">' + v.icona + '</span> ' +
             esc(v.testo) + '</div>' +
           '<div class="iva-conto-spieg">' + spiegazione + '</div>' +
         '</div>'
}

function renderDifferenzaIva(p) {
  var cont = el('cru-iva-differenza')
  if (!cont) return
  var r = calcolaDifferenzaIva(flussiCache || [], p.da, p.a)
  var ord = ivaAliquotaOrdinaria()

  // L'avvertenza viene PRIMA dei numeri, non dopo: un numero letto senza
  // sapere che e' un'ipotesi resta in testa come se fosse un dato.
  var avviso =
    '<div class="fase-banner warn" role="status" style="margin-bottom:14px">' +
      '<span class="icon" aria-hidden="true">\u26A0\uFE0F</span>' +
      '<div class="msg"><strong>Questo non &egrave; una dichiarazione IVA.</strong>' +
        '<small>Oggi non sei soggetto IVA: fatturi senza IVA e quella che paghi ai ' +
        'fornitori &egrave; un costo, non la recuperi. Questi due conti sono ' +
        'un&rsquo;<strong>ipotesi</strong>, per vedere come staresti messo se ti registrassi. ' +
        'La dichiarazione vera la fa il commercialista.</small>' +
      '</div>' +
    '</div>'

  // (a) metodo effettivo
  var contoA = rigaContoIva(
    '\uD83E\uDDEE Metodo effettivo',
    r.effettivo,
    'IVA sulle vendite ' + fmtNum2(r.ivaVendite) + ' CHF &minus; IVA sugli acquisti ' +
    fmtNum2(r.ivaAcquisti) + ' CHF')

  // (b) metodo dell'aliquota saldo — solo se l'aliquota c'e'
  var contoB
  if (r.aliquotaSaldo == null) {
    contoB =
      '<div class="iva-conto mancante">' +
        '<div class="iva-conto-et">\uD83D\uDCD0 Metodo dell&rsquo;aliquota saldo</div>' +
        '<div class="iva-conto-val dim">non calcolabile</div>' +
        '<div class="iva-conto-spieg">Manca l&rsquo;<strong>aliquota saldo</strong>. ' +
          'Non &egrave; l&rsquo;8,1%: dipende dal ramo e la assegna l&rsquo;AFC quando ti ' +
          'registri, e per la carpenteria &egrave; un&rsquo;altra. Non me la invento &mdash; ' +
          'scrivila in <button type="button" class="link-btn" ' +
          'onclick="apriImpostazioniIva()">Impostazioni ditta</button> ' +
          'e questo conto compare.</div>' +
      '</div>'
  } else {
    contoB = rigaContoIva(
      '\uD83D\uDCD0 Metodo dell&rsquo;aliquota saldo (' + fmtNumIt(r.aliquotaSaldo) + '%)',
      r.metodoSaldo,
      fmtNumIt(r.aliquotaSaldo) + '% di ' + fmtNum2(r.lordoVendite) +
      ' CHF di cifra d&rsquo;affari lorda. L&rsquo;IVA sugli acquisti non si recupera: ' +
      'non entra nel conto.') +
      '<div class="iva-nota-fattura">' +
        '<span aria-hidden="true">\uD83D\uDCCC</span> <strong>Al cliente si fattura sempre ' +
        'l&rsquo;aliquota ordinaria (' + fmtNumIt(ord) + '%).</strong> L&rsquo;aliquota saldo ' +
        '&egrave; solo quella che versi all&rsquo;AFC, non quella che scrivi in fattura: ' +
        '&egrave; l&rsquo;equivoco pi&ugrave; comune di questo metodo, e porta a fatturare male.' +
      '</div>'
  }

  // Il confronto: e' il motivo per cui la funzione esiste.
  var confronto = ''
  if (r.aliquotaSaldo != null) {
    var diff = r.effettivo - r.metodoSaldo
    confronto = '<div class="iva-confronto">' +
      (Math.abs(diff) < 0.005
        ? 'Con questi numeri i due metodi si equivalgono.'
        : (diff > 0
            ? '<strong>Con l&rsquo;aliquota saldo verseresti ' + fmtNum2(Math.abs(diff)) +
              ' CHF in meno</strong> rispetto al metodo effettivo.'
            : '<strong>Con il metodo effettivo verseresti ' + fmtNum2(Math.abs(diff)) +
              ' CHF in meno</strong> rispetto all&rsquo;aliquota saldo.')) +
      ' Su un periodo solo non si decide: guarda pi&ugrave; periodi prima di scegliere quale ' +
      'metodo chiedere all&rsquo;AFC.</div>'
  }

  // Su quanti documenti e' costruito. Senza questa riga il totale sembra
  // completo, e oggi non lo e' quasi mai: la maggior parte dei documenti e'
  // registrata senza codice IVA, e conta zero.
  var senzaIva = r.senzaIvaVendite + r.senzaIvaAcquisti
  var totDoc = r.docVendite + r.docAcquisti
  var base =
    '<div class="iva-base">' +
      '<span aria-hidden="true">\uD83D\uDCC4</span> Calcolato su <strong>' + totDoc +
      (totDoc === 1 ? ' documento' : ' documenti') + '</strong> del periodo (' +
      r.docVendite + ' in entrata, ' + r.docAcquisti + ' in uscita)' +
      (senzaIva
        ? ', di cui <strong>' + senzaIva + ' senza IVA indicata</strong>, che contano zero. ' +
          'Oggi &egrave; la maggioranza: finch&eacute; non sei soggetto IVA i documenti si ' +
          'registrano senza. Il conto qui sopra &egrave; quindi pi&ugrave; basso di quello ' +
          'che sarebbe davvero.'
        : '.') +
      (r.scartatiDaConfermare
        ? (r.scartatiDaConfermare === 1 ? ' Escluso 1 documento da confermare.' : ' Esclusi ' + r.scartatiDaConfermare + ' documenti da confermare.')
        : '') +
    '</div>'

  html('cru-iva-differenza',
    '<div class="card">' +
      '<div class="card-title">\uD83E\uDDFE Differenza IVA ' +
        '<span class="dim">(indicatore, non una dichiarazione)</span></div>' +
      avviso +
      '<div class="iva-conti">' + contoA + contoB + '</div>' +
      confronto +
      base +
      '<div class="form-hint" style="margin-top:12px">' +
        'Il periodo &egrave; quello scelto qui sopra. In Svizzera si dichiara per trimestre ' +
        'col metodo effettivo e per semestre con l&rsquo;aliquota saldo: per un confronto ' +
        'realistico usa <strong>Trimestre</strong>.' +
      '</div>' +
    '</div>')
}

// ── Le due aliquote, salvate nelle impostazioni ─────────────────────────────
// Un bottone suo e non quello generale della ditta: queste due stanno in
// tm_conta_impostazioni (chiave/valore), non in tm_aziende, e mescolarle al
// salvataggio dell'anagrafica vorrebbe dire due scritture diverse dietro un
// bottone solo.
async function salvaAliquoteIva() {
  var btn = el('imp-iva-salva-btn')
  var ord = getVal('imp-iva-ordinaria')
  var sal = getVal('imp-iva-saldo')

  var nOrd = safeNum(ord)
  if (ord !== '' && (nOrd == null || nOrd <= 0 || nOrd > 100)) {
    showFattureBanner('impostazioni-banner', 'err',
      'L\u2019aliquota ordinaria deve essere una percentuale fra 0 e 100. Oggi in Svizzera \u00e8 8,1.')
    return
  }
  // Vuota e' un valore legittimo, anzi e' quello di partenza: vuol dire «non
  // la so ancora», e il conto col metodo saldo semplicemente non si mostra.
  var nSal = safeNum(sal)
  if (sal !== '' && (nSal == null || nSal <= 0 || nSal > 100)) {
    showFattureBanner('impostazioni-banner', 'err',
      'L\u2019aliquota saldo deve essere una percentuale fra 0 e 100, oppure vuota se non la sai ancora.')
    return
  }

  if (btn) { btn.disabled = true; btn.textContent = '\u23F3 Salvataggio\u2026' }
  try {
    await salvaImpostazioneConta('iva_aliquota_ordinaria',
      ord === '' ? String(IVA_ORDINARIA_DEFAULT) : nOrd,
      'Aliquota IVA ordinaria in percentuale (indicatore Differenza IVA)')
    await salvaImpostazioneConta('iva_aliquota_saldo', sal === '' ? '' : nSal,
      'Aliquota saldo AFC in percentuale, vuota se non assegnata (indicatore Differenza IVA)')
    showFattureBanner('impostazioni-banner', 'ok', sal === ''
      ? 'Aliquote salvate. L\u2019aliquota saldo \u00e8 vuota: in Situazione quel conto resta nascosto, e c\u2019\u00e8 scritto perch\u00e9.'
      : 'Aliquote salvate. Apri Situazione per vedere il confronto fra i due metodi.')
  } catch (e) {
    showFattureBanner('impostazioni-banner', 'err', 'Aliquote non salvate: ' + (e.message || e))
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '\uD83D\uDCBE Salva le aliquote' }
  }
}

// Va alle impostazioni E porta l'occhio sul campo giusto: mandare qualcuno in
// una pagina lunga senza dirgli dove guardare e' mezzo aiuto.
function apriImpostazioniIva() {
  showPage('impostazioni')
  initImpostazioniPage().then(function () {
    var c = el('imp-iva-saldo')
    if (c) { c.scrollIntoView({ block: 'center' }); c.focus() }
  })
}

// Riga IVA: compare SOLO se esiste un periodo IVA in vigore. Mostrare importi a
// zero suggerirebbe un calcolo fatto, mentre qui l'IVA semplicemente non c'e'.
function renderIvaRiga(p) {
  var attivi = (ivaPeriodiCache || []).filter(function (x) {
    if (x.valido_da && p.a && x.valido_da > p.a) return false          // inizia dopo il periodo
    if (x.valido_a  && p.da && x.valido_a  < p.da) return false        // finito prima del periodo
    return true
  })

  if (!attivi.length) {
    html('cru-iva',
      '<div class="cru-iva-riga">' +
        '<span aria-hidden="true">🧾</span>' +
        '<strong>IVA non attiva</strong>' +
        '<span class="dim">Carpenteria Ticinese non è assoggettata: non c\'è nessuna IVA da calcolare in questo periodo.</span>' +
        '<button type="button" class="link-btn link-conf" onclick="showPage(\'impostazioni\'); initImpostazioniPage()">Apri le impostazioni ditta</button>' +
      '</div>')
    return
  }

  var per = attivi[0]
  var metodo = per.metodo === 'saldo'
    ? 'aliquota saldo ' + fmtNumIt(safeNum(per.aliquota_saldo) || 0) + ' %'
    : 'metodo effettivo'
  html('cru-iva',
    '<div class="cru-iva-riga">' +
      '<span aria-hidden="true">🧾</span>' +
      '<strong>IVA attiva</strong>' +
      '<span>' + esc(metodo + ' · criterio ' + (per.criterio || '—')) +
        ' · in vigore dal ' + esc(fmtDate(per.valido_da)) + '</span>' +
    '</div>')
}

function renderGruppi(speso) {
  var sub = el('cru-gruppi-sottotitolo')
  if (sub) sub.textContent = 'Come si scompone il totale «Speso» del periodo. Le percentuali sono calcolate su quel totale.'

  if (!speso.righe.length) {
    html('cru-gruppi',
      '<div class="cru-vuoto">' +
        '<strong>Nessuna spesa saldata in questo periodo.</strong><br>' +
        'Quando ci saranno spese saldate, qui compare come si dividono fra i nove gruppi.' +
      '</div>')
    return
  }

  var lista = calcolaGruppi(speso.righe)
  var totale = speso.importo

  // Tutte le spese senza gruppo: le barre non direbbero niente.
  var conGruppo = lista.filter(function (g) { return g.codice })
  if (!conGruppo.length) {
    html('cru-gruppi',
      '<div class="cru-vuoto">' +
        '<strong>Nessun movimento classificato per gruppo.</strong><br>' +
        'Il gruppo si ricava dal conto contabile: finché i movimenti non sono classificati, ' +
        'non c\'è modo di sapere a quale gruppo appartengono.<br>' +
        '<button type="button" class="btn-primary" style="margin-top:10px" ' +
        'onclick="showPage(\'movimenti\'); loadDaClassificare()">Vai a «Da classificare»</button>' +
      '</div>')
    return
  }

  var rows = lista.map(function (g) {
    var perc = totale ? (g.importo / totale * 100) : 0
    var nonAss = !g.codice
    var etichetta = nomeGruppo(g.codice)
    var n = g.righe.length
    return '<button type="button" class="gruppo-riga' + (nonAss ? ' non-assegnato' : '') + '"' +
             ' onclick="apriElencoCruscotto(\'gruppo\', \'' + (g.codice || '') + '\')"' +
             ' aria-label="' + esc(etichetta + ': ' + fmtNumIt(g.importo) + ' franchi, ' +
                                   fmtNumIt(perc) + ' per cento, ' + n + (n === 1 ? ' documento' : ' documenti')) + '">' +
             '<span class="gruppo-riga-testa">' +
               (nonAss ? '' : '<span class="gruppo-cod">' + esc(g.codice) + '</span>') +
               '<span class="gruppo-nome">' + esc(etichetta) + '</span>' +
               '<span class="gruppo-importo">' + esc(fmtNumIt(g.importo)) + ' CHF</span>' +
               '<span class="gruppo-perc">' + esc(fmtNumIt(perc)) + ' %</span>' +
             '</span>' +
             '<span class="gruppo-barra-sfondo">' +
               '<span class="gruppo-barra" style="width:' + Math.max(0, Math.min(100, perc)).toFixed(1) + '%"></span>' +
             '</span>' +
           '</button>'
  }).join('')

  var nonAssegnate = lista.filter(function (g) { return !g.codice })[0]
  var avviso = nonAssegnate
    ? '<div class="nota-cruscotto" style="margin-top:12px">' +
        '<span aria-hidden="true">⚠️</span>' +
        '<span><strong>' + esc(fmtNumIt(nonAssegnate.importo)) + ' CHF</strong> non hanno ancora un gruppo, ' +
        'perché i documenti non sono classificati o il loro conto non è associato a nessun gruppo. ' +
        '<button type="button" class="link-btn" onclick="showPage(\'movimenti\'); loadDaClassificare()">Classifica questi movimenti</button></span>' +
      '</div>'
    : ''

  html('cru-gruppi', rows + avviso)
}

// ── Elenco filtrato ──────────────────────────────────────────────────────────

function apriElencoCruscotto(quale, param) {
  var p = periodoCruscotto()
  var t = calcolaTotaliCruscotto(flussiCache || [], p.da, p.a)
  sommaPagamentiPeriodo(t, pagamentiCache, flussiCache, p.da, p.a)
  var righe = [], titolo = '', sotto = ''

  if (quale === 'cru-box-speso') {
    righe = t.speso.righe;       titolo = '💸 Speso nel periodo'
    sotto = 'Documenti il cui pagamento è avvenuto fra il ' + fmtDate(p.da) + ' e il ' + fmtDate(p.a) + '.'
  } else if (quale === 'cru-box-incassato') {
    righe = t.incassato.righe;   titolo = '💰 Incassato nel periodo'
    sotto = 'Documenti incassati fra il ' + fmtDate(p.da) + ' e il ' + fmtDate(p.a) + '.'
  } else if (quale === 'cru-box-dapagare') {
    righe = t.daPagare.righe;    titolo = '⏳ Da pagare'
    sotto = 'Tutto quello che resta da pagare, a qualunque data: questo elenco non dipende dal periodo scelto.'
  } else if (quale === 'cru-box-daincassare') {
    righe = t.daIncassare.righe; titolo = '🔵 Da incassare'
    sotto = 'Tutto quello che resta da incassare, a qualunque data: questo elenco non dipende dal periodo scelto.'
  } else if (quale === 'gruppo') {
    var g = calcolaGruppi(t.speso.righe).filter(function (x) { return (x.codice || '') === (param || '') })[0]
    righe = g ? g.righe : []
    titolo = '📦 ' + nomeGruppo(param || null)
    sotto = 'Spese pagate nel periodo che appartengono a questo gruppo.'
  }

  if (el('cru-elenco-titolo'))      el('cru-elenco-titolo').textContent = titolo
  if (el('cru-elenco-sottotitolo')) el('cru-elenco-sottotitolo').textContent = sotto

  if (!righe.length) {
    html('cru-elenco', '<div class="cru-vuoto">Nessun documento in questo elenco.</div>')
  } else {
    righe = righe.slice().sort(function (x, y) {
      return String(dataCassa(y) || '').localeCompare(String(dataCassa(x) || ''))
    })
    html('cru-elenco', righe.map(function (r) {
      var conto = r.conto_codice
        ? r.conto_codice + ' · ' + (r.conto_descrizione || '')
        : 'non classificato'
      return '<div class="cru-elenco-riga">' +
        '<span class="cru-elenco-nome">' + esc(r.controparte_nome || '—') + '</span>' +
        '<span class="cru-elenco-meta">' + esc(fmtDate(dataCassa(r))) + ' · conto ' + esc(conto) + '</span>' +
        (haRipiegoData(r) ? '<span class="cru-tag-ripiego">data incasso non registrata</span>' : '') +
        '<span class="cru-elenco-imp">' + esc(fmtNumIt(safeNum(r.importo_totale) || 0)) + ' CHF</span>' +
      '</div>'
    }).join(''))
  }

  var card = el('cru-elenco-card')
  if (card) { card.style.display = 'block'; card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }
}

function chiudiElencoCruscotto() {
  var card = el('cru-elenco-card')
  if (card) card.style.display = 'none'
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 3.2 — Il gruppo proposto dal conto, nella classificazione
//
// Il gruppo NON e' un campo indipendente: e' un derivato del conto. Qui lo si
// mostra e lo si puo' forzare, ma finche' resta uguale a quello del conto NON
// viene salvato niente: la riga continua a seguire il conto.
// Si scrive un override solo quando l'utente sceglie deliberatamente altro.
// ══════════════════════════════════════════════════════════════════════════════

// Le tre tabelle su cui un override si puo' scrivere. 'spesa' e 'regia' sono di
// App Cantieri: fuori perimetro, non si toccano.
function tabellaPerOrigine(origineTipo) {
  if (origineTipo === 'proprio')  return 'tm_conta_movimenti_propri'
  if (origineTipo === 'acquisto') return 'tm_conta_fatture_acquisto'
  if (origineTipo === 'fattura')  return 'tm_conta_fatture'
  return null
}

// Il gruppo che il conto selezionato suggerisce.
function gruppoDelContoSelezionato() {
  var id = getVal('cls-conto')
  if (!id) return null
  var c = (contiCache || []).filter(function (x) { return x.id === id })[0]
  return c ? (c.gruppo_codice || null) : null
}

// Ridisegna il menu del gruppo dopo un cambio di conto.
// Regola: se l'utente non ha ancora forzato niente, il gruppo segue il conto.
// Se ha forzato, resta com'e' — e l'avviso spiega la differenza.
async function aggiornaGruppoDaConto(forzaRiallineo) {
  var sel = el('cls-gruppo')
  if (!sel) return
  await loadGruppi()
  var dalConto = gruppoDelContoSelezionato()
  var attuale  = sel.value
  var scelto   = (forzaRiallineo || !clsGruppoForzato) ? (dalConto || '') : attuale
  sel.innerHTML = buildGruppoOptionsCls(scelto)
  if (forzaRiallineo) clsGruppoForzato = false
  renderNotaGruppo()
}

// Il campo resta visibile anche quando e' vuoto: «Non assegnato» e' scritto,
// non lasciato indovinare da un menu vuoto.
function buildGruppoOptionsCls(selected) {
  // Stessa regola del menu principale: un elenco vuoto si dichiara.
  if (!gruppiCache || !gruppiCache.length) return opzioneGruppiMancanti()
  var out = '<option value=""' + (!selected ? ' selected' : '') + '>— Non assegnato —</option>'
  ;(gruppiCache || []).forEach(function (g) {
    out += '<option value="' + esc(g.codice) + '"' + (g.codice === selected ? ' selected' : '') + '>' +
           esc(g.codice + ' · ' + g.nome) + '</option>'
  })
  return out
}

let clsGruppoForzato = false   // true = l'utente ha scelto a mano, non si ricalcola

function onClsGruppoChange() {
  clsGruppoForzato = true
  renderNotaGruppo()
}

function renderNotaGruppo() {
  var sel = el('cls-gruppo')
  if (!sel) return
  var scelto   = sel.value || null
  var dalConto = gruppoDelContoSelezionato()

  // Nota sotto il campo: dice DA DOVE viene il valore, in parole.
  var nota = ''
  if (!clsGruppoForzato && dalConto && scelto === dalConto) {
    nota = '<span class="gruppo-proposto">✨ proposto dal conto — modificabile</span>'
  } else if (clsGruppoForzato) {
    nota = '<span class="gruppo-proposto">✍️ scelto a mano — resta così finché non lo cambi</span>'
  } else if (!dalConto && !scelto) {
    nota = '<span class="dim" style="font-size:11px">Il conto scelto non appartiene a nessun gruppo di spesa: resta «Non assegnato».</span>'
  }
  html('cls-gruppo-nota', nota)

  // Avviso NON bloccante quando conto e gruppo dicono cose diverse.
  if (dalConto && scelto && scelto !== dalConto) {
    html('cls-gruppo-avviso',
      '<div class="gruppo-discorde">' +
        '<span aria-hidden="true">⚠️</span>' +
        '<span><strong>Attenzione:</strong> il conto dice <strong>' + esc(nomeGruppo(dalConto)) +
        '</strong>, il gruppo dice <strong>' + esc(nomeGruppo(scelto)) + '</strong>. ' +
        'Il commercialista vedrà <strong>' + esc(nomeGruppo(dalConto)) +
        '</strong>, il cruscotto <strong>' + esc(nomeGruppo(scelto)) + '</strong>. ' +
        'Puoi salvare lo stesso: è solo un avviso.</span>' +
      '</div>')
  } else {
    html('cls-gruppo-avviso', '')
  }
}

// Salvataggio dell'override, dopo la classificazione.
// Scrive NULL quando il gruppo coincide con quello del conto: cosi' la riga
// torna a seguire il conto e un domani cambiare conto cambia anche il gruppo.
async function salvaOverrideGruppo(movimenti) {
  var sel = el('cls-gruppo')
  if (!sel) return
  var scelto   = sel.value || null
  var dalConto = gruppoDelContoSelezionato()
  var override = (scelto && scelto !== dalConto) ? scelto : null

  for (var i = 0; i < movimenti.length; i++) {
    var m = movimenti[i]
    var tab = tabellaPerOrigine(m.origine_tipo)
    if (!tab) continue        // spese e regia: fuori perimetro, niente da scrivere
    try {
      const { error } = await sb.from(tab)
        .update({ gruppo_codice: override })
        .eq('id', m.origine_id)
        .eq('azienda_id', currentAziendaId)
        .select()
      if (error) throw error
    } catch (e) {
      // Non blocca la classificazione, che e' gia' salvata: avvisa e basta.
      console.warn('Override gruppo non salvato per ' + m.origine_id + ':', e.message || e)
      showClsBanner('warn', 'Classificazione salvata, ma il gruppo forzato non è stato scritto: ' + (e.message || e))
    }
  }
  flussiCache = null   // il cruscotto dovra' rileggere
}

// Prepara il campo gruppo all'apertura della modale di classificazione.
// Se il movimento ha gia' un override salvato, lo ripropone: aprire e
// risalvare una classificazione non deve cancellare una scelta fatta prima.
async function preparaCampoGruppo() {
  clsGruppoForzato = false
  var grp = el('cls-gruppo-group')
  var target = classifyTargets && classifyTargets.length ? classifyTargets : []

  // Il campo si mostra solo se l'override e' scrivibile da qualche parte.
  // Per 'spesa' e 'regia' (App Cantieri) non c'e' nessuna colonna da scrivere.
  var scrivibile = target.some(function (m) { return !!tabellaPerOrigine(m.origine_tipo) })
  if (grp) grp.style.display = scrivibile ? 'block' : 'none'
  if (!scrivibile) return

  await aggiornaGruppoDaConto(true)

  // Un solo movimento: si recupera l'override gia' salvato, se c'e'.
  if (target.length === 1) {
    try {
      var righe = await loadFlussi()
      var r = (righe || []).filter(function (x) { return x.id_origine === target[0].origine_id })[0]
      if (r && r.gruppo_manuale) {
        var sel = el('cls-gruppo')
        if (sel) {
          sel.innerHTML = buildGruppoOptionsCls(r.gruppo_manuale)
          clsGruppoForzato = true
          renderNotaGruppo()
        }
      }
    } catch (_) { /* senza la vista si resta sul gruppo del conto */ }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 4 — SCADENZE E AVVISI
//
// Legge SOLO v_conta_flussi, come il Cruscotto. Nessun SQL nuovo: la vista ha
// gia' data_scadenza, stato_pagamento e verso.
//
// I giorni si scrivono a parole — «scaduto da 4 giorni», mai «-4»: un numero
// negativo davanti a una data va interpretato, una frase no.
// ══════════════════════════════════════════════════════════════════════════════

let impostazioniConta = null   // chiave -> valore, da tm_conta_impostazioni
let scadenzeCache     = null   // ultimo calcolo dei blocchi (per il badge)

// ── Impostazioni del modulo ──────────────────────────────────────────────────

async function loadImpostazioniConta(force) {
  if (impostazioniConta && !force) return impostazioniConta
  // FASE 22 — la stessa trappola delle altre cache, in un'altra forma: prima
  // si metteva impostazioniConta = {} e si usciva, e quell'oggetto vuoto —
  // «vero» in JavaScript — restava in cache per tutta la sessione anche dopo
  // il login. Le impostazioni della busta e della taratura sparivano cosi'.
  // Adesso senza sessione non si scrive niente in cache: si riprova dopo.
  if (!currentAziendaId) return impostazioniConta || {}
  impostazioniConta = {}
  try {
    const { data, error } = await sb
      .from('tm_conta_impostazioni')
      .select('chiave, valore')
      .eq('azienda_id', currentAziendaId)
    if (error) throw error
    ;(data || []).forEach(function (r) { impostazioniConta[r.chiave] = r.valore })
  } catch (e) {
    console.warn('Impostazioni contabilità non lette:', e.message || e)
  }
  return impostazioniConta
}

function impostazione(chiave, seManca) {
  if (!impostazioniConta || impostazioniConta[chiave] == null) return seManca
  return impostazioniConta[chiave]
}

function giorniPreavviso() {
  var n = parseInt(impostazione('giorni_preavviso_scadenze', '7'), 10)
  return (isNaN(n) || n < 0) ? 7 : n
}

function finestraScadenzeAttiva() {
  return impostazione('mostra_finestra_scadenze', 'si') !== 'no'
}

async function salvaImpostazioneConta(chiave, valore, note) {
  const { error } = await sb
    .from('tm_conta_impostazioni')
    .upsert({ azienda_id: currentAziendaId, chiave: chiave, valore: String(valore), note: note || null },
            { onConflict: 'azienda_id,chiave' })
    .select()
  if (error) throw error
  if (impostazioniConta) impostazioniConta[chiave] = String(valore)
}

// ── Aritmetica delle date ────────────────────────────────────────────────────

// Differenza in giorni interi fra due date 'AAAA-MM-GG'.
// Si passa da Date.UTC per la sola sottrazione: e' l'unico modo di non farsi
// rovinare il conto dall'ora legale, che due volte l'anno accorcia o allunga
// un giorno di un'ora e farebbe arrotondare male. Nessuna data viene MAI
// formattata da qui: per quello ci sono dataISO() e oggiISO() della FASE 2.
function diffGiorni(dataA, dataB) {
  if (!dataA || !dataB) return null
  var a = String(dataA).split('-'), b = String(dataB).split('-')
  if (a.length < 3 || b.length < 3) return null
  var ua = Date.UTC(+a[0], +a[1] - 1, +a[2])
  var ub = Date.UTC(+b[0], +b[1] - 1, +b[2])
  if (isNaN(ua) || isNaN(ub)) return null
  return Math.round((ua - ub) / 86400000)
}

// I giorni a parole. Singolare e plurale corretti: «1 giorno», non «1 giorni».
function giorniAParole(dataScadenza, oggi) {
  var d = diffGiorni(dataScadenza, oggi)
  if (d == null) return { testo: 'senza scadenza', cls: 'assente' }
  if (d === 0)   return { testo: 'scade oggi', cls: 'oggi' }
  if (d < 0) {
    var n = -d
    return { testo: 'scaduto da ' + n + (n === 1 ? ' giorno' : ' giorni'), cls: 'ritardo' }
  }
  return { testo: 'scade fra ' + d + (d === 1 ? ' giorno' : ' giorni'), cls: 'vicino' }
}

// ── I quattro blocchi ────────────────────────────────────────────────────────

// Una riga senza data_scadenza non puo' stare in nessuno dei tre blocchi: senza
// scadenza non c'e' modo di dire se e' in ritardo. Finisce nel blocco grigio,
// che e' un invito a completare il dato, non un avviso.
function calcolaScadenze(righe, oggi, preavviso) {
  var b = {
    scaduto:   { chiave: 'scaduto',   icona: '🔴', titolo: 'Scaduto da pagare',    righe: [], somma: 0 },
    inScadenza:{ chiave: 'inScadenza',icona: '🟠', titolo: 'In scadenza',          righe: [], somma: 0 },
    incasso:   { chiave: 'incasso',   icona: '🔵', titolo: 'Incasso non arrivato', righe: [], somma: 0 },
    senzaData: { chiave: 'senzaData', icona: '⚪', titolo: 'Senza scadenza — da completare', righe: [], somma: 0 },
    // Non e' un blocco: e' il resto. Posizioni aperte che non sono ancora un
    // avviso — uscite oltre il preavviso, entrate non ancora scadute.
    // Servono solo a dire quante sono, senza mescolare urgenza e apertura.
    altre:     { chiave: 'altre',     righe: [], somma: 0 }
  }
  var limite = addDays(oggi, preavviso)

  for (var i = 0; i < (righe || []).length; i++) {
    var r = righe[i]
    // FASE 8 — PRIMA: «!== 'aperto'», cioe' «salta tutto cio' che non e' intatto».
    // Con l'arrivo di 'parziale' quella riga avrebbe saltato anche le fatture
    // pagate a meta': sarebbero sparite da TUTTE le fasce delle scadenze,
    // SCADUTO compreso, senza nessun errore. Proprio i documenti che meritano
    // piu' attenzione. Adesso si salta solo cio' che e' saldato davvero.
    if (r.stato_pagamento === 'pagato') continue
    if (!confermata(r)) continue          // le righe da confermare non sono avvisi
    // FASE 8 — quello che scade e' il RESIDUO, non l'importo pieno: su una
    // fattura da 400 con 200 gia' versati, restano da pagare 200.
    var res = safeNum(r.residuo)
    if (res == null) res = (safeNum(r.importo_totale) || 0) - (safeNum(r.importo_pagato) || 0)
    var imp = res

    // FASE 8 — un documento con un piano rateale compare per la PROSSIMA RATA
    // non pagata, non per il residuo totale: e' quella la cifra che scade a
    // quella data. Il residuo totale si scrive accanto, fra parentesi, cosi'
    // non si perde di vista il quadro.
    var rate = rateDi(r.tabella_origine, r.id_origine)
    var nonPagate = rate.filter(function (x) { return !x.pagamento_id })
    if (nonPagate.length) {
      var pross = nonPagate.slice().sort(function (x, y) {
        return String(x.data_prevista).localeCompare(String(y.data_prevista))
      })[0]
      // Si usa una COPIA della riga: la vista non va modificata, la stanno
      // leggendo anche il cruscotto e i cantieri.
      var rr = Object.assign({}, r, {
        data_scadenza: pross.data_prevista,
        _rata: pross,
        _rateTotali: rate.length,
        _residuoTotale: res
      })
      imp = safeNum(pross.importo_previsto) || 0
      rr._importoRata = imp
      if (r.verso === 'uscita') {
        if (pross.data_prevista < oggi) { b.scaduto.righe.push(rr); b.scaduto.somma += imp }
        else if (pross.data_prevista <= limite) { b.inScadenza.righe.push(rr); b.inScadenza.somma += imp }
      } else {
        if (pross.data_prevista < oggi) { b.incasso.righe.push(rr); b.incasso.somma += imp }
      }
      continue
    }

    if (!r.data_scadenza) { b.senzaData.righe.push(r); b.senzaData.somma += imp; continue }

    if (r.verso === 'uscita') {
      if (r.data_scadenza < oggi) { b.scaduto.righe.push(r); b.scaduto.somma += imp }
      else if (r.data_scadenza <= limite) { b.inScadenza.righe.push(r); b.inScadenza.somma += imp }
      // Oltre il preavviso: non e' ancora un avviso. Si conta soltanto.
      else { b.altre.righe.push(r); b.altre.somma += imp }
    } else {
      // Un incasso e' «non arrivato» dal giorno DOPO la scadenza.
      if (r.data_scadenza < oggi) { b.incasso.righe.push(r); b.incasso.somma += imp }
      else { b.altre.righe.push(r); b.altre.somma += imp }
    }
  }

  // La piu' urgente in cima: chi e' scaduto da piu' tempo, per primo.
  ;['scaduto', 'inScadenza', 'incasso', 'senzaData'].forEach(function (k) {
    b[k].righe.sort(function (x, y) {
      return String(x.data_scadenza || '9999-12-31').localeCompare(String(y.data_scadenza || '9999-12-31'))
    })
  })
  return b
}

// Il conteggio del badge: i TRE blocchi, senza il grigio.
// Il blocco grigio e' un promemoria di compilazione, non una scadenza.
function contaScadenzeUrgenti(b) {
  return b.scaduto.righe.length + b.inScadenza.righe.length + b.incasso.righe.length
}

// ── La schermata ─────────────────────────────────────────────────────────────

async function initScadenzePage() {
  if (!currentAziendaId) {
    showScadenzeBanner('err', 'Azienda non trovata: rieffettua il login.')
    return
  }
  html('scad-blocchi', loadingRow('Caricamento scadenze…'))
  try {
    await loadImpostazioniConta(true)
    await loadFlussi(true)
    await loadPagamenti(true)
    await loadRate(true)
    renderScadenze()
    await refreshScadenzeCount()
  } catch (e) {
    html('scad-blocchi', '')
    showScadenzeBanner('err', 'Scadenze non caricate: ' + (e.message || e))
  }
}

function showScadenzeBanner(tipo, msg) {
  var icona = tipo === 'ok' ? '✅' : tipo === 'warn' ? '⚠️' : '❌'
  html('scadenze-banner',
    '<div class="fase-banner ' + tipo + '" role="' + (tipo === 'ok' ? 'status' : 'alert') + '">' +
      '<span class="icon" aria-hidden="true">' + icona + '</span>' +
      '<div class="msg">' + esc(msg) + '</div>' +
    '</div>')
}

function renderScadenze() {
  var oggi = oggiISO()
  var pre  = giorniPreavviso()
  var b    = calcolaScadenze(flussiCache || [], oggi, pre)
  scadenzeCache = b

  var nota = el('scad-nota-preavviso-testo')
  if (nota) {
    nota.textContent = 'Una fattura entra fra quelle «in scadenza» ' + pre +
      (pre === 1 ? ' giorno' : ' giorni') + ' prima della data di scadenza. ' +
      'Si cambia da «Impostazioni ditta».'
  }

  html('scad-blocchi',
    bloccoScadenze(b.scaduto,    'rosso',   'Fatture da pagare la cui data di scadenza è già passata.') +
    bloccoScadenze(b.inScadenza, 'arancio', 'Da pagare entro i prossimi ' + pre + (pre === 1 ? ' giorno' : ' giorni') + '.') +
    bloccoScadenze(b.incasso,    'blu',     'Fatture emesse e non ancora incassate, con la scadenza già passata.') +
    bloccoScadenze(b.senzaData,  'grigio',  'Documenti aperti a cui manca la data di scadenza: senza quella non si può dire se sono in ritardo.') +
    rigaAltrePosizioni(b.altre)
  )
}

// Il conto delle posizioni aperte che NON sono un avviso.
// Questa schermata risponde a «cosa e' urgente», il Cruscotto a «quanto devo
// ancora»: sono due domande diverse e i due totali non coincidono. Questa riga
// tiene visibile la differenza invece di lasciarla sembrare un numero che balla.
// Scorciatoia usata dal rimando in fondo alla schermata Scadenze.
function vaiAlCruscotto() {
  showPage('cruscotto')
  initCruscottoPage()
}

function rigaAltrePosizioni(altre) {
  var n = altre.righe.length
  if (!n) return ''        // se non ce ne sono, la riga non compare
  var testo = (n === 1)
    ? "Una posizione aperta non ancora in scadenza"
    : 'Altre ' + n + ' posizioni aperte non ancora in scadenza'
  return '<div class="nota-cruscotto" id="scad-altre">' +
      '<span aria-hidden="true">📊</span>' +
      '<span>' + esc(testo) + ', per ' + esc(fmtNumIt(altre.somma)) + ' CHF. ' +
        '<button type="button" class="link-btn" onclick="vaiAlCruscotto()">' +
        (n === 1 ? 'Vedila nel Cruscotto' : 'Vedile nel Cruscotto') + '</button></span>' +
    '</div>'
}

function bloccoScadenze(blocco, colore, spiegazione) {
  var n = blocco.righe.length
  var conta = (n === 0) ? 'nessun documento' : (n === 1 ? '1 documento' : n + ' documenti')

  var corpo = n
    ? blocco.righe.map(function (r) { return rigaScadenza(r, blocco.chiave) }).join('')
    : '<div class="scad-vuoto">Nessuna scadenza in questo blocco. ' + esc(spiegazione) + '</div>'

  return '<div class="scad-blocco ' + colore + '">' +
    '<div class="scad-testa">' +
      '<span aria-hidden="true">' + blocco.icona + '</span>' +
      '<span class="scad-titolo">' + esc(blocco.titolo.toUpperCase()) + '</span>' +
      '<span class="scad-conta">' + esc(conta) + '</span>' +
      (n ? '<span class="scad-somma">' + esc(fmtNumIt(blocco.somma)) + ' CHF</span>' : '') +
    '</div>' +
    '<div class="scad-corpo">' + corpo + '</div>' +
  '</div>'
}

function rigaScadenza(r, blocco) {
  var oggi = oggiISO()
  var q = giorniAParole(r.data_scadenza, oggi)
  var e = etichettaPagamento(r.verso, 'pagato')     // «Pagato» o «Incassato»

  var doc = []
  if (r.descrizione) doc.push(r.descrizione)
  else doc.push(r.verso === 'entrata' ? 'Fattura' : 'Documento')
  if (r.data_documento) doc.push('del ' + fmtDate(r.data_documento))
  if (r.conto_codice) doc.push('conto ' + r.conto_codice + ' ' + (r.conto_descrizione || ''))

  var quando = r.data_scadenza
    ? 'Scadenza ' + fmtDate(r.data_scadenza) + ' — ' + q.testo
    : 'Nessuna data di scadenza registrata'

  // FASE 8 — se si sta guardando una rata, la riga lo dice: «rata 2 di 4».
  // Senza, sembrerebbe che scada l'intera fattura.
  if (r._rata) {
    doc.push('rata ' + r._rata.numero_rata + ' di ' + r._rateTotali)
  }

  return '<div class="scad-riga">' +
    // Nel blocco grigio l'icona resta neutra: li' non c'e' nessuna urgenza,
    // manca solo un dato. Un pallino rosso direbbe il contrario.
    '<span class="scad-riga-icona" aria-hidden="true">' +
      (blocco === 'senzaData' ? '⚪' : (r.verso === 'entrata' ? '🔵' : '🔴')) + '</span>' +
    '<div class="scad-riga-main">' +
      '<div class="scad-nome">' + esc(r.controparte_nome || '—') + '</div>' +
      '<div class="scad-doc">' + esc(doc.join(' · ')) + '</div>' +
      '<div class="scad-quando ' + q.cls + '">' + esc(quando) + '</div>' +
    '</div>' +
    '<div class="scad-riga-imp">' +
      esc(fmtNumIt(r._importoRata != null ? r._importoRata
                   : (safeNum(r.residuo) != null ? safeNum(r.residuo) : (safeNum(r.importo_totale) || 0)))) + ' CHF' +
      // Il residuo totale accanto alla rata: dice quanto resta in tutto, senza
      // che si debba sommare le rate a mente.
      (r._rata && r._residuoTotale != null && Math.abs(r._residuoTotale - r._importoRata) > 0.005
        ? '<span class="scad-residuo-tot">residuo totale ' + esc(fmtNumIt(r._residuoTotale)) + ' CHF</span>'
        : '') +
    '</div>' +
    '<div class="scad-riga-azioni">' +
      '<button type="button" class="azione-rapida" ' +
        'onclick="segnaSaldatoDaScadenze(\'' + esc(r.tabella_origine) + '\', \'' + esc(r.id_origine) +
          '\', \'' + esc(r.verso) + '\', ' + (r._importoRata != null ? r._importoRata
            : (safeNum(r.residuo) != null ? safeNum(r.residuo) : (safeNum(r.importo_totale) || 0))) +
          (r._rata ? ', \'' + esc(r._rata.id) + '\'' : '') + ')">' +
        // Il testo dice CHE COSA si sta saldando: la rata o tutto il resto.
        '✅ ' + (r._rata ? 'Salda la rata ' + r._rata.numero_rata
                          : 'Salda ' + esc(e.testo.toLowerCase())) + '</button>' +
      '<button type="button" class="azione-rapida" ' +
        'onclick="apriDocumentoScadenza(\'' + esc(r.tabella_origine) + '\', \'' + esc(r.id_origine) + '\')">' +
        '✏️ Apri</button>' +
    '</div>' +
  '</div>'
}

// ── Le azioni ────────────────────────────────────────────────────────────────

// Scrive stato_pagamento e data_pagamento sulla tabella di origine.
// Sulle fatture di vendita questi due campi sono nella whitelist del trigger di
// immutabilita' (FASE 1): l'UPDATE passa. Se arrivasse un errore di
// immutabilita' vorrebbe dire che si sta scrivendo un campo sbagliato — e in
// quel caso si deve correggere la chiamata, non aggirare il trigger.
// FASE 8 — non si scrive piu' lo stato: si registra il PAGAMENTO, e lo stato
// lo ricalcola il trigger. L'importo e' il residuo, oppure la rata se il
// documento ne ha una in scadenza: e' quello che si sta davvero pagando.
async function segnaSaldatoDaScadenze(tabella, id, verso, importoDaSaldare, idRata) {
  if (!currentAziendaId) return
  var e = etichettaPagamento(verso, 'pagato')
  try {
    var imp = safeNum(importoDaSaldare)
    if (imp == null || imp <= 0) throw new Error('Importo da saldare non valido.')

    const { data: creato, error } = await sb.from('tm_conta_pagamenti').insert({
      azienda_id: currentAziendaId,
      tabella_origine: tabella, id_origine: id,
      data: oggiISO(), importo: imp,
      created_by: currentUser ? currentUser.id : null
    }).select()
    if (error) throw error

    if (idRata && creato && creato[0]) {
      try {
        await sb.from('tm_conta_rate').update({ pagamento_id: creato[0].id })
          .eq('id', idRata).eq('azienda_id', currentAziendaId).select()
      } catch (eR) { console.warn('Rata non collegata:', eR.message || eR) }
    }
    invalidaCachePagamenti()
    await loadFlussi(true); await loadPagamenti(true); await loadRate(true)

    // I flussi sono stati riletti: la riga sparisce dal blocco e i conteggi si
    // rifanno senza ricaricare la pagina.
    renderScadenze()
    await refreshScadenzeCount()
    showScadenzeBanner('ok', 'Segnato come ' + e.testo.toLowerCase() + ' in data odierna.')
  } catch (err) {
    var m = String(err.message || err)
    if (m.indexOf('sola lettura') !== -1 || m.indexOf('immutabil') !== -1) {
      showScadenzeBanner('err',
        'Il database ha rifiutato la modifica come se si stesse cambiando un dato congelato della fattura. ' +
        'Non è un problema da aggirare: segnalalo, perché vuol dire che questa azione sta scrivendo un campo sbagliato. ' +
        'Messaggio originale: ' + m)
    } else {
      showScadenzeBanner('err', 'Non salvato: ' + m)
    }
  }
}

// Porta il documento nella sua schermata.
async function apriDocumentoScadenza(tabella, id) {
  try {
    if (tabella === 'tm_conta_fatture') {
      showPage('fatture')
      await initFatturePage()
      await viewFattura(id)
    } else if (tabella === 'tm_conta_fatture_acquisto') {
      showPage('acquisti')
      await initAcquistiPage()
      await viewAcquisto(id)
    } else {
      // movimenti propri: si aprono direttamente in modifica
      await startEditMovimento(id)
    }
  } catch (e) {
    showScadenzeBanner('err', 'Impossibile aprire il documento: ' + (e.message || e))
  }
}

// ── FASE 4B — il badge nel menu ──────────────────────────────────────────────
// Stessa classe .nav-badge di «Da classificare», stesso posto nella voce.
// Unica differenza: a zero non c'e' nessun pallino.
async function refreshScadenzeCount() {
  if (!currentUser || !currentAziendaId) return 0
  try {
    await loadImpostazioniConta()
    var righe = await loadFlussi()
    var b = calcolaScadenze(righe, oggiISO(), giorniPreavviso())
    scadenzeCache = b
    var n = contaScadenzeUrgenti(b)

    var badge = el('nav-badge-scadenze')
    if (badge) {
      if (n > 0) {
        badge.style.display = ''
        badge.textContent = String(n)
        badge.setAttribute('aria-label', n === 1 ? '1 scadenza da controllare' : n + ' scadenze da controllare')
      } else {
        // Zero non si mostra: un pallino con lo 0 e' rumore.
        badge.style.display = 'none'
        badge.textContent = ''
        badge.removeAttribute('aria-label')
      }
    }
    return n
  } catch (_) { return 0 }   // non bloccante: il badge non deve fermare l'app
}

// ── FASE 4C — la finestrella all'apertura ────────────────────────────────────

const CHIAVE_VISTA_IL = 'ct_scadenze_vista_il'

// localStorage e non sessionStorage: sessionStorage si azzera a ogni chiusura
// del browser, e la finestra tornerebbe dieci volte al giorno.
function scadenzeGiaVisteOggi() {
  try { return localStorage.getItem(CHIAVE_VISTA_IL) === oggiISO() }
  catch (_) { return false }     // navigazione privata: si comporta come «non vista»
}

function segnaScadenzeViste() {
  try { localStorage.setItem(CHIAVE_VISTA_IL, oggiISO()) } catch (_) { /* non essenziale */ }
}

async function forseMostraFinestraScadenze() {
  // 3. solo a utente autenticato, mai sulla pagina di accesso
  if (!currentUser || !currentAziendaId || currentPage === 'login') return
  // 2. non e' gia' comparsa oggi
  if (scadenzeGiaVisteOggi()) return
  await loadImpostazioniConta()
  if (!finestraScadenzeAttiva()) return

  var n = await refreshScadenzeCount()
  // 1. c'e' almeno una riga nei tre blocchi. Se non c'e' niente in sospeso,
  //    la finestra non compare: nessuno vuole un avviso che dice «tutto bene».
  if (!n) return

  mostraFinestraScadenze(scadenzeCache)
}

function mostraFinestraScadenze(b) {
  if (!b) return
  // Solo il riepilogo: la finestra si legge in due secondi, il dettaglio sta
  // nella schermata. Le righe a zero non si mostrano.
  var righe = [
    { icona: '🔴', testo: etichettaBlocco(b.scaduto.righe.length, 'fattura scaduta', 'fatture scadute'), dato: b.scaduto },
    { icona: '🟠', testo: etichettaBlocco(b.inScadenza.righe.length, 'in scadenza', 'in scadenza'),      dato: b.inScadenza },
    { icona: '🔵', testo: etichettaBlocco(b.incasso.righe.length, 'incasso non arrivato', 'incassi non arrivati'), dato: b.incasso }
  ].filter(function (x) { return x.dato.righe.length > 0 })

  html('scad-modal-body', righe.map(function (x) {
    return '<div class="scad-sommario-riga">' +
      '<span aria-hidden="true">' + x.icona + '</span>' +
      '<span class="scad-sommario-testo">' + esc(x.testo) + '</span>' +
      '<span class="scad-sommario-imp">' + esc(fmtNumIt(x.dato.somma)) + ' CHF</span>' +
    '</div>'
  }).join(''))

  var ov = el('scadenze-overlay')
  if (ov) ov.style.display = 'flex'
  segnaScadenzeViste()      // segnata come vista appena compare, non alla chiusura
}

function etichettaBlocco(n, singolare, plurale) {
  return n + ' ' + (n === 1 ? singolare : plurale)
}

function chiudiFinestraScadenze() {
  var ov = el('scadenze-overlay')
  if (ov) ov.style.display = 'none'
}

function vaiAlleScadenze() {
  chiudiFinestraScadenze()
  showPage('scadenze')
  initScadenzePage()
}

// ══════════════════════════════════════════════════════════════════════════════
// FASE 5A — PONTE COPIA/INCOLLA
//
// Nessuna chiave API, nessun servizio esterno, nessun account: il testo va a
// Claude a mano e la risposta torna a mano. Il file e' pubblico su GitHub Pages,
// quindi qualsiasi chiave scritta qui dentro sarebbe leggibile da chiunque.
//
// Questa strada resta anche quando ci sara' la lettura automatica: e' l'unica
// che non puo' smettere di funzionare perche' un servizio e' giu'.
// ══════════════════════════════════════════════════════════════════════════════

// ── Il prompt ────────────────────────────────────────────────────────────────

// L'elenco dei conti si genera dal database, non e' scritto qui: se Umberto
// aggiunge un conto, il prompt lo conosce senza ripubblicare il programma.
function elencoContiPerPrompt() {
  var conti = (contiCache || []).filter(function (c) {
    // Solo i conti su cui ha senso registrare un acquisto: costi e cespiti.
    // Proporre un ricavo su una fattura ricevuta sarebbe un suggerimento sbagliato.
    return c.tipo === 'costo' || c.tipo === 'attivo'
  })
  if (!conti.length) return '  (elenco conti non disponibile: scegli tu il conto dopo)'
  return conti.map(function (c) {
    return '  ' + c.codice_conto + ' = ' + c.descrizione
  }).join('\n')
}

function testoPromptFattura() {
  return 'Leggi questa fattura e rispondi SOLO con un oggetto\n' +
    'JSON, senza testo prima o dopo, senza backtick.\n\n' +
    'Campi richiesti:\n' +
    '{\n' +
    '  "fornitore": "ragione sociale esatta",\n' +
    '  "numero_fornitore": "numero fattura o null",\n' +
    '  "data": "AAAA-MM-GG",\n' +
    '  "scadenza": "AAAA-MM-GG o null",\n' +
    '  "importo": 0.00,\n' +
    '  "valuta": "CHF",\n' +
    '  "imponibile": 0.00,\n' +
    '  "iva_importo": 0.00,\n' +
    '  "aliquota_iva": 8.1,\n' +
    '  "descrizione": "cosa e\' stato acquistato",\n' +
    '  "conto_suggerito": "codice a 4 cifre",\n' +
    '  "note_lettura": "cosa non si legge bene, o null"\n' +
    '}\n\n' +
    'REGOLE:\n' +
    '- Copia imponibile e IVA COSI\' COME SONO STAMPATI\n' +
    '  sulla fattura. NON ricalcolarli.\n' +
    '- Se un dato non c\'e\' o non si legge: null.\n' +
    '  Non inventare mai un valore.\n' +
    '- Le date in formato AAAA-MM-GG.\n' +
    '- Gli importi con il punto decimale (1234.50).\n' +
    '- conto_suggerito: scegli fra questi conti\n' +
    elencoContiPerPrompt() + '\n' +
    '- note_lettura: scrivi qui se la foto e\' sfocata,\n' +
    '  tagliata, o se un importo e\' incerto.\n'
}

async function copiaPromptFattura() {
  try {
    await ensureContiIva()          // il prompt ha bisogno dell'elenco conti aggiornato
    var testo = testoPromptFattura()
    var copiato = false
    try {
      await navigator.clipboard.writeText(testo)
      copiato = true
    } catch (_) {
      // Alcuni browser negano la clipboard se la pagina non e' in primo piano.
      // Ripiego storico che funziona ovunque: una textarea nascosta e execCommand.
      var ta = document.createElement('textarea')
      ta.value = testo
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      try { copiato = document.execCommand('copy') } catch (__) { copiato = false }
      document.body.removeChild(ta)
    }

    if (copiato) {
      showPonteBanner('ok', 'Prompt copiato. Aprilo in Claude e allega la foto o il PDF della fattura.')
    } else {
      // Se non si riesce a copiare, il testo va comunque mostrato: senza, l'utente
      // resta senza prompt e senza sapere perche'.
      apriIncollaRisposta()
      var box = el('ponte-ai-testo')
      if (box) { box.value = testo; box.select() }
      showPonteBanner('warn',
        'Il browser non ha permesso la copia automatica. Il prompt è qui sotto, già selezionato: copialo a mano con Ctrl+C.')
    }
  } catch (e) {
    showPonteBanner('err', 'Prompt non preparato: ' + (e.message || e))
  }
}

function showPonteBanner(tipo, msg) {
  var icona = tipo === 'ok' ? '✅' : tipo === 'warn' ? '⚠️' : tipo === 'info' ? '⏳' : '❌'
  html('ponte-ai-banner',
    '<div class="fase-banner ' + tipo + '" role="' + (tipo === 'ok' ? 'status' : 'alert') + '">' +
      '<span class="icon" aria-hidden="true">' + icona + '</span>' +
      '<div class="msg">' + esc(msg) + '</div>' +
    '</div>')
}

function apriIncollaRisposta() {
  var box = el('ponte-ai-incolla')
  if (box) box.style.display = 'block'
  var ta = el('ponte-ai-testo')
  if (ta) { ta.value = ''; ta.focus() }
  html('ponte-ai-banner', '')
}

function chiudiIncollaRisposta() {
  var box = el('ponte-ai-incolla')
  if (box) box.style.display = 'none'
  var ta = el('ponte-ai-testo')
  if (ta) ta.value = ''
}

// ── Lettura del JSON ─────────────────────────────────────────────────────────

// La risposta arriva quasi sempre sporca: backtick, «Ecco il JSON:» davanti,
// una frase di commento dopo. Si tiene il primo oggetto graffo-per-graffo.
function estraiJson(testo) {
  var t = String(testo || '').trim()
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  var apre = t.indexOf('{')
  var chiude = t.lastIndexOf('}')
  if (apre === -1 || chiude === -1 || chiude < apre) {
    throw new Error('Nella risposta non c\'è nessun oggetto JSON: manca la parentesi graffa di apertura o di chiusura.')
  }
  var pezzo = t.slice(apre, chiude + 1)
  try {
    return JSON.parse(pezzo)
  } catch (e) {
    throw new Error('Il JSON non è leggibile (' + e.message + '). Copia di nuovo la risposta per intero, senza tagliarla.')
  }
}

// ── Validazioni, una per tipo di campo ───────────────────────────────────────

// Una data deve essere scritta bene E deve esistere davvero: il 31 febbraio
// e' scritto bene ma non esiste, e JavaScript lo trasformerebbe in marzo.
function validaData(v) {
  if (v == null || v === '') return null
  var t = String(v).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null
  var p = t.split('-')
  var anno = +p[0], mese = +p[1], giorno = +p[2]
  if (mese < 1 || mese > 12 || giorno < 1) return null
  var d = new Date(Date.UTC(anno, mese - 1, giorno))
  // Se la data non esiste, i pezzi ricostruiti non coincidono con quelli scritti.
  if (d.getUTCFullYear() !== anno || d.getUTCMonth() !== mese - 1 || d.getUTCDate() !== giorno) return null
  return t
}

function validaImporto(v) {
  if (v == null || v === '') return null
  var n = safeNum(typeof v === 'string' ? v.replace(/'/g, '').replace(/\s/g, '').replace(',', '.') : v)
  if (n == null || n < 0) return null      // un importo negativo su una fattura non ha senso
  return n
}

function validaValuta(v) {
  var t = String(v || '').trim().toUpperCase()
  return (t === 'CHF' || t === 'EUR') ? t : null
}

// Il conto deve esistere davvero nel piano dei conti: se l'AI inventa un codice,
// il campo resta vuoto invece di riempirsi con qualcosa di falso.
function validaConto(codice) {
  if (!codice) return null
  var t = String(codice).trim()
  var c = (contiCache || []).filter(function (x) { return String(x.codice_conto) === t })[0]
  return c || null
}

// Il codice IVA che corrisponde all'aliquota letta, se esiste.
function codiceIvaPerAliquota(aliquota) {
  var a = safeNum(aliquota)
  if (a == null) return null
  var c = (ivaCache || []).filter(function (x) {
    var xa = safeNum(x.aliquota)
    return xa != null && Math.abs(xa - a) < 0.005
  })[0]
  return c || null
}

// ── Applicazione al modulo ───────────────────────────────────────────────────

// La porta del ponte manuale: legge la casella e passa il testo alla
// validazione, che e' una sola per tutti.
async function applicaRispostaAI() {
  html('ponte-ai-note', '')
  var testo = el('ponte-ai-testo') ? el('ponte-ai-testo').value : ''
  if (!String(testo).trim()) {
    showPonteBanner('err', 'La casella è vuota: incolla la risposta di Claude prima di premere «Compila il modulo».')
    return
  }
  var esito = await applicaTestoLettura(testo)
  if (esito.ok) {
    chiudiIncollaRisposta()
    showPonteBanner('ok', 'Modulo compilato dalla lettura. Controlla i campi prima di salvare.')
  }
}

// LA validazione. Prende un testo — da dovunque venga — e o compila un modulo
// coerente, o non tocca niente. Restituisce { ok: true/false }.
async function applicaTestoLettura(testo) {
  var dati
  try {
    dati = estraiJson(testo)
  } catch (e) {
    // Regola non negoziabile: se il JSON e' rotto NON si compila niente.
    // Mezzo modulo riempito e' peggio di un modulo vuoto, perche' sembra a posto.
    showPonteBanner('err', e.message)
    return { ok: false }
  }

  try {
    await ensureContiIva()
    await loadGruppi()
  } catch (_) { /* la compilazione va avanti anche senza gli elenchi */ }

  // Si valida TUTTO prima di scrivere: cosi' o si compila un modulo coerente,
  // o non si tocca niente.
  var scartati = []
  var v = {}

  v.fornitore = (dati.fornitore == null) ? null : String(dati.fornitore).trim() || null
  v.numero    = (dati.numero_fornitore == null) ? null : String(dati.numero_fornitore).trim() || null

  v.data = validaData(dati.data)
  if (dati.data && !v.data) scartati.push('la data «' + dati.data + '» non è una data valida')

  v.scadenza = validaData(dati.scadenza)
  if (dati.scadenza && !v.scadenza) scartati.push('la scadenza «' + dati.scadenza + '» non è una data valida')

  v.importo = validaImporto(dati.importo)
  if (dati.importo != null && v.importo == null) scartati.push('l\'importo «' + dati.importo + '» non è un numero valido')

  v.imponibile = validaImporto(dati.imponibile)
  if (dati.imponibile != null && v.imponibile == null) scartati.push('l\'imponibile «' + dati.imponibile + '» non è un numero valido')

  v.iva = validaImporto(dati.iva_importo)
  if (dati.iva_importo != null && v.iva == null) scartati.push('l\'IVA «' + dati.iva_importo + '» non è un numero valido')

  v.valuta = validaValuta(dati.valuta)
  if (dati.valuta && !v.valuta) scartati.push('la valuta «' + dati.valuta + '» non è ammessa (solo CHF o EUR)')

  var conto = validaConto(dati.conto_suggerito)
  if (dati.conto_suggerito && !conto) {
    scartati.push('il conto «' + dati.conto_suggerito + '» non esiste nel piano dei conti')
  }

  var codIva = codiceIvaPerAliquota(dati.aliquota_iva)

  // ── Coerenza degli importi ──────────────────────────────────────────────
  // Imponibile + IVA deve dare il totale. Non si corregge niente: si avvisa.
  // Gli arrotondamenti di stampa fanno ballare i centesimi, quindi si tollera
  // uno scarto di 5 centesimi.
  var avvisoScarto = null
  if (v.importo != null && v.imponibile != null && v.iva != null) {
    var scarto = Math.abs((v.imponibile + v.iva) - v.importo)
    if (scarto > 0.05) {
      avvisoScarto = 'Imponibile ' + fmtNumIt(v.imponibile) + ' CHF + IVA ' + fmtNumIt(v.iva) +
        ' CHF fa ' + fmtNumIt(v.imponibile + v.iva) + ' CHF, ma il totale letto è ' +
        fmtNumIt(v.importo) + ' CHF: ballano ' + fmtNumIt(scarto) +
        ' CHF. Controlla sulla fattura quale dei tre è sbagliato.'
    }
  }

  // ── Scrittura nel modulo ────────────────────────────────────────────────
  if (v.fornitore) setVal('a-fornitore', v.fornitore)
  if (v.numero)    setVal('a-numero', v.numero)
  if (v.data)      setVal('a-data', v.data)
  if (v.scadenza)  setVal('a-scadenza', v.scadenza)
  if (v.importo != null)    setVal('a-importo', v.importo)
  if (v.valuta)             setVal('a-valuta', v.valuta)
  if (v.imponibile != null) setVal('a-imponibile', v.imponibile)
  if (v.iva != null)        setVal('a-iva', v.iva)
  if (dati.descrizione)     setVal('a-note', String(dati.descrizione).trim())

  if (codIva && el('a-codice-iva')) el('a-codice-iva').innerHTML = buildIvaOptions(codIva.id)

  // Il conto suggerito non ha un campo suo in questo modulo: il conto si
  // assegna dopo, in «Da classificare». Qui se ne usa il GRUPPO, che e' il
  // derivato del conto (FASE 3), e il codice resta scritto nel riquadro.
  if (conto && conto.gruppo_codice) {
    await riempiSelectGruppi('a-gruppo', conto.gruppo_codice)
  }

  // Il contatto NON si collega da solo: il nome letto da una foto non basta a
  // dire che e' quel fornitore in rubrica. Si scrive il testo, il collegamento
  // lo fa Umberto scegliendolo dall'elenco.
  if (el('a-contatto-id')) el('a-contatto-id').value = ''
  html('a-contatto-legato', '')

  renderNoteLettura(dati.note_lettura, scartati, avvisoScarto, conto)
  return { ok: true }
}

// Riquadro sopra il modulo: cosa ha segnalato la lettura, cosa e' stato scartato
// e cosa non torna. Tutto in parole, con l'icona sempre accompagnata dal testo.
function renderNoteLettura(noteLettura, scartati, avvisoScarto, conto) {
  var pezzi = ''

  if (noteLettura) {
    pezzi += '<div class="lettura-nota">' +
      '<span aria-hidden="true">🔎</span>' +
      '<span><strong>La lettura segnala:</strong> ' + esc(String(noteLettura)) + '</span>' +
    '</div>'
  }

  if (avvisoScarto) {
    pezzi += '<div class="lettura-nota avviso">' +
      '<span aria-hidden="true">⚠️</span>' +
      '<span><strong>Gli importi non tornano.</strong> ' + esc(avvisoScarto) +
      ' I campi sono stati compilati lo stesso.</span>' +
    '</div>'
  }

  if (scartati && scartati.length) {
    pezzi += '<div class="lettura-nota avviso">' +
      '<span aria-hidden="true">🚫</span>' +
      '<span><strong>Non ' + (scartati.length === 1 ? 'è stato scritto' : 'sono stati scritti') +
      ' nel modulo:</strong><ul style="margin:5px 0 0 18px">' +
      scartati.map(function (x) { return '<li>' + esc(x) + '</li>' }).join('') +
      '</ul>Questi campi sono rimasti vuoti: compilali a mano guardando la fattura.</span>' +
    '</div>'
  }

  if (conto) {
    pezzi += '<div class="lettura-nota">' +
      '<span aria-hidden="true">🏷</span>' +
      '<span><strong>Conto suggerito dalla lettura:</strong> ' +
      esc(conto.codice_conto + ' · ' + conto.descrizione) +
      '. Non viene salvato adesso: lo confermerai in «Da classificare».</span>' +
    '</div>'
  }

  html('ponte-ai-note', pezzi)
}


// ══════════════════════════════════════════════════════════════════════════════
// FASE 6 — CONTABILITÀ PER CANTIERE
//
// SOLA LETTURA sulle tabelle di App Cantieri (cantieri, spese, regia, giornate):
// stanno nello stesso database ma appartengono a un'altra applicazione, in
// produzione. Qui si leggono e basta. Nessuna ALTER, nessun UPDATE, nessun
// trigger, nessuna cancellazione.
//
// L'unica eccezione, dalla FASE 22, e' createCustomCantiere(): inserisce un
// cantiere nuovo con nome, luogo, committente e stato 'Attivo', per poterlo
// scegliere subito nella classificazione. Resta una INSERT sola, su quattro
// colonne. Tutto il resto della scheda si compila nell'App Cantieri.
//
// DUE ERRORI CHE QUESTA SCHERMATA NON DEVE FARE
//
//   1. Il margine con la tariffa di VENDITA e' falso. 78 CHF/h e' il prezzo a
//      cui un'ora si vende, non quello che costa. Sottrarre il ricavo dal
//      ricavo da un numero che non vuol dire niente. Se il costo orario non e'
//      impostato, il margine si chiama «SENZA MANODOPERA» e non si inventa
//      nessun valore di ripiego.
//
//   2. La stessa spesa puo' esistere due volte: lo scontrino fotografato in
//      App Cantieri e la fattura dello stesso fornitore arrivata per posta.
//      I due blocchi restano separati e non si sommano mai in silenzio.
//      Il confronto automatico su descrizione e importo NON si fa: darebbe
//      falsi positivi, e un avviso che sbaglia spesso smette di essere letto.
// ══════════════════════════════════════════════════════════════════════════════

let speseCantiereCache = null   // tabella spese di App Cantieri (sola lettura)
let regiaCantiereCache = null   // tabella regia  di App Cantieri (sola lettura)
let giornateCache      = null   // tabella giornate di App Cantieri (sola lettura)
let classCantiereMap   = null   // "origine_tipo:origine_id" -> cantiere_id
let cantiereApertoId   = null   // cantiere mostrato nella scheda

// ── Costo orario ─────────────────────────────────────────────────────────────

function costoOrario() {
  var n = safeNum(impostazione('costo_orario_medio', null))
  return (n != null && n > 0) ? n : null       // zero o negativo = non impostato
}
function costoOrarioVerificato() { return impostazione('costo_orario_verificato', 'no') === 'si' }
function costoOrarioAggiornatoIl() { return impostazione('costo_orario_aggiornato_il', null) }

// ── Letture (tutte in sola lettura) ─────────────────────────────────────────

async function loadSpeseCantiere(force) {
  if (cacheOk('speseCantiere') && !force) return speseCantiereCache || []
  // FASE 22 — senza sessione non si legge niente, ma non e' una lettura
  // riuscita: segnarla tale bloccherebbe ogni tentativo dopo il login.
  // Stessa guardia di loadContatti e loadCantieri.
  if (!currentAziendaId) { speseCantiereCache = speseCantiereCache || []; return speseCantiereCache }
  try {
    const { data, error } = await sb.from('spese')
      .select('id, cantiere_id, data, descrizione, importo, valuta, note')
      .limit(2000)
    if (error) throw error
    speseCantiereCache = data || []
    segnaCacheOk('speseCantiere')
  } catch (e) {
    speseCantiereCache = speseCantiereCache || []   // non riuscita: il prossimo tentativo riprova
    console.warn('Spese di cantiere non lette:', e.message || e)
  }
  return speseCantiereCache
}

async function loadRegiaCantiere(force) {
  if (cacheOk('regiaCantiere') && !force) return regiaCantiereCache || []
  // FASE 22 — senza sessione non si legge niente, ma non e' una lettura
  // riuscita: segnarla tale bloccherebbe ogni tentativo dopo il login.
  // Stessa guardia di loadContatti e loadCantieri.
  if (!currentAziendaId) { regiaCantiereCache = regiaCantiereCache || []; return regiaCantiereCache }
  try {
    const { data, error } = await sb.from('regia')
      .select('id, cantiere_id, data, descrizione, quantita, um, prezzo_unitario, fatturato')
      .limit(2000)
    if (error) throw error
    regiaCantiereCache = data || []
    segnaCacheOk('regiaCantiere')
  } catch (e) {
    regiaCantiereCache = regiaCantiereCache || []   // non riuscita: il prossimo tentativo riprova
    console.warn('Regia non letta:', e.message || e)
  }
  return regiaCantiereCache
}

async function loadGiornate(force) {
  if (cacheOk('giornate') && !force) return giornateCache || []
  // FASE 22 — senza sessione non si legge niente, ma non e' una lettura
  // riuscita: segnarla tale bloccherebbe ogni tentativo dopo il login.
  // Stessa guardia di loadContatti e loadCantieri.
  if (!currentAziendaId) { giornateCache = giornateCache || []; return giornateCache }
  try {
    const { data, error } = await sb.from('giornate')
      .select('id, cantiere_id, data, ore_totali, note')
      .limit(5000)
    if (error) throw error
    giornateCache = data || []
    segnaCacheOk('giornate')
  } catch (e) {
    giornateCache = giornateCache || []   // non riuscita: il prossimo tentativo riprova
    console.warn('Giornate non lette:', e.message || e)
  }
  return giornateCache
}

// Il collegamento documento → cantiere sta nelle classificazioni, non nella
// vista: v_conta_flussi non espone cantiere_id e modificarla e' fuori perimetro.
// Si carica la mappa e si incrocia qui.
async function loadMappaCantieri(force) {
  if (classCantiereMap && !force) return classCantiereMap
  classCantiereMap = {}
  if (!currentAziendaId) return classCantiereMap
  try {
    const { data, error } = await sb.from('tm_conta_classificazioni')
      .select('origine_tipo, origine_id, cantiere_id')
      .eq('azienda_id', currentAziendaId)
    if (error) throw error
    ;(data || []).forEach(function (c) {
      classCantiereMap[c.origine_tipo + ':' + c.origine_id] = c.cantiere_id || null
    })
  } catch (e) {
    console.warn('Collegamento cantieri non letto:', e.message || e)
  }
  return classCantiereMap
}

function cantiereDelFlusso(r) {
  if (!classCantiereMap) return null
  return classCantiereMap[r.origine_tipo + ':' + r.id_origine] || null
}

// ── Il calcolo, per un cantiere ──────────────────────────────────────────────
// Un cantiere non ha «periodo»: si guarda tutto, dall'inizio alla fine.

function contiCantiere(cantiereId) {
  var c = {
    fatturato:   { importo: 0, righe: [] },
    incassato:   { importo: 0, righe: [] },
    daIncassare: { importo: 0, righe: [] },
    fornitori:   { importo: 0, righe: [] },
    fornitoriDaPagare: 0,
    spese:       { importo: 0, righe: [] },
    regiaAperta: { importo: 0, righe: [] },
    ore: 0,
    giornate:    []
  }

  // ── Entrate e fatture fornitori: dalla vista, incrociata con le classificazioni
  ;(flussiCache || []).forEach(function (r) {
    if (!confermata(r)) return                       // le da_confermare non contano, come ovunque
    if (cantiereDelFlusso(r) !== cantiereId) return
    var imp = safeNum(r.importo_totale) || 0

    // FASE 8 — incassato e residuo vengono dai pagamenti veri, non dallo stato:
    // una fattura incassata a meta' contribuisce per meta' a entrambi.
    var pagato = safeNum(r.importo_pagato) || 0
    var res = safeNum(r.residuo)
    if (res == null) res = imp - pagato

    if (r.verso === 'entrata') {
      // Il FATTURATO conta il documento emesso, a prescindere dall'incasso:
      // e' quello che decide il margine, e non cambia con la FASE 8.
      c.fatturato.importo += imp; c.fatturato.righe.push(r)
      if (pagato > 0.005)      { c.incassato.importo += pagato;   c.incassato.righe.push(r) }
      if (Math.abs(res) > 0.005) { c.daIncassare.importo += res;  c.daIncassare.righe.push(r) }
    } else {
      c.fornitori.importo += imp; c.fornitori.righe.push(r)
      if (Math.abs(res) > 0.005) c.fornitoriDaPagare += res
    }
  })

  // ── Spese di App Cantieri: blocco separato, MAI sommato alle fatture
  ;(speseCantiereCache || []).forEach(function (s) {
    if (s.cantiere_id !== cantiereId) return
    c.spese.importo += safeNum(s.importo) || 0
    c.spese.righe.push(s)
  })

  // ── Regia non ancora fatturata: valore = quantita x prezzo_unitario
  ;(regiaCantiereCache || []).forEach(function (r) {
    if (r.cantiere_id !== cantiereId) return
    if (r.fatturato) return                          // gia' fatturata: e' fra le entrate
    var q = safeNum(r.quantita) || 0
    var pu = safeNum(r.prezzo_unitario) || 0
    c.regiaAperta.importo += q * pu
    c.regiaAperta.righe.push(r)
  })

  // ── Ore dalle giornate
  ;(giornateCache || []).forEach(function (g) {
    if (g.cantiere_id !== cantiereId) return
    c.ore += safeNum(g.ore_totali) || 0
    c.giornate.push(g)
  })

  // ── Manodopera e margine
  var co = costoOrario()
  c.costoOrario = co
  c.costoManodopera = (co != null) ? c.ore * co : null

  // Senza costo orario la manodopera non entra nel conto, e il margine cambia
  // NOME: «senza manodopera». Un margine falso e' peggio di uno mancante.
  c.margine = c.fatturato.importo - c.fornitori.importo - c.spese.importo
            - (c.costoManodopera != null ? c.costoManodopera : 0)
  c.margineCompleto = (c.costoManodopera != null)

  // La percentuale e' sul FATTURATO. Con fatturato zero non si divide: si
  // scrive che non e' calcolabile, non esce NaN ne' Infinity.
  c.marginePerc = (c.fatturato.importo > 0) ? (c.margine / c.fatturato.importo * 100) : null

  c.vuoto = !c.fatturato.righe.length && !c.fornitori.righe.length &&
            !c.spese.righe.length && !c.regiaAperta.righe.length && !c.ore
  return c
}

// ── La pagina ────────────────────────────────────────────────────────────────

async function initCantieriPage() {
  if (!currentAziendaId) {
    showCantieriBanner('err', 'Azienda non trovata: rieffettua il login.')
    return
  }
  html('cantieri-tabella', loadingRow('Caricamento cantieri…'))
  try {
    await loadImpostazioniConta(true)
    await loadCantieri()
    await loadFlussi(true)
    await loadPagamenti(true)
    await loadMappaCantieri(true)
    await loadSpeseCantiere(true)
    await loadRegiaCantiere(true)
    await loadGiornate(true)
    riempiTendinaCantieri()
    if (cantiereApertoId) apriCantiere(cantiereApertoId)
    else tornaElencoCantieri()
  } catch (e) {
    html('cantieri-tabella', '')
    showCantieriBanner('err', 'Cantieri non caricati: ' + (e.message || e))
  }
}

function showCantieriBanner(tipo, msg) {
  var icona = tipo === 'ok' ? '✅' : tipo === 'warn' ? '⚠️' : '❌'
  html('cantieri-banner',
    '<div class="fase-banner ' + tipo + '" role="' + (tipo === 'ok' ? 'status' : 'alert') + '">' +
      '<span class="icon" aria-hidden="true">' + icona + '</span>' +
      '<div class="msg">' + esc(msg) + '</div>' +
    '</div>')
}

function riempiTendinaCantieri() {
  var sel = el('cant-scelta')
  if (!sel) return
  sel.innerHTML = cantieriOrdinati().map(function (c) {
    return '<option value="' + esc(c.id) + '">' + esc(nomeCantiere(c, true)) + '</option>'
  }).join('')
}

// ── 6C — il confronto fra cantieri ───────────────────────────────────────────

let cantieriOrdinePer = 'perc'      // 'perc' | 'nome' | 'fatturato' | 'margine'

function ordinaCantieriPer(campo) {
  cantieriOrdinePer = campo
  renderElencoCantieri()
}

function tornaElencoCantieri() {
  registraVista('cantieri', 'elenco')
  cantiereApertoId = null
  var e = el('cantieri-elenco-view'); if (e) e.style.display = 'block'
  var s = el('cantieri-scheda-view'); if (s) s.style.display = 'none'
  renderElencoCantieri()
}

function renderElencoCantieri() {
  var lista = cantieriOrdinati()
  if (!lista.length) {
    html('cantieri-tabella',
      '<div class="cru-vuoto"><strong>Nessun cantiere trovato.</strong><br>' +
      'I cantieri arrivano da App Cantieri: se qui non compare nulla, non ce ne sono ancora, ' +
      'oppure questo utente non ha il permesso di leggerli.</div>')
    return
  }

  var righe = lista.map(function (c) {
    var k = contiCantiere(c.id)
    return { cantiere: c, k: k }
  })

  righe.sort(function (a, b) {
    if (cantieriOrdinePer === 'nome') return String(a.cantiere.nome || '').localeCompare(String(b.cantiere.nome || ''), 'it')
    if (cantieriOrdinePer === 'fatturato') return b.k.fatturato.importo - a.k.fatturato.importo
    if (cantieriOrdinePer === 'margine')   return b.k.margine - a.k.margine
    // per percentuale: quelli senza fatturato in fondo, non in cima con «—»
    var pa = (a.k.marginePerc == null) ? -Infinity : a.k.marginePerc
    var pb = (b.k.marginePerc == null) ? -Infinity : b.k.marginePerc
    return pb - pa
  })

  var tot = { fatturato: 0, costi: 0, margine: 0 }
  var body = righe.map(function (x) {
    var k = x.k
    var costi = k.fornitori.importo + k.spese.importo + (k.costoManodopera || 0)
    tot.fatturato += k.fatturato.importo
    tot.costi     += costi
    tot.margine   += k.margine

    // Sotto il 15% e' un margine basso: lo dice l'icona E la parola, mai il
    // solo colore. Senza fatturato non si giudica: non c'e' niente da valutare.
    var basso = (k.marginePerc != null && k.marginePerc < 15)
    var percTxt = (k.marginePerc == null)
      ? '<span class="dim">non calcolabile</span>'
      : esc(fmtNumIt(k.marginePerc)) + ' %'
    var segnale = basso
      ? ' <span class="margine-basso">⚠️ margine basso</span>'
      : ''
    var senzaMano = k.margineCompleto ? '' :
      ' <span class="senza-mano">senza manodopera</span>'

    return '<tr class="row-clickable" onclick="apriCantiere(\'' + esc(x.cantiere.id) + '\')">' +
      '<td>' + esc(nomeCantiere(x.cantiere, true)) + '</td>' +
      '<td class="num">' + esc(fmtNumIt(k.fatturato.importo)) + ' CHF</td>' +
      '<td class="num">' + esc(fmtNumIt(costi)) + ' CHF</td>' +
      '<td class="num">' + esc(fmtNumIt(k.margine)) + ' CHF' + senzaMano + '</td>' +
      '<td class="num">' + percTxt + segnale + '</td>' +
    '</tr>'
  }).join('')

  var percTot = (tot.fatturato > 0) ? (tot.margine / tot.fatturato * 100) : null

  function th(campo, testo, extra) {
    var attivo = (cantieriOrdinePer === campo) ? ' ↓' : ''
    return '<th' + (extra || '') + '><button type="button" class="th-ordina" onclick="ordinaCantieriPer(\'' + campo + '\')">' +
           esc(testo) + attivo + '</button></th>'
  }

  html('cantieri-tabella',
    '<div class="table-wrap"><table><thead><tr>' +
      th('nome', 'Cantiere') +
      th('fatturato', 'Fatturato', ' style="text-align:right"') +
      '<th style="text-align:right">Costi</th>' +
      th('margine', 'Margine', ' style="text-align:right"') +
      th('perc', 'Margine %', ' style="text-align:right"') +
    '</tr></thead><tbody>' + body +
    '<tr class="riga-totale">' +
      '<td><strong>Totale generale</strong></td>' +
      '<td class="num"><strong>' + esc(fmtNumIt(tot.fatturato)) + ' CHF</strong></td>' +
      '<td class="num"><strong>' + esc(fmtNumIt(tot.costi)) + ' CHF</strong></td>' +
      '<td class="num"><strong>' + esc(fmtNumIt(tot.margine)) + ' CHF</strong></td>' +
      '<td class="num"><strong>' + (percTot == null ? '—' : esc(fmtNumIt(percTot)) + ' %') + '</strong></td>' +
    '</tr>' +
    '</tbody></table></div>' +
    (costoOrario() == null
      ? '<div class="nota-cruscotto avviso" style="margin-top:12px">' +
        '<span aria-hidden="true">⚠️</span>' +
        '<span><strong>Margini senza manodopera.</strong> Manca il costo orario, quindi le ore ' +
        'non sono contate in nessuna riga. ' +
        '<button type="button" class="link-btn" onclick="vaiAlCostoOrario()">Imposta il costo orario</button></span></div>'
      : ''))
}

// ── 6B — la scheda del singolo cantiere ──────────────────────────────────────

function apriCantiere(id) {
  if (!id) return
  registraVista('cantieri', 'scheda')
  cantiereApertoId = id
  var e = el('cantieri-elenco-view'); if (e) e.style.display = 'none'
  var s = el('cantieri-scheda-view'); if (s) s.style.display = 'block'
  var sel = el('cant-scelta'); if (sel) sel.value = id
  chiudiElencoCantiere()
  renderSchedaCantiere()
}

function renderSchedaCantiere() {
  var id = cantiereApertoId
  var cant = (cantieriCache || []).filter(function (x) { return x.id === id })[0]
  var k = contiCantiere(id)

  if (k.vuoto) {
    html('cant-dettaglio',
      '<div class="card"><div class="cru-vuoto">' +
      '<strong>Nessun movimento registrato per questo cantiere.</strong><br>' +
      'Non ci sono fatture, spese né ore collegate a ' + esc(nomeCantiere(cant, false)) + '. ' +
      'Una fattura entra qui quando le assegni questo cantiere in «Da classificare».' +
      '</div></div>')
    return
  }

  function riga(etichetta, importo, n, extra) {
    return '<div class="cant-riga">' +
        '<span class="cant-et">' + esc(etichetta) + '</span>' +
        '<span class="cant-imp">' + esc(fmtNumIt(importo)) + ' CHF</span>' +
        '<span class="cant-n">' + (n == null ? '' : esc(n + (n === 1 ? ' documento' : ' documenti'))) + '</span>' +
      '</div>' + (extra || '')
  }
  function rigaClic(chiave, etichetta, importo, n) {
    return '<button type="button" class="cant-riga cliccabile" onclick="apriElencoCantiere(\'' + chiave + '\')">' +
        '<span class="cant-et">' + esc(etichetta) + '</span>' +
        '<span class="cant-imp">' + esc(fmtNumIt(importo)) + ' CHF</span>' +
        '<span class="cant-n">' + esc(n + (n === 1 ? ' documento' : ' documenti')) + '</span>' +
      '</button>'
  }

  // ── ENTRATE
  var entrate = '<div class="card cant-blocco"><div class="card-title">💰 Entrate</div>' +
    rigaClic('fatturato',   'Fatturato',    k.fatturato.importo,   k.fatturato.righe.length) +
    rigaClic('incassato',   'Incassato',    k.incassato.importo,   k.incassato.righe.length) +
    rigaClic('daIncassare', 'Da incassare', k.daIncassare.importo, k.daIncassare.righe.length) +
    // La regia non fatturata NON entra nel margine, ma va detta: senza, un
    // cantiere lavorato in regia sembra in perdita quando non lo e'.
    (k.regiaAperta.righe.length
      ? '<div class="nota-cruscotto" style="margin:10px 0 0">' +
        '<span aria-hidden="true">🧾</span>' +
        '<span>Regia non ancora fatturata: <strong>' + esc(fmtNumIt(k.regiaAperta.importo)) +
        ' CHF</strong> — non contata nel margine. ' +
        '<button type="button" class="link-btn" onclick="apriElencoCantiere(\'regia\')">Vedi le righe</button></span></div>'
      : '') +
    '</div>'

  // ── USCITE: due blocchi separati, mai sommati
  var uscite = '<div class="card cant-blocco"><div class="card-title">💸 Uscite</div>' +
    rigaClic('fornitori', 'Fatture fornitori', k.fornitori.importo, k.fornitori.righe.length) +
    '<div class="cant-sub">di cui ancora da pagare: <strong>' + esc(fmtNumIt(k.fornitoriDaPagare)) + ' CHF</strong></div>' +
    rigaClic('spese', 'Spese di cantiere', k.spese.importo, k.spese.righe.length) +
    '<div class="cant-sub">registrate in App Cantieri dagli operai</div>' +
    '<div class="nota-cruscotto avviso" style="margin:10px 0 0">' +
      '<span aria-hidden="true">⚠️</span>' +
      '<span>Controlla che le spese di cantiere non siano già registrate anche come fattura ' +
      'd\'acquisto: in quel caso il costo risulta doppio. I due blocchi restano separati apposta ' +
      'e non vengono sommati.</span>' +
    '</div>' +
    '</div>'

  // ── MANODOPERA
  var manodopera = '<div class="card cant-blocco"><div class="card-title">👷 Manodopera</div>' +
    rigaClic('ore', 'Ore registrate', k.ore, k.giornate.length).replace(' CHF', ' ore') +
    (k.costoOrario != null
      ? riga('Costo orario', k.costoOrario, null) .replace('</span><span class="cant-n">', ' /h</span><span class="cant-n">') +
        riga('Costo manodopera', k.costoManodopera, null)
      : '<div class="nota-cruscotto avviso" style="margin:10px 0 0">' +
        '<span aria-hidden="true">⚠️</span>' +
        '<span><strong>Costo manodopera non calcolabile: manca il costo orario.</strong> ' +
        'Le ore ci sono, ma senza sapere quanto costa un\'ora non si può dire quanto è costata la manodopera. ' +
        '<button type="button" class="link-btn" onclick="vaiAlCostoOrario()">Impostalo</button></span></div>') +
    (k.regiaAperta.righe.length
      ? '<div class="nota-cruscotto avviso" style="margin:10px 0 0">' +
        '<span aria-hidden="true">⚠️</span>' +
        '<span>Le ore qui sopra vengono dalle giornate di cantiere. Se le stesse ore sono state ' +
        'registrate anche in regia per essere rifatturate, il costo risulta doppio: controlla a occhio.</span></div>'
      : '') +
    '</div>'

  // ── RISULTATO
  var etichettaMargine = k.margineCompleto ? 'MARGINE' : 'MARGINE SENZA MANODOPERA'
  var risultato = '<div class="card cant-blocco cant-risultato">' +
    '<div class="card-title">📈 Risultato</div>' +
    '<div class="cant-margine">' +
      '<span class="cant-margine-et">' + esc(etichettaMargine) + '</span>' +
      '<span class="cant-margine-imp">' + esc(fmtNumIt(k.margine)) + ' CHF</span>' +
      '<span class="cant-margine-perc">' +
        (k.marginePerc == null
          ? '<span class="dim">percentuale non calcolabile: nessun fatturato</span>'
          : esc(fmtNumIt(k.marginePerc)) + ' % del fatturato') +
      '</span>' +
    '</div>' +
    '<div class="cant-formula">Fatturato − fatture fornitori − spese di cantiere' +
      (k.margineCompleto ? ' − costo manodopera' : '') + '</div>' +
    (!k.margineCompleto
      ? '<div class="nota-cruscotto avviso" style="margin:10px 0 0">' +
        '<span aria-hidden="true">⚠️</span>' +
        '<span><strong>MARGINE SENZA MANODOPERA</strong> — imposta il costo orario per avere il margine vero. ' +
        '<button type="button" class="link-btn" onclick="vaiAlCostoOrario()">Impostalo</button></span></div>'
      : (!costoOrarioVerificato()
          ? '<div class="nota-cruscotto avviso" style="margin:10px 0 0">' +
            '<span aria-hidden="true">⚠️</span>' +
            '<span>Costo orario non ancora verificato dal commercialista — il margine è indicativo.</span></div>'
          : '')) +
    '</div>'

  html('cant-dettaglio', entrate + uscite + manodopera + risultato)
}

// ── Elenco dei documenti dietro a un riquadro ────────────────────────────────

function apriElencoCantiere(chiave) {
  var k = contiCantiere(cantiereApertoId)
  var righe = [], titolo = '', tipo = 'flusso'

  if (chiave === 'fatturato')   { righe = k.fatturato.righe;   titolo = '💰 Fatturato' }
  else if (chiave === 'incassato')   { righe = k.incassato.righe;   titolo = '💰 Incassato' }
  else if (chiave === 'daIncassare') { righe = k.daIncassare.righe; titolo = '🔵 Da incassare' }
  else if (chiave === 'fornitori')   { righe = k.fornitori.righe;   titolo = '💸 Fatture fornitori' }
  else if (chiave === 'spese')       { righe = k.spese.righe;       titolo = '🧾 Spese di cantiere'; tipo = 'spesa' }
  else if (chiave === 'regia')       { righe = k.regiaAperta.righe; titolo = '🧾 Regia non fatturata'; tipo = 'regia' }
  else if (chiave === 'ore')         { righe = k.giornate;          titolo = '👷 Giornate registrate'; tipo = 'giornata' }

  if (el('cant-elenco-titolo')) el('cant-elenco-titolo').textContent = titolo
  if (!righe.length) {
    html('cant-elenco', '<div class="cru-vuoto">Nessun documento in questo elenco.</div>')
  } else {
    html('cant-elenco', righe.map(function (r) {
      if (tipo === 'spesa') {
        return rigaElencoCant(fmtDate(r.data), r.descrizione || '—', fmtNumIt(safeNum(r.importo) || 0) + ' CHF')
      }
      if (tipo === 'regia') {
        var q = safeNum(r.quantita) || 0, pu = safeNum(r.prezzo_unitario) || 0
        return rigaElencoCant(fmtDate(r.data),
          (r.descrizione || '—') + ' · ' + fmtNumIt(q) + ' ' + (r.um || '') + ' × ' + fmtNumIt(pu) + ' CHF',
          fmtNumIt(q * pu) + ' CHF')
      }
      if (tipo === 'giornata') {
        return rigaElencoCant(fmtDate(r.data), r.note || 'Giornata di cantiere',
          fmtNumIt(safeNum(r.ore_totali) || 0) + ' ore')
      }
      return rigaElencoCant(fmtDate(r.data_documento), r.controparte_nome || '—',
        fmtNumIt(safeNum(r.importo_totale) || 0) + ' CHF')
    }).join(''))
  }
  var card = el('cant-elenco-card')
  if (card) { card.style.display = 'block'; card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }
}

function rigaElencoCant(data, testo, importo) {
  return '<div class="cru-elenco-riga">' +
    '<span class="cru-elenco-nome">' + esc(testo) + '</span>' +
    '<span class="cru-elenco-meta">' + esc(data) + '</span>' +
    '<span class="cru-elenco-imp">' + esc(importo) + '</span>' +
  '</div>'
}

function chiudiElencoCantiere() {
  var card = el('cant-elenco-card')
  if (card) card.style.display = 'none'
}

function vaiAlCostoOrario() {
  showPage('impostazioni')
  initImpostazioniPage().then(function () {
    var e = el('imp-costo-orario')
    if (e) { e.scrollIntoView({ behavior: 'smooth', block: 'center' }); e.focus() }
  }).catch(function () { /* la pagina si apre lo stesso */ })
}

// ── Il costo orario in Impostazioni ──────────────────────────────────────────

// Cambiare il numero toglie la spunta: un valore nuovo non e' quello che il
// commercialista aveva controllato. Senza questo, fra sei mesi la spunta
// resterebbe accesa su una cifra che non ha mai visto.
function onCostoOrarioCambiato() {
  var chk = el('imp-costo-verificato')
  if (chk && chk.checked) {
    chk.checked = false
    var hint = el('imp-costo-verificato-hint')
    if (hint) hint.innerHTML = '<strong>La spunta è stata tolta:</strong> hai cambiato il costo orario, ' +
      'quindi va rifatto controllare al commercialista.'
  }
  renderStatoCostoOrario(true)
}

function onCostoVerificatoCambiato() { renderStatoCostoOrario(true) }

// La riga sotto il campo: da quando vale questo numero e se qualcuno l'ha
// controllato. Serve a non dimenticarsi, fra sei mesi, che e' una stima.
function renderStatoCostoOrario(inModifica) {
  var box = el('imp-costo-stato')
  if (!box) return
  var dataAgg = costoOrarioAggiornatoIl()
  var verif = el('imp-costo-verificato') ? el('imp-costo-verificato').checked : false

  var quando = inModifica
    ? 'non ancora salvato'
    : (dataAgg ? fmtDate(dataAgg) : 'mai impostato')

  box.innerHTML =
    '<div class="costo-riga"><span aria-hidden="true">📅</span> Ultimo aggiornamento: <strong>' +
      esc(quando) + '</strong></div>' +
    '<div class="costo-riga">' +
      '<span aria-hidden="true">' + (verif ? '✅' : '⚠️') + '</span> Verificato dal commercialista: <strong>' +
      (verif ? 'sì' : 'no') + '</strong>' +
      (verif ? '' : ' <span class="dim">— il margine dei cantieri resta indicativo</span>') +
    '</div>'
}


// ══════════════════════════════════════════════════════════════════════════════
// FASE 7 — PACCHETTO PER IL COMMERCIALISTA
//
// Un solo ZIP con l'Excel e tutti i giustificativi.
//
// LA REGOLA CHE TIENE IN PIEDI TUTTO: ogni riga dell'Excel porta il NOME ESATTO
// del file che le corrisponde, percorso compreso. Un pacchetto con quaranta PDF
// e un Excel che non dice quale riga sia quale file costringe il commercialista
// ad aprirli uno per uno: tanto vale non farlo. Per questo il nome si calcola
// UNA volta sola (nomeFilePacchetto) e la stessa stringa finisce sia nella
// cella sia nel percorso dentro lo ZIP.
//
// IL PERIODO QUI E' PER COMPETENZA: conta la data del DOCUMENTO, non quella del
// pagamento. E' l'opposto del Cruscotto, che e' di cassa. Detto sulla schermata
// e ripetuto nel LEGGIMI, altrimenti la differenza sembra un errore.
// ══════════════════════════════════════════════════════════════════════════════

let pacchettoInCorso  = false
let pacchettoAnnullato = false
let jsZipCaricato     = false

// ── JSZip: si scarica solo quando serve ─────────────────────────────────────
// Non e' un <script> in fondo alla pagina come SheetJS: caricarla all'avvio
// significherebbe farla scaricare a chiunque apra l'app, anche a chi non
// generera' mai un pacchetto. Cosi' invece un CDN muto disturba solo chi sta
// premendo il bottone, e l'export Excel continua a funzionare comunque.
function caricaJSZip() {
  return new Promise(function (risolvi, rifiuta) {
    if (jsZipCaricato && window.JSZip) { risolvi(window.JSZip); return }
    if (window.JSZip) { jsZipCaricato = true; risolvi(window.JSZip); return }
    var s = document.createElement('script')
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
    s.onload = function () {
      if (window.JSZip) { jsZipCaricato = true; risolvi(window.JSZip) }
      else rifiuta(new Error('JSZip caricata ma non disponibile.'))
    }
    s.onerror = function () {
      rifiuta(new Error('Impossibile creare lo ZIP. Puoi comunque scaricare l\'Excel da solo.'))
    }
    document.head.appendChild(s)
  })
}

// ── I nomi dei file ─────────────────────────────────────────────────────────

// «2026-08-24_Reguscireco_96.50.pdf»
// La data per prima e in formato AAAA-MM-GG: cosi' l'ordine alfabetico della
// cartella e' anche l'ordine cronologico, senza che nessuno debba ordinare.
// Accenti e spazi via, come gia' si fa per il nome del PDF fattura (FASE 2).
function ripulisciPerNomeFile(testo) {
  var t = String(testo || '')
  // Scompone le lettere accentate e butta via i segni: Città -> Citta, Müller -> Muller
  if (t.normalize) t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  return t.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'documento'
}

function estensioneDa(percorso, seManca) {
  var m = String(percorso || '').match(/\.([A-Za-z0-9]{1,5})(?:\?|$)/)
  return m ? m[1].toLowerCase() : (seManca || 'pdf')
}

function nomeFilePacchetto(data, chi, importo, estensione) {
  var d = data ? String(data).slice(0, 10) : 'senza-data'
  var imp = (safeNum(importo) != null) ? safeNum(importo).toFixed(2) : '0.00'
  return d + '_' + ripulisciPerNomeFile(chi) + '_' + imp + '.' + estensione
}

// Due fatture dello stesso fornitore, stesso giorno, stesso importo esistono.
// Il secondo file prende _2, il terzo _3: nessuno viene sovrascritto in silenzio.
function nomeUnico(usati, cartella, nome) {
  var completo = cartella + '/' + nome
  if (!usati[completo]) { usati[completo] = true; return completo }
  var punto = nome.lastIndexOf('.')
  var base = (punto > 0) ? nome.slice(0, punto) : nome
  var est  = (punto > 0) ? nome.slice(punto) : ''
  var n = 2
  while (usati[cartella + '/' + base + '_' + n + est]) n++
  completo = cartella + '/' + base + '_' + n + est
  usati[completo] = true
  return completo
}

// ── Che cosa entra nel pacchetto ────────────────────────────────────────────
// I filtri sono quelli del §7C: niente bozze, niente annullate, niente
// «da confermare». La regia non fatturata resta fuori: non e' un documento
// fiscale, e' lavoro ancora da fatturare.
async function raccogliDocumentiPacchetto(da, a) {
  var ds = await loadExportDataset()
  // Senza questa lettura ogni documento risulterebbe senza allegati.
  try { await loadAllegati() } catch (_) {}
  var d  = docsPeriodo(ds, da, a)      // applica gia' il filtro «da confermare»
  var usati = {}
  var voci = []

  // ── Fatture di vendita e note di credito → vendite/
  d.vendite.concat(d.note).forEach(function (f) {
    voci.push({
      sezione: 'vendite',
      etichetta: (f.tipo === 'nota_credito' ? 'Nota di credito ' : 'Fattura ') + (f.numero || ''),
      data: f.data_emissione,
      chi: f.cliente_nome,
      importo: f.totale,
      allegati: allegatiDi('tm_conta_fatture', f.id),
      id: f.id,
      // Una fattura senza PDF non e' un errore dello Storage: e' un PDF che
      // nessuno ha ancora allegato. Il motivo va scritto per esteso.
      motivoSeManca: 'PDF non ancora allegato'
    })
  })

  // ── Fatture d'acquisto → acquisti/
  d.acquisti.forEach(function (x) {
    voci.push({
      sezione: 'acquisti',
      etichetta: 'Fattura ' + (x.numero_fornitore || '') + ' ' + (x.fornitore || ''),
      data: x.data, chi: x.fornitore, importo: x.importo,
      allegati: allegatiDi('tm_conta_fatture_acquisto', x.id), id: x.id,
      motivoSeManca: 'nessun file caricato'
    })
  })

  // ── Movimenti propri → movimenti/ (cartella separata, come l'Excel)
  d.spese.forEach(function (par) {
    var m = par.mov
    if (m.origine_tipo !== 'proprio') return     // spesa/regia di App Cantieri: altra sezione
    voci.push({
      sezione: 'movimenti',
      etichetta: m.descrizione || 'Movimento',
      data: m.data, chi: m.ente || m.ente_fornitore || m.descrizione, importo: m.importo,
      allegati: allegatiDi('tm_conta_movimenti_propri', m.origine_id), id: m.origine_id,
      motivoSeManca: 'nessun file caricato'
    })
  })

  // ── Spese di cantiere → spese_cantiere/
  // La tabella e' vuota oggi (App Cantieri non e' mai stato usato per le spese):
  // se non ci sono righe la cartella NON viene creata. Uno ZIP con una cartella
  // vuota fa pensare che qualcosa sia andato perso.
  var speseCant = await speseCantierePeriodo(da, a)
  speseCant.forEach(function (sp) {
    voci.push({
      sezione: 'spese_cantiere',
      etichetta: sp.descrizione || 'Spesa di cantiere',
      data: sp.data, chi: cantiereLabel(sp.cantiere_id), importo: sp.importo,
      allegati: sp.foto_path
        ? [{ path: sp.foto_path, tipo: 'altro', nome_file: null }] : [],
      id: sp.id,
      bucket: 'cantiere-spese',
      motivoSeManca: 'foto mai scattata'
    })
  })

  // Il nome del file si assegna QUI, una volta sola: la stessa stringa andra'
  // nella cella ALLEGATO dell'Excel e nel percorso dentro lo ZIP.
  // Il nome base si assegna QUI, una volta sola per documento: la stessa
  // stringa va nella cella ALLEGATO dell'Excel e nel percorso dentro lo ZIP.
  //
  // Con piu' allegati i file stanno ACCANTO alla fattura, nella stessa cartella
  // di sezione, distinti dal suffisso: _bolla1, _bolla2, _ricevuta1. Una
  // sottocartella per documento farebbe dello ZIP un albero da navigare;
  // cosi' il commercialista apre una cartella e li vede tutti in ordine di data.
  voci.forEach(function (v) {
    v.files = []
    var lista = v.allegati || []
    if (!lista.length) return

    // L'allegato di tipo «fattura» viene per primo: e' il documento, gli altri
    // sono il contorno. A parita' di tipo resta l'ordine di caricamento.
    var ordinati = lista.slice().sort(function (p, q) {
      return (p.tipo === 'fattura' ? 0 : 1) - (q.tipo === 'fattura' ? 0 : 1)
    })

    var contatori = {}
    ordinati.forEach(function (al, i) {
      var est = estensioneDa(al.path, v.sezione === 'spese_cantiere' ? 'jpg' : 'pdf')
      var suffisso = ''
      if (i > 0 || al.tipo !== 'fattura') {
        contatori[al.tipo] = (contatori[al.tipo] || 0) + 1
        suffisso = '_' + al.tipo + contatori[al.tipo]
      }
      // Il suffisso entra nel nome PRIMA dell'estensione: nomeFilePacchetto
      // mette gia' il punto, incollarlo dopo darebbe «..pdf».
      var nome = nomeFilePacchetto(v.data, v.chi, v.importo, est)
      if (suffisso) {
        var punto = nome.lastIndexOf('.')
        nome = nome.slice(0, punto) + suffisso + nome.slice(punto)
      }
      v.files.push({ path: al.path, nomeNelloZip: nomeUnico(usati, v.sezione, nome) })
    })
  })

  return { voci: voci, d: d, ds: ds }
}

// Spese di cantiere del periodo. Sola lettura, tabella di App Cantieri.
async function speseCantierePeriodo(da, a) {
  try {
    await loadSpeseCantiere()
    await loadCantieri()
    return (speseCantiereCache || []).filter(function (s) { return inPeriodo(s.data, da, a) })
  } catch (e) {
    console.warn('Spese di cantiere non lette per il pacchetto:', e.message || e)
    return []
  }
}

// ── L'anteprima, prima di generare ──────────────────────────────────────────

async function aggiornaAnteprimaPacchetto() {
  var box = el('exp-zip-anteprima')
  if (!box) return
  var da = getVal('exp-da'), a = getVal('exp-a')
  if (!da || !a) { box.innerHTML = '<span class="dim">Imposta il periodo per vedere l\'anteprima del pacchetto.</span>'; return }

  box.innerHTML = loadingRow('Calcolo del pacchetto…')
  try {
    var r = await raccogliDocumentiPacchetto(da, a)
    var conAllegato = r.voci.filter(function (v) { return v.files.length })
    var senza = r.voci.length - conAllegato.length

    if (!r.voci.length) {
      box.innerHTML = '<div class="cru-vuoto"><strong>Nessun documento in questo periodo.</strong><br>' +
        'Non c\'è niente da mettere nel pacchetto: cambia il periodo qui sopra.</div>'
      var b0 = el('exp-zip-btn'); if (b0) b0.disabled = true
      return
    }
    var b1 = el('exp-zip-btn'); if (b1) b1.disabled = false

    // Stima: le foto pesano molto piu' dei PDF. Sono cifre grossolane e la
    // scritta lo dice: servono solo a evitare la sorpresa dei 200 MB.
    var stimaMB = 0
    conAllegato.forEach(function (v) {
      stimaMB += v.files.length * ((v.sezione === 'spese_cantiere') ? 3 : 0.35)
    })
    stimaMB = Math.max(0.1, stimaMB)

    var avviso = ''
    if (stimaMB > 200) {
      avviso = '<div class="nota-cruscotto avviso"><span aria-hidden="true">⚠️</span><span>' +
        '<strong>Pacchetto molto grande (circa ' + esc(fmtNumIt(stimaMB)) + ' MB).</strong> ' +
        'Conviene generare un mese alla volta. Il bottone resta attivo: decidi tu.</span></div>'
    } else if (stimaMB > 20) {
      avviso = '<div class="nota-cruscotto avviso"><span aria-hidden="true">⚠️</span><span>' +
        'Il pacchetto pesa circa <strong>' + esc(fmtNumIt(stimaMB)) + ' MB</strong>: troppo per un\'email. ' +
        'Caricalo su Google Drive oppure dividilo in periodi più corti.</span></div>'
    }

    box.innerHTML =
      '<div class="exp-riga"><span>Documenti nel periodo</span><span><strong>' + r.voci.length + '</strong></span></div>' +
      '<div class="exp-riga"><span>Giustificativi da allegare</span><span><strong>' +
        conAllegato.reduce(function (n, v) { return n + v.files.length }, 0) + '</strong></span></div>' +
      '<div class="exp-riga' + (senza ? ' exp-vuoto' : '') + '"><span>' +
        (senza ? '⏳ Documenti senza giustificativo' : '✅ Nessun documento senza giustificativo') +
        '</span><span><strong>' + senza + '</strong></span></div>' +
      '<div class="exp-riga"><span>Dimensione stimata</span><span><strong>circa ' +
        esc(fmtNumIt(stimaMB)) + ' MB</strong></span></div>' +
      (senza ? '<div class="form-hint" style="margin-top:6px">I documenti senza giustificativo restano ' +
        'nell\'Excel con la cella vuota, ed è elencato il perché in DOCUMENTI_MANCANTI.txt.</div>' : '') +
      avviso
  } catch (e) {
    box.innerHTML = '<span class="dim">Anteprima non disponibile: ' + esc(e.message || e) + '</span>'
  }
}

// ── La generazione ──────────────────────────────────────────────────────────

function annullaPacchetto() {
  pacchettoAnnullato = true
  mostraProgressoPacchetto('Annullamento in corso…', 100)
}

function mostraProgressoPacchetto(testo, percento) {
  var box = el('exp-zip-progresso')
  if (box) box.style.display = testo ? 'block' : 'none'
  var t = el('exp-zip-progresso-testo'); if (t) t.textContent = testo || ''
  var b = el('exp-zip-progresso-barra'); if (b) b.style.width = Math.max(0, Math.min(100, percento || 0)) + '%'
}

function bannerPacchetto(tipo, msg) {
  var icona = tipo === 'ok' ? '✅' : tipo === 'warn' ? '⚠️' : '❌'
  html('exp-zip-banner',
    '<div class="fase-banner ' + tipo + '" style="margin-top:12px" role="' + (tipo === 'ok' ? 'status' : 'alert') + '">' +
      '<span class="icon" aria-hidden="true">' + icona + '</span>' +
      '<div class="msg">' + msg + '</div>' +
    '</div>')
}

async function generaPacchetto() {
  if (pacchettoInCorso) return
  var da = getVal('exp-da'), a = getVal('exp-a')
  if (!validPeriodo(da, a)) return

  pacchettoInCorso = true
  pacchettoAnnullato = false
  html('exp-zip-banner', '')
  var btn = el('exp-zip-btn'), btnAnn = el('exp-zip-annulla-btn')
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Preparazione…' }
  if (btnAnn) btnAnn.style.display = 'inline-flex'

  var mancanti = []      // {data, chi, importo, motivo}
  try {
    mostraProgressoPacchetto('Caricamento della libreria per lo ZIP…', 2)
    var JSZipLib = await caricaJSZip()

    mostraProgressoPacchetto('Raccolta dei documenti…', 5)
    await loadPagamenti(true)      // FASE 8: servono per le colonne PAGATO e RESIDUO
    var r = await raccogliDocumentiPacchetto(da, a)
    if (!r.voci.length) {
      bannerPacchetto('warn', 'Nessun documento in questo periodo: non è stato creato nessun file.')
      return
    }

    var zip = new JSZipLib()
    var conAllegato = r.voci.filter(function (v) { return v.files.length })
    var scaricati = 0

    // ── Gli allegati, uno per uno ──────────────────────────────────────────
    // try/catch INTORNO A OGNI FILE: un allegato che non si scarica finisce
    // fra i mancanti e il pacchetto si genera lo stesso. Se bastasse un file
    // rotto a far fallire tutto, il pacchetto non si potrebbe mai consegnare.
    // Si conta per FILE, non per documento: una fattura con due bolle vale tre.
    var daScaricare = []
    conAllegato.forEach(function (v) {
      v.files.forEach(function (fl) { daScaricare.push({ v: v, fl: fl }) })
    })

    for (var i = 0; i < daScaricare.length; i++) {
      if (pacchettoAnnullato) { bannerPacchetto('warn', 'Generazione annullata: nessun file è stato scaricato.'); return }
      var v  = daScaricare[i].v
      var fl = daScaricare[i].fl
      mostraProgressoPacchetto('Scarico allegato ' + (i + 1) + ' di ' + daScaricare.length + '…',
                               5 + Math.round((i / daScaricare.length) * 80))
      try {
        var bucket = v.bucket || STORAGE_BUCKET
        const { data: blob, error } = await sb.storage.from(bucket).download(fl.path)
        if (error) throw error
        if (!blob) throw new Error('file vuoto')
        zip.file(fl.nomeNelloZip, blob)
        scaricati++
      } catch (eFile) {
        // Il file salta, ma gli altri dello stesso documento no: si azzera
        // solo questo, e il motivo va scritto nominando il file.
        fl.nomeNelloZip = null
        mancanti.push({ data: v.data, chi: v.chi, importo: v.importo,
                        motivo: 'file non scaricabile (' + (eFile.message || eFile) + ')' })
      }
    }

    // I documenti che non avevano proprio un file
    r.voci.filter(function (v) { return !v.files.length }).forEach(function (v) {
      mancanti.push({ data: v.data, chi: v.chi, importo: v.importo, motivo: v.motivoSeManca })
    })

    if (pacchettoAnnullato) { bannerPacchetto('warn', 'Generazione annullata: nessun file è stato scaricato.'); return }

    // ── L'Excel, con la colonna ALLEGATO ───────────────────────────────────
    mostraProgressoPacchetto('Creazione dell\'Excel…', 88)
    var mappa = {}
    // La cella ALLEGATO elenca tutti i file di quel documento, separati da «; ».
    // Con la cella vuota il commercialista non saprebbe che le bolle esistono.
    r.voci.forEach(function (v) {
      var nomi = (v.files || []).map(function (fl) { return fl.nomeNelloZip })
                                .filter(Boolean)
      if (nomi.length) mappa[v.sezione + ':' + v.id] = nomi.join('; ')
    })
    var wb = costruisciWorkbookPacchetto(r, mappa, da, a)
    var xlsxBin = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
    zip.file('01_Riepilogo.xlsx', xlsxBin)

    // ── I due file di testo ────────────────────────────────────────────────
    mostraProgressoPacchetto('Scrittura del riepilogo…', 92)
    zip.file('00_LEGGIMI.txt', await testoLeggimi(r, da, a, scaricati, mancanti.length))
    if (mancanti.length) zip.file('DOCUMENTI_MANCANTI.txt', testoDocumentiMancanti(mancanti))

    // ── Lo ZIP ─────────────────────────────────────────────────────────────
    mostraProgressoPacchetto('Compressione…', 95)
    var blobZip = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' },
      function (meta) { mostraProgressoPacchetto('Compressione… ' + Math.round(meta.percent) + '%', 95 + meta.percent * 0.05) })

    if (pacchettoAnnullato) { bannerPacchetto('warn', 'Generazione annullata: nessun file è stato scaricato.'); return }

    scaricaBlob(blobZip, 'CT_' + da + '_' + a + '.zip')
    mostraProgressoPacchetto('', 0)

    var msg = '<strong>Pacchetto creato.</strong> ' + r.voci.length +
      (r.voci.length === 1 ? ' documento' : ' documenti') + ', ' + scaricati +
      (scaricati === 1 ? ' giustificativo allegato' : ' giustificativi allegati') +
      (mancanti.length ? ', ' + mancanti.length + ' senza file (elencati in DOCUMENTI_MANCANTI.txt)' : '') + '.' +
      '<br><button type="button" class="link-btn" onclick="proponiConsegna()">Hai consegnato il pacchetto? Segna il periodo come consegnato</button>'
    bannerPacchetto(mancanti.length ? 'warn' : 'ok', msg)

  } catch (e) {
    mostraProgressoPacchetto('', 0)
    bannerPacchetto('err', esc(e.message || String(e)))
  } finally {
    pacchettoInCorso = false
    if (btn) { btn.disabled = false; btn.textContent = '📦 Genera pacchetto completo (ZIP)' }
    if (btnAnn) btnAnn.style.display = 'none'
    if (pacchettoAnnullato) mostraProgressoPacchetto('', 0)
  }
}

// Scarica un blob senza passare da una libreria.
function scaricaBlob(blob, nomeFile) {
  var url = URL.createObjectURL(blob)
  var a = document.createElement('a')
  a.href = url
  a.download = nomeFile
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(function () { URL.revokeObjectURL(url) }, 2000)
}

// ── L'Excel del pacchetto ───────────────────────────────────────────────────
// Usa gli stessi fogli dell'export normale, con in piu' la colonna ALLEGATO.
// I buildSheet* accettano la mappa come parametro FACOLTATIVO: senza mappa si
// comportano esattamente come prima, cosi' l'export Excel esistente non cambia
// di una virgola.
function costruisciWorkbookPacchetto(r, mappa, da, a) {
  var d = r.d, ds = r.ds
  var sez = sezioniSelezionate()
  var wb = XLSX.utils.book_new()

  if (d.vendite.length)  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildSheetVendite(d.vendite, ds, false, mappa)), 'Vendite')
  if (d.note.length)     XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildSheetVendite(d.note, ds, true, mappa)), 'Note di credito')
  if (d.acquisti.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildSheetAcquisti(d.acquisti, ds, mappa)), 'Acquisti')
  if (d.spese.length)    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildSheetSpese(d.spese, mappa)), 'Spese e movimenti')

  // Le spese di cantiere stanno in un foglio SEPARATO e non si sommano mai agli
  // acquisti: lo stesso scontrino puo' essere gia' fra le fatture ricevute.
  var speseCant = r.voci.filter(function (v) { return v.sezione === 'spese_cantiere' })
  if (speseCant.length) {
    var aoa = [['Data', 'Cantiere', 'Descrizione', 'Importo', 'ALLEGATO']]
    speseCant.forEach(function (v) {
      var nomiSp = (v.files || []).map(function (fl) { return fl.nomeNelloZip })
                                  .filter(Boolean).join('; ')
      aoa.push([v.data || '', v.chi || '', v.etichetta || '', safeNum(v.importo) || 0, nomiSp])
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Spese cantiere')
  }

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildSheetRiepilogo(d, sez, da, a)), 'Riepilogo')
  return wb
}

// ── 00_LEGGIMI.txt ──────────────────────────────────────────────────────────

async function testoLeggimi(r, da, a, allegatiInclusi, allegatiMancanti) {
  var t = totaliSezioni(r.d)
  var az = aziendaInfo || {}
  var nome = (az.nome || 'CARPENTERIA TICINESE SAGL').toUpperCase()

  function riga(etichetta, n, importo) {
    var e = '  ' + etichetta
    while (e.length < 28) e += ' '
    var c = String(n) + (n === 1 ? ' doc' : ' doc')
    while (c.length < 9) c = ' ' + c
    // Lo zero non ha segno: «-0,00» viene dal totale delle note di credito, che
    // e' negativo per costruzione. Su zero documenti e' solo brutto da leggere.
    var n0 = safeNum(importo) || 0
    if (Math.abs(n0) < 0.005) n0 = 0
    var i = fmtNumIt(n0) + ' CHF'
    while (i.length < 16) i = ' ' + i
    return e + c + i
  }

  var speseCant = r.voci.filter(function (v) { return v.sezione === 'spese_cantiere' })
  var totSpeseCant = speseCant.reduce(function (s, v) { return s + (safeNum(v.importo) || 0) }, 0)

  var righe = [
    nome,
    'Periodo: ' + fmtDate(da) + ' - ' + fmtDate(a),
    'Generato il: ' + fmtDate(oggiISO()),
    '',
    'CONTENUTO',
    riga('Fatture di vendita', r.d.vendite.length, t.vendite),
    riga('Note di credito', r.d.note.length, t.note),
    riga('Fatture d\'acquisto', r.d.acquisti.length, t.acquisti),
    riga('Movimenti propri', r.d.spese.length, t.spese),
    riga('Spese di cantiere', speseCant.length, totSpeseCant),
    '',
    '  Allegati inclusi:   ' + allegatiInclusi + ' file',
    '  Allegati mancanti:  ' + allegatiMancanti + ' file'
  ]
  if (allegatiMancanti) righe.push('    -> vedi DOCUMENTI_MANCANTI.txt')

  righe.push('', 'NOTE')
  // Il periodo: e' la nota che evita la telefonata del commercialista.
  righe.push('  I documenti sono contati per DATA DEL DOCUMENTO')
  righe.push('  (competenza), non per data di pagamento.')

  // IVA: il testo cambia se esiste un periodo attivo.
  try { await loadIvaPeriodi() } catch (_) { }
  var ivaAttivi = (ivaPeriodiCache || []).filter(function (x) {
    if (x.valido_da && a && x.valido_da > a) return false
    if (x.valido_a && da && x.valido_a < da) return false
    return true
  })
  if (!ivaAttivi.length) {
    righe.push('  IVA: azienda non assoggettata in questo')
    righe.push('       periodo.')
  } else {
    var p = ivaAttivi[0]
    righe.push('  IVA: metodo ' + (p.metodo || '-') +
      (p.metodo === 'saldo' ? ', aliquota saldo ' + fmtNumIt(safeNum(p.aliquota_saldo) || 0) + '%' : '') + ',')
    righe.push('       criterio ' + (p.criterio || '-') +
      ', in vigore dal ' + fmtDate(p.valido_da) + '.')
  }

  righe.push('  I documenti da confermare NON sono inclusi.')
  if (speseCant.length) {
    righe.push('  Le spese di cantiere possono coincidere con')
    righe.push('  fatture d\'acquisto gia\' elencate: verificare.')
  }

  // §7D — se il periodo e' gia' stato consegnato, va detto qui.
  var consegna = await dataConsegnaPeriodo(da, a)
  if (consegna) righe.push('  Periodo gia\' consegnato il ' + fmtDate(consegna) + '.')

  righe.push('')
  righe.push('Contatto: ' + (az.email || 'info@carpenteriaticinese.ch'))
  righe.push('')
  return righe.join('\r\n')      // CRLF: si apre bene anche col Blocco note
}

// ── DOCUMENTI_MANCANTI.txt ──────────────────────────────────────────────────
// Due sezioni distinte, perche' sono due problemi diversi e si risolvono in
// modi diversi: un file mai caricato lo si carica, un file non scaricabile e'
// un guasto da guardare.
function testoDocumentiMancanti(mancanti) {
  function blocco(titolo, lista, coda) {
    if (!lista.length) return []
    var out = [titolo, '']
    lista.forEach(function (m) {
      var d = m.data ? fmtDate(m.data) : '(senza data)'
      var chi = String(m.chi || '-')
      var imp = fmtNumIt(safeNum(m.importo) || 0) + ' CHF'
      var r1 = d + '  ' + chi
      while (r1.length < 40) r1 += ' '
      out.push(r1 + imp)
      out.push('            ' + m.motivo)
      out.push('')
    })
    out.push(coda, '')
    return out
  }

  var guasti = mancanti.filter(function (m) { return m.motivo.indexOf('non scaricabile') !== -1 })
  var maiCaricati = mancanti.filter(function (m) { return m.motivo.indexOf('non scaricabile') === -1 })

  var righe = ['DOCUMENTI SENZA ALLEGATO', '',
    'Questi documenti sono nell\'Excel ma il', 'giustificativo non e\' nel pacchetto.', '', '']

  righe = righe.concat(blocco('--- GIUSTIFICATIVO MAI CARICATO ---', maiCaricati,
    'Si risolve caricando il file nel programma.'))
  righe = righe.concat(blocco('--- FILE NON SCARICABILE (GUASTO) ---', guasti,
    'Il file risulta caricato ma non si scarica: va controllato.'))

  return righe.join('\r\n')
}

// ── §7D — collegamento al blocco periodo ────────────────────────────────────

// Quando e' stato consegnato questo periodo, se lo e' stato.
async function dataConsegnaPeriodo(da, a) {
  try {
    const { data, error } = await sb.from('tm_conta_export_log')
      .select('created_at, periodo_da, periodo_a')
      .eq('azienda_id', currentAziendaId)
      .eq('periodo_da', da).eq('periodo_a', a)
      .order('created_at', { ascending: false }).limit(1)
    if (error) throw error
    return (data && data[0]) ? String(data[0].created_at).slice(0, 10) : null
  } catch (e) { return null }
}

// Il blocco NON e' automatico: lo ZIP si genera mille volte per prova, e
// bloccare a ogni generazione renderebbe impossibile provare. Blocca Umberto,
// con un clic esplicito, usando la funzione che esiste gia'.
function proponiConsegna() {
  var card = document.querySelector('#page-export .card:last-of-type')
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' })
  var b = el('exp-lock-btn')
  if (b) { b.focus(); b.classList.add('evidenzia'); setTimeout(function () { b.classList.remove('evidenzia') }, 2600) }
}

// ── Il PDF allegato alla fattura di vendita ─────────────────────────────────

// FASE 9A — apriSceltaPdfFattura() e allegaPdfFattura() non ci sono piu':
// allegavano UN file scrivendo doc_path. Adesso si passa dalla finestra
// «Aggiungi allegato», che vale per tutti i documenti e scrive in
// tm_conta_allegati. Una strada sola.

// ══════════════════════════════════════════════════════════════════════════════
// FASE 8 — PAGAMENTI PARZIALI E RATE
//
// TRE CONCETTI CHE NON SI MESCOLANO MAI:
//   DOCUMENTO   la fattura. Importo fisso.
//   RATE        quello che si e' PROMESSO di pagare. Previsione, date future.
//   PAGAMENTI   quello che si e' PAGATO davvero. Fatto compiuto, data reale.
//
// Sommare rate e pagamenti conterebbe due volte lo stesso denaro. Le rate
// servono alle Scadenze, per sapere QUANDO; i pagamenti dicono QUANTO e' uscito.
//
// stato_pagamento NON si scrive piu' da qui: lo calcola il trigger sul database
// a ogni pagamento inserito o cancellato. Il codice lo legge soltanto.
// ══════════════════════════════════════════════════════════════════════════════

let pagamentiCache = null   // tutti i pagamenti dell'azienda
let rateCache      = null   // tutte le rate dell'azienda
let docPagamentoCorrente = null   // {tabella, id, importo, verso, nome} nella modale

// ── Letture ─────────────────────────────────────────────────────────────────

async function loadPagamenti(force) {
  if (cacheOk('pagamenti') && !force) return pagamentiCache || []
  // Senza sessione non si legge niente, ma non e' una lettura riuscita:
  // segnarla tale bloccherebbe ogni tentativo dopo il login.
  if (!currentAziendaId) { pagamentiCache = []; return pagamentiCache }
  try {
    const { data, error } = await sb.from('tm_conta_pagamenti')
      .select('id, tabella_origine, id_origine, data, importo, metodo, riferimento, note')
      .eq('azienda_id', currentAziendaId)
      .order('data')
    if (error) throw error
    pagamentiCache = data || []
    segnaCacheOk('pagamenti')
  } catch (e) {
    pagamentiCache = pagamentiCache || []   // non riuscita: il prossimo tentativo riprova
    console.warn('Pagamenti non letti:', e.message || e)
  }
  return pagamentiCache
}

async function loadRate(force) {
  if (cacheOk('rate') && !force) return rateCache || []
  // Senza sessione non si legge niente, ma non e' una lettura riuscita:
  // segnarla tale bloccherebbe ogni tentativo dopo il login.
  if (!currentAziendaId) { rateCache = []; return rateCache }
  try {
    const { data, error } = await sb.from('tm_conta_rate')
      .select('id, tabella_origine, id_origine, numero_rata, data_prevista, importo_previsto, pagamento_id, note')
      .eq('azienda_id', currentAziendaId)
      .order('numero_rata')
    if (error) throw error
    rateCache = data || []
    segnaCacheOk('rate')
  } catch (e) {
    rateCache = rateCache || []   // non riuscita: il prossimo tentativo riprova
    console.warn('Rate non lette:', e.message || e)
  }
  return rateCache
}

function pagamentiDi(tabella, id) {
  return (pagamentiCache || []).filter(function (p) {
    return p.tabella_origine === tabella && p.id_origine === id
  })
}
function rateDi(tabella, id) {
  return (rateCache || []).filter(function (r) {
    return r.tabella_origine === tabella && r.id_origine === id
  }).sort(function (a, b) { return a.numero_rata - b.numero_rata })
}
function totalePagatoDi(tabella, id) {
  return pagamentiDi(tabella, id).reduce(function (s, p) { return s + (safeNum(p.importo) || 0) }, 0)
}

// Svuota tutto quello che dipende dai pagamenti: dopo una modifica, ogni
// schermata deve rileggere invece di mostrare numeri vecchi.
function invalidaCachePagamenti() {
  pagamentiCache = null
  rateCache = null
  flussiCache = null
  exportDataset = null
}

// ══ 8B — REGISTRARE UN PAGAMENTO ═══════════════════════════════════════════

// Apre la modale. L'importo proposto e' il RESIDUO: e' quasi sempre quello che
// si sta pagando, e chi paga a rate lo corregge.
// Quale pagamento si sta correggendo. null = se ne sta creando uno nuovo.
// Da questo dipendono il titolo, il testo del bottone e — soprattutto — se al
// salvataggio si fa INSERT o UPDATE.
var pagamentoInModifica = null

// Rimette la finestra come la trova chi registra un pagamento nuovo.
function vestiFinestraPagamento(inModifica) {
  var t = el('pag-title')
  if (t) t.textContent = inModifica ? '✏️ Modifica pagamento' : '💳 Registra pagamento'
  var b = el('pag-salva-btn')
  if (b) b.textContent = inModifica ? '💾 Salva le correzioni' : '💾 Registra'
}

// Apre la finestra sui valori di un pagamento gia' registrato.
async function apriModificaPagamento(idPagamento) {
  try {
    await loadPagamenti(true)
    await loadRate(true)
    var pg = (pagamentiCache || []).filter(function (x) { return x.id === idPagamento })[0]
    if (!pg) throw new Error('Pagamento non trovato: ricarica la pagina.')

    // Il documento a cui appartiene: serve l'importo per il riepilogo.
    var doc = await trovaDocumento(pg.tabella_origine, pg.id_origine)
    var importoDoc = doc ? safeNum(doc.importo != null ? doc.importo : doc.totale) : null
    var verso = pg.tabella_origine === 'tm_conta_fatture' ? 'entrata' : 'uscita'
    var nome = doc ? (doc.fornitore || doc.cliente_nome || doc.descrizione || '') : ''

    await apriRegistraPagamento(pg.tabella_origine, pg.id_origine, importoDoc || 0, verso, nome)

    // I valori attuali prendono il posto delle proposte.
    pagamentoInModifica = pg.id
    setVal('pag-data', pg.data || '')
    setVal('pag-importo', pg.importo == null ? '' : pg.importo)
    setVal('pag-metodo', pg.metodo || '')
    setVal('pag-riferimento', pg.riferimento || '')
    vestiFinestraPagamento(true)

    // La rata: se questo pagamento ne salda una, il collegamento resta com'e'.
    // Non si cambia da qui — spostare un pagamento da una rata all'altra e'
    // un'altra operazione, e mescolarla a questa confonderebbe le due.
    var rata = rateDi(pg.tabella_origine, pg.id_origine)
                 .filter(function (r) { return r.pagamento_id === pg.id })[0]
    var grp = el('pag-rata-group')
    if (grp) grp.style.display = 'none'
    html('pag-avviso', rata
      ? '<div class="pag-nota">📅 Questo pagamento salda la <strong>rata ' +
        rata.numero_rata + '</strong>: il collegamento resta anche dopo la correzione.</div>'
      : '')

    // L'impronta si rifa' ORA, sui valori appena messi: altrimenti la finestra
    // risulterebbe «gia' modificata» appena aperta e chiederebbe conferma
    // anche a chi non ha toccato niente.
    registraAperturaModale('pagamento-overlay')
  } catch (e) {
    window.alert('Impossibile aprire il pagamento: ' + (e.message || e))
  }
}

async function apriRegistraPagamento(tabella, id, importoDoc, verso, nome) {
  pagamentoInModifica = null
  vestiFinestraPagamento(false)
  docPagamentoCorrente = { tabella: tabella, id: id, importo: safeNum(importoDoc) || 0,
                           verso: verso || 'uscita', nome: nome || '' }
  await loadPagamenti(true)
  await loadRate(true)

  var gia = totalePagatoDi(tabella, id)
  var residuo = docPagamentoCorrente.importo - gia

  html('pag-riepilogo',
    rigaPag('Importo del documento', docPagamentoCorrente.importo) +
    rigaPag('Già ' + etichettaPagamento(docPagamentoCorrente.verso, 'pagato').testo.toLowerCase(), gia) +
    rigaPag('Residuo', residuo, true))

  setVal('pag-data', oggiISO())
  setVal('pag-importo', residuo > 0 ? residuo.toFixed(2) : '')
  setVal('pag-metodo', '')
  setVal('pag-riferimento', '')
  html('pag-banner', '')
  html('pag-avviso', '')

  // «Salda la rata» compare solo se ci sono rate non ancora pagate.
  var nonPagate = rateDi(tabella, id).filter(function (r) { return !r.pagamento_id })
  var grp = el('pag-rata-group')
  if (grp) grp.style.display = nonPagate.length ? 'block' : 'none'
  var sel = el('pag-rata')
  if (sel) {
    sel.innerHTML = '<option value="">— nessuna rata —</option>' +
      nonPagate.map(function (r) {
        return '<option value="' + esc(r.id) + '">Rata ' + r.numero_rata + ' del ' +
               esc(fmtDate(r.data_prevista)) + ' — ' + esc(fmtNumIt(r.importo_previsto)) + ' CHF</option>'
      }).join('')
  }

  var ov = el('pagamento-overlay')
  if (ov) ov.style.display = 'flex'
  // L'impronta si prende ADESSO, con i valori gia' proposti dentro: cosi' la
  // domanda «chiudere senza salvare?» arriva solo se l'utente ha cambiato
  // qualcosa, non per i valori che ha trovato scritti.
  registraAperturaModale('pagamento-overlay')
  var inp = el('pag-importo'); if (inp) inp.focus()
}

function rigaPag(etichetta, importo, forte) {
  return '<div class="pag-riga' + (forte ? ' forte' : '') + '">' +
    '<span>' + esc(etichetta) + '</span>' +
    '<span>' + esc(fmtNumIt(importo)) + ' CHF</span></div>'
}

function chiudiRegistraPagamento() {
  var ov = el('pagamento-overlay')
  if (ov) ov.style.display = 'none'
  docPagamentoCorrente = null
  pagamentoInModifica = null
}

// Scegliendo una rata, importo e data si propongono da quella: e' il senso di
// un piano rateale, e riscriverli a mano ogni volta sarebbe solo un modo per
// sbagliarli.
function onRataScelta() {
  var id = getVal('pag-rata')
  if (!id || !docPagamentoCorrente) return
  var r = rateDi(docPagamentoCorrente.tabella, docPagamentoCorrente.id)
            .filter(function (x) { return x.id === id })[0]
  if (!r) return
  setVal('pag-importo', (safeNum(r.importo_previsto) || 0).toFixed(2))
  // La data resta quella di oggi: la rata dice quando ERA prevista, il
  // pagamento dice quando e' avvenuto davvero. Sono due date diverse.
  controllaImportoPagamento()
}

// Avviso NON bloccante se si versa piu' del residuo: capita davvero, con
// interessi e spese bancarie. Si avvisa e si lascia salvare.
function controllaImportoPagamento() {
  if (!docPagamentoCorrente) return
  var imp = safeNum(getVal('pag-importo'))
  var gia = totalePagatoDi(docPagamentoCorrente.tabella, docPagamentoCorrente.id)
  var residuo = docPagamentoCorrente.importo - gia
  if (imp != null && imp > residuo + 0.005) {
    html('pag-avviso',
      '<div class="lettura-nota avviso"><span aria-hidden="true">⚠️</span><span>' +
      'Stai registrando <strong>' + esc(fmtNumIt(imp)) + ' CHF</strong> su un residuo di <strong>' +
      esc(fmtNumIt(residuo)) + ' CHF</strong>: sono <strong>' + esc(fmtNumIt(imp - residuo)) +
      ' CHF</strong> in più. Può essere giusto (interessi, spese bancarie): puoi salvare lo stesso.' +
      '</span></div>')
  } else {
    html('pag-avviso', '')
  }
}

async function salvaPagamento() {
  if (!docPagamentoCorrente) return
  var d = docPagamentoCorrente
  var btn = el('pag-salva-btn')
  try {
    var data = getVal('pag-data')
    var imp = safeNum(getVal('pag-importo'))
    if (!data) throw new Error('Serve la data del pagamento.')
    if (!validaData(data)) throw new Error('La data del pagamento non è valida.')
    // Zero o negativo si rifiuta: non e' un pagamento.
    if (imp == null || imp <= 0) throw new Error('L\'importo deve essere maggiore di zero.')

    if (btn) { btn.disabled = true; btn.textContent = '⏳ Salvataggio…' }

    var creato = null
    if (pagamentoInModifica) {
      // Correzione di un pagamento esistente. Non si toccano ne' il documento
      // ne' la rata collegata: cambiano solo i quattro valori del versamento.
      // Il trigger trg_pagamenti_ricalcola rifa' da solo stato e data del
      // documento, anche in UPDATE: se l'importo cala, «Pagato» torna
      // «Pagato in parte» senza che nessuno lo scriva a mano.
      const { error: eUp } = await sb.from('tm_conta_pagamenti').update({
        data: data,
        importo: imp,
        metodo: getVal('pag-metodo') || null,
        riferimento: getVal('pag-riferimento') || null
      }).eq('id', pagamentoInModifica).eq('azienda_id', currentAziendaId).select()
      if (eUp) throw eUp
    } else {
      const { data: nuovo, error } = await sb.from('tm_conta_pagamenti').insert({
        azienda_id: currentAziendaId,
        tabella_origine: d.tabella,
        id_origine: d.id,
        data: data,
        importo: imp,
        metodo: getVal('pag-metodo') || null,
        riferimento: getVal('pag-riferimento') || null,
        created_by: currentUser ? currentUser.id : null
      }).select()
      if (error) throw error
      creato = nuovo
    }

    // La rata scelta si collega al pagamento appena creato.
    var idRata = pagamentoInModifica ? '' : getVal('pag-rata')
    if (idRata && creato && creato[0]) {
      const { error: eRata } = await sb.from('tm_conta_rate')
        .update({ pagamento_id: creato[0].id })
        .eq('id', idRata).eq('azienda_id', currentAziendaId).select()
      if (eRata) console.warn('Rata non collegata:', eRata.message)
    }

    invalidaCachePagamenti()
    chiudiRegistraPagamento()
    await ricaricaDopoPagamento(d)
  } catch (e) {
    var m = String(e.message || e)
    // Il trigger di immutabilita' non deve entrarci: se compare, e' un segnale.
    if (m.indexOf('sola lettura') !== -1 || m.indexOf('non si puo modificare') !== -1) {
      m = 'Il database ha rifiutato la modifica come se si toccasse un campo congelato della fattura. ' +
          'Non va aggirato: segnalalo. Messaggio: ' + m
    }
    html('pag-banner', '<div class="fase-banner err"><span class="icon" aria-hidden="true">❌</span>' +
      '<div class="msg">' + esc(m) + '</div></div>')
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = pagamentoInModifica ? '💾 Salva le correzioni' : '💾 Registra'
    }
  }
}

// Dopo un pagamento si ridisegna la schermata da cui si e' partiti.
async function ricaricaDopoPagamento(d) {
  try {
    await loadPagamenti(true)
    await loadRate(true)
    if (d.tabella === 'tm_conta_fatture') {
      await loadFattureList(); await viewFattura(d.id)
    } else if (d.tabella === 'tm_conta_fatture_acquisto') {
      await loadAcquistiList(); await viewAcquisto(d.id)
    }
    if (currentPage === 'scadenze') { await loadFlussi(true); renderScadenze() }
    if (currentPage === 'cruscotto') { await loadFlussi(true); renderCruscotto() }
    await refreshScadenzeCount()
  } catch (e) { console.warn('Ricarica dopo pagamento:', e.message || e) }
}

// ── Elenco dei pagamenti nella scheda del documento ─────────────────────────

function elencoPagamentiHtml(tabella, id, verso) {
  var lista = pagamentiDi(tabella, id)
  var rate = rateDi(tabella, id)
  if (!lista.length) {
    return '<div class="cru-vuoto">Nessun pagamento registrato su questo documento.</div>'
  }
  return lista.map(function (p) {
    // Se questo pagamento salda una rata, si dice quale.
    var r = rate.filter(function (x) { return x.pagamento_id === p.id })[0]
    return '<div class="pag-elenco-riga">' +
      '<span class="pag-data">' + esc(fmtDate(p.data)) + '</span>' +
      '<span class="pag-imp">' + esc(fmtNumIt(p.importo)) + ' CHF</span>' +
      '<span class="pag-meta">' +
        esc([p.metodo, p.riferimento].filter(Boolean).join(' · ') || '—') +
        (r ? ' <span class="pag-rata-tag">salda la rata ' + r.numero_rata + '</span>' : '') +
      '</span>' +
      '<button type="button" class="azione-rapida" ' +
        'onclick="apriModificaPagamento(\'' + esc(p.id) + '\')">✏️ Modifica</button>' +
      '<button type="button" class="azione-rapida" ' +
        'onclick="eliminaPagamento(\'' + esc(p.id) + '\', \'' + esc(fmtNumIt(p.importo)) +
        '\', \'' + esc(fmtDate(p.data)) + '\')">🗑️ Elimina</button>' +
    '</div>'
  }).join('')
}

// ── La storia dei pagamenti di un documento ────────────────────────────────
// L'audit registra creazione, correzione ed eliminazione di ogni versamento
// (SQL_FASE13). Senza questa finestra sarebbero righe che nessuno puo' leggere.
//
// Si cerca per DOCUMENTO, non per pagamento: un versamento eliminato non esiste
// piu', e la sua storia — che e' proprio quella che interessa — resterebbe
// irraggiungibile partendo dall'elenco dei pagamenti vivi.
async function apriStoriaPagamenti(tabella, idDoc, nome) {
  html('storia-summary', '')
  html('storia-body', loadingRow('Caricamento storia…'))
  var t = el('storia-title')
  if (t) t.textContent = '🕐 Storia dei pagamenti'
  var ov = el('storia-overlay')
  if (ov) ov.style.display = 'flex'
  registraAperturaModale('storia-overlay')

  html('storia-summary',
    '<div class="cls-sum-title">' + esc(nome || 'Documento') + '</div>' +
    '<div class="cls-sum-meta"><span>💳 Versamenti registrati, corretti o eliminati</span></div>')

  try {
    const { data, error } = await sb
      .from('tm_conta_audit')
      .select('campo, valore_prima, valore_dopo, utente, timestamp')
      .eq('tabella_origine', 'tm_conta_pagamenti')
      .eq('doc_tabella', tabella)
      .eq('doc_id', idDoc)
      .order('timestamp', { ascending: false })
    if (error) throw error

    var rows = data || []
    var ids = []
    for (var i = 0; i < rows.length; i++) { if (rows[i].utente) ids.push(rows[i].utente) }
    await loadUtentiEmails(ids)
    if (!rows.length) {
      html('storia-body',
        '<div class="cru-vuoto">Nessuna modifica registrata sui pagamenti di questo documento.' +
        '<br><span class="dim">La storia parte da quando è stato attivato l\'audit sui pagamenti ' +
        '(SQL_FASE13): i versamenti registrati prima non compaiono.</span></div>')
      return
    }
    renderStoria(rows)
  } catch (e) {
    // Se la colonna non c'e' ancora, lo si dice invece di mostrare l'errore
    // grezzo del database, che qui non aiuterebbe nessuno.
    var m = String(e.message || e)
    html('storia-body', (m.indexOf('doc_tabella') !== -1 || m.indexOf('doc_id') !== -1)
      ? '<div class="cru-vuoto">L\'audit sui pagamenti non è ancora attivo su questo database.' +
        '<br><span class="dim">Va applicato <strong>SQL_FASE13.sql</strong> su Supabase.</span></div>'
      : '<p style="color:var(--err);padding:8px">Errore: ' + esc(m) + '</p>')
  }
}

// La conferma NOMINA importo e data: «Eliminare?» da solo non dice quale dei
// tre versamenti si sta per cancellare.
async function eliminaPagamento(idPagamento, importoTesto, dataTesto) {
  if (!window.confirm('Eliminare il pagamento di ' + importoTesto + ' CHF del ' + dataTesto + '?\n\n' +
      'Lo stato del documento viene ricalcolato: se era «pagato» torna a «pagato in parte» o «non pagato». ' +
      'Una rata collegata torna da pagare.')) return
  try {
    var pg = (pagamentiCache || []).filter(function (p) { return p.id === idPagamento })[0]
    const { error } = await sb.from('tm_conta_pagamenti')
      .delete().eq('id', idPagamento).eq('azienda_id', currentAziendaId)
    if (error) throw error
    invalidaCachePagamenti()
    if (pg) await ricaricaDopoPagamento({ tabella: pg.tabella_origine, id: pg.id_origine })
  } catch (e) {
    window.alert('Pagamento non eliminato: ' + (e.message || e))
  }
}

// ══ 8C — IL PIANO RATEALE ══════════════════════════════════════════════════

let rateBozza = []          // righe dell'anteprima, modificabili prima di salvare
let docRateCorrente = null

async function apriPianoRateale(tabella, id, importoDoc, nome) {
  docRateCorrente = { tabella: tabella, id: id, importo: safeNum(importoDoc) || 0, nome: nome || '' }
  await loadRate(true)
  html('rate-riepilogo', rigaPag('Importo da ripartire', docRateCorrente.importo, true))
  setVal('rate-numero', '4')
  setVal('rate-prima', oggiISO())
  setVal('rate-ogni', 'mese')
  html('rate-banner', '')
  generaAnteprimaRate()
  var ov = el('rate-overlay')
  if (ov) ov.style.display = 'flex'
  registraAperturaModale('rate-overlay')
}

function chiudiPianoRateale() {
  var ov = el('rate-overlay')
  if (ov) ov.style.display = 'none'
  docRateCorrente = null
  rateBozza = []
}

// La ripartizione: importo / numero rate, a 2 decimali. La DIFFERENZA di
// arrotondamento va sull'ULTIMA rata, cosi' la somma torna esatta.
// 100 in 3 rate -> 33,33 + 33,33 + 33,34 = 100,00
function generaAnteprimaRate() {
  if (!docRateCorrente) return
  var n = parseInt(getVal('rate-numero'), 10)
  var prima = getVal('rate-prima')
  var ogni = getVal('rate-ogni') || 'mese'
  if (!n || n < 1 || n > 60) { html('rate-anteprima', '<div class="cru-vuoto">Indica un numero di rate fra 1 e 60.</div>'); rateBozza = []; return }
  if (!prima || !validaData(prima)) { html('rate-anteprima', '<div class="cru-vuoto">Indica la data della prima scadenza.</div>'); rateBozza = []; return }

  var tot = docRateCorrente.importo
  var base = Math.round((tot / n) * 100) / 100
  rateBozza = []
  for (var i = 0; i < n; i++) {
    var imp = (i === n - 1) ? Math.round((tot - base * (n - 1)) * 100) / 100 : base
    rateBozza.push({ numero: i + 1, data: dataRata(prima, i, ogni), importo: imp })
  }
  renderAnteprimaRate()
}

// La data della rata i-esima. Usa addDays / mesi senza mai passare da
// toISOString: le date locali non devono attraversare UTC (regola FASE 2).
function dataRata(prima, indice, ogni) {
  var p = String(prima).split('-')
  var y = +p[0], m = +p[1] - 1, g = +p[2]
  if (ogni === 'settimana') return addDays(prima, indice * 7)

  // Tutte le altre periodicita' sono multipli di un mese: cosi' la regola dei
  // mesi corti vale una volta sola per tutte, anno compreso.
  var MESI = { mese: 1, bimestre: 2, trimestre: 3, semestre: 6, anno: 12 }
  var passo = MESI[ogni] || 1

  var d = new Date(y, m + indice * passo, 1)
  // Se il giorno non esiste nel mese di arrivo si prende l'ultimo disponibile:
  // 31 gennaio + 1 mese fa 28 febbraio, non 3 marzo. Vale anche per l'anno:
  // il 29 febbraio di un bisestile + 1 anno diventa 28 febbraio.
  var ultimo = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(g, ultimo))
  return dataISO(d)
}

function renderAnteprimaRate() {
  var somma = rateBozza.reduce(function (s, r) { return s + (safeNum(r.importo) || 0) }, 0)
  var tot = docRateCorrente ? docRateCorrente.importo : 0
  var torna = Math.abs(somma - tot) < 0.005

  var righe = rateBozza.map(function (r, i) {
    return '<div class="rata-riga">' +
      '<span class="rata-n">' + r.numero + '</span>' +
      '<input type="date" class="form-input rata-data" value="' + esc(r.data) + '" ' +
        'onchange="modificaRata(' + i + ', \'data\', this.value)" aria-label="Data rata ' + r.numero + '" />' +
      '<input type="number" step="0.01" min="0" class="form-input rata-imp" value="' + esc(r.importo) + '" ' +
        'onchange="modificaRata(' + i + ', \'importo\', this.value)" aria-label="Importo rata ' + r.numero + '" />' +
      '<span class="rata-chf">CHF</span>' +
    '</div>'
  }).join('')

  html('rate-anteprima', righe +
    '<div class="rata-totale' + (torna ? ' ok' : ' err') + '">' +
      '<span>Totale delle rate</span>' +
      '<span>' + esc(fmtNumIt(somma)) + ' CHF</span>' +
      '<span>' + (torna
        ? '✅ corrisponde all\'importo del documento'
        : '❌ non corrisponde: mancano ' + esc(fmtNumIt(tot - somma)) + ' CHF') + '</span>' +
    '</div>')

  // Qui bloccare e' giusto: un piano che non somma e' un piano sbagliato, e
  // salvarlo significherebbe portarsi dietro un errore in ogni scadenza futura.
  var btn = el('rate-salva-btn')
  if (btn) btn.disabled = !torna || !rateBozza.length
}

function modificaRata(i, campo, valore) {
  if (!rateBozza[i]) return
  if (campo === 'importo') rateBozza[i].importo = safeNum(valore) || 0
  else rateBozza[i].data = valore
  renderAnteprimaRate()
}

async function salvaPianoRateale() {
  if (!docRateCorrente || !rateBozza.length) return
  var d = docRateCorrente
  var btn = el('rate-salva-btn')
  try {
    var somma = rateBozza.reduce(function (s, r) { return s + (safeNum(r.importo) || 0) }, 0)
    if (Math.abs(somma - d.importo) > 0.005) {
      throw new Error('Le rate sommano ' + fmtNumIt(somma) + ' CHF invece di ' + fmtNumIt(d.importo) + ' CHF.')
    }
    for (var i = 0; i < rateBozza.length; i++) {
      if (!validaData(rateBozza[i].data)) throw new Error('La data della rata ' + rateBozza[i].numero + ' non è valida.')
      if ((safeNum(rateBozza[i].importo) || 0) <= 0) throw new Error('L\'importo della rata ' + rateBozza[i].numero + ' deve essere maggiore di zero.')
    }
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Salvataggio…' }

    // Si sostituisce il piano: si tolgono solo le rate NON pagate, quelle gia'
    // saldate restano perche' sono collegate a un pagamento vero.
    const { error: eDel } = await sb.from('tm_conta_rate')
      .delete()
      .eq('tabella_origine', d.tabella).eq('id_origine', d.id)
      .eq('azienda_id', currentAziendaId)
      .is('pagamento_id', null)
    if (eDel) throw eDel

    const { error } = await sb.from('tm_conta_rate').insert(rateBozza.map(function (r) {
      return {
        azienda_id: currentAziendaId,
        tabella_origine: d.tabella, id_origine: d.id,
        numero_rata: r.numero, data_prevista: r.data, importo_previsto: r.importo
      }
    })).select()
    if (error) throw error

    invalidaCachePagamenti()
    chiudiPianoRateale()
    await ricaricaDopoPagamento(d)
  } catch (e) {
    html('rate-banner', '<div class="fase-banner err"><span class="icon" aria-hidden="true">❌</span>' +
      '<div class="msg">' + esc(e.message || e) + '</div></div>')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Salva il piano' }
  }
}

// ── Elenco delle rate nella scheda ──────────────────────────────────────────

function elencoRateHtml(tabella, id) {
  var lista = rateDi(tabella, id)
  if (!lista.length) return ''
  var pag = pagamentiCache || []
  return '<div class="rate-elenco">' + lista.map(function (r) {
    var p = r.pagamento_id ? pag.filter(function (x) { return x.id === r.pagamento_id })[0] : null
    return '<div class="rata-elenco-riga">' +
      '<span class="rata-n">' + r.numero_rata + '</span>' +
      '<span class="rata-data-txt">' + esc(fmtDate(r.data_prevista)) + '</span>' +
      '<span class="rata-imp-txt">' + esc(fmtNumIt(r.importo_previsto)) + ' CHF</span>' +
      '<span class="rata-stato">' + (p
        ? '✅ pagata il ' + esc(fmtDate(p.data))
        : '⏳ da pagare') + '</span>' +
    '</div>'
  }).join('') + '</div>'
}

// ── Il riquadro completo «Pagamenti e rate» per la scheda del documento ─────

function boxPagamentiHtml(tabella, id, importoDoc, verso, nome) {
  var gia = totalePagatoDi(tabella, id)
  var residuo = (safeNum(importoDoc) || 0) - gia
  var rate = rateDi(tabella, id)
  var e = etichettaPagamento(verso, gia <= 0.005 ? 'aperto' : (residuo > 0.005 ? 'parziale' : 'pagato'))
  var argomenti = "'" + esc(tabella) + "', '" + esc(id) + "', " + (safeNum(importoDoc) || 0) +
                  ", '" + esc(verso) + "', '" + esc(String(nome || '').replace(/'/g, '')) + "'"

  return '<div class="card">' +
    '<div class="card-title">💳 Pagamenti</div>' +
    '<div class="pag-sommario">' +
      rigaPag('Importo del documento', safeNum(importoDoc) || 0) +
      rigaPag(etichettaPagamento(verso, 'pagato').testo, gia) +
      rigaPag('Residuo', residuo, true) +
      '<div class="pag-stato-riga">' + badge(e.cls, e.icona + ' ' + e.testo) + '</div>' +
    '</div>' +
    elencoPagamentiHtml(tabella, id, verso) +
    '<div class="form-actions" style="margin-top:12px">' +
      '<button type="button" class="btn-primary" onclick="apriRegistraPagamento(' + argomenti + ')">' +
        '➕ Registra pagamento</button>' +
      '<button type="button" class="btn-secondary" onclick="apriPianoRateale(\'' + esc(tabella) + '\', \'' +
        esc(id) + '\', ' + (safeNum(importoDoc) || 0) + ', \'' + esc(String(nome || '').replace(/'/g, '')) + '\')">' +
        (rate.length ? '📅 Modifica il piano rateale' : '📅 Crea piano rateale') + '</button>' +
      '<button type="button" class="btn-secondary" onclick="apriStoriaPagamenti(\'' +
        esc(tabella) + '\', \'' + esc(id) + '\', \'' +
        esc(String(nome || '').replace(/'/g, '')) + '\')">🕐 Storia</button>' +
    '</div>' +
    (rate.length
      ? '<div class="card-title" style="margin-top:16px">📅 Rate</div>' + elencoRateHtml(tabella, id)
      : '') +
  '</div>'
}


// ══════════════════════════════════════════════════════════════════════════════
// LE FINESTRE — regola unica per tutto il programma
//
// Un clic fuori non deve mai cancellare mezz'ora di lavoro. E' successo con il
// piano rateale: dodici rate scritte a mano, un clic di troppo, tutto perso.
//
//   FINESTRE DOVE SI SCRIVE  (pagamento, rate, classificazione, emissione)
//     clic fuori: NON chiude, mai.
//     Esc, X, Annulla: chiudono, ma se c'e' qualcosa di scritto chiedono prima.
//
//   FINESTRE DI SOLA LETTURA  (scadenze, storia modifiche)
//     clic fuori: chiude. Non c'e' niente da perdere.
//
// «Qualcosa di scritto» non vuol dire «campi non vuoti»: una finestra appena
// aperta ha gia' dei valori proposti, e chiedere conferma per quelli sarebbe
// solo fastidioso. Si confronta con l'impronta presa all'apertura, cosi' la
// domanda arriva solo se l'utente ha davvero cambiato qualcosa.
// ══════════════════════════════════════════════════════════════════════════════

// Quali finestre proteggere, e come chiuderle.
var FINESTRE = {
  'pagamento-overlay':    { chiudi: 'chiudiRegistraPagamento', protetta: true },
  'rate-overlay':         { chiudi: 'chiudiPianoRateale',      protetta: true },
  'classify-overlay':     { chiudi: 'closeClassifyPanel',      protetta: true },
  'allegato-overlay':     { chiudi: 'chiudiAggiungiAllegato',  protetta: true },
  'emit-confirm-overlay': { chiudi: 'closeEmitConfirm',        protetta: true },
  'scadenze-overlay':     { chiudi: 'chiudiFinestraScadenze',  protetta: false },
  'storia-overlay':       { chiudi: 'closeStoria',             protetta: false }
}

var improntaFinestre = {}   // id -> stato dei campi al momento dell'apertura
var ordineApertura = []     // le finestre nell'ordine in cui sono state aperte

// L'impronta: tutti i campi compilabili dentro la finestra, in un'unica stringa.
// Le rate in corso di stesura non stanno nei campi ma in rateBozza: si aggiunge
// anche quella, altrimenti dodici righe modificate a mano non risulterebbero.
function improntaModale(idOverlay) {
  var ov = el(idOverlay)
  if (!ov) return ''
  var pezzi = []
  var campi = ov.querySelectorAll('input, select, textarea')
  for (var i = 0; i < campi.length; i++) {
    var c = campi[i]
    if (c.type === 'checkbox' || c.type === 'radio') pezzi.push(c.checked ? '1' : '0')
    else pezzi.push(String(c.value == null ? '' : c.value))
  }
  if (idOverlay === 'rate-overlay' && typeof rateBozza !== 'undefined') {
    pezzi.push(JSON.stringify(rateBozza))
  }
  return pezzi.join('')
}

// Da chiamare appena la finestra si apre, DOPO aver riempito i campi proposti.
function registraAperturaModale(idOverlay) {
  improntaFinestre[idOverlay] = improntaModale(idOverlay)
  // Si tiene anche l'ordine: se due finestre risultassero aperte insieme, Esc
  // deve chiudere l'ULTIMA, non una a caso.
  var i = ordineApertura.indexOf(idOverlay)
  if (i !== -1) ordineApertura.splice(i, 1)
  ordineApertura.push(idOverlay)
}

function modaleModificata(idOverlay) {
  if (!(idOverlay in improntaFinestre)) return false
  return improntaModale(idOverlay) !== improntaFinestre[idOverlay]
}

// La chiusura che passa dalla domanda. La usano la X, Annulla ed Esc.
function chiudiModaleConConferma(idOverlay) {
  var conf = FINESTRE[idOverlay]
  if (!conf) return
  var chiudi = window[conf.chiudi]
  if (typeof chiudi !== 'function') return

  // Finestra vuota o non toccata: si chiude subito, senza domande inutili.
  function dimentica() {
    delete improntaFinestre[idOverlay]
    var i = ordineApertura.indexOf(idOverlay)
    if (i !== -1) ordineApertura.splice(i, 1)
  }
  if (!conf.protetta || !modaleModificata(idOverlay)) {
    dimentica()
    chiudi()
    return
  }
  if (window.confirm('Chiudere senza salvare?\n\nI dati inseriti andranno persi.')) {
    dimentica()
    chiudi()
  }
  // Se risponde Annulla non succede niente: la finestra resta aperta com'era.
}

// Qual e' la finestra aperta in questo momento (l'ultima in ordine di DOM).
function modaleAperta() {
  function eAperta(id) {
    var ov = el(id)
    return ov && ov.style.display !== 'none' && ov.style.display !== ''
  }
  // Prima si guarda l'ordine di apertura, dall'ultima alla prima.
  for (var i = ordineApertura.length - 1; i >= 0; i--) {
    if (eAperta(ordineApertura[i])) return ordineApertura[i]
  }
  // Ripiego per le finestre di sola lettura, che non registrano l'impronta.
  var altre = Object.keys(FINESTRE).filter(eAperta)
  return altre.length ? altre[altre.length - 1] : null
}

// ── Esc e clic fuori, in un posto solo ──────────────────────────────────────
function installaGestioneFinestre() {
  // Esc: chiude la finestra aperta, passando dalla domanda se serve.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return
    var id = modaleAperta()
    if (!id) return
    e.preventDefault()
    chiudiModaleConConferma(id)
  })

  // Clic fuori: SOLO sulle finestre di sola lettura.
  Object.keys(FINESTRE).forEach(function (id) {
    if (FINESTRE[id].protetta) return
    var ov = el(id)
    if (!ov) return
    ov.addEventListener('click', function (e) {
      // solo il clic sullo sfondo, non quello sul contenuto della finestra
      if (e.target !== ov) return
      chiudiModaleConConferma(id)
    })
  })
}


// ══════════════════════════════════════════════════════════════════════════════
// LA CRONOLOGIA — il tasto Indietro torna alla schermata precedente
//
// Prima usciva dal programma: la navigazione interna non lasciava traccia nella
// cronologia del browser, quindi «Indietro» riportava alla pagina di prima —
// cioe' fuori. Su un telefono, dove Indietro e' il gesto piu' usato, era un modo
// sicuro per perdere quello che si stava facendo.
//
// Si usa l'indirizzo con il cancelletto (#situazione, #fatture/dettaglio):
// non ricarica niente, funziona anche su GitHub Pages che serve il sito da una
// sottocartella, e rende i collegamenti diretti condivisibili.
//
// Livelli: ogni sezione puo' avere un sottolivello (elenco -> dettaglio ->
// modifica). Indietro ne risale UNO alla volta, non salta all'inizio.
// ══════════════════════════════════════════════════════════════════════════════

var navInCorso = false      // true mentre si applica un «indietro»: non si ripusha
var vistaCorrente = {}      // pagina -> sottolivello attuale, es. {fatture: 'detail'}

// Le sezioni che hanno sottolivelli, con la funzione che li applica.
// L'ordine conta: e' quello in cui «Indietro» li risale.
var LIVELLI = {
  fatture:   { livelli: ['list', 'detail', 'edit'],   applica: 'showFattureView' },
  acquisti:  { livelli: ['list', 'detail', 'edit'],   applica: 'showAcquistiView' },
  // FASE 18 — «lettura» sta fra elenco e modulo: Indietro dal modulo torna
  // alla scheda letta, e da li' all'elenco.
  rubrica:   { livelli: ['lista', 'lettura', 'scheda'], applica: 'mostraRubricaVista' },
  cantieri:  { livelli: ['elenco', 'scheda'],         applica: '_vistaCantieri' }
}

// I cantieri non hanno una funzione unica: si passa da due funzioni diverse.
function _vistaCantieri(quale) {
  if (quale === 'scheda' && cantiereApertoId) apriCantiere(cantiereApertoId)
  else tornaElencoCantieri()
}

// L'indirizzo che descrive dove siamo: «#fatture/detail».
function indirizzoDi(pagina, vista) {
  if (!pagina) return '#'
  return '#' + pagina + (vista && vista !== 'list' && vista !== 'lista' && vista !== 'elenco'
                         ? '/' + vista : '')
}

// Mette la posizione attuale nella cronologia. `sostituisci` per il primo
// caricamento, dove non si deve creare una voce in piu'.
function spingiStato(pagina, vista, sostituisci) {
  if (navInCorso) return
  var stato = { p: pagina, v: vista || null }
  var url = indirizzoDi(pagina, vista)
  try {
    if (sostituisci) history.replaceState(stato, '', url)
    else history.pushState(stato, '', url)
  } catch (e) { /* se la cronologia non e' disponibile si naviga lo stesso */ }
}

// Applica uno stato SENZA rimetterlo nella cronologia.
function applicaStato(stato) {
  if (!stato || !stato.p) return
  navInCorso = true
  try {
    if (currentPage !== stato.p) {
      showPage(stato.p)
      caricaPagina(stato.p)
    }
    var conf = LIVELLI[stato.p]
    if (conf) {
      var fn = window[conf.applica]
      if (typeof fn === 'function') fn(stato.v || conf.livelli[0])
      vistaCorrente[stato.p] = stato.v || conf.livelli[0]
    }
  } finally {
    navInCorso = false
  }
}

// Il caricamento dei dati di una pagina, uguale a quello del menu: cosi'
// arrivando da un collegamento diretto la schermata non resta vuota.
function caricaPagina(pageId) {
  try {
    if (pageId === 'movimenti')   { loadDaClassificare() }
    if (pageId === 'inserimento') { initInserimentoPage() }
    if (pageId === 'export')      { initExportPage() }
    if (pageId === 'fatture')     { initFatturePage() }
    if (pageId === 'acquisti')    { initAcquistiPage() }
    if (pageId === 'rubrica')     { initRubricaPage() }
    if (pageId === 'codici')      { initCodiciPage() }
    if (pageId === 'busta')       { initBustaPage() }
    if (pageId === 'cruscotto')   { initCruscottoPage() }
    if (pageId === 'scadenze')    { initScadenzePage() }
    if (pageId === 'cantieri')    { initCantieriPage() }
    if (pageId === 'impostazioni'){ initImpostazioniPage() }
  } catch (e) { console.warn('Caricamento pagina ' + pageId + ':', e.message || e) }
}

// Da chiamare quando cambia il sottolivello dentro una sezione.
function registraVista(pagina, vista) {
  if (navInCorso) return
  if (vistaCorrente[pagina] === vista) return     // niente di nuovo da ricordare
  vistaCorrente[pagina] = vista
  spingiStato(pagina, vista, false)
}

// ── Il tasto Indietro ───────────────────────────────────────────────────────
function installaCronologia() {
  window.addEventListener('popstate', function (ev) {
    // 1. Se c'e' una finestra aperta, Indietro chiude PRIMA quella.
    //    Con la stessa domanda di Esc, se ci sono dati non salvati.
    var idModale = (typeof modaleAperta === 'function') ? modaleAperta() : null
    if (idModale) {
      var eraAperta = true
      chiudiModaleConConferma(idModale)
      var ov = el(idModale)
      var ancoraAperta = ov && ov.style.display !== 'none' && ov.style.display !== ''
      // In tutti e due i casi — chiusa, oppure lasciata aperta perche' l'utente
      // ha risposto «Annulla» — la posizione nella cronologia va rimessa com'era:
      // il tasto Indietro ha consumato una voce che non doveva consumare.
      spingiStato(currentPage, vistaCorrente[currentPage], false)
      return
    }

    // 2. Nessuna finestra aperta: si torna dove dice la cronologia.
    var stato = ev.state
    if (!stato) {
      // Voce senza stato (il primo caricamento): si legge l'indirizzo.
      stato = statoDaIndirizzo()
    }
    if (stato && stato.p) applicaStato(stato)
    else {
      // Si e' risaliti oltre l'inizio: si torna alla schermata di partenza.
      applicaStato({ p: currentUser ? 'setup' : 'login', v: null })
    }
  })
}

// Legge «#fatture/detail» e ne fa uno stato.
function statoDaIndirizzo() {
  var h = String(window.location.hash || '').replace(/^#/, '')
  if (!h) return null
  var pezzi = h.split('/')
  var pagina = pezzi[0]
  if (!el('page-' + pagina)) return null      // indirizzo di una pagina che non c'e'
  return { p: pagina, v: pezzi[1] || null }
}

// All'avvio: se l'indirizzo ha un cancelletto, si apre quella schermata.
// Serve ai collegamenti diretti e al ricaricamento della pagina.
function apriDaIndirizzo() {
  var stato = statoDaIndirizzo()
  if (!stato) return false
  // Le pagine riservate si aprono solo a utente autenticato: senza, si finisce
  // sul login e l'indirizzo verrebbe solo a promettere qualcosa che non c'e'.
  var btn = document.querySelector('.nav-item[data-page="' + stato.p + '"]')
  if (btn && btn.classList.contains('auth-only') && !currentUser) return false
  applicaStato(stato)
  spingiStato(stato.p, stato.v, true)
  return true
}


// ══════════════════════════════════════════════════════════════════════════════
// LA CLASSIFICAZIONE NELLA SCHEDA DEL DOCUMENTO
//
// Prima, una volta classificato un documento, non c'era piu' modo di cambiargli
// il conto: «Da classificare» era a zero e la scheda non offriva niente. Per
// correggere un conto sbagliato bisognava aspettare che il documento tornasse
// nell'elenco, cosa che non succedeva mai.
//
// Adesso ogni scheda mostra come e' classificato il documento e permette di
// rifarlo, riusando la stessa modale di «Da classificare»: una sola finestra,
// una sola logica di salvataggio, un solo posto dove l'audit registra tutto.
// ══════════════════════════════════════════════════════════════════════════════

// La classificazione di un documento, letta dalla mappa gia' caricata.
function classificazioneDi(origineTipo, origineId) {
  return (classByKey && classByKey[origineTipo + ':' + origineId]) || null
}

// Ricostruisce il "movimento" nella forma che la modale si aspetta.
// Le tre schede hanno campi con nomi diversi: qui si normalizzano una volta.
function movimentoPerClassificare(tabella, doc) {
  if (tabella === 'tm_conta_fatture') {
    return {
      origine_tipo: 'fattura', origine_id: doc.id,
      data: doc.data_emissione, importo: safeNum(doc.totale),
      valuta: doc.valuta || 'CHF', cantiere_id: null,
      descrizione: (doc.tipo === 'nota_credito' ? 'Nota di credito ' : 'Fattura ') +
                   (doc.numero || '') + ' — ' + (doc.cliente_nome || ''),
      ente: doc.cliente_nome || null,
      _sorgente: 'Fatture vendita', _tipo_label: 'Fattura di vendita', _icon: '📤'
    }
  }
  if (tabella === 'tm_conta_fatture_acquisto') {
    return {
      origine_tipo: 'acquisto', origine_id: doc.id,
      data: doc.data, importo: safeNum(doc.importo),
      valuta: doc.valuta || 'CHF', cantiere_id: null,
      codice_iva_id: doc.codice_iva_id || null,   // FASE 20 — vedi sopra
      descrizione: 'Acquisto ' + (doc.numero_fornitore || '') + ' — ' + (doc.fornitore || ''),
      ente: doc.fornitore || null,
      _sorgente: 'Fatture acquisto', _tipo_label: 'Fattura acquisto', _icon: '📥'
    }
  }
  return {
    origine_tipo: 'proprio', origine_id: doc.id,
    data: doc.data, importo: safeNum(doc.importo),
    valuta: doc.valuta || 'CHF', cantiere_id: null,
    descrizione: doc.descrizione || 'Movimento',
    ente: doc.ente_fornitore || null,
    _sorgente: 'Inserimento manuale', _tipo_label: 'Movimento proprio', _icon: '➕'
  }
}

// Il riquadro. Mostra i quattro dati che contano e il bottone per rifarla.
function boxClassificazioneHtml(tabella, doc) {
  var m = movimentoPerClassificare(tabella, doc)
  var c = classificazioneDi(m.origine_tipo, m.origine_id)
  var bloccato = isBloccato(m.origine_tipo, m.origine_id)

  var azione
  if (bloccato) {
    // Il periodo consegnato non si tocca: si dice perche' e come sbloccarlo,
    // invece di lasciare un bottone che da' errore quando lo si preme.
    azione = '<button type="button" class="btn-secondary" disabled ' +
      'title="Il periodo e stato consegnato al commercialista">🔒 Periodo consegnato</button>' +
      '<div class="form-hint" style="margin-top:6px">' +
        'Periodo consegnato — sblocca da «Export &amp; consegna» per modificare.</div>'
  } else {
    azione = '<button type="button" class="btn-secondary" ' +
      'onclick="riclassificaDocumento(\'' + esc(tabella) + '\', \'' + esc(doc.id) + '\')">' +
      (c ? '🏷 Riclassifica' : '🏷 Classifica') + '</button>'
  }

  if (!c) {
    return '<div class="card">' +
      '<div class="card-title">🏷 Classificazione</div>' +
      '<div class="cru-vuoto"><strong>Non ancora classificato.</strong><br>' +
        'Finché non ha un conto, questo documento non entra nei gruppi di spesa ' +
        'né nell\'export per il commercialista.</div>' +
      '<div class="form-actions" style="margin-top:12px">' + azione + '</div>' +
    '</div>'
  }

  // Il gruppo si deriva dal conto (FASE 3): qui si mostra quello che vedra' il
  // cruscotto, dicendo da dove viene.
  var conto = (contiCache || []).filter(function (x) { return x.id === c.conto_id })[0]
  var gruppoCod = doc.gruppo_codice || (conto ? conto.gruppo_codice : null)
  var gruppoTesto = gruppoCod
    ? gruppoCod + ' ' + nomeGruppo(gruppoCod) + (doc.gruppo_codice ? ' (scelto a mano)' : ' (dal conto)')
    : 'nessuno'

  function riga(etichetta, valore) {
    return '<div class="class-riga">' +
      '<span class="class-et">' + esc(etichetta) + '</span>' +
      '<span class="class-val">' + esc(valore) + '</span></div>'
  }

  return '<div class="card">' +
    '<div class="card-title">🏷 Classificazione</div>' +
    riga('Conto',    contoLabel(c.conto_id)) +
    riga('Gruppo',   gruppoTesto) +
    riga('Cantiere', c.cantiere_id ? cantiereLabel(c.cantiere_id) : 'nessuno (spesa aziendale)') +
    riga('IVA',      ivaLabel(c.codice_iva_id)) +
    (c.note ? riga('Note', c.note) : '') +
    '<div class="class-stato">' + statoBadge(c.stato) + '</div>' +
    '<div class="form-actions" style="margin-top:12px">' + azione + '</div>' +
  '</div>'
}

// Apre la modale gia' esistente, precompilata con i valori attuali.
// Ogni modifica passa da saveClassificazione(), quindi finisce nell'audit come
// sempre: non c'e' una seconda strada di salvataggio da tenere allineata.
async function riclassificaDocumento(tabella, idDoc) {
  try {
    var doc = await trovaDocumento(tabella, idDoc)
    if (!doc) throw new Error('Documento non trovato: ricarica la pagina.')
    var m = movimentoPerClassificare(tabella, doc)

    if (isBloccato(m.origine_tipo, m.origine_id)) {
      window.alert('Periodo consegnato (bloccato).\n\nRiaprilo dalla pagina «Export & consegna» per riclassificare.')
      return
    }
    classifyMode = 'single'
    await openSingleClassify(m, classificazioneDi(m.origine_tipo, m.origine_id))
  } catch (e) {
    window.alert('Impossibile aprire la classificazione: ' + (e.message || e))
  }
}

// Il documento: prima dagli elenchi in memoria, che e' immediato; se li' non
// c'e' — un filtro attivo, una ricerca, l'arrivo da un'altra schermata — lo si
// legge dal database. Prima ci si fermava al primo passo, e il bottone
// «Riclassifica» spariva o dava «documento non trovato» proprio sui documenti
// che non stavano nell'elenco aperto in quel momento.
function docInMemoria(tabella, idDoc) {
  if (tabella === 'tm_conta_fatture') {
    if (currentDetailFattura && currentDetailFattura.id === idDoc) return currentDetailFattura
    return (fattureList || []).filter(function (x) { return x.id === idDoc })[0]
  }
  if (tabella === 'tm_conta_fatture_acquisto') {
    return (acquistiList || []).filter(function (x) { return x.id === idDoc })[0]
  }
  return (recentiList || []).filter(function (x) { return x.id === idDoc })[0]
}

async function trovaDocumento(tabella, idDoc) {
  var d = docInMemoria(tabella, idDoc)
  if (d) return d
  if (!idDoc || !currentAziendaId) return null
  const { data, error } = await sb.from(tabella).select('*')
    .eq('id', idDoc).eq('azienda_id', currentAziendaId).single()
  if (error) throw error
  return data
}

// Le classificazioni servono anche fuori dalla schermata «Da classificare»:
// senza questa lettura le schede mostrerebbero «non classificato» per tutto.
async function assicuraClassificazioni(force) {
  if (classByKey && Object.keys(classByKey).length && !force) return classByKey
  if (!currentAziendaId) return classByKey
  try {
    const { data, error } = await sb.from('tm_conta_classificazioni')
      .select('id, origine_tipo, origine_id, conto_id, codice_iva_id, categoria, note, imponibile, iva_importo, iva_inclusa, cantiere_id, stato')
      .eq('azienda_id', currentAziendaId)
    if (error) throw error
    classByKey = {}
    ;(data || []).forEach(function (c) { classByKey[c.origine_tipo + ':' + c.origine_id] = c })
  } catch (e) {
    console.warn('Classificazioni non lette:', e.message || e)
  }
  return classByKey
}

// Ridisegna il riquadro dopo un salvataggio, senza ricaricare la schermata.
async function aggiornaBoxClassificazione(tabella, idDoc, idContenitore, doc) {
  try {
    await assicuraClassificazioni(true)
    await ensureContiIva()
    await loadCantieri()
    await loadGruppi()
    // Il documento arriva da chi apre la scheda, che ce l'ha gia' letto dal
    // database. Si ricade sugli elenchi in memoria solo se non e' stato
    // passato: cercarlo li' e' quello che faceva sparire il riquadro sui
    // documenti fuori dall'elenco corrente.
    var d = doc || await trovaDocumento(tabella, idDoc)
    if (d) { html(idContenitore, boxClassificazioneHtml(tabella, d)); return }
    throw new Error('documento non trovato in memoria')
  } catch (e) {
    // Un riquadro vuoto e senza spiegazione e' come se la funzione non ci
    // fosse: si dice cosa e' successo e si lascia la strada per riprovare.
    console.warn('Riquadro classificazione:', e.message || e)
    html(idContenitore,
      '<div class="card"><div class="card-title">🏷 Classificazione</div>' +
      '<div class="cru-vuoto">Non sono riuscito a leggere la classificazione di questo ' +
      'documento. Ricarica la pagina: se il problema resta, il conto si cambia dalla ' +
      'schermata <strong>Da classificare</strong>.</div></div>')
  }
}

// La riga di classificazione in cima al form di modifica. Chi entra con la
// matita non passa dalla scheda: senza questa riga il bottone non lo vedeva.
function rigaClassificazioneFormHtml(tabella, doc) {
  var m = movimentoPerClassificare(tabella, doc)
  var c = classificazioneDi(m.origine_tipo, m.origine_id)
  var testo = c && c.conto_id
    ? '<strong>' + esc(contoLabel(c.conto_id)) + '</strong>'
    : '<span class="dim">non ancora classificato</span>'
  var azione = isBloccato(m.origine_tipo, m.origine_id)
    ? '<button type="button" class="btn-secondary" disabled ' +
        'title="Il periodo e stato consegnato al commercialista">🔒 Periodo consegnato</button>'
    : '<button type="button" class="btn-secondary" ' +
        'onclick="riclassificaDocumento(\'' + esc(tabella) + '\', \'' + esc(doc.id) + '\')">' +
        (c && c.conto_id ? '🏷 Riclassifica' : '🏷 Classifica') + '</button>'
  return '<div class="class-riga-form">' +
    '<span>Classificazione: ' + testo + '</span>' + azione + '</div>'
}

async function aggiornaRigaClassificazioneForm(tabella, idDoc, idContenitore, doc) {
  try {
    if (!idDoc) { html(idContenitore, ''); return }   // documento nuovo: non esiste ancora
    await assicuraClassificazioni(true)
    await ensureContiIva()
    var d = doc || await trovaDocumento(tabella, idDoc)
    if (d) html(idContenitore, rigaClassificazioneFormHtml(tabella, d))
    else html(idContenitore, '')
  } catch (e) {
    console.warn('Riga classificazione nel form:', e.message || e)
    html(idContenitore, '')
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// FASE 9A — GLI ALLEGATI
//
// Prima ogni documento aveva UN allegato: la colonna doc_path. Una fattura con
// due bolle di consegna e la ricevuta del bonifico non ci stava — o si caricava
// la fattura, o si caricava la bolla.
//
// Adesso ogni allegato e' una riga in tm_conta_allegati, con il suo tipo.
// doc_path resta nel database come storico (SQL_FASE9) ma NON si legge e NON si
// scrive piu' da nessuna parte: una fonte sola, come per i pagamenti.
// ══════════════════════════════════════════════════════════════════════════════

var LIMITE_ALLEGATO_MB = 10

// I quattro tipi, con icona ed etichetta. L'icona non va mai da sola.
var TIPI_ALLEGATO = [
  { v: 'fattura',  et: 'Fattura',  ic: '📄' },
  { v: 'bolla',    et: 'Bolla',    ic: '📋' },
  { v: 'ricevuta', et: 'Ricevuta', ic: '🧾' },
  { v: 'altro',    et: 'Altro',    ic: '📎' },
  // FASE 22 — la polizza QR della banca. Non si sceglie da questa tendina: si
  // carica dal suo riquadro sulla fattura, perche' porta con se' l'immagine
  // per la stampa. Sta qui perche' l'elenco degli allegati la deve saper
  // nominare, e perche' il pacchetto per il commercialista la ritrovi.
  { v: 'polizza_qr', et: 'Polizza QR', ic: '🏦' }
]

// Il tipo 'altro' e' il ripiego. Si cerca per nome e non per posizione:
// l'indice fisso 3 aveva smesso di essere «altro» appena si e' aggiunta una
// voce in coda.
function etichettaTipoAllegato(tipo) {
  var ripiego = null
  for (var i = 0; i < TIPI_ALLEGATO.length; i++) {
    if (TIPI_ALLEGATO[i].v === tipo) return TIPI_ALLEGATO[i]
    if (TIPI_ALLEGATO[i].v === 'altro') ripiego = TIPI_ALLEGATO[i]
  }
  return ripiego || TIPI_ALLEGATO[0]
}

// ── La cache ────────────────────────────────────────────────────────────────
// Si caricano tutti gli allegati dell'azienda in un colpo: sono poche righe, e
// cosi' gli elenchi possono scrivere «📎 3» senza una query per riga.
let allegatiCache = []

// Il file scelto nel form diventa un allegato del documento appena salvato.
// Restituisce null se e' andato tutto bene, o il motivo del fallimento: il
// documento resta salvato comunque, e il chiamante lo dice.
async function creaAllegatoDaForm(file, tabella, idDoc) {
  if (!file || !idDoc) return null
  try {
    var mb = file.size / (1024 * 1024)
    if (mb > LIMITE_ALLEGATO_MB) {
      return 'il file pesa ' + fmtNumIt(mb) + ' MB, oltre il limite di ' + LIMITE_ALLEGATO_MB + ' MB'
    }
    var path = await uploadAllegato(file)
    const { error } = await sb.from('tm_conta_allegati').insert({
      azienda_id: currentAziendaId,
      tabella_origine: tabella,
      id_origine: idDoc,
      tipo: 'fattura',
      path: path,
      nome_file: file.name,
      dimensione: file.size,
      created_by: currentUser ? currentUser.id : null
    }).select()
    if (error) {
      // Il file e' salito ma la riga no: si toglie, altrimenti resta nello
      // Storage senza che niente lo nomini.
      try { await deleteAllegatoStorage(path) } catch (_) {}
      throw error
    }
    invalidaCacheAllegati()
    return null
  } catch (e) {
    return e.message || String(e)
  }
}

async function loadAllegati(force) {
  if (cacheOk('allegati') && !force) return allegatiCache || []
  // Senza sessione non si legge niente, ma non e' una lettura riuscita:
  // segnarla tale bloccherebbe ogni tentativo dopo il login.
  if (!currentAziendaId) { allegatiCache = []; return allegatiCache }

  var COLONNE_BASE = 'id, tabella_origine, id_origine, tipo, path, nome_file, dimensione, created_at'
  // FASE 22 — le quattro colonne della polizza QR: senza, la stampa non
  // saprebbe ne' dove sta l'immagine ne' quanto misura.
  var COLONNE_POLIZZA = COLONNE_BASE + ', img_path, img_larghezza_mm, img_altezza_mm, pagina_origine'

  async function leggi(colonne) {
    return await sb.from('tm_conta_allegati')
      .select(colonne)
      .eq('azienda_id', currentAziendaId)
      .order('created_at', { ascending: true })
  }

  var r = await leggi(COLONNE_POLIZZA)
  if (r.error) {
    // SQL_FASE22 non ancora lanciato: le colonne non esistono. Gli allegati
    // devono continuare a funzionare come prima — a non poter caricare una
    // polizza si sopravvive, a perdere l'elenco dei giustificativi no.
    // La bandierina dice al riquadro della polizza di spiegarlo invece di
    // dare un errore incomprensibile.
    console.warn('Allegati senza le colonne della FASE 22:', r.error.message || r.error)
    sqlFase22Mancante = true
    r = await leggi(COLONNE_BASE)
  } else {
    sqlFase22Mancante = false
  }
  if (r.error) throw r.error
  allegatiCache = r.data || []
  segnaCacheOk('allegati')
  return allegatiCache
}

// Vero quando le colonne della polizza QR non ci sono ancora: SQL_FASE22.sql
// non e' stato lanciato.
var sqlFase22Mancante = false

function invalidaCacheAllegati() { scadeCache('allegati') }

function allegatiDi(tabella, id) {
  if (!id) return []
  return (allegatiCache || []).filter(function (a) {
    return a.tabella_origine === tabella && a.id_origine === id
  })
}

function contaAllegati(tabella, id) { return allegatiDi(tabella, id).length }

// La spia negli elenchi: il NUMERO, non un generico «Allegato». Sapere che ce
// ne sono tre senza aprire la scheda e' il punto di tutta la fase.
function badgeAllegati(tabella, id, bannerId) {
  var n = contaAllegati(tabella, id)
  // Il caso «nessuno» e' quello che conta: e' il giustificativo mancante, e
  // deve vedersi. In grigio, perche' non e' un errore — e' una cosa da fare.
  if (!n) return '<span class="alleg-nessuno">⚠️ Nessun allegato</span>'
  var primo = allegatiDi(tabella, id)[0]
  return '<button class="icon-btn" title="' + (n === 1 ? 'Apri l allegato' : 'Apri il primo dei ' + n + ' allegati') +
    '" onclick="event.stopPropagation(); openAllegato(\'' + esc(primo.path) + '\', \'' + esc(bannerId || '') + '\')">📎 ' +
    n + (n === 1 ? ' allegato' : ' allegati') + '</button>'
}

// ── Il riquadro nella scheda ────────────────────────────────────────────────
function boxAllegatiHtml(tabella, id, nome) {
  var lista = allegatiDi(tabella, id)
  var argomenti = "'" + esc(tabella) + "', '" + esc(id) + "', '" +
                  esc(String(nome || '').replace(/'/g, '')) + "'"

  var righe = lista.length
    ? lista.map(function (a) {
        var t = etichettaTipoAllegato(a.tipo)
        // FASE 22 — la polizza QR non si sceglie da questa tendina, e non si
        // puo' nemmeno diventare: porta con se' l'immagine per la stampa, che
        // un cambio di tipo non creerebbe. Si mostra come etichetta ferma, e
        // si gestisce dal suo riquadro.
        var sel = a.tipo === 'polizza_qr'
          ? '<span class="alleg-tipo-fisso" title="Si gestisce dal riquadro «Polizza QR della banca»">' +
              t.ic + ' ' + esc(t.et) + '</span>'
          // Il tipo si puo' cambiare dopo: capita di caricare una bolla e
          // accorgersi solo dopo di averla segnata come fattura.
          : '<select class="alleg-tipo" title="Tipo di documento" ' +
            'onchange="cambiaTipoAllegato(\'' + esc(a.id) + '\', this.value, ' + argomenti + ')">' +
            TIPI_ALLEGATO.filter(function (x) { return x.v !== 'polizza_qr' }).map(function (x) {
              return '<option value="' + x.v + '"' + (x.v === a.tipo ? ' selected' : '') + '>' +
                     x.ic + ' ' + x.et + '</option>'
            }).join('') + '</select>'
        return '<div class="alleg-riga">' +
          sel +
          '<span class="alleg-nome" title="' + esc(a.path) + '">' +
            esc(a.nome_file || allegatoNomeFile(a.path)) + '</span>' +
          '<span class="alleg-azioni">' +
            '<button type="button" class="icon-btn" onclick="openAllegato(\'' + esc(a.path) +
              '\', \'' + esc(bannerAllegatiDi(tabella)) + '\')">📎 Apri</button>' +
            '<button type="button" class="icon-btn danger" onclick="eliminaAllegato(\'' + esc(a.id) +
              '\', ' + argomenti + ')">🗑️ Elimina</button>' +
          '</span>' +
        '</div>'
      }).join('')
    : '<div class="cru-vuoto">Nessun allegato.</div>'

  return '<div class="card">' +
    '<div class="card-title">📎 Allegati' + (lista.length ? ' (' + lista.length + ')' : '') + '</div>' +
    righe +
    '<div class="form-actions" style="margin-top:12px">' +
      '<button type="button" class="btn-secondary" onclick="apriAggiungiAllegato(' + argomenti + ')">' +
        '➕ Aggiungi allegato</button>' +
    '</div>' +
  '</div>'
}

// Dove finiscono gli avvisi, a seconda della schermata da cui si guarda.
function bannerAllegatiDi(tabella) {
  if (tabella === 'tm_conta_fatture') return 'fatture-allegato-banner'
  if (tabella === 'tm_conta_fatture_acquisto') return 'acquisti-detail-banner'
  return 'inserimento-banner'
}

async function aggiornaBoxAllegati(tabella, id, idContenitore, nome) {
  try {
    await loadAllegati(true)
    html(idContenitore, boxAllegatiHtml(tabella, id, nome))
  } catch (e) {
    html(idContenitore, '<div class="card"><div class="card-title">📎 Allegati</div>' +
      '<div class="cru-vuoto">Allegati non leggibili: ' + esc(e.message || e) + '</div></div>')
  }
}

// ── La finestra «Aggiungi allegato» ─────────────────────────────────────────
var docAllegatoCorrente = null

function apriAggiungiAllegato(tabella, id, nome, tipoProposto) {
  docAllegatoCorrente = { tabella: tabella, id: id, nome: nome || '' }
  var inp = el('alleg-file'); if (inp) inp.value = ''
  setVal('alleg-tipo', tipoProposto || 'fattura')
  html('alleg-banner', '')
  html('alleg-riepilogo',
    '<div class="cls-sum-title">' + esc(nome || 'Documento') + '</div>' +
    '<div class="cls-sum-meta"><span>Massimo ' + LIMITE_ALLEGATO_MB + ' MB per file</span></div>')
  var ov = el('allegato-overlay')
  if (ov) ov.style.display = 'flex'
  registraAperturaModale('allegato-overlay')
}

function chiudiAggiungiAllegato() {
  var ov = el('allegato-overlay')
  if (ov) ov.style.display = 'none'
  docAllegatoCorrente = null
}

async function salvaAllegato() {
  if (!docAllegatoCorrente) return
  var d = docAllegatoCorrente
  var btn = el('alleg-salva-btn')
  var inp = el('alleg-file')
  var file = (inp && inp.files && inp.files.length) ? inp.files[0] : null
  try {
    if (!file) throw new Error('Scegli un file da allegare.')
    // Il limite si controlla PRIMA di caricare: mandare 40 MB per sentirsi dire
    // di no dopo due minuti di attesa e' il modo peggiore di dirlo.
    var mb = file.size / (1024 * 1024)
    if (mb > LIMITE_ALLEGATO_MB) {
      throw new Error('Il file pesa ' + fmtNumIt(mb) + ' MB, oltre il limite di ' +
        LIMITE_ALLEGATO_MB + ' MB. Riducilo o caricalo diviso.')
    }
    var tipo = getVal('alleg-tipo') || 'altro'

    if (btn) { btn.disabled = true; btn.textContent = '⏳ Caricamento…' }

    var path = await uploadAllegato(file)     // stesso bucket e stesso formato di sempre
    const { error } = await sb.from('tm_conta_allegati').insert({
      azienda_id: currentAziendaId,
      tabella_origine: d.tabella,
      id_origine: d.id,
      tipo: tipo,
      path: path,
      nome_file: file.name,
      dimensione: file.size,
      created_by: currentUser ? currentUser.id : null
    }).select()
    if (error) {
      // Il file e' gia' nello Storage ma la riga no: senza questo rimarrebbe
      // un file che nessuno puo' piu' raggiungere.
      try { await deleteAllegatoStorage(path) } catch (_) {}
      throw error
    }

    invalidaCacheAllegati()
    exportDataset = null                       // il pacchetto deve rileggere
    chiudiAggiungiAllegato()
    await ricaricaDopoAllegato(d)
  } catch (e) {
    html('alleg-banner', '<div class="fase-banner err"><span class="icon" aria-hidden="true">❌</span>' +
      '<div class="msg">' + esc(e.message || e) + '</div></div>')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Allega' }
  }
}

// Cambiare il tipo dopo: una UPDATE sola, nessun file toccato.
async function cambiaTipoAllegato(idAllegato, tipo, tabella, id, nome) {
  try {
    const { error } = await sb.from('tm_conta_allegati')
      .update({ tipo: tipo }).eq('id', idAllegato).eq('azienda_id', currentAziendaId).select()
    if (error) throw error
    invalidaCacheAllegati()
    exportDataset = null
    await ricaricaDopoAllegato({ tabella: tabella, id: id, nome: nome })
  } catch (e) {
    avvisoAllegato(bannerAllegatiDi(tabella), 'err', 'Tipo non cambiato: ' + (e.message || e))
  }
}

// Eliminare cancella ANCHE il file dallo Storage: senza, lo Storage si
// riempirebbe di file che nessuna riga nomina piu' e che nessuno sa cosa siano.
// La conferma lo dice, perche' non si torna indietro.
async function eliminaAllegato(idAllegato, tabella, id, nome) {
  var a = (allegatiCache || []).filter(function (x) { return x.id === idAllegato })[0]
  if (!a) return
  var etichetta = a.nome_file || allegatoNomeFile(a.path)
  if (!window.confirm('Eliminare l\'allegato «' + etichetta + '»?\n\n' +
      'Il file viene cancellato dallo storage: non si può annullare.')) return
  try {
    // Prima la riga, poi il file: se il file non si cancella resta un file
    // orfano, fastidioso ma innocuo. Al contrario resterebbe una riga che
    // punta al vuoto, e l'elenco mostrerebbe un allegato che non si apre.
    const { error } = await sb.from('tm_conta_allegati')
      .delete().eq('id', idAllegato).eq('azienda_id', currentAziendaId).select()
    if (error) throw error
    try {
      await deleteAllegatoStorage(a.path)
      // FASE 22 — la polizza QR ha due file: l'originale e l'immagine per la
      // stampa. Cancellandone uno solo l'altro resterebbe nel bucket senza
      // che niente lo nomini piu'.
      if (a.img_path) await deleteAllegatoStorage(a.img_path)
    } catch (eFile) {
      console.warn('File non cancellato dallo storage:', eFile.message || eFile, a.path)
      avvisoAllegato(bannerAllegatiDi(tabella), 'warn',
        'Allegato tolto dal documento, ma il file è rimasto nello storage: ' + (eFile.message || eFile))
    }
    invalidaCacheAllegati()
    exportDataset = null
    await ricaricaDopoAllegato({ tabella: tabella, id: id, nome: nome })
    // Se era la polizza, anche il suo riquadro e il foglio di stampa devono
    // accorgersene: altrimenti la fattura continuerebbe a mostrare una pagina
    // in coda che non c'e' piu'.
    if (a.tipo === 'polizza_qr' && tabella === 'tm_conta_fatture') {
      await disegnaBoxPolizza(id)
      await ridisegnaStampaFattura(id)
    }
  } catch (e) {
    avvisoAllegato(bannerAllegatiDi(tabella), 'err', 'Allegato non eliminato: ' + (e.message || e))
  }
}

// Ridisegna quello che mostra gli allegati, senza ricaricare la schermata.
async function ricaricaDopoAllegato(d) {
  try {
    await loadAllegati(true)
    if (d.tabella === 'tm_conta_fatture') {
      if (el('fatture-allegati')) html('fatture-allegati', boxAllegatiHtml(d.tabella, d.id, d.nome))
      await loadFattureList()
    } else if (d.tabella === 'tm_conta_fatture_acquisto') {
      if (el('acquisti-allegati')) html('acquisti-allegati', boxAllegatiHtml(d.tabella, d.id, d.nome))
      await loadAcquistiList()
    } else {
      if (currentPage === 'inserimento') await loadRecentiInseriti()
    }
  } catch (e) { console.warn('Ricarica dopo allegato:', e.message || e) }
}


// ══════════════════════════════════════════════════════════════════════════════
// FASE 22 / P7 — LA POLIZZA QR DELLA BANCA, IN CODA ALLA FATTURA
//
// IL PROGRAMMA NON GENERA IL CODICE QR, E NON DEVE.
// La polizza la fa la banca di Umberto, gratis e valida, e lui la scarica in
// PDF a ogni fattura. Rifarla qui vorrebbe dire riscrivere una cosa gia' fatta
// bene, col rischio che una polizza sbagliata venga rifiutata dalla banca o
// faccia pagare male il cliente. La generazione automatica e' una fase futura,
// per quando TimberMaster sara' un prodotto per chi il conto di Umberto non ce
// l'ha.
//
// Quello che serve adesso e' molto piu' semplice: la polizza della banca si
// allega alla fattura e si stampa insieme a lei. Un documento solo, un file
// solo da spedire.
//
// LA SCELTA CHE REGGE TUTTO: SI CONVERTE UNA VOLTA, AL CARICAMENTO.
// Il PDF diventa un'immagine a 300 dpi nel momento in cui Umberto lo carica, e
// l'immagine si salva accanto all'originale (che non si butta). Da li' in poi
// la stampa e' banale: una figura di misure fisse, come una foto. Non si
// renderizza al momento di stampare — proprio quando serve non si vuole
// dipendere da una libreria che arriva da internet.
//
// PERCHE' 300 DPI: e' l'errore piu' probabile di tutta questa fase. Un QR
// sgranato sembra giusto a schermo e poi il telefono non lo legge. 300 dpi
// significa scale = 300/72 sul canvas di pdf.js.
//
// PERCHE' NON SI RITAGLIA E NON SI RIDIMENSIONA: la polizza ha misure standard
// e fisse, e il testo stampato accanto al codice fa parte della polizza. Una
// polizza scalata anche di poco non e' piu' conforme. Si posiziona e basta.
// ══════════════════════════════════════════════════════════════════════════════

// pdf.js 3.11.174: e' l'ultima serie che cdnjs pubblica ancora in UMD (un
// <script> normale, con un global). Dalla 4 in poi ci sono solo moduli ES,
// che questa pagina non carica.
var PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/'
var TIMEOUT_PDFJS_MS = 20000
var DPI_POLIZZA = 300
var POLIZZA_MM_L = 210      // misure standard della polizza svizzera:
var POLIZZA_MM_H = 105      // 210 x 105 mm, la fascia in fondo all'A4

// Si scarica solo quando serve, come JSZip: sono quasi due megabyte, e chi non
// carica mai una polizza non deve pagarli a ogni apertura del programma.
// A differenza di caricaJSZip, qui c'e' un tempo massimo: un CDN che accetta
// la connessione e poi non risponde lascerebbe la Promise appesa per sempre, e
// il bottone girerebbe all'infinito.
function caricaPdfJs() {
  return new Promise(function (risolvi, rifiuta) {
    if (window.pdfjsLib) { risolvi(window.pdfjsLib); return }
    var finito = false
    var orologio = setTimeout(function () {
      if (finito) return
      finito = true
      rifiuta(new Error('La libreria per leggere i PDF non risponde. Controlla il collegamento a internet.'))
    }, TIMEOUT_PDFJS_MS)

    var s = document.createElement('script')
    s.src = PDFJS_BASE + 'pdf.min.js'
    s.onload = function () {
      if (finito) return
      finito = true; clearTimeout(orologio)
      if (!window.pdfjsLib) { rifiuta(new Error('Libreria PDF caricata ma non disponibile.')); return }
      // Il worker deve essere della STESSA versione: pdf.js si rifiuta di
      // partire se le due non combaciano.
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js'
      risolvi(window.pdfjsLib)
    }
    s.onerror = function () {
      if (finito) return
      finito = true; clearTimeout(orologio)
      rifiuta(new Error('Non riesco a scaricare la libreria per leggere i PDF. Serve internet.'))
    }
    document.head.appendChild(s)
  })
}

// I punti tipografici del PDF (72 per pollice) in millimetri.
function puntiInMm(pt) { return pt * 25.4 / 72 }

// La polizza QR di una fattura, se c'e'.
function polizzaDi(idFattura) {
  return allegatiDi('tm_conta_fatture', idFattura).filter(function (a) {
    return a.tipo === 'polizza_qr'
  })[0] || null
}

// ── Quale pagina del PDF ────────────────────────────────────────────────────
// Il PDF della banca a volte e' un A4 con la polizza in fondo, a volte la sola
// fascia di pagamento, a volte una lettera di due pagine con la polizza in
// coda. Si cerca la pagina che contiene le parole della polizza — nelle tre
// lingue, perche' la banca puo' emetterla in tedesco o francese. Se non si
// trova, si prende l'ultima: e' li' che la polizza sta quasi sempre.
var PAROLE_POLIZZA = [
  'sezione pagamento', 'zahlteil', 'section paiement', 'payment part',
  'ricevuta', 'empfangsschein', 'récépissé', 'recepisse', 'receipt'
]

async function scegliPaginaPolizza(pdf) {
  if (pdf.numPages === 1) return 1
  for (var n = 1; n <= pdf.numPages; n++) {
    try {
      var pagina = await pdf.getPage(n)
      var testo = await pagina.getTextContent()
      var s = testo.items.map(function (i) { return i.str }).join(' ').toLowerCase()
      for (var k = 0; k < PAROLE_POLIZZA.length; k++) {
        if (s.indexOf(PAROLE_POLIZZA[k]) !== -1) return n
      }
    } catch (_) { /* pagina illeggibile: si prova la prossima */ }
  }
  return pdf.numPages
}

// ── L'IBAN scritto sulla polizza ────────────────────────────────────────────
// Non si corregge NIENTE da soli: si legge, si confronta e si avvisa. Umberto
// ha piu' di un conto, e una polizza su un conto diverso da quello stampato
// sulla fattura fa leggere al cliente due numeri diversi sullo stesso foglio.
function ibanNudo(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '') }

function trovaIbanNelTesto(testo) {
  // Solo CH e LI: sono gli unici conti su cui una polizza QR svizzera puo'
  // essere emessa, e cercare qualunque IBAN prenderebbe anche quello del
  // cliente se comparisse.
  //
  // 21 caratteri: CH + 2 cifre di controllo + 5 dell'istituto + 12 del conto.
  // Gli ultimi 17 NON sono solo cifre — il conto puo' contenere lettere, e
  // proprio quelli di Umberto finiscono con una lettera
  // (…0001 N, …0002 X). Con \d{19} non si trovavano.
  var m = ibanNudo(testo).match(/(?:CH|LI)\d{2}[A-Z0-9]{17}/)
  return m ? m[0] : null
}

async function leggiIbanDallaPagina(pagina) {
  try {
    var testo = await pagina.getTextContent()
    return trovaIbanNelTesto(testo.items.map(function (i) { return i.str }).join(' '))
  } catch (_) { return null }
}

// ── Il caricamento ──────────────────────────────────────────────────────────

var polizzaFatturaCorrente = null   // {id, numero} della fattura su cui si sta lavorando

function bannerPolizza(tipo, msg) { showFattureBanner('polizza-banner', tipo, msg) }

async function caricaPolizzaQr(input) {
  var file = input && input.files && input.files[0]
  if (!file) return
  var f = polizzaFatturaCorrente
  if (!f) { bannerPolizza('err', 'Apri prima una fattura.'); return }
  if (sqlFase22Mancante) {
    bannerPolizza('err', 'Prima serve la migrazione: lancia SQL_FASE22.sql dal SQL Editor ' +
      'di Supabase, poi ricarica la pagina. Fino ad allora la polizza non si può allegare.')
    input.value = ''
    return
  }

  var btn = el('polizza-carica-btn')
  if (btn) { btn.disabled = true }
  html('polizza-anteprima', '')
  bannerPolizza('warn', '⏳ Preparo la polizza per la stampa…')

  try {
    var mb = file.size / (1024 * 1024)
    if (mb > LIMITE_ALLEGATO_MB) {
      throw new Error('Il file pesa ' + fmtNumIt(mb) + ' MB, oltre il limite di ' +
                      LIMITE_ALLEGATO_MB + ' MB.')
    }
    var nome = String(file.name || '').toLowerCase()
    var ePdf = nome.slice(-4) === '.pdf' || file.type === 'application/pdf'
    var eImmagine = /\.(png|jpe?g)$/.test(nome) || /^image\/(png|jpeg)$/.test(file.type)
    if (!ePdf && !eImmagine) {
      throw new Error('La polizza dev’essere un PDF, oppure un’immagine PNG o JPG.')
    }

    var preparata = ePdf ? await polizzaDaPdf(file) : await polizzaDaImmagine(file)

    // Una sola polizza per fattura: la precedente se ne va prima, riga e file.
    await togliPolizzaSilenziosa(f.id)

    // Due file: l'originale (che non si butta) e l'immagine per la stampa.
    var pathOriginale = await uploadAllegato(file)
    var pathImmagine
    try {
      pathImmagine = await uploadAllegato(preparata.file)
    } catch (eImg) {
      try { await deleteAllegatoStorage(pathOriginale) } catch (_) {}
      throw eImg
    }

    const { error } = await sb.from('tm_conta_allegati').insert({
      azienda_id: currentAziendaId,
      tabella_origine: 'tm_conta_fatture',
      id_origine: f.id,
      tipo: 'polizza_qr',
      path: pathOriginale,
      nome_file: file.name,
      dimensione: file.size,
      img_path: pathImmagine,
      img_larghezza_mm: preparata.larghezzaMm,
      img_altezza_mm: preparata.altezzaMm,
      pagina_origine: preparata.pagina || null,
      created_by: currentUser ? currentUser.id : null
    }).select()
    if (error) {
      // I file sono saliti ma la riga no: si tolgono, altrimenti restano nello
      // Storage senza che niente li nomini.
      try { await deleteAllegatoStorage(pathOriginale) } catch (_) {}
      try { await deleteAllegatoStorage(pathImmagine) } catch (_) {}
      throw error
    }

    invalidaCacheAllegati()
    exportDataset = null
    await loadAllegati(true)
    await disegnaBoxPolizza(f.id)
    await aggiornaBoxAllegati('tm_conta_fatture', f.id, 'fatture-allegati', 'Fattura ' + (f.numero || ''))
    // La fattura stampata cambia: la nota «allegata a parte» deve sparire e la
    // pagina in coda deve comparire.
    await ridisegnaStampaFattura(f.id)

    bannerPolizza('ok', messaggioEsitoPolizza(preparata, f))
  } catch (e) {
    console.error('Polizza QR:', e)
    bannerPolizza('err', 'Polizza non allegata: ' + (e.message || e) +
      ' — la fattura resta com’era e si stampa lo stesso, senza polizza.')
  } finally {
    if (btn) btn.disabled = false
    if (input) input.value = ''
  }
}

// Il riepilogo di cosa e' stato preso, IBAN compreso.
function messaggioEsitoPolizza(p, f) {
  var parti = ['Polizza allegata']
  if (p.pagina) parti.push('presa dalla pagina ' + p.pagina + ' del PDF')
  parti.push('stampata a ' + Math.round(p.larghezzaMm) + ' × ' +
             Math.round(p.altezzaMm) + ' mm, a grandezza reale')
  var msg = parti.join(', ') + '. Guarda l’anteprima qui sotto: se il codice è sgranato o è il ' +
            'file sbagliato, ricaricane un altro adesso.'

  var ibanFattura = ibanNudo(f.iban || (aziendaInfo || {}).iban)
  if (p.iban) {
    if (ibanFattura && ibanNudo(p.iban) !== ibanFattura) {
      msg += ' ⚠️ ATTENZIONE: la polizza è sul conto ' + p.iban + ', ma sulla fattura è ' +
             'stampato ' + (f.iban || (aziendaInfo || {}).iban) + '. Sono due conti diversi: ' +
             'il cliente leggerebbe due numeri sullo stesso documento. Controlla quale dei due è ' +
             'quello giusto — non correggo niente da solo.'
    } else {
      msg += ' Il conto della polizza è lo stesso stampato sulla fattura.'
    }
  } else {
    msg += ' ⚠️ Non sono riuscito a leggere l’IBAN dalla polizza: controlla tu che sia il conto ' +
           'giusto. Sulla fattura è stampato ' +
           (f.iban || (aziendaInfo || {}).iban || '(nessun IBAN)') + '.'
  }
  return msg
}

// ── Da PDF a immagine, una volta sola ───────────────────────────────────────
async function polizzaDaPdf(file) {
  var pdfjs = await caricaPdfJs()
  var dati = new Uint8Array(await file.arrayBuffer())
  var pdf = await pdfjs.getDocument({ data: dati }).promise

  var numero = await scegliPaginaPolizza(pdf)
  var pagina = await pdf.getPage(numero)
  var iban = await leggiIbanDallaPagina(pagina)

  // scale 1 = 72 dpi. Le misure in millimetri si prendono da qui, prima di
  // ingrandire: sono quelle vere della pagina, ed e' a quelle che si stampa.
  var naturale = pagina.getViewport({ scale: 1 })
  var larghezzaMm = puntiInMm(naturale.width)
  var altezzaMm   = puntiInMm(naturale.height)

  var vista = pagina.getViewport({ scale: DPI_POLIZZA / 72 })
  var canvas = document.createElement('canvas')
  canvas.width  = Math.round(vista.width)
  canvas.height = Math.round(vista.height)
  var ctx = canvas.getContext('2d')
  // Fondo bianco: un PDF senza fondo diventerebbe un PNG trasparente, e in
  // stampa il nero del QR su trasparente puo' uscire grigio.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await pagina.render({ canvasContext: ctx, viewport: vista }).promise

  var blob = await canvasInPng(canvas)
  return {
    file: new File([blob], 'polizza_qr_stampa.png', { type: 'image/png' }),
    larghezzaMm: larghezzaMm,
    altezzaMm: altezzaMm,
    pagina: numero,
    pagineTotali: pdf.numPages,
    iban: iban
  }
}

// Un'immagine si prende com'e'. Le misure in millimetri non si possono
// ricavare dai pixel — un PNG non sa a che dimensione va stampato — quindi si
// assumono quelle standard della polizza svizzera, e lo si scrive.
async function polizzaDaImmagine(file) {
  return {
    file: file,
    larghezzaMm: POLIZZA_MM_L,
    altezzaMm: POLIZZA_MM_H,
    pagina: null,
    iban: null
  }
}

// PNG e non JPEG: il QR e' tratto in bianco e nero, e il JPEG lo sporca di
// aloni proprio sui bordi dei quadratini.
function canvasInPng(canvas) {
  return new Promise(function (risolvi, rifiuta) {
    if (canvas.toBlob) {
      canvas.toBlob(function (b) {
        if (b) risolvi(b); else rifiuta(new Error('Non riesco a creare l’immagine della polizza.'))
      }, 'image/png')
    } else {
      rifiuta(new Error('Questo browser non sa creare l’immagine della polizza.'))
    }
  })
}

// ── Togliere la polizza ─────────────────────────────────────────────────────

// Senza domande e senza avvisi: e' il passo interno di una sostituzione.
async function togliPolizzaSilenziosa(idFattura) {
  var vecchia = polizzaDi(idFattura)
  if (!vecchia) return
  const { error } = await sb.from('tm_conta_allegati')
    .delete().eq('id', vecchia.id).eq('azienda_id', currentAziendaId).select()
  if (error) throw error
  try { await deleteAllegatoStorage(vecchia.path) } catch (_) {}
  if (vecchia.img_path) { try { await deleteAllegatoStorage(vecchia.img_path) } catch (_) {} }
  invalidaCacheAllegati()
}

async function togliPolizza(idFattura, numero) {
  if (!window.confirm('Togliere la polizza QR da questa fattura?\n\n' +
      'I file vengono cancellati dallo storage: non si può annullare. ' +
      'La fattura si stamperà come prima, con la nota «Polizza QR allegata a parte».')) return
  var btn = el('polizza-togli-btn')
  if (btn) btn.disabled = true
  try {
    await togliPolizzaSilenziosa(idFattura)
    exportDataset = null
    await loadAllegati(true)
    await disegnaBoxPolizza(idFattura)
    await aggiornaBoxAllegati('tm_conta_fatture', idFattura, 'fatture-allegati', 'Fattura ' + (numero || ''))
    await ridisegnaStampaFattura(idFattura)
    bannerPolizza('ok', 'Polizza tolta.')
  } catch (e) {
    console.error('Rimozione polizza:', e)
    bannerPolizza('err', 'Polizza non tolta: ' + (e.message || e))
  } finally {
    if (btn) btn.disabled = false
  }
}

// ── Il riquadro sulla fattura ───────────────────────────────────────────────

async function disegnaBoxPolizza(idFattura) {
  var cont = el('fatture-polizza')
  if (!cont) return
  var f = (currentDetailFattura && currentDetailFattura.id === idFattura) ? currentDetailFattura : null
  polizzaFatturaCorrente = f ? { id: f.id, numero: f.numero, iban: f.iban } : { id: idFattura, numero: '', iban: null }

  // Sulle note di credito la polizza non ha senso: non si incassa niente.
  if (f && f.tipo === 'nota_credito') { html(cont.id, ''); return }

  var p = polizzaDi(idFattura)
  var corpo

  if (sqlFase22Mancante) {
    corpo = '<div class="fase-banner warn"><span class="icon" aria-hidden="true">⚠️</span>' +
      '<div class="msg">Per allegare la polizza serve prima la migrazione ' +
      '<code>SQL_FASE22.sql</code>, da lanciare una volta sola dal SQL Editor di Supabase. ' +
      'Tutto il resto del programma funziona lo stesso.</div></div>'
  } else if (p) {
    corpo =
      '<div class="polizza-riga">' +
        '<span class="polizza-et">🏦 Polizza allegata</span>' +
        '<span class="alleg-nome" title="' + esc(p.path) + '">' +
          esc(p.nome_file || allegatoNomeFile(p.path)) + '</span>' +
        '<span class="alleg-azioni">' +
          '<button type="button" class="icon-btn" onclick="openAllegato(\'' + esc(p.path) +
            '\', \'polizza-banner\')">📎 Apri l’originale</button>' +
          '<button type="button" class="icon-btn danger" id="polizza-togli-btn" ' +
            'onclick="togliPolizza(\'' + esc(idFattura) + '\', \'' +
              esc((polizzaFatturaCorrente && polizzaFatturaCorrente.numero) || '') + '\')">' +
            '🗑️ Togli la polizza</button>' +
        '</span>' +
      '</div>' +
      '<div class="form-hint">' +
        'Si stampa in coda alla fattura, su una pagina sua, a grandezza reale (' +
        Math.round(safeNum(p.img_larghezza_mm) || POLIZZA_MM_L) + ' × ' +
        Math.round(safeNum(p.img_altezza_mm) || POLIZZA_MM_H) + ' mm' +
        (p.pagina_origine ? ', dalla pagina ' + p.pagina_origine + ' del PDF' : '') + ').' +
        ' Per sostituirla, caricane un&#8217;altra: la vecchia se ne va da sola.' +
      '</div>' +
      '<div id="polizza-anteprima" class="polizza-anteprima"></div>'
  } else {
    corpo = '<div class="form-hint" style="margin-top:0">' +
      'Carica qui la polizza che ti manda la banca. Viene stampata in coda alla fattura, ' +
      'su una pagina sua e a grandezza reale, così spedisci un documento solo. ' +
      'Senza polizza la fattura si stampa come sempre.</div>'
  }

  html(cont.id,
    '<div class="card no-print">' +
      '<div class="card-title">🏦 Polizza QR della banca</div>' +
      '<div id="polizza-banner" role="status" aria-live="polite"></div>' +
      corpo +
      (sqlFase22Mancante ? '' :
        '<div class="form-group" style="margin-top:12px">' +
          '<label for="polizza-file" class="form-label">' +
            (p ? 'Sostituisci la polizza' : 'Polizza (PDF, oppure PNG/JPG)') + '</label>' +
          '<input type="file" id="polizza-file" class="form-input-file" ' +
            'accept=".pdf,.png,.jpg,.jpeg" onchange="caricaPolizzaQr(this)" />' +
          '<div class="form-hint">Massimo ' + LIMITE_ALLEGATO_MB + ' MB. ' +
            'Il PDF viene convertito in immagine a ' + DPI_POLIZZA + ' dpi una volta sola, ' +
            'adesso: l’originale resta archiviato con la fattura.</div>' +
        '</div>') +
    '</div>')

  if (p) await mostraAnteprimaPolizza(p)
}

// L'anteprima e' quello che verra' stampato, non il PDF originale: se e'
// sgranata o e' il file sbagliato si vede qui, non dopo aver spedito.
async function mostraAnteprimaPolizza(p) {
  var cont = el('polizza-anteprima')
  if (!cont || !p.img_path) return
  try {
    var url = await urlFirmato(p.img_path)
    html('polizza-anteprima',
      '<div class="form-label" style="margin-bottom:6px">Anteprima di quello che verrà stampato</div>' +
      '<img src="' + esc(url) + '" alt="Anteprima della polizza QR" class="polizza-img">')
  } catch (e) {
    html('polizza-anteprima',
      '<div class="form-hint">Anteprima non disponibile (' + esc(e.message || e) +
      '). La polizza resta allegata.</div>')
  }
}

// Il link temporaneo a un file del bucket privato. Un'ora basta: serve solo a
// mostrarlo e a stamparlo adesso.
async function urlFirmato(path) {
  const { data, error } = await sb.storage.from(STORAGE_BUCKET).createSignedUrl(path, 3600)
  if (error) throw error
  if (!data || !data.signedUrl) throw new Error('Il server non ha restituito un link firmato.')
  return data.signedUrl
}

// Rifa' il foglio di stampa della fattura aperta: la nota «allegata a parte» e
// la pagina della polizza dipendono da quello che e' appena cambiato.
async function ridisegnaStampaFattura(idFattura) {
  try {
    if (!currentDetailFattura || currentDetailFattura.id !== idFattura) return
    if (!righeDetailCorrenti) return
    renderFatturaPrint(currentDetailFattura, righeDetailCorrenti, rifInfoCorrente)
    await preparaPolizzaPerStampa(idFattura)
  } catch (e) { console.warn('Ridisegno stampa:', e.message || e) }
}

// ── La stampa ───────────────────────────────────────────────────────────────
//
// L'immagine si carica PRIMA di window.print(): un <img> ancora vuoto stampa
// una pagina bianca, e nessuno se ne accorge finche' la busta non e' spedita.
// Se non si carica, la fattura esce come sempre e un banner lo dice: il
// programma non deve mai restare bloccato per colpa della polizza.
async function preparaPolizzaPerStampa(idFattura) {
  var posto = el('fatture-qrpage')
  if (!posto) return false
  var p = polizzaDi(idFattura)
  if (!p || !p.img_path) { posto.innerHTML = ''; return false }

  var l = safeNum(p.img_larghezza_mm) || POLIZZA_MM_L
  var h = safeNum(p.img_altezza_mm) || POLIZZA_MM_H
  try {
    var url = await urlFirmato(p.img_path)
    await new Promise(function (risolvi, rifiuta) {
      var img = new Image()
      img.onload = function () { risolvi() }
      img.onerror = function () { rifiuta(new Error('immagine non caricata')) }
      img.src = url
    })
    posto.innerHTML =
      '<div class="inv-qrpage">' +
        '<img class="inv-qrimg" src="' + esc(url) + '" alt="Polizza QR" ' +
             'style="width:' + l + 'mm;height:' + h + 'mm">' +
      '</div>'
    return true
  } catch (e) {
    console.warn('Polizza non pronta per la stampa:', e.message || e)
    posto.innerHTML = ''
    showFattureBanner('fatture-detail-banner', 'warn',
      'La polizza allegata non si è caricata: la fattura si stampa senza. ' +
      'Riprova fra un momento o controlla il collegamento.')
    return false
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// FASE 9B — L'AVVISO SUL DOPPIONE
//
// L'errore vero non e' registrare due volte la stessa fattura: e' PAGARLA due
// volte. Per questo il controllo dev'essere CERTO, mai probabilistico.
//
// Si confrontano due cose sole: fornitore (senza maiuscole e spazi doppi) e
// numero della fattura del fornitore. Nient'altro. Niente importi vicini,
// niente descrizioni simili, niente date vicine: con sei fatture di storico
// darebbero falsi allarmi, e un avviso che sbaglia spesso si impara a
// scacciare senza leggerlo — a quel punto non protegge piu' da niente.
//
// Se il numero manca, NESSUN controllo: senza numero non si puo' dire niente
// di certo, e un dubbio non e' un avviso.
//
// E non blocca MAI il salvataggio: due documenti con lo stesso numero
// esistono davvero (nota di credito, rifatturazione).
// ══════════════════════════════════════════════════════════════════════════════

function normalizzaFornitore(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function normalizzaNumeroFattura(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '').trim()
}

// La chiave del confronto. null = non confrontabile (numero vuoto).
function chiaveDoppione(fornitore, numero) {
  var n = normalizzaNumeroFattura(numero)
  var f = normalizzaFornitore(fornitore)
  if (!n || !f) return null
  return f + '|' + n
}

// ── La spia nell'elenco ─────────────────────────────────────────────────────
// Si costruisce da una query sua, non dalle righe che l'elenco ha in memoria:
// un controllo che cambia risposta a seconda della pagina che stai guardando
// non e' un controllo. Sono tre colonne su una tabella piccola.
var chiaviDoppioni = {}      // chiave -> [ {id, numero_fornitore, fornitore, data, importo} ]
var chiaviCaricate = false

async function caricaChiaviDoppioni(force) {
  if (chiaviCaricate && !force) return chiaviDoppioni
  chiaviDoppioni = {}
  if (!currentAziendaId) return chiaviDoppioni
  const { data, error } = await sb.from('tm_conta_fatture_acquisto')
    .select('id, fornitore, numero_fornitore, data, importo, valuta')
    .eq('azienda_id', currentAziendaId)
    .not('numero_fornitore', 'is', null)
  if (error) throw error
  ;(data || []).forEach(function (r) {
    var k = chiaveDoppione(r.fornitore, r.numero_fornitore)
    if (!k) return
    if (!chiaviDoppioni[k]) chiaviDoppioni[k] = []
    chiaviDoppioni[k].push(r)
  })
  chiaviCaricate = true
  return chiaviDoppioni
}

function invalidaChiaviDoppioni() { chiaviCaricate = false }

// Gli altri documenti che condividono fornitore + numero con questo.
function doppioniDi(fornitore, numero, escludiId) {
  var k = chiaveDoppione(fornitore, numero)
  if (!k) return []
  return (chiaviDoppioni[k] || []).filter(function (r) { return r.id !== escludiId })
}

// La spia: icona E parola, come tutte le altre.
function spiaDoppione(a) {
  var altri = doppioniDi(a.fornitore, a.numero_fornitore, a.id)
  if (!altri.length) return ''
  return ' <button type="button" class="spia-doppione" title="Un altro documento ha lo stesso fornitore e lo stesso numero" ' +
    'onclick="event.stopPropagation(); viewAcquisto(\'' + esc(altri[0].id) + '\')">⚠️ Doppione?</button>'
}

// ── Il controllo al salvataggio ─────────────────────────────────────────────
// Query mirata: si filtra sul numero, che e' la parte selettiva, e si confronta
// il fornitore normalizzato sulle pochissime righe che tornano. Filtrare il
// fornitore nel database vorrebbe dire normalizzarlo li', e «Softution SAGL» e
// «softution  sagl» non si equivalgono per un confronto SQL.
async function cercaDoppione(fornitore, numero, escludiId) {
  var n = String(numero || '').trim()
  if (!n) return null                       // senza numero non si controlla niente
  var f = normalizzaFornitore(fornitore)
  if (!f) return null

  const { data, error } = await sb.from('tm_conta_fatture_acquisto')
    .select('id, fornitore, numero_fornitore, data, importo, valuta')
    .eq('azienda_id', currentAziendaId)
    .eq('numero_fornitore', n)
  if (error) throw error

  var trovati = (data || []).filter(function (r) {
    return r.id !== escludiId && normalizzaFornitore(r.fornitore) === f
  })
  return trovati.length ? trovati[0] : null
}

// L'avviso: dice QUALE fattura, con data e importo, e lascia decidere.
function avvisoDoppioneHtml(altra) {
  return '<div class="fase-banner warn">' +
    '<span class="icon" aria-hidden="true">⚠️</span>' +
    '<div class="msg">' +
      '<strong>Attenzione: hai già registrato la fattura n. ' + esc(altra.numero_fornitore || '') +
        ' di ' + esc(altra.fornitore || '') + ' del ' + esc(fmtDate(altra.data)) +
        ' per ' + esc(fmtNumIt(altra.importo)) + ' ' + esc(altra.valuta || 'CHF') + '.</strong>' +
      '<div class="form-actions" style="margin-top:10px">' +
        '<button type="button" class="btn-secondary" onclick="viewAcquisto(\'' + esc(altra.id) + '\')">' +
          '👁 Vedi quella fattura</button>' +
        '<button type="button" class="btn-primary" onclick="salvaAcquistoComunque()">' +
          '💾 Salva lo stesso</button>' +
      '</div>' +
    '</div>' +
  '</div>'
}

// Chi preme «Salva lo stesso» ha visto l'avviso e ha deciso: si salta il
// controllo una volta sola, non per sempre.
var doppioneAccettato = false

function salvaAcquistoComunque() {
  doppioneAccettato = true
  saveAcquisto()
}


// ══════════════════════════════════════════════════════════════════════════════
// FASE 9C — LA PAGINA VECCHIA
//
// GitHub Pages tiene index.html in cache dieci minuti, e index.html e' l'unico
// file che non puo' auto-versionarsi: app.js?v=30 si aggiorna da solo, la
// pagina che lo richiama no. Risultato: si guarda l'HTML vecchio col JS nuovo,
// non si trova quello che si cerca e si crede che il codice sia rotto.
// E' successo tre volte in un giorno.
//
// Il numero e' UNO SOLO: lo stesso del cache-busting. Due numeri separati
// divergono sempre, e un controllo di versione sbagliato e' peggio di nessun
// controllo.
//
// Non ricarica da sola: un ricaricamento a sorpresa mentre si compila un
// modulo perde il lavoro. Lo dice, e lascia premere.
// ══════════════════════════════════════════════════════════════════════════════

var VERSIONE = '43'

function controllaVersionePagina() {
  try {
    var dichiarata = document.body ? document.body.getAttribute('data-versione') : null
    // Se l'attributo manca non si dice niente: sarebbe un allarme su una pagina
    // che potrebbe essere semplicemente servita da un altro posto.
    if (!dichiarata || dichiarata === VERSIONE) return

    var b = el('versione-banner')
    if (!b) return
    b.innerHTML = '<div class="fase-banner warn">' +
      '<span class="icon" aria-hidden="true">⚠️</span>' +
      '<div class="msg"><strong>Questa pagina è una versione vecchia.</strong> ' +
        'Il programma è stato aggiornato (versione ' + esc(VERSIONE) + ', qui c\'è la ' +
        esc(dichiarata) + '): finché non la ricarichi potresti non vedere le novità.' +
        '<div class="form-actions" style="margin-top:10px">' +
          '<button type="button" class="btn-primary" onclick="ricaricaPagina()">🔄 Ricarica</button>' +
        '</div>' +
      '</div></div>'
  } catch (e) { console.warn('Controllo versione:', e.message || e) }
}

function ricaricaPagina() {
  // location.reload() e location.reload(true) NON bastano: il secondo e'
  // deprecato e i browser moderni lo ignorano, e un ricaricamento normale
  // ripesca index.html dalla cache — che e' l'unico file senza ?v=. Si
  // naviga percio' su un indirizzo con un parametro sempre diverso, che la
  // cache non puo' servire.
  //
  // Si riparte da pathname e non dall'indirizzo intero: cosi' un ?r= vecchio
  // non si somma a quello nuovo. Il #frammento si tiene, per tornare sulla
  // schermata da cui si e' premuto.
  try {
    window.location.replace(window.location.pathname + '?r=' + Date.now() +
                            window.location.hash)
  } catch (_) {
    window.location.reload()
  }
}

// FASE 22 / P1 — SUBITO DOPO, L'INDIRIZZO SI RIPULISCE.
//
// Il ?r= ha fatto il suo lavoro nel momento in cui il browser ha chiesto la
// pagina: da li' in poi e' sporcizia. E non se ne andrebbe da solo, perche'
// spingiStato() chiama history.replaceState con un indirizzo RELATIVO
// ('#fatture'), che conserva la query: il parametro resterebbe nella barra
// per tutta la sessione e finirebbe dentro il collegamento salvato.
//
// Va chiamata PRIMA di installaCronologia(): dopo il primo spingiStato()
// sarebbe gia' tardi.
function pulisciIndirizzoRicarica() {
  try {
    if (!window.location.search) return
    var p = new URLSearchParams(window.location.search)
    // 'ricarica' e' il nome usato dalla versione 40: chi ce l'ha appiccicato
    // in cache deve vederselo togliere lo stesso.
    if (!p.has('r') && !p.has('ricarica')) return
    // Si tolgono SOLO i due parametri nostri. Buttare via tutta la query
    // sarebbe piu' corto, ma un giorno qualcuno passerebbe un parametro suo e
    // se lo vedrebbe sparire senza capire perche'.
    p.delete('r'); p.delete('ricarica')
    var resto = p.toString()
    history.replaceState(history.state, '', window.location.pathname +
                         (resto ? '?' + resto : '') + window.location.hash)
  } catch (e) { console.warn('Pulizia indirizzo:', e.message || e) }
}


// ══════════════════════════════════════════════════════════════════════════════
// FASE 10 — LETTURA AUTOMATICA DELLE FATTURE
//
// Il programma manda la fattura (PDF o foto) a un Worker su Cloudflare, che
// custodisce la chiave API e parla con l'AI al posto suo. Qui dentro NON c'e'
// nessuna chiave, e non ci deve mai finire: questo file e' pubblico su GitHub.
//
// La risposta passa dalla STESSA validazione del ponte copia/incolla della
// FASE 5A. Due strade di validazione, un giorno, divergerebbero: una vale i
// centesimi risparmiati, l'altra no.
//
// Il ponte manuale resta sempre lì. Se il Worker non risponde, non si e' mai
// bloccati: si copia il prompt e si legge la fattura a mano, come prima.
// ══════════════════════════════════════════════════════════════════════════════

// ── Il costo ─────────────────────────────────────────────────────────────────
// Prezzi di Anthropic per claude-sonnet-5, in dollari per MILIONE di token.
// Verificati il 31 agosto 2026 su anthropic.com/pricing.
//
// I prezzi cambiano: sono qui, in un punto solo, e la data dice quando erano
// veri. Se il conto a schermo smette di somigliare a quello che arriva
// davvero, e' questa riga che va aggiornata.
var PREZZO_INPUT_MTOK  = 3.00
var PREZZO_OUTPUT_MTOK = 15.00

// Da dollari a franchi. Anche questo cambia, ed e' una stima: serve l'ordine di
// grandezza, non il centesimo esatto.
var CAMBIO_USD_CHF = 0.80

// Quanto si aspetta il Worker prima di arrendersi. Una fattura fotografata ci
// mette qualche secondo; un minuto e' largo abbastanza da non tagliare una
// lettura lenta, e corto abbastanza da non lasciare l'utente a fissare la
// rotella senza sapere se sta succedendo qualcosa.
var TIMEOUT_LETTURA_MS = 60000

var LIMITE_LETTURA_MB = 10

function costoStimatoChf(inputTokens, outputTokens) {
  var usd = (safeNum(inputTokens) || 0) / 1000000 * PREZZO_INPUT_MTOK +
            (safeNum(outputTokens) || 0) / 1000000 * PREZZO_OUTPUT_MTOK
  return usd * CAMBIO_USD_CHF
}

// ── L'indirizzo del Worker ───────────────────────────────────────────────────
// Sta in tm_conta_impostazioni, non nel codice: cosi' si cambia senza
// ripubblicare il programma, ed e' per azienda — un Worker condiviso vorrebbe
// dire la chiave di una ditta usata da un'altra.
function urlWorkerLettura() {
  return String(impostazione('worker_lettura_url', '') || '').trim()
}

function letturaAutomaticaAttiva() { return !!urlWorkerLettura() }

// ── Il file, in base64 ───────────────────────────────────────────────────────
// Si legge come data URL e si toglie il prefisso «data:...;base64,»: il Worker
// vuole i soli caratteri, non l'intestazione.
function fileInBase64(file) {
  return new Promise(function (risolvi, rifiuta) {
    var lettore = new FileReader()
    lettore.onload = function () {
      var s = String(lettore.result || '')
      var virgola = s.indexOf(',')
      risolvi(virgola === -1 ? s : s.slice(virgola + 1))
    }
    lettore.onerror = function () { rifiuta(new Error('Il file non si riesce a leggere.')) }
    lettore.readAsDataURL(file)
  })
}

// ── La chiamata al Worker ────────────────────────────────────────────────────
// Restituisce { testo, input_tokens, output_tokens } oppure lancia con un
// messaggio gia' leggibile: chi la chiama non deve tradurre niente.
async function chiediLetturaAlWorker(file, prompt) {
  var url = urlWorkerLettura()
  if (!url) throw new Error('L\'indirizzo del Worker non è configurato. Vai in «Impostazioni ditta» → «Lettura automatica delle fatture».')

  var base64 = await fileInBase64(file)

  // Il timeout va gestito qui: fetch da solo aspetta all'infinito, e una
  // richiesta che non torna piu' lascia il bottone spento per sempre.
  var controllo = new AbortController()
  var scaduto = false
  var orologio = setTimeout(function () { scaduto = true; controllo.abort() }, TIMEOUT_LETTURA_MS)

  var risposta
  try {
    risposta = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_base64: base64,
        media_type: file.type || 'application/pdf',
        prompt: prompt
      }),
      signal: controllo.signal
    })
  } catch (e) {
    if (scaduto) {
      throw new Error('La lettura ha superato il minuto di attesa e si è fermata. Riprova, oppure usa «Copia prompt».')
    }
    // Qui finiscono anche i rifiuti CORS, che il browser non lascia distinguere
    // da un errore di rete: si dicono tutti e due i motivi possibili.
    throw new Error('Non sono riuscito a contattare il Worker. Controlla l\'indirizzo in «Impostazioni ditta», oppure usa «Copia prompt».')
  } finally {
    clearTimeout(orologio)
  }

  var dati = null
  try { dati = await risposta.json() } catch (_) { /* gestito sotto */ }

  if (!dati) throw new Error('Il Worker ha risposto in un formato che non riesco a leggere. Usa «Copia prompt».')
  if (!dati.ok) throw new Error(dati.errore || 'Il Worker ha rifiutato la richiesta.')
  if (!String(dati.testo || '').trim()) throw new Error('Il Worker non ha restituito nessun testo. Riprova, oppure usa «Copia prompt».')

  return dati
}

// ── Il bottone «Leggi da PDF o foto» ─────────────────────────────────────────
var letturaInCorso = false

function apriSceltaFileLettura() {
  if (letturaInCorso) return          // due clic non devono fare due chiamate
  var inp = el('lettura-file')
  if (inp) { inp.value = ''; inp.click() }
}

async function leggiFatturaDaFile(input) {
  if (!input || !input.files || !input.files.length) return
  if (letturaInCorso) return
  var file = input.files[0]

  var btn = el('btn-lettura-ai')
  html('ponte-ai-note', '')
  html('lettura-costo', '')

  try {
    // Il limite si controlla PRIMA di leggere e mandare: caricare 30 MB per
    // sentirsi dire di no e' il modo peggiore di dirlo, e la chiamata si
    // pagherebbe lo stesso.
    var mb = file.size / (1024 * 1024)
    if (mb > LIMITE_LETTURA_MB) {
      throw new Error('Il file pesa ' + fmtNumIt(mb) + ' MB, oltre il limite di ' +
        LIMITE_LETTURA_MB + ' MB. Rifallo con una risoluzione più bassa.')
    }

    letturaInCorso = true
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Lettura in corso…' }
    showPonteBanner('info', 'Lettura di «' + file.name + '» in corso… può volerci qualche secondo.')

    // Il prompt esce dal database, con l'elenco dei conti aggiornato: e' lo
    // stesso del ponte manuale, e come lì i conti vanno caricati prima.
    await ensureContiIva()
    var prompt = testoPromptFattura()

    var risposta = await chiediLetturaAlWorker(file, prompt)

    // UNA SOLA strada di validazione: la stessa del ponte copia/incolla.
    var esito = await applicaTestoLettura(risposta.testo)

    if (esito.ok) {
      lettaDaAI = true          // il documento entrera' come «da confermare»
      mostraCostoLettura(risposta.input_tokens, risposta.output_tokens)
      showPonteBanner('ok', 'Fattura letta. Controlla i campi prima di salvare: entrerà come «da confermare».')
    }
    // Se la validazione ha rifiutato, il messaggio l'ha gia' scritto lei.
  } catch (e) {
    showPonteBanner('err', (e.message || String(e)) +
      ' — puoi sempre usare 📋 Copia prompt e leggerla a mano.')
  } finally {
    letturaInCorso = false
    if (btn) { btn.disabled = false; btn.textContent = '📄 Leggi da PDF o foto' }
    if (input) input.value = ''       // così lo stesso file si può riprovare
  }
}

// Il bottone c'e' solo dove serve: su un documento nuovo, e solo se
// l'indirizzo del Worker e' stato configurato. Senza indirizzo non comparirebbe
// altro che un errore, e il ponte manuale funziona lo stesso.
function mostraBottoneLettura(nuovo) {
  var btn = el('btn-lettura-ai')
  if (btn) btn.style.display = (nuovo && letturaAutomaticaAttiva()) ? '' : 'none'
  html('lettura-costo', '')
}

// ── Il costo, dopo ogni lettura ──────────────────────────────────────────────
// Niente contatore mensile e niente storico: sarebbero una tabella nuova per un
// dato che Cloudflare e Anthropic tengono gia'. Serve l'ordine di grandezza,
// qui e adesso.
// Sotto il centesimo «0,00 CHF» non dice niente: si scrive che e' meno di
// un centesimo, che e' l'informazione vera.
function costoLeggibile(chf) {
  return (chf > 0 && chf < 0.005) ? 'meno di 0,01 CHF' : fmtNumIt(chf) + ' CHF'
}

function mostraCostoLettura(inputTokens, outputTokens) {
  var chf = costoStimatoChf(inputTokens, outputTokens)
  html('lettura-costo',
    '<div class="lettura-costo">ℹ️ Lettura completata · costo stimato <strong>' +
      esc(costoLeggibile(chf)) + '</strong>' +
      '<span class="dim"> (' + esc(String(inputTokens || 0)) + ' token letti, ' +
        esc(String(outputTokens || 0)) + ' scritti)</span>' +
    '</div>')
}

// ── Impostazioni: l'indirizzo e la prova ─────────────────────────────────────
function statoLetturaHtml(stato, dettaglio) {
  // La specifica ne chiedeva tre. Ne servono quattro: dire «non risponde» a
  // un Worker che ha risposto «credito esaurito» manda a cercare il guasto
  // nel posto sbagliato.
  var m = {
    ok:     { ic: '✅', txt: 'funziona',            cls: 'ok' },
    guasto: { ic: '⚠️', txt: 'risponde, ma non funziona', cls: 'warn' },
    ko:     { ic: '⚠️', txt: 'non risponde',        cls: 'warn' },
    vuoto:  { ic: '—',  txt: 'non configurato',     cls: 'dim' }
  }[stato] || { ic: '—', txt: 'non configurato', cls: 'dim' }
  return '<span class="lettura-stato ' + m.cls + '">' + m.ic + ' ' + esc(m.txt) + '</span>' +
         (dettaglio ? '<div class="form-hint" style="margin-top:6px">' + esc(dettaglio) + '</div>' : '')
}

function aggiornaStatoLettura() {
  html('imp-lettura-stato', statoLetturaHtml(letturaAutomaticaAttiva() ? 'ok' : 'vuoto',
    letturaAutomaticaAttiva() ? 'Indirizzo salvato. Premi «Prova la connessione» per verificarlo davvero.' : null))
}

// La prova manda una richiesta vera, con un file finto minuscolo: e' l'unico
// modo di sapere se il Worker risponde, se la chiave c'e' e se l'origine e'
// ammessa. Un semplice «l'indirizzo sembra giusto» non direbbe niente.
async function provaConnessioneWorker() {
  var btn = el('imp-lettura-prova-btn')
  var url = String(getVal('imp-lettura-url') || '').trim()
  if (!url) {
    html('imp-lettura-stato', statoLetturaHtml('vuoto', 'Incolla prima l\'indirizzo del Worker.'))
    return
  }
  try {
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Prova in corso…' }
    html('imp-lettura-stato', statoLetturaHtml('vuoto', 'Prova in corso…'))

    var controllo = new AbortController()
    var orologio = setTimeout(function () { controllo.abort() }, 30000)
    var risposta
    try {
      risposta = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Modalita di prova: nessuna immagine. Mandarne una finta aggiungeva
        // un motivo di fallimento che non c'entrava niente con quello che la
        // prova deve verificare — ed e' quello che succedeva col pixel 1x1,
        // che l'API rifiutava perche' troppo piccolo.
        body: JSON.stringify({ prova: true }),
        signal: controllo.signal
      })
    } finally { clearTimeout(orologio) }

    var dati = null
    try { dati = await risposta.json() } catch (_) {}

    if (dati && dati.ok) {
      html('imp-lettura-stato', statoLetturaHtml('ok',
        'Il Worker ha risposto e la chiave funziona. Costo della prova: ' +
        costoLeggibile(costoStimatoChf(dati.input_tokens, dati.output_tokens)) + '.'))
    } else {
      // Il motivo lo scrive gia' il Worker, in italiano: si mostra quello.
      // Il codice HTTP da solo non dice a nessuno che cosa aggiustare, e si
      // aggiunge solo quando non c'e' proprio nient'altro da dire.
      // Se il Worker ha dato un motivo, ha risposto: il guasto e' a valle.
      html('imp-lettura-stato', (dati && dati.errore)
        ? statoLetturaHtml('guasto', dati.errore)
        : statoLetturaHtml('ko', 'Il Worker ha risposto in modo inatteso (codice ' + risposta.status +
            '). Se hai appena incollato il codice su Cloudflare, controlla di aver premuto Deploy.'))
    }
  } catch (e) {
    html('imp-lettura-stato', statoLetturaHtml('ko',
      'Non ho ricevuto risposta. Controlla che l\'indirizzo sia giusto e che il Worker risulti pubblicato su Cloudflare.'))
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔌 Prova la connessione' }
  }
}

// ── «Da confermare» ──────────────────────────────────────────────────────────
// Quello che ha letto una macchina non entra nei conti finche' una persona non
// l'ha guardato. L'infrastruttura c'era gia' dalla FASE 5C: qui si aggiunge il
// gesto per confermare, che deve restare un gesto — non l'effetto collaterale
// di un salvataggio.
var lettaDaAI = false

function daConfermare(a) { return a && a.stato_conferma === 'da_confermare' }

function spiaDaConfermare(a) {
  if (!daConfermare(a)) return ''
  return ' <span class="spia-conferma">⏳ Da confermare</span>'
}

async function confermaAcquisto(id) {
  if (!window.confirm('Confermare questa fattura?\n\n' +
      'Da adesso entra nei totali, nelle scadenze e nell\'export per il commercialista.\n' +
      'Controlla che data e importo siano giusti: l\'AI sbaglia le date e legge male gli importi sulle foto storte.')) return
  try {
    const { error } = await sb.from('tm_conta_fatture_acquisto')
      .update({ stato_conferma: 'confermato' })
      .eq('id', id).eq('azienda_id', currentAziendaId).select()
    if (error) throw error
    scadeCache('flussi')
    exportDataset = null
    await loadAcquistiList()
    await refreshDaConfermareCount()
    // Se si stava guardando proprio quella scheda, si ridisegna: altrimenti
    // resterebbe il bottone «Conferma» su una fattura gia' confermata.
    try {
      var ap = el('acquisti-detail-view')
      if (ap && ap.style.display !== 'none') await viewAcquisto(id)
    } catch (_) {}
    showFattureBanner('acquisti-list-banner', 'ok', 'Fattura confermata: da adesso entra nei totali.')
  } catch (e) {
    showFattureBanner('acquisti-list-banner', 'err', 'Non confermata: ' + (e.message || e))
  }
}

// Il badge nel menu, con lo stesso schema di «Da classificare».
async function refreshDaConfermareCount() {
  if (!currentUser || !currentAziendaId) return
  try {
    const { data, error } = await sb.from('tm_conta_fatture_acquisto')
      .select('id')
      .eq('azienda_id', currentAziendaId)
      .eq('stato_conferma', 'da_confermare')
    if (error) throw error
    var n = (data || []).length
    var badge = el('nav-badge-acquisti')
    if (badge) {
      badge.textContent = String(n)
      badge.style.display = n ? '' : 'none'
      badge.setAttribute('aria-label', n + ' fatture da confermare')
    }
  } catch (_) { /* non bloccante */ }
}


// ─── Entry point ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {

  // Navigazione click
  document.querySelectorAll('.nav-item[data-page]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.disabled || btn.classList.contains('disabled')) return
      var pageId = btn.dataset.page
      showPage(pageId)
      if (pageId === 'movimenti')   { loadDaClassificare() }
      if (pageId === 'inserimento') { initInserimentoPage() }
      if (pageId === 'export')      { initExportPage() }
      if (pageId === 'fatture')     { initFatturePage() }
      if (pageId === 'acquisti')    { initAcquistiPage() }
      if (pageId === 'rubrica')     { initRubricaPage() }
      if (pageId === 'codici')      { initCodiciPage() }
      if (pageId === 'busta')       { initBustaPage() }
      if (pageId === 'cruscotto')   { initCruscottoPage() }
      if (pageId === 'scadenze')    { initScadenzePage() }
      if (pageId === 'cantieri')    { initCantieriPage() }
      if (pageId === 'impostazioni'){ initImpostazioniPage() }
      if (pageId === 'setup')       { /* già caricata */ }
    })
  })

  // Imposta data di default nel form (oggi)
  var fData = el('f-data')
  if (fData) { fData.value = oggiISO() }

  // Chiudi le modali cliccando lo sfondo o premendo Esc
  var clsOverlay = el('classify-overlay')
  if (clsOverlay) {
    // Il clic sullo sfondo NON chiude piu': qui si sta classificando un
    // movimento, e un clic di troppo faceva ricominciare da capo.
  }
  // Esc e clic-fuori sono gestiti in un posto solo, con la regola per tutte
  // le finestre: vedi installaGestioneFinestre().
  installaGestioneFinestre()
  // FASE 22 — prima della cronologia: dopo, il ?r= resterebbe incollato.
  pulisciIndirizzoRicarica()
  installaCronologia()
  // FASE 9C — se l'HTML e' una versione vecchia rimasta in cache, lo si dice.
  controllaVersionePagina()

  // Mostra istruzioni SQL (visibili prima dell'auth)
  renderSqlInstructions()

  // Ascolta cambi auth
  sb.auth.onAuthStateChange(function (event, session) {
    if (event === 'SIGNED_IN' && session && session.user) {
      currentUser = session.user
      loadAziendaId().then(function () {
        updateSidebarAuth()
        refreshDaClassificareCount()
        refreshDaConfermareCount()
        refreshScadenzeCount()
        if (currentPage === 'login') {
          showPage('setup')
          runSetupCheck()
        }
      })
    } else if (event === 'SIGNED_OUT') {
      currentUser = null
      currentAziendaId = null
      updateSidebarAuth()
      var badgeNav = el('nav-badge-movimenti')
      if (badgeNav) badgeNav.textContent = '0'
      var badgeScad = el('nav-badge-scadenze')
      if (badgeScad) { badgeScad.style.display = 'none'; badgeScad.textContent = '' }
      flussiCache = null
      impostazioniConta = null
      aziendaInfo = null      // FASE 23 — vedi doLogout
      showPage('login')
    }
  })

  // Controlla sessione esistente
  sb.auth.getSession().then(function (result) {
    var session = result.data && result.data.session
    if (session && session.user) {
      currentUser = session.user
      loadAziendaId().then(function () {
        updateSidebarAuth()
        // Se l'indirizzo chiede una schermata precisa si apre quella, altrimenti
        // si parte dal setup come sempre.
        if (!apriDaIndirizzo()) { showPage('setup'); runSetupCheck() }
        refreshDaClassificareCount()
        refreshDaConfermareCount()
        // FASE 4 — all'avvio: badge, e la finestrella se c'e' qualcosa in sospeso
        refreshScadenzeCount().then(function () { forseMostraFinestraScadenze() })
      })
    } else {
      showPage('login')
    }
  }).catch(function () {
    showPage('login')
  })

})

// ══════════════════════════════════════════════════════════════════════════════
// MENU MOBILE (off-canvas) — solo layout/UI, nessuna logica dati toccata
// ══════════════════════════════════════════════════════════════════════════════
function toggleSidebar() {
  var sb = document.getElementById('sidebar')
  var ov = document.getElementById('sidebar-overlay')
  if (!sb) return
  var open = sb.classList.toggle('open')
  if (ov) ov.style.display = open ? 'block' : 'none'
  var btn = document.getElementById('hamburger-btn')
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false')
}

function closeSidebar() {
  var sb = document.getElementById('sidebar')
  var ov = document.getElementById('sidebar-overlay')
  if (sb) sb.classList.remove('open')
  if (ov) ov.style.display = 'none'
  var btn = document.getElementById('hamburger-btn')
  if (btn) btn.setAttribute('aria-expanded', 'false')
}

// FASE 2 — il menu dei suggerimenti della rubrica si chiude cliccando altrove.
// Senza questo resterebbe aperto sopra il resto del modulo.
document.addEventListener('click', function (ev) {
  ['f', 'a', 'v', 'b'].forEach(function (prefix) {
    var c = rubricaCampi(prefix)
    var box = el(c.suggest)
    if (!box || !box.innerHTML) return
    var campo = el(c.testo)
    if (box.contains(ev.target) || (campo && campo === ev.target)) return
    // FASE 18 — il bottone «Scegli dalla rubrica» apre il menu: se lo chiudesse
    // anche questo gestore, il menu si aprirebbe e si richiuderebbe da solo.
    var btn = c.btnSfoglia ? el(c.btnSfoglia) : null
    if (btn && (btn === ev.target || btn.contains(ev.target))) return
    html(c.suggest, '')
  })
})

// La data del movimento decide lo stato proposto: passata = gia' saldata,
// futura = ancora da pagare. Stessa regola del backfill della FASE 1.
document.addEventListener('DOMContentLoaded', function () {
  var d = el('f-data')
  if (d) d.addEventListener('change', function () {
    // solo su un movimento nuovo: in modifica lo stato e' quello salvato
    if (!editingMovimentoId) proponiStatoDaData()
  })
})

// Listener AGGIUNTIVO (non tocca l'entry point esistente): chiude il menu quando
// si tocca una voce, si fa logout, o si torna a larghezza desktop.
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('#sidebar .nav-item[data-page]').forEach(function (btn) {
    btn.addEventListener('click', function () { closeSidebar() })
  })
  var logoutBtn = document.querySelector('#sidebar .logout-btn')
  if (logoutBtn) logoutBtn.addEventListener('click', function () { closeSidebar() })
  window.addEventListener('resize', function () {
    if (window.innerWidth > 900) closeSidebar()
  })
})
