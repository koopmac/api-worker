/**
 * Termina business electricity rates API (v1)
 *
 * api.termina.com/v1/rates -> Cloudflare Access (service token) -> Metabase /api/dataset -> Postgres
 *
 * Five native queries bundled into the Worker, one per response block (sql/metabase/01..05).
 * Request values are sent as Metabase variables (never pasted into the SQL), so Metabase escapes them.
 *   01 location  -> resolve the network first (422 if out of coverage, warning if ambiguous)
 *   02 usage, 03 benchmark, 04 plans, 05 stats -> run in parallel
 */

import Q_LOCATION from "../sql/metabase/01_location.sql";
import Q_USAGE from "../sql/metabase/02_usage.sql";
import Q_BENCHMARK from "../sql/metabase/03_benchmark.sql";
import Q_PLANS from "../sql/metabase/04_plans.sql";
import Q_STATS from "../sql/metabase/05_stats.sql";
import POSTCODE_MAP from "../data/postcode-distributors.json";
import DISTRIBUTOR_REGISTRY from "../data/distributors.json";
import POSTCODE_SUBURBS from "../data/postcode-suburbs.json";
import CITY_REGISTRY from "../data/cities.json";

// Postcode -> distributor slugs (built from CDR plan data by scripts/build-postcode-map.mjs).
// Postcodes served by 2+ networks list all of them and are returned as ambiguous.
const POSTCODES = POSTCODE_MAP as Record<string, string[]>;
interface Distributor {
  name: string;
  state: string;
  db_slug: string | null; // slug as derived from distributors.name in our DB (null = not matched in DB yet)
  cdr_names: string[];
}
const DISTRIBUTORS = DISTRIBUTOR_REGISTRY as Record<string, Distributor>;
// Postcode -> suburbs (ABS ASGS 2021, CC BY 4.0; built by scripts/build_geography.py)
const SUBURBS = POSTCODE_SUBURBS as Record<string, string[]>;
// Cities: capitals = ABS Greater Capital City areas, others = Significant Urban Areas
interface City {
  name: string;
  state: string;
  basis: string;
  aliases: string[];
  postcodes: string[];
  networks: Record<string, number>; // costed: network -> postcodes served
  fringe_networks: Record<string, number>; // a few boundary postcodes only
}
const CITIES = CITY_REGISTRY as Record<string, City>;
const CITY_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(CITIES).flatMap(([slug, c]) => c.aliases.map((a) => [a, slug])),
);
const STATES = ["NSW", "VIC", "QLD", "SA", "TAS", "ACT", "WA", "NT"];
const STATES_IN_NEM = ["NSW", "VIC", "QLD", "SA", "TAS", "ACT"];
const networksInState = (state: string) =>
  Object.entries(DISTRIBUTORS)
    .filter(([, d]) => d.state === state)
    .map(([slug]) => slug);
const BY_DB_SLUG: Record<string, string> = Object.fromEntries(
  Object.entries(DISTRIBUTORS)
    .filter(([, d]) => d.db_slug)
    .map(([slug, d]) => [d.db_slug as string, slug]),
);
// Accept our public slug ("evoenergy") or the DB-derived one ("evoenergy-electricity")
const toPublicSlug = (s: string) => (DISTRIBUTORS[s] ? s : BY_DB_SLUG[s] ?? s);
const toDbSlug = (s: string) => DISTRIBUTORS[s]?.db_slug ?? s;
const networkFromRegistry = (slug: string) => ({
  id: slug,
  name: DISTRIBUTORS[slug]?.name ?? slug,
  state: DISTRIBUTORS[slug]?.state ?? null,
});

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  RATE_LIMITER: RateLimiter;
  SITE_URL: string;
  PAGE_PATH_TEMPLATE: string; // e.g. "/cheapest-business-electricity/{state}"
  CITY_PAGE_PATH_TEMPLATE: string; // e.g. "/cheapest-business-electricity/{city}"
  METABASE_URL: string;
  METABASE_DATABASE_ID: string; // the rates database's ID in Metabase
  // Secrets
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;
  METABASE_API_KEY: string;
}

const API_VERSION = "v1";
const EDGE_CACHE_SECONDS = 3600;
const BROWSER_CACHE_SECONDS = 300;
const METABASE_TIMEOUT_MS = 20_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const OFFER_SOURCES = ["all", "public", "termina_buying_group"] as const;

type Row = Record<string, unknown>;
interface Warning {
  code: string;
  message: string;
  network?: string; // set when the warning applies to one of several networks
}

class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    let cacheStatus = "BYPASS";
    let response: Response;

    try {
      if (request.method === "OPTIONS") {
        response = withCors(new Response(null, { status: 204 }));
      } else if (request.method !== "GET" && request.method !== "HEAD") {
        throw new ApiError(405, "method_not_allowed", "Only GET is supported.");
      } else if (url.pathname === "/health") {
        response = await health(env);
      } else {
        const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        if (!success) throw new ApiError(429, "rate_limited", "Too many requests. Retry in a minute.");

        const cache = caches.default;
        const cacheKey = new Request(normaliseUrl(url), { method: "GET" });
        const cached = await cache.match(cacheKey);

        if (cached) {
          cacheStatus = "HIT";
          response = cached;
        } else {
          cacheStatus = "MISS";
          try {
            response = await route(url, env);
          } catch (err) {
            response = errorResponse(err);
          }
          if (response.headers.get("Cache-Control")?.includes("s-maxage")) {
            ctx.waitUntil(cache.put(cacheKey, response.clone()));
          }
        }
      }
    } catch (err) {
      response = errorResponse(err);
    }

    console.log(
      JSON.stringify({
        path: url.pathname,
        query: url.search,
        status: response.status,
        cache: cacheStatus,
        ms: Date.now() - started,
        ua: request.headers.get("User-Agent")?.slice(0, 120),
      }),
    );

    const out = new Response(response.body, response);
    out.headers.set("X-Cache", cacheStatus);
    return out;
  },
};

async function route(url: URL, env: Env): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "") {
    return json({
      name: "Termina business electricity rates API",
      version: API_VERSION,
      endpoints: {
        "GET /v1/rates": {
          location:
            "one of nmi, postcode, distributor, city, state. distributor can narrow postcode, city or state; nmi overrides all",
          optional: "usage_kwh, peak_share, shoulder_share, max_demand_kw, offer_source, limit, cursor",
          examples: [
            "/v1/rates?distributor=evoenergy",
            "/v1/rates?state=NSW",
            "/v1/rates?city=brisbane",
            "/v1/rates?postcode=2600&usage_kwh=40000",
            "/v1/rates?distributor=evoenergy&offer_source=public&limit=10",
          ],
        },
      },
    });
  }
  if (path === `/${API_VERSION}/rates`) return getRates(url.searchParams, env);
  throw new ApiError(404, "not_found", "Unknown endpoint. See / for the list.");
}

// ---------------------------------------------------------------------------
// GET /v1/rates
// ---------------------------------------------------------------------------
async function getRates(search: URLSearchParams, env: Env): Promise<Response> {
  const q = parseQuery(search);
  const warnings: Warning[] = [];
  const level = q.nmi ? "nmi" : q.postcode ? "postcode" : q.city ? "city" : q.state ? "state" : "distributor";
  const input = q.nmi ?? q.postcode ?? q.city ?? q.state ?? q.distributor;
  const city = q.city && !q.nmi && !q.postcode ? CITIES[q.city] : undefined;

  // 1. Work out which network(s) to cost. NMI is resolved in SQL; postcode and distributor here.
  let targets: Target[];
  let skipped: { id: string; name: string; state: string | null }[] = [];

  if (q.nmi) {
    targets = [{ key: "nmi", nmi: q.nmi }];
  } else {
    const distributor = q.distributor ? toPublicSlug(q.distributor) : undefined;
    // The area's networks: postcode map, city definition, or every network in the state
    let area: string[] | undefined;
    let areaLabel = "";
    if (q.postcode) {
      area = POSTCODES[q.postcode];
      areaLabel = `postcode ${q.postcode}`;
      if (!area) throw new ApiError(422, "out_of_coverage", "We don't have an electricity network for that postcode.", { input });
    } else if (city) {
      area = Object.keys(city.networks);
      areaLabel = city.name;
      if (area.length === 0) {
        throw new ApiError(422, "out_of_coverage", `${city.name} isn't on the National Electricity Market, so we don't have rates for it.`, { input });
      }
      const fringe = Object.keys(city.fringe_networks);
      if (fringe.length && !distributor) {
        warnings.push({
          code: "fringe_networks",
          message: `A few ${city.name} boundary postcodes are served by ${fringe.map((f) => DISTRIBUTORS[f]?.name ?? f).join(", ")}, not included here. Pass postcode for an exact match.`,
        });
      }
    } else if (q.state) {
      area = networksInState(q.state);
      areaLabel = q.state;
      if (!STATES_IN_NEM.includes(q.state) || area.length === 0) {
        throw new ApiError(422, "out_of_coverage", `${q.state} isn't on the National Electricity Market, so we don't have rates for it.`, { input });
      }
    }
    if (area && distributor && !area.includes(distributor)) {
      throw new ApiError(400, "distributor_location_mismatch", `${distributor} doesn't serve ${areaLabel}.`, {
        networks_serving_location: area,
      });
    }
    const serving = distributor ? [distributor] : (area as string[]);
    // Networks we know about but haven't matched to a distributor in our database yet
    skipped = serving.filter((s) => DISTRIBUTORS[s] && !DISTRIBUTORS[s].db_slug).map(networkFromRegistry);
    targets = serving.filter((s) => !skipped.some((k) => k.id === s)).map((s) => ({ key: s, distributor: toDbSlug(s) }));
  }

  for (const net of skipped) {
    warnings.push({ code: "rates_not_available", message: `We don't have rates for ${net.name} yet.` });
  }

  // 2. Cost every target network in parallel (5 queries each)
  let results = await Promise.all(targets.map((t) => costNetwork(env, q, t)));

  // An NMI can match more than one network in SQL: cost each of them separately
  if (results.length === 1 && results[0].ambiguousIds.length > 1) {
    targets = results[0].ambiguousIds.map((db) => ({ key: toPublicSlug(db), distributor: db }));
    results = await Promise.all(targets.map((t) => costNetwork(env, q, t)));
  }

  if (results.some((r) => r.invalidShares)) {
    throw new ApiError(400, "invalid_usage_shares", "peak_share + shoulder_share must not exceed 1.");
  }

  const covered = results.filter((r) => !r.outOfCoverage);
  if (covered.length === 0 && skipped.length === 0) {
    throw new ApiError(
      422,
      "out_of_coverage",
      "We don't have an electricity network for that location. Check the distributor, postcode or NMI.",
      { input },
    );
  }

  // 3. Location
  const networks = [...covered.map((r) => r.network), ...skipped];
  const states = [...new Set(networks.map((n) => n.state).filter(Boolean))];
  const state = states.length === 1 ? (states[0] as string) : null;
  // Several networks is expected for a state or city; for a postcode or NMI it means we can't tell which
  const multi = networks.length > 1;
  const ambiguous = multi && (level === "postcode" || level === "nmi");
  const location = {
    level,
    input,
    state: state ?? (level === "state" ? q.state : null) ?? null,
    city: city ? { id: q.city, name: city.name, basis: city.basis } : null,
    postcode: q.postcode ?? null,
    suburbs: q.postcode ? SUBURBS[q.postcode] ?? [] : [],
    networks,
    ambiguous,
  };

  if (multi && !ambiguous) {
    warnings.unshift({
      code: "multiple_networks",
      message: `${city ? city.name : q.state} is served by ${networks.length} networks (${networks
        .map((n) => n.name)
        .join(", ")}). Plans from all of them are included; each plan's network says which it applies to. Pass postcode or nmi for your site.`,
    });
  }
  if (ambiguous) {
    warnings.unshift({
      code: "ambiguous_location",
      message: `${level === "postcode" ? `Postcode ${q.postcode}` : "This location"} is served by ${networks.length} networks (${networks
        .map((n) => n.name)
        .join(", ")}). Showing rates for all of them; each plan's network says which it applies to. Pass distributor or nmi to narrow it down.`,
    });
  }
  for (const r of covered) {
    for (const w of r.warnings) {
      warnings.push(multi ? ({ code: w.code, message: `${r.network.name}: ${w.message}`, network: r.network.id } as Warning) : w);
    }
  }

  // 4. Merge plans across networks, cheapest first, and page with a per-network cursor
  type Candidate = { row: Row; key: string; cost: number };
  const candidates: Candidate[] = [];
  for (const r of covered) {
    for (const row of r.planRows) candidates.push({ row, key: r.key, cost: Number(row._cursor_cost) });
  }
  candidates.sort((x, y) => x.cost - y.cost || x.key.localeCompare(y.key) || Number(x.row._offer_id) - Number(y.row._offer_id));
  const page = candidates.slice(0, q.limit);

  const positions: Record<string, [string, string]> = { ...(q.cursor?.p ?? {}) };
  for (const c of page) positions[c.key] = [String(c.row._cursor_cost), String(c.row._offer_id)];
  const done = new Set(q.cursor?.d ?? []);
  for (const r of covered) {
    const fetched = r.planRows.length;
    const emitted = page.filter((c) => c.key === r.key).length;
    if (fetched <= q.limit && emitted === fetched) done.add(r.key); // nothing left beyond this page
  }
  const remaining = covered.some((r) => !done.has(r.key));
  const offset = q.cursor?.o ?? 0;
  const next_cursor = remaining ? encodeCursor({ o: offset + page.length, p: positions, d: [...done] }) : null;

  const plans = page.map((c, i) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(c.row)) if (!k.startsWith("_")) out[k] = v;
    out.plan_rank = offset + i + 1;
    if (typeof out.network === "string") out.network = toPublicSlug(out.network);
    out.warnings = asArray(c.row._plan_warnings);
    return out;
  });

  // 5. Per-network blocks. Top level carries them too when there is exactly one network.
  const by_network = covered.map((r) => ({ network: r.network, usage: r.usage, benchmark: r.benchmark, stats: r.stats }));
  const single = by_network.length === 1 ? by_network[0] : null;

  return json(
    envelope({
      location,
      usage: single?.usage ?? null,
      benchmark: single?.benchmark ?? null,
      stats: single?.stats ?? null,
      by_network,
      plans,
      next_cursor,
      warnings,
      env,
      state: location.state,
      city: city ? (q.city as string) : null,
    }),
  );
}

// ---------------------------------------------------------------------------
// One network: run the five queries in parallel and shape the blocks
// ---------------------------------------------------------------------------
interface Target {
  key: string; // public slug, or "nmi"
  distributor?: string; // DB slug
  nmi?: string;
}

interface NetworkResult {
  key: string;
  network: { id: string; name: string; state: string | null };
  outOfCoverage: boolean;
  ambiguousIds: string[]; // DB slugs when the SQL matched more than one network (NMI only)
  invalidShares: boolean;
  usage: unknown;
  benchmark: unknown;
  stats: unknown;
  planRows: Row[];
  warnings: Warning[];
}

async function costNetwork(env: Env, q: RatesQuery, t: Target): Promise<NetworkResult> {
  const base = queryParams({ ...q, distributor: t.distributor, nmi: t.nmi, postcode: undefined });
  const pos = q.cursor?.p?.[t.key];
  const finished = q.cursor?.d?.includes(t.key);
  const planParams = { ...base, lim: String(q.limit + 1), ...(pos ? { cursor_cost: pos[0], cursor_offer_id: pos[1] } : {}) };

  const [locRows, usageRows, benchRows, planRows, statsRows] = await Promise.all([
    runQuery(env, "01_location", Q_LOCATION, base),
    runQuery(env, "02_usage", Q_USAGE, base),
    runQuery(env, "03_benchmark", Q_BENCHMARK, base),
    finished ? Promise.resolve([] as Row[]) : runQuery(env, "04_plans", Q_PLANS, planParams),
    runQuery(env, "05_stats", Q_STATS, base),
  ]);

  const loc = locRows[0] ?? {};
  const sqlNetworks = asArray(loc.networks) as Row[];
  const first = sqlNetworks[0] ?? {};
  const id = toPublicSlug(String(first.id ?? t.key));
  const network = {
    id,
    name: DISTRIBUTORS[id]?.name ?? String(first.name ?? id),
    state: (typeof loc.state === "string" ? loc.state : null) ?? DISTRIBUTORS[id]?.state ?? null,
  };

  const u = usageRows[0] ?? {};
  const assumed = asArray(u.assumed) as string[];
  const usage = {
    annual_kwh: u.annual_kwh ?? null,
    peak_share: u.peak_share ?? null,
    shoulder_share: u.shoulder_share ?? null,
    off_peak_share: u.off_peak_share ?? null,
    max_demand_kw: u.max_demand_kw ?? null,
    assumed,
    // provided | regulator_reference (the benchmark's own usage) | small_business_default (10,000 kWh)
    default_basis: u.usage_default_basis ?? null,
  };

  const warnings: Warning[] = [];
  if (usage.annual_kwh === null) {
    warnings.push({
      code: "no_default_usage",
      message: "We don't have a representative usage for this location yet. Pass usage_kwh to see costed plans.",
    });
  }
  if (assumed.some((a) => ["peak_share", "shoulder_share", "max_demand_kw"].includes(a)) && usage.peak_share !== null) {
    warnings.push({
      code: "illustrative_profile",
      message: "Time-of-use split and demand are illustrative network defaults. Pass peak_share, shoulder_share and max_demand_kw for your site.",
    });
  }
  if (usage.default_basis === "small_business_default") {
    warnings.push({
      code: "assumed_usage",
      message: "There's no regulator reference usage for this network, so we've assumed 10,000 kWh a year. Pass usage_kwh for your site.",
    });
  }
  const benchmark = benchRows[0] ?? null;
  if (benchmark && benchmark.standing_offer_method === "not_available") {
    warnings.push({
      code: "benchmark_not_at_usage",
      message: `The ${benchmark.name} is published at ${Number(benchmark.official_usage_kwh).toLocaleString("en-AU")} kWh only, so there's no standing offer figure at your usage.`,
    });
  }

  return {
    key: t.key,
    network,
    outOfCoverage: loc._out_of_coverage === true,
    ambiguousIds: loc.ambiguous === true ? sqlNetworks.map((n) => String(n.id)) : [],
    invalidShares: u._invalid_shares === true,
    usage,
    benchmark,
    stats: statsRows[0] ?? null,
    planRows,
    warnings,
  };
}

function envelope(b: {
  location: unknown;
  usage: unknown;
  benchmark: unknown;
  stats: unknown;
  by_network: unknown[];
  plans: unknown[];
  next_cursor: string | null;
  warnings: Warning[];
  env: Env;
  state: string | null;
  city?: string | null;
}) {
  return {
    location: b.location,
    usage: b.usage,
    benchmark: b.benchmark,
    stats: b.stats,
    by_network: b.by_network,
    plans: b.plans,
    next_cursor: b.next_cursor,
    warnings: b.warnings,
    page_url: b.city
      ? new URL(b.env.CITY_PAGE_PATH_TEMPLATE.replace("{city}", b.city), b.env.SITE_URL).toString()
      : b.state
        ? new URL(b.env.PAGE_PATH_TEMPLATE.replace("{state}", b.state.toLowerCase()), b.env.SITE_URL).toString()
        : null,
    meta: {
      api_version: API_VERSION,
      currency: "AUD",
      prices_include_gst: true,
      source: "Termina",
      generated_at: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Input parsing and validation
// ---------------------------------------------------------------------------
interface RatesQuery {
  distributor?: string;
  postcode?: string;
  state?: string;
  city?: string; // canonical city slug
  nmi?: string;
  usage_kwh?: string;
  peak_share?: string;
  shoulder_share?: string;
  max_demand_kw?: string;
  offer_source: string;
  limit: number;
  cursor?: CursorState;
}

function parseQuery(p: URLSearchParams): RatesQuery {
  const get = (k: string) => {
    const v = p.get(k)?.trim();
    return v ? v : undefined;
  };

  const distributor = get("distributor")?.toLowerCase();
  const postcode = get("postcode");
  const nmi = get("nmi")?.toUpperCase();

  const stateRaw = get("state")?.toUpperCase();
  const cityRaw = get("city")?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  if (!distributor && !postcode && !nmi && !stateRaw && !cityRaw) {
    throw new ApiError(400, "missing_location", "Provide one of: nmi, postcode, distributor, city, or state.");
  }
  if (stateRaw && !STATES.includes(stateRaw)) {
    throw new ApiError(400, "invalid_state", "Unknown state.", { allowed: STATES });
  }
  const city = cityRaw ? (CITIES[cityRaw] ? cityRaw : CITY_ALIASES[cityRaw]) : undefined;
  if (cityRaw && !city) {
    throw new ApiError(400, "unknown_city", `We don't recognise the city "${cityRaw}".`, { examples: Object.keys(CITIES).slice(0, 12) });
  }
  if (distributor && !/^[a-z0-9-]{2,40}$/.test(distributor)) {
    throw new ApiError(400, "invalid_distributor", 'distributor must be a slug like "evoenergy".');
  }
  if (postcode && !/^\d{4}$/.test(postcode)) {
    throw new ApiError(400, "invalid_postcode", "postcode must be 4 digits.");
  }
  if (nmi && !/^[A-Z0-9]{10,11}$/.test(nmi)) {
    throw new ApiError(400, "invalid_nmi", "nmi must be 10 or 11 letters and digits.");
  }

  const usage_kwh = num(get("usage_kwh"), "usage_kwh", 1000, 2_000_000, true);
  const peak_share = num(get("peak_share"), "peak_share", 0, 1);
  const shoulder_share = num(get("shoulder_share"), "shoulder_share", 0, 1);
  const max_demand_kw = num(get("max_demand_kw"), "max_demand_kw", 0, 10_000);
  if (peak_share !== undefined && shoulder_share !== undefined && Number(peak_share) + Number(shoulder_share) > 1) {
    throw new ApiError(400, "invalid_usage_shares", "peak_share + shoulder_share must not exceed 1.");
  }

  const offer_source = get("offer_source")?.toLowerCase() ?? "all";
  if (!(OFFER_SOURCES as readonly string[]).includes(offer_source)) {
    throw new ApiError(400, "invalid_offer_source", "Unknown offer_source.", { allowed: OFFER_SOURCES });
  }

  const limitRaw = get("limit");
  const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ApiError(400, "invalid_limit", `limit must be a whole number from 1 to ${MAX_LIMIT}.`);
  }

  const cursorRaw = get("cursor");
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : undefined;

  return { distributor, postcode, nmi, state: stateRaw, city, usage_kwh, peak_share, shoulder_share, max_demand_kw, offer_source, limit, cursor };
}

function num(v: string | undefined, name: string, min: number, max: number, integer = false): string | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new ApiError(400, `invalid_${name}`, `${name} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}.`);
  }
  return String(n);
}

// Values passed to every query as Metabase variables. Missing values are left out, so Metabase uses the SQL default.
function queryParams(q: RatesQuery): Record<string, string> {
  const all: Record<string, string | undefined> = {
    distributor: q.distributor,
    postcode: q.postcode,
    nmi: q.nmi,
    usage_kwh: q.usage_kwh,
    peak_share: q.peak_share,
    shoulder_share: q.shoulder_share,
    max_demand_kw: q.max_demand_kw,
    offer_source: q.offer_source,
    lim: String(q.limit),
  };
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

// Paging cursor, base64url JSON. Plans from several networks are merged, so it keeps a keyset position
// per network: p = { network: [annual_cost_inc_gst (exact text), offer_id] }, d = networks with nothing left,
// o = how many plans were already returned (for plan_rank).
interface CursorState {
  o: number;
  p: Record<string, [string, string]>;
  d: string[];
}

function encodeCursor(c: CursorState): string {
  return btoa(JSON.stringify(c)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(raw: string): CursorState {
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((raw.length + 3) % 4);
    const c = JSON.parse(atob(padded)) as CursorState;
    const keyOk = (k: string) => /^[a-z0-9-]{2,40}$/.test(k);
    const valid =
      Number.isInteger(c.o) && c.o >= 0 &&
      c.p && typeof c.p === "object" &&
      Object.entries(c.p).every(
        ([k, v]) => keyOk(k) && Array.isArray(v) && /^-?\d+(\.\d+)?$/.test(v[0]) && /^\d{1,19}$/.test(v[1]),
      ) &&
      Array.isArray(c.d) && c.d.every(keyOk);
    if (valid) return c;
  } catch {
    /* fall through */
  }
  throw new ApiError(400, "invalid_cursor", "cursor is not valid. Use next_cursor from a previous response.");
}

function normaliseUrl(url: URL): string {
  // Keys lowercased and sorted; values kept as-is (cursor is case-sensitive)
  const params = [...url.searchParams.entries()]
    .map(([k, v]) => [k.toLowerCase(), v.trim()] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b));
  const qs = new URLSearchParams(params).toString();
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}${qs ? `?${qs}` : ""}`;
}

// ---------------------------------------------------------------------------
// Metabase
// ---------------------------------------------------------------------------
function accessHeaders(env: Env): Record<string, string> {
  return {
    "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
    "x-api-key": env.METABASE_API_KEY,
  };
}

// The eleven variables every query declares (all optional Text; see scripts/build-metabase-sql.mjs)
const VARIABLES = [
  "distributor", "postcode", "nmi", "usage_kwh", "peak_share", "shoulder_share",
  "max_demand_kw", "offer_source", "lim", "cursor_cost", "cursor_offer_id",
];
const TEMPLATE_TAGS = Object.fromEntries(
  VARIABLES.map((name) => [name, { id: name, name, "display-name": name, type: "text", required: false }]),
);

// At most 10 Metabase queries in flight per request (a VIC state request costs 5 networks x 5 queries)
const MAX_IN_FLIGHT = 10;
let inFlight = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

async function runQuery(env: Env, label: string, sql: string, params: Record<string, string>): Promise<Row[]> {
  return withSlot(() => runQueryNow(env, label, sql, params));
}

async function runQueryNow(env: Env, label: string, sql: string, params: Record<string, string>): Promise<Row[]> {
  const parameters = Object.entries(params).map(([tag, value]) => ({
    id: tag,
    type: "category",
    target: ["variable", ["template-tag", tag]],
    value,
  }));
  const fail = (reason: string): never => {
    console.error(JSON.stringify({ metabase_error: reason, query: label }));
    throw new ApiError(503, "upstream_unavailable", "Rates data is temporarily unavailable. Try again shortly.");
  };

  let res: Response;
  try {
    res = await fetch(`${env.METABASE_URL}/api/dataset`, {
      method: "POST",
      headers: { ...accessHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({
        database: Number(env.METABASE_DATABASE_ID),
        type: "native",
        native: { query: sql, "template-tags": TEMPLATE_TAGS },
        parameters,
      }),
      redirect: "manual", // an Access redirect means the service token was rejected
      signal: AbortSignal.timeout(METABASE_TIMEOUT_MS),
    });
  } catch (err) {
    return fail(String(err));
  }

  if (res.status >= 300 && res.status < 400) return fail("Cloudflare Access rejected the service token");

  const body = (await res.json().catch(() => null)) as {
    status?: string;
    error?: string;
    data?: { cols: { name: string }[]; rows: unknown[][] };
  } | null;

  // Metabase answers 202 for completed queries; failures come back as status "failed"
  if (!res.ok || !body || body.status === "failed" || !body.data) {
    return fail(body?.error ?? `HTTP ${res.status}`);
  }

  const names = body.data.cols.map((c) => c.name);
  return body.data.rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
}

// Metabase may return jsonb as a JSON string and text[] as a Postgres array literal
function asArray(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("[")) {
      try {
        return JSON.parse(s);
      } catch {
        return [];
      }
    }
    if (s.startsWith("{") && s.endsWith("}")) {
      const inner = s.slice(1, -1);
      return inner ? inner.split(",").map((x) => x.replace(/^"|"$/g, "")) : [];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// GET /health (not cached, not rate limited)
// ---------------------------------------------------------------------------
async function health(env: Env): Promise<Response> {
  let status = 0;
  try {
    const res = await fetch(`${env.METABASE_URL}/api/health`, {
      headers: accessHeaders(env),
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    status = res.status;
  } catch {
    /* status stays 0 */
  }
  const ok = status === 200;
  return new Response(JSON.stringify({ ok, metabase_status: status }), {
    status: ok ? 200 : 503,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------
function json(body: unknown): Response {
  return withCors(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${BROWSER_CACHE_SECONDS}, s-maxage=${EDGE_CACHE_SECONDS}`,
      },
    }),
  );
}

function errorResponse(err: unknown): Response {
  const e = err instanceof ApiError ? err : new ApiError(500, "internal_error", "Something went wrong.");
  if (!(err instanceof ApiError)) console.error(JSON.stringify({ error: String(err) }));

  return withCors(
    new Response(JSON.stringify({ error: { code: e.code, message: e.message, details: e.details } }), {
      status: e.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }),
  );
}

function withCors(res: Response): Response {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}
