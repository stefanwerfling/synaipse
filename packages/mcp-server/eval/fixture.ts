/**
 * Fixture vault for the LLM-usability eval (plan P8 / B7): two projects
 * (kestrel, harbor) plus shared knowledge, written the way agents write
 * memory. It deliberately contains the hard cases of a real vault:
 * superseded decisions next to their successors, near-duplicates, an
 * expired and a low-confidence note, the same topic in both projects and
 * raw inbox entries. Changing it changes the baseline.
 */

export interface EvalNote {
    path: string;
    title: string;
    body: string;
    tags?: readonly string[];
    /** Extra frontmatter (supersedes, confidence, valid_until, type, updated, ...). */
    fm?: Readonly<Record<string, unknown>>;
}

export type EvalCategory = 'lookup' | 'paraphrase' | 'current' | 'scoped' | 'trust';

export interface EvalQuestion {
    id: string;
    category: EvalCategory;
    /** The question as a user would ask it. */
    question: string;
    /** What the simulated agent types into synaipse_search. */
    query: string;
    /** Notes that answer the question; the first one is the best answer. */
    relevant: readonly string[];
    /**
     * Notes that must not outrank the best answer: superseded, expired or
     * low-confidence notes on the same topic, or the other project's note.
     */
    outdated?: readonly string[];
}

const K = 'Memory/kestrel';
const H = 'Memory/harbor';

export const EVAL_NOTES: readonly EvalNote[] = [
    // ---- kestrel: decisions, incl. superseded ones ------------------------
    {
        path: `${K}/decisions/session-store-redis.md`,
        title: 'Session store: Redis',
        tags: ['decision', 'auth', 'redis'],
        fm: {type: 'decision', updated: '2025-03-02'},
        body: 'Kestrel keeps user sessions in Redis with a 24 h TTL. Reason: the API runs on three nodes and sessions must be shared. Sticky sessions were rejected because deploys drop them.'
    },
    {
        path: `${K}/decisions/session-store-postgres.md`,
        title: 'Session store: Postgres instead of Redis',
        tags: ['decision', 'auth', 'postgres'],
        fm: {type: 'decision', updated: '2025-09-14', supersedes: ['Session store: Redis']},
        body: 'Since September 2025 Kestrel stores sessions in the Postgres table `sessions` (unlogged, TTL via a cron job every 10 min). Redis was dropped to remove one moving part; the session load is about 40 writes per second, which Postgres handles easily. Background: [[Postgres unlogged tables]].'
    },
    {
        path: `${K}/decisions/frontend-framework.md`,
        title: 'Frontend framework: Vue 2',
        tags: ['decision', 'frontend'],
        fm: {type: 'decision', updated: '2024-05-10'},
        body: 'The Kestrel admin UI is built with Vue 2 and Vuex. The team knows it and the component library (Vuetify 2) covers the forms we need.'
    },
    {
        path: `${K}/decisions/frontend-framework-svelte.md`,
        title: 'Frontend framework: migrate the admin UI to Svelte 5',
        tags: ['decision', 'frontend'],
        fm: {type: 'decision', updated: '2025-11-02', supersedes: ['Frontend framework: Vue 2']},
        body: 'Vue 2 is end of life. The admin UI is being migrated to Svelte 5 with runes; new screens are Svelte only, old Vue screens are ported page by page behind the `/next` route. Primer: [[Svelte 5 runes]].'
    },
    {
        path: `${K}/decisions/api-versioning.md`,
        title: 'API versioning via URL prefix',
        tags: ['decision', 'api'],
        fm: {type: 'decision', updated: '2025-01-20'},
        body: 'Public Kestrel endpoints are versioned with a URL prefix (`/v1/`, `/v2/`). Header-based versioning was rejected because the CDN cache key ignores custom headers. A version is supported for 12 months after its successor ships.'
    },
    {
        path: `${K}/decisions/background-jobs.md`,
        title: 'Background jobs with pg-boss',
        tags: ['decision', 'jobs', 'postgres'],
        fm: {type: 'decision', updated: '2025-06-30'},
        body: 'Kestrel runs background jobs (emails, PDF invoices, webhook retries) with pg-boss on the main Postgres. A separate queue (RabbitMQ) was considered and rejected: one more service to operate for under 5k jobs a day.'
    },
    {
        path: `${K}/decisions/feature-flags.md`,
        title: 'Feature flags in the config table',
        tags: ['decision', 'release'],
        fm: {type: 'decision', updated: '2025-04-11'},
        body: 'Feature flags live in the `config` table, read once per request and cached for 30 s. Each flag has an owner and a removal date; flags older than 90 days show up in the weekly cleanup report.'
    },
    // ---- kestrel: bugs and incidents --------------------------------------
    {
        path: `${K}/bugs/invoice-pdf-timeout.md`,
        title: 'Invoice PDF generation times out',
        tags: ['bug', 'jobs', 'pdf'],
        fm: {type: 'bug', updated: '2025-07-08'},
        body: 'Invoices with more than 400 line items took over 60 s in headless Chromium and hit the job timeout. Fix: render the line-item table as a separate HTML page per 200 rows and merge the PDFs with [[pdf-lib]]. Generation for 1000 rows now takes 9 s.'
    },
    {
        path: `${K}/bugs/timezone-billing-cutoff.md`,
        title: 'Billing cutoff off by one day for US customers',
        tags: ['bug', 'billing', 'time'],
        fm: {type: 'bug', updated: '2025-08-19'},
        body: 'The monthly billing cutoff used the server time (UTC). Customers in US time zones were billed a day early. Fix: compute the cutoff in the account time zone stored in `accounts.tz`, with Luxon.'
    },
    {
        path: `${K}/bugs/webhook-retry-storm.md`,
        title: 'Webhook retries flooded a customer endpoint',
        tags: ['bug', 'incident', 'webhooks'],
        fm: {type: 'bug', updated: '2025-10-03'},
        body: 'A customer endpoint returned 500 for two hours and every webhook was retried immediately, 12k requests per minute. Retries now use exponential backoff starting at 30 s, capped at 6 h, with jitter, and an endpoint is paused after 50 consecutive failures. Pattern: [[Retry with exponential backoff and jitter]].'
    },
    {
        path: `${K}/bugs/csv-import-encoding.md`,
        title: 'CSV import breaks umlauts',
        tags: ['bug', 'import'],
        fm: {type: 'bug', updated: '2025-02-14'},
        body: 'Excel exports CSV as Windows-1252 by default, so ä/ö/ü turned into replacement characters. The importer now sniffs the encoding with chardet and converts to UTF-8 before parsing.'
    },
    // ---- kestrel: how-tos, architecture, people ----------------------------
    {
        path: `${K}/howto/local-setup.md`,
        title: 'Kestrel local development setup',
        tags: ['howto', 'setup'],
        fm: {type: 'note', updated: '2025-09-20'},
        body: 'Run `docker compose up db mail` for Postgres and Mailpit, then `pnpm install` and `pnpm dev`. Seed data: `pnpm db:seed` creates the admin user admin@kestrel.test. The API listens on :4000, the admin UI on :5173.'
    },
    {
        path: `${K}/howto/release.md`,
        title: 'Kestrel release process',
        tags: ['howto', 'release'],
        fm: {type: 'note', updated: '2025-10-15'},
        body: 'Releases go out on Tuesdays. Tag `vX.Y.Z` on main, CI builds the images and deploys to staging; production deploy is a manual approval in the pipeline. Database migrations run before the new pods start and must be backwards compatible for one release.'
    },
    {
        path: `${K}/howto/rotate-stripe-key.md`,
        title: 'Rotate the Stripe API key',
        tags: ['howto', 'billing', 'secrets'],
        fm: {type: 'note', updated: '2025-05-27'},
        body: 'Create a restricted key in the Stripe dashboard, store it in Vault under `kv/kestrel/stripe`, restart the billing worker, then revoke the old key after one hour without errors in the billing dashboard.'
    },
    {
        path: `${K}/architecture/overview.md`,
        title: 'Kestrel architecture overview',
        tags: ['architecture'],
        fm: {type: 'concept', updated: '2025-09-30'},
        body: 'Kestrel is a B2B invoicing app: a Node API (Fastify), Postgres 16, the admin UI and a worker process for jobs. Files go to S3-compatible storage (MinIO in dev). Auth is email + password with optional TOTP; SSO via SAML for enterprise accounts. Details: [[Multi-tenancy with row level security]], [[Background jobs with pg-boss]], [[Kestrel release process]].'
    },
    {
        path: `${K}/architecture/multi-tenancy.md`,
        title: 'Multi-tenancy with row level security',
        tags: ['architecture', 'postgres', 'security'],
        fm: {type: 'concept', updated: '2025-03-18'},
        body: 'Every table has an `account_id` column and Postgres row level security policies. The API sets `app.account_id` per transaction; a missing setting makes every query return no rows instead of leaking data. See [[Postgres row level security basics]].'
    },
    {
        path: `${K}/people/maria.md`,
        title: 'Maria (Kestrel product owner)',
        tags: ['person'],
        fm: {type: 'note', updated: '2025-08-01'},
        body: 'Maria owns the Kestrel roadmap and signs off on billing changes. Prefers written proposals over meetings; review requests go to her on Mondays.'
    },
    // ---- kestrel: near-duplicates, trust cases -----------------------------
    {
        path: `${K}/notes/rate-limits.md`,
        title: 'API rate limits',
        tags: ['api'],
        fm: {updated: '2025-06-02'},
        body: 'The public API allows 600 requests per minute per API key; bursts of up to 100 extra requests are absorbed by a token bucket. Exceeding it returns 429 with a Retry-After header.'
    },
    {
        path: `${K}/notes/rate-limiting-public-api.md`,
        title: 'Rate limiting on the public API',
        tags: ['api'],
        fm: {updated: '2025-06-03'},
        body: 'Rate limit per API key is 600/min with a token bucket (burst 100). 429 responses carry Retry-After. Internal service keys are exempt.'
    },
    {
        path: `${K}/notes/postgres-version-guess.md`,
        title: 'Postgres max connections (guess)',
        tags: ['postgres'],
        fm: {confidence: 0.3, updated: '2025-04-01'},
        body: 'I think the production Postgres allows about 100 connections, not verified. Someone mentioned it in a call.'
    },
    {
        path: `${K}/notes/postgres-connections.md`,
        title: 'Postgres connection limits in production',
        tags: ['postgres', 'ops'],
        fm: {confidence: 0.95, updated: '2025-09-02'},
        body: 'Production Postgres has max_connections = 400. The API uses PgBouncer in transaction mode with a pool of 40 per node; the worker gets its own pool of 20. See [[PgBouncer pooling modes]].'
    },
    {
        path: `${K}/notes/support-hotline.md`,
        title: 'Support on-call phone number',
        tags: ['ops'],
        fm: {valid_until: '2025-06-30', updated: '2025-01-05'},
        body: 'Until the end of June 2025 the support on-call phone number is +49 30 1234 5678 (temporary provider).'
    },
    {
        path: `${K}/notes/support-oncall.md`,
        title: 'Support on-call rotation',
        tags: ['ops'],
        fm: {updated: '2025-07-01'},
        body: 'Since July 2025 support on-call runs through PagerDuty: the schedule "kestrel-support" pages the on-call engineer, the public phone number forwards to it.'
    },
    // ---- kestrel: inbox (raw remember entries) -----------------------------
    {
        path: `${K}/inbox/2025-11-10.md`,
        title: 'Inbox 2025-11-10',
        tags: ['inbox'],
        fm: {created: '2025-11-10', updated: '2025-11-10'},
        body: '### 09:12\n\nThe S3 bucket for invoices has versioning enabled, lifecycle deletes old versions after 30 days.\n\n#storage\n\n### 14:40\n\nPDF rendering uses Chromium 128 in the worker image; upgrading needs the font package fonts-noto.\n\n#pdf'
    },
    {
        path: `${K}/inbox/2025-11-12.md`,
        title: 'Inbox 2025-11-12',
        tags: ['inbox'],
        fm: {created: '2025-11-12', updated: '2025-11-12'},
        body: '### 10:05\n\nMaria wants the dunning emails in three steps: 3, 10 and 21 days after due date.\n\n#billing\n\n### 16:22\n\nThe SAML login for enterprise accounts breaks if the IdP clock is more than 5 minutes off.\n\n#auth'
    },
    // ---- harbor: a second project with overlapping topics -------------------
    {
        path: `${H}/decisions/session-store.md`,
        title: 'Harbor session store',
        tags: ['decision', 'auth'],
        fm: {type: 'decision', updated: '2025-04-22'},
        body: 'Harbor (the mobile backend) uses stateless JWT access tokens (15 min) and refresh tokens in Redis. No server-side sessions.'
    },
    {
        path: `${H}/decisions/push-notifications.md`,
        title: 'Push notifications via Firebase',
        tags: ['decision', 'mobile'],
        fm: {type: 'decision', updated: '2025-02-09'},
        body: 'Harbor sends push notifications through Firebase Cloud Messaging for Android and iOS. APNs directly was rejected to keep one integration.'
    },
    {
        path: `${H}/howto/release.md`,
        title: 'Harbor release process',
        tags: ['howto', 'release'],
        fm: {type: 'note', updated: '2025-08-12'},
        body: 'Harbor backend releases are continuous: every merge to main deploys after the e2e suite passes. The mobile apps ship every second Thursday through the app stores with a staged rollout (10 %, 50 %, 100 %).'
    },
    {
        path: `${H}/bugs/offline-sync-conflicts.md`,
        title: 'Offline sync creates duplicate entries',
        tags: ['bug', 'sync', 'mobile'],
        fm: {type: 'bug', updated: '2025-09-05'},
        body: 'When the app reconnected after offline edits, entries were created twice because the client retried before the server acknowledged. Fix: client-generated UUIDs as idempotency keys and an upsert on the server ([[Idempotency keys]]).'
    },
    {
        path: `${H}/architecture/overview.md`,
        title: 'Harbor architecture overview',
        tags: ['architecture'],
        fm: {type: 'concept', updated: '2025-06-18'},
        body: 'Harbor is the backend for the Kestrel field-service mobile app: a Go service, SQLite on the device, Postgres on the server, sync over a REST delta endpoint every 60 s or on demand. Releases: [[Harbor release process]].'
    },
    {
        path: `${H}/notes/rate-limits.md`,
        title: 'Harbor API rate limits',
        tags: ['api'],
        fm: {updated: '2025-05-15'},
        body: 'The Harbor sync endpoint allows 120 requests per minute per device; the login endpoint 10 per minute per IP.'
    },
    // ---- shared knowledge ---------------------------------------------------
    {
        path: 'Knowledge/postgres/unlogged-tables.md',
        title: 'Postgres unlogged tables',
        tags: ['postgres', 'knowledge'],
        body: 'Unlogged tables skip the write-ahead log: writes are much faster, but the table is truncated after a crash and not replicated. Good for caches and sessions that can be rebuilt.'
    },
    {
        path: 'Knowledge/postgres/row-level-security.md',
        title: 'Postgres row level security basics',
        tags: ['postgres', 'security', 'knowledge'],
        body: 'Enable with ALTER TABLE ... ENABLE ROW LEVEL SECURITY and add policies with CREATE POLICY. Table owners bypass RLS unless FORCE ROW LEVEL SECURITY is set; superusers always bypass it.'
    },
    {
        path: 'Knowledge/http/retry-backoff.md',
        title: 'Retry with exponential backoff and jitter',
        tags: ['http', 'knowledge'],
        body: 'Retry delays should grow exponentially with random jitter, so many clients do not retry in lockstep. "Full jitter" picks a random delay between 0 and the exponential cap.'
    },
    {
        path: 'Knowledge/http/idempotency-keys.md',
        title: 'Idempotency keys',
        tags: ['http', 'knowledge'],
        body: 'A client sends a unique key with a mutating request; the server stores the first response under that key and returns it again for retries. Makes POST safe to retry.'
    },
    {
        path: 'Knowledge/tools/pdf-lib.md',
        title: 'pdf-lib',
        tags: ['pdf', 'knowledge'],
        body: 'pdf-lib is a pure JavaScript library to create and modify PDFs; it can copy pages between documents, which makes merging rendered chunks simple.'
    },
    {
        path: 'Knowledge/frontend/svelte-runes.md',
        title: 'Svelte 5 runes',
        tags: ['frontend', 'knowledge'],
        body: 'Svelte 5 replaces the implicit reactivity of Svelte 4 with runes: $state, $derived, $effect and $props. Stores still work but runes are the default.'
    },
    {
        path: 'Knowledge/ops/pgbouncer-modes.md',
        title: 'PgBouncer pooling modes',
        tags: ['postgres', 'ops', 'knowledge'],
        body: 'Session mode keeps a server connection per client session; transaction mode returns it after each transaction (no session state like prepared statements or SET); statement mode after each statement.'
    }
];

export const EVAL_QUESTIONS: readonly EvalQuestion[] = [
    // ---- lookup: the words of the question are in the note ------------------
    {id: 'L1', category: 'lookup', question: 'How do I set up Kestrel locally?', query: 'kestrel local development setup', relevant: [`${K}/howto/local-setup.md`]},
    {id: 'L2', category: 'lookup', question: 'Why did invoice PDFs time out?', query: 'invoice PDF timeout', relevant: [`${K}/bugs/invoice-pdf-timeout.md`]},
    {id: 'L3', category: 'lookup', question: 'How do we version the public API?', query: 'API versioning', relevant: [`${K}/decisions/api-versioning.md`]},
    {id: 'L4', category: 'lookup', question: 'What runs background jobs?', query: 'background jobs', relevant: [`${K}/decisions/background-jobs.md`]},
    {id: 'L5', category: 'lookup', question: 'How do I rotate the Stripe key?', query: 'rotate Stripe API key', relevant: [`${K}/howto/rotate-stripe-key.md`]},
    {id: 'L6', category: 'lookup', question: 'How are tenants isolated?', query: 'multi-tenancy row level security', relevant: [`${K}/architecture/multi-tenancy.md`, 'Knowledge/postgres/row-level-security.md']},
    {id: 'L7', category: 'lookup', question: 'What was the webhook retry incident?', query: 'webhook retries flooded endpoint', relevant: [`${K}/bugs/webhook-retry-storm.md`]},
    {id: 'L8', category: 'lookup', question: 'Who is the product owner of Kestrel?', query: 'Kestrel product owner', relevant: [`${K}/people/maria.md`]},
    {id: 'L9', category: 'lookup', question: 'How do feature flags work?', query: 'feature flags', relevant: [`${K}/decisions/feature-flags.md`]},
    {id: 'L10', category: 'lookup', question: 'What are PgBouncer pooling modes?', query: 'PgBouncer pooling modes', relevant: ['Knowledge/ops/pgbouncer-modes.md']},
    {id: 'L11', category: 'lookup', question: 'Which push provider does Harbor use?', query: 'push notifications', relevant: [`${H}/decisions/push-notifications.md`]},
    {id: 'L12', category: 'lookup', question: 'How did we fix duplicate entries after offline sync?', query: 'offline sync duplicate entries', relevant: [`${H}/bugs/offline-sync-conflicts.md`, 'Knowledge/http/idempotency-keys.md']},

    // ---- paraphrase: the question uses other words than the note ------------
    {id: 'P1', category: 'paraphrase', question: 'Customers in America got charged a day too early, what happened?', query: 'charged a day too early America', relevant: [`${K}/bugs/timezone-billing-cutoff.md`]},
    {id: 'P2', category: 'paraphrase', question: 'German special characters break when uploading spreadsheets', query: 'umlauts spreadsheet upload broken', relevant: [`${K}/bugs/csv-import-encoding.md`]},
    {id: 'P3', category: 'paraphrase', question: 'When do we ship to production?', query: 'ship to production schedule', relevant: [`${K}/howto/release.md`]},
    {id: 'P4', category: 'paraphrase', question: 'How fast can a client call the API before being throttled?', query: 'throttled requests per minute', relevant: [`${K}/notes/rate-limits.md`, `${K}/notes/rate-limiting-public-api.md`]},
    {id: 'P5', category: 'paraphrase', question: 'What is the overall system design of Kestrel?', query: 'kestrel system design components', relevant: [`${K}/architecture/overview.md`]},
    {id: 'P6', category: 'paraphrase', question: 'How should clients wait between retries?', query: 'wait between retries', relevant: ['Knowledge/http/retry-backoff.md', `${K}/bugs/webhook-retry-storm.md`]},

    // ---- current: a newer note supersedes an older one -----------------------
    {id: 'C1', category: 'current', question: 'Where does Kestrel store sessions?', query: 'Kestrel session store', relevant: [`${K}/decisions/session-store-postgres.md`], outdated: [`${K}/decisions/session-store-redis.md`]},
    {id: 'C2', category: 'current', question: 'Do we still use Redis for sessions in Kestrel?', query: 'Redis sessions Kestrel', relevant: [`${K}/decisions/session-store-postgres.md`], outdated: [`${K}/decisions/session-store-redis.md`]},
    {id: 'C3', category: 'current', question: 'Which frontend framework does the admin UI use?', query: 'admin UI frontend framework', relevant: [`${K}/decisions/frontend-framework-svelte.md`], outdated: [`${K}/decisions/frontend-framework.md`]},
    {id: 'C4', category: 'current', question: 'Should new admin screens be written in Vue?', query: 'Vue admin screens', relevant: [`${K}/decisions/frontend-framework-svelte.md`], outdated: [`${K}/decisions/frontend-framework.md`]},
    {id: 'C5', category: 'current', question: 'What is the session TTL in Kestrel?', query: 'Kestrel session TTL 24 h', relevant: [`${K}/decisions/session-store-postgres.md`], outdated: [`${K}/decisions/session-store-redis.md`]},
    {id: 'C6', category: 'current', question: 'Which component library and state management does the admin UI use?', query: 'admin UI component library state management Vuex', relevant: [`${K}/decisions/frontend-framework-svelte.md`], outdated: [`${K}/decisions/frontend-framework.md`]},

    // ---- trust: low confidence and expired notes ------------------------------
    {id: 'T1', category: 'trust', question: 'How many connections does production Postgres allow?', query: 'Postgres max connections production', relevant: [`${K}/notes/postgres-connections.md`], outdated: [`${K}/notes/postgres-version-guess.md`]},
    {id: 'T2', category: 'trust', question: 'How do I reach support on-call?', query: 'support on-call phone', relevant: [`${K}/notes/support-oncall.md`], outdated: [`${K}/notes/support-hotline.md`]},

    // ---- scoped: the same topic exists in both projects ----------------------
    {id: 'S1', category: 'scoped', question: 'How does Harbor release?', query: 'Harbor release process', relevant: [`${H}/howto/release.md`], outdated: [`${K}/howto/release.md`]},
    {id: 'S2', category: 'scoped', question: 'What are the Harbor rate limits?', query: 'Harbor rate limits', relevant: [`${H}/notes/rate-limits.md`], outdated: [`${K}/notes/rate-limits.md`, `${K}/notes/rate-limiting-public-api.md`]},
    {id: 'S3', category: 'scoped', question: 'How are sessions handled in Harbor?', query: 'Harbor session store', relevant: [`${H}/decisions/session-store.md`]},
    {id: 'S4', category: 'scoped', question: 'What is the Harbor architecture?', query: 'Harbor architecture overview', relevant: [`${H}/architecture/overview.md`], outdated: [`${K}/architecture/overview.md`]},

    // ---- remembered facts that only live in the inbox ------------------------
    {id: 'L13', category: 'lookup', question: 'How long are old invoice file versions kept?', query: 'invoice bucket versioning lifecycle', relevant: [`${K}/inbox/2025-11-10.md`]},
    {id: 'L14', category: 'lookup', question: 'When are dunning emails sent?', query: 'dunning emails', relevant: [`${K}/inbox/2025-11-12.md`]}
];
