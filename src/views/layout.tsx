/** @jsxImportSource hono/jsx */
// src/views/layout.tsx — top-level HTML chrome.

export const Layout = (props: { title: string; children: any }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{props.title}</title>
      <link rel="stylesheet" href="/styles.css" />
      <script src="/static/sessions.js" defer></script>
    </head>
    <body>
      <header class="topbar">
        <a href="/" class="brand">
          pi sessions <span class="dim">viewer</span>
        </a>
      </header>
      <main>{props.children}</main>
    </body>
  </html>
);
