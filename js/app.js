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
  return esc(n.toLocaleString('it-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + (valuta || 'CHF'))
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

// Formatta un numero a 2 decimali per la UI; '—' se non disponibile
function fmtNum2(n) {
  if (n == null || isNaN(n)) return '—'
  return n.toLocaleString('it-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ─── Navigazione pagine ───────────────────────────────────────────────────────
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active') })
  document.querySelectorAll('.nav-item[data-page]').forEach(function (n) { n.classList.remove('active') })
  const page = el('page-' + pageId)
  if (page) page.classList.add('active')
  const navBtn = document.querySelector('.nav-item[data-page="' + pageId + '"]')
  if (navBtn) navBtn.classList.add('active')
  currentPage = pageId
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
  updateSidebarAuth()
  html('nav-badge-movimenti', '0')
  showPage('login')
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
        .select('id, fornitore, numero_fornitore, data, importo, valuta')
        .eq('azienda_id', currentAziendaId)
        .order('data', { ascending: false })
      if (error) throw error
      for (var q = 0; q < (data || []).length; q++) {
        var acq = data[q]
        var desc = 'Acquisto' + (acq.numero_fornitore ? ' ' + acq.numero_fornitore : '') + ' — ' + (acq.fornitore || '')
        movimenti.push({
          origine_tipo: 'acquisto',
          origine_id:   acq.id,
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
      .select('id, data, descrizione, ente_fornitore, importo, valuta, ricorrente, periodicita, doc_path, created_at, stato_conferma')
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
  html('movimenti-sorgenti',
    '<div class="grid-3" style="margin-bottom:20px">' +
      statCard('📦 Spese', speseCnt, 'App Cantieri — Canale A') +
      statCard('🔧 Regia', regiaCnt, 'App Cantieri — Canale A') +
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
  if (daClass.length === 0) {
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
async function ensureContiIva() {
  if (contiCache && ivaCache) return
  try {
    const { data, error } = await sb
      .from('tm_conta_piano_conti')
      .select('id, codice_conto, descrizione, tipo, azienda_id, attivo, gruppo_codice')
      .eq('paese', 'CH')
      .eq('attivo', true)
      .order('codice_conto')
    if (error) throw error
    contiCache = data || []
  } catch (e) {
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
  } catch (e) {
    ivaCache = ivaCache || []
    console.warn('IVA:', e.message)
  }
}

// Carica cantieri (sola lettura, con fallback progressivo). Mai bloccante.
async function loadCantieri() {
  if (cantieriCache !== null) return
  try {
    // FASE 6A — servono anche luogo e stato: il luogo distingue due cantieri
    // con lo stesso nome, lo stato decide l'ordine della tendina.
    // SOLA LETTURA: 'cantieri' e' una tabella di App Cantieri, in produzione.
    const { data, error } = await sb.from('cantieri')
      .select('id, nome, luogo, stato, committente').limit(500)
    if (error) throw error
    cantieriCache = (data || []).map(function (c) {
      return { id: c.id, nome: c.nome, luogo: c.luogo || null,
               stato: c.stato || null, committente: c.committente || null }
    })
    return
  } catch (e0) {
  try {
    const { data, error } = await sb.from('cantieri').select('id, nome').limit(500)
    if (error) throw error
    cantieriCache = (data || []).map(function (c) { return { id: c.id, nome: c.nome } })
    return
  } catch (e1) {
    try {
      const { data, error } = await sb.from('cantieri').select('id').limit(500)
      if (error) throw error
      cantieriCache = (data || []).map(function (c) { return { id: c.id, nome: null } })
      return
    } catch (e2) {
      cantieriCache = []
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
  if (conStato && c.stato && ordineStatoCantiere(c.stato) !== 0) n += ' (' + c.stato + ')'
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
  if (!conti.length) return '<option value="" disabled>Nessun conto trovato</option>'
  var out = ''
  if (propri.length)    out += '<optgroup label="I miei conti">' + propri.map(opt).join('') + '</optgroup>'
  if (pacchetto.length) out += '<optgroup label="Pacchetto CH">' + pacchetto.map(opt).join('') + '</optgroup>'
  return out
}

function buildIvaOptions(selectedId) {
  var iva = ivaCache || []
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

  await ensureContiIva()
  await loadCantieri()
  el('cls-conto').innerHTML = buildContoOptions('', prefill ? prefill.conto_id : null)
  preparaCampoGruppo()
  el('cls-iva').innerHTML = buildIvaOptions(prefill ? prefill.codice_iva_id : null)
  el('cls-cantiere').innerHTML = buildCantiereOptions(prefill ? prefill.cantiere_id : m.cantiere_id, true)
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

  await ensureContiIva()
  await loadCantieri()
  el('cls-conto').innerHTML = buildContoOptions('', null)
  preparaCampoGruppo()
  el('cls-iva').innerHTML = buildIvaOptions(null)
  el('cls-cantiere-comune').innerHTML = buildCantiereOptions(null, true)
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
  var box = el('f-allegato-corrente')
  var lbl = el('f-allegato-label')
  if (!box) return
  if (!editingDocPath) {
    box.style.display = 'none'
    box.innerHTML = ''
    if (lbl) lbl.innerHTML = 'Allegato documento <span class="dim">(opzionale)</span>'
    return
  }
  box.style.display = 'flex'
  box.innerHTML =
    '<span aria-hidden="true">📎</span>' +
    '<span class="allegato-nome">' + esc(allegatoNomeFile(editingDocPath)) + '</span>' +
    '<span class="allegato-actions">' +
      '<button type="button" class="btn-secondary" onclick="openAllegato(\'' + esc(editingDocPath) + '\', \'inserimento-banner\')">📎 Apri allegato</button>' +
      '<button type="button" class="btn-secondary" onclick="rimuoviAllegatoMovimento()">🗑️ Rimuovi allegato</button>' +
    '</span>'
  if (lbl) lbl.innerHTML = 'Sostituisci allegato <span class="dim">(scegli un nuovo file per rimpiazzare quello sopra)</span>'
}

async function rimuoviAllegatoMovimento() {
  if (!editingDocPath) return
  if (!window.confirm('Rimuovere l\'allegato?\n\nIl file verrà cancellato dallo storage: non si può annullare.')) return
  var path = editingDocPath
  try {
    await deleteAllegatoStorage(path)
    if (editingMovimentoId) {
      const { error } = await sb.from('tm_conta_movimenti_propri')
        .update({ doc_path: null }).eq('id', editingMovimentoId).eq('azienda_id', currentAziendaId).select()
      if (error) throw error
    }
    editingDocPath = null
    renderMovimentoAllegatoCorrente()
    showInserimentoBanner('ok', 'Allegato rimosso', 'Il file è stato cancellato dallo storage.')
    try { await loadRecentiInseriti() } catch (_) {}
  } catch (e) {
    console.error('rimuoviAllegatoMovimento:', e)
    showInserimentoBanner('err', 'Rimozione allegato non riuscita', e.message || String(e))
  }
}

async function startEditMovimento(id) {
  if (!currentAziendaId) return
  if (isBloccato('proprio', id)) {
    alert('Questo movimento è in un periodo consegnato (bloccato). Sbloccalo dalla pagina «Export & consegna» per modificarlo.')
    return
  }
  try {
    const { data, error } = await sb
      .from('tm_conta_movimenti_propri')
      .select('id, data, descrizione, ente_fornitore, importo, valuta, ricorrente, periodicita, doc_path,' +
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
    editingDocPath = data.doc_path || null

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
    iva_inclusa: 'IVA inclusa', cantiere_id: 'Cantiere', stato: 'Stato'
  }
  return map[field] || field
}
function prettyAuditValue(field, val) {
  if (val == null || val === '') return '(vuoto)'
  if (field === 'conto_id')      return contoLabel(val)
  if (field === 'codice_iva_id') return ivaLabel(val)
  if (field === 'cantiere_id')   return cantiereLabel(val)
  if (field === 'iva_inclusa')   return (val === 'true' || val === true) ? 'IVA inclusa' : 'IVA esclusa'
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
      .select('id, numero, data_emissione, cliente_nome, totale_imponibile, totale_iva, totale, valuta, stato, stato_pagamento, data_scadenza, data_pagamento, gruppo_codice, contatto_id, tipo, iban, rif_fattura_id, doc_path')
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
  if (!currentAziendaId) { html('fatture-table', '<div class="dim">Accedi per vedere le fatture.</div>'); return }
  html('fatture-table', loadingRow('Caricamento fatture…'))
  try {
    const { data, error } = await sb
      .from('tm_conta_fatture')
      .select('id, numero, anno, data_emissione, cliente_nome, totale, valuta, stato, stato_pagamento, data_scadenza, tipo, created_at, doc_path')
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
        (f.stato === 'emessa' && !f.doc_path
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
function calcolaRiga(r) {
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
  fatturaRighe = [{ descrizione: '', quantita: 1, prezzo_unitario: 0, codice_iva_id: '' }]
  el('fatture-edit-title').textContent = editorTipo === 'nota_credito' ? 'Nuova nota di credito' : 'Nuova fattura'
  el('f-cli-nome').value = ''
  el('f-cli-indirizzo').value = ''
  el('f-cli-paese').value = 'CH'
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
      return { descrizione: r.descrizione || '', quantita: r.quantita, prezzo_unitario: r.prezzo_unitario, codice_iva_id: r.codice_iva_id || '' }
    })
    if (!fatturaRighe.length) fatturaRighe = [{ descrizione: '', quantita: 1, prezzo_unitario: 0, codice_iva_id: '' }]

    el('fatture-edit-title').textContent = (f.tipo === 'nota_credito' ? 'Nota di credito' : 'Fattura') + ' (bozza)'
    el('f-cli-nome').value = f.cliente_nome || ''
    el('f-cli-indirizzo').value = f.cliente_indirizzo || ''
    el('f-cli-paese').value = f.cliente_paese || 'CH'
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
    rows +=
      '<tr>' +
        '<td><input class="cell-input" value="' + esc(r.descrizione || '') + '" oninput="onRigaInput(' + i + ',\'descrizione\',this.value)" placeholder="Descrizione"></td>' +
        '<td><input class="cell-input num" type="number" step="0.001" value="' + esc(r.quantita == null ? '' : String(r.quantita)) + '" oninput="onRigaInput(' + i + ',\'quantita\',this.value)"></td>' +
        '<td><input class="cell-input num" type="number" step="0.01" value="' + esc(r.prezzo_unitario == null ? '' : String(r.prezzo_unitario)) + '" oninput="onRigaInput(' + i + ',\'prezzo_unitario\',this.value)"></td>' +
        (ivaOn ? '<td><select class="cell-input" onchange="onRigaInput(' + i + ',\'codice_iva_id\',this.value)">' + buildIvaOptions(r.codice_iva_id) + '</select></td>' : '') +
        '<td class="num" id="imp-cell-' + i + '">' + fmtNum2(calc.imponibile) + '</td>' +
        (ivaOn ? '<td class="num" id="iva-cell-' + i + '">' + fmtNum2(calc.iva) + '</td>' : '') +
        '<td><button class="icon-btn danger" title="Rimuovi riga" onclick="removeRiga(' + i + ')">✕</button></td>' +
      '</tr>'
  }
  tb.innerHTML = rows
  recalcFatturaTotals()
}

function onRigaInput(i, field, value) {
  if (!fatturaRighe[i]) return
  fatturaRighe[i][field] = value
  var calc = calcolaRiga(fatturaRighe[i])
  var impCell = el('imp-cell-' + i), ivaCell = el('iva-cell-' + i)
  if (impCell) impCell.textContent = fmtNum2(calc.imponibile)
  if (ivaCell) ivaCell.textContent = fmtNum2(calc.iva)
  recalcFatturaTotals()
}

function addRiga() {
  fatturaRighe.push({ descrizione: '', quantita: 1, prezzo_unitario: 0, codice_iva_id: '' })
  renderRigheEditor()
}
function removeRiga(i) {
  fatturaRighe.splice(i, 1)
  if (!fatturaRighe.length) fatturaRighe.push({ descrizione: '', quantita: 1, prezzo_unitario: 0, codice_iva_id: '' })
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
    cliente_indirizzo: el('f-cli-indirizzo') ? (el('f-cli-indirizzo').value.trim() || null) : null,
    cliente_paese:     (el('f-cli-paese') && el('f-cli-paese').value.trim()) ? el('f-cli-paese').value.trim().toUpperCase().slice(0, 2) : 'CH',
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
    if (!desc) continue   // salta le righe vuote
    var calc = calcolaRiga(r)
    payload.push({
      fattura_id:      fatturaId,
      descrizione:     desc,
      quantita:        safeNum(r.quantita) != null ? safeNum(r.quantita) : 0,
      prezzo_unitario: safeNum(r.prezzo_unitario) != null ? safeNum(r.prezzo_unitario) : 0,
      codice_iva_id:   isSoggettoIva() ? (r.codice_iva_id || null) : null,
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
  var hasRiga = false
  for (var i = 0; i < fatturaRighe.length; i++) {
    if ((fatturaRighe[i].descrizione || '').trim() && safeNum(fatturaRighe[i].prezzo_unitario) != null) { hasRiga = true; break }
  }
  if (!hasRiga) { showFattureBanner('fatture-edit-banner', 'err', 'Aggiungi almeno una riga con descrizione e prezzo.'); return }
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
    sumRows.push(['IBAN', resolveEditorIban() || (aziendaInfo && aziendaInfo.iban) || '— predefinito —'])
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
    if (f.tipo !== 'nota_credito') sumRows.push(['IBAN', (f.iban && String(f.iban).trim()) ? f.iban : ((aziendaInfo && aziendaInfo.iban) || '— predefinito —')])
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
          codice_iva_id: r.codice_iva_id, imponibile_riga: r.imponibile_riga, iva_riga: r.iva_riga, totale_riga: r.totale_riga, ordine: idx
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
function maskIban(iban) {
  var s = String(iban || '').replace(/\s+/g, '')
  return s.length <= 4 ? s : '…' + s.slice(-4)
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
  var defMask = a.iban ? ' (' + maskIban(a.iban) + ')' : ' (non impostato)'
  var out = '<option value="">Predefinito aziendale' + esc(defMask) + '</option>'
  var attive = (ibanRubrica || []).filter(function (x) { return x.attivo })
  for (var i = 0; i < attive.length; i++) {
    var e = attive[i]
    var sel = (currentIban && e.iban === currentIban) ? ' selected' : ''
    out += '<option value="' + esc(e.iban) + '"' + sel + '>' + esc(e.etichetta + ' — ' + maskIban(e.iban)) + '</option>'
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
      '<span class="iban-mask">' + esc(maskIban(e.iban)) + '</span>' +
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
  try {
    const { data, error } = await sb.from('tm_aziende').select('*').eq('id', currentAziendaId).single()
    if (error) throw error
    aziendaInfo = data || {}
  } catch (e) { aziendaInfo = {} }
}
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
    renderFatturaPrint(f, righe || [], rifInfo)
    renderDetailActions(f)
    // FASE 8 — pagamenti e rate. Solo sui documenti veri: su una bozza non
    // esiste ancora niente da pagare.
    try {
      await loadPagamenti(); await loadRate()
      html('fatture-pagamenti', f.stato === 'bozza' ? ''
        : boxPagamentiHtml('tm_conta_fatture', f.id, f.totale, 'entrata', f.cliente_nome))
    } catch (ePag) { html('fatture-pagamenti', '') }
  } catch (e) {
    html('fatture-print', '<p style="color:var(--err)">Errore: ' + esc(e.message) + '</p>')
  }
}

function renderFatturaPrint(f, righe, rifInfo) {
  var a = aziendaInfo || {}
  var v = esc(f.valuta || 'CHF')
  var isNC = f.tipo === 'nota_credito'
  var titolo = isNC ? 'NOTA DI CREDITO' : 'FATTURA'
  var ivaOn = isSoggettoIva()   // interruttore IVA: colonne/riepilogo/numero IVA solo se ON

  // Righe (colonne IVA solo se soggetto IVA)
  var righeHtml = ''
  for (var i = 0; i < righe.length; i++) {
    var r = righe[i]
    righeHtml +=
      '<tr>' +
        '<td>' + esc(r.descrizione || '') + '</td>' +
        '<td class="num">' + fmtNum2(safeNum(r.quantita)) + '</td>' +
        '<td class="num">' + fmtNum2(safeNum(r.prezzo_unitario)) + '</td>' +
        (ivaOn ? '<td>' + esc(ivaLabel(r.codice_iva_id)) + '</td>' : '') +
        '<td class="num">' + fmtNum2(safeNum(r.imponibile_riga)) + '</td>' +
        (ivaOn ? '<td class="num">' + fmtNum2(safeNum(r.iva_riga)) + '</td>' : '') +
      '</tr>'
  }
  var righeHead =
    '<th>Descrizione</th><th class="num">Q.tà</th><th class="num">Prezzo</th>' +
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
  var logoSrc = (a.logo_url && String(a.logo_url).trim()) ? a.logo_url : 'img/logo.png'

  // Intestazione azienda (nome = ragione sociale; indirizzo, NPA città, tel, email)
  var azNome = a.nome || aziendaNome()
  var addrLines = []
  if (a.indirizzo) addrLines.push(a.indirizzo)
  var cittaRiga = [a.cap, a.citta].filter(Boolean).join(' ')
  if (cittaRiga) addrLines.push(cittaRiga)
  var contattiLine = [(a.telefono ? 'Tel. ' + a.telefono : null), a.email].filter(Boolean).join(' · ')
  if (contattiLine) addrLines.push(contattiLine)
  if (ivaOn && a.numero_iva) addrLines.push('IVA ' + a.numero_iva)
  var addrText = addrLines.join('\n')

  // Scadenza (solo fattura)
  var giorni = safeNum(a.termini_pagamento_giorni)
  if (giorni == null) giorni = 30
  var scadenza = isNC ? null : addDays(f.data_emissione, giorni)

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
        '<div class="inv-qrnote">Polizza QR allegata a parte.</div>' +
      '</div>'
  }

  // Piè di pagina centrato
  var footerParts = [esc(azNome)]
  if (a.uid) footerParts.push('UID ' + esc(a.uid))
  if (a.sito_web) footerParts.push(esc(a.sito_web))
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
              (a.forma_giuridica ? ' <span class="inv-forma">' + esc(a.forma_giuridica) + '</span>' : '') +
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
        (f.cliente_indirizzo ? '<div>' + esc(f.cliente_indirizzo) + '</div>' : '') +
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
    '</div>'
  )
}

function renderDetailActions(f) {
  var a = '<div class="form-actions" style="margin-top:0">'
  a += '<button class="btn-primary" onclick="printFattura()">🖨 Stampa</button>'
  // Stesso CSS di stampa, stesso risultato: cambia solo il nome del file proposto.
  a += '<button class="btn-secondary" onclick="scaricaFatturaPDF()">📄 Scarica PDF</button>'
  // FASE 7 — il PDF si allega dopo averlo generato: da li' entra nel pacchetto
  // per il commercialista. Il testo cambia se ce n'e' gia' uno.
  if (f.stato !== 'bozza') {
    a += f.doc_path
      ? '<button class="btn-secondary" onclick="apriSceltaPdfFattura()">📎 PDF allegato — sostituisci</button>'
      : '<button class="btn-secondary" onclick="apriSceltaPdfFattura()">📎 Allega PDF alla fattura</button>'
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

function printFattura() { window.print() }

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
    (pagato || a.data_pagamento ? riga('Data pagamento', a.data_pagamento ? esc(fmtDate(a.data_pagamento)) : '—') : '') +
    (pagato || a.metodo_pagamento ? riga('Metodo', esc(a.metodo_pagamento || '—')) : '') +
    (a.riferimento_pagamento ? riga('Riferimento', esc(a.riferimento_pagamento)) : '') +
    (a.note ? '<div class="ro-sep"></div><div class="ro-section">Note</div><div class="ro-lbl"></div><div class="ro-val" style="font-weight:400;white-space:pre-line">' + esc(a.note) + '</div>' : '') +
    '</div>'

  // Allegato
  if (a.doc_path) {
    body += '<div class="allegato-box" style="margin-top:16px">' +
      '<span aria-hidden="true">📎</span>' +
      '<span class="allegato-nome">' + esc(allegatoNomeFile(a.doc_path)) + '</span>' +
      '<span class="allegato-actions">' +
        '<button class="btn-secondary" onclick="openAllegato(\'' + esc(a.doc_path) + '\', \'acquisti-detail-banner\')">📎 Apri allegato</button>' +
      '</span></div>'
  } else {
    body += '<div class="dim" style="margin-top:16px">Nessun allegato.</div>'
  }
  html('acquisti-detail-body', body)
  // FASE 8 — pagamenti e rate sotto il dettaglio dell'acquisto.
  loadPagamenti().then(function () { return loadRate() }).then(function () {
    html('acquisti-pagamenti',
      boxPagamentiHtml('tm_conta_fatture_acquisto', a.id, a.importo, 'uscita', a.fornitore))
  }).catch(function () { html('acquisti-pagamenti', '') })

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
  if (!currentAziendaId) { html('acquisti-table', '<div class="dim">Accedi per vedere le fatture d\'acquisto.</div>'); return }
  html('acquisti-table', loadingRow('Caricamento…'))
  try {
    const { data, error } = await sb
      .from('tm_conta_fatture_acquisto')
      .select('id, fornitore, numero_fornitore, data, importo, valuta, scadenza, stato_pagamento, doc_path, note, created_at, codice_iva_id, imponibile, iva_importo, data_pagamento, metodo_pagamento, riferimento_pagamento, gruppo_codice, contatto_id')
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
  return allegatoBtn(a.doc_path, 'acquisti-list-banner') +
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

  var metodo = el('acquisti-filtro-metodo') ? el('acquisti-filtro-metodo').value : ''
  // FASE 6A — filtro per cantiere. '__nessuno__' = le spese aziendali, che sono
  // una risposta valida e devono potersi cercare come le altre.
  var cantF = el('acquisti-filtro-cantiere') ? el('acquisti-filtro-cantiere').value : ''
  var list = acquistiList.filter(function (a) {
    if (stato && a.stato_pagamento !== stato) return false
    if (metodo && a.metodo_pagamento !== metodo) return false
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
    var attivo = qv || stato || anno || metodo
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
    // riga secondaria compatta: pagamento (es. "Pagato il 14.07 · Bonifico")
    var paySub = ''
    if (a.stato_pagamento === 'pagato') {
      var parts = []
      if (a.data_pagamento) parts.push('il ' + fmtDate(a.data_pagamento))
      if (a.metodo_pagamento) parts.push(a.metodo_pagamento)
      if (parts.length) paySub = '<span class="cell-sub">' + esc(parts.join(' · ')) + '</span>'
    } else if (a.metodo_pagamento || a.data_pagamento) {
      paySub = '<span class="cell-sub">dati pagamento salvati</span>'
    }
    return '<tr class="row-clickable" onclick="viewAcquisto(\'' + a.id + '\')">' +
      '<td>' + esc(a.fornitore || '') + '</td>' +
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

// ── Stato/dati di pagamento ──────────────────────────────────────────────────
function onAcquistoStatoChange() {
  var pagato = getVal('a-stato') === 'pagato'
  var grp = el('a-pagamento-group')
  if (grp) { if (pagato) grp.classList.remove('pay-dim'); else grp.classList.add('pay-dim') }
  var ids = ['a-data-pagamento', 'a-metodo', 'a-riferimento']
  for (var i = 0; i < ids.length; i++) { var e = el(ids[i]); if (e) e.disabled = !pagato }
  // proposta (non obbligatoria): se segno "pagato" e la data è vuota → oggi
  if (pagato && !getVal('a-data-pagamento')) setVal('a-data-pagamento', oggiISO())
  var hint = el('a-pagamento-hint')
  if (hint) {
    hint.textContent = pagato
      ? 'Data proposta modificabile, non obbligatoria.'
      : 'Si attivano quando lo stato è «Pagato». I dati già inseriti restano salvati.'
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
  var chkGia = el('a-gia-pagata')
  if (chkGia) {
    // La spunta ha senso solo su un documento NUOVO: su uno esistente i
    // pagamenti si aggiungono dalla scheda, uno per uno.
    var nuovo = !editingAcquistoId
    var grp = el('a-gia-pagata-group')
    if (grp) grp.style.display = nuovo ? 'block' : 'none'
    chkGia.checked = false
  }
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
  // pagamento
  setVal('a-data-pagamento',  v.data_pagamento || '')
  setVal('a-metodo',          v.metodo_pagamento || '')
  setVal('a-riferimento',     v.riferimento_pagamento || '')
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
  var box = el('a-allegato-corrente')
  var lbl = el('a-allegato-label')
  if (!box) return
  if (!acquistoDocPath) {
    box.style.display = 'none'
    box.innerHTML = ''
    if (lbl) lbl.innerHTML = 'Allegato documento <span class="dim">(opzionale)</span>'
    return
  }
  box.style.display = 'flex'
  box.innerHTML =
    '<span aria-hidden="true">📎</span>' +
    '<span class="allegato-nome">' + esc(allegatoNomeFile(acquistoDocPath)) + '</span>' +
    '<span class="allegato-actions">' +
      '<button type="button" class="btn-secondary" onclick="openAllegato(\'' + esc(acquistoDocPath) + '\', \'acquisti-edit-banner\')">📎 Apri allegato</button>' +
      '<button type="button" class="btn-secondary" onclick="rimuoviAllegatoAcquisto()">🗑️ Rimuovi allegato</button>' +
    '</span>'
  if (lbl) lbl.innerHTML = 'Sostituisci allegato <span class="dim">(scegli un nuovo file per rimpiazzare quello sopra)</span>'
}

async function rimuoviAllegatoAcquisto() {
  if (!acquistoDocPath) return
  if (!window.confirm('Rimuovere l\'allegato?\n\nIl file verrà cancellato dallo storage: non si può annullare.')) return
  var path = acquistoDocPath
  try {
    await deleteAllegatoStorage(path)
    // se la fattura è già salvata, azzera anche doc_path a database
    if (editingAcquistoId) {
      const { error } = await sb.from('tm_conta_fatture_acquisto')
        .update({ doc_path: null }).eq('id', editingAcquistoId).eq('azienda_id', currentAziendaId).select()
      if (error) throw error
    }
    acquistoDocPath = null
    renderAcquistoAllegatoCorrente()
    showFattureBanner('acquisti-edit-banner', 'ok', 'Allegato rimosso.')
    try { await loadAcquistiList() } catch (_) {}
  } catch (e) {
    console.error('rimuoviAllegatoAcquisto:', e)
    showFattureBanner('acquisti-edit-banner', 'err', 'Rimozione allegato non riuscita: ' + (e.message || e))
  }
}

async function newAcquisto() {
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
  html('acquisti-edit-banner', '')
  try {
    const { data, error } = await sb.from('tm_conta_fatture_acquisto').select('*').eq('id', id).eq('azienda_id', currentAziendaId).single()
    if (error) throw error
    editingAcquistoId = id
    acquistoDocPath = data.doc_path || null
    var vals = {
      fornitore: data.fornitore || '', numero_fornitore: data.numero_fornitore || '',
      data: data.data || '', importo: data.importo == null ? '' : data.importo,
      valuta: data.valuta || 'CHF', scadenza: data.scadenza || '',
      stato_pagamento: data.stato_pagamento || 'aperto', note: data.note || '',
      codice_iva_id: data.codice_iva_id || null,
      imponibile: data.imponibile, iva_importo: data.iva_importo,
      data_pagamento: data.data_pagamento || '', metodo_pagamento: data.metodo_pagamento || '',
      riferimento_pagamento: data.riferimento_pagamento || ''
    }
    acquistoOriginal = vals
    clearAcquistoFileInput()   // PRIMA di mostrare il form: mai dopo
    if (el('acquisti-edit-title')) el('acquisti-edit-title').textContent = 'Modifica fattura d\'acquisto'
    showAcquistiView('edit')
    await ensureContiIva()
    await loadAziendaInfo()
    fillAcquistoForm(vals)
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
    note:             getVal('a-note') || null,
    // IVA (restano NULL se non si sceglie un codice: si salva solo il totale)
    codice_iva_id:    getVal('a-codice-iva') || null,
    imponibile:       impo,
    iva_importo:      ivaI,
    // FASE 8 — data, metodo e riferimento stanno su OGNI pagamento, in
    // tm_conta_pagamenti: un documento pagato in tre volte ha tre metodi, e
    // queste colonne non potrebbero dirlo. Restano nel database come storico
    // (vedi i COMMENT in SQL_FASE8.sql) ma non si scrivono piu'.
    note:                  getVal('a-note') || null
  }
}

// FASE 8 — se alla creazione si spunta «gia' pagata per intero», si registra
// subito un pagamento con la data del documento. Cosi' non si perde
// l'inserimento veloce di una fattura arrivata gia' saldata, senza rimettere
// in piedi la scrittura a mano dello stato.
async function creaPagamentoSeGiaPagata(idAcquisto, importo, dataDoc) {
  var chk = el('a-gia-pagata')
  if (!chk || !chk.checked) return
  var imp = safeNum(importo)
  if (imp == null || imp <= 0) return
  try {
    const { error } = await sb.from('tm_conta_pagamenti').insert({
      azienda_id: currentAziendaId,
      tabella_origine: 'tm_conta_fatture_acquisto',
      id_origine: idAcquisto,
      data: dataDoc || oggiISO(),
      importo: imp,
      note: 'Registrato alla creazione con «gia pagata per intero».',
      created_by: currentUser ? currentUser.id : null
    }).select()
    if (error) throw error
    invalidaCachePagamenti()
  } catch (e) {
    showFattureBanner('acquisti-edit-banner', 'warn',
      'Fattura salvata, ma il pagamento non e stato registrato: ' + (e.message || e) +
      ' — puoi aggiungerlo dalla scheda del documento.')
  }
}

async function saveAcquisto() {
  html('acquisti-edit-banner', '')
  // Il file va letto SUBITO, prima di qualunque await: un re-render successivo
  // non deve poter far sparire la scelta dell'utente.
  var fileInput = el('a-allegato')
  var fileDaCaricare = (fileInput && fileInput.files && fileInput.files.length > 0) ? fileInput.files[0] : null

  var btn = el('acq-save-btn'); if (btn) { btn.disabled = true; btn.textContent = '⏳ Salvataggio…' }
  try {
    var payload = collectAcquisto()
    // allegato (opzionale): in modifica si parte dal doc esistente
    var doc_path = editingAcquistoId ? acquistoDocPath : null
    var allegatoFallito = false
    if (fileDaCaricare) {
      try {
        doc_path = await uploadAllegato(fileDaCaricare)
      } catch (uploadErr) {
        allegatoFallito = uploadErr.message || 'allegato non caricato'
        console.error('Allegato acquisto — upload fallito:', uploadErr)
      }
    }
    payload.doc_path = doc_path

    if (editingAcquistoId) {
      const { error } = await sb.from('tm_conta_fatture_acquisto').update(payload).eq('id', editingAcquistoId).eq('azienda_id', currentAziendaId).select()
      if (error) throw error
    } else {
      payload.created_by = currentUser ? currentUser.id : null
      const { data, error } = await sb.from('tm_conta_fatture_acquisto').insert(payload).select()
      if (error) throw error
      editingAcquistoId = data && data[0] ? data[0].id : null
      // FASE 8 — se era spuntato «gia pagata per intero», il pagamento si crea
      // adesso: prima non esisteva ancora l'id del documento a cui collegarlo.
      if (editingAcquistoId) {
        await creaPagamentoSeGiaPagata(editingAcquistoId, payload.importo, payload.data)
      }
    }
    acquistoDocPath = doc_path
    acquistoOriginal = null
    clearAcquistoFileInput()   // caricato (o fallito): l'input riparte pulito

    await loadAcquistiList()
    try { await refreshDaClassificareCount() } catch (_) {}
    acquistiBackToList()
    if (allegatoFallito) {
      showFattureBanner('acquisti-list-banner', 'warn', '⚠️ Fattura salvata MA allegato NON caricato: ' + allegatoFallito)
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
  if (img.src.indexOf('img/logo.png') === -1) {
    img.src = 'img/logo.png'         // primo fallback: logo statico del progetto
  } else {
    img.onerror = null
    img.style.display = 'none'       // fallback finale: nascondi
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
  setVal('imp-paese',    a.paese || 'CH')
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
    paese:           (getVal('imp-paese') || 'CH').toUpperCase().slice(0, 2),
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

    // Upload allegato (opzionale). In modifica si parte dall'allegato esistente.
    var doc_path = editingMovimentoId ? editingDocPath : null
    var allegatoFallito = false
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
      try {
        doc_path = await uploadAllegato(fileInput.files[0])
      } catch (uploadErr) {
        allegatoFallito = uploadErr.message || 'allegato non caricato'
      }
    }

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
      doc_path:      doc_path,
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
  if (!currentAziendaId) {
    html('inserimento-recenti', '<div class="dim" style="padding:8px 0">Accedi per vedere i movimenti.</div>')
    return
  }
  html('inserimento-recenti', loadingRow('Caricamento…'))
  try {
    const { data, error } = await sb
      .from('tm_conta_movimenti_propri')
      .select('id, data, descrizione, importo, valuta, ente_fornitore, ricorrente, periodicita, doc_path')
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
        .select('origine_id, stato')
        .eq('azienda_id', currentAziendaId)
        .eq('origine_tipo', 'proprio')
        .in('origine_id', ids)
      if (!clsErr && cls) {
        for (var ci = 0; ci < cls.length; ci++) {
          statoById[cls[ci].origine_id] = cls[ci].stato
          var key = 'proprio:' + cls[ci].origine_id
          if (!classByKey[key]) classByKey[key] = {}
          classByKey[key].stato = cls[ci].stato
        }
      }
    } catch (_) { /* non bloccante */ }

    var rows = data.map(function (m, i) {
      var importoStr = fmtImporto(m.importo, m.valuta)
      var bloccato = statoById[m.id] === 'bloccato'
      var azioni = allegatoBtn(m.doc_path, 'inserimento-banner') + (bloccato
        ? '<span class="lock-tag" title="Periodo consegnato — sola lettura">🔒 Consegnato</span>'
        : '<button class="icon-btn" title="Modifica" onclick="editRecente(' + i + ')">✏️ Modifica</button>' +
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
      '<div class="card-title">📋 Piano dei conti CH — Kontenrahmen KMU ' + badge('ok', conti.length + ' conti') + '</div>' +
      '<div class="table-wrap"><table><thead><tr><th style="width:90px">Conto</th><th>Descrizione</th><th style="width:110px">Tipo</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="sql-tip">💡 Piano dei conti provvisorio. Il piano definitivo è fornito dal commercialista.</div>' +
    '</div>'
  )
}

// ─── Codici IVA (Fase 1) ──────────────────────────────────────────────────────
async function renderCodiciIVA() {
  html('fase1-iva', loadingRow('Caricamento codici IVA…'))
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
      '<div class="card-title">🏷 Codici IVA CH ' + badge('ok', codici.length + ' codici') + '</div>' +
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
let rubricaSuggest  = { prefix: null, list: [], hi: -1 }   // stato del menu a tendina

// ── Caricamento dati di base ─────────────────────────────────────────────────

// I 9 gruppi di costo/ricavo. Tabella condivisa, si carica una volta sola.
async function loadGruppi() {
  if (gruppiCache) return gruppiCache
  try {
    const { data, error } = await sb
      .from('tm_conta_gruppi')
      .select('codice, nome, esempi, ordine')
      .order('ordine')
    if (error) throw error
    gruppiCache = data || []
  } catch (e) {
    gruppiCache = []
    console.warn('Gruppi non caricati:', e.message || e)
  }
  return gruppiCache
}

// Opzioni per un menu «gruppo». La voce vuota è esplicita: «nessun gruppo» è
// una scelta legittima, non un campo dimenticato.
function buildGruppoOptions(selected) {
  var out = '<option value="">— nessun gruppo —</option>'
  ;(gruppiCache || []).forEach(function (g) {
    out += '<option value="' + esc(g.codice) + '"' +
           (g.codice === selected ? ' selected' : '') + '>' +
           esc(g.codice + ' · ' + g.nome) + '</option>'
  })
  return out
}

async function riempiSelectGruppi(id, selected) {
  await loadGruppi()
  var sel = el(id)
  if (sel) sel.innerHTML = buildGruppoOptions(selected || '')
}

async function loadContatti(force) {
  if (contattiCache && !force) return contattiCache
  if (!currentAziendaId) { contattiCache = []; return contattiCache }
  const { data, error } = await sb
    .from('tm_contatti')
    .select('id, categoria, ragione_sociale, nome, cognome, indirizzo, cap, citta, paese,' +
            ' telefono, email, sito_web, uid_partita_iva, iban, gruppo_default,' +
            ' giorni_pagamento, note, attivo')
    .eq('azienda_id', currentAziendaId)
    .order('ragione_sociale', { nullsFirst: false })
  if (error) throw error
  contattiCache = data || []
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
  var lista  = el('rubrica-lista-view')
  var scheda = el('rubrica-scheda-view')
  if (lista)  lista.style.display  = (quale === 'lista')  ? 'block' : 'none'
  if (scheda) scheda.style.display = (quale === 'scheda') ? 'block' : 'none'
}

function setRubricaTab(cat) {
  rubricaTab = cat
  ;['cliente', 'fornitore', 'collaboratore', 'generico'].forEach(function (c) {
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
    var n = tutti.filter(function (x) { return x.categoria === c && x.attivo !== false }).length
    var b = el('cnt-' + c)
    if (b) b.textContent = String(n)
  })

  var list = tutti.filter(function (c) {
    if (c.categoria !== rubricaTab) return false
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
      : 'Nessun contatto in questa scheda. Premi «➕ Nuovo contatto» per aggiungerne uno.'
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
    azioni += '<button class="azione-rapida" onclick="event.stopPropagation(); apriContatto(\'' + c.id + '\')">✏️ Apri scheda</button>'

    return '<div class="contatto-row' + (c.attivo === false ? ' inattivo' : '') + '"' +
             ' onclick="apriContatto(\'' + c.id + '\')" role="button" tabindex="0"' +
             ' onkeydown="if(event.key===\'Enter\'){apriContatto(\'' + c.id + '\')}">' +
             '<div class="contatto-main">' +
               '<div class="contatto-nome">' + esc(nome) +
                 (c.attivo === false ? ' ' + badge('warn', '📦 Archiviato') : '') + '</div>' +
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
  if (el('c-categoria')) el('c-categoria').value = categoriaIniziale || rubricaTab
  if (el('c-paese'))     el('c-paese').value = 'CH'
  if (el('c-attivo'))    el('c-attivo').checked = true
  if (el('contatto-card-title')) el('contatto-card-title').textContent = '➕ Nuovo contatto'
  if (el('contatto-submit-btn')) el('contatto-submit-btn').textContent = '💾 Salva contatto'
  html('contatto-banner', '')
  renderAzioniRapide()
  mostraRubricaVista('scheda')
  if (el('c-ragione')) el('c-ragione').focus()
}

async function apriContatto(id) {
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
  if (el('c-paese'))     el('c-paese').value     = c.paese || 'CH'
  if (el('c-telefono'))  el('c-telefono').value  = c.telefono || ''
  if (el('c-email'))     el('c-email').value     = c.email || ''
  if (el('c-sito'))      el('c-sito').value      = c.sito_web || ''
  if (el('c-uid'))       el('c-uid').value       = c.uid_partita_iva || ''
  if (el('c-iban'))      el('c-iban').value      = c.iban || ''
  if (el('c-giorni'))    el('c-giorni').value    = c.giorni_pagamento == null ? '' : c.giorni_pagamento
  if (el('c-note'))      el('c-note').value      = c.note || ''
  if (el('c-attivo'))    el('c-attivo').checked  = c.attivo !== false
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
  var out = ''
  if (tel) {
    out += '<a class="azione-rapida" href="tel:' + esc(tel.replace(/\s/g, '')) + '">📞 Chiama ' + esc(tel) + '</a> '
  }
  if (email) {
    out += '<a class="azione-rapida" href="mailto:' + esc(email) + '">✉️ Scrivi mail a ' + esc(email) + '</a>'
  }
  if (!out) {
    out = '<div class="dim" style="font-size:12px">Inserisci telefono o email: qui compaiono i pulsanti per chiamare e scrivere.</div>'
  }
  html('contatto-azioni-rapide', out)
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
  return {
    azienda_id:      currentAziendaId,
    categoria:       getVal('c-categoria') || 'generico',
    ragione_sociale: ragione || null,
    nome:            getVal('c-nome') || null,
    cognome:         cognome || null,
    indirizzo:       getVal('c-indirizzo') || null,
    cap:             getVal('c-cap') || null,
    citta:           getVal('c-citta') || null,
    paese:           (getVal('c-paese') || 'CH').toUpperCase().slice(0, 2),
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
}

async function salvaContatto(event) {
  if (event) event.preventDefault()
  var btn = el('contatto-submit-btn')
  var testoBtn = btn ? btn.textContent : ''
  html('contatto-banner', '')
  try {
    var payload = raccogliContatto()
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
  return (prefix === 'a')
    ? { testo: 'a-fornitore', hidden: 'a-contatto-id', suggest: 'a-fornitore-suggest',
        legato: 'a-contatto-legato', gruppo: 'a-gruppo', scadenza: 'a-scadenza',
        data: 'a-data', categoria: 'fornitore' }
    : { testo: 'f-ente', hidden: 'f-contatto-id', suggest: 'f-ente-suggest',
        legato: 'f-contatto-legato', gruppo: 'f-gruppo', scadenza: 'f-scadenza',
        data: 'f-data', categoria: 'fornitore' }
}

function chiudiSuggerimenti(prefix) {
  var c = rubricaCampi(prefix)
  html(c.suggest, '')
  rubricaSuggest = { prefix: null, list: [], hi: -1 }
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

  var out = trovati.map(function (x, i) {
    return '<button type="button" class="suggest-item" role="option"' +
           ' onclick="scegliContatto(\'' + prefix + '\', \'' + x.id + '\')">' +
           esc(contattoNome(x)) +
           '<span class="s-sub">' + esc(contattoSub(x) || x.categoria) + '</span>' +
           '</button>'
  }).join('')

  // La creazione al volo è sempre in fondo: si crea solo se davvero non c'è.
  out += '<button type="button" class="suggest-item suggest-new"' +
         ' onclick="creaContattoAlVolo(\'' + prefix + '\')">' +
         '➕ Crea «' + esc(getVal(c.testo)) + '» come nuovo contatto' +
         '<span class="s-sub">lo salva in rubrica e lo collega a questo documento</span>' +
         '</button>'

  html(c.suggest, out)
  rubricaSuggest = { prefix: prefix, list: trovati, hi: -1 }
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

  renderContattoLegato(prefix, x, compilati)
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
function nomeFilePdfFattura(f) {
  if (!f) return 'Fattura'
  var tipo = (f.tipo === 'nota_credito') ? 'NotaCredito' : 'Fattura'
  var num  = f.numero || 'bozza'
  var chi  = (f.cliente_nome || '')
    .normalize ? (f.cliente_nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '') : (f.cliente_nome || '')
  // Solo la prima parola del cliente: il nome del file resta corto e leggibile
  chi = chi.replace(/[^A-Za-z0-9 ]/g, '').trim().split(/\s+/)[0] || ''
  return [tipo, num, chi].filter(Boolean).join('_').replace(/\s+/g, '_')
}

function scaricaFatturaPDF() {
  var f = currentDetailFattura
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
  if (flussiCache && !force) return flussiCache
  if (!currentAziendaId) { flussiCache = []; return flussiCache }
  const { data, error } = await sb
    .from('v_conta_flussi')
    .select('id_origine, tabella_origine, origine_tipo, verso, controparte_nome, descrizione,' +
            ' data_documento, data_scadenza, importo_totale, importo_iva, stato_pagamento,' +
            ' data_pagamento, conto_codice, conto_descrizione, gruppo_codice, gruppo_manuale,' +
            ' gruppo_da_conto, stato_conferma, importo_pagato, residuo, prossima_rata')
    .eq('azienda_id', currentAziendaId)
  if (error) throw error
  flussiCache = data || []
  return flussiCache
}

async function loadIvaPeriodi(force) {
  if (ivaPeriodiCache && !force) return ivaPeriodiCache
  try {
    const { data, error } = await sb
      .from('tm_conta_iva_periodi')
      .select('id, valido_da, valido_a, metodo, aliquota_saldo, criterio')
      .eq('azienda_id', currentAziendaId)
      .order('valido_da')
    if (error) throw error
    ivaPeriodiCache = data || []
  } catch (e) {
    ivaPeriodiCache = []
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
  impostazioniConta = {}
  if (!currentAziendaId) return impostazioniConta
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
  var icona = tipo === 'ok' ? '✅' : tipo === 'warn' ? '⚠️' : '❌'
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

async function applicaRispostaAI() {
  html('ponte-ai-note', '')
  var testo = el('ponte-ai-testo') ? el('ponte-ai-testo').value : ''
  if (!String(testo).trim()) {
    showPonteBanner('err', 'La casella è vuota: incolla la risposta di Claude prima di premere «Compila il modulo».')
    return
  }

  var dati
  try {
    dati = estraiJson(testo)
  } catch (e) {
    // Regola non negoziabile: se il JSON e' rotto NON si compila niente.
    // Mezzo modulo riempito e' peggio di un modulo vuoto, perche' sembra a posto.
    showPonteBanner('err', e.message)
    return
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

  chiudiIncollaRisposta()
  showPonteBanner('ok', 'Modulo compilato dalla lettura. Controlla i campi prima di salvare.')
  renderNoteLettura(dati.note_lettura, scartati, avvisoScarto, conto)
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
  if (speseCantiereCache && !force) return speseCantiereCache
  try {
    const { data, error } = await sb.from('spese')
      .select('id, cantiere_id, data, descrizione, importo, valuta, note')
      .limit(2000)
    if (error) throw error
    speseCantiereCache = data || []
  } catch (e) {
    speseCantiereCache = []
    console.warn('Spese di cantiere non lette:', e.message || e)
  }
  return speseCantiereCache
}

async function loadRegiaCantiere(force) {
  if (regiaCantiereCache && !force) return regiaCantiereCache
  try {
    const { data, error } = await sb.from('regia')
      .select('id, cantiere_id, data, descrizione, quantita, um, prezzo_unitario, fatturato')
      .limit(2000)
    if (error) throw error
    regiaCantiereCache = data || []
  } catch (e) {
    regiaCantiereCache = []
    console.warn('Regia non letta:', e.message || e)
  }
  return regiaCantiereCache
}

async function loadGiornate(force) {
  if (giornateCache && !force) return giornateCache
  try {
    const { data, error } = await sb.from('giornate')
      .select('id, cantiere_id, data, ore_totali, note')
      .limit(5000)
    if (error) throw error
    giornateCache = data || []
  } catch (e) {
    giornateCache = []
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
      path: f.doc_path || null,
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
      path: x.doc_path || null, id: x.id,
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
      path: m.doc_path || null, id: m.origine_id,
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
      path: sp.foto_path || null, id: sp.id,
      bucket: 'cantiere-spese',
      motivoSeManca: 'foto mai scattata'
    })
  })

  // Il nome del file si assegna QUI, una volta sola: la stessa stringa andra'
  // nella cella ALLEGATO dell'Excel e nel percorso dentro lo ZIP.
  voci.forEach(function (v) {
    if (!v.path) { v.nomeNelloZip = null; return }
    var est = estensioneDa(v.path, v.sezione === 'spese_cantiere' ? 'jpg' : 'pdf')
    v.nomeNelloZip = nomeUnico(usati, v.sezione, nomeFilePacchetto(v.data, v.chi, v.importo, est))
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
    var conAllegato = r.voci.filter(function (v) { return !!v.path })
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
    conAllegato.forEach(function (v) { stimaMB += (v.sezione === 'spese_cantiere') ? 3 : 0.35 })
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
      '<div class="exp-riga"><span>Giustificativi da allegare</span><span><strong>' + conAllegato.length + '</strong></span></div>' +
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
    var conAllegato = r.voci.filter(function (v) { return !!v.path })
    var scaricati = 0

    // ── Gli allegati, uno per uno ──────────────────────────────────────────
    // try/catch INTORNO A OGNI FILE: un allegato che non si scarica finisce
    // fra i mancanti e il pacchetto si genera lo stesso. Se bastasse un file
    // rotto a far fallire tutto, il pacchetto non si potrebbe mai consegnare.
    for (var i = 0; i < conAllegato.length; i++) {
      if (pacchettoAnnullato) { bannerPacchetto('warn', 'Generazione annullata: nessun file è stato scaricato.'); return }
      var v = conAllegato[i]
      mostraProgressoPacchetto('Scarico allegato ' + (i + 1) + ' di ' + conAllegato.length + '…',
                               5 + Math.round((i / conAllegato.length) * 80))
      try {
        var bucket = v.bucket || STORAGE_BUCKET
        const { data: blob, error } = await sb.storage.from(bucket).download(v.path)
        if (error) throw error
        if (!blob) throw new Error('file vuoto')
        zip.file(v.nomeNelloZip, blob)
        scaricati++
      } catch (eFile) {
        // Il file resta nell'Excel con la cella vuota, e il motivo va scritto.
        v.nomeNelloZip = null
        mancanti.push({ data: v.data, chi: v.chi, importo: v.importo,
                        motivo: 'file non scaricabile (' + (eFile.message || eFile) + ')' })
      }
    }

    // I documenti che non avevano proprio un file
    r.voci.filter(function (v) { return !v.path }).forEach(function (v) {
      mancanti.push({ data: v.data, chi: v.chi, importo: v.importo, motivo: v.motivoSeManca })
    })

    if (pacchettoAnnullato) { bannerPacchetto('warn', 'Generazione annullata: nessun file è stato scaricato.'); return }

    // ── L'Excel, con la colonna ALLEGATO ───────────────────────────────────
    mostraProgressoPacchetto('Creazione dell\'Excel…', 88)
    var mappa = {}
    r.voci.forEach(function (v) { if (v.nomeNelloZip) mappa[v.sezione + ':' + v.id] = v.nomeNelloZip })
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
      aoa.push([v.data || '', v.chi || '', v.etichetta || '', safeNum(v.importo) || 0, v.nomeNelloZip || ''])
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

function apriSceltaPdfFattura() {
  var inp = el('fat-pdf-input')
  if (inp) { inp.value = ''; inp.click() }
}

async function allegaPdfFattura(input) {
  if (!input || !input.files || !input.files.length) return
  var file = input.files[0]
  var f = currentDetailFattura
  if (!f) return

  html('fatture-allegato-banner', loadingRow('Caricamento del PDF…'))
  try {
    if (file.type && file.type.indexOf('pdf') === -1) {
      throw new Error('Serve un file PDF. Genera prima il documento con «Scarica PDF».')
    }
    var path = await uploadAllegato(file)      // stesso bucket e stesso formato degli acquisti
    const { error } = await sb.from('tm_conta_fatture')
      .update({ doc_path: path })
      .eq('id', f.id).eq('azienda_id', currentAziendaId).select()
    if (error) throw error

    currentDetailFattura.doc_path = path
    exportDataset = null                        // il pacchetto deve rileggere
    html('fatture-allegato-banner',
      '<div class="fase-banner ok"><span class="icon" aria-hidden="true">✅</span>' +
      '<div class="msg">PDF allegato alla fattura. Da adesso entra nel pacchetto per il commercialista.</div></div>')
    await loadFattureList()
    await viewFattura(f.id)
  } catch (e) {
    var m = String(e.message || e)
    // Se il trigger di immutabilita' rifiuta, NON si aggira: si segnala.
    if (m.indexOf('non si puo modificare') !== -1 || m.indexOf('sola lettura') !== -1) {
      m = 'Il database ha rifiutato la modifica come se doc_path fosse un campo congelato. ' +
          'Non va aggirato: segnalalo, perché vuol dire che SQL_FASE7.sql non è stato applicato ' +
          'oppure che il trigger è diverso da quello previsto. Messaggio: ' + m
    }
    html('fatture-allegato-banner',
      '<div class="fase-banner err"><span class="icon" aria-hidden="true">❌</span>' +
      '<div class="msg">' + esc(m) + '</div></div>')
  } finally {
    if (input) input.value = ''
  }
}


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
  if (pagamentiCache && !force) return pagamentiCache
  if (!currentAziendaId) { pagamentiCache = []; return pagamentiCache }
  try {
    const { data, error } = await sb.from('tm_conta_pagamenti')
      .select('id, tabella_origine, id_origine, data, importo, metodo, riferimento, note')
      .eq('azienda_id', currentAziendaId)
      .order('data')
    if (error) throw error
    pagamentiCache = data || []
  } catch (e) {
    pagamentiCache = []
    console.warn('Pagamenti non letti:', e.message || e)
  }
  return pagamentiCache
}

async function loadRate(force) {
  if (rateCache && !force) return rateCache
  if (!currentAziendaId) { rateCache = []; return rateCache }
  try {
    const { data, error } = await sb.from('tm_conta_rate')
      .select('id, tabella_origine, id_origine, numero_rata, data_prevista, importo_previsto, pagamento_id, note')
      .eq('azienda_id', currentAziendaId)
      .order('numero_rata')
    if (error) throw error
    rateCache = data || []
  } catch (e) {
    rateCache = []
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
async function apriRegistraPagamento(tabella, id, importoDoc, verso, nome) {
  docPagamentoCorrente = { tabella: tabella, id: id, importo: safeNum(importoDoc) || 0,
                           verso: verso || 'uscita', nome: nome || '' }
  await loadPagamenti(true)
  await loadRate(true)

  var gia = totalePagatoDi(tabella, id)
  var residuo = docPagamentoCorrente.importo - gia

  html('pag-riepilogo',
    rigaPag('Importo del documento', docPagamentoCorrente.importo) +
    rigaPag('Già pagato', gia) +
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

    const { data: creato, error } = await sb.from('tm_conta_pagamenti').insert({
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

    // La rata scelta si collega al pagamento appena creato.
    var idRata = getVal('pag-rata')
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
    if (btn) { btn.disabled = false; btn.textContent = '💾 Registra' }
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
        'onclick="eliminaPagamento(\'' + esc(p.id) + '\', \'' + esc(fmtNumIt(p.importo)) +
        '\', \'' + esc(fmtDate(p.data)) + '\')">🗑️ Elimina</button>' +
    '</div>'
  }).join('')
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
  var passo = (ogni === 'trimestre') ? 3 : 1
  var d = new Date(y, m + indice * passo, 1)
  // Se il giorno non esiste nel mese (31 in un mese di 30), si prende l'ultimo.
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
      rigaPag('Pagato', gia) +
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
    '</div>' +
    (rate.length
      ? '<div class="card-title" style="margin-top:16px">📅 Rate</div>' + elencoRateHtml(tabella, id)
      : '') +
  '</div>'
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
      if (pageId === 'inserimento') { loadRecentiInseriti() }
      if (pageId === 'export')      { initExportPage() }
      if (pageId === 'fatture')     { initFatturePage() }
      if (pageId === 'acquisti')    { initAcquistiPage() }
      if (pageId === 'rubrica')     { initRubricaPage() }
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
    clsOverlay.addEventListener('click', function (e) {
      if (e.target === clsOverlay) closeClassifyPanel()
    })
  }
  var storiaOverlay = el('storia-overlay')
  if (storiaOverlay) {
    storiaOverlay.addEventListener('click', function (e) {
      if (e.target === storiaOverlay) closeStoria()
    })
  }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return
    var so = el('storia-overlay')
    if (so && so.style.display !== 'none') { closeStoria(); return }
    var o = el('classify-overlay')
    if (o && o.style.display !== 'none') { closeClassifyPanel(); return }
    // FASE 4 — la finestrella delle scadenze si chiude anche con Esc
    var sc = el('scadenze-overlay')
    if (sc && sc.style.display !== 'none') chiudiFinestraScadenze()
  })

  // Mostra istruzioni SQL (visibili prima dell'auth)
  renderSqlInstructions()

  // Ascolta cambi auth
  sb.auth.onAuthStateChange(function (event, session) {
    if (event === 'SIGNED_IN' && session && session.user) {
      currentUser = session.user
      loadAziendaId().then(function () {
        updateSidebarAuth()
        refreshDaClassificareCount()
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
        showPage('setup')
        runSetupCheck()
        refreshDaClassificareCount()
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
  ['f', 'a'].forEach(function (prefix) {
    var c = rubricaCampi(prefix)
    var box = el(c.suggest)
    if (!box || !box.innerHTML) return
    var campo = el(c.testo)
    if (box.contains(ev.target) || (campo && campo === ev.target)) return
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
