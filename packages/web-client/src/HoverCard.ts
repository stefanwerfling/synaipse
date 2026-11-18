export interface AnchorRect {
    left: number;
    top: number;
    bottom: number;
}

export interface ViewportSize {
    width: number;
    height: number;
}

export interface CardConstraints {
    cardWidth: number;
    cardMaxHeight: number;
    margin?: number;
}

export const positionHoverCard = (
    anchor: AnchorRect,
    viewport: ViewportSize,
    constraints: CardConstraints
): {left: number; top: number} => {
    const margin = constraints.margin ?? 8;

    let left = anchor.left;
    if (left + constraints.cardWidth > viewport.width - margin) {
        left = viewport.width - constraints.cardWidth - margin;
    }
    if (left < margin) {
        left = margin;
    }

    let top = anchor.bottom + margin;
    if (top + constraints.cardMaxHeight > viewport.height - margin) {
        const above = anchor.top - constraints.cardMaxHeight - margin;

        if (above >= margin) {
            top = above;
        } else {
            top = Math.max(margin, viewport.height - constraints.cardMaxHeight - margin);
        }
    }
    if (top < margin) {
        top = margin;
    }

    return {left, top};
};

export const clipSnippet = (markdown: string, maxChars: number): string => {
    const stripped = markdown
        .replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '')
        .replace(/```[\s\S]*?```/g, '⟨code⟩')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t, l) => (typeof l === 'string' ? l : t))
        .replace(/^#+\s+/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    if (stripped.length <= maxChars) {
        return stripped;
    }

    return `${stripped.slice(0, maxChars).trimEnd()}…`;
};