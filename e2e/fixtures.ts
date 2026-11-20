import {test as base, expect, type Page} from '@playwright/test';

/** Page errors and console errors collected per test; a test fails if any appear. */
export const test = base.extend<{errors: string[]}>({
    errors: async ({page}, use) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
        page.on('console', (m) => {
            if (m.type() === 'error') errors.push(`console: ${m.text()}`);
        });
        await use(errors);
        expect(errors, 'no page or console errors').toEqual([]);
    }
});

export {expect};

export const noteItems = (page: Page) => page.locator('.note-list-item');
