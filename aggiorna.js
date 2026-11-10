/* =========================================================================
   aggiorna.js — avviso «Nuova versione» per le app di Carpenteria Ticinese
   -------------------------------------------------------------------------
   Regola (Umberto, 9.11.2026): mai versioni vecchie bloccate sul telefono o
   sul PC. Quando esce una versione nuova l'app mostra in alto
   «🔄 Nuova versione: aggiorna» con un tasto grande. Niente blocchi.

   FILE UGUALE IN TUTTE LE APP: si copia così com'è, non si modifica.
   Ogni app cambia solo due cose: il numero nella riga <script> e il file
   versione.json.

   Come si usa (3 passi):
   1. Copiare questo file nella cartella dell'app, accanto a index.html.
   2. Creare accanto a index.html il file  versione.json  con dentro solo:
          {"versione":5}
   3. In index.html, in fondo a <body>:
          <script src="aggiorna.js?v=5" data-versione="5"></script>
      data-versione = numero della versione di QUESTA pagina (uguale a ?v=).
      Facoltativo: data-file="altro.json" se il file ha un altro nome.

   A ogni versione nuova: aumentare il numero in versione.json, in
   data-versione e in ?v= (tutti uguali), poi pubblicare.

   Cosa fa:
   - Legge versione.json all'apertura, quando la pagina torna visibile
     (cambio di scheda, telefono riacceso) e ogni 10 minuti.
     La lettura salta ogni memoria: cache 'no-store' + ?t=<ora> nell'indirizzo
     (così anche la copia di GitHub Pages, tenuta fino a 10 minuti, viene saltata).
   - Se il numero letto è più alto di data-versione mostra la fascia in alto.
   - Il tasto «Aggiorna» rinfresca la copia della pagina nel browser e la
     ricarica con ?v=<nuovo> nell'indirizzo: un indirizzo nuovo non viene mai
     preso dalla memoria vecchia. Il resto dell'indirizzo (#...) resta uguale.
   - «Dopo» chiude la fascia; torna al prossimo controllo.
   - Se versione.json manca o la rete non va: non fa niente (nessun errore,
     nessun blocco). L'app funziona lo stesso.
   - Nessun dato dell'utente, nessun localStorage, nessun service worker.
   ========================================================================= */
(function () {
  "use strict";

  var script = document.currentScript;
  var VERSIONE_PAGINA = Number(script && script.getAttribute("data-versione")) || 0;
  var FILE = (script && script.getAttribute("data-file")) || "versione.json";
  var OGNI_MS = 10 * 60 * 1000;   // controllo ogni 10 minuti
  var ID = "ct-aggiorna";
  var chiusaPer = 0;              // versione per cui si è premuto «Dopo» (fino al prossimo controllo)

  if (!VERSIONE_PAGINA) return;   // manca data-versione: non si controlla niente

  /* indirizzo di versione.json accanto allo script (funziona anche se la pagina ha #... o ?...) */
  function indirizzoFile() {
    var base = (script && script.src) ? script.src : location.href;
    var u = new URL(FILE, base);
    u.searchParams.set("t", String(Date.now()));
    return u.toString();
  }

  function controlla() {
    if (!window.fetch) return;
    fetch(indirizzoFile(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (dati) {
        var nuova = dati ? Number(dati.versione) : 0;
        if (nuova > VERSIONE_PAGINA && nuova !== chiusaPer) mostra(nuova);
      })
      .catch(function () { /* rete assente o file mancante: niente avviso, niente blocco */ });
  }

  function aggiorna(nuova) {
    var u = new URL(location.href);
    u.searchParams.set("v", String(nuova));
    var pulito = new URL(location.href);
    pulito.hash = "";
    pulito.searchParams.delete("v");
    /* prima si rinfresca la copia dell'indirizzo normale (quello dell'icona sul telefono),
       poi si ricarica con ?v=<nuovo>. Se il rinfresco non riesce si ricarica lo stesso. */
    var fatto = false;
    function vai() { if (fatto) return; fatto = true; location.replace(u.toString()); }
    try {
      fetch(pulito.toString(), { cache: "reload" }).then(vai, vai);
      setTimeout(vai, 2500);
    } catch (e) { vai(); }
  }

  function mostra(nuova) {
    var box = document.getElementById(ID);
    if (!box) {
      box = document.createElement("div");
      box.id = ID;
      box.setAttribute("role", "status");
      box.style.cssText = [
        "position:sticky", "top:0", "left:0", "right:0", "z-index:2147483000",
        "display:flex", "flex-wrap:wrap", "align-items:center", "gap:10px",
        "padding:12px 16px", "background:#14181F", "color:#FFFFFF",
        "border-bottom:3px solid #C8A24A", "font:600 18px/1.35 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
        "box-shadow:0 4px 16px rgba(0,0,0,.35)"
      ].join(";");
      /* un solo tasto grande con la scritta intera, piu' «Dopo» */
      var tasto = document.createElement("button");
      tasto.type = "button";
      tasto.id = ID + "-tasto";
      tasto.style.cssText = "flex:1 1 220px;min-height:56px;padding:10px 18px;border-radius:12px;border:none;background:#C8A24A;color:#1a1000;font-family:inherit;font-weight:700;font-size:19px;line-height:1.2;cursor:pointer;text-align:center";
      tasto.innerHTML = '<span aria-hidden="true">🔄</span> Nuova versione: aggiorna';
      var dopo = document.createElement("button");
      dopo.type = "button";
      dopo.id = ID + "-dopo";
      dopo.style.cssText = "min-height:56px;padding:10px 18px;border-radius:12px;border:2px solid #FFFFFF;background:transparent;color:#FFFFFF;font-family:inherit;font-weight:600;font-size:18px;line-height:1.2;cursor:pointer";
      dopo.textContent = "Dopo";
      box.appendChild(tasto); box.appendChild(dopo);
      document.body.insertBefore(box, document.body.firstChild);
    }
    box.setAttribute("data-nuova", String(nuova));
    document.getElementById(ID + "-tasto").onclick = function () { aggiorna(nuova); };
    document.getElementById(ID + "-dopo").onclick = function () { chiusaPer = nuova; box.remove(); };
  }

  function avvia() {
    controlla();
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") { chiusaPer = 0; controlla(); }
    });
    setInterval(function () { chiusaPer = 0; controlla(); }, OGNI_MS);
  }

  if (document.body) avvia();
  else document.addEventListener("DOMContentLoaded", avvia);
})();
