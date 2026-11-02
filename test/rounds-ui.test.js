import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { harness } from './helpers.js';

function monitorAudio() {
  window.playedNotes = [];
  window.drumrolls = [];
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (destination, ...args) {
    if (destination instanceof AudioDestinationNode) {
      const analyser = this.context.createAnalyser();
      window.outputAnalyser = analyser;
      connect.call(this, analyser);
      connect.call(analyser, destination);
      return destination;
    }
    return connect.call(this, destination, ...args);
  };
  const create = AudioContext.prototype.createOscillator;
  AudioContext.prototype.createOscillator = function () {
    const oscillator = create.call(this);
    const start = oscillator.start.bind(oscillator);
    oscillator.start = (...args) => { window.playedNotes.push(oscillator.frequency.value); start(...args); };
    return oscillator;
  };
  const createSource = AudioContext.prototype.createBufferSource;
  AudioContext.prototype.createBufferSource = function () {
    const source = createSource.call(this);
    const start = source.start.bind(source);
    source.start = (...args) => {
      const samples = source.buffer.getChannelData(0);
      window.drumrolls.push({
        duration: source.buffer.duration, offset: args[1], running: this.state === 'running',
        energy: [0, 4, 9].map(second => {
          const section = samples.subarray(second * this.sampleRate, (second + 1) * this.sampleRate);
          return Math.sqrt(section.reduce((sum, value) => sum + value * value, 0) / section.length);
        }),
      });
      start(...args);
    };
    return source;
  };
}

test('browser: plan rounds then roll from public page as admin while audience only watches', async () => {
  const h = await harness();
  const server = h.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    await h.pool.query('UPDATE events SET is_demo=TRUE WHERE id=1');
    await h.add('Demo Round One', 'round.one@example.com');
    await h.add('Demo Round Two', 'round.two@example.com');
    browser = await chromium.launch();
    const context = await browser.newContext();
    const admin = await context.newPage();
    await admin.addInitScript(monitorAudio);
    const errors = [];
    admin.on('pageerror', e => errors.push(e.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    await admin.goto(`${base}/?event=1#admin`);
    await admin.getByLabel('Admin email').fill(h.config.adminEmail);
    await admin.getByLabel('Admin password').fill(h.config.adminPassword);
    await admin.getByRole('button', { name: 'Sign in to admin' }).click();
    await admin.getByRole('button', { name: 'Settings', exact: true }).click();
    await admin.getByLabel('Round prize', { exact: true }).fill('Gift hamper');
    await admin.getByRole('button', { name: 'Add round', exact: true }).click();
    await admin.getByLabel('Round prize', { exact: true }).nth(1).fill('Voucher');
    await admin.getByRole('button', { name: 'Save round plan' }).click();
    await admin.waitForFunction(() => document.querySelector('[data-form="settings"] [name="prize_count"]')?.value === '2');
    assert.equal(await admin.locator('[data-form="settings"] [name="prize_count"]').inputValue(), '2');
    await admin.getByLabel('Event status').selectOption('live');
    await admin.getByRole('button', { name: 'Save event settings' }).click();
    await admin.getByText('The plan cannot be changed after going Live', { exact: false }).waitFor();
    await admin.getByRole('link', { name: 'Live draw' }).click();
    await admin.getByRole('button', { name: 'Roll Round 1' }).waitFor();
    assert.equal(await admin.getByLabel('Number of winners', { exact: true }).count(), 0);
    const audienceContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const audience = await audienceContext.newPage();
    await audience.addInitScript(monitorAudio);
    audience.on('pageerror', e => errors.push(e.message));
    await audience.goto(`${base}/?event=1#draw`);
    await audience.getByText('Waiting for the coordinator to roll.', { exact: false }).waitFor();
    assert.equal(await audience.locator('[data-roll-round]').count(), 0);
    assert.equal(await audience.getByRole('button', { name: 'Reset demo' }).count(), 0);
    assert.equal(await audience.evaluate(() => window.playedNotes.length), 0);
    assert.equal(await audience.locator('[data-action="sound"]').count(), 0);
    await audience.locator('#draw-stage').click();
    assert.equal(await audience.evaluate(() => window.drumrolls.length), 0);
    await admin.getByRole('button', { name: 'Roll Round 1' }).click();
    await admin.getByRole('heading', { name: 'Let the luck roll!', exact: true }).waitFor();
    await audience.getByRole('heading', { name: 'Let the luck roll!', exact: true }).waitFor();
    assert.equal(await admin.getByRole('button', { name: 'Roll Round 2' }).isDisabled(), true);
    assert.equal(await admin.getByRole('button', { name: 'Reset demo' }).isDisabled(), true);
    assert.ok(await audience.locator('.reel-digit.rolling').first().evaluate(el => getComputedStyle(el, '::before').animationName === 'reel-roll'));
    for (const screen of [admin, audience]) {
      await screen.waitForFunction(() => window.drumrolls.length === 1);
      const drum = await screen.evaluate(() => window.drumrolls[0]);
      assert.equal(drum.duration, 10);
      assert.equal(drum.running, true);
      assert.ok(drum.offset >= 0 && drum.offset < 3);
      assert.ok(drum.energy.every(rms => rms > .05), JSON.stringify(drum));
      await screen.waitForFunction(() => {
        const samples = new Float32Array(window.outputAnalyser.fftSize);
        window.outputAnalyser.getFloatTimeDomainData(samples);
        return samples.some(value => Math.abs(value) > .02);
      });
    }
    await audience.locator('#draw-stage .winner-reveal').waitFor();
    await audience.locator('.confetti-burst').waitFor({ state: 'attached' });
    await admin.locator('.confetti-burst').waitFor({ state: 'attached' });
    await audience.waitForFunction(() => window.playedNotes.some(note => note > 1000));
    await audience.evaluate(() => { window.playedNotes = []; });
    await audience.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await audience.locator('.confetti-burst').evaluate(el => getComputedStyle(el).display), 'none');
    await audience.emulateMedia({ reducedMotion: 'no-preference' });
    await admin.waitForFunction(() => !document.querySelector('[data-roll-round]')?.disabled);
    await admin.getByRole('button', { name: 'Roll Round 2' }).click();
    await audience.getByRole('heading', { name: 'Let the luck roll!', exact: true }).waitFor();
    await audience.locator('#draw-stage .winner-reveal').waitFor();
    await audience.getByText('All rounds are complete.', { exact: true }).waitFor();
    await audience.waitForFunction(() => window.playedNotes.some(note => note > 1000));
    assert.equal(await audience.evaluate(() => window.drumrolls.length), 2);
    assert.equal(await audience.locator('#winners-list .winner-item').count(), 2);
    assert.equal(await admin.locator('[data-roll-round]').count(), 0);
    await h.pool.query("UPDATE draws SET reveal_at=NOW()-INTERVAL '10 seconds' WHERE event_id=1");
    await audience.locator('.confetti-burst').waitFor({ state: 'detached' });
    await audience.reload();
    await audience.getByText('All rounds are complete.', { exact: true }).waitFor();
    assert.equal(await audience.locator('.confetti-burst').count(), 0);
    admin.once('dialog', dialog => dialog.dismiss());
    await admin.getByRole('button', { name: 'Reset demo' }).click();
    assert.equal((await h.admin.get('/api/events/1/public')).body.draws.length, 2);
    admin.once('dialog', dialog => dialog.accept());
    await admin.getByRole('button', { name: 'Reset demo' }).click();
    await admin.getByRole('button', { name: 'Roll Round 1' }).waitFor();
    await audience.getByText('Waiting for the coordinator to roll.', { exact: false }).waitFor();
    assert.equal(await audience.locator('#winners-list .winner-item').count(), 0);
    assert.equal((await h.admin.get('/api/events/1/public')).body.stats.tickets, 2);
    await admin.getByRole('button', { name: 'Roll Round 1' }).click();
    await audience.getByRole('heading', { name: 'Let the luck roll!', exact: true }).waitFor();
    assert.equal(await audience.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await audienceContext.close();
    await context.close();
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await h.pool.end();
  }
});
