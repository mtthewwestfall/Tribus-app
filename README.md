# Tribus Opportunity Radar

A lightweight lead-discovery workspace for researching local businesses, reviewing evidence, and managing outreach in one place.

## Run locally
- Requires Node.js 20+
- Run `npm start`
- Open `http://localhost:3000`
- Set `TAVILY_API_KEY` in the environment to enable server-side website verification. The key is never sent to the browser.

## Features
- Business opportunity and customer prospect modes
- Interactive Leaflet map, radius and category filters
- Evidence-aware lead scoring and confidence indicators
- Server-side Tavily Basic Search verification with deterministic matching and business-ID caching
- Website verification fallback when no API key is configured
- Per-lead printable report, CSV export, editable pipeline status, and client profiles stored in the browser
- No fabricated phone numbers or buyer-intent claims

## Notes
This repository is a fresh implementation scaffold. The original Replit workspace was not directly accessible during initial setup, so its private source and existing runtime data have not been imported. Website verification is a new implementation based on the requested behavior; compare it against the Replit version before replacing that app.
