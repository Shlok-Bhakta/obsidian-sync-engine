export class TFile {
    path: string;
    extension: string;

    constructor(path = "") {
        this.path = path;
        this.extension = path.split(".").pop() ?? "";
    }
}

export class TFolder {
    path: string;

    constructor(path = "") {
        this.path = path;
    }
}

export class Notice {}

export function normalizePath(path: string): string {
    return path.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

export async function requestUrl(): Promise<never> {
    throw new Error("requestUrl mock was not configured");
}
