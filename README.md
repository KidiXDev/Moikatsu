# Moikatsu

Self-hosted, open-source AI character chat. Supports Character Card V1/V2/V3 (PNG, JSON, CharX), Chat Completion presets, lorebooks, and JSONL chats. Uses OpenRouter for models.

> Early development.

## Requirements

- [Node.js](https://nodejs.org/) 22.18+ or 24.12+
- [Bun](https://bun.sh/) (package manager)

## Install and run

```sh
git clone <repo-url> moikatsu
cd moikatsu
bun install
bun run build
bun run start
```

Open http://127.0.0.1:8100.

On first start Moikatsu creates `config.yaml` and the `data/` folder.

## Configuration

Edit `config.yaml`, then restart. Defaults are documented in [`default/config.yaml`](./default/config.yaml).

| Key         | Default            | Description                                                   |
| ----------- | ------------------ | ------------------------------------------------------------- |
| `dataRoot`  | `./data`           | Folder for all your data.                                     |
| `listen`    | `false`            | `true` lets other devices on your network connect.            |
| `port`      | `8100`             | Server port.                                                  |
| `whitelist` | `127.0.0.1`, `::1` | IPs or CIDR ranges allowed to connect. Empty allows everyone. |
| `basicAuth` | disabled           | Username and password prompt.                                 |
| `maxBodyMB` | `100`              | Largest accepted upload.                                      |

To use Moikatsu from your phone on the same network: set `listen: true` and add your network to `whitelist` (e.g. `192.168.1.0/24`) or enable `basicAuth`. The server refuses to listen on the network without one of them.

## Your data

Everything is stored as plain files in `data/`:

```
data/
  settings.json     settings
  secrets.json      API keys (encrypted)
  characters/       character cards (.png)
  chats/            chats per character (.jsonl)
  group-chats/      group chats (.jsonl)
  groups/           groups (.json)
  lorebooks/        lorebooks (.json)
  presets/          Chat Completion presets (.json)
  personas/         persona avatars
  quick-replies/    Quick Reply sets (.json)
  media/            uploaded images and text attachments
  prompts/          the prompt sent for each reply (last 50 per chat)
  backups/          chat history snapshots, daily settings copies
  trash/            deleted characters, groups, and chats (kept 30 days)
```

To back up, copy the `data/` folder, or download a zip from `GET /api/backup` (API keys are left out). Upload that zip to `POST /api/backup` to restore it; the current data is saved to `backups/` first.

### Importing an existing data folder

```sh
bun run import-data /path/to/user/data
```

Copies characters, chats, group chats, groups, lorebooks (`worlds/`), presets (`OpenAI Settings/`), persona avatars (`User Avatars/`), and Quick Reply sets (`QuickReplies/`), and converts personas, World Info, regex, and Author's Note settings from its `settings.json`. Files that already exist are kept.

API keys in `secrets.json` are encrypted with `secret.key`, which lives in the Moikatsu folder, not in `data/`. A copied or shared data folder doesn't expose your keys. If `secret.key` is lost, enter your API key again.

## Development

```sh
bun run dev         # server (auto-restart) + Vite at http://localhost:5173
bun run test:unit   # tests
bun run type-check
bun run lint         # oxlint + ESLint, with fixes
bun run format       # oxfmt
```

The server (`server/`) and the engine (`engine/`) run TypeScript directly with Node's type stripping, so they use erasable syntax only (no enums, namespaces, or parameter properties) and relative imports with `.ts` extensions. The engine is also bundled into the UI, so it can't use Node or browser-only APIs.

## License

[AGPL-3.0](./LICENSE)
