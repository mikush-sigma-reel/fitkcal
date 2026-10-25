import { sb, $, $$, h, r0, r1, MEALS, toast, openSheet, closeSheet, callAI, compressImage, attachMic, md } from "./helpers.js";
import { ACTIVITY, targets, sum, scale, localDay, shiftDay, mealForNow } from "./calc.js";
import { startScanner, lookupBarcode } from "./scanner.js";
import { SUPABASE_URL } from "./config.js";

const state = { user: null, profile: null, weight: null, day: localDay(), pendingCoach: null };
const tgt = () => targets(state.profile, state.weight);
const view = () => $("#view");

// ═════════ Start ═════════
async function boot() {
  if (SUPABASE_URL.includes("TWOJ-PROJEKT")) return renderSetupNeeded();
  const { data: { session } } = await sb.auth.getSession();
  sb.auth.onAuthStateChange((event, s) => {
    if (event === "SIGNED_OUT") { state.user = null; renderLogin(); }
    if (event === "SIGNED_IN" && !state.user && s) { state.user = s.user; start(); }
  });
  if (!session) return renderLogin();
  state.user = session.user;
  start();
}

async function start() {
  document.body.classList.remove("auth");
  await loadProfile();
  window.onhashchange = route;
  if (!state.profile?.sex || !state.weight) location.hash = "#settings";
  route();
}

async function loadProfile() {
  const [{ data: p }, { data: w }] = await Promise.all([
    sb.from("profiles").select("*").maybeSingle(),
    sb.from("weights").select("day, weight_kg").order("day", { ascending: false }).limit(1),
  ]);
  state.profile = p ?? { id: state.user.id, training: {} };
  state.weight = w?.[0] ? Number(w[0].weight_kg) : null;
}

const VIEWS = { today: renderToday, coach: renderCoach, workouts: renderWorkouts, progress: renderProgress, settings: renderSettings };

function route() {
  const name = location.hash.slice(1) || "today";
  const fn = VIEWS[name] ?? renderToday;
  $$("#tabs a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#${name}`));
  document.body.dataset.view = name;
  closeSheet();
  fn().catch((e) => { console.error(e); toast(e.message, "err"); });
}

// ═════════ Logowanie ═════════
function renderSetupNeeded() {
  document.body.classList.add("auth");
  view().innerHTML = `<div class="auth-box"><div class="logo">🔥</div><h1>FitKcal</h1>
    <p class="muted">Uzupełnij <code>js/config.js</code> danymi projektu Supabase (instrukcja w README.md).</p></div>`;
}

function renderLogin() {
  document.body.classList.add("auth");
  view().innerHTML = `
    <form class="auth-box" id="login">
      <div class="logo">🔥</div><h1>FitKcal</h1>
      <p class="muted">Twój licznik kalorii z trenerem AI</p>
      <input name="email" type="email" placeholder="E-mail" autocomplete="email" required>
      <input name="password" type="password" placeholder="Hasło (min. 6 znaków)" autocomplete="current-password" minlength="6" required>
      <button class="btn primary" type="submit">Zaloguj</button>
      <button class="btn ghost" type="button" id="signup">Załóż konto</button>
    </form>`;
  const f = $("#login");
  f.onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.signInWithPassword({ email: f.email.value, password: f.password.value });
    if (error) toast(error.message === "Invalid login credentials" ? "Zły e-mail lub hasło" : error.message, "err");
  };
  $("#signup").onclick = async () => {
    if (!f.reportValidity()) return;
    const { data, error } = await sb.auth.signUp({ email: f.email.value, password: f.password.value });
    if (error) return toast(error.message, "err");
    if (!data.session) toast("Sprawdź skrzynkę i potwierdź e-mail, potem się zaloguj");
  };
}

// ═════════ Dziś ═════════
async function renderToday() {
  const { data: entries = [], error } = await sb.from("food_entries").select("*").eq("day", state.day).order("created_at");
  if (error) throw error;
  const t = tgt(), s = sum(entries);
  const isToday = state.day === localDay();
  const dayLabel = isToday ? "Dziś" : state.day === shiftDay(localDay(), -1) ? "Wczoraj"
    : new Date(state.day + "T12:00").toLocaleDateString("pl-PL", { weekday: "short", day: "numeric", month: "short" });

  const C = 2 * Math.PI * 52;
  const pct = t ? Math.min(1, s.kcal / t.kcal) : 0;
  const left = t ? t.kcal - r0(s.kcal) : null;

  const bar = (label, val, goal, cls) => `
    <div class="macro ${cls}">
      <div class="macro-top"><span>${label}</span><span><b>${r0(val)}</b>${goal ? ` / ${goal} g` : " g"}</span></div>
      <div class="track"><div style="width:${goal ? Math.min(100, (val / goal) * 100) : 0}%"></div></div>
    </div>`;

  const mealHtml = Object.entries(MEALS).map(([key, label]) => {
    const list = entries.filter((e) => e.meal === key);
    const kc = sum(list).kcal;
    return `<section class="meal">
      <div class="meal-head"><h3>${label}</h3><span class="muted">${r0(kc)} kcal</span>
        <button class="icon-btn add-meal" data-meal="${key}" aria-label="Dodaj do: ${label}">＋</button></div>
      ${list.map((e) => `
        <button class="entry" data-id="${e.id}">
          <span class="entry-name">${h(e.name)}${e.grams ? ` <span class="muted">${r0(e.grams)} g</span>` : ""}</span>
          <span class="entry-kcal">${r0(e.kcal)}</span>
          <span class="entry-macros muted">B ${r1(e.protein)} · T ${r1(e.fat)} · W ${r1(e.carbs)}</span>
        </button>`).join("") || `<div class="empty muted">—</div>`}
    </section>`;
  }).join("");

  view().innerHTML = `
    <header class="day-nav">
      <button class="icon-btn" id="prev" aria-label="Poprzedni dzień">‹</button>
      <h2>${dayLabel}</h2>
      <button class="icon-btn" id="next" aria-label="Następny dzień" ${isToday ? "disabled" : ""}>›</button>
    </header>
    ${t ? "" : `<a class="banner" href="#settings">Uzupełnij profil i wagę, żeby wyliczyć Twój dzienny cel →</a>`}
    <div class="card summary">
      <svg class="ring ${left !== null && left < 0 ? "over" : ""}" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="52" class="ring-bg"/>
        <circle cx="60" cy="60" r="52" class="ring-fg" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"/>
        <text x="60" y="56" class="ring-num">${left !== null ? Math.abs(left) : r0(s.kcal)}</text>
        <text x="60" y="76" class="ring-sub">${left === null ? "kcal" : left >= 0 ? "zostało" : "ponad cel"}</text>
      </svg>
      <div class="summary-side">
        <div class="kv"><span class="muted">Zjedzone</span><b>${r0(s.kcal)} kcal</b></div>
        <div class="kv"><span class="muted">Cel</span><b>${t ? t.kcal + " kcal" : "—"}</b></div>
        ${bar("Białko", s.protein, t?.protein, "p")}
        ${bar("Tłuszcze", s.fat, t?.fat, "f")}
        ${bar("Węglowodany", s.carbs, t?.carbs, "c")}
      </div>
    </div>
    ${mealHtml}
    <button class="fab" id="fab" aria-label="Dodaj jedzenie">＋</button>`;

  $("#prev").onclick = () => { state.day = shiftDay(state.day, -1); renderToday(); };
  $("#next").onclick = () => { if (!isToday) { state.day = shiftDay(state.day, 1); renderToday(); } };
  $("#fab").onclick = () => openAdd();
  $$(".add-meal").forEach((b) => (b.onclick = () => openAdd(b.dataset.meal)));
  $$(".entry").forEach((b) => (b.onclick = () => openEntry(entries.find((e) => String(e.id) === b.dataset.id))));
}

async function addEntries(rows, meal) {
  const { error } = await sb.from("food_entries").insert(rows.map((r) => ({
    day: state.day, meal, name: r.name, grams: r.grams || null,
    kcal: r0(r.kcal), protein: r1(r.protein), fat: r1(r.fat), carbs: r1(r.carbs),
    source: r.source ?? "manual", barcode: r.barcode ?? null,
  })));
  if (error) return toast(error.message, "err");
  closeSheet();
  toast(`Dodano: ${r0(sum(rows).kcal)} kcal`, "ok");
  if (location.hash === "#today" || !location.hash) renderToday();
}

// ───────── Arkusz dodawania ─────────
function mealPicker(selected) {
  return `<div class="seg meal-seg">${Object.entries(MEALS).map(([k, l]) =>
    `<button type="button" data-meal="${k}" class="${k === selected ? "on" : ""}">${l}</button>`).join("")}</div>`;
}

function openAdd(presetMeal) {
  let meal = presetMeal ?? (state.day === localDay() ? mealForNow() : "snack");
  let image = null, items = [], stopScan = null;

  const sheet = openSheet(`
    <div class="sheet-head"><h3>Dodaj jedzenie</h3><button class="icon-btn" data-close aria-label="Zamknij">✕</button></div>
    ${mealPicker(meal)}
    <div class="seg mode-seg">
      <button type="button" data-mode="ai" class="on">✨ AI</button>
      <button type="button" data-mode="code">▥ Kod</button>
      <button type="button" data-mode="manual">✎ Ręcznie</button>
    </div>

    <div class="pane" data-pane="ai">
      <div class="row">
        <label class="btn"><input type="file" accept="image/*" capture="environment" hidden class="pick">📷 Zdjęcie</label>
        <label class="btn ghost"><input type="file" accept="image/*" hidden class="pick">🖼 Galeria</label>
      </div>
      <div class="preview"></div>
      <div class="mic-field">
        <textarea id="ai-text" rows="3" placeholder="Opisz lub dopowiedz, np. „pół paczki frytek 750 g z piekarnika + 2 łyżki ketchupu”. Możesz dyktować mikrofonem z klawiatury."></textarea>
        <button type="button" class="icon-btn mic" aria-label="Dyktuj">🎤</button>
      </div>
      <button class="btn primary wide" id="analyze">Policz z AI</button>
      <div id="ai-result"></div>
    </div>

    <div class="pane" data-pane="code" hidden>
      <div id="scan-area"></div>
      <div class="row"><input id="code-input" inputmode="numeric" placeholder="lub wpisz kod ręcznie"><button class="btn" id="code-go">Szukaj</button></div>
      <div id="code-result"></div>
    </div>

    <form class="pane grid-form" data-pane="manual" hidden>
      <label class="full">Nazwa<input name="name" required></label>
      <label>Gramy<input name="grams" type="number" inputmode="decimal" step="any"></label>
      <label>Kcal<input name="kcal" type="number" inputmode="decimal" step="any" required></label>
      <label>Białko<input name="protein" type="number" inputmode="decimal" step="any" value="0"></label>
      <label>Tłuszcze<input name="fat" type="number" inputmode="decimal" step="any" value="0"></label>
      <label>Węgle<input name="carbs" type="number" inputmode="decimal" step="any" value="0"></label>
      <button class="btn primary full">Dodaj</button>
    </form>`);

  const stop = () => { stopScan?.(); stopScan = null; };
  window.addEventListener("sheetclose", stop, { once: true });

  $$(".meal-seg button", sheet).forEach((b) => (b.onclick = () => {
    meal = b.dataset.meal;
    $$(".meal-seg button", sheet).forEach((x) => x.classList.toggle("on", x === b));
  }));

  $$(".mode-seg button", sheet).forEach((b) => (b.onclick = async () => {
    $$(".mode-seg button", sheet).forEach((x) => x.classList.toggle("on", x === b));
    $$(".pane", sheet).forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.mode));
    stop();
    if (b.dataset.mode === "code") {
      try { stopScan = await startScanner("scan-area", (code) => { stopScan = null; showProduct(code); }); }
      catch (e) { $("#scan-area", sheet).innerHTML = `<p class="muted">Kamera niedostępna (${h(e.message || e)}). Wpisz kod ręcznie.</p>`; }
    }
  }));

  // — AI —
  attachMic($(".mic", sheet), $("#ai-text", sheet));
  $$(".pick", sheet).forEach((inp) => (inp.onchange = async () => {
    const f = inp.files?.[0];
    if (!f) return;
    image = await compressImage(f);
    $(".preview", sheet).innerHTML = `<img src="${image.preview}" alt=""><button class="icon-btn" id="rm-img" aria-label="Usuń zdjęcie">✕</button>`;
    $("#rm-img", sheet).onclick = () => { image = null; $(".preview", sheet).innerHTML = ""; };
    inp.value = "";
  }));

  const analyzeBtn = $("#analyze", sheet);
  analyzeBtn.onclick = async () => {
    const text = $("#ai-text", sheet).value.trim();
    if (!text && !image) return toast("Zrób zdjęcie albo opisz, co jesz", "warn");
    analyzeBtn.disabled = true; // blokuje podwójne kliknięcie = podwójne zapytanie
    analyzeBtn.textContent = "Liczę…";
    try {
      const res = await callAI({ action: "food", day: state.day, text, image: image && { data: image.data, mime: image.mime } });
      items = res.items.map((i) => ({ ...i, source: "ai" }));
      renderItems(res);
    } catch (e) {
      toast(e.message, "err");
    } finally {
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = "Policz ponownie";
    }
  };

  function renderItems(res) {
    const box = $("#ai-result", sheet);
    if (!items.length) { box.innerHTML = `<p class="note">${h(res?.note || "Nic nie rozpoznano.")}</p>`; return; }
    const conf = { low: "niska", medium: "średnia", high: "wysoka" }[res?.confidence] ?? "";
    box.innerHTML = `
      ${res ? `<p class="note">${h(res.note)}${conf ? ` <span class="muted">(pewność: ${conf})</span>` : ""}</p>` : ""}
      ${items.map((it, i) => `
        <div class="item" data-i="${i}">
          <div class="row"><input class="it-name" value="${h(it.name)}"><button class="icon-btn it-rm" aria-label="Usuń">✕</button></div>
          <div class="item-nums">
            <label>g<input class="it-g" type="number" inputmode="decimal" value="${r0(it.grams)}"></label>
            <label>kcal<input data-k="kcal" type="number" inputmode="decimal" value="${r0(it.kcal)}"></label>
            <label>B<input data-k="protein" type="number" inputmode="decimal" step="any" value="${r1(it.protein)}"></label>
            <label>T<input data-k="fat" type="number" inputmode="decimal" step="any" value="${r1(it.fat)}"></label>
            <label>W<input data-k="carbs" type="number" inputmode="decimal" step="any" value="${r1(it.carbs)}"></label>
          </div>
        </div>`).join("")}
      <div class="total" id="ai-total"></div>
      <button class="btn primary wide" id="ai-add">Dodaj do dziennika</button>`;

    const total = () => {
      const s = sum(items);
      $("#ai-total", sheet).innerHTML = `Razem: <b>${r0(s.kcal)} kcal</b> · B ${r1(s.protein)} · T ${r1(s.fat)} · W ${r1(s.carbs)}`;
    };
    total();
    $$(".item", box).forEach((row) => {
      const i = Number(row.dataset.i);
      $(".it-name", row).oninput = (e) => (items[i].name = e.target.value);
      $(".it-g", row).onchange = (e) => {
        // zmiana gramów przelicza całą pozycję proporcjonalnie
        items[i] = scale(items[i], Number(e.target.value) || 0);
        renderItems(null);
      };
      $$("[data-k]", row).forEach((inp) => (inp.oninput = () => { items[i][inp.dataset.k] = Number(inp.value) || 0; total(); }));
      $(".it-rm", row).onclick = () => { items.splice(i, 1); renderItems(null); };
    });
    $("#ai-add", sheet).onclick = () => addEntries(items, meal);
  }

  // — Kod kreskowy —
  $("#code-go", sheet).onclick = () => { const c = $("#code-input", sheet).value.trim(); if (c) { stop(); showProduct(c); } };

  async function showProduct(code) {
    const box = $("#code-result", sheet);
    $("#scan-area", sheet).innerHTML = "";
    box.innerHTML = `<p class="muted">Szukam ${h(code)}…</p>`;
    let p = null;
    try { p = await lookupBarcode(code); } catch { /* sieć */ }
    if (!p) {
      box.innerHTML = `<p class="note">Nie znalazłem produktu <b>${h(code)}</b> w Open Food Facts. Zrób zdjęcie etykiety w zakładce ✨ AI — odczyta wartości.</p>`;
      return;
    }
    const g0 = p.serving ?? 100;
    box.innerHTML = `
      <div class="card product">
        <b>${h(p.name)}</b> <span class="muted">${h(p.quantity)}</span>
        <p class="muted">na 100 g: ${r0(p.per100.kcal)} kcal · B ${r1(p.per100.protein)} · T ${r1(p.per100.fat)} · W ${r1(p.per100.carbs)}</p>
        <div class="row"><label class="grow">Ile gramów?<input id="p-g" type="number" inputmode="decimal" value="${g0}"></label></div>
        <p id="p-calc"></p>
        <button class="btn primary wide" id="p-add">Dodaj</button>
      </div>`;
    const calc = () => {
      const g = Number($("#p-g", sheet).value) || 0, k = g / 100;
      return { name: p.name, grams: g, kcal: p.per100.kcal * k, protein: p.per100.protein * k,
        fat: p.per100.fat * k, carbs: p.per100.carbs * k, source: "barcode", barcode: code };
    };
    const show = () => { const c = calc(); $("#p-calc", sheet).innerHTML = `<b>${r0(c.kcal)} kcal</b> · B ${r1(c.protein)} · T ${r1(c.fat)} · W ${r1(c.carbs)}`; };
    $("#p-g", sheet).oninput = show;
    show();
    $("#p-add", sheet).onclick = () => addEntries([calc()], meal);
  }

  // — Ręcznie —
  $('[data-pane="manual"]', sheet).onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    addEntries([{ name: f.name.value, grams: Number(f.grams.value) || null, kcal: Number(f.kcal.value),
      protein: Number(f.protein.value), fat: Number(f.fat.value), carbs: Number(f.carbs.value) }], meal);
  };
}

// ───────── Edycja wpisu ─────────
function openEntry(e) {
  let meal = e.meal;
  const sheet = openSheet(`
    <div class="sheet-head"><h3>Edytuj wpis</h3><button class="icon-btn" data-close aria-label="Zamknij">✕</button></div>
    ${mealPicker(meal)}
    <form class="grid-form" id="ef">
      <label class="full">Nazwa<input name="name" value="${h(e.name)}" required></label>
      <label>Gramy<input name="grams" type="number" inputmode="decimal" step="any" value="${e.grams ?? ""}"></label>
      <label>Kcal<input name="kcal" type="number" inputmode="decimal" step="any" value="${r0(e.kcal)}"></label>
      <label>Białko<input name="protein" type="number" inputmode="decimal" step="any" value="${r1(e.protein)}"></label>
      <label>Tłuszcze<input name="fat" type="number" inputmode="decimal" step="any" value="${r1(e.fat)}"></label>
      <label>Węgle<input name="carbs" type="number" inputmode="decimal" step="any" value="${r1(e.carbs)}"></label>
      <button class="btn primary full">Zapisz</button>
    </form>
    <div class="row">
      <button class="btn ghost grow" id="again">↻ Zjedz ponownie dziś</button>
      <button class="btn danger" id="del">Usuń</button>
    </div>`);
  const f = $("#ef", sheet);
  $$(".meal-seg button", sheet).forEach((b) => (b.onclick = () => {
    meal = b.dataset.meal;
    $$(".meal-seg button", sheet).forEach((x) => x.classList.toggle("on", x === b));
  }));
  f.grams.onchange = () => {
    const s = scale({ grams: e.grams, kcal: +f.kcal.value, protein: +f.protein.value, fat: +f.fat.value, carbs: +f.carbs.value }, +f.grams.value || 0);
    e = { ...e, grams: s.grams };
    f.kcal.value = r0(s.kcal); f.protein.value = r1(s.protein); f.fat.value = r1(s.fat); f.carbs.value = r1(s.carbs);
  };
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const { error } = await sb.from("food_entries").update({
      meal, name: f.name.value, grams: Number(f.grams.value) || null, kcal: +f.kcal.value,
      protein: +f.protein.value, fat: +f.fat.value, carbs: +f.carbs.value,
    }).eq("id", e.id);
    if (error) return toast(error.message, "err");
    closeSheet(); renderToday();
  };
  $("#again", sheet).onclick = async () => {
    const { error } = await sb.from("food_entries").insert({
      day: localDay(), meal: mealForNow(), name: e.name, grams: e.grams, kcal: e.kcal,
      protein: e.protein, fat: e.fat, carbs: e.carbs, source: e.source, barcode: e.barcode,
    });
    if (error) return toast(error.message, "err");
    closeSheet(); state.day = localDay(); renderToday(); toast("Dodano do dzisiaj", "ok");
  };
  $("#del", sheet).onclick = async () => {
    if (!confirm(`Usunąć „${e.name}”?`)) return;
    const { error } = await sb.from("food_entries").delete().eq("id", e.id);
    if (error) return toast(error.message, "err");
    closeSheet(); renderToday();
  };
}

// ═════════ Trener ═════════
const QUICK = [
  "Zaproponuj mi trening na dziś",
  "Co zjeść na kolację, żeby dobić białko?",
  "Podsumuj mój ostatni tydzień",
  "Rozpisz mi plan treningowy na tydzień",
];

async function renderCoach() {
  const { data: msgs = [] } = await sb.from("chat_messages").select("role, content, created_at")
    .order("created_at", { ascending: false }).limit(60);
  msgs.reverse();

  view().innerHTML = `
    <header class="page-head"><h2>Trener</h2><button class="btn ghost small" id="clear">Wyczyść</button></header>
    <div class="chat" id="chat">
      ${msgs.length ? "" : `<div class="bubble assistant"><p>Cześć! Znam Twój profil, cel i to, co dziś zjadłeś. Pytaj o treningi, jedzenie albo postępy 💪</p></div>`}
      ${msgs.map((m) => `<div class="bubble ${m.role}">${m.role === "assistant" ? md(m.content) : `<p>${h(m.content)}</p>`}</div>`).join("")}
    </div>
    <div class="chips">${QUICK.map((q) => `<button class="chip">${h(q)}</button>`).join("")}</div>
    <form class="composer" id="composer">
      <textarea id="msg" rows="1" placeholder="Napisz albo dyktuj…"></textarea>
      <button type="button" class="icon-btn mic" aria-label="Dyktuj">🎤</button>
      <button class="icon-btn send" aria-label="Wyślij">➤</button>
    </form>`;

  const chat = $("#chat"), input = $("#msg"), form = $("#composer");
  const scroll = () => window.scrollTo(0, document.body.scrollHeight);
  scroll();
  attachMic($(".mic", form), input);
  input.oninput = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; };

  let busy = false;
  const send = async (text) => {
    text = text.trim();
    if (!text || busy) return;
    busy = true;
    form.classList.add("busy");
    chat.insertAdjacentHTML("beforeend", `<div class="bubble user"><p>${h(text)}</p></div><div class="bubble assistant typing"><span></span><span></span><span></span></div>`);
    input.value = ""; input.oninput(); scroll();
    try {
      const res = await callAI({ action: "chat", day: localDay(), message: text });
      $(".typing", chat).outerHTML = `<div class="bubble assistant">${md(res.reply)}</div>`;
    } catch (e) {
      $(".typing", chat).outerHTML = `<div class="bubble assistant error"><p>⚠️ ${h(e.message)}</p></div>`;
    } finally {
      busy = false;
      form.classList.remove("busy");
      scroll();
    }
  };

  form.onsubmit = (e) => { e.preventDefault(); send(input.value); };
  input.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); send(input.value); } };
  $$(".chip").forEach((c) => (c.onclick = () => send(c.textContent)));
  $("#clear").onclick = async () => {
    if (!confirm("Wyczyścić historię rozmowy?")) return;
    await sb.from("chat_messages").delete().eq("user_id", state.user.id);
    renderCoach();
  };

  if (state.pendingCoach) { const q = state.pendingCoach; state.pendingCoach = null; send(q); }
}

// ═════════ Treningi ═════════
const setsToText = (sets) => (sets ?? []).map((s) => (s.kg ? `${s.reps}x${s.kg}` : `${s.reps}`)).join(", ");
const textToSets = (txt) => txt.split(/[,;]+/).map((p) => p.trim()).filter(Boolean).map((p) => {
  const [reps, kg] = p.toLowerCase().replace(/kg/g, "").split(/\s*[x×*]\s*/);
  return { reps: Number(reps) || 0, kg: Number(String(kg ?? "").replace(",", ".")) || 0 };
});

async function renderWorkouts() {
  const { data: list = [] } = await sb.from("workouts").select("*").order("day", { ascending: false }).limit(40);
  view().innerHTML = `
    <header class="page-head"><h2>Treningi</h2><button class="btn primary small" id="new">＋ Nowy</button></header>
    <button class="banner" id="ask">✨ Poproś trenera o plan na dziś →</button>
    ${list.map((w) => `
      <button class="card workout" data-id="${w.id}">
        <div class="row"><b class="grow">${h(w.title)}</b><span class="muted">${new Date(w.day + "T12:00").toLocaleDateString("pl-PL", { day: "numeric", month: "short" })}</span></div>
        <div class="muted">${[w.duration_min && `${w.duration_min} min`, w.kcal_burned && `${w.kcal_burned} kcal`].filter(Boolean).join(" · ")}</div>
        <ul>${(w.exercises ?? []).map((e) => `<li>${h(e.name)} <span class="muted">${h(setsToText(e.sets))}</span></li>`).join("")}</ul>
      </button>`).join("") || `<p class="muted center">Brak treningów. Dodaj pierwszy albo poproś trenera o plan.</p>`}`;

  $("#new").onclick = () => openWorkout();
  $("#ask").onclick = () => { state.pendingCoach = "Zaproponuj mi trening na dziś"; location.hash = "#coach"; };
  $$(".workout").forEach((b) => (b.onclick = () => openWorkout(list.find((w) => String(w.id) === b.dataset.id))));
}

function openWorkout(w = null) {
  const exRow = (e = { name: "", sets: [] }) => `
    <div class="ex"><input class="ex-name" placeholder="Ćwiczenie, np. Przysiad" value="${h(e.name)}">
    <input class="ex-sets" placeholder="powt×kg, np. 10x40, 10x40, 8x45" value="${h(setsToText(e.sets))}">
    <button type="button" class="icon-btn ex-rm" aria-label="Usuń ćwiczenie">✕</button></div>`;

  const sheet = openSheet(`
    <div class="sheet-head"><h3>${w ? "Edytuj trening" : "Nowy trening"}</h3><button class="icon-btn" data-close aria-label="Zamknij">✕</button></div>
    <form class="grid-form" id="wf">
      <label class="full">Nazwa<input name="title" value="${h(w?.title ?? "")}" placeholder="np. Push / Nogi / Bieganie" required></label>
      <label>Data<input name="day" type="date" value="${w?.day ?? localDay()}"></label>
      <label>Minuty<input name="duration" type="number" inputmode="numeric" value="${w?.duration_min ?? ""}"></label>
      <label class="full">Spalone kcal (opcjonalnie)<input name="kcal" type="number" inputmode="numeric" value="${w?.kcal_burned ?? ""}"></label>
      <div class="full" id="exs">${(w?.exercises?.length ? w.exercises : [undefined]).map((e) => exRow(e)).join("")}</div>
      <button type="button" class="btn ghost full" id="add-ex">＋ Ćwiczenie</button>
      <label class="full">Notatki<textarea name="notes" rows="2">${h(w?.notes ?? "")}</textarea></label>
      <button class="btn primary full">Zapisz</button>
      ${w ? `<button type="button" class="btn danger full" id="wdel">Usuń trening</button>` : ""}
    </form>`);

  const bindRm = () => $$(".ex-rm", sheet).forEach((b) => (b.onclick = () => b.parentElement.remove()));
  bindRm();
  $("#add-ex", sheet).onclick = () => { $("#exs", sheet).insertAdjacentHTML("beforeend", exRow()); bindRm(); };

  const f = $("#wf", sheet);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const exercises = $$(".ex", sheet)
      .map((r) => ({ name: $(".ex-name", r).value.trim(), sets: textToSets($(".ex-sets", r).value) }))
      .filter((x) => x.name);
    const row = { title: f.title.value, day: f.day.value || localDay(), duration_min: Number(f.duration.value) || null,
      kcal_burned: Number(f.kcal.value) || null, notes: f.notes.value || null, exercises };
    const { error } = w ? await sb.from("workouts").update(row).eq("id", w.id) : await sb.from("workouts").insert(row);
    if (error) return toast(error.message, "err");
    closeSheet(); renderWorkouts(); toast("Zapisano trening", "ok");
  };
  if (w) $("#wdel", sheet).onclick = async () => {
    if (!confirm("Usunąć trening?")) return;
    await sb.from("workouts").delete().eq("id", w.id);
    closeSheet(); renderWorkouts();
  };
}

// ═════════ Postępy ═════════
async function renderProgress() {
  const today = localDay(), from = shiftDay(today, -6);
  const [{ data: weights = [] }, { data: food = [] }] = await Promise.all([
    sb.from("weights").select("id, day, weight_kg").order("day", { ascending: false }).limit(90),
    sb.from("food_entries").select("day, kcal, protein").gte("day", from).lte("day", today),
  ]);
  const t = tgt();

  // Wykres wagi (SVG)
  const pts = [...weights].reverse();
  let chart = `<p class="muted center">Dodaj co najmniej 2 pomiary, żeby zobaczyć wykres.</p>`;
  if (pts.length >= 2) {
    const W = 320, H = 140, pad = 24;
    const ws = pts.map((p) => Number(p.weight_kg));
    const min = Math.min(...ws) - 0.5, max = Math.max(...ws) + 0.5;
    const t0 = new Date(pts[0].day).getTime(), t1 = new Date(pts.at(-1).day).getTime() || t0 + 1;
    const x = (d) => pad + ((new Date(d).getTime() - t0) / (t1 - t0 || 1)) * (W - pad * 2);
    const y = (v) => H - pad - ((v - min) / (max - min)) * (H - pad * 2);
    const line = pts.map((p) => `${x(p.day).toFixed(1)},${y(p.weight_kg).toFixed(1)}`).join(" ");
    chart = `<svg class="wchart" viewBox="0 0 ${W} ${H}">
      <text x="2" y="${y(max - 0.5) + 4}" class="axis">${r1(max - 0.5)}</text>
      <text x="2" y="${y(min + 0.5) + 4}" class="axis">${r1(min + 0.5)}</text>
      <polyline points="${line}" class="wline"/>
      ${pts.map((p) => `<circle cx="${x(p.day).toFixed(1)}" cy="${y(p.weight_kg).toFixed(1)}" r="2.5" class="wdot"/>`).join("")}
    </svg>`;
  }
  const change = pts.length >= 2 ? r1(pts.at(-1).weight_kg - pts[0].weight_kg) : null;

  // Ostatnie 7 dni kcal
  const days = Array.from({ length: 7 }, (_, i) => shiftDay(from, i));
  const per = Object.fromEntries(days.map((d) => [d, 0]));
  for (const f of food) per[f.day] = (per[f.day] ?? 0) + Number(f.kcal);
  const logged = days.filter((d) => per[d] > 0);
  const avg = logged.length ? r0(logged.reduce((s, d) => s + per[d], 0) / logged.length) : 0;
  const top = Math.max(t?.kcal ?? 0, ...Object.values(per), 1);

  view().innerHTML = `
    <header class="page-head"><h2>Postępy</h2></header>
    <form class="card row" id="wform">
      <label class="grow">Waga dziś (kg)<input name="w" type="number" inputmode="decimal" step="0.1" value="${weights[0]?.day === today ? weights[0].weight_kg : ""}" placeholder="${state.weight ?? "np. 85.4"}" required></label>
      <button class="btn primary">Zapisz</button>
    </form>
    <div class="card">
      <div class="row"><b class="grow">Waga</b>${change !== null ? `<span class="${change <= 0 ? "good" : "bad"}">${change > 0 ? "+" : ""}${change} kg</span>` : ""}</div>
      ${chart}
    </div>
    <div class="card">
      <div class="row"><b class="grow">Kalorie — 7 dni</b><span class="muted">śr. ${avg} kcal${t ? ` / cel ${t.kcal}` : ""}</span></div>
      <div class="bars">
        ${days.map((d) => `<div class="bar-col"><div class="bar-wrap"><div class="bar ${t && per[d] > t.kcal ? "over" : ""}" style="height:${(per[d] / top) * 100}%"></div></div>
          <span>${new Date(d + "T12:00").toLocaleDateString("pl-PL", { weekday: "narrow" })}</span></div>`).join("")}
        ${t ? `<div class="goal-line" style="bottom:${18 + (t.kcal / top) * 120}px"></div>` : ""}
      </div>
    </div>
    <div class="card">
      <b>Pomiary</b>
      ${weights.slice(0, 15).map((w) => `<div class="row wrow"><span class="grow">${w.day}</span><b>${w.weight_kg} kg</b>
        <button class="icon-btn wdel" data-id="${w.id}" aria-label="Usuń pomiar">✕</button></div>`).join("") || `<p class="muted">Brak</p>`}
    </div>`;

  $("#wform").onsubmit = async (e) => {
    e.preventDefault();
    const val = Number(String(e.target.w.value).replace(",", "."));
    const { error } = await sb.from("weights").upsert({ user_id: state.user.id, day: today, weight_kg: val }, { onConflict: "user_id,day" });
    if (error) return toast(error.message, "err");
    await loadProfile();
    toast("Zapisano wagę — cel przeliczony", "ok");
    renderProgress();
  };
  $$(".wdel").forEach((b) => (b.onclick = async () => {
    if (!confirm("Usunąć pomiar?")) return;
    await sb.from("weights").delete().eq("id", b.dataset.id);
    await loadProfile();
    renderProgress();
  }));
}

// ═════════ Ustawienia ═════════
async function renderSettings() {
  const p = state.profile ?? {}, tr = p.training ?? {};
  const { data: usage } = await sb.from("ai_usage").select("count").eq("day", localDay()).maybeSingle();
  const opt = (val, cur, label) => `<option value="${val}" ${String(cur) === String(val) ? "selected" : ""}>${label}</option>`;

  view().innerHTML = `
    <header class="page-head"><h2>Profil</h2></header>
    <form id="sf">
      <div class="card grid-form">
        <h3 class="full">O mnie</h3>
        <label class="full">Imię<input name="name" value="${h(p.name ?? "")}"></label>
        <label>Płeć<select name="sex">${opt("", p.sex, "—")}${opt("m", p.sex, "Mężczyzna")}${opt("f", p.sex, "Kobieta")}</select></label>
        <label>Data urodzenia<input name="birth_date" type="date" value="${p.birth_date ?? ""}"></label>
        <label>Wzrost (cm)<input name="height_cm" type="number" inputmode="decimal" value="${p.height_cm ?? ""}"></label>
        <label>Waga (kg)<input name="weight" type="number" inputmode="decimal" step="0.1" value="${state.weight ?? ""}"></label>
        <label class="full">Aktywność<select name="activity_level">${Object.entries(ACTIVITY).map(([k, v]) => opt(k, p.activity_level ?? "light", v.label)).join("")}</select></label>
      </div>

      <div class="card grid-form">
        <h3 class="full">Cel</h3>
        <label>Cel<select name="goal">${opt("cut", p.goal ?? "cut", "Redukcja")}${opt("maintain", p.goal, "Utrzymanie")}${opt("bulk", p.goal, "Masa")}</select></label>
        <label>Tempo (kg/tydz.)<select name="rate_kg_week">${[0.25, 0.5, 0.75, 1].map((v) => opt(v, Number(p.rate_kg_week ?? 0.5), v)).join("")}</select></label>
        <label>Białko (g/kg)<input name="protein_g_kg" type="number" step="0.1" inputmode="decimal" value="${p.protein_g_kg ?? 2}"></label>
        <label>Tłuszcz (g/kg)<input name="fat_g_kg" type="number" step="0.1" inputmode="decimal" value="${p.fat_g_kg ?? 0.8}"></label>
        <div class="full targets" id="tg"></div>
      </div>

      <div class="card grid-form">
        <h3 class="full">Treningi <span class="muted small">— trener bierze to pod uwagę</span></h3>
        <label>Gdzie<select name="t_place">${["siłownia", "dom", "plener", "mieszane"].map((v) => opt(v, tr.place ?? "siłownia", v)).join("")}</select></label>
        <label>Poziom<select name="t_level">${["początkujący", "średni", "zaawansowany"].map((v) => opt(v, tr.experience ?? "średni", v)).join("")}</select></label>
        <label>Dni w tygodniu<input name="t_days" type="number" min="1" max="7" inputmode="numeric" value="${tr.days_per_week ?? 3}"></label>
        <label>Minut na sesję<input name="t_min" type="number" inputmode="numeric" value="${tr.session_min ?? 60}"></label>
        <label class="full">Sprzęt<input name="t_eq" value="${h(tr.equipment ?? "")}" placeholder="np. pełna siłownia / hantle 2×20 kg, drążek"></label>
        <label class="full">Kontuzje / ograniczenia<input name="t_inj" value="${h(tr.injuries ?? "")}" placeholder="np. bolące kolano, bez skoków"></label>
        <label class="full">Co lubisz / czego nie<input name="t_likes" value="${h(tr.likes ?? "")}" placeholder="np. lubię martwy ciąg, nie znoszę biegania"></label>
        <label class="full">Inne uwagi dla trenera<textarea name="t_notes" rows="2">${h(tr.notes ?? "")}</textarea></label>
      </div>
      <button class="btn primary wide">Zapisz</button>
    </form>
    <div class="card">
      <div class="row"><span class="grow muted">Zapytania AI dziś</span><b>${usage?.count ?? 0}</b></div>
      <div class="row"><span class="grow muted">Konto</span><span>${h(state.user.email)}</span></div>
      <button class="btn ghost wide" id="logout">Wyloguj</button>
    </div>`;

  const f = $("#sf");
  const read = () => ({
    id: state.user.id,
    name: f.name.value || null,
    sex: f.sex.value || null,
    birth_date: f.birth_date.value || null,
    height_cm: Number(f.height_cm.value) || null,
    activity_level: f.activity_level.value,
    goal: f.goal.value,
    rate_kg_week: Number(f.rate_kg_week.value),
    protein_g_kg: Number(f.protein_g_kg.value) || 2,
    fat_g_kg: Number(f.fat_g_kg.value) || 0.8,
    training: {
      place: f.t_place.value, experience: f.t_level.value,
      days_per_week: Number(f.t_days.value) || null, session_min: Number(f.t_min.value) || null,
      equipment: f.t_eq.value, injuries: f.t_inj.value, likes: f.t_likes.value, notes: f.t_notes.value,
    },
    updated_at: new Date().toISOString(),
  });
  const preview = () => {
    const t = targets(read(), Number(f.weight.value) || null);
    $("#tg").innerHTML = t
      ? `<div><span class="muted">BMR</span><b>${t.bmr}</b></div><div><span class="muted">TDEE</span><b>${t.tdee}</b></div>
         <div class="hl"><span class="muted">Cel dzienny</span><b>${t.kcal} kcal</b></div>
         <div><span class="muted">Białko</span><b>${t.protein} g</b></div><div><span class="muted">Tłuszcz</span><b>${t.fat} g</b></div><div><span class="muted">Węgle</span><b>${t.carbs} g</b></div>`
      : `<p class="muted">Uzupełnij płeć, datę urodzenia, wzrost i wagę — cel wyliczy się sam.</p>`;
  };
  f.oninput = preview;
  preview();

  f.onsubmit = async (e) => {
    e.preventDefault();
    const row = read();
    const { error } = await sb.from("profiles").upsert(row);
    if (error) return toast(error.message, "err");
    const w = Number(String(f.weight.value).replace(",", "."));
    if (w && w !== state.weight) {
      const { error: we } = await sb.from("weights").upsert({ user_id: state.user.id, day: localDay(), weight_kg: w }, { onConflict: "user_id,day" });
      if (we) return toast(we.message, "err");
    }
    await loadProfile();
    toast("Zapisano", "ok");
    location.hash = "#today";
  };
  $("#logout").onclick = () => sb.auth.signOut();
}

// ═════════ PWA ═════════
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
boot();
