#!/usr/bin/env node
/**
 * One-off migration: repair project roadmap note links against the live vault.
 * Each `noteLinks` entry is resolved to an existing note (via the shared
 * @synaipse/core resolver, plus an auto-memory slug fallback for legacy
 * `project_*` names) and rewritten to its canonical wikilink (the note title).
 * References that resolve to nothing are dropped.
 *
 * Talks to the running dev API (default http://localhost:3001) so there is a
 * single source of truth and no second index.
 *
 *   node scripts/migrate-roadmap-links.mjs <project>          # dry-run one project
 *   node scripts/migrate-roadmap-links.mjs --all              # dry-run all projects
 *   node scripts/migrate-roadmap-links.mjs --all --apply      # write via PUT
 */
import {resolveNoteRefTarget, canonicalNoteLink} from '@synaipse/core';

const BASE = process.env.SYNAIPSE_API ?? 'http://localhost:3001';
const arg = process.argv[2];
const apply = process.argv.includes('--apply');
const recoverOn = !process.argv.includes('--no-recover'); // same-project token recovery
const keepPhantoms = process.argv.includes('--keep-phantoms'); // don't drop unresolved
if (!arg) {
    console.error('usage: migrate-roadmap-links.mjs <project|--all> [--apply] [--no-recover] [--keep-phantoms]');
    process.exit(1);
}

const getJson = async (path) => {
    const r = await fetch(`${BASE}${path}`);
    if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
    return r.json();
};

const baseName = (id) => {
    const last = id.slice(id.lastIndexOf('/') + 1);
    return last.endsWith('.md') ? last.slice(0, -3) : last;
};

/**
 * Legacy auto-memory slug → note. Strip a leading `project_`/`project-`,
 * turn `_` into `-`, lowercase, and match a UNIQUE note filename base.
 */
const norm = (s) => s.toLowerCase().replace(/^(project|lesson)[_-]/, '').replace(/\.md$/, '');
const toks = (s) => new Set(norm(s).split(/[^a-z0-9]+/).filter((t) => t.length > 2));
const subset = (a, b) => [...a].every((t) => b.has(t));

const resolveSlug = (ref, notes) => {
    const slug = norm(ref.trim()).replace(/_/g, '-');
    const hits = notes.filter((n) => baseName(n.id).toLowerCase() === slug);
    return hits.length === 1 ? hits[0] : null;
};

/**
 * Same-project recovery: within Memory/<project>/, find the note whose filename
 * tokens are a subset/superset of the slug tokens, uniquely (fewest extra
 * tokens). Precise because it never leaves the project folder.
 */
const recover = (project, ref, notes) => {
    const lt = toks(ref);
    if (lt.size === 0) return null;
    const inProj = notes.filter((n) => n.id.startsWith(`Memory/${project}/`));
    const hits = inProj.filter((n) => {
        const bt = toks(baseName(n.id));
        return bt.size > 0 && (subset(lt, bt) || subset(bt, lt));
    });
    if (hits.length === 0) return null;
    const dist = (n) => Math.abs(toks(baseName(n.id)).size - lt.size);
    hits.sort((a, b) => dist(a) - dist(b));
    const tied = hits.filter((n) => dist(n) === dist(hits[0]));
    return tied.length === 1 ? tied[0] : null;
};

const migrate = async (project, targets) => {
    const roadmap = await getJson(`/api/roadmap?project=${encodeURIComponent(project)}`);
    const fixed = [];
    const recovered = [];
    const kept = [];
    const dropped = [];

    const rewrite = (steps) => {
        for (const step of steps ?? []) {
            if (Array.isArray(step.noteLinks) && step.noteLinks.length > 0) {
                const out = [];
                for (const link of step.noteLinks) {
                    let target = resolveNoteRefTarget(link, targets) ?? resolveSlug(link, targets);
                    let viaRecover = false;
                    if (target === null && recoverOn) {
                        target = recover(project, link, targets);
                        viaRecover = target !== null;
                    }
                    if (target === null) {
                        dropped.push({step: step.id, link});
                        if (keepPhantoms) out.push(link); // leave the dead link untouched
                        continue;
                    }
                    const canonical = canonicalNoteLink(target);
                    if (canonical === link) kept.push({step: step.id, link});
                    else if (viaRecover) recovered.push({step: step.id, from: link, to: canonical});
                    else fixed.push({step: step.id, from: link, to: canonical});
                    if (!out.includes(canonical)) out.push(canonical);
                }
                step.noteLinks = out;
            }
            if (Array.isArray(step.children)) rewrite(step.children);
        }
    };
    rewrite(roadmap.steps);

    const dropAction = keepPhantoms ? 'KEEP' : 'DROP';
    console.log(
        `\n=== ${project}: fixed ${fixed.length} · recovered ${recovered.length} · kept ${kept.length} · ${dropAction.toLowerCase()} ${dropped.length} ===`
    );
    for (const f of fixed) console.log(`  fix  [${f.step}] "${f.from}"  →  "${f.to}"`);
    for (const r of recovered) console.log(`  rec  [${r.step}] "${r.from}"  →  "${r.to}"`);
    for (const d of dropped) console.log(`  ${dropAction} [${d.step}] "${d.link}"`);

    const changed = fixed.length > 0 || recovered.length > 0 || (!keepPhantoms && dropped.length > 0);
    if (apply && changed) {
        const put = await fetch(`${BASE}/api/roadmap?project=${encodeURIComponent(project)}`, {
            method: 'PUT',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({steps: roadmap.steps, active: roadmap.active})
        });
        if (!put.ok) throw new Error(`PUT ${project} → HTTP ${put.status}: ${await put.text()}`);
        console.log(`  ✅ applied`);
    }
    return {project, fixed: fixed.length, recovered: recovered.length, kept: kept.length, dropped: dropped.length};
};

const notes = await getJson('/api/notes');
const targets = notes.map((n) => ({id: n.id, title: n.title, aliases: n.aliases ?? []}));

let projects;
if (arg === '--all') {
    const {roadmaps} = await getJson('/api/roadmaps');
    projects = roadmaps.map((r) => r.project);
} else {
    projects = [arg];
}

console.log(
    `\n### roadmap link migration (${apply ? 'APPLY' : 'DRY-RUN'}${keepPhantoms ? ', keep-phantoms' : ''}${recoverOn ? '' : ', no-recover'}) — ${projects.length} project(s) ###`
);
const totals = {fixed: 0, recovered: 0, kept: 0, dropped: 0};
for (const p of projects) {
    const r = await migrate(p, targets);
    totals.fixed += r.fixed;
    totals.recovered += r.recovered;
    totals.kept += r.kept;
    totals.dropped += r.dropped;
}
console.log(
    `\n### TOTAL: fixed ${totals.fixed} · recovered ${totals.recovered} · kept ${totals.kept} · ${keepPhantoms ? 'kept-phantom' : 'dropped'} ${totals.dropped} ###`
);
if (!apply) console.log('Dry-run only. Re-run with --apply to write these changes via PUT.');
