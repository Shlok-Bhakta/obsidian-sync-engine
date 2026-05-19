export const MARKDOWN_FIELD = "markdown";

type YjsApi = {
    Doc: new () => {
        getText(name: string): {
            insert(index: number, text: string): void;
        };
        destroy(): void;
    };
    encodeStateAsUpdateV2(doc: any): Uint8Array;
};

export function docStateFromContent(content: string, Y: YjsApi): Uint8Array {
    const doc = new Y.Doc();
    doc.getText(MARKDOWN_FIELD).insert(0, content);
    const state = Y.encodeStateAsUpdateV2(doc);
    doc.destroy();
    return state;
}
