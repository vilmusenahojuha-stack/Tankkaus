(() => {
  "use strict";

  // ------------------ STORAGE ------------------
  const STORAGE = {
    cfg: "fuel_cfg_v1",
    history: "fuel_history_v1",
    vehicles: "fuel_vehicles_v1",
    last: "fuel_last_v1",
    adblueLast: "fuel_adblue_last_v1",
  };

  const DEFAULT_CFG = {
    sheetsUrl: "",
    lastOk: "",
  };

// ------------------ HARD-CODED ENDPOINT ------------------
const HARD_SHEETS_URL = "https://script.google.com/macros/s/AKfycbzVcOXNOIYtG5FF_ggcmYDR5QV6gGLvsqtyke0NNACo5T7cEzb-LGwSKIQtCtxZQRmL3Q/exec";


  const DEFAULT_VEHICLES = ["ISS-440", "JLN-678", "GPG-830"];

  // ------------------ STATE ------------------
  let cfg = loadJSON(STORAGE.cfg, DEFAULT_CFG);
  let vehicles = loadJSON(STORAGE.vehicles, DEFAULT_VEHICLES);
  let history = loadJSON(STORAGE.history, []); // includes queued unsent rows
  let lastCache = loadJSON(STORAGE.last, {}); // viimeisin onnistunut tankkaus / auto
  let adblueLastCache = loadJSON(STORAGE.adblueLast, {}); // viimeisin AdBlue-tankkaus / auto

  // ------------------ HELPERS ------------------
  const $ = (id) => document.getElementById(id);

  function loadJSON(key, fallback){
    try{
      const raw = localStorage.getItem(key);
      if(!raw) return structuredClone(fallback);
      const val = JSON.parse(raw);
      return (val ?? structuredClone(fallback));
    }catch{
      return structuredClone(fallback);
    }
  }

  function saveJSON(key, val){
    localStorage.setItem(key, JSON.stringify(val));
  }

  function nowLocalDateTime(){
    const d = new Date();
    const pad = (n) => String(n).padStart(2,"0");
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth()+1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mi = pad(d.getMinutes());
    return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${mi}` };
  }

  function toast(msg){
    const t = $("toast");
    if(!t) return;
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._tm);
    toast._tm = setTimeout(()=> t.classList.remove("show"), 2200);
  }

  function showModal(id, on){
    const el = $(id);
    if(!el) return;
    el.setAttribute("aria-hidden", on ? "false" : "true");
  }

  function fmt1(n){
    if(n === null || n === undefined || n === "") return "";
    const x = Number(n);
    if(!Number.isFinite(x)) return "";
    return x.toFixed(1);
  }
  function fmt2(n){
    if(n === null || n === undefined || n === "") return "";
    const x = Number(n);
    if(!Number.isFinite(x)) return "";
    return x.toFixed(2);
  }

  function toNumber(v){
    const x = Number(String(v ?? "").replace(",", "."));
    return Number.isFinite(x) ? x : null;
  }

  function makeId(){
    return "f_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
  }

function updateLastCache(vehicle, entry){
  if(!vehicle || !entry) return;
  lastCache[vehicle] = { ...entry, vehicle, sent: true, sending: false };
  saveJSON(STORAGE.last, lastCache);
}

function getPrevFromCache(vehicle){
  const v = lastCache[vehicle];
  return v ? { ...v, vehicle } : null;
}

function updateAdblueLastCache(vehicle, entry){
  if(!vehicle || !entry || !(Number(entry.adblueLiters) > 0)) return;
  adblueLastCache[vehicle] = {
    vehicle,
    ts: Number(entry.ts) || Date.now(),
    odoKm: entry.odoKm,
    adblueLiters: entry.adblueLiters
  };
  saveJSON(STORAGE.adblueLast, adblueLastCache);
}

function getPrevAdblue(vehicle){
  const cached = adblueLastCache[vehicle] ? { ...adblueLastCache[vehicle], vehicle } : null;
  const local = [...history]
    .filter(e => e.vehicle === vehicle && Number(e.adblueLiters) > 0 && Number.isFinite(Number(e.odoKm)))
    .sort((a,b) => Number(b.ts || 0) - Number(a.ts || 0))[0] || null;
  if(!local) return cached;
  if(!cached) return local;
  return Number(local.ts || 0) >= Number(cached.ts || 0) ? local : cached;
}


  // ------------------ CONFIRM MODAL ------------------
  function confirmModal(body, okText="OK", title="Varmistus"){
    return new Promise((resolve) => {
      $("cTitle").textContent = title;
      $("cBody").textContent = body;
      $("cOk").textContent = okText;

      const cleanup = () => {
        $("cOk").removeEventListener("click", onOk);
        $("cCancel").removeEventListener("click", onCancel);
        showModal("modalConfirm", false);
      };
      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };

      $("cOk").addEventListener("click", onOk);
      $("cCancel").addEventListener("click", onCancel);
      showModal("modalConfirm", true);
    });
  }

  // ------------------ VEHICLES ------------------
  function renderVehicles(){
    const sel = $("fVehicle");
    if(!sel) return;
    const cur = sel.value;
    sel.innerHTML = "";
    vehicles.forEach(v => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    });
    if(cur && vehicles.includes(cur)) sel.value = cur;
  }

  async function addVehicle(){
    const name = prompt("Syötä auton nimi / rekisterinumero:");
    const v = (name || "").trim();
    if(!v) return;
    if(!vehicles.includes(v)) vehicles.push(v);
    vehicles = vehicles.filter(Boolean);
    saveJSON(STORAGE.vehicles, vehicles);
    renderVehicles();
    $("fVehicle").value = v;
    recompute();
  }

  // ------------------ COMPUTE ------------------
  function findPrevForVehicle(vehicle){
  // Etsitään uusin tieto mittarista:
  // 1) paikallinen historia (jonossa olevat + mahdolliset) ja
  // 2) viimeisin mittari Sheetiin onnistuneesti menneestä (cache)
  const arr = [...history]
    .filter(e => e.vehicle === vehicle && Number.isFinite(Number(e.odoKm)))
    .sort((a,b) => (b.ts || 0) - (a.ts || 0));

  const localPrev = arr[0] || null;
  const cachedPrev = getPrevFromCache(vehicle);

  if(!localPrev) return cachedPrev;
  if(!cachedPrev) return localPrev;

  return (Number(localPrev.ts||0) >= Number(cachedPrev.ts||0)) ? localPrev : cachedPrev;
}


  function recompute(){
    const vehicle = $("fVehicle")?.value || "";
    const odo = toNumber($("fOdo")?.value);
    const liters = toNumber($("fLiters")?.value);
    const adblue = toNumber($("fAdblue")?.value) ?? 0;

    const drivenInput = $("fDriven");
    const hint = $("drivenHint");
    if(!drivenInput) return;

    // auto driven from prev odo
    let prev = null;
    let drivenAuto = null;
    if(vehicle && odo !== null){
      prev = findPrevForVehicle(vehicle);
      if(prev && Number.isFinite(Number(prev.odoKm))){
        const prevOdo = Number(prev.odoKm);
        const delta = odo - prevOdo;
        if(delta > 0) drivenAuto = delta;
        else if(delta === 0) drivenAuto = 0;
        else drivenAuto = null; // invalid
      }
    }

    // Determine if user has overridden: store a data flag
    const userEdited = drivenInput.dataset.userEdited === "1";

    if(!userEdited){
      if(drivenAuto === null){
        drivenInput.value = "";
        if(hint){
          if(prev && odo !== null) hint.textContent = "⚠️ Mittarilukema pienempi kuin edellinen – syötä ajettu km käsin.";
          else if(!prev && odo !== null) hint.textContent = "Ei edellistä tankkausta tälle autolle – ajettu km ei vielä laskuissa.";
          else hint.textContent = "";
        }
      }else{
        drivenInput.value = String(drivenAuto);
        if(hint){
          if(prev) hint.textContent = `Auto laski: ${drivenAuto} km (edellinen mittari ${prev.odoKm}). Voit korjata tarvittaessa.`;
          else hint.textContent = "";
        }
      }
    }else{
      if(hint) hint.textContent = "Korjattu ajettu km (perustuu syöttämääsi arvoon).";
    }

    const drivenFinal = toNumber(drivenInput.value);

    // calc avg fuel
    let avgCalc = "";
    if(liters !== null && drivenFinal !== null && drivenFinal > 0){
      avgCalc = fmt1((liters / drivenFinal) * 100);
    }
    $("fAvgCalc").value = avgCalc ? `${avgCalc}` : "";

    // AdBlue l/1000 km lasketaan edellisestä AdBlue-tankkauksesta.
    let adAvg = "";
    const prevAdblue = getPrevAdblue(vehicle);
    const adblueDrivenKm = prevAdblue && odo !== null ? odo - Number(prevAdblue.odoKm) : null;
    if(adblue > 0 && Number.isFinite(adblueDrivenKm) && adblueDrivenKm > 0){
      adAvg = fmt2((adblue / adblueDrivenKm) * 1000);
    }
    $("fAdblueAvg").value = adAvg || "";
    const adHint = $("adblueHint");
    if(adHint){
      if(!(adblue > 0)) adHint.textContent = "";
      else if(!prevAdblue) adHint.textContent = "Ensimmäinen AdBlue-tankkaus aloittaa kulutusseurannan.";
      else if(!(adblueDrivenKm > 0)) adHint.textContent = "⚠️ Mittarilukeman pitää olla edellistä AdBlue-tankkausta suurempi.";
      else adHint.textContent = `Laskettu ${adblueDrivenKm} km matkalta edellisestä AdBlue-tankkauksesta.`;
    }
  }

  function markDrivenUserEdited(){
    const el = $("fDriven");
    if(!el) return;
    el.dataset.userEdited = "1";
  }
  function resetDrivenUserEdited(){
    const el = $("fDriven");
    if(!el) return;
    el.dataset.userEdited = "0";
  }

  // ------------------ RENDER HISTORY ------------------
  function renderHistory(){
  const list = $("list");
  const empty = $("emptyHint");
  const meta = $("historyMeta");
  if(!list) return;

  const vehicle = $("fVehicle")?.value || "";

  // Näytä vain yksi: uusin paikallinen/jonossa oleva tai viimeisin Sheetsiin tallennettu.
  const local = history.filter(e => !vehicle || e.vehicle === vehicle);
  const cached = vehicle && lastCache[vehicle] ? [lastCache[vehicle]] : [];
  const arr = [...local, ...cached]
    .filter((e, i, all) => all.findIndex(x => x.id && e.id && x.id === e.id) === i)
    .sort((a,b)=> (b.ts||0) - (a.ts||0));

  list.innerHTML = "";
  if(empty) empty.style.display = arr.length ? "none" : "block";

  const queued = history.filter(e => (!vehicle || e.vehicle === vehicle) && e.sent !== true).length;
  if(meta) meta.textContent = queued ? ` (Jonossa ${queued})` : " (viimeisin)";

  if(!arr.length) return;

  const e = arr[0];

  const div = document.createElement("div");
  div.className = "item";

  const top = document.createElement("div");
  top.className = "itemTop";
  const left = document.createElement("div");
  const dt = new Date(e.ts || Date.now());
  const dateStr = (e.date && e.time) ? `${e.date} ${e.time}` : dt.toLocaleString();
  left.textContent = `${dateStr} • ${e.place || "-"}`;
  const badge = document.createElement("span");
  badge.className = "badge" + (e.sent === true ? " sent" : (e.sending ? " sending" : " queue"));
  badge.textContent = e.sent === true ? "TALLENNETTU" : (e.sending ? "LÄHETETÄÄN…" : "ODOTTAA YHTEYTTÄ");
  top.appendChild(left);
  top.appendChild(badge);

  const r1 = document.createElement("div");
  r1.className = "row";
  const driven = (e.drivenKmFinal ?? "");
  r1.textContent = `${e.vehicle || "-"} • Mittari ${e.odoKm ?? "-"} km • Ajettu ${driven !== "" ? driven + " km" : "-"}`;

  const r2 = document.createElement("div");
  r2.className = "row";
  const liters = e.liters ?? "";
  const avg = (e.avgCalcLper100 ?? "");
  const car = (e.avgCarLper100 ?? "");
  r2.textContent = `Tankattu ${liters !== "" ? liters + " l" : "-"} • Laskettu ${avg !== "" ? avg + " l/100" : "-"} • Auton ${car !== "" ? car + " l/100" : "-"}`;

  const r3 = document.createElement("div");
  r3.className = "row";
  const ad = e.adblueLiters ?? "";
  const adavg = e.adblueLper1000 ?? "";
  const adkm = e.adblueDrivenKm ?? "";
  r3.textContent = `AdBlue ${ad !== "" && Number(ad) > 0 ? ad + " l" : "-"} • Kulutus ${adavg !== "" ? adavg + " l/1000 km" : "-"}${adkm !== "" ? " • Matka " + adkm + " km" : ""}`;

  div.appendChild(top);
  div.appendChild(r1);
  div.appendChild(r2);
  div.appendChild(r3);
  if(e.sentErr){
    const errorRow = document.createElement("div");
    errorRow.className = "row syncError";
    errorRow.textContent = "Tallennusvirhe: " + e.sentErr;
    div.appendChild(errorRow);
  }

  list.appendChild(div);
}


  // ------------------ FORMS ------------------
  function fillNow(){
    const {date, time} = nowLocalDateTime();
    $("fDate").value = date;
    $("fTime").value = time;
  }

  function clearForm(){
    fillNow();
    $("fPlace").value = "";
    $("fOdo").value = "";
    $("fLiters").value = "";
    $("fAvgCar").value = "";
    $("fAdblue").value = "";
    $("fAvgCalc").value = "";
    $("fAdblueAvg").value = "";
    resetDrivenUserEdited();
    $("fDriven").value = "";
    $("drivenHint").textContent = "";
    recompute();
  }

  function getSheetsUrl(){
    // Kovakoodattu endpoint (asetuksista ei muuteta)
    return (HARD_SHEETS_URL || "").trim();
  }

  // ------------------ SHEETS API ------------------
  async function callSheets(action, payload){
    const url = getSheetsUrl();
    if(!url) throw new Error("Sheets URL puuttuu");
    const body = JSON.stringify({ action, ...payload });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(url, {
        method:"POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body,
        signal: controller.signal
      });
    } catch (error) {
      if(error && error.name === "AbortError") throw new Error("Sheets-yhteys aikakatkaistiin 15 sekunnin jälkeen");
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const txt = await res.text();
    let data = null;
    try{ data = JSON.parse(txt); }catch{}
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    if(!data || data.ok !== true) throw new Error(data?.error || "Tuntematon virhe");
    return data;
  }

  async function testSheets(){
    try{
      await callSheets("ping", {});
      cfg.lastOk = new Date().toISOString();
      saveJSON(STORAGE.cfg, cfg);
      $("settingsStatus").textContent = "✅ Yhteys OK";
      toast("Yhteys OK ✅");
    }catch(err){
      $("settingsStatus").textContent = "❌ " + (err?.message || err);
      toast("Yhteystesti epäonnistui");
    }
  }

  async function syncQueue({ ask = true, silent = false } = {}){
    const url = getSheetsUrl();
    if(!url){
      if(!silent) toast("Sheets URL puuttuu");
      return;
    }
    const unsent = history.filter(e => e.sent !== true);
    if(!unsent.length){
      if(!silent) toast("Ei jonossa olevia");
      return;
    }
    if(ask){
      const ok = await confirmModal(`Lähetetään jonossa olevat merkinnät Sheetiin?\n\nKpl: ${unsent.length}`, "LÄHETÄ");
      if(!ok) return;
    }

    let sentCount = 0;
    let failedCount = 0;
    for(const entry of unsent){
      entry.sending = true;
      entry.sentErr = "";
      saveJSON(STORAGE.history, history);
      renderHistory();
      try{
        const data = await callSheets("appendFuel", { rows: [entry] });
        const sentIds = new Set(data.sentIds || [entry.id]);
        if(!sentIds.has(entry.id)) throw new Error("Sheets ei vahvistanut tallennusta");
        entry.sent = true;
        entry.sending = false;
        entry.sentAt = Date.now();
        updateLastCache(entry.vehicle, entry);
        updateAdblueLastCache(entry.vehicle, entry);
        sentCount++;
      }catch(err){
        entry.sent = false;
        entry.sending = false;
        entry.sentErr = String(err?.message || err);
        failedCount++;
      }
      saveJSON(STORAGE.history, history);
      renderHistory();
    }
    history = history.filter(e => e.sent !== true);
    saveJSON(STORAGE.history, history);
    renderHistory();
    if(sentCount) await refreshFromSheets();
    if(!silent) toast(failedCount ? `Lähetetty ${sentCount}, jonossa ${failedCount}` : "Lähetetty ✅");
  }

  async function refreshFromSheets(){
  const url = getSheetsUrl();
  const vehicle = $("fVehicle")?.value || "";
  if(!url || !vehicle) return;

  try{
    const data = await callSheets("listFuel", { vehicle });

    // Päivitä vain viimeisin mittari-cache (auto km -laskentaan)
    const sheetRows = Array.isArray(data.rows) ? data.rows : [];
    if(sheetRows.length){
      const normalized = sheetRows.map(normalizeRowFromSheets).sort((a,b)=> (b.ts||0)-(a.ts||0));
      const last = normalized[0];
      updateLastCache(vehicle, last);
      const lastAdblue = normalized.find(e => Number(e.adblueLiters) > 0);
      if(lastAdblue) updateAdblueLastCache(vehicle, lastAdblue);
    }

    // Historia pidetään kevyenä: vain jonossa olevat merkinnät jäävät paikallisesti
    history = history.filter(e => e.sent !== true);
    saveJSON(STORAGE.history, history);

    renderHistory();
    $("settingsStatus").textContent = "✅ Päivitetty (viimeisin mittari haettu Sheetsistä)";
  }catch(err){
    // not fatal
    $("settingsStatus").textContent = "⚠️ Historiasta ei saatu yhteyttä (listFuel).";
  }
}


  function normalizeRowFromSheets(r){
    // Accept both snake/camel keys
    const ts = r.ts ?? r.timestamp ?? r.time ?? Date.now();
    const e = {
      id: r.id ?? makeId(),
      ts: Number(ts) || Date.parse(ts) || Date.now(),
      date: r.date || "",
      time: r.time || "",
      place: r.place || r.city || "",
      vehicle: r.vehicle || r.plate || "",
      odoKm: r.odoKm ?? r.odo ?? "",
      drivenKmAuto: r.drivenKmAuto ?? "",
      drivenKmFinal: r.drivenKmFinal ?? r.drivenKm ?? "",
      drivenKmManualUsed: !!r.drivenKmManualUsed,
      liters: r.liters ?? "",
      avgCalcLper100: r.avgCalcLper100 ?? "",
      avgCarLper100: r.avgCarLper100 ?? r.avgCar ?? "",
      adblueLiters: r.adblueLiters ?? r.adblue ?? "",
      adblueLper1000: r.adblueLper1000 ?? "",
      adblueDrivenKm: r.adblueDrivenKm ?? "",
      sent: true,
      sending: false
    };
    return e;
  }

  // ------------------ SAVE ENTRY ------------------
  function buildEntryFromForm(){
    const date = ($("fDate").value || "").trim();
    const time = ($("fTime").value || "").trim();
    const place = ($("fPlace").value || "").trim();
    const vehicle = ($("fVehicle").value || "").trim();
    const odoKm = toNumber($("fOdo").value);
    const liters = toNumber($("fLiters").value);
    const avgCarLper100 = toNumber($("fAvgCar").value);
    const adblueLiters = toNumber($("fAdblue").value) ?? 0;

    const drivenKmFinal = toNumber($("fDriven").value);
    const prev = findPrevForVehicle(vehicle);
    const prevOdo = prev ? toNumber(prev.odoKm) : null;

    let drivenKmAuto = null;
    if(odoKm !== null && prevOdo !== null){
      const delta = odoKm - prevOdo;
      drivenKmAuto = (delta >= 0) ? delta : null;
    }

    const drivenKmManualUsed = ($("fDriven").dataset.userEdited === "1");

    // calc
    let avgCalcLper100 = null;
    if(liters !== null && drivenKmFinal !== null && drivenKmFinal > 0){
      avgCalcLper100 = Number(((liters / drivenKmFinal) * 100).toFixed(1));
    }
    const prevAdblue = getPrevAdblue(vehicle);
    let adblueDrivenKm = null;
    if(adblueLiters > 0 && prevAdblue && odoKm !== null){
      const delta = odoKm - Number(prevAdblue.odoKm);
      if(delta > 0) adblueDrivenKm = delta;
    }
    let adblueLper1000 = null;
    if(adblueLiters > 0 && adblueDrivenKm !== null){
      adblueLper1000 = Number(((adblueLiters / adblueDrivenKm) * 1000).toFixed(2));
    }

    return {
      id: makeId(),
      ts: Date.now(),
      date, time,
      place,
      vehicle,
      odoKm: odoKm ?? "",
      drivenKmAuto: drivenKmAuto ?? "",
      drivenKmFinal: drivenKmFinal ?? "",
      drivenKmManualUsed,
      liters: liters ?? "",
      avgCalcLper100: (avgCalcLper100 ?? ""),
      avgCarLper100: (avgCarLper100 ?? ""),
      adblueLiters: (adblueLiters ?? 0),
      adblueLper1000: (adblueLper1000 ?? ""),
      adblueDrivenKm: (adblueDrivenKm ?? ""),
      sent: false,
      sending: true,
      sentErr: ""
    };
  }

  function validateEntry(entry){
    if(!entry.vehicle) return "Valitse auto.";
    if(!entry.place) return "Syötä paikkakunta.";
    if(entry.odoKm === "" || entry.odoKm === null) return "Syötä mittarilukema.";
    if(entry.liters === "" || entry.liters === null) return "Syötä tankattu määrä (l).";
    // driven can be empty for first entry, but if liters present we allow; calculations blank
    return "";
  }

  async function saveEntry(){
    const entry = buildEntryFromForm();
    const err = validateEntry(entry);
    if(err){
      toast(err);
      return;
    }

    const ok = await confirmModal(
      `Tallennetaanko tankkaus?\n\n${entry.date} ${entry.time}\n${entry.place}\n${entry.vehicle}\nMittari: ${entry.odoKm} km\nTankattu: ${entry.liters} l`,
      "TALLENNA"
    );
    if(!ok) return;

    // optimistic: add to local history first (so not lost)
    history.push(entry);
    saveJSON(STORAGE.history, history);
    renderHistory();

    // try send to sheets if url present
    const url = getSheetsUrl();
    if(!url){
      toast("Tallennettu jonoon (Sheets URL puuttuu)");
      return;
    }

    try{
      const data = await callSheets("appendFuel", { rows: [entry] });
      // mark as sent
      const sentIds = new Set((data.sentIds || [entry.id]));
      if(!sentIds.has(entry.id)) throw new Error("Sheets ei vahvistanut tallennusta");
      entry.sent = true;
      entry.sending = false;
      entry.sentAt = Date.now();
      updateLastCache(entry.vehicle, entry);
      updateAdblueLastCache(entry.vehicle, entry);
      history = history.filter(e => e.id !== entry.id);
      saveJSON(STORAGE.history, history);
      toast("Tallennettu Sheetiin ✅");
      renderHistory();
      await refreshFromSheets();
    }catch(err2){
      entry.sent = false;
      entry.sending = false;
      entry.sentErr = String(err2?.message || err2);
      saveJSON(STORAGE.history, history);
      renderHistory();
      toast("Ei yhteyttä — odottaa uutta lähetystä");
      $("settingsStatus").textContent = "❌ " + (err2?.message || err2);
    }
  }

  // ------------------ SETTINGS ------------------
  function openSettings(){
    $("sheetsUrl").value = getSheetsUrl();
    $("sheetsUrl").setAttribute("disabled","disabled");
    const last = cfg.lastOk ? new Date(cfg.lastOk).toLocaleString() : "-";
    $("settingsStatus").textContent = `Viimeisin OK: ${last}`;
    showModal("modalSettings", true);
  }

  function closeSettings(){
    showModal("modalSettings", false);
  }

  function saveSettings(){
    toast("Sheets URL on kovakoodattu – ei muutettavissa asetuksista.");
  }

  // ------------------ INIT ------------------
  function bind(){
    $("btnSettings").addEventListener("click", openSettings);
    $("btnCloseSettings").addEventListener("click", closeSettings);
    $("btnSaveSettings").addEventListener("click", () => { saveSettings(); closeSettings(); });

    $("btnTest").addEventListener("click", testSheets);
    $("btnSync").addEventListener("click", () => syncQueue());

    $("btnAddVehicle").addEventListener("click", addVehicle);

    $("btnClear").addEventListener("click", async () => {
      const ok = await confirmModal("Tyhjennetäänkö lomake?", "TYHJENNÄ");
      if(!ok) return;
      clearForm();
      toast("Tyhjennetty");
    });

    $("btnSave").addEventListener("click", saveEntry);

    // recompute triggers
    ["fVehicle","fOdo","fLiters","fAdblue"].forEach(id => {
  $(id).addEventListener("input", () => {
    recompute();
  });
  $(id).addEventListener("change", () => {
    recompute();

    // kun auto vaihtuu, hae viimeisin mittari Sheetsistä (cache) ja päivitä historia-näkymä
    if(id === "fVehicle"){
      refreshFromSheets();
      renderHistory();
    }
  });
});


    $("fDriven").addEventListener("input", () => {
      markDrivenUserEdited();
      recompute();
    });

    // if user focuses driven and edits, set manual
    $("fDriven").addEventListener("focus", () => {
      if($("fDriven").value !== "") markDrivenUserEdited();
    });
  }

  function init(){
    renderVehicles();
    fillNow();
    resetDrivenUserEdited();
    // set main button colors (yellow for save, blue for settings already)
    $("btnSave").classList.add("btn-yellow");
    $("btnSettings").classList.add("btn-blue");

    renderHistory();
    recompute();

    // If sheetsUrl set, try refresh (non-fatal)
    if(getSheetsUrl()){
      refreshFromSheets();
    }
  }

  // global error toasts
  window.addEventListener("error", (e) => {
    console.error(e);
  });
  window.addEventListener("unhandledrejection", (e) => {
    console.error(e);
  });

  window.addEventListener("online", () => {
    syncQueue({ ask: false, silent: true });
  });

  bind();
  init();
  if(navigator.onLine){
    setTimeout(() => syncQueue({ ask: false, silent: true }), 300);
  }
})();
