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