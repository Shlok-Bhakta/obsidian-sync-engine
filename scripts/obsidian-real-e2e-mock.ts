export * from "../plugin/src/test/obsidianMock";

type RequestUrlOptions = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
};

export async function requestUrl(options: RequestUrlOptions): Promise<{
  status: number;
  text: string;
  arrayBuffer: ArrayBuffer;
}> {
  const response = await fetch(options.url, {
    method: options.method ?? "GET",
    headers: options.headers,
    body: options.body,
  });
  const arrayBuffer = await response.arrayBuffer();
  return {
    status: response.status,
    text: new TextDecoder().decode(arrayBuffer),
    arrayBuffer,
  };
}
