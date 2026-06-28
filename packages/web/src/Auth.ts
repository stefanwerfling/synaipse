/**
 * Frontend auth bootstrap. Backed by the /api/auth/* endpoints in
 * server-mode and stubbed to "always-authenticated" in local-mode so the
 * rest of the app can stay mode-agnostic.
 */
export interface AccountDto {
    id: number;
    email: string;
    isAdmin: boolean;
    createdAt: number;
    lastLoginAt: number | null;
}

export type AuthMode =
    | {mode: 'local'; authenticated: true}
    | {mode: 'server'; authenticated: false}
    | {mode: 'server'; authenticated: true; account: AccountDto};

export const fetchAuthMode = async (): Promise<AuthMode> => {
    const res = await fetch('/api/auth/mode', {credentials: 'same-origin'});
    if (!res.ok) {
        throw new Error(`/api/auth/mode failed: ${res.status}`);
    }
    return await res.json() as AuthMode;
};

export interface LoginResult {
    ok: true;
    account: AccountDto;
}

export interface LoginError {
    ok: false;
    status: number;
    message: string;
}

export const login = async (email: string, password: string): Promise<LoginResult | LoginError> => {
    const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        credentials: 'same-origin',
        body: JSON.stringify({email, password})
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        let message = `Login failed (${res.status})`;
        try {
            const parsed = JSON.parse(text) as {error?: string};
            if (typeof parsed.error === 'string') message = parsed.error;
        } catch { /* keep default */ }
        return {ok: false, status: res.status, message};
    }

    const body = await res.json() as {account: AccountDto};
    return {ok: true, account: body.account};
};

export const logout = async (): Promise<void> => {
    await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin'
    });
};

export interface TokenDto {
    id: number;
    label: string;
    read: boolean;
    write: boolean;
    tokenHint: string;
    createdAt: number;
    lastUsedAt: number | null;
    revokedAt: number | null;
    expiresAt: number | null;
}

export interface CreateTokenInput {
    label: string;
    read: boolean;
    write: boolean;
    expiresInDays?: number | null;
}

export interface CreateTokenResult {
    token: TokenDto;
    /** Plain bearer — returned exactly once, never re-fetchable. */
    plainToken: string;
}

const tokensError = async (res: Response, fallback: string): Promise<Error> => {
    const text = await res.text().catch(() => '');
    try {
        const parsed = JSON.parse(text) as {error?: string};
        if (typeof parsed.error === 'string') return new Error(parsed.error);
    } catch { /* fall through */ }
    return new Error(`${fallback} (${res.status})`);
};

export const listTokens = async (): Promise<TokenDto[]> => {
    const res = await fetch('/api/tokens', {credentials: 'same-origin'});
    if (!res.ok) throw await tokensError(res, 'listTokens failed');
    const body = await res.json() as {tokens: TokenDto[]};
    return body.tokens;
};

export const createToken = async (input: CreateTokenInput): Promise<CreateTokenResult> => {
    const payload: Record<string, unknown> = {
        label: input.label,
        read: input.read,
        write: input.write
    };
    if (input.expiresInDays !== undefined && input.expiresInDays !== null) {
        payload.expiresInDays = input.expiresInDays;
    }

    const res = await fetch('/api/tokens', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        credentials: 'same-origin',
        body: JSON.stringify(payload)
    });
    if (!res.ok) throw await tokensError(res, 'createToken failed');
    return await res.json() as CreateTokenResult;
};

export const revokeToken = async (id: number): Promise<void> => {
    const res = await fetch(`/api/tokens/${id}`, {
        method: 'DELETE',
        credentials: 'same-origin'
    });
    if (!res.ok) throw await tokensError(res, 'revokeToken failed');
};

export const rotateToken = async (id: number, expiresInDays?: number | null): Promise<CreateTokenResult> => {
    const payload: Record<string, unknown> = {};
    if (expiresInDays !== undefined && expiresInDays !== null) {
        payload.expiresInDays = expiresInDays;
    }

    const res = await fetch(`/api/tokens/${id}/rotate`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        credentials: 'same-origin',
        body: JSON.stringify(payload)
    });
    if (!res.ok) throw await tokensError(res, 'rotateToken failed');
    return await res.json() as CreateTokenResult;
};

/**
 * Admin-side view of an account — adds disabledAt which the self-facing
 * /api/auth/me deliberately omits (a disabled user can't reach /me at all,
 * so the field would be dead weight for self-view).
 */
export interface AdminAccountDto extends AccountDto {
    disabledAt: number | null;
}

export interface CreateUserInput {
    email: string;
    password: string;
    isAdmin: boolean;
}

export interface PatchUserInput {
    disabled?: boolean;
    isAdmin?: boolean;
    password?: string;
}

export const listUsers = async (): Promise<AdminAccountDto[]> => {
    const res = await fetch('/api/admin/users', {credentials: 'same-origin'});
    if (!res.ok) throw await tokensError(res, 'listUsers failed');
    const body = await res.json() as {accounts: AdminAccountDto[]};
    return body.accounts;
};

export const createUser = async (input: CreateUserInput): Promise<AdminAccountDto> => {
    const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        credentials: 'same-origin',
        body: JSON.stringify(input)
    });
    if (!res.ok) throw await tokensError(res, 'createUser failed');
    const body = await res.json() as {account: AdminAccountDto};
    return body.account;
};

export const patchUser = async (id: number, patch: PatchUserInput): Promise<AdminAccountDto> => {
    const res = await fetch(`/api/admin/users/${id}`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        credentials: 'same-origin',
        body: JSON.stringify(patch)
    });
    if (!res.ok) throw await tokensError(res, 'patchUser failed');
    const body = await res.json() as {account: AdminAccountDto};
    return body.account;
};