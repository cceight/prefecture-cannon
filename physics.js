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

  // ===== 地球モード =====
  // 重力の強さ(1コマあたりの加速)は通常モードと同じ。これを地表の 9.80665 m/s² とみなすと、
  // 画面の1コマ(1/60秒)は現実の約7.5秒、つまり画面は約452倍速のタイムラプスになる
  const EARTH_R_KM = 6371;
  const EARTH_R = EARTH_R_KM / KM_PER_UNIT;                 // 地球の半径(物理単位)
  const G_STEP = GRAVITY_SCALE * (1000 / 60) ** 2;          // 地表の重力加速度(物理単位/コマ²)
  const REAL_SEC_PER_STEP = Math.sqrt(G_STEP * KM_PER_UNIT * 1000 / 9.80665); // 1コマ = 現実の何秒か
  const TIME_LAPSE = REAL_SEC_PER_STEP * 60;                 // 画面の1秒 = 現実の何秒か
  const GM = G_STEP * EARTH_R * EARTH_R;                     // 重力定数×地球の質量(物理単位)
  const E_EARTH = 800;            // 地球モードのパワー100%時の火薬(全県共通。北海道の倍率は通常モードと同じ)
  const ATM_RHO0 = 1.225;         // 地表の空気の密度(kg/m³)
  const ATM_H = 8.5;              // 大気の厚みの目安(スケールハイト、km)
  const CRUST_THICK = 1000;       // 空気抵抗の計算に使う、県の厚み(m)
  const CRUST_RHO = 2700;         // 空気抵抗の計算に使う、県の密度(kg/m³、花崗岩くらい)
  const DRAG_CD = 1;              // 抗力係数
  const ESCAPE_CHECK_R = 3;       // 地球の半径の何倍まで離れたら、脱出の判定をするか
  const EARTH_BOUNCE = 0.05;      // 地球モードの反発係数(秒速数kmの激突なので、ほとんど弾まない)
  const HILL_LIMIT_R = 60;        // 遠地点がこれより遠い(月の軌道くらい)なら、重力圏を離れたとみなす

  function createGame(Matter, pref, opts = {}) {
    const { Engine, Bodies, Body, Composite } = Matter;
    const earth = opts.mode === 'earth';
    const engine = Engine.create();
    engine.gravity.scale = earth ? 0 : GRAVITY_SCALE;
    const C = { x: 0, y: GROUND_Y + EARTH_R };   // 地球の中心(地球モード)

    const statics = [];
    const segs = []; const SEG_N = Math.ceil(2 * Math.PI * EARTH_R / 10);
    if (earth) {
      // 地面: 地球の円周を、上面が円弧に沿った台形のブロックで囲む
      // (全部を物理に入れると重いので、県の近くにあるブロックだけをその都度参加させる)
      const N = SEG_N, T = 200;
      for (let i = 0; i < N; i++) {
        const a0 = (i / N) * 2 * Math.PI, a1 = ((i + 1) / N) * 2 * Math.PI;
        const pt = (a, r) => ({ x: C.x + Math.sin(a) * r, y: C.y - Math.cos(a) * r });
        const v = [pt(a0, EARTH_R), pt(a1, EARTH_R), pt(a1, EARTH_R - T), pt(a0, EARTH_R - T)];
        const cx = (v[0].x + v[1].x + v[2].x + v[3].x) / 4, cy = (v[0].y + v[1].y + v[2].y + v[3].y) / 4;
        segs.push(Bodies.fromVertices(cx, cy, [v], { isStatic: true, friction: 0.9, restitution: EARTH_BOUNCE, label: 'ground' }));
      }
    } else {
      statics.push(Bodies.rectangle(0, GROUND_Y + 5000, 4e6, 10000, {
        isStatic: true, friction: 0.9, restitution: 0.2, label: 'ground'
      }));
      // はるか後方の壁(後ろへ転がり続けるのを止める)
      statics.push(Bodies.rectangle(-30000, GROUND_Y - 50000, 1000, 100000, { isStatic: true }));
    }

    // 撃ち出すもの: 普通の県は1つ、真・○○県は島ごとに1つずつ
    const islands = pref.islands || [pref];
    const density = DENSITY * Math.pow(pref.area / REF_AREA, MASS_EXP - 1);
    const makeParts = isl => {
      const parts = isl.parts.map(pts =>
        Bodies.fromVertices(0, 0, [pts.map(([x, y]) => ({ x: x / KM_PER_UNIT, y: y / KM_PER_UNIT }))], {
          density, friction: 0.9, restitution: earth ? EARTH_BOUNCE : 0.5
        }));
      // 各パーツの位置は、元の座標どおりに置き直す
      isl.parts.forEach((pts, i) => {
        let cx = 0, cy = 0, A = 0;
        for (let k = 0; k < pts.length; k++) {
          const a = pts[k], b = pts[(k + 1) % pts.length], cr = a[0] * b[1] - b[0] * a[1];
          A += cr; cx += (a[0] + b[0]) * cr; cy += (a[1] + b[1]) * cr;
        }
        A /= 2; Body.setPosition(parts[i], { x: cx / (6 * A) / KM_PER_UNIT, y: cy / (6 * A) / KM_PER_UNIT });
      });
      return parts;
    };
    const islandUnits = islands.map((isl, idx) => {
      const body = Body.create({ parts: makeParts(isl), friction: 0.9, restitution: earth ? EARTH_BOUNCE : 0.5, frictionAir: 0 });
      // 重心を県庁所在地に移す(回転の中心もここになる)。慣性モーメントは平行軸の定理で補正
      if (!pref.islands && pref.cap) {
        const cap = { x: pref.cap[0] / KM_PER_UNIT, y: pref.cap[1] / KM_PER_UNIT };
        const d2 = (cap.x - body.position.x) ** 2 + (cap.y - body.position.y) ** 2;
        Body.setCentre(body, cap, false);
        Body.setInertia(body, body.inertia + body.mass * d2);
      }
      return {
        body, idx,
        name: isl.name || pref.name,
        area: isl.area || pref.area,
        outline: isl.outline, holes: isl.holes, off: isl.off || [0, 0],
        // 回転の中心が、形データの原点からどれだけズレているか(描画用)
        com: { x: body.position.x, y: body.position.y },
        eqWidth: 2 * Math.sqrt((isl.area || pref.area) / Math.PI) / KM_PER_UNIT, // 同じ面積の円の幅
        still: 0, touched: false, touchStep: 0, status: 'flying', phi: 0, phiRaw: 0,
      };
    });
    // 真・○○県: 着地するまでは全部の島を1つの塊として飛ばし、最初に地面に触れた瞬間に島ごとに分解する
    let group = null;
    if (pref.islands) {
      const gb = Body.create({ parts: islands.flatMap(makeParts), friction: 0.9, restitution: earth ? EARTH_BOUNCE : 0.5, frictionAir: 0 });
      group = {
        body: gb, idx: 0, isGroup: true, name: pref.name, area: pref.area,
        rings: islands.map(i => i.outline), off: [0, 0],
        com: { x: gb.position.x, y: gb.position.y },
        eqWidth: 2 * Math.sqrt(pref.area / Math.PI) / KM_PER_UNIT,
        still: 0, touched: false, touchStep: 0, status: 'flying', phi: 0, phiRaw: 0,
      };
      // 分解するときに使う、塊の重心から見た各島の位置(傾ける前)
      islandUnits.forEach(u => { u.local = { x: u.body.position.x - gb.position.x, y: u.body.position.y - gb.position.y }; });
      // 描画用: 塊の中の各島の位置と大きさ
      group.subs = islandUnits.map(u => ({ local: u.local, r: radiusOf(u.body) }));
    }
    let units = group ? [group] : islandUnits;
    let main = units[0];
    let body = main.body;
    const totalMass = units.reduce((s, u) => s + u.body.mass, 0);
    // 発射台の基準点(普通の県は県庁所在地、真・○○県は県庁所在地のある座標の原点)
    const pivot = pref.islands ? { x: 0, y: 0 } : { x: body.position.x, y: body.position.y };
    units.forEach(u => { u.offset = { x: u.body.position.x - pivot.x, y: u.body.position.y - pivot.y }; });
    const size = radiusOf(islandUnits[0].body);    // 傾ける前の大きさ(大砲の大きさに使う)

    // 発射位置: 最下点が地面から少し上になる高さ
    const maxY = Math.max(...units.map(u => u.body.bounds.max.y));
    const startX = 0;
    const startY = GROUND_Y - (maxY - pivot.y) - size * 0.3 - 5;
    if (!pref.islands) Body.setPosition(body, { x: startX, y: startY });
    else units.forEach(u => Body.setPosition(u.body, { x: startX + u.offset.x, y: startY + u.offset.y }));
    Composite.add(engine.world, [...statics, ...units.map(u => u.body)]);

    const state = {
      engine, body, units, mode: earth ? 'earth' : 'flat', C, R: EARTH_R,
      com: main.com, size, startX, startY, path1s: 0, launched: false, settled: false, steps: 0, still: 0, maxX: 0, peakY: 0,
    };

    // 地面からの高さ(一番低い頂点。地球モードは地球の中心からの距離で測る)
    function clearance(b) {
      if (!earth) return GROUND_Y - b.bounds.max.y;
      const dx = b.position.x - C.x, dy = b.position.y - C.y;
      const far = Math.hypot(dx, dy) - EARTH_R - radiusOf(b) * 1.5;
      if (far > 1) return far;
      let m = Infinity;
      for (let i = 1; i < b.parts.length; i++) for (const q of b.parts[i].vertices) m = Math.min(m, Math.hypot(q.x - C.x, q.y - C.y) - EARTH_R);
      return m;
    }
    state.clearance = clearance;

    // 地球モード: 県の近くの地面ブロックだけを物理に参加させる
    const activeSeg = new Set();
    function updateGround() {
      if (!earth) return;
      const need = new Set();
      for (const u of units) {
        const b = u.body, r = Math.hypot(b.position.x - C.x, b.position.y - C.y);
        const reach = radiusOf(b) * 1.5 + Body.getSpeed(b) * 1.5 + 20;
        if (r - EARTH_R > reach) continue;
        const center = Math.atan2(b.position.x - C.x, C.y - b.position.y);
        const half = reach / EARTH_R;
        const i0 = Math.floor((center - half) / (2 * Math.PI) * SEG_N), i1 = Math.ceil((center + half) / (2 * Math.PI) * SEG_N);
        for (let i = i0; i <= i1; i++) need.add(((i % SEG_N) + SEG_N) % SEG_N);
      }
      for (const i of activeSeg) if (!need.has(i)) { Composite.remove(engine.world, segs[i]); activeSeg.delete(i); }
      for (const i of need) if (!activeSeg.has(i)) { Composite.add(engine.world, segs[i]); activeSeg.add(i); }
    }
    updateGround();

    // 狙い: 発射角と同じだけ県を傾ける(0°で本来の向き)。地面にめり込むなら持ち上げる
    state.aim = function (angleDeg) {
      const a = -angleDeg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
      for (const u of units) {
        Body.setAngle(u.body, 0);
        Body.setPosition(u.body, { x: startX + u.offset.x, y: startY + u.offset.y });
        Body.setAngle(u.body, a);
        if (u.offset.x || u.offset.y) {
          Body.setPosition(u.body, { x: startX + u.offset.x * ca - u.offset.y * sa, y: startY + u.offset.x * sa + u.offset.y * ca });
        }
      }
      for (let k = 0; k < 3; k++) {
        const over = earth ? 5 - Math.min(...units.map(u => clearance(u.body)))
          : Math.max(...units.map(u => u.body.bounds.max.y)) - (GROUND_Y - 5);
        if (over <= 0) break;
        for (const u of units) Body.setPosition(u.body, { x: u.body.position.x, y: u.body.position.y - over });
        if (!earth) break;
      }
      for (const u of units) { Body.setVelocity(u.body, { x: 0, y: 0 }); Body.setAngularVelocity(u.body, 0); }
    };

    state.launch = function (angleDeg, powerPct) {
      state.aim(angleDeg);
      const E = (earth ? E_EARTH : E_MAX) * (CANNON_BOOST[pref.baseId || pref.id] || 1) * Math.max(0.02, powerPct / 100);
      const v = Math.sqrt(2 * E / totalMass);
      const th = angleDeg * Math.PI / 180;
      for (const u of units) {
        Body.setVelocity(u.body, { x: v * Math.cos(th), y: -v * Math.sin(th) });
        // 回転を付ける(島の塊は巨大で、少し回っただけで端が地面をこするので回さない)
        Body.setAngularVelocity(u.body, u.isGroup ? 0 : -0.004 * (0.5 + powerPct / 200));
        if (earth) { u.phiRaw = angleAround(u.body.position); u.phi = u.phiRaw; }
      }
      state.launched = true;
      state.v0 = v;
    };

    // 地球の中心から見た角度(発射地点の真上が0、進行方向がプラス)
    function angleAround(p) { return Math.atan2(p.x - C.x, C.y - p.y); }
    const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

    // 1回分の細かい計算(重力・空気抵抗 → 物理更新)。frac は1フレームに対する割合
    function subStep(dt, frac) {
      for (const u of units) {
        const b = u.body;
        if (earth) {
          // 重力: 地球の中心に向かって、距離の2乗に反比例
          const dx = C.x - b.position.x, dy = C.y - b.position.y, r = Math.hypot(dx, dy);
          const g = GRAVITY_SCALE * (EARTH_R / r) ** 2;
          b.force.x += b.mass * g * dx / r;
          b.force.y += b.mass * g * dy / r;
          // 空気抵抗: 本物の大気(上空ほど薄い)。県は厚さ1kmの岩の板として計算する
          const hKm = (r - EARTH_R) * KM_PER_UNIT;
          if (hKm < 300 && clearance(b) > 0.5) {
            const v = Body.getVelocity(b), sp = Math.hypot(v.x, v.y);
            if (sp > 0.01) {
              const nx = -v.y / sp, ny = v.x / sp;
              let lo = Infinity, hi = -Infinity;
              for (let i = 1; i < b.parts.length; i++) {
                for (const q of b.parts[i].vertices) { const d = q.x * nx + q.y * ny; if (d < lo) lo = d; if (d > hi) hi = d; }
              }
              const rho = ATM_RHO0 * Math.exp(-Math.max(0, hKm) / ATM_H);
              const areaM2 = (hi - lo) * KM_PER_UNIT * 1000 * CRUST_THICK;
              const massKg = u.area * 1e6 * CRUST_THICK * CRUST_RHO;
              const vReal = sp * KM_PER_UNIT * 1000 / REAL_SEC_PER_STEP;              // m/s
              const aReal = 0.5 * rho * DRAG_CD * areaM2 * vReal * vReal / massKg;    // m/s²
              const dv = aReal * REAL_SEC_PER_STEP * frac * REAL_SEC_PER_STEP / (KM_PER_UNIT * 1000); // 物理単位/コマ
              const k = Math.min(0.5, dv / sp);
              Body.setVelocity(b, { x: v.x * (1 - k), y: v.y * (1 - k) });
            }
          }
        } else if (b.bounds.max.y < GROUND_Y - 0.5) {
          // 空気抵抗: 重い県ほど減速しにくく、細長い県は回転の向きで受ける風が変わる
          const v = Body.getVelocity(b), sp = Math.hypot(v.x, v.y);
          if (sp > 0.01) {
            const nx = -v.y / sp, ny = v.x / sp;
            let lo = Infinity, hi = -Infinity;
            for (let i = 1; i < b.parts.length; i++) {
              for (const q of b.parts[i].vertices) { const d = q.x * nx + q.y * ny; if (d < lo) lo = d; if (d > hi) hi = d; }
            }
            const width = SHAPE_DRAG * (hi - lo) + (1 - SHAPE_DRAG) * u.eqWidth;
            const k = Math.min(0.5, AIR_DRAG * width * sp / b.mass * frac);
            Body.setVelocity(b, { x: v.x * (1 - k), y: v.y * (1 - k) });
          }
        }
      }
      Engine.update(engine, dt);
    }

    const maxSteps = earth ? 60 * 900 : 60 * 40;
    state.step = function (dt = 1000 / 60) {
      if (!state.launched || state.settled) return;
      // 速いときは1コマを細かく刻んで計算する(着地で地面に深くめり込むのを防ぐ)
      let fastest = 0;
      for (const u of units) fastest = Math.max(fastest, Body.getSpeed(u.body));
      const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(fastest / MAX_MOVE)));
      updateGround();
      const before = { x: body.position.x, y: body.position.y };
      for (let i = 0; i < n; i++) {
        // 塊が地面にぶつかる直前に分解する(ぶつかった衝撃で巨大な塊が急回転して、端の島が振り回されないように)
        if (group && units[0] === group) {
          // 次の細かい計算で地面に届きそうか(地面に向かう方向の速さで判定)
          const gb = group.body, v = Body.getVelocity(gb);
          let toward = v.y;
          if (earth) { const dx = gb.position.x - C.x, dy = gb.position.y - C.y, r = Math.hypot(dx, dy); toward = -(v.x * dx + v.y * dy) / r; }
          if (clearance(gb) < Math.max(0, toward) / n + 0.5) breakApart();
        }
        subStep(dt / n, 1 / n);
      }
      // 発射速度の計測(表示専用。物理には影響しない): 最初の1秒(60コマ)で進んだ道のり
      if (state.steps < 60) state.path1s += Math.hypot(body.position.x - before.x, body.position.y - before.y) * KM_PER_UNIT;
      state.steps++;
      let allDone = true;
      for (const u of units) {
        const b = u.body;
        // 接地中は地面の抵抗(転がり抵抗)をかける
        const onGround = earth ? clearance(b) < 0.5 : b.bounds.max.y > GROUND_Y - 0.5;
        if (onGround) {
          if (!u.touched) u.touchStep = state.steps;
          u.touched = true;
        }
        if (u.touched) {
          // 着地後は時間とともに抵抗を強めて、必ず止まるようにする
          const t = state.steps - u.touchStep;
          b.frictionAir = GROUND_DRAG * (1 + Math.max(0, t - 180) / 60);
        }
        if (earth) trackOrbit(u);
        const sp = Body.getSpeed(b), av = Math.abs(Body.getAngularVelocity(b));
        if (state.steps > 30 && sp < 0.03 && av < 0.0008) u.still++; else u.still = 0;
        if (u.status === 'flying' && (u.still > 40 || (u.touched && state.steps - u.touchStep > 900))) u.status = 'landed';
        if (u.status === 'flying') allDone = false;
      }
      state.touched = main.touched; state.touchStep = main.touchStep; state.still = main.still;
      state.peakY = Math.min(state.peakY, body.bounds.max.y);
      if (allDone || state.steps > maxSteps) {
        for (const u of units) if (u.status === 'flying') u.status = 'landed';
        state.settled = true;
      }
    };

    // 塊を島ごとに分解する。各島は、その瞬間の塊の位置・向き・速さ・回転をそのまま引き継ぐ
    function breakApart() {
      const g = group.body, th = g.angle, c = Math.cos(th), s = Math.sin(th);
      const v = Body.getVelocity(g), w = Body.getAngularVelocity(g);
      Composite.remove(engine.world, g);
      for (const u of islandUnits) {
        const d = { x: u.local.x * c - u.local.y * s, y: u.local.x * s + u.local.y * c };
        Body.setPosition(u.body, { x: g.position.x + d.x, y: g.position.y + d.y });
        Body.setAngle(u.body, th);
        // 地面にめり込んだまま切り離すと、押し戻されて弾け飛ぶので、地表まで持ち上げておく
        const sink = 0.2 - clearance(u.body);
        if (sink > 0) {
          let nx = 0, ny = -1;
          if (earth) { const dx = u.body.position.x - C.x, dy = u.body.position.y - C.y, r = Math.hypot(dx, dy); nx = dx / r; ny = dy / r; }
          Body.setPosition(u.body, { x: u.body.position.x + nx * sink, y: u.body.position.y + ny * sink });
        }
        Body.setVelocity(u.body, { x: v.x - w * d.y, y: v.y + w * d.x });
        Body.setAngularVelocity(u.body, w);
        if (earth) { u.phiRaw = angleAround(u.body.position); u.phi = group.phi + wrap(u.phiRaw - group.phiRaw); }
        Composite.add(engine.world, u.body);
      }
      units = islandUnits; state.units = units;
      main = units[0]; body = main.body; state.body = body;
      state.brokeStep = state.steps + 1;
    }

    // 地球モード: 地球をまわった角度を数えて、1周したら衛星、重力を振り切ったら脱出
    function trackOrbit(u) {
      const b = u.body;
      const raw = angleAround(b.position);
      u.phi += wrap(raw - u.phiRaw); u.phiRaw = raw;
      if (u.status !== 'flying') return;
      // 一度も地面に触れずに地球を1周したら衛星
      if (!u.touched && u.phi >= 2 * Math.PI) { u.status = 'satellite'; return; }
      const dx = b.position.x - C.x, dy = b.position.y - C.y, r = Math.hypot(dx, dy);
      if (r > EARTH_R * ESCAPE_CHECK_R) {
        const v = Body.getVelocity(b);
        const energy = (v.x * v.x + v.y * v.y) / 2 - GM / r;
        let far = energy >= 0;
        if (!far) {
          const a = -GM / (2 * energy), h = dx * v.y - dy * v.x;
          const e = Math.sqrt(Math.max(0, 1 + 2 * energy * h * h / (GM * GM)));
          far = a * (1 + e) > EARTH_R * HILL_LIMIT_R;
        }
        if (far) u.status = 'escaped';
      }
    }

    // 地球モード: 地面に沿って測った距離(km)。県の一番前の端まで
    function arcFrontKm(u) {
      const b = u.body;
      let m = -Infinity;
      for (let i = 1; i < b.parts.length; i++) for (const q of b.parts[i].vertices) {
        m = Math.max(m, u.phi + wrap(angleAround(q) - u.phiRaw));
      }
      return m * EARTH_R * KM_PER_UNIT;
    }
    const frontKm = u => earth ? arcFrontKm(u) : (u.body.bounds.max.x - startX) * KM_PER_UNIT;

    // 先頭(一番遠くまで行った島)。地球モードでは宇宙へ行った島は除く
    state.lead = function () {
      let best = main, bd = -Infinity;
      for (const u of units) {
        if (earth && (u.status === 'escaped' || u.status === 'satellite') && u !== main) continue;
        const d = earth ? u.phi : u.body.bounds.max.x;
        if (d > bd) { bd = d; best = u; }
      }
      return best;
    };
    // 記録になる島(地面に落ちた中で一番遠い島)
    state.recordUnit = function () {
      let best = null, bd = -Infinity;
      for (const u of units) {
        if (earth && u.status !== 'landed') continue;
        const d = frontKm(u);
        if (d > bd) { bd = d; best = u; }
      }
      return best;
    };
    // 結果(地球モード): 本体(一番大きい島)の行き先
    state.outcome = () => earth ? main.status : 'landed';

    // 発射速度(km/s): 最初の1秒間の平均の速さ。1秒未満で止まったら、止まるまでの平均
    state.launchSpeed = () => state.path1s / (Math.max(1, Math.min(60, state.steps)) / 60);
    // 地球モードの初速(現実の km/s)
    state.realSpeedKmS = v => v * KM_PER_UNIT / REAL_SEC_PER_STEP;
    // 地球モードの経過時間(現実の秒)
    state.realElapsedSec = () => state.steps * REAL_SEC_PER_STEP;
    state.altitudeKm = u => earth ? (Math.hypot(u.body.position.x - C.x, u.body.position.y - C.y) - EARTH_R) * KM_PER_UNIT
      : Math.max(0, (GROUND_Y - u.body.bounds.max.y) * KM_PER_UNIT);

    // 記録は、発射位置から県の一番前の端まで(大きい県ほど有利)
    state.rawDistanceKm = () => {
      const u = state.recordUnit();
      return u ? frontKm(u) : 0;
    };
    state.distanceKm = () => Math.max(0, state.rawDistanceKm());
    state.heightKm = () => Math.max(0, (GROUND_Y - body.bounds.max.y) * KM_PER_UNIT);
    return state;
  }

  function radiusOf(body) {
    const b = body.bounds; return Math.max(b.max.x - b.min.x, b.max.y - b.min.y) / 2;
  }

  const api = { CANNON_BOOST, createGame, KM_PER_UNIT, GROUND_Y, radiusOf, EARTH_R, TIME_LAPSE, GM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PrefPhysics = api;
})(typeof window !== 'undefined' ? window : globalThis);
