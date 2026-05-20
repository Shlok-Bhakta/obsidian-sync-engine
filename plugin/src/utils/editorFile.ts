import { App, Editor, MarkdownView, TFile } from "obsidian";
import { EditorView } from "@codemirror/view";

export function editorViewFor(editor: Editor): EditorView | null {
	const cm = (editor as Editor & { cm?: EditorView }).cm;
	return cm ?? null;
}

export function fileForEditorView(app: App, editorView: EditorView): TFile | null {
	const leaves = app.workspace.getLeavesOfType("markdown");
	for (const leaf of leaves) {
		const view = leaf.view;
		if (view instanceof MarkdownView && editorViewFor(view.editor) === editorView) {
			return view.file;
		}
	}
	return null;
}
