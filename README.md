# Tierlist Bot (1 channel + pinned dashboard + image tierlist)

## What it does
- One channel (recommended: `#tierlist`).
- Bot posts **one** dashboard message and pins it.
- Dashboard shows a **generated PNG tierlist** (S/A/B/C/D) with character icons.
- Button **Start rating** opens an **ephemeral wizard** (no channel spam):
  - choose main (required)
  - rate all other 15 characters
  - Submit
- After Submit:
  - user locked for `COOLDOWN_HOURS` (default 24h)
  - tierlist image auto-rebuilds and dashboard message auto-updates
- Mods can rename tiers with `/tiers set` (image updates immediately).
- Optional: daily DM reminder when user can rate again.

## 0) Server setup (important)
Create a text channel, e.g. `#tierlist`.
Permissions:
- @everyone: View Channel ✅, Send Messages ❌
- Bot: View ✅, Send ✅, Embed Links ✅, Attach Files ✅, Read History ✅, Manage Messages ✅ (for pin)

If people can chat in the channel, the "always on top" idea breaks.

## 1) Local install
1) Install Node.js LTS
2) In project folder:
   ```bash
   npm i
   ```
3) Copy `.env.example` -> `.env` and fill:
   - DISCORD_TOKEN
   - CLIENT_ID (Application ID)
   - GUILD_ID (Server ID)

4) Register slash commands (once per guild):
   ```bash
   npm run deploy-commands
   ```

5) Start:
   ```bash
   npm start
   ```

## 2) Create the dashboard message
In Discord run:
- `/setup channel:#tierlist`

Bot will post and pin the dashboard.

## 3) Add character icons (to look like a real tierlist)
Put 16 PNG files into:
- `assets/characters/`

Filenames must match ids from `config/characters.json`, e.g. `honored_one.png`.

Then run in Discord:
- `/rebuild` (or just Submit once; image updates on Submit)

## 4) Rename tier labels (mods)
- `/tiers set tier:S name:Имба`
- `/tiers set tier:B name:Норма`

## 5) Railway deploy (quick)
1) Push to GitHub (do NOT push `.env`)
2) Railway -> New Project -> Deploy from GitHub
3) Add Variables:
   - DISCORD_TOKEN
   - CLIENT_ID
   - GUILD_ID
   - COOLDOWN_HOURS=24
   - DATA_DIR=./data
4) Add a **Volume** and mount it to `/app/data` so `data/state.json` survives redeploys.
5) Deploy. Check logs: "Logged in as ..."

## Notes
- Ephemeral wizard means no spam in your tierlist channel.
- Image generation uses PureImage. Cyrillic works best with a proper TTF font in `assets/fonts/`.
