/**
 * Ambient declarations for the browser client bundle.
 *
 * The bundle resolves nothing from the host's frozen platform module table:
 * icons are drawn locally, so the only ambient surface left is the CSS module
 * import (the client-platform compiler turns it into an injected stylesheet
 * plus a class-name map).
 */

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
