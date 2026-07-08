# open-rush

An open-source, self-hostable rush tracking app for a fraternity chapter. Brothers submit and browse potential new members (PNMs), vote yes/no with a configurable anonymity setting, and leave notes with emoji reactions. An admin approves new accounts and PNM submissions, records bid decisions, adjusts platform settings, and exports the roster to CSV.

It's a plain server-rendered app: one Node process, one SQLite file, no build step, no client-side framework. It works with JavaScript disabled in the browser.

## Features

- Open signup with admin approval — no one sees PNM data until a brother is approved.
- PNM submissions with photos (name required; brothers must also give a phone number or Instagram handle), admin review queue, and per-field edit rules (brothers can only fill in blanks; admins can edit anything).
- Yes/no voting per PNM, with an anonymous or public voter-list setting and a "freeze voting" switch.
- Notes on each PNM with emoji reactions: 👍 👎 ❤️ 🔥 😂 🦑
- Admin panel: user queue, PNM queue, bid/no-bid/undecided decision badges, platform settings, a typed-confirmation "reset rush" danger zone, and CSV export.
- Search and filter the PNM list by name/hometown, decision, and your own vote.
- Photo uploads are re-encoded server-side (not just checked by file extension) before anything is ever served back.

## Requirements

- **Node.js 20 or newer** — the JavaScript runtime that runs the app (installation covered below).
- That's it. There is no external database, no Docker, no build step — SQLite lives in a single local file, and all other dependencies are installed automatically by `npm install`.

## Quick start

This guide assumes no prior experience — every command goes into a terminal, and each step says what it does. If you've done this kind of thing before, the short version is: install Node 20+, `git clone`, `npm install`, `cp .env.example .env` (set `SESSION_SECRET`), `npm run create-admin`, `npm start`.

### Step 0 — Open a terminal

- **macOS:** open **Terminal** (press `Cmd+Space`, type "Terminal", hit Enter).
- **Windows:** open **PowerShell** (press the Windows key, type "PowerShell", hit Enter).
- **Linux:** you know where your terminal is.

Commands below are typed (or pasted) into that window and run by pressing Enter.

### Step 1 — Install Node.js

**macOS**

Either download and run the macOS installer from [nodejs.org](https://nodejs.org) (choose the **LTS** version), or if you use [Homebrew](https://brew.sh):

```bash
brew install node
```

**Windows**

Either download and run the Windows installer from [nodejs.org](https://nodejs.org) (choose the **LTS** version, accept the defaults), or install from PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
```

Close and reopen PowerShell afterward so it picks up the new command.

**Linux (Debian/Ubuntu)**

The version in the default `apt` repositories is often too old. Use NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

(Fedora/RHEL: same idea with `https://rpm.nodesource.com/setup_22.x` and `dnf install nodejs`. Or use [nvm](https://github.com/nvm-sh/nvm) on any distro.)

**Verify it worked (all platforms):**

```bash
node --version
```

You should see `v20.x.x` or higher. If you see "command not found", the install didn't finish — reopen the terminal and try again.

### Step 2 — Get the code

If you have git:

```bash
git clone https://github.com/arsergi/open-rush.git
cd open-rush
```

No git? On GitHub click the green **Code** button → **Download ZIP**, unzip it, then in your terminal `cd` into the unzipped folder (e.g. `cd Downloads/open-rush-main`).

### Step 3 — Install the app's dependencies

```bash
npm install
```

`npm` came with Node. This downloads everything the app needs into a `node_modules` folder — takes a minute the first time. Warnings are normal; errors are not.

### Step 4 — Configure

The app reads its settings from a file named `.env`. Start from the provided example:

```bash
cp .env.example .env        # macOS / Linux
copy .env.example .env      # Windows PowerShell
```

Now generate a session secret — a long random string that keeps login cookies secure. This command prints one (works on every OS, since you already have Node):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Open `.env` in any text editor (Notepad, TextEdit, whatever) and paste the output after `SESSION_SECRET=`, so the line looks like:

```
SESSION_SECRET=4f8a1c...long-random-string...9b2e
```

Don't share this value or commit it anywhere.

### Step 5 — Create your admin account

```bash
npm run create-admin
```

It asks for an email, username, and password (the password won't show as you type — that's on purpose). This is the **only** way to create an admin; there's deliberately no way to do it through the website.

### Step 6 — Start it

```bash
npm start
```

Leave that terminal window open (the app stops when you close it) and visit [http://localhost:3000](http://localhost:3000) in your browser. Log in with the admin account you just made — brothers use `/pnms`, and the admin panel is at `/admin`. To stop the app, press `Ctrl+C` in the terminal.

Everyone else signs up at `/signup` and waits for you to approve them at `/admin/users`.

### If something goes wrong

- **`EADDRINUSE` / "port already in use"** — something else is on port 3000. Set `PORT=3001` (any free port) in `.env` and start again.
- **"SESSION_SECRET is required"** — Step 4 wasn't finished; make sure `.env` exists and the `SESSION_SECRET=` line is filled in.
- **`node: command not found` / very old version** — redo Step 1 and reopen the terminal.
- **Errors during `npm install` mentioning "gyp" or compilers** — rare (the native modules ship prebuilt for common platforms); updating Node to the current LTS from [nodejs.org](https://nodejs.org) usually fixes it.

Running this for your whole chapter on a real server? See [Deployment](#deployment) below.

## Usage overview

**Signup flow.** Anyone can sign up at `/signup` (unless the admin has closed signups). New accounts start as `pending` and land on a holding page until an admin approves them at `/admin/users`. Rejected or still-pending accounts can't see any PNM data.

**PNM submissions.** Any approved brother can submit a PNM at `/pnms/new` — name is required, and brothers must also supply a phone number or an Instagram handle (admins aren't held to that rule). A brother-submitted PNM starts `pending` and is visible only to its submitter and admins until an admin approves it at `/admin/pnms`; admin-submitted PNMs go straight to `active`. Once a PNM is active, any approved brother can view it, vote, and comment. Brothers may only fill in currently-blank optional fields (hometown, phone, Instagram, photo) when editing; admins can edit everything.

**Voting.** Each brother can cast one yes/no vote per PNM (voting again just changes your vote). Under **Settings**, the admin chooses whether voter names are public to all brothers or anonymous (admins can always see who voted which way); voting can also be frozen chapter-wide.

**Notes and reactions.** Any approved brother can leave a note on a PNM. Notes from admins are visually flagged based on the author's *current* role. A note can be deleted by its author or by an admin. Reactions are a fixed set of six emoji, toggled on/off per user per note — no JavaScript required.

**Bid decisions.** From a PNM's page, an admin sets a `BID` / `NO BID` / `UNDECIDED` badge. This is a label only — it never locks voting.

**CSV export.** `/admin/export.csv` (admin only) exports all active PNMs with name, phone, Instagram, hometown, yes/no vote counts, decision, and note count. Cells that would otherwise be interpreted as a spreadsheet formula (starting with `=`, `+`, `-`, or `@`) are prefixed with a leading apostrophe so opening the export in Excel/Sheets/LibreOffice is safe.

**Reset rush.** At the end of a rush cycle, `/admin/settings` has a danger zone that wipes all PNMs, votes, notes, and reactions (and their photo files) once you type `RESET RUSH` to confirm. User accounts are left untouched, so brothers don't need to re-register next semester.

## CLI admin tool

Admin accounts are never created through the web app — only through `scripts/admin.js`, run on the server itself:

```bash
node scripts/admin.js create              # interactive: prompts for email/username/password
node scripts/admin.js promote <username>  # brother -> admin
node scripts/admin.js demote <username>   # admin -> brother (refuses to demote the last admin)
node scripts/admin.js list                # list all users with role/status
```

`npm run create-admin` is shorthand for `node scripts/admin.js create`.

For scripted/non-interactive setups (e.g. provisioning scripts, containers without a TTY), set these environment variables instead of answering the prompts:

```bash
ADMIN_EMAIL=admin@example.com \
ADMIN_USERNAME=admin \
ADMIN_PASSWORD='a-strong-password' \
node scripts/admin.js create
```

## Deployment

open-rush is a single Node process that speaks plain HTTP — put a reverse proxy in front of it for TLS.

**Caddy** (`Caddyfile`):

```
rush.example.com {
    reverse_proxy localhost:3000
}
```

**nginx** (inside your `server { ... }` block, with TLS already configured):

```nginx
location / {
    proxy_pass http://localhost:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Whichever proxy you use, once traffic is arriving over HTTPS set `COOKIE_SECURE=1` in `.env` so session cookies get the `Secure` flag, and set `TRUST_PROXY=1` alongside it so rate limiting sees real client IPs.

**systemd** unit (`/etc/systemd/system/open-rush.service`):

```ini
[Unit]
Description=open-rush
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/open-rush
ExecStart=/usr/bin/node app.js
Restart=on-failure
EnvironmentFile=/opt/open-rush/.env
User=open-rush

[Install]
WantedBy=multi-user.target
```

Then `systemctl enable --now open-rush`.

**Data and backups.** Everything open-rush needs to keep is under `data/` (or wherever `DATA_DIR` points): the SQLite database file and the `uploads/` directory of re-encoded photos. Back up that one directory and you have the whole app's state.

## Security notes

- Passwords are hashed with bcrypt (cost 12); login compares against a dummy hash when the account doesn't exist, so response timing doesn't reveal whether a username/email is registered.
- Every state-changing request is protected by a per-session CSRF token (a hidden `_csrf` field on every form, checked with a timing-safe comparison).
- Helmet sets a strict Content-Security-Policy (`default-src 'self'`) and other standard security headers.
- Login and signup are rate-limited per IP.
- Uploaded photos are identified by their actual magic bytes (not file extension or client-supplied MIME type), then re-encoded and resized through `sharp` before being written to disk — this strips EXIF data and anything else riding along in the original file. Only our own re-encoded JPEGs are ever served back.
- All database access goes through parameterized `better-sqlite3` statements; there is no string-built SQL. Search input is escaped for safe use inside a `LIKE` pattern.
- CSV export guards against spreadsheet formula injection (a leading `'` on any cell starting with `=`, `+`, `-`, or `@`).
- Admin accounts can only be created or promoted via the `scripts/admin.js` CLI, run on the server itself — there is no HTTP route that can grant the `admin` role.

## Contributing

Issues and pull requests are welcome — this is meant to be a small, readable codebase that a chapter's own tech-inclined brother can run and modify.

## License

MIT — see [LICENSE](./LICENSE).
