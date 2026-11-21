import type {ActivityPanel} from './ActivityPanel.js';
import type {AuditPanel} from './AuditPanel.js';
import type {BenchmarksPanel} from './BenchmarksPanel.js';
import type {CanvasPanel} from './CanvasPanel.js';
import type {ChatPanel} from './ChatPanel.js';
import type {InboxPanel} from './InboxPanel.js';
import type {EventStream} from './Events.js';
import type {JobsPanel} from './JobsPanel.js';
import type {RoadmapPanel} from './RoadmapPanel.js';
import {defineMessages} from './I18n.js';

/**
 * Tab registry (plan P3 / D1). The topbar is generated from TAB_DEFS, and
 * every panel except Notes, Graph and Consent is constructed — and its
 * module imported — only when its tab is first opened.
 */
export const TABS = ['notes', 'graph', 'canvas', 'inbox', 'roadmap', 'benchmarks', 'chat', 'jobs', 'activity', 'audit', 'consent'] as const;
export type Tab = typeof TABS[number];

export interface TabDef {
    id: Tab;
    /** Read at render time, so it follows the UI language. */
    readonly label: string;
    readonly title?: string;
}

const t = defineMessages('tabs', {
    notes: 'Notes',
    graph: 'Graph',
    canvas: 'Canvas',
    inbox: 'Inbox',
    inboxTitle: 'remember entries from agents: merge into notes or discard',
    roadmap: 'Roadmap',
    roadmapTitle: 'Per-project roadmap — AI-planned implementation steps',
    benchmarks: 'Benchmarks',
    benchmarksTitle: 'Per-project benchmarks — speed and quality comparisons by machine, backend, technique',
    chat: 'Chat',
    jobs: 'Jobs',
    activity: 'Activity',
    audit: 'Audit',
    auditTitle: 'GDPR layer 4 — audit log of external LLM calls',
    consent: 'Consent',
    consentTitle: 'Just-in-time consent requests from MCP note reads'
});

type TitleKey = 'inboxTitle' | 'roadmapTitle' | 'benchmarksTitle' | 'auditTitle' | 'consentTitle';

const tab = (id: Tab, titleKey?: TitleKey): TabDef => {
    const def = {
        id,
        get label() {
            return t(id);
        }
    };
    // A getter, not a spread: spreading would read the title once, now.
    if (titleKey !== undefined) Object.defineProperty(def, 'title', {get: () => t(titleKey), enumerable: true});
    return def;
};

export const TAB_DEFS: readonly TabDef[] = [
    tab('notes'),
    tab('graph'),
    tab('canvas'),
    tab('inbox', 'inboxTitle'),
    tab('roadmap', 'roadmapTitle'),
    tab('benchmarks', 'benchmarksTitle'),
    tab('chat'),
    tab('jobs'),
    tab('activity'),
    tab('audit', 'auditTitle'),
    tab('consent', 'consentTitle')
];

/** What every tab panel offers the app shell. */
export interface PanelView {
    readonly element: HTMLElement;
    onShow?(): void | Promise<void>;
    onHide?(): void;
    destroy?(): void;
}

/** App callbacks the lazily built panels need. */
export interface PanelContext {
    /** Open a note by id and switch to the Notes tab. */
    openNote(noteId: string): void;
    /** Resolve a title/alias/path reference and open it (tells the user when nothing matches). */
    openRef(ref: string): void;
    resolveNoteLink(ref: string): string | null;
    /** Notes were created or changed outside the editor (jobs, imports). */
    notesChanged(): void;
    /** Something a route names changed inside a panel (roadmap project). */
    routeChanged(): void;
    /** The page's one event stream (named events such as `job`). */
    readonly events: EventStream;
}

export interface LazyPanels {
    canvas: CanvasPanel;
    inbox: InboxPanel;
    roadmap: RoadmapPanel;
    benchmarks: BenchmarksPanel;
    chat: ChatPanel;
    jobs: JobsPanel;
    activity: ActivityPanel;
    audit: AuditPanel;
}

export type LazyTab = keyof LazyPanels;

export const isLazyTab = (tab: Tab): tab is LazyTab => tab in PANEL_FACTORIES;

export const PANEL_FACTORIES: {[K in LazyTab]: (ctx: PanelContext) => Promise<LazyPanels[K]>} = {
    canvas: async (ctx) => new (await import('./CanvasPanel.js')).CanvasPanel({onOpenNote: ctx.openNote}),
    inbox: async (ctx) => new (await import('./InboxPanel.js')).InboxPanel({
        onOpenNote: ctx.openNote,
        resolveNoteLink: ctx.resolveNoteLink,
        onChange: ctx.notesChanged
    }),
    roadmap: async (ctx) => new (await import('./RoadmapPanel.js')).RoadmapPanel({
        onOpenNote: ctx.openRef,
        resolveNoteLink: ctx.resolveNoteLink,
        onProjectChange: ctx.routeChanged
    }),
    benchmarks: async (ctx) => new (await import('./BenchmarksPanel.js')).BenchmarksPanel({onOpenNote: ctx.openRef}),
    chat: async (ctx) => new (await import('./ChatPanel.js')).ChatPanel({
        onOpenNote: (noteId) => {
            // Research results put the URL into noteId — open it externally.
            if (noteId.startsWith('http://') || noteId.startsWith('https://')) {
                window.open(noteId, '_blank', 'noopener,noreferrer');
                return;
            }
            ctx.openNote(noteId);
        }
    }),
    jobs: async (ctx) => new (await import('./JobsPanel.js')).JobsPanel({onChange: ctx.notesChanged, events: ctx.events}),
    activity: async (ctx) => new (await import('./ActivityPanel.js')).ActivityPanel({onOpenNote: ctx.openNote}),
    audit: async () => new (await import('./AuditPanel.js')).AuditPanel()
};
