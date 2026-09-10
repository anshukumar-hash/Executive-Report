/**
 * /api/delivery — Delivery Operations pendency (> 6 hrs): Image · Video · 360,
 * queried DIRECTLY from the ClickHouse warehouse (the Metabase public cards
 * these used to read now 400 on Metabase's side).
 *
 * Config via APP_SECRETS (same keys the warehouse services use):
 *   CLICKHOUSE_URL       e.g. https://leio048s4j.us-east-1.aws.clickhouse.cloud:8443
 *   CLICKHOUSE_USER
 *   CLICKHOUSE_PASSWORD
 *   CLICKHOUSE_DATABASE  optional, default 'default'
 *
 * Read-only over the HTTP interface with FINAL=1 (the tables are
 * ReplacingMergeTree — without FINAL counts come out inflated by un-merged row
 * versions). If the CLICKHOUSE_* keys are absent each metric is null and the
 * tiles keep "—", with a note naming what to add.
 */

const CH_URL = (process.env.CLICKHOUSE_URL || '').replace(/\/+$/, '');
const CH_USER = process.env.CLICKHOUSE_USER;
const CH_PASSWORD = process.env.CLICKHOUSE_PASSWORD;
const CH_DATABASE = process.env.CLICKHOUSE_DATABASE || 'default';

async function chQuery(sql, timeoutMs = 60000) {
  const params = new URLSearchParams({
    database: CH_DATABASE,
    default_format: 'JSON',
    final: '1',
    readonly: '2',
    output_format_json_quote_64bit_integers: '0',
    max_execution_time: String(Math.floor(timeoutMs / 1000)),
    timeout_overflow_mode: 'throw',
  });
  const res = await fetch(`${CH_URL}/?${params}`, {
    method: 'POST',
    headers: {
      'x-clickhouse-user': CH_USER,
      'x-clickhouse-key': CH_PASSWORD,
      'content-type': 'text/plain; charset=utf-8',
    },
    body: sql,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.split('\n')[0].slice(0, 200)}`);
  return JSON.parse(text).data || [];
}

const scalar = async (sql) => {
  const rows = await chQuery(sql);
  const v = rows[0] && rows[0].total_pending;
  return v == null ? null : Number(v);
};

// ── Image pendency (last 90 days, QC-unassigned, Automobile enterprises) ──────
const IMAGE_SQL = `
WITH filtered_ai_sku AS (
  SELECT * FROM eventila.ai_sku
  WHERE created_on >= now() - INTERVAL 90 DAY AND is_hidden = 0 AND status = 'Done'
    AND status NOT IN ('draft')
    AND crm_status NOT IN ('','qc_done','enterprise_done','image_reshoot','qc_onhold')
    AND enterprise_id NOT IN ('de4aca97f','3471c086e','ca3c8e6e7','d2ce8274e','ae0a68ccf','36dd343cd','f9830c477','88135ef45','204fffd0d')
    AND ((enterprise_id IN ('1ff0e3f32','68d42e97c') AND crm_status != 'qc_unassigned') OR enterprise_id NOT IN ('1ff0e3f32','68d42e97c'))
)
SELECT count() AS total_pending
FROM filtered_ai_sku AS t1
LEFT JOIN (SELECT enterprise_id, quality_check, is_active, is_test_account, category
           FROM eventila.enterprise_details WHERE stage IN ('Live','Onboarding')) AS t3 ON t1.enterprise_id = t3.enterprise_id
LEFT JOIN eventila.enterprise_account AS t4 ON t1.enterprise_id = t4.enterprise_id
WHERE (coalesce(t3.quality_check, t4.quality_check) = 1)
  AND (coalesce(t3.is_active, t4.is_active) = 1)
  AND t3.is_test_account = 0
  AND (coalesce(t3.category, t4.category) IN ('Automobile','Automobiles','Cars'))
  AND t1.enterprise_id NOT IN ('TaD1VC1Ko','28733e36c')
  AND (t1.source IS NOT NULL)`;

// ── Video pendency (> 6 hrs, Live/Onboarding) ────────────────────────────────
const VIDEO_SQL = `
SELECT COUNT(video_id) AS total_pending
FROM video.video v
INNER JOIN eventila.enterprise_details ed ON ed.enterprise_id = v.enterprise_id
WHERE v.crm_status NOT IN ('qc_done','qc_yet_to_start')
  AND lower(ed.enterprise_id) != 'tad1vc1ko'
  AND lower(ed.stage) IN ('live','onboarding')
  AND v.status IN ('done','failed')
  AND v.is_deleted = 0
  AND v.enterprise_id NOT IN ('ca3c8e6e7','858b283d5','d414b35ff','ae0a68ccf','de4aca97f','bbba66bd5')
  AND dateDiff('hour', v.created_on, now()) > 6`;

// ── 360-spin pendency (> 6 hrs) — total pending SKUs across live/onboarding ───
const THREESIXTY_SQL = `
WITH base_skus AS (
  SELECT s.enterprise_id AS eid, s.sku_id AS sku
  FROM \`360_spin\`.\`360_spin\` s
  INNER JOIN eventila.ai_sku a ON s.sku_id = a.sku_id
  WHERE s.is_hidden = '0' AND lower(s.status) IN ('failed','done') AND s.crm_status = 'qc_unassigned'
    AND a.created_on >= toDateTime('2025-09-01 00:00:00') AND dateDiff('hour', a.created_on, now()) > 6
)
SELECT uniqExact(b.sku) AS total_pending
FROM base_skus b
INNER JOIN (SELECT enterprise_id, is_test_account FROM eventila.enterprise_details WHERE stage IN ('Onboarding','Live')) ed
  ON b.eid = ed.enterprise_id
WHERE ed.is_test_account = 0`;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!CH_URL || !CH_USER || !CH_PASSWORD) {
    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      imagePendency: null, videoPendency: null, threeSixtyPendency: null,
      note: 'CLICKHOUSE_URL / CLICKHOUSE_USER / CLICKHOUSE_PASSWORD not set in APP_SECRETS.',
    });
  }
  const [imagePendency, videoPendency, threeSixtyPendency] = await Promise.all([
    scalar(IMAGE_SQL).catch(() => null),
    scalar(VIDEO_SQL).catch(() => null),
    scalar(THREESIXTY_SQL).catch(() => null),
  ]);
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
  return res.status(200).json({
    generatedAt: new Date().toISOString(),
    source: 'clickhouse',
    imagePendency, videoPendency, threeSixtyPendency,
  });
};
