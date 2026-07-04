# Localization (Multi-Language Support)

Supports the Southeast Asia market opportunity already defined in the company proposal (50,000+ cafés, 200,000+ ISPs, 100,000+ esports centers across the region) — not just the Philippines.

---

## Language Rollout Phases

### Phase 1: Launch (Philippines)
- **English** (default/fallback)
- **Filipino/Tagalog**

### Phase 2: Southeast Asia Expansion
- **Bahasa Indonesia** (Indonesia — largest SEA market by population)
- **Vietnamese** (Vietnam)
- **Thai** (Thailand)
- **Bahasa Melayu** (Malaysia/Brunei)

### Phase 3: Further Reach (as demand justifies)
- **Mandarin (Simplified)** — Singapore, Malaysia Chinese-speaking communities
- **Khmer** (Cambodia), **Lao** (Laos), **Burmese** (Myanmar) — smaller/later markets, add only if actual café demand appears

---

## Where Language Applies

- **Kiosk UI (ZenCafe OS)** — per-branch default language, but individual players can also set their own preferred language on login (their profile remembers it across branches)
- **Admin Dashboard** — café owner/staff choose their own working language, independent of what players see
- **Emails** (password reset, temp account expiry reminders) — sent in the player's preferred language if set, otherwise falls back to the branch/café default

---

## Technical Approach

- **Key-based translation files** (e.g., JSON: `{"session_start_button": "Simulan ang Sesyon"}`) — adding a new language is just adding a new file, no code changes required
- **English as fallback** — if a translation key is missing in a language file, English displays instead of a blank/broken string
- **No paid translation API needed for v1** — since we're targeting free-tier development:
  - Start with community/volunteer translation (e.g., beta café partners who speak the language help translate directly)
  - Or use free machine translation as a rough draft, then have a native speaker review before publishing — avoids embarrassing mistranslations in a customer-facing product

---

## Data Model Implications

```
users (players) — addition
  ├─ preferred_language (e.g., "en", "fil", "id", "vi", "th", "ms")

cafes — addition
  ├─ default_language (per branch)

translation_keys — new table or static JSON files per language
  ├─ key (e.g., "session_start_button")
  ├─ language_code
  ├─ value
```

---

## Open Decisions (Need Owner Input)

- [ ] Which language should be built second, right after Tagalog — Bahasa Indonesia (largest market) is the likely candidate, but confirm priority
- [ ] Should translation files live as static JSON (simpler, redeploy needed for updates) or a database table (editable live via admin, more flexible but more engineering)?
- [ ] Who reviews/approves community-submitted translations before they go live — you, or a trusted regional partner?
