import {AxeBuilder} from '@axe-core/playwright';
import {expect, noteItems, test} from './fixtures';

test('loads the notes of the fixture vault', async ({page, errors}) => {
    await page.goto('/');
    await expect(page.getByText('5 notes')).toBeVisible();
    await expect(noteItems(page)).toHaveCount(5);
    expect(errors).toEqual([]);
});

test('opens a note, follows a wikilink, shows backlinks', async ({page, errors}) => {
    await page.goto('/');
    await noteItems(page).filter({hasText: 'Architecture'}).click();
    await expect(page).toHaveURL(/#\/notes\/Memory\/demo\/Architecture\.md$/);
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', {name: 'Architecture', level: 1}).first()).toBeVisible();
    await expect(main.getByRole('heading', {name: /Linked from 2/})).toBeVisible();

    await main.getByRole('button', {name: 'Search Engine', exact: true}).click();
    await expect(page).toHaveURL(/Search%20Engine\.md$/);
    await expect(main.getByText('quokka-shaped tokenizer')).toBeVisible();
    expect(errors).toEqual([]);
});

test('a deep link opens the note directly', async ({page, errors}) => {
    await page.goto('/#/notes/Memory/demo/Decision%20Log.md');
    await expect(page.getByRole('main').getByText('keep the smoke vault tiny')).toBeVisible();
    expect(errors).toEqual([]);
});

test('fulltext search finds a note and opens it', async ({page, errors}) => {
    await page.goto('/');
    await page.getByRole('searchbox', {name: 'Search notes'}).fill('quokka');
    const hit = page.locator('.search-result-title', {hasText: 'Search Engine'});
    await expect(hit).toBeVisible();
    await hit.click();
    await expect(page).toHaveURL(/Search%20Engine\.md$/);
    expect(errors).toEqual([]);
});

test('every top-level tab renders without errors', async ({page, errors}) => {
    await page.goto('/');
    await expect(noteItems(page)).toHaveCount(5);
    const nav = page.getByRole('navigation');
    const tabs = await nav.getByRole('button').allInnerTexts();
    expect(tabs.length).toBeGreaterThan(5);
    for (const name of tabs.map((t) => t.trim()).filter((t) => t.length > 0)) {
        await nav.getByRole('button', {name, exact: true}).click();
        await page.waitForTimeout(300);
    }
    await nav.getByRole('button', {name: 'Graph', exact: true}).click();
    await expect(page.locator('canvas').first()).toBeVisible();
    expect(errors).toEqual([]);
});

test('theme toggle switches the root theme', async ({page, errors}) => {
    await page.goto('/');
    const root = page.locator('#root');
    const before = await root.getAttribute('data-theme');
    await page.getByRole('button', {name: /Switch to (light|dark) theme/}).click();
    await expect(root).not.toHaveAttribute('data-theme', before ?? '');
    expect(errors).toEqual([]);
});

const A11Y_VIEWS = [
    '#/notes/Memory/demo/Architecture.md',
    '#/graph',
    '#/canvas',
    '#/inbox',
    '#/roadmap',
    '#/benchmarks',
    '#/chat',
    '#/jobs',
    '#/activity',
    '#/audit',
    '#/consent'
];

for (const theme of ['dark', 'light'] as const) {
    test(`no accessibility violations, colour contrast included (${theme})`, async ({page, errors}) => {
        await page.addInitScript((t) => localStorage.setItem('synaipse-theme', t), theme);
        const found: string[] = [];
        for (const view of A11Y_VIEWS) {
            await page.goto(`/${view}`);
            await expect(page.getByRole('navigation')).toBeVisible();
            await page.waitForTimeout(600);
            const result = await new AxeBuilder({page}).withTags(['wcag2a', 'wcag2aa']).analyze();
            for (const v of result.violations) {
                for (const node of v.nodes) found.push(`${view} ${v.impact} ${v.id}: ${node.target.join(' ')}`);
            }
        }
        expect(found).toEqual([]);
        expect(errors).toEqual([]);
    });
}

for (const theme of ['dark', 'light'] as const) {
    test(`selected tag chips in the graph filter are readable (${theme})`, async ({page, errors}) => {
        await page.addInitScript((t) => localStorage.setItem('synaipse-theme', t), theme);
        await page.goto('/#/graph');
        const open = page.getByRole('button', {name: /^Tags · /});
        await expect(open).toBeVisible();
        const total = Number((await open.innerText()).replace(/\D+/g, ''));
        for (let i = 0; i < total; i++) {
            await page.getByRole('button', {name: /^Tags · /}).click();
            await page.locator('.tag-picker-item[aria-pressed="false"]').first().click();
            await page.keyboard.press('Escape');
        }
        await expect(page.locator('.chip.tag-fill')).toHaveCount(total);
        const result = await new AxeBuilder({page}).include('.chip.tag-fill').withRules(['color-contrast']).analyze();
        expect(result.violations.flatMap((v) => v.nodes.map((n) => n.target.join(' ')))).toEqual([]);
        expect(errors).toEqual([]);
    });
}
