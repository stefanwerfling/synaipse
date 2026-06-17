import ts from 'typescript';

/**
 * Parse a TypeScript / JavaScript source file into a structured summary —
 * exported symbols and import edges — so the code crawler can render a
 * note with wikilinks across the dependency graph.
 *
 * Single-file parsing; no full type-checker because we don't need types,
 * we need shape + module references.
 */

export type ExportKind = 'function' | 'class' | 'interface' | 'type' | 'const' | 'enum' | 're-export';

export interface CodeExport {
    kind: ExportKind;
    name: string;
    /** One-line signature for functions, the type expression for type aliases. */
    signature: string;
    /** Leading JSDoc / line-comment summary, if present. */
    docstring: string | null;
}

export interface CodeImport {
    /** The string from the import statement, e.g. `./utils` or `node:fs`. */
    moduleSpecifier: string;
    /** True if `./` or `../` — needs path resolution. */
    isRelative: boolean;
    /** Names imported from the module — `[]` for side-effect-only imports. */
    names: string[];
}

export interface ParsedCodeFile {
    language: 'typescript' | 'javascript';
    lines: number;
    exports: CodeExport[];
    imports: CodeImport[];
    /** Top-of-file comment (often a banner/docstring describing the module). */
    fileDoc: string | null;
}

const trimLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

const stripJsDoc = (raw: string): string => {
    return raw
        .split('\n')
        .map((line) => line.replace(/^\s*\*\s?/, '').replace(/^\s*\/\*+/, '').replace(/\*+\/\s*$/, ''))
        .filter((line) => line.length > 0 && !line.startsWith('@'))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
};

const stripLineComment = (raw: string): string => {
    return raw
        .split('\n')
        .map((line) => line.replace(/^\s*\/\/\s?/, ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
};

const leadingDoc = (node: ts.Node, source: string): string | null => {
    const ranges = ts.getLeadingCommentRanges(source, node.getFullStart());
    if (ranges === undefined || ranges.length === 0) return null;

    const last = ranges[ranges.length - 1];
    if (last === undefined) return null;

    const text = source.slice(last.pos, last.end);

    if (text.startsWith('/**')) return stripJsDoc(text);
    if (text.startsWith('//')) return stripLineComment(text);
    return null;
};

const isExported = (node: ts.Node): boolean => {
    if (!ts.canHaveModifiers(node)) return false;
    const modifiers = ts.getModifiers(node);
    if (modifiers === undefined) return false;
    return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
};

const signatureOfFunction = (node: ts.FunctionDeclaration, source: string): string => {
    const params = node.parameters.map((p) => p.getText(node.getSourceFile())).join(', ');
    const ret = node.type !== undefined ? `: ${node.type.getText(node.getSourceFile())}` : '';
    void source;
    return trimLine(`function ${node.name?.text ?? ''}(${params})${ret}`);
};

const signatureOfClass = (node: ts.ClassDeclaration): string => {
    const heritage = node.heritageClauses?.map((c) => c.getText(node.getSourceFile())).join(' ') ?? '';
    return trimLine(`class ${node.name?.text ?? '<anonymous>'} ${heritage}`);
};

const signatureOfInterface = (node: ts.InterfaceDeclaration): string => {
    const heritage = node.heritageClauses?.map((c) => c.getText(node.getSourceFile())).join(' ') ?? '';
    return trimLine(`interface ${node.name.text} ${heritage}`);
};

const signatureOfType = (node: ts.TypeAliasDeclaration): string => {
    return trimLine(`type ${node.name.text} = ${node.type.getText(node.getSourceFile()).slice(0, 200)}`);
};

const signatureOfEnum = (node: ts.EnumDeclaration): string => {
    return `enum ${node.name.text}`;
};

const extractImports = (source: ts.SourceFile): CodeImport[] => {
    const out: CodeImport[] = [];

    for (const stmt of source.statements) {
        if (!ts.isImportDeclaration(stmt)) continue;
        const spec = stmt.moduleSpecifier;
        if (!ts.isStringLiteral(spec)) continue;

        const names: string[] = [];
        const clause = stmt.importClause;

        if (clause !== undefined) {
            if (clause.name !== undefined) names.push(clause.name.text);

            const bindings = clause.namedBindings;
            if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
                names.push(`* as ${bindings.name.text}`);
            } else if (bindings !== undefined && ts.isNamedImports(bindings)) {
                for (const el of bindings.elements) {
                    names.push(el.name.text);
                }
            }
        }

        out.push({
            moduleSpecifier: spec.text,
            isRelative: spec.text.startsWith('.'),
            names
        });
    }

    return out;
};

const extractExports = (source: ts.SourceFile): CodeExport[] => {
    const out: CodeExport[] = [];

    for (const stmt of source.statements) {
        if (ts.isFunctionDeclaration(stmt) && isExported(stmt) && stmt.name !== undefined) {
            out.push({
                kind: 'function',
                name: stmt.name.text,
                signature: signatureOfFunction(stmt, source.getFullText()),
                docstring: leadingDoc(stmt, source.getFullText())
            });
            continue;
        }

        if (ts.isClassDeclaration(stmt) && isExported(stmt) && stmt.name !== undefined) {
            out.push({
                kind: 'class',
                name: stmt.name.text,
                signature: signatureOfClass(stmt),
                docstring: leadingDoc(stmt, source.getFullText())
            });
            continue;
        }

        if (ts.isInterfaceDeclaration(stmt) && isExported(stmt)) {
            out.push({
                kind: 'interface',
                name: stmt.name.text,
                signature: signatureOfInterface(stmt),
                docstring: leadingDoc(stmt, source.getFullText())
            });
            continue;
        }

        if (ts.isTypeAliasDeclaration(stmt) && isExported(stmt)) {
            out.push({
                kind: 'type',
                name: stmt.name.text,
                signature: signatureOfType(stmt),
                docstring: leadingDoc(stmt, source.getFullText())
            });
            continue;
        }

        if (ts.isEnumDeclaration(stmt) && isExported(stmt)) {
            out.push({
                kind: 'enum',
                name: stmt.name.text,
                signature: signatureOfEnum(stmt),
                docstring: leadingDoc(stmt, source.getFullText())
            });
            continue;
        }

        if (ts.isVariableStatement(stmt) && isExported(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (!ts.isIdentifier(decl.name)) continue;

                const type = decl.type !== undefined ? `: ${decl.type.getText(source).slice(0, 120)}` : '';
                out.push({
                    kind: 'const',
                    name: decl.name.text,
                    signature: trimLine(`const ${decl.name.text}${type}`),
                    docstring: leadingDoc(stmt, source.getFullText())
                });
            }
            continue;
        }

        if (ts.isExportDeclaration(stmt)) {
            const spec = stmt.moduleSpecifier;
            const from = spec !== undefined && ts.isStringLiteral(spec) ? spec.text : '?';

            if (stmt.exportClause !== undefined && ts.isNamedExports(stmt.exportClause)) {
                for (const el of stmt.exportClause.elements) {
                    out.push({
                        kind: 're-export',
                        name: el.name.text,
                        signature: `export {${el.name.text}} from '${from}'`,
                        docstring: null
                    });
                }
            }
            continue;
        }
    }

    return out;
};

const extractFileDoc = (source: ts.SourceFile): string | null => {
    const text = source.getFullText();
    const ranges = ts.getLeadingCommentRanges(text, 0);
    if (ranges === undefined || ranges.length === 0) return null;

    const first = ranges[0];
    if (first === undefined) return null;

    const raw = text.slice(first.pos, first.end);
    if (raw.startsWith('/**')) return stripJsDoc(raw);
    if (raw.startsWith('//')) return stripLineComment(raw);
    return null;
};

export const parseCodeFile = (filePath: string, content: string): ParsedCodeFile => {
    const isTs = /\.tsx?$/.test(filePath);
    const source = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        isTs ? ts.ScriptKind.TSX : ts.ScriptKind.JS
    );

    return {
        language: isTs ? 'typescript' : 'javascript',
        lines: content.split('\n').length,
        exports: extractExports(source),
        imports: extractImports(source),
        fileDoc: extractFileDoc(source)
    };
};