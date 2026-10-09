# Tribus Opportunity Radar

A lightweight lead-discovery workspace for researching local businesses, reviewing evidence, and managing outreach in one place.

## Run locally
- Requires Node.js 20+
- Run `npm start`
- Open `http://localhost:3000`
- Set `TAVILY_API_KEY` in the environment to enable server-side website verification. Business discovery uses OpenStreetMap data through Nominatim and Overpass; it does not require a Google Places API key. Keep any API keys in server-side environment variables, never in browser code or Git.

## Features
- Business opportunity and customer prospect modes
- Live business discovery using OpenStreetMap + Overpass, with location lookup and up to 50 imported listings per search
- Interactive Leaflet map, radius and category filters
- Evidence-aware lead scoring and confidence indicators
- Server-side Tavily Basic Search verification with deterministic matching and business-ID caching
- Website verification fallback when no API key is configured
- Per-lead printable report, CSV export, editable pipeline status, and client profiles stored in the browser
- No fabricated phone numbers or buyer-intent claims

## Live business discovery

1. Enter a business type and a town, city, postcode, or address in **Discover businesses**.
2. Tribus uses OpenStreetMap's Nominatim service to geocode the location, then queries the Overpass API for mapped businesses within the selected radius.
3. Results include mapped names, categories, coordinates, and any address, website, phone, or email tags that contributors have supplied.

No Google Places API key or Google Places billing setup is required for this discovery path. OpenStreetMap data is community-maintained, so coverage varies: some real businesses will be missing, and many listings will not include contact details. Listed websites and phone numbers are not independently verified. A listing or fit score does not establish purchase intent; review evidence before outreach.

The app caches location lookups in memory to avoid repeated geocoding during a running process. Please use the public Nominatim and Overpass services responsibly and follow their usage policies; do not turn this endpoint into high-volume or automated bulk harvesting. OpenStreetMap data is © OpenStreetMap contributors and is made available under the Open Database License (ODbL).

## Website verification

Set `TAVILY_API_KEY` in the Railway service variables to enable server-side website verification. Without it, Tribus clearly marks website verification as needing review rather than claiming a website is verified.

## Notes

This repository is a fresh implementation scaffold. The original Replit workspace was not directly accessible during initial setup, so its private source and existing runtime data have not been imported. Website verification is a new implementation based on the requested behavior; compare it against the Replit version before replacing that app.
