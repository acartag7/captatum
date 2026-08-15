export interface PlaywrightModule {
  chromium: {
    launch(options: Record<string, unknown>): Promise<PlaywrightBrowser>;
    connectOverCDP(endpoint: string): Promise<PlaywrightBrowser>;
  };
}

export interface PlaywrightBrowser {
  newContext(options: Record<string, unknown>): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

export interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
  /** Fires for EVERY page created in the context — including popups and
   *  popups-of-popups (page.on("popup") arms only the one page it is set on). */
  on(event: "page", handler: (page: PlaywrightPage) => void): void;
  /** Context-level interception covers EVERY page in the context — including
   *  popups, which page-level routing does not (the popup-egress fix). */
  route(pattern: string, handler: RouteHandler): Promise<void>;
  routeWebSocket?(pattern: string, handler: WebSocketHandler): Promise<void>;
}

export interface PlaywrightFrame {
  content(): Promise<string>;
}

export interface PlaywrightPage {
  route(pattern: string, handler: RouteHandler): Promise<void>;
  routeWebSocket?(pattern: string, handler: WebSocketHandler): Promise<void>;
  on(event: "download" | "websocket", handler: (value: PlaywrightEventValue) => void): void;
  /** Fired when the page opens a popup/new target — page.route does NOT cover it. */
  on(event: "popup", handler: (page: PlaywrightPage) => void): void;
  setDefaultTimeout?(timeoutMs: number): void;
  setDefaultNavigationTimeout?(timeoutMs: number): void;
  goto(url: string, options: Record<string, unknown>): Promise<PlaywrightResponse | null>;
  content(): Promise<string>;
  frames(): PlaywrightFrame[];
  mainFrame(): PlaywrightFrame;
  url(): string;
  waitForTimeout(ms: number): Promise<void>;
  waitForLoadState(state: string, options?: { timeout?: number }): Promise<void>;
  /** The browser's live DOM evaluation (#154) — used for `domTextLength` (document.body.innerText
   *  length), which captures shadow-DOM / computed-visible text the serialized-HTML extractor
   *  misses. Optional so test mocks need not implement it (the renderer guards the call). */
  evaluate?<T>(pageFunction: () => T): Promise<T>;
  close(): Promise<void>;
}

export type RouteHandler = (route: PlaywrightRoute) => Promise<void> | void;
export type WebSocketHandler = (socket: PlaywrightWebSocketRoute) => Promise<void> | void;
export type PlaywrightEventValue = PlaywrightDownload | PlaywrightWebSocket;

export interface PlaywrightRoute {
  request(): PlaywrightRequest;
  fulfill(options: {
    status: number;
    body: Uint8Array;
    contentType?: string;
    headers?: Record<string, string>;
  }): Promise<void>;
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}

export interface PlaywrightRequest {
  url(): string;
  method(): string;
  resourceType(): string;
  isNavigationRequest?(): boolean;
  /** The frame that issued the request; === page.mainFrame() for top-level requests. */
  frame?(): PlaywrightFrame;
  /** POST body bytes (#111 route gate); null when the request has no body. */
  postDataBuffer?(): Buffer | null;
  /** Request headers (#111 Content-Type allowlist + advisory Content-Length pre-check). */
  headers?(): Record<string, string>;
}

export interface PlaywrightResponse {
  status(): number;
}

export interface PlaywrightDownload {
  url(): string;
  cancel?(): Promise<void>;
}

export interface PlaywrightWebSocket {
  url(): string;
  close?(): Promise<void>;
}

export interface PlaywrightWebSocketRoute {
  url(): string;
  close(): Promise<void>;
}
