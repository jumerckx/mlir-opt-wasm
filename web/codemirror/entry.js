// Re-export every CodeMirror symbol the demo touches. esbuild bundles this
// into a single ESM file so the browser loads CodeMirror locally and every
// symbol shares one module instance (no Facet/instanceof duplication).
export {
  EditorState,
  StateField,
  StateEffect,
  RangeSetBuilder,
  Compartment,
} from "@codemirror/state";

export {
  EditorView,
  Decoration,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";

export {
  history,
  defaultKeymap,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";

export {
  indentUnit,
  bracketMatching,
  foldGutter,
  foldKeymap,
} from "@codemirror/language";
