# ORBoard — Complete Setup Guide
**Anesthesia Command Center**

---

## What You're Building
A real-time, multi-device OR staffing board. Every screen in your OR suite, office, and front desk shows the same live board. Drag a CRNA into OR 3 and every other open browser updates within 1 second.

**Tech stack:**
- **Next.js 14** — the web framework (same as other projects)
- **Supabase** — your database + real-time sync engine
- **Vercel** — free hosting, deploys in 2 minutes
- **TypeScript** — catches bugs before they happen

---

## PHASE 1 — Prerequisites (10 min)

### Step 1: Check Node.js
Open VS Code → Terminal → New Terminal, then type:
```bash
node --version
```
You need `v18` or higher. If missing, go to **nodejs.org** and download the LTS version.

### Step 2: Check you have VS Code with Claude Code
Make sure Claude Code CLI is installed:
```bash
claude --version
```
If missing, install it per Anthropic's instructions.

---

## PHASE 2 — Create the Project (5 min)

### Step 3: Create a new Next.js app
In your terminal (navigate to wherever you keep projects first):
```bash
cd ~/Desktop
npx create-next-app@14 orboard --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --no-git
```
When prompted, just press **Enter** to accept all defaults.

### Step 4: Open it in VS Code
```bash
cd orboard
code .
```

### Step 5: Install Supabase
In the VS Code terminal (you should now be inside the `orboard` folder):
```bash
npm install @supabase/supabase-js@latest @supabase/ssr@latest
```

---

## PHASE 3 — Copy the Source Files

### Step 6: Replace the generated files
All source files are included in this zip. **Replace** the generated files with the ones provided:

```
src/
  types/index.ts          ← copy this in
  lib/supabase.ts         ← copy this in
  app/
    layout.tsx            ← replace generated
    page.tsx              ← replace generated
    globals.css           ← replace generated
    board/
      page.tsx            ← new file
      BoardClient.tsx     ← new file
      Sidebar.tsx         ← new file
      SiteCard.tsx        ← new file
      StatsBar.tsx        ← new file
      Modals.tsx          ← new file
    api/
      sites/route.ts      ← new file
      rooms/route.ts      ← new file
      staff/route.ts      ← new file
      assignments/route.ts ← new file
tailwind.config.ts        ← replace generated
next.config.ts            ← replace generated
```

**Tip:** In VS Code you can drag files from Finder/Explorer directly into the Explorer panel on the left.

---

## PHASE 4 — Set Up Supabase (10 min)

### Step 7: Create a Supabase project
1. Go to **supabase.com** → Sign in → New Project
2. Name: `orboard`
3. Database password: choose something strong and save it
4. Region: **US East (N. Virginia)**
5. Click **Create new project** — wait ~2 minutes

### Step 8: Run the database schema
1. In your Supabase project, click **SQL Editor** in the left sidebar
2. Click **New query**
3. Open `supabase_schema.sql` from this project
4. **Select all** the SQL text, **paste** it into Supabase SQL Editor
5. Click **Run** (green button)
6. You should see: `Success. No rows returned`

### Step 9: Get your API keys
1. In Supabase, click the **gear icon** (Settings) in the left sidebar
2. Click **API**
3. Copy two values:
   - **Project URL** — looks like `https://abcdefgh.supabase.co`
   - **anon public key** — long string starting with `eyJ...`

### Step 10: Create your environment file
In VS Code, create a new file called `.env.local` in the ROOT of the project (same level as `package.json`). Paste:

```
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...your_key_here
```

> ⚠️ Use your real values, not the placeholder text above.
> ✅ This file is in `.gitignore` — it will NOT be uploaded to GitHub.

---

## PHASE 5 — Run It Locally (2 min)

### Step 11: Start the dev server
```bash
npm run dev
```

Open your browser to: **http://localhost:3000**

You should see the ORBoard with your sites loaded from Supabase. Try:
- Dragging a staff member to a room
- Opening another browser tab to the same URL — changes sync in real time
- Adding a site, room, or staff member

If you see errors, check the VS Code terminal for messages and paste them to Claude.

---

## PHASE 6 — Deploy to Vercel (5 min)

### Step 12: Push to GitHub
```bash
git init
git add .
git commit -m "ORBoard initial build"
```
Then go to **github.com** → New repository → name it `orboard` → follow the push instructions.

### Step 13: Deploy on Vercel
1. Go to **vercel.com** → Sign in with GitHub
2. Click **New Project** → Import your `orboard` repo
3. On the configuration screen, click **Environment Variables**
4. Add both:
   - `NEXT_PUBLIC_SUPABASE_URL` = your URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = your key
5. Click **Deploy**

In ~2 minutes you get a live URL like `orboard.vercel.app` — share it with your whole team.

---

## PHASE 7 — Add Your Real Staff & Sites

### Step 14: Clear the sample data (optional)
In Supabase → SQL Editor:
```sql
delete from assignments;
delete from rooms;
delete from staff;
delete from sites;
```

Then use the app's UI to add your actual sites, rooms, and staff members.

---

## Daily Usage

- The board **resets assignments each day** automatically (each assignment is stored with today's date)
- Staff can be dragged into rooms, then unassigned by clicking their chip in the room
- The sidebar shows which staff are assigned vs available at a glance
- 24hr shifts show in **red** as a visual warning
- Anyone with the URL sees live updates instantly

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Error: supabaseUrl is required` | Check `.env.local` has both keys with no spaces |
| Real-time not updating | In Supabase → Database → Replication → check all 4 tables are enabled |
| `npm run dev` fails | Make sure you ran `npm install` and are in the `orboard` folder |
| White screen on Vercel | Check the Vercel deployment logs for errors; usually missing env vars |
| Can't drag on mobile | Native HTML5 drag-drop doesn't work on iOS — we'll add touch support in the next version |

---

## What's Next (Future Enhancements)

- **Print view** — generate a printable daily assignment sheet
- **Touch/mobile drag** — support iPad use at the OR desk
- **Case types** — label each room with the procedure type
- **Shift history** — see yesterday's or last week's assignments
- **Staff notes** — add per-person notes (e.g., "call from 3pm")
- **Authentication** — lock board edits to authorized users only
