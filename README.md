# Tribus Opportunity Radar

A lightweight lead-discovery workspace for researching local businesses, reviewing evidence, and managing outreach in one place.

## Run locally
- Requires Node.js 20+
- Run `npm start`
- Open `http://localhost:3000`
- Set `TAVILY_API_KEY` in the environment to enable server-side website verification. Set `GOOGLE_PLACES_API_KEY` to enable live business discovery. Keep both keys in Railway service variables; neither key is sent to the browser.

## Features
- Business opportunity and customer prospect modes
- Interactive Leaflet map, radius and category filters
- Evidence-aware lead scoring and confidence indicators
- Live business discovery through Google Places API (New) Text Search, with deduplication and up to 50 imported listings per search\n- Server-side Tavily Basic Search verification with deterministic matching and business-ID caching
- Website verification fallback when no API key is configured
- Per-lead printable report, CSV export, editable pipeline status, and client profiles stored in the browser
- No fabricated phone numbers or buyer-intent claims

## Notes
This repository is a fresh implementation scaffold. The original Replit workspace was not directly accessible during initial setup, so its private source and existing runtime data have not been imported. Website verification is a new implementation based on the requested behavior; compare it against the Replit version before replacing that app.

## Enable live business discovery

1. In [Google Cloud Console](https://console.cloud.google.com/), select or create a project and enable **Places API (New)**.
2. Enable billing for that project, create an API key, and restrict it to the Places API. Google Places is pay-as-you-go; review the current [usage and billing documentation](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing) before searching.
3. In Railway, open the **Tribus-app-preview** service → **Variables** and add `GOOGLE_PLACES_API_KEY` with the key value. Railway will redeploy the service. Never put the key in frontend code or commit it to GitHub.
4. Open the deployed app, use **Discover real businesses**, enter a business type and location, then choose 10, 25, or 50 results.

The app uses Google's Text Search (New) endpoint with a field mask, requests website/address/map information when available, and labels source and evidence. Google Text Search returns up to 60 results per individual query; the app runs several related searches and deduplicates results to try to reach the requested count. Actual counts can be lower. “United States” is a very broad search area, so results may not represent a balanced national sample; for higher-quality prospecting, search one city/state or metro at a time (for example, “dentists” in “Austin, TX”). Some listings have no website, and directory presence does not prove buyer intent. Google API costs depend on the fields requested and current pricing.
