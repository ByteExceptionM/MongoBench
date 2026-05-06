/**
 * Monaco worker bootstrap. Vite ?worker imports bundle each language
 * worker as a separate chunk; we set MonacoEnvironment.getWorker so
 * Monaco picks the right one without the default CDN loader.
 *
 * Imported once from main.tsx — the side effect installs the global,
 * registers the MongoBench-branded editor theme, and registers the
 * `mongo-shell` language used by the document editor and query toolbar.
 */
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') return new JsonWorker()
    return new EditorWorker()
  }
}

/**
 * Custom MongoDB shell-flavored EJSON language.
 *
 * Plain Monaco JSON would leave shell helpers (`ObjectId(...)`, `ISODate(...)`)
 * and unquoted keys uncolored. This monarch tokenizer recognizes the same
 * surface accepted by `mongoQueryLang.ts` so the document editor and the
 * query toolbar render with consistent, subtle colors.
 */
monaco.languages.register({ id: 'mongo-shell' })

monaco.languages.setLanguageConfiguration('mongo-shell', {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string'] },
    { open: "'", close: "'", notIn: ['string'] }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ]
})

monaco.languages.setMonarchTokensProvider('mongo-shell', {
  defaultToken: '',
  tokenPostfix: '.mongo',

  // BSON / shell value constructors recognized by mongoQueryLang.
  helpers: [
    'ObjectId',
    'ISODate',
    'Date',
    'NumberLong',
    'NumberInt',
    'NumberDouble',
    'NumberDecimal',
    'Long',
    'Int32',
    'Decimal128',
    'UUID',
    'JUUID',
    'BinData',
    'Timestamp',
    'MinKey',
    'MaxKey',
    'DBRef',
    'Code',
    'Symbol',
    'RegExp'
  ],

  keywords: ['true', 'false', 'null', 'undefined', 'new'],

  tokenizer: {
    root: [
      { include: '@whitespace' },

      // Standalone helpers: MinKey / MaxKey without parens.
      [/\b(MinKey|MaxKey)\b(?!\s*\()/, 'type.identifier'],

      // Helper invocation: identifier followed by `(`.
      [
        /[A-Za-z_$][\w$]*(?=\s*\()/,
        {
          cases: {
            '@helpers': 'type.identifier',
            '@keywords': 'keyword',
            '@default': 'identifier.invocation'
          }
        }
      ],

      // Identifier (unquoted key, or bare value keyword).
      [
        /[A-Za-z_$][\w$]*/,
        {
          cases: {
            '@keywords': 'keyword',
            '@default': 'identifier'
          }
        }
      ],

      [/[{}()[\]]/, '@brackets'],
      [/:/, 'delimiter.colon'],
      [/,/, 'delimiter.comma'],

      // Numbers
      [/-?\d+\.\d+([eE][+-]?\d+)?/, 'number.float'],
      [/-?\.\d+([eE][+-]?\d+)?/, 'number.float'],
      [/-?0[xX][0-9a-fA-F]+/, 'number.hex'],
      [/-?\d+([eE][+-]?\d+)?/, 'number'],

      // Strings — `$`-prefixed strings (operators / EJSON wrapper keys)
      // get their own token so they pop visually against regular keys.
      [/"\$[A-Za-z][\w]*"/, 'string.dollar'],
      [/"/, { token: 'string.quote', bracket: '@open', next: '@string_double' }],
      [/'/, { token: 'string.quote', bracket: '@open', next: '@string_single' }],

      // Regex literal
      [/\/(?=([^\\/]|\\.)+\/[gimsuy]*)/, { token: 'regexp', next: '@regex' }]
    ],

    string_double: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, { token: 'string.quote', bracket: '@close', next: '@pop' }]
    ],

    string_single: [
      [/[^\\']+/, 'string'],
      [/\\./, 'string.escape'],
      [/'/, { token: 'string.quote', bracket: '@close', next: '@pop' }]
    ],

    regex: [
      [/\\./, 'regexp.escape'],
      [/\//, { token: 'regexp', next: '@regexFlags' }],
      [/[^/\\]+/, 'regexp']
    ],

    regexFlags: [
      [/[gimsuy]+/, { token: 'regexp', next: '@pop' }],
      [/./, { token: '', next: '@pop' }]
    ],

    whitespace: [
      [/\s+/, ''],
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@block_comment']
    ],

    block_comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment']
    ]
  }
})

// Subtle, low-saturation palette. The goal is *gentle* tinting against the
// dark editor background — values still read as text first, color second.
monaco.editor.defineTheme('mongobench-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    // Plain JSON (kept for any leftover json editors)
    { token: 'string.key.json', foreground: 'a8c5e8' },
    { token: 'string.value.json', foreground: 'd4d8de' },
    { token: 'number', foreground: '8de4d2' },
    { token: 'keyword.json', foreground: 'd9a3e8' },
    { token: 'delimiter.bracket.json', foreground: '64748b' },
    { token: 'delimiter.array.json', foreground: '64748b' },
    { token: 'delimiter.colon.json', foreground: '64748b' },
    { token: 'delimiter.comma.json', foreground: '64748b' },

    // mongo-shell tokens
    { token: 'type.identifier.mongo', foreground: 'b9a8e8' }, // ObjectId / ISODate / NumberLong …
    { token: 'identifier.invocation.mongo', foreground: 'b9a8e8' },
    { token: 'identifier.mongo', foreground: 'a8c5e8' }, // unquoted keys
    { token: 'keyword.mongo', foreground: 'd9a3e8' }, // true / false / null / undefined
    { token: 'string.mongo', foreground: 'd4d8de' },
    { token: 'string.escape.mongo', foreground: 'e8c894' },
    { token: 'string.quote.mongo', foreground: '8b96a3' },
    { token: 'string.dollar.mongo', foreground: 'e0a07a' }, // "$gt", "$oid", …
    { token: 'number.mongo', foreground: '8de4d2' },
    { token: 'number.float.mongo', foreground: '8de4d2' },
    { token: 'number.hex.mongo', foreground: '8de4d2' },
    { token: 'regexp.mongo', foreground: 'e8b885' },
    { token: 'regexp.escape.mongo', foreground: 'e8c894' },
    { token: 'comment.mongo', foreground: '5b6470' },
    { token: 'delimiter.colon.mongo', foreground: '64748b' },
    { token: 'delimiter.comma.mongo', foreground: '64748b' }
  ],
  colors: {
    'editor.background': '#13171c',
    'editor.foreground': '#e6edf3',
    'editor.lineHighlightBackground': '#1c2228',
    'editor.lineHighlightBorder': '#1c2228',
    'editorLineNumber.foreground': '#4b5663',
    'editorLineNumber.activeForeground': '#a8b3bd',
    'editorIndentGuide.background1': '#1f262e',
    'editorIndentGuide.activeBackground1': '#2a323b',
    'editorGutter.background': '#13171c',
    'editor.selectionBackground': '#2c3a4a',
    'editor.inactiveSelectionBackground': '#23303d',
    'editorCursor.foreground': '#22e0e9',
    'editorWidget.background': '#171c22',
    'editorWidget.border': '#2a323b',
    'scrollbarSlider.background': '#2a323b80',
    'scrollbarSlider.hoverBackground': '#3a4350aa',
    'scrollbarSlider.activeBackground': '#4a5260cc'
  }
})

loader.config({ monaco })

void loader.init()
