// ── Keccak-256 (Sponge) and DeepSeek PoW Solver (Pure JS) ───────────────
//
// A standalone, highly portable implementation of the Keccak sponge construction
// and DeepSeek's proof-of-work (PoW) algorithm. It has zero external dependencies
// and runs in any modern Node.js environment.

const d = new Uint32Array([
  0, 1, 0, 32898, 0x80000000, 32906, 0x80000000, 0x80008000,
  0, 32907, 0, 0x80000001, 0x80000000, 0x80008081, 0x80000000, 32777,
  0, 138, 0, 136, 0, 0x80008009, 0, 0x8000000a,
  0, 0x8000808b, 0x80000000, 139, 0x80000000, 32905, 0x80000000, 32771,
  0x80000000, 32770, 0x80000000, 128, 0, 32778, 0x80000000, 0x8000000a,
  0x80000000, 0x80008081, 0x80000000, 32896, 0, 0x80000001, 0x80000000, 0x80008008
]);

const v = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4,
  15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1
];

const w = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14,
  27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44
];

function copyWord(src, srcIdx, dest, destIdx) {
  const i = 2 * destIdx;
  const o = 2 * srcIdx;
  dest[i] = src[o];
  dest[i + 1] = src[o + 1];
}

function rhoAndPi(state, C, W) {
  let i = 0;
  copyWord(state, i + 1, W, i);
  let u = 0;
  for (; i < 24; i++) {
    const t = v[i];
    const a = w[i];
    copyWord(state, t, C, 0);
    const o = W[0];
    const f = W[1];
    const s = 32 - a;
    u = a < 32 ? 0 : 1;
    W[u] = (o << a) | (f >>> s);
    W[(u + 1) % 2] = (f << a) | (o >>> s);
    copyWord(W, 0, state, t);
    copyWord(C, 0, W, 0);
  }
}

function theta(state, C, D, W) {
  for (let t = 0; t < 5; t++) {
    const n = 2 * t;
    const i = (t + 5) * 2;
    const o = (t + 10) * 2;
    const f = (t + 15) * 2;
    const u = (t + 20) * 2;
    C[n] = state[n] ^ state[i] ^ state[o] ^ state[f] ^ state[u];
    C[n + 1] = state[n + 1] ^ state[i + 1] ^ state[o + 1] ^ state[f + 1] ^ state[u + 1];
  }
  for (let t = 0; t < 5; t++) {
    copyWord(C, (t + 1) % 5, W, 0);
    const o = W[0];
    const f = W[1];
    W[0] = (o << 1) | (f >>> 31);
    W[1] = (f << 1) | (o >>> 31);
    D[2 * t] = C[((t + 4) % 5) * 2] ^ W[0];
    D[2 * t + 1] = C[((t + 4) % 5) * 2 + 1] ^ W[1];
    for (let r = 0; r < 25; r += 5) {
      state[(r + t) * 2] ^= D[2 * t];
      state[(r + t) * 2 + 1] ^= D[2 * t + 1];
    }
  }
}

function chi(state, C) {
  for (let t = 0; t < 25; t += 5) {
    for (let n = 0; n < 5; n++) {
      copyWord(state, t + n, C, n);
    }
    for (let n = 0; n < 5; n++) {
      const i = (t + n) * 2;
      const o = ((n + 1) % 5) * 2;
      const f = ((n + 2) % 5) * 2;
      state[i] ^= ~C[o] & C[f];
      state[i + 1] ^= ~C[o + 1] & C[f + 1];
    }
  }
}

function iota(state, round) {
  const n = 2 * round;
  state[0] ^= d[n];
  state[1] ^= d[n + 1];
}

function absorbQueue(queue, state) {
  for (let r = 0; r < queue.length; r += 8) {
    const n = r / 4;
    state[n] ^= (queue[r + 7] << 24) | (queue[r + 6] << 16) | (queue[r + 5] << 8) | queue[r + 4];
    state[n + 1] ^= (queue[r + 3] << 24) | (queue[r + 2] << 16) | (queue[r + 1] << 8) | queue[r];
  }
}

function squeezeState(state, queue) {
  for (let r = 0; r < queue.length; r += 8) {
    const n = r / 4;
    queue[r] = state[n + 1];
    queue[r + 1] = state[n + 1] >>> 8;
    queue[r + 2] = state[n + 1] >>> 16;
    queue[r + 3] = state[n + 1] >>> 24;
    queue[r + 4] = state[n];
    queue[r + 5] = state[n] >>> 8;
    queue[r + 6] = state[n] >>> 16;
    queue[r + 7] = state[n] >>> 24;
  }
}

export class KeccakSponge {
  constructor({ capacity = 256 } = {}) {
    this.capacity = capacity;
    this.rateBytes = 200 - capacity / 4;
    this.outputBytes = capacity / 8;
    this.state = new Uint32Array(50);
    this.queue = Buffer.allocUnsafe(this.rateBytes);
    this.queueOffset = 0;

    const C = new Uint32Array(10);
    const D = new Uint32Array(10);
    const W = new Uint32Array(2);

    this.keccak = (state) => {
      for (let round = 1; round < 24; round++) {
        theta(state, C, D, W);
        rhoAndPi(state, C, W);
        chi(state, C);
        iota(state, round);
      }
      C.fill(0);
      D.fill(0);
      W.fill(0);
    };
  }

  absorb(buffer) {
    for (let e = 0; e < buffer.length; e++) {
      this.queue[this.queueOffset] = buffer[e];
      this.queueOffset += 1;
      if (this.queueOffset >= this.rateBytes) {
        absorbQueue(this.queue, this.state);
        this.keccak(this.state);
        this.queueOffset = 0;
      }
    }
    return this;
  }

  squeeze(padding) {
    const buffer = Buffer.allocUnsafe(this.outputBytes);
    const tempQueue = Buffer.allocUnsafe(this.queue.length);
    const tempState = new Uint32Array(this.state.length);

    this.queue.copy(tempQueue);
    tempState.set(this.state);

    tempQueue.fill(0, this.queueOffset);
    tempQueue[this.queueOffset] |= padding;
    tempQueue[this.rateBytes - 1] |= 128;

    absorbQueue(tempQueue, tempState);

    this.keccak(tempState);
    squeezeState(tempState, buffer);

    return buffer;
  }

  copy() {
    const copy = new KeccakSponge({ capacity: this.capacity });
    copy.state.set(this.state);
    this.queue.copy(copy.queue);
    copy.queueOffset = this.queueOffset;
    return copy;
  }
}

export function solveDeepSeekPow(algorithm, challenge, salt, difficulty, expireAt) {
  if (algorithm !== "DeepSeekHashV1") {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }
  const prefix = `${salt}_${expireAt}_`;

  const createHash = () => {
    const sponge = new KeccakSponge({ capacity: 256 });
    return {
      update(s) {
        sponge.absorb(Buffer.from(s, "utf8"));
        return this;
      },
      digest(fmt = "hex") {
        return sponge.squeeze(6).toString(fmt);
      },
      copy() {
        const clonedSponge = sponge.copy();
        return {
          update(s) {
            clonedSponge.absorb(Buffer.from(s, "utf8"));
            return this;
          },
          digest(fmt = "hex") {
            return clonedSponge.squeeze(6).toString(fmt);
          }
        };
      }
    };
  };

  const h = createHash();
  h.update(prefix);

  for (let nonce = 0; nonce < difficulty; nonce++) {
    if (h.copy().update(String(nonce)).digest("hex") === challenge) {
      return nonce;
    }
  }
  return -1;
}
