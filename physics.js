// 都道府県キャノン 物理コア(ブラウザ・Node共通)
(function (root) {
  const KM_PER_UNIT = 2;          // 1物理単位 = 2km
  const DENSITY = 0.001;          // 基準の密度(大阪府の重さが基準)
  const REF_AREA = 1860;          // 基準の面積(km²、大阪府)
  const MASS_EXP = 0.5;           // 重さ ∝ 面積のこの乗数(0.5 = ルート。大きい県でも重くなりすぎない)
  const E_MAX = 16000;            // パワー100%時の火薬(全県共通)
  const CANNON_BOOST = { 1: 3.2 };// 県ごとの火薬の倍率(北海道は大きい大砲)
  const AIR_DRAG = 0.000008;      // 空気抵抗(風を受ける幅 × 速さ² ÷ 重さ で減速)
  const SHAPE_DRAG = 0.25;        // 風を受ける幅への形の影響(1 = 実際の幅、0 = 同じ面積の円の幅)
  const GRAVITY_SCALE = 0.001;
  const GROUND_Y = 0;
  const MAX_MOVE = 4;             // 1回の計算で動いてよい距離(物理単位)
  const MAX_SUBSTEPS = 16;        // 1コマを最大何分割するか
  const GROUND_DRAG = 0.004;      // 接地中の抵抗(転がり抵抗の代わり)

  function createGame(Matter, pref) {
    const { Engine, Bodies, Body, Composite } = Matter;
    const engine = Engine.create();
    engine.gravity.scale = GRAVITY_SCALE;

    const ground = Bodies.rectangle(0, GROUND_Y + 5000, 4e6, 10000, {
      isStatic: true, friction: 0.9, restitution: 0.2, label: 'ground'
    });
    // はるか後方の壁(後ろへ転がり続けるのを止める)
    const backWall = Bodies.rectangle(-30000, GROUND_Y - 50000, 1000, 100000, { isStatic: true });

    const parts = pref.parts.map(pts =>
      Bodies.fromVertices(0, 0, [pts.map(([x, y]) => ({ x: x / KM_PER_UNIT, y: y / KM_PER_UNIT }))], {
        density: DENSITY * Math.pow(pref.area / REF_AREA, MASS_EXP - 1), friction: 0.9, restitution: 0.5
      }));
    // 各パーツの位置は、元の座標どおりに置き直す
    pref.parts.forEach((pts, i) => {
      let cx = 0, cy = 0, A = 0;
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k], b = pts[(k + 1) % pts.length], cr = a[0] * b[1] - b[0] * a[1];
        A += cr; cx += (a[0] + b[0]) * cr; cy += (a[1] + b[1]) * cr;
      }
      A /= 2; Body.setPosition(parts[i], { x: cx / (6 * A) / KM_PER_UNIT, y: cy / (6 * A) / KM_PER_UNIT });
    });
    const body = Body.create({ parts, friction: 0.9, restitution: 0.5, frictionAir: 0 });

    // 重心を県庁所在地に移す(回転の中心もここになる)。慣性モーメントは平行軸の定理で補正
    if (pref.cap) {
      const cap = { x: pref.cap[0] / KM_PER_UNIT, y: pref.cap[1] / KM_PER_UNIT };
      const d2 = (cap.x - body.position.x) ** 2 + (cap.y - body.position.y) ** 2;
      Body.setCentre(body, cap, false);
      Body.setInertia(body, body.inertia + body.mass * d2);
    }
    // 回転の中心(県庁所在地)が、形データの原点からどれだけズレているか(描画用)
    const com = { x: body.position.x, y: body.position.y };
    const size = radiusOf(body);    // 傾ける前の大きさ(大砲の大きさに使う)
    const eqWidth = 2 * Math.sqrt(pref.area / Math.PI) / KM_PER_UNIT; // 同じ面積の円の幅
    // 発射位置: 最下点が地面から少し上になる高さ
    const b0 = body.bounds;
    const startX = 0;
    const startY = GROUND_Y - (b0.max.y - body.position.y) - radiusOf(body) * 0.3 - 5;
    Body.setPosition(body, { x: startX, y: startY });
    Composite.add(engine.world, [ground, backWall, body]);

    const state = { engine, body, com, size, startX, startY, launched: false, settled: false, steps: 0, still: 0, maxX: 0, peakY: 0 };

    // 狙い: 発射角と同じだけ県を傾ける(0°で本来の向き)。地面にめり込むなら持ち上げる
    state.aim = function (angleDeg) {
      Body.setAngle(body, 0);
      Body.setPosition(body, { x: startX, y: startY });
      Body.setAngle(body, -angleDeg * Math.PI / 180);
      const over = body.bounds.max.y - (GROUND_Y - 5);
      if (over > 0) Body.setPosition(body, { x: startX, y: startY - over });
      Body.setVelocity(body, { x: 0, y: 0 });
      Body.setAngularVelocity(body, 0);
    };

    state.launch = function (angleDeg, powerPct) {
      state.aim(angleDeg);
      const E = E_MAX * (CANNON_BOOST[pref.id] || 1) * Math.max(0.02, powerPct / 100);
      const v = Math.sqrt(2 * E / body.mass);
      const th = angleDeg * Math.PI / 180;
      Body.setVelocity(body, { x: v * Math.cos(th), y: -v * Math.sin(th) });
      Body.setAngularVelocity(body, -0.004 * (0.5 + powerPct / 200));
      state.launched = true;
      state.v0 = v;
    };

    // 1回分の細かい計算(空気抵抗 → 物理更新)。frac は1フレームに対する割合
    function subStep(dt, frac) {
      // 空気抵抗: 重い県ほど減速しにくく、細長い県は回転の向きで受ける風が変わる
      if (body.bounds.max.y < GROUND_Y - 0.5) {
        const v = Body.getVelocity(body), sp = Math.hypot(v.x, v.y);
        if (sp > 0.01) {
          const nx = -v.y / sp, ny = v.x / sp;
          let lo = Infinity, hi = -Infinity;
          for (let i = 1; i < body.parts.length; i++) {
            for (const q of body.parts[i].vertices) { const d = q.x * nx + q.y * ny; if (d < lo) lo = d; if (d > hi) hi = d; }
          }
          const width = SHAPE_DRAG * (hi - lo) + (1 - SHAPE_DRAG) * eqWidth;
          const k = Math.min(0.5, AIR_DRAG * width * sp / body.mass * frac);
          Body.setVelocity(body, { x: v.x * (1 - k), y: v.y * (1 - k) });
        }
      }
      Engine.update(engine, dt);
    }

    state.step = function (dt = 1000 / 60) {
      if (!state.launched || state.settled) return;
      // 速いときは1コマを細かく刻んで計算する(着地で地面に深くめり込むのを防ぐ)
      const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(Body.getSpeed(body) / MAX_MOVE)));
      for (let i = 0; i < n; i++) subStep(dt / n, 1 / n);
      state.steps++;
      // 接地中は地面の抵抗(転がり抵抗)をかける
      if (body.bounds.max.y > GROUND_Y - 0.5) {
        if (!state.touched) state.touchStep = state.steps;
        state.touched = true;
      }
      if (state.touched) {
        // 着地後は時間とともに抵抗を強めて、必ず止まるようにする
        const t = state.steps - state.touchStep;
        body.frictionAir = GROUND_DRAG * (1 + Math.max(0, t - 180) / 60);
      }
      const sp = Body.getSpeed(body), av = Math.abs(Body.getAngularVelocity(body));
      state.peakY = Math.min(state.peakY, body.bounds.max.y);
      if (state.steps > 30 && sp < 0.03 && av < 0.0008) state.still++; else state.still = 0;
      if (state.still > 40 || (state.touched && state.steps - state.touchStep > 900) || state.steps > 60 * 40) state.settled = true;
    };

    // 記録は、発射位置から県の一番前の端まで(大きい県ほど有利)
    state.rawDistanceKm = () => (body.bounds.max.x - startX) * KM_PER_UNIT;
    state.distanceKm = () => Math.max(0, state.rawDistanceKm());
    state.heightKm = () => Math.max(0, (GROUND_Y - body.bounds.max.y) * KM_PER_UNIT);
    return state;
  }

  function radiusOf(body) {
    const b = body.bounds; return Math.max(b.max.x - b.min.x, b.max.y - b.min.y) / 2;
  }

  const api = { CANNON_BOOST, createGame, KM_PER_UNIT, GROUND_Y, radiusOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PrefPhysics = api;
})(typeof window !== 'undefined' ? window : globalThis);
