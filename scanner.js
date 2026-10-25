// Skaner kodów kreskowych + Open Food Facts (darmowa baza, sporo polskich produktów).
// Safari na iOS nie ma BarcodeDetector, więc używamy biblioteki html5-qrcode (ładowanej dopiero przy użyciu).

const LIB = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
let libPromise;

function loadLib() {
  libPromise ??= new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = LIB;
    s.onload = res;
    s.onerror = () => { libPromise = null; rej(new Error("Nie udało się załadować skanera")); };
    document.head.append(s);
  });
  return libPromise;
}

// Uruchamia kamerę w elemencie o danym id; zwraca funkcję stop()
export async function startScanner(elementId, onCode) {
  await loadLib();
  const F = window.Html5QrcodeSupportedFormats;
  const scanner = new window.Html5Qrcode(elementId, {
    formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128],
    verbose: false,
  });
  let done = false;
  await scanner.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 260, height: 140 } },
    (code) => {
      if (done) return;
      done = true;
      scanner.stop().catch(() => {}).finally(() => onCode(code));
    },
  );
  return () => { if (!done) { done = true; scanner.stop().catch(() => {}); } };
}

export async function lookupBarcode(code) {
  const fields = "product_name,product_name_pl,brands,nutriments,serving_quantity,quantity";
  const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${fields}`);
  if (!res.ok) return null;
  const j = await res.json();
  if (j.status !== 1 || !j.product) return null;
  const p = j.product, n = p.nutriments ?? {};
  const kcal = n["energy-kcal_100g"] ?? (n["energy_100g"] ? n["energy_100g"] / 4.184 : null);
  if (kcal == null) return null;
  const name = [p.product_name_pl || p.product_name, p.brands?.split(",")[0]].filter(Boolean).join(" — ");
  return {
    name: name || `Produkt ${code}`,
    per100: {
      kcal: Number(kcal) || 0,
      protein: Number(n.proteins_100g) || 0,
      fat: Number(n.fat_100g) || 0,
      carbs: Number(n.carbohydrates_100g) || 0,
    },
    serving: Number(p.serving_quantity) || null,
    quantity: p.quantity ?? "",
  };
}
