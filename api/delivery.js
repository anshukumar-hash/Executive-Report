/**
 * Vercel Serverless Function — /api/delivery
 *
 * Delivery · Operations pendency metrics, computed live from Metabase's dataset
 * API (ClickHouse). Split into its own endpoint so the heavy (~8s) ClickHouse
 * queries don't block the main /api/metrics dashboard load — the frontend
 * fetches this in parallel and fills the Delivery tiles when it resolves.
 *
 * Config via env (set in .env.local locally, and Vercel → Settings → Env Vars;
 * for `vercel dev` they must also exist in the Development environment):
 *   METABASE_BASE_URL, METABASE_API_KEY, METABASE_DATABASE_ID (default 363).
 *
 * Each metric returns null if unconfigured or the query fails — the dashboard
 * keeps "—". Video and 360 pendency queries are placeholders until provided.
 */

// Count of QC-on, non-360 SKUs (Live/Onboarding Automobile enterprises, test &
// excluded IDs filtered out) created in the last 30 days, pending QC > 6 hours.
const IMAGE_PENDENCY_SQL = `
SELECT
    COUNT(sku_id) AS total_pendency_count
FROM
(
    SELECT
        sk.sku_id,
        sk.crm_status,
        sk.is_360,
        CASE
            WHEN ed.quality_check = 1
             AND ed.enterprise_qc_priority = 0
            THEN 1
            ELSE 0
        END AS is_qc_on,
        dateDiff('hour', sk.created_on, now()) AS pending_duration_hours
    FROM eventila.ai_sku sk
    LEFT JOIN eventila.enterprise_team_details etd
        ON sk.team_id = etd.team_id
    LEFT JOIN eventila.enterprise_details ed
        ON etd.enterprise_id = ed.enterprise_id
    LEFT JOIN PartnerSystem.outputworkflows o
        ON o.teamId = etd.team_id AND o.enterpriseId = etd.enterprise_id AND o.isActive = 1
    LEFT JOIN PartnerSystem.inputworkflows i
        ON i.teamId = etd.team_id AND i.enterpriseId = etd.enterprise_id AND i.isActive = 1 AND i.createDraft = 'true'
    LEFT JOIN inventory.dealerVinMapping dvm
        ON dvm.teamId = etd.team_id AND dvm.enterpriseId = etd.enterprise_id AND dvm.dealerVinId = sk.dealerVinId
    LEFT JOIN media_management.medias m
        ON m.dealerVinId = sk.dealerVinId AND m.mediaId = sk.mediaId
    LEFT JOIN PartnerSystem.rooftopinventories r
        ON r.dealerVinId = m.dealerVinId
    WHERE sk.created_on >= today() - INTERVAL 30 DAY
      AND sk.is_hidden = 0
      AND ed.is_test_account = 0
      AND etd.is_test_account = 0
      AND ed.is_active = 1
      AND ed.stage IN ('Live', 'Onboarding')
      AND ed.category = 'Automobile'
      AND sk.crm_status != 'qc_done'
      AND ed.enterprise_id NOT IN
      (
        '0b4bc56b1','00d2aafe9','197d146c4','18d200080','1O103VCUW',
        '28733e36c','2LA80M7WO','8e2f0d75a','293e1a285','TaD1VC1Ko',
        '3471c086e','39b5a5268','af5e033aa','c95e31793','caae51a38',
        'L3X0W7YW6','74e1ee1ab','4J8975Z1G','4bc9d1ce6','7KIAEAQQA'
      )
    LIMIT 1 BY sk.sku_id
    SETTINGS
        join_algorithm = 'grace_hash',
        max_bytes_in_join = 10737418240,
        max_bytes_before_external_sort = 10737418240,
        max_threads = 4
)
WHERE is_qc_on = 1
  AND toString(is_360) IN ('0', 'false', 'FALSE')
  AND pending_duration_hours > 6`;

// Runs one native SQL query against Metabase's dataset API and returns the first
// scalar cell as a number (null on any failure).
async function metabaseScalar(sql) {
  const base = (process.env.METABASE_BASE_URL || '').replace(/\/$/, '');
  const key = process.env.METABASE_API_KEY;
  const dbId = Number(process.env.METABASE_DATABASE_ID || 363);
  if (!base || !key || !dbId || !sql) return null;
  // NOTE: .trim() is required — a leading newline makes Metabase's ClickHouse
  // driver fail with "Select statement did not produce a ResultSet".
  const res = await fetch(`${base}/api/dataset`, {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ database: dbId, type: 'native', native: { query: sql.trim() } }),
  });
  if (!res.ok) throw new Error(`metabase dataset -> HTTP ${res.status}`);
  const out = await res.json();
  const rows = out && out.data && out.data.rows;
  if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0])) return null;
  const n = Number(rows[0][0]);
  return isNaN(n) ? null : n;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const [imagePendency, videoPendency, threeSixtyPendency] = await Promise.all([
      metabaseScalar(IMAGE_PENDENCY_SQL).catch(() => null),
      // Placeholders — swap in the Video / 360 pendency SQL when provided.
      Promise.resolve(null),
      Promise.resolve(null),
    ]);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      imagePendency,       // null if Metabase unreachable/unconfigured
      videoPendency,       // null until the query is added
      threeSixtyPendency,  // null until the query is added
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
