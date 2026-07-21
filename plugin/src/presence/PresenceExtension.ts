import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import * as Y from "yjs";
import { base64ToBytes, bytesToBase64 } from "../sync/storage";

export type RemotePresence = { clientId: string; name: string; color: string; anchor: number; head: number };
export const setRemotePresence = StateEffect.define<RemotePresence[]>();

class CaretWidget extends WidgetType {
  constructor(private readonly name: string, private readonly color: string) { super(); }
  toDOM(): HTMLElement {
    const caret = activeDocument.createElement("span");
    caret.className = "obsidian-sync-remote-caret";
    caret.style.setProperty("--sync-presence-color", this.color);
    const label = caret.createSpan({ cls: "obsidian-sync-remote-caret-label", text: this.name });
    label.style.setProperty("--sync-presence-color", this.color);
    return caret;
  }
}

function decorations(states: RemotePresence[]): DecorationSet {
  const ranges = states.flatMap((state) => {
    const from = Math.min(state.anchor, state.head);
    const to = Math.max(state.anchor, state.head);
    const result = [Decoration.widget({ widget: new CaretWidget(state.name, state.color), side: 1 }).range(state.head)];
    if (from !== to) result.push(Decoration.mark({ class: "obsidian-sync-remote-selection", attributes: { style: `--sync-presence-color:${state.color}` } }).range(from, to));
    return result;
  }).sort((a, b) => a.from - b.from);
  return Decoration.set(ranges, true);
}

const presenceField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setRemotePresence)) return decorations(effect.value);
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function presenceExtension(): Extension { return presenceField; }

export function encodeRelativePosition(type: Y.Text, index: number): string {
  return bytesToBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(type, index)));
}

export function decodeRelativePosition(value: string, doc: Y.Doc): number | null {
  const absolute = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(base64ToBytes(value)), doc);
  return absolute?.index ?? null;
}

export function colorForIdentity(identity: string, dark: boolean): string {
  let hash = 2166136261;
  for (const character of identity) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const hue = Math.abs(hash) % 360;
  const saturation = 0.65;
  const lightness = dark ? 0.68 : 0.42;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const offset = lightness - chroma / 2;
  const [r, g, b] = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return `#${[r, g, b].map((value) => Math.round((value + offset) * 255).toString(16).padStart(2, "0")).join("")}`;
}
