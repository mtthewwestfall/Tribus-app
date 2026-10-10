import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const cache = new Map();
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "same-origin" });
  res.end(JSON.stringify(body));
}
async function inspectPublicWebsite(input) {
  let current;
  try { current = new URL(input); } catch { return null; }
  const safe = (u) => {
    const h = u.hostname.toLowerCase();
    return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password &&
      !["localhost", "localhost.localdomain"].includes(h) && !h.endsWith(".local") &&
      !h.endsWith(".internal") && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) && h.includes(".");
  };
  if (!safe(current)) return null;
  for (let hop = 0; hop < 4; hop++) {
    let response;
    try {
      response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(7000),
        headers: { "user-agent": "TribusOpportunityRadar/1.0", "accept": "text/html,application/xhtml+xml" } });
    } catch { return null; }
    if ([301,302,303,307,308].includes(response.status)) {
      const loc = response.headers.get("location");
      if (!loc) return null;
      try { current = new URL(loc, current); } catch { return null; }
      if (!safe(current)) return null;
      continue;
    }
    if (!response.ok || !(response.headers.get("content-type") || "").includes("text/html")) return null;
    const html = (await response.text()).slice(0, 500000);
    const strip = (v) => String(v || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
    const title = strip((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
    const descriptionMatch = html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]+content=["']([^"']*)["']/i) || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["']/i);
    const description = strip(descriptionMatch?.[1] || "");
    const emails = [...new Set((html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).filter(x => !/example\.|wixpress|sentry/i.test(x)))].slice(0, 3);
    const phones = [...new Set((html.match(/(?:\+?\d[\d ().-]{7,}\d)/g) || []).map(x => x.trim()).filter(x => x.replace(/\D/g, "").length >= 9 && x.replace(/\D/g, "").length <= 15))].slice(0, 3);
    return { url: current.href, title: title.slice(0, 180), description: description.slice(0, 500), emails, phones, excerpt: strip(html).slice(0, 420) };
  }
  return null;
}

function scoreResult(business, results = []) {
  const norm = (v) => String(v || "").toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9]+/g, " ").trim();
  const name = norm(business.name);
  const location = norm([business.city, business.region, business.address].filter(Boolean).join(" "));
  const phone = norm(business.phone);
  const category = norm(business.category);
  return results.map((r) => {
    const title = norm(r.title), url = String(r.url || ""), content = norm(r.content);
    let score = 0, evidence = [];
    if (name && (title.includes(name) || content.includes(name))) { score += 42; evidence.push("Business name matches search result"); }
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      const nameSlug = name.replace(/\s+/g, "");
      if (nameSlug.length >= 5 && host.replace(/[^a-z0-9]/g, "").includes(nameSlug)) { score += 30; evidence.push("Domain closely matches business name"); }
      else if (name && title.includes(name)) { score += 10; evidence.push("Title includes business name"); }
    } catch {}
    if (location && (content.includes(location) || title.includes(location))) { score += 12; evidence.push("Location evidence found"); }
    if (phone && content.includes(phone)) { score += 8; evidence.push("Phone number matches"); }
    if (category && (content.includes(category) || title.includes(category))) { score += 8; evidence.push("Category evidence found"); }
    return { url, title: r.title || url, score: Math.min(score, 100), evidence };
  }).sort((a, b) => b.score - a.score);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" }); return res.end();
  }
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/api/health") return json(res, 200, { ok: true, app: "Tribus Opportunity Radar" });
  if (url.pathname === "/api/geocode" && req.method === "GET") {
    const query = String(url.searchParams.get("q") || "").trim().slice(0, 180);
    const lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
    const reverse = url.searchParams.has("lat") && url.searchParams.has("lon") && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    if (!query && !reverse) return json(res, 400, { error: "Provide a place query or valid latitude and longitude." });
    const key = reverse ? "reverse:" + lat.toFixed(5) + ":" + lon.toFixed(5) : "geo:" + query.toLowerCase();
    try {
      let result = cache.get(key);
      if (!result) {
        const usZip = !reverse && /^\d{5}(?:-\d{4})?$/.test(query); const endpoint = reverse ? "https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=" + lat + "&lon=" + lon : usZip ? "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&postalcode=" + encodeURIComponent(query) : "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + encodeURIComponent(query);
        const response = await fetch(endpoint, { headers: { "User-Agent": "TribusOpportunityRadar/1.0", "Accept": "application/json" }, signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error("OpenStreetMap geocoding failed (" + response.status + ")");
        const data = await response.json(); const item = reverse ? data : data[0];
        if (!item || !item.lat || !item.lon) return json(res, 404, { error: "Place not found." });
        result = { lat: Number(item.lat), lon: Number(item.lon), displayName: item.display_name || query || "Pinned location" }; cache.set(key, result);
      }
      return json(res, 200, result);
    } catch (error) { return json(res, 502, { error: "OpenStreetMap geocoding is temporarily unavailable.", detail: error.message }); }
  }
  if (url.pathname === "/api/discover" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) return json(res, 413, { error: "Request too large" }); }
    let input;
    try { input = JSON.parse(raw); } catch { return json(res, 400, { error: "Invalid JSON" }); }
    const query = String(input?.industry || "local businesses").trim().slice(0, 100);
    const location = String(input?.location || "Manchester, UK").trim().slice(0, 120);
    const target = Math.max(1, Math.min(50, Number(input?.limit) || 50));
    if (!query || !location) return json(res, 400, { error: "Industry and location are required." });
    const variants = [...new Set([query, query + " shops", query + " services", "independent businesses"])];
    const found = new Map();
    const radius = Math.max(1000, Math.min(25000, Number(input?.radiusMeters) || 15000));
    try {
      let geo;
      const inputLat = Number(input?.lat), inputLon = Number(input?.lon);
      if (input?.lat !== undefined && input?.lon !== undefined && Number.isFinite(inputLat) && Number.isFinite(inputLon) && Math.abs(inputLat) <= 90 && Math.abs(inputLon) <= 180) {
        geo = { lat: inputLat, lon: inputLon, displayName: location || ("Pinned location " + inputLat.toFixed(5) + ", " + inputLon.toFixed(5)) };
      } else {
        const usZip = /^\d{5}(?:-\d{4})?$/.test(location); const geoKey = usZip ? "geo:us-zip:" + location : "geo:" + location.toLowerCase(); let cachedGeo = cache.get(geoKey);
        if (!cachedGeo) {
          const postcodeOnly = /^[a-z0-9][a-z0-9 -]{2,10}$/i.test(location) && /\d/.test(location);
          const geoUrls = usZip
            ? ["https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&postalcode=" + encodeURIComponent(location), "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=" + encodeURIComponent(location + ", USA")]
            : postcodeOnly
              ? ["https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&postalcode=" + encodeURIComponent(location), "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + encodeURIComponent(location)]
              : ["https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + encodeURIComponent(location)];
          let geoResults = [];
          for (const geoUrl of geoUrls) {
            const geoResponse = await fetch(geoUrl, { headers: { "User-Agent": "TribusOpportunityRadar/1.0", "Accept": "application/json" }, signal: AbortSignal.timeout(12000) });
            if (!geoResponse.ok) throw new Error("OpenStreetMap location lookup failed (" + geoResponse.status + ")");
            geoResults = await geoResponse.json();
            if (geoResults.length) break;
          }
          if (!geoResults.length) return json(res, 200, { provider: "OpenStreetMap + Overpass", query, location, requested: target, count: 0, results: [], note: "Location not found. Try a ZIP code, postal code, town, city, or full address." });
          cachedGeo = { lat: Number(geoResults[0].lat), lon: Number(geoResults[0].lon), displayName: geoResults[0].display_name || location }; cache.set(geoKey, cachedGeo);
        }
        geo = cachedGeo;
      }
      const overpassQuery = '[out:json][timeout:12];nwr(around:' + radius + ',' + geo.lat + ',' + geo.lon + ')["name"][~"^(shop|office|craft|amenity|healthcare|tourism|leisure|industrial)$"~".+"];out body center;';
      // Public Overpass instances can rate-limit or become temporarily overloaded.
      // Try multiple community endpoints so one unhealthy mirror does not break discovery.
      const overpassEndpoints = [
        "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
        "https://overpass.private.coffee/api/interpreter",
        "https://overpass-api.de/api/interpreter",
        "https://ethiopia.overpass.openplaceguide.org/api/interpreter"
      ];
      let payload = null;
      let emptyPayload = null;
      const overpassErrors = [];
      // Race public mirrors, but do not let a fast, valid-but-empty mirror win
      // while another mirror has actual listings for the same area.
      try {
        payload = await Promise.any(overpassEndpoints.map(async (endpoint) => {
          const host = new URL(endpoint).hostname;
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": "TribusOpportunityRadar/1.0", "Accept": "application/json" },
            body: "data=" + encodeURIComponent(overpassQuery),
            signal: AbortSignal.timeout(12000)
          });
          if (!response.ok) throw new Error(host + ": HTTP " + response.status);
          const data = await response.json();
          if (!data || !Array.isArray(data.elements) || data.remark) {
            throw new Error(host + ": invalid Overpass response" + (data?.remark ? " (" + String(data.remark).slice(0, 160) + ")" : ""));
          }
          if (data.elements.length === 0) {
            emptyPayload = data;
            throw new Error(host + ": returned zero listings; trying another mirror");
          }
          return data;
        }));
      } catch (aggregateError) {
        for (const error of aggregateError.errors || [aggregateError]) overpassErrors.push(error.message || String(error));
        // If every healthy mirror genuinely returned no listings, return an empty
        // result set instead of masking it as an outage.
        if (emptyPayload) payload = emptyPayload;
      }
      if (!payload) throw new Error("All OpenStreetMap business search endpoints failed. " + overpassErrors.join("; "));

      const normalize = (s) => String(s || "").toLowerCase().replace(/[_-]+/g, " ").trim();
      const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !["business","businesses","company","companies","local","independent","nearby","service","services","shop","shops"].includes(w));
      const elements = payload.elements || [];
      for (const p of elements) {
        const tags = p.tags || {};
        if (!tags.name) continue;
        const point = p.type === "node" ? p : (p.center || {});
        if (typeof point.lat !== "number" || typeof point.lon !== "number") continue;
        const tagCategory = tags.shop || tags.office || tags.craft || tags.amenity || tags.healthcare || tags.tourism || tags.leisure || tags.industrial || "business";
        const searchable = normalize([tags.name, tagCategory, tags.brand, tags.description].join(" "));
        const matchCount = terms.filter(term => searchable.includes(term)).length;
        // Accept any user-entered business type. Keep all mapped businesses in the
        // results and use text matches only for relevance ranking, not exclusion.
        const category = normalize(tagCategory).replace(/;/g, ", ") || query;
        const addressParts = [
          [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
          tags["addr:suburb"] || tags["addr:city"] || tags["addr:town"] || tags["addr:village"],
          tags["addr:state"],
          tags["addr:postcode"]
        ].filter(Boolean);
        const address = addressParts.join(", ");
        const city = tags["addr:city"] || tags["addr:town"] || tags["addr:village"] || tags["addr:suburb"] || location;
        const website = tags.website || tags["contact:website"] || "";
        const phone = tags.phone || tags["contact:phone"] || "";
        const id = "osm-" + p.type + "-" + p.id;
        // Opportunity score: reward established, locally operated businesses and
        // visible business signals, while treating unverified data as unknown.
        const foundedRaw = tags.start_date || tags["opening_date"] || tags["start_date:business"] || tags.founded || tags["company:founding_date"] || "";
        const foundedMatch = String(foundedRaw).match(/(?:18|19|20)\\d{2}/);
        const foundedYear = foundedMatch ? Number(foundedMatch[0]) : null;
        const yearsOpen = foundedYear && foundedYear <= new Date().getFullYear() ? new Date().getFullYear() - foundedYear : null;
        const brand = String(tags.brand || tags.operator || "").trim();
        const franchiseWords = /\\b(mcdonald|starbucks|subway|domino|dunkin|wendy|burger king|taco bell|pizza hut|kfc|7.?eleven|anytime fitness|planet fitness|great clips|sprint|verizon|t.?mobile|walgreens|cvs|walmart|target)\\b/i;
        const franchise = Boolean(brand && normalize(brand) !== normalize(tags.name)) || franchiseWords.test(String(tags.name) + " " + brand);
        const localStatus = franchise ? "Likely franchise / chain" : brand ? "Brand/operator listed; local status uncertain" : "Likely independent (not confirmed)";
        const hours = String(tags.opening_hours || "").trim();
        const websiteHost = (() => { try { return new URL(website).hostname.replace(/^www\\./i, ""); } catch { return ""; } })();
        const directoryWebsite = /facebook\\.com|instagram\\.com|yelp\\.com|linktr\\.ee|google\\.com|tripadvisor\\.com/i.test(websiteHost);
        const websiteQuality = !website ? "No website listed" : directoryWebsite ? "Directory/social link only — weak website presence" : /^https:\\/\\//i.test(website) ? "HTTPS custom-site candidate — quality not yet audited" : "Website listed — security/quality not yet audited";
        const yelpRating = Number(tags["yelp:rating"] || tags.yelp_rating || 0) || null;
        const yelpReviews = Number(tags["yelp:review_count"] || tags.yelp_reviews || 0) || null;
        const scoreFactors = [];
        let score = 45;
        if (hours) { score += 6; scoreFactors.push({factor:"Published opening hours",value:hours,impact:6,status:"known"}); }
        else scoreFactors.push({factor:"Opening hours",value:"Not listed",impact:0,status:"unknown"});
        if (!website) { score += 12; scoreFactors.push({factor:"Website opportunity",value:"No website listed",impact:12,status:"known"}); }
        else if (directoryWebsite) { score += 8; scoreFactors.push({factor:"Website presence",value:websiteQuality,impact:8,status:"estimated"}); }
        else { score += 2; scoreFactors.push({factor:"Website presence",value:websiteQuality,impact:2,status:"estimated"}); }
        if (yearsOpen !== null) { const ageImpact = Math.min(10, Math.max(0, Math.floor(yearsOpen / 2))); score += ageImpact; scoreFactors.push({factor:"Years operating",value:yearsOpen + " years (from " + foundedYear + " tag)",impact:ageImpact,status:"mapped data"}); }
        else scoreFactors.push({factor:"Years operating",value:"Not available",impact:0,status:"unknown"});
        if (franchise) { score -= 12; scoreFactors.push({factor:"Local vs franchise",value:localStatus,impact:-12,status:"estimated"}); }
        else { score += 8; scoreFactors.push({factor:"Local vs franchise",value:localStatus,impact:8,status:"estimated"}); }
        if (yelpRating !== null || yelpReviews !== null) { const reviewImpact = Math.min(10, Math.round((yelpRating || 0) * 1.5) + Math.min(4, Math.floor((yelpReviews || 0) / 50))); score += reviewImpact; scoreFactors.push({factor:"Yelp reviews",value:(yelpRating ? yelpRating + "/5" : "Rating unknown") + (yelpReviews ? " · " + yelpReviews + " reviews" : ""),impact:reviewImpact,status:"mapped tag — verify"}); }
        else scoreFactors.push({factor:"Yelp reviews",value:"Not supplied by OpenStreetMap; needs external research",impact:0,status:"unknown"});
        if (matchCount) { const relevanceImpact = Math.min(8, matchCount * 3); score += relevanceImpact; scoreFactors.push({factor:"Business-type relevance",value:matchCount + " search term match(es)",impact:relevanceImpact,status:"estimated"}); }
        if (phone) score += 3;
        if (address) score += 3;
        score = Math.max(0, Math.min(100, score));
        found.set(id, {
          id, sourceId: id, name: tags.name, category, city,
          region: tags["addr:state"] || "", address, website, phone,
          email: tags.email || tags["contact:email"] || "",
          lat: point.lat, lon: point.lon, rating: yelpRating, reviewCount: yelpReviews || 0,
          yearsOpen, foundedYear, localStatus, websiteQuality, openingHours: hours, scoreFactors,
          mapsUrl: "https://www.openstreetmap.org/" + p.type + "/" + p.id,
          score, status: "New",
          websiteStatus: website ? "Listed in OpenStreetMap; not independently verified" : "Website not listed",
          confidence: website ? "medium" : "low", provider: "OpenStreetMap",
          notes: "Mapped business listing. Confirm current operating status and contact details before outreach.",
          reason: "Opportunity score combines published hours, website gap/presence, available operating-history data, estimated local-vs-chain status, Yelp data only if explicitly present, and business-type relevance. Unknown factors are not treated as verified facts; this is not purchase intent.",
          evidence: ["Source: OpenStreetMap", address || "No street address supplied in map data", website ? "Website listed in map data; not independently verified" : "No website listed in map data", phone ? "Phone number listed in map data" : "No phone number listed in map data", hours ? "Opening hours: " + hours : "Opening hours not supplied", yearsOpen !== null ? "Operating history inferred from mapped year " + foundedYear : "Years operating not supplied", localStatus, yelpRating || yelpReviews ? "Yelp fields present in mapped tags; verify externally" : "Yelp rating/review count unavailable from OpenStreetMap; not assumed"],
          demo: false
        });
      }
      const all = [...found.values()];
      all.sort((a, b) => {
        const aMatch = terms.filter(term => normalize([a.name, a.category].join(" ")).includes(term)).length;
        const bMatch = terms.filter(term => normalize([b.name, b.category].join(" ")).includes(term)).length;
        return bMatch - aMatch || b.score - a.score || a.name.localeCompare(b.name);
      });
      const results = all.slice(0, target);
      return json(res, 200, {
        provider: "OpenStreetMap + Overpass", query, location, requested: target,
        count: results.length, results,
        note: "OpenStreetMap listings are community-maintained and may be incomplete. Websites and phone numbers are mapped data, not independently verified. Search area is within " + Math.round(radius / 1000) + " km of " + geo.displayName + "."
      });
    } catch (error) {
      return json(res, 502, { error: "OpenStreetMap business discovery is temporarily unavailable.", detail: error.message });
    }
  }
  if (url.pathname === "/api/verify-website" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) return json(res, 413, { error: "Request too large" }); }
    let business;
    try { business = JSON.parse(raw); } catch { return json(res, 400, { error: "Invalid JSON" }); }
    if (!business || !business.id || !business.name) return json(res, 400, { error: "Business id and name are required" });
    if (cache.has(String(business.id))) return json(res, 200, { ...cache.get(String(business.id)), cached: true });
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      const page = business.website ? await inspectPublicWebsite(String(business.website)) : null;
      const sources = page ? [{ title: page.title || page.url, url: page.url, excerpt: [page.description, page.excerpt].filter(Boolean).join(" ").slice(0, 420) }] : [];
      const evidence = ["Research mode: direct public website inspection (no paid search API).", ...(page?.title ? ["Website title: " + page.title] : []), ...(page?.description ? ["Website meta description: " + page.description] : []), ...(page?.emails?.length ? ["Email address(es) visible in website HTML: " + page.emails.join(", ") + " (not independently verified)"] : []), ...(page?.phones?.length ? ["Phone-like number(s) visible in website HTML: " + page.phones.join(", ") + " (not independently verified)"] : [])];
      const result = { businessId: String(business.id), status: page ? "Website Inspected — review required" : "Needs review", confidence: "low", provider: "direct-website", verifiedUrl: page?.url || "", researchStatus: page ? "Website inspected — review required" : "Limited research — review required", researchSummary: page ? "Read public page metadata and visible text from the listed website. This does not confirm ownership, current operation, service area, or buyer intent." : business.website ? "The listed website could not be safely fetched or did not return a readable public HTML page. Verify manually." : "No website is present in the map listing. Without a search API, external business discovery is limited to the mapped listing and its tags.", evidence, candidates: [], sources, websiteDetails: page ? { title: page.title, description: page.description, emails: page.emails, phones: page.phones } : null, cached: false };
      cache.set(String(business.id), result);
      return json(res, 200, result);
    }
    try {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, query: business.name + " " + [business.city, business.region, business.category].filter(Boolean).join(" ") + " official website", search_depth: "basic", max_results: 8, include_answer: false, include_raw_content: false })
      });
      if (!response.ok) throw new Error("Tavily search failed (" + response.status + ")");
      const payload = await response.json();
      const ranked = scoreResult(business, payload.results || []);
      const best = ranked[0];
      const verified = Boolean(best && best.url && best.score >= 42);
      const sources = (payload.results || []).slice(0, 5).map(r => ({ title: String(r.title || r.url || "Source").slice(0, 180), url: String(r.url || ""), excerpt: String(r.content || "").replace(/\\s+/g, " ").slice(0, 420) }));
      const useful = sources.filter(s => s.url && s.excerpt);
      const researchSummary = useful.length ? "Public search surfaced " + useful.length + " source excerpt(s). Review the linked evidence below; summaries are snippets and may be incomplete." : "Search returned no usable source excerpts. Verify manually before outreach.";
      const result = {
        businessId: String(business.id), status: verified ? "Website Found" : "Needs review",
        confidence: best && best.score >= 70 ? "high" : best && best.score >= 42 ? "medium" : "low",
        provider: "tavily", verifiedUrl: verified ? best.url : "", score: best?.score || 0,
        researchStatus: useful.length ? "Public sources found — review required" : "Needs review", researchSummary,
        evidence: [...(verified ? best.evidence : ["No result met the deterministic matching threshold; review results manually."]), ...useful.map(s => "Search source: " + s.title + " — " + s.excerpt)],
        sources: useful, candidates: ranked.slice(0, 5).map(({url,title,score,evidence}) => ({url,title,score,evidence})), cached: false
      };
      cache.set(String(business.id), result); return json(res, 200, result);
    } catch (error) {
      return json(res, 502, { error: "Website verification is temporarily unavailable", detail: error.message });
    }
  }
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const resolved = path.resolve(root, "." + pathname);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return json(res, 403, { error: "Forbidden" });
  try {
    const content = await readFile(resolved);
    res.writeHead(200, { "content-type": mime[path.extname(resolved)] || "application/octet-stream" }); res.end(content);
  } catch { json(res, 404, { error: "Not found" }); }
});
server.listen(port, "0.0.0.0", () => console.log("Tribus Opportunity Radar listening on " + port));
