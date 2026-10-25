import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const h = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const r0 = (v) => Math.round(Number(v) || 0);
export const r1 = (v) => Math.round((Number(v) || 0) * 10) / 10;

export const MEALS = { breakfast: "Śniadanie", lunch: "Obiad", dinner: "Kolacja", snack: "Przekąski" };

export function toast(msg, kind = "") {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3200);
}

// ───────── Arkusz (modal od dołu) ─────────
export function openSheet(html, onMount) {
  closeSheet();
  const wrap = document.createElement("div");
  wrap.className = "sheet-wrap";
  wrap.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet" role="dialog">${html}</div>`;
  document.body.append(wrap);
  document.body.classList.add("no-scroll");
  $(".sheet-backdrop", wrap).onclick = closeSheet;
  $$("[data-close]", wrap).forEach((b) => (b.onclick = closeSheet));
  requestAnimationFrame(() => wrap.classList.add("open"));
  onMount?.($(".sheet", wrap));
  return $(".sheet", wrap);
}

export function closeSheet() {
  $$(".sheet-wrap").forEach((w) => w.remove());
  document.body.classList.remove("no-scroll");
  window.dispatchEvent(new Event("sheetclose"));
}

// ───────── Wywołanie funkcji AI na serwerze ─────────
export async function callAI(body) {
  const { data, error } = await sb.functions.invoke("ai", { body });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error ?? msg; } catch { /* brak treści */ }
    throw new Error(msg);
  }
  return data;
}

// Zmniejsza zdjęcie przed wysłaniem — mniej danych i tokenów, AI i tak widzi wystarczająco
export async function compressImage(file, max = 1024, quality = 0.8) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL("image/jpeg", quality);
    return { data: dataUrl.split(",")[1], mime: "image/jpeg", preview: dataUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ───────── Dyktowanie ─────────
// Na iPhonie najpewniejszy jest mikrofon na klawiaturze iOS — działa w każdym polu tekstowym.
// Jeśli przeglądarka ma Web Speech API, dokładamy własny przycisk 🎤.
export function attachMic(button, field) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { button.remove(); return; }
  let rec = null;
  button.onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = "pl-PL";
    rec.interimResults = true;
    rec.continuous = false;
    const before = field.value ? field.value.trimEnd() + " " : "";
    rec.onresult = (e) => {
      field.value = before + [...e.results].map((r) => r[0].transcript).join("");
      field.dispatchEvent(new Event("input"));
    };
    rec.onerror = (e) => {
      if (e.error !== "aborted") toast("Dyktowanie niedostępne — użyj mikrofonu na klawiaturze", "warn");
    };
    rec.onend = () => { rec = null; button.classList.remove("rec"); };
    button.classList.add("rec");
    rec.start();
  };
}

// Mini-markdown dla odpowiedzi trenera (po escape, więc bezpieczne)
export function md(text) {
  const lines = h(text).split(/\n/);
  let out = "", list = false;
  for (const raw of lines) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|\s)\*(.+?)\*/g, "$1<i>$2</i>");
    const m = line.match(/^\s*(?:[-•*]|\d+[.)])\s+(.*)/);
    if (m) {
      if (!list) { out += "<ul>"; list = true; }
      out += `<li>${m[1]}</li>`;
      continue;
    }
    if (list) { out += "</ul>"; list = false; }
    const hd = line.match(/^#{1,4}\s+(.*)/);
    if (hd) out += `<p><b>${hd[1]}</b></p>`;
    else if (line.trim()) out += `<p>${line}</p>`;
  }
  return out + (list ? "</ul>" : "");
}
