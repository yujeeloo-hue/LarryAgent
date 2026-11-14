/** Let a sandboxed demo request Escape dismissal without parent DOM access. */
export const DEMO_ESCAPE_MESSAGE_TYPE = "jellybot-demo-escape";

export function withDemoEscapeBridge(html: string): string {
  // Prepending after the doctype preserves standards mode and also works if
  // the demo ends in an unclosed comment/tag. Its own handled Esc takes priority.
  const bridge = `<script>window.addEventListener("keydown",function(event){if(event.key==="Escape"&&!event.isComposing)setTimeout(function(){if(!event.defaultPrevented)parent.postMessage({type:"${DEMO_ESCAPE_MESSAGE_TYPE}"},"*")},0)});</script>`;
  const doctype = html.match(/^\s*<!doctype\s[^>]*>/i);
  const offset = doctype?.[0].length ?? 0;
  return html.slice(0, offset) + bridge + html.slice(offset);
}
