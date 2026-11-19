import type {ActivityPanel} from './ActivityPanel.js';
import type {AuditPanel} from './AuditPanel.js';
import type {BenchmarksPanel} from './BenchmarksPanel.js';
import type {CanvasPanel} from './CanvasPanel.js';
import type {ChatPanel} from './ChatPanel.js';
import type {InboxPanel} from './InboxPanel.js';
import type {JobsPanel} from './JobsPanel.js';
import type {RoadmapPanel} from './RoadmapPanel.js';

/**
 * Tab registry (plan P3 / D1). The topbar is generated from TAB_DEFS, and
 * every panel except Notes, Graph and Consent is constructed — and its
 * module imported — only when its tab is first opened.
 */
export const TABS = ['notes', 'graph', 'canvas', 'inbox', 'roadmap', 'benchmarks', 'chat', 'jobs', 'activity', 'audit', 'consent'] as const;
export type Tab = typeof TABS[number];

export interface TabDef {
    id: Tab;
    label: string;
    title?: string;
}

export const TAB_DEFS: readonly TabDef[] = [
    {id: 'notes', label: 'Notes'},
    {id: 'graph', label: 'Graph'},
    {id: 'canvas', label: 'Canvas'},
    {id: 'inbox', label: 'Inbox', title: 'remember-Einträge der Agenten: in Notizen übernehmen oder verwerfen'},
    {id: 'roadmap', label: 'Roadmap', title: 'Per-Projekt Roadmap — KI-geplante Umsetzungsschritte'},
    {id: 'benchmarks', label: 'Benchmarks', title: 'Per-Projekt Benchmarks — Speed-/Qualitäts-Vergleiche nach Maschine, Backend, Technik'},
    {id: 'chat', label: 'Chat'},
    {id: 'jobs', label: 'Jobs'},
    {id: 'activity', label: 'Activity'},
    {id: 'audit', label: 'Audit', title: 'DSGVO Layer 4 — Audit-Log externer LLM-Aufrufe'},
    {id: 'consent', label: 'Consent', title: 'Just-in-time consent requests from MCP note reads'}
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
    jobs: async (ctx) => new (await import('./JobsPanel.js')).JobsPanel({onChange: ctx.notesChanged}),
    activity: async (ctx) => new (await import('./ActivityPanel.js')).ActivityPanel({onOpenNote: ctx.openNote}),
    audit: async () => new (await import('./AuditPanel.js')).AuditPanel()
};
