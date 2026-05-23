export class TAbstractFile {
    path: string;

    constructor(path = "") {
        this.path = path;
    }
}

export class TFile extends TAbstractFile {
    extension: string;

    constructor(path = "") {
        super(path);
        this.extension = path.split(".").pop() ?? "";
    }
}

export class TFolder extends TAbstractFile {}

export class Notice {}

export class MarkdownView {}

export class Plugin {
    app: unknown;
    manifest: unknown;

    constructor(app?: unknown, manifest?: unknown) {
        this.app = app;
        this.manifest = manifest;
    }

    registerDomEvent(): void {}
}

export class PluginSettingTab {
    app: unknown;
    plugin: unknown;
    containerEl = {};

    constructor(app?: unknown, plugin?: unknown) {
        this.app = app;
        this.plugin = plugin;
    }
}

export class Setting {
    descEl = {
        createEl: () => ({
            setCssStyles: () => {},
            toggle: () => {},
        }),
    };
    settingEl = {};

    constructor(_containerEl?: unknown) {}
    setName(): this { return this; }
    setDesc(): this { return this; }
    addText(callback: (text: unknown) => unknown): this {
        callback({
            setPlaceholder: () => ({
                setValue: () => ({
                    onChange: () => {},
                    setDisabled: () => {},
                }),
            }),
            setValue: () => ({
                onChange: () => {},
                setDisabled: () => {},
            }),
        });
        return this;
    }
    addToggle(callback: (toggle: unknown) => unknown): this {
        callback({
            setValue: () => ({
                onChange: () => {},
            }),
        });
        return this;
    }
    addButton(callback: (button: unknown) => unknown): this {
        callback({
            buttonEl: {
                setText: () => {},
                toggleClass: () => {},
            },
            setButtonText: () => ({
                setTooltip: () => ({
                    onClick: () => {},
                }),
            }),
        });
        return this;
    }
}

export const Platform = {
    isMobile: false,
};

export function normalizePath(path: string): string {
    return path.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

export async function requestUrl(): Promise<never> {
    throw new Error("requestUrl mock was not configured");
}
