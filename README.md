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
scripts/build-postcode-map.mjs   rebuilds data/postcode-distributors.json from CDR plan data
scripts/build_geography.py       rebuilds data/postcode-suburbs.json and data/cities.json from ABS data
data/distributors.json           networks: public slug, name, state, and the slug our DB uses
data/postcode-distributors.json  postcode -> distributor(s), bundled into the Worker
data/postcode-collisions.csv     postcodes served by 2+ networks, with evidence
data/postcode-map-report.md      coverage summary from the last build
data/postcode-suburbs.json       postcode -> suburbs (ABS, CC BY 4.0)
data/cities.json                 97 cities: capitals (ABS Greater Capital City areas) and Significant Urban Areas
data/geography-report.md         every city with its networks
wrangler.jsonc                   Worker config (Metabase URL and database ID, rate limit)
```

## API

`GET /v1/rates`

| Param | Notes |
|---|---|
| `nmi` | 10 or 11 characters. Overrides the others |
| `postcode` | 4 digits |
| `distributor` | slug, e.g. `evoenergy`. On its own, or to narrow a postcode, city or state |
| `city` | slug, e.g. `brisbane`, `gold-coast`, `newcastle`. See `data/cities.json` |
| `state` | `NSW`, `VIC`, `QLD`, `SA`, `TAS`, `ACT` (`WA` and `NT` return 422) |
| `usage_kwh` | whole number, 1,000 to 2,000,000. Default: state representative usage |
| `peak_share`, `shoulder_share` | 0 to 1, sum at most 1. Default: network profile |
| `max_demand_kw` | Default: network profile |
| `offer_source` | `all` (default), `public`, `termina_buying_group` |
| `limit` | plans per page, 1 to 50, default 10 |
| `cursor` | `next_cursor` from the previous page |

At least one of `nmi`, `postcode`, `distributor`, `city`, `state` is required.

Response: `location`, `usage`, `benchmark`, `stats`, `by_network`, `plans`, `next_cursor`, `pagination`, `warnings`, `page_url`, `meta`.
All prices include GST.

- **All offers for the location**, buying group and public, cheapest first, 10 per page. `pagination` gives
  `page`, `total_pages`, `total_plans`, `from_rank`, `to_rank`, `has_more` and `next_cursor`; pass `cursor` to
  get the next page. Totals follow the `offer_source` filter.
- **Customer type.** Offers known to be residential are excluded. Offers with no customer-type link (most
  public offers today) are included with `customer_type_verified: false` and a `customer_type_unverified`
  warning. `stats` adds `plans_public`, `plans_buying_group`, `plans_customer_type_unverified` and
  `lowest_public_verified_business_inc_gst` (lowest public price counting verified business plans only).
- **Several networks** (a split postcode, a state, a city) without `usage_kwh` are all costed at 10,000 kWh, so
  their plans can be ranked together (`common_usage` warning).
- `by_network` has one entry per network costed (`network`, `usage`, `benchmark`, `stats`).
- `usage`, `benchmark` and `stats` at the top level are filled when exactly one network applies, and are
  `null` when several do (read them from `by_network` instead). `page_url` is `null` across states.
- Warnings that apply to one of several networks carry a `network` field.
- `location.suburbs` lists the suburbs in a postcode. `location.city` is set for city lookups.
- States and cities usually span several networks: every network is costed and the plans are merged,
  with a `multiple_networks` warning (`ambiguous` stays `false`, since that is expected). `page_url` points to
  the state or city page (`PAGE_PATH_TEMPLATE`, `CITY_PAGE_PATH_TEMPLATE` in `wrangler.jsonc`).
- Benchmarks (`benchmark`, or per network in `by_network`), all 2026-27 and GST inclusive:

  | Networks | Benchmark | Reference usage | Costed at other usage from |
  |---|---|---|---|
  | Ausgrid, Endeavour, Essential, Energex, SA Power Networks | AER DMO 8 | 10,000 kWh | DMO flat rate tariff caps |
  | CitiPower, Powercor, Jemena, United, AusNet | ESC VDO | 10,000 kWh | VDO small business flat tariffs |
  | TasNetworks | Aurora Tariff 23 (regulated) | 10,000 kWh | Tariff 23 rates |
  | Evoenergy | ICRC reference price | 25,000 kWh | not available (no tariff components published) |
  | Ergon | none yet | (10,000 kWh assumed) | |

  - **Default usage is the benchmark's reference usage**, so by default `standing_offer_at_this_usage_inc_gst`
    equals the published figure and `standing_offer_method` is `published`. `usage.default_basis` says where
    the usage came from (`provided`, `regulator_reference`, `small_business_default`).
  - **At any other usage** the regulated flat tariff is costed (supply x 365 + usage x kWh), method
    `tariff_costed`. Each plan's `vs_standing_offer_pct` compares against this figure.
  - `official_annual_inc_gst` / `official_usage_kwh` are always the published figure, and
    `official_tou_annual_inc_gst` is the published time-of-use figure where there is one.
  - Update `benchmark_ref` in the shared SQL header every July (prices, usage and tariff components).

| Status | When |
|---|---|
| 200 | Rates returned. Postcodes served by several networks return plans for all of them, plus an `ambiguous_location` warning |
| 400 | Invalid input (`error.code` says which), including `distributor_location_mismatch` and `unknown_city` |
| 422 | `out_of_coverage`: no network for that location |
| 429 | Rate limited (120 requests per minute per IP) |
| 503 | Metabase unreachable or a query failed (cached pages keep serving) |

`GET /health` checks the Worker can reach Metabase through Access.

### How a request runs

1. Validate input.
2. Resolve the network(s): postcode from `data/postcode-distributors.json`, distributor from
   `data/distributors.json`, NMI in SQL.
3. For each network, run all five queries in parallel (location, usage, benchmark, plans, stats).
   Plans asks for `limit + 1` rows to know if there's another page.
4. Merge plans across networks cheapest first, strip internal `_` fields, turn `_plan_warnings` into each
   plan's `warnings`, add warnings (`ambiguous_location`, `no_default_usage`, `illustrative_profile`,
   `benchmark_scaled`, `rates_not_available`), and build `next_cursor` (one position per network).
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

## Postcodes and distributors

Our database has no postcode to distributor mapping, so the Worker resolves postcodes itself from
`data/postcode-distributors.json` and passes the distributor to the SQL. The SQL never receives a postcode.

- One network: the request runs as that distributor.
- Two or more networks (a **collision**, e.g. 2620 Queanbeyan/ACT): the API costs **every** network, merges
  their plans cheapest first (each plan's `network` says which it applies to), and returns
  `ambiguous: true` with an `ambiguous_location` warning. Paging walks through all networks' plans.
  Every collision is listed in `data/postcode-collisions.csv` with how many retailer brands back each side.
  A side backed by one brand against many is flagged "may be a data error".
- Not in the map: 422 `out_of_coverage`.

The map is built from Consumer Data Right plan data: every current electricity plan lists its distributors
and postcodes, and plans naming exactly one distributor tell us which postcodes it serves. Refresh it
(network boundaries rarely change, so quarterly is plenty):

```bash
npm run build:postcodes
```

`data/distributors.json` links our public slugs (`evoenergy`) to the slugs derived from
`distributors.name` in our DB (`evoenergy-electricity`). The API accepts either. If the build reports
unmapped CDR names, add them to that network's `cdr_names`. A network with `db_slug: null` returns a
`rates_not_available` warning instead of querying.

## Suburbs and cities

Built from ABS ASGS Edition 3 (2021) allocation files (CC BY 4.0), which place every mesh block in one
postcode area, one suburb and one city area:

- A suburb is listed for a postcode when at least 25% of the suburb's mesh blocks fall in it.
- A postcode belongs to a city when at least 50% of its mesh blocks are in the city area.
- A city's networks come from its postcodes. Networks serving at least 10% of them are costed; the rest are
  listed in a `fringe_networks` warning.
- Canberra is the ACT. Capitals use Greater Capital City areas, so "sydney" is Greater Sydney.

Refresh after the ABS publishes a new edition (`pip install openpyxl` first):

```bash
npm run build:geography
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
