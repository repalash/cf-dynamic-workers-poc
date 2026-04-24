// Chat widget HTML imported as a raw string and injected into dynamic worker
// HTML responses by the host worker via HTMLRewriter.
// @ts-ignore — ?raw import resolved at build time
import widgetHtml from "./chat-widget.html?raw"

export const CHAT_WIDGET_HTML: string = widgetHtml
