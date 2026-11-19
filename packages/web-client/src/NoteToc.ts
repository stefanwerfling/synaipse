import {extractToc, TocPanel} from './Toc.js';

/**
 * The outline column next to the note viewer (plan P7 / D2): builds the
 * entries from the rendered preview, scrolls to a clicked heading and
 * keeps the active entry in step with the scroll position (scroll-spy).
 */
export class NoteToc {
    private readonly panel: TocPanel;
    private observer: IntersectionObserver | null = null;
    private readonly visible = new Set<string>();
    private order = new Map<string, number>();
    private clickPinTimer: number | null = null;
    private flashTimer: number | null = null;
    private flashTarget: HTMLElement | null = null;
    /** The preview the entries were built from; null when no note is rendered. */
    private content: HTMLElement | null = null;

    public constructor(
        /** Gets `has-toc`; the outline column is inserted into it before `viewer`. */
        private readonly layoutRoot: HTMLElement,
        /** The scrolling viewport the headings live in. */
        private readonly viewer: HTMLElement
    ) {
        this.panel = new TocPanel({onNavigate: (id) => this.scrollToHeading(id)});
    }

    /** Rebuild from `content` (the rendered preview), or hide the outline when null or without headings. */
    public update(content: HTMLElement | null): void {
        this.disposeObserver();
        this.content = content;

        if (content === null) {
            this.hide();
            return;
        }

        const entries = extractToc(content);
        this.panel.setEntries(entries);

        if (entries.length === 0) {
            this.hide();
            return;
        }

        if (!this.panel.element.isConnected) {
            this.layoutRoot.insertBefore(this.panel.element, this.viewer);
        }
        this.layoutRoot.classList.add('has-toc');

        this.installObserver(entries.map((e) => e.id));
    }

    public destroy(): void {
        this.disposeObserver();
        if (this.flashTimer !== null) {
            window.clearTimeout(this.flashTimer);
            this.flashTimer = null;
        }
    }

    private hide(): void {
        if (this.content === null) this.panel.setEntries([]);
        this.panel.element.remove();
        this.layoutRoot.classList.remove('has-toc');
    }

    private heading(id: string): HTMLElement | null {
        const h = this.content?.querySelector(`[id="${id}"]`);
        return h instanceof HTMLElement ? h : null;
    }

    /**
     * Scroll the note viewport so the clicked heading sits at the top,
     * and pin the TOC's active state to the clicked entry until the
     * smooth scroll settles. Without the pin, the scroll-spy observer
     * would immediately re-highlight whichever heading falls inside its
     * band — usually the NEXT heading below the clicked one.
     *
     * Explicit `viewer.scrollTo` (not `scrollIntoView`) because both
     * `.viewer` and `.md-preview` carry `overflow-y: auto`, and browsers
     * disagree about which one `scrollIntoView` should touch.
     */
    private scrollToHeading(id: string): void {
        const target = this.heading(id);
        if (target === null) return;

        const viewerRect = this.viewer.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const offset = targetRect.top - viewerRect.top + this.viewer.scrollTop;

        this.panel.setActive(id);
        this.pinActive();
        this.flashHeading(target);

        this.viewer.scrollTo({
            top: Math.max(0, offset - 8),
            behavior: 'smooth'
        });
    }

    /**
     * Briefly highlight the target heading so the user sees where the
     * click landed. Re-triggering restarts the effect cleanly.
     */
    private flashHeading(target: HTMLElement): void {
        if (this.flashTimer !== null) {
            window.clearTimeout(this.flashTimer);
            this.flashTimer = null;
        }
        if (this.flashTarget !== null) {
            this.flashTarget.classList.remove('toc-flash');
        }
        // Force reflow so re-adding the class restarts the CSS animation.
        void target.offsetWidth;
        target.classList.add('toc-flash');
        this.flashTarget = target;
        this.flashTimer = window.setTimeout(() => {
            target.classList.remove('toc-flash');
            if (this.flashTarget === target) this.flashTarget = null;
            this.flashTimer = null;
        }, 1600);
    }

    /**
     * Suppress scroll-spy driven `setActive` calls for ~800ms so a
     * user-initiated navigation isn't clobbered by the observer picking
     * a nearby heading as the scroll passes through.
     */
    private pinActive(): void {
        if (this.clickPinTimer !== null) {
            window.clearTimeout(this.clickPinTimer);
        }
        this.clickPinTimer = window.setTimeout(() => {
            this.clickPinTimer = null;
            // After the pin lifts, resync from the current scroll pos.
            this.refreshActive();
        }, 800);
    }

    /**
     * Scroll-spy: track which headings intersect the top band of the
     * viewer viewport and mark the topmost visible one as active. The
     * band starts at viewport top and ends at 30% down (rootMargin
     * `0 0 -70% 0`) so a heading scrolled to the very top by a TOC
     * click stays inside the band and remains highlighted.
     */
    private installObserver(ids: readonly string[]): void {
        this.visible.clear();
        this.order = new Map(ids.map((id, i) => [id, i]));

        const headings: HTMLElement[] = [];
        for (const id of ids) {
            const h = this.heading(id);
            if (h !== null) headings.push(h);
        }

        if (headings.length === 0) return;

        this.observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                const id = (entry.target as HTMLElement).id;
                if (entry.isIntersecting) {
                    this.visible.add(id);
                } else {
                    this.visible.delete(id);
                }
            }

            this.refreshActive();
        }, {
            root: this.viewer,
            rootMargin: '0px 0px -70% 0px',
            threshold: 0
        });

        for (const h of headings) {
            this.observer.observe(h);
        }
    }

    private refreshActive(): void {
        // User just clicked a TOC entry — don't let the observer override
        // the deliberate selection while the smooth scroll runs.
        if (this.clickPinTimer !== null) {
            return;
        }

        if (this.visible.size === 0) {
            // Nothing in the band — pick whichever heading is furthest above
            // the top edge of the viewport instead of blanking the outline.
            this.panel.setActive(this.closestHeadingAboveViewport());
            return;
        }

        let best: string | null = null;
        let bestOrder = Infinity;
        for (const id of this.visible) {
            const order = this.order.get(id) ?? Infinity;
            if (order < bestOrder) {
                bestOrder = order;
                best = id;
            }
        }

        this.panel.setActive(best);
    }

    private closestHeadingAboveViewport(): string | null {
        if (this.content === null) return null;

        const viewerTop = this.viewer.getBoundingClientRect().top;
        let best: string | null = null;
        let bestTop = -Infinity;

        for (const id of this.order.keys()) {
            const h = this.heading(id);
            if (h === null) continue;
            const top = h.getBoundingClientRect().top - viewerTop;
            if (top <= 0 && top > bestTop) {
                bestTop = top;
                best = id;
            }
        }

        return best;
    }

    private disposeObserver(): void {
        if (this.observer !== null) {
            this.observer.disconnect();
            this.observer = null;
        }
        if (this.clickPinTimer !== null) {
            window.clearTimeout(this.clickPinTimer);
            this.clickPinTimer = null;
        }
        this.visible.clear();
        this.order.clear();
    }
}
