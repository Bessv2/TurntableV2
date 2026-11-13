# Listening Room

A small Turntable.fm-style group listening room that runs entirely on Cloudflare Workers.

- Up to 5 DJ seats. When a song ends, the DJ in the play seat rotates to the back, and played songs go to the bottom of that DJ's queue.
- Each person's queue is private, so nobody sees what's coming until it plays.
- 👍 Awesome / 👎 Lame voting. Each Awesome is a point for the DJ. A song is voted off when 2+ Lame votes are more than half the listeners.
- Chat with GIF search (Giphy). Pasted image or GIF links show inline.
- Song search uses Spotify's catalog, or iTunes when Spotify isn't set up. Each song is matched to a YouTube upload of the same length when it's queued.
- **Playback per listener:** people logged in with Spotify Premium (on the app's allowlist) hear Spotify, and everyone else hears the matched YouTube video. Everyone is synced to the same server clock, usually within 1–2 seconds.
- You can also paste a YouTube link to queue any video.
- Separate rooms: `https://your-site/?room=friday`.

## How it works

```
public/        static site (index.html, style.css, app.js) - no build step
src/worker.js  API routes, the Room Durable Object, and MatchCache (saved YouTube matches)
```

The server never streams audio. It holds the room state (`current track + startedAt`), and each browser plays the track in its own Spotify or YouTube player at `now - startedAt`. A Durable Object alarm moves to the next song when the track's duration is up.

## Setup

### 1. Put the code on GitHub
Create a private repo and push this folder to it.

### 2. Deploy on Cloudflare
1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository** → pick the repo.
2. Keep the defaults (deploy command `npx wrangler deploy`) and deploy.
3. Note the URL, e.g. `https://listening-room.<your-subdomain>.workers.dev`.

Every push to `main` redeploys from then on.

(Alternative from your machine: `npm install`, `npx wrangler login`, `npx wrangler deploy`.)

### 3. Add secrets
Worker → **Settings** → **Variables and Secrets** → add these as type **Secret**:

| Name | Needed? | What for |
|---|---|---|
| `YOUTUBE_API_KEY` | Yes | Matching songs to YouTube, and pasted links |
| `ROOM_PASSWORD` | Recommended | Shared passphrase to enter the room |
| `SPOTIFY_CLIENT_SECRET` | Optional | Spotify catalog search (cleaner results + Spotify IDs) |
| `GIPHY_API_KEY` | Optional | GIF search button |

Or from the CLI: `npx wrangler secret put YOUTUBE_API_KEY`.

**YouTube key:** in Google Cloud → Credentials, restrict it to *YouTube Data API v3*. Don't add a website restriction, because the calls come from the Worker, not the browser. Quota: each new song match costs about 101 of the 10,000 free daily units, so roughly 95 new songs a day. Matches are saved for 30 days in the Worker's own storage (the `MatchCache` Durable Object), so queuing a song that's been matched before costs nothing. Pasted links cost 1 unit the first time.

### 4. Spotify (optional, up to 5 people)
1. https://developer.spotify.com/dashboard → **Create app**. The app owner needs Premium.
   - Redirect URI: your site URL **with a trailing slash**, e.g. `https://listening-room.<sub>.workers.dev/`
   - APIs used: **Web API** and **Web Playback SDK**
2. Copy the **Client ID** into `wrangler.jsonc` → `vars.SPOTIFY_CLIENT_ID` (it isn't secret) and commit. Put the **Client secret** in the `SPOTIFY_CLIENT_SECRET` secret.
3. **User Management** → add the Spotify account email of each person who'll connect. Development-mode apps are limited to 5 users, and each needs Premium.

Everyone else just hears YouTube; they don't need to do anything.

### 5. Giphy (optional)
https://developers.giphy.com → Create an API key → set `GIPHY_API_KEY`.

## Using it
1. Open the site and enter your name (and the room password).
2. Click **Tune in**. Browsers need one click before they'll play audio.
3. Optional: **Connect Spotify**.
4. Search for songs and add them to **My queue**, then **Step up to DJ**.

## Local development
```
npm install
npx wrangler dev        # http://localhost:8787
```
For local secrets, create `.dev.vars` with `YOUTUBE_API_KEY=...` etc. Spotify login works locally only if you also register `http://127.0.0.1:8787/` as a redirect URI and open the site via 127.0.0.1.

## Known limits / ideas
- YouTube videos with embedding disabled can't play. The search filters those out, but if one slips through, the DJ can skip.
- Spotify and YouTube versions occasionally differ by a second or two (intros, silence).
- SoundCloud isn't wired up yet. It would work the same way as pasted YouTube links, using the SoundCloud Widget API.
- No accounts: identity is a name plus a random ID in the browser. Fine for a private room behind a password.
