# CRE Job Tracker

Single-file HTML/JS app for tracking Commercial Real Estate job applications. Everything lives in `index.html` — no build step, no dependencies, no backend.

## GitHub
Repo: https://github.com/billmalone123/cre-job-tracker  
Branch: `main`

## Auto-push rule
After every code change, immediately commit and push to GitHub without asking for confirmation. No permission needed.

## What the app does
- Tracks CRE job applications with fields: company, title, location, date found, deadline, status, bucket, URL, notes
- Auto-fills the form from a job posting URL (via CORS proxy → Claude API)
- Auto-fills the form from a screenshot upload (Claude vision API)
- Stores all data in `localStorage` (no server)
- Requires user to set an Anthropic API key (stored in `localStorage`)

## Job buckets (CRE categories)
Exactly these four strings — must match precisely:
- `"Capital Markets Advisory"` — debt/equity placement, structured finance
- `"Investment Sales Brokerage"` — buying/selling commercial properties
- `"Leasing Brokerage"` — office/retail/industrial leasing
- `"Development"` — ground-up development, construction, asset management

## Key element IDs
- `urlInp` / `fetchBtn` — URL input and fetch button
- `imgInp` / `imgLabel` — screenshot file input and label
- `scrapeAlert` — alert shown during/after scraping
- `fCo`, `fTitle`, `fLoc`, `fDate`, `fDeadline`, `fBucket`, `fUrl`, `fNotes` — form fields
- `openAddBtn` — toggles the add-job form open/closed
- `addSection` — the collapsible add-job section

## Claude API usage
- Model: `claude-sonnet-4-20250514`
- URL scraping: strips HTML tags, caps at 18,000 chars, sends to Claude with extraction prompt
- Screenshot: sends base64 image to Claude vision API
- Both use `max_tokens: 1024`
- Header required: `anthropic-dangerous-direct-browser-access: true`
- CORS proxies tried in order: `api.allorigins.win`, then `corsproxy.io`

## Editing tips
- All CSS is in the `<style>` block at the top of `index.html`
- All JS is in a single `<script>` block at the bottom
- CSS variables (colors, radius) are in `:root`
- The `$()` helper is just `document.getElementById()`
- `showAlert(id, type, msg, spinner)` — types: `'info'`, `'success'`, `'error'`
- `iso()` returns today's date as YYYY-MM-DD
