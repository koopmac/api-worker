-- =============================================================================
-- rates_api_v1 / 02_usage.sql
-- Block: response.usage for GET /v1/rates. One row.
-- Flags: [TEST] params · [F7] usage default = regulator reference usage · [F8] TOU split + demand defaults (hardcoded, illustrative)
-- Contract change: shoulder_share + off_peak_share added; shoulder_share should become an API param.
-- NULL annual_kwh / shares = no default for this location → app should warn.
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

-- [F7] Default usage = the regulator's reference usage for the network (official_usage_kwh in benchmark_ref:
-- 10,000 kWh for DMO, VDO and TAS; 25,000 kWh for the ACT). Networks without a benchmark (Ergon) use 10,000 kWh,
-- the DMO small business convention. At the default, the benchmark is exactly the published figure.

-- [HARDCODED][F8] Network load-profile defaults: TOU kWh split + max demand.
-- ILLUSTRATIVE, not derived from data. Replace with regulator usage profiles when sourced.
-- off_peak_share is derived (1 - peak - shoulder); peak + shoulder must be <= 1.
network_profile_defaults (network_slug, peak_share, shoulder_share, max_demand_kw) AS (
    VALUES ('evoenergy-electricity', 0.25::numeric, 0.45::numeric, 15::numeric)
),

-- [HARDCODED] Regulator small business reference prices for 2026-27, by network (DB slugs), GST inclusive.
--   official_annual_inc_gst      published flat-rate annual price at official_usage_kwh
--   official_tou_annual_inc_gst  published time-of-use annual price, where the regulator publishes one
--   flat_supply / flat_usage     the regulated flat tariff (c/day, c/kWh), used to cost the benchmark at any
--                                other usage: supply x 365 + usage x kWh
--   DMO (NSW, SE QLD, SA): AER DMO 8 final determination, Table 2.2 (prices) and Figure 2.4 (small business
--        flat rate tariff caps). Caps x 10,000 kWh reproduce the published prices to the dollar.
--   VDO (VIC): ESC 2026-27 final decision, Table 3 (bills) and the published small business flat tariffs
--        (<40 MWh). AusNet's two blocks are the same rate. Tariffs reproduce the bills within $2 (rounding).
--   TAS: no published annual figure. Aurora's regulated Tariff 23 (Business Single Rate) from 1 July 2026.
--   ACT: ICRC small business reference price. No tariff components published, so no figure at other usage.
--   Not covered: Ergon (regional QLD, QCA notified prices). Update every July.
benchmark_ref (network_slug, name, regulator, period, official_annual_inc_gst, official_tou_annual_inc_gst, official_usage_kwh, flat_supply_c_per_day_inc_gst, flat_usage_c_per_kwh_inc_gst, source_url) AS (
    VALUES
        ('evoenergy-electricity', 'ACT small business reference price', 'ICRC', '2026-27', 5217::numeric, NULL::numeric, 25000::numeric, NULL::numeric, NULL::numeric, 'https://www.legislation.act.gov.au/ni/2026-259/'),
        ('ausgrid',   'Default Market Offer (Ausgrid)',           'AER', '2026-27', 4523::numeric, 4450::numeric, 10000::numeric, 372.7476::numeric, 31.6293::numeric, 'https://www.aer.gov.au/industry/registers/resources/reviews/default-market-offer-2026-27'),
        ('endeavour', 'Default Market Offer (Endeavour Energy)',  'AER', '2026-27', 4343::numeric, 4326::numeric, 10000::numeric, 244.1375::numeric, 34.5198::numeric, 'https://www.aer.gov.au/industry/registers/resources/reviews/default-market-offer-2026-27'),
        ('essential', 'Default Market Offer (Essential Energy)',  'AER', '2026-27', 5517::numeric, 4919::numeric, 10000::numeric, 405.6542::numeric, 40.3667::numeric, 'https://www.aer.gov.au/industry/registers/resources/reviews/default-market-offer-2026-27'),
        ('energex',   'Default Market Offer (Energex)',           'AER', '2026-27', 3849::numeric, 3693::numeric, 10000::numeric, 261.6257::numeric, 28.9359::numeric, 'https://www.aer.gov.au/industry/registers/resources/reviews/default-market-offer-2026-27'),
        ('sapower',   'Default Market Offer (SA Power Networks)', 'AER', '2026-27', 5162::numeric, 4868::numeric, 10000::numeric, 185.5810::numeric, 44.8449::numeric, 'https://www.aer.gov.au/industry/registers/resources/reviews/default-market-offer-2026-27'),
        ('ausnet',    'Victorian Default Offer (AusNet)',         'ESC', '2026-27', 3896::numeric, NULL::numeric, 10000::numeric, 129.39::numeric,   34.23::numeric,   'https://www.esc.vic.gov.au/electricity-and-gas/prices-tariffs-and-benchmarks/victorian-default-offer/victorian-default-offer-price-review-2026-27'),
        ('citipower', 'Victorian Default Offer (CitiPower)',      'ESC', '2026-27', 3033::numeric, NULL::numeric, 10000::numeric, 152.19::numeric,   24.77::numeric,   'https://www.esc.vic.gov.au/electricity-and-gas/prices-tariffs-and-benchmarks/victorian-default-offer/victorian-default-offer-price-review-2026-27'),
        ('jemena',    'Victorian Default Offer (Jemena)',         'ESC', '2026-27', 3488::numeric, NULL::numeric, 10000::numeric, 167.09::numeric,   28.78::numeric,   'https://www.esc.vic.gov.au/electricity-and-gas/prices-tariffs-and-benchmarks/victorian-default-offer/victorian-default-offer-price-review-2026-27'),
        ('powercor',  'Victorian Default Offer (Powercor)',       'ESC', '2026-27', 3357::numeric, NULL::numeric, 10000::numeric, 169.78::numeric,   27.36::numeric,   'https://www.esc.vic.gov.au/electricity-and-gas/prices-tariffs-and-benchmarks/victorian-default-offer/victorian-default-offer-price-review-2026-27'),
        ('united',    'Victorian Default Offer (United Energy)',  'ESC', '2026-27', 3124::numeric, NULL::numeric, 10000::numeric, 154.00::numeric,   25.61::numeric,   'https://www.esc.vic.gov.au/electricity-and-gas/prices-tariffs-and-benchmarks/victorian-default-offer/victorian-default-offer-price-review-2026-27'),
        ('tasnetworks', 'Aurora Energy regulated small business tariff (Tariff 23)', 'OTTER', '2026-27', 3371::numeric, NULL::numeric, 10000::numeric, 170.00::numeric, 27.50::numeric, 'https://www.auroraenergy.com.au/business/products/business-all-pricing')
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
            COALESCE(p.usage_kwh,      brd.official_usage_kwh, 10000::numeric) AS annual_kwh,
            CASE WHEN p.usage_kwh IS NOT NULL          THEN 'provided'
                 WHEN brd.official_usage_kwh IS NOT NULL THEN 'regulator_reference'
                 ELSE 'small_business_default' END     AS usage_default_basis,
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
        LEFT JOIN benchmark_ref brd            ON brd.network_slug = sn.network_slug
        LEFT JOIN network_profile_defaults npd ON npd.network_slug = sn.network_slug
    ) x
),

benchmark_resolved AS (
    SELECT
        br.name,
        br.regulator,
        br.period,
        br.official_annual_inc_gst,
        br.official_tou_annual_inc_gst,
        br.official_usage_kwh,
        br.flat_supply_c_per_day_inc_gst,
        br.flat_usage_c_per_kwh_inc_gst,
        -- [F11] At the reference usage: the published figure, exactly. At any other usage: the regulated
        -- flat tariff costed (supply x 365 + usage x kWh). No tariff components (ACT): not available.
        CASE
            WHEN u.annual_kwh = br.official_usage_kwh THEN br.official_annual_inc_gst
            WHEN br.flat_supply_c_per_day_inc_gst IS NOT NULL THEN
                ROUND((br.flat_supply_c_per_day_inc_gst * 365 + br.flat_usage_c_per_kwh_inc_gst * u.annual_kwh) / 100, 0)
        END AS standing_offer_at_this_usage_inc_gst,
        CASE
            WHEN u.annual_kwh = br.official_usage_kwh THEN 'published'
            WHEN br.flat_supply_c_per_day_inc_gst IS NOT NULL THEN 'tariff_costed'
            ELSE 'not_available'
        END AS standing_offer_method,
        br.source_url
    FROM single_network sn
    JOIN benchmark_ref br ON br.network_slug = sn.network_slug
    CROSS JOIN usage_resolved u
)
-- ═══════════ END SHARED HEADER ═══════════
SELECT
    annual_kwh,
    peak_share,
    shoulder_share,        -- not in contract yet: add alongside peak_share
    off_peak_share,        -- not in contract yet: derived, 1 - peak - shoulder
    max_demand_kw,
    assumed,
    usage_default_basis,   -- provided | regulator_reference | small_business_default
    invalid_shares AS _invalid_shares   -- TRUE → peak + shoulder > 1; app should 400
FROM usage_resolved;
