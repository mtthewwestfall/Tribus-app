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
    const variants = [...new Set([query, query + " shops", query + " services", "independent businesses"])];
    const found = new Map();
    const geoKey = "geo:" + location.toLowerCase();
    try {
      let geo = cache.get(geoKey);
      if (!geo) {
        const geoUrl = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + encodeURIComponent(location);
        const geoResponse = await fetch(geoUrl, {
          headers: { "User-Agent": "TribusOpportunityRadar/1.0", "Accept": "application/json" },
          signal: AbortSignal.timeout(12000)
        });
        if (!geoResponse.ok) throw new Error("OpenStreetMap location lookup failed (" + geoResponse.status + ")");
        const geoResults = await geoResponse.json();
        if (!geoResults.length) return json(res, 200, { provider: "OpenStreetMap + Overpass", query, location, requested: target, count: 0, results: [], note: "Location not found. Try a town, city, postcode, or full address." });
        geo = { lat: Number(geoResults[0].lat), lon: Number(geoResults[0].lon), displayName: geoResults[0].display_name || location };
        cache.set(geoKey, geo);
      }
      const radius = Math.max(1000, Math.min(25000, Number(input?.radiusMeters) || 15000));
      const overpassQuery = '[out:json][timeout:25];(nwr(around:' + radius + ',' + geo.lat + ',' + geo.lon + ')["name"]["shop"];nwr(around:' + radius + ',' + geo.lat + ',' + geo.lon + ')["name"]["office"];nwr(around:' + radius + ',' + geo.lat + ',' + geo.lon + ')["name"]["craft"];nwr(around:' + radius + ',' + geo.lat + ',' + geo.lon + ')["name"]["amenity"];nwr(around:' + radius + ',' + geo.lat + ',' + geo.lon + ')["name"]["healthcare"];nwr(around:' + radius + ',' + geo.lat + ',' + geo.lon + ')["name"]["tourism"];nwr(around:' + radius + ',' + geo.lat + ',' + geo.lon + ')["name"]["leisure"];nwr(around:' + radius + ',' + geo.lat + ',' + geo.lon + ')["name"]["industrial"];);out body center 200;';
      const overpassResponse = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": "TribusOpportunityRadar/1.0" },
        body: "data=" + encodeURIComponent(overpassQuery),
        signal: AbortSignal.timeout(35000)
      });
      if (!overpassResponse.ok) throw new Error("OpenStreetMap business search failed (" + overpassResponse.status + ")");
      const payload = await overpassResponse.json();
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
        const score = Math.min(88, 42 + matchCount * 12 + (website ? 8 : 0) + (phone ? 5 : 0));
        found.set(id, {
          id, sourceId: id, name: tags.name, category, city,
          region: tags["addr:state"] || "", address, website, phone,
          email: tags.email || tags["contact:email"] || "",
          lat: point.lat, lon: point.lon, rating: null, reviewCount: 0,
          mapsUrl: "https://www.openstreetmap.org/" + p.type + "/" + p.id,
          score, status: "New",
          websiteStatus: website ? "Listed in OpenStreetMap; not independently verified" : "Website not listed",
          confidence: website ? "medium" : "low", provider: "OpenStreetMap",
          notes: "Mapped business listing. Confirm current operating status and contact details before outreach.",
          reason: "Discovered from OpenStreetMap tags; fit score is a rough category/contact-data heuristic, not purchase intent.",
          evidence: ["Source: OpenStreetMap", address || "No street address supplied in map data", website ? "Website listed in map data; not independently verified" : "No website listed in map data", phone ? "Phone number listed in map data" : "No phone number listed in map data"],
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
      const result = { businessId: String(business.id), status: "Needs review", confidence: "low", provider: "not-configured", verifiedUrl: "", researchStatus: "Not researched", researchSummary: "Automated public-source research requires TAVILY_API_KEY. This listing has not been independently verified.", evidence: ["TAVILY_API_KEY is not configured; no website or business claims were verified."], candidates: [], sources: [], cached: false };
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
