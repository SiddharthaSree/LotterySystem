import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { chromium } from 'playwright';
import { harness } from './helpers.js';
import { drawVideos } from '../lib/draw-videos.js';
import { enableDrawVideos } from '../scripts/enable-draw-videos.js';

async function prepare(h) {
  const root = '/admin/events/1';
  await h.write('put', `${root}/rounds`, { rounds: [
    { name: 'First', prize_label: 'Gift', winner_count: 2, batch_size: 1 },
    { name: 'Second', prize_label: 'Gift', winner_count: 1 },
    { name: 'Final', prize_label: 'Gift', winner_count: 1 },
  ] }).expect(200);
  for (let n = 1; n <= 4; n++) await h.add(`Video Employee ${n}`, `video${n}@example.com`);
  await h.write('patch', root, { ...h.settings, title: 'Diwali - 5 November 2026', prize_count: 4 }).expect(200);
  await enableDrawVideos(h.pool);
  assert.equal((await enableDrawVideos(h.pool)).alreadyEnabled, true);
  await h.write('patch', root, { ...h.settings, prize_count: 4, status: 'live' }).expect(200);
  return (await h.admin.get('/api/events/1/public')).body.rounds;
}

test('videos gate first rolls only, enforce ordered playback, preserve all awards and wait for final reveal before credits', async () => {
  const h = await harness();
  try {
    const root = '/admin/events/1';
    const rounds = await prepare(h);
    const visitor = request.agent(h.app);
    const csrf = (await visitor.get('/api/session')).body.csrf;
    await visitor.post(`/api${root}/videos/play`).set('x-csrf-token', csrf).send({ key: 'round-1' }).expect(401);
    await h.admin.post(`/api${root}/videos/play`).send({ key: 'round-1' }).expect(403);
    await h.write('post', `${root}/videos/play`, { key: 'credits' }).expect(400);
    await h.write('post', `${root}/videos/play`, { key: 'round-2' }).expect(400);
    await h.write('post', `${root}/videos/play`, { key: 'invalid' }).expect(400);
    for (const [i, round] of rounds.entries()) {
      await h.write('post', `${root}/rounds/${round.id}/roll`, {}).expect(400);
      const attempts = await Promise.all([
        h.write('post', `${root}/videos/play`, { key: `round-${i + 1}` }),
        h.write('post', `${root}/videos/play`, { key: `round-${i + 1}` }),
      ]);
      assert.deepEqual(attempts.map(r => r.status).sort(), [201, 400]);
      const playback = attempts.find(r => r.status === 201).body;
      const finish = `${root}/videos/${playback.id}/finish`;
      await h.write('post', finish, {}).expect(400);
      await h.write('post', finish, { skip: true }).expect(400);
      await h.write('post', `${root}/rounds/${round.id}/roll`, {}).expect(400);
      await h.write('patch', root, { ...h.settings, prize_count: 4, status: 'ended' }).expect(400);
      const publicData = (await visitor.get('/api/events/1/public')).body;
      assert.equal(publicData.video_playbacks.at(-1).id, playback.id);
      assert.equal(publicData.videos.length, 4);
      assert.equal(publicData.draws.length, i === 0 ? 0 : i + 1);
      if (i === 0) {
        await h.pool.query("UPDATE video_playbacks SET started_at=NOW()-INTERVAL '100 seconds' WHERE id=$1", [playback.id]);
        await h.write('post', finish, {}).expect(200);
      } else await h.write('post', finish, { skip: true, confirm: true }).expect(200);
      await h.write('post', finish, {}).expect(200);
      await h.write('post', `${root}/rounds/${round.id}/roll`, {}).expect(201);
      await h.write('post', `${root}/videos/play`, { key: 'credits' }).expect(400);
      await h.pool.query("UPDATE draws SET reveal_at=NOW()-INTERVAL '1 second'");
      if (i === 0) {
        // The second batch in the same round does not repeat the greeting.
        await h.write('post', `${root}/rounds/${round.id}/roll`, {}).expect(201);
        await h.pool.query("UPDATE draws SET reveal_at=NOW()-INTERVAL '1 second'");
        await h.write('post', `${root}/videos/play`, { key: 'round-1' }).expect(400);
      }
    }
    const before = (await h.pool.query('SELECT * FROM draws ORDER BY id')).rows;
    const credits = (await h.write('post', `${root}/videos/play`, { key: 'credits' }).expect(201)).body;
    await h.write('post', `${root}/videos/${credits.id}/finish`, { skip: true, confirm: true }).expect(200);
    assert.deepEqual((await h.pool.query('SELECT * FROM draws ORDER BY id')).rows, before);
    assert.equal(before.length, 4);
    assert.equal(new Set(before.map(d => d.person_id)).size, 4);
    assert.equal((await h.pool.query('SELECT * FROM video_playbacks')).rows.length, 4);
    const audits = (await h.pool.query("SELECT action FROM audit_log WHERE action LIKE 'video.%'")).rows;
    assert.equal(audits.length, 8);
  } finally { await h.pool.end(); }
});

test('browser video overlay synchronizes public screens, survives fullscreen, resumes late viewers, and never auto-rolls', async () => {
  const h = await harness();
  const server = h.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    await prepare(h);
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const audience = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await audience.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play;
      let blocked = false;
      HTMLMediaElement.prototype.play = function () {
        if (this.tagName === 'VIDEO' && !blocked) {
          blocked = true;
          return Promise.reject(new DOMException('Gesture required', 'NotAllowedError'));
        }
        return play.call(this);
      };
    });
    const errors = [];
    for (const screen of [page, audience]) screen.on('pageerror', e => errors.push(e.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/#admin`);
    await page.getByLabel('Admin email').fill(h.config.adminEmail);
    await page.getByLabel('Admin password').fill(h.config.adminPassword);
    await page.getByRole('button', { name: 'Sign in to admin' }).click();
    await page.getByRole('link', { name: 'Live draw' }).click();
    await audience.goto(`${base}/#draw`);
    assert.equal(await audience.locator('[data-play-video]').count(), 0);
    await page.getByRole('button', { name: 'Play Round 1 Greeting', exact: true }).click();
    await audience.locator('#video-overlay video').waitFor();
    await audience.getByText('Your browser needs a click for video sound. Select Play / resume with sound.', { exact: true }).waitFor();
    await audience.getByRole('button', { name: 'Play / resume with sound', exact: true }).click();
    await audience.waitForFunction(() => document.querySelector('#video-overlay video').currentTime > 0);
    await page.locator('#video-overlay video').waitFor();
    await page.getByText('Diwali wishes from our Management', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Play / resume with sound', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#video-overlay video').currentTime > .5);
    const duration = await page.locator('#video-overlay video').evaluate(v => v.duration);
    assert.ok(Math.abs(duration - drawVideos[0].duration) < .1);
    // Browser fullscreen is the containing presentation, not native video fullscreen.
    await page.evaluate(() => document.querySelector('#app').requestFullscreen());
    await page.waitForFunction(() => document.fullscreenElement?.id === 'app');
    await page.waitForFunction(() => document.querySelector('#video-overlay video').currentTime > 1);
    assert.ok(await page.locator('#video-overlay').isVisible());
    assert.equal(await audience.locator('[data-action="video-skip"]').count(), 0);
    assert.equal((await h.pool.query('SELECT * FROM draws')).rows.length, 0);
    await h.pool.query("UPDATE video_playbacks SET started_at=NOW()-INTERVAL '15 seconds'");
    await audience.reload();
    await audience.locator('#video-overlay video').waitFor();
    await audience.waitForFunction(() => document.querySelector('#video-overlay video').currentTime > 14);
    assert.equal(await audience.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await h.pool.query("UPDATE video_playbacks SET started_at=NOW()-INTERVAL '100 seconds'");
    await page.waitForFunction(() => !document.querySelector('[data-action="video-finish"]').disabled);
    let finishAttempts = 0;
    await page.route('**/videos/*/finish', async route => {
      finishAttempts++;
      if (finishAttempts === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary test outage' }) });
      else await route.continue();
    });
    await page.locator('#video-overlay video').evaluate(v => { v.currentTime = v.duration - .2; });
    await page.getByRole('button', { name: 'Play / resume with sound', exact: true }).click();
    await page.getByText('The video has finished, but returning to the draw failed.', { exact: false }).waitFor();
    await audience.locator('#video-overlay').waitFor({ state: 'detached' });
    await page.locator('#video-overlay').waitFor({ state: 'detached' });
    assert.ok(finishAttempts >= 2, 'Automatic completion retries after a transient failure');
    await page.unroute('**/videos/*/finish');
    assert.equal((await h.pool.query('SELECT * FROM draws')).rows.length, 0);
    assert.equal(await page.locator('[data-roll-round]').isDisabled(), false);
    await page.evaluate(() => document.exitFullscreen());
    await page.getByRole('button', { name: 'Replay Round 1 Greeting', exact: true }).click();
    await h.pool.query("UPDATE video_playbacks SET started_at=NOW()-INTERVAL '100 seconds' WHERE completed_at IS NULL");
    await page.reload();
    await page.locator('#video-overlay video').waitFor();
    await page.getByRole('button', { name: 'Play / resume with sound', exact: true }).click();
    await page.locator('#video-overlay').waitFor({ state: 'detached' });
    await page.waitForFunction(() => !document.querySelector('[data-roll-round]')?.disabled);
    assert.equal((await h.pool.query('SELECT * FROM draws')).rows.length, 0);
    for (const video of drawVideos) {
      const response = await request(h.app).get(video.src).set('Range', 'bytes=0-1023').expect(206);
      assert.equal(response.body.length, 1024);
      const meta = await audience.evaluate(src => new Promise((resolve, reject) => {
        const v = document.createElement('video');
        v.onloadedmetadata = () => resolve(v.duration);
        v.onerror = () => reject(new Error('Cannot decode supplied video'));
        v.src = src;
      }), video.src);
      assert.ok(Math.abs(meta - video.duration) < .1);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await h.pool.end();
  }
});

test('real first greeting plays through and automatically returns to manual draw without a Return click', async () => {
  const h = await harness();
  const server = h.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    await prepare(h);
    browser = await chromium.launch();
    const page = await browser.newPage();
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/#admin`);
    await page.getByLabel('Admin email').fill(h.config.adminEmail);
    await page.getByLabel('Admin password').fill(h.config.adminPassword);
    await page.getByRole('button', { name: 'Sign in to admin' }).click();
    await page.getByRole('link', { name: 'Live draw' }).click();
    await page.getByRole('button', { name: 'Play Round 1 Greeting', exact: true }).click();
    await page.locator('#video-overlay video').waitFor();
    await page.getByRole('button', { name: 'Play / resume with sound', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#video-overlay video')?.currentTime > 1);
    await page.locator('#video-overlay').waitFor({ state: 'detached', timeout: 95000 });
    assert.equal(await page.locator('[data-roll-round]').isDisabled(), false);
    assert.equal((await h.pool.query('SELECT * FROM draws')).rows.length, 0);
    const playback = (await h.pool.query('SELECT * FROM video_playbacks')).rows[0];
    assert.ok(playback.completed_at);
    assert.equal(playback.skipped, false);
    assert.ok(new Date(playback.completed_at) - new Date(playback.started_at) >= drawVideos[0].duration * 1000);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await h.pool.end();
  }
});
