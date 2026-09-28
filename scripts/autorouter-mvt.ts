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
