// Creates or updates the five Metabase saved questions from sql/metabase/*.sql,
// with all eleven variables defined as optional Text. Run from your machine:
//
//   METABASE_URL=https://metabase.termina.io \
//   METABASE_API_KEY=... CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... \
//   METABASE_DATABASE_ID=2 METABASE_COLLECTION_ID=15 \
//   npm run sync:metabase
//
// Card IDs are saved to metabase-cards.json so later runs update the same questions.
// Copy the printed IDs into wrangler.jsonc (CARD_*).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

const need = ["METABASE_URL", "METABASE_API_KEY", "METABASE_DATABASE_ID"];
for (const k of need) if (!process.env[k]) throw new Error(`Missing env var ${k}`);

const base = process.env.METABASE_URL.replace(/\/+$/, "");
const headers = {
  "Content-Type": "application/json",
  "x-api-key": process.env.METABASE_API_KEY,
  ...(process.env.CF_ACCESS_CLIENT_ID && {
    "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET,
  }),
};

const CARDS = [
  ["CARD_LOCATION", "01_location.sql", "Rates API v1 · 01 location"],
  ["CARD_USAGE", "02_usage.sql", "Rates API v1 · 02 usage"],
  ["CARD_BENCHMARK", "03_benchmark.sql", "Rates API v1 · 03 benchmark"],
  ["CARD_PLANS", "04_plans.sql", "Rates API v1 · 04 plans"],
  ["CARD_STATS", "05_stats.sql", "Rates API v1 · 05 stats"],
];
const VARS = ["distributor", "postcode", "nmi", "usage_kwh", "peak_share", "shoulder_share",
  "max_demand_kw", "offer_source", "lim", "cursor_cost", "cursor_offer_id"];

const idsFile = "metabase-cards.json";
const ids = existsSync(idsFile) ? JSON.parse(readFileSync(idsFile, "utf8")) : {};

async function api(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers, body: body && JSON.stringify(body), redirect: "manual" });
  if (res.status >= 300 && res.status < 400) throw new Error("Redirected by Cloudflare Access: check the service token and Service Auth policy");
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

for (const [key, file, name] of CARDS) {
  const query = readFileSync(`sql/metabase/${file}`, "utf8");
  const existing = ids[key] ? await api("GET", `/api/card/${ids[key]}`).catch(() => null) : null;
  const oldTags = existing?.dataset_query?.native?.["template-tags"] ?? {};

  const tags = Object.fromEntries(VARS.map((v) => [v, {
    id: oldTags[v]?.id ?? randomUUID(),
    name: v,
    "display-name": v,
    type: "text",
    required: false,
  }]));

  const card = {
    name,
    display: "table",
    visualization_settings: {},
    dataset_query: {
      type: "native",
      database: Number(process.env.METABASE_DATABASE_ID),
      native: { query, "template-tags": tags },
    },
    ...(process.env.METABASE_COLLECTION_ID && { collection_id: Number(process.env.METABASE_COLLECTION_ID) }),
  };

  const saved = existing ? await api("PUT", `/api/card/${ids[key]}`, card) : await api("POST", "/api/card", card);
  ids[key] = saved.id;
  console.log(`${existing ? "updated" : "created"} ${key} = ${saved.id}  (${name})`);
}

writeFileSync(idsFile, JSON.stringify(ids, null, 2) + "\n");
console.log("\nPaste into wrangler.jsonc vars:");
for (const [key] of CARDS) console.log(`    "${key}": "${ids[key]}",`);
