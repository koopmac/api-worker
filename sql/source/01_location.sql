-- =============================================================================
-- rates_api_v1 / 01_location.sql
-- Block: response.location for GET /v1/rates. One row.
-- App layer: out_of_coverage → 422; ambiguous → warning + skip plans; page_url.
-- Flags: [TEST] params · [F1] slug · [F2] postcode · [F3] NMI · [F4] state map · [F10] fuel_type
-- Not supported (no source data): state / city / q lookups, suburbs (NULL).
-- =============================================================================
-- ═══════════ SHARED HEADER: keep identical across 01–05 (edit once, paste to all) ═══════════
WITH
params AS (
    -- [TEST] Hardcoded test values. Replace with API params once queries are validated.
    -- Pass exactly one of distributor / postcode / nmi (distributor + postcode allowed; nmi overrides).
    SELECT
        'evoenergy-electricity'::text AS distributor,  -- [TEST] matched on slug derived from distributors.name [F1]
        NULL::text        AS postcode,         -- [TEST] try '2620' with distributor NULL for the split case
        NULL::text        AS nmi,              -- [TEST]
        25000::numeric    AS usage_kwh,        -- [TEST] NULL → state representative usage
        NULL::numeric     AS peak_share,       -- [TEST] NULL → network default. Share of annual kWh in peak window
        NULL::numeric     AS shoulder_share,   -- [TEST] NULL → network default. off_peak_share = 1 - peak - shoulder
        NULL::numeric     AS max_demand_kw,    -- [TEST] NULL → network default
        'all'::text       AS offer_source,     -- all | public | termina_buying_group
        20::int           AS lim,
        NULL::numeric     AS cursor_cost,      -- keyset cursor: _cursor_cost of last row returned
        NULL::bigint      AS cursor_offer_id   -- keyset cursor: _offer_id of last row returned
),

-- [HARDCODED][F4] distributor → state. No state column on distributors.
-- Slugs must match the derived slugs from 00_schema_checks #2 or state resolves NULL.
network_state_map (network_slug, state) AS (
    VALUES
        ('evoenergy-electricity', 'ACT'),   -- slugs as derived from distributors.name in our DB
        ('ausgrid',           'NSW'),
        ('endeavour',         'NSW'),
        ('essential',         'NSW'),
        ('energex',           'QLD'),
        ('ergon',             'QLD'),
        ('sapower',           'SA'),
        ('tasnetworks',       'TAS'),
        ('citipower',         'VIC'),
        ('powercor',          'VIC'),
        ('jemena',            'VIC'),
        ('united',            'VIC'),
        ('ausnet',            'VIC')
),

-- [HARDCODED][F7] State representative usage. Only ACT confirmed (ICRC 2026-27). Other states TODO.
state_usage_defaults (state, representative_kwh) AS (
    VALUES ('ACT', 25000::numeric)
),

-- [HARDCODED][F8] Network load-profile defaults: TOU kWh split + max demand.
-- ILLUSTRATIVE, not derived from data. Replace with regulator usage profiles when sourced.
-- off_peak_share is derived (1 - peak - shoulder); peak + shoulder must be <= 1.
network_profile_defaults (network_slug, peak_share, shoulder_share, max_demand_kw) AS (
    VALUES ('evoenergy-electricity', 0.25::numeric, 0.45::numeric, 15::numeric)
),

-- [HARDCODED] Regulator reference prices. Only ACT populated.
benchmark_ref (state, name, regulator, period, official_annual_inc_gst, official_usage_kwh, source_url) AS (
    VALUES ('ACT', 'ACT small business reference price', 'ICRC', '2026-27',
            5217::numeric, 25000::numeric, 'https://www.legislation.act.gov.au/ni/2026-259/')
),

-- Location resolution.
--   [F1] slug derived from distributors.name (no slug column)
--   [F2] postcode via distributors.included_postcodes (reliability unknown)
--   [F3] NMI via first 4 chars vs identity_pattern elements (leading '^' stripped in case they're regex)
--   [F10] distributors.fuel_type = 'elec' value unverified
network AS (
    SELECT
        d.id    AS distributor_id,
        d.name  AS network_name,
        s.network_slug,
        m.state
    FROM public.distributors d
    CROSS JOIN params p
    CROSS JOIN LATERAL (
        SELECT trim(BOTH '-' FROM regexp_replace(lower(d.name), '[^a-z0-9]+', '-', 'g')) AS network_slug
    ) s
    LEFT JOIN network_state_map m ON m.network_slug = s.network_slug
    WHERE d.fuel_type::text = 'elec'
      AND CASE
            WHEN p.nmi IS NOT NULL THEN EXISTS (
                SELECT 1
                FROM unnest(d.identity_pattern) ip
                WHERE LEFT(ltrim(ip::text, '^'), 4) = LEFT(upper(p.nmi), 4)
            )
            WHEN p.distributor IS NOT NULL THEN
                s.network_slug = p.distributor
                AND (p.postcode IS NULL OR p.postcode = ANY (d.included_postcodes::text[]))
            WHEN p.postcode IS NOT NULL THEN
                p.postcode = ANY (d.included_postcodes::text[])
            ELSE FALSE
          END
),

-- Exactly one network, or nothing (ambiguous / out of coverage → no plans, no defaults)
single_network AS (
    SELECT * FROM network
    WHERE (SELECT COUNT(*) FROM network) = 1
),

usage_resolved AS (
    SELECT
        x.*,
        1 - x.peak_share - x.shoulder_share                   AS off_peak_share,
        (x.peak_share + x.shoulder_share) > 1                 AS invalid_shares
    FROM (
        SELECT
            COALESCE(p.usage_kwh,      sud.representative_kwh) AS annual_kwh,
            COALESCE(p.peak_share,     npd.peak_share)         AS peak_share,
            COALESCE(p.shoulder_share, npd.shoulder_share)     AS shoulder_share,
            COALESCE(p.max_demand_kw,  npd.max_demand_kw)      AS max_demand_kw,
            array_remove(ARRAY[
                CASE WHEN p.usage_kwh      IS NULL THEN 'usage_kwh'      END,
                CASE WHEN p.peak_share     IS NULL THEN 'peak_share'     END,
                CASE WHEN p.shoulder_share IS NULL THEN 'shoulder_share' END,
                CASE WHEN p.max_demand_kw  IS NULL THEN 'max_demand_kw'  END
            ]::text[], NULL::text) AS assumed
        FROM params p
        LEFT JOIN single_network sn            ON TRUE
        LEFT JOIN state_usage_defaults sud     ON sud.state = sn.state
        LEFT JOIN network_profile_defaults npd ON npd.network_slug = sn.network_slug
    ) x
),

benchmark_resolved AS (
    SELECT
        br.name,
        br.regulator,
        br.period,
        br.official_annual_inc_gst,
        br.official_usage_kwh,
        -- [F11] PLACEHOLDER: linear scaling of the reference price to requested usage (standing offer not costed)
        ROUND(br.official_annual_inc_gst * u.annual_kwh / NULLIF(br.official_usage_kwh, 0), 0)
            AS standing_offer_at_this_usage_inc_gst,
        br.source_url
    FROM single_network sn
    JOIN benchmark_ref br ON br.state = sn.state
    CROSS JOIN usage_resolved u
)
-- ═══════════ END SHARED HEADER ═══════════
SELECT
    CASE WHEN p.nmi IS NOT NULL      THEN 'nmi'
         WHEN p.postcode IS NOT NULL THEN 'postcode'
         ELSE 'distributor' END                               AS level,
    COALESCE(p.nmi, p.postcode, p.distributor)                AS input,
    CASE WHEN COUNT(n.distributor_id) = 1 THEN MAX(n.state) END AS state,
    p.postcode,
    NULL::text[]                                              AS suburbs,   -- [F5] no source table
    COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id',              n.network_slug,             -- [F1] derived, not a real slug
                'name',            n.network_name,
                'state',           n.state,
                '_distributor_id', n.distributor_id            -- internal, strip in API
            ) ORDER BY n.network_name
        ) FILTER (WHERE n.distributor_id IS NOT NULL),
        '[]'::jsonb
    )                                                         AS networks,
    COUNT(n.distributor_id) > 1                               AS ambiguous,
    COUNT(n.distributor_id) = 0                               AS _out_of_coverage
FROM params p
LEFT JOIN network n ON TRUE
GROUP BY p.nmi, p.postcode, p.distributor;
