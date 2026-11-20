import {clear, el} from './Dom.js';
import {
    createToken,
    listTokens,
    revokeToken,
    rotateToken,
    type TokenDto
} from './Auth.js';
import {confirmDialog} from './Dialogs.js';
import {toastError} from './Toast.js';
import {openModal} from './Modal.js';
import {defineMessages} from './I18n.js';

const t = defineMessages('tokensPanel', {
    statusRevoked: 'revoked',
    statusExpired: 'expired',
    statusActive: 'active',
    intro: 'Personal MCP bearer tokens. Each grants read and/or write access to the vault on behalf of your account.',
    myTokens: 'My tokens',
    labelPlaceholder: 'Label (e.g. laptop-mcp)',
    expiresPlaceholder: 'expires (days, optional)',
    createToken: 'Create token',
    label: 'Label',
    scopes: 'Scopes',
    read: 'Read',
    write: 'Write',
    expires: 'Expires',
    labelRequired: 'Label is required',
    scopeRequired: 'Pick at least one scope (read or write)',
    expiresInvalid: 'Expires (days) must be a positive integer',
    creating: 'Creating…',
    loadingTokens: 'Loading tokens…',
    empty: 'No tokens yet. Create one above to authenticate the MCP server.',
    rotate: 'Rotate',
    revoke: 'Revoke',
    created: 'created {date}',
    lastUsed: 'last used {date}',
    expiresAt: 'expires {date}',
    revokeTitle: 'Revoke token?',
    revokeMessage: 'Any client using "{label}" loses access immediately. This cannot be undone.',
    revoking: 'Revoking…',
    rotateTitle: 'Rotate token?',
    rotateMessage: 'The old bearer of "{label}" stops working immediately. You get a new one, shown only once.',
    rotating: 'Rotating…',
    copiedClose: 'I have copied it — close',
    copy: 'Copy',
    copiedCheck: 'Copied ✓',
    newToken: 'New token',
    tokenCreated: 'Token created: {label}',
    tokenRotated: 'Token rotated: {label}',
    copyNow: 'Copy this token now.',
    hashOnly: 'Synaipse stores only a hash — once this dialog closes the plain bearer is gone forever.'
});

const formatDate = (ms: number | null): string => {
    if (ms === null || !Number.isFinite(ms) || ms <= 0) return '—';
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
};

const scopeBadge = (token: TokenDto): string => {
    const parts: string[] = [];
    if (token.read) parts.push('R');
    if (token.write) parts.push('W');
    return parts.length === 0 ? '—' : parts.join(' / ');
};

const isExpired = (token: TokenDto, now: number): boolean =>
    token.expiresAt !== null && token.expiresAt <= now;

const status = (token: TokenDto, now: number): {label: string; cls: string} => {
    if (token.revokedAt !== null) return {label: t('statusRevoked'), cls: 'tokens-status revoked'};
    if (isExpired(token, now)) return {label: t('statusExpired'), cls: 'tokens-status revoked'};
    return {label: t('statusActive'), cls: 'tokens-status active'};
};

export class TokensPanel {
    public readonly element: HTMLElement;
    private listHost: HTMLElement;
    private formHost: HTMLElement;
    private busy = false;

    public constructor() {
        this.element = el('div', {class: 'tokens-panel'});
        this.formHost = el('div', {class: 'tokens-form-host'});
        this.listHost = el('div', {class: 'tokens-list'});

        this.element.appendChild(el('p', {
            class: 'tokens-intro',
            text: t('intro')
        }));
        this.element.appendChild(this.formHost);
        this.element.appendChild(el('h3', {class: 'tokens-section-title', text: t('myTokens')}));
        this.element.appendChild(this.listHost);

        this.renderForm();
        this.renderListLoading();
    }

    public async onShow(): Promise<void> {
        await this.refresh();
    }

    private renderForm(): void {
        clear(this.formHost);

        const labelInput = el('input', {
            class: 'tokens-input',
            attrs: {type: 'text', placeholder: t('labelPlaceholder'), maxlength: '64'}
        }) as HTMLInputElement;

        const readCheck = el('input', {
            attrs: {type: 'checkbox', checked: 'checked'}
        }) as HTMLInputElement;

        const writeCheck = el('input', {
            attrs: {type: 'checkbox'}
        }) as HTMLInputElement;

        const expiresInput = el('input', {
            class: 'tokens-input tokens-input-small',
            attrs: {type: 'number', placeholder: t('expiresPlaceholder'), min: '1', max: '1825'}
        }) as HTMLInputElement;

        const error = el('div', {class: 'tokens-form-error', attrs: {'aria-live': 'polite'}});
        const submitBtn = el('button', {
            class: 'btn btn-primary',
            attrs: {type: 'submit'},
            text: t('createToken')
        }) as HTMLButtonElement;

        const form = el('form', {class: 'tokens-form'},
            el('div', {class: 'tokens-form-row'},
                el('label', {class: 'tokens-label-text', text: t('label')}),
                labelInput
            ),
            el('div', {class: 'tokens-form-row'},
                el('label', {class: 'tokens-label-text', text: t('scopes')}),
                el('div', {class: 'tokens-checks'},
                    el('label', {class: 'tokens-check'}, readCheck, el('span', {text: t('read')})),
                    el('label', {class: 'tokens-check'}, writeCheck, el('span', {text: t('write')}))
                )
            ),
            el('div', {class: 'tokens-form-row'},
                el('label', {class: 'tokens-label-text', text: t('expires')}),
                expiresInput
            ),
            error,
            el('div', {class: 'tokens-form-actions'}, submitBtn)
        );

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            if (this.busy) return;

            const label = labelInput.value.trim();
            if (label.length === 0) {
                error.textContent = t('labelRequired');
                return;
            }

            const read = readCheck.checked;
            const write = writeCheck.checked;
            if (!read && !write) {
                error.textContent = t('scopeRequired');
                return;
            }

            let expiresInDays: number | null = null;
            const raw = expiresInput.value.trim();
            if (raw.length > 0) {
                const n = Number.parseInt(raw, 10);
                if (!Number.isFinite(n) || n <= 0) {
                    error.textContent = t('expiresInvalid');
                    return;
                }
                expiresInDays = n;
            }

            error.textContent = '';
            this.busy = true;
            submitBtn.disabled = true;
            submitBtn.textContent = t('creating');

            void (async () => {
                try {
                    const result = await createToken({label, read, write, expiresInDays});
                    labelInput.value = '';
                    expiresInput.value = '';
                    writeCheck.checked = false;
                    readCheck.checked = true;
                    showPlainTokenModal(result.plainToken, result.token.label, 'created');
                    await this.refresh();
                } catch (cause) {
                    error.textContent = cause instanceof Error ? cause.message : String(cause);
                } finally {
                    this.busy = false;
                    submitBtn.disabled = false;
                    submitBtn.textContent = t('createToken');
                }
            })();
        });

        this.formHost.appendChild(form);
    }

    private renderListLoading(): void {
        clear(this.listHost);
        this.listHost.appendChild(el('div', {class: 'tokens-empty', text: t('loadingTokens')}));
    }

    private async refresh(): Promise<void> {
        try {
            const tokens = await listTokens();
            this.renderList(tokens);
        } catch (cause) {
            clear(this.listHost);
            this.listHost.appendChild(el('div', {
                class: 'tokens-empty error',
                text: cause instanceof Error ? cause.message : String(cause)
            }));
        }
    }

    private renderList(tokens: readonly TokenDto[]): void {
        clear(this.listHost);

        if (tokens.length === 0) {
            this.listHost.appendChild(el('div', {
                class: 'tokens-empty',
                text: t('empty')
            }));
            return;
        }

        const now = Date.now();
        const sorted = [...tokens].sort((a, b) => {
            // Active tokens first, then by creation desc.
            const aActive = a.revokedAt === null && !isExpired(a, now);
            const bActive = b.revokedAt === null && !isExpired(b, now);
            if (aActive !== bActive) return aActive ? -1 : 1;
            return b.createdAt - a.createdAt;
        });

        for (const token of sorted) {
            this.listHost.appendChild(this.renderRow(token, now));
        }
    }

    private renderRow(token: TokenDto, now: number): HTMLElement {
        const st = status(token, now);
        const isActive = token.revokedAt === null && !isExpired(token, now);

        const rotateBtn = el('button', {
            class: 'btn',
            attrs: {type: 'button'},
            text: t('rotate')
        }) as HTMLButtonElement;
        rotateBtn.addEventListener('click', () => this.handleRotate(token, rotateBtn));

        const revokeBtn = el('button', {
            class: 'btn btn-danger',
            attrs: {type: 'button'},
            text: t('revoke')
        }) as HTMLButtonElement;
        revokeBtn.addEventListener('click', () => this.handleRevoke(token, revokeBtn));

        if (!isActive) {
            rotateBtn.disabled = true;
            revokeBtn.disabled = true;
        }

        return el('div', {class: 'tokens-row'},
            el('div', {class: 'tokens-row-main'},
                el('div', {class: 'tokens-row-head'},
                    el('span', {class: 'tokens-row-label', text: token.label}),
                    el('span', {class: st.cls, text: st.label}),
                    el('span', {class: 'tokens-row-scopes', text: scopeBadge(token)})
                ),
                el('div', {class: 'tokens-row-meta'},
                    el('span', {class: 'tokens-row-hint', text: `…${token.tokenHint}`}),
                    el('span', {text: t('created', {date: formatDate(token.createdAt)})}),
                    el('span', {text: t('lastUsed', {date: formatDate(token.lastUsedAt)})}),
                    el('span', {text: t('expiresAt', {date: formatDate(token.expiresAt)})})
                )
            ),
            el('div', {class: 'tokens-row-actions'}, rotateBtn, revokeBtn)
        );
    }

    private async handleRevoke(token: TokenDto, btn: HTMLButtonElement): Promise<void> {
        if (this.busy) return;
        const ok = await confirmDialog({
            title: t('revokeTitle'),
            message: t('revokeMessage', {label: token.label}),
            confirmLabel: t('revoke'),
            danger: true
        });
        if (!ok) return;

        this.busy = true;
        btn.disabled = true;
        btn.textContent = t('revoking');

        try {
            await revokeToken(token.id);
            await this.refresh();
        } catch (cause) {
            toastError('', cause);
            btn.disabled = false;
            btn.textContent = t('revoke');
        } finally {
            this.busy = false;
        }
    }

    private async handleRotate(token: TokenDto, btn: HTMLButtonElement): Promise<void> {
        if (this.busy) return;
        const ok = await confirmDialog({
            title: t('rotateTitle'),
            message: t('rotateMessage', {label: token.label}),
            confirmLabel: t('rotate'),
            danger: true
        });
        if (!ok) return;

        this.busy = true;
        btn.disabled = true;
        btn.textContent = t('rotating');

        try {
            const result = await rotateToken(token.id);
            showPlainTokenModal(result.plainToken, result.token.label, 'rotated');
            await this.refresh();
        } catch (cause) {
            toastError('', cause);
            btn.disabled = false;
            btn.textContent = t('rotate');
        } finally {
            this.busy = false;
        }
    }
}

const showPlainTokenModal = (plain: string, label: string, action: 'created' | 'rotated'): void => {
    const closeBtn = el('button', {
        class: 'btn btn-primary',
        attrs: {type: 'button'},
        text: t('copiedClose')
    });

    const copyBtn = el('button', {
        class: 'btn',
        attrs: {type: 'button'},
        text: t('copy')
    }) as HTMLButtonElement;

    const tokenBox = el('code', {class: 'tokens-modal-code', attrs: {'aria-label': t('newToken')}, text: plain});

    copyBtn.addEventListener('click', () => {
        void (async () => {
            try {
                await navigator.clipboard.writeText(plain);
                copyBtn.textContent = t('copiedCheck');
                window.setTimeout(() => { copyBtn.textContent = t('copy'); }, 1500);
            } catch {
                // Clipboard API can fail on non-https contexts; fall back to manual select.
                const range = document.createRange();
                range.selectNodeContents(tokenBox);
                const sel = window.getSelection();
                if (sel !== null) {
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
            }
        })();
    });

    const modal = openModal({
        title: action === 'created' ? t('tokenCreated', {label}) : t('tokenRotated', {label}),
        size: 'md',
        className: 'tokens-modal',
        body: [
            el('p', {class: 'tokens-modal-warning'},
                el('strong', {text: t('copyNow')}),
                ' ',
                t('hashOnly')
            ),
            el('div', {class: 'tokens-modal-codewrap'}, tokenBox, copyBtn)
        ],
        footer: [closeBtn],
        initialFocus: copyBtn,
        onDismiss: () => undefined
    });
    closeBtn.addEventListener('click', () => modal.close());
};
