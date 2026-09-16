# Shared UI

`@multiplayer-ai/ui` owns the React presentation used by Next.js and the Electron renderer. Both apps consume the same TypeScript source through workspace dependencies; there is no separately published bundle or generated copy. Next.js transpiles it and electron-vite bundles it into the packaged renderer. React is a peer dependency.

## Ownership

| Directory                            | What belongs here                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `src/primitives`                     | Buttons, inputs, dialogs, sidebar, messages, Markdown and other reusable view elements           |
| `src/layouts`                        | The resizable room workspace; page mode stacks on mobile and window mode fills the desktop shell |
| `src/chat`                           | Selectable messages, display types, composer and draft acknowledgment rules                      |
| `src/ai`                             | Agent welcome state and user message bubble                                                      |
| `src/hooks`, `src/lib`, `src/styles` | UI hooks, class-name utilities, common theme and compact component styles                        |

Use direct subpath imports:

```tsx
import { Button } from "@multiplayer-ai/ui/primitives/button";
import { Composer } from "@multiplayer-ai/ui/chat/composer";
import { MessageList } from "@multiplayer-ai/ui/chat/message-list";
import { RoomWorkspace } from "@multiplayer-ai/ui/layouts/room-workspace";
```

The former `apps/*/.../components/ui` files are compatibility re-exports. Edit or add shared primitives here, including generated shadcn components, then expose them through a package subpath. Avoid regenerating implementations over the app facades. Keep client directives on interactive entry points and keep pure exports, such as `buttonVariants`, usable from Server Components.

## App adapters

Web's `Messages` maps database records into `ChatMessage`. Desktop's `GroupChatPanel` maps local records and passes selection/send callbacks. `ChatMessage` carries display fields, optional delivery state, accessible selection text and a footer. It does not import database or Electron contracts.

Web's `ThreadComposer` supplies its model switcher and accepted-revision handler. Desktop's `PromptInput` supplies compact styling and translates the bridge's boolean acknowledgment. Give each composer a stable `targetKey` for its draft owner. Web supplies a revision; the uncontrolled revision mode tracks edits inside the shared composer. A rejected or thrown submission retains the draft, repeated sends are blocked while pending, and late acknowledgments cannot clear a newer edit or another target. Length counting is configurable: web prompts use Unicode code points, while desktop matches its IPC string limits using UTF-16 code units.

`SidebarProvider` accepts `onPersistOpen`. Web owns its cookie in the app wrapper. The shared component never reads or writes cookies. The desktop's shell/sidebar, execution history, Mission Control, approvals, connection controls and runner configuration stay in desktop. AI SDK parts, web transport, server actions, authentication and session reconciliation stay in web. Product schemas remain in `@multiplayer-ai/domain`.

The package must not import Next.js, Electron, Node built-ins, database clients, provider implementations or app source. ESLint enforces these boundaries. Desktop currently renders plain text; moving Markdown here does not enable remote links, images or network access in Electron. Any future desktop Markdown adapter must respect the existing navigation and asset policy.

## Styling

Both app stylesheets import `styles/theme.css` and `styles/chat.css` after Tailwind. Both explicitly scan `packages/ui/src` with `@source`. Import `styles/markdown.css` in consumers that render Markdown; it includes Streamdown's stylesheet and source scanning. Each app owns its font loading, shell styles and platform-specific layout.

## Verification

From the repository root:

```powershell
pnpm check
pnpm --filter @multiplayer-ai/ui exec playwright install chromium
pnpm test:ui:e2e
pnpm test:desktop:e2e
```

The browser fixture exercises default and compact presentation, asynchronous sends, editing back to the same text, room switching, rejection/error recovery, IME, selection, sidebar persistence callbacks and responsive resizing. It uses local callbacks and makes no live backend or model calls. Screenshots and console diagnostics go to the ignored `output/playwright/ui-*` directory. Desktop fixture suites cover the real app adapters and IPC flows. Authenticated web/backend integration tests remain separate from these UI fixtures.

Turbo follows the apps' dependency on this source package for build invalidation. UI typechecks include the root TypeScript configuration. UI tests are uncached. Run the browser fixture and desktop checks locally using the commands above.
