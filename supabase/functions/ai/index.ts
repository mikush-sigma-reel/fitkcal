// FitKcal — funkcja serwerowa AI (Supabase Edge Function, Deno).
// Klucz do AI jest tylko tutaj (sekrety Supabase), nigdy w aplikacji na telefonie.
//
// Każda akcja z aplikacji = DOKŁADNIE JEDNO zapytanie do modelu:
//   { action: "food", day, text?, image?: { data: base64, mime } }  → rozpoznanie jedzenia (JSON)
//   { action: "chat", day, message }                                  → odpowiedź trenera
//
// Sekrety (Dashboard → Edge Functions → Secrets):
//   AI_PROVIDER     "gemini" (domyślnie) albo "claude"
//   AI_MODEL        np. "gemini-2.5-flash" albo "claude-haiku-5-5"
//   GEMINI_API_KEY  klucz z Google AI Studio (gdy provider = gemini)
//   ANTHROPIC_API_KEY klucz z console.anthropic.com (gdy provider = claude)
//   AI_DAILY_LIMIT  maks. zapytań AI na osobę dziennie (domyślnie 150)

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const PROVIDER = (Deno.env.get("AI_PROVIDER") ?? "gemini").toLowerCase();
const MODEL = Deno.env.get("AI_MODEL") ?? (PROVIDER === "claude" ? "claude-haiku-5-5" : "gemini-2.5-flash");
const DAILY_LIMIT = Number(Deno.env.get("AI_DAILY_LIMIT") ?? "150");
const CHAT_HISTORY = 12;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ───────── Wyliczenia (ta sama logika co js/calc.js w aplikacji) ─────────
const ACTIVITY: Record<string, number> = {
  sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9,
};

function ageFrom(birth: string | null): number | null {
  if (!birth) return null;
  const b = new Date(birth), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a;
}

function targets(p: any, weight: number | null) {
  const age = ageFrom(p?.birth_date);
  if (!p?.sex || !p?.height_cm || !age || !weight) return null;
  const bmr = 10 * weight + 6.25 * Number(p.height_cm) - 5 * age + (p.sex === "m" ? 5 : -161);
  const tdee = bmr * (ACTIVITY[p.activity_level] ?? 1.375);
  const delta = (Number(p.rate_kg_week ?? 0.5) * 7700) / 7;
  let kcal = tdee;
  if (p.goal === "cut") kcal = Math.max(tdee - delta, p.sex === "m" ? 1500 : 1200);
  if (p.goal === "bulk") kcal = tdee + delta;
  const protein = Number(p.protein_g_kg ?? 2) * weight;
  const fat = Number(p.fat_g_kg ?? 0.8) * weight;
  const carbs = Math.max(0, (kcal - protein * 4 - fat * 9) / 4);
  const r = Math.round;
  return { age, bmr: r(bmr), tdee: r(tdee), kcal: r(kcal), protein: r(protein), fat: r(fat), carbs: r(carbs) };
}

// ───────── Kontekst użytkownika do prompta ─────────
async function loadContext(db: any, day: string) {
  const since = new Date(day);
  since.setDate(since.getDate() - 6);
  const sinceStr = since.toISOString().slice(0, 10);

  const [profile, weights, todayFood, weekFood, workouts] = await Promise.all([
    db.from("profiles").select("*").maybeSingle(),
    db.from("weights").select("day, weight_kg").order("day", { ascending: false }).limit(8),
    db.from("food_entries").select("name, grams, kcal, protein, fat, carbs, meal").eq("day", day),
    db.from("food_entries").select("day, kcal, protein").gte("day", sinceStr).lte("day", day),
    db.from("workouts").select("day, title, duration_min, exercises, notes")
      .order("day", { ascending: false }).limit(5),
  ]);

  const p = profile.data ?? {};
  const w = weights.data ?? [];
  const current = w[0] ? Number(w[0].weight_kg) : null;
  const t = targets(p, current);

  const eaten = (todayFood.data ?? []).reduce(
    (s: any, e: any) => ({
      kcal: s.kcal + Number(e.kcal), protein: s.protein + Number(e.protein),
      fat: s.fat + Number(e.fat), carbs: s.carbs + Number(e.carbs),
    }),
    { kcal: 0, protein: 0, fat: 0, carbs: 0 },
  );

  const perDay: Record<string, { kcal: number; protein: number }> = {};
  for (const e of weekFood.data ?? []) {
    perDay[e.day] ??= { kcal: 0, protein: 0 };
    perDay[e.day].kcal += Number(e.kcal);
    perDay[e.day].protein += Number(e.protein);
  }

  const goalPl: Record<string, string> = { cut: "redukcja", maintain: "utrzymanie", bulk: "masa" };
  const r = Math.round;
  const lines = [
    `Dzisiejsza data: ${day}`,
    `Imię: ${p.name ?? "?"}, płeć: ${p.sex === "m" ? "mężczyzna" : p.sex === "f" ? "kobieta" : "?"}, ` +
      `wiek: ${t?.age ?? ageFrom(p.birth_date) ?? "?"}, wzrost: ${p.height_cm ?? "?"} cm, waga: ${current ?? "?"} kg`,
    `Cel: ${goalPl[p.goal] ?? "?"} (${p.rate_kg_week ?? "?"} kg/tydz.), aktywność: ${p.activity_level ?? "?"}`,
    `Historia wagi (najnowsze pierwsze): ${w.map((x: any) => `${x.day}: ${x.weight_kg}`).join(", ") || "brak"}`,
    t
      ? `Dzienny cel: ${t.kcal} kcal, B ${t.protein} g, T ${t.fat} g, W ${t.carbs} g (BMR ${t.bmr}, TDEE ${t.tdee})`
      : "Dzienny cel: nieznany — profil niekompletny (poproś o uzupełnienie w Ustawieniach).",
    `Zjedzone dziś: ${r(eaten.kcal)} kcal, B ${r(eaten.protein)} g, T ${r(eaten.fat)} g, W ${r(eaten.carbs)} g` +
      (t ? ` → zostało ${r(t.kcal - eaten.kcal)} kcal, B ${r(t.protein - eaten.protein)} g` : ""),
    `Dzisiejsze wpisy: ${(todayFood.data ?? []).map((e: any) => `${e.name} ${e.grams ?? "?"}g ${r(e.kcal)}kcal`).join("; ") || "brak"}`,
    `Ostatnie 7 dni (kcal/białko): ${Object.entries(perDay).sort().map(([d, v]) => `${d}: ${r(v.kcal)}/${r(v.protein)}g`).join(", ") || "brak"}`,
    `Preferencje treningowe: ${JSON.stringify(p.training ?? {})}`,
    `Ostatnie treningi: ${(workouts.data ?? []).map((x: any) =>
      `${x.day} ${x.title}${x.duration_min ? ` ${x.duration_min}min` : ""}: ` +
      (x.exercises ?? []).map((e: any) => `${e.name} ${(e.sets ?? []).map((s: any) => `${s.reps}x${s.kg ?? 0}kg`).join(",")}`).join("; ")
    ).join(" | ") || "brak"}`,
  ];
  return lines.join("\n");
}

// ───────── Prompty ─────────
const FOOD_SYSTEM = `Jesteś dietetykiem sportowym i ekspertem od szacowania wartości odżywczych jedzenia ze zdjęć i opisów.
Zadanie: rozpoznaj wszystkie produkty/potrawy i oszacuj gramaturę, kcal oraz makro (białko, tłuszcz, węglowodany w gramach).

Zasady:
- Informacje podane przez użytkownika w tekście (waga, ilość, opakowanie, marka, sposób przygotowania) mają ZAWSZE pierwszeństwo przed oceną wzrokową. Przykład: "pół paczki frytek 750 g" = 375 g frytek.
- Jeśli na zdjęciu widać etykietę z wartościami odżywczymi, odczytaj je i przelicz na podaną porcję.
- Uwzględniaj ukryte kalorie (tłuszcz do smażenia, sosy, masło) zgodnie z opisem; gdy nie wiadomo — przyjmij typowe domowe przygotowanie i wspomnij o tym w "note".
- Dla produktów mrożonych/surowych przyjmuj wartości dla stanu podanego przez użytkownika (np. frytki z piekarnika vs smażone).
- Liczby zaokrąglaj: kcal do 1, makro do 0.1, gramy do 1.
- "note": maks. 2 krótkie zdania po polsku — co założyłeś i ewentualnie jedna rada w kontekście celu użytkownika.

Odpowiedz WYŁĄCZNIE poprawnym JSON (bez markdown) w formacie:
{"items":[{"name":"string","grams":number,"kcal":number,"protein":number,"fat":number,"carbs":number}],"confidence":"low|medium|high","note":"string"}
Jeśli na zdjęciu nie ma jedzenia, zwróć {"items":[],"confidence":"low","note":"<wyjaśnienie>"}.`;

const COACH_SYSTEM = `Jesteś osobistym trenerem i dietetykiem sportowym użytkownika aplikacji FitKcal. Mówisz po polsku, na "ty", konkretnie i życzliwie, bez lania wody.
Znasz jego aktualne dane (poniżej, odświeżane przy każdej wiadomości) — korzystaj z nich, nie pytaj o rzeczy, które już tu są.

Specjalizacja:
- Redukcja/utrzymanie/masa: bilans kaloryczny, białko, sytość, planowanie posiłków pod pozostały budżet kcal i makro.
- Treningi: plany dopasowane do miejsca, sprzętu, liczby dni, czasu sesji, doświadczenia i kontuzji z preferencji. Progresja na podstawie ostatnich treningów.
- Gdy podajesz plan treningu: lista ćwiczeń z seriami × powtórzeniami, przerwą i krótką wskazówką techniczną; rozgrzewka na początku.
- Gdy profil jest niekompletny, poproś o uzupełnienie Ustawień.

Bezpieczeństwo: nie schodź poniżej rozsądnego minimum kalorycznego, nie promuj skrajnych diet ani odwodnienia. Przy bólu, urazie, chorobach lub lekach odsyłaj do lekarza/fizjoterapeuty. Nie stawiaj diagnoz.
Formatowanie: krótkie akapity, listy z "- ", pogrubienia **tak**. Zwykle do 200 słów, chyba że użytkownik prosi o pełny plan.`;

// ───────── Wywołania modeli (jedno zapytanie + ponowienie tylko przy limicie/przeciążeniu) ─────────
type Part = { text: string } | { image: { data: string; mime: string } };
type Turn = { role: "user" | "assistant"; parts: Part[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry(call: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await call();
    if (![429, 500, 503, 529].includes(res.status) || attempt >= 2) return res;
    // Gemini podaje sugerowany czas w RetryInfo, Claude w nagłówku retry-after
    let wait = 2000 * (attempt + 1);
    const ra = Number(res.headers.get("retry-after"));
    if (ra) wait = ra * 1000;
    try {
      const body = await res.clone().json();
      const info = body?.error?.details?.find((d: any) => d.retryDelay);
      if (info) wait = parseFloat(info.retryDelay) * 1000;
    } catch { /* ignore */ }
    if (wait > 10000) return res; // nie trzymamy telefonu dłużej — zgłaszamy limit
    await sleep(wait);
  }
}

async function callModel(system: string, turns: Turn[], wantJson: boolean): Promise<string> {
  if (PROVIDER === "claude") {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) throw new HttpError(500, "Brak sekretu ANTHROPIC_API_KEY");
    const res = await withRetry(() =>
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1500,
          system,
          messages: turns.map((t) => ({
            role: t.role,
            content: t.parts.map((p) =>
              "text" in p
                ? { type: "text", text: p.text }
                : { type: "image", source: { type: "base64", media_type: p.image.mime, data: p.image.data } }
            ),
          })),
        }),
      })
    );
    if (!res.ok) throw await modelError(res);
    const out = await res.json();
    return (out.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  }

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new HttpError(500, "Brak sekretu GEMINI_API_KEY");
  const res = await withRetry(() =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: turns.map((t) => ({
          role: t.role === "assistant" ? "model" : "user",
          parts: t.parts.map((p) =>
            "text" in p ? { text: p.text } : { inline_data: { mime_type: p.image.mime, data: p.image.data } }
          ),
        })),
        generationConfig: {
          temperature: wantJson ? 0.2 : 0.7,
          ...(wantJson ? { responseMimeType: "application/json" } : {}),
        },
      }),
    })
  );
  if (!res.ok) throw await modelError(res);
  const out = await res.json();
  const text = out.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
  if (!text) throw new HttpError(502, "Model nie zwrócił odpowiedzi (możliwa blokada treści).");
  return text;
}

async function modelError(res: Response) {
  const body = await res.text();
  console.error("AI error", res.status, body.slice(0, 500));
  if (res.status === 429) return new HttpError(429, "Limit zapytań AI chwilowo wyczerpany — spróbuj za minutę.");
  return new HttpError(502, `Błąd AI (${res.status}).`);
}

function parseJson(text: string) {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new HttpError(502, "AI zwróciło niepoprawny format.");
  return JSON.parse(text.slice(start, end + 1));
}

const num = (v: unknown, d = 1) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10 ** d) / 10 ** d : 0;
};

// ───────── Handler ─────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) throw new HttpError(401, "Brak logowania");

    const url = Deno.env.get("SUPABASE_URL")!;
    const db = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await db.auth.getUser(auth.replace("Bearer ", ""));
    if (!user) throw new HttpError(401, "Sesja wygasła — zaloguj się ponownie");

    const body = await req.json();
    const day = /^\d{4}-\d{2}-\d{2}$/.test(body.day ?? "") ? body.day : new Date().toISOString().slice(0, 10);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: used, error: usageErr } = await admin.rpc("bump_ai_usage", { p_user: user.id });
    if (usageErr) throw new HttpError(500, "Licznik AI: " + usageErr.message);
    if (used > DAILY_LIMIT) throw new HttpError(429, `Dzienny limit AI (${DAILY_LIMIT}) wykorzystany.`);

    const context = await loadContext(db, day);

    if (body.action === "food") {
      const text = String(body.text ?? "").slice(0, 2000).trim();
      if (!text && !body.image?.data) throw new HttpError(400, "Dodaj zdjęcie albo opis.");
      const parts: Part[] = [];
      if (body.image?.data) {
        if (body.image.data.length > 6_000_000) throw new HttpError(413, "Zdjęcie za duże.");
        parts.push({ image: { data: body.image.data, mime: body.image.mime ?? "image/jpeg" } });
      }
      parts.push({ text: `Opis od użytkownika: ${text || "(brak — oceń tylko ze zdjęcia)"}` });

      const raw = await callModel(`${FOOD_SYSTEM}\n\n--- Dane użytkownika ---\n${context}`, [{ role: "user", parts }], true);
      const out = parseJson(raw);
      const items = (Array.isArray(out.items) ? out.items : []).slice(0, 20).map((i: any) => ({
        name: String(i.name ?? "Produkt").slice(0, 120),
        grams: num(i.grams, 0), kcal: num(i.kcal, 0),
        protein: num(i.protein), fat: num(i.fat), carbs: num(i.carbs),
      }));
      return json({ items, confidence: out.confidence ?? "medium", note: String(out.note ?? ""), used, limit: DAILY_LIMIT });
    }

    if (body.action === "chat") {
      const message = String(body.message ?? "").slice(0, 4000).trim();
      if (!message) throw new HttpError(400, "Pusta wiadomość.");

      const { data: hist } = await db.from("chat_messages").select("role, content")
        .order("created_at", { ascending: false }).limit(CHAT_HISTORY);
      // Historia musi zaczynać się od "user" i naprzemiennie zmieniać role
      const turns: Turn[] = [];
      for (const m of (hist ?? []).reverse()) {
        if (!turns.length && m.role !== "user") continue;
        const last = turns[turns.length - 1];
        if (last?.role === m.role) (last.parts[0] as { text: string }).text += "\n\n" + m.content;
        else turns.push({ role: m.role, parts: [{ text: m.content }] });
      }
      if (turns[turns.length - 1]?.role === "user") turns.pop();
      turns.push({ role: "user", parts: [{ text: message }] });

      const reply = (await callModel(`${COACH_SYSTEM}\n\n--- Dane użytkownika ---\n${context}`, turns, false)).trim();
      await db.from("chat_messages").insert([
        { role: "user", content: message },
        { role: "assistant", content: reply },
      ]);
      return json({ reply, used, limit: DAILY_LIMIT });
    }

    throw new HttpError(400, "Nieznana akcja");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (!(e instanceof HttpError)) console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});
