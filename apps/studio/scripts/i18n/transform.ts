import { Node, QuoteKind, SyntaxKind, type Expression, type SourceFile } from 'ts-morph'

import { isTranslatableAttr, isTranslatableText, TOAST_METHODS } from './classify'

const I18N_IMPORT = '@/lib/i18n'
const DYNAMIC_DISPLAY_PROPS = new Set(['label', 'title', 'description'])

// Turn an English source string into a valid single-quoted $t() call, escaping
// backslashes and single quotes. We use the $t alias (rather than a bare t)
// because many components have a local identifier named `t` in scope (e.g.
// `array.map((t, i) => ...)`), which would shadow or type-conflict with a
// plain `t` import.
function tCall(key: string): string {
  const escaped = key
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `$t('${escaped}')`
}

function directivePrologueCount(sf: SourceFile): number {
  let count = 0
  for (const stmt of sf.getStatements()) {
    if (Node.isExpressionStatement(stmt)) {
      const expr = stmt.getExpression()
      if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
        count++
        continue
      }
    }
    break
  }
  return count
}

function ensureImport(
  sf: SourceFile,
  hasDynamicDisplayValue: boolean,
  hasStaticTranslation: boolean
): void {
  // ts-morph defaults newly-generated nodes to double quotes; force single
  // quotes to match the codebase style for any import text we insert.
  sf.getProject().manipulationSettings.set({ quoteKind: QuoteKind.Single })

  const existing = sf.getImportDeclaration((d) => d.getModuleSpecifierValue() === I18N_IMPORT)
  if (existing) {
    const staticImport = existing
      .getNamedImports()
      .find((n) => n.getAliasNode()?.getText() === '$t')
    if (hasStaticTranslation && !staticImport) {
      existing.addNamedImport({ name: 't', alias: '$t' })
    } else if (!hasStaticTranslation && staticImport) {
      staticImport.remove()
    }
    if (
      hasDynamicDisplayValue &&
      !existing.getNamedImports().some((n) => n.getAliasNode()?.getText() === '$tValue')
    ) {
      existing.addNamedImport({ name: 'translateDisplayValue', alias: '$tValue' })
    }
    return
  }
  sf.insertImportDeclaration(directivePrologueCount(sf), {
    moduleSpecifier: I18N_IMPORT,
    namedImports: [
      ...(hasStaticTranslation ? [{ name: 't', alias: '$t' }] : []),
      ...(hasDynamicDisplayValue ? [{ name: 'translateDisplayValue', alias: '$tValue' }] : []),
    ],
  })
}

export function transformSourceFile(
  sf: SourceFile,
  options: { toastsOnly?: boolean } = {}
): { keys: string[]; changed: boolean } {
  const keys: string[] = []
  let changed = false
  let hasDynamicDisplayValue = false

  const record = (key: string) => {
    keys.push(key)
    changed = true
  }

  // 0) Already-wrapped $t('...') calls: collect their keys WITHOUT marking the
  //    file changed, so keys.json is always the full key list in use — a
  //    re-run over an already-wrapped tree must still report every key, not
  //    just the ones wrapped by this run.
  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return
    const expr = node.getExpression()
    if (!Node.isIdentifier(expr) || expr.getText() !== '$t') return
    const arg = node.getArguments()[0]
    if (arg && Node.isStringLiteral(arg)) keys.push(arg.getLiteralValue())
  })

  if (!options.toastsOnly) {
    // 1) JSX text nodes: <div>Save changes</div>
    sf.forEachDescendant((node) => {
      if (Node.isJsxText(node)) {
        const raw = node.getLiteralText()
        const trimmed = raw.trim()
        if (!isTranslatableText(trimmed)) return
        // Preserve surrounding whitespace around the wrapped expression.
        const leading = raw.slice(0, raw.indexOf(trimmed))
        const trailing = raw.slice(raw.indexOf(trimmed) + trimmed.length)
        // Collapse internal whitespace runs (including newlines from Prettier-wrapped
        // multi-line JSX text) to a single space, matching JSX's own runtime
        // whitespace-collapsing so the key matches the rendered English.
        const collapsed = trimmed.replace(/\s+/g, ' ')
        node.replaceWithText(`${leading}{${tCall(collapsed)}}${trailing}`)
        record(collapsed)
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

    // 3) JSX expression strings, including conditional values of text attrs.
    // Keep the condition and any non-text branches intact.
    const wrapExpressionText = (expression: Expression) => {
      if (Node.isConditionalExpression(expression)) {
        wrapExpressionText(expression.getWhenTrue())
        wrapExpressionText(expression.getWhenFalse())
      } else if (Node.isStringLiteral(expression)) {
        const value = expression.getLiteralValue()
        if (!isTranslatableText(value)) return
        expression.replaceWithText(tCall(value))
        record(value)
      } else if (
        Node.isPropertyAccessExpression(expression) &&
        DYNAMIC_DISPLAY_PROPS.has(expression.getName())
      ) {
        expression.replaceWithText(`$tValue(${expression.getText()})`)
        changed = true
        hasDynamicDisplayValue = true
      }
    }

    sf.forEachDescendant((node) => {
      if (!Node.isJsxExpression(node)) return
      const parent = node.getParent()
      if (Node.isJsxAttribute(parent) && !isTranslatableAttr(parent.getNameNode().getText())) return
      if (!Node.isJsxAttribute(parent) && !Node.isJsxElement(parent) && !Node.isJsxFragment(parent))
        return
      const expression = node.getExpression()
      if (expression) wrapExpressionText(expression)
    })
  }

  // Translate complete notification sentences, keeping dynamic values as
  // interpolation parameters so translators can reorder them safely.
  const visitedToastVariables = new Set<string>()
  const wrapToastText = (expression: Node): void => {
    if (
      Node.isJsxElement(expression) ||
      Node.isJsxSelfClosingElement(expression) ||
      Node.isJsxFragment(expression)
    ) {
      expression.forEachDescendant((node) => {
        if (Node.isJsxText(node)) {
          const raw = node.getLiteralText()
          const text = raw.trim().replace(/\s+/g, ' ')
          if (!isTranslatableText(text)) return
          const trimmed = raw.trim()
          const leading = raw.slice(0, raw.indexOf(trimmed))
          const trailing = raw.slice(raw.indexOf(trimmed) + trimmed.length)
          node.replaceWithText(`${leading}{${tCall(text)}}${trailing}`)
          record(text)
        } else if (
          Node.isJsxAttribute(node) &&
          [
            'message',
            'description',
            'progressPrefix',
            'labelBottom',
            'label',
            'title',
            'content',
          ].includes(node.getNameNode().getText())
        ) {
          const init = node.getInitializer()
          if (init && Node.isStringLiteral(init)) {
            const text = init.getLiteralValue()
            if (!isTranslatableText(text)) return
            init.replaceWithText(`{${tCall(text)}}`)
            record(text)
          } else if (init && Node.isJsxExpression(init)) {
            const value = init.getExpression()
            if (value) wrapToastText(value)
          }
        }
      })
    } else if (Node.isIdentifier(expression)) {
      for (const definition of expression.getDefinitions()) {
        const declaration = definition.getDeclarationNode()
        if (!declaration || !Node.isVariableDeclaration(declaration)) continue
        // Module-scope config must stay English until it is rendered.
        if (
          !declaration.getFirstAncestor(
            (node) =>
              Node.isArrowFunction(node) ||
              Node.isFunctionDeclaration(node) ||
              Node.isMethodDeclaration(node)
          )
        )
          continue
        const id = `${declaration.getSourceFile().getFilePath()}:${declaration.getStart()}`
        if (visitedToastVariables.has(id)) continue
        visitedToastVariables.add(id)
        const init = declaration.getInitializer()
        if (init && declaration.getSourceFile() === sf) wrapToastText(init)
      }
    } else if (Node.isConditionalExpression(expression)) {
      wrapToastText(expression.getWhenTrue())
      wrapToastText(expression.getWhenFalse())
    } else if (Node.isParenthesizedExpression(expression)) {
      wrapToastText(expression.getExpression())
    } else if (
      Node.isBinaryExpression(expression) &&
      ['??', '||'].includes(expression.getOperatorToken().getText())
    ) {
      wrapToastText(expression.getLeft())
      wrapToastText(expression.getRight())
    } else if (
      Node.isStringLiteral(expression) ||
      Node.isNoSubstitutionTemplateLiteral(expression)
    ) {
      const value = expression.getLiteralValue()
      if (!isTranslatableText(value)) return
      expression.replaceWithText(tCall(value))
      record(value)
    } else if (
      Node.isBinaryExpression(expression) &&
      expression.getOperatorToken().getText() === '+'
    ) {
      const parts: Node[] = []
      const flatten = (node: Node): void => {
        if (Node.isBinaryExpression(node) && node.getOperatorToken().getText() === '+') {
          flatten(node.getLeft())
          flatten(node.getRight())
        } else {
          parts.push(node)
        }
      }
      flatten(expression)
      // Only concatenate messages that start with text; numeric addition and
      // unknown operands must retain their original JavaScript semantics.
      if (
        !Node.isStringLiteral(parts[0]) &&
        !Node.isNoSubstitutionTemplateLiteral(parts[0]) &&
        !Node.isTemplateExpression(parts[0])
      )
        return
      let key = ''
      const values: string[] = []
      for (const part of parts) {
        if (Node.isStringLiteral(part) || Node.isNoSubstitutionTemplateLiteral(part)) {
          key += part.getLiteralValue()
        } else if (Node.isTemplateExpression(part)) {
          key += part.getHead().compilerNode.text
          for (const span of part.getTemplateSpans()) {
            key += `{{value${values.length}}}` + span.getLiteral().compilerNode.text
            values.push(`value${values.length}: ${span.getExpression().getText()}`)
          }
        } else {
          key += `{{value${values.length}}}`
          values.push(`value${values.length}: ${part.getText()}`)
        }
      }
      if (!isTranslatableText(key)) return
      expression.replaceWithText(tCall(key).slice(0, -1) + `, { ${values.join(', ')} })`)
      record(key)
    } else if (Node.isTemplateExpression(expression)) {
      const spans = expression.getTemplateSpans()
      if (
        !expression.getHead().compilerNode.text &&
        spans.length === 1 &&
        !spans[0].getLiteral().compilerNode.text
      ) {
        // A template containing only a conditional message has no sentence of
        // its own. Translate its branches instead of inventing a placeholder key.
        wrapToastText(spans[0].getExpression())
        return
      }
      let key = expression.getHead().compilerNode.text
      const values: string[] = []
      expression.getTemplateSpans().forEach((span, index) => {
        key += `{{value${index}}}` + span.getLiteral().compilerNode.text
        const value = span.getExpression()
        // English plural suffixes are grammatical text, not user data. Keep
        // them in English fallback and translate them to empty text in Chinese.
        if (Node.isConditionalExpression(value)) {
          for (const branch of [value.getWhenTrue(), value.getWhenFalse()]) {
            if (Node.isStringLiteral(branch) && branch.getLiteralValue() === 's') {
              branch.replaceWithText(tCall('s'))
              record('s')
            }
          }
        }
        values.push(`value${index}: ${span.getExpression().getText()}`)
      })
      if (!isTranslatableText(key)) return
      expression.replaceWithText(tCall(key).slice(0, -1) + `, { ${values.join(', ')} })`)
      record(key)
    }
  }

  const wrapToastOptions = (options: Node | undefined, promise = false): void => {
    if (!options || !Node.isObjectLiteralExpression(options)) return
    for (const property of options.getProperties()) {
      if (!Node.isPropertyAssignment(property)) continue
      const name = property.getName().replace(/^['"]|['"]$/g, '')
      const value = property.getInitializer()
      if (!value) continue
      if (name === 'description' || (promise && ['loading', 'success', 'error'].includes(name))) {
        if (Node.isArrowFunction(value)) {
          const body = value.getBody()
          if (Node.isBlock(body)) {
            body.forEachDescendant((node) => {
              // Do not rewrite returns belonging to nested callbacks.
              if (
                Node.isReturnStatement(node) &&
                node.getFirstAncestorByKind(SyntaxKind.ArrowFunction) === value
              ) {
                const returned = node.getExpression()
                if (returned) wrapToastText(returned)
              }
            })
          } else {
            wrapToastText(body)
          }
        } else {
          wrapToastText(value)
        }
      }
    }
  }

  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return
    const expr = node.getExpression()
    let method: string | undefined
    if (Node.isPropertyAccessExpression(expr) && expr.getExpression().getText() === 'toast') {
      method = expr.getName()
    } else if (Node.isIdentifier(expr) && expr.getText() === 'toast') {
      method = 'toast'
    }
    if (method === 'promise') {
      wrapToastOptions(node.getArguments()[1], true)
    } else if (method && TOAST_METHODS.has(method)) {
      const arg = node.getArguments()[0]
      if (arg) wrapToastText(arg)
      wrapToastOptions(node.getArguments()[1])
    }
  })

  const interpolationWords = new Set([
    's',
    'y',
    'ies',
    'created',
    'updated',
    'enabled',
    'disabled',
    'downgraded',
    'upgraded',
    're-enable',
    'disable',
    'policy',
    'policies',
    'secret',
    'publishable',
    'row',
    'rows',
    'function',
    'functions',
    'deleted',
    'saved',
  ])
  const wrapInterpolationText = (node: Node): void => {
    if (Node.isConditionalExpression(node)) {
      wrapInterpolationText(node.getWhenTrue())
      wrapInterpolationText(node.getWhenFalse())
    } else if (
      Node.isBinaryExpression(node) &&
      ['??', '||'].includes(node.getOperatorToken().getText())
    ) {
      wrapInterpolationText(node.getLeft())
      wrapInterpolationText(node.getRight())
    } else if (Node.isStringLiteral(node)) {
      const text = node.getLiteralValue()
      if (!isTranslatableText(text) && !interpolationWords.has(text)) return
      node.replaceWithText(tCall(text))
      record(text)
    }
  }
  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node) || node.getExpression().getText() !== '$t') return
    const vars = node.getArguments()[1]
    if (!vars || !Node.isObjectLiteralExpression(vars)) return
    for (const property of vars.getProperties()) {
      if (!Node.isPropertyAssignment(property) || !/^value\d+$/.test(property.getName())) continue
      const value = property.getInitializer()
      if (value) wrapInterpolationText(value)
    }
  })

  const hasStaticTranslation = sf
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .some(
      (call) => Node.isIdentifier(call.getExpression()) && call.getExpression().getText() === '$t'
    )
  const staticImport = sf
    .getImportDeclaration((declaration) => declaration.getModuleSpecifierValue() === I18N_IMPORT)
    ?.getNamedImports()
    .some((namedImport) => namedImport.getAliasNode()?.getText() === '$t')
  const staleStaticImport = !hasStaticTranslation && staticImport
  if (changed || staleStaticImport || (hasStaticTranslation && !staticImport)) {
    ensureImport(sf, hasDynamicDisplayValue, hasStaticTranslation)
    changed = true
  }
  return { keys, changed }
}
