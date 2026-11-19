import type {Frontmatter, NoteId} from '@synaipse/core';
import {ProjectScopeError} from '@synaipse/core';

/**
 * Project scoping for MCP-style writes: every project lives under
 * `Memory/<project>/` and carries the tag `project/<project>`. The
 * project comes per call (URL, header) or from the configured default.
 */
export class ProjectScope {
    public constructor(
        /** SYNAIPSE_PROJECT; null when the server runs without one. */
        public readonly defaultProject: string | null,
        public readonly configExtraTags: readonly string[]
    ) {}

    public get(override?: string | null): string | null {
        return override ?? this.defaultProject;
    }

    public require(op: string, override?: string | null): string {
        const resolved = override ?? this.defaultProject;

        if (resolved === null || resolved === '') {
            throw new ProjectScopeError(
                `${op} requires a project context. Set SYNAIPSE_PROJECT in the MCP server env, ` +
                `or pass it per-request via URL path /mcp/<project> or header X-Synaipse-Project.`
            );
        }

        return resolved;
    }

    public folder(project: string): string {
        return `Memory/${project}/`;
    }

    public tag(project: string): string {
        return `project/${project}`;
    }

    public assertInProject(id: NoteId, op: string, override?: string | null): void {
        const project = this.require(op, override);
        const prefix = this.folder(project);

        if (!id.startsWith(prefix)) {
            throw new ProjectScopeError(
                `${op} blocked: ${id} is outside project scope (${project}). Project notes live under ${prefix}.`
            );
        }
    }

    public normaliseWritePath(rawPath: string, project: string): string {
        const trimmed = rawPath.replace(/^\/+/, '');

        if (trimmed.length === 0) {
            throw new ProjectScopeError('write path is empty');
        }

        const projectPrefix = this.folder(project);

        if (trimmed.startsWith(projectPrefix)) {
            return trimmed;
        }

        if (trimmed.startsWith('Memory/')) {
            const rest = trimmed.slice('Memory/'.length);
            const firstSlash = rest.indexOf('/');

            if (firstSlash > 0) {
                return `${projectPrefix}${rest.slice(firstSlash + 1)}`;
            }

            return `${projectPrefix}${rest}`;
        }

        return `${projectPrefix}${trimmed}`;
    }

    public applyToFrontmatter(
        frontmatter: Frontmatter | undefined,
        project: string,
        extraTags: readonly string[] = []
    ): Frontmatter {
        const base: Frontmatter = frontmatter ? {...frontmatter} : {};
        const projectTag = this.tag(project);
        const existingTags = Array.isArray(base.tags)
            ? base.tags.filter((t): t is string => typeof t === 'string')
            : [];

        const merged = [...existingTags];

        for (const tag of [projectTag, ...extraTags]) {
            if (!merged.includes(tag)) {
                merged.push(tag);
            }
        }

        base.project = project;
        base.tags = merged;

        return base;
    }

    public resolveExtraTags(perCall: readonly string[] | undefined): readonly string[] {
        return perCall ?? this.configExtraTags;
    }
}
