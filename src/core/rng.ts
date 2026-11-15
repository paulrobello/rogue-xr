/** Named sub-streams of a run seed. Each consumes independently so one system's draws never shift another's. */
export const STREAMS = ['floor', 'deck', 'dice', 'loot', 'ai'] as const;
export type StreamName = (typeof STREAMS)[number];

/** Serializable sfc32 state: four unsigned 32-bit words. */
export type StreamState = readonly [number, number, number, number];
export type RunRngState = Readonly<Record<StreamName, StreamState>>;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SEED_LENGTH = 8;

/** FNV-1a 32-bit hash. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** splitmix32 step, used to expand one 32-bit value into well-mixed sfc32 state words. */
function splitmix32(value: number): () => number {
  let state = value >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

export class Stream {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(state: StreamState) {
    [this.a, this.b, this.c, this.d] = state;
  }

  static fromKey(key: string): Stream {
    const mix = splitmix32(hashString(key));
    const stream = new Stream([mix(), mix(), mix(), mix()]);
    for (let i = 0; i < 12; i++) stream.nextUint32();
    return stream;
  }

  nextUint32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextUint32() / 0x1_0000_0000;
  }

  /** Uniform integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new RangeError(`int(${min}, ${max}) needs integers with min <= max`);
    }
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick() from an empty list');
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Fisher-Yates shuffle into a new array. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  snapshot(): StreamState {
    return [this.a, this.b, this.c, this.d];
  }
}

export class RunRng {
  readonly seed: string;
  private readonly streams: Record<StreamName, Stream>;

  constructor(seed: string, state?: RunRngState) {
    this.seed = normalizeSeed(seed);
    this.streams = Object.fromEntries(
      STREAMS.map((name) => [
        name,
        state ? new Stream(state[name]) : Stream.fromKey(`${this.seed}:${name}`),
      ]),
    ) as Record<StreamName, Stream>;
  }

  stream(name: StreamName): Stream {
    return this.streams[name];
  }

  snapshot(): RunRngState {
    return Object.fromEntries(
      STREAMS.map((name) => [name, this.streams[name].snapshot()]),
    ) as Record<StreamName, StreamState>;
  }
}

/** Uppercases, maps the Crockford look-alikes (I, L → 1, O → 0) and drops separators. */
export function normalizeSeed(input: string): string {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (cleaned.length !== SEED_LENGTH || [...cleaned].some((ch) => !CROCKFORD.includes(ch))) {
    throw new RangeError(`Seed must be ${SEED_LENGTH} Crockford base32 characters, got "${input}"`);
  }
  return cleaned;
}

export function isValidSeed(input: string): boolean {
  try {
    normalizeSeed(input);
    return true;
  } catch {
    return false;
  }
}

/** A fresh seed from the platform CSPRNG. Only seed creation may use non-seeded randomness. */
export function randomSeed(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SEED_LENGTH));
  return [...bytes].map((byte) => CROCKFORD[byte & 31]).join('');
}
