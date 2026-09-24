/** Clip a polygon ring to a tile core, retaining winding and a closed ring. */
export function clipTileRing(ring, box) {
  let points = ring.slice(0, -1);
  for (const [axis, edge, sign] of [
    [0, box.west, 1],
    [0, box.east, -1],
    [1, box.south, 1],
    [1, box.north, -1],
  ]) {
    const output = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[(i + points.length - 1) % points.length],
        b = points[i];
      const ai = (a[axis] - edge) * sign >= 0,
        bi = (b[axis] - edge) * sign >= 0;
      if (ai !== bi) {
        const t = (edge - a[axis]) / (b[axis] - a[axis]);
        const p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        p[axis] = edge;
        output.push(p);
      }
      if (bi) output.push(b);
    }
    points = output;
  }
  return points.length >= 3 ? [...points, points[0]] : [];
}

/** Return only real boundary segments, never the straight edges introduced by tile clipping. */
export function militaryOutlineLines(ring, box) {
  const lines = [];
  let line = [];
  const epsilon = 1e-8;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1],
      b = ring[i];
    const seam = [
      [0, box.west],
      [0, box.east],
      [1, box.south],
      [1, box.north],
    ].some(
      ([axis, edge]) =>
        Math.abs(a[axis] - edge) < epsilon &&
        Math.abs(b[axis] - edge) < epsilon,
    );
    if (seam) {
      if (line.length > 1) lines.push(line);
      line = [];
    } else {
      if (!line.length) line.push(a);
      line.push(b);
    }
  }
  if (line.length > 1) lines.push(line);
  return lines;
}

function inside(point, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      hit = !hit;
  }
  return hit;
}
const inPolygon = (point, rings) =>
  inside(point, rings[0]) &&
  !rings.slice(1).some((ring) => inside(point, ring));
function bounds(ring) {
  const x = ring.map((p) => p[0]),
    y = ring.map((p) => p[1]);
  return {
    west: Math.min(...x),
    east: Math.max(...x),
    south: Math.min(...y),
    north: Math.max(...y),
  };
}
function overlaps(a, b, eps) {
  return (
    a.west <= b.east + eps &&
    b.west <= a.east + eps &&
    a.south <= b.north + eps &&
    b.south <= a.north + eps
  );
}
function distance2(p, a, b) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy) || 0,
    ),
  );
  return (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2;
}
function touches(a, b, epsilon) {
  if (!overlaps(a.bbox, b.bbox, epsilon)) return false;
  if (
    a.rings[0].some((p) => inPolygon(p, b.rings)) ||
    b.rings[0].some((p) => inPolygon(p, a.rings))
  )
    return true;
  const cross = (p, q, r) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  for (const ar of a.rings)
    for (const br of b.rings) {
      for (let i = 1; i < ar.length; i++)
        for (let j = 1; j < br.length; j++) {
          const p = ar[i - 1],
            q = ar[i],
            r = br[j - 1],
            s = br[j];
          if (
            cross(p, q, r) * cross(p, q, s) < 0 &&
            cross(r, s, p) * cross(r, s, q) < 0
          )
            return true;
          if (
            Math.min(
              distance2(p, r, s),
              distance2(q, r, s),
              distance2(r, p, q),
              distance2(s, p, q),
            ) <=
            epsilon ** 2
          )
            return true;
        }
    }
  return false;
}
function ringMoment(ring) {
  const [ox, oy] = ring[0];
  let sum = 0,
    x = 0,
    y = 0;
  for (let i = 1; i < ring.length; i++) {
    const a = [ring[i - 1][0] - ox, ring[i - 1][1] - oy],
      b = [ring[i][0] - ox, ring[i][1] - oy];
    const c = a[0] * b[1] - b[0] * a[1];
    sum += c;
    x += (a[0] + b[0]) * c;
    y += (a[1] + b[1]) * c;
  }
  return {
    area: Math.abs(sum / 2),
    point: sum ? [ox + x / (3 * sum), oy + y / (3 * sum)] : ring[0],
  };
}

/** Merge touching mapped parcels and tile fragments, preserving one session-stable installation id. */
export function mergeMilitaryFragments(records, aliases = new Map()) {
  const fragments = records
    .filter((r) => r.footprint?.length >= 4)
    .map((r) => ({
      ...r,
      rings: r.rings || [r.footprint],
      bbox: bounds(r.footprint),
    }));
  const parents = fragments.map((_, i) => i);
  const root = (i) => {
    while (parents[i] !== i) {
      parents[i] = parents[parents[i]];
      i = parents[i];
    }
    return i;
  };
  for (let i = 0; i < fragments.length; i++)
    for (let j = 0; j < i; j++) {
      if (root(i) === root(j)) continue;
      // One quantization cell accommodates the slightly different edge coordinates of adjacent tiles.
      const eps = Math.max(
        fragments[i].tileEpsilon || 1e-8,
        fragments[j].tileEpsilon || 1e-8,
      );
      const knownId = aliases.get(fragments[i].featureKey || fragments[i].id);
      if (
        (knownId &&
          knownId ===
            aliases.get(fragments[j].featureKey || fragments[j].id)) ||
        (fragments[i].featureKey &&
          fragments[i].featureKey === fragments[j].featureKey) ||
        touches(fragments[i], fragments[j], eps)
      )
        parents[root(i)] = root(j);
    }
  const groups = new Map();
  fragments.forEach((f, i) => {
    const key = root(i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  });
  const merged = [...groups.values()].map((group) => {
    const keys = [...new Set(group.map((r) => r.featureKey || r.id))].sort();
    const priorIds = new Set(
      keys.map((key) => aliases.get(key)).filter(Boolean),
    );
    const id = [...priorIds].sort()[0] || `ofm:installation:${keys[0]}`;
    // A bridge can join groups while some of their parcels are offscreen.
    // Keep those retained aliases canonical too, so a later pan cannot split the identity.
    if (priorIds.size > 1)
      for (const [key, prior] of aliases) {
        if (priorIds.has(prior)) aliases.set(key, id);
      }
    for (const key of keys) {
      aliases.delete(key);
      aliases.set(key, id);
    }
    let area = 0,
      x = 0,
      y = 0;
    for (const f of group)
      for (let i = 0; i < f.rings.length; i++) {
        const m = ringMoment(f.rings[i]),
          weight = m.area * (i ? -1 : 1);
        area += weight;
        x += m.point[0] * weight;
        y += m.point[1] * weight;
      }
    let point = area > 0 ? [x / area, y / area] : group[0].footprint[0];
    if (!group.some((f) => inPolygon(point, f.rings))) {
      // Find the nearest interior horizontal interval at a fragment's mid-latitude.
      const candidates = [];
      for (const f of group) {
        const lat = (f.bbox.south + f.bbox.north) / 2,
          hits = [];
        for (const ring of f.rings)
          for (let i = 1; i < ring.length; i++) {
            const a = ring[i - 1],
              b = ring[i];
            if (a[1] > lat !== b[1] > lat)
              hits.push(a[0] + ((lat - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
          }
        hits.sort((a, b) => a - b);
        for (let i = 1; i < hits.length; i++) {
          const p = [(hits[i - 1] + hits[i]) / 2, lat];
          if (inPolygon(p, f.rings)) candidates.push(p);
        }
      }
      candidates.sort(
        (a, b) =>
          Math.hypot(a[0] - point[0], a[1] - point[1]) -
          Math.hypot(b[0] - point[0], b[1] - point[1]),
      );
      point = candidates[0] || group[0].footprint[0];
    }
    return {
      ...group[0],
      id,
      longitude: point[0],
      latitude: point[1],
      footprints: group.map((f) => f.rings),
      outlineLines: group.flatMap((f) => f.outlineLines || [f.footprint]),
      sources: [
        ...new Map(
          group.flatMap((f) => f.sources).map((s) => [s.id, s]),
        ).values(),
      ],
    };
  });
  while (aliases.size > 4096) aliases.delete(aliases.keys().next().value);
  return [...merged, ...records.filter((r) => !r.footprint?.length)];
}
