# Third-party components

This project uses external packages. Their own licenses and notices apply; the lockfile records exact installed versions. This file is not a replacement for those licenses.

## Installed foundation

| Component | Usage | License |
| --- | --- | --- |
| Next.js / React | Application runtime dependencies; UI is still being implemented | Preserve the licenses shipped with the installed packages |
| Drizzle ORM / Drizzle Kit | PostgreSQL schema and generated migrations | Apache-2.0 |
| node-postgres (`pg`) | PostgreSQL connections | Preserve the license shipped with the installed package |
| Zod | Runtime validation of application data | Preserve the license shipped with the installed package |
| Walrus Memory SDK (`@mysten-incubation/memwal` 0.1.9) | Official client used by the server memory adapter; relayer operations remain subject to live verification | Apache-2.0; retain the package's distributed LICENSE |
| Vercel AI SDK (`ai` 7.0.148) and OpenAI-compatible provider (3.0.75) | Structured model generation binding | Apache-2.0; retain distributed package licenses |

Tooling dependencies are recorded separately in `package.json` and `pnpm-lock.yaml`.

## Vendored project source

No code from EdgeFinder, Bureau, SentinelCRE or other hackathon applications has been copied into the application at this stage. Their selected files were inspected for compatibility; decisions and reviewed commits are in [the reuse audit](docs/code-reuse.md).

When copying a module or UI source component, add the original repository, pinned commit, original path, local destination, changes and complete required license/notice before shipping it. Planned SDK integrations are not listed as completed imports.

## Consumer UI source and primitives (task04)

Actual shadcn/ui source was copied from https://github.com/shadcn-ui/ui at commit `ba1503c64472b82256d9de95e2e62c5901a38e8b` (MIT, copyright shadcn). The complete upstream license is preserved at `apps/web/vendor/shadcn-ui/LICENSE.md`.

| Upstream path | Local path | Modifications |
| --- | --- | --- |
| `apps/v4/registry/new-york-v4/ui/button.tsx` | `apps/web/components/ui/button.tsx` | Replace cn package alias with local clsx/tailwind-merge helper; Prettier formatting |
| `apps/v4/registry/new-york-v4/ui/dialog.tsx` | `apps/web/components/ui/dialog.tsx` | Replace cn/button registry aliases with local imports; Prettier formatting |

These source components use pinned `radix-ui` and `class-variance-authority`. The account menu directly uses Radix DropdownMenu. Their distributed package licenses remain applicable. Lucide icons retain the installed package license. Tailwind CSS, clsx and tailwind-merge are pinned in the web manifest and workspace lockfile. No competitor assets or hackathon application source are used by this UI.

## Authentication (task03)

`next-auth@4.24.15` is consumed as an installed package (ISC, https://github.com/nextauthjs/next-auth). It implements Google OAuth, CSRF, encrypted session cookies and sign-out; no upstream source was copied. `server-only@0.0.1` (MIT, https://github.com/reactjs/rfcs/pull/0227) guards server imports. Installed package licenses and notices remain applicable.
