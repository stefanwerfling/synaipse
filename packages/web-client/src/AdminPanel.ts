import {clear, el} from './Dom.js';
import {
    createUser,
    listUsers,
    patchUser,
    type AdminAccountDto
} from './Auth.js';
import {confirmDialog, formDialog} from './Dialogs.js';
import {toast, toastError} from './Toast.js';
import {defineMessages} from './I18n.js';

const t = defineMessages('adminPanel', {
    statusDisabled: 'disabled',
    statusActive: 'active',
    intro: 'Manage accounts that can log into this vault. Disabled users lose their session immediately; deletion is intentionally absent so the audit trail stays intact.',
    accounts: 'Accounts',
    email: 'Email',
    initialPassword: 'Initial password (min 8)',
    createUser: 'Create user',
    password: 'Password',
    role: 'Role',
    admin: 'Admin',
    emailRequired: 'Email is required',
    passwordTooShort: 'Password must be at least 8 characters',
    creating: 'Creating…',
    loadingAccounts: 'Loading accounts…',
    empty: 'No accounts yet — create one with the form above.',
    roleAdmin: 'admin',
    roleUser: 'user',
    you: 'you',
    enable: 'Enable',
    disable: 'Disable',
    cannotDisableSelf: 'You cannot disable your own account.',
    demote: 'Demote',
    promote: 'Promote',
    cannotRevokeSelf: 'You cannot revoke your own admin.',
    resetPassword: 'Reset password',
    created: 'created {date}',
    lastLogin: 'last login {date}',
    disabledAt: 'disabled {date}',
    disableTitle: 'Disable account?',
    disableMessage: '{email} is signed out immediately; every active session stops working.',
    reEnableTitle: 'Re-enable account?',
    reEnableMessage: '{email} can sign in again.',
    reEnable: 'Re-enable',
    disabling: 'Disabling…',
    reEnabling: 'Re-enabling…',
    grantTitle: 'Grant admin?',
    grantMessage: '{email} will be able to manage other accounts.',
    grantAdmin: 'Grant admin',
    revokeTitle: 'Revoke admin?',
    revokeMessage: '{email} keeps the account but loses user management.',
    revokeAdmin: 'Revoke admin',
    promoting: 'Promoting…',
    demoting: 'Demoting…',
    resetMessage: 'New password for {email}. Pass it on to them yourself; it is not shown again.',
    newPassword: 'New password (min. 8 characters)',
    repeat: 'Repeat',
    passwordTooShortDot: 'Password must be at least 8 characters.',
    mismatch: 'The passwords do not match.',
    resetting: 'Resetting…',
    resetDone: 'Password for {email} has been reset.'
});

export interface AdminPanelOptions {
    /** Account id of the currently logged-in admin — used to gate self-targeted action buttons. */
    selfId: number;
}

const formatDate = (ms: number | null): string => {
    if (ms === null || !Number.isFinite(ms) || ms <= 0) return '—';
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
};

const status = (account: AdminAccountDto): {label: string; cls: string} => {
    if (account.disabledAt !== null) return {label: t('statusDisabled'), cls: 'admin-status revoked'};
    return {label: t('statusActive'), cls: 'admin-status active'};
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
            text: t('intro')
        }));
        this.element.appendChild(this.formHost);
        this.element.appendChild(el('h3', {class: 'admin-section-title', text: t('accounts')}));
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
            attrs: {type: 'email', placeholder: t('email'), maxlength: '255', autocomplete: 'off'}
        }) as HTMLInputElement;

        const passwordInput = el('input', {
            class: 'admin-input',
            attrs: {type: 'password', placeholder: t('initialPassword'), autocomplete: 'new-password'}
        }) as HTMLInputElement;

        const adminCheck = el('input', {
            attrs: {type: 'checkbox'}
        }) as HTMLInputElement;

        const error = el('div', {class: 'admin-form-error', attrs: {'aria-live': 'polite'}});
        const submitBtn = el('button', {
            class: 'btn btn-primary',
            attrs: {type: 'submit'},
            text: t('createUser')
        }) as HTMLButtonElement;

        const form = el('form', {class: 'admin-form'},
            el('div', {class: 'admin-form-row'},
                el('label', {class: 'admin-label-text', text: t('email')}),
                emailInput
            ),
            el('div', {class: 'admin-form-row'},
                el('label', {class: 'admin-label-text', text: t('password')}),
                passwordInput
            ),
            el('div', {class: 'admin-form-row'},
                el('label', {class: 'admin-label-text', text: t('role')}),
                el('label', {class: 'admin-check'}, adminCheck, el('span', {text: t('admin')}))
            ),
            error,
            el('div', {class: 'admin-form-actions'}, submitBtn)
        );

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            if (this.busy) return;

            const email = emailInput.value.trim();
            if (email.length === 0) {
                error.textContent = t('emailRequired');
                return;
            }

            const password = passwordInput.value;
            if (password.length < 8) {
                error.textContent = t('passwordTooShort');
                return;
            }

            error.textContent = '';
            this.busy = true;
            submitBtn.disabled = true;
            submitBtn.textContent = t('creating');

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
                    submitBtn.textContent = t('createUser');
                }
            })();
        });

        this.formHost.appendChild(form);
    }

    private renderListLoading(): void {
        clear(this.listHost);
        this.listHost.appendChild(el('div', {class: 'admin-empty', text: t('loadingAccounts')}));
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
                text: t('empty')
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
            text: account.isAdmin ? t('roleAdmin') : t('roleUser')
        });

        const selfBadge = isSelf ? el('span', {class: 'admin-self-badge', text: t('you')}) : null;

        const enableBtn = el('button', {
            class: 'btn',
            attrs: {type: 'button'},
            text: isDisabled ? t('enable') : t('disable')
        }) as HTMLButtonElement;
        if (isSelf) {
            enableBtn.disabled = true;
            enableBtn.title = t('cannotDisableSelf');
        }
        enableBtn.addEventListener('click', () => this.handleToggleDisabled(account, enableBtn));

        const adminBtn = el('button', {
            class: 'btn',
            attrs: {type: 'button'},
            text: account.isAdmin ? t('demote') : t('promote')
        }) as HTMLButtonElement;
        if (isSelf && account.isAdmin) {
            adminBtn.disabled = true;
            adminBtn.title = t('cannotRevokeSelf');
        }
        adminBtn.addEventListener('click', () => this.handleToggleAdmin(account, adminBtn));

        const passwordBtn = el('button', {
            class: 'btn',
            attrs: {type: 'button'},
            text: t('resetPassword')
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
                    el('span', {text: t('created', {date: formatDate(account.createdAt)})}),
                    el('span', {text: t('lastLogin', {date: formatDate(account.lastLoginAt)})}),
                    isDisabled ? el('span', {text: t('disabledAt', {date: formatDate(account.disabledAt)})}) : el('span', {text: ''})
                )
            ),
            el('div', {class: 'admin-row-actions'}, enableBtn, adminBtn, passwordBtn)
        );
    }

    private async handleToggleDisabled(account: AdminAccountDto, btn: HTMLButtonElement): Promise<void> {
        if (this.busy) return;
        const willDisable = account.disabledAt === null;
        const ok = await confirmDialog(willDisable
            ? {
                title: t('disableTitle'),
                message: t('disableMessage', {email: account.email}),
                confirmLabel: t('disable'),
                danger: true
            }
            : {
                title: t('reEnableTitle'),
                message: t('reEnableMessage', {email: account.email}),
                confirmLabel: t('reEnable')
            });
        if (!ok) return;

        this.busy = true;
        btn.disabled = true;
        btn.textContent = willDisable ? t('disabling') : t('reEnabling');

        try {
            await patchUser(account.id, {disabled: willDisable});
            await this.refresh();
        } catch (cause) {
            toastError('', cause);
            btn.disabled = false;
            btn.textContent = willDisable ? t('disable') : t('enable');
        } finally {
            this.busy = false;
        }
    }

    private async handleToggleAdmin(account: AdminAccountDto, btn: HTMLButtonElement): Promise<void> {
        if (this.busy) return;
        const willPromote = !account.isAdmin;
        const ok = await confirmDialog(willPromote
            ? {
                title: t('grantTitle'),
                message: t('grantMessage', {email: account.email}),
                confirmLabel: t('grantAdmin')
            }
            : {
                title: t('revokeTitle'),
                message: t('revokeMessage', {email: account.email}),
                confirmLabel: t('revokeAdmin'),
                danger: true
            });
        if (!ok) return;

        this.busy = true;
        btn.disabled = true;
        btn.textContent = willPromote ? t('promoting') : t('demoting');

        try {
            await patchUser(account.id, {isAdmin: willPromote});
            await this.refresh();
        } catch (cause) {
            toastError('', cause);
            btn.disabled = false;
            btn.textContent = willPromote ? t('promote') : t('demote');
        } finally {
            this.busy = false;
        }
    }

    private async handleResetPassword(account: AdminAccountDto, btn: HTMLButtonElement): Promise<void> {
        if (this.busy) return;
        const values = await formDialog({
            title: t('resetPassword'),
            message: t('resetMessage', {email: account.email}),
            fields: [
                {name: 'password', label: t('newPassword'), type: 'password', autocomplete: 'new-password'},
                {name: 'repeat', label: t('repeat'), type: 'password', autocomplete: 'new-password'}
            ],
            confirmLabel: t('resetPassword'),
            validate: (v) => {
                if (v.password!.length < 8) return t('passwordTooShortDot');
                if (v.repeat !== v.password) return t('mismatch');
                return null;
            }
        });
        if (values === null) return;
        const newPw = values.password!;

        this.busy = true;
        btn.disabled = true;
        btn.textContent = t('resetting');

        try {
            await patchUser(account.id, {password: newPw});
            toast(t('resetDone', {email: account.email}), {kind: 'success'});
            await this.refresh();
        } catch (cause) {
            toastError('', cause);
        } finally {
            this.busy = false;
            btn.disabled = false;
            btn.textContent = t('resetPassword');
        }
    }
}