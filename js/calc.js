// Zapotrzebowanie liczy kod (wzór Mifflin-St Jeor), nie AI — za darmo, szybko i zawsze tak samo.
// Ta sama logika jest w supabase/functions/ai/index.ts, żeby trener widział te same liczby.

export const ACTIVITY = {
  sedentary:   { f: 1.2,   label: "Siedzący (praca przy biurku, brak treningów)" },
  light:       { f: 1.375, label: "Lekki (1–3 treningi/tydz. lub dużo chodzenia)" },
  moderate:    { f: 1.55,  label: "Średni (3–5 treningów/tydz.)" },
  active:      { f: 1.725, label: "Wysoki (6–7 treningów/tydz.)" },
  very_active: { f: 1.9,   label: "Bardzo wysoki (praca fizyczna + treningi)" },
};

export function ageFrom(birth) {
  if (!birth) return null;
  const b = new Date(birth), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a;
}

export function targets(p, weight) {
  const age = ageFrom(p?.birth_date);
  if (!p?.sex || !p?.height_cm || !age || !weight) return null;
  const bmr = 10 * weight + 6.25 * Number(p.height_cm) - 5 * age + (p.sex === "m" ? 5 : -161);
  const tdee = bmr * (ACTIVITY[p.activity_level]?.f ?? 1.375);
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

export function sum(entries) {
  return entries.reduce(
    (s, e) => ({
      kcal: s.kcal + Number(e.kcal), protein: s.protein + Number(e.protein),
      fat: s.fat + Number(e.fat), carbs: s.carbs + Number(e.carbs),
    }),
    { kcal: 0, protein: 0, fat: 0, carbs: 0 },
  );
}

// Przeskalowanie pozycji do nowej gramatury (proporcjonalnie)
export function scale(item, grams) {
  const base = Number(item.grams) || 0;
  if (!base) return { ...item, grams };
  const k = grams / base;
  const r1 = (v) => Math.round(v * k * 10) / 10;
  return { ...item, grams, kcal: Math.round(item.kcal * k), protein: r1(item.protein), fat: r1(item.fat), carbs: r1(item.carbs) };
}

export function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shiftDay(day, n) {
  const d = new Date(day + "T12:00:00");
  d.setDate(d.getDate() + n);
  return localDay(d);
}

export function mealForNow() {
  const h = new Date().getHours();
  if (h < 11) return "breakfast";
  if (h < 16) return "lunch";
  if (h < 21) return "dinner";
  return "snack";
}
