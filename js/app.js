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
        .in('stato', ['emessa', 'pagata'])
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

  return movimenti
}

// ─── CANALE B — legge tm_conta_movimenti_propri ────────────────────────────
async function loadCanalB() {
  if (!currentAziendaId) return []
  try {
    const { data, error } = await sb
      .from('tm_conta_movimenti_propri')
      .select('id, data, descrizione, ente_fornitore, importo, valuta, ricorrente, periodicita, doc_path, created_at')
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
      .select('id, codice_conto, descrizione, tipo, azienda_id, attivo')
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
  var out = includeGenerale ? '<option value="">Ditta (generale)</option>' : ''
  var list = cantieriCache || []
  var found = false
  for (var i = 0; i < list.length; i++) {
    var c = list[i]
    var sel = (selectedId && c.id === selectedId) ? ' selected' : ''
    if (sel) found = true
    out += '<option value="' + esc(c.id) + '"' + sel + '>' + esc(c.nome || c.id) + '</option>'
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
  if (s.conto_id) el('cls-conto').innerHTML = buildContoOptions('', s.conto_id)
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
      .select('id, data, descrizione, ente_fornitore, importo, valuta, ricorrente, periodicita, doc_path')
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
      periodicita: data.periodicita || 'mensile'
    }
    editingMovimentoId = id
    originalEditValues = vals
    editingDocPath = data.doc_path || null

    showPage('inserimento')
    fillFormFromValues(vals)
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
  if (!id) return 'Ditta (generale)'
  var c = (cantieriCache || []).filter(function (x) { return x.id === id })[0]
  return c ? (c.nome || c.id) : String(id)
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

function initExportPage() {
  if (!el('exp-da') || !el('exp-a')) return
  if (!el('exp-da').value) {
    var now = new Date()
    el('exp-da').value = now.getFullYear() + '-01-01'
    el('exp-a').value = now.toISOString().split('T')[0]
  }
  html('export-banner', '')
  updateExportPreview()
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
    var pairs = await getClassificatiNelPeriodo(da, a)
    exportPeriodRows = pairs
    var tot = 0, nBlocc = 0
    for (var i = 0; i < pairs.length; i++) {
      tot += (safeNum(pairs[i].cls.imponibile) || 0) + (safeNum(pairs[i].cls.iva_importo) || 0)
      if (pairs[i].cls.stato === 'bloccato') nBlocc++
    }
    prev.innerHTML =
      '<strong>' + pairs.length + '</strong> movimenti classificati nel periodo · ' +
      'totale <span class="exp-amount">' + fmtNum2(round2(tot)) + ' CHF</span>' +
      (nBlocc ? ' · ' + nBlocc + ' già consegnati 🔒' : '')
  } catch (e) {
    exportPeriodRows = []
    prev.innerHTML = '<span style="color:var(--err)">Errore anteprima: ' + esc(e.message) + '</span>'
  }
}

async function exportExcel() {
  if (typeof XLSX === 'undefined') { showExportBanner('err', 'Libreria Excel non caricata: controlla la connessione e ricarica la pagina.'); return }
  var da = el('exp-da').value, a = el('exp-a').value
  if (!validPeriodo(da, a)) return
  var btn = el('exp-xlsx-btn')
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Genero…' }
  try {
    var pairs = await getClassificatiNelPeriodo(da, a)
    if (!pairs.length) { showExportBanner('warn', 'Nessun movimento classificato nel periodo: niente da esportare.'); return }
    var sheets = buildExportAoa(pairs)
    var wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheets.movimenti), 'Movimenti')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheets.perConto), 'Riepilogo per conto')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheets.perIva), 'Riepilogo per IVA')
    XLSX.writeFile(wb, exportFileName(da, a, 'xlsx'))
    showExportBanner('ok', 'Excel generato: ' + pairs.length + ' movimenti. Controlla i download del browser.')
  } catch (e) {
    showExportBanner('err', 'Export Excel: ' + e.message)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📊 Genera Excel (.xlsx)' }
  }
}

async function exportCsv() {
  if (typeof XLSX === 'undefined') { showExportBanner('err', 'Libreria CSV non caricata: controlla la connessione e ricarica la pagina.'); return }
  var da = el('exp-da').value, a = el('exp-a').value
  if (!validPeriodo(da, a)) return
  var btn = el('exp-csv-btn')
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Genero…' }
  try {
    var pairs = await getClassificatiNelPeriodo(da, a)
    if (!pairs.length) { showExportBanner('warn', 'Nessun movimento classificato nel periodo: niente da esportare.'); return }
    var sheets = buildExportAoa(pairs)
    var ws = XLSX.utils.aoa_to_sheet(sheets.movimenti)
    var csv = '﻿' + XLSX.utils.sheet_to_csv(ws, { FS: ';' })   // BOM + ';' per Excel europeo
    downloadBlob(csv, exportFileName(da, a, 'csv'), 'text/csv;charset=utf-8;')
    showExportBanner('ok', 'CSV generato: ' + pairs.length + ' movimenti (foglio «Movimenti»).')
  } catch (e) {
    showExportBanner('err', 'Export CSV: ' + e.message)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📄 Genera CSV' }
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
  var map  = { bozza: 'info', emessa: 'warn', pagata: 'ok', annullata: 'err' }
  var icon = { bozza: '✏️', emessa: '📨', pagata: '✅', annullata: '🚫' }
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
      .select('id, numero, anno, data_emissione, cliente_nome, totale, valuta, stato, tipo, created_at')
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
  var anno  = el('fatture-filtro-anno') ? el('fatture-filtro-anno').value : ''
  var q = el('fatture-search') ? el('fatture-search').value.trim().toLowerCase() : ''

  // mostra/nasconde il pulsante di pulizia ricerca
  var clearBtn = el('fatture-search-clear')
  if (clearBtn) clearBtn.style.display = q ? 'flex' : 'none'

  // filtri esistenti (stato/anno)
  var list = fattureList.filter(function (f) {
    if (stato && f.stato !== stato) return false
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
    var filtroAttivo = q || stato || anno
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
      '<td>' + statoFatturaBadge(f.stato) + '</td>' +
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
  el('f-fat-data').value = new Date().toISOString().split('T')[0]
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
    el('f-fat-data').value = f.data_emissione || new Date().toISOString().split('T')[0]
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

  if (!window.confirm('Emettere il documento? Verrà assegnato il numero progressivo e diventerà DEFINITIVO (sola lettura). Per correggere si usa una nota di credito.')) return

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
  if (!window.confirm('Emettere il documento? Verrà assegnato il numero e diventerà definitivo (sola lettura).')) return
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

async function setPagata(id, toPagata) {
  html('fatture-detail-banner', loadingRow('Aggiornamento stato…'))
  try {
    const { error } = await sb.from('tm_conta_fatture').update({ stato: toPagata ? 'pagata' : 'emessa' }).eq('id', id).eq('azienda_id', currentAziendaId).select()
    if (error) throw error
    await loadFattureList()
    await viewFattura(id)
  } catch (e) {
    showFattureBanner('fatture-detail-banner', 'err', 'Aggiornamento stato: ' + friendlyFatturaError(e))
  }
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
      data_emissione:    new Date().toISOString().split('T')[0],
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
  if (f.stato === 'bozza') {
    a += '<button class="btn-secondary" onclick="editFattura(\'' + f.id + '\')">✏️ Modifica bozza</button>'
    a += '<button class="btn-primary" onclick="emettiFatturaById(\'' + f.id + '\')">📨 Emetti</button>'
    // Elimina SOLO sulle bozze (numero non ancora assegnato). Mai sulle emesse.
    a += '<button class="btn-secondary" onclick="deleteBozza(\'' + f.id + '\')">🗑️ Elimina</button>'
  } else if (f.stato === 'emessa') {
    a += '<button class="btn-secondary" onclick="setPagata(\'' + f.id + '\', true)">✅ Segna come pagata</button>'
    if (f.tipo !== 'nota_credito') a += '<button class="btn-secondary" onclick="creaNotaCredito(\'' + f.id + '\')">↩️ Crea nota di credito</button>'
  } else if (f.stato === 'pagata') {
    a += '<button class="btn-secondary" onclick="setPagata(\'' + f.id + '\', false)">↩️ Segna non pagata</button>'
    if (f.tipo !== 'nota_credito') a += '<button class="btn-secondary" onclick="creaNotaCredito(\'' + f.id + '\')">↩️ Crea nota di credito</button>'
  }
  a += '<button class="btn-secondary" onclick="fattureBackToList()">← Indietro</button>'
  a += '</div>'
  html('fatture-detail-actions', a)
}

function printFattura() { window.print() }

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

// data 'YYYY-MM-DD' + giorni → 'YYYY-MM-DD' (per la scadenza fattura)
function addDays(dateStr, days) {
  if (!dateStr) return null
  var d = new Date(dateStr + 'T00:00:00')
  if (isNaN(d.getTime())) return null
  d.setDate(d.getDate() + (parseInt(days, 10) || 0))
  return d.toISOString().split('T')[0]
}

function setVal(id, val) { var e = el(id); if (e) e.value = (val == null ? '' : val) }
function getVal(id) { var e = el(id); return e ? e.value.trim() : '' }

async function initImpostazioniPage() {
  if (!currentAziendaId) {
    showFattureBanner('impostazioni-banner', 'err', 'Azienda non trovata: rieffettua il login.')
    return
  }
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
    var missing = impostazioniMancanti(aziendaInfo)
    if (missing.length) {
      showFattureBanner('impostazioni-banner', 'warn', 'Salvato. ⚠️ Per fatture complete mancano ancora: ' + missing.join(', ') + '.')
    } else {
      showFattureBanner('impostazioni-banner', 'ok', 'Impostazioni salvate. I dati compaiono nelle nuove fatture.')
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
  if (el('f-data')) el('f-data').value = new Date().toISOString().split('T')[0]
  html('inserimento-banner', '')
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

    var payload = {
      azienda_id:    currentAziendaId,
      data:          dataVal,
      descrizione:   desc,
      ente_fornitore: ente || null,
      importo:       importoVal,
      valuta:        valuta,
      ricorrente:    ricorrente,
      periodicita:   periodicita,
      doc_path:      doc_path
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
      const { error } = await sb
        .from('tm_conta_movimenti_propri')
        .insert(payload)
        .select()
      if (error) throw error
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
async function uploadAllegato(file) {
  if (!currentAziendaId) throw new Error('Azienda non definita, impossibile caricare allegato.')
  var ts       = Date.now()
  var safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  // Path = "{azienda_id}/{ts}_{nome}" — split_part(name,'/',1) nella policy Storage
  // restituisce esattamente l'azienda_id, garantendo l'isolamento per azienda.
  var path = currentAziendaId + '/' + ts + '_' + safeName

  const { data, error } = await sb.storage.from(STORAGE_BUCKET).upload(path, file, { upsert: false })
  if (error) {
    if (error.message && error.message.toLowerCase().indexOf('bucket') !== -1) {
      throw new Error('Bucket "' + STORAGE_BUCKET + '" non trovato su Supabase Storage. Clicca su "Istruzioni per crearlo".')
    }
    throw new Error('Upload allegato: ' + error.message)
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
      var azioni = bloccato
        ? '<span class="lock-tag" title="Periodo consegnato — sola lettura">🔒 Consegnato</span>'
        : '<button class="icon-btn" title="Modifica" onclick="editRecente(' + i + ')">✏️ Modifica</button>' +
          '<button class="icon-btn danger" title="Elimina" onclick="deleteRecente(' + i + ')">🗑️ Elimina</button>'
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
      if (pageId === 'impostazioni'){ initImpostazioniPage() }
      if (pageId === 'setup')       { /* già caricata */ }
    })
  })

  // Imposta data di default nel form (oggi)
  var fData = el('f-data')
  if (fData) { fData.value = new Date().toISOString().split('T')[0] }

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
    if (o && o.style.display !== 'none') closeClassifyPanel()
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
