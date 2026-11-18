import {clear, el} from './Dom.js';
import {
    createUser,
    listUsers,
    patchUser,
    type AdminAccountDto
} from './Auth.js';

export interface AdminPanelOptions {
    /** Account id of the currently logged-in admin — used to gate self-targeted action buttons. */
    selfId: number;
}

const formatDate = (ms: number | null): string => {
    if (ms === null || !Number.isFinite(ms) || ms <= 0) return '—';
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
};

const status = (account: AdminAccountDto): {label: string; cls: string} => {
    if (account.disabledAt !== null) return {label: 'disabled', cls: 'admin-status revoked'};
    return {label: 'active', cls: 'admin-status active'};
};

export class AdminPanel {
    public readonly element: HTMLElement;
    private listHost: HTMLElement;
    private formHost: HTMLElement;
    private busy = false;

    public constructor(private readonly opts: AdminPanelOptions) {
        this.element = el('div', {class: 'admin-panel'});
        this.formHost = el('div', {class: 'admin-form-host'});
        this.listHost = el('div', {class: 'admin-list'});

        this.element.appendChild(el('p', {
            class: 'admin-intro',
            text: 'Manage accounts that can log into this vault. Disabled users lose their session immediately; deletion is intentionally absent so the audit trail stays intact.'
        }));
        this.element.appendChild(this.formHost);
        this.element.appendChild(el('h3', {class: 'admin-section-title', text: 'Accounts'}));
        this.element.appendChild(this.listHost);

        this.renderForm();
        this.renderListLoading();
    }

    public async onShow(): Promise<void> {
        await this.refresh();
    }

    private renderForm(): void {
        clear(this.formHost);

        const emailInput = el('input', {
            class: 'admin-input',
            attrs: {type: 'email', placeholder: 'Email', maxlength: '255', autocomplete: 'off'}
        }) as HTMLInputElement;

        const passwordInput = el('input', {
            class: 'admin-input',
            attrs: {type: 'password', placeholder: 'Initial password (min 8)', autocomplete: 'new-password'}
        }) as HTMLInputElement;

        const adminCheck = el('input', {
            attrs: {type: 'checkbox'}
        }) as HTMLInputElement;

        const error = el('div', {class: 'admin-form-error', attrs: {'aria-live': 'polite'}});
        const submitBtn = el('button', {
            class: 'btn btn-primary',
            attrs: {type: 'submit'},
            text: 'Create user'
        }) as HTMLButtonElement;

        const form = el('form', {class: 'admin-form'},
            el('div', {class: 'admin-form-row'},
                el('label', {class: 'admin-label-text', text: 'Email'}),
                emailInput
            ),
            el('div', {class: 'admin-form-row'},
                el('label', {class: 'admin-label-text', text: 'Password'}),
                passwordInput
            ),
            el('div', {class: 'admin-form-row'},
                el('label', {class: 'admin-label-text', text: 'Role'}),
                el('label', {class: 'admin-check'}, adminCheck, el('span', {text: 'Admin'}))
            ),
            error,
            el('div', {class: 'admin-form-actions'}, submitBtn)
        );

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            if (this.busy) return;

            const email = emailInput.value.trim();
            if (email.length === 0) {
                error.textContent = 'Email is required';
                return;
            }

            const password = passwordInput.value;
            if (password.length < 8) {
                error.textContent = 'Password must be at least 8 characters';
                return;
            }

            error.textContent = '';
            this.busy = true;
            submitBtn.disabled = true;
            submitBtn.textContent = 'Creating…';

            void (async () => {
                try {
                    await createUser({email, password, isAdmin: adminCheck.checked});
                    emailInput.value = '';
                    passwordInput.value = '';
                    adminCheck.checked = false;
                    await this.refresh();
                } catch (cause) {
                    error.textContent = cause instanceof Error ? cause.message : String(cause);
                } finally {
                    this.busy = false;
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Create user';
                }
            })();
        });

        this.formHost.appendChild(form);
    }

    private renderListLoading(): void {
        clear(this.listHost);
        this.listHost.appendChild(el('div', {class: 'admin-empty', text: 'Loading accounts…'}));
    }

    private async refresh(): Promise<void> {
        try {
            const list = await listUsers();
            this.renderList(list);
        } catch (cause) {
            clear(this.listHost);
            this.listHost.appendChild(el('div', {
                class: 'admin-empty error',
                text: cause instanceof Error ? cause.message : String(cause)
            }));
        }
    }

    private renderList(accounts: readonly AdminAccountDto[]): void {
        clear(this.listHost);

        if (accounts.length === 0) {
            this.listHost.appendChild(el('div', {
                class: 'admin-empty',
                text: 'No accounts yet — create one with the form above.'
            }));
            return;
        }

        const sorted = [...accounts].sort((a, b) => {
            // Active first, disabled at the bottom; within each group by created desc.
            const aActive = a.disabledAt === null;
            const bActive = b.disabledAt === null;
            if (aActive !== bActive) return aActive ? -1 : 1;
            return b.createdAt - a.createdAt;
        });

        for (const account of sorted) {
            this.listHost.appendChild(this.renderRow(account));
        }
    }

    private renderRow(account: AdminAccountDto): HTMLElement {
        const isSelf = account.id === this.opts.selfId;
        const isDisabled = account.disabledAt !== null;
        const st = status(account);

        const roleBadge = el('span', {
            class: account.isAdmin ? 'admin-role-badge admin' : 'admin-role-badge',
            text: account.isAdmin ? 'admin' : 'user'
        });

        const selfBadge = isSelf ? el('span', {class: 'admin-self-badge', text: 'you'}) : null;

        const enableBtn = el('button', {
            class: 'btn',
            attrs: {type: 'button'},
            text: isDisabled ? 'Enable' : 'Disable'
        }) as HTMLButtonElement;
        if (isSelf) {
            enableBtn.disabled = true;
            enableBtn.title = 'You cannot disable your own account.';
        }
        enableBtn.addEventListener('click', () => this.handleToggleDisabled(account, enableBtn));

        const adminBtn = el('button', {
            class: 'btn',
            attrs: {type: 'button'},
            text: account.isAdmin ? 'Demote' : 'Promote'
        }) as HTMLButtonElement;
        if (isSelf && account.isAdmin) {
            adminBtn.disabled = true;
            adminBtn.title = 'You cannot revoke your own admin.';
        }
        adminBtn.addEventListener('click', () => this.handleToggleAdmin(account, adminBtn));

        const passwordBtn = el('button', {
            class: 'btn',
            attrs: {type: 'button'},
            text: 'Reset password'
        }) as HTMLButtonElement;
        passwordBtn.addEventListener('click', () => this.handleResetPassword(account, passwordBtn));

        const head = el('div', {class: 'admin-row-head'},
            el('span', {class: 'admin-row-email', text: account.email}),
            el('span', {class: st.cls, text: st.label}),
            roleBadge
        );
        if (selfBadge !== null) head.appendChild(selfBadge);

        return el('div', {class: 'admin-row'},
            el('div', {class: 'admin-row-main'},
                head,
                el('div', {class: 'admin-row-meta'},
                    el('span', {text: `created ${formatDate(account.createdAt)}`}),
                    el('span', {text: `last login ${formatDate(account.lastLoginAt)}`}),
                    isDisabled ? el('span', {text: `disabled ${formatDate(account.disabledAt)}`}) : el('span', {text: ''})
                )
            ),
            el('div', {class: 'admin-row-actions'}, enableBtn, adminBtn, passwordBtn)
        );
    }

    private async handleToggleDisabled(account: AdminAccountDto, btn: HTMLButtonElement): Promise<void> {
        if (this.busy) return;
        const willDisable = account.disabledAt === null;
        const verb = willDisable ? 'Disable' : 'Re-enable';
        const ok = window.confirm(
            willDisable
                ? `Disable "${account.email}"? They will be logged out immediately and any active session will stop working.`
                : `Re-enable "${account.email}"? They will be able to sign in again.`
        );
        if (!ok) return;

        this.busy = true;
        btn.disabled = true;
        btn.textContent = `${verb.replace(/e$/, '')}ing…`;

        try {
            await patchUser(account.id, {disabled: willDisable});
            await this.refresh();
        } catch (cause) {
            window.alert(cause instanceof Error ? cause.message : String(cause));
            btn.disabled = false;
            btn.textContent = willDisable ? 'Disable' : 'Enable';
        } finally {
            this.busy = false;
        }
    }

    private async handleToggleAdmin(account: AdminAccountDto, btn: HTMLButtonElement): Promise<void> {
        if (this.busy) return;
        const willPromote = !account.isAdmin;
        const ok = window.confirm(
            willPromote
                ? `Grant admin to "${account.email}"? They will be able to manage other accounts.`
                : `Revoke admin from "${account.email}"? They keep their account but lose user-management access.`
        );
        if (!ok) return;

        this.busy = true;
        btn.disabled = true;
        btn.textContent = willPromote ? 'Promoting…' : 'Demoting…';

        try {
            await patchUser(account.id, {isAdmin: willPromote});
            await this.refresh();
        } catch (cause) {
            window.alert(cause instanceof Error ? cause.message : String(cause));
            btn.disabled = false;
            btn.textContent = willPromote ? 'Promote' : 'Demote';
        } finally {
            this.busy = false;
        }
    }

    private async handleResetPassword(account: AdminAccountDto, btn: HTMLButtonElement): Promise<void> {
        if (this.busy) return;
        const newPw = window.prompt(
            `Reset password for "${account.email}". Enter the new password (min 8 chars). It will be shown only here — copy it before closing.`
        );
        if (newPw === null) return;
        if (newPw.length < 8) {
            window.alert('Password must be at least 8 characters.');
            return;
        }
        const confirmPw = window.prompt('Confirm the new password by typing it again:');
        if (confirmPw === null) return;
        if (confirmPw !== newPw) {
            window.alert('Passwords did not match — no change applied.');
            return;
        }

        this.busy = true;
        btn.disabled = true;
        btn.textContent = 'Resetting…';

        try {
            await patchUser(account.id, {password: newPw});
            window.alert(`Password for "${account.email}" has been reset.`);
            await this.refresh();
        } catch (cause) {
            window.alert(cause instanceof Error ? cause.message : String(cause));
        } finally {
            this.busy = false;
            btn.disabled = false;
            btn.textContent = 'Reset password';
        }
    }
}