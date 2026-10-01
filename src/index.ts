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

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  RATE_LIMITER: RateLimiter;
  SITE_URL: string;
  PAGE_PATH_TEMPLATE: string; // e.g. "/cheapest-business-electricity/{state}"
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
          location: "one of distributor, postcode, nmi (distributor + postcode allowed; nmi overrides)",
          optional: "usage_kwh, peak_share, shoulder_share, max_demand_kw, offer_source, limit, cursor",
          examples: [
            "/v1/rates?distributor=evoenergy",
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
  const base = queryParams(q);
  const warnings: Warning[] = [];

  // 1. Location first: it decides whether the other four are worth running
  const locRow = (await runQuery(env, "01_location", Q_LOCATION, base))[0];
  if (!locRow) throw new ApiError(500, "internal_error", "Location lookup returned no row.");

  if (locRow._out_of_coverage === true) {
    throw new ApiError(
      422,
      "out_of_coverage",
      "We don't have an electricity network for that location. Check the distributor, postcode or NMI.",
      { input: locRow.input },
    );
  }

  const networks = (asArray(locRow.networks) as Row[]).map(({ _distributor_id, ...n }) => n);
  const state = typeof locRow.state === "string" ? locRow.state : null;
  const location = {
    level: locRow.level,
    input: locRow.input,
    state,
    postcode: locRow.postcode ?? null,
    suburbs: asArray(locRow.suburbs),
    networks,
    ambiguous: locRow.ambiguous === true,
  };

  if (location.ambiguous) {
    warnings.push({
      code: "ambiguous_location",
      message: `This location is served by ${networks.length} networks (${networks
        .map((n) => n.id)
        .join(", ")}). Pass distributor or nmi to choose one.`,
    });
    return json(envelope({ location, usage: null, benchmark: null, stats: null, plans: [], next_cursor: null, warnings, env, state }));
  }

  // 2. Other blocks in parallel. Plans fetches limit + 1 to detect another page.
  const [usageRows, benchRows, planRows, statsRows] = await Promise.all([
    runQuery(env, "02_usage", Q_USAGE, base),
    runQuery(env, "03_benchmark", Q_BENCHMARK, base),
    runQuery(env, "04_plans", Q_PLANS, { ...base, lim: String(q.limit + 1) }),
    runQuery(env, "05_stats", Q_STATS, base),
  ]);

  // Usage
  const u = usageRows[0] ?? {};
  if (u._invalid_shares === true) {
    throw new ApiError(400, "invalid_usage_shares", "peak_share + shoulder_share must not exceed 1.", {
      peak_share: u.peak_share,
      shoulder_share: u.shoulder_share,
    });
  }
  const assumed = asArray(u.assumed) as string[];
  const usage = {
    annual_kwh: u.annual_kwh ?? null,
    peak_share: u.peak_share ?? null,
    shoulder_share: u.shoulder_share ?? null,
    off_peak_share: u.off_peak_share ?? null,
    max_demand_kw: u.max_demand_kw ?? null,
    assumed,
  };
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

  // Benchmark (zero rows = no regulator reference for this state)
  const benchmark = benchRows[0] ?? null;
  if (benchmark && usage.annual_kwh !== null && Number(benchmark.official_usage_kwh) !== Number(usage.annual_kwh)) {
    warnings.push({
      code: "benchmark_scaled",
      message: `The ${benchmark.name} is set at ${benchmark.official_usage_kwh} kWh; the figure for your usage is scaled linearly and is an estimate.`,
    });
  }

  // Plans: strip internal fields, page with keyset cursor
  const hasMore = planRows.length > q.limit;
  const page = planRows.slice(0, q.limit);
  const last = page[page.length - 1];
  const next_cursor = hasMore && last ? encodeCursor(String(last._cursor_cost), String(last._offer_id)) : null;
  const plans = page.map((p) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(p)) if (!k.startsWith("_")) out[k] = v;
    out.warnings = asArray(p._plan_warnings);
    return out;
  });

  const stats = statsRows[0] ?? null;

  return json(envelope({ location, usage, benchmark, stats, plans, next_cursor, warnings, env, state }));
}

function envelope(b: {
  location: unknown;
  usage: unknown;
  benchmark: unknown;
  stats: unknown;
  plans: unknown[];
  next_cursor: string | null;
  warnings: Warning[];
  env: Env;
  state: string | null;
}) {
  return {
    location: b.location,
    usage: b.usage,
    benchmark: b.benchmark,
    stats: b.stats,
    plans: b.plans,
    next_cursor: b.next_cursor,
    warnings: b.warnings,
    page_url: b.state
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
  nmi?: string;
  usage_kwh?: string;
  peak_share?: string;
  shoulder_share?: string;
  max_demand_kw?: string;
  offer_source: string;
  limit: number;
  cursor?: { cost: string; offerId: string };
}

function parseQuery(p: URLSearchParams): RatesQuery {
  const get = (k: string) => {
    const v = p.get(k)?.trim();
    return v ? v : undefined;
  };

  const distributor = get("distributor")?.toLowerCase();
  const postcode = get("postcode");
  const nmi = get("nmi")?.toUpperCase();

  if (!distributor && !postcode && !nmi) {
    throw new ApiError(400, "missing_location", "Provide one of: distributor, postcode, or nmi.");
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

  return { distributor, postcode, nmi, usage_kwh, peak_share, shoulder_share, max_demand_kw, offer_source, limit, cursor };
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
    cursor_cost: q.cursor?.cost,
    cursor_offer_id: q.cursor?.offerId,
  };
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

// Keyset cursor: base64url of [annual_cost_inc_gst (exact text), offer_id]
function encodeCursor(cost: string, offerId: string): string {
  return btoa(JSON.stringify([cost, offerId])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(c: string): { cost: string; offerId: string } {
  try {
    const padded = c.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((c.length + 3) % 4);
    const [cost, offerId] = JSON.parse(atob(padded));
    if (/^-?\d+(\.\d+)?$/.test(cost) && /^\d{1,19}$/.test(offerId)) return { cost, offerId };
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

async function runQuery(env: Env, label: string, sql: string, params: Record<string, string>): Promise<Row[]> {
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
