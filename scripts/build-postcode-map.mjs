// Builds data/postcode-distributors.json from Consumer Data Right (Energy Made Easy) plan data.
//
// Every current electricity plan lists the distributors and postcodes it applies to. Plans that name
// exactly ONE distributor tell us that distributor serves those postcodes. Combining every brand's plans
// gives a postcode -> distributor mapping. Postcodes claimed by 2+ distributors are collisions: real
// network boundaries (e.g. 2620 Queanbeyan/ACT) or retailer data errors. The evidence counts help tell
// which: a real split is usually backed by many brands on both sides.
//
// Run: npm run build:postcodes   (needs internet; takes a few minutes)
// Outputs:
//   data/postcode-distributors.json   { "3000": ["citipower"], "2620": ["essential-energy", "evoenergy"] }
//   data/postcode-collisions.csv      every postcode with 2+ distributors, with evidence
//   data/postcode-map-report.md       summary: coverage, collisions, unmapped distributor names
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const REGISTER = "https://api.cdr.gov.au/cdr-register/v1/energy/data-holders/brands/summary";
const EME = "https://cdr.energymadeeasy.gov.au";
const CONCURRENCY = 6;

// Brands whose register URI is their own domain: plans are published on Energy Made Easy under these slugs
const EME_SLUGS = {
  "Arcline by RACV": "arcline", "Cooperative Power": "cooperative-power", "RAA Energy": "raa",
  "Aurora Energy": "aurora", "Origin Energy": "origin", AGL: "agl", EnergyAustralia: "energyaustralia",
  ENGIE: "engie", "Alinta Energy": "alinta", "Sumo Power (legacy)": "sumo", "Kogan Energy": "kogan",
  Powershop: "powershop", ActewAGL: "actewagl", "Diamond Energy": "diamond", "COVAU PTY LIMITED": "covau",
  "Next Business Energy": "next-business", "1st Energy": "1st-energy", "OVO Energy": "ovo-energy",
  "Indigo Power": "indigo-power", "Blue NRG": "blue-nrg", Nectr: "nectr", "Dodo Power & Gas": "dodo",
  "Momentum Energy": "momentum", "Pacific Blue Retail": "pacific-blue", "Tango Energy": "tango",
  "GloBird Energy": "globird", "Lumo Energy": "lumo", "Red Energy": "red-energy", "Snowy Energy": "snowy",
  Amber: "amber", "1st Energy (EL Retail Energy)": "energy-locals", "ENGIE large business": "engie-large",
  "Ergon Energy Retail": "ergon",
};

// CDR distributor names -> our public slugs. Unknown names are reported, not guessed.
const DISTRIBUTORS = JSON.parse(readFileSync("data/distributors.json", "utf8"));
const ALIASES = {};
for (const [slug, d] of Object.entries(DISTRIBUTORS)) for (const a of d.cdr_names) ALIASES[norm(a)] = slug;
function norm(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function getJson(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "x-v": "1", Accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

async function brandPlans(base) {
  const plans = [];
  for (let page = 1; ; page++) {
    const d = await getJson(`${base}/cds-au/v1/energy/plans?fuelType=ELECTRICITY&effective=CURRENT&page-size=1000&page=${page}`);
    if (!d) return null;
    plans.push(...(d.data?.plans ?? []));
    if (page >= (d.meta?.totalPages ?? 1)) return plans;
  }
}

async function pool(items, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) {
      const item = items[i++];
      out.push(await fn(item));
    }
  }));
  return out;
}

// ---------------------------------------------------------------------------
const brands = (await getJson(REGISTER)).data;
console.log(`${brands.length} energy brands in the CDR register`);

const evidence = {}; // postcode -> slug -> Set(brand)
const unmapped = {}; // unknown CDR distributor name -> plan count
const brandStats = [];

await pool(brands, async (b) => {
  const candidates = [];
  if (b.publicBaseUri?.startsWith(EME)) candidates.push(b.publicBaseUri);
  if (EME_SLUGS[b.brandName]) candidates.push(`${EME}/${EME_SLUGS[b.brandName]}`);
  if (b.publicBaseUri && !b.publicBaseUri.startsWith(EME)) candidates.push(b.publicBaseUri);

  let plans = null, used = null;
  for (const base of candidates) {
    try {
      plans = await brandPlans(base);
    } catch {
      plans = null;
    }
    if (plans) { used = base; break; }
  }
  if (!plans) { brandStats.push({ brand: b.brandName, plans: 0, usable: 0, source: "unreachable" }); return; }

  let usable = 0;
  for (const p of plans) {
    const g = p.geography ?? {};
    const dists = g.distributors ?? [];
    const pcs = g.includedPostcodes ?? [];
    if (dists.length !== 1 || pcs.length === 0) continue;
    const slug = ALIASES[norm(dists[0])];
    if (!slug) { unmapped[dists[0]] = (unmapped[dists[0]] ?? 0) + 1; continue; }
    usable++;
    for (const pc of pcs) {
      if (!/^\d{4}$/.test(pc)) continue;
      ((evidence[pc] ??= {})[slug] ??= new Set()).add(b.brandName);
    }
  }
  brandStats.push({ brand: b.brandName, plans: plans.length, usable, source: used });
  console.log(`  ${b.brandName}: ${plans.length} plans, ${usable} usable`);
});

// ---------------------------------------------------------------------------
const map = {};
const collisions = [];
for (const pc of Object.keys(evidence).sort()) {
  const slugs = Object.keys(evidence[pc]).sort();
  map[pc] = slugs;
  if (slugs.length > 1) {
    collisions.push({ pc, entries: slugs.map((s) => ({ slug: s, brands: evidence[pc][s].size })) });
  }
}

mkdirSync("data", { recursive: true });
writeFileSync("data/postcode-distributors.json", JSON.stringify(map, null, 0).replace(/\],"/g, '],\n"') + "\n");

const csv = ["postcode,distributors,brand_evidence,likely"];
for (const c of collisions) {
  const max = Math.max(...c.entries.map((e) => e.brands));
  // A side backed by 1 brand while the other has 5+ is probably a retailer data error
  const weak = c.entries.filter((e) => e.brands === 1 && max >= 5).map((e) => e.slug);
  csv.push(
    `${c.pc},${c.entries.map((e) => e.slug).join(" | ")},${c.entries.map((e) => `${e.slug}:${e.brands}`).join(" | ")},${
      weak.length ? `check: ${weak.join(" ")} may be a data error` : "real split"
    }`,
  );
}
writeFileSync("data/postcode-collisions.csv", csv.join("\n") + "\n");

const perDist = {};
for (const slugs of Object.values(map)) for (const s of slugs) perDist[s] = (perDist[s] ?? 0) + 1;
const report = [
  `# Postcode map report`,
  ``,
  `Generated ${new Date().toISOString()} from CDR plan data (${brandStats.filter((b) => b.plans).length} of ${brands.length} brands reachable).`,
  ``,
  `- Postcodes mapped: **${Object.keys(map).length}**`,
  `- Postcodes with one distributor: **${Object.keys(map).length - collisions.length}**`,
  `- Collisions (2+ distributors): **${collisions.length}** (see postcode-collisions.csv; the API lists all and flags the location as ambiguous)`,
  ``,
  `## Postcodes per distributor`,
  ``,
  `| Distributor | Postcodes |`,
  `|---|---|`,
  ...Object.entries(perDist).sort().map(([s, n]) => `| ${s} | ${n} |`),
  ``,
  `## CDR distributor names not mapped`,
  ``,
  Object.keys(unmapped).length
    ? `Add these to \`cdr_names\` in data/distributors.json if they are real networks:\n\n` +
      Object.entries(unmapped).sort((a, b) => b[1] - a[1]).map(([n, c]) => `- ${n} (${c} plans)`).join("\n")
    : `None.`,
  ``,
  `## Brands`,
  ``,
  `| Brand | Plans | Usable (single distributor) |`,
  `|---|---|---|`,
  ...brandStats.sort((a, b) => a.brand.localeCompare(b.brand)).map((b) => `| ${b.brand} | ${b.plans} | ${b.usable} |`),
  ``,
].join("\n");
writeFileSync("data/postcode-map-report.md", report);

console.log(`\n${Object.keys(map).length} postcodes, ${collisions.length} collisions`);
if (Object.keys(unmapped).length) console.log("Unmapped distributor names:", unmapped);
