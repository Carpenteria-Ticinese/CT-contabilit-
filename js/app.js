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
