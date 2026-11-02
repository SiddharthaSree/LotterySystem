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
const drum = new Float32Array(rate * 10);
for (let hit = 0; hit < 10; hit += .12 - .075 * (hit / 10)) {
  for (let i = Math.floor(hit * rate); i < Math.min(drum.length, (hit + .13) * rate); i++) {
    const age = i / rate - hit;
    drum[i] += (noise() * .8 + Math.sin(age * Math.PI * 2 * 170) * .5) * Math.exp(-age * 32);
  }
}
const fanfare = new Float32Array(rate * 2);
[523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
  for (let i = Math.floor(index * .16 * rate); i < fanfare.length; i++) {
    const age = i / rate - index * .16;
    fanfare[i] += Math.sin(age * Math.PI * 2 * frequency) * .28 * Math.min(1, age * 100) * Math.exp(-age * 3);
  }
});
const destination = new URL('../public/audio/', import.meta.url);
await mkdir(destination, { recursive: true });
await writeFile(new URL('drumroll.wav', destination), wav(drum));
await writeFile(new URL('winner.wav', destination), wav(fanfare));
console.log('Generated original 10-second drumroll and 2-second winner fanfare.');
