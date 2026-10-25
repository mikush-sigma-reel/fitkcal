# FitKcal 🔥

Twój licznik kalorii na iPhone'a (PWA): zdjęcie + opis → AI liczy kcal i makro, skaner kodów kreskowych,
dziennik, waga z wykresem, log treningów i czat z trenerem AI, który zna Twój profil.

## Jak to działa

```
iPhone (PWA z GitHub Pages)
   │  logowanie, dziennik, waga, treningi  →  Supabase (baza Postgres + RLS)
   │  zdjęcie / opis / czat                →  Supabase Edge Function "ai"  →  Gemini albo Claude
   │  kod kreskowy                         →  Open Food Facts (darmowe, bez klucza)
```

- **Jedna akcja = jedno zapytanie do AI.** Zdjęcie, Twój opis, profil i dzisiejszy bilans idą razem w jednym prompcie.
  Przy błędzie „za dużo zapytań” serwer sam odczeka i ponowi maksymalnie 2 razy. Do tego obowiązuje dzienny limit na osobę.
- **Cel kaloryczny liczy kod** (wzór Mifflin-St Jeor plus aktywność i tempo redukcji), a nie AI. Zmieniasz wagę albo
  ustawienia, a cel przelicza się od razu. Trener dostaje te same liczby w każdym prompcie.
- **Klucz AI jest tylko na serwerze** (w sekretach Supabase). W kodzie aplikacji nie ma nic tajnego.
- Przed wysłaniem zdjęcie jest zmniejszane do 1024 px. Mniej danych to mniej tokenów i szybsza odpowiedź.

## Wdrożenie (ok. 20 minut, bez instalowania czegokolwiek)

### 1. Supabase (baza + serwer), darmowy plan
1. Załóż projekt na <https://supabase.com>.
2. **SQL Editor → New query** → wklej całość z [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
3. **Authentication → Sign In / Providers → Email**: włączone. Dla wygody możesz wyłączyć „Confirm email”.

### 2. Klucz do AI
- **Gemini** (domyślnie): <https://aistudio.google.com> → *Get API key*. Darmowy plan ma limity, które Google często zmienia.
  Aktualny limit i listę modeli sprawdzisz w AI Studio. Jeśli chcesz mieć spokój z limitami, włącz płatności
  i ustaw limit wydatków (np. 20 zł). Przy jednym użytkowniku to zwykle grosze. Uwaga: na darmowym planie Google
  może używać zapytań do trenowania modeli.
- **Claude** (alternatywa): <https://console.anthropic.com> → API Keys. Nie ma darmowego planu, płacisz za użycie.

### 3. Funkcja serwerowa `ai`
1. Supabase → **Edge Functions → Deploy a new function → Via Editor**.
2. Nazwa: **`ai`**. Wklej treść [`supabase/functions/ai/index.ts`](supabase/functions/ai/index.ts) → **Deploy**.
3. **Edge Functions → Secrets** → dodaj:

| Nazwa | Wartość |
|---|---|
| `AI_PROVIDER` | `gemini` albo `claude` |
| `AI_MODEL` | np. `gemini-2.5-flash` (sprawdź aktualną nazwę w AI Studio) albo `claude-haiku-5-5` |
| `GEMINI_API_KEY` | klucz z AI Studio (gdy gemini) |
| `ANTHROPIC_API_KEY` | klucz z Anthropic (gdy claude) |
| `AI_DAILY_LIMIT` | np. `150` (limit zapytań na osobę dziennie) |

Model zmieniasz samym sekretem, bez ruszania kodu.

### 4. Połącz aplikację z Supabase
W [`js/config.js`](js/config.js) wpisz **Project URL** i klucz **anon / publishable**
(Supabase → Project Settings → API). Ten klucz jest publiczny z założenia, bo dane chroni RLS.

### 5. Hosting na GitHub Pages (darmowy, HTTPS jest potrzebny do aparatu i mikrofonu)
1. GitHub → **New repository** (np. `fitkcal`).
2. **Add file → Upload files** → przeciągnij całą zawartość tego folderu → *Commit*.
3. **Settings → Pages** → Source: *Deploy from a branch*, branch `main`, folder `/ (root)` → Save.
4. Po minucie aplikacja jest pod adresem `https://TWOJ-LOGIN.github.io/fitkcal/`.
5. Supabase → **Authentication → URL Configuration** → *Site URL* ustaw na ten adres.

### 6. Na iPhonie
Otwórz adres w **Safari** → *Udostępnij* → **Dodaj do ekranu początkowego**. Zaloguj się (*Załóż konto* przy pierwszym
razie), uzupełnij Profil i gotowe. Przy pierwszym zdjęciu albo skanowaniu zezwól na dostęp do aparatu.

### Znajomi
Znajomy zakłada konto tym samym linkiem i widzi tylko swoje dane. Gdy wszyscy mają już konta, zablokuj
nowe rejestracje: Authentication → Sign In / Providers → wyłącz *Allow new users to sign up*. Nowe osoby
możesz potem zapraszać z Authentication → Users → *Invite user*.

## Korzystanie
- **＋ → ✨ AI**: zrób zdjęcie i/lub dopisz szczegóły („pół paczki frytek 750 g z piekarnika”). Twoje dane mają
  pierwszeństwo przed oceną ze zdjęcia. Wynik możesz poprawić przed zapisaniem: zmiana gramów przelicza całą pozycję.
- **Dyktowanie:** na iPhonie najpewniej działa 🎤 na klawiaturze iOS (w każdym polu tekstowym).
- **▥ Kod**: skaner kodów kreskowych, dane z Open Food Facts. Gdy produktu nie ma w bazie, zrób zdjęcie etykiety w zakładce AI.
- **Kliknięcie wpisu**: edycja, usunięcie albo „Zjedz ponownie dziś”.
- **Trener**: zna Twój profil, cel, dzisiejszy bilans, ostatnie 7 dni, wagę, preferencje i ostatnie treningi.
- **Profil**: poziom aktywności już obejmuje treningi, więc spalone kcal z treningów nie są doliczane do celu (żeby nie liczyć ich dwa razy).

## Aktualizacje aplikacji
Po zmianie plików podbij `CACHE` w [`sw.js`](sw.js) (np. `fitkcal-v2`), żeby telefon pobrał nową wersję.
