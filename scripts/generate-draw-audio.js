import { mkdir, writeFile } from 'node:fs/promises';

const rate = 22050;
function wav(samples) {
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((value, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2));
  return data;
}

let seed = 2026;
const noise = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2147483648 - 1;
};
const drum = new Float32Array(rate * 9);
for (let hit = 0; hit < 9; hit += .17 - .13 * (hit / 9)) {
  for (let i = Math.floor(hit * rate); i < Math.min(drum.length, (hit + .13) * rate); i++) {
    const age = i / rate - hit;
    const intensity = .2 + .65 * (hit / 9);
    drum[i] += (noise() * .8 + Math.sin(age * Math.PI * 2 * 170) * .5) * Math.exp(-age * 32) * intensity;
  }
}
for (let i = 0; i < drum.length; i++) {
  const time = i / rate;
  const rise = time / 9;
  drum[i] += Math.sin(2 * Math.PI * (65 * time + 8 * time * time)) * .08 * rise * rise;
}
const fanfare = new Float32Array(rate * 2);
for (const [start, frequencies, strength] of [
  [0, [392, 493.88, 587.33], .16],
  [.22, [523.25, 659.25, 783.99, 1046.5], .2],
]) {
  for (let i = Math.floor(start * rate); i < fanfare.length; i++) {
    const age = i / rate - start;
    for (const frequency of frequencies) {
      const brass = Math.sin(age * Math.PI * 2 * frequency) + .25 * Math.sin(age * Math.PI * 4 * frequency);
      fanfare[i] += brass * strength * Math.min(1, age * 90) * Math.exp(-age * 2.8);
    }
  }
}
for (let i = 0; i < fanfare.length; i++) {
  const time = i / rate;
  if (time >= .22) fanfare[i] += noise() * .2 * Math.exp(-(time - .22) * 5);
}
const destination = new URL('../public/audio/', import.meta.url);
await mkdir(destination, { recursive: true });
await writeFile(new URL('drumroll.wav', destination), wav(drum));
await writeFile(new URL('winner.wav', destination), wav(fanfare));
console.log('Generated original 9-second crescendo and 2-second ta-da fanfare.');
