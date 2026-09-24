// The slice of CodeMirror 6 the Studio uses, bundled once into lib/studio/vendor/codemirror.js
// by `npm run build:vendor`. Rebuild after bumping any @codemirror/* devDependency.
export { EditorView, keymap, Decoration, ViewPlugin } from '@codemirror/view';
export { EditorState, StateField, StateEffect, Compartment, RangeSetBuilder } from '@codemirror/state';
export { basicSetup } from 'codemirror';
export { markdown } from '@codemirror/lang-markdown';
export { yamlFrontmatter } from '@codemirror/lang-yaml';
export { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
export { tags } from '@lezer/highlight';
