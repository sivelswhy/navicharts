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
