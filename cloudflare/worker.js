// 都道府県キャノン ランキング API(Cloudflare Workers + D1)
// D1 データベースを「DB」という名前で紐づけて使う
//
//   GET  /ranking?pref=all   全体ランキング(上位20件)
//   GET  /ranking?pref=27    県別ランキング(上位10件)
//   POST /scores             記録を登録 { name, prefId, distance, angle, power }
//                            → { overallRank, prefRank }

const VALID_PREFS = new Set([...Array.from({ length: 47 }, (_, i) => i + 1), 142, 147]);
const OVERALL_LIMIT = 20;
const PREF_LIMIT = 10;
const NAME_MAX = 12;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });
}

async function getRanking(env, url) {
  const pref = url.searchParams.get('pref') || 'all';
  let rows;
  if (pref === 'all') {
    rows = await env.DB.prepare(
      'SELECT name, pref_id AS prefId, distance, angle, power, created_at AS createdAt FROM scores ORDER BY distance DESC, id ASC LIMIT ?'
    ).bind(OVERALL_LIMIT).all();
  } else {
    const prefId = Number(pref);
    if (!VALID_PREFS.has(prefId)) return json({ error: '県の指定が正しくありません' }, 400);
    rows = await env.DB.prepare(
      'SELECT name, pref_id AS prefId, distance, angle, power, created_at AS createdAt FROM scores WHERE pref_id = ? ORDER BY distance DESC, id ASC LIMIT ?'
    ).bind(prefId, PREF_LIMIT).all();
  }
  return json({ pref, entries: rows.results || [] });
}

async function postScore(env, request) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '送られてきたデータを読めませんでした' }, 400); }

  const name = String(body.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX);
  const prefId = Number(body.prefId);
  const distance = Number(body.distance);
  const angle = Number.isFinite(Number(body.angle)) ? Math.round(Number(body.angle)) : null;
  const power = Number.isFinite(Number(body.power)) ? Math.round(Number(body.power)) : null;

  if (!name) return json({ error: '名前を入れてください' }, 400);
  if (!VALID_PREFS.has(prefId)) return json({ error: '県の指定が正しくありません' }, 400);
  if (!Number.isFinite(distance) || distance <= 0) return json({ error: '飛距離が正しくありません' }, 400);

  const d = Math.round(distance * 10) / 10;
  await env.DB.prepare('INSERT INTO scores (name, pref_id, distance, angle, power) VALUES (?, ?, ?, ?, ?)')
    .bind(name, prefId, d, angle, power).run();

  // 順位: 自分より遠い記録の数 + 1(同じ距離なら先に登録した人が上)
  const overall = await env.DB.prepare('SELECT COUNT(*) AS n FROM scores WHERE distance > ?').bind(d).first();
  const inPref = await env.DB.prepare('SELECT COUNT(*) AS n FROM scores WHERE pref_id = ? AND distance > ?').bind(prefId, d).first();
  return json({ overallRank: (overall?.n ?? 0) + 1, prefRank: (inPref?.n ?? 0) + 1, distance: d });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (request.method === 'GET' && url.pathname === '/ranking') return await getRanking(env, url);
      if (request.method === 'POST' && url.pathname === '/scores') return await postScore(env, request);
      if (request.method === 'GET' && url.pathname === '/') return json({ ok: true, service: 'prefecture-cannon-ranking' });
      return json({ error: 'ページが見つかりません' }, 404);
    } catch (e) {
      return json({ error: 'サーバーでエラーが起きました' }, 500);
    }
  },
};
