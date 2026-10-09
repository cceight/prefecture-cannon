-- 都道府県キャノン ランキング用のテーブル(Cloudflare D1)
CREATE TABLE IF NOT EXISTS scores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,              -- プレイヤー名(12文字まで)
  pref_id    INTEGER NOT NULL,              -- 県の番号(1〜47、真・長崎県=142、真・沖縄県=147)
  distance   REAL    NOT NULL,              -- 飛距離(km)
  angle      INTEGER,                       -- 角度(°)
  power      INTEGER,                       -- パワー(%)
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scores_distance ON scores (distance DESC);
CREATE INDEX IF NOT EXISTS idx_scores_pref ON scores (pref_id, distance DESC);
