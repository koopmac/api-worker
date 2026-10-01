# Termina rates API

Business electricity rates API on Cloudflare Workers, querying Postgres through Metabase's `/api/dataset`.

```
api.termina.com/v1/rates  (Worker: validation, rate limit, edge cache, response shaping)
   -> Cloudflare Access (service token)
   -> metabase.termina.io/api/dataset  (five native queries, bundled into the Worker)
   -> Postgres
```

No saved questions are needed in Metabase. The SQL in `sql/metabase/` is bundled into the Worker at deploy
time. Request values are sent as Metabase variables, never pasted into the SQL, so Metabase escapes them.

## Repo layout

```
src/index.ts                     the Worker
sql/source/01..05.sql            the queries as written, with hardcoded [TEST] params (run in any SQL client)
sql/metabase/01..05.sql          generated, and what the Worker actually runs. Don't edit by hand
scripts/build-metabase-sql.mjs   sql/source -> sql/metabase
wrangler.jsonc                   Worker config (Metabase URL and database ID, rate limit)
```

## API

`GET /v1/rates`

| Param | Notes |
|---|---|
| `distributor` | slug, e.g. `evoenergy` |
| `postcode` | 4 digits. Can combine with `distributor` |
| `nmi` | 10 or 11 characters. Overrides the others |
| `usage_kwh` | whole number, 1,000 to 2,000,000. Default: state representative usage |
| `peak_share`, `shoulder_share` | 0 to 1, sum at most 1. Default: network profile |
| `max_demand_kw` | Default: network profile |
| `offer_source` | `all` (default), `public`, `termina_buying_group` |
| `limit` | 1 to 50, default 20 |
| `cursor` | `next_cursor` from the previous page |

At least one of `distributor`, `postcode`, `nmi` is required.

Response: `location`, `usage`, `benchmark`, `stats`, `plans`, `next_cursor`, `warnings`, `page_url`, `meta`.
All prices include GST.

| Status | When |
|---|---|
| 200 | Rates returned. Ambiguous postcodes return 200 with an `ambiguous_location` warning and no plans |
| 400 | Invalid input (`error.code` says which) |
| 422 | `out_of_coverage`: no network for that location |
| 429 | Rate limited (120 requests per minute per IP) |
| 503 | Metabase unreachable or a query failed (cached pages keep serving) |

`GET /health` checks the Worker can reach Metabase through Access.

### How a request runs

1. Validate input.
2. Run **01 location**. Out of coverage → 422. Ambiguous → return with a warning (one query total).
3. Run **02 usage, 03 benchmark, 04 plans, 05 stats** in parallel. Plans asks for `limit + 1` rows to know if there's another page.
4. Strip internal `_` fields, turn `_plan_warnings` into each plan's `warnings`, add top-level warnings
   (`no_default_usage`, `illustrative_profile`, `benchmark_scaled`), build `next_cursor` and `page_url`.
5. Cache the 200 response at the edge for an hour.

## Setup

### 1. Cloudflare Access service token
Zero Trust → Access → Service credentials → **Create service token** (`rates-api-worker`). Save the ID and secret.
Then open the Access application for `metabase.termina.io` and add a policy:
**Action: Service Auth**, Include: Service Token = `rates-api-worker`.
Without this policy Access ignores the token and redirects to the login page.

### 2. Metabase API key and database ID
Use an API key whose group can run native queries on the rates database. Ideally that group has access to
the rates database only, and nothing else in Metabase.

Set `METABASE_DATABASE_ID` in `wrangler.jsonc` to the rates database's ID (the `"database"` value you use in
`/api/dataset` calls, or the number in Admin → Databases → the database's URL). Default is `1`.

### 3. Deploy from GitHub
1. Push this folder to a GitHub repo.
2. Cloudflare dashboard → Workers & Pages → Create → **Import a repository** → pick the repo.
   Build command: leave blank. Deploy command: `npx wrangler deploy`.
3. Worker → Settings → Variables and Secrets → add **secrets** `CF_ACCESS_CLIENT_ID`,
   `CF_ACCESS_CLIENT_SECRET`, `METABASE_API_KEY`.
4. Every push to `main` redeploys.

The `api.termina.com` custom domain is created on first deploy (the zone must be on this Cloudflare account).

### 4. Test
```bash
curl https://api.termina.com/health
curl -i "https://api.termina.com/v1/rates?distributor=evoenergy&limit=5"   # twice: X-Cache MISS then HIT
curl "https://api.termina.com/v1/rates?postcode=2620"                       # ambiguous_location warning
```

## Changing a query

1. Edit the file in `sql/source/` (keep the shared header identical across 01 to 05).
2. `npm run build:sql`
3. Commit and push. The Worker redeploys with the new SQL. If output columns changed, update `src/index.ts` to match.

The build makes two changes to the source SQL: it replaces the `params` block with Metabase variables, and
returns `_cursor_cost` as text in 04 so the paging cursor round-trips exactly.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in the three secrets
npm run dev                       # http://localhost:8787
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `/health` shows `metabase_status: 302` | Access rejected the token: Service Auth policy missing or wrong secret |
| `/health` shows 502 or 530 | Tunnel behind Metabase is down |
| 503 and the log says 401/403 | Metabase API key wrong, or its group can't query the rates database |
| 503 and the log mentions a table or column | Wrong `METABASE_DATABASE_ID`, or the SQL needs fixing |
| Old numbers after a data refresh | Edge cache (1 hour). Purge the `api.termina.com` cache after refreshes |

Worker logs: dashboard → Worker → Logs. Each request logs one JSON line; Metabase failures log `metabase_error`.
