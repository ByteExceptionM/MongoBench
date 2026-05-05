/**
 * Monaco worker bootstrap. Vite ?worker imports bundle each language
 * worker as a separate chunk; we set MonacoEnvironment.getWorker so
 * Monaco picks the right one without the default CDN loader.
 *
 * Imported once from main.tsx — the side effect installs the global
 * and registers the MongoBench-branded editor theme.
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

// Custom theme aligned with the app's CSS variables so the editor blends
// into the surrounding card surface instead of looking like a foreign
// (warm-grey) strip pasted in.
monaco.editor.defineTheme('mongobench-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'string.key.json', foreground: '8ad6ff' },
    { token: 'string.value.json', foreground: 'cfd6dd' },
    { token: 'number', foreground: '6ee7b7' },
    { token: 'keyword.json', foreground: 'f0abfc' },
    { token: 'delimiter.bracket.json', foreground: '64748b' },
    { token: 'delimiter.array.json', foreground: '64748b' },
    { token: 'delimiter.colon.json', foreground: '64748b' },
    { token: 'delimiter.comma.json', foreground: '64748b' }
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
