/**
 * Vercel Serverless Function — /api/delivery
 *
 * Delivery · Operations pendency metrics. Sourced from Metabase PUBLIC questions
 * (shared read-only links) — no API key required, so these keep working even if
 * METABASE_API_KEY expires. Split into its own endpoint so the frontend can fill
 * the Delivery tiles in parallel with the main /api/metrics load.
 *
 * Public questions (override the UUIDs via env if the links are ever re-shared):
 *   Image pendency → total_pendency_count (scalar)
 *   Video pendency → COUNT(video_id)      (scalar)
 *   360   pendency → SUM(Pending)          (per-enterprise rows)
 *
 * Each metric returns null if the link fails — the dashboard keeps "—".
 */

const MB_BASE = (process.env.METABASE_BASE_URL || 'https://metabase.spyne.ai').replace(/\/$/, '');

// Metabase public question UUIDs (from the shared /public/question/<uuid> links).
const IMAGE_PUBLIC_UUID = process.env.METABASE_IMAGE_PUBLIC_UUID || '46a291e5-09b9-4603-9d96-898db60100c8';
const VIDEO_PUBLIC_UUID = process.env.METABASE_VIDEO_PUBLIC_UUID || '58440586-6c7a-464e-9a17-b0c75ad2b60b';
const THREESIXTY_PUBLIC_UUID = process.env.METABASE_360_PUBLIC_UUID || 'a8a676db-6019-4f99-b129-5cecde4317fd';

// Fetch a public card's result rows (array of {column: value} objects). No auth.
async function publicCardRows(uuid) {
  if (!MB_BASE || !uuid) return null;
  const res = await fetch(`${MB_BASE}/api/public/card/${uuid}/query/json`);
  if (!res.ok) throw new Error(`metabase public card ${uuid} -> HTTP ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : null;
}
// First numeric cell of the first row (single-value cards: image, video).
async function publicScalar(uuid) {
  const rows = await publicCardRows(uuid);
  if (!rows || !rows.length) return null;
  const v = Number(Object.values(rows[0])[0]);
  return isNaN(v) ? null : v;
}
// Sum a numeric column across all rows (360 per-enterprise breakdown).
async function publicColumnSum(uuid, col) {
  const rows = await publicCardRows(uuid);
  if (!rows || !rows.length) return null;
  return rows.reduce((s, r) => s + (Number(r[col]) || 0), 0);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const [imagePendency, videoPendency, threeSixtyPendency] = await Promise.all([
      publicScalar(IMAGE_PUBLIC_UUID).catch(() => null),                    // total_pendency_count
      publicScalar(VIDEO_PUBLIC_UUID).catch(() => null),                    // COUNT(video_id)
      publicColumnSum(THREESIXTY_PUBLIC_UUID, 'Pending').catch(() => null), // SUM(Pending)
    ]);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      imagePendency,       // null if the public link is unreachable
      videoPendency,
      threeSixtyPendency,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
