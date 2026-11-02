import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { harness } from './helpers.js';

test('presentation fits projector and laptop screens with paginated winners and live round control', async () => {
  const h = await harness();
  const server = h.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser;
  try {
    const plan = [
      { name: 'Round 1', prize_label: 'Gift hamper', winner_count: 10 },
      { name: 'Round 2', prize_label: 'Shopping voucher', winner_count: 4 },
      { name: 'Round 3', prize_label: 'Surprise gift', winner_count: 3 },
    ];
    await h.write('put', '/admin/events/1/rounds', { rounds: plan }).expect(200);
    for (let i = 1; i <= 15; i++) await h.add(`Demo Employee ${String(i).padStart(2, '0')}`, `demo${i}@example.com`);
    await h.write('patch', '/admin/events/1', { ...h.settings, prize_count: 17, status: 'live' }).expect(200);
    const data = (await h.admin.get('/api/events/1/public')).body;
    await h.write('post', `/admin/events/1/rounds/${data.rounds[0].id}/roll`, {}).expect(201);
    await h.pool.query("UPDATE draws SET reveal_at=NOW()-INTERVAL '1 second' WHERE event_id=1");
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/?event=1#admin`);
    await page.getByLabel('Admin email').fill(h.config.adminEmail);
    await page.getByLabel('Admin password').fill(h.config.adminPassword);
    await page.getByRole('button', { name: 'Sign in to admin' }).click();
    await page.getByRole('heading', { name: 'Make the celebration happen.' }).waitFor();
    await page.getByRole('link', { name: 'Live draw' }).click();
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1280, height: 720 }, { width: 1024, height: 600 }, { width: 1920, height: 1080 }]) {
      if (await page.evaluate(() => Boolean(document.fullscreenElement))) {
        await page.getByRole('button', { name: 'Exit presentation' }).click();
        await page.waitForFunction(() => !document.fullscreenElement);
      }
      await page.setViewportSize(viewport);
      await page.getByRole('button', { name: 'Presentation mode' }).click();
      await page.waitForFunction(() => document.fullscreenElement?.classList.contains('presentation'));
      const measurements = await page.evaluate(() => {
        const app = document.querySelector('#app');
        const targets = ['#draw-stage', '#round-controls', '#winners-list', '[data-roll-round]', '.presentation-pages'];
        return {
          noScroll: app.scrollHeight <= app.clientHeight + 1 && app.scrollWidth <= app.clientWidth + 1,
          visible: targets.every(selector => {
            const rect = document.querySelector(selector).getBoundingClientRect();
            return rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth;
          }),
          winnersFit: [...document.querySelectorAll('.winner-item')].every(item => item.scrollHeight <= item.clientHeight + 1),
        };
      });
      assert.deepEqual(measurements, { noScroll: true, visible: true, winnersFit: true }, JSON.stringify(viewport));
    }
    assert.equal(await page.locator('#winners-list .winner-item').count(), 8);
    await page.getByRole('button', { name: 'Next winners' }).click();
    assert.equal(await page.locator('#winners-list .winner-item').count(), 2);
    assert.ok(await page.getByRole('button', { name: 'Roll Round 2' }).isVisible());
    await page.getByRole('button', { name: 'Exit presentation' }).click();
    await page.waitForFunction(() => !document.fullscreenElement);
    assert.equal(await page.locator('#winners-list .winner-item').count(), 10);
    assert.equal(await page.locator('#app').evaluate(el => el.classList.contains('presentation')), false);
    await page.setViewportSize({ width: 1024, height: 600 });
    await page.getByRole('button', { name: 'Presentation mode' }).click();
    await page.waitForFunction(() => document.fullscreenElement?.classList.contains('presentation'));
    await page.getByRole('button', { name: 'Roll Round 2' }).click();
    await page.getByRole('heading', { name: 'Let the luck roll!', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => {
      const app = document.querySelector('#app');
      const reels = document.querySelector('.ticket-reels').getBoundingClientRect();
      const rounds = document.querySelector('#round-controls').getBoundingClientRect();
      return app.scrollHeight <= app.clientHeight + 1 && reels.top >= 0 &&
        reels.bottom <= innerHeight && rounds.bottom <= innerHeight;
    }), true);
    assert.ok(await page.getByRole('button', { name: 'Exit presentation' }).isVisible());
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await h.pool.end();
  }
});
