import { Node, QuoteKind, type SourceFile } from 'ts-morph'

import { isTranslatableAttr, isTranslatableText, TOAST_METHODS } from './classify'

const I18N_IMPORT = '@/lib/i18n'

// Turn an English source string into a valid single-quoted t() call, escaping
// backslashes and single quotes.
function tCall(key: string): string {
  const escaped = key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return `t('${escaped}')`
}

function ensureImport(sf: SourceFile): void {
  // ts-morph defaults newly-generated nodes to double quotes; force single
  // quotes to match the codebase style for any import text we insert.
  sf.getProject().manipulationSettings.set({ quoteKind: QuoteKind.Single })

  const existing = sf.getImportDeclaration((d) => d.getModuleSpecifierValue() === I18N_IMPORT)
  if (existing) {
    if (!existing.getNamedImports().some((n) => n.getName() === 't')) {
      existing.addNamedImport('t')
    }
    return
  }
  sf.insertImportDeclaration(0, { moduleSpecifier: I18N_IMPORT, namedImports: ['t'] })
}

export function transformSourceFile(sf: SourceFile): { keys: string[]; changed: boolean } {
  const keys: string[] = []
  let changed = false

  const record = (key: string) => {
    keys.push(key)
    changed = true
  }

  // 1) JSX text nodes: <div>Save changes</div>
  sf.forEachDescendant((node) => {
    if (Node.isJsxText(node)) {
      const raw = node.getLiteralText()
      const trimmed = raw.trim()
      if (!isTranslatableText(trimmed)) return
      // Preserve surrounding whitespace around the wrapped expression.
      const leading = raw.slice(0, raw.indexOf(trimmed))
      const trailing = raw.slice(raw.indexOf(trimmed) + trimmed.length)
      node.replaceWithText(`${leading}{${tCall(trimmed)}}${trailing}`)
      record(trimmed)
    }
  })

  // 2) JSX attributes: placeholder="Search tables"
  sf.forEachDescendant((node) => {
    if (Node.isJsxAttribute(node)) {
      const name = node.getNameNode().getText()
      if (!isTranslatableAttr(name)) return
      const init = node.getInitializer()
      if (init && Node.isStringLiteral(init)) {
        const value = init.getLiteralValue()
        if (!isTranslatableText(value)) return
        init.replaceWithText(`{${tCall(value)}}`)
        record(value)
      }
    }
  })

  // 3) sonner toast calls: toast.success('Saved successfully')
  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return
    const expr = node.getExpression()
    let method: string | undefined
    if (Node.isPropertyAccessExpression(expr) && expr.getExpression().getText() === 'toast') {
      method = expr.getName()
    } else if (Node.isIdentifier(expr) && expr.getText() === 'toast') {
      method = 'toast'
    }
    if (!method || !TOAST_METHODS.has(method)) return
    const arg = node.getArguments()[0]
    if (arg && Node.isStringLiteral(arg)) {
      const value = arg.getLiteralValue()
      if (!isTranslatableText(value)) return
      arg.replaceWithText(tCall(value))
      record(value)
    }
  })

  if (changed) ensureImport(sf)
  return { keys, changed }
}
