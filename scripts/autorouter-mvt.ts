// Décodage minimal des tuiles vectorielles (MVT) autorouter, pour les tests en LOCAL (voir autorouter-tiles.ts).

export type Props = Record<string, string | number | boolean>;
export type Vertex = { lngLat: [number, number]; inside: boolean };

// ───────── Décodage MVT minimal ─────────

class Pbf {
  pos = 0;
  readonly buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }
  get done() {
    return this.pos >= this.buf.length;
  }
  varint(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = this.buf[this.pos++];
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  }
  /** Champ suivant : numéro, type de fil, et contenu (sous-tampon ou entier) */
  field(): { num: number; wire: number; bytes?: Uint8Array; value?: number } {
    const key = this.varint();
    const num = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) return { num, wire, value: this.varint() };
    if (wire === 2) {
      const len = this.varint();
      const bytes = this.buf.subarray(this.pos, (this.pos += len));
      return { num, wire, bytes };
    }
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos);
    if (wire === 5) {
      this.pos += 4;
      return { num, wire, value: view.getFloat32(0, true) };
    }
    this.pos += 8;
    return { num, wire, value: view.getFloat64(0, true) };
  }
  packed(): number[] {
    const out: number[] = [];
    while (!this.done) out.push(this.varint());
    return out;
  }
}

const text = new TextDecoder();
const zigzag = (n: number) => (n % 2 ? -(n + 1) / 2 : n / 2);

function decodeValue(bytes: Uint8Array): string | number | boolean {
  const { num, bytes: b, value } = new Pbf(bytes).field();
  if (num === 1) return text.decode(b);
  if (num === 7) return value === 1;
  if (num === 6) return zigzag(value!);
  return value!;
}

/** Entités linéaires d'une tuile : propriétés et sommets en [lon, lat], avec leur position dans la tuile */
export function decodeTile(buf: Uint8Array, z: number, x: number, y: number): { props: Props; lines: Vertex[][] }[] {
  const out: { props: Props; lines: Vertex[][] }[] = [];
  const tile = new Pbf(buf);
  while (!tile.done) {
    const layerField = tile.field();
    if (layerField.num !== 3) continue;
    const layer = new Pbf(layerField.bytes!);
    const keys: string[] = [];
    const values: (string | number | boolean)[] = [];
    const rawFeatures: Uint8Array[] = [];
    let extent = 4096;
    while (!layer.done) {
      const f = layer.field();
      if (f.num === 2) rawFeatures.push(f.bytes!);
      else if (f.num === 3) keys.push(text.decode(f.bytes));
      else if (f.num === 4) values.push(decodeValue(f.bytes!));
      else if (f.num === 5) extent = f.value!;
    }
    for (const raw of rawFeatures) {
      const feature = new Pbf(raw);
      let tags: number[] = [];
      let geometry: number[] = [];
      while (!feature.done) {
        const f = feature.field();
        if (f.num === 2) tags = new Pbf(f.bytes!).packed();
        else if (f.num === 4) geometry = new Pbf(f.bytes!).packed();
      }
      const props: Props = {};
      for (let i = 0; i < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];

      const toVertex = (gx: number, gy: number): Vertex => {
        const px = (x + gx / extent) / 2 ** z;
        const py = (y + gy / extent) / 2 ** z;
        const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * py))) * 180) / Math.PI;
        return { lngLat: [px * 360 - 180, lat], inside: gx > 0 && gx < extent && gy > 0 && gy < extent };
      };
      const lines: Vertex[][] = [];
      let gx = 0;
      let gy = 0;
      for (let i = 0; i < geometry.length; ) {
        const command = geometry[i] & 7;
        const count = geometry[i++] >> 3;
        if (command === 7) continue;
        if (command === 1) lines.push([]);
        for (let c = 0; c < count; c++) {
          gx += zigzag(geometry[i++]);
          gy += zigzag(geometry[i++]);
          lines.at(-1)!.push(toVertex(gx, gy));
        }
      }
      out.push({ props, lines });
    }
  }
  return out;
}

// ───────── Assemblage de tuiles (vues d'ensemble) ─────────

class Writer {
  private bytes: number[] = [];
  varint(n: number) {
    while (n >= 0x80) {
      this.bytes.push((n % 0x80) | 0x80);
      n = Math.floor(n / 0x80);
    }
    this.bytes.push(n);
    return this;
  }
  /** Champ de longueur variable (sous-message, texte, liste compacte) */
  message(num: number, bytes: Uint8Array | number[]) {
    this.varint(num * 8 + 2).varint(bytes.length);
    for (const b of bytes) this.bytes.push(b);
    return this;
  }
  uint(num: number, value: number) {
    return this.varint(num * 8).varint(value);
  }
  packed(num: number, values: number[]) {
    return this.message(num, new Writer().varints(values).finish());
  }
  private varints(values: number[]) {
    for (const v of values) this.varint(v);
    return this;
  }
  finish() {
    return Uint8Array.from(this.bytes);
  }
}

const unzigzag = (n: number) => (n < 0 ? -2 * n - 1 : 2 * n);
const encoder = new TextEncoder();

/** Côté de la grille d'éclaircissement des points d'une tuile assemblée : au plus un point par case */
const POINT_GRID = 64;

/**
 * Tuile de zoom z assemblée à partir de ses 4^k tuiles filles (zoom z + k), rangées ligne par ligne :
 * mêmes couches et propriétés, géométries ramenées à l'étendue de la tuile mère.
 * Les points sont éclaircis (trop nombreux pour MapLibre), en gardant d'abord ceux de `type` 0 (points en route).
 */
export function mergeChildTiles(children: Uint8Array[], k: number): Uint8Array {
  const n = 2 ** k;
  type Point = { bytes: Uint8Array; cell: number; primary: boolean };
  type Layer = { version: number; extent: number; keys: string[]; keyIndex: Map<string, number>; values: Uint8Array[]; valueIndex: Map<string, number>; features: Uint8Array[]; points: Point[] };
  const layers = new Map<string, Layer>();

  children.forEach((buf, i) => {
    const dx = i % n;
    const dy = Math.floor(i / n);
    const tile = new Pbf(buf);
    while (!tile.done) {
      const layerField = tile.field();
      if (layerField.num !== 3) continue;
      const pbf = new Pbf(layerField.bytes!);
      let name = '';
      let version = 2;
      let extent = 4096;
      const keys: string[] = [];
      const values: Uint8Array[] = [];
      const rawFeatures: Uint8Array[] = [];
      while (!pbf.done) {
        const f = pbf.field();
        if (f.num === 1) name = text.decode(f.bytes);
        else if (f.num === 2) rawFeatures.push(f.bytes!);
        else if (f.num === 3) keys.push(text.decode(f.bytes));
        else if (f.num === 4) values.push(f.bytes!);
        else if (f.num === 5) extent = f.value!;
        else if (f.num === 15) version = f.value!;
      }
      let layer = layers.get(name);
      if (!layer) layers.set(name, (layer = { version, extent, keys: [], keyIndex: new Map(), values: [], valueIndex: new Map(), features: [], points: [] }));
      const keyMap = keys.map((key) => {
        let idx = layer.keyIndex.get(key);
        if (idx === undefined) layer.keyIndex.set(key, (idx = layer.keys.push(key) - 1));
        return idx;
      });
      const valueMap = values.map((value) => {
        const id = value.join(',');
        let idx = layer.valueIndex.get(id);
        if (idx === undefined) layer.valueIndex.set(id, (idx = layer.values.push(value) - 1));
        return idx;
      });
      // Coordonnées de la fille → coordonnées de la mère (étendue de la mère)
      const scale = layer.extent / extent / n;
      const offX = (dx * layer.extent) / n;
      const offY = (dy * layer.extent) / n;

      const typeKey = keys.indexOf('type');

      for (const raw of rawFeatures) {
        const feature = new Pbf(raw);
        const out = new Writer();
        let geomType = 0;
        let primary = false;
        let first: [number, number] | undefined;
        while (!feature.done) {
          const f = feature.field();
          if (f.num === 1 || f.num === 3) out.uint(f.num, f.value!);
          if (f.num === 3) geomType = f.value!;
          else if (f.num === 2) {
            const tags = new Pbf(f.bytes!).packed();
            for (let j = 0; j < tags.length; j += 2) if (tags[j] === typeKey) primary = decodeValue(values[tags[j + 1]]) === 0;
            out.packed(2, tags.map((t, j) => (j % 2 ? valueMap[t] : keyMap[t])));
          } else if (f.num === 4) {
            const geometry = new Pbf(f.bytes!).packed();
            const encoded: number[] = [];
            let gx = 0;
            let gy = 0;
            let px = 0;
            let py = 0;
            for (let j = 0; j < geometry.length; ) {
              const command = geometry[j++];
              encoded.push(command);
              if ((command & 7) === 7) continue;
              for (let c = 0; c < command >> 3; c++) {
                gx += zigzag(geometry[j++]);
                gy += zigzag(geometry[j++]);
                first ??= [gx, gy];
                const x = Math.round(offX + gx * scale);
                const y = Math.round(offY + gy * scale);
                encoded.push(unzigzag(x - px), unzigzag(y - py));
                px = x;
                py = y;
              }
            }
            out.packed(4, encoded);
          }
        }
        if (geomType !== 1 || !first) {
          layer.features.push(out.finish());
          continue;
        }
        // Point de la marge de la fille : déjà présent dans sa voisine
        const [fx, fy] = first;
        if (fx < 0 || fy < 0 || fx >= extent || fy >= extent) continue;
        const cx = Math.floor(((dx + fx / extent) / n) * POINT_GRID);
        const cy = Math.floor(((dy + fy / extent) / n) * POINT_GRID);
        layer.points.push({ bytes: out.finish(), cell: cy * POINT_GRID + cx, primary });
      }
    }
  });

  const tile = new Writer();
  for (const [name, layer] of layers) {
    const out = new Writer().uint(15, layer.version).message(1, encoder.encode(name));
    for (const feature of layer.features) out.message(2, feature);
    const taken = new Set<number>();
    for (const point of [...layer.points.filter((p) => p.primary), ...layer.points.filter((p) => !p.primary)]) {
      if (taken.has(point.cell)) continue;
      taken.add(point.cell);
      out.message(2, point.bytes);
    }
    for (const key of layer.keys) out.message(3, encoder.encode(key));
    for (const value of layer.values) out.message(4, value);
    out.uint(5, layer.extent);
    tile.message(3, out.finish());
  }
  return tile.finish();
}

// ───────── Découpage au bord de la tuile ─────────

type Pt = [number, number];

/** Segment [a, b] découpé à la boîte (Liang-Barsky) ; null s'il est entièrement dehors */
function clipSegment(a: Pt, b: Pt, lo: number, hi: number): [Pt, Pt] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  for (const [p, q] of [
    [-dx, a[0] - lo],
    [dx, hi - a[0]],
    [-dy, a[1] - lo],
    [dy, hi - a[1]],
  ]) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return null;
    }
  }
  const at = (t: number): Pt => [Math.round(a[0] + t * dx), Math.round(a[1] + t * dy)];
  return [at(t0), at(t1)];
}

/** Ligne découpée à la boîte : un morceau par passage à l'intérieur */
function clipLine(line: Pt[], lo: number, hi: number): Pt[][] {
  const parts: Pt[][] = [];
  let current: Pt[] | null = null;
  for (let i = 1; i < line.length; i++) {
    const seg = clipSegment(line[i - 1], line[i], lo, hi);
    if (!seg) {
      current = null;
      continue;
    }
    const [s, e] = seg;
    const last = current?.at(-1);
    if (!current || !last || last[0] !== s[0] || last[1] !== s[1]) parts.push((current = [s]));
    current.push(e);
    // Sortie de la boîte : le morceau suivant repartira de son point d'entrée
    if (e[0] !== line[i][0] || e[1] !== line[i][1]) current = null;
  }
  return parts.filter((p) => p.length >= 2);
}

/** Anneau de polygone découpé à la boîte (Sutherland-Hodgman) */
function clipRing(ring: Pt[], lo: number, hi: number): Pt[] {
  let out = ring;
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= lo, (a, b) => [lo, Math.round(a[1] + ((lo - a[0]) * (b[1] - a[1])) / (b[0] - a[0]))]],
    [(p) => p[0] <= hi, (a, b) => [hi, Math.round(a[1] + ((hi - a[0]) * (b[1] - a[1])) / (b[0] - a[0]))]],
    [(p) => p[1] >= lo, (a, b) => [Math.round(a[0] + ((lo - a[1]) * (b[0] - a[0])) / (b[1] - a[1])), lo]],
    [(p) => p[1] <= hi, (a, b) => [Math.round(a[0] + ((hi - a[1]) * (b[0] - a[0])) / (b[1] - a[1])), hi]],
  ];
  for (const [inside, cross] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(cross(prev, cur));
        out.push(cur);
      } else if (inside(prev)) out.push(cross(prev, cur));
    }
    if (!out.length) break;
  }
  return out;
}

const signedArea = (ring: Pt[]) => ring.reduce((s, p, i) => s + (ring[(i + 1) % ring.length][0] - p[0]) * (ring[(i + 1) % ring.length][1] + p[1]), 0);

/** Géométrie MVT (commandes) → parties en coordonnées absolues */
function decodeGeometry(geometry: number[]): Pt[][] {
  const parts: Pt[][] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < geometry.length; ) {
    const command = geometry[i] & 7;
    const count = geometry[i++] >> 3;
    if (command === 7) continue;
    if (command === 1) parts.push([]);
    for (let c = 0; c < count; c++) {
      x += zigzag(geometry[i++]);
      y += zigzag(geometry[i++]);
      parts.at(-1)!.push([x, y]);
    }
  }
  return parts;
}

function encodeGeometry(parts: Pt[][], type: number): number[] {
  const out: number[] = [];
  let x = 0;
  let y = 0;
  const move = (p: Pt) => {
    out.push(unzigzag(p[0] - x), unzigzag(p[1] - y));
    [x, y] = p;
  };
  if (type === 1) {
    out.push(((parts.length & 0x1fffffff) << 3) | 1);
    for (const [p] of parts) move(p);
    return out;
  }
  for (const part of parts) {
    out.push((1 << 3) | 1);
    move(part[0]);
    out.push(((part.length - 1) << 3) | 2);
    for (const p of part.slice(1)) move(p);
    if (type === 3) out.push((1 << 3) | 7);
  }
  return out;
}

/** Géométrie découpée à la boîte selon son type (1 points, 2 lignes, 3 polygones) ; vide si tout est dehors */
function clipGeometry(parts: Pt[][], type: number, lo: number, hi: number): Pt[][] {
  if (type === 1) return parts.flat().filter((p) => p[0] >= lo && p[0] <= hi && p[1] >= lo && p[1] <= hi).map((p) => [p]);
  if (type === 2) return parts.flatMap((line) => clipLine(line, lo, hi));
  // Polygones : anneaux extérieurs et leurs trous ; un trou dont l'extérieur disparaît disparaît aussi
  const out: Pt[][] = [];
  let outerKept = false;
  const outerSign = Math.sign(signedArea(parts[0] ?? []));
  for (const ring of parts) {
    const isOuter = Math.sign(signedArea(ring)) === outerSign;
    if (!isOuter && !outerKept) continue;
    const clipped = clipRing(ring, lo, hi);
    const kept = clipped.length >= 3 && signedArea(clipped) !== 0;
    if (isOuter) outerKept = kept;
    if (kept) out.push(clipped);
  }
  return out;
}

/**
 * Tuile dont les géométries sont découpées à son bord, plus une marge de `buffer` (en 1/16 d'étendue par défaut).
 * Les tuiles autorouter ne découpent pas leurs tracés : ils débordent de plusieurs tuiles, au-delà de ce que
 * MapLibre accepte (coordonnées écrasées, tracés déformés ou interrompus au bord des tuiles à certains zooms).
 */
export function clipTileToBuffer(buf: Uint8Array, bufferRatio = 1 / 16): Uint8Array {
  const tile = new Writer();
  const reader = new Pbf(buf);
  while (!reader.done) {
    const layerField = reader.field();
    if (layerField.num !== 3) continue;
    const pbf = new Pbf(layerField.bytes!);
    const fields: { num: number; bytes?: Uint8Array; value?: number }[] = [];
    let extent = 4096;
    while (!pbf.done) {
      const f = pbf.field();
      if (f.num === 5) extent = f.value!;
      fields.push(f);
    }
    const lo = -Math.round(extent * bufferRatio);
    const hi = extent - lo;
    const out = new Writer();
    for (const f of fields) {
      if (f.num !== 2) {
        if (f.bytes) out.message(f.num, f.bytes);
        else out.uint(f.num, f.value!);
        continue;
      }
      // Entité : géométrie découpée, le reste inchangé
      const feature = new Pbf(f.bytes!);
      const parts: { num: number; bytes?: Uint8Array; value?: number }[] = [];
      let type = 0;
      let geometry: number[] = [];
      while (!feature.done) {
        const g = feature.field();
        if (g.num === 3) type = g.value!;
        if (g.num === 4) geometry = new Pbf(g.bytes!).packed();
        else parts.push(g);
      }
      const decoded = decodeGeometry(geometry);
      const outside = decoded.some((part) => part.some(([x, y]) => x < lo || x > hi || y < lo || y > hi));
      const clipped = outside ? clipGeometry(decoded, type, lo, hi) : decoded;
      if (!clipped.length) continue;
      const fw = new Writer();
      for (const g of parts) {
        if (g.bytes) fw.message(g.num, g.bytes);
        else fw.uint(g.num, g.value!);
      }
      fw.packed(4, outside ? encodeGeometry(clipped, type) : geometry);
      out.message(2, fw.finish());
    }
    tile.message(3, out.finish());
  }
  return tile.finish();
}
