import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const mainPath = fileURLToPath(new URL('../../src/electron/main.cjs', import.meta.url));
const nodeModuleTypesPath = fileURLToPath(new URL('../../node_modules/@types/node/module.d.ts', import.meta.url));

test('Electron main has no undeclared or typo-suggested identifiers', () => {
  const program = ts.createProgram([mainPath, nodeModuleTypesPath], {
    allowJs: true,
    checkJs: true,
    noResolve: true,
    noEmit: true,
    skipLibCheck: true,
    types: ['node'],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  });
  const mainSource = program.getSourceFile(mainPath);
  assert.ok(mainSource, 'TypeScript must load the Electron main source');
  const scopeDiagnosticCodes = new Set([2304, 2552]);
  const undeclared = ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => scopeDiagnosticCodes.has(diagnostic.code) && diagnostic.file === mainSource)
    .map((diagnostic) => {
      const position = diagnostic.file && diagnostic.start != null
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : null;
      return {
        line: position ? position.line + 1 : null,
        column: position ? position.character + 1 : null,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      };
    });

  assert.deepEqual(undeclared, []);
});
