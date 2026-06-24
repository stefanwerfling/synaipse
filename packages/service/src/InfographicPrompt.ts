/**
 * Prompt-appendable guide that tells a content-generating LLM (chat,
 * research, …) it MAY render structured information as an `@antv/
 * infographic` block. The web preview (and the chat-message render
 * path) auto-instantiate the SVG layout for these blocks.
 *
 * Why a curated subset and not the full ~93 built-in templates:
 *   - Token budget — every chat / research turn carries the system
 *     prompt; a full template dump would be ~600+ tokens of context
 *     bloat with diminishing return.
 *   - Schema discoverability — the data-block shape differs per
 *     family (list-* uses title/desc/lists, sequence-* similar,
 *     compare-* has left/right, chart-* has values, …). The curated
 *     8 cover all major families so the LLM has a *pattern* to
 *     adapt rather than memorising every shape.
 *
 * The trailing hint "90+ more templates exist, write any layout
 * name" lets the LLM stretch to other templates by guessing the
 * name. If it guesses wrong the preview renders an error message in
 * the stub div (see MarkdownPreview.applyAntvInfographics) instead
 * of silently failing — a self-correcting feedback loop on the next
 * turn.
 */

export const INFOGRAPHIC_GUIDE = `

---

VISUAL INFOGRAPHICS (optional, use sparingly)

When your reply contains structured information that genuinely benefits
from visual layout — roadmaps, step flows, comparisons, hierarchies,
timelines, KPI dashboards — you MAY embed an infographic in your
markdown reply using this container syntax:

\`\`\`
::: infographic <layout-name>
data
  title <Main title>
  desc <Short subtitle>
  lists
    - label <Item 1 label>
      value <number, optional>
      desc <Item 1 short description>
      icon <icon-name, optional>
    - label <Item 2 label>
      value <number>
      desc <…>
:::
\`\`\`

Indentation matters: 2 spaces per nesting level, dash + space for list
items. Don't quote string values. \`value\` is a number, other fields are
text. The closing \`:::\` must be on its own line.

CURATED LAYOUTS (pick one of these — they cover the common shapes):

- \`list-row-horizontal-icon-arrow\` — horizontal step flow with icons
  and arrows. Best for: roadmaps, customer journeys, pipelines.
  Schema: title, desc, lists[label, value?, desc?, icon?]

- \`list-row-circular-progress\` — rows with circular progress rings.
  Best for: KPI snapshots, completion status, scorecards.
  Schema: title, desc, lists[label, value (0-100), desc?]

- \`list-grid-progress-card\` — grid of cards with progress bars.
  Best for: project dashboards, multi-track status.
  Schema: title, desc, lists[label, value, desc?]

- \`sequence-timeline-simple\` — vertical timeline of events.
  Best for: milestones, version history, project log.
  Schema: title, desc, lists[label (date / version), desc (event)]

- \`sequence-steps-simple\` — numbered step list.
  Best for: tutorials, how-to, workflows.
  Schema: title, desc, lists[label, desc]

- \`compare-hierarchy-left-right-circle-node-pill-badge\` — left-vs-right
  side-by-side comparison. Best for: A/B compare, before/after, pros/cons.
  Schema: title, desc, lefts[label, desc], rights[label, desc]

- \`relation-network-icon-badge\` — node/edge diagram with icons.
  Best for: dependency graphs, system architecture, relationships.
  Schema: title, nodes[id, label, icon?], edges[from, to, label?]

- \`hierarchy-mindmap\` — central topic with radial branches.
  Best for: brainstorms, topic decomposition, knowledge maps.
  Schema: title, root[label, children[label, children?]]

NOTES ON USAGE:
- The renderer (\`@antv/infographic\`) ships ~90 templates total. Beyond
  the curated 8 above, other available families include \`chart-*\`,
  \`list-pyramid-*\`, \`list-column-*\`, \`list-grid-*\`, \`sequence-*\`,
  \`relation-*\`, \`hierarchy-*\`. If a curated layout doesn't fit, you
  may write any layout name from these families; if the name doesn't
  exist the preview will show an error message and you can pick a
  different one on the next turn.
- Icons (\`icon company-021_v1_lineal\`) are optional. If unsure of the
  exact name, omit the \`icon\` field — a placeholder renders instead.
- Use infographics ONLY when the visual layout adds clarity. For prose
  answers, plain text remains the right default. Never embed an
  infographic just because you can.
- Place the infographic inside your reply where it would naturally
  appear in a long-form answer; you can mix it with normal markdown
  prose, headings, citations etc.
`;
