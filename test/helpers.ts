import { JSDOM } from 'jsdom';

export interface DomHandle {
  window: Window & typeof globalThis;
  document: Document;
}

export function buildDom(html: string): DomHandle {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  return {
    window: dom.window as unknown as Window & typeof globalThis,
    document: dom.window.document,
  };
}
