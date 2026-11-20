/**
 * UI language (plan P7 / C3). No library. Each module keeps its English
 * messages next to the code under a namespace; the German tables live in
 * I18nDe.ts, a chunk of its own that is loaded only when German is
 * active, so the initial bundle carries one language.
 *
 *   const t = defineMessages('notes', {
 *       save: 'Save',
 *       saved: 'Saved {count} note|Saved {count} notes'
 *   });
 *   t('saved', {count: 3});
 *
 *   // I18nDe.ts
 *   notes: {save: 'Speichern', saved: '{count} Notiz gespeichert|{count} Notizen gespeichert'}
 *
 * `{name}` is replaced by params.name. A message with `|` is a plural
 * pair (one|other), picked by params.count. A key missing in German
 * falls back to English; test/i18n.test.ts insists on complete tables
 * with matching placeholders. English is the default (decision §13.5);
 * the language comes from the host's mount option, else the stored
 * user choice.
 */

export type Locale = 'en' | 'de';
export const LOCALES: readonly Locale[] = ['en', 'de'];
export const DEFAULT_LOCALE: Locale = 'en';

/** Native names for the language switcher. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {en: 'English', de: 'Deutsch'};

const STORAGE_KEY = 'synaipse.locale';

export const isLocale = (value: unknown): value is Locale => value === 'en' || value === 'de';

const readStored = (): Locale | null => {
    try {
        const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
        return isLocale(raw) ? raw : null;
    } catch {
        return null;
    }
};

const writeStored = (locale: Locale): void => {
    try {
        globalThis.localStorage?.setItem(STORAGE_KEY, locale);
    } catch {
        // storage blocked: the choice lasts for this page only
    }
};

let current: Locale = DEFAULT_LOCALE;
const listeners = new Set<(locale: Locale) => void>();

export type MessageTable = Readonly<Record<string, string>>;
/** Translations by locale and namespace; English is never stored here, it is the code. */
const translations: Partial<Record<Locale, Record<string, MessageTable>>> = {};

/** Install the tables of one language (the German chunk does this; tests may too). */
export const registerMessages = (locale: Locale, namespace: string, table: MessageTable): void => {
    (translations[locale] ??= {})[namespace] = table;
};

/** Load the tables a language needs. English is built in. */
export const loadLocale = async (locale: Locale): Promise<void> => {
    if (locale === 'de' && translations.de === undefined) {
        const {DE} = await import('./I18nDe.js');
        for (const [namespace, table] of Object.entries(DE)) registerMessages('de', namespace, table);
    }
};

export const getLocale = (): Locale => current;

/**
 * Pick the starting language: the host's choice wins, then what the user
 * chose before, else English. Does not notify listeners.
 */
export const initLocale = async (fromHost?: Locale): Promise<Locale> => {
    const locale = fromHost ?? readStored() ?? DEFAULT_LOCALE;
    await loadLocale(locale);
    current = locale;
    return current;
};

/**
 * Switch the language once its tables are loaded; `remember` stores it as
 * the user's choice (the switcher does, a host does not).
 */
export const setLocale = async (locale: Locale, remember = false): Promise<void> => {
    if (remember) writeStored(locale);
    await loadLocale(locale);
    if (locale === current) return;
    current = locale;
    for (const listener of [...listeners]) listener(locale);
};

/** Subscribe to language changes; returns the unsubscribe. */
export const onLocaleChange = (listener: (locale: Locale) => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

export type MessageParams = Readonly<Record<string, string | number>>;

const pluralRules = new Map<Locale, Intl.PluralRules>();
const pluralOf = (locale: Locale, count: number): Intl.LDMLPluralRule => {
    let rules = pluralRules.get(locale);
    if (rules === undefined) {
        rules = new Intl.PluralRules(locale);
        pluralRules.set(locale, rules);
    }
    return rules.select(count);
};

/** Resolve plural pair and placeholders of one message. */
export const formatMessage = (message: string, params: MessageParams | undefined, locale: Locale): string => {
    let text = message;
    const bar = text.indexOf('|');
    if (bar !== -1) {
        const count = Number(params?.count ?? 0);
        text = pluralOf(locale, count) === 'one' ? text.slice(0, bar) : text.slice(bar + 1);
    }
    if (params === undefined) return text;
    return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
        const value = params[name];
        return value === undefined ? whole : String(value);
    });
};

export type Translate<K extends string> = (key: K, params?: MessageParams) => string;

/**
 * Bind the English table of a namespace. The returned `t` reads the
 * current language on every call, so text built after a language switch
 * is already translated.
 */
export const defineMessages = <M extends Record<string, string>>(
    namespace: string,
    en: M
): Translate<Extract<keyof M, string>> =>
    (key, params) => formatMessage(translations[current]?.[namespace]?.[key] ?? en[key] ?? key, params, current);

/** Words that many modules share. */
export const tc = defineMessages('common', {
    cancel: 'Cancel',
    close: 'Close',
    save: 'Save',
    delete: 'Delete',
    edit: 'Edit',
    open: 'Open',
    add: 'Add',
    create: 'Create',
    remove: 'Remove',
    rename: 'Rename',
    retry: 'Retry',
    refresh: 'Refresh',
    loading: 'Loading…',
    ok: 'OK',
    yes: 'Yes',
    no: 'No',
    none: 'none',
    copied: 'Copied'
});

/** Date and time in the UI language. */
export const formatDateTime = (value: Date | number | string, opts: Intl.DateTimeFormatOptions = {dateStyle: 'medium', timeStyle: 'short'}): string =>
    new Intl.DateTimeFormat(current === 'de' ? 'de-DE' : 'en-US', opts).format(new Date(value));

/** A number in the UI language (thousands separators). */
export const formatNumber = (value: number, opts?: Intl.NumberFormatOptions): string =>
    new Intl.NumberFormat(current === 'de' ? 'de-DE' : 'en-US', opts).format(value);
