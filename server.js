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
  if (url.pathname === "/api/discover" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) return json(res, 413, { error: "Request too large" }); }
    let input;
    try { input = JSON.parse(raw); } catch { return json(res, 400, { error: "Invalid JSON" }); }
    const query = String(input?.industry || "local businesses").trim().slice(0, 100);
    const location = String(input?.location || "Manchester, UK").trim().slice(0, 120);
    const target = Math.max(1, Math.min(50, Number(input?.limit) || 50));
    if (!query || !location) return json(res, 400, { error: "Industry and location are required." });
    const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return json(res, 503, { error: "Google Places is not configured yet. Add GOOGLE_MAPS_API_KEY or GOOGLE_PLACES_API_KEY to this Railway service's Variables, then redeploy. The key must have Places API (New) enabled." });
    const variants = [...new Set([query, query + " shops", query + " services", "independent businesses"])];
    const found = new Map();
    try {
      for (const term of variants) {
        let pageToken = "";
        for (let page = 0; page < 3 && found.size < target; page++) {
          const isUS = /\b(united states|usa|u\.s\.|u\.s\.a\.)\b/i.test(location) || /\b(US|USA)\b/i.test(location);
          const isUK = /\b(united kingdom|uk|great britain|england|manchester)\b/i.test(location);
          const body = { textQuery: term + " in " + location, languageCode: "en", ...(isUS ? {regionCode:"US"} : isUK ? {regionCode:"GB"} : {}), pageSize: 20 };
          if (pageToken) body.pageToken = pageToken;
          const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
            method: "POST",
            headers: { "content-type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.addressComponents,places.websiteUri,places.types,places.location,places.rating,places.userRatingCount,places.googleMapsUri,nextPageToken" },
            body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
          });
          if (!response.ok) {
            const detail = await response.text();
            const status = response.status === 401 || response.status === 403 ? 502 : 502;
            return json(res, status, { error: "Google Places search failed. Check that Places API (New) is enabled and the key is valid and unrestricted to server-side use.", detail: detail.slice(0, 500) });
          }
          const payload = await response.json();
          for (const p of payload.places || []) {
            if (!p.id || found.has(p.id)) continue;
            const loc = p.location || {};
            const components = p.addressComponents || [];
            const locality = components.find(c => (c.types || []).includes("locality")) || components.find(c => (c.types || []).includes("postal_town")) || {};
            const region = components.find(c => (c.types || []).includes("administrative_area_level_1")) || {};
            found.set(p.id, {
              id: "google-" + p.id, sourceId: p.id,
              name: p.displayName?.text || "Unnamed business",
              category: (p.types || []).filter(t => !["point_of_interest","establishment"].includes(t)).slice(0, 2).join(", ").replace(/_/g, " ") || query,
              city: locality?.longText || location, region: region?.shortText || region?.longText || "",
              address: p.formattedAddress || "", website: p.websiteUri || "",
              lat: typeof loc.latitude === "number" ? loc.latitude : null,
              lon: typeof loc.longitude === "number" ? loc.longitude : null,
              rating: p.rating ?? null, reviewCount: p.userRatingCount ?? 0,
              mapsUrl: p.googleMapsUri || "", score: 50, status: "New",
              websiteStatus: p.websiteUri ? "Found in Google Places" : "Website not listed",
              confidence: p.websiteUri ? "medium" : "low", provider: "Google Places",
              notes: "Discovered via Google Places Text Search. Confirm details before outreach.",
              reason: "Directory discovery result; no purchase intent inferred.",
              evidence: ["Source: Google Places API", p.formattedAddress || "Address not supplied", p.websiteUri ? "Website supplied by Google Places" : "Google Places did not supply a website"],
              demo: false
            });
          }
          pageToken = payload.nextPageToken || "";
          if (!pageToken) break;
        }
        if (found.size >= target) break;
      }
      return json(res, 200, { provider: "Google Places", query, location, requested: target, count: Math.min(found.size, target), results: [...found.values()].slice(0, target), note: "Google Places returns up to 20 results per page; results are deduplicated across related searches. Some listings do not include a website." });
    } catch (error) {
      return json(res, 502, { error: "Business discovery is temporarily unavailable.", detail: error.message });
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
      const result = { businessId: String(business.id), status: "Needs review", confidence: "low", provider: "mock", verifiedUrl: "", evidence: ["TAVILY_API_KEY is not configured; no website claim was made."], cached: false };
      cache.set(String(business.id), result); return json(res, 200, result);
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
      const result = {
        businessId: String(business.id), status: verified ? "Website Found" : "Needs review",
        confidence: best && best.score >= 70 ? "high" : best && best.score >= 42 ? "medium" : "low",
        provider: "tavily", verifiedUrl: verified ? best.url : "", score: best?.score || 0,
        evidence: verified ? best.evidence : ["No result met the deterministic matching threshold; review results manually."],
        candidates: ranked.slice(0, 5).map(({url,title,score,evidence}) => ({url,title,score,evidence})), cached: false
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
