import { expect, test } from '@playwright/test';
import { installArchive } from './helpers/archive';

for (const autoCollapse of [true, false]) {
  test(`keeps all pinned compact date tracks visible after hover ends with auto-collapse ${autoCollapse}`, async ({ page }) => {
    test.setTimeout(60_000);
    await installArchive(page, 'facebook', false, false, false, 120);
    await page.addInitScript(value => {
      const prefix = 'majv_' + location.hostname + '_setting_';
      localStorage.setItem(prefix + 'autoCollapseDateNav', String(value));
      localStorage.setItem(prefix + 'infoPanelOpen', 'true');
    }, autoCollapse);
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.goto('');
    await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
    await page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' }).click();
    await expect(page.locator('#chat')).not.toHaveAttribute('data-opening', 'true');
    const header = page.locator('.chat-header-region > .chat-header');
    const toggle = header.getByRole('button', { name: 'Browse dates' });
    const dates = header.locator('.date-nav-controls');
    await page.mouse.move(1, 1);
    await expect(dates).toBeHidden();
    const before = await page.locator('#chat').boundingBox();
    // Keyboard activation pins the panel independently of transient hover opening.
    await toggle.focus();
    await toggle.press('Escape');
    await toggle.press('Enter');
    await expect(header).toHaveAttribute('data-date-expanded', 'true');
    for (const scale of ['Month', 'Week', 'Day']) {
      await dates.getByRole('button', { name: scale, exact: true }).click();
      await page.mouse.move(500, 850);
      await toggle.blur();
      await expect(header).not.toHaveCSS('display', 'flex');
      await expect(dates).toBeVisible();
      await expect(dates.locator('.date-nav-track')).toBeVisible();
      await expect(dates.locator('.date-nav-track')).toHaveCSS('display', scale === 'Month' ? 'flex' : 'block');
      expect(await page.locator('#chat').boundingBox()).toEqual(before);
    }
    await page.setViewportSize({ width: 1100, height: 900 });
    await expect(dates.locator('.date-nav-track')).toBeVisible();
    await toggle.press('Escape');
    await expect(dates).toBeHidden();
    await toggle.press('Enter');
    await expect(dates.locator('.date-nav-track')).toBeVisible();
    await page.locator('#chat').click({ position: { x: 10, y: 200 } });
    await expect(dates).toBeHidden();
  });
}

for (const autoCollapse of [true, false]) {
  test(`keeps crowded desktop chat headers usable with auto-collapse ${autoCollapse}`, async ({ page }) => {
    test.setTimeout(60_000);
    await installArchive(page, 'facebook', false, false, false, 120);
    await page.addInitScript(value => {
      const prefix = 'majv_' + location.hostname + '_';
      localStorage.setItem(prefix + 'setting_autoCollapseDateNav', String(value));
      localStorage.setItem(prefix + 'setting_infoPanelOpen', 'true');
    }, autoCollapse);
    await page.setViewportSize({ width: 1800, height: 900 });
    await page.goto('');
    await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
    await page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' }).click();
    const header = page.locator('.chat-header-region > .chat-header');
    const title = header.getByRole('heading', { name: 'Alice Chat' });
    const info = header.getByRole('button', { name: 'Toggle chat info panel', exact: true });
    const dates = header.locator('.date-nav-controls');
    const dateToggle = header.getByRole('button', { name: 'Browse dates', exact: true });
    const chat = page.locator('#chat');
    await expect(chat).not.toHaveAttribute('data-opening', 'true');
    await expect(dates).toBeVisible();
    const wideTitle = await title.boundingBox();
    const wideDates = await dates.boundingBox();
    expect(wideDates!.y).toBeLessThan(wideTitle!.y + wideTitle!.height);
    await expect(dates.locator('#dateNavCurrentBox')).toHaveJSProperty('tagName', 'BUTTON');
    if (!autoCollapse) {
      await dates.locator('#dateNavCurrentBox').click();
      await expect(dates).toHaveClass(/manual-collapsed/);
      await expect(dates.locator('.date-nav-track')).toBeHidden();
    }

    for (const width of [1280, 1000, 769]) {
      await page.setViewportSize({ width, height: 900 });
      await info.hover();
      await expect(dates).toBeHidden();
      const before = await info.boundingBox();
      const heading = await title.boundingBox();
      const bounds = await header.boundingBox();
      const chatBefore = await chat.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, height: rect.height, scrollTop: element.scrollTop,
          lastMessageTop: [...element.querySelectorAll('.message')].at(-1)?.getBoundingClientRect().top };
      });
      expect(heading!.x + heading!.width).toBeLessThanOrEqual(before!.x);
      expect(heading!.width).toBeGreaterThan(bounds!.width - before!.width - 35);
      await title.hover();
      if (!autoCollapse) {
        await expect(dates).toBeHidden();
        await title.click();
      }
      await expect(dates).toBeVisible();
      await expect(dates.locator('#dateNavCurrentBox')).toHaveJSProperty('tagName', 'DIV');
      await expect(dates.locator('button.date-nav-current-box')).toHaveCount(0);
      await dates.locator('#dateNavCurrentBox').click();
      await expect(dates.locator('.date-nav-scale')).toBeVisible();
      await expect(dates.locator('.date-nav-track')).toBeVisible();
      await expect(dates).not.toHaveClass(/manual-collapsed/);
      const secondary = await dates.boundingBox();
      const after = await info.boundingBox();
      expect(secondary!.y).toBeGreaterThanOrEqual(after!.y + after!.height);
      expect(after!.y).toBeCloseTo(before!.y, 0);
      expect(after!.x).toBeCloseTo(before!.x, 0);
      expect(await chat.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, height: rect.height, scrollTop: element.scrollTop,
          lastMessageTop: [...element.querySelectorAll('.message')].at(-1)?.getBoundingClientRect().top };
      })).toEqual(chatBefore);
      await info.hover();
      if (autoCollapse) await expect(dates).toBeHidden();
      else await expect(dates).toBeVisible();
      expect(await chat.boundingBox()).toMatchObject({ y: chatBefore.top, height: chatBefore.height });
      if (!autoCollapse) {
        await title.click();
        await expect(dates).toBeHidden();
      }
    }

    await page.setViewportSize({ width: 1000, height: 900 });
    await title.hover();
    if (!autoCollapse) await title.click();
    await dates.getByRole('button', { name: 'Week', exact: true }).click();
    await page.mouse.move(1, 1);
    if (autoCollapse) await expect(dates).toBeHidden();
    else await expect(dates).toBeVisible();
    await title.hover();
    await dates.getByRole('button', { name: 'Month', exact: true }).click();
    await page.mouse.move(1, 1);
    await page.keyboard.press('Tab');
    await dateToggle.focus();
    await expect(dates).toBeVisible();
    await expect(dates.locator('.date-nav-track')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(dates.getByRole('button', { name: 'Month', exact: true })).toBeFocused();
    await info.hover();
    if (autoCollapse) await expect(dates).toBeHidden();
    else await expect(dates).toBeVisible();
    await info.click();
    await expect(page.locator('#chatInfoPanel')).toBeHidden();
    await expect(title).toBeVisible();
    await title.hover();
    await expect(dates).toBeVisible();
    await info.click();
    await expect(page.locator('#chatInfoPanel')).toBeVisible();
    await title.hover();
    await expect(dates).toBeVisible();

    for (const tab of ['Settings', 'Chats']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await title.hover();
      if (!autoCollapse) await dateToggle.click();
      await expect(dates).toBeVisible();
    }

    await title.click();
    await expect(dates).toBeHidden();
    await expect(dates.locator('#dateNavCurrentBox')).toBeHidden();
    await title.click();
    await expect(dates).toBeVisible();
    await dates.getByRole('button', { name: 'Day', exact: true }).click();
    await expect(dates).toBeVisible();
    await page.mouse.move(1, 1);
    await expect(dates).toBeVisible();
    await info.hover();
    await expect(dates).toBeVisible();
    await dateToggle.press('Escape');
    await expect(dates).toBeHidden();
    await dateToggle.press('Enter');
    await expect(dates).toBeVisible();

    await page.keyboard.press('Tab');
    await dateToggle.focus();
    await expect(dates).toBeVisible();
    await dateToggle.press('Enter');
    await expect(dates).toBeHidden();
    await dateToggle.press(' ');
    await expect(dates).toBeVisible();

    // Turning auto-collapse off switches to clicks, including the first hover.
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    const autoCollapseToggle = page.locator('#autoCollapseDateNavToggle');
    const autoCollapseLabel = page.locator('label[for="autoCollapseDateNavToggle"]');
    if (!await autoCollapseToggle.isChecked()) await autoCollapseLabel.click();
    await expect(autoCollapseToggle).toBeChecked();
    await autoCollapseLabel.click();
    await expect(autoCollapseToggle).not.toBeChecked();
    await title.hover();
    await expect(dates).toBeHidden();
    await title.click();
    await expect(dates).toBeVisible();
    await page.mouse.move(1, 1);
    await expect(dates).toBeVisible();
    await title.click();
    await expect(dates).toBeHidden();
    await page.mouse.move(1, 1);
    await title.hover();
    await expect(dates).toBeHidden();
    await dateToggle.focus();
    await expect(dates).toBeHidden();
    await dateToggle.press('Enter');
    await expect(dates).toBeVisible();
    await dateToggle.press(' ');
    await expect(dates).toBeHidden();
    await autoCollapseLabel.click();
    await expect(autoCollapseToggle).toBeChecked();
    await title.hover();
    await expect(dates).toBeVisible();
    await page.mouse.move(1, 1);
    await expect(dates).toBeHidden();

    if (!autoCollapse) {
      await autoCollapseLabel.click();
      await expect(autoCollapseToggle).not.toBeChecked();
    }
    await page.setViewportSize({ width: 1800, height: 900 });
    const wideToggle = dates.locator('#dateNavCurrentBox');
    await expect(wideToggle).toHaveJSProperty('tagName', 'BUTTON');
    if (!autoCollapse) {
      await expect(dates).toHaveClass(/manual-collapsed/);
      await wideToggle.click();
      await expect(dates).not.toHaveClass(/manual-collapsed/);
      await expect(dates.locator('.date-nav-scale')).toBeVisible();
    } else await expect(wideToggle).toBeDisabled();
  });
}

test('uses 70 percent bubble widths only in narrow message areas', async ({ page }) => {
  await installArchive(page, 'facebook', false, true, false, 120);
  await page.addInitScript(() => {
    localStorage.setItem('majv_' + location.hostname + '_setting_infoPanelOpen', 'true');
  });
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' }).click();
  const chat = page.locator('#chat');
  await expect(chat).toHaveAttribute('aria-busy', 'false');
  const observedWidths = new Set<string>();
  for (const width of [1800, 1280, 1000, 769, 390, 1800]) {
    await page.setViewportSize({ width, height: 900 });
    await page.mouse.move(1, 1);
    await chat.evaluate(element => { element.scrollTop = 0; });
    const grid = chat.locator('.message.has-media-grid').first();
    await grid.scrollIntoViewIfNeeded();
    const metrics = await chat.evaluate(element => {
      const style = getComputedStyle(element);
      return { width: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
    });
    const expected = metrics.width <= 600 ? '70%' : '50%';
    observedWidths.add(expected);
    for (const direction of ['from-me', 'from-them']) {
      await expect(chat.locator(`.message.${direction}`).first()).toHaveCSS('max-width', expected);
    }
    await expect(grid).toHaveCSS('max-width', expected);
    const ratio = parseFloat(expected) / 100;
    await expect.poll(async () => grid.evaluate((message, fraction) => {
      const parent = message.parentElement!.getBoundingClientRect();
      return message.getBoundingClientRect().width - Math.min(340, parent.width * fraction);
    }, ratio)).toBeCloseTo(0, 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  expect([...observedWidths].sort()).toEqual(['50%', '70%']);
});

test('clears the compact date overlay for date jumps without changing wide or attachment jumps', async ({ page }) => {
  test.setTimeout(60_000);
  await installArchive(page, 'facebook', false, false, false, 120);
  await page.addInitScript(() => {
    localStorage.setItem('majv_' + location.hostname + '_setting_infoPanelOpen', 'true');
  });
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.goto('');
  await page.getByRole('button', { name: /Select messages folder|Select folder/ }).click();
  await page.locator('.chat-list-item').filter({ hasText: 'Alice Chat' }).click();
  const header = page.locator('.chat-header-region > .chat-header');
  const title = header.getByRole('heading', { name: 'Alice Chat' });
  const dates = header.locator('.date-nav-controls');
  const chat = page.locator('#chat');
  await expect(chat).not.toHaveAttribute('data-opening', 'true');

  const landedOffset = async (index: string) => page.locator(`#chat .message[data-msg-index="${index}"]`).evaluate(message => (
    message.getBoundingClientRect().top - document.querySelector('#chat')!.getBoundingClientRect().top
  ));

  for (const width of [1800, 1000, 769]) {
    await page.setViewportSize({ width, height: 900 });
    await title.hover();
    await expect(dates).toBeVisible();
    const month = dates.locator('.date-nav-item').nth(2);
    const index = (await month.getAttribute('data-msg-index'))!;
    await month.click();
    const target = page.locator(`#chat .message[data-msg-index="${index}"]`);
    await expect(target).toHaveClass(/highlight-target/);
    const expected = width === 1800 ? 120 : await dates.evaluate(controls => Math.max(
      120, controls.getBoundingClientRect().bottom - document.querySelector('#chat')!.getBoundingClientRect().top + 12,
    ));
    await expect.poll(() => landedOffset(index)).toBeCloseTo(expected, 0);
    if (width !== 1800) {
      const overlay = (await dates.boundingBox())!;
      expect((await target.boundingBox())!.y).toBeGreaterThanOrEqual(overlay.y + overlay.height + 11);
    }
  }

  // Slider jumps use the current overlay height as well.
  await dates.getByRole('button', { name: 'Week', exact: true }).click();
  const slider = dates.locator('input[type="range"]');
  const previousTarget = (await chat.locator('.message.highlight-target').getAttribute('data-msg-index'))!;
  await slider.focus();
  await slider.press('End');
  await slider.press('ArrowLeft');
  const highlighted = chat.locator('.message.highlight-target');
  await expect(highlighted).toHaveCount(1);
  await expect(highlighted).not.toHaveAttribute('data-msg-index', previousTarget);
  const overlay = (await dates.boundingBox())!;
  await expect.poll(async () => (await highlighted.boundingBox())!.y).toBeGreaterThanOrEqual(overlay.y + overlay.height + 11);

  await dates.getByRole('button', { name: 'Month', exact: true }).click();
  const firstMonth = dates.locator('.date-nav-item').first();
  const firstIndex = (await firstMonth.getAttribute('data-msg-index'))!;
  await firstMonth.click();
  await expect(chat.locator(`.message[data-msg-index="${firstIndex}"]`)).toHaveClass(/highlight-target/);
  const firstOffset = await dates.evaluate(controls => Math.max(
    120, controls.getBoundingClientRect().bottom - document.querySelector('#chat')!.getBoundingClientRect().top + 12,
  ));
  await expect.poll(() => landedOffset(firstIndex)).toBeCloseTo(firstOffset, 0);

  // Jumping from an attachment still uses the original 120px offset, even if the compact row is open.
  await page.mouse.move(1, 1);
  await chat.evaluate(element => { element.scrollTop = 0; });
  const attachmentMessage = chat.locator('.message[data-msg-index="22"]');
  await attachmentMessage.scrollIntoViewIfNeeded();
  await attachmentMessage.getByRole('button', { name: 'Image not found or unreadable' }).click();
  const viewer = page.getByRole('dialog', { name: 'Attachment viewer' });
  await expect(viewer).toBeVisible();
  await viewer.getByRole('button', { name: 'More options' }).click();
  await viewer.getByRole('button', { name: 'Jump to message' }).click();
  await expect(viewer).toHaveCount(0);
  await expect.poll(() => landedOffset('22')).toBeCloseTo(120, 0);
  await expect(chat.locator('.message-list-content')).toHaveCSS('padding-top', '0px');
  await title.hover();
  await expect(dates).toBeVisible();
  await expect.poll(() => landedOffset('22')).toBeCloseTo(120, 0);
});
