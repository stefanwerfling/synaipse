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