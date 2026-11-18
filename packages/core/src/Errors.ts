export class SynaipseError extends Error {
    public constructor(message: string, public override readonly cause?: unknown) {
        super(message);
        this.name = this.constructor.name;
    }
}

export class ConfigError extends SynaipseError {}
export class VaultError extends SynaipseError {}
export class VectorError extends SynaipseError {}
export class NotFoundError extends SynaipseError {}
export class ProjectScopeError extends SynaipseError {}
/**
 * A guarded write did not apply (plan P8 / B4): the note changed since the
 * caller read it (`expectedHash`), or `mode` did not match whether the
 * note exists. Nothing was written.
 */
export class WriteConflictError extends SynaipseError {
    public constructor(
        message: string,
        public readonly noteId: string,
        /** Hash of the note now, null when it does not exist. */
        public readonly currentHash: string | null
    ) {
        super(message);
    }
}
